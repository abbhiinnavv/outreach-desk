import type { DB } from "./db";

/*
  The funnel: how many companies made it through each stage. Every number comes straight from the database.
  Replies from "Add sample replies" are counted separately so demo data never passes as real results.
*/
export interface FunnelStage { key: string; label: string; count: number; hint: string }
export interface Funnel {
  stages: FunnelStage[];
  bounced: number;
  autoReplies: number;
  doNotEmail: number;
  sampleReplies: number;
  highFit: number;
}

const one = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const FROM_SENDS = `FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ?`;
const FROM_REPLIES = `FROM replies r JOIN sends s ON s.id = r.send_id JOIN drafts d ON d.id = s.draft_id JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ?`;

export function buildFunnel(db: DB, id: number): Funnel {
  const companies = one(db, `SELECT COUNT(*) AS n FROM companies WHERE campaign_id = ?`, id);
  const withEmail = one(db, `SELECT COUNT(DISTINCT c.id) AS n FROM companies c JOIN contacts ct ON ct.company_id = c.id WHERE c.campaign_id = ? AND ct.verification IN ('valid','risky') AND COALESCE(ct.kind,'person') <> 'avoid'`, id);
  const written = one(db, `SELECT COUNT(DISTINCT d.company_id) AS n FROM drafts d JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ?`, id);
  const approved = one(db, `SELECT COUNT(DISTINCT d.company_id) AS n FROM drafts d JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND d.status IN ('approved','sent')`, id);
  const sent = one(db, `SELECT COUNT(DISTINCT d.company_id) AS n ${FROM_SENDS} AND s.status IN ('sent','bounced')`, id);
  const replied = one(db, `SELECT COUNT(DISTINCT d.company_id) AS n ${FROM_REPLIES} AND r.label NOT IN ('Out of office','Bounced')`, id);
  const interested = one(db, `SELECT COUNT(DISTINCT d.company_id) AS n ${FROM_REPLIES} AND r.label IN ('Interested','Question')`, id);
  const meetings = one(db, `SELECT COUNT(DISTINCT d.company_id) AS n ${FROM_REPLIES} AND r.meeting_booked = 1`, id);
  return {
    stages: [
      { key: "found", label: "Companies found", count: companies, hint: "Added by AI search or CSV" },
      { key: "email", label: "Have a usable email", count: withEmail, hint: "Valid or risky, not careers@ or legal@" },
      { key: "written", label: "Email written", count: written, hint: "Drafted by Gemini or the template" },
      { key: "approved", label: "Approved by you", count: approved, hint: "Nothing is sent without this" },
      { key: "sent", label: "Sent", count: sent, hint: "Delivered through your Gmail" },
      { key: "replied", label: "Replied", count: replied, hint: "A human answer, not an auto-reply or bounce" },
      { key: "interested", label: "Interested or asked a question", count: interested, hint: "These need your answer" },
      { key: "meeting", label: "Meeting booked", count: meetings, hint: "You mark this on the replies page" },
    ],
    bounced: one(db, `SELECT COUNT(*) AS n ${FROM_REPLIES} AND r.label = 'Bounced'`, id),
    autoReplies: one(db, `SELECT COUNT(*) AS n ${FROM_REPLIES} AND r.label = 'Out of office'`, id),
    doNotEmail: one(db, `SELECT COUNT(*) AS n FROM suppression`),
    sampleReplies: one(db, `SELECT COUNT(*) AS n ${FROM_REPLIES} AND r.simulated = 1`, id),
    highFit: one(db, `SELECT COUNT(*) AS n FROM companies WHERE campaign_id = ? AND fit_label = 'High'`, id),
  };
}

/** Conversion from the previous stage, as a whole percent, or null when there is nothing to divide by. */
export const conversion = (prev: number, now: number) => (prev > 0 ? Math.round((now / prev) * 100) : null);
