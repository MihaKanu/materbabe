import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PublicKey } from "@solana/web3.js";
import * as sol from "./solana.js";
import { config } from "./config.js";
import { buildCardSvg } from "./cardsvg.js";
import { FRAME_WEBP_BASE64 } from "./frameData.js";

const FONT_URL = "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf";
const fontPath = (): string => path.join(config.dataDir, "fonts", "Poppins-Bold.ttf");
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

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

const dataUri = (buf: Buffer, ext: string): string => `data:${MIME[ext] ?? "image/png"};base64,${buf.toString("base64")}`;

/** Saves the cut-out artwork shown faintly on the right of the card. */
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
function loadBackground(): string | undefined {
  for (const e of ["png", "jpg"]) {
    const f = path.join(config.dataDir, `background.${e}`);
    if (fs.existsSync(f)) return dataUri(fs.readFileSync(f), e);
  }
  return undefined;
}
function loadCharacter(): string | undefined {
  for (const e of ["png", "jpg"]) {
    const f = path.join(config.dataDir, `character.${e}`);
    if (fs.existsSync(f)) return dataUri(fs.readFileSync(f), e);
  }
  return undefined;
}

async function loadCoinImage(image?: string): Promise<string | undefined> {
  if (!image) return undefined;
  try {
    if (/^https:\/\//i.test(image)) {
      const r = await fetch(image, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return undefined;
      const buf = Buffer.from(await r.arrayBuffer());
      const mime =
        buf[0] === 0x89 ? "image/png" : buf[0] === 0xff ? "image/jpeg" : buf[0] === 0x47 ? "image/gif" : buf[0] === 0x52 ? "image/webp" : "image/png";
      return `data:${mime};base64,${buf.toString("base64")}`;
    }
    const f = path.join(config.dataDir, image);
    if (!fs.existsSync(f)) return undefined;
    return dataUri(fs.readFileSync(f), path.extname(f).slice(1).toLowerCase());
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
    frame: `data:image/webp;base64,${FRAME_WEBP_BASE64}`,
    symbol: p.symbol,
    multiplier: p.multiplier,
    pnl: p.pnl,
    profit: p.profit,
    username: p.username,
    coinImage: await loadCoinImage(p.image),
    character: loadCharacter(),
    background: loadBackground(),
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1672 },
    font: hasFont
      ? { fontFiles: [fontPath()], loadSystemFonts: false, defaultFontFamily: "Poppins" }
      : { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const gateway = (u: string): string => (u.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, "")}` : u);

function readStr(buf: Buffer, off: number): [string, number] {
  const len = buf.readUInt32LE(off);
  return [buf.subarray(off + 4, off + 4 + len).toString("utf8").replace(/\0+$/g, "").trim(), off + 4 + len];
}

/** Name/symbol/uri from the mint itself (Token-2022 metadata) or the Metaplex metadata account. */
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

/** Ticker and picture for any coin: on-chain metadata first, DexScreener only as a fallback. */
export async function lookupCoin(mint: string): Promise<{ symbol?: string; image?: string }> {
  let symbol: string | undefined;
  let image: string | undefined;
  try {
    const m = await onChainMeta(new PublicKey(mint));
    symbol = m.symbol || undefined;
    if (m.uri) {
      try {
        const r = await fetch(gateway(m.uri), { signal: AbortSignal.timeout(8_000) });
        if (r.ok) {
          const j = (await r.json()) as { image?: string };
          if (j.image) image = gateway(j.image);
        }
      } catch {
        /* metadata host unreachable */
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
