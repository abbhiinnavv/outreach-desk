import type { DB } from "./db";
import { buildSheets } from "./workbook";

/*
  Keeps a Google Sheet up to date with every email's status (waiting / approved / rejected / sent).
  How: a tiny Google Apps Script inside your own Sheet (google-sheet/apps-script.js) receives the table
  from this app and rewrites the sheet. No Google Cloud project and no extra login are needed.
  If the sheet is not set up, or Google is unreachable, the app carries on normally.
*/
const WORDS: Record<string, string> = { pending: "Waiting", approved: "Approved", rejected: "Rejected", sent: "Sent" };
const dangerous = /^[=+\-@\t\r]/;
const safe = (v: string) => (dangerous.test(v) ? `'${v}` : v);

export function buildTracker(db: DB, campaignId: number): string[][] {
  const rows = db.prepare(
    `SELECT c.name, c.domain, c.fit_score, ct.email, d.status, d.variant, d.subject_a, d.subject_b, d.written_by, d.created_at
       FROM drafts d JOIN companies c ON c.id = d.company_id LEFT JOIN contacts ct ON ct.id = d.contact_id
      WHERE c.campaign_id = ?
      ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END, c.fit_score DESC, d.id`
  ).all(campaignId) as any[];
  const head = ["Company", "Website", "Fit", "Email", "Status", "Subject", "Written by", "Drafted at"];
  return [head, ...rows.map((r) => [
    safe(r.name), r.domain, String(r.fit_score), safe(r.email ?? ""), WORDS[r.status] ?? r.status,
    safe(r.variant === "B" ? r.subject_b : r.subject_a), r.written_by, r.created_at ?? "",
  ])];
}

export const sheetConfigured = () => !!process.env.SHEET_WEBHOOK_URL?.trim();

const g = globalThis as unknown as { __sheetLast?: { ok: boolean; at: string; error?: string } };
export const lastSheetSync = () => g.__sheetLast ?? null;

export async function syncSheet(db: DB, campaignId: number, deps: { fetch?: typeof fetch; url?: string; secret?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const url = (deps.url ?? process.env.SHEET_WEBHOOK_URL ?? "").trim();
  if (!url) return { ok: false, error: "no_sheet" };
  const secret = deps.secret ?? process.env.SHEET_SECRET ?? "";
  const doFetch = deps.fetch ?? fetch;
  let result: { ok: boolean; error?: string };
  try {
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ secret, sheets: buildSheets(db, campaignId) }), signal: AbortSignal.timeout(20000) });
    const text = (await res.text()).trim();
    result = res.ok && text === "ok" ? { ok: true } : { ok: false, error: text === "wrong secret" ? "The secret in .env.local does not match the one in the script." : `Google did not accept it (${res.status}).` };
  } catch {
    result = { ok: false, error: "Could not reach Google." };
  }
  g.__sheetLast = { ...result, at: new Date().toISOString() };
  return result;
}

/** Fire and forget: never slows or breaks the page. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();
export function syncSheetQuietly(db: DB, campaignId: number) {
  if (!sheetConfigured()) return;
  clearTimeout(timers.get(campaignId));          // several changes in a row become one update
  timers.set(campaignId, setTimeout(() => { timers.delete(campaignId); void syncSheet(db, campaignId).catch(() => {}); }, 1500));
}
