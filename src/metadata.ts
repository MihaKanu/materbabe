import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Telegram } from "telegraf";
import { config } from "./config.js";

export const metaDir = (): string => path.join(config.dataDir, "meta");

export function baseUrl(): string {
  if (!config.publicUrl) throw new Error("PUBLIC_URL is not set, so metadata cannot be hosted by this bot.");
  return config.publicUrl;
}

export interface MetaInput {
  name: string;
  symbol: string;
  description: string;
  imageUrl?: string;
  imageFileId?: string;
  twitter?: string;
  website?: string;
}

/** Saves metadata JSON (and an uploaded image) on this server and returns its public URI. */
export async function save(m: MetaInput, tg: Telegram): Promise<string> {
  const base = baseUrl();
  const id = randomBytes(8).toString("hex");
  fs.mkdirSync(metaDir(), { recursive: true });
  let image = m.imageUrl;
  if (m.imageFileId) {
    const link = await tg.getFileLink(m.imageFileId);
    const res = await fetch(link.href);
    if (!res.ok) throw new Error("Could not download the image");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5_000_000) throw new Error("Image is larger than 5 MB");
    let ext = path.extname(link.pathname).slice(1).toLowerCase();
    if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) ext = "jpg";
    fs.writeFileSync(path.join(metaDir(), `${id}.${ext}`), buf);
    image = `${base}/img/${id}.${ext}`;
  }
  const json: Record<string, unknown> = {
    name: m.name,
    symbol: m.symbol,
    description: m.description,
    showName: true,
  };
  if (image) json.image = image;
  if (m.twitter) json.twitter = m.twitter;
  if (m.website) json.website = m.website;
  fs.writeFileSync(path.join(metaDir(), `${id}.json`), JSON.stringify(json));
  return `${base}/meta/${id}.json`;
}
