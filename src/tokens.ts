import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as sol from "./solana.js";

export async function tokenProgramOf(mint: PublicKey): Promise<PublicKey> {
  const info = await sol.withRetry(() => sol.connection.getAccountInfo(mint));
  if (!info) throw new Error("Account not found");
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Address is not a token mint");
  }
  return info.owner;
}

/** Send tokens from `from`'s associated account to each target (ATAs created, paid by `from`). */
export async function distribute(
  mint: PublicKey,
  from: Keypair,
  targets: { owner: PublicKey; amount: bigint }[],
  decimals: number,
): Promise<string[]> {
  const program = await tokenProgramOf(mint);
  const src = getAssociatedTokenAddressSync(mint, from.publicKey, true, program);
  const sigs: string[] = [];
  for (let i = 0; i < targets.length; i += 4) {
    const ixs: TransactionInstruction[] = [];
    for (const t of targets.slice(i, i + 4)) {
      const dst = getAssociatedTokenAddressSync(mint, t.owner, true, program);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dst, t.owner, mint, program));
      ixs.push(createTransferCheckedInstruction(src, mint, dst, from.publicKey, t.amount, decimals, [], program));
    }
    sigs.push(await sol.sendTx(ixs, [from]));
  }
  return sigs;
}

export async function burn(
  mint: PublicKey,
  wallet: Keypair,
  amount: bigint,
  decimals: number,
  feePayer?: Keypair,
): Promise<string> {
  const program = await tokenProgramOf(mint);
  const acct = getAssociatedTokenAddressSync(mint, wallet.publicKey, true, program);
  const ix = createBurnCheckedInstruction(acct, mint, wallet.publicKey, amount, decimals, [], program);
  return sol.sendTx([ix], feePayer ? [feePayer, wallet] : [wallet]);
}
