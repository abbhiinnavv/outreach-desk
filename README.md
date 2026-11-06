# Outreach Desk

An outreach agent with a human approval gate. You describe a campaign, it finds and scores companies, finds contacts, drafts emails, and sends only what you approve.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 55 tests
npm run typecheck
npm run sample:big   # makes sample-data/companies-1000.csv (fake .example domains)
```

Node 20+ required. The database is one file: `data/outreach.db`. Delete it to start fresh.

## Build plan

| Step | What | Status |
|---|---|---|
| 1 | Campaign brief, unlimited CSV import, dedupe, fit scoring, company list | done |
| 2a | Email finder: crawl company sites, keep the source page, check every email | done |
| 2b | Company finder: Gemini suggests firms, every website is checked before you can add it | done |
| 3 | Email writing (Gemini, template fallback) + review and approval page | done |
| 4 | Sending through Gmail, daily cap, pauses, no repeats, do-not-email list | done |
| 5 | Reply tracking: reads Gmail, labels replies, do-not-email list, sample replies for demos | done |
| 6 | One-page funnel (found, email, written, approved, sent, replied, interested, meeting) | done |

## Where to change things

| To change | File |
|---|---|
| Scoring weights (region 40, valid email 30, person 20, trigger 10) and High/Medium thresholds | `src/lib/score.ts` |
| Which CSV column names are accepted | `src/lib/importer.ts` (`ALIASES`) |
| Brief form fields and validation | `src/lib/brief.ts`, `src/app/campaign-form.tsx` |
| Database tables | `src/lib/db.ts` |
| How many pages per site, delay between pages | `src/lib/crawl/crawl.ts` |
| Which pages count as contact pages | `src/lib/crawl/extract.ts` (`LINK_WORDS`) |
| Email labels (valid / risky / invalid) | `src/lib/crawl/verify.ts` |
| Looks | `src/app/globals.css` |

## Rules this project keeps

- Nothing is sent without approval.
- Sample data uses `.example` domains, so no real company is ever emailed by accident.
- No paid services. Free tiers and local tools only.

## Email finder rules

- Follows each site's robots.txt and skips sites that say no bots.
- Visits at most 6 pages per site and waits between requests.
- Every email keeps the page it was found on.
- Labels: valid = company domain + mail server found; risky = free provider or other domain; invalid = bad format or no mail server. No free check proves an inbox exists. Only sending shows that.

## Choosing the contact

Each email is typed: person (best), business (sales@, partnerships@), general (info@, contact@), support (support@, help@), avoid (careers@, legal@).
The contact shown for a company is the best valid one: decision-makers first, then person, business, general, support. Invalid emails are never chosen while a better one exists.
If a site blocks the crawler, use "Add an email by hand" on that company, or import a CSV row with its email: repeated companies keep their new emails.
"Download CSV" exports every company and email with its check result and the page it was found on.

## Company finder (needs a free Gemini key)

1. Get a key at aistudio.google.com (Get API key). It is free and needs no card.
2. In the project folder, create a file named `.env.local` with one line: `GEMINI_API_KEY=your-key-here` (see `.env.local.example`).
3. Restart the app. Never share the key or commit the file.

Gemini only suggests companies. The app then visits every website, and only sites that load and mention the company name are ticked for you. Without a key the rest of the app works as before.

## Writing and approving emails

"3. Write the emails" writes one email per company that has a usable address, 5 companies per Gemini request. It reads each company's own home page so the email can mention something real. If Gemini is missing, rate-limited, or writes something unsafe (links, brackets, filler), the plain template is used and the draft says "written by template".
The greeting, sign-off and the "reply no thanks" line are added by code (`src/lib/email-template.ts`), not by the AI. Open "Review and approve" to edit, approve or reject. Nothing is sent in this step.

## Live Google Sheet (optional, free, 5 minutes)

Keeps a sheet updated with every email's status (Waiting, Approved, Rejected, Sent) each time you approve, reject, edit or write emails.
1. Create a new Google Sheet. Open Extensions > Apps Script. Delete what is there and paste `google-sheet/apps-script.js`. Change `SECRET` to a private word.
2. Click Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy, allow access, copy the Web app URL.
3. In `.env.local` add `SHEET_WEBHOOK_URL=<that URL>` and `SHEET_SECRET=<your private word>`. Restart the app.
4. On the review page click "Update sheet now". The sheet fills in.
"Anyone" means anyone with the long secret URL can try to post, but the script ignores it without your secret word. The sheet itself stays private to you.

## Connect Gmail (for sending)

Uses Gmail's normal mail server with an "app password", so no Google Cloud project is needed.
1. Use a Gmail account you can afford to risk, not your main one. Turn on 2-Step Verification for it (myaccount.google.com > Security).
2. Go to myaccount.google.com/apppasswords, name it "Outreach Desk", and copy the 16-letter password.
3. In `.env.local` add `GMAIL_USER=you@gmail.com` and `GMAIL_APP_PASSWORD=the 16 letters`. Restart the app.
4. Campaign page, "4. Send": press "Send a test to myself" first.

Safety rules (all in `src/lib/sending.ts`): only approved emails; never more than the daily limit; 25 to 60 seconds between emails; never the same address twice; addresses Gmail rejects go on the do-not-email list; a login or limit error stops everything.

## Replies

"5. Replies" reads your inbox (read only, same app password) and keeps only replies to emails this app sent: matched by reply headers, the sender's address, the company's domain, or a bounce that names the address. Everything else in your inbox is ignored and never saved.
Labels come from plain rules first (`src/lib/classify.ts`), then Gemini for anything the rules cannot place, else "Unclear" and you choose. "Not interested", "Unsubscribe" and "Bounced" put the address on the do-not-email list. "Add sample replies" creates seven clearly marked fake replies (positive, question, not now, no, unsubscribe, out of office, bounce) for demos; "Remove sample replies" deletes them and undoes their effects.

## Public demo (free)

`DEMO_MODE=1` switches off everything that reaches outside the app (crawling, Gemini, sending, inbox, uploads), and `npm run seed` fills an empty database with a fictional campaign (all `.example` domains). `render.yaml` deploys it on Render's free plan. The free plan sleeps when idle (first visit takes about a minute) and its disk is reset on restart, so the seed runs again and the demo always comes back.
