import ExcelJS from "exceljs";
import type { DB } from "./db";
import { CONTACT_ORDER, getCampaign } from "./queries";
import { buildFunnel, conversion } from "./funnel";

/*
  The master workbook: the whole campaign in one place, from "company found" to "feedback".
  Four tabs: Pipeline (one row per company, every stage), Emails (every address found),
  Replies (the feedback) and Funnel (the totals). Built fresh from the database each time, so it is always current.
  The same tabs are sent to the live Google Sheet after every step.
*/
export type Table = Array<Array<string | number>>;

const dangerous = /^[=+\-@\t\r]/;
const safe = (v: unknown): string | number => (typeof v === "number" ? v : dangerous.test(String(v ?? "")) ? `'${v}` : String(v ?? ""));
const yn = (b: unknown) => (b ? "Yes" : "No");
const DRAFT_WORD: Record<string, string> = { pending: "Waiting for approval", approved: "Approved", rejected: "Rejected", sent: "Sent" };

function nextAction(r: any, doNotEmail: boolean): string {
  if (doNotEmail || r.label === "Not interested" || r.label === "Unsubscribe") return "Do not contact again";
  if (r.label === "Bounced" || r.sstatus === "bounced") return "Find another email";
  if (r.label === "Interested" || r.label === "Question") return r.meeting_booked ? "Meeting booked" : "Reply to them now";
  if (r.label === "Not now") return "Try again in about 90 days";
  if (r.label === "Out of office") return "Try again later";
  if (r.sstatus === "sent") return "Waiting for a reply";
  if (r.dstatus === "approved") return "Send it";
  if (r.dstatus === "pending") return "Review and approve";
  if (r.dstatus === "rejected") return "Rewrite or skip";
  if (!r.email) return "Find or add an email";
  return "Write the email";
}

export function pipelineTable(db: DB, id: number): Table {
  const rows = db.prepare(
    `SELECT c.name, c.domain, c.region, c.city, c.fit_score, c.fit_label,
            ct.email, ct.kind, ct.verification, ct.source_url,
            d.status AS dstatus, d.written_by, CASE d.variant WHEN 'B' THEN d.subject_b ELSE d.subject_a END AS subject,
            s.sent_at, s.status AS sstatus,
            r.label, r.body, r.simulated, r.meeting_booked,
            (SELECT 1 FROM suppression sp WHERE sp.email = LOWER(ct.email)) AS dne
       FROM companies c
       LEFT JOIN contacts ct ON ct.id = (SELECT id FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1)
       LEFT JOIN drafts d ON d.id = (SELECT MAX(id) FROM drafts WHERE company_id = c.id)
       LEFT JOIN sends s ON s.id = (SELECT MAX(id) FROM sends WHERE draft_id = d.id)
       LEFT JOIN replies r ON r.id = (SELECT MAX(id) FROM replies WHERE send_id = s.id)
      WHERE c.campaign_id = ? ORDER BY c.fit_score DESC, c.id`
  ).all(id) as any[];
  const head = ["Company", "Website", "Region", "City", "Fit score", "Fit", "Best email", "Email type", "Email check", "Found on page",
    "Email written", "Draft status", "Written by", "Subject", "Sent at", "Send result", "Reply label", "Reply (start)", "Reply is a sample", "Meeting booked", "Do not email", "Next action"];
  return [head, ...rows.map((r) => [
    safe(r.name), r.domain, r.region ?? "", r.city ?? "", r.fit_score, r.fit_label, safe(r.email ?? ""), r.kind ?? "", r.verification ?? "", r.source_url ?? "",
    yn(r.dstatus), DRAFT_WORD[r.dstatus] ?? "", r.written_by ?? "", safe(r.subject ?? ""), r.sent_at ?? "", r.sstatus ?? "",
    r.label ?? "", safe(String(r.body ?? "").replace(/\s+/g, " ").slice(0, 300)), r.label ? yn(r.simulated) : "", r.label ? yn(r.meeting_booked) : "", yn(r.dne), nextAction(r, !!r.dne),
  ])];
}

export function emailsTable(db: DB, id: number): Table {
  const rows = db.prepare(
    `SELECT c.name, ct.email, ct.verification, ct.kind, ct.role, ct.method, ct.source_url, ct.verify_note
       FROM contacts ct JOIN companies c ON c.id = ct.company_id WHERE c.campaign_id = ? ORDER BY c.fit_score DESC, c.id, ct.priority, ct.id`
  ).all(id) as any[];
  return [["Company", "Email", "Check", "Type", "Role", "How it was added", "Found on page", "Note"],
    ...rows.map((r) => [safe(r.name), safe(r.email), r.verification, r.kind ?? "", r.role ?? "", r.method ?? "", r.source_url ?? "", r.verify_note ?? ""])];
}

export function repliesTable(db: DB, id: number): Table {
  const rows = db.prepare(
    `SELECT c.name, s.to_email, r.label, r.labelled_by, r.simulated, r.meeting_booked, r.received_at, r.body
       FROM replies r JOIN sends s ON s.id = r.send_id JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id
      WHERE c.campaign_id = ? ORDER BY r.id DESC`
  ).all(id) as any[];
  return [["Company", "Email", "Label", "Labelled by", "Sample reply", "Meeting booked", "Received", "Reply"],
    ...rows.map((r) => [safe(r.name), safe(r.to_email), r.label, r.labelled_by ?? "", yn(r.simulated), yn(r.meeting_booked), r.received_at, safe(String(r.body ?? "").replace(/\s+/g, " ").slice(0, 600))])];
}

export function funnelTable(db: DB, id: number): Table {
  const f = buildFunnel(db, id);
  const out: Table = [["Stage", "Companies", "% of previous stage"]];
  f.stages.forEach((s, i) => { const c = i ? conversion(f.stages[i - 1].count, s.count) : null; out.push([s.label, s.count, c === null ? "" : `${c}%`]); });
  out.push(["", "", ""], ["Bounced addresses", f.bounced, ""], ["Auto-replies", f.autoReplies, ""], ["On the do-not-email list", f.doNotEmail, ""], ["Sample replies included", f.sampleReplies, ""]);
  return out;
}

export function buildSheets(db: DB, id: number): Record<string, Table> {
  return { Pipeline: pipelineTable(db, id), Emails: emailsTable(db, id), Replies: repliesTable(db, id), Funnel: funnelTable(db, id) };
}

export async function buildWorkbook(db: DB, id: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Outreach Desk";
  const name = getCampaign(db, id)?.name ?? "Campaign";
  for (const [title, table] of Object.entries(buildSheets(db, id))) {
    const ws = wb.addWorksheet(title, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRows(table);
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FF0B1F3A" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0FF" } };
    ws.columns.forEach((col, i) => {
      const longest = Math.max(...table.slice(0, 60).map((r) => String(r[i] ?? "").length), 8);
      col.width = Math.min(Math.max(longest + 2, 10), 48);
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table[0].length } };
  }
  wb.title = name;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
