import fs from "node:fs";
import path from "node:path";
import { createHmac, scryptSync } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

/**
 * Wallet keys are DERIVED from WALLET_STORE_KEY + an index, never stored.
 * If the registry file is lost, every wallet is recoverable with /recover <count>.
 */
export type Group = "treasury" | "chusi";
export interface WalletPublic {
  id: string;
  group: Group;
  publicKey: string;
  index: number;
}
export interface Position {
  spent: string; // lamports invested
  realized: string; // estimated lamports returned from sells
  entryMcap?: string; // market cap (lamports) at first recorded buy
}
export interface SourceInfo {
  id: string;
  group: Group | "master";
  publicKey: string;
}
export interface CoinRec {
  mint: string;
  name: string;
  symbol: string;
  image?: string; // local file (relative to data dir) or https URL
  createdAt: string;
}
export interface WalletRec extends WalletPublic {
  secret?: string; // only set when restored from a save made with a different WALLET_STORE_KEY
  index: number;
  createdAt: string;
}
export interface Data {
  nextIndex: number;
  nextW: number;
  nextC: number;
  wallets: WalletRec[];
  coins: CoinRec[];
  positions: Record<string, Position>;
}

const root = scryptSync(config.storeKey, "materbabe-wallet-derivation-v1", 32);
const file = path.join(config.dataDir, "registry.json");
export type StoreData = Data;
let data: Data = { nextIndex: 0, nextW: 1, nextC: 1, wallets: [], coins: [], positions: {} };

function derive(index: number): Keypair {
  return Keypair.fromSeed(createHmac("sha256", root).update(`wallet:${index}`).digest());
}

export function loadStore(): void {
  if (!fs.existsSync(file)) {
    console.warn("No registry file yet (new install, or the disk was reset). Use /recover <count> if you had wallets.");
    return;
  }
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim() === "") return;
  try {
    data = JSON.parse(raw) as Data;
    data.positions ??= {};
    data.coins ??= [];
  } catch {
    throw new Error("registry.json is corrupt. Not overwriting it; fix or move the file (a .bak copy may exist).");
  }
}

function save(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

function add(group: Group, index: number): WalletRec {
  const id = group === "chusi" ? `C${data.nextC++}` : `W${data.nextW++}`;
  const rec: WalletRec = {
    id,
    group,
    index,
    publicKey: derive(index).publicKey.toBase58(),
    createdAt: new Date().toISOString(),
  };
  data.wallets.push(rec);
  return rec;
}

/** Key derived from the master seed for a named purpose (e.g. per-user payment addresses). */
export function deriveNamed(label: string): Keypair {
  return Keypair.fromSeed(createHmac("sha256", root).update(label).digest());
}

export function createWallets(group: Group, count: number): WalletPublic[] {
  const made: WalletPublic[] = [];
  for (let i = 0; i < count; i++) {
    const r = add(group, data.nextIndex++);
    made.push({ id: r.id, group: r.group, publicKey: r.publicKey, index: r.index });
  }
  save();
  return made;
}

/** Re-register derived wallets 0..count-1 that are missing from the registry (as treasury). */
export function recoverRange(count: number): number {
  let added = 0;
  const have = new Set(data.wallets.map((w) => w.index));
  for (let i = 0; i < count; i++) {
    if (!have.has(i)) {
      add("treasury", i);
      added++;
    }
  }
  data.nextIndex = Math.max(data.nextIndex, count);
  save();
  return added;
}

export function getWallets(group?: Group): WalletPublic[] {
  return data.wallets
    .filter((w) => !group || w.group === group)
    .map((w) => ({ id: w.id, group: w.group, publicKey: w.publicKey, index: w.index }));
}

export function getWallet(id: string): WalletPublic | undefined {
  return getWallets().find((w) => w.id === id);
}

/** Master ("M") or any derived wallet. Never display the result. */
export function signerFor(id: string): Keypair | undefined {
  if (id === "M") return config.master;
  const r = data.wallets.find((w) => w.id === id);
  if (!r) return undefined;
  if (r.secret) return Keypair.fromSecretKey(bs58.decode(r.secret));
  const kp = r.secret ? Keypair.fromSecretKey(bs58.decode(r.secret)) : derive(r.index);
  if (kp.publicKey.toBase58() !== r.publicKey) {
    throw new Error("WALLET_STORE_KEY does not match this wallet. Was it changed?");
  }
  return kp;
}

export function allSources(): SourceInfo[] {
  return [
    { id: "M", group: "master", publicKey: config.master.publicKey.toBase58() },
    ...getWallets().map((w) => ({ id: w.id, group: w.group, publicKey: w.publicKey })),
  ];
}

export function addCoin(c: Omit<CoinRec, "createdAt">): void {
  data.coins.push({ ...c, createdAt: new Date().toISOString() });
  save();
}
export function getCoins(): CoinRec[] {
  return data.coins;
}

export function getPosition(mint: string): Position | undefined {
  return data.positions[mint];
}
export function addSpent(mint: string, lamports: bigint, entryMcap?: bigint): void {
  const p = data.positions[mint] ?? { spent: "0", realized: "0" };
  p.spent = (BigInt(p.spent) + lamports).toString();
  if (!p.entryMcap && entryMcap !== undefined) p.entryMcap = entryMcap.toString();
  data.positions[mint] = p;
  save();
}
export function addRealized(mint: string, lamports: bigint): void {
  const p = data.positions[mint] ?? { spent: "0", realized: "0" };
  p.realized = (BigInt(p.realized) + lamports).toString();
  data.positions[mint] = p;
  save();
}

/** Everything needed for a portfolio save, including each wallet's private key. */
export function exportState(): { data: Data; keys: Record<string, string> } {
  const keys: Record<string, string> = {};
  for (const w of data.wallets) {
    try {
      const kp = signerFor(w.id);
      if (kp) keys[w.id] = bs58.encode(kp.secretKey);
    } catch {
      /* skip wallets whose key cannot be derived */
    }
  }
  return { data: JSON.parse(JSON.stringify(data)) as Data, keys };
}

/** Replaces the registry. Wallets that this server's WALLET_STORE_KEY cannot derive keep the key from the save. */
export function importState(d: Data, keys: Record<string, string>): void {
  for (const w of d.wallets) {
    delete w.secret;
    if (derive(w.index).publicKey.toBase58() === w.publicKey) continue;
    const k = keys[w.id];
    if (!k) throw new Error(`The save has no key for wallet ${w.id}`);
    if (Keypair.fromSecretKey(bs58.decode(k)).publicKey.toBase58() !== w.publicKey) {
      throw new Error(`Key mismatch for wallet ${w.id}`);
    }
    w.secret = k;
  }
  d.positions ??= {};
  d.coins ??= [];
  data = d;
  save();
}

/** For the encrypted portfolio save: the full registry plus every wallet's secret key (base58). */
export function exportAll(): { registry: Data; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  for (const w of data.wallets) {
    const kp = signerFor(w.id);
    if (kp) secrets[w.id] = bs58.encode(kp.secretKey);
  }
  return { registry: data, secrets };
}

export function importAll(registry: Data, secrets: Record<string, string>): void {
  const keepIndex = data.nextIndex;
  data = registry;
  data.positions ??= {};
  data.coins ??= [];
  data.nextIndex = Math.max(keepIndex, data.nextIndex); // never reuse an index
  for (const w of data.wallets) {
    if (derive(w.index).publicKey.toBase58() !== w.publicKey && secrets[w.id]) w.secret = secrets[w.id];
  }
  save();
}
