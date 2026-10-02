import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export interface TreasuryWallet { id: string; publicKey: string; secretKey: string; }
const wallets = new Map<string, TreasuryWallet>();

export function createWallet(): TreasuryWallet {
  const keypair = Keypair.generate();
  const id = `W${wallets.size + 1}`;
  const wallet: TreasuryWallet = { id, publicKey: keypair.publicKey.toBase58(), secretKey: bs58.encode(keypair.secretKey) };
  wallets.set(id, wallet);
  return wallet;
}
export function getWallet(id: string): TreasuryWallet | undefined { return wallets.get(id); }
export function getWallets(): TreasuryWallet[] { return [...wallets.values()]; }
export function deleteWallet(id: string): boolean { return wallets.delete(id); }
