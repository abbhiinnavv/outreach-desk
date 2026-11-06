import type { DB } from "./db";
import { contactTier, emailKind, KIND_PRIORITY } from "./score";

/*
  One place that saves a contact, so every source (CSV, crawler, manual) ranks and labels it the same way.
  Returns true if it was new, false if that email was already saved for the company.
*/
export interface NewContact {
  companyId: number;
  email: string;
  name?: string | null;
  role?: string | null;
  sourceUrl?: string | null;
  method: "imported" | "crawled" | "manual";
}

export function contactInserter(db: DB) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO contacts (company_id, name, role, email, tier, source_url, method, kind, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return (c: NewContact): boolean => {
    const kind = emailKind(c.email);
    const info = stmt.run(c.companyId, c.name ?? null, c.role ?? null, c.email, contactTier(c.role ?? null, c.email), c.sourceUrl ?? null, c.method, kind, KIND_PRIORITY[kind]);
    return info.changes > 0;
  };
}
