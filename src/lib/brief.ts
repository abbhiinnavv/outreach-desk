import type { Brief } from "./score";

/*
  The campaign brief: who we target, why, and how the email should sound.
  It is the single input the whole agent works from. Validation lives here so the form,
  the tests and later steps all share the same rules.
*/
export interface CampaignInput {
  name: string;
  product: string;
  pitch: string;
  regions: string[];
  goal: "demo" | "reply" | "pilot";
  tone: "warm" | "formal" | "casual";
  sender: string;
  dailyCap: number;
}

export type ParseResult = { ok: true; value: CampaignInput } | { ok: false; errors: string[] };

const pick = <T extends string>(v: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export function parseBrief(get: (key: string) => string | null | undefined): ParseResult {
  const s = (k: string) => (get(k) ?? "").toString().trim();
  const errors: string[] = [];

  const name = s("name");
  const product = s("product");
  const pitch = s("pitch");
  const sender = s("sender");
  const regions = s("regions").split(",").map((r) => r.trim()).filter(Boolean);

  if (!name) errors.push("Give the campaign a name.");
  if (!product) errors.push("Say what product you are selling.");
  if (!pitch) errors.push("Write the one-line pitch.");
  if (!sender) errors.push("Add the sender name.");
  if (regions.length === 0) errors.push("Add at least one target region.");

  const dailyCap = Number.parseInt(s("dailyCap") || "10", 10);
  if (!Number.isFinite(dailyCap) || dailyCap < 1 || dailyCap > 500) errors.push("Daily send cap must be between 1 and 500.");

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name, product, pitch, regions, sender, dailyCap,
      goal: pick(s("goal"), ["demo", "reply", "pilot"] as const, "demo"),
      tone: pick(s("tone"), ["warm", "formal", "casual"] as const, "warm"),
    },
  };
}

export const toScoringBrief = (c: Pick<CampaignInput, "regions">): Brief => ({ regions: c.regions });
