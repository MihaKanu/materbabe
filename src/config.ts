import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function positiveLimit(name: string, fallback: string): number {
  const raw = process.env[name]?.trim() || fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number.`);
  return n;
}

const network = process.env.SOLANA_NETWORK?.trim() || 'mainnet-beta';
if (network !== 'mainnet-beta') throw new Error('SOLANA_NETWORK must be mainnet-beta for this production bot.');

const payoutWallet = required('PAYOUT_WALLET');
try { new PublicKey(payoutWallet); } catch { throw new Error('PAYOUT_WALLET is invalid.'); }

export const config = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  ownerTelegramId: Number(required('OWNER_TELEGRAM_ID')),
  accessKey: required('ACCESS_KEY'),
  network: network as 'mainnet-beta',
  rpc: required('SOLANA_RPC_URL'),
  masterSecret: required('MASTER_SECRET'),
  payoutWallet,
  maxSingleBuySol: positiveLimit('MAX_SINGLE_BUY_SOL', '1'),
  maxPayoutSol: positiveLimit('MAX_PAYOUT_SOL', '5'),
  maxSingleFundSol: positiveLimit('MAX_SINGLE_FUND_SOL', '1'),
  slippagePercent: positiveLimit('SLIPPAGE_PERCENT', '1'),
};

if (!Number.isSafeInteger(config.ownerTelegramId) || config.ownerTelegramId <= 0) {
  throw new Error('OWNER_TELEGRAM_ID is invalid.');
}
