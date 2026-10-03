import {
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import * as sol from "./solana.js";

export async function tokenProgramOf(
  mint: PublicKey
): Promise<PublicKey> {
  const info = await sol.withRetry(() =>
    sol.connection.getAccountInfo(mint)
  );

  if (!info) {
    throw new Error("Account not found");
  }

  if (
    !info.owner.equals(TOKEN_PROGRAM_ID) &&
    !info.owner.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error("Address is not a token mint");
  }

  return info.owner;
}

/**
 * Send tokens from `from`'s associated token account
 * to each target.
 *
 * Destination ATAs are created idempotently.
 */
export async function distribute(
  mint: PublicKey,
  from: Keypair,
  targets: Array<{
    owner: PublicKey;
    amount: bigint;
  }>,
  decimals: number
): Promise<string[]> {
  const program: PublicKey =
    await tokenProgramOf(mint);

  const sourceAta: PublicKey =
    getAssociatedTokenAddressSync(
      mint,
      from.publicKey,
      true,
      program
    );

  const signatures: string[] = [];

  for (let i = 0; i < targets.length; i += 4) {
    const instructions: TransactionInstruction[] = [];

    const batch = targets.slice(i, i + 4);

    for (const target of batch) {
      const destinationAta: PublicKey =
        getAssociatedTokenAddressSync(
          mint,
          target.owner,
          true,
          program
        );

      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          from.publicKey,
          destinationAta,
          target.owner,
          mint,
          program
        )
      );

      instructions.push(
        createTransferCheckedInstruction(
          sourceAta,
          mint,
          destinationAta,
          from.publicKey,
          target.amount,
          decimals,
          [],
          program
        )
      );
    }

    const signature: string =
      await sol.sendTx(instructions, [from]);

    signatures.push(signature);
  }

  return signatures;
}

/**
 * Burn tokens from a wallet's associated token account.
 *
 * `feePayer` can optionally pay the transaction fee.
 */
export async function burn(
  mint: PublicKey,
  wallet: Keypair,
  amount: bigint,
  decimals: number,
  feePayer?: Keypair
): Promise<string> {
  const program: PublicKey =
    await tokenProgramOf(mint);

  const tokenAccount: PublicKey =
    getAssociatedTokenAddressSync(
      mint,
      wallet.publicKey,
      true,
      program
    );

  const instruction: TransactionInstruction =
    createBurnCheckedInstruction(
      tokenAccount,
      mint,
      wallet.publicKey,
      amount,
      decimals,
      [],
      program
    );

  const signers: Keypair[] = feePayer
    ? [feePayer, wallet]
    : [wallet];

  const signature: string =
    await sol.sendTx(instruction ? [instruction] : [], signers);

  return signature;
}
