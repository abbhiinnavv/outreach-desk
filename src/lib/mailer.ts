import nodemailer from "nodemailer";

/*
  The only file that talks to Gmail. It uses Gmail's normal mail server (SMTP) with an "app password",
  so no Google Cloud project is needed. The password stays in .env.local on your computer.
*/
export interface Outgoing { from: string; to: string; subject: string; text: string; headers?: Record<string, string> }
export type Mailer = (m: Outgoing) => Promise<{ messageId: string }>;

export type MailErrorKind = "auth" | "rejected" | "limit" | "network";
export class MailError extends Error {
  constructor(message: string, public kind: MailErrorKind) { super(message); }
}

export const gmailUser = () => (process.env.GMAIL_USER ?? "").trim();
const appPassword = () => (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
export const hasGmail = () => !!gmailUser() && !!appPassword();

/** Turns nodemailer's errors into the few cases the app cares about. */
export function classifyMailError(e: any): MailError {
  const code = String(e?.code ?? "");
  const resp = Number(e?.responseCode ?? 0);
  const text = String(e?.response ?? e?.message ?? "");
  if (code === "EAUTH" || resp === 535) return new MailError("Gmail refused the login. Check GMAIL_USER and GMAIL_APP_PASSWORD in .env.local.", "auth");
  if (/daily user sending|quota|rate limit|too many|5\.4\.5|4\.7\.0/i.test(text) || resp === 421 || resp === 450 || resp === 452)
    return new MailError("Gmail says you have hit its sending limit. Try again tomorrow.", "limit");
  if (code === "EENVELOPE" || (resp >= 550 && resp < 560)) return new MailError(`The address was refused: ${text.slice(0, 120)}`, "rejected");
  return new MailError("Could not reach Gmail. Check your internet connection.", "network");
}

export function makeGmailMailer(): Mailer {
  if (!hasGmail()) throw new MailError("Gmail is not set up. Add GMAIL_USER and GMAIL_APP_PASSWORD to .env.local and restart.", "auth");
  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: gmailUser(), pass: appPassword() } });
  return async (m) => {
    try {
      const info = await transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, headers: m.headers });
      return { messageId: String(info.messageId) };
    } catch (e) { throw classifyMailError(e); }
  };
}
