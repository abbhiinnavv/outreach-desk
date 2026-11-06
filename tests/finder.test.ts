import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiJson, GeminiError } from "../src/lib/gemini";
import { suggestCompanies, checkCandidates, nameTokens } from "../src/lib/finder";
import type { Fetcher } from "../src/lib/crawl/fetcher";
import { openDb } from "../src/lib/db";
import { createCampaign, listCompanies } from "../src/lib/queries";
import { importCsv } from "../src/lib/importer";

const reply = (obj: unknown, status = 200) => async () =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const geminiAnswer = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test("gemini: parses JSON, sends the key in a header, strips code fences", async () => {
  let seen: { url: string; headers: Record<string, string>; body: any } | null = null;
  const fetchMock = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    return new Response(JSON.stringify(geminiAnswer('```json\n[{"a":1}]\n```')), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await geminiJson<Array<{ a: number }>>("hi", { type: "ARRAY" }, { fetch: fetchMock, apiKey: "KEY123" });
  assert.deepEqual(out, [{ a: 1 }]);
  assert.equal(seen!.headers["x-goog-api-key"], "KEY123");
  assert.ok(!seen!.url.includes("KEY123"), "key must not be in the URL");
  assert.equal(seen!.body.generationConfig.responseMimeType, "application/json");
});

test("gemini: clear errors for no key, bad key, quota, junk answer", async () => {
  const kind = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof GeminiError ? e.kind : "other"; } };
  delete process.env.GEMINI_API_KEY;
  assert.equal(await kind(geminiJson("x", {})), "no_key");
  assert.equal(await kind(geminiJson("x", {}, { apiKey: "k", fetch: reply({}, 403) as any })), "auth");
  assert.equal(await kind(geminiJson("x", {}, { apiKey: "k", fetch: reply({}, 429) as any })), "quota");
  assert.equal(await kind(geminiJson("x", {}, { apiKey: "k", fetch: reply({}, 503) as any })), "unavailable");
  assert.equal(await kind(geminiJson("x", {}, { apiKey: "k", fetch: reply(geminiAnswer("not json")) as any })), "bad_response");
  assert.equal(await kind(geminiJson("x", {}, { apiKey: "k", fetch: (async () => { throw new Error("offline"); }) as any })), "unavailable");
});

test("suggestions are cleaned: bad websites dropped, duplicates removed, count capped", async () => {
  const items = [
    { name: "Alpha Wealth", website: "https://www.alpha.in/about", city: "Mumbai", region: "India" },
    { name: "Alpha Again", website: "alpha.in" },          // same domain
    { name: "No Site", website: "" },                       // no website
    { name: "Junk", website: "not a website" },
    { name: "Beta Capital", website: "beta.com", city: "", region: "Singapore" },
    { name: "Gamma", website: "gamma.com" },
  ];
  const fetchMock = reply(geminiAnswer(JSON.stringify(items))) as any;
  const out = await suggestCompanies("wealth firms", ["India"], 2, { apiKey: "k", fetch: fetchMock });
  assert.deepEqual(out.map((o) => o.website), ["alpha.in", "beta.com"]);
  assert.equal(out[1].city, null);
});

test("name tokens ignore generic words", () => {
  assert.deepEqual(nameTokens("Equentis Wealth Advisory Services Limited"), ["equentis"]);
  assert.deepEqual(nameTokens("Neo Wealth and Asset Management"), []);
});

test("website check: verified, wrong company, blocked, made-up", async () => {
  const pages: Record<string, { status: number; text: string }> = {
    "https://real.com": { status: 200, text: "<title>Equentis | Wealth</title>" },
    "https://wrong.com": { status: 200, text: "<title>Pizza place</title>" },
    "https://blocked.com": { status: 403, text: "" },
  };
  const fetcher: Fetcher = async (url) => {
    const p = pages[url];
    if (!p) throw new Error("no such site");
    return { ok: p.status === 200, status: p.status, url, text: p.text, contentType: "text/html" };
  };
  const out = await checkCandidates([
    { name: "Equentis Wealth Advisory", website: "real.com", city: null, region: null },
    { name: "Kestrel Wealth", website: "wrong.com", city: null, region: null },
    { name: "Dezerv", website: "blocked.com", city: null, region: null },
    { name: "Imaginary Capital Partners", website: "madeup.com", city: null, region: null },
  ], fetcher);
  const status = Object.fromEntries(out.map((o) => [o.name, o.status]));
  assert.deepEqual(status, { "Equentis Wealth Advisory": "verified", "Kestrel Wealth": "mismatch", Dezerv: "blocked", "Imaginary Capital Partners": "unreachable" });
  assert.equal(out[0].status, "verified"); // best first
  assert.equal(out[3].status, "unreachable");
});

test("re-importing a known company fills a missing region", () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, { name: "T", product: "P", pitch: "p", regions: ["India"], goal: "demo", tone: "warm", sender: "A", dailyCap: 10 });
  importCsv(db, id, "name,website\nDezerv,dezerv.in\n", { regions: ["India"] });
  assert.equal(listCompanies(db, id).items[0].fitScore, 0);
  importCsv(db, id, "name,website,city,region\nDezerv,dezerv.in,Mumbai,India\n", { regions: ["India"] });
  const c = listCompanies(db, id).items[0];
  assert.equal(c.region, "India");
  assert.equal(c.city, "Mumbai");
  // it does not overwrite a region that is already set
  importCsv(db, id, "name,website,region\nDezerv,dezerv.in,UAE\n", { regions: ["India"] });
  assert.equal(listCompanies(db, id).items[0].region, "India");
});
