import { getDb } from "@/lib/db";
import { getCampaign } from "@/lib/queries";
import { buildExportCsv } from "@/lib/export";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const db = getDb();
  const campaign = Number.isInteger(id) ? getCampaign(db, id) : null;
  if (!campaign) return new Response("Not found", { status: 404 });
  const file = campaign.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "campaign";
  return new Response(buildExportCsv(db, id), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}.csv"` },
  });
}
