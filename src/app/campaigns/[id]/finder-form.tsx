"use client";

import { useActionState, useState } from "react";
import { addCandidatesAction, findCompaniesAction, type FormState } from "../../actions";

const initial: FormState = {};
const BADGE: Record<string, { text: string; cls: string }> = {
  verified: { text: "website checked", cls: "valid" },
  mismatch: { text: "check this one", cls: "risky" },
  blocked: { text: "could not check", cls: "risky" },
  unreachable: { text: "no website found", cls: "invalid" },
};

export default function FinderForm({ campaignId, hasKey }: { campaignId: number; hasKey: boolean }) {
  const [found, findAction, finding] = useActionState(findCompaniesAction, initial);
  const [added, addAction, adding] = useActionState(addCandidatesAction, initial);
  const [dismissed, setDismissed] = useState<unknown>(null);
  const showList = found.candidates && dismissed !== found.candidates;

  return (
    <div>
      <form action={findAction}>
        <input type="hidden" name="campaignId" value={campaignId} />
        <div className="row">
          <div style={{ flex: "3 1 280px" }}>
            <label>Describe the companies you want</label>
            <input type="text" name="query" placeholder="e.g. wealth advisory firms in Mumbai" disabled={!hasKey} />
          </div>
          <div style={{ flex: "0 1 110px" }}>
            <label>How many</label>
            <select name="count" defaultValue="10" disabled={!hasKey}><option>5</option><option>10</option><option>15</option><option>20</option></select>
          </div>
          <button type="submit" disabled={finding || !hasKey}>{finding ? "Searching and checking websites…" : "Find companies"}</button>
        </div>
      </form>
      {!hasKey && <div className="errors">No Gemini key found yet. Create a file called .env.local in the project folder with one line, GEMINI_API_KEY=your key, then restart the app.</div>}
      {found.errors && <div className="errors"><ul>{found.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}

      {showList && (
        <form action={addAction} style={{ marginTop: 14 }}>
          <input type="hidden" name="campaignId" value={campaignId} />
          <input type="hidden" name="candidates" value={JSON.stringify(found.candidates)} />
          <p className="small muted" style={{ margin: "0 0 8px" }}>
            Gemini suggested these. We visited each website. Tick the ones you want to add. Companies with a checked website are ticked for you.
          </p>
          {found.candidates!.map((c, i) => (
            <label key={c.domain} className="check cand">
              <input type="checkbox" name="pick" value={i} defaultChecked={c.status === "verified"} disabled={c.status === "unreachable"} />
              <span>
                <b>{c.name}</b> <span className="muted small">{c.domain}{c.city || c.region ? ` · ${[c.city, c.region].filter(Boolean).join(", ")}` : ""}</span>{" "}
                <span className={`vpill ${BADGE[c.status].cls}`} title={c.note}>{BADGE[c.status].text}</span>
                {c.status !== "verified" && <span className="muted small"> {c.note}</span>}
              </span>
            </label>
          ))}
          <div style={{ marginTop: 10 }} className="row">
            <button type="submit" disabled={adding}>{adding ? "Adding…" : "Add ticked companies"}</button>
            <button type="button" className="ghost" onClick={() => setDismissed(found.candidates)}>Clear list</button>
          </div>
        </form>
      )}
      {added.message && <div className="ok">{added.message}</div>}
      {added.errors && <div className="errors"><ul>{added.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
    </div>
  );
}
