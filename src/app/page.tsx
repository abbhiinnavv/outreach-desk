import Link from "next/link";
import { getDb } from "@/lib/db";
import { listCampaigns } from "@/lib/queries";
import CampaignForm from "./campaign-form";

export const dynamic = "force-dynamic";

export default function Home() {
  const campaigns = listCampaigns(getDb());
  return (
    <>
      <h1>Campaigns</h1>
      <p className="sub">A campaign is one outreach goal: who you target, what you offer, and how the email should sound.</p>

      {campaigns.length > 0 && (
        <div className="card">
          <h2>Your campaigns</h2>
          <div className="tablewrap"><table>
            <thead><tr><th>Name</th><th>Product</th><th>Regions</th><th>Companies</th></tr></thead>
            <tbody>{campaigns.map((c) => (
              <tr key={c.id}><td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td><td>{c.product}</td><td>{c.regions.join(", ")}</td><td>{c.companies.toLocaleString()}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      <div className="card">
        <h2>New campaign</h2>
        <CampaignForm />
      </div>
    </>
  );
}
