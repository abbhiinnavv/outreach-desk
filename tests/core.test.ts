import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openDb } from "../src/lib/db";
import { normalizeDomain, cleanEmail } from "../src/lib/domain";
import { scoreCompany, contactTier } from "../src/lib/score";
import { parseBrief } from "../src/lib/brief";
import { importCsv, rescoreCampaign } from "../src/lib/importer";
import { createCampaign, listCompanies, campaignStats } from "../src/lib/queries";
import { verifyUnchecked } from "../src/lib/enrich";

const brief = { regions: ["India", "Singapore"] };
const input = {
  name: "T", product: "P", pitch: "Pitch", regions: ["India", "Singapore"],
  goal: "demo" as const, tone: "warm" as const, sender: "Abhi", dailyCap: 10,
};

test("normalizeDomain cleans urls and rejects junk", () => {
  assert.equal(normalizeDomain("https://www.Acme.com/about?x=1"), "acme.com");
  assert.equal(normalizeDomain("acme.com:8080/x"), "acme.com");
  assert.equal(normalizeDomain("sub.acme.co.in"), "sub.acme.co.in");
  assert.equal(normalizeDomain("not a website"), null);
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain(null), null);
});

test("cleanEmail", () => {
  assert.equal(cleanEmail(" A@B.com "), "a@b.com");
  assert.equal(cleanEmail("nope"), null);
});

test("score: perfect match is 100, empty is 0", () => {
  const perfect = scoreCompany({ region: "india", trigger: "x", best: { email: "asha@b.com", verification: "valid" } }, brief);
  assert.equal(perfect.score, 100);
  assert.equal(perfect.label, "High");
  const none = scoreCompany({ region: null, trigger: null, best: null }, brief);
  assert.equal(none.score, 0);
  assert.equal(none.label, "Low");
});

test("score: support@ is a valid email but not a person (no Person points); unchecked or invalid emails earn nothing", () => {
  const f = (email: string, verification: string, region: string | null = "India") =>
    scoreCompany({ region, trigger: null, best: { email, verification } }, brief).score;
  assert.equal(f("support@x.com", "valid"), 70);   // region 40 + email 30
  assert.equal(f("sales@x.com", "valid"), 90);     // + person/business 20
  assert.equal(f("asha@x.com", "unchecked"), 40);  // region only
  assert.equal(f("asha@x.com", "invalid"), 40);
  assert.equal(f("asha@x.com", "valid", null), 50); // no region known
});

test("contact tier uses the job title", () => {
  assert.equal(contactTier("Founder", "asha@x.com"), "decision");
  assert.equal(contactTier("Founder", "legal@x.com"), "general");
  assert.equal(contactTier(null, "asha@x.com"), "general");
});

test("brief validation", () => {
  const bad = parseBrief(() => "");
  assert.equal(bad.ok, false);
  const form: Record<string, string> = { name: "n", product: "p", pitch: "x", sender: "s", regions: "India, UAE", dailyCap: "10" };
  const ok = parseBrief((k) => form[k]);
  assert.ok(ok.ok && ok.value.regions.length === 2);
  const tooBig = parseBrief((k) => ({ ...form, dailyCap: "9999" })[k]);
  assert.equal(tooBig.ok, false);
});

test("import: sample file dedupes, rejects bad rows, scores", () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, input);
  const r = importCsv(db, id, fs.readFileSync("sample-data/companies.csv", "utf8"), brief);
  assert.equal(r.total, 9);
  assert.equal(r.added, 7);
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
  const again = importCsv(db, id, fs.readFileSync("sample-data/companies.csv", "utf8"), brief);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 8);
  const list = listCompanies(db, id);
  assert.equal(list.total, 7);
  assert.equal(list.items[0].name, "Kestrel Wealth");
  assert.equal(list.items[0].fitScore, 50); // region 40 + trigger 10; its email is not checked yet
});

test("scores rise once emails are checked", async () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, input);
  importCsv(db, id, fs.readFileSync("sample-data/companies.csv", "utf8"), brief);
  await verifyUnchecked(db, id, async () => true);
  rescoreCampaign(db, id, brief);
  const byName = Object.fromEntries(listCompanies(db, id).items.map((c) => [c.name, c.fitScore]));
  assert.equal(byName["Kestrel Wealth"], 100); // India + valid + person + trigger
  assert.equal(byName["Harbor Advisors"], 70); // India + valid, but only info@ and no trigger: 40+30
  assert.equal(byName["Tidal Partners"], 30);  // UAE is not a target here (0); contact@ is valid (30) but is not a person (0)
});

test("import: missing columns reported, BOM and odd headers handled", () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, input);
  assert.equal(importCsv(db, id, "foo,bar\n1,2\n", brief).invalid, 1);
  const r = importCsv(db, id, "﻿Company Name,Website\nAcme,acme.com\n", brief);
  assert.equal(r.added, 1);
});

test("import: 5000 rows, filters, pagination, rescoring", () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, input);
  const lines = ["name,domain,region"];
  for (let i = 0; i < 5000; i++) lines.push(`Firm ${i},firm${i}.example,${i % 2 ? "India" : "USA"}`);
  const r = importCsv(db, id, lines.join("\n"), brief);
  assert.equal(r.added, 5000);
  const p = listCompanies(db, id, { page: 3, pageSize: 100 });
  assert.equal(p.items.length, 100);
  assert.equal(p.pages, 50);
  assert.equal(listCompanies(db, id, { q: "firm42" }).total > 0, true);
  assert.equal(listCompanies(db, id, { fit: "High" }).items.every((c) => c.fitLabel === "High"), true);
  const s = campaignStats(db, id);
  assert.equal(s.total, 5000);
  assert.equal(rescoreCampaign(db, id, { ...brief, regions: ["USA"] }), 5000);
});
