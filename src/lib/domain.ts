/*
  Turn whatever someone pasted ("https://www.Acme.com/about?x=1") into a clean domain ("acme.com").
  The clean domain is how we spot duplicates, so the same company is never emailed twice.
  Returns null when the input is not a plausible domain.
*/
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // protocol
  d = d.replace(/^[^@/]*@/, "");                // user@ before the host
  d = d.split(/[/?#]/)[0] ?? "";                // path, query, fragment
  d = d.replace(/:\d+$/, "");                   // port
  d = d.replace(/^www\./, "");
  d = d.replace(/\.$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;

export function cleanEmail(input: string | null | undefined): string | null {
  const e = (input ?? "").trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}
