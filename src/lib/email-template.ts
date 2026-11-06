import type { CampaignRow } from "./queries";

/*
  The email template: the fixed frame around the words Gemini (or the fallback) writes.
  The greeting, sign-off and opt-out line are added HERE, in code, so they are always present
  and the AI cannot change them. The finished text is stored as one piece, so what you see
  on the approval screen is exactly what will be sent.
*/
export function firstName(full: string | null | undefined): string | null {
  const n = (full ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z][A-Za-z'’-]{1,20}$/.test(n) ? n : null;
}

export const OPT_OUT_LINE = `P.S. If this isn't relevant, just reply "no thanks" and I won't email you again.`;

/** Fixes small typing slips from the AI, such as a missing space after a full stop. */
export const tidy = (t: string) => t.trim().replace(/([a-z][.!?])([A-Z])/g, "$1 $2").replace(/[ \t]+\n/g, "\n");

export function assembleEmail(o: { companyName: string; contactName: string | null; paragraphs: string; sender: string }): string {
  const who = firstName(o.contactName);
  const greeting = who ? `Hi ${who},` : "Hi there,";
  return `${greeting}\n\n${tidy(o.paragraphs)}\n\nBest,\n${o.sender}\n\n${OPT_OUT_LINE}`;
}

const ASK: Record<CampaignRow["goal"], Record<CampaignRow["tone"], string>> = {
  demo: {
    warm: "Would you be open to a quick 15-minute demo this week? Happy to work around your schedule.",
    formal: "Would you be open to a brief demonstration at a time convenient to you?",
    casual: "Up for a quick 15-minute demo this week?",
  },
  reply: {
    warm: "Is this something your team is thinking about? Even a one-line reply would help me.",
    formal: "I would be grateful if you could let me know whether this is relevant to your team.",
    casual: "Is this on your radar at all? A one-liner is plenty.",
  },
  pilot: {
    warm: "Would you be open to a small pilot to see whether it fits how your team works?",
    formal: "Would you be willing to consider a small pilot to evaluate its fit for your team?",
    casual: "Want to try it out on a small pilot and see if it fits?",
  },
};

export const askLine = (c: Pick<CampaignRow, "goal" | "tone">) => ASK[c.goal][c.tone];
