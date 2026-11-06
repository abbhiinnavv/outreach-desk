import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db";
import { createCampaign } from "../src/lib/queries";
import { importCsv } from "../src/lib/importer";
import { eligibleCompanies, writeDrafts, reviewDraft, draftCounts, validParagraphs, listDrafts } from "../src/lib/drafts";
import { emailKind } from "../src/lib/score";
import { extractAbout } from "../src/lib/crawl/extract";
import type { Fetcher } from "../src/lib/crawl/fetcher";

const brief = { regions: ["India"] };
function setup() {
  const db = openDb(":memory:");
  const camp = createCampaign(db, { name: "T", product: "Acme", pitch: "We help wealth firms reply to clients faster", regions: ["India"], goal: "demo", tone: "warm", sender: "Abhi", dailyCap: 20 });
  const id = typeof camp === "number" ? camp : (camp as any).id;
  importCsv(db, id,
    "name,website,region,contact name,email\nAlpha,alpha.example,India,Riya Shah,riya@alpha.example\nBeta,beta.example,India,,csr@beta.example\nGamma,gamma.example,India,,\nDelta,delta.example,India,,info@delta.example\n", brief);
  db.prepare("UPDATE contacts SET verification='valid' WHERE email LIKE '%alpha%' OR email LIKE '%delta%' OR email LIKE '%beta%'").run();
  return { db, id };
}
const page: Fetcher = async (url) => ({ ok: true, status: 200, url, contentType: "text/html", text: `<title>x</title><meta name="description" content="Alpha is a boutique wealth advisory firm in Mumbai.">` });
const GOOD = "We build tools that help wealth firms answer client questions faster and keep every conversation organised. Many small teams lose hours to repeated emails each week, and this removes most of that work. Would you be open to a short demo this week to see if it fits?";

test("csr@ is never picked; only usable contacts get drafts", () => {
  assert.equal(emailKind("csr@beta.example"), "avoid");
  const { db, id } = setup();
  const names = eligibleCompanies(db, id).map((e) => e.name).sort();
  assert.deepEqual(names, ["Alpha", "Delta"]);
});

test("extractAbout reads the meta description", () => {
  assert.match(extractAbout('<meta name="description" content="A boutique wealth firm in Pune.">')!, /boutique wealth firm/);
  assert.equal(extractAbout("<p>nothing</p>"), null);
});

test("validParagraphs rejects links, placeholders and filler", () => {
  assert.ok(validParagraphs(GOOD));
  assert.ok(!validParagraphs(GOOD + " See https://x.com"));
  assert.ok(!validParagraphs(GOOD + " [Name]"));
  assert.ok(!validParagraphs("too short"));
});

test("template fallback when there is no Gemini key; greeting, sign-off and opt-out always present", async () => {
  const { db, id } = setup();
  const r = await writeDrafts(db, id, { fetcher: page, useGemini: false });
  assert.equal(r.written, 2); assert.equal(r.byTemplate, 2);
  const d = listDrafts(db, id, "pending").items;
  const alpha = d.find((x) => x.company === "Alpha")!;
  assert.match(alpha.body, /^Hi Riya,/);
  assert.match(alpha.body, /Best,\nAbhi/);
  assert.match(alpha.body, /reply "no thanks"/);
  assert.match(d.find((x) => x.company === "Delta")!.body, /^Hi there,/);
  assert.equal(draftCounts(db, id).waiting, 0);
  const again = await writeDrafts(db, id, { fetcher: page, useGemini: false });
  assert.equal(again.written, 0, "never writes twice for one company");
});

test("gemini output is used when valid, rejected when unsafe, quota falls back", async () => {
  const { db, id } = setup();
  const ids = (db.prepare("SELECT id FROM companies ORDER BY id").all() as any[]).map((r) => r.id);
  const ok = { id: String(ids[0]), subject_a: "Faster client replies", subject_b: "Idea for Alpha", body: GOOD };
  const bad = { id: String(ids[3]), subject_a: "Hi", subject_b: "Idea", body: "Visit http://spam.com now" };
  const fetchMock = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([ok, bad]) }] } }] }), { status: 200 })) as any;
  const r = await writeDrafts(db, id, { fetcher: page, gemini: { fetch: fetchMock, apiKey: "k" } });
  assert.equal(r.byGemini, 1); assert.equal(r.byTemplate, 1);

  const s2 = setup();
  const quota = (async () => new Response("{}", { status: 429 })) as any;
  const r2 = await writeDrafts(s2.db, s2.id, { fetcher: page, gemini: { fetch: quota, apiKey: "k" } });
  assert.equal(r2.byTemplate, 2); assert.match(r2.note!, /free limit/);
});

test("approval: edit, approve, reject, reset; invalid addresses cannot be approved", async () => {
  const { db, id } = setup();
  await writeDrafts(db, id, { fetcher: page, useGemini: false });
  const d = listDrafts(db, id, "pending").items;
  const a = d[0];
  assert.equal(reviewDraft(db, a.id, "approve", { body: "Hi,\n\nThis is my edited email body that is long enough.\n\nBest,\nAbhi" }).ok, true);
  assert.equal(listDrafts(db, id, "approved").items[0].body.startsWith("Hi,"), true);
  assert.equal(reviewDraft(db, d[1].id, "reject").ok, true);
  assert.equal(draftCounts(db, id).approved, 1); assert.equal(draftCounts(db, id).rejected, 1);
  reviewDraft(db, d[1].id, "reset");
  assert.equal(draftCounts(db, id).pending, 1);
  assert.equal(reviewDraft(db, d[1].id, "save", { subjectA: "a\nb" }).ok, false, "multi-line subject refused");
  db.prepare("UPDATE contacts SET verification='invalid'").run();
  assert.equal(reviewDraft(db, d[1].id, "approve").ok, false);
  db.prepare("UPDATE drafts SET status='sent' WHERE id=?").run(a.id);
  assert.equal(reviewDraft(db, a.id, "reject").ok, false, "sent emails cannot change");
});

import { buildTracker, syncSheet } from "../src/lib/sheet-sync";
test("tracker rows show status words and neutralise formulas; sync reports errors", async () => {
  const { db, id } = setup();
  await writeDrafts(db, id, { fetcher: page, useGemini: false });
  const d = listDrafts(db, id, "pending").items;
  reviewDraft(db, d[0].id, "approve"); reviewDraft(db, d[1].id, "reject");
  const t = buildTracker(db, id);
  assert.deepEqual(t[0].slice(0, 5), ["Company", "Website", "Fit", "Email", "Status"]);
  assert.deepEqual(t.slice(1).map((r) => r[4]).sort(), ["Approved", "Rejected"]);
  db.prepare("UPDATE companies SET name='=HYPERLINK(1)' WHERE id=(SELECT company_id FROM drafts LIMIT 1)").run();
  assert.ok(buildTracker(db, id).some((r) => r[0] === "'=HYPERLINK(1)"));
  let sent: any = null;
  const ok = await syncSheet(db, id, { url: "http://x", secret: "s", fetch: (async (_u: string, i: any) => { sent = JSON.parse(i.body); return new Response("ok"); }) as any });
  assert.equal(ok.ok, true); assert.equal(sent.secret, "s"); assert.deepEqual(Object.keys(sent.sheets), ["Pipeline", "Emails", "Replies", "Funnel"]); assert.equal(sent.sheets.Pipeline.length, 5);
  assert.match((await syncSheet(db, id, { url: "http://x", fetch: (async () => new Response("wrong secret")) as any })).error!, /secret/);
  assert.equal((await syncSheet(db, id, { url: "http://x", fetch: (async () => { throw new Error("x"); }) as any })).ok, false);
  assert.equal((await syncSheet(db, id, { url: "" })).error, "no_sheet");
});
