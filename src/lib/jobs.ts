import { getDb } from "./db";
import { isDemo } from "./demo";
import { getCampaign } from "./queries";
import { toScoringBrief } from "./brief";
import { runEnrichment } from "./enrich";
import { makeFetcher } from "./crawl/fetcher";
import { dnsMx } from "./crawl/verify";
import { writeDrafts, type DraftingResult } from "./drafts";
import { syncSheetQuietly } from "./sheet-sync";
import { sendApproved, type SendResult } from "./sending";
import { gmailUser, makeGmailMailer, MailError } from "./mailer";

/*
  Runs the email finder in the background of the app, so the page does not freeze while
  hundreds of websites are visited. One job per campaign. Progress is read from the database.
  If you stop the app, nothing is lost: unfinished companies simply stay "pending".
*/
const g = globalThis as unknown as { __jobs?: Map<number, { stop: boolean }> };
const jobs = (g.__jobs ??= new Map());

export function isRunning(campaignId: number): boolean {
  return jobs.has(campaignId);
}

export function startEnrichmentJob(campaignId: number): boolean {
  if (isDemo()) return false;
  if (jobs.has(campaignId)) return false;
  const db = getDb();
  const campaign = getCampaign(db, campaignId);
  if (!campaign) return false;
  const state = { stop: false };
  jobs.set(campaignId, state);
  runEnrichment(db, campaignId, toScoringBrief(campaign), { fetcher: makeFetcher(), mx: dnsMx, concurrency: 4 }, { shouldStop: () => state.stop })
    .catch((e) => console.error("enrichment job failed", e))
    .finally(() => { jobs.delete(campaignId); syncSheetQuietly(db, campaignId); });
  return true;
}

export function stopEnrichmentJob(campaignId: number) {
  const j = jobs.get(campaignId);
  if (j) j.stop = true;
}

// ---- email writing job ----
const gd = globalThis as unknown as { __draftJobs?: Map<number, { stop: boolean; result?: DraftingResult; error?: string }> };
const draftJobs = (gd.__draftJobs ??= new Map());

export const isDrafting = (id: number) => draftJobs.get(id)?.result === undefined && draftJobs.get(id)?.error === undefined && draftJobs.has(id);
export const draftOutcome = (id: number) => { const j = draftJobs.get(id); return j && (j.result || j.error) ? { result: j.result ?? null, error: j.error ?? null } : null; };

export function startDraftingJob(campaignId: number): boolean {
  if (isDemo()) return false;
  if (isDrafting(campaignId)) return false;
  const db = getDb();
  if (!getCampaign(db, campaignId)) return false;
  const state: { stop: boolean; result?: DraftingResult; error?: string } = { stop: false };
  draftJobs.set(campaignId, state);
  writeDrafts(db, campaignId, { fetcher: makeFetcher({ timeoutMs: 8000 }), delayMs: 4000 }, { shouldStop: () => state.stop })
    .then((r) => { state.result = r; syncSheetQuietly(db, campaignId); })
    .catch((e) => { console.error("drafting job failed", e); state.error = "Something went wrong while writing. Try again."; });
  return true;
}
export function stopDraftingJob(campaignId: number) { const j = draftJobs.get(campaignId); if (j) j.stop = true; }

// ---- sending job ----
const gs = globalThis as unknown as { __sendJobs?: Map<number, { stop: boolean; done: boolean; result?: SendResult; error?: string }> };
const sendJobs = (gs.__sendJobs ??= new Map());

export const isSending = (id: number) => { const j = sendJobs.get(id); return !!j && !j.done; };
export const sendOutcome = (id: number) => { const j = sendJobs.get(id); return j?.done ? (j.result?.note ?? j.error ?? null) : null; };

/** Returns an error message, or null when the job started. */
export function startSendingJob(campaignId: number): string | null {
  if (isDemo()) return "Sending is switched off in the public demo.";
  if (isSending(campaignId)) return "Already sending.";
  const db = getDb();
  if (!getCampaign(db, campaignId)) return "Campaign not found.";
  let mailer;
  try { mailer = makeGmailMailer(); } catch (e) { return e instanceof MailError ? e.message : "Gmail is not set up."; }
  const state: { stop: boolean; done: boolean; result?: SendResult; error?: string } = { stop: false, done: false };
  sendJobs.set(campaignId, state);
  const pause = () => (25 + Math.random() * 35) * 1000; // 25 to 60 seconds between emails
  sendApproved(db, campaignId, { mailer, fromAddress: gmailUser(), delayMs: pause }, { shouldStop: () => state.stop })
    .then((r) => { state.result = r; })
    .catch((e) => { console.error("sending job failed", e); state.error = "Something went wrong while sending."; })
    .finally(() => { state.done = true; syncSheetQuietly(db, campaignId); });
  return null;
}
export function stopSendingJob(campaignId: number) { const j = sendJobs.get(campaignId); if (j) j.stop = true; }
