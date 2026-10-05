import fs from "node:fs";
import path from "node:path";
import { createHash, randomInt } from "node:crypto";
import { config } from "./config.js";
import * as sol from "./solana.js";
import * as store from "./store.js";

/**
 * One-time access keys. Only SHA-256 hashes of the keys ship with the code (keys/keyhashes.txt).
 * Redeemed keys and accepted Telegram IDs are saved in DATA_DIR/access.json (needs the persistent disk,
 * otherwise a redeploy forgets who was accepted and which keys were used).
 */
interface Pending {
  quote: string; // lamports quoted to the user
  required: string; // lamports accepted (97% of quote, covers small price drift)
  usd: number;
  expires: number;
  notified?: string;
}
interface Sale {
  userId: number;
  lamports: string;
  usd: number;
  sig: string;
  at: string;
}
interface Db {
  accepted: Record<string, { at: string; keyHash: string }>;
  used: string[];
  issued: string[]; // hashes of keys sold through the bot
  pending: Record<string, Pending>;
  sales: Sale[];
}
const hashFile = path.join(process.cwd(), "keys", "keyhashes.txt");
const dbFile = path.join(config.dataDir, "access.json");
let db: Db = { accepted: {}, used: [], issued: [], pending: {}, sales: [] };
let issuedSet = new Set<string>();
let valid = new Set<string>();
let usedSet = new Set<string>();

const hashKey = (k: string): string => createHash("sha256").update(k).digest("hex").slice(0, 32);

export function loadAccess(): void {
  valid = new Set(fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8").split(/\s+/).filter(Boolean) : []);
  if (fs.existsSync(dbFile)) {
    const raw = fs.readFileSync(dbFile, "utf8");
    if (raw.trim()) db = JSON.parse(raw) as Db;
  }
  db.issued ??= [];
  db.pending ??= {};
  db.sales ??= [];
  usedSet = new Set(db.used);
  issuedSet = new Set(db.issued);
  console.log(`Access keys loaded: ${valid.size}; members: ${Object.keys(db.accepted).length}`);
}

function save(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, dbFile);
}

let notifier: ((id: number, html: string) => Promise<void>) | undefined;
const buyersLocal = path.join(config.dataDir, "buyers.txt");
let ghQueue: Promise<void> = Promise.resolve();

/** Records "TelegramID - CODE - HASH" after a code is redeemed (the code is dead by then, so it is safe to store). */
function logBuyer(uid: number, code: string, hash: string): void {
  const line = `${uid} - ${code} - ${hash}`;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(buyersLocal, line + "\n");
  } catch {
    /* local copy is best effort */
  }
  if (!config.githubToken || !config.githubRepo) return;
  ghQueue = ghQueue
    .then(() => pushToGithub(line))
    .catch(async (e: unknown) => {
      console.error("GitHub log failed:", e instanceof Error ? e.message : "unknown");
      await notifier?.(config.ownerTelegramId, `⚠️ Could not write to GitHub. Add this line to ${config.githubBuyersPath} manually:\n<code>${line}</code>`);
    });
}

async function pushToGithub(line: string): Promise<void> {
  const url = `https://api.github.com/repos/${config.githubRepo}/contents/${config.githubBuyersPath}`;
  const headers = {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "total-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const g = await fetch(`${url}?ref=${config.githubBranch}`, { headers });
    let sha: string | undefined;
    let existing = "";
    if (g.status === 200) {
      const j = (await g.json()) as { sha: string; content: string };
      sha = j.sha;
      existing = Buffer.from(j.content, "base64").toString("utf8");
    } else if (g.status !== 404) {
      throw new Error(`GitHub read ${g.status}`);
    }
    const body = {
      message: "Add buyer",
      content: Buffer.from(existing + line + "\n").toString("base64"),
      branch: config.githubBranch,
      ...(sha ? { sha } : {}),
    };
    const p = await fetch(url, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (p.ok) return;
    if (p.status !== 409 && p.status !== 422) throw new Error(`GitHub write ${p.status}`);
  }
  throw new Error("GitHub write conflict");
}

export const isAccepted = (id: number): boolean => Boolean(db.accepted[String(id)]);
export const memberCount = (): number => Object.keys(db.accepted).length;

export function redeem(id: number, rawKey: string): "ok" | "invalid" | "used" {
  const key = rawKey.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!key.startsWith("TOTAL") || key.length !== 17) return "invalid";
  const h = hashKey(key);
  if (!valid.has(h) && !issuedSet.has(h)) return "invalid";
  if (usedSet.has(h)) return "used";
  usedSet.add(h);
  db.used.push(h);
  db.accepted[String(id)] = { at: new Date().toISOString(), keyHash: h };
  save();
  logBuyer(id, key, h);
  return "ok";
}

// ---------------- paid access ----------------
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genKey(): string {
  let k = "TOTAL";
  for (let i = 0; i < 12; i++) k += ALPHABET[randomInt(ALPHABET.length)];
  return k;
}
const depositKp = (uid: number) => store.deriveNamed(`pay:${uid}`);

export function createQuote(uid: number, solUsd: number): { address: string; lamports: bigint; usd: number } {
  const usd = config.accessPriceUsd;
  const quote = BigInt(Math.ceil((usd / solUsd) * 1e9));
  db.pending[String(uid)] = {
    quote: quote.toString(),
    required: ((quote * 97n) / 100n).toString(),
    usd,
    expires: Date.now() + 60 * 60_000,
  };
  save();
  return { address: depositKp(uid).publicKey.toBase58(), lamports: quote, usd };
}

export type PayResult =
  | { state: "none" }
  | { state: "waiting"; needed: bigint }
  | { state: "short"; received: bigint; needed: bigint }
  | { state: "paid"; code: string; sig: string };

/** Checks the user's deposit address; on success sweeps it to the master wallet and issues a one-time code. */
export async function processUser(uid: number): Promise<PayResult> {
  const p = db.pending[String(uid)];
  if (!p) return { state: "none" };
  const kp = depositKp(uid);
  const bal = await sol.getSolBalance(kp.publicKey);
  const need = BigInt(p.required);
  if (bal < need) return bal > 0n ? { state: "short", received: bal, needed: need } : { state: "waiting", needed: need };
  return sol.withLock(`pay:${uid}`, async (): Promise<PayResult> => {
    if (!db.pending[String(uid)]) return { state: "none" };
    const fee = await sol.transferFeeLamports(kp);
    const sig = await sol.transferSol(kp, config.master.publicKey, bal - fee);
    const code = genKey();
    const h = hashKey(code);
    issuedSet.add(h);
    db.issued.push(h);
    db.sales.push({ userId: uid, lamports: bal.toString(), usd: p.usd, sig, at: new Date().toISOString() });
    delete db.pending[String(uid)];
    save();
    return { state: "paid", code, sig };
  });
}

export function salesSummary(): string {
  const total = db.sales.reduce((a, s) => a + s.usd, 0);
  const last = db.sales.slice(-10).map((s) => `${s.at.slice(0, 16)} user ${s.userId} ${sol.formatSol(BigInt(s.lamports))} SOL`);
  return `Sales: ${db.sales.length} (~$${total.toFixed(0)})\nMembers: ${memberCount()}\nPending: ${Object.keys(db.pending).length}\n\n${last.join("\n") || "no sales yet"}`;
}

export const codeMessage = (code: string): string =>
  `✅ Payment received.\n\nYour access code:\n<code>${code}</code>\n\nSend:\n<code>/access ${code}</code>`;

/** Polls pending payments every 20s and messages users automatically. */
export function startWatcher(notify: (id: number, html: string) => Promise<void>): void {
  notifier = notify;
  setInterval(() => {
    void (async () => {
      for (const [k, p] of Object.entries(db.pending)) {
        const uid = Number(k);
        try {
          const r = await processUser(uid);
          if (r.state === "paid") {
            await notify(uid, codeMessage(r.code));
            await notify(config.ownerTelegramId, `💰 New sale: user ${uid}, $${p.usd}. Swept to master.`);
          } else if (r.state === "short" && p.notified !== r.received.toString()) {
            p.notified = r.received.toString();
            save();
            await notify(uid, `Received ${sol.formatSol(r.received, 6)} SOL, but ${sol.formatSol(r.needed - r.received, 6)} SOL more is needed. Send the rest to the same address.`);
          } else if (Date.now() > p.expires) {
            delete db.pending[k];
            save();
          }
        } catch (e) {
          console.error("Payment watcher error:", e instanceof Error ? e.message : "unknown");
        }
      }
    })();
  }, 20_000);
}
