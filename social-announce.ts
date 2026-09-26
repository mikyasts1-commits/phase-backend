/**
 * Social announcement engine for Phase Go Live.
 *
 * When a user launches their coin, one tap announces it across all
 * connected social accounts (TikTok, Instagram). Generates a branded
 * launch card image, posts it with caption, tracks results.
 *
 * Flow:
 *  1. POST /api/v1/social/announce { userId, coinName, ticker }
 *  2. Generate launch card PNG (1080x1080)
 *  3. Host it at a public URL (backend serves /social/cards/:id.png)
 *  4. Post to each connected provider in parallel
 *  5. Return per-provider results
 */

import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { decryptToken } from "./social-auth.js";

interface RouteCtx {
  route(
    method: string,
    path: string,
    handler: (ctx: {
      req: Request;
      url: URL;
      params: Record<string, string>;
      body: unknown;
    }) => Promise<unknown>
  ): void;
  sendJson(data: unknown, status?: number): Response;
  HttpError: new (status: number, code: string, message: string) => Error;
}

// In-memory card store (use S3/R2 in production)
const cardStore = new Map<string, Buffer>();

// In-memory announcement log
const announcementLog: any[] = [];

/**
 * Generate a branded coin launch card (1080x1080 PNG).
 */
export async function generateLaunchCard(coinName: string, ticker: string, isMeme: boolean): Promise<Buffer> {
  const bg = isMeme ? "#1a0b2e" : "#0c4a6e";
  const accent = isMeme ? "#a855f7" : "#0ea5e9";
  const badge = isMeme ? "MEME COIN" : "ISSUER COVENANT SIGNED";

  const svg = `
  <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${bg}"/>
        <stop offset="100%" stop-color="#020617"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="40%" r="60%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1080" height="1080" fill="url(#bg)"/>
    <rect width="1080" height="1080" fill="url(#glow)"/>

    <!-- Phi mark -->
    <text x="540" y="380" text-anchor="middle" font-family="Georgia, serif"
          font-size="220" fill="${accent}" opacity="0.9">Φ</text>

    <!-- Ticker -->
    <text x="540" y="560" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
          font-size="110" font-weight="bold" fill="#ffffff" letter-spacing="8">$${ticker}</text>

    <!-- Coin name -->
    <text x="540" y="640" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
          font-size="52" fill="#cbd5e1">${escapeXml(coinName)}</text>

    <!-- Badge -->
    <rect x="290" y="700" width="500" height="56" rx="28" fill="none"
          stroke="${accent}" stroke-width="2" opacity="0.8"/>
    <text x="540" y="737" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
          font-size="28" font-weight="bold" fill="${accent}" letter-spacing="4">${badge}</text>

    <!-- Footer -->
    <text x="540" y="920" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
          font-size="36" fill="#94a3b8">Now live on Phase</text>
    <text x="540" y="970" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
          font-size="28" fill="#64748b">Everyone gets their own blockchain</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Post a photo to Instagram (business/creator account) via Graph API.
 */
async function postToInstagram(accessToken: string, igUserId: string, imageUrl: string, caption: string) {
  // Step 1: Create media container
  const createRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: accessToken }),
    }
  );
  const createData = await createRes.json() as any;
  if (!createRes.ok) throw new Error(`IG media create failed: ${createData.error?.message || createRes.status}`);
  const containerId = createData.id;

  // Step 2: Publish
  const pubRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
    }
  );
  const pubData = await pubRes.json() as any;
  if (!pubRes.ok) throw new Error(`IG publish failed: ${pubData.error?.message || pubRes.status}`);
  return { postId: pubData.id };
}

/**
 * Post a photo to TikTok via Content Posting API (DIRECT_POST).
 * Requires video.publish scope + app audit for public posts.
 */
async function postToTikTok(accessToken: string, imageUrl: string, caption: string) {
  // TikTok photo posts use the content/init endpoint with PHOTO mode
  const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      post_info: { title: caption, privacy_level: "PUBLIC_TO_EVERYONE" },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [imageUrl] },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    }),
  });
  const initData = await initRes.json() as any;
  if (!initRes.ok || initData.error?.code !== "ok") {
    throw new Error(`TikTok post init failed: ${initData.error?.message || initRes.status}`);
  }
  return { publishId: initData.data?.publish_id };
}

// ---------------------------------------------------------------------------
// Store interface (mirrors social-auth.ts pattern)
// ---------------------------------------------------------------------------

interface AnnounceStore {
  getConnectionTokens(userId: string, provider: string): Promise<{ accessToken: string; providerUserId: string } | null>;
  listConnections(userId: string): Promise<{ provider: string }[]>;
  logAnnouncement(entry: any): Promise<void>;
}

class MemoryAnnounceStore implements AnnounceStore {
  // In production, wire this to the same Postgres tables as social-auth.ts
  async getConnectionTokens() { return null; }
  async listConnections() { return []; }
  async logAnnouncement(entry: any) { announcementLog.push(entry); }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountAnnounceRoutes(deps: RouteCtx, store?: AnnounceStore) {
  const { route, sendJson, HttpError } = deps;
  const db: AnnounceStore = store || new MemoryAnnounceStore();

  // Serve generated launch cards (public URL for social APIs to pull from)
  route("GET", "/api/v1/social/cards/:cardId.png", async (ctx) => {
    const buf = cardStore.get(ctx.params.cardId);
    if (!buf) throw new HttpError(404, "card_not_found", "Launch card not found");
    return new Response(buf as any, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    });
  });

  // Generate a preview card (for the app to show before posting)
  route("POST", "/api/v1/social/cards/preview", async (ctx) => {
    const body = (ctx.body || {}) as { coinName?: string; ticker?: string; meme?: boolean };
    if (!body.coinName || !body.ticker) throw new HttpError(400, "missing_fields", "coinName and ticker required");
    const cardId = `card_${randomBytes(8).toString("hex")}`;
    const png = await generateLaunchCard(body.coinName, body.ticker, !!body.meme);
    cardStore.set(cardId, png);
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://phase-backend.onrender.com";
    return sendJson({ cardId, cardUrl: `${baseUrl}/api/v1/social/cards/${cardId}.png` });
  });

  // Announce a coin launch across all connected socials
  route("POST", "/api/v1/social/announce", async (ctx) => {
    const body = (ctx.body || {}) as {
      userId?: string; coinName?: string; ticker?: string; meme?: boolean; cardId?: string;
    };
    if (!body.userId || !body.coinName || !body.ticker) {
      throw new HttpError(400, "missing_fields", "userId, coinName, and ticker required");
    }

    // Generate or reuse the launch card
    let cardId = body.cardId;
    if (!cardId || !cardStore.has(cardId)) {
      cardId = `card_${randomBytes(8).toString("hex")}`;
      cardStore.set(cardId, await generateLaunchCard(body.coinName, body.ticker, !!body.meme));
    }
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://phase-backend.onrender.com";
    const cardUrl = `${baseUrl}/api/v1/social/cards/${cardId}.png`;

    const caption = body.meme
      ? `I just launched $${body.ticker} (${body.coinName}) on Phase — no promises, just vibes. Everyone gets their own blockchain.`
      : `I just launched $${body.ticker} (${body.coinName}) on Phase — backed by a signed issuer covenant. Everyone gets their own blockchain.`;

    const connections = await db.listConnections(body.userId);
    const results: Record<string, any> = {};

    await Promise.all(connections.map(async ({ provider }) => {
      try {
        const tokens = await db.getConnectionTokens(body.userId!, provider);
        if (!tokens) {
          results[provider] = { ok: false, error: "no_tokens" };
          return;
        }
        const accessToken = decryptToken(tokens.accessToken);
        if (provider === "instagram") {
          const r = await postToInstagram(accessToken, tokens.providerUserId, cardUrl, caption);
          results[provider] = { ok: true, ...r };
        } else if (provider === "tiktok") {
          const r = await postToTikTok(accessToken, cardUrl, caption);
          results[provider] = { ok: true, ...r };
        } else {
          results[provider] = { ok: false, error: "announce_not_supported" };
        }
      } catch (e: any) {
        results[provider] = { ok: false, error: e.message };
      }
    }));

    await db.logAnnouncement({
      id: `ann_${randomBytes(8).toString("hex")}`,
      userId: body.userId,
      coinName: body.coinName,
      ticker: body.ticker,
      cardId,
      results,
      createdAt: new Date().toISOString(),
    });

    return sendJson({ announced: true, cardUrl, caption, results });
  });

  // Announcement history
  route("GET", "/api/v1/social/announcements", async (ctx) => {
    const userId = ctx.url.searchParams.get("userId");
    const mine = userId ? announcementLog.filter((a) => a.userId === userId) : announcementLog;
    return sendJson({ announcements: mine.slice(-20).reverse() });
  });
}
