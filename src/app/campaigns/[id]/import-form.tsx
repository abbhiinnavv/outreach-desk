"use client";

import { useActionState } from "react";
import { importCsvAction, type FormState } from "../../actions";

const initial: FormState = {};

export default function ImportForm({ campaignId }: { campaignId: number }) {
  const [state, action, pending] = useActionState(importCsvAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="row">
        <div><label>CSV file <span className="hint">(any number of rows)</span></label><input type="file" name="file" accept=".csv,text/csv" /></div>
        <button type="submit" disabled={pending}>{pending ? "Importing…" : "Import companies"}</button>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary className="small muted">Or paste CSV text</summary>
        <textarea name="paste" placeholder="name,website,region" style={{ marginTop: 8 }} />
      </details>
      {state.message && <div className="ok">{state.message}</div>}
      {state.errors && <div className="errors"><ul>{state.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
    </form>
  );
}
