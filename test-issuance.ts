/**
 * Hermetic unit tests for the issuance API (draft/sign/mint validation).
 * No Postgres (DATABASE_URL unset -> in-memory store), no Solana network:
 * the mint route's on-chain call is NOT exercised here — mint validation
 * (422 paths) is. Live minting is verified separately against devnet.
 * Run with: npx tsx test-issuance.ts
 */
delete process.env.DATABASE_URL;

const { mountIssuanceRoutes, renderAgreementText, sha256Hex } = await import("./issuance.js");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// --- tiny fake router -------------------------------------------------------
type Handler = (ctx: any) => void | Promise<void>;
const routes: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: Handler }> = [];
function compilePath(path: string) {
  const paramNames: string[] = [];
  const patternStr = path.split("/").map((seg) => {
    if (seg.startsWith(":")) { paramNames.push(seg.slice(1)); return "([^/]+)"; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { pattern: new RegExp(`^${patternStr}$`), paramNames };
}
class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
function sendJson(res: any, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.body = body;
}
mountIssuanceRoutes({
  route: (m: string, p: string, h: Handler) => routes.push({ method: m, ...compilePath(p), handler: h }),
  sendJson,
  HttpError: HttpError as any,
});

async function call(method: string, path: string, opts: { query?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const url = new URL("http://x" + path + (opts.query ? "?" + opts.query : ""));
  const r = routes.find((rt) => rt.method === method && rt.pattern.test(url.pathname));
  if (!r) throw new Error(`no route ${method} ${path}`);
  const m = url.pathname.match(r.pattern)!;
  const params: Record<string, string> = {};
  r.paramNames.forEach((n, i) => { params[n] = m[i + 1]; });
  const res: any = {};
  await r.handler({
    req: { headers: opts.headers ?? {} },
    res,
    params,
    query: url.searchParams,
    body: opts.body ?? {},
  });
  return res as { statusCode: number; body: any };
}

const UID = "user-test-1";

// --- 1. draft validation ----------------------------------------------------
let res = await call("POST", "/api/v1/issuance/draft", { body: { userId: UID, name: "MyCoin", ticker: "mycoin" } });
check("draft created (ticker normalized)", res.statusCode === 201 && res.body.draft.ticker === "MYCOIN", JSON.stringify(res.body).slice(0, 120));
const draftId = res.body.draftId;

res = await call("POST", "/api/v1/issuance/draft", { body: { userId: UID, name: "X", ticker: "bad ticker!" } });
check("bad ticker -> 422", res.statusCode === 422 && res.body.error === "invalid_ticker");

res = await call("POST", "/api/v1/issuance/draft", {
  body: { userId: UID, name: "X", ticker: "OK2", equityPublic: 70, equityRetained: 40 },
});
check("split != 100 -> 422", res.statusCode === 422 && res.body.error === "invalid_split");

res = await call("POST", "/api/v1/issuance/draft", { body: { userId: UID, name: "", ticker: "OK2" } });
check("empty name -> 422", res.statusCode === 422 && res.body.error === "invalid_name");

res = await call("POST", "/api/v1/issuance/draft", { body: { name: "X", ticker: "OK2" } });
check("missing userId -> 400", res.statusCode === 400 && res.body.error === "missing_user_id");

// --- 2. agreement ------------------------------------------------------------
res = await call("GET", "/api/v1/issuance/agreement", { query: `draftId=${draftId}` });
check("agreement renders with coin name", res.statusCode === 200 && res.body.agreementText.includes("MyCoin"));
check("agreement hash matches recompute",
  res.body.agreementHash === sha256Hex(res.body.agreementText));
check("template notice present", res.body.templateNote.includes("TEMPLATE ONLY"));

res = await call("GET", "/api/v1/issuance/agreement", { query: "draftId=nope" });
check("unknown draft -> 404", res.statusCode === 404);

// --- 3. sign validation -------------------------------------------------------
res = await call("POST", "/api/v1/issuance/sign", {
  body: { userId: UID, draftId, legalName: "  ", accepted: true },
});
check("blank legalName -> 422", res.statusCode === 422 && res.body.error === "invalid_legal_name");

res = await call("POST", "/api/v1/issuance/sign", {
  body: { userId: UID, draftId, legalName: "Mikyas Tesema", accepted: false },
});
check("accepted!==true -> 422", res.statusCode === 422 && res.body.error === "not_accepted");

res = await call("POST", "/api/v1/issuance/sign", {
  body: { userId: "someone-else", draftId, legalName: "Eve", accepted: true },
});
check("wrong user -> 403", res.statusCode === 403);

res = await call("POST", "/api/v1/issuance/sign", {
  body: { userId: UID, draftId, legalName: "Mikyas Tesema", accepted: true },
});
check("sign ok", res.statusCode === 201 && res.body.legalName === "Mikyas Tesema"
  && typeof res.body.agreementHash === "string" && res.body.agreementHash.length === 64);

// --- 4. mint validation (no network: 422 paths only) ---------------------------
// Use a fresh unsigned draft to hit the 422 (a signed draft would proceed to
// the on-chain mint, which is verified separately against devnet).
const r2 = await call("POST", "/api/v1/issuance/draft", { body: { userId: UID, name: "Unsigned", ticker: "UNS1" } });
res = await call("POST", "/api/v1/issuance/mint", {
  body: { userId: UID, draftId: r2.body.draftId },
  headers: { "idempotency-key": "key-no-sig-2" },
});
check("mint without signature -> 422 signature_required",
  res.statusCode === 422 && res.body.error === "signature_required", JSON.stringify(res.body).slice(0, 160));

res = await call("POST", "/api/v1/issuance/mint", {
  body: { userId: UID, draftId: r2.body.draftId },
});
check("mint without idempotency key -> 400", res.statusCode === 400 && res.body.error === "missing_idempotency_key");

// --- 5. coins listing -----------------------------------------------------------
res = await call("GET", "/api/v1/issuance/coins", { query: `userId=${UID}` });
check("coins list ok (empty, nothing minted)", res.statusCode === 200 && Array.isArray(res.body.coins) && res.body.coins.length === 0);

// --- 6. renderAgreementText determinism ------------------------------------------
const t1 = renderAgreementText(res.body.coins.length === 0 ? {
  id: "d", userId: UID, name: "A", ticker: "AAA", category: "", tagline: "",
  valueThesis: "V", equityPublic: 60, equityRetained: 40, socialProfiles: [],
  status: "draft", createdAt: "", updatedAt: "",
} : null as never);
check("agreement text deterministic", t1 === renderAgreementText({
  id: "d", userId: UID, name: "A", ticker: "AAA", category: "", tagline: "",
  valueThesis: "V", equityPublic: 60, equityRetained: 40, socialProfiles: [],
  status: "draft", createdAt: "", updatedAt: "",
}));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
