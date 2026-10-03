/**
 * PUMP SDK BOUNDARY — the ONLY file allowed to import "@pump-fun/pump-sdk".
 *
 * STATUS: NOT IMPLEMENTED. The installed @pump-fun/pump-sdk@2.0.0 declarations
 * have not been inspected, so no SDK call is guessed here. Run
 *   npm install && npm run inspect-sdk
 * and implement each function below against the exact .d.ts signatures
 * (createV2Instruction / createV2AndBuyInstructions, fetchBuyState, buyInstructions,
 * fetchSellState, sellInstructions, fetchGlobal, fetchFeeConfig,
 * getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount).
 * Use sol.sendTx(instructions, signers) to submit. Token program: use the one
 * from fetchBuyState if exposed, else the mint account's owner.
 */
import { Keypair, PublicKey } from "@solana/web3.js";

export class PumpNotImplementedError extends Error {
  constructor(fn: string) {
    super(`Pump module not implemented (${fn}). SDK declarations must be inspected first.`);
  }
}

export interface CurveState {
  graduated: boolean;
  priceText: string;
  marketCapText: string;
  solReservesText: string;
  tokenReservesText: string;
  feeText: string; // creator / protocol / LP from SDK fee config
}
export interface BuyQuote {
  estTokensRaw: bigint;
}
export interface SellQuote {
  estLamports: bigint;
}
export interface CreateParams {
  name: string;
  symbol: string;
  uri: string;
  creator: Keypair;
  initialBuyLamports: bigint;
  slippageBps: number;
  mayhemMode: false; // default OFF; adjust to the SDK's real field after inspection
}

export async function getCurveState(_mint: PublicKey): Promise<CurveState> {
  throw new PumpNotImplementedError("getCurveState");
}
export async function quoteBuy(_mint: PublicKey, _lamports: bigint, _bps: number): Promise<BuyQuote> {
  throw new PumpNotImplementedError("quoteBuy");
}
export async function buy(_mint: PublicKey, _w: Keypair, _lamports: bigint, _bps: number): Promise<string> {
  throw new PumpNotImplementedError("buy");
}
export async function quoteSell(_mint: PublicKey, _raw: bigint, _bps: number): Promise<SellQuote> {
  throw new PumpNotImplementedError("quoteSell");
}
export async function sell(_mint: PublicKey, _w: Keypair, _raw: bigint, _bps: number): Promise<string> {
  throw new PumpNotImplementedError("sell");
}
export async function createCoin(_p: CreateParams): Promise<{ mint: string; signature: string }> {
  throw new PumpNotImplementedError("createCoin");
}
