import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emailKind } from "../src/lib/score";
import { openDb } from "../src/lib/db";
import { createCampaign, listCompanies, contactsFor } from "../src/lib/queries";
import { importCsv } from "../src/lib/importer";
import { contactInserter } from "../src/lib/contacts";
import { buildExportCsv } from "../src/lib/export";
import { verifyUnchecked } from "../src/lib/enrich";

const brief = { regions: ["India"] };
const camp = { name: "T", product: "P", pitch: "p", regions: ["India"], goal: "demo" as const, tone: "warm" as const, sender: "A", dailyCap: 10 };

test("emailKind sorts inboxes into the right bucket", () => {
  assert.equal(emailKind("asha@x.com"), "person");
  assert.equal(emailKind("ravi.nair@x.com"), "person");
  assert.equal(emailKind("sales@x.com"), "business");
  assert.equal(emailKind("partnerships@x.com"), "business");
  assert.equal(emailKind("info@x.com"), "general");
  assert.equal(emailKind("support@x.com"), "support");
  assert.equal(emailKind("customercare@x.com"), "support");
  assert.equal(emailKind("careers@x.com"), "avoid");
  assert.equal(emailKind("legal@x.com"), "avoid");
  // the ones the real Equentis site showed
  assert.equal(emailKind("po@equentis.com"), "avoid");
  assert.equal(emailKind("pmscompliance@equentis.com"), "avoid");
  assert.equal(emailKind("communications@equentis.com"), "avoid");
  assert.equal(emailKind("grievance@equentis.com"), "avoid");
  assert.equal(emailKind("compliance@equentis.com"), "avoid");
  assert.equal(emailKind("dev@x.com"), "person");
});

test("best contact: skips invalid, prefers a person over support", async () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, camp);
  importCsv(db, id, "name,domain\nAcme,acme.test\n", brief);
  const add = contactInserter(db);
  const cid = (db.prepare("SELECT id FROM companies").get() as { id: number }).id;
  add({ companyId: cid, email: "support@acme.test", method: "crawled", sourceUrl: "https://acme.test/" });
  add({ companyId: cid, email: "info@acme.test", method: "crawled" });
  add({ companyId: cid, email: "careers@acme.test", method: "crawled" });
  add({ companyId: cid, email: "dev@acme.test", method: "manual" });
  await verifyUnchecked(db, id, async () => true);
  let top = listCompanies(db, id).items[0];
  assert.equal(top.contactEmail, "dev@acme.test");
  // If the person's address turns out invalid, fall back to the next best, never the invalid one.
  db.prepare("UPDATE contacts SET verification = 'invalid' WHERE email = 'dev@acme.test'").run();
  top = listCompanies(db, id).items[0];
  assert.equal(top.contactEmail, "info@acme.test");
  const all = contactsFor(db, [cid]).get(cid)!;
  assert.deepEqual(all.map((c) => c.email), ["info@acme.test", "support@acme.test", "careers@acme.test", "dev@acme.test"]);
  const csv = buildExportCsv(db, id);
  assert.ok(csv.includes("info@acme.test") && csv.includes("support@acme.test; careers@acme.test"), csv);
});

test("importing a repeated company adds its new email instead of dropping it", async () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, camp);
  importCsv(db, id, "name,website\nDezerv,dezerv.in\n", brief);
  const r = importCsv(db, id, "name,website,email\nDezerv,https://www.dezerv.in/contact,hello@dezerv.in\n", brief);
  assert.equal(r.added, 0);
  assert.equal(r.duplicates, 1);
  assert.equal(r.merged, 1);
  const again = importCsv(db, id, "name,website,email\nDezerv,dezerv.in,hello@dezerv.in\n", brief);
  assert.equal(again.merged, 0); // already saved
  assert.equal(listCompanies(db, id).items[0].contactEmail, "hello@dezerv.in");
  await verifyUnchecked(db, id, async () => true);
  assert.equal(listCompanies(db, id).items[0].contactVerification, "valid");
});

test("export: one row per email, and spreadsheet formulas are neutralised", () => {
  const db = openDb(":memory:");
  const id = createCampaign(db, camp);
  importCsv(db, id, 'name,domain,email\n"=HYPERLINK(""http://evil"")",evil.test,a@evil.test\nPlain Co,plain.test,\n', brief);
  const csv = buildExportCsv(db, id);
  assert.ok(csv.startsWith("﻿Company,Website"));
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes("'=HYPERLINK")), "formula cell must be prefixed");
  assert.ok(!lines.some((l) => /^"?=HYPERLINK/.test(l)));
  assert.ok(lines.some((l) => l.startsWith("Plain Co,plain.test")));
});

test("a database made by the old version is upgraded without losing rows", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "od-")), "old.db");
  const old = new Database(file);
  old.exec(`
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL, pitch TEXT NOT NULL, regions TEXT NOT NULL,
      min_advisors INTEGER NOT NULL DEFAULT 8, prefer_structured INTEGER NOT NULL DEFAULT 1, contact_pref TEXT NOT NULL DEFAULT 'decision',
      goal TEXT NOT NULL DEFAULT 'demo', tone TEXT NOT NULL DEFAULT 'warm', sender TEXT NOT NULL, daily_cap INTEGER NOT NULL DEFAULT 10, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE companies (id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, name TEXT NOT NULL, domain TEXT NOT NULL, city TEXT, region TEXT, advisors INTEGER,
      structured INTEGER NOT NULL DEFAULT 0, trigger TEXT, fit_score INTEGER NOT NULL DEFAULT 0, fit_label TEXT NOT NULL DEFAULT 'Low', fit_reasons TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'imported', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (campaign_id, domain));
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, name TEXT, role TEXT, email TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'general',
      source_url TEXT, method TEXT NOT NULL DEFAULT 'imported', verification TEXT NOT NULL DEFAULT 'unchecked', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (company_id, email));
    INSERT INTO campaigns (name, product, pitch, regions, sender) VALUES ('Old','P','p','["India"]','A');
    INSERT INTO companies (campaign_id, name, domain) VALUES (1,'Acme','acme.test');
    INSERT INTO contacts (company_id, email) VALUES (1,'support@acme.test'), (1,'asha@acme.test');`);
  old.close();
  const db = openDb(file);
  const rows = db.prepare("SELECT email, kind, priority FROM contacts ORDER BY id").all();
  assert.deepEqual(rows, [{ email: "support@acme.test", kind: "support", priority: 3 }, { email: "asha@acme.test", kind: "person", priority: 0 }]);
  assert.equal((db.prepare("SELECT crawl_status FROM companies").get() as any).crawl_status, "pending");
  assert.equal(listCompanies(db, 1).items[0].contactEmail, "asha@acme.test");
  db.close();
  openDb(file).close(); // a second start must not fail
});

test("contacts labelled by older rules are re-labelled on start", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "od-")), "v1.db");
  const db = openDb(file);
  const id = createCampaign(db, camp);
  importCsv(db, id, "name,domain,email\nEq,eq.test,po@eq.test\n", brief);
  db.prepare("UPDATE contacts SET kind = 'person', priority = 0").run(); // as the old version stored it
  db.pragma("user_version = 1");
  db.close();
  const again = openDb(file);
  assert.deepEqual(again.prepare("SELECT kind, priority FROM contacts").get(), { kind: "avoid", priority: 4 });
  again.close();
});
