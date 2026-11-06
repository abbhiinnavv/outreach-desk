import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getCampaign } from "@/lib/queries";
import { draftCounts, listDrafts } from "@/lib/drafts";
import { approveAllAction, reviewDraftAction, syncSheetAction } from "../../../actions";
import { lastSheetSync, sheetConfigured } from "@/lib/sheet-sync";

export const dynamic = "force-dynamic";

const TABS = [["pending", "Waiting"], ["approved", "Approved"], ["rejected", "Rejected"], ["sent", "Sent"]] as const;

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string }> }) {
  const { id: idStr } = await params;
  const sp = await searchParams;
  const id = Number(idStr);
  const db = getDb();
  const campaign = Number.isInteger(id) ? getCampaign(db, id) : null;
  if (!campaign) notFound();
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "pending";
  const page = Math.max(Number.parseInt(sp.page ?? "1", 10) || 1, 1);
  const counts = draftCounts(db, id);
  const list = listDrafts(db, id, tab, page);
  const n: Record<string, number> = { pending: counts.pending, approved: counts.approved, rejected: counts.rejected, sent: counts.sent };

  return (
    <>
      <p className="small"><Link href={`/campaigns/${id}`}>← {campaign.name}</Link></p>
      <h1>Review emails</h1>
      <p className="sub">Edit anything you like. Nothing is sent from this page. Approved emails are what the next step will send.</p>

      <div className="tabs">
        {TABS.map(([k, label]) => <Link key={k} href={`/campaigns/${id}/review?tab=${k}`} className={tab === k ? "on" : ""}>{label} ({n[k]})</Link>)}
      </div>

      <div className="card small" style={{ padding: 12 }}>
        <div className="row" style={{ alignItems: "center" }}>
          <div>
            <b>Live tracker sheet:</b>{" "}
            {!sheetConfigured() ? <span className="muted">not connected. See README, &quot;Live Google Sheet&quot; (5 minutes).</span>
              : lastSheetSync()?.ok ? <span style={{ color: "var(--good)" }}>connected, last updated {new Date(lastSheetSync()!.at).toLocaleTimeString()}</span>
              : lastSheetSync() ? <span style={{ color: "var(--bad)" }}>{lastSheetSync()!.error}</span>
              : <span className="muted">connected. Updates after your next change.</span>}
          </div>
          {sheetConfigured() && <form action={syncSheetAction} style={{ flex: "0 0 auto" }}><input type="hidden" name="campaignId" value={id} /><button type="submit" className="ghost">Update sheet now</button></form>}
          <a className="btn ghost" href={`/api/campaigns/${id}/tracker`} style={{ flex: "0 0 auto" }}>Download tracker CSV</a>
        </div>
      </div>

      {tab === "pending" && counts.pending > 1 && (
        <form action={approveAllAction} style={{ marginBottom: 14 }}>
          <input type="hidden" name="campaignId" value={id} />
          <button type="submit" className="ghost">Approve all {counts.pending} as written</button>
          <span className="small muted"> Only do this after reading a few.</span>
        </form>
      )}

      {list.items.length === 0 && <div className="card muted">Nothing here yet.</div>}

      {list.items.map((d) => (
        <form key={d.id} action={reviewDraftAction} className="draft">
          <input type="hidden" name="draftId" value={d.id} />
          <input type="hidden" name="campaignId" value={id} />
          <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
            <div><b>{d.company}</b> <span className="muted small">{d.domain}</span></div>
            <div style={{ flex: "0 0 auto" }}>
              <span className="pill High" style={{ background: "var(--bg)", color: "var(--muted)" }}>fit {d.fitScore}</span>{" "}
              <span className="small muted">to {d.email}</span>{" "}
              <span className={`vpill ${d.verification}`}>{d.verification}</span>{" "}
              <span className="kind">{d.kind}</span>{" "}
              <span className="kind">written by {d.writtenBy}</span>
            </div>
          </div>
          {d.rationale && <div className="why small muted">Why this email: {d.rationale}</div>}

          <div className="grid" style={{ marginBottom: 10 }}>
            <div><label>Subject A <span className="hint">(sent if you choose A)</span></label><input type="text" name="subjectA" defaultValue={d.subjectA} /></div>
            <div><label>Subject B</label><input type="text" name="subjectB" defaultValue={d.subjectB} /></div>
            <div><label>Which subject to send</label>
              <select name="variant" defaultValue={d.variant}><option value="A">A</option><option value="B">B</option></select>
            </div>
          </div>
          <label>Email</label>
          <textarea name="body" defaultValue={d.body} readOnly={tab === "sent"} />

          <div className="actions">
            {(tab === "pending" || tab === "rejected") && <button type="submit" name="intent" value="approve" className="good">Approve</button>}
            {tab !== "sent" && <button type="submit" name="intent" value="save" className="ghost">Save changes</button>}
            {tab === "pending" && <button type="submit" name="intent" value="reject" className="bad">Reject</button>}
            {(tab === "approved" || tab === "rejected") && <button type="submit" name="intent" value="reset" className="ghost">Move back to waiting</button>}
          </div>
        </form>
      ))}

      <div className="pager">
        {page > 1 ? <Link href={`/campaigns/${id}/review?tab=${tab}&page=${page - 1}`}>← Previous</Link> : <span />}
        <span className="small muted">Page {list.page} of {list.pages}</span>
        {page < list.pages ? <Link href={`/campaigns/${id}/review?tab=${tab}&page=${page + 1}`}>Next →</Link> : <span />}
      </div>
    </>
  );
}
