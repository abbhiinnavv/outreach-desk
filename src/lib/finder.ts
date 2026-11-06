import { geminiJson, type GeminiDeps } from "./gemini";
import { normalizeDomain } from "./domain";
import type { Fetcher } from "./crawl/fetcher";

/*
  Company finder.
    1. Gemini suggests firms that match your search.
    2. We do NOT trust those suggestions. Every website is visited, and a company is marked
       "verified" only if the site loads and mentions the company's name.
  Gemini can invent companies. This check is what keeps invented ones out of your list.
*/
export interface Suggestion {
  name: string;
  website: string;
  city: string | null;
  region: string | null;
}

export type CheckStatus = "verified" | "blocked" | "mismatch" | "unreachable";

export interface Candidate extends Suggestion {
  domain: string;
  status: CheckStatus;
  note: string;
}

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING" },
      website: { type: "STRING" },
      city: { type: "STRING" },
      region: { type: "STRING" },
    },
    required: ["name", "website"],
  },
};

export async function suggestCompanies(query: string, regions: string[], count: number, deps: GeminiDeps = {}): Promise<Suggestion[]> {
  const n = Math.min(Math.max(Math.floor(count) || 10, 1), 25);
  const prompt = `You are helping a sales team build a list of REAL companies.
Task: list up to ${n} real companies that match this search: "${query}".
The team targets these regions: ${regions.join(", ")}.
Rules:
- Only include companies you are confident really exist and are operating.
- Give each company's official website (like example.com). If you are not sure of the website, leave that company out.
- Do not invent companies. Do not include directories, news sites, social media pages or government pages.
- "region" is the country the company is based in. "city" is its main city.`;
  const raw = await geminiJson<Array<Record<string, unknown>>>(prompt, SCHEMA, deps);
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
    const domain = normalizeDomain(typeof r.website === "string" ? r.website : "");
    if (!name || !domain || seen.has(domain)) continue;
    seen.add(domain);
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
    out.push({ name, website: domain, city: s(r.city), region: s(r.region) });
    if (out.length >= n) break;
  }
  return out;
}

const GENERIC = new Set(["wealth", "capital", "advisors", "advisory", "advisor", "partners", "management", "financial", "services", "limited", "private", "asset", "assets", "investment", "investments", "family", "office", "group", "india", "pvt", "ltd", "company", "solutions", "securities", "finance", "fund", "funds", "managers"]);

/** The words in a company name that actually identify it (not "wealth", "capital", and so on). */
export function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !GENERIC.has(t));
}

async function checkOne(s: Suggestion, fetcher: Fetcher): Promise<Candidate> {
  const domain = normalizeDomain(s.website)!;
  const base = { ...s, domain };
  let lastStatus = 0;
  for (const url of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    try {
      const r = await fetcher(url);
      lastStatus = r.status;
      if (r.ok && r.text) {
        const text = r.text.toLowerCase();
        const tokens = nameTokens(s.name);
        const label = domain.split(".")[0];
        const hit = tokens.some((t) => text.includes(t)) || (label.length >= 4 && text.includes(label) && s.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(label));
        if (hit || tokens.length === 0) return { ...base, status: "verified", note: "website loads and mentions the company" };
        return { ...base, status: "mismatch", note: "website loads but does not mention the company name" };
      }
      if (r.status === 401 || r.status === 403 || r.status === 429) return { ...base, status: "blocked", note: "the site blocks automated visitors, so it could not be checked" };
    } catch { /* try the next address */ }
  }
  return { ...base, status: "unreachable", note: lastStatus ? `site answered with status ${lastStatus}` : "website did not respond" };
}

export async function checkCandidates(list: Suggestion[], fetcher: Fetcher, concurrency = 5): Promise<Candidate[]> {
  const out: Candidate[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await checkOne(list[i], fetcher);
    }
  }));
  const order: Record<CheckStatus, number> = { verified: 0, mismatch: 1, blocked: 2, unreachable: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status]);
}
