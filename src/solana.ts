import bs58 from 'bs58';
import BN from 'bn.js';
import { Connection, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { NATIVE_MINT, getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import type { AccountInfo } from '@solana/web3.js';
import { config } from './config.js';

export const connection = new Connection(config.rpc, 'confirmed');
export const onlinePump = new OnlinePumpSdk(connection);
export const masterKeypair = loadMasterKeypair();

function loadMasterKeypair(): Keypair {
  try {
    const decoded = bs58.decode(config.masterSecret);
    if (decoded.length !== 64) throw new Error('wrong length');
    return Keypair.fromSecretKey(decoded);
  } catch { throw new Error('MASTER_SECRET is invalid.'); }
}

export function shortKey(key: PublicKey | string): string { const s = typeof key === 'string' ? key : key.toBase58(); return `${s.slice(0,4)}...${s.slice(-4)}`; }
export function explorerTx(signature: string): string { return `https://solscan.io/tx/${signature}`; }
export function explorerAddress(address: string): string { return `https://solscan.io/account/${address}`; }
export function solToLamports(value: number): BN { if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid SOL amount.'); return new BN(Math.round(value * 1_000_000_000)); }
export function lamportsToSol(value: number | bigint | BN): string { const n = typeof value === 'bigint' ? Number(value) : value instanceof BN ? Number(value.toString()) : value; return (n / 1e9).toFixed(4); }

async function retryRead<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i=0;i<attempts;i++) { try { return await fn(); } catch (e) { last=e; if (i<attempts-1) await new Promise(r=>setTimeout(r, 500*(i+1))); } }
  throw last;
}

export async function verifyMainnet(): Promise<void> {
  const version = await connection.getVersion();
  const genesis = await connection.getGenesisHash();
  // Mainnet genesis hash is stable; using the RPC's cluster endpoint is preferable to guessing from URL.
  const knownMainnetGenesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  if (genesis !== knownMainnetGenesis) throw new Error(`RPC network mismatch. Expected: mainnet-beta (genesis ${knownMainnetGenesis}), received ${genesis}.`);
  void version;
}

export async function solBalance(owner: PublicKey): Promise<number> { return (await retryRead(()=>connection.getBalance(owner))) / 1e9; }
export async function masterBalance(): Promise<number> { return solBalance(masterKeypair.publicKey); }

export async function sendSol(from: Keypair, to: PublicKey, sol: number): Promise<string> {
  const lamports = solToLamports(sol);
  const balance = await connection.getBalance(from.publicKey);
  if (balance < lamports.toNumber() + 10_000) throw new Error('Insufficient SOL balance.');
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units: 100_000}), SystemProgram.transfer({fromPubkey:from.publicKey,toPubkey:to,lamports:lamports.toNumber()}));
  return sendAndConfirmTransaction(connection, tx, [from], { commitment:'confirmed' });
}

export async function tokenBalance(mint: PublicKey, owner: PublicKey): Promise<BN> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error('Token mint account not found.');
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program);
  try { return new BN((await getAccount(connection, ata, 'confirmed', program)).amount.toString()); } catch { return new BN(0); }
}

export async function tokenProgramForMint(mint: PublicKey): Promise<PublicKey> {
  const account = await retryRead(()=>connection.getAccountInfo(mint));
  if (!account) throw new Error('Token mint account not found.');
  if (account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID)) return account.owner;
  throw new Error('Unsupported token program.');
}

export async function createCoin(args: {name:string;symbol:string;uri:string;initialBuySol:number}): Promise<{mint:string;signature:string}> {
  const mint = Keypair.generate();
  const user = masterKeypair.publicKey;
  const global = await onlinePump.fetchGlobal();
  const feeConfig = await onlinePump.fetchFeeConfig();
  const solAmount = solToLamports(args.initialBuySol);
  const ixs = args.initialBuySol > 0
    ? await PUMP_SDK.createV2AndBuyInstructions({
        global, mint: mint.publicKey, name: args.name, symbol: args.symbol, uri: args.uri,
        creator: user, user, solAmount,
        amount: getBuyTokenAmountFromSolAmount({global, feeConfig, mintSupply:null, bondingCurve:null, amount:solAmount, quoteMint:NATIVE_MINT}),
        mayhemMode:false,
      })
    : [await PUMP_SDK.createV2Instruction({mint:mint.publicKey,name:args.name,symbol:args.symbol,uri:args.uri,creator:user,user,mayhemMode:false,holderReward:false})];
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units: 500_000}), ...ixs);
  const signature = await sendAndConfirmTransaction(connection, tx, [masterKeypair, mint], {commitment:'confirmed'});
  return {mint:mint.publicKey.toBase58(), signature};
}

export async function quoteBuy(mint: PublicKey, user: PublicKey, sol: number): Promise<{tokens:BN; sol:BN}> {
  const [state, global, feeConfig] = await Promise.all([onlinePump.fetchBuyState(mint,user),onlinePump.fetchGlobal(),onlinePump.fetchFeeConfig()]);
  if (state.bondingCurve.complete) throw new Error('This token has graduated from the bonding curve.');
  const amount = solToLamports(sol);
  const tokens = getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:state.bondingCurve.tokenTotalSupply,bondingCurve:state.bondingCurve,amount,quoteMint:NATIVE_MINT});
  return {tokens,sol:amount};
}

export async function buy(mint: PublicKey, wallet: Keypair, sol: number): Promise<string> {
  const [state, global, feeConfig] = await Promise.all([onlinePump.fetchBuyState(mint,wallet.publicKey),onlinePump.fetchGlobal(),onlinePump.fetchFeeConfig()]);
  if (state.bondingCurve.complete) throw new Error('This token has graduated from the bonding curve. Bonding-curve trading is unavailable.');
  const solAmount = solToLamports(sol);
  const amount = getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:state.bondingCurve.tokenTotalSupply,bondingCurve:state.bondingCurve,amount:solAmount,quoteMint:NATIVE_MINT});
  const ixs = await PUMP_SDK.buyInstructions({...state,global,mint,user:wallet.publicKey,solAmount,amount,slippage:config.slippagePercent});
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:500_000}),...ixs);
  return sendAndConfirmTransaction(connection,tx,[wallet],{commitment:'confirmed'});
}

export async function sell(mint: PublicKey, wallet: Keypair, amount: BN): Promise<{signature:string;expectedSol:BN}> {
  if (!amount.isZero() && amount.isNeg()) throw new Error('Invalid token amount.');
  const [state,global,feeConfig] = await Promise.all([onlinePump.fetchSellState(mint,wallet.publicKey),onlinePump.fetchGlobal(),onlinePump.fetchFeeConfig()]);
  if (state.bondingCurve.complete) throw new Error('This token has graduated from the bonding curve. Bonding-curve trading is unavailable.');
  const balance = await tokenBalance(mint,wallet.publicKey);
  if (amount.gt(balance)) throw new Error('Sell amount exceeds wallet token balance.');
  const expectedSol = getSellSolAmountFromTokenAmount({global,feeConfig,mintSupply:state.bondingCurve.tokenTotalSupply,bondingCurve:state.bondingCurve,amount});
  const ixs = await PUMP_SDK.sellInstructions({...state,global,mint,user:wallet.publicKey,amount,solAmount:expectedSol,slippage:config.slippagePercent});
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:500_000}),...ixs);
  const signature = await sendAndConfirmTransaction(connection,tx,[wallet],{commitment:'confirmed'});
  return {signature,expectedSol};
}

export async function tokenAnalytics(mint: PublicKey): Promise<{complete:boolean;tokenSupply:BN;virtualSol:BN;virtualToken:BN}> {
  const curve = await onlinePump.fetchBondingCurve(mint);
  return {complete:curve.complete,tokenSupply:curve.tokenTotalSupply,virtualSol:curve.virtualSolReserves,virtualToken:curve.virtualTokenReserves};
}

export { PublicKey, Keypair, BN };
