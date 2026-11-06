import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { campaignStats, contactsFor, getCampaign, listCompanies } from "@/lib/queries";
import { syncSheetAction, addContactAction, rescoreAction, startEnrichAction, stopEnrichAction, startDraftingAction } from "../../actions";
import { draftCounts } from "@/lib/drafts";
import { isDrafting, isSending } from "@/lib/jobs";
import { sendCounts } from "@/lib/sending";
import { gmailUser, hasGmail } from "@/lib/mailer";
import SendPanel from "./send-panel";
import ReplyPanel from "./reply-panel";
import { lastSheetSync, sheetConfigured } from "@/lib/sheet-sync";
import { replyCounts } from "@/lib/replies";
import DraftProgress from "./draft-progress";
import { enrichProgress } from "@/lib/enrich";
import { isRunning } from "@/lib/jobs";
import ImportForm from "./import-form";
import Progress from "./progress";
import FinderForm from "./finder-form";
import { hasGeminiKey } from "@/lib/gemini";

export const dynamic = "force-dynamic";

type Search = { fit?: string; q?: string; page?: string };

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id: idStr } = await params;
  const sp = await searchParams;
  const id = Number(idStr);
  const db = getDb();
  const campaign = Number.isInteger(id) ? getCampaign(db, id) : null;
  if (!campaign) notFound();

  const fit = sp.fit === "High" || sp.fit === "Medium" || sp.fit === "Low" ? sp.fit : "";
  const q = sp.q ?? "";
  const page = Math.max(Number.parseInt(sp.page ?? "1", 10) || 1, 1);
  const stats = campaignStats(db, id);
  const list = listCompanies(db, id, { fit, q, page, pageSize: 25 });
  const allContacts = contactsFor(db, list.items.map((c) => c.id));
  const running = isRunning(id);
  const prog = { running, ...enrichProgress(db, id) };
  const dc = draftCounts(db, id);
  const drafting = isDrafting(id);
  const sc = sendCounts(db, id);
  const rc = replyCounts(db, id);

  const qs = (over: Record<string, string | number>) => {
    const p = new URLSearchParams({ ...(fit && { fit }), ...(q && { q }), page: String(page), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) });
    return `/campaigns/${id}?${p.toString()}`;
  };

  return (
    <>
      <p className="small"><Link href="/">← All campaigns</Link></p>
      <h1>{campaign.name}</h1>
      <p className="sub">{campaign.product} · {campaign.regions.join(", ")} · goal: {campaign.goal} · cap {campaign.dailyCap}/day</p>

      <div className="card master" style={{ padding: 16 }}>
        <div>
          <b>Master workbook</b> <span className="small muted">every company from found to feedback, updated after each step</span>
          <div className="small" style={{ marginTop: 2 }}>
            Live Google Sheet:{" "}
            {!sheetConfigured() ? <span className="muted">not connected (optional, see README)</span>
              : lastSheetSync()?.ok ? <span className="tick">✓ updated {new Date(lastSheetSync()!.at).toLocaleTimeString()}</span>
              : lastSheetSync() ? <span style={{ color: "var(--bad)" }}>{lastSheetSync()!.error}</span>
              : <span className="muted">connected, updates after your next change</span>}
          </div>
        </div>
        <div className="row" style={{ flex: "0 0 auto" }}>
          <a className="btn" href={`/api/campaigns/${id}/workbook`}>Download Excel (.xlsx)</a>
          {sheetConfigured() && <form action={syncSheetAction}><input type="hidden" name="campaignId" value={id} /><button type="submit" className="ghost">Update sheet now</button></form>}
          <Link className="btn ghost" href={`/campaigns/${id}/funnel`}>See the funnel →</Link>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><b>{stats.total.toLocaleString()}</b><span>Companies</span></div>
        <div className="stat"><b>{stats.high.toLocaleString()}</b><span>High fit</span></div>
        <div className="stat"><b>{stats.medium.toLocaleString()}</b><span>Medium fit</span></div>
        <div className="stat"><b>{stats.low.toLocaleString()}</b><span>Low fit</span></div>
        <div className="stat"><b>{stats.withEmail.toLocaleString()}</b><span>With an email</span></div>
      </div>

      <div className="card">
        <h2><span className="num">01</span> Add companies</h2>
        <h3 className="sec">Find them with AI</h3>
        <FinderForm campaignId={id} hasKey={hasGeminiKey()} />
        <h3 className="sec">Or upload your own list</h3>
        <p className="small muted" style={{ marginTop: -6 }}>Columns it understands: name, website/domain, city, region, trigger, contact name, role, email. Only name and website are needed. Duplicates (same website) are skipped.</p>
        <ImportForm campaignId={id} />
      </div>

      <div className="card">
        <h2><span className="num">02</span> Find emails</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Visits each company website (home, contact, about and team pages), saves every email it finds together with the page it came from,
          then checks each email. It follows each site&apos;s robots.txt and waits between page loads. Companies already in the list with an email from your CSV get checked too.
        </p>
        <div className="row" style={{ marginBottom: 10 }}>
          <form action={startEnrichAction} style={{ flex: "0 0 auto" }}>
            <input type="hidden" name="campaignId" value={id} />
            <button type="submit" disabled={running || (prog.pending === 0)}>{running ? "Running…" : prog.pending === 0 ? "Nothing waiting" : `Find emails for ${prog.pending.toLocaleString()} companies`}</button>
          </form>
          {prog.failed > 0 && !running && (
            <form action={startEnrichAction} style={{ flex: "0 0 auto" }}>
              <input type="hidden" name="campaignId" value={id} />
              <input type="hidden" name="retryFailed" value="1" />
              <button className="ghost" type="submit">Retry {prog.failed} failed</button>
            </form>
          )}
          {running && (
            <form action={stopEnrichAction} style={{ flex: "0 0 auto" }}>
              <input type="hidden" name="campaignId" value={id} />
              <button className="ghost" type="submit">Stop</button>
            </form>
          )}
        </div>
        <Progress campaignId={id} initial={prog} />
      </div>

      <div className="card">
        <h2><span className="num">03</span> Write the emails</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Writes one email for each company that has a usable email address (valid or risky, not careers@ or legal@ style inboxes).
          It reads the company&apos;s own website so the email can mention something real, uses Gemini when your key works, and a plain template when it does not.
          <b> Nothing is sent.</b> Every email waits on the review page for you to edit and approve.
        </p>
        <div className="row" style={{ marginBottom: 10 }}>
          <form action={startDraftingAction} style={{ flex: "0 0 auto" }}>
            <input type="hidden" name="campaignId" value={id} />
            <button type="submit" disabled={drafting || dc.waiting === 0}>{drafting ? "Writing…" : dc.waiting === 0 ? "Nothing to write" : `Write ${dc.waiting} email${dc.waiting > 1 ? "s" : ""}`}</button>
          </form>
          {dc.total > 0 && <Link className="btn ghost" href={`/campaigns/${id}/review`} style={{ flex: "0 0 auto" }}>Review and approve ({dc.pending} waiting)</Link>}
        </div>
        <DraftProgress campaignId={id} initialDrafting={drafting} initialCounts={dc} />
      </div>

      <div className="card">
        <h2><span className="num">04</span> Send</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Sends only the emails you approved, one at a time with a pause between each, up to your daily limit. It never emails the same address twice,
          and skips anyone on the do-not-email list. Always send the test first.
        </p>
        <SendPanel campaignId={id} gmail={hasGmail()} gmailUser={gmailUser()} initialSending={isSending(id)} initialCounts={sc} />
      </div>

      <div className="card">
        <h2><span className="num">05</span> Replies</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Reads your Gmail inbox (read only) and keeps only replies to emails sent from here. Each reply is labelled: Interested, Question, Not now, Not interested, Unsubscribe, Out of office or Bounced.
          Anyone who says no, unsubscribes or bounces goes on the do-not-email list automatically. Sample replies are clearly marked and can be removed in one click.
        </p>
        <ReplyPanel campaignId={id} gmail={hasGmail()} summary={rc} />
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, flex: "1 1 auto" }}><span className="num">06</span> Companies, best fit first</h2>
          <a className="btn ghost" href={`/api/campaigns/${id}/export`} style={{ flex: "0 0 auto" }}>Download CSV</a>
          <form action={rescoreAction} style={{ flex: "0 0 auto" }}>
            <input type="hidden" name="campaignId" value={id} />
            <button className="ghost" type="submit">Re-score all</button>
          </form>
        </div>
        <form method="get" className="row" style={{ marginBottom: 12 }}>
          <div><label>Search</label><input type="search" name="q" defaultValue={q} placeholder="Name or website" /></div>
          <div><label>Fit</label><select name="fit" defaultValue={fit}><option value="">All</option><option>High</option><option>Medium</option><option>Low</option></select></div>
          <button type="submit">Filter</button>
        </form>

        {list.items.length === 0 ? (
          <p className="muted">{stats.total === 0 ? "No companies yet. Import a CSV above (try sample-data/companies.csv)." : "No companies match this filter."}</p>
        ) : (
          <div className="tablewrap"><table>
            <thead><tr><th>Fit score (0–100)</th><th>Company</th><th>Where</th><th>Trigger</th><th>Contact</th></tr></thead>
            <tbody>{list.items.map((c) => (
              <tr key={c.id}>
                <td><div className="score">{c.fitScore}</div><span className={`pill ${c.fitLabel}`}>{c.fitLabel} fit</span><div className={`gauge ${c.fitLabel}`}><i style={{ width: `${c.fitScore}%` }} /></div></td>
                <td><b>{c.name}</b><div className="small muted">{c.domain}</div></td>
                <td>{[c.city, c.region].filter(Boolean).join(", ") || "-"}</td>
                <td className="small">{c.trigger ?? <span className="muted">none</span>}</td>
                <td className="small">
                  {c.contactEmail ? (
                    <>
                      {c.contactEmail}{" "}
                      {c.contactVerification && c.contactVerification !== "unchecked" && <span className={`vpill ${c.contactVerification}`} title={c.contactNote ?? ""}>{c.contactVerification}</span>}
                      <div className="muted">{c.contactRole ?? "role unknown"}</div>
                      {c.contactSource && <div className="muted">found on <a href={c.contactSource} target="_blank" rel="noreferrer">{new URL(c.contactSource).pathname || "/"}</a></div>}
                    </>
                  ) : c.crawlStatus === "failed" ? (
                    <span className="muted" title={c.crawlNote ?? ""}>failed: {c.crawlNote}</span>
                  ) : c.crawlStatus === "done" ? (
                    <span className="muted">no email on the site</span>
                  ) : (
                    <span className="muted">not searched yet</span>
                  )}
                  <details className="emails">
                    <summary>{c.emailCount > 0 ? `All ${c.emailCount} email${c.emailCount > 1 ? "s" : ""} · add one` : "Add an email by hand"}</summary>
                    {(allContacts.get(c.id) ?? []).map((e) => (
                      <div key={e.id} className="erow">
                        <span>{e.email}</span>{" "}
                        <span className={`vpill ${e.verification}`} title={e.note ?? ""}>{e.verification}</span>{" "}
                        <span className="kind">{e.kind}</span>
                        <div className="muted">
                          {e.note}
                          {e.sourceUrl ? <> · found on <a href={e.sourceUrl} target="_blank" rel="noreferrer">{new URL(e.sourceUrl).pathname || "/"}</a></> : ` · added by ${e.method}`}
                        </div>
                      </div>
                    ))}
                    <form action={addContactAction} className="addform">
                      <input type="hidden" name="companyId" value={c.id} />
                      <input type="text" name="email" placeholder="name@company.com" required />
                      <input type="text" name="role" placeholder="role (optional)" />
                      <button type="submit" className="ghost">Add</button>
                    </form>
                  </details>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}

        <div className="pager">
          {page > 1 ? <Link href={qs({ page: page - 1 })}>← Previous</Link> : <span />}
          <span className="small muted">Page {list.page} of {list.pages.toLocaleString()} · {list.total.toLocaleString()} companies</span>
          {page < list.pages ? <Link href={qs({ page: page + 1 })}>Next →</Link> : <span />}
        </div>
      </div>

      <div className="card next">
        <b>Done:</b> all six steps are built. Open the funnel for the one-page summary.
      </div>
    </>
  );
}
