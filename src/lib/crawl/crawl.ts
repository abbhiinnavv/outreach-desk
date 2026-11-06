import { extractEmails, extractLinks } from "./extract";
import { robotsAllows, type Fetcher } from "./fetcher";

/*
  Visit one company website and collect the emails on it.
  It reads the home page, then the contact / about / team pages it links to (max 6 pages in total),
  waits a moment between requests, and obeys robots.txt.
  Every email is saved together with the page it was found on.
*/
export interface FoundEmail { email: string; sourceUrl: string }

export interface CrawlResult {
  pagesVisited: string[];
  found: FoundEmail[];
  error?: string;
}

export interface CrawlOptions {
  maxPages?: number;
  delayMs?: number;
  /** Override where to start (used by tests). Normally https://domain, www.domain, then http. */
  bases?: string[];
  maxEmails?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function crawlSite(domain: string, fetcher: Fetcher, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 6;
  const delayMs = opts.delayMs ?? 600;
  const bases = opts.bases ?? [`https://${domain}`, `https://www.${domain}`, `http://${domain}`];
  const result: CrawlResult = { pagesVisited: [], found: [] };

  // 1. Find a base address that answers with a web page.
  let home: { url: string; text: string } | null = null;
  let lastError = "site did not respond";
  for (const base of bases) {
    try {
      const r = await fetcher(base);
      if (r.ok && r.text) { home = { url: r.url, text: r.text }; break; }
      lastError = `site answered with status ${r.status}`;
    } catch (e) {
      lastError = e instanceof Error && e.name === "AbortError" ? "site took too long" : "site unreachable";
    }
  }
  if (!home) { result.error = lastError; return result; }

  // 2. Respect robots.txt.
  const origin = new URL(home.url).origin;
  let robots = "";
  try {
    const r = await fetcher(`${origin}/robots.txt`);
    if (r.ok && !/<html/i.test(r.text.slice(0, 300))) robots = r.text;
  } catch { /* no robots.txt is fine */ }
  const allowed = (url: string) => {
    const u = new URL(url);
    return robotsAllows(robots, u.pathname + u.search);
  };
  if (!allowed(home.url)) { result.error = "blocked by the site's robots.txt"; return result; }

  // 3. Home page, then the best-looking contact pages.
  const seen = new Map<string, string>(); // email -> first page found on
  const take = (html: string, url: string) => {
    result.pagesVisited.push(url);
    for (const e of extractEmails(html)) if (!seen.has(e)) seen.set(e, url);
  };
  take(home.text, home.url);
  const queue = extractLinks(home.text, home.url, maxPages * 2).filter(allowed);
  for (const url of queue) {
    if (result.pagesVisited.length >= maxPages) break;
    await sleep(delayMs);
    try {
      const r = await fetcher(url);
      if (r.ok && r.text) take(r.text, r.url);
    } catch { /* skip a page that fails */ }
  }

  // Emails on the company's own domain first: they are the most trustworthy.
  const root = domain.replace(/^www\./, "");
  const own = (e: string) => e.endsWith("@" + root) || e.endsWith("." + root);
  result.found = [...seen.entries()]
    .map(([email, sourceUrl]) => ({ email, sourceUrl }))
    .sort((a, b) => Number(own(b.email)) - Number(own(a.email)))
    .slice(0, opts.maxEmails ?? 10);
  return result;
}
