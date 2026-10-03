import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

interface WalletRecord {
  id: string;
  publicKey: string;
  secretKey: string; // base58; never sent to Telegram or logs
  createdAt: string;
}
interface StoreData {
  nextId: number;
  wallets: WalletRecord[];
}
export interface WalletPublic {
  id: string;
  publicKey: string;
}

let data: StoreData = { nextId: 1, wallets: [] };

function encrypt(plain: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(config.storeKey, salt, 32);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({
    v: 1,
    enc: true,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  });
}

function decrypt(file: string): string {
  const o = JSON.parse(file);
  const key = scryptSync(config.storeKey, Buffer.from(o.salt, "base64"), 32);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(o.ct, "base64")), d.final()]).toString("utf8");
}

export function loadStore(): void {
  if (!fs.existsSync(config.storePath)) {
    if (!config.storeKey) {
      console.warn("WALLET_STORE_KEY not set: treasury keys will be stored UNENCRYPTED.");
    }
    return;
  }
  const raw = fs.readFileSync(config.storePath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.enc) {
    if (!config.storeKey) throw new Error("Wallet store is encrypted but WALLET_STORE_KEY is not set.");
    data = JSON.parse(decrypt(raw)) as StoreData;
  } else {
    data = parsed as StoreData;
  }
}

function save(): void {
  fs.mkdirSync(path.dirname(config.storePath), { recursive: true });
  const body = JSON.stringify(data);
  const out = config.storeKey ? encrypt(body) : body;
  const tmp = `${config.storePath}.tmp`;
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, config.storePath);
}

export function createWallet(): WalletPublic {
  const kp = Keypair.generate();
  const rec: WalletRecord = {
    id: `W${data.nextId++}`,
    publicKey: kp.publicKey.toBase58(),
    secretKey: bs58.encode(kp.secretKey),
    createdAt: new Date().toISOString(),
  };
  data.wallets.push(rec);
  save();
  return { id: rec.id, publicKey: rec.publicKey };
}

export function getWallets(): WalletPublic[] {
  return data.wallets.map((w) => ({ id: w.id, publicKey: w.publicKey }));
}

export function getWallet(id: string): WalletPublic | undefined {
  const w = data.wallets.find((x) => x.id === id);
  return w ? { id: w.id, publicKey: w.publicKey } : undefined;
}

/** Internal use only, for signing. Never display the result. */
export function getWalletKeypair(id: string): Keypair | undefined {
  const w = data.wallets.find((x) => x.id === id);
  return w ? Keypair.fromSecretKey(bs58.decode(w.secretKey)) : undefined;
}

/** Not exposed in Telegram. Caller must confirm and check balances first. */
export function deleteWallet(id: string): boolean {
  const w = data.wallets.find((x) => x.id === id);
  if (!w) return false;
  if (w.publicKey === config.master.publicKey.toBase58()) {
    throw new Error("Refusing to delete the master wallet.");
  }
  data.wallets = data.wallets.filter((x) => x.id !== id);
  save();
  return true;
}
