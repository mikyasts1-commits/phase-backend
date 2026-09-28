/**
 * legal-docs.ts — the Phase Coin Minting Agreement as served documents.
 *
 * GET /api/v1/legal/minting-agreement.pdf
 *   The completed (final) minting agreement — the authoritative terms the
 *   app links from the Sign & Mint page ("View terms and conditions").
 *
 * GET /api/v1/legal/minting-agreement/signed/:signatureId.pdf
 *   The same agreement with the Article 20 signature block auto-populated
 *   from the signature record: printed legal name, category X
 *   (Individual / Entity), electronic signature (the typed legal name —
 *   the agreement provides that typing it in the app counts as signing),
 *   entity title, and signing date. This is the copy shown in the app's
 *   Documentation & Compliance section after issuance.
 *
 * The signatureId is an unguessable UUID minted at sign time; that is the
 * access control for the personalized copy (same pattern as the app's
 * other per-record URLs).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getIssuanceStore } from "./issuance.js";

const here = dirname(fileURLToPath(import.meta.url));
const AGREEMENT_PDF_PATH = join(here, "legal", "phase-minting-agreement.pdf");

// Article 20 signature block geometry, measured from the source PDF.
// Page 10 (index 9), 612x792pt, PyMuPDF origin top-left. pdf-lib draws
// from bottom-left, so yPdf = 792 - yTop - ascent.
const SIGN_PAGE_INDEX = 9;
const PAGE_H = 792;
const G = {
  namePrint: { x: 152, yTop: 146.4 },   // "Legal name (print): ____"
  catIndBox: { x: 100.3, yTop: 175.7 },  // "( ) Individual" parens
  catEntBox: { x: 236.5, yTop: 175.7 },  // "( ) Entity" parens
  signature: { x: 108, yTop: 205.7 },    // "Signature: ____"
  title: { x: 159, yTop: 249.9 },        // "Title (Entity Issuers): ____"
  date: { x: 83, yTop: 279.9 },          // "Date: ____"
};
const yPdf = (yTop: number, size: number) => PAGE_H - yTop - size * 0.82;
const INK = rgb(0.08, 0.16, 0.28); // dark ink-blue, reads as pen on the form

function basePdfBytes(): Buffer {
  if (!existsSync(AGREEMENT_PDF_PATH)) {
    throw new Error("minting agreement PDF not found on server");
  }
  return readFileSync(AGREEMENT_PDF_PATH);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// Rendered signed copies, keyed by signatureId (the inputs never change).
const signedCache = new Map<string, Buffer>();

async function renderSignedPdf(signatureId: string): Promise<Buffer> {
  const hit = signedCache.get(signatureId);
  if (hit) return hit;

  const store = await getIssuanceStore();
  const sig = await store.getSignatureById(signatureId);
  if (!sig) {
    const e = new Error("signature not found") as Error & { statusCode?: number; code?: string };
    e.statusCode = 404; e.code = "signature_not_found";
    throw e;
  }

  const doc = await PDFDocument.load(basePdfBytes());
  const page = doc.getPages()[SIGN_PAGE_INDEX];
  if (!page) throw new Error("agreement PDF is missing its signature page");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const name = sig.legalName.trim();
  const isEntity = (sig.issuerCategory || "individual").toLowerCase() === "entity";
  const dateStr = formatDate(sig.signedAt);

  // Printed legal name on its underline.
  page.drawText(name, { x: G.namePrint.x, y: yPdf(G.namePrint.yTop, 11), size: 11, font, color: INK });
  // Category X in the chosen parens.
  const box = isEntity ? G.catEntBox : G.catIndBox;
  page.drawText("X", { x: box.x + 4, y: yPdf(box.yTop, 12), size: 12, font: bold, color: INK });
  // Electronic signature = the typed legal name (per §19.7 / the form note).
  page.drawText(name, { x: G.signature.x, y: yPdf(G.signature.yTop, 11), size: 11, font, color: INK });
  // Entity title, when provided.
  if (isEntity && sig.title) {
    page.drawText(sig.title, { x: G.title.x, y: yPdf(G.title.yTop, 11), size: 11, font, color: INK });
  }
  // Signing date.
  page.drawText(dateStr, { x: G.date.x, y: yPdf(G.date.yTop, 11), size: 11, font, color: INK });

  const bytes = Buffer.from(await doc.save());
  signedCache.set(signatureId, bytes);
  return bytes;
}

export interface LegalDocsMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
}

export function mountLegalDocsRoutes(deps: LegalDocsMountDeps): void {
  const { route } = deps;

  route("GET", "/api/v1/legal/minting-agreement.pdf", async (ctx) => {
    try {
      const pdf = basePdfBytes();
      ctx.res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": pdf.length,
        "Content-Disposition": 'inline; filename="phase-minting-agreement.pdf"',
        "Cache-Control": "public, max-age=3600",
      });
      ctx.res.end(pdf);
    } catch (err) {
      ctx.res.writeHead(500, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({ error: "agreement_unavailable" }));
    }
  });

  route("GET", "/api/v1/legal/minting-agreement/signed/:signatureId.pdf", async (ctx) => {
    try {
      const signatureId = String(ctx.params?.signatureId || "");
      if (!signatureId) throw Object.assign(new Error("missing id"), { statusCode: 400, code: "missing_id" });
      const pdf = await renderSignedPdf(signatureId);
      ctx.res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": pdf.length,
        "Content-Disposition": `inline; filename="phase-minting-agreement-signed.pdf"`,
        "Cache-Control": "private, max-age=86400",
      });
      ctx.res.end(pdf);
    } catch (err: any) {
      const status = err.statusCode || 500;
      ctx.res.writeHead(status, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({ error: err.code || "render_failed", message: err.message }));
    }
  });
}

/** Test hook: render a signed copy without HTTP. */
export async function renderSignedAgreementPdf(signatureId: string): Promise<Buffer> {
  return renderSignedPdf(signatureId);
}
