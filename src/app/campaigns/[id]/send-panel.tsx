"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sendTestAction, startSendingAction, stopSendingAction, type FormState } from "../../actions";

interface Counts { cap: number; today: number; approved: number; remaining: number; willSend: number }
const initial: FormState = {};

export default function SendPanel({ campaignId, gmail, gmailUser, initialSending, initialCounts }: { campaignId: number; gmail: boolean; gmailUser: string; initialSending: boolean; initialCounts: Counts }) {
  const [c, setC] = useState(initialCounts);
  const [sending, setSending] = useState(initialSending);
  const [note, setNote] = useState<string | null>(null);
  const [test, testAction, testing] = useActionState(sendTestAction, initial);
  const [start, startAction, starting] = useActionState(startSendingAction, initial);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    let was = initialSending;
    const tick = async () => {
      try {
        const p = await (await fetch(`/api/campaigns/${campaignId}/progress`, { cache: "no-store" })).json();
        if (!alive) return;
        setC(p.send); setSending(p.sending); setNote(p.sendNote);
        if (was && !p.sending) router.refresh();
        was = p.sending;
      } catch { /* next tick */ }
    };
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [campaignId, initialSending, router]);

  if (!gmail) {
    return (
      <p className="small">
        Gmail is not connected yet. Add <code>GMAIL_USER</code> and <code>GMAIL_APP_PASSWORD</code> to <code>.env.local</code> and restart (see README, &quot;Connect Gmail&quot;).
      </p>
    );
  }

  return (
    <div>
      <p className="small muted" style={{ margin: "0 0 10px" }}>
        Sending from <b>{gmailUser}</b> · {c.approved} approved · sent today {c.today} of {c.cap} allowed
      </p>

      <form action={testAction} style={{ marginBottom: 12 }}>
        <input type="hidden" name="campaignId" value={campaignId} />
        <button type="submit" className="ghost" disabled={testing || sending}>{testing ? "Sending test…" : "1. Send a test to myself"}</button>
        <span className="small muted"> Sends one email to your own inbox so you can see how it looks.</span>
        {test.message && <div className="ok">{test.message}</div>}
        {test.errors && <div className="errors">{test.errors[0]}</div>}
      </form>

      <form action={startAction}>
        <input type="hidden" name="campaignId" value={campaignId} />
        <label className="check" style={{ marginBottom: 8 }}>
          <input type="checkbox" name="confirm" value="yes" /> I have read the approved emails and I want them sent.
        </label>
        <div className="row">
          <button type="submit" disabled={starting || sending || c.willSend === 0} style={{ flex: "0 0 auto" }}>
            {sending ? "Sending…" : c.willSend === 0 ? (c.approved === 0 ? "No approved emails" : "Today's limit reached") : `2. Send ${c.willSend} approved email${c.willSend > 1 ? "s" : ""} now`}
          </button>
        </div>
        {start.message && <div className="ok">{start.message}</div>}
        {start.errors && <div className="errors">{start.errors[0]}</div>}
      </form>

      {sending && (
        <form action={stopSendingAction} style={{ marginTop: 8 }}>
          <input type="hidden" name="campaignId" value={campaignId} />
          <button type="submit" className="ghost">Stop after the current email</button>
        </form>
      )}
      {note && !sending && <p className="small" style={{ margin: "8px 0 0" }}>{note}</p>}
      {c.approved > c.willSend && c.willSend > 0 && <p className="small muted" style={{ margin: "8px 0 0" }}>{c.approved - c.willSend} more stay approved for the next day because of your daily limit.</p>}
    </div>
  );
}
