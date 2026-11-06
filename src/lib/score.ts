/*
  Fit score: how good a match is this company for the campaign? 0 to 100.

  Four rules, using only things the app can find out by itself (no typing needed):
    Region   the company is in a place you target                          40
    Email    we have an email and it checked out as valid                  30
    Person   the email goes to a person or a sales inbox, not support@     20
    Trigger  there is a reason to reach out right now (optional)           10

  The weights are a starting assumption. Change them here and everything follows.
*/
export const WEIGHTS = { region: 40, email: 30, person: 20, trigger: 10 } as const;
export const THRESHOLDS = { high: 75, medium: 50 } as const;

export type FitLabel = "High" | "Medium" | "Low";

export interface Brief {
  regions: string[];
}

export interface BestContact {
  email: string;
  verification: string; // valid | risky | invalid | unchecked
}

export interface CompanyFacts {
  region: string | null;
  trigger: string | null;
  best: BestContact | null; // the best contact we have for the company, if any
}

export interface Reason {
  rule: "Region" | "Email" | "Person" | "Trigger";
  ok: boolean;
  points: number;
}

export interface Fit {
  score: number;
  label: FitLabel;
  reasons: Reason[];
}

export function labelFor(score: number): FitLabel {
  return score >= THRESHOLDS.high ? "High" : score >= THRESHOLDS.medium ? "Medium" : "Low";
}

export function scoreCompany(c: CompanyFacts, b: Brief): Fit {
  const regionOk = c.region != null && b.regions.some((r) => r.toLowerCase() === c.region!.toLowerCase());
  const emailOk = c.best?.verification === "valid";
  const kind = c.best ? emailKind(c.best.email) : null;
  const reasons: Reason[] = [
    { rule: "Region", ok: regionOk, points: WEIGHTS.region },
    { rule: "Email", ok: emailOk, points: WEIGHTS.email },
    { rule: "Person", ok: emailOk && (kind === "person" || kind === "business"), points: WEIGHTS.person },
    { rule: "Trigger", ok: !!c.trigger && c.trigger.trim() !== "", points: WEIGHTS.trigger },
  ];
  const score = reasons.reduce((sum, r) => sum + (r.ok ? r.points : 0), 0);
  return { score, label: labelFor(score), reasons };
}

/*
  What kind of inbox is this? Used to pick the best address to write to.
  person    a real person's address (asha@, ravi.nair@)            best
  business  sales, partnerships, business development              good
  general   info@, contact@, hello@                                 okay
  support   support@, help@, care@                                  poor: customer service desks
  avoid     careers@, legal@, privacy@: not people who buy software
*/
export type EmailKind = "person" | "business" | "general" | "support" | "avoid";

// Words that give an inbox away, wherever they appear in the name (pmscompliance@, investorgrievance@).
const AVOID_ANYWHERE = /(career|recruit|compliance|grievance|legal|privacy|communication|press|media|investor|nodal|redress|billing|account|finance|csr|esg|foundation|sustainab)/;
const AVOID_EXACT = /^(po|co|cs|hr|ir|jobs?|dpo|abuse|webmaster|noreply|no-reply|postmaster)$/;
const SUPPORT_ANYWHERE = /(support|helpdesk|customer|service|feedback|complaint)/;
const SUPPORT_EXACT = /^(help|care|assist\w*)$/;
const BUSINESS_ANYWHERE = /(sales|partner|business|advis|enterprise|corporate|alliance)/;
const GENERAL_EXACT = /^(info|contact|hello|hi|mail|office|admin|team|enquir\w*|inquir\w*|connect|reach\w*|general|desk)$/;

export function emailKind(email: string): EmailKind {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  if (AVOID_EXACT.test(local) || AVOID_ANYWHERE.test(local)) return "avoid";
  if (SUPPORT_EXACT.test(local) || SUPPORT_ANYWHERE.test(local)) return "support";
  if (BUSINESS_ANYWHERE.test(local)) return "business";
  if (GENERAL_EXACT.test(local) || local.length <= 2) return "general"; // very short names are almost always a role
  return "person";
}

export const KIND_PRIORITY: Record<EmailKind, number> = { person: 0, business: 1, general: 2, support: 3, avoid: 4 };

/* Is the contact a decision-maker? Judged from the job title when we have one. */
const DECISION_WORDS = /\b(founder|co-?founder|owner|partner|managing|ceo|cio|coo|cfo|chief|head|director|president|principal)\b/i;
export type ContactTier = "decision" | "general";
export function contactTier(role: string | null, email: string | null): ContactTier {
  if (!email) return "general";
  return role && DECISION_WORDS.test(role) && emailKind(email) !== "avoid" ? "decision" : "general";
}
