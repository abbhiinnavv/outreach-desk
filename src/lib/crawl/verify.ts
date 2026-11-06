import dns from "node:dns/promises";

/*
  Free email checks. These catch most bad addresses, but NO free check can prove an inbox exists.
  Only an actual send can show that (a bounce). So the labels are careful:

    valid    looks deliverable: correct format, the domain has mail servers,
             and the address is on the company's own domain
    risky    probably fine but not certain: a free provider (gmail), a different domain,
             or we could not check right now
    invalid  will not work: bad format, domain has no mail servers, or a no-reply address
*/
export type Verification = "valid" | "risky" | "invalid";
export interface VerifyResult { verification: Verification; note: string }

/** true = the domain can receive mail, false = it cannot, null = could not check (try later). */
export type MxResolver = (domain: string) => Promise<boolean | null>;

export const dnsMx: MxResolver = async (domain) => {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length > 0) return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENODATA" && code !== "ENOTFOUND") return null;
  }
  // No MX record: mail may still go to the domain's main address (an A record).
  try {
    return (await dns.resolve4(domain)).length > 0;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENODATA" || code === "ENOTFOUND" ? false : null;
  }
};

const FREE_PROVIDERS = new Set(["gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com", "rediffmail.com", "icloud.com", "proton.me", "protonmail.com"]);
const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse)$/i;
const SYNTAX = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export async function verifyEmail(
  email: string,
  companyDomain: string,
  mx: MxResolver,
  cache: Map<string, boolean | null> = new Map()
): Promise<VerifyResult> {
  const e = email.trim().toLowerCase();
  if (!SYNTAX.test(e) || e.length > 254) return { verification: "invalid", note: "not a valid email format" };
  const [local, domain] = e.split("@");
  if (NO_REPLY.test(local)) return { verification: "invalid", note: "a no-reply address nobody reads" };

  let hasMail = cache.get(domain);
  if (hasMail === undefined) { hasMail = await mx(domain); cache.set(domain, hasMail); }
  if (hasMail === false) return { verification: "invalid", note: "the domain cannot receive email" };
  if (hasMail === null) return { verification: "risky", note: "could not check the domain right now" };

  const root = companyDomain.replace(/^www\./, "").toLowerCase();
  if (FREE_PROVIDERS.has(domain)) return { verification: "risky", note: "a free email provider, not the company's own domain" };
  if (domain !== root && !domain.endsWith("." + root) && !root.endsWith("." + domain)) {
    return { verification: "risky", note: `different domain from the company (${domain})` };
  }
  return { verification: "valid", note: "company domain, mail server found" };
}
