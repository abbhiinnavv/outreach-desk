import { getDb } from "@/lib/db";
import { enrichProgress } from "@/lib/enrich";
import { isRunning, isDrafting, draftOutcome, isSending, sendOutcome } from "@/lib/jobs";
import { sendCounts } from "@/lib/sending";
import { draftCounts } from "@/lib/drafts";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "bad id" }, { status: 400 });
  const db = getDb();
  return Response.json({ running: isRunning(id), ...enrichProgress(db, id), drafting: isDrafting(id), drafts: draftCounts(db, id), sending: isSending(id), send: sendCounts(db, id), sendNote: sendOutcome(id), draftNote: draftOutcome(id)?.result?.note ?? draftOutcome(id)?.error ?? null });
}
