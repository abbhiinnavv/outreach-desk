/*
  Downloads one web page safely: with a time limit, a size limit, and an honest name.
  Also reads robots.txt, the file where a website says which pages bots may visit.
  We follow it. If a site says "no bots", we skip that site.
*/
export const USER_AGENT = "OutreachDeskBot/0.1 (research crawler; respects robots.txt)";
export const BOT_TOKEN = "outreachdeskbot";

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string; // final URL after redirects
  text: string;
  contentType: string;
}
export type Fetcher = (url: string) => Promise<FetchResult>;

export function makeFetcher(o: { timeoutMs?: number; maxBytes?: number } = {}): Fetcher {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const maxBytes = o.maxBytes ?? 1_000_000;
  return async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const finalUrl = res.url || url;
      if (contentType && !/text\/|xml/i.test(contentType)) {
        await res.body?.cancel();
        return { ok: false, status: res.status, url: finalUrl, text: "", contentType };
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size >= maxBytes) { await reader.cancel(); break; }
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      return { ok: res.ok, status: res.status, url: finalUrl, text, contentType };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Is this path allowed for our bot, according to the robots.txt text? */
export function robotsAllows(robotsTxt: string, pathAndQuery: string): boolean {
  type Group = { agents: string[]; rules: Array<{ allow: boolean; path: string }> };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (val) cur.rules.push({ allow: key === "allow", path: val });
    } else lastWasAgent = false;
  }
  // A group that names us beats the "*" group.
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && BOT_TOKEN.includes(a.replace(/\/.*/, ""))));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      const pattern = r.path.endsWith("$") ? r.path.slice(0, -1) : r.path;
      const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (r.path.endsWith("$") ? "$" : ""));
      if (re.test(pathAndQuery) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) {
        best = { allow: r.allow, len: r.path.length };
      }
    }
  }
  return best ? best.allow : true;
}
