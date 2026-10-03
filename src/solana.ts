import { randomInt } from "node:crypto";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { config } from "./config.js";

export const connection = new Connection(config.rpcUrl, "confirmed");

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
export const FEE_BUFFER_LAMPORTS = 2_000_000n; // keep master above rent + fees

export const short = (k: PublicKey | string): string => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
};

export const txLink = (sig: string): string => `https://solscan.io/tx/${sig}`;
export const mintLink = (mint: string): string => `https://solscan.io/token/${mint}`;

export async function verifyMainnet(): Promise<void> {
  if (config.network !== "mainnet-beta") {
    throw new Error("SOLANA_NETWORK must be mainnet-beta.");
  }
  const genesis = await withRetry(() => connection.getGenesisHash());
  if (genesis !== MAINNET_GENESIS) {
    throw new Error("RPC network mismatch. Expected: mainnet-beta");
  }
}

/** Retry for READ operations only. Never wrap a signed send in this. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}

export function parsePublicKey(s: string): PublicKey {
  try {
    return new PublicKey(s.trim());
  } catch {
    throw new Error("Invalid public key");
  }
}

/** Decimal string -> base units, exact (no floats). */
export function parseDecimal(input: string, decimals: number): bigint {
  const t = input.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Invalid amount");
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function formatUnits(raw: bigint, decimals: number, maxFrac = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").slice(0, maxFrac);
  return decimals === 0 ? whole.toString() : `${whole}.${frac.padEnd(maxFrac, "0")}`;
}

export const formatSol = (lamports: bigint, frac = 4): string => formatUnits(lamports, 9, frac);

/** Parses a SOL amount and enforces 0 < amount <= maxSol. Returns lamports. */
export function parseSol(input: string, maxSol: number): bigint {
  const lamports = parseDecimal(input, 9);
  if (lamports <= 0n) throw new Error("Invalid SOL amount");
  if (lamports > BigInt(Math.round(maxSol * 1e9))) {
    throw new Error(`Amount exceeds limit of ${maxSol} SOL`);
  }
  return lamports;
}

export async function getSolBalance(pk: PublicKey): Promise<bigint> {
  return BigInt(await withRetry(() => connection.getBalance(pk, "confirmed")));
}

export interface TokenBalance {
  raw: bigint;
  decimals: number;
}

/** Works for classic SPL and Token-2022 mints (filters by mint, any program). */
export async function getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<TokenBalance> {
  const res = await withRetry(() => connection.getParsedTokenAccountsByOwner(owner, { mint }));
  let raw = 0n;
  let decimals = 0;
  for (const a of res.value) {
    const ta = (a.account.data as { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } })
      .parsed.info.tokenAmount;
    raw += BigInt(ta.amount);
    decimals = ta.decimals;
  }
  if (res.value.length === 0) {
    const sup = await withRetry(() => connection.getTokenSupply(mint));
    decimals = sup.value.decimals;
  }
  return { raw, decimals };
}

/** Build, sign, send ONCE, confirm. signers[0] pays fees. */
export async function sendTx(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await withRetry(() =>
    connection.getLatestBlockhash("confirmed"),
  );
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs);
  tx.sign(...signers);
  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 0 });
  } catch (e) {
    let detail = e instanceof Error ? e.message : String(e);
    let logs: string[] | undefined = (e as { logs?: string[] }).logs;
    if (!logs && e instanceof SendTransactionError) {
      logs = await e.getLogs(connection).catch(() => undefined);
    }
    if (logs && logs.length) detail += " | " + logs.slice(-5).join(" | ");
    throw new Error(detail);
  }
  console.log("Transaction submitted", sig);
  try {
    const res = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (res.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`);
  } catch (e) {
    // Do not resend. Check whether it landed anyway.
    const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (st.value && !st.value.err && st.value.confirmationStatus) {
      console.log("Transaction confirmed", sig);
      return sig;
    }
    throw e;
  }
  console.log("Transaction confirmed", sig);
  return sig;
}

export async function transferSol(from: Keypair, to: PublicKey, lamports: bigint): Promise<string> {
  const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports });
  return sendTx([ix], [from]);
}

// ---- per-key transaction locks ----
export class LockedError extends Error {}
const locks = new Set<string>();
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(key)) throw new LockedError("locked");
  locks.add(key);
  try {
    return await fn();
  } finally {
    locks.delete(key);
  }
}

export function friendlyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const l = m.toLowerCase();
  if (l.includes("invalid public key")) return "Invalid public key.";
  if (l.includes("insufficient funds") || l.includes("insufficient lamports") || l.includes("\"custom\":1"))
    return "Insufficient SOL balance.";
  if (l.includes("blockhash")) return "Blockhash expired. Try again.";
  if (l.includes("simulation failed")) return m.length > 700 ? m.slice(0, 700) + "…" : m;
  if (l.includes("account not found") || l.includes("could not find")) return "Account not found.";
  if (l.includes("slippage")) return "Slippage exceeded.";
  if (l.includes("invalid amount") || l.includes("invalid sol")) return "Invalid amount.";
  if (l.includes("fetch failed") || l.includes("429") || l.includes("econn")) return "RPC unavailable.";
  if (l.includes("pump module")) return m;
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}

/** Random split of `total` lamports over n wallets, each at least minEach. Sums exactly to total. */
export function randomSplit(total: bigint, n: number, minEach: bigint): bigint[] {
  if (total < minEach * BigInt(n)) {
    throw new Error(`Total too small: each wallet needs at least ${formatSol(minEach)} SOL`);
  }
  const spare = total - minEach * BigInt(n);
  const w = Array.from({ length: n }, () => randomInt(1, 101));
  const sum = BigInt(w.reduce((a, b) => a + b, 0));
  const out = w.map((x) => minEach + (spare * BigInt(x)) / sum);
  out[n - 1] += total - out.reduce((a, b) => a + b, 0n);
  return out;
}
