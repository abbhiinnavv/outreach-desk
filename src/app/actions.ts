"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { parseBrief, toScoringBrief } from "@/lib/brief";
import { createCampaign, getCampaign } from "@/lib/queries";
import { importCsv, rescoreCampaign } from "@/lib/importer";
import { resetFailed, verifyUnchecked } from "@/lib/enrich";
import { dnsMx } from "@/lib/crawl/verify";
import { contactInserter } from "@/lib/contacts";
import { cleanEmail } from "@/lib/domain";
import { startEnrichmentJob, stopEnrichmentJob, startDraftingJob, startSendingJob, stopSendingJob } from "@/lib/jobs";
import { sendTest } from "@/lib/sending";
import { processInbound, addSampleReplies, removeSampleReplies, relabel, setMeeting } from "@/lib/replies";
import { fetchInbound } from "@/lib/inbox";
import { LABELS, type Label } from "@/lib/classify";
import { hasGeminiKey } from "@/lib/gemini";
import { isDemo, DEMO_MESSAGE } from "@/lib/demo";
import { gmailUser, makeGmailMailer, MailError } from "@/lib/mailer";
import { reviewDraft, type Intent } from "@/lib/drafts";
import { syncSheet, syncSheetQuietly } from "@/lib/sheet-sync";
import { checkCandidates, suggestCompanies, type Candidate } from "@/lib/finder";
import { GeminiError } from "@/lib/gemini";
import { makeFetcher } from "@/lib/crawl/fetcher";
import Papa from "papaparse";

export interface FormState {
  errors?: string[];
  message?: string;
  candidates?: Candidate[];
}

export async function createCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = parseBrief((k) => form.get(k)?.toString());
  if (!parsed.ok) return { errors: parsed.errors };
  const id = createCampaign(getDb(), parsed.value);
  redirect(`/campaigns/${id}`);
}

export async function importCsvAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (isDemo()) return { errors: [DEMO_MESSAGE] };
  const id = Number(form.get("campaignId"));
  const campaign = getCampaign(getDb(), id);
  if (!campaign) return { errors: ["Campaign not found."] };

  const file = form.get("file");
  const pasted = form.get("paste")?.toString() ?? "";
  let text = pasted.trim();
  if (file instanceof File && file.size > 0) text = await file.text();
  if (!text) return { errors: ["Choose a CSV file or paste CSV text first."] };

  const r = importCsv(getDb(), id, text, toScoringBrief(campaign));
  await verifyUnchecked(getDb(), id, dnsMx); // check any emails that came with the CSV
  rescoreCampaign(getDb(), id, toScoringBrief(campaign));
  revalidatePath(`/campaigns/${id}`);
  syncSheetQuietly(getDb(), id);
  const msg = `Read ${r.total} rows: ${r.added} added, ${r.duplicates} duplicates skipped${r.merged ? ` (${r.merged} new email${r.merged > 1 ? "s" : ""} added to companies already in the list)` : ""}, ${r.invalid} invalid.`;
  return r.problems.length ? { message: msg, errors: r.problems } : { message: msg };
}

export async function startEnrichAction(form: FormData): Promise<void> {
  if (isDemo()) return;
  const id = Number(form.get("campaignId"));
  if (form.get("retryFailed")) resetFailed(getDb(), id);
  startEnrichmentJob(id);
  revalidatePath(`/campaigns/${id}`);
  syncSheetQuietly(getDb(), id);
}

export async function startDraftingAction(form: FormData): Promise<void> {
  if (isDemo()) return;
  const id = Number(form.get("campaignId"));
  startDraftingJob(id);
  revalidatePath(`/campaigns/${id}`);
  syncSheetQuietly(getDb(), id);
}

export async function reviewDraftAction(form: FormData): Promise<void> {
  const id = Number(form.get("draftId"));
  const campaignId = Number(form.get("campaignId"));
  const intent = String(form.get("intent")) as Intent;
  if (!["save", "approve", "reject", "reset"].includes(intent)) return;
  const text = (k: string) => (form.has(k) ? String(form.get(k)) : undefined);
  reviewDraft(getDb(), id, intent, { subjectA: text("subjectA"), subjectB: text("subjectB"), variant: text("variant"), body: text("body") });
  syncSheetQuietly(getDb(), campaignId);
  revalidatePath(`/campaigns/${campaignId}/review`);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
}

export async function approveAllAction(form: FormData): Promise<void> {
  const campaignId = Number(form.get("campaignId"));
  const db = getDb();
  const ids = db.prepare(`SELECT d.id FROM drafts d JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND d.status = 'pending'`).all(campaignId) as Array<{ id: number }>;
  for (const { id } of ids) reviewDraft(db, id, "approve");
  syncSheetQuietly(db, campaignId);
  revalidatePath(`/campaigns/${campaignId}/review`);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
}

export async function stopEnrichAction(form: FormData): Promise<void> {
  const id = Number(form.get("campaignId"));
  stopEnrichmentJob(id);
  revalidatePath(`/campaigns/${id}`);
  syncSheetQuietly(getDb(), id);
}

export async function rescoreAction(form: FormData): Promise<void> {
  const id = Number(form.get("campaignId"));
  const campaign = getCampaign(getDb(), id);
  if (!campaign) return;
  rescoreCampaign(getDb(), id, toScoringBrief(campaign));
  revalidatePath(`/campaigns/${id}`);
  syncSheetQuietly(getDb(), id);
}

/** Add an email by hand, for example one you copied from a site that blocks the crawler. */
export async function addContactAction(form: FormData): Promise<void> {
  if (isDemo()) return;
  const companyId = Number(form.get("companyId"));
  const email = cleanEmail(form.get("email")?.toString());
  const db = getDb();
  const company = db.prepare(`SELECT id, campaign_id AS cid FROM companies WHERE id = ?`).get(companyId) as { id: number; cid: number } | undefined;
  if (!company || !email) return;
  const role = form.get("role")?.toString().trim() || null;
  const name = form.get("name")?.toString().trim() || null;
  contactInserter(db)({ companyId, email, name, role, method: "manual" });
  await verifyUnchecked(db, company.cid, dnsMx);
  rescoreCampaign(db, company.cid, toScoringBrief(getCampaign(db, company.cid)!));
  revalidatePath(`/campaigns/${company.cid}`);
  syncSheetQuietly(getDb(), company.cid);
}

/** Ask Gemini for companies, then check every website before showing them. */
export async function findCompaniesAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (isDemo()) return { errors: [DEMO_MESSAGE] };
  const id = Number(form.get("campaignId"));
  const campaign = getCampaign(getDb(), id);
  if (!campaign) return { errors: ["Campaign not found."] };
  const query = form.get("query")?.toString().trim() ?? "";
  if (query.length < 3) return { errors: ["Describe the companies you want, for example: wealth advisory firms in Mumbai."] };
  try {
    const suggestions = await suggestCompanies(query, campaign.regions, Number(form.get("count")) || 10);
    if (suggestions.length === 0) return { errors: ["Gemini did not suggest any companies it was sure about. Try a more specific search."] };
    const candidates = await checkCandidates(suggestions, makeFetcher({ timeoutMs: 8000 }));
    return { candidates };
  } catch (e) {
    return { errors: [e instanceof GeminiError ? e.message : "Something went wrong while searching. Try again."] };
  }
}

/** Add the companies you ticked. They go through the same import as a CSV, so duplicates are skipped. */
export async function addCandidatesAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (isDemo()) return { errors: [DEMO_MESSAGE] };
  const id = Number(form.get("campaignId"));
  const campaign = getCampaign(getDb(), id);
  if (!campaign) return { errors: ["Campaign not found."] };
  let all: Candidate[] = [];
  try { all = JSON.parse(form.get("candidates")?.toString() ?? "[]"); } catch { /* ignore */ }
  const picks = new Set(form.getAll("pick").map((v) => Number(v)));
  const chosen = all.filter((_, i) => picks.has(i));
  if (chosen.length === 0) return { errors: ["Tick at least one company to add."] };
  const csv = Papa.unparse(chosen.map((c) => ({ name: c.name, website: c.domain, city: c.city ?? "", region: c.region ?? "" })));
  const r = importCsv(getDb(), id, csv, toScoringBrief(campaign));
  revalidatePath(`/campaigns/${id}`);
  syncSheetQuietly(getDb(), id);
  return { message: `Added ${r.added} compan${r.added === 1 ? "y" : "ies"}${r.duplicates ? ` (${r.duplicates} already in your list)` : ""}. Now click Find emails.` };
}

export async function syncSheetAction(form: FormData): Promise<void> {
  const campaignId = Number(form.get("campaignId"));
  await syncSheet(getDb(), campaignId);
  revalidatePath(`/campaigns/${campaignId}/review`);
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function sendTestAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (isDemo()) return { errors: [DEMO_MESSAGE] };
  const campaignId = Number(form.get("campaignId"));
  try {
    const r = await sendTest(getDb(), campaignId, { mailer: makeGmailMailer(), fromAddress: gmailUser() });
    return r.ok ? { message: r.message } : { errors: [r.message] };
  } catch (e) {
    return { errors: [e instanceof MailError ? e.message : "The test could not be sent."] };
  }
}

export async function startSendingAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (isDemo()) return { errors: [DEMO_MESSAGE] };
  const campaignId = Number(form.get("campaignId"));
  if (form.get("confirm") !== "yes") return { errors: ["Tick the box to confirm you have read the emails."] };
  const err = startSendingJob(campaignId);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
  return err ? { errors: [err] } : { message: "Sending started. It pauses between emails, so this takes a while. You can leave this page open or close it." };
}

export async function stopSendingAction(form: FormData): Promise<void> {
  const campaignId = Number(form.get("campaignId"));
  stopSendingJob(campaignId);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
}

export async function checkRepliesAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (isDemo()) return { errors: [DEMO_MESSAGE] };
  const campaignId = Number(form.get("campaignId"));
  const db = getDb();
  try {
    const first = db.prepare(`SELECT MIN(s.sent_at) AS t FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND s.sent_at IS NOT NULL`).get(campaignId) as { t: string | null };
    const since = first?.t ? new Date(new Date(first.t.replace(" ", "T") + "Z").getTime() - 24 * 3600 * 1000) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const inbound = await fetchInbound(since);
    const r = await processInbound(db, campaignId, inbound, { gemini: { enabled: hasGeminiKey() } });
    revalidatePath(`/campaigns/${campaignId}`);
    syncSheetQuietly(getDb(), campaignId);
    revalidatePath(`/campaigns/${campaignId}/replies`);
    return { message: r.stored === 0 ? `Checked ${inbound.length} recent messages. No new replies to your emails yet.` : `Found ${r.stored} new repl${r.stored > 1 ? "ies" : "y"}: ${Object.entries(r.byLabel).map(([k, n]) => `${n} ${k}`).join(", ")}.` };
  } catch (e) {
    console.error("check replies failed:", e);
    return { errors: [e instanceof MailError ? e.message : `Could not read the inbox (${String((e as any)?.responseText ?? (e as any)?.message ?? "unknown").slice(0, 160)}).`] };
  }
}

export async function addSamplesAction(form: FormData): Promise<void> {
  const campaignId = Number(form.get("campaignId"));
  await addSampleReplies(getDb(), campaignId);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
  revalidatePath(`/campaigns/${campaignId}/replies`);
}

export async function removeSamplesAction(form: FormData): Promise<void> {
  const campaignId = Number(form.get("campaignId"));
  removeSampleReplies(getDb(), campaignId);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
  revalidatePath(`/campaigns/${campaignId}/replies`);
}

export async function relabelAction(form: FormData): Promise<void> {
  const campaignId = Number(form.get("campaignId"));
  const label = String(form.get("label")) as Label;
  if (LABELS.includes(label)) relabel(getDb(), Number(form.get("replyId")), label);
  revalidatePath(`/campaigns/${campaignId}/replies`);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
}

export async function meetingAction(form: FormData): Promise<void> {
  const campaignId = Number(form.get("campaignId"));
  setMeeting(getDb(), Number(form.get("replyId")), form.get("booked") === "1");
  revalidatePath(`/campaigns/${campaignId}/replies`);
  revalidatePath(`/campaigns/${campaignId}`);
  syncSheetQuietly(getDb(), campaignId);
}
