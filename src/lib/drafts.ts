import type { DB } from "./db";
import { geminiJson, GeminiError, type GeminiDeps } from "./gemini";
import { assembleEmail, askLine } from "./email-template";
import { extractAbout } from "./crawl/extract";
import type { Fetcher } from "./crawl/fetcher";
import { CONTACT_ORDER, getCampaign, type CampaignRow } from "./queries";

/*
  Writing the emails.
    - Only companies with a usable email get one (not invalid, not careers@/legal@ style inboxes).
    - We read each company's own home page description, so the email can mention something real.
    - Gemini writes the middle of the email, 5 companies per request (free limits are small).
      If Gemini is missing, out of quota, or writes something unsafe, a plain template is used instead.
    - Nothing is ever sent from here. Every draft waits for your approval.
*/
export interface Eligible {
  companyId: number; name: string; domain: string; city: string | null; region: string | null;
  contactId: number; email: string; contactName: string | null; kind: string; verification: string;
}

export function eligibleCompanies(db: DB, campaignId: number): Eligible[] {
  return db
    .prepare(
      `SELECT c.id AS companyId, c.name, c.domain, c.city, c.region,
              ct.id AS contactId, ct.email, ct.name AS contactName, ct.kind, ct.verification
         FROM companies c
         JOIN contacts ct ON ct.id = (SELECT id FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1)
        WHERE c.campaign_id = ?
          AND ct.verification IN ('valid', 'risky') AND COALESCE(ct.kind, 'person') <> 'avoid'
          AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.company_id = c.id)
        ORDER BY c.fit_score DESC, c.id`
    )
    .all(campaignId) as Eligible[];
}

// ---------- the fallback template ----------
export function templateParagraphs(c: Eligible, campaign: CampaignRow, about: string | null): string {
  const pitch = campaign.pitch.trim().replace(/\s+/g, " ");
  const place = c.city || c.region;
  const intro = `I'm ${campaign.sender} from ${campaign.product}. ${/[.!?]$/.test(pitch) ? pitch : pitch + "."}`;
  const hook = about && about.length <= 160
    ? `I came across ${c.name}${place ? ` in ${place}` : ""} and saw how you describe yourselves: "${about}"`
    : `I'm reaching out to a small number of firms${place ? ` in ${place}` : ""}, and ${c.name} stood out.`;
  return `${intro}\n\n${hook} ${askLine(campaign)}`;
}

export function templateSubjects(c: Eligible, campaign: CampaignRow): [string, string] {
  return [`A quick idea for ${c.name}`, `${campaign.product} and ${c.name}`];
}

// ---------- checking what Gemini wrote ----------
export function validParagraphs(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 120 || t.length > 1100) return false;
  if (/https?:|www\.|@|\[|\]|\{|\}|<|>/i.test(t)) return false;           // no links, emails or placeholders
  if (/\b(dear sir|hope this (email )?finds you)/i.test(t)) return false;  // generic filler
  return true;
}
export function validSubject(s: unknown): s is string {
  return typeof s === "string" && s.trim().length >= 4 && s.trim().length <= 70 && !/[\r\n]/.test(s) && s !== s.toUpperCase();
}

const GOAL_TEXT: Record<CampaignRow["goal"], string> = {
  demo: "ask for a short demo call", reply: "ask for a simple reply about whether this is relevant", pilot: "ask whether they would try a small pilot",
};

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { id: { type: "STRING" }, subject_a: { type: "STRING" }, subject_b: { type: "STRING" }, body: { type: "STRING" } },
    required: ["id", "subject_a", "subject_b", "body"],
  },
};

interface Written { subjectA: string; subjectB: string; paragraphs: string }

async function askGemini(batch: Array<{ c: Eligible; about: string | null }>, campaign: CampaignRow, deps: GeminiDeps): Promise<Map<number, Written>> {
  const prompt = `You write short, honest outreach emails on behalf of ${campaign.sender}, who sells ${campaign.product}.
What ${campaign.product} does (use ONLY this, add no other claims about it): "${campaign.pitch}"
Goal of each email: ${GOAL_TEXT[campaign.goal]}. Tone: ${campaign.tone}.

For each company below write:
- subject_a and subject_b: two different angles, each under 50 characters, no ALL CAPS, no emojis, no clickbait.
- body: 55 to 90 words in 2 short paragraphs, plain text. No greeting and no sign-off (those are added separately).

Rules:
- Mention one real detail about the company ONLY if it appears in "site says". Otherwise do not pretend to know them.
- Do not invent facts, numbers, customers, results, awards or mutual connections.
- No links, email addresses, or placeholders in brackets. No phrases like "I hope this finds you well".
- End with one clear, low-pressure ask.

Companies (JSON): ${JSON.stringify(batch.map(({ c, about }) => ({ id: String(c.companyId), name: c.name, location: [c.city, c.region].filter(Boolean).join(", ") || null, "site says": about })))}`;
  const raw = await geminiJson<Array<Record<string, unknown>>>(prompt, SCHEMA, deps);
  const out = new Map<number, Written>();
  for (const r of Array.isArray(raw) ? raw : []) {
    const id = Number(r.id);
    if (batch.some(({ c }) => c.companyId === id) && validSubject(r.subject_a) && validSubject(r.subject_b) && validParagraphs(r.body) && r.subject_a !== r.subject_b) {
      out.set(id, { subjectA: (r.subject_a as string).trim(), subjectB: (r.subject_b as string).trim(), paragraphs: (r.body as string).trim() });
    }
  }
  return out;
}

export function whyThisFirm(c: Eligible, about: string | null): string {
  const kind = c.kind === "person" ? "a person's address" : c.kind === "business" ? "a business inbox" : c.kind === "general" ? "a general inbox" : "a support inbox";
  return `${c.region ? `Based in ${c.region}, one of your target regions. ` : ""}Sending to ${c.email} (${kind}, email check: ${c.verification}). ` +
    (about ? `Their site says: "${about}"` : "No site description was available, so the email stays general.");
}

export interface DraftingDeps {
  fetcher: Fetcher;
  gemini?: GeminiDeps;
  useGemini?: boolean;
  delayMs?: number; // pause between Gemini calls to stay inside the free limit
}
export interface DraftingResult { written: number; byGemini: number; byTemplate: number; note: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function writeDrafts(db: DB, campaignId: number, deps: DraftingDeps, opts: { shouldStop?: () => boolean } = {}): Promise<DraftingResult> {
  const campaign = getCampaign(db, campaignId);
  const result: DraftingResult = { written: 0, byGemini: 0, byTemplate: 0, note: null };
  if (!campaign) return result;
  const list = eligibleCompanies(db, campaignId);
  let geminiOn = deps.useGemini ?? true;
  const insert = db.prepare(
    `INSERT INTO drafts (company_id, contact_id, subject_a, subject_b, variant, body, rationale, written_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (let i = 0; i < list.length; i += 5) {
    if (opts.shouldStop?.()) { result.note = "Stopped by you."; break; }
    const chunk = list.slice(i, i + 5);
    const abouts = await Promise.all(chunk.map(async (c) => {
      for (const u of [`https://${c.domain}`, `https://www.${c.domain}`]) {
        try { const r = await deps.fetcher(u); if (r.ok && r.text) return extractAbout(r.text); } catch { /* try next */ }
      }
      return null;
    }));
    const batch = chunk.map((c, k) => ({ c, about: abouts[k] }));

    let written = new Map<number, Written>();
    if (geminiOn) {
      try {
        written = await askGemini(batch, campaign, deps.gemini ?? {});
        if (deps.delayMs) await sleep(deps.delayMs);
      } catch (e) {
        if (e instanceof GeminiError) {
          geminiOn = false;
          result.note = e.kind === "quota" ? "Gemini's free limit ran out, so the rest were written from the template." : `Gemini was not used (${e.message}) so the rest were written from the template.`;
        } else throw e;
      }
    }

    db.transaction(() => {
      for (const { c, about } of batch) {
        const w = written.get(c.companyId);
        const [tA, tB] = templateSubjects(c, campaign);
        const paragraphs = w?.paragraphs ?? templateParagraphs(c, campaign, about);
        const body = assembleEmail({ companyName: c.name, contactName: c.contactName, paragraphs, sender: campaign.sender });
        insert.run(c.companyId, c.contactId, w?.subjectA ?? tA, w?.subjectB ?? tB, c.companyId % 2 === 0 ? "A" : "B", body, whyThisFirm(c, about), w ? "gemini" : "template");
        result.written++;
        if (w) result.byGemini++; else result.byTemplate++;
      }
    })();
  }
  if (!result.note && result.byTemplate > 0 && result.byGemini === 0 && deps.useGemini !== false) result.note = "These were written from the template.";
  return result;
}

// ---------- approval ----------
export type Intent = "save" | "approve" | "reject" | "reset";
export interface ReviewInput { subjectA?: string; subjectB?: string; variant?: string; body?: string }

export function reviewDraft(db: DB, draftId: number, intent: Intent, input: ReviewInput = {}): { ok: boolean; error?: string } {
  const d = db.prepare(`SELECT d.*, ct.verification AS verification FROM drafts d LEFT JOIN contacts ct ON ct.id = d.contact_id WHERE d.id = ?`).get(draftId) as
    | { status: string; subject_a: string; subject_b: string; variant: string; body: string; verification: string | null }
    | undefined;
  if (!d) return { ok: false, error: "Draft not found." };
  if (d.status === "sent") return { ok: false, error: "This email was already sent." };

  if (intent === "reject") { db.prepare(`UPDATE drafts SET status = 'rejected' WHERE id = ?`).run(draftId); return { ok: true }; }
  if (intent === "reset") { db.prepare(`UPDATE drafts SET status = 'pending' WHERE id = ?`).run(draftId); return { ok: true }; }

  const subjectA = (input.subjectA ?? d.subject_a).trim();
  const subjectB = (input.subjectB ?? d.subject_b).trim();
  const body = (input.body ?? d.body).replace(/\r\n/g, "\n").trim();
  const variant = input.variant === "B" ? "B" : input.variant === "A" ? "A" : d.variant;
  if (!subjectA || !subjectB || /[\r\n]/.test(subjectA + subjectB)) return { ok: false, error: "Subjects must be filled in, on one line." };
  if (body.length < 30 || body.length > 5000) return { ok: false, error: "The email body is too short or too long." };
  if (intent === "approve" && (d.verification === "invalid" || !d.verification)) return { ok: false, error: "This email address failed its check. Add a better one first." };

  db.prepare(`UPDATE drafts SET subject_a = ?, subject_b = ?, variant = ?, body = ?, status = ? WHERE id = ?`)
    .run(subjectA, subjectB, variant, body, intent === "approve" ? "approved" : d.status, draftId);
  return { ok: true };
}

export function draftCounts(db: DB, campaignId: number) {
  const rows = db.prepare(`SELECT d.status AS s, COUNT(*) AS n FROM drafts d JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? GROUP BY d.status`).all(campaignId) as Array<{ s: string; n: number }>;
  const get = (s: string) => rows.find((r) => r.s === s)?.n ?? 0;
  return { pending: get("pending"), approved: get("approved"), rejected: get("rejected"), sent: get("sent"), total: rows.reduce((a, r) => a + r.n, 0), waiting: eligibleCompanies(db, campaignId).length };
}

export interface DraftView {
  id: number; status: string; subjectA: string; subjectB: string; variant: string; body: string; rationale: string | null; writtenBy: string;
  company: string; domain: string; fitScore: number; email: string; kind: string; verification: string;
}

export function listDrafts(db: DB, campaignId: number, status: string, page = 1, pageSize = 15) {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM drafts d JOIN companies c ON c.id = d.company_id WHERE c.campaign_id = ? AND d.status = ?`).get(campaignId, status) as { n: number }).n;
  const rows = db.prepare(
    `SELECT d.id, d.status, d.subject_a, d.subject_b, d.variant, d.body, d.rationale, d.written_by, c.name, c.domain, c.fit_score,
            ct.email, COALESCE(ct.kind, 'person') AS kind, ct.verification
       FROM drafts d JOIN companies c ON c.id = d.company_id LEFT JOIN contacts ct ON ct.id = d.contact_id
      WHERE c.campaign_id = ? AND d.status = ? ORDER BY c.fit_score DESC, d.id LIMIT ? OFFSET ?`
  ).all(campaignId, status, pageSize, (Math.max(page, 1) - 1) * pageSize) as any[];
  const items: DraftView[] = rows.map((r) => ({
    id: r.id, status: r.status, subjectA: r.subject_a, subjectB: r.subject_b, variant: r.variant, body: r.body, rationale: r.rationale, writtenBy: r.written_by,
    company: r.name, domain: r.domain, fitScore: r.fit_score, email: r.email, kind: r.kind, verification: r.verification,
  }));
  return { items, total, pages: Math.max(Math.ceil(total / pageSize), 1), page: Math.max(page, 1) };
}
