import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import bs58 from "bs58";
import { config } from "./config.js";
import * as store from "./store.js";
import * as access from "./access.js";

/** Encrypted portfolio backup (.tpf): gzip + AES-256-GCM, key from a passphrase the owner chooses. */
const MAGIC = Buffer.from("TPF1");
const MAX_FILES_BYTES = 12_000_000; // bots can only download 20 MB files

export interface Portfolio {
  v: 1;
  at: string;
  masterPublic: string;
  masterSecret: string;
  storeKey: string;
  registry: store.StoreData;
  secrets: Record<string, string>;
  access: access.AccessDb;
  settings: string;
  disclosure: string;
  buyers: string;
  files: Record<string, string>;
}

const readText = (rel: string): string => {
  const f = path.join(config.dataDir, rel);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};

function collectFiles(): { files: Record<string, string>; skipped: number } {
  const files: Record<string, string> = {};
  let total = 0;
  let skipped = 0;
  const add = (rel: string): void => {
    const f = path.join(config.dataDir, rel);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return;
    const b = fs.readFileSync(f);
    if (total + b.length > MAX_FILES_BYTES) {
      skipped++;
      return;
    }
    total += b.length;
    files[rel] = b.toString("base64");
  };
  if (fs.existsSync(config.dataDir)) {
    for (const n of fs.readdirSync(config.dataDir)) if (/^(character|background)\.(png|jpg)$/.test(n)) add(n);
  }
  const md = path.join(config.dataDir, "meta");
  if (fs.existsSync(md)) for (const n of fs.readdirSync(md)) add(path.join("meta", n));
  return { files, skipped };
}

function buildFull(passphrase: string): { buf: Buffer; skipped: number; summary: string } {
  if (passphrase.length < 8) throw new Error("The password must be at least 8 characters.");
  const { registry, secrets } = store.exportAll();
  const { files, skipped } = collectFiles();
  const payload: Portfolio = {
    v: 1,
    at: new Date().toISOString(),
    masterPublic: config.master.publicKey.toBase58(),
    masterSecret: bs58.encode(config.master.secretKey),
    storeKey: config.storeKey,
    registry,
    secrets,
    access: access.exportDb(),
    settings: readText("settings.json"),
    disclosure: readText("disclosure.jsonl"),
    buyers: readText("buyers.txt"),
    files,
  };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  return {
    buf: Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]),
    skipped,
    summary: `${registry.wallets.length} wallets, ${registry.coins.length} coins, ${Object.keys(files).length} files`,
  };
}

export function open(buf: Buffer, passphrase: string): Portfolio {
  if (buf.length < 48 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("This is not a Total portfolio file.");
  try {
    const d = createDecipheriv("aes-256-gcm", scryptSync(passphrase, buf.subarray(4, 20), 32), buf.subarray(20, 32));
    d.setAuthTag(buf.subarray(32, 48));
    const gz = Buffer.concat([d.update(buf.subarray(48)), d.final()]);
    return JSON.parse(zlib.gunzipSync(gz).toString("utf8")) as Portfolio;
  } catch {
    throw new Error("Wrong passphrase or damaged file.");
  }
}

export function describe(p: Portfolio): string {
  const w = p.registry.wallets;
  const same = p.masterPublic === config.master.publicKey.toBase58();
  return `Saved: ${p.at.slice(0, 16).replace("T", " ")}\nWallets: ${w.filter((x) => x.group === "treasury").length} treasury, ${w.filter((x) => x.group === "chusi").length} Chusi\nCoins: ${p.registry.coins.length}\nMembers: ${Object.keys(p.access.accepted ?? {}).length}\nFiles: ${Object.keys(p.files).length}\nMaster wallet: ${same ? "matches this bot" : `DIFFERENT (${p.masterPublic.slice(0, 4)}...${p.masterPublic.slice(-4)}). Set MASTER_SECRET to the saved one to use it`}`;
}

/** Replaces the wallet list/coins; merges access records so no used key is ever re-enabled. */
export function apply(p: Portfolio): string {
  const reg = path.join(config.dataDir, "registry.json");
  if (fs.existsSync(reg)) fs.copyFileSync(reg, path.join(config.dataDir, "registry.before-restore.json"));
  store.importAll(p.registry, p.secrets);
  access.importDb(p.access);
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (p.settings) fs.writeFileSync(path.join(config.dataDir, "settings.json"), p.settings);
  for (const [name, text] of [["disclosure.jsonl", p.disclosure], ["buyers.txt", p.buyers]] as const) {
    if (text.length > readText(name).length) fs.writeFileSync(path.join(config.dataDir, name), text);
  }
  for (const [rel, b64] of Object.entries(p.files)) {
    const f = path.join(config.dataDir, rel);
    if (!path.resolve(f).startsWith(path.resolve(config.dataDir))) continue; // never write outside the data dir
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(b64, "base64"));
  }
  return `✅ Portfolio restored.\n${describe(p)}`;
}

// API used by the Telegram handlers
export const build = (password: string): Buffer => buildFull(password).buf;
export const summary = describe;
export function restore(p: Portfolio): void {
  apply(p);
}
