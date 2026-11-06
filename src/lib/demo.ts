/*
  Demo mode (set DEMO_MODE=1 on a public website).
  Anything that reaches outside the app is switched off: visiting company websites, calling Gemini,
  sending email, reading an inbox, uploading lists. Everything a visitor can click is safe, and all data is fictional.
*/
export const isDemo = () => process.env.DEMO_MODE === "1";
export const DEMO_MESSAGE = "This is a public demo, so crawling, AI calls and sending are switched off. Run it on your own computer to use them.";
