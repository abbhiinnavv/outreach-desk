import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getCampaign } from "@/lib/queries";
import { buildFunnel, conversion } from "@/lib/funnel";

export const dynamic = "force-dynamic";

export default async function FunnelPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const db = getDb();
  const campaign = Number.isInteger(id) ? getCampaign(db, id) : null;
  if (!campaign) notFound();
  const f = buildFunnel(db, id);
  const top = Math.max(f.stages[0].count, 1);

  return (
    <>
      <p className="small"><Link href={`/campaigns/${id}`}>← {campaign.name}</Link></p>
      <h1>Funnel</h1>
      <p className="sub">From a company found to a meeting booked. Every number is read live from the database.</p>

      {f.sampleReplies > 0 && (
        <div className="errors" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>
          {f.sampleReplies} of the replies counted here are <b>sample replies</b> made for a demo, not real answers. Remove them on the campaign page to see real results only.
        </div>
      )}

      <div className="card">
        {f.stages.map((s, i) => {
          const conv = i === 0 ? null : conversion(f.stages[i - 1].count, s.count);
          return (
            <div key={s.key} style={{ padding: "10px 0", borderTop: i ? "1px solid var(--line)" : "none" }}>
              <div className="row" style={{ alignItems: "baseline", marginBottom: 6 }}>
                <div style={{ flex: "1 1 auto" }}><b>{s.label}</b> <span className="small muted">{s.hint}</span></div>
                <div style={{ flex: "0 0 auto", textAlign: "right" }}>
                  {i > 0 && f.stages[i - 1].count !== s.count && <span className="arrow">{f.stages[i - 1].count.toLocaleString()} → </span>}<span className="bigfig">{s.count.toLocaleString()}</span>
                  {conv !== null && <div className="small muted">{conv}% of previous{conv === 100 ? " ✓" : ""}</div>}
                </div>
              </div>
              <div className="bar"><div className="barfill" style={{ width: `${Math.round((s.count / top) * 100)}%` }} /></div>
            </div>
          );
        })}
      </div>

      <div className="stats">
        <div className="stat"><b>{f.highFit}</b><span>High-fit companies</span></div>
        <div className="stat"><b>{f.bounced}</b><span>Bounced addresses</span></div>
        <div className="stat"><b>{f.autoReplies}</b><span>Auto-replies</span></div>
        <div className="stat"><b>{f.doNotEmail}</b><span>On the do-not-email list</span></div>
      </div>

      <div className="card">
        <h2>How to read this</h2>
        <p className="small muted" style={{ margin: 0 }}>
          A big drop between two stages shows where the work is. Fewer emails than companies means the email finder needs help (add contacts by hand).
          A drop between approved and sent means the daily limit is holding emails back. A low reply rate usually means the wording or the target list needs changing, not the tool.
          Sending is slow and capped on purpose, so a young Gmail account does not get flagged as spam.
        </p>
      </div>
    </>
  );
}
