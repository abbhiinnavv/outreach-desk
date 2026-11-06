import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db";
import { createCampaign } from "../src/lib/queries";
import { importCsv } from "../src/lib/importer";
import { writeDrafts, reviewDraft, listDrafts, draftCounts } from "../src/lib/drafts";
import { sendApproved, sendTest, sendCounts, isSuppressed } from "../src/lib/sending";
import { MailError, classifyMailError, type Mailer } from "../src/lib/mailer";
import { assembleEmail } from "../src/lib/email-template";
import type { Fetcher } from "../src/lib/crawl/fetcher";

const page: Fetcher = async (url) => ({ ok: true, status: 200, url, contentType: "text/html", text: "<title>nothing here</title>" });

async function setup(cap = 20, n = 4) {
  const db = openDb(":memory:");
  const id = createCampaign(db, { name: "T", product: "Acme", pitch: "We help wealth firms reply faster", regions: ["India"], goal: "demo", tone: "warm", sender: "Abhi", dailyCap: cap });
  let csv = "name,website,region,email\n";
  for (let i = 1; i <= n; i++) csv += `Firm${i},firm${i}.example,India,hello@firm${i}.example\n`;
  importCsv(db, id, csv, { regions: ["India"] });
  db.prepare("UPDATE contacts SET verification='valid'").run();
  await writeDrafts(db, id, { fetcher: page, useGemini: false });
  for (const d of listDrafts(db, id, "pending").items) reviewDraft(db, d.id, "approve");
  return { db, id };
}
const recorder = () => { const out: any[] = []; const mailer: Mailer = async (m) => { out.push(m); return { messageId: `<${out.length}@x>` }; }; return { out, mailer }; };

test("sends only approved emails, records them, never twice", async () => {
  const { db, id } = await setup();
  const { out, mailer } = recorder();
  const r = await sendApproved(db, id, { mailer, fromAddress: "me@gmail.com" });
  assert.equal(r.sent, 4); assert.equal(out.length, 4);
  assert.equal(out[0].from, "Abhi <me@gmail.com>");
  assert.match(out[0].headers["List-Unsubscribe"], /mailto:me@gmail.com/);
  assert.equal(draftCounts(db, id).sent, 4);
  const again = await sendApproved(db, id, { mailer, fromAddress: "me@gmail.com" });
  assert.equal(again.sent, 0); assert.equal(out.length, 4);
});

test("daily cap is respected and counts what was really sent today", async () => {
  const { db, id } = await setup(2, 4);
  const { out, mailer } = recorder();
  assert.deepEqual([sendCounts(db, id).willSend, sendCounts(db, id).approved], [2, 4]);
  const r = await sendApproved(db, id, { mailer, fromAddress: "me@gmail.com" });
  assert.equal(r.sent, 2); assert.match(r.note!, /limit/);
  assert.equal(draftCounts(db, id).approved, 2, "the rest stay approved");
  const r2 = await sendApproved(db, id, { mailer, fromAddress: "me@gmail.com" });
  assert.equal(r2.sent, 0); assert.equal(out.length, 2);
});

test("suppressed and invalid addresses are skipped; a rejected address is suppressed and others still go", async () => {
  const { db, id } = await setup(20, 4);
  db.prepare("INSERT INTO suppression (email, reason) VALUES ('hello@firm1.example','unsubscribe')").run();
  db.prepare("INSERT INTO suppression (email, reason) VALUES ('@firm2.example','unsubscribe')").run();
  assert.ok(isSuppressed(db, "x@firm2.example"));
  const seen: string[] = [];
  const mailer: Mailer = async (m) => { if (m.to.includes("firm3")) throw new MailError("no such user", "rejected"); seen.push(m.to); return { messageId: "<a>" }; };
  const r = await sendApproved(db, id, { mailer, fromAddress: "me@gmail.com" });
  assert.deepEqual(seen, ["hello@firm4.example"]);
  assert.equal(r.skipped, 2); assert.equal(r.failed, 1); assert.equal(r.sent, 1);
  assert.ok(isSuppressed(db, "hello@firm3.example"));
});

test("a login problem stops everything and leaves the rest approved", async () => {
  const { db, id } = await setup();
  let calls = 0;
  const mailer: Mailer = async () => { calls++; throw new MailError("Gmail refused the login.", "auth"); };
  const r = await sendApproved(db, id, { mailer, fromAddress: "me@gmail.com" });
  assert.equal(calls, 1); assert.equal(r.sent, 0); assert.match(r.note!, /login/);
  assert.equal(draftCounts(db, id).approved, 4);
});

test("stop button halts between emails; pause is used between sends only", async () => {
  const { db, id } = await setup();
  const { out, mailer } = recorder();
  const pauses: number[] = [];
  let stop = false;
  const r = await sendApproved(db, id, { mailer: async (m) => { const x = await mailer(m); stop = true; return x; }, fromAddress: "me@gmail.com", delayMs: () => 5, sleep: async (ms) => { pauses.push(ms); } }, { shouldStop: () => stop });
  assert.equal(out.length, 1); assert.match(r.note!, /Stopped/);
  assert.equal(pauses.length, 0);
});

test("test email goes to yourself, marked [TEST], and is not recorded as a real send", async () => {
  const { db, id } = await setup();
  const { out, mailer } = recorder();
  const r = await sendTest(db, id, { mailer, fromAddress: "me@gmail.com" });
  assert.ok(r.ok); assert.equal(out[0].to, "me@gmail.com"); assert.match(out[0].subject, /^\[TEST\]/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM sends").get() as any).n, 0);
});

test("gmail errors are classified; small AI typing slips are tidied", () => {
  assert.equal(classifyMailError({ code: "EAUTH" }).kind, "auth");
  assert.equal(classifyMailError({ responseCode: 550, response: "550 5.4.5 Daily user sending quota exceeded" }).kind, "limit");
  assert.equal(classifyMailError({ responseCode: 550, response: "550 5.1.1 no such user" }).kind, "rejected");
  assert.equal(classifyMailError({ code: "ECONNECTION" }).kind, "network");
  assert.match(assembleEmail({ companyName: "X", contactName: null, paragraphs: "Less admin.Our goal is you.", sender: "A" }), /admin\. Our goal/);
});
