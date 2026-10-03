import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { formatSol, short, txLink } from "./solana.js";

export interface DisclosureEntry {
  ts: string;
  type: "wallet_created" | "funded" | "sold" | "sent";
  walletId?: string;
  publicKey?: string;
  lamports?: string;
  signature?: string;
  note?: string;
}

const file = path.join(path.dirname(config.storePath), "disclosure.jsonl");

/** Append-only public record. Contains addresses and signatures only, never keys. */
export function record(e: Omit<DisclosureEntry, "ts">): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");
}

export function render(): string {
  let out =
    "MATERBABE COIN KIRKINATOR — WALLET DISCLOSURE\n" +
    "The wallets below are CONTROLLED BY THE OPERATOR of this bot.\n" +
    "They are not independent holders.\n" +
    `Master wallet: ${config.master.publicKey.toBase58()}\n\n`;
  if (!fs.existsSync(file)) return out + "(no entries yet)\n";
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as DisclosureEntry;
    out += `${e.ts}  ${e.type}  ${e.walletId ?? ""}  ${e.publicKey ?? ""}`;
    if (e.lamports) out += `  ${formatSol(BigInt(e.lamports), 4)} SOL`;
    if (e.signature) out += `  ${txLink(e.signature)}`;
    if (e.note) out += `  ${e.note}`;
    out += "\n";
  }
  return out;
}
export { short };
