"use client";

import { useActionState } from "react";
import { createCampaignAction, type FormState } from "./actions";

const initial: FormState = {};

export default function CampaignForm() {
  const [state, action, pending] = useActionState(createCampaignAction, initial);
  return (
    <form action={action}>
      <div className="grid">
        <div><label>Campaign name</label><input type="text" name="name" defaultValue="HyperNorm: wealth advisors" /></div>
        <div><label>Sender name</label><input type="text" name="sender" defaultValue="Abhinav" /></div>
        <div><label>Product <span className="hint">(what are you selling?)</span></label><input type="text" name="product" defaultValue="HyperNorm" /></div>
        <div><label>Target regions <span className="hint">(comma separated)</span></label><input type="text" name="regions" defaultValue="India, Singapore, UAE" /></div>
      </div>
      <div style={{ marginTop: 14 }}>
        <label>One-line pitch <span className="hint">(the email is built around this)</span></label>
        <textarea name="pitch" defaultValue="Helps wealth advisory firms turn client data into personalised recommendations, so advisors spend less time on paperwork and more on clients." />
      </div>
      <div className="grid" style={{ marginTop: 14 }}>
        <div><label>Goal of the email</label><select name="goal" defaultValue="demo"><option value="demo">Book a demo</option><option value="reply">Get a reply</option><option value="pilot">Offer a pilot</option></select></div>
        <div><label>Tone</label><select name="tone" defaultValue="warm"><option value="warm">Warm</option><option value="formal">Formal</option><option value="casual">Casual</option></select></div>
        <div><label>Daily send cap</label><input type="number" name="dailyCap" defaultValue={10} min={1} max={500} /></div>
      </div>
      {state.errors && <div className="errors"><ul>{state.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      <div style={{ marginTop: 16 }}><button type="submit" disabled={pending}>{pending ? "Creating…" : "Create campaign"}</button></div>
    </form>
  );
}
