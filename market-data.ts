/**
 * ============================================================================
 *  PHASE PROTOCOL — Live Market Data (Finnhub)
 * ============================================================================
 *
 *  Real-price layer for the Phase backend. Fetches live quotes from Finnhub
 *  (free tier: 60 calls/min, real-time US quotes) and degrades gracefully:
 *
 *    - API key present  -> live quotes, cached 60s, upstream calls spaced
 *                          >=1.2s apart to stay inside the free-tier limit.
 *    - Key missing       -> every response is labelled source:"mock" so the
 *                          app can show an honest "simulated price" label.
 *    - Feed error        -> last cached price is served with stale:true
 *                          instead of failing the request.
 *
 *  The key is read from the FINNHUB_API_KEY environment variable at call
 *  time — it is never written to a file. In production this comes from the
 *  platform's secret manager.
 *
 *  Zero npm dependencies: uses the global fetch available in Node >= 18.
 */

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const CACHE_TTL_MS = 60_000; // serve live quotes from cache for 60s
const MIN_UPSTREAM_GAP_MS = 1_200; // free tier = 60 calls/min -> stay under it

export type PriceSource = "finnhub-live" | "mock";

export interface QuoteResult {
  symbol: string;
  /** Null when no live price is available and nothing is cached. */
  price: number | null;
  currency: string;
  source: PriceSource;
  /** True when the price is older than the cache TTL or is a mock fallback. */
  stale: boolean;
  /** Epoch ms of the price being returned. */
  fetchedAt: number;
  note?: string;
}

export interface BtcRate {
  usdPerBtc: number;
  source: PriceSource;
  fetchedAt: number;
  stale: boolean;
}

/** Last-resort fallback so BTC conversion never divides by zero. */
const MOCK_USD_PER_BTC = 97_000;

interface CacheEntry {
  price: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

// --- Upstream serialization: at most one Finnhub call per MIN_UPSTREAM_GAP_MS
let upstreamQueue: Promise<unknown> = Promise.resolve();
let lastUpstreamAt = 0;

function scheduleUpstream<T>(fn: () => Promise<T>): Promise<T> {
  const run = upstreamQueue.then(async () => {
    const wait = MIN_UPSTREAM_GAP_MS - (Date.now() - lastUpstreamAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastUpstreamAt = Date.now();
    }
  });
  // Keep the queue alive even if a single call fails.
  upstreamQueue = run.catch(() => undefined);
  return run;
}

function apiKey(): string | null {
  const key = (process.env.FINNHUB_API_KEY ?? "").trim();
  return key.length > 0 ? key : null;
}

async function fetchFinnhubQuote(symbol: string): Promise<number> {
  const key = apiKey();
  if (!key) throw new Error("no_api_key");
  const url = `${FINNHUB_BASE}/quote?${new URLSearchParams({ symbol, token: key })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`finnhub_http_${res.status}`);
  const data = (await res.json()) as { c?: unknown };
  if (typeof data.c !== "number" || !(data.c > 0)) throw new Error("finnhub_empty_quote");
  return data.c;
}

/**
 * Live quote for any Finnhub symbol ("AAPL", "BINANCE:BTCUSDT", ...).
 * Never throws for feed problems — the result carries source/stale/note.
 */
export async function getQuote(rawSymbol: string): Promise<QuoteResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const now = Date.now();
  const cached = cache.get(symbol);

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      symbol,
      price: cached.price,
      currency: "USD",
      source: "finnhub-live",
      stale: false,
      fetchedAt: cached.fetchedAt,
    };
  }

  if (!apiKey()) {
    if (cached) {
      return {
        symbol,
        price: cached.price,
        currency: "USD",
        source: "finnhub-live",
        stale: true,
        fetchedAt: cached.fetchedAt,
        note: "FINNHUB_API_KEY not set — showing last cached price",
      };
    }
    return {
      symbol,
      price: null,
      currency: "USD",
      source: "mock",
      stale: true,
      fetchedAt: now,
      note: "FINNHUB_API_KEY not set — no live price available",
    };
  }

  try {
    const price = await scheduleUpstream(() => fetchFinnhubQuote(symbol));
    const fetchedAt = Date.now();
    cache.set(symbol, { price, fetchedAt });
    return { symbol, price, currency: "USD", source: "finnhub-live", stale: false, fetchedAt };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (cached) {
      return {
        symbol,
        price: cached.price,
        currency: "USD",
        source: "finnhub-live",
        stale: true,
        fetchedAt: cached.fetchedAt,
        note: `feed error (${reason}) — showing last cached price`,
      };
    }
    return {
      symbol,
      price: null,
      currency: "USD",
      source: "mock",
      stale: true,
      fetchedAt: now,
      note: `feed error (${reason})`,
    };
  }
}

/** USD-per-BTC rate for the portfolio valuation's BTC denomination leg. */
export async function getUsdPerBtc(): Promise<BtcRate> {
  const q = await getQuote("BINANCE:BTCUSDT");
  if (q.price !== null && q.price > 0) {
    return { usdPerBtc: q.price, source: q.source, fetchedAt: q.fetchedAt, stale: q.stale };
  }
  return { usdPerBtc: MOCK_USD_PER_BTC, source: "mock", fetchedAt: Date.now(), stale: true };
}

/** Feed health for the /api/v1/market/status endpoint. */
export function getFeedStatus(): {
  provider: string;
  configured: boolean;
  cacheEntries: number;
  cacheTtlMs: number;
  symbols: string[];
} {
  return {
    provider: "finnhub",
    configured: apiKey() !== null,
    cacheEntries: cache.size,
    cacheTtlMs: CACHE_TTL_MS,
    symbols: [...cache.keys()],
  };
}
