import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { gmailUser, MailError } from "./mailer";
import type { Inbound } from "./replies";

/*
  Reads your Gmail inbox (read only) with the same app password used for sending.
  It only looks at mail from the last few days and hands it to processInbound, which keeps nothing
  that is not a reply to an email this app sent.
*/
export async function fetchInbound(since: Date, max = 300): Promise<Inbound[]> {
  const pass = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: gmailUser(), pass }, logger: false });
  try {
    await client.connect();
  } catch (e: any) {
    console.error("IMAP connect failed:", e?.code, e?.responseText ?? e?.message);
    if (e?.authenticationFailed) throw new MailError("Gmail refused the login for reading mail. Check GMAIL_USER and GMAIL_APP_PASSWORD in .env.local.", "auth");
    const why = String(e?.responseText ?? e?.code ?? e?.message ?? "unknown").slice(0, 160);
    throw new MailError(`Could not open your inbox (${why}).`, "network");
  }
  const out: Inbound[] = [];
  client.on("error", () => {}); // errors are reported through the calls below
  const lock = await client.getMailboxLock("INBOX");
  try {
    const found = await client.search({ since }, { uid: true });
    const uids = (found || []).slice(-max);
    if (uids.length) {
      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        if (!msg.source) continue;
        const p = await simpleParser(msg.source);
        const from = p.from?.value?.[0]?.address?.toLowerCase();
        if (!from || from === gmailUser().toLowerCase() || !p.messageId) continue;
        const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
        const auto = String(p.headers.get("auto-submitted") ?? "").toLowerCase();
        out.push({
          messageId: p.messageId, from, subject: p.subject ?? "", text: p.text ?? "",
          inReplyTo: p.inReplyTo ?? null, references: refs, autoSubmitted: !!auto && auto !== "no",
          date: p.date ? p.date.toISOString().replace("T", " ").slice(0, 19) : undefined,
        });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}
