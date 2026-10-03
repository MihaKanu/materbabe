/**
 * PUMP SDK BOUNDARY — the only file that imports "@pump-fun/pump-sdk".
 * Written against the installed @pump-fun/pump-sdk@2.0.0 declarations
 * (dumped from dist/index.d.ts). Uses the SOL-quoted bonding-curve builders:
 * createV2Instruction, createV2AndBuyInstructions, buyInstructions, sellInstructions.
 * Non-SOL-quote curves and graduated tokens are rejected.
 */
import BN from "bn.js";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurveMarketCap,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import { config } from "./config.js";
import * as sol from "./solana.js";

export class PumpNotImplementedError extends Error {}

export interface CurveState {
  graduated: boolean;
  priceText: string;
  marketCapText: string;
  solReservesText: string;
  tokenReservesText: string;
  feeText: string;
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
  mayhemMode: false;
}

let onlineSdk: OnlinePumpSdk | undefined;
function online(): OnlinePumpSdk {
  onlineSdk ??= new OnlinePumpSdk(sol.connection);
  return onlineSdk;
}

const toBN = (v: bigint): BN => new BN(v.toString());
const toBig = (v: BN): bigint => BigInt(v.toString());

/** Token program that owns the mint (classic SPL or Token-2022). */
async function baseTokenProgram(mint: PublicKey): Promise<PublicKey> {
  const info = await sol.withRetry(() => sol.connection.getAccountInfo(mint));
  if (!info) throw new Error("Account not found");
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Address is not a token mint");
  }
  return info.owner;
}

async function loadBuy(mint: PublicKey, user: PublicKey) {
  const tokenProgram = await baseTokenProgram(mint);
  const sdk = online();
  const [state, global, feeConfig] = await Promise.all([
    sol.withRetry(() => sdk.fetchBuyState(mint, user, tokenProgram)),
    sol.withRetry(() => sdk.fetchGlobal()),
    sol.withRetry(() => sdk.fetchFeeConfig()),
  ]);
  return { tokenProgram, state, global, feeConfig };
}

function requireTradable(quoteMint: PublicKey, complete: boolean): void {
  if (complete) throw new Error("Token graduated: bonding-curve trading is unavailable.");
  if (!quoteMint.equals(NATIVE_MINT)) {
    throw new Error("This token uses a non-SOL quote, which this bot does not support.");
  }
}

export async function getCurveState(mint: PublicKey): Promise<CurveState> {
  const { state } = await loadBuy(mint, config.master.publicKey);
  const bc = state.bondingCurve;
  const dec = (await sol.withRetry(() => sol.connection.getTokenSupply(mint))).value.decimals;
  const mc = bondingCurveMarketCap({
    mintSupply: bc.tokenTotalSupply,
    virtualQuoteReserves: bc.virtualQuoteReserves,
    virtualTokenReserves: bc.virtualTokenReserves,
  });
  const vq = Number(bc.virtualQuoteReserves.toString()) / 1e9;
  const vt = Number(bc.virtualTokenReserves.toString()) / 10 ** dec;
  return {
    graduated: bc.complete,
    priceText: vt > 0 ? `${(vq / vt).toPrecision(6)} SOL` : "n/a",
    marketCapText: `${sol.formatSol(toBig(mc), 2)} SOL`,
    solReservesText: `${sol.formatSol(toBig(bc.realQuoteReserves))} SOL (real)`,
    tokenReservesText: `${sol.formatUnits(toBig(bc.realTokenReserves), dec, 2)} (real)`,
    feeText: "creator / protocol / LP rates are applied inside the SDK quote (current on-chain config)",
  };
}

export async function quoteBuy(mint: PublicKey, lamports: bigint, _bps: number): Promise<BuyQuote> {
  const { state, global, feeConfig } = await loadBuy(mint, config.master.publicKey);
  requireTradable(state.quoteMint, state.bondingCurve.complete);
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: state.bondingCurve.tokenTotalSupply,
    bondingCurve: state.bondingCurve,
    amount: toBN(lamports),
    quoteMint: state.quoteMint,
  });
  return { estTokensRaw: toBig(amount) };
}

export async function buy(
  mint: PublicKey,
  wallet: Keypair,
  lamports: bigint,
  bps: number,
  feePayer?: Keypair,
): Promise<string> {
  const { tokenProgram, state, global, feeConfig } = await loadBuy(mint, wallet.publicKey);
  requireTradable(state.quoteMint, state.bondingCurve.complete);
  const solAmount = toBN(lamports);
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: state.bondingCurve.tokenTotalSupply,
    bondingCurve: state.bondingCurve,
    amount: solAmount,
    quoteMint: state.quoteMint,
  });
  const ixs: TransactionInstruction[] = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint,
    user: wallet.publicKey,
    amount,
    solAmount,
    slippage: bps / 100, // ASSUMED percent; unit not shown in declarations
    tokenProgram,
  });
  return sol.sendTx(ixs, feePayer ? [feePayer, wallet] : [wallet]);
}

async function loadSell(mint: PublicKey, user: PublicKey) {
  const tokenProgram = await baseTokenProgram(mint);
  const sdk = online();
  const [state, global, feeConfig] = await Promise.all([
    sol.withRetry(() => sdk.fetchSellState(mint, user, tokenProgram)),
    sol.withRetry(() => sdk.fetchGlobal()),
    sol.withRetry(() => sdk.fetchFeeConfig()),
  ]);
  return { tokenProgram, state, global, feeConfig };
}

export async function quoteSell(mint: PublicKey, raw: bigint, _bps: number): Promise<SellQuote> {
  const { state, global, feeConfig } = await loadSell(mint, config.master.publicKey);
  requireTradable(state.quoteMint, state.bondingCurve.complete);
  const out = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: state.bondingCurve.tokenTotalSupply,
    bondingCurve: state.bondingCurve,
    amount: toBN(raw),
  });
  return { estLamports: toBig(out) };
}

export async function sell(
  mint: PublicKey,
  wallet: Keypair,
  raw: bigint,
  bps: number,
  feePayer?: Keypair,
): Promise<string> {
  const { tokenProgram, state, global, feeConfig } = await loadSell(mint, wallet.publicKey);
  requireTradable(state.quoteMint, state.bondingCurve.complete);
  const amount = toBN(raw);
  const solAmount = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: state.bondingCurve.tokenTotalSupply,
    bondingCurve: state.bondingCurve,
    amount,
  });
  const ixs: TransactionInstruction[] = await PUMP_SDK.sellInstructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    mint,
    user: wallet.publicKey,
    amount,
    solAmount,
    slippage: bps / 100, // ASSUMED percent; unit not shown in declarations
    tokenProgram,
    mayhemMode: state.bondingCurve.isMayhemMode,
    cashback: state.bondingCurve.isCashbackCoin,
  });
  return sol.sendTx(ixs, feePayer ? [feePayer, wallet] : [wallet]);
}

export async function createCoin(p: CreateParams): Promise<{ mint: string; signature: string }> {
  const mintKp = Keypair.generate();
  const base = {
    mint: mintKp.publicKey,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    creator: p.creator.publicKey,
    user: p.creator.publicKey,
    mayhemMode: p.mayhemMode,
  };
  let ixs: TransactionInstruction[];
  if (p.initialBuyLamports > 0n) {
    const sdk = online();
    const [global, feeConfig] = await Promise.all([
      sol.withRetry(() => sdk.fetchGlobal()),
      sol.withRetry(() => sdk.fetchFeeConfig()),
    ]);
    const solAmount = toBN(p.initialBuyLamports);
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    });
    ixs = await PUMP_SDK.createV2AndBuyInstructions({ global, ...base, amount, solAmount });
  } else {
    ixs = [await PUMP_SDK.createV2Instruction(base)];
  }
  const signature = await sol.sendTx(ixs, [p.creator, mintKp]);
  console.log("Coin created", sol.short(mintKp.publicKey));
  return { mint: mintKp.publicKey.toBase58(), signature };
}

/** SOL needed (at creation) to buy `pct10`/10 percent of total supply. Uses the SDK quote, solved by bisection. */
export async function quoteAllocation(
  pct10: number,
): Promise<{ lamports: bigint; tokensRaw: bigint; supplyRaw: bigint }> {
  const sdk = online();
  const [global, feeConfig] = await Promise.all([
    sol.withRetry(() => sdk.fetchGlobal()),
    sol.withRetry(() => sdk.fetchFeeConfig()),
  ]);
  const supplyRaw = toBig(global.tokenTotalSupply);
  const target = (supplyRaw * BigInt(pct10)) / 1000n;
  const tokensFor = (l: bigint): bigint =>
    toBig(
      getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: null,
        bondingCurve: null,
        amount: toBN(l),
        quoteMint: NATIVE_MINT,
      }),
    );
  let lo = 1n;
  let hi = 10_000n * 1_000_000_000n;
  if (tokensFor(hi) < target) throw new Error("Allocation is not reachable on the bonding curve.");
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (tokensFor(mid) >= target) hi = mid;
    else lo = mid + 1n;
  }
  return { lamports: hi, tokensRaw: tokensFor(hi), supplyRaw };
}

/** Tokens a fresh curve would give for `lamports`, and total supply (SDK quote). Used for the 30% launch cap. */
export async function creationQuote(lamports: bigint): Promise<{ tokensRaw: bigint; supplyRaw: bigint }> {
  const sdk = online();
  const [global, feeConfig] = await Promise.all([
    sol.withRetry(() => sdk.fetchGlobal()),
    sol.withRetry(() => sdk.fetchFeeConfig()),
  ]);
  const supplyRaw = toBig(global.tokenTotalSupply);
  if (supplyRaw <= 0n) throw new Error("Could not read total supply");
  const tokensRaw = toBig(
    getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: toBN(lamports),
      quoteMint: NATIVE_MINT,
    }),
  );
  return { tokensRaw, supplyRaw };
}
