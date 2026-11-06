"use client";

import { useActionState } from "react";
import Link from "next/link";
import { addSamplesAction, checkRepliesAction, removeSamplesAction, type FormState } from "../../actions";

const initial: FormState = {};
export interface ReplySummary { total: number; sample: number; meetings: number; sent: number; byLabel: Record<string, number> }

export default function ReplyPanel({ campaignId, gmail, summary }: { campaignId: number; gmail: boolean; summary: ReplySummary }) {
  const [state, action, checking] = useActionState(checkRepliesAction, initial);
  const chips = Object.entries(summary.byLabel);
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <form action={action} style={{ flex: "0 0 auto" }}>
          <input type="hidden" name="campaignId" value={campaignId} />
          <button type="submit" disabled={!gmail || checking}>{checking ? "Checking Gmail…" : "Check my Gmail for replies"}</button>
        </form>
        <Link className="btn ghost" href={`/campaigns/${campaignId}/replies`} style={{ flex: "0 0 auto" }}>Open replies ({summary.total})</Link>
        <form action={addSamplesAction} style={{ flex: "0 0 auto" }}>
          <input type="hidden" name="campaignId" value={campaignId} />
          <button type="submit" className="ghost" disabled={summary.sent === 0}>Add sample replies</button>
        </form>
        {summary.sample > 0 && (
          <form action={removeSamplesAction} style={{ flex: "0 0 auto" }}>
            <input type="hidden" name="campaignId" value={campaignId} />
            <button type="submit" className="ghost">Remove sample replies</button>
          </form>
        )}
      </div>
      {!gmail && <p className="small muted">Connect Gmail to check your real inbox. Sample replies work without it.</p>}
      {state.message && <div className="ok">{state.message}</div>}
      {state.errors && <div className="errors">{state.errors[0]}</div>}
      <p className="small muted" style={{ margin: "6px 0 0" }}>
        {summary.sent} sent · {summary.total} repl{summary.total === 1 ? "y" : "ies"}
        {chips.length > 0 && <> · {chips.map(([k, n]) => `${n} ${k}`).join(" · ")}</>}
        {summary.meetings > 0 && <> · {summary.meetings} meeting{summary.meetings > 1 ? "s" : ""} booked</>}
        {summary.sample > 0 && <> · includes {summary.sample} sample</>}
      </p>
    </div>
  );
}
