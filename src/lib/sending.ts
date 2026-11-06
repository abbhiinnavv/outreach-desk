import type { DB } from "./db";
import { MailError, type Mailer } from "./mailer";
import { getCampaign } from "./queries";

/*
  Sending approved emails. The safety rules live here, in one place:
    - only drafts you approved are sent; nothing else, ever
    - at most the campaign's daily cap per day (counted from what was really sent today)
    - never twice to the same address, never to anyone on the suppression list
    - a pause between emails so it looks like a person, not a burst
    - the first login or limit problem stops everything straight away
*/
export function sentToday(db: DB, campaignId: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id
      WHERE c.campaign_id = ? AND s.status = 'sent' AND date(s.sent_at, 'localtime') = date('now', 'localtime')`
  ).get(campaignId) as { n: number }).n;
}

export function sendCounts(db: DB, campaignId: number) {
  const campaign = getCampaign(db, campaignId);
  const cap = campaign?.dailyCap ?? 0;
  const today = sentToday(db, campaignId);
  const approved = (db.prepare(`SELECT COUNT(*) AS n FROM drafts d JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND d.status = 'approved'`).get(campaignId) as { n: number }).n;
  const remaining = Math.max(cap - today, 0);
  return { cap, today, approved, remaining, willSend: Math.min(approved, remaining) };
}

interface ReadyDraft { id: number; subject: string; body: string; email: string; verification: string; contactId: number | null }

function readyDrafts(db: DB, campaignId: number): ReadyDraft[] {
  return db.prepare(
    `SELECT d.id, CASE d.variant WHEN 'B' THEN d.subject_b ELSE d.subject_a END AS subject, d.body, ct.email AS email, ct.verification AS verification, ct.id AS contactId
       FROM drafts d JOIN companies c ON c.id = d.company_id LEFT JOIN contacts ct ON ct.id = d.contact_id
      WHERE c.campaign_id = ? AND d.status = 'approved' ORDER BY c.fit_score DESC, d.id`
  ).all(campaignId) as ReadyDraft[];
}

export const isSuppressed = (db: DB, email: string) =>
  !!db.prepare(`SELECT 1 FROM suppression WHERE email = ? OR email = ?`).get(email.toLowerCase(), "@" + email.toLowerCase().split("@")[1]);

export interface SendDeps {
  mailer: Mailer;
  fromAddress: string;                 // the Gmail address
  delayMs?: () => number;              // pause between emails
  sleep?: (ms: number) => Promise<void>;
}
export interface SendResult { sent: number; failed: number; skipped: number; note: string | null }

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sendApproved(db: DB, campaignId: number, deps: SendDeps, opts: { shouldStop?: () => boolean } = {}): Promise<SendResult> {
  const campaign = getCampaign(db, campaignId);
  const result: SendResult = { sent: 0, failed: 0, skipped: 0, note: null };
  if (!campaign) return result;
  const sleep = deps.sleep ?? wait;
  const from = `${campaign.sender} <${deps.fromAddress}>`;
  let remaining = Math.max(campaign.dailyCap - sentToday(db, campaignId), 0);
  if (remaining === 0) { result.note = `Today's limit of ${campaign.dailyCap} is already used. Nothing was sent.`; return result; }

  const insertSend = db.prepare(`INSERT INTO sends (draft_id, sent_at, message_id, status, to_email, error, day_no) VALUES (?, ?, ?, ?, ?, ?, 1)`);
  const markSent = db.prepare(`UPDATE drafts SET status = 'sent' WHERE id = ?`);
  const log = db.prepare(`INSERT INTO events (kind, ref, data) VALUES (?, ?, ?)`);
  const alreadyEmailed = db.prepare(
    `SELECT 1 FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND s.status = 'sent' AND s.to_email = ?`);
  let first = true;

  for (const d of readyDrafts(db, campaignId)) {
    if (remaining === 0) { result.note = `Stopped at today's limit of ${campaign.dailyCap}. The rest stay approved for tomorrow.`; break; }
    if (opts.shouldStop?.()) { result.note = "Stopped by you. Emails not yet sent stay approved."; break; }
    const to = (d.email ?? "").toLowerCase();
    if (!to || d.verification === "invalid" || isSuppressed(db, to) || alreadyEmailed.get(campaignId, to)) { result.skipped++; continue; }

    if (!first) await sleep(deps.delayMs ? deps.delayMs() : 0);
    first = false;
    if (opts.shouldStop?.()) { result.note = "Stopped by you. Emails not yet sent stay approved."; break; }

    try {
      const out = await deps.mailer({
        from, to, subject: d.subject, text: d.body,
        headers: { "List-Unsubscribe": `<mailto:${deps.fromAddress}?subject=unsubscribe>` },
      });
      db.transaction(() => {
        insertSend.run(d.id, new Date().toISOString().replace("T", " ").slice(0, 19), out.messageId, "sent", to, null);
        markSent.run(d.id);
        log.run("sent", String(d.id), to);
      })();
      result.sent++; remaining--;
    } catch (e) {
      const err = e instanceof MailError ? e : new MailError("Unexpected error while sending.", "network");
      insertSend.run(d.id, null, null, "failed", to, err.message);
      result.failed++;
      if (err.kind === "rejected") {
        db.prepare(`INSERT OR IGNORE INTO suppression (email, reason) VALUES (?, 'bounced')`).run(to);
        db.prepare(`UPDATE drafts SET status = 'rejected' WHERE id = ?`).run(d.id);
        continue;                                // one bad address must not stop the others
      }
      result.note = err.message;                 // login, limit or network problem: stop everything
      break;
    }
  }
  return result;
}

/** Sends the first approved email (or the first waiting one) to YOUR OWN address. Not recorded as a real send. */
export async function sendTest(db: DB, campaignId: number, deps: SendDeps): Promise<{ ok: boolean; message: string }> {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  const d = db.prepare(
    `SELECT CASE d.variant WHEN 'B' THEN d.subject_b ELSE d.subject_a END AS subject, d.body FROM drafts d JOIN companies c ON c.id = d.company_id
      WHERE c.campaign_id = ? AND d.status IN ('approved', 'pending') ORDER BY (d.status = 'approved') DESC, d.id LIMIT 1`
  ).get(campaignId) as { subject: string; body: string } | undefined;
  if (!d) return { ok: false, message: "Write at least one email first." };
  try {
    await deps.mailer({ from: `${campaign.sender} <${deps.fromAddress}>`, to: deps.fromAddress, subject: `[TEST] ${d.subject}`, text: d.body });
    return { ok: true, message: `Test sent to ${deps.fromAddress}. Check your inbox (and Spam).` };
  } catch (e) {
    return { ok: false, message: e instanceof MailError ? e.message : "The test could not be sent." };
  }
}
