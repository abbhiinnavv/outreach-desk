/*
  Makes a big fake company list so you can prove the app handles any size.
  Usage: tsx scripts/make-sample.ts 1000 sample-data/companies-1000.csv
  Every domain ends in .example, so no real company can ever be emailed from this data.
*/
import fs from "node:fs";
import path from "node:path";

const n = Number(process.argv[2] ?? 1000);
const out = process.argv[3] ?? "sample-data/companies-1000.csv";

const regions = ["India", "India", "India", "Singapore", "UAE", "UK", "USA"];
const cities: Record<string, string[]> = {
  India: ["Mumbai", "Bangalore", "Delhi", "Pune", "Chennai"],
  Singapore: ["Singapore"], UAE: ["Dubai"], UK: ["London"], USA: ["New York"],
};
const words = ["Alder", "Birch", "Cedar", "Delta", "Ember", "Fjord", "Granite", "Harbor", "Iris", "Juniper", "Kestrel", "Lumen", "Maple", "Nova", "Onyx", "Pine", "Quartz", "Raven", "Sage", "Tidal"];
const kinds = ["Wealth", "Capital", "Advisors", "Partners", "Family Office"];
const triggers = ["", "", "Hiring relationship managers", "Opened a new office", "Launched a PMS product", "Recently funded"];
const roles = ["Founder", "Managing Partner", "Head of Advisory", "Relationship Manager", "Operations Executive"];

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

const rows = ["name,website,city,region,trigger,contact name,role,email"];
for (let i = 0; i < n; i++) {
  const name = `${pick(words)} ${pick(kinds)} ${i + 1}`;
  const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`;
  const region = pick(regions);
  const role = pick(roles);
  const hasEmail = rnd() > 0.2;
  const email = hasEmail ? `${rnd() > 0.5 ? "info" : "contact" + i}@${domain}` : "";
  rows.push([
    name, `https://www.${domain}`, pick(cities[region]), region, pick(triggers), hasEmail ? `Person ${i + 1}` : "", role, email,
  ].join(","));
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rows.join("\n") + "\n");
console.log(`Wrote ${n} fake companies to ${out}`);
