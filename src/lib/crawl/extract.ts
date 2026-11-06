/*
  Pull email addresses and useful links out of a web page's HTML.
  No libraries: plain text matching, so it is easy to read and change.

  Finds emails written as:
    - mailto: links
    - plain text            hello@acme.com
    - spelled-out text      hello [at] acme [dot] com
    - HTML entities         hello&#64;acme.com
    - Cloudflare-protected  data-cfemail="..."   (very common on small business sites)
*/

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}/gi;
const FILE_ENDINGS = /\.(png|jpe?g|gif|svg|webp|avif|css|js|mjs|woff2?|ttf|ico|pdf|mp4|map)$/i;
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "domain.com", "yourdomain.com", "yourcompany.com", "email.com",
  "test.com", "sentry.io", "wixpress.com", "sentry-next.wixpress.com", "godaddy.com",
]);

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&amp;/gi, "&");
}

/** Cloudflare hides emails as hex: first byte is a key, the rest is XORed with it. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out.includes("@") ? out : null;
}

function deobfuscate(s: string): string {
  return s
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, "@")
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, ".");
}

export function isUsableEmail(raw: string): boolean {
  const e = raw.toLowerCase();
  const [local, domain] = e.split("@");
  if (!local || !domain) return false;
  if (local.length > 64 || e.length > 254) return false;
  if (FILE_ENDINGS.test(e)) return false;          // logo@2x.png
  if (/^[0-9a-f]{24,}$/.test(local)) return false; // tracking ids
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  return true;
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const add = (s: string) => {
    for (const m of s.matchAll(EMAIL_RE)) {
      const e = m[0].toLowerCase().replace(/[.]+$/, "");
      if (isUsableEmail(e)) found.add(e);
    }
  };

  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) add(e);
  }
  for (const m of html.matchAll(/email-protection#([0-9a-f]+)/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) add(e);
  }

  const text = deobfuscate(decodeEntities(html));
  for (const m of text.matchAll(/mailto:([^"'\s>?]+)/gi)) {
    try { add(decodeURIComponent(m[1])); } catch { add(m[1]); }
  }
  add(text);
  return [...found];
}

const LINK_WORDS: Array<[RegExp, number]> = [
  [/contact|reach-us|get-in-touch|enquir|inquir/i, 1],
  [/team|people|leadership|management|partners|our-?advis|who-we-are|founder/i, 2],
  [/about/i, 3],
  [/connect|support|help|locat|office/i, 4],
];
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3)(\?|#|$)/i;

const hostKey = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Same-site links that probably hold contact details, best first. */
export function extractLinks(html: string, baseUrl: string, limit = 8): string[] {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return []; }
  const ranked = new Map<string, number>();
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeEntities(m[1]).trim();
    if (href.startsWith("#")) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href) || SKIP_EXT.test(href)) continue;
    let u: URL;
    try { u = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || hostKey(u.hostname) !== hostKey(base.hostname)) continue;
    u.hash = "";
    const key = u.toString();
    if (key === base.toString() || u.pathname === "/" || ranked.has(key)) continue;
    const hit = LINK_WORDS.find(([re]) => re.test(u.pathname));
    if (hit) ranked.set(key, hit[1]);
  }
  return [...ranked.entries()].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([u]) => u);
}

/** A short description of the company taken from its own home page (meta description, else the title). */
export function extractAbout(html: string, maxLen = 220): string | null {
  const meta =
    html.match(/<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:og:description|description)["']/i)?.[1];
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  const raw = (meta ?? title ?? "").replace(/\s+/g, " ").trim();
  if (raw.length < 15) return null;
  const text = decodeEntities(raw);
  return text.length > maxLen ? text.slice(0, maxLen - 1).trimEnd() + "…" : text;
}
