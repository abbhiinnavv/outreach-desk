import Papa from "papaparse";
import type { DB } from "./db";
import { CONTACT_ORDER } from "./queries";

/*
  The campaign as a simple CSV for Google Sheets or Excel: one row per company.
  Columns: Company, Website, Fit, Best email, Check, Found on page, Other emails.
*/
const dangerous = /^[=+\-@\t\r]/;
// A cell that starts with = + - @ can run as a formula in a spreadsheet. Prefix it so it shows as text.
const safe = (v: unknown) => (typeof v === "string" && dangerous.test(v) ? `'${v}` : v ?? "");

export function buildExportCsv(db: DB, campaignId: number): string {
  const companies = db
    .prepare(`SELECT id, name, domain, fit_score, fit_label FROM companies WHERE campaign_id = ? ORDER BY fit_score DESC, name COLLATE NOCASE`)
    .all(campaignId) as Array<{ id: number; name: string; domain: string; fit_score: number; fit_label: string }>;
  const contacts = db
    .prepare(`SELECT company_id, email, verification, source_url FROM contacts WHERE company_id IN (SELECT id FROM companies WHERE campaign_id = ?) ORDER BY ${CONTACT_ORDER}`)
    .all(campaignId) as Array<{ company_id: number; email: string; verification: string; source_url: string | null }>;
  const byCompany = new Map<number, typeof contacts>();
  for (const c of contacts) byCompany.set(c.company_id, [...(byCompany.get(c.company_id) ?? []), c]);

  const rows = companies.map((co) => {
    const [best, ...others] = byCompany.get(co.id) ?? [];
    return {
      Company: co.name,
      Website: co.domain,
      Fit: `${co.fit_score} ${co.fit_label}`,
      "Best email": best?.email ?? "",
      Check: best?.verification ?? "",
      "Found on page": best?.source_url ?? "",
      "Other emails": others.map((o) => o.email).join("; "),
    };
  });
  const cleaned = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safe(v)])));
  return "﻿" + Papa.unparse(cleaned, { columns: ["Company", "Website", "Fit", "Best email", "Check", "Found on page", "Other emails"] });
}
