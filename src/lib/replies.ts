import type { DB } from "./db";
import { classifyReply, stripQuoted, LABELS, SUPPRESSING, type Label } from "./classify";
import type { GeminiDeps } from "./gemini";

/*
  Turning inbox messages into tracked replies.
  Privacy rule: a message is only stored if it clearly belongs to an email THIS app sent
  (reply headers, the sender's address, the company's domain, or a bounce naming the address).
  Everything else in your inbox is ignored and never saved.
*/
export interface Inbound {
  messageId: string;
  from: string;               // sender address
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
  autoSubmitted?: boolean;
  date?: string;
}

interface SendRow { id: number; to_email: string; message_id: string | null; company: string }

function campaignSends(db: DB, campaignId: number): SendRow[] {
  return db.prepare(
    `SELECT s.id, s.to_email, s.message_id, c.name AS company FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id
      WHERE c.campaign_id = ? AND s.status IN ('sent', 'bounced') AND s.to_email IS NOT NULL ORDER BY s.id DESC`
  ).all(campaignId) as SendRow[];
}

const domainOf = (e: string) => e.toLowerCase().split("@")[1] ?? "";

export function matchSend(sends: SendRow[], m: Inbound): SendRow | null {
  const ids = new Set([m.inReplyTo, ...(m.references ?? [])].filter(Boolean) as string[]);
  if (ids.size) { const hit = sends.find((s) => s.message_id && ids.has(s.message_id)); if (hit) return hit; }
  const from = m.from.toLowerCase();
  const exact = sends.find((s) => s.to_email.toLowerCase() === from);
  if (exact) return exact;
  const body = `${m.subject}\n${m.text}`.toLowerCase();
  if (/mailer-daemon|postmaster/i.test(from)) return sends.find((s) => body.includes(s.to_email.toLowerCase())) ?? null;
  const sameDomain = sends.filter((s) => domainOf(s.to_email) === domainOf(from) && domainOf(from) !== "");
  return sameDomain.length === 1 ? sameDomain[0] : null;
}

function setSuppression(db: DB, email: string, label: Label, simulated: boolean) {
  db.prepare(`INSERT OR REPLACE INTO suppression (email, reason) VALUES (?, ?)`).run(email.toLowerCase(), label === "Bounced" ? (simulated ? "bounced (sample)" : "bounced") : `${label}${simulated ? " (sample)" : ""}`);
}
const REPLY_REASONS = ["Unsubscribe", "Not interested", "Unsubscribe (sample)", "Not interested (sample)"];

function applyEffects(db: DB, send: SendRow, label: Label, simulated: boolean) {
  if (SUPPRESSING.includes(label)) setSuppression(db, send.to_email, label, simulated);
  if (label === "Bounced") db.prepare(`UPDATE sends SET status = 'bounced' WHERE id = ?`).run(send.id);
}

export interface ProcessResult { stored: number; ignored: number; duplicates: number; byLabel: Record<string, number> }

export async function processInbound(db: DB, campaignId: number, msgs: Inbound[], opts: { simulated?: boolean; gemini?: GeminiDeps & { enabled?: boolean } } = {}): Promise<ProcessResult> {
  const sends = campaignSends(db, campaignId);
  const res: ProcessResult = { stored: 0, ignored: 0, duplicates: 0, byLabel: {} };
  const exists = db.prepare(`SELECT 1 FROM replies WHERE message_id = ?`);
  const insert = db.prepare(
    `INSERT INTO replies (send_id, body, label, labelled_by, message_id, from_email, subject, simulated, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  );
  for (const m of msgs) {
    if (exists.get(m.messageId)) { res.duplicates++; continue; }
    const send = matchSend(sends, m);
    if (!send) { res.ignored++; continue; }
    const text = /mailer-daemon|postmaster/i.test(m.from) ? m.text.slice(0, 2000) : stripQuoted(m.text);
    const { label, by } = await classifyReply({ from: m.from, subject: m.subject, text, autoSubmitted: m.autoSubmitted }, opts.gemini);
    db.transaction(() => {
      insert.run(send.id, text, label, by, m.messageId, m.from.toLowerCase(), m.subject.slice(0, 200), opts.simulated ? 1 : 0, m.date ?? null);
      applyEffects(db, send, label, !!opts.simulated);
    })();
    res.stored++; res.byLabel[label] = (res.byLabel[label] ?? 0) + 1;
  }
  return res;
}

// ---------- changing a label by hand ----------
export function relabel(db: DB, replyId: number, label: Label): boolean {
  if (!LABELS.includes(label)) return false;
  const r = db.prepare(`SELECT r.id, r.simulated, s.id AS sendId, s.to_email AS toEmail FROM replies r JOIN sends s ON s.id = r.send_id WHERE r.id = ?`).get(replyId) as
    | { id: number; simulated: number; sendId: number; toEmail: string } | undefined;
  if (!r) return false;
  db.transaction(() => {
    db.prepare(`UPDATE replies SET label = ?, labelled_by = 'you' WHERE id = ?`).run(label, replyId);
    // Undo a do-not-email entry that came from a reply label, then apply the new one.
    db.prepare(`DELETE FROM suppression WHERE email = ? AND reason IN (${REPLY_REASONS.map(() => "?").join(",")})`).run(r.toEmail.toLowerCase(), ...REPLY_REASONS);
    applyEffects(db, { id: r.sendId, to_email: r.toEmail, message_id: null, company: "" }, label, !!r.simulated);
  })();
  return true;
}

export function setMeeting(db: DB, replyId: number, booked: boolean) {
  db.prepare(`UPDATE replies SET meeting_booked = ? WHERE id = ?`).run(booked ? 1 : 0, replyId);
}

// ---------- listing ----------
export interface ReplyView { id: number; company: string; domain: string; email: string; label: Label; by: string; text: string; subject: string; simulated: boolean; meeting: boolean; receivedAt: string }

export function listReplies(db: DB, campaignId: number): ReplyView[] {
  const rows = db.prepare(
    `SELECT r.id, c.name, c.domain, s.to_email, r.label, r.labelled_by, r.body, r.subject, r.simulated, r.meeting_booked, r.received_at
       FROM replies r JOIN sends s ON s.id = r.send_id JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id
      WHERE c.campaign_id = ?
      ORDER BY CASE r.label WHEN 'Interested' THEN 0 WHEN 'Question' THEN 1 WHEN 'Unclear' THEN 2 WHEN 'Not now' THEN 3 ELSE 4 END, r.id DESC`
  ).all(campaignId) as any[];
  return rows.map((r) => ({ id: r.id, company: r.name, domain: r.domain, email: r.to_email, label: r.label as Label, by: r.labelled_by ?? "", text: r.body, subject: r.subject ?? "", simulated: !!r.simulated, meeting: !!r.meeting_booked, receivedAt: r.received_at }));
}

export function replyCounts(db: DB, campaignId: number) {
  const rows = db.prepare(
    `SELECT r.label AS label, COUNT(*) AS n, SUM(r.simulated) AS sim FROM replies r JOIN sends s ON s.id = r.send_id JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? GROUP BY r.label`
  ).all(campaignId) as Array<{ label: string; n: number; sim: number }>;
  const byLabel: Record<string, number> = {};
  let total = 0, sample = 0;
  for (const r of rows) { byLabel[r.label] = r.n; total += r.n; sample += r.sim ?? 0; }
  const meetings = (db.prepare(`SELECT COUNT(*) AS n FROM replies r JOIN sends s ON s.id = r.send_id JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND r.meeting_booked = 1`).get(campaignId) as { n: number }).n;
  const sent = (db.prepare(`SELECT COUNT(*) AS n FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND s.status IN ('sent','bounced')`).get(campaignId) as { n: number }).n;
  return { total, sample, byLabel, meetings, sent };
}

// ---------- sample replies (for demos) ----------
const SAMPLES: Array<{ subject: string; text: string; from?: "daemon" }> = [
  { subject: "Re: {s}", text: "Hi Abhinav,\n\nThis looks interesting. We spend a lot of time on client paperwork. Can we do a call on Thursday at 4pm?\n\nRegards" },
  { subject: "Re: {s}", text: "Hello,\n\nHow does pricing work, and does it integrate with Zoho?\n\nThanks" },
  { subject: "Re: {s}", text: "Thanks for reaching out. It's not a priority right now, maybe check back next quarter." },
  { subject: "Re: {s}", text: "Not interested, please remove us from your list." },
  { subject: "Re: {s}", text: "no thanks" },
  { subject: "Automatic reply: {s}", text: "I am out of office until 14 Nov with limited access to email. For urgent matters contact the front desk." },
  { subject: "Delivery Status Notification (Failure)", text: "Address not found\n\nYour message wasn't delivered to {to} because the address couldn't be found, or is unable to receive mail.\n\nThe response was: 550 5.1.1 The email account that you tried to reach does not exist.", from: "daemon" },
];

export async function addSampleReplies(db: DB, campaignId: number): Promise<ProcessResult> {
  const sends = campaignSends(db, campaignId).reverse();
  const unused = sends.filter((s) => !db.prepare(`SELECT 1 FROM replies WHERE send_id = ?`).get(s.id));
  const msgs: Inbound[] = unused.slice(0, SAMPLES.length).map((s, i) => {
    const t = SAMPLES[i];
    return {
      messageId: `sample-${s.id}-${i}`,
      from: t.from === "daemon" ? "mailer-daemon@googlemail.com" : s.to_email,
      subject: t.subject.replace("{s}", "your note").replace("{to}", s.to_email),
      text: t.text.replace("{to}", s.to_email),
    };
  });
  return processInbound(db, campaignId, msgs, { simulated: true, gemini: { enabled: false } });
}

export function removeSampleReplies(db: DB, campaignId: number): number {
  const ids = db.prepare(
    `SELECT r.id, r.send_id AS sendId FROM replies r JOIN sends s ON s.id = r.send_id JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND r.simulated = 1`
  ).all(campaignId) as Array<{ id: number; sendId: number }>;
  db.transaction(() => {
    for (const r of ids) {
      db.prepare(`UPDATE sends SET status = 'sent' WHERE id = ? AND status = 'bounced'`).run(r.sendId);
      db.prepare(`DELETE FROM replies WHERE id = ?`).run(r.id);
    }
    db.prepare(`DELETE FROM suppression WHERE reason LIKE '%(sample)'`).run();
  })();
  return ids.length;
}
