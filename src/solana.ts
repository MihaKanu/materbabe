import bs58 from 'bs58';
import BN from 'bn.js';
import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import { config } from './config.js';
export const connection = new Connection(config.rpc, 'confirmed');
export const onlinePump = new OnlinePumpSdk(connection);
export const masterKeypair = loadMasterKeypair();
function loadMasterKeypair(): Keypair {
  try {
    const decoded = bs58.decode(config.masterSecret);
    if (decoded.length !== 64) {
      throw new Error('wrong length');
    }
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new Error('MASTER_SECRET is invalid.');
  }
}
export function shortKey(key: PublicKey | string): string {
  const value =
    typeof key === 'string'
      ? key
      : key.toBase58();
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
export function explorerTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}
export function explorerAddress(address: string): string {
  return `https://solscan.io/account/${address}`;
}
export function solToLamports(value: number): BN {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid SOL amount.');
  }
  const lamports = Math.round(value * 1_000_000_000);
  if (!Number.isSafeInteger(lamports)) {
    throw new Error('SOL amount is too large.');
  }
  return new BN(lamports);
}
export function lamportsToSol(
  value: number | bigint | BN,
): string {
  let lamports: number;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return new BN(value.toString())
        .div(new BN(1_000_000_000))
        .toString();
    }
    lamports = Number(value);
  } else if (value instanceof BN) {
    if (value.gt(new BN(Number.MAX_SAFE_INTEGER))) {
      return value
        .div(new BN(1_000_000_000))
        .toString();
    }
    lamports = value.toNumber();
  } else {
    lamports = value;
  }
  return (lamports / 1_000_000_000).toFixed(4);
}
async function retryRead<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500 * (attempt + 1));
        });
      }
    }
  }
  throw lastError;
}
export async function verifyMainnet(): Promise<void> {
  const genesis = await retryRead(
    () => connection.getGenesisHash(),
  );
  const knownMainnetGenesis =
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  if (genesis !== knownMainnetGenesis) {
    throw new Error(
      `RPC network mismatch. Expected: mainnet-beta.`,
    );
  }
}
export async function solBalance(
  owner: PublicKey,
): Promise<number> {
  const balance = await retryRead(
    () => connection.getBalance(owner),
  );
  return balance / 1_000_000_000;
}
export async function masterBalance(): Promise<number> {
  return solBalance(masterKeypair.publicKey);
}
export async function sendSol(
  from: Keypair,
  to: PublicKey,
  sol: number,
): Promise<string> {
  const lamports = solToLamports(sol);
  const balance = await retryRead(
    () => connection.getBalance(from.publicKey),
  );
  const requiredLamports =
    lamports.add(new BN(10_000));
  if (new BN(balance).lt(requiredLamports)) {
    throw new Error('Insufficient SOL balance.');
  }
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 100_000,
    }),
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: lamports.toNumber(),
    }),
  );
  return sendAndConfirmTransaction(
    connection,
    transaction,
    [from],
    {
      commitment: 'confirmed',
    },
  );
}
export async function tokenBalance(
  mint: PublicKey,
  owner: PublicKey,
): Promise<BN> {
  const account = await retryRead(
    () => connection.getAccountInfo(mint),
  );
  if (!account) {
    throw new Error('Token mint account not found.');
  }
  const tokenProgram = account.owner.equals(
    TOKEN_2022_PROGRAM_ID,
  )
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    tokenProgram,
  );
  try {
    const tokenAccount = await getAccount(
      connection,
      ata,
      'confirmed',
      tokenProgram,
    );
    return new BN(tokenAccount.amount.toString());
  } catch {
    return new BN(0);
  }
}
export async function tokenProgramForMint(
  mint: PublicKey,
): Promise<PublicKey> {
  const account = await retryRead(
    () => connection.getAccountInfo(mint),
  );
  if (!account) {
    throw new Error('Token mint account not found.');
  }
  if (
    account.owner.equals(TOKEN_PROGRAM_ID) ||
    account.owner.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    return account.owner;
  }
  throw new Error('Unsupported token program.');
}
export async function createCoin(args: {
  name: string;
  symbol: string;
  uri: string;
  initialBuySol: number;
}): Promise<{
  mint: string;
  signature: string;
}> {
  if (!args.name.trim()) {
    throw new Error('Token name is required.');
  }
  if (!args.symbol.trim()) {
    throw new Error('Token symbol is required.');
  }
  if (!args.uri.trim()) {
    throw new Error('Token metadata URI is required.');
  }
  if (
    !Number.isFinite(args.initialBuySol) ||
    args.initialBuySol < 0
  ) {
    throw new Error('Invalid initial buy amount.');
  }
  if (
    args.initialBuySol >
    config.maxSingleBuySol
  ) {
    throw new Error('Initial buy limit exceeded.');
  }
  const mint = Keypair.generate();
  const user = masterKeypair.publicKey;
  const global = await onlinePump.fetchGlobal();
  const solAmount =
    args.initialBuySol > 0
      ? solToLamports(args.initialBuySol)
      : new BN(0);
  let instructions;
  if (args.initialBuySol > 0) {
    const feeConfig =
      await onlinePump.fetchFeeConfig();
    /*
     * A brand-new curve uses the protocol's initial
     * configuration. The SDK's quote function accepts
     * the global state and current curve state.
     */
    const amount =
      getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: global.tokenTotalSupply,
        bondingCurve: {
          virtualTokenReserves:
            global.initialVirtualTokenReserves,
          virtualSolReserves:
            global.initialVirtualSolReserves,
          realTokenReserves:
            global.initialRealTokenReserves,
          realSolReserves: new BN(0),
          tokenTotalSupply:
            global.tokenTotalSupply,
          complete: false,
          creator: user,
        } as never,
        amount: solAmount,
        quoteMint: NATIVE_MINT,
      });
    instructions =
      await PUMP_SDK.createV2AndBuyInstructions({
        global,
        mint: mint.publicKey,
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        creator: user,
        user,
        amount,
        solAmount,
        mayhemMode: false,
        holderReward: false,
      });
  } else {
    instructions = [
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        creator: user,
        user,
        mayhemMode: false,
        holderReward: false,
      }),
    ];
  }
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 500_000,
    }),
    ...instructions,
  );
  const signature =
    await sendAndConfirmTransaction(
      connection,
      transaction,
      [masterKeypair, mint],
      {
        commitment: 'confirmed',
      },
    );
  return {
    mint: mint.publicKey.toBase58(),
    signature,
  };
}
export async function quoteBuy(
  mint: PublicKey,
  user: PublicKey,
  sol: number,
): Promise<{
  tokens: BN;
  sol: BN;
}> {
  const [
    state,
    global,
    feeConfig,
  ] = await Promise.all([
    onlinePump.fetchBuyState(
      mint,
      user,
    ),
    onlinePump.fetchGlobal(),
    onlinePump.fetchFeeConfig(),
  ]);
  if (state.bondingCurve.complete) {
    throw new Error(
      'This token has graduated from the bonding curve.',
    );
  }
  const solAmount = solToLamports(sol);
  const tokens =
    getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply:
        state.bondingCurve.tokenTotalSupply,
      bondingCurve:
        state.bondingCurve,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    });
  return {
    tokens,
    sol: solAmount,
  };
}
export async function buy(
  mint: PublicKey,
  wallet: Keypair,
  sol: number,
): Promise<string> {
  const [
    state,
    global,
    feeConfig,
  ] = await Promise.all([
    onlinePump.fetchBuyState(
      mint,
      wallet.publicKey,
    ),
    onlinePump.fetchGlobal(),
    onlinePump.fetchFeeConfig(),
  ]);
  if (state.bondingCurve.complete) {
    throw new Error(
      'This token has graduated from the bonding curve. Bonding-curve trading is unavailable.',
    );
  }
  const solAmount =
    solToLamports(sol);
  const amount =
    getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply:
        state.bondingCurve.tokenTotalSupply,
      bondingCurve:
        state.bondingCurve,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    });
  /*
   * IMPORTANT:
   *
   * tokenProgram is supplied directly from fetchBuyState().
   * This allows the SDK to use the correct SPL Token
   * program or Token-2022 program.
   */
  const instructions =
    await PUMP_SDK.buyInstructions({
      ...state,
      global,
      mint,
      user: wallet.publicKey,
      solAmount,
      amount,
      slippage: config.slippagePercent,
      tokenProgram: state.tokenProgram,
    });
  const transaction =
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 500_000,
      }),
      ...instructions,
    );
  return sendAndConfirmTransaction(
    connection,
    transaction,
    [wallet],
    {
      commitment: 'confirmed',
    },
  );
}
export async function sell(
  mint: PublicKey,
  wallet: Keypair,
  amount: BN,
): Promise<{
  signature: string;
  expectedSol: BN;
}> {
  if (amount.lte(new BN(0))) {
    throw new Error(
      'Invalid token amount.',
    );
  }
  const [
    state,
    global,
    feeConfig,
  ] = await Promise.all([
    onlinePump.fetchSellState(
      mint,
      wallet.publicKey,
    ),
    onlinePump.fetchGlobal(),
    onlinePump.fetchFeeConfig(),
  ]);
  if (state.bondingCurve.complete) {
    throw new Error(
      'This token has graduated from the bonding curve. Bonding-curve trading is unavailable.',
    );
  }
  const balance =
    await tokenBalance(
      mint,
      wallet.publicKey,
    );
  if (amount.gt(balance)) {
    throw new Error(
      'Sell amount exceeds wallet token balance.',
    );
  }
  const expectedSol =
    getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply:
        state.bondingCurve.tokenTotalSupply,
      bondingCurve:
        state.bondingCurve,
      amount,
    });
  /*
   * Render's actual TypeScript compiler confirmed that
   * this installed SDK version requires both:
   *
   * tokenProgram
   * mayhemMode
   *
   * We therefore supply them explicitly.
   *
   * The bot's configured default is non-Mayhem.
   */
  const instructions =
    await PUMP_SDK.sellInstructions({
      ...state,
      global,
      mint,
      user: wallet.publicKey,
      amount,
      solAmount: expectedSol,
      slippage: config.slippagePercent,
      tokenProgram: state.tokenProgram,
      mayhemMode: false,
    });
  const transaction =
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 500_000,
      }),
      ...instructions,
    );
  const signature =
    await sendAndConfirmTransaction(
      connection,
      transaction,
      [wallet],
      {
        commitment: 'confirmed',
      },
    );
  return {
    signature,
    expectedSol,
  };
}
/*
 * The installed Render compiler explicitly reported that
 * BondingCurve does NOT expose virtualSolReserves.
 *
 * Therefore this function intentionally returns only
 * fields confirmed by the installed type surface.
 */
export async function tokenAnalytics(
  mint: PublicKey,
): Promise<{
  complete: boolean;
  tokenSupply: BN;
  virtualToken: BN;
}> {
  const curve =
    await onlinePump.fetchBondingCurve(mint);
  return {
    complete: curve.complete,
    tokenSupply: curve.tokenTotalSupply,
    virtualToken:
      curve.virtualTokenReserves,
  };
}
export {
  PublicKey,
  Keypair,
  BN,
};
