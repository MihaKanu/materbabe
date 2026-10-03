import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function positive(name: string, fallback?: string): number {
  const raw = process.env[name]?.trim() || fallback;
  if (raw === undefined) throw new Error(`Missing required environment variable: ${name}`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number.`);
  return n;
}

function loadMaster(secret: string): Keypair {
  try {
    return Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    throw new Error("MASTER_SECRET is invalid.");
  }
}

function loadPayout(addr: string): PublicKey {
  try {
    return new PublicKey(addr);
  } catch {
    throw new Error("PAYOUT_WALLET is not a valid Solana address.");
  }
}

const ownerId = Number(req("OWNER_TELEGRAM_ID"));
if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
  throw new Error("OWNER_TELEGRAM_ID must be a numeric Telegram user ID.");
}

const rpcUrl = req("SOLANA_RPC_URL");
let rpcHost: string;
try {
  rpcHost = new URL(rpcUrl).host.replace(/^.*@/, "");
} catch {
  throw new Error("SOLANA_RPC_URL is not a valid URL.");
}

const masterKeypair = loadMaster(req("MASTER_SECRET"));
const slippagePercent = positive("SLIPPAGE_PERCENT", "1");
if (slippagePercent > 10) throw new Error("SLIPPAGE_PERCENT above 10 is refused.");

export const config = {
  telegramToken: req("TELEGRAM_BOT_TOKEN"),
  ownerTelegramId: ownerId,
  accessKey: req("ACCESS_KEY"),
  network: req("SOLANA_NETWORK"),
  rpcUrl,
  rpcLabel: rpcHost, // host only; never log rpcUrl itself
  master: masterKeypair,
  payoutWallet: loadPayout(req("PAYOUT_WALLET")),
  maxSingleBuySol: positive("MAX_SINGLE_BUY_SOL"),
  maxPayoutSol: positive("MAX_PAYOUT_SOL"),
  maxSingleFundSol: positive("MAX_SINGLE_FUND_SOL", "1"),
  slippagePercent,
  slippageBps: Math.round(slippagePercent * 100),
  storePath: process.env.WALLET_STORE_PATH?.trim() || "./data/wallets.json",
  storeKey: process.env.WALLET_STORE_KEY?.trim() || "",
  port: Number(process.env.PORT) || 3000,
  monitorBand: { min: 18, max: 26 },
} as const;
