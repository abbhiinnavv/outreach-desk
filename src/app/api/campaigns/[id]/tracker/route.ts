import Papa from "papaparse";
import { getDb } from "@/lib/db";
import { buildTracker } from "@/lib/sheet-sync";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response("bad id", { status: 400 });
  return new Response("﻿" + Papa.unparse(buildTracker(getDb(), id)), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="email-tracker-${id}.csv"` },
  });
}
