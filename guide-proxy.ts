/**
 * guide-proxy.ts — Backend proxy for Phi, the in-app Phase guide.
 *
 * The Android app's ChatbotLauncher calls queryPhiBrain(), which today answers
 * from a scripted mock brain bundled in the app. When this module is mounted
 * and LLAMA_API_KEY is set, the app swaps one function body to POST here and
 * Phi answers from Meta's Llama API instead. Nothing else in the UI changes.
 *
 * Endpoint: POST /api/guide/chat
 *   Request:  { messages: [{ from: "user"|"phi", text }], context?: { screen?: string } }
 *   Response: { text, actions?: [{ label, tab }], suggestions?: string[], provider: "mock"|"llama" }
 *
 * Cost gate: the Llama API is pay-per-use. Do NOT set LLAMA_API_KEY / enable
 * the live path without the user's explicit approval.
 *
 * Testnet/sandbox only. Phi explains and navigates; it never moves money.
 */

type ChatMsg = { from: "user" | "phi"; text: string };
type GuideAction = { label: string; tab: "golive" | "market" | "dashboard" };

const PHI_SYSTEM_PROMPT = `You are Phi, the in-app guide for Phase — a mobile app where anyone (creators, athletes, small businesses, asset owners) can turn real-world value into investable shares ("coins").

How Phase works:
- Go Live tab: describe your value, link social profiles or business numbers, set the Sovereign Equity Split (what % of future upside you sell publicly vs. retain — always totals 100%), then sign the Issuer Agreement.
- Issuer Agreement: a contract the issuer signs for the benefit of coin purchasers (identity, accuracy of statements, rights, value sharing). In the current alpha it is a TEMPLATE for demonstration, not legal advice; counsel must review before any real offering.
- Marketplace tab: directory of listed people, businesses, assets. Filter by category dropdown or browse all.
- Dashboard tab: portfolio, holdings, cash balances, transaction history.
- Issuers can link multiple social profiles (YouTube, TikTok, X, Instagram); each renders as a clickable badge on the listing, with a simulated verification check.
- The current alpha is fully simulated: mock data, no live prices, no real money moves.

Rules:
- Be concise and warm: 1–3 sentences, plain language, no jargon dumps.
- You may suggest navigation with actions: {"label":"Open Go Live","tab":"golive"}, {"label":"Open Marketplace","tab":"market"}, {"label":"Open Dashboard","tab":"dashboard"}.
- You may include up to 3 short follow-up suggestions.
- Never promise returns, never give regulated financial advice, never claim the alpha moves real money, never claim the Issuer Agreement template is binding legal advice.
- If asked about something outside Phase, say so briefly and steer back.`;

// --- Mock brain (mirrors the app's bundled demo brain) -----------------------
function mockReply(messages: ChatMsg[]): { text: string; suggestions: string[] } {
  const last = [...messages].reverse().find((m) => m.from === "user");
  const t = (last?.text || "").toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w));
  const sug = ["How do I go live?", "How does investing work?", "What's the Issuer Agreement?"];
  if (has("go live", "onchain", "issue", "mint", "mycoin"))
    return { text: "Going live takes about two minutes: describe your value, link your social profiles or business numbers, set your Sovereign Equity Split, then sign the Issuer Agreement.", suggestions: ["What's a Sovereign Equity Split?", "What's the Issuer Agreement?"] };
  if (has("split", "equity", "stake", "sovereign"))
    return { text: "The Sovereign Equity Split decides how much of your future upside you sell publicly vs. keep — it always totals 100%, so your stake is always clear.", suggestions: sug };
  if (has("agreement", "contract", "legal", "sign"))
    return { text: "The Issuer Agreement is the contract you sign when you go live — a commitment to coin purchasers covering identity, accuracy, and value sharing. It's a template for now; counsel reviews it before any real offering.", suggestions: sug };
  if (has("invest", "buy", "purchase"))
    return { text: "The Marketplace is the directory of every listed person, business, and asset. Pick one, choose your currency, and invest. In this alpha everything is simulated.", suggestions: sug };
  return { text: "I can help with going live, the coin split, the Issuer Agreement, social profiles, or investing. What would you like to know?", suggestions: sug };
}

// --- Live Llama wiring (GO-LIVE STEP — needs LLAMA_API_KEY + user approval) ---
async function llamaReply(messages: ChatMsg[]): Promise<{ text: string; actions?: GuideAction[]; suggestions?: string[] }> {
  const apiKey = process.env.LLAMA_API_KEY;
  if (!apiKey) throw new Error("LLAMA_API_KEY not set — live guide brain is disabled.");
  // Llama API is OpenAI-compatible. Swap model id for the current default.
  const res = await fetch("https://api.llama.com/compat/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "Llama-4-Maverick-17B-128E-Instruct",
      messages: [
        { role: "system", content: PHI_SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.from === "user" ? "user" : "assistant", content: m.text })),
      ],
      // Ask for structured output so the app can render actions/suggestions.
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "phi_reply",
          schema: {
            type: "object",
            properties: {
              text: { type: "string" },
              actions: {
                type: "array",
                items: { type: "object", properties: { label: { type: "string" }, tab: { type: "string", enum: ["golive", "market", "dashboard"] } }, required: ["label", "tab"] },
              },
              suggestions: { type: "array", items: { type: "string" } },
            },
            required: ["text"],
          },
        },
      },
      max_tokens: 400,
      temperature: 0.6,
    }),
  });
  if (!res.ok) throw new Error(`Llama API error: ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content);
}

// --- Route mounting (same deps-injection style as securities.ts) -------------
type RouteHandler = (ctx: { req: unknown; res: unknown; body?: unknown }) => Promise<void>;
type MountDeps = {
  route: (method: string, path: string, handler: RouteHandler) => void;
  sendJson: (res: unknown, status: number, body: Record<string, unknown>) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
};

export function mountGuideRoutes(deps: MountDeps): void {
  const { route, sendJson, HttpError } = deps;

  // --- POST /api/guide/chat ---
  route("POST", "/api/guide/chat", async (ctx) => {
    try {
      const body = (ctx.body || {}) as { messages?: ChatMsg[] };
      const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
      if (!messages.some((m) => m.from === "user")) {
        throw new HttpError(400, "bad_request", "messages must include at least one user message");
      }
      // Live path activates the moment LLAMA_API_KEY is set (needs user approval).
      if (process.env.LLAMA_API_KEY) {
        const reply = await llamaReply(messages);
        sendJson(ctx.res, 200, { provider: "llama", ...reply });
        return;
      }
      const reply = mockReply(messages);
      sendJson(ctx.res, 200, { provider: "mock", ...reply });
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, "internal_error", err instanceof Error ? err.message : String(err));
      const statusCode = (e as { statusCode?: number }).statusCode ?? 500;
      const code = (e as { code?: number }).code ?? "internal_error";
      sendJson(ctx.res, statusCode, { provider: "guide", error: code, message: e.message });
    }
  });
}
