import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getCampaign } from "@/lib/queries";
import { listReplies, replyCounts } from "@/lib/replies";
import { LABELS, NEXT_STEP, NEEDS_REPLY } from "@/lib/classify";
import { meetingAction, relabelAction } from "../../../actions";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { Interested: "valid", Question: "valid", "Not now": "risky", "Out of office": "risky", Unclear: "risky", "Not interested": "invalid", Unsubscribe: "invalid", Bounced: "invalid" };

export default async function RepliesPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const db = getDb();
  const campaign = Number.isInteger(id) ? getCampaign(db, id) : null;
  if (!campaign) notFound();
  const replies = listReplies(db, id);
  const c = replyCounts(db, id);
  const needs = replies.filter((r) => NEEDS_REPLY.includes(r.label));

  return (
    <>
      <p className="small"><Link href={`/campaigns/${id}`}>← {campaign.name}</Link></p>
      <h1>Replies</h1>
      <p className="sub">{c.sent} sent · {c.total} replies · {needs.length} need your answer · {c.meetings} meeting{c.meetings === 1 ? "" : "s"} booked</p>

      {replies.length === 0 && <div className="card muted">No replies yet. Go back and use &quot;Check my Gmail for replies&quot;, or add sample replies to see how it works.</div>}

      {replies.map((r) => (
        <div key={r.id} className="draft">
          <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
            <div><b>{r.company}</b> <span className="muted small">{r.email}</span></div>
            <div style={{ flex: "0 0 auto" }}>
              <span className={`vpill ${TONE[r.label] ?? "risky"}`}>{r.label}</span>{" "}
              {r.simulated && <span className="kind">sample</span>}{" "}
              <span className="kind">labelled by {r.by || "rules"}</span>
              {r.meeting && <> <span className="vpill valid">meeting booked</span></>}
            </div>
          </div>
          <div className="why small" style={{ whiteSpace: "pre-wrap" }}>{r.text || "(no text)"}</div>
          <p className="small muted" style={{ margin: "6px 0" }}>Next: {NEXT_STEP[r.label]}</p>
          <div className="actions">
            <form action={relabelAction} className="addform" style={{ margin: 0 }}>
              <input type="hidden" name="replyId" value={r.id} />
              <input type="hidden" name="campaignId" value={id} />
              <select name="label" defaultValue={r.label} style={{ width: "auto" }}>{LABELS.map((l) => <option key={l}>{l}</option>)}</select>
              <button type="submit" className="ghost">Change label</button>
            </form>
            {NEEDS_REPLY.includes(r.label) && (
              <form action={meetingAction} style={{ margin: 0 }}>
                <input type="hidden" name="replyId" value={r.id} />
                <input type="hidden" name="campaignId" value={id} />
                <input type="hidden" name="booked" value={r.meeting ? "0" : "1"} />
                <button type="submit" className={r.meeting ? "ghost" : "good"}>{r.meeting ? "Undo meeting booked" : "Mark meeting booked"}</button>
              </form>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
