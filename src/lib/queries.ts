import type { DB } from "./db";
import type { CampaignInput } from "./brief";

export interface CampaignRow extends Omit<CampaignInput, "regions"> {
  id: number;
  regions: string[];
  createdAt: string;
}

// Which contact is "the" contact for a company: skip invalid ones, prefer decision-makers, then people over generic inboxes.
export const CONTACT_ORDER = "(verification = 'invalid'), tier = 'decision' DESC, priority, CASE verification WHEN 'valid' THEN 0 WHEN 'risky' THEN 1 WHEN 'unchecked' THEN 2 ELSE 3 END, id";

const toCampaign = (r: any): CampaignRow => ({
  id: r.id, name: r.name, product: r.product, pitch: r.pitch,
  regions: JSON.parse(r.regions),
  goal: r.goal, tone: r.tone, sender: r.sender, dailyCap: r.daily_cap, createdAt: r.created_at,
});

export function createCampaign(db: DB, c: CampaignInput): number {
  const info = db
    .prepare(
      `INSERT INTO campaigns (name, product, pitch, regions, goal, tone, sender, daily_cap)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(c.name, c.product, c.pitch, JSON.stringify(c.regions), c.goal, c.tone, c.sender, c.dailyCap);
  return Number(info.lastInsertRowid);
}

export function getCampaign(db: DB, id: number): CampaignRow | null {
  const r = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id);
  return r ? toCampaign(r) : null;
}

export function listCampaigns(db: DB): Array<CampaignRow & { companies: number }> {
  const rows = db
    .prepare(`SELECT c.*, (SELECT COUNT(*) FROM companies WHERE campaign_id = c.id) AS n FROM campaigns c ORDER BY c.id DESC`)
    .all() as any[];
  return rows.map((r) => ({ ...toCampaign(r), companies: r.n }));
}

export interface CompanyFilters {
  fit?: "High" | "Medium" | "Low" | "";
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface CompanyListItem {
  id: number; name: string; domain: string; city: string | null; region: string | null;
  trigger: string | null;
  fitScore: number; fitLabel: string; status: string;
  contactEmail: string | null; contactRole: string | null;
  contactVerification: string | null; contactSource: string | null; contactNote: string | null;
  emailCount: number; crawlStatus: string; crawlNote: string | null;
}

export function listCompanies(db: DB, campaignId: number, f: CompanyFilters = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const where = ["c.campaign_id = ?"];
  const args: Array<string | number> = [campaignId];
  if (f.fit) { where.push("c.fit_label = ?"); args.push(f.fit); }
  if (f.q?.trim()) {
    where.push("(c.name LIKE ? OR c.domain LIKE ?)");
    const like = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    args.push(like, like);
  }
  const w = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM companies c WHERE ${w}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT c.*,
         (SELECT email FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1) AS contact_email,
         (SELECT role  FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1) AS contact_role,
         (SELECT verification FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1) AS contact_verification,
         (SELECT source_url FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1) AS contact_source,
         (SELECT verify_note FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1) AS contact_note,
         (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) AS email_count
       FROM companies c WHERE ${w}
       ORDER BY c.fit_score DESC, c.name COLLATE NOCASE LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize) as any[];
  const items: CompanyListItem[] = rows.map((r) => ({
    id: r.id, name: r.name, domain: r.domain, city: r.city, region: r.region,
    trigger: r.trigger, fitScore: r.fit_score, fitLabel: r.fit_label, status: r.status,
    contactEmail: r.contact_email, contactRole: r.contact_role,
    contactVerification: r.contact_verification, contactSource: r.contact_source, contactNote: r.contact_note,
    emailCount: r.email_count, crawlStatus: r.crawl_status, crawlNote: r.crawl_note,
  }));
  return { items, total, page, pageSize, pages: Math.max(Math.ceil(total / pageSize), 1) };
}

export function campaignStats(db: DB, campaignId: number) {
  const by = db
    .prepare(`SELECT fit_label AS label, COUNT(*) AS n FROM companies WHERE campaign_id = ? GROUP BY fit_label`)
    .all(campaignId) as Array<{ label: string; n: number }>;
  const get = (l: string) => by.find((b) => b.label === l)?.n ?? 0;
  const withEmail = (db
    .prepare(`SELECT COUNT(DISTINCT company_id) AS n FROM contacts WHERE company_id IN (SELECT id FROM companies WHERE campaign_id = ?)`)
    .get(campaignId) as { n: number }).n;
  const total = get("High") + get("Medium") + get("Low");
  return { total, high: get("High"), medium: get("Medium"), low: get("Low"), withEmail };
}

export interface ContactRow {
  id: number; companyId: number; email: string; name: string | null; role: string | null;
  kind: string; verification: string; note: string | null; sourceUrl: string | null; method: string;
}

export function contactsFor(db: DB, companyIds: number[]): Map<number, ContactRow[]> {
  const out = new Map<number, ContactRow[]>();
  if (companyIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT * FROM contacts WHERE company_id IN (${companyIds.map(() => "?").join(",")}) ORDER BY ${CONTACT_ORDER}`
    )
    .all(...companyIds) as any[];
  for (const r of rows) {
    const list = out.get(r.company_id) ?? [];
    list.push({
      id: r.id, companyId: r.company_id, email: r.email, name: r.name, role: r.role, kind: r.kind ?? "person",
      verification: r.verification, note: r.verify_note, sourceUrl: r.source_url, method: r.method,
    });
    out.set(r.company_id, list);
  }
  return out;
}
