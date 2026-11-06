/*
  Talks to Google's free Gemini API. The key lives in a private file on your computer (.env.local),
  never in the code and never sent anywhere except to Google.

  If this ever stops working, the rest of the app still works: Gemini is only used to suggest companies
  (and, later, to help write emails with a template as the fallback).
*/
export type GeminiErrorKind = "no_key" | "auth" | "quota" | "unavailable" | "bad_response";

export class GeminiError extends Error {
  constructor(message: string, public kind: GeminiErrorKind) {
    super(message);
  }
}

export interface GeminiDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  model?: string;
}

export const hasGeminiKey = () => !!process.env.GEMINI_API_KEY?.trim();

export async function geminiJson<T>(prompt: string, schema: object, deps: GeminiDeps = {}): Promise<T> {
  const key = (deps.apiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (!key) throw new GeminiError("No Gemini key found. Add GEMINI_API_KEY to the .env.local file and restart the app.", "no_key");
  const model = deps.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const doFetch = deps.fetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
      }),
    });
  } catch {
    throw new GeminiError("Could not reach Gemini. Check your internet connection and try again.", "unavailable");
  }

  if (res.status === 429) throw new GeminiError("Gemini's free limit is used up for now. Wait a minute (or until tomorrow if it keeps happening) and try again.", "quota");
  if (res.status === 401 || res.status === 403) throw new GeminiError("Gemini rejected the key. Check the key in .env.local.", "auth");
  if (res.status === 400) {
    const body = await res.text().catch(() => "");
    if (/api key/i.test(body)) throw new GeminiError("Gemini says the key is not valid. Check the key in .env.local.", "auth");
    throw new GeminiError("Gemini could not handle that request.", "bad_response");
  }
  if (!res.ok) throw new GeminiError(`Gemini is having trouble (status ${res.status}). Try again in a minute.`, "unavailable");

  const data = (await res.json().catch(() => null)) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as T;
  } catch {
    throw new GeminiError("Gemini's answer was not in the expected format. Try again.", "bad_response");
  }
}
