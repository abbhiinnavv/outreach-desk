import { geminiJson, GeminiError, type GeminiDeps } from "./gemini";

/*
  Labelling a reply. Plain rules first: they are free, instant and predictable, and they handle the clear cases.
  Gemini is asked only about the messages the rules cannot place. If it is not available the label is "Unclear"
  and you choose one yourself on the replies page.
*/
export const LABELS = ["Interested", "Question", "Not now", "Not interested", "Unsubscribe", "Out of office", "Bounced", "Unclear"] as const;
export type Label = (typeof LABELS)[number];

/** Labels after which we must never email that address again. */
export const SUPPRESSING: Label[] = ["Unsubscribe", "Not interested", "Bounced"];
/** Labels that need a human answer. */
export const NEEDS_REPLY: Label[] = ["Interested", "Question"];

export const NEXT_STEP: Record<Label, string> = {
  Interested: "Reply today and offer two time slots.",
  Question: "Answer the question, then offer a short call.",
  "Not now": "Parked. Try again in about 90 days.",
  "Not interested": "Added to the do-not-email list.",
  Unsubscribe: "Added to the do-not-email list.",
  "Out of office": "No action. Try again after they are back.",
  Bounced: "Address added to the do-not-email list. Find another contact for this company.",
  Unclear: "Read it and choose a label yourself.",
};

/** Keeps only what the person actually wrote: cuts quoted history and signatures' quoted headers. */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*On .{5,250}wrote:\s*$/i.test(line) || /^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^\s*From:\s.+@/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

export interface ReplyInput { from: string; subject: string; text: string; autoSubmitted?: boolean }

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery subsystem/i;
const BOUNCE_SUBJECT = /delivery status notification|undeliverable|undelivered|returned mail|delivery (has )?failed|failure notice|mail delivery failed/i;
const BOUNCE_BODY = /5\.1\.1|address not found|user unknown|no such user|does not exist|couldn'?t be delivered|wasn'?t delivered/i;
const OOO = /out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on (annual )?leave|away from (my )?(desk|email|office)|limited access to (my )?email|on vacation|will respond (when|after) i return/i;
const UNSUB = /\bunsubscribe\b|remove (me|us)\b|take (me|us) off|stop (emailing|contacting|sending|messaging)|do not (contact|email|write)|don'?t (contact|email|write)|no more emails/i;
const NOT_NOW = /not a priority|bad timing|busy (right now|at the moment|this (month|quarter))|(check|circle|get|touch|reach)\s*(back|base|out)[^.\n]{0,40}(later|next|in (a |few|couple)|after|\d)|(next|after) (quarter|month|year|diwali|festive)|revisit[^.\n]{0,30}(later|next|in)|maybe (later|next)|not (right )?now|at a later (date|time|stage)/i;
const NOT_INTERESTED = /not interested|no,? thanks?|no thank you|not relevant|not a (good )?fit|we (already|are happy with)|already (have|use|work with)|don'?t need|do not need|not looking|we'?re set|\bpass\b/i;
const INTERESTED = /\binterested\b|sounds (good|great|interesting|promising)|looks (good|great|interesting)|let'?s (talk|connect|chat|schedule|set up|hop|do)|happy to (chat|talk|connect|jump|speak|meet)|(book|schedule|setup|set up) (a |the )?(call|meeting|demo|time)|call (on|this|next|tomorrow|today)|(send|share) (me |us )?(more|the|some)?\s*(details|info|information|deck|brochure|pricing)|tell me more|would love to|available (on|this|next|tomorrow)|free (on|this|next|tomorrow)|go ahead/i;

export function classifyByRules(m: ReplyInput): Label | null {
  const head = `${m.subject}\n${m.text.slice(0, 600)}`;
  if (BOUNCE_FROM.test(m.from) || (BOUNCE_SUBJECT.test(m.subject) && BOUNCE_BODY.test(m.text))) return "Bounced";
  if (m.autoSubmitted || OOO.test(head)) return "Out of office";
  const body = m.text;
  if (UNSUB.test(body)) return "Unsubscribe";
  if (NOT_INTERESTED.test(body)) return "Not interested";
  if (NOT_NOW.test(body)) return "Not now";
  if (INTERESTED.test(body)) return "Interested";
  if (body.includes("?")) return "Question";
  return null;
}

const SCHEMA = { type: "OBJECT", properties: { label: { type: "STRING", enum: LABELS.filter((l) => l !== "Unclear") } }, required: ["label"] };

export async function classifyReply(m: ReplyInput, gemini?: GeminiDeps & { enabled?: boolean }): Promise<{ label: Label; by: "rules" | "gemini" | "none" }> {
  const byRules = classifyByRules(m);
  if (byRules) return { label: byRules, by: "rules" };
  if (gemini?.enabled === false) return { label: "Unclear", by: "none" };
  try {
    const out = await geminiJson<{ label: string }>(
      `Classify this reply to a cold sales email into exactly one label: ${LABELS.filter((l) => l !== "Unclear").join(", ")}.\nInterested = wants to talk or learn more. Question = asks something. Not now = maybe later. Not interested = declines. Unsubscribe = asks to stop. Out of office = auto reply. Bounced = delivery failure.\nReply:\n"""${m.text.slice(0, 1500)}"""`,
      SCHEMA, gemini ?? {}
    );
    const label = LABELS.find((l) => l === out?.label && l !== "Unclear");
    return label ? { label, by: "gemini" } : { label: "Unclear", by: "none" };
  } catch (e) {
    if (e instanceof GeminiError) return { label: "Unclear", by: "none" };
    throw e;
  }
}
