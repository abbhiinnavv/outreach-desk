"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface P { running: boolean; pending: number; crawling: number; done: number; failed: number; emails: number; validEmails: number }

/* Asks the server for progress every 2 seconds while the email finder is running. */
export default function Progress({ campaignId, initial }: { campaignId: number; initial: P }) {
  const [p, setP] = useState<P>(initial);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    let wasRunning = initial.running;
    const tick = async () => {
      try {
        const r = await fetch(`/api/campaigns/${campaignId}/progress`, { cache: "no-store" });
        const next: P = await r.json();
        if (!alive) return;
        setP(next);
        if (wasRunning && !next.running) router.refresh(); // job just finished: reload the table
        wasRunning = next.running;
      } catch { /* try again on the next tick */ }
    };
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [campaignId, initial.running, router]);

  const total = p.pending + p.crawling + p.done + p.failed;
  const finished = p.done + p.failed;
  const pct = total ? Math.round((finished / total) * 100) : 0;
  return (
    <div>
      <div className="bar"><div className="barfill" style={{ width: `${pct}%` }} /></div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>
        {p.running ? "Working… " : ""}
        {finished} of {total} websites checked · {p.done} done · {p.failed} failed · {p.pending + p.crawling} waiting · {p.emails} emails found ({p.validEmails} look valid)
      </p>
    </div>
  );
}
