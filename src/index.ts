import { randomBytes } from "node:crypto";
import { Context, Markup, Telegraf } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { config } from "./config.js";
import * as sol from "./solana.js";
import * as store from "./store.js";
import * as pump from "./pump.js";
import * as tokens from "./tokens.js";
import * as disclosure from "./disclosure.js";
import * as meta from "./metadata.js";
import { startServer } from "./server.js";

const bot = new Telegraf(config.telegramToken, { handlerTimeout: 900_000 });
const authorized = new Set<number>();

const MIN_PER_WALLET = 10_000_000n; // 0.01 SOL
const TOP_HOLDER_WALLETS = 10;
const ALLOC_ATA_RENT = 2_500_000n; // per-wallet token account rent estimate
const CREATE_COST_BUFFER = 30_000_000n; // account rent + fees for a new coin
const GRAD_MSG =
  "⚠️ This token has graduated from the bonding curve.\nBonding-curve trading is unavailable.\nUse the appropriate PumpSwap/AMM implementation if enabled.";

// ---------- types ----------
type RunResult = string | { text: string; mint: string };
interface Confirm {
  userId: number;
  lockKey: string;
  run: () => Promise<RunResult>;
  expires: number;
}
type CreateStep = "name" | "symbol" | "uri" | "desc" | "image" | "twitter" | "website" | "alloc" | "buy";
interface CreateFlow {
  kind: "create";
  step: CreateStep;
  name?: string;
  symbol?: string;
  uri?: string;
  self?: boolean;
  desc?: string;
  imageUrl?: string;
  imageFileId?: string;
  twitter?: string;
  website?: string;
}
type Flow =
  | { kind: "fund"; step: "wallet" | "amount"; walletId?: string }
  | { kind: "payout" }
  | CreateFlow
  | { kind: "trade"; side: "buy" | "sell"; step: "mint" | "wallet" | "amount"; mint?: PublicKey; walletId?: string }
  | { kind: "analytics" }
  | { kind: "multi"; step: "count" | "total"; count?: number }
  | { kind: "sellall"; step: "coin" | "mint" | "pct"; mint?: PublicKey }
  | { kind: "burn"; step: "coin" | "mint" | "scope" | "pct"; mint?: PublicKey; scope?: "master" | "all" }
  | { kind: "send"; step: "wallet" | "addr" | "amount"; walletId?: string; dest?: PublicKey };

const flows = new Map<number, Flow>();
const confirms = new Map<string, Confirm>();

// ---------- helpers ----------
async function gate(ctx: Context): Promise<boolean> {
  const id = ctx.from?.id;
  if (id && authorized.has(id)) return true;
  await ctx.reply("🔐 MaterBabe Coin Kirkinator\nAccess required.\nUse:\n/access <key>");
  return false;
}
async function owner(ctx: Context): Promise<boolean> {
  if (!(await gate(ctx))) return false;
  if (ctx.from?.id !== config.ownerTelegramId) {
    await ctx.reply("⛔ Owner only.");
    return false;
  }
  return true;
}
async function sendLong(ctx: Context, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 3800) await ctx.reply(text.slice(i, i + 3800));
}
async function safe(ctx: Context, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    await ctx.reply(`❌ ${sol.friendlyError(e)}`);
  }
}
const pairs = <T>(a: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += 2) out.push(a.slice(i, i + 2));
  return out;
};
const pctKb = () =>
  Markup.inlineKeyboard([[25, 50, 75, 100].map((n) => Markup.button.callback(`${n}%`, `p:${n}`))]);

function walletKb(opts: { master?: boolean; all?: boolean }) {
  const btns = [] as ReturnType<typeof Markup.button.callback>[];
  if (opts.master) btns.push(Markup.button.callback(`Master ${sol.short(config.master.publicKey)}`, "w:M"));
  for (const w of store.getWallets().slice(0, 60)) {
    btns.push(Markup.button.callback(`${w.id} ${sol.short(w.publicKey)}`, `w:${w.id}`));
  }
  const rows = pairs(btns);
  if (opts.all) rows.push([Markup.button.callback("All wallets", "w:ALL")]);
  return Markup.inlineKeyboard(rows);
}

async function askCoin(ctx: Context, title: string): Promise<void> {
  const list = store.getCoins();
  const start = Math.max(0, list.length - 20);
  const btns = [] as ReturnType<typeof Markup.button.callback>[];
  for (let i = start; i < list.length; i++) {
    btns.push(Markup.button.callback(`${list[i].symbol}`, `k:${i}`));
  }
  const rows = pairs(btns);
  rows.push([Markup.button.callback("Other mint…", "k:other")]);
  await ctx.reply(`${title}\nPick a saved coin or paste a mint address:`, Markup.inlineKeyboard(rows));
}

const menuKb = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🚀 Create Coin", "m:create"), Markup.button.callback("💰 Balances", "m:bal")],
    [Markup.button.callback("👛 Wallets", "m:wallets"), Markup.button.callback("➕ Add Wallets", "m:multi")],
    [Markup.button.callback("🛒 Buy", "m:buy"), Markup.button.callback("💸 Sell", "m:sell")],
    [Markup.button.callback("💥 Sell All Wallets", "m:sellall"), Markup.button.callback("🔥 Burn", "m:burn")],
    [Markup.button.callback("📊 Token Analytics", "m:analytics"), Markup.button.callback("📤 Payout", "m:payout")],
    [Markup.button.callback("📤 Send SOL Out", "m:send"), Markup.button.callback("⚙️ Admin", "m:admin")],
    [Markup.button.callback("🧹 Clear Chat", "m:clear"), Markup.button.callback("📄 Disclosure", "m:disclosure")],
  ]);

async function showMenu(ctx: Context): Promise<void> {
  if (!(await gate(ctx))) return;
  await ctx.reply("🪙 MaterBabe Coin Kirkinator\nCreated by: YYLuccys Mom\nMainnet: ONLINE", menuKb());
}

async function sendCa(ctx: Context, mint: string): Promise<void> {
  // copy_text buttons postdate this Telegraf version's typings, hence the cast.
  const copy = { text: "📋 CA", copy_text: { text: mint } } as unknown as InlineKeyboardButton;
  await ctx.reply(`Contract address:\n<code>${mint}</code>`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [copy],
        [
          { text: "Solscan", url: sol.mintLink(mint) },
          { text: "pump.fun", url: `https://pump.fun/coin/${mint}` },
        ],
      ],
    },
  });
}

async function askConfirm(ctx: Context, summary: string, lockKey: string, run: () => Promise<RunResult>): Promise<void> {
  const id = randomBytes(6).toString("hex");
  confirms.set(id, { userId: ctx.from!.id, lockKey, run, expires: Date.now() + 5 * 60_000 });
  const text = `⚠️ CONFIRM TRANSACTION\n${summary}\n\nProceed?`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirm", `c:${id}`), Markup.button.callback("❌ Cancel", `x:${id}`)],
  ]);
  if (text.length > 3900) {
    await sendLong(ctx, text.slice(0, -"\n\nProceed?".length));
    await ctx.reply("Proceed?", kb);
  } else {
    await ctx.reply(text, kb);
  }
}

function clip(lines: string[], max = 30): string {
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n…and ${lines.length - max} more` : lines.join("\n");
}

// ---------- views ----------
async function walletReport(): Promise<string> {
  const m = config.master.publicKey;
  let out = `Master ${sol.short(m)}\n${sol.formatSol(await sol.getSolBalance(m))} SOL\n`;
  for (const g of ["treasury", "chusi"] as const) {
    const ws = store.getWallets(g);
    if (ws.length === 0) continue;
    out += `\n${g === "chusi" ? "Chusi Wallets" : "Treasury Wallets"}\n`;
    const bals = await Promise.all(ws.map((w) => sol.getSolBalance(new PublicKey(w.publicKey))));
    ws.forEach((w, i) => {
      out += `${w.id} ${sol.short(w.publicKey)} ${sol.formatSol(bals[i])} SOL\n`;
    });
  }
  return out;
}

async function showBalances(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  await sendLong(ctx, `💰 Balances\n\n${await walletReport()}`);
  await ctx.reply("Refresh?", Markup.inlineKeyboard([[Markup.button.callback("🔄 Refresh", "m:bal")]]));
}

async function showWallets(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  await sendLong(ctx, `👛 Wallets\n\n${await walletReport()}`);
  await ctx.reply(
    "Actions:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Create Treasury Wallet", "m:newwallet"), Markup.button.callback("Fund Wallet", "m:fund")],
      [Markup.button.callback("➕ Add Wallets", "m:multi"), Markup.button.callback("Refresh", "m:wallets")],
    ]),
  );
}

async function newWallet(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  const [w] = store.createWallets("treasury", 1);
  disclosure.record({ type: "wallet_created", walletId: w.id, publicKey: w.publicKey });
  await ctx.reply(
    `✅ Treasury wallet created\nWallet ID:\n${w.id}\nAddress:\n${w.publicKey}\n⚠️ Controlled by the bot. Keys are derived from WALLET_STORE_KEY.`,
  );
}

async function showAdmin(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  await ctx.reply(
    "⚙️ ADMIN",
    Markup.inlineKeyboard([
      [Markup.button.callback("Master Balance", "m:bal"), Markup.button.callback("View Wallets", "m:wallets")],
      [Markup.button.callback("Create Treasury Wallet", "m:newwallet"), Markup.button.callback("Fund Wallet", "m:fund")],
      [Markup.button.callback("Limits", "a:limits"), Markup.button.callback("Token Analytics", "m:analytics")],
      [Markup.button.callback("Payout", "m:payout"), Markup.button.callback("Restart State", "a:reset")],
    ]),
  );
}

async function showStatus(ctx: Context): Promise<void> {
  if (!(await gate(ctx))) return;
  const bal = await sol.getSolBalance(config.master.publicKey);
  await ctx.reply(
    `Network: Solana Mainnet\nRPC: ${config.rpcLabel}\nMaster: ${sol.short(config.master.publicKey)} (${sol.formatSol(bal)} SOL)\nTreasury wallets: ${store.getWallets("treasury").length}\nChusi wallets: ${store.getWallets("chusi").length}\nSaved coins: ${store.getCoins().length}\nSlippage: ${config.slippagePercent}%\nData dir: ${config.dataDir}\nPublic URL: ${config.publicUrl || "NOT SET"}`,
  );
}

async function sendDisclosure(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  await ctx.replyWithDocument({ source: Buffer.from(disclosure.render()), filename: "disclosure.txt" });
  if (config.publicUrl) await ctx.reply(`Public link:\n${config.publicUrl}/disclosure`);
}

async function clearChat(ctx: Context, lastId: number): Promise<void> {
  if (!(await gate(ctx))) return;
  flows.delete(ctx.from!.id);
  const chatId = ctx.chat!.id;
  const ids: number[] = [];
  for (let i = lastId; i > Math.max(0, lastId - 300); i--) ids.push(i);
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map((id) => ctx.telegram.deleteMessage(chatId, id).catch(() => undefined)));
    await new Promise((r) => setTimeout(r, 700));
  }
  await ctx.reply("🧹 Cleared what Telegram allows (messages under 48 hours old).", menuKb());
}

// ---------- analytics ----------
async function runAnalytics(ctx: Context, text: string): Promise<void> {
  const mint = sol.parsePublicKey(text);
  const sup = await sol.withRetry(() => sol.connection.getTokenSupply(mint));
  const decimals = sup.value.decimals;
  const total = BigInt(sup.value.amount);
  let held = 0n;
  let lines = "";
  for (const s of store.allSources()) {
    const b = await sol.getTokenBalance(new PublicKey(s.publicKey), mint);
    if (b.raw === 0n) continue;
    held += b.raw;
    lines += `${s.id} (${s.group}): ${sol.formatUnits(b.raw, decimals)}\n`;
  }
  const ppm = total > 0n ? (held * 1_000_000n) / total : 0n;
  const pct = Number(ppm) / 10_000;
  const { min, max } = config.monitorBand;
  const inside = pct >= min && pct <= max;

  let curve = "Bonding curve data: unavailable";
  try {
    const c = await pump.getCurveState(mint);
    curve = `Price: ${c.priceText}\nMarket cap: ${c.marketCapText}\nSOL reserves: ${c.solReservesText}\nToken reserves: ${c.tokenReservesText}\nGraduated: ${c.graduated ? "YES" : "NO"}\nFees: ${c.feeText}`;
  } catch (e) {
    if (!(e instanceof pump.PumpNotImplementedError)) curve = `Bonding curve data: ${sol.friendlyError(e)}`;
  }
  await sendLong(
    ctx,
    `📊 TOKEN ANALYTICS\nMint:\n${mint.toBase58()}\n\n${curve}\n\nTotal supply: ${sol.formatUnits(total, decimals)}\nOperator-controlled holdings (master + treasury + Chusi):\n${lines || "none\n"}Combined: ${sol.formatUnits(held, decimals)}\n\nControlled-wallet share: ${pct.toFixed(2)}%\nMonitoring range: ${min}%–${max}%\nStatus: ${inside ? "INSIDE RANGE" : "OUTSIDE RANGE"}${inside ? "" : "\nNo automatic corrective trading performed."}\n\nThese wallets are operator-controlled, not independent holders.`,
  );
}

// ---------- flow starters ----------
async function startFund(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  if (store.getWallets().length === 0) return void (await ctx.reply("No wallets yet. Create one first."));
  flows.set(ctx.from!.id, { kind: "fund", step: "wallet" });
  await ctx.reply("Select wallet to fund (or type its ID):", walletKb({}));
}
async function startPayout(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  flows.set(ctx.from!.id, { kind: "payout" });
  const bal = await sol.getSolBalance(config.master.publicKey);
  await ctx.reply(
    `📤 Payout\nDestination: ${sol.short(config.payoutWallet)}\nMaster balance: ${sol.formatSol(bal)} SOL\nMax: ${config.maxPayoutSol} SOL\n\nEnter SOL amount (/cancel to abort):`,
  );
}
async function startCreate(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  flows.set(ctx.from!.id, { kind: "create", step: "name" });
  await ctx.reply("🚀 Create Coin\nEnter token NAME (/cancel to abort):");
}
async function startTrade(ctx: Context, side: "buy" | "sell"): Promise<void> {
  if (!(await owner(ctx))) return;
  flows.set(ctx.from!.id, { kind: "trade", side, step: "mint" });
  await askCoin(ctx, side === "buy" ? "🛒 Buy" : "💸 Sell");
}
async function startAnalytics(ctx: Context): Promise<void> {
  if (!(await gate(ctx))) return;
  flows.set(ctx.from!.id, { kind: "analytics" });
  await askCoin(ctx, "📊 Token Analytics");
}
async function startMulti(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  flows.set(ctx.from!.id, { kind: "multi", step: "count" });
  await ctx.reply("➕ Add Wallets (Chusi Wallets)\nHow many new wallets? (1-50)");
}
async function startSellAll(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  flows.set(ctx.from!.id, { kind: "sellall", step: "coin" });
  await askCoin(ctx, "💥 Sell from ALL wallets (master + treasury + Chusi)");
}
async function startBurn(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  flows.set(ctx.from!.id, { kind: "burn", step: "coin" });
  await askCoin(ctx, "🔥 Burn supply (irreversible)");
}
async function startSend(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  if (store.getWallets().length === 0) return void (await ctx.reply("No wallets yet."));
  flows.set(ctx.from!.id, { kind: "send", step: "wallet" });
  await ctx.reply("📤 Send SOL out of a wallet.\nSelect source (or type its ID):", walletKb({ all: true }));
}

// ---------- coin selected ----------
async function onMint(ctx: Context, uid: number, f: Flow, mint: PublicKey): Promise<void> {
  if (f.kind === "analytics") {
    flows.delete(uid);
    return runAnalytics(ctx, mint.toBase58());
  }
  if (f.kind === "trade") {
    const c = await pump.getCurveState(mint);
    if (c.graduated) {
      flows.delete(uid);
      return void (await ctx.reply(GRAD_MSG));
    }
    flows.set(uid, { ...f, step: "wallet", mint });
    return void (await ctx.reply("Select source wallet (or type its ID, e.g. M, W1, C3):", walletKb({ master: true })));
  }
  if (f.kind === "sellall") {
    const c = await pump.getCurveState(mint);
    if (c.graduated) {
      flows.delete(uid);
      return void (await ctx.reply(GRAD_MSG));
    }
    flows.set(uid, { kind: "sellall", step: "pct", mint });
    return void (await ctx.reply("Sell what share of every wallet's tokens?", pctKb()));
  }
  if (f.kind === "burn") {
    flows.set(uid, { kind: "burn", step: "scope", mint });
    return void (await ctx.reply(
      "Burn from:",
      Markup.inlineKeyboard([[Markup.button.callback("Master only", "s:master"), Markup.button.callback("All wallets", "s:all")]]),
    ));
  }
}

// ---------- wallet selected ----------
async function onWallet(ctx: Context, uid: number, f: Flow, id: string): Promise<void> {
  if (f.kind === "fund" && f.step === "wallet") {
    if (id === "M" || !store.getWallet(id)) throw new Error("Wallet not found");
    flows.set(uid, { kind: "fund", step: "amount", walletId: id });
    return void (await ctx.reply(`Enter SOL amount to send to ${id} (max ${config.maxSingleFundSol}):`));
  }
  if (f.kind === "send" && f.step === "wallet") {
    if (id !== "ALL" && !store.getWallet(id)) throw new Error("Wallet not found");
    flows.set(uid, { kind: "send", step: "addr", walletId: id });
    return void (await ctx.reply("Enter destination Solana address:"));
  }
  if (f.kind === "trade" && f.step === "wallet" && f.mint) {
    if (!store.signerFor(id)) throw new Error("Wallet not found");
    flows.set(uid, { ...f, step: "amount", walletId: id });
    if (f.side === "buy") return void (await ctx.reply(`Enter SOL amount (max ${config.maxSingleBuySol}):`));
    const kp = store.signerFor(id)!;
    const tb = await sol.getTokenBalance(kp.publicKey, f.mint);
    return void (await ctx.reply(
      `${id} holds ${sol.formatUnits(tb.raw, tb.decimals)} tokens.\nSell how much? Tap a share or type a token amount:`,
      pctKb(),
    ));
  }
}

// ---------- percent selected ----------
async function onPercent(ctx: Context, uid: number, f: Flow, pct: number): Promise<void> {
  if (f.kind === "sellall" && f.step === "pct" && f.mint) return planSellAll(ctx, uid, f.mint, pct);
  if (f.kind === "burn" && f.step === "pct" && f.mint && f.scope) return planBurn(ctx, uid, f.mint, f.scope, pct);
  if (f.kind === "trade" && f.side === "sell" && f.step === "amount" && f.mint && f.walletId) {
    return planSellOne(ctx, uid, f.mint, f.walletId, { pct });
  }
}

async function feePayerFor(id: string): Promise<Keypair | undefined> {
  if (id === "M") return undefined;
  return (await sol.getSolBalance(config.master.publicKey)) >= 2_000_000n ? config.master : undefined;
}

interface Holding {
  id: string;
  raw: bigint;
  decimals: number;
}
async function holdings(mint: PublicKey, pct: number, onlyMaster: boolean): Promise<Holding[]> {
  const sources = onlyMaster ? store.allSources().filter((s) => s.id === "M") : store.allSources();
  const out: Holding[] = [];
  for (let i = 0; i < sources.length; i += 10) {
    const chunk = sources.slice(i, i + 10);
    const bals = await Promise.all(chunk.map((s) => sol.getTokenBalance(new PublicKey(s.publicKey), mint)));
    chunk.forEach((s, j) => {
      const raw = (bals[j].raw * BigInt(pct)) / 100n;
      if (raw > 0n) out.push({ id: s.id, raw, decimals: bals[j].decimals });
    });
  }
  return out;
}

async function planSellOne(
  ctx: Context,
  uid: number,
  mint: PublicKey,
  walletId: string,
  amount: { pct: number } | { text: string },
): Promise<void> {
  const kp = store.signerFor(walletId);
  if (!kp) throw new Error("Wallet not found");
  const tb = await sol.getTokenBalance(kp.publicKey, mint);
  const raw = "pct" in amount ? (tb.raw * BigInt(amount.pct)) / 100n : sol.parseDecimal(amount.text, tb.decimals);
  if (raw <= 0n) throw new Error("Invalid token amount");
  if (raw > tb.raw) throw new Error("Sell amount exceeds wallet token balance.");
  const q = await pump.quoteSell(mint, raw, config.slippageBps);
  const payer = await feePayerFor(walletId);
  flows.delete(uid);
  await askConfirm(
    ctx,
    `Action: SELL\nToken: ${mint.toBase58()}\nWallet: ${walletId} ${sol.short(kp.publicKey)}\nAmount: ${sol.formatUnits(raw, tb.decimals)}\nExpected: ~${sol.formatSol(q.estLamports)} SOL (re-priced live at execution)\nSlippage: ${config.slippagePercent}%\nNetwork fee paid by: ${payer ? "master wallet" : "this wallet"}`,
    `wallet:${walletId}`,
    async () => {
      const sig = await pump.sell(mint, kp, raw, config.slippageBps, payer);
      disclosure.record({ type: "sold", walletId, publicKey: kp.publicKey.toBase58(), signature: sig, note: `sold ${sol.formatUnits(raw, tb.decimals)} of ${mint.toBase58()}` });
      return `✅ Sell submitted\n${sol.txLink(sig)}`;
    },
  );
}

async function planSellAll(ctx: Context, uid: number, mint: PublicKey, pct: number): Promise<void> {
  const rows = await holdings(mint, pct, false);
  if (rows.length === 0) throw new Error("No wallet holds this token.");
  const decimals = rows[0].decimals;
  const total = rows.reduce((a, r) => a + r.raw, 0n);
  const q = await pump.quoteSell(mint, total, config.slippageBps);
  const fee = await sol.sellFeeEstimate(config.master);
  const needed = fee * BigInt(rows.filter((r) => r.id !== "M").length);
  const mbal = await sol.getSolBalance(config.master.publicKey);
  if (mbal < needed + sol.FEE_BUFFER_LAMPORTS) {
    throw new Error(`Master wallet needs about ${sol.formatSol(needed + sol.FEE_BUFFER_LAMPORTS, 5)} SOL to pay network fees.`);
  }
  flows.delete(uid);
  const list = rows.map((r) => `${r.id}: ${sol.formatUnits(r.raw, decimals)}`);
  await askConfirm(
    ctx,
    `Action: SELL ${pct}% FROM ALL WALLETS\nToken: ${mint.toBase58()}\nWallets: ${rows.length}\n${clip(list)}\n\nTotal: ${sol.formatUnits(total, decimals)}\nEstimated proceeds: ~${sol.formatSol(q.estLamports)} SOL (each sell is re-priced live; later sells get lower prices)\nNetwork fee: ~${sol.formatSol(fee, 6)} SOL per wallet, paid by master (live estimate)\nProceeds STAY in each wallet.\nSlippage: ${config.slippagePercent}%`,
    "sellall",
    async () => {
      const out: string[] = [];
      let ok = 0;
      for (let i = 0; i < rows.length; i += 5) {
        const chunk = rows.slice(i, i + 5);
        const res = await Promise.allSettled(
          chunk.map(async (r) => {
            const kp = store.signerFor(r.id);
            if (!kp) throw new Error("Wallet not found");
            const payer = r.id === "M" ? undefined : config.master;
            return sol.withLock(`wallet:${r.id}`, () => pump.sell(mint, kp, r.raw, config.slippageBps, payer));
          }),
        );
        res.forEach((x, j) => {
          const r = chunk[j];
          if (x.status === "fulfilled") {
            ok++;
            disclosure.record({ type: "sold", walletId: r.id, signature: x.value, note: `sold ${sol.formatUnits(r.raw, decimals)} of ${mint.toBase58()}` });
            out.push(`${r.id} ✅ ${sol.txLink(x.value)}`);
          } else {
            out.push(`${r.id} ❌ ${x.reason instanceof sol.LockedError ? "busy" : sol.friendlyError(x.reason)}`);
          }
        });
      }
      return `Sell-all finished: ${ok}/${rows.length} succeeded.\nProceeds stay in each wallet.\n\n${out.join("\n")}`;
    },
  );
}

async function planBurn(ctx: Context, uid: number, mint: PublicKey, scope: "master" | "all", pct: number): Promise<void> {
  const rows = await holdings(mint, pct, scope === "master");
  if (rows.length === 0) throw new Error("Nothing to burn.");
  const decimals = rows[0].decimals;
  const total = rows.reduce((a, r) => a + r.raw, 0n);
  const mbal = await sol.getSolBalance(config.master.publicKey);
  if (mbal < sol.FEE_BUFFER_LAMPORTS) throw new Error("Master wallet needs SOL to pay network fees.");
  flows.delete(uid);
  const list = rows.map((r) => `${r.id}: ${sol.formatUnits(r.raw, decimals)}`);
  await askConfirm(
    ctx,
    `Action: 🔥 BURN ${pct}% (IRREVERSIBLE)\nToken: ${mint.toBase58()}\nFrom: ${scope === "master" ? "master only" : "all wallets"}\n${clip(list)}\n\nTotal burned: ${sol.formatUnits(total, decimals)}\nBurned tokens cannot be recovered.`,
    "burn",
    async () => {
      const out: string[] = [];
      let ok = 0;
      for (let i = 0; i < rows.length; i += 5) {
        const chunk = rows.slice(i, i + 5);
        const res = await Promise.allSettled(
          chunk.map(async (r) => {
            const kp = store.signerFor(r.id);
            if (!kp) throw new Error("Wallet not found");
            const payer = r.id === "M" ? undefined : config.master;
            return sol.withLock(`wallet:${r.id}`, () => tokens.burn(mint, kp, r.raw, r.decimals, payer));
          }),
        );
        res.forEach((x, j) => {
          const r = chunk[j];
          if (x.status === "fulfilled") {
            ok++;
            disclosure.record({ type: "burned", walletId: r.id, signature: x.value, note: `burned ${sol.formatUnits(r.raw, decimals)} of ${mint.toBase58()}` });
            out.push(`${r.id} 🔥 ${sol.txLink(x.value)}`);
          } else {
            out.push(`${r.id} ❌ ${x.reason instanceof sol.LockedError ? "busy" : sol.friendlyError(x.reason)}`);
          }
        });
      }
      return `Burn finished: ${ok}/${rows.length} wallets.\n\n${out.join("\n")}`;
    },
  );
}

// ---------- create coin ----------
async function allocateTop10(mint: PublicKey): Promise<string> {
  try {
    const bal = await sol.getTokenBalance(config.master.publicKey, mint);
    if (bal.raw === 0n) return "\nAllocation skipped: master holds no tokens.";
    const wallets = store.createWallets("chusi", TOP_HOLDER_WALLETS);
    const each = bal.raw / BigInt(TOP_HOLDER_WALLETS);
    const targets = wallets.map((w, i) => ({
      owner: new PublicKey(w.publicKey),
      amount: i === TOP_HOLDER_WALLETS - 1 ? bal.raw - each * BigInt(TOP_HOLDER_WALLETS - 1) : each,
    }));
    const sigs = await tokens.distribute(mint, config.master, targets, bal.decimals);
    wallets.forEach((w, i) => {
      disclosure.record({ type: "allocated", walletId: w.id, publicKey: w.publicKey, signature: sigs[Math.floor(i / 4)], note: `${sol.formatUnits(targets[i].amount, bal.decimals)} of ${mint.toBase58()}` });
    });
    return `\nTop-10 allocation sent to Chusi wallets ${wallets[0].id}–${wallets[wallets.length - 1].id} (each ${sol.formatUnits(each, bal.decimals)}).`;
  } catch (e) {
    return `\n⚠️ Allocation failed: ${sol.friendlyError(e)}\nTokens stay in the master wallet.`;
  }
}

async function confirmCreate(ctx: Context, uid: number, f: CreateFlow, buyLamports: bigint, pct10: number): Promise<void> {
  const name = f.name!;
  const symbol = f.symbol!;
  const extra = pct10 > 0 ? ALLOC_ATA_RENT * BigInt(TOP_HOLDER_WALLETS) : 0n;
  const need = buyLamports + extra + CREATE_COST_BUFFER;
  const mbal = await sol.getSolBalance(config.master.publicKey);
  if (mbal < need) throw new Error(`Insufficient master-wallet balance. Need about ${sol.formatSol(need)} SOL.`);
  const price = await sol.getSolPriceUsd();
  const usd = price ? ` (~$${((Number(buyLamports) / 1e9) * price).toFixed(2)})` : "";
  flows.delete(uid);
  const allocLine =
    pct10 > 0
      ? `Top-10 allocation: ${(pct10 / 10).toFixed(1)}% of supply\nBuy amount: ${sol.formatSol(buyLamports)} SOL${usd}\nSplit across ${TOP_HOLDER_WALLETS} new Chusi wallets (operator-controlled, listed in the public disclosure)\nExtra account rent: ~${sol.formatSol(extra)} SOL`
      : `Initial buy: ${sol.formatSol(buyLamports)} SOL${usd}`;
  const uriLine = f.self
    ? `Metadata: hosted by this bot${f.desc ? "\nDescription: " + f.desc.slice(0, 100) : ""}${f.twitter ? "\nX: " + f.twitter : ""}${f.website ? "\nWebsite: " + f.website : ""}`
    : `URI: ${f.uri}${pct10 > 0 ? `\nAdd this disclosure link to your own metadata: ${config.publicUrl}/disclosure` : ""}`;
  await askConfirm(
    ctx,
    `Action: CREATE COIN\nName: ${name}\nSymbol: ${symbol}\n${uriLine}\n${allocLine}\nMayhem Mode: OFF\nSlippage: ${config.slippagePercent}%`,
    "master",
    async () => {
      let uri = f.uri ?? "";
      if (f.self) {
        let d = f.desc ?? "";
        if (pct10 > 0) d += `${d ? "\n\n" : ""}Dev-controlled wallets are disclosed: ${meta.baseUrl()}/disclosure`;
        uri = await meta.save({ name, symbol, description: d, imageUrl: f.imageUrl, imageFileId: f.imageFileId, twitter: f.twitter, website: f.website }, bot.telegram);
      }
      const r = await pump.createCoin({ name, symbol, uri, creator: config.master, initialBuyLamports: buyLamports, slippageBps: config.slippageBps, mayhemMode: false });
      store.addCoin({ mint: r.mint, name, symbol });
      disclosure.record({ type: "coin_created", signature: r.signature, note: `${symbol} ${r.mint}` });
      const alloc = pct10 > 0 ? await allocateTop10(new PublicKey(r.mint)) : "";
      return {
        text: `🚀 COIN CREATED\nName: ${name}\nSymbol: ${symbol}\nMint: ${r.mint}\nBuy: ${sol.formatSol(buyLamports)} SOL\nTransaction: ${r.signature}\nSolscan: ${sol.txLink(r.signature)}${alloc}`,
        mint: r.mint,
      };
    },
  );
}

function cleanUrl(text: string): string {
  const u = new URL(text);
  if (u.protocol !== "https:") throw new Error("Link must start with https://");
  return u.toString();
}

async function handleCreate(ctx: Context, uid: number, f: CreateFlow, text: string): Promise<void> {
  const skip = text.toUpperCase() === "SKIP";
  switch (f.step) {
    case "name": {
      if (!text || text.length > 32) throw new Error("Name must be 1-32 characters");
      flows.set(uid, { ...f, step: "symbol", name: text });
      return void (await ctx.reply("Enter SYMBOL (e.g. MBABE):"));
    }
    case "symbol": {
      if (!/^[A-Za-z0-9]{1,10}$/.test(text)) throw new Error("Symbol must be 1-10 letters/numbers");
      flows.set(uid, { ...f, step: "uri", symbol: text.toUpperCase() });
      return void (await ctx.reply("Paste a metadata URI (https:// or ipfs://), or type SELF to host description, image and links on this bot:"));
    }
    case "uri": {
      if (text.toUpperCase() === "SELF") {
        meta.baseUrl(); // throws if PUBLIC_URL is missing
        flows.set(uid, { ...f, step: "desc", self: true });
        return void (await ctx.reply("Enter a description (or SKIP):"));
      }
      const u = new URL(text);
      if (u.protocol !== "https:" && u.protocol !== "ipfs:") throw new Error("URI must be https:// or ipfs://");
      flows.set(uid, { ...f, step: "alloc", uri: text });
      return void (await askAlloc(ctx));
    }
    case "desc": {
      flows.set(uid, { ...f, step: "image", desc: skip ? "" : text.slice(0, 500) });
      return void (await ctx.reply("Send a photo, paste an https image link, or SKIP:"));
    }
    case "image": {
      flows.set(uid, { ...f, step: "twitter", imageUrl: skip ? undefined : cleanUrl(text) });
      return void (await ctx.reply("X (Twitter) link or @handle, or SKIP:"));
    }
    case "twitter": {
      let tw: string | undefined;
      if (!skip) tw = text.startsWith("@") ? `https://x.com/${text.slice(1)}` : cleanUrl(text);
      flows.set(uid, { ...f, step: "website", twitter: tw });
      return void (await ctx.reply("Website link (https://…), or SKIP:"));
    }
    case "website": {
      flows.set(uid, { ...f, step: "alloc", website: skip ? undefined : cleanUrl(text) });
      return void (await askAlloc(ctx));
    }
    case "alloc": {
      if (!/^\d+(\.\d)?$/.test(text)) throw new Error("Enter a percent like 10 or 12.5");
      const pct10 = Math.round(Number(text) * 10);
      if (pct10 > 300) throw new Error("Allocation above 30% is refused.");
      if (pct10 === 0) {
        flows.set(uid, { ...f, step: "buy" });
        return void (await ctx.reply(`Initial buy in SOL (0 for none, max ${config.maxSingleBuySol}):`));
      }
      const q = await pump.quoteAllocation(pct10);
      if (q.lamports > BigInt(Math.round(config.maxAllocationSol * 1e9))) {
        throw new Error(`Cost exceeds MAX_ALLOCATION_SOL (${config.maxAllocationSol}).`);
      }
      return confirmCreate(ctx, uid, f, q.lamports, pct10);
    }
    case "buy": {
      const lamports = text === "0" ? 0n : sol.parseSol(text, config.maxSingleBuySol);
      return confirmCreate(ctx, uid, f, lamports, 0);
    }
  }
}
async function askAlloc(ctx: Context): Promise<void> {
  await ctx.reply(
    "Top-10 holder allocation (0–30%).\nThe bot buys this share at creation and spreads it over 10 new Chusi wallets. They are operator-controlled and listed in the public disclosure.\nEnter a percent, or 0 for none:",
  );
}

// ---------- commands ----------
bot.start(async (ctx) => {
  if (ctx.from && authorized.has(ctx.from.id)) return showMenu(ctx);
  await ctx.reply("🔐 MaterBabe Coin Kirkinator\nAccess required.\nUse:\n/access <key>");
});
bot.command("access", async (ctx) => {
  const key = ctx.message.text.split(/\s+/).slice(1).join(" ");
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
  if (key && key === config.accessKey) {
    authorized.add(ctx.from.id);
    await ctx.reply("✅ Access granted.");
    return showMenu(ctx);
  }
  await ctx.reply("❌ Invalid key.");
});
bot.help(async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.reply(
    "/start /help /status /balance /wallets /wallet <id> /create /fund /buy /sell /sellall /burn /multi (Add Wallets) /send /token /analytics /payout /admin /disclosure /clear /recover <count> /cancel\n\nMoney commands are owner-only and need confirmation.",
  );
});
bot.command("status", showStatus);
bot.command("balance", showBalances);
bot.command("wallets", showWallets);
bot.command("wallet", async (ctx) => {
  if (!(await owner(ctx))) return;
  const w = store.getWallet(ctx.message.text.split(/\s+/)[1]?.toUpperCase() ?? "");
  if (!w) return void (await ctx.reply("Wallet not found."));
  const bal = await sol.getSolBalance(new PublicKey(w.publicKey));
  await ctx.reply(`${w.id} (${w.group})\n${w.publicKey}\n${sol.formatSol(bal)} SOL`);
});
bot.command("create", startCreate);
bot.command("fund", startFund);
bot.command("buy", (ctx) => startTrade(ctx, "buy"));
bot.command("sell", (ctx) => startTrade(ctx, "sell"));
bot.command(["token", "holders", "analytics"], startAnalytics);
bot.command("payout", startPayout);
bot.command("admin", showAdmin);
bot.command("multi", startMulti);
bot.command("sellall", startSellAll);
bot.command("burn", startBurn);
bot.command("send", startSend);
bot.command("disclosure", sendDisclosure);
bot.command("clear", (ctx) => clearChat(ctx, ctx.message.message_id));
bot.command("recover", async (ctx) => {
  if (!(await owner(ctx))) return;
  const n = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isInteger(n) || n < 1 || n > 500) return void (await ctx.reply("Usage: /recover <count 1-500>"));
  const added = store.recoverRange(n);
  await ctx.reply(`Registered ${added} derived wallets as treasury (indexes 0–${n - 1}). Check /balance.`);
});
bot.command("cancel", async (ctx) => {
  flows.delete(ctx.from.id);
  await ctx.reply("Cancelled.");
});

// ---------- buttons ----------
const routes: Record<string, (ctx: Context) => Promise<void>> = {
  create: startCreate,
  bal: showBalances,
  wallets: showWallets,
  buy: (c) => startTrade(c, "buy"),
  sell: (c) => startTrade(c, "sell"),
  analytics: startAnalytics,
  payout: startPayout,
  admin: showAdmin,
  newwallet: newWallet,
  fund: startFund,
  multi: startMulti,
  sellall: startSellAll,
  burn: startBurn,
  send: startSend,
  disclosure: sendDisclosure,
  clear: (c) =>
    clearChat(c, (c.callbackQuery && "message" in c.callbackQuery ? c.callbackQuery.message?.message_id : undefined) ?? 0),
};
bot.action(/^m:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fn = routes[ctx.match[1]];
  if (fn) await safe(ctx, () => fn(ctx));
});
bot.action("a:limits", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  await ctx.reply(
    `Max buy: ${config.maxSingleBuySol} SOL\nMax allocation buy: ${config.maxAllocationSol} SOL\nMax fund: ${config.maxSingleFundSol} SOL\nMax Add Wallets total: ${config.maxMultiTotalSol} SOL\nMax send out: ${config.maxWalletSendSol} SOL\nMax payout: ${config.maxPayoutSol} SOL\nSlippage: ${config.slippagePercent}%\n\nChange via environment variables and redeploy.`,
  );
});
bot.action("a:reset", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  flows.clear();
  confirms.clear();
  await ctx.reply("Conversation state cleared. Wallets and balances are untouched.");
});

bot.action(/^k:(\d+|other)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from!.id;
  const f = flows.get(uid);
  if (!f) return;
  if (f.kind === "analytics" ? !(await gate(ctx)) : !(await owner(ctx))) return;
  const v = ctx.match[1];
  if (v === "other") return void (await ctx.reply("Enter token mint address:"));
  const coin = store.getCoins()[Number(v)];
  if (!coin) return;
  await safe(ctx, () => onMint(ctx, uid, f, new PublicKey(coin.mint)));
});
bot.action(/^w:(M|ALL|[WC]\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  const uid = ctx.from!.id;
  const f = flows.get(uid);
  if (!f) return void (await ctx.reply("Nothing to select. Start again from the menu."));
  await safe(ctx, () => onWallet(ctx, uid, f, ctx.match[1]));
});
bot.action(/^p:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  const uid = ctx.from!.id;
  const f = flows.get(uid);
  if (!f) return;
  await safe(ctx, () => onPercent(ctx, uid, f, Number(ctx.match[1])));
});
bot.action(/^s:(master|all)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  const uid = ctx.from!.id;
  const f = flows.get(uid);
  if (f?.kind === "burn" && f.step === "scope" && f.mint) {
    flows.set(uid, { kind: "burn", step: "pct", mint: f.mint, scope: ctx.match[1] as "master" | "all" });
    await ctx.reply("Burn what share?", pctKb());
  }
});

bot.action(/^x:([0-9a-f]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  confirms.delete(ctx.match[1]);
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
  await ctx.reply("Cancelled. No transaction was submitted.");
});

bot.action(/^c:([0-9a-f]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  const id = ctx.match[1];
  const c = confirms.get(id);
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
  if (!c || c.userId !== ctx.from!.id || c.expires < Date.now()) {
    confirms.delete(id);
    return void (await ctx.reply("This confirmation expired or was already used."));
  }
  confirms.delete(id); // single use => double-click protection
  try {
    const out = await sol.withLock(c.lockKey, c.run);
    if (typeof out === "string") {
      await sendLong(ctx, out);
    } else {
      await sendLong(ctx, out.text);
      await sendCa(ctx, out.mint);
    }
  } catch (e) {
    if (e instanceof sol.LockedError) {
      await ctx.reply("⏳ A transaction is already being processed for this wallet.");
    } else {
      console.error("Transaction error:", e instanceof Error ? e.message : "unknown");
      await ctx.reply(`❌ Transaction failed\nReason:\n${sol.friendlyError(e)}`);
    }
  }
});

// ---------- photo + text input ----------
bot.on("photo", async (ctx) => {
  const uid = ctx.from.id;
  const f = flows.get(uid);
  if (uid !== config.ownerTelegramId || f?.kind !== "create" || f.step !== "image") return;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  flows.set(uid, { ...f, step: "twitter", imageFileId: photo.file_id });
  await ctx.reply("Got the image. X (Twitter) link or @handle, or SKIP:");
});

bot.on("text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  const uid = ctx.from.id;
  const f = flows.get(uid);
  if (!f) return;
  if (!authorized.has(uid)) return void (await gate(ctx));
  await safe(ctx, () => handleFlow(ctx, uid, f, text));
});

async function handleFlow(ctx: Context, uid: number, f: Flow, text: string): Promise<void> {
  if (f.kind === "analytics") {
    flows.delete(uid);
    return runAnalytics(ctx, text);
  }
  if (uid !== config.ownerTelegramId) return void (await ctx.reply("⛔ Owner only."));

  const wantsMint =
    (f.kind === "trade" && f.step === "mint") ||
    ((f.kind === "sellall" || f.kind === "burn") && (f.step === "coin" || f.step === "mint"));
  if (wantsMint) return onMint(ctx, uid, f, sol.parsePublicKey(text));

  if ((f.kind === "fund" || f.kind === "send" || f.kind === "trade") && f.step === "wallet" && /^(M|ALL|[WC]\d+)$/i.test(text)) {
    return onWallet(ctx, uid, f, text.toUpperCase());
  }

  if ((f.kind === "sellall" || f.kind === "burn") && f.step === "pct") {
    const pct = Number(text);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new Error("Enter a whole number from 1 to 100");
    return onPercent(ctx, uid, f, pct);
  }

  if (f.kind === "create") return handleCreate(ctx, uid, f, text);

  if (f.kind === "trade" && f.step === "amount" && f.mint && f.walletId) {
    const mint = f.mint;
    const wid = f.walletId;
    if (f.side === "sell") return planSellOne(ctx, uid, mint, wid, { text });
    const kp = store.signerFor(wid);
    if (!kp) throw new Error("Wallet not found");
    const lamports = sol.parseSol(text, config.maxSingleBuySol);
    const bal = await sol.getSolBalance(kp.publicKey);
    if (bal < lamports + sol.FEE_BUFFER_LAMPORTS / 2n) throw new Error("Insufficient SOL balance.");
    const q = await pump.quoteBuy(mint, lamports, config.slippageBps);
    const tb = await sol.getTokenBalance(kp.publicKey, mint);
    flows.delete(uid);
    return askConfirm(
      ctx,
      `Action: BUY\nToken: ${mint.toBase58()}\nWallet: ${wid} ${sol.short(kp.publicKey)}\nSOL input: ${sol.formatSol(lamports)} SOL\nEstimated tokens: ${sol.formatUnits(q.estTokensRaw, tb.decimals)}\nSlippage: ${config.slippagePercent}%\nFees: calculated by SDK`,
      `wallet:${wid}`,
      async () => {
        const sig = await pump.buy(mint, kp, lamports, config.slippageBps);
        return `✅ Buy submitted\n${sol.txLink(sig)}`;
      },
    );
  }

  if (f.kind === "fund" && f.step === "amount" && f.walletId) {
    const w = store.getWallet(f.walletId);
    if (!w) throw new Error("Wallet not found");
    const lamports = sol.parseSol(text, config.maxSingleFundSol);
    const master = await sol.getSolBalance(config.master.publicKey);
    if (master < lamports + sol.FEE_BUFFER_LAMPORTS) throw new Error("Insufficient master-wallet balance.");
    const cur = await sol.getSolBalance(new PublicKey(w.publicKey));
    if (cur + lamports < sol.RENT_EXEMPT_MIN_LAMPORTS) throw new Error("Amount too small for a new account (min ~0.00089 SOL).");
    flows.delete(uid);
    return askConfirm(
      ctx,
      `Action: FUND\nFrom: Master ${sol.short(config.master.publicKey)}\nTo: ${w.id} ${sol.short(w.publicKey)}\nAmount: ${sol.formatSol(lamports)} SOL`,
      "master",
      async () => {
        const sig = await sol.transferSol(config.master, new PublicKey(w.publicKey), lamports);
        disclosure.record({ type: "funded", walletId: w.id, publicKey: w.publicKey, lamports: lamports.toString(), signature: sig });
        return `✅ Funded ${w.id} with ${sol.formatSol(lamports)} SOL\n${sol.txLink(sig)}`;
      },
    );
  }

  if (f.kind === "send") {
    if (f.step === "addr") {
      const dest = sol.parsePublicKey(text);
      flows.set(uid, { kind: "send", step: "amount", walletId: f.walletId, dest });
      return void (await ctx.reply(
        f.walletId === "ALL"
          ? "Type MAX to send every wallet's full SOL balance (minus the exact current network fee):"
          : `Enter SOL amount (max ${config.maxWalletSendSol}), or MAX for the full balance minus the exact fee:`,
      ));
    }
    if (f.step === "amount" && f.dest && f.walletId) {
      const dest = f.dest;
      const isMax = text.toUpperCase() === "MAX";
      if (f.walletId === "ALL" && !isMax) throw new Error("For all wallets, type MAX");
      const ids = f.walletId === "ALL" ? store.getWallets().map((w) => w.id) : [f.walletId];
      const fee = await sol.transferFeeLamports(config.master);
      const plan: { id: string; lamports: bigint }[] = [];
      let sum = 0n;
      for (const wid of ids) {
        const w = store.getWallet(wid);
        if (!w) throw new Error("Wallet not found");
        const bal = await sol.getSolBalance(new PublicKey(w.publicKey));
        const amt = isMax ? bal - fee : sol.parseSol(text, config.maxWalletSendSol);
        if (isMax && amt <= 0n) continue;
        if (bal < amt + fee) throw new Error(`Insufficient SOL balance in ${wid}.`);
        plan.push({ id: wid, lamports: amt });
        sum += amt;
      }
      if (plan.length === 0) throw new Error("Nothing to send.");
      if (sum > BigInt(Math.round(config.maxWalletSendSol * 1e9))) {
        throw new Error(`Total exceeds MAX_WALLET_SEND_SOL (${config.maxWalletSendSol}).`);
      }
      const destBal = await sol.getSolBalance(dest);
      if (destBal === 0n && plan[0].lamports < sol.RENT_EXEMPT_MIN_LAMPORTS) {
        throw new Error("Destination is a new account; the first amount must be at least ~0.00089 SOL.");
      }
      flows.delete(uid);
      const list = plan.map((p) => `${p.id}: ${sol.formatSol(p.lamports, 6)} SOL`);
      return askConfirm(
        ctx,
        `Action: SEND SOL OUT\nTo (check carefully):\n${dest.toBase58()}\n\n${clip(list)}\n\nTotal: ${sol.formatSol(sum, 6)} SOL\nNetwork fee per wallet (live): ${sol.formatSol(fee, 6)} SOL${isMax ? " — already deducted from each amount" : ""}`,
        "sendout",
        async () => {
          const out: string[] = [];
          for (const p of plan) {
            try {
              const kp = store.signerFor(p.id);
              if (!kp) throw new Error("Wallet not found");
              const sig = await sol.withLock(`wallet:${p.id}`, () => sol.transferSol(kp, dest, p.lamports));
              disclosure.record({ type: "sent", walletId: p.id, publicKey: kp.publicKey.toBase58(), lamports: p.lamports.toString(), signature: sig, note: `to ${dest.toBase58()}` });
              out.push(`${p.id} ✅ ${sol.formatSol(p.lamports, 6)} SOL ${sol.txLink(sig)}`);
            } catch (e) {
              out.push(`${p.id} ❌ ${e instanceof sol.LockedError ? "busy" : sol.friendlyError(e)}`);
            }
          }
          return `Send finished.\n\n${out.join("\n")}`;
        },
      );
    }
  }

  if (f.kind === "payout") {
    const lamports = sol.parseSol(text, config.maxPayoutSol);
    const bal = await sol.getSolBalance(config.master.publicKey);
    if (bal < lamports + sol.FEE_BUFFER_LAMPORTS) throw new Error("Insufficient master-wallet balance.");
    flows.delete(uid);
    return askConfirm(
      ctx,
      `Action: PAYOUT\nTo: ${config.payoutWallet.toBase58()}\nAmount: ${sol.formatSol(lamports)} SOL\nMaster balance: ${sol.formatSol(bal)} SOL`,
      "master",
      async () => {
        const sig = await sol.transferSol(config.master, config.payoutWallet, lamports);
        return `✅ Payout sent: ${sol.formatSol(lamports)} SOL\n${sol.txLink(sig)}`;
      },
    );
  }

  if (f.kind === "multi") {
    if (f.step === "count") {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("Enter a whole number from 1 to 50");
      flows.set(uid, { kind: "multi", step: "total", count: n });
      return void (await ctx.reply(
        `Total SOL to split across ${n} Chusi wallets (min ${sol.formatSol(MIN_PER_WALLET * BigInt(n))}, max ${config.maxMultiTotalSol}):`,
      ));
    }
    const n = f.count ?? 0;
    const total = sol.parseSol(text, config.maxMultiTotalSol);
    const bal = await sol.getSolBalance(config.master.publicKey);
    if (bal < total + sol.FEE_BUFFER_LAMPORTS) throw new Error("Insufficient master-wallet balance.");
    const shares = sol.randomSplit(total, n, MIN_PER_WALLET);
    flows.delete(uid);
    const preview = shares.map((s, i) => `#${i + 1}: ${(Number((s * 10000n) / total) / 100).toFixed(2)}% (${sol.formatSol(s)} SOL)`);
    return askConfirm(
      ctx,
      `Action: ADD WALLETS\nNew Chusi wallets: ${n}\nTotal: ${sol.formatSol(total)} SOL\nRandom split:\n${clip(preview, 50)}\n\nChusi wallets are operator-controlled and recorded in the disclosure file.`,
      "master",
      async () => {
        const wallets = store.createWallets("chusi", n);
        for (const w of wallets) disclosure.record({ type: "wallet_created", walletId: w.id, publicKey: w.publicKey });
        const lines: string[] = [];
        let err = "";
        for (let i = 0; i < wallets.length; i += 10) {
          const slice = wallets.slice(i, i + 10);
          try {
            const ixs = slice.map((w, j) => SystemProgram.transfer({ fromPubkey: config.master.publicKey, toPubkey: new PublicKey(w.publicKey), lamports: shares[i + j] }));
            const sig = await sol.sendTx(ixs, [config.master]);
            slice.forEach((w, j) => {
              disclosure.record({ type: "funded", walletId: w.id, publicKey: w.publicKey, lamports: shares[i + j].toString(), signature: sig });
              lines.push(`${w.id} ${sol.short(w.publicKey)} ${sol.formatSol(shares[i + j])} SOL`);
            });
          } catch (e) {
            err = sol.friendlyError(e);
            slice.forEach((w) => lines.push(`${w.id} ${sol.short(w.publicKey)} NOT FUNDED`));
            break;
          }
        }
        return `${err ? `⚠️ Stopped early: ${err}\n` : "✅ "}Chusi wallets added\n${lines.join("\n")}\n\nRecorded. Use /disclosure for the public file.`;
      },
    );
  }
}

bot.catch((err) => console.error("Bot error:", err instanceof Error ? err.message : "unknown"));

// ---------- startup ----------
async function main(): Promise<void> {
  console.log("Loading configuration...");
  console.log("Loading wallet registry...");
  store.loadStore();
  console.log("Connecting to Solana...");
  console.log("Checking network...");
  await sol.verifyMainnet();
  console.log("Checking master balance...");
  const bal = await sol.getSolBalance(config.master.publicKey);
  console.log("Starting Telegram bot...");
  await bot.telegram.getMe();
  startServer(config.port, disclosure.render);
  bot.launch().catch((e) => {
    console.error("Telegram launch failed:", e instanceof Error ? e.message : "unknown");
    process.exit(1);
  });
  console.log(
    `🟢 MaterBabe Coin Kirkinator online\nNetwork: Solana Mainnet\nRPC: connected (${config.rpcLabel})\nMaster wallet: ${sol.short(config.master.publicKey)} (${sol.formatSol(bal)} SOL)\nData dir: ${config.dataDir}`,
  );
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

main().catch((e) => {
  console.error("Startup failed:", e instanceof Error ? e.message : "unknown");
  process.exit(1);
});
