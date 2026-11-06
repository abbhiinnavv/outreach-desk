import type { DB } from "./db";
import { crawlSite } from "./crawl/crawl";
import type { Fetcher } from "./crawl/fetcher";
import { verifyEmail, type MxResolver } from "./crawl/verify";
import { contactInserter } from "./contacts";
import { rescoreCampaign } from "./importer";
import type { Brief } from "./score";

/*
  Enrichment = for each company: visit its website, save the emails found (with the page they came
  from), then check every email the company has, including ones that came from your CSV.
*/
export interface EnrichDeps {
  fetcher: Fetcher;
  mx: MxResolver;
  delayMs?: number;
  maxPages?: number;
  concurrency?: number;
  bases?: (domain: string) => string[] | undefined; // tests only
}

interface CompanyRef { id: number; domain: string }

export async function enrichCompany(db: DB, company: CompanyRef, deps: EnrichDeps, mxCache = new Map<string, boolean | null>()) {
  const crawl = await crawlSite(company.domain, deps.fetcher, {
    delayMs: deps.delayMs,
    maxPages: deps.maxPages,
    bases: deps.bases?.(company.domain),
  });

  const insert = contactInserter(db);
  db.transaction(() => {
    for (const f of crawl.found) insert({ companyId: company.id, email: f.email, sourceUrl: f.sourceUrl, method: "crawled" });
  })();

  const contacts = db.prepare(`SELECT id, email FROM contacts WHERE company_id = ?`).all(company.id) as Array<{ id: number; email: string }>;
  const results: Array<{ id: number; r: Awaited<ReturnType<typeof verifyEmail>> }> = [];
  for (const c of contacts) results.push({ id: c.id, r: await verifyEmail(c.email, company.domain, deps.mx, mxCache) });
  const upd = db.prepare(`UPDATE contacts SET verification = ?, verify_note = ? WHERE id = ?`);
  db.transaction(() => { for (const x of results) upd.run(x.r.verification, x.r.note, x.id); })();

  const failed = !!crawl.error;
  db.prepare(`UPDATE companies SET crawl_status = ?, crawl_note = ?, crawled_at = datetime('now'),
              status = CASE WHEN status = 'imported' THEN 'enriched' ELSE status END WHERE id = ?`)
    .run(failed ? "failed" : "done", failed ? crawl.error : `${crawl.found.length} email(s) found on ${crawl.pagesVisited.length} page(s)`, company.id);
  return { crawl, contacts: contacts.length };
}

export interface RunOptions {
  shouldStop?: () => boolean;
}

/** Process every pending company in a campaign. Returns how many were handled. */
export async function runEnrichment(db: DB, campaignId: number, brief: Brief, deps: EnrichDeps, opts: RunOptions = {}): Promise<number> {
  db.prepare(`UPDATE companies SET crawl_status = 'pending' WHERE campaign_id = ? AND crawl_status = 'crawling'`).run(campaignId);
  const take = db.prepare(`SELECT id, domain FROM companies WHERE campaign_id = ? AND crawl_status = 'pending' ORDER BY fit_score DESC, id LIMIT 1`);
  const mark = db.prepare(`UPDATE companies SET crawl_status = 'crawling' WHERE id = ?`);
  const mxCache = new Map<string, boolean | null>();
  let handled = 0;

  const worker = async () => {
    for (;;) {
      if (opts.shouldStop?.()) return;
      // Claiming a company is synchronous, so two workers never take the same one.
      const next = take.get(campaignId) as CompanyRef | undefined;
      if (!next) return;
      mark.run(next.id);
      try {
        await enrichCompany(db, next, deps, mxCache);
      } catch (e) {
        db.prepare(`UPDATE companies SET crawl_status = 'failed', crawl_note = ? WHERE id = ?`)
          .run(`unexpected error: ${e instanceof Error ? e.message : String(e)}`, next.id);
      }
      handled++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(deps.concurrency ?? 4, 1) }, worker));
  db.prepare(`UPDATE companies SET crawl_status = 'pending' WHERE campaign_id = ? AND crawl_status = 'crawling'`).run(campaignId);
  rescoreCampaign(db, campaignId, brief);
  return handled;
}

export function enrichProgress(db: DB, campaignId: number) {
  const rows = db.prepare(`SELECT crawl_status AS s, COUNT(*) AS n FROM companies WHERE campaign_id = ? GROUP BY crawl_status`).all(campaignId) as Array<{ s: string; n: number }>;
  const get = (s: string) => rows.find((r) => r.s === s)?.n ?? 0;
  const emails = (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE company_id IN (SELECT id FROM companies WHERE campaign_id = ?)`).get(campaignId) as { n: number }).n;
  const good = (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE verification = 'valid' AND company_id IN (SELECT id FROM companies WHERE campaign_id = ?)`).get(campaignId) as { n: number }).n;
  return { pending: get("pending"), crawling: get("crawling"), done: get("done"), failed: get("failed"), emails, validEmails: good };
}

export function resetFailed(db: DB, campaignId: number): number {
  return db.prepare(`UPDATE companies SET crawl_status = 'pending', crawl_note = NULL WHERE campaign_id = ? AND crawl_status = 'failed'`).run(campaignId).changes;
}

/** Check emails that have not been checked yet (for example, ones added from a CSV or by hand). */
export async function verifyUnchecked(db: DB, campaignId: number, mx: MxResolver, max = 300): Promise<number> {
  const rows = db.prepare(
    `SELECT ct.id, ct.email, c.domain FROM contacts ct JOIN companies c ON c.id = ct.company_id
      WHERE c.campaign_id = ? AND ct.verification = 'unchecked' LIMIT ?`
  ).all(campaignId, max) as Array<{ id: number; email: string; domain: string }>;
  const cache = new Map<string, boolean | null>();
  const upd = db.prepare(`UPDATE contacts SET verification = ?, verify_note = ? WHERE id = ?`);
  for (const r of rows) {
    const v = await verifyEmail(r.email, r.domain, mx, cache);
    upd.run(v.verification, v.note, r.id);
  }
  return rows.length;
}
