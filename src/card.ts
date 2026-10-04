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
}): Promise<Buffer> {
  const hasFont = await ensureFont();
  const svg = buildCardSvg({
    title: config.cardTitle,
    symbol: p.symbol,
    multiplier: p.multiplier,
    pnl: p.pnl,
    profit: p.profit,
    example: p.example,
    coinImage: await loadCoinImage(p.image),
    character: loadCharacter(),
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1920 },
    font: hasFont
      ? { fontFiles: [fontPath()], loadSystemFonts: false, defaultFontFamily: "Poppins" }
      : { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}
