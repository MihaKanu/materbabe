import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { config } from "./config.js";
import { buildCardSvg } from "./cardsvg.js";

const FONT_URL = "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Medium.ttf";
const fontPath = (): string => path.join(config.dataDir, "fonts", "Poppins-Medium.ttf");
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
      const ct = r.headers.get("content-type") ?? "image/png";
      return `data:${ct.split(";")[0]};base64,${buf.toString("base64")}`;
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
    symbol: p.symbol,
    multiplier: p.multiplier,
    pnl: p.pnl,
    profit: p.profit,
    example: p.example,
    username: p.username,
    coinImage: await loadCoinImage(p.image),
    character: loadCharacter(),
    background: loadBackground(),
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1920 },
    font: hasFont
      ? { fontFiles: [fontPath()], loadSystemFonts: false, defaultFontFamily: "Poppins" }
      : { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

/** Ticker and picture for coins the bot did not create, from DexScreener's public API. */
export async function lookupCoin(mint: string): Promise<{ symbol?: string; image?: string }> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return {};
    const j = (await r.json()) as {
      pairs?: { baseToken?: { address?: string; symbol?: string }; info?: { imageUrl?: string } }[];
    };
    const p = j.pairs?.find((x) => x.baseToken?.address === mint) ?? j.pairs?.[0];
    return { symbol: p?.baseToken?.symbol, image: p?.info?.imageUrl };
  } catch {
    return {};
  }
}
