import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { PublicKey } from "@solana/web3.js";
import * as sol from "./solana.js";
import { config } from "./config.js";
import { buildCardSvg, bannerSize, esc, FONT } from "./cardsvg.js";
import { FRAME_WEBP_BASE64 } from "./frameData.js";

const FONT_URL = "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf";

async function download(file: string, url: string, ms: number): Promise<string | null> {
  const f = path.join(config.dataDir, "fonts", file);
  if (fs.existsSync(f)) return f;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    return f;
  } catch {
    return null;
  }
}

export type Lang = "en" | "es" | "ru" | "zh" | "ar";
const NOTO = "https://github.com/google/fonts/raw/main/ofl";
export const LANGS: Record<Lang, { name: string; pnl: string; initial: string; font?: { file: string; url: string } }> = {
  en: { name: "English", pnl: "P&L", initial: "Initial Buy" },
  es: { name: "Español", pnl: "P&G", initial: "Compra inicial" },
  ru: { name: "Русский", pnl: "П/У", initial: "Начальная покупка", font: { file: "NotoSans.ttf", url: `${NOTO}/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf` } },
  zh: { name: "中文", pnl: "盈亏", initial: "初始买入", font: { file: "NotoSansSC.ttf", url: `${NOTO}/notosanssc/NotoSansSC%5Bwght%5D.ttf` } },
  ar: { name: "العربية", pnl: "الربح/الخسارة", initial: "الشراء الأولي", font: { file: "NotoSansArabic.ttf", url: `${NOTO}/notosansarabic/NotoSansArabic%5Bwdth%2Cwght%5D.ttf` } },
};
const settingsFile = (): string => path.join(config.dataDir, "settings.json");
export function getLang(): Lang {
  try {
    const l = (JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { lang?: string }).lang;
    return l && l in LANGS ? (l as Lang) : "en";
  } catch {
    return "en";
  }
}
export function setLang(l: Lang): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ lang: l }));
}

/** The SVG renderer only reads a few formats, so every picture is converted to PNG first (handles WebP, AVIF, GIF, JPEG...). */
async function toPngDataUri(buf: Buffer, maxWidth: number): Promise<string | undefined> {
  try {
    const out = await sharp(buf).resize({ width: maxWidth, withoutEnlargement: true }).png().toBuffer();
    return `data:image/png;base64,${out.toString("base64")}`;
  } catch (e) {
    console.error("Image convert failed:", e instanceof Error ? e.message : "unknown");
    return undefined;
  }
}

let frameUri: string | undefined;
async function getFrame(): Promise<string> {
  frameUri ??= await toPngDataUri(Buffer.from(FRAME_WEBP_BASE64, "base64"), 1000);
  return frameUri ?? `data:image/webp;base64,${FRAME_WEBP_BASE64}`;
}

// ---- IPFS gateways: metadata and pictures often sit behind a slow or blocked gateway ----
const GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
const toHttp = (u: string): string => (u.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, "")}` : u);
function variants(url: string): string[] {
  const m = /\/ipfs\/(.+)$/.exec(url);
  return m ? [url, ...GATEWAYS.map((g) => g + m[1])] : [url];
}
async function fetchAny(url: string, ms = 7000): Promise<Response | null> {
  for (const u of variants(toHttp(url))) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
      if (r.ok) return r;
    } catch {
      /* try the next gateway */
    }
  }
  return null;
}

export function setCharacter(buf: Buffer, ext: "png" | "jpg"): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const e of ["png", "jpg"]) fs.rmSync(path.join(config.dataDir, `character.${e}`), { force: true });
  fs.writeFileSync(path.join(config.dataDir, `character.${ext}`), buf);
}
export function setBackground(buf: Buffer, ext: "png" | "jpg"): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  clearBackground();
  fs.writeFileSync(path.join(config.dataDir, `background.${ext}`), buf);
}
export function clearBackground(): void {
  for (const e of ["png", "jpg"]) fs.rmSync(path.join(config.dataDir, `background.${e}`), { force: true });
}
async function loadLocal(name: string, maxWidth: number): Promise<string | undefined> {
  for (const e of ["png", "jpg"]) {
    const f = path.join(config.dataDir, `${name}.${e}`);
    if (fs.existsSync(f)) return toPngDataUri(fs.readFileSync(f), maxWidth);
  }
  return undefined;
}

async function loadCoinImage(image?: string): Promise<string | undefined> {
  if (!image) return undefined;
  try {
    if (/^(https:\/\/|ipfs:\/\/)/i.test(image)) {
      const r = await fetchAny(image);
      if (!r) {
        console.error("Coin image could not be downloaded from any gateway");
        return undefined;
      }
      return toPngDataUri(Buffer.from(await r.arrayBuffer()), 800);
    }
    const f = path.join(config.dataDir, image);
    return fs.existsSync(f) ? toPngDataUri(fs.readFileSync(f), 800) : undefined;
  } catch {
    return undefined;
  }
}

type FontOpts = { fontFiles?: string[]; loadSystemFonts?: boolean; defaultFontFamily?: string };
/** Exact rendered width of a text line, so icons can sit right next to it. */
function measure(text: string, size: number, family: string, weight: number, font: FontOpts): number | undefined {
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="500"><text x="0" y="350" font-family="${family}" font-weight="${weight}" font-size="${size}">${esc(text)}</text></svg>`;
    const b = new Resvg(svg, { font }).getBBox();
    return b ? Math.round(b.width) : undefined;
  } catch {
    return undefined;
  }
}

export async function renderCard(p: {
  symbol: string;
  image?: string;
  multiplier: string;
  pnl: string;
  profit: boolean;
  profitSol?: string;
  initialBuy?: string;
  example?: boolean;
  username?: string;
}): Promise<Buffer> {
  const L = LANGS[getLang()];
  let labels = { pnl: L.pnl, initial: L.initial };
  const fontFiles: string[] = [];
  const base = await download("Poppins-Bold.ttf", FONT_URL, 15_000);
  if (base) fontFiles.push(base);
  const bebas = await download("BebasNeue-Regular.ttf", `${NOTO}/bebasneue/BebasNeue-Regular.ttf`, 20_000);
  if (bebas) fontFiles.push(bebas);
  if (L.font) {
    const extra = await download(L.font.file, L.font.url, 90_000);
    if (extra) fontFiles.push(extra);
    else labels = { pnl: LANGS.en.pnl, initial: LANGS.en.initial }; // font unavailable: fall back to English labels
  }
  const fontOpts: FontOpts = fontFiles.length
    ? { fontFiles, loadSystemFonts: false, defaultFontFamily: "Poppins" }
    : { loadSystemFonts: true };
  const bannerWidth = p.profitSol ? measure(p.profitSol, bannerSize(p.profitSol), "'Bebas Neue', 'Poppins', sans-serif", 700, fontOpts) : undefined;
  const initWidth = p.initialBuy ? measure(`${labels.initial}: ${p.initialBuy}`, 40, FONT, 700, fontOpts) : undefined;
  const svg = buildCardSvg({
    bannerWidth,
    initWidth,
    title: config.cardTitle,
    tag: p.example ? "EXAMPLE" : config.cardLink,
    frame: await getFrame(),
    labels,
    symbol: p.symbol,
    multiplier: p.multiplier,
    pnl: p.pnl,
    profit: p.profit,
    profitSol: p.profitSol,
    initialBuy: p.initialBuy,
    username: p.username,
    coinImage: await loadCoinImage(p.image),
    character: await loadLocal("character", 1000),
    background: await loadLocal("background", 1672),
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1672 }, font: fontOpts });
  return resvg.render().asPng();
}

// ---- coin lookup: on-chain metadata first, DexScreener only as a fallback ----
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function readStr(buf: Buffer, off: number): [string, number] {
  const len = buf.readUInt32LE(off);
  return [buf.subarray(off + 4, off + 4 + len).toString("utf8").replace(/\0+$/g, "").trim(), off + 4 + len];
}

async function onChainMeta(mint: PublicKey): Promise<{ name?: string; symbol?: string; uri?: string }> {
  const parsed = await sol.withRetry(() => sol.connection.getParsedAccountInfo(mint));
  const data = parsed.value?.data as unknown as
    | { parsed?: { info?: { extensions?: { extension?: string; state?: { name?: string; symbol?: string; uri?: string } }[] } } }
    | undefined;
  const ext = data?.parsed?.info?.extensions?.find((e) => e.extension === "tokenMetadata");
  if (ext?.state) return ext.state;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM,
  );
  const acct = await sol.withRetry(() => sol.connection.getAccountInfo(pda));
  if (!acct) return {};
  let off = 65;
  let name: string;
  let symbol: string;
  let uri: string;
  [name, off] = readStr(acct.data, off);
  [symbol, off] = readStr(acct.data, off);
  [uri] = readStr(acct.data, off);
  return { name, symbol, uri };
}

export async function lookupCoin(mint: string): Promise<{ symbol?: string; image?: string }> {
  let symbol: string | undefined;
  let image: string | undefined;
  try {
    const m = await onChainMeta(new PublicKey(mint));
    symbol = m.symbol || undefined;
    if (m.uri) {
      const r = await fetchAny(m.uri);
      if (r) {
        try {
          const j = (await r.json()) as { image?: string };
          if (j.image) image = toHttp(j.image);
        } catch {
          /* metadata was not JSON */
        }
      } else {
        console.error("Coin metadata could not be downloaded from any gateway");
      }
    }
  } catch {
    /* no on-chain metadata */
  }
  if (!symbol || !image) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8_000) });
      if (r.ok) {
        const j = (await r.json()) as { pairs?: { baseToken?: { address?: string; symbol?: string }; info?: { imageUrl?: string } }[] };
        const p = j.pairs?.find((x) => x.baseToken?.address === mint) ?? j.pairs?.[0];
        symbol = symbol ?? p?.baseToken?.symbol;
        image = image ?? p?.info?.imageUrl;
      }
    } catch {
      /* optional fallback */
    }
  }
  return { symbol, image };
}
