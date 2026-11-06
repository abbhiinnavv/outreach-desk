import { getDb } from "@/lib/db";
import { buildWorkbook } from "@/lib/workbook";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response("bad id", { status: 400 });
  const file = await buildWorkbook(getDb(), id);
  return new Response(new Uint8Array(file), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="outreach-desk-campaign-${id}.xlsx"`,
    },
  });
}
