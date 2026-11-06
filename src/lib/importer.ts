import Papa from "papaparse";
import type { DB } from "./db";
import { cleanEmail, normalizeDomain } from "./domain";
import { scoreCompany, type Brief } from "./score";
import { CONTACT_ORDER } from "./queries";
import { contactInserter } from "./contacts";

/*
  CSV import. No row limit: 10 rows or 100,000 rows use the same code.
  Everything runs in one database transaction, so a crash never leaves a half-imported list.

  Accepted column names (case and spacing do not matter; the first match wins):
    name      : name, company, company name, firm
    domain    : domain, website, url, site
    city      : city, location
    region    : region, country
    trigger   : trigger, reason, news, signal
    contact   : contact name, contact
    role      : role, title, contact role
    email     : email, contact email
*/
const ALIASES: Record<string, string[]> = {
  name: ["name", "company", "company name", "firm"],
  domain: ["domain", "website", "url", "site"],
  city: ["city", "location"],
  region: ["region", "country"],
  trigger: ["trigger", "reason", "news", "signal"],
  contact: ["contact name", "contact"],
  role: ["role", "title", "contact role"],
  email: ["email", "contact email"],
};

export interface ImportResult {
  total: number;      // data rows seen
  added: number;      // new companies saved
  duplicates: number; // same domain already in this campaign (or earlier in this file)
  merged: number;     // new emails added to a company that was already in the list
  invalid: number;    // rows we could not use
  problems: string[]; // first few reasons, for the UI
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

function mapHeaders(fields: string[]): Record<string, string> {
  const byNorm = new Map(fields.map((f) => [norm(f), f]));
  const out: Record<string, string> = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const hit = names.find((n) => byNorm.has(n));
    if (hit) out[key] = byNorm.get(hit)!;
  }
  return out;
}

export function importCsv(db: DB, campaignId: number, csvText: string, brief: Brief): ImportResult {
  const parsed = Papa.parse<Record<string, string>>(csvText.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
  });
  const cols = mapHeaders(parsed.meta.fields ?? []);
  const result: ImportResult = { total: parsed.data.length, added: 0, duplicates: 0, merged: 0, invalid: 0, problems: [] };

  if (!cols.name || !cols.domain) {
    result.invalid = result.total;
    result.problems.push("The file needs a company name column and a website/domain column.");
    return result;
  }

  const insertCompany = db.prepare(
    `INSERT OR IGNORE INTO companies
       (campaign_id, name, domain, city, region, trigger, fit_score, fit_label, fit_reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const addContact = contactInserter(db);
  const findCompany = db.prepare(`SELECT id FROM companies WHERE campaign_id = ? AND domain = ?`);
  const fillBlanks = db.prepare(`UPDATE companies SET region = COALESCE(region, ?), city = COALESCE(city, ?), trigger = COALESCE(trigger, ?) WHERE id = ?`);

  const note = (msg: string) => { if (result.problems.length < 5) result.problems.push(msg); };

  db.transaction(() => {
    parsed.data.forEach((row, i) => {
      const line = i + 2; // +1 for header, +1 because humans count from 1
      const get = (k: string) => (cols[k] ? (row[cols[k]] ?? "").toString().trim() : "");

      const name = get("name");
      const domain = normalizeDomain(get("domain"));
      if (!name || !domain) {
        result.invalid++;
        note(`Row ${line}: ${!name ? "missing company name" : `"${get("domain")}" is not a valid website`}.`);
        return;
      }

      const trigger = get("trigger") || null;
      const email = cleanEmail(get("email"));
      const role = get("role") || null;
      const region = get("region") || null;

      // Emails from a CSV are not checked yet; they count once they have been verified.
      const fit = scoreCompany({ region, trigger, best: email ? { email, verification: "unchecked" } : null }, brief);

      const info = insertCompany.run(
        campaignId, name, domain, get("city") || null, region, trigger,
        fit.score, fit.label, JSON.stringify(fit.reasons)
      );
      if (info.changes === 0) {
        result.duplicates++;
        // A repeated company can still bring a new email, or fill in a region it was missing.
        const existing = findCompany.get(campaignId, domain) as { id: number } | undefined;
        if (existing) {
          fillBlanks.run(region, get("city") || null, trigger, existing.id);
          if (email && addContact({ companyId: existing.id, email, name: get("contact") || null, role, method: "imported" })) result.merged++;
        }
        return;
      }
      result.added++;
      if (email) addContact({ companyId: Number(info.lastInsertRowid), email, name: get("contact") || null, role, method: "imported" });
    });
  })();

  return result;
}

/** Re-score every company in a campaign (use after emails are checked, or the brief or the weights change). */
export function rescoreCampaign(db: DB, campaignId: number, brief: Brief): number {
  const rows = db
    .prepare(
      `SELECT c.id, c.region, c.trigger,
              (SELECT email        FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1) AS email,
              (SELECT verification FROM contacts WHERE company_id = c.id ORDER BY ${CONTACT_ORDER} LIMIT 1) AS verification
         FROM companies c WHERE c.campaign_id = ?`
    )
    .all(campaignId) as Array<{ id: number; region: string | null; trigger: string | null; email: string | null; verification: string | null }>;
  const upd = db.prepare(`UPDATE companies SET fit_score = ?, fit_label = ?, fit_reasons = ? WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) {
      const fit = scoreCompany(
        { region: r.region, trigger: r.trigger, best: r.email ? { email: r.email, verification: r.verification ?? "unchecked" } : null },
        brief
      );
      upd.run(fit.score, fit.label, JSON.stringify(fit.reasons), r.id);
    }
  })();
  return rows.length;
}
