import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { PublicKey } from "@solana/web3.js";
import * as sol from "./solana.js";
import { config } from "./config.js";
import { buildCardSvg } from "./cardsvg.js";
import { FRAME_WEBP_BASE64 } from "./frameData.js";

const FONT_URL = "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf";
const fontPath = (): string => path.join(config.dataDir, "fonts", "Poppins-Bold.ttf");

async function ensureFont(): Promise<boolean> {
  const f = fontPath();
  if (fs.existsSync(f)) return true;
  try {
    const r = await fetch(FONT_URL, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return false;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
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

export async function renderCard(p: {
  symbol: string;
  image?: string;
  multiplier: string;
  pnl: string;
  profit: boolean;
  example?: boolean;
  username?: string;
}): Promise<Buffer> {
  const hasFont = await ensureFont();
  const svg = buildCardSvg({
    title: config.cardTitle,
    tag: p.example ? "EXAMPLE" : config.cardLink,
    frame: await getFrame(),
    symbol: p.symbol,
    multiplier: p.multiplier,
    pnl: p.pnl,
    profit: p.profit,
    username: p.username,
    coinImage: await loadCoinImage(p.image),
    character: await loadLocal("character", 1000),
    background: await loadLocal("background", 1672),
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1672 },
    font: hasFont
      ? { fontFiles: [fontPath()], loadSystemFonts: false, defaultFontFamily: "Poppins" }
      : { loadSystemFonts: true },
  });
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
