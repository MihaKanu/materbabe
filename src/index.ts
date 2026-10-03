import http from "node:http";
import { randomBytes } from "node:crypto";
import { Context, Markup, Telegraf } from "telegraf";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import * as sol from "./solana.js";
import * as store from "./store.js";
import * as pump from "./pump.js";

const bot = new Telegraf(config.telegramToken);
const authorized = new Set<number>();

type Flow =
  | { kind: "fund"; step: "wallet" | "amount"; walletId?: string }
  | { kind: "payout" }
  | { kind: "create"; step: "name" | "symbol" | "uri" | "buy"; name?: string; symbol?: string; uri?: string }
  | { kind: "trade"; side: "buy" | "sell"; step: "mint" | "wallet" | "amount"; mint?: PublicKey; walletId?: string }
  | { kind: "analytics" };

interface Confirm {
  userId: number;
  lockKey: string;
  run: () => Promise<string>;
  expires: number;
}
const flows = new Map<number, Flow>();
const confirms = new Map<string, Confirm>();

// ---------- guards ----------
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

const menuKb = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🚀 Create Coin", "m:create"), Markup.button.callback("💰 Balances", "m:bal")],
    [Markup.button.callback("👛 Treasury Wallets", "m:wallets"), Markup.button.callback("🛒 Buy", "m:buy")],
    [Markup.button.callback("💸 Sell", "m:sell"), Markup.button.callback("📊 Token Analytics", "m:analytics")],
    [Markup.button.callback("📤 Payout", "m:payout"), Markup.button.callback("⚙️ Admin", "m:admin")],
  ]);

async function showMenu(ctx: Context): Promise<void> {
  if (!(await gate(ctx))) return;
  await ctx.reply(
    "🪙 MaterBabe Coin Kirkinator\nCreated by: YYLuccys Mom\nMainnet: ONLINE",
    menuKb(),
  );
}

// ---------- views ----------
async function showBalances(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  const m = config.master.publicKey;
  let out = `💰 Balances\n\nMaster ${sol.short(m)}\n${sol.formatSol(await sol.getSolBalance(m))} SOL\n`;
  for (const w of store.getWallets()) {
    out += `\n${w.id} ${sol.short(w.publicKey)}\n${sol.formatSol(await sol.getSolBalance(new PublicKey(w.publicKey)))} SOL\n`;
  }
  await ctx.reply(out, Markup.inlineKeyboard([[Markup.button.callback("🔄 Refresh", "m:bal")]]));
}

async function showWallets(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  const m = config.master.publicKey;
  let out = `👛 Treasury\n\nMaster\n${sol.short(m)}\n${sol.formatSol(await sol.getSolBalance(m))} SOL\n`;
  for (const w of store.getWallets()) {
    out += `\n${w.id}\n${sol.short(w.publicKey)}\n${sol.formatSol(await sol.getSolBalance(new PublicKey(w.publicKey)))} SOL\n`;
  }
  await ctx.reply(
    out,
    Markup.inlineKeyboard([
      [Markup.button.callback("Create Wallet", "m:newwallet"), Markup.button.callback("Fund Wallet", "m:fund")],
      [Markup.button.callback("Refresh", "m:wallets")],
    ]),
  );
}

async function newWallet(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  const w = store.createWallet();
  console.log("Wallet created", w.id, sol.short(w.publicKey));
  await ctx.reply(
    `✅ Treasury wallet created\nWallet ID:\n${w.id}\nAddress:\n${w.publicKey}\n⚠️ This wallet is controlled by the bot.`,
  );
}

async function showAdmin(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  await ctx.reply(
    "⚙️ ADMIN",
    Markup.inlineKeyboard([
      [Markup.button.callback("Master Balance", "m:bal"), Markup.button.callback("View Treasury", "m:wallets")],
      [Markup.button.callback("Create Treasury Wallet", "m:newwallet"), Markup.button.callback("Fund Treasury", "m:fund")],
      [Markup.button.callback("Limits", "a:limits"), Markup.button.callback("Token Analytics", "m:analytics")],
      [Markup.button.callback("Payout", "m:payout"), Markup.button.callback("Restart State", "a:reset")],
    ]),
  );
}

async function showStatus(ctx: Context): Promise<void> {
  if (!(await gate(ctx))) return;
  const bal = await sol.getSolBalance(config.master.publicKey);
  await ctx.reply(
    `Network: Solana Mainnet\nRPC: ${config.rpcLabel}\nMaster: ${sol.short(config.master.publicKey)} (${sol.formatSol(bal)} SOL)\nTreasury wallets: ${store.getWallets().length}\nSlippage: ${config.slippagePercent}%\nPump module: NOT IMPLEMENTED (create/buy/sell disabled)`,
  );
}

// ---------- flow starters ----------
async function startFund(ctx: Context): Promise<void> {
  if (!(await owner(ctx))) return;
  const ws = store.getWallets();
  if (ws.length === 0) return void (await ctx.reply("No treasury wallets yet. Create one first."));
  flows.set(ctx.from!.id, { kind: "fund", step: "wallet" });
  await ctx.reply("Select wallet to fund:", walletKb());
}
function walletKb() {
  return Markup.inlineKeyboard(
    store.getWallets().map((w) => [Markup.button.callback(`${w.id} ${sol.short(w.publicKey)}`, `w:${w.id}`)]),
  );
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
  await ctx.reply(`${side === "buy" ? "🛒 Buy" : "💸 Sell"}\nEnter token mint address:`);
}
async function startAnalytics(ctx: Context): Promise<void> {
  if (!(await gate(ctx))) return;
  flows.set(ctx.from!.id, { kind: "analytics" });
  await ctx.reply("📊 Enter token mint address:");
}

// ---------- confirmation ----------
async function askConfirm(
  ctx: Context,
  summary: string,
  lockKey: string,
  run: () => Promise<string>,
): Promise<void> {
  const id = randomBytes(6).toString("hex");
  confirms.set(id, { userId: ctx.from!.id, lockKey, run, expires: Date.now() + 5 * 60_000 });
  await ctx.reply(
    `⚠️ CONFIRM TRANSACTION\n${summary}\n\nProceed?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirm", `c:${id}`), Markup.button.callback("❌ Cancel", `x:${id}`)],
    ]),
  );
}

// ---------- analytics ----------
async function runAnalytics(ctx: Context, text: string): Promise<void> {
  const mint = sol.parsePublicKey(text);
  const sup = await sol.withRetry(() => sol.connection.getTokenSupply(mint));
  const decimals = sup.value.decimals;
  const total = BigInt(sup.value.amount);
  let held = 0n;
  const ws = store.getWallets();
  let lines = "";
  for (const w of ws) {
    const b = await sol.getTokenBalance(new PublicKey(w.publicKey), mint);
    held += b.raw;
    lines += `${w.id}: ${sol.formatUnits(b.raw, decimals)}\n`;
  }
  const ppm = total > 0n ? (held * 1_000_000n) / total : 0n;
  const pct = Number(ppm) / 10_000;
  const { min, max } = config.monitorBand;
  const inside = pct >= min && pct <= max;

  let curve = "Bonding curve data: unavailable (Pump module not implemented)";
  try {
    const c = await pump.getCurveState(mint);
    curve = `Price: ${c.priceText}\nMarket cap: ${c.marketCapText}\nSOL reserves: ${c.solReservesText}\nToken reserves: ${c.tokenReservesText}\nGraduated: ${c.graduated ? "YES" : "NO"}\nFees: ${c.feeText}`;
  } catch (e) {
    if (!(e instanceof pump.PumpNotImplementedError)) throw e;
  }

  await ctx.reply(
    `📊 TOKEN ANALYTICS\nMint:\n${mint.toBase58()}\n\n${curve}\n\nTotal supply: ${sol.formatUnits(total, decimals)}\nKnown treasury wallets: ${ws.length}\n${lines}Combined treasury balance: ${sol.formatUnits(held, decimals)}\n\nControlled-wallet share: ${pct.toFixed(2)}%\nMonitoring range: ${min}%–${max}%\nStatus: ${inside ? "INSIDE RANGE" : "OUTSIDE RANGE"}${inside ? "" : "\nNo automatic corrective trading performed."}\n\nThese wallets are bot-controlled, not independent holders.`,
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
    await ctx.deleteMessage(); // remove the key from chat history
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
    "/start /help /status /balance /wallets /wallet <id> /create /fund /buy /sell /token /holders /analytics /payout /admin /cancel\n\nMoney commands are owner-only and need confirmation.",
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
  await ctx.reply(`${w.id}\n${w.publicKey}\n${sol.formatSol(bal)} SOL`);
});
bot.command("create", startCreate);
bot.command("fund", startFund);
bot.command("buy", (ctx) => startTrade(ctx, "buy"));
bot.command("sell", (ctx) => startTrade(ctx, "sell"));
bot.command(["token", "holders", "analytics"], startAnalytics);
bot.command("payout", startPayout);
bot.command("admin", showAdmin);
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
};
bot.action(/^m:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fn = routes[ctx.match[1]];
  if (fn) await fn(ctx);
});
bot.action("a:limits", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  await ctx.reply(
    `Max buy: ${config.maxSingleBuySol} SOL\nMax fund: ${config.maxSingleFundSol} SOL\nMax payout: ${config.maxPayoutSol} SOL\nSlippage: ${config.slippagePercent}%\n\nChange these via environment variables and redeploy.`,
  );
});
bot.action("a:reset", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  flows.clear();
  confirms.clear();
  await ctx.reply("Conversation state cleared. Wallets and balances are untouched.");
});

bot.action(/^w:(W\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await owner(ctx))) return;
  const f = flows.get(ctx.from!.id);
  const id = ctx.match[1];
  if (!f || !store.getWallet(id)) return void (await ctx.reply("Nothing to select. Start again from the menu."));
  if (f.kind === "fund" && f.step === "wallet") {
    flows.set(ctx.from!.id, { kind: "fund", step: "amount", walletId: id });
    await ctx.reply(`Enter SOL amount to send to ${id} (max ${config.maxSingleFundSol}):`);
  } else if (f.kind === "trade" && f.step === "wallet") {
    flows.set(ctx.from!.id, { ...f, step: "amount", walletId: id });
    await ctx.reply(f.side === "buy" ? `Enter SOL amount (max ${config.maxSingleBuySol}):` : "Enter token amount to sell:");
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
    await ctx.reply(out);
  } catch (e) {
    if (e instanceof sol.LockedError) {
      await ctx.reply("⏳ A transaction is already being processed for this wallet.");
    } else {
      console.error("Transaction error:", e instanceof Error ? e.message : "unknown");
      await ctx.reply(`❌ Transaction failed\nReason:\n${sol.friendlyError(e)}`);
    }
  }
});

// ---------- text input for flows ----------
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  const uid = ctx.from.id;
  const f = flows.get(uid);
  if (!f) return;
  if (!authorized.has(uid)) return void (await gate(ctx));
  try {
    await handleFlow(ctx, uid, f, text);
  } catch (e) {
    await ctx.reply(`❌ ${sol.friendlyError(e)}`);
  }
});

async function handleFlow(ctx: Context, uid: number, f: Flow, text: string): Promise<void> {
  if (f.kind === "analytics") {
    flows.delete(uid);
    return runAnalytics(ctx, text);
  }
  if (uid !== config.ownerTelegramId) return void (await ctx.reply("⛔ Owner only."));

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
        return `✅ Funded ${w.id} with ${sol.formatSol(lamports)} SOL\n${sol.txLink(sig)}`;
      },
    );
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

  if (f.kind === "create") {
    if (f.step === "name") {
      if (!text || text.length > 32) throw new Error("Name must be 1-32 characters");
      flows.set(uid, { ...f, step: "symbol", name: text });
      return void (await ctx.reply("Enter SYMBOL (e.g. MBABE):"));
    }
    if (f.step === "symbol") {
      if (!/^[A-Za-z0-9]{1,10}$/.test(text)) throw new Error("Symbol must be 1-10 letters/numbers");
      flows.set(uid, { ...f, step: "uri", symbol: text.toUpperCase() });
      return void (await ctx.reply("Enter metadata URI (https://… JSON):"));
    }
    if (f.step === "uri") {
      const u = new URL(text);
      if (u.protocol !== "https:" && u.protocol !== "ipfs:") throw new Error("URI must be https:// or ipfs://");
      flows.set(uid, { ...f, step: "buy", uri: text });
      return void (await ctx.reply(`Initial buy in SOL (0 for none, max ${config.maxSingleBuySol}):`));
    }
    const buyLamports = text === "0" ? 0n : sol.parseSol(text, config.maxSingleBuySol);
    flows.delete(uid);
    const { name, symbol, uri } = f as Required<Pick<typeof f, "name" | "symbol" | "uri">>;
    return askConfirm(
      ctx,
      `Action: CREATE COIN\nName: ${name}\nSymbol: ${symbol}\nURI: ${uri}\nInitial buy: ${sol.formatSol(buyLamports)} SOL\nSlippage: ${config.slippagePercent}%\nMayhem Mode: OFF`,
      "master",
      async () => {
        const r = await pump.createCoin({
          name,
          symbol,
          uri,
          creator: config.master,
          initialBuyLamports: buyLamports,
          slippageBps: config.slippageBps,
          mayhemMode: false,
        });
        return `🚀 COIN CREATED\nName: ${name}\nSymbol: ${symbol}\nMint: ${r.mint}\nInitial buy: ${sol.formatSol(buyLamports)} SOL\nTransaction: ${r.signature}\nSolscan: ${sol.txLink(r.signature)}`;
      },
    );
  }

  if (f.kind === "trade") {
    if (f.step === "mint") {
      const mint = sol.parsePublicKey(text);
      const curve = await pump.getCurveState(mint); // throws until implemented
      if (curve.graduated) {
        flows.delete(uid);
        return void (await ctx.reply(
          "⚠️ This token has graduated from the bonding curve.\nBonding-curve trading is unavailable.\nUse the appropriate PumpSwap/AMM implementation if enabled.",
        ));
      }
      flows.set(uid, { ...f, step: "wallet", mint });
      return void (await ctx.reply("Select treasury wallet:", walletKb()));
    }
    if (f.step === "amount" && f.mint && f.walletId) {
      const mint = f.mint;
      const wid = f.walletId;
      const w = store.getWallet(wid);
      const kp = store.getWalletKeypair(wid);
      if (!w || !kp) throw new Error("Wallet not found");
      flows.delete(uid);
      if (f.side === "buy") {
        const lamports = sol.parseSol(text, config.maxSingleBuySol);
        const bal = await sol.getSolBalance(kp.publicKey);
        if (bal < lamports + sol.FEE_BUFFER_LAMPORTS / 2n) throw new Error("Insufficient SOL balance.");
        const q = await pump.quoteBuy(mint, lamports, config.slippageBps);
        const tb = await sol.getTokenBalance(kp.publicKey, mint);
        return askConfirm(
          ctx,
          `Action: BUY\nToken: ${mint.toBase58()}\nWallet: ${wid} ${sol.short(w.publicKey)}\nSOL input: ${sol.formatSol(lamports)} SOL\nEstimated tokens: ${sol.formatUnits(q.estTokensRaw, tb.decimals)}\nSlippage: ${config.slippagePercent}%\nFees: calculated by SDK`,
          `wallet:${wid}`,
          async () => {
            const sig = await pump.buy(mint, kp, lamports, config.slippageBps);
            return `✅ Buy submitted\n${sol.txLink(sig)}`;
          },
        );
      }
      const tb = await sol.getTokenBalance(kp.publicKey, mint);
      const raw = sol.parseDecimal(text, tb.decimals);
      if (raw <= 0n) throw new Error("Invalid token amount");
      if (raw > tb.raw) throw new Error("Sell amount exceeds wallet token balance.");
      const q = await pump.quoteSell(mint, raw, config.slippageBps);
      return askConfirm(
        ctx,
        `Action: SELL\nToken: ${mint.toBase58()}\nWallet: ${wid} ${sol.short(w.publicKey)}\nAmount: ${sol.formatUnits(raw, tb.decimals)}\nExpected: ${sol.formatSol(q.estLamports)} SOL\nSlippage: ${config.slippagePercent}%`,
        `wallet:${wid}`,
        async () => {
          const sig = await pump.sell(mint, kp, raw, config.slippageBps);
          return `✅ Sell submitted\n${sol.txLink(sig)}`;
        },
      );
    }
  }
}

bot.catch((err) => console.error("Bot error:", err instanceof Error ? err.message : "unknown"));

// ---------- startup ----------
async function main(): Promise<void> {
  console.log("Loading configuration...");
  console.log("Loading wallet store...");
  store.loadStore();
  console.log("Connecting to Solana...");
  console.log("Checking network...");
  await sol.verifyMainnet();
  console.log("Checking master balance...");
  const bal = await sol.getSolBalance(config.master.publicKey);
  console.log("Starting Telegram bot...");
  await bot.telegram.getMe();

  http
    .createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    })
    .listen(config.port);

  bot.launch().catch((e) => {
    console.error("Telegram launch failed:", e instanceof Error ? e.message : "unknown");
    process.exit(1);
  });
  console.log(
    `🟢 MaterBabe Coin Kirkinator online\nNetwork: Solana Mainnet\nRPC: connected (${config.rpcLabel})\nMaster wallet: ${sol.short(config.master.publicKey)} (${sol.formatSol(bal)} SOL)`,
  );
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

main().catch((e) => {
  console.error("Startup failed:", e instanceof Error ? e.message : "unknown");
  process.exit(1);
});
