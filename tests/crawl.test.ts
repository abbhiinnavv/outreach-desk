import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extractEmails, extractLinks, decodeCfEmail } from "../src/lib/crawl/extract";
import { robotsAllows, makeFetcher } from "../src/lib/crawl/fetcher";
import { crawlSite } from "../src/lib/crawl/crawl";
import { verifyEmail, type MxResolver } from "../src/lib/crawl/verify";
import { openDb } from "../src/lib/db";
import { createCampaign } from "../src/lib/queries";
import { enrichProgress, resetFailed, runEnrichment } from "../src/lib/enrich";
import { importCsv } from "../src/lib/importer";

const brief = { regions: ["India"] };
const camp = { name: "T", product: "P", pitch: "p", regions: ["India"], goal: "demo" as const, tone: "warm" as const, sender: "A", dailyCap: 10 };

// Build a Cloudflare-style hidden email so we test the real decoding.
const cf = (email: string, key = 0x2a) => key.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");

test("extract: plain, mailto, entities, spelled-out, cloudflare", () => {
  const html = `
    <a href="mailto:Sales@Acme.com?subject=Hi">mail</a>
    <p>Write to founder&#64;acme.com or press [at] acme [dot] com</p>
    <span data-cfemail="${cf("hidden@acme.com")}">[email protected]</span>
    <img src="logo@2x.png"> <p>you@example.com</p> <p>Dr. Rao: rao@acme.com.</p>`;
  const got = extractEmails(html).sort();
  assert.deepEqual(got, ["founder@acme.com", "hidden@acme.com", "press@acme.com", "rao@acme.com", "sales@acme.com"]);
  assert.equal(decodeCfEmail(cf("a@b.co")), "a@b.co");
  assert.equal(decodeCfEmail("zz"), null);
});

test("extract: ranks contact pages, ignores other sites and files", () => {
  const html = `<a href="/about-us">a</a><a href="/contact">c</a><a href="https://other.com/contact">x</a>
    <a href="/brochure.pdf">p</a><a href="/blog/post">b</a><a href="mailto:a@b.com">m</a><a href="/team#x">t</a>`;
  const links = extractLinks(html, "https://www.acme.com/");
  assert.deepEqual(links, ["https://www.acme.com/contact", "https://www.acme.com/team", "https://www.acme.com/about-us"]);
});

test("robots.txt rules", () => {
  const txt = "User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.json$\n\nUser-agent: OutreachDeskBot\nDisallow: /secret";
  assert.equal(robotsAllows(txt, "/contact"), true);
  assert.equal(robotsAllows(txt, "/secret/x"), false);
  assert.equal(robotsAllows(txt, "/private"), true); // the bot-specific group wins over *
  const star = "User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.json$";
  assert.equal(robotsAllows(star, "/private/x"), false);
  assert.equal(robotsAllows(star, "/private/public/a"), true);
  assert.equal(robotsAllows(star, "/data.json"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /", "/anything"), false);
  assert.equal(robotsAllows("", "/x"), true);
});

test("verify labels", async () => {
  const mx: MxResolver = async (d) => (d === "nomail.test" ? false : d === "flaky.test" ? null : true);
  const v = (e: string, dom = "acme.com") => verifyEmail(e, dom, mx);
  assert.equal((await v("a@acme.com")).verification, "valid");
  assert.equal((await v("a@mail.acme.com")).verification, "valid");
  assert.equal((await v("a@gmail.com")).verification, "risky");
  assert.equal((await v("a@other.com")).verification, "risky");
  assert.equal((await v("a@nomail.test", "nomail.test")).verification, "invalid");
  assert.equal((await v("a@flaky.test", "flaky.test")).verification, "risky");
  assert.equal((await v("noreply@acme.com")).verification, "invalid");
  assert.equal((await v("not-an-email")).verification, "invalid");
});

// A tiny real web server so the crawler is tested over real HTTP.
function startSite() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const send = (body: string, type = "text/html", status = 200) => { res.writeHead(status, { "content-type": type }); res.end(body); };
    switch (req.url) {
      case "/": return send(`<a href="/contact">Contact</a><a href="/team">Team</a><a href="/hidden">x</a><p>info@good.test</p>`);
      case "/contact": return send(`<p>Write: asha [at] good [dot] test</p><a href="mailto:ceo@good.test">ceo</a>`);
      case "/team": return send(`<span data-cfemail="${cf("dev@good.test")}"></span>`);
      case "/hidden": return send(`<p>secret@good.test</p>`);
      case "/robots.txt": return send("User-agent: *\nDisallow: /hidden", "text/plain");
      case "/logo.png": return send("x", "image/png");
      default: return send("nope", "text/html", 404);
    }
  });
  return new Promise<{ base: string; hits: string[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => server.close() }))
  );
}

test("crawl over real HTTP: finds emails, records source page, obeys robots.txt", async () => {
  const site = await startSite();
  try {
    const r = await crawlSite("good.test", makeFetcher({ timeoutMs: 3000 }), { bases: [site.base], delayMs: 0 });
    const byEmail = Object.fromEntries(r.found.map((f) => [f.email, new URL(f.sourceUrl).pathname]));
    assert.deepEqual(byEmail, { "info@good.test": "/", "asha@good.test": "/contact", "ceo@good.test": "/contact", "dev@good.test": "/team" });
    assert.ok(!site.hits.includes("/hidden"), "must not visit a page robots.txt forbids");
  } finally { site.close(); }
});

test("crawl: unreachable and blocked sites report a clear reason", async () => {
  const dead = await crawlSite("x.test", makeFetcher({ timeoutMs: 500 }), { bases: ["http://127.0.0.1:1"], delayMs: 0 });
  assert.equal(dead.error, "site unreachable");
  const blocked = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html" });
    res.end(req.url === "/robots.txt" ? "User-agent: *\nDisallow: /" : "<p>a@b.test</p>");
  });
  await new Promise<void>((r) => blocked.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(blocked.address() as AddressInfo).port}`;
    const r = await crawlSite("b.test", makeFetcher(), { bases: [base], delayMs: 0 });
    assert.match(r.error ?? "", /robots/);
    assert.equal(r.found.length, 0);
  } finally { blocked.close(); }
});

test("enrichment end to end: saves emails with sources, verifies, handles failures, resumes", async () => {
  const site = await startSite();
  try {
    const db = openDb(":memory:");
    const id = createCampaign(db, camp);
    importCsv(db, id, "name,domain,region,email\nGood Co,good.test,India,csv@good.test\nDead Co,dead.test,India,\n", brief);
    const mx: MxResolver = async (d) => d !== "dead.test";
    const deps = { fetcher: makeFetcher({ timeoutMs: 1500 }), mx, delayMs: 0, concurrency: 3, bases: (d: string) => (d === "good.test" ? [site.base] : ["http://127.0.0.1:1"]) };

    assert.equal(enrichProgress(db, id).pending, 2);
    await runEnrichment(db, id, brief, deps);
    const p = enrichProgress(db, id);
    assert.equal(p.done, 1);
    assert.equal(p.failed, 1);
    assert.equal(p.pending, 0);
    assert.equal(p.emails, 5); // 4 crawled + 1 from the CSV
    assert.equal(p.validEmails, 5);

    const rows = db.prepare(`SELECT email, method, source_url, verification FROM contacts ORDER BY email`).all() as any[];
    assert.ok(rows.find((r) => r.email === "csv@good.test" && r.method === "imported" && r.verification === "valid"));
    assert.ok(rows.find((r) => r.email === "dev@good.test" && r.method === "crawled" && r.source_url.endsWith("/team")));
    const dead = db.prepare(`SELECT crawl_status, crawl_note FROM companies WHERE domain = 'dead.test'`).get() as any;
    assert.equal(dead.crawl_status, "failed");
    assert.equal(dead.crawl_note, "site unreachable");

    // Running again does nothing new; retrying failed puts it back in the queue.
    assert.equal(await runEnrichment(db, id, brief, deps), 0);
    assert.equal(resetFailed(db, id), 1);
    assert.equal(enrichProgress(db, id).pending, 1);
  } finally { site.close(); }
});

test("enrichment: stop request leaves the rest pending", async () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, camp);
  const lines = ["name,domain"];
  for (let i = 0; i < 30; i++) lines.push(`C${i},c${i}.test`);
  importCsv(db, id, lines.join("\n"), brief);
  let n = 0;
  const fetcher = async (url: string) => { n++; return { ok: true, status: 200, url, text: "<p>x@c.test</p>", contentType: "text/html" }; };
  await runEnrichment(db, id, brief, { fetcher, mx: async () => true, delayMs: 0, concurrency: 2 }, { shouldStop: () => n >= 6 });
  const p = enrichProgress(db, id);
  assert.ok(p.pending > 0 && p.done > 0 && p.crawling === 0, JSON.stringify(p));
});
