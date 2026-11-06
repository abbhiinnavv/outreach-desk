"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Counts { pending: number; approved: number; rejected: number; sent: number; total: number; waiting: number }

/* While emails are being written, asks the server every 2 seconds how many are done. */
export default function DraftProgress({ campaignId, initialDrafting, initialCounts }: { campaignId: number; initialDrafting: boolean; initialCounts: Counts }) {
  const [c, setC] = useState(initialCounts);
  const [drafting, setDrafting] = useState(initialDrafting);
  const [note, setNote] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    let was = initialDrafting;
    const tick = async () => {
      try {
        const r = await fetch(`/api/campaigns/${campaignId}/progress`, { cache: "no-store" });
        const p = await r.json();
        if (!alive) return;
        setC(p.drafts); setDrafting(p.drafting); setNote(p.draftNote);
        if (was && !p.drafting) router.refresh();
        was = p.drafting;
      } catch { /* next tick */ }
    };
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [campaignId, initialDrafting, router]);

  return (
    <div>
      {drafting && <div className="bar"><div className="barfill" style={{ width: `${c.total + c.waiting ? Math.round((c.total / (c.total + c.waiting)) * 100) : 0}%` }} /></div>}
      <p className="small muted" style={{ margin: "6px 0 0" }}>
        {drafting ? "Writing… " : ""}{c.total} written · {c.pending} waiting for you · {c.approved} approved · {c.rejected} rejected · {c.waiting} still to write
      </p>
      {note && !drafting && <p className="small" style={{ margin: "6px 0 0" }}>{note}</p>}
    </div>
  );
}
