/*
  Fills an empty database with a fictional demo campaign (every domain ends in .example, so nothing real is involved).
  Used for the public demo. Safe to run any time: it does nothing if a campaign already exists.
*/
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";
import { createCampaign } from "../src/lib/queries";
import { importCsv, rescoreCampaign } from "../src/lib/importer";
import { writeDrafts, listDrafts, reviewDraft } from "../src/lib/drafts";
import { sendApproved } from "../src/lib/sending";
import { addSampleReplies } from "../src/lib/replies";

async function main() {
  const db = getDb();
  if ((db.prepare("SELECT COUNT(*) AS n FROM campaigns").get() as { n: number }).n > 0) { console.log("seed: database already has data, skipping"); return; }
  const id = createCampaign(db, {
    name: "Demo: wealth advisors (fictional)", product: "an AI assistant for wealth firms",
    pitch: "We help wealth advisory firms turn portfolio data into client-ready recommendations faster.",
    regions: ["India"], goal: "demo", tone: "warm", sender: "Abhinav", dailyCap: 10,
  });
  const csv = fs.readFileSync(path.join(process.cwd(), "sample-data", "companies.csv"), "utf8");
  importCsv(db, id, csv, { regions: ["India"] });
  db.prepare("UPDATE contacts SET verification = 'valid', verify_note = 'demo data'").run();
  rescoreCampaign(db, id, { regions: ["India"] });
  await writeDrafts(db, id, { fetcher: async (url) => ({ ok: false, status: 0, url, text: "", contentType: "" }), useGemini: false });
  const drafts = listDrafts(db, id, "pending", 1, 50).items;
  drafts.slice(0, 6).forEach((d) => reviewDraft(db, d.id, "approve"));
  let n = 0;
  await sendApproved(db, id, { mailer: async () => ({ messageId: `<demo-${++n}@example>` }), fromAddress: "demo@example.com" });
  await addSampleReplies(db, id);
  console.log("seed: demo campaign created");
}
main().catch((e) => { console.error(e); process.exit(1); });
