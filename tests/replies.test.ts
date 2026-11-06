import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db";
import { createCampaign } from "../src/lib/queries";
import { importCsv } from "../src/lib/importer";
import { writeDrafts, reviewDraft, listDrafts } from "../src/lib/drafts";
import { sendApproved, isSuppressed } from "../src/lib/sending";
import { classifyByRules, stripQuoted } from "../src/lib/classify";
import { processInbound, listReplies, relabel, setMeeting, replyCounts, addSampleReplies, removeSampleReplies, type Inbound } from "../src/lib/replies";
import type { Fetcher } from "../src/lib/crawl/fetcher";
import type { Mailer } from "../src/lib/mailer";

const page: Fetcher = async (url) => ({ ok: true, status: 200, url, contentType: "text/html", text: "<title>x</title>" });
async function setup(n = 7) {
  const db = openDb(":memory:");
  const id = createCampaign(db, { name: "T", product: "Acme", pitch: "We help wealth firms reply faster", regions: ["India"], goal: "demo", tone: "warm", sender: "Abhi", dailyCap: 50 });
  let csv = "name,website,region,email\n";
  for (let i = 1; i <= n; i++) csv += `Firm${i},firm${i}.example,India,hello@firm${i}.example\n`;
  importCsv(db, id, csv, { regions: ["India"] });
  db.prepare("UPDATE contacts SET verification='valid'").run();
  await writeDrafts(db, id, { fetcher: page, useGemini: false });
  for (const d of listDrafts(db, id, "pending").items) reviewDraft(db, d.id, "approve");
  let k = 0;
  const mailer: Mailer = async () => ({ messageId: `<sent-${++k}@gmail.com>` });
  await sendApproved(db, id, { mailer, fromAddress: "me@gmail.com" });
  return { db, id };
}
const msg = (o: Partial<Inbound> & { from: string; text: string }): Inbound => ({ messageId: `<${Math.random()}@x>`, subject: "Re: hello", ...o });

test("rules label realistic positive and negative replies", () => {
  const L = (text: string, subject = "Re: hi", from = "a@b.com") => classifyByRules({ from, subject, text });
  assert.equal(L("This looks interesting. Can we do a call on Thursday at 4pm?"), "Interested");
  assert.equal(L("Sounds great, happy to chat next week."), "Interested");
  assert.equal(L("Please send me more details and pricing."), "Interested");
  assert.equal(L("How does pricing work and do you integrate with Zoho?"), "Question");
  assert.equal(L("Not a priority right now, check back next quarter."), "Not now");
  assert.equal(L("Maybe later, we are busy this month."), "Not now");
  assert.equal(L("Not interested, thanks."), "Not interested");
  assert.equal(L("no thanks"), "Not interested");
  assert.equal(L("We already use another vendor for this."), "Not interested");
  assert.equal(L("Please remove us from your list."), "Unsubscribe");
  assert.equal(L("Unsubscribe"), "Unsubscribe");
  assert.equal(L("I am out of office until Monday with limited access to email."), "Out of office");
  assert.equal(L("Thanks", "Automatic reply: hello"), "Out of office");
  assert.equal(L("Address not found. 550 5.1.1 user unknown", "Delivery Status Notification (Failure)", "mailer-daemon@googlemail.com"), "Bounced");
  assert.equal(L("ok received"), null);
  assert.equal(L("I am not interested in a demo"), "Not interested", "negative wins over the word demo");
});

test("quoted history is cut so our own email never confuses the label", () => {
  const t = "Not interested.\n\nOn Fri, 6 Nov 2026 at 06:04, Abhi <me@gmail.com> wrote:\n> Would you be open to a demo?\n> reply no thanks";
  assert.equal(stripQuoted(t), "Not interested.");
});

test("replies are matched to what we sent; unrelated inbox mail is ignored and never stored", async () => {
  const { db, id } = await setup(4);
  const sent = db.prepare("SELECT message_id, to_email FROM sends ORDER BY id").all() as any[];
  const res = await processInbound(db, id, [
    msg({ from: "hello@firm1.example", text: "Interested, can we talk tomorrow?" }),
    msg({ from: "someone.else@firm2.example", text: "Not now, maybe later next quarter.", inReplyTo: sent[1].message_id }),
    msg({ from: "ceo@firm3.example", text: "Sounds good, tell me more" }),        // same company domain, other mailbox
    msg({ from: "newsletter@random.com", text: "50% off today only" }),
    msg({ from: "friend@gmail.com", text: "dinner tonight?" }),
  ], { gemini: { enabled: false } });
  assert.equal(res.stored, 3); assert.equal(res.ignored, 2);
  assert.equal(replyCounts(db, id).total, 3);
  assert.ok(!listReplies(db, id).some((r) => /newsletter|dinner/.test(r.text)));
});

test("same message twice is stored once; bounce names the address and suppresses it", async () => {
  const { db, id } = await setup(3);
  const m = msg({ from: "hello@firm1.example", text: "Interested" });
  await processInbound(db, id, [m], { gemini: { enabled: false } });
  const again = await processInbound(db, id, [m], { gemini: { enabled: false } });
  assert.equal(again.duplicates, 1); assert.equal(replyCounts(db, id).total, 1);
  await processInbound(db, id, [msg({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", text: "Your message wasn't delivered to hello@firm2.example. 550 5.1.1 user unknown" })], { gemini: { enabled: false } });
  assert.ok(isSuppressed(db, "hello@firm2.example"));
  assert.equal((db.prepare("SELECT status FROM sends WHERE to_email='hello@firm2.example'").get() as any).status, "bounced");
});

test("'no thanks' and unsubscribe go on the do-not-email list; interest does not", async () => {
  const { db, id } = await setup(4);
  await processInbound(db, id, [
    msg({ from: "hello@firm1.example", text: "no thanks" }),
    msg({ from: "hello@firm2.example", text: "please unsubscribe us" }),
    msg({ from: "hello@firm3.example", text: "Interested, let's talk" }),
  ], { gemini: { enabled: false } });
  assert.ok(isSuppressed(db, "hello@firm1.example")); assert.ok(isSuppressed(db, "hello@firm2.example"));
  assert.ok(!isSuppressed(db, "hello@firm3.example"));
});

test("changing a label by hand re-applies the rules; meeting booked is counted", async () => {
  const { db, id } = await setup(3);
  await processInbound(db, id, [msg({ from: "hello@firm1.example", text: "no thanks" })], { gemini: { enabled: false } });
  const r = listReplies(db, id)[0];
  assert.ok(isSuppressed(db, "hello@firm1.example"));
  relabel(db, r.id, "Interested");
  assert.ok(!isSuppressed(db, "hello@firm1.example"), "mislabelled 'no' can be undone");
  setMeeting(db, r.id, true);
  assert.equal(replyCounts(db, id).meetings, 1);
  relabel(db, r.id, "Unsubscribe");
  assert.ok(isSuppressed(db, "hello@firm1.example"));
});

test("sample replies cover every kind, are marked, and are fully removable", async () => {
  const { db, id } = await setup(7);
  const r = await addSampleReplies(db, id);
  assert.equal(r.stored, 7);
  const labels = listReplies(db, id).map((x) => x.label).sort();
  assert.deepEqual(labels, ["Bounced", "Interested", "Not interested", "Not now", "Out of office", "Question", "Unsubscribe"]);
  assert.ok(listReplies(db, id).every((x) => x.simulated));
  assert.ok((db.prepare("SELECT COUNT(*) n FROM suppression").get() as any).n >= 3);
  removeSampleReplies(db, id);
  assert.equal(replyCounts(db, id).total, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM suppression").get() as any).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM sends WHERE status='bounced'").get() as any).n, 0);
});

import { buildFunnel, conversion } from "../src/lib/funnel";
test("funnel counts each stage from real rows and reports sample replies separately", async () => {
  const { db, id } = await setup(5);
  let f = buildFunnel(db, id);
  assert.deepEqual(f.stages.map((s) => s.count), [5, 5, 5, 5, 5, 0, 0, 0]);
  await processInbound(db, id, [
    msg({ from: "hello@firm1.example", text: "Interested, can we talk Thursday?" }),
    msg({ from: "hello@firm2.example", text: "no thanks" }),
    msg({ from: "hello@firm3.example", subject: "Automatic reply", text: "I am out of office" }),
    msg({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", text: "not delivered to hello@firm4.example 550 5.1.1 user unknown" }),
  ], { gemini: { enabled: false } });
  const r = listReplies(db, id).find((x) => x.label === "Interested")!;
  setMeeting(db, r.id, true);
  f = buildFunnel(db, id);
  assert.deepEqual(f.stages.map((s) => s.count), [5, 5, 5, 5, 5, 2, 1, 1]);
  assert.equal(f.bounced, 1); assert.equal(f.autoReplies, 1); assert.equal(f.sampleReplies, 0);
  assert.equal(conversion(5, 2), 40); assert.equal(conversion(0, 2), null);
  await removeSampleReplies(db, id);
  await addSampleReplies(db, id);
  assert.ok(buildFunnel(db, id).sampleReplies > 0);
});

import ExcelJS from "exceljs";
import { pipelineTable, buildWorkbook, buildSheets } from "../src/lib/workbook";
test("master workbook: one row per company shows every stage and the right next action", async () => {
  const { db, id } = await setup(5);
  await processInbound(db, id, [
    msg({ from: "hello@firm1.example", text: "Interested, can we talk Thursday?" }),
    msg({ from: "hello@firm2.example", text: "no thanks" }),
    msg({ from: "hello@firm3.example", text: "Not a priority right now, check back next quarter" }),
  ], { gemini: { enabled: false } });
  const t = pipelineTable(db, id);
  const head = t[0] as string[];
  const col = (name: string) => head.indexOf(name);
  const byCompany = (n: string) => t.find((r) => r[0] === n)!;
  assert.equal(t.length, 6);
  assert.equal(byCompany("Firm1")[col("Next action")], "Reply to them now");
  assert.equal(byCompany("Firm2")[col("Next action")], "Do not contact again");
  assert.equal(byCompany("Firm2")[col("Do not email")], "Yes");
  assert.equal(byCompany("Firm3")[col("Next action")], "Try again in about 90 days");
  assert.equal(byCompany("Firm4")[col("Next action")], "Waiting for a reply");
  assert.equal(byCompany("Firm4")[col("Draft status")], "Sent");
  assert.equal(byCompany("Firm1")[col("Reply is a sample")], "No");
  // a company with nothing done yet
  db.prepare("INSERT INTO companies (campaign_id, name, domain) VALUES (?, '=Evil()', 'new.example')").run(id);
  const t2 = pipelineTable(db, id);
  const fresh = t2.find((r) => String(r[0]).includes("Evil"))!;
  assert.equal(fresh[0], "'=Evil()", "formulas are neutralised");
  assert.equal(fresh[col("Next action")], "Find or add an email");
  assert.deepEqual(Object.keys(buildSheets(db, id)), ["Pipeline", "Emails", "Replies", "Funnel"]);
});

test("the .xlsx file opens and has the four tabs with data", async () => {
  const { db, id } = await setup(3);
  const buf = await buildWorkbook(db, id);
  assert.equal(buf.subarray(0, 2).toString(), "PK");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Pipeline", "Emails", "Replies", "Funnel"]);
  assert.equal(wb.getWorksheet("Pipeline")!.rowCount, 4);
  assert.equal(wb.getWorksheet("Pipeline")!.getRow(1).getCell(1).value, "Company");
});
