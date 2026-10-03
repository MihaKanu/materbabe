import 'dotenv/config';

import {
  Markup,
  Telegraf,
  Context,
  session,
} from 'telegraf';

import {
  Keypair,
  PublicKey,
} from '@solana/web3.js';

import BN from 'bn.js';

import { config } from './config.js';

import {
  connection,
  masterKeypair,
  masterBalance,
  solBalance,
  tokenBalance,
  shortKey,
  explorerTx,
  createCoin,
  quoteBuy,
  buy,
  sell,
} from './solana.js';

import {
  createWallet,
  getWallet,
  getWallets,
} from './store.js';

interface SessionData {
  authorized?: boolean;
  pendingAction?: string;
  pendingData?: Record<string, string>;
}

interface BotContext extends Context {
  session: SessionData;
}

const bot = new Telegraf<BotContext>(
  config.telegramBotToken,
);

const payoutWallet = new PublicKey(
  payoutWallet,
);

bot.use(session());

const transactionLocks = new Set<string>();

function isOwner(ctx: Context): boolean {
  return ctx.from?.id === config.ownerTelegramId;
}

function isAuthorized(ctx: BotContext): boolean {
  return Boolean(ctx.session.authorized);
}

function requireAccess(
  ctx: BotContext,
): boolean {
  if (!isAuthorized(ctx)) {
    void ctx.reply(
      '🔐 Access required.\n\nUse:\n/access <key>',
    );

    return false;
  }

  return true;
}

function requireOwner(
  ctx: BotContext,
): boolean {
  if (!isOwner(ctx)) {
    void ctx.reply(
      '❌ Owner authorization required.',
    );

    return false;
  }

  return true;
}

function parsePositiveNumber(
  value: string | undefined,
): number {
  if (!value) {
    throw new Error(
      'Amount is required.',
    );
  }

  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      'Invalid amount.',
    );
  }

  return amount;
}

function parsePublicKey(
  value: string | undefined,
): PublicKey {
  if (!value?.trim()) {
    throw new Error(
      'Token mint is required.',
    );
  }

  try {
    return new PublicKey(value.trim());
  } catch {
    throw new Error(
      'Invalid Solana public key.',
    );
  }
}

function explorerMessage(
  signature: string,
): string {
  return `Transaction:\n${signature}\n\nSolscan:\n${explorerTx(signature)}`;
}

function lockKey(
  action: string,
  walletId: string,
): string {
  return `${action}:${walletId}`;
}

function acquireLock(
  key: string,
): boolean {
  if (transactionLocks.has(key)) {
    return false;
  }

  transactionLocks.add(key);
  return true;
}

function releaseLock(
  key: string,
): void {
  transactionLocks.delete(key);
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '🚀 Create Coin',
        'create',
      ),
      Markup.button.callback(
        '💰 Balances',
        'balances',
      ),
    ],
    [
      Markup.button.callback(
        '👛 Treasury',
        'wallets',
      ),
      Markup.button.callback(
        '🛒 Buy',
        'buy',
      ),
    ],
    [
      Markup.button.callback(
        '💸 Sell',
        'sell',
      ),
      Markup.button.callback(
        '📊 Analytics',
        'analytics',
      ),
    ],
    [
      Markup.button.callback(
        '📤 Payout',
        'payout',
      ),
      Markup.button.callback(
        '⚙️ Admin',
        'admin',
      ),
    ],
  ]);
}

async function sendMainMenu(
  ctx: BotContext,
): Promise<void> {
  await ctx.reply(
    [
      '🪙 MaterBabe Coin Kirkinator',
      '',
      'Created by: YYLuccys Mom',
      'Network: Solana Mainnet',
      '',
      'Choose an action:',
    ].join('\n'),
    mainMenu(),
  );
}

bot.start(async (ctx) => {
  if (!ctx.session) {
    ctx.session = {};
  }

  if (!ctx.session.authorized) {
    await ctx.reply(
      [
        '🔐 MaterBabe Coin Kirkinator',
        '',
        'Access required.',
        '',
        'Use:',
        '/access <key>',
      ].join('\n'),
    );

    return;
  }

  await sendMainMenu(
    ctx,
  );
});

bot.command('access', async (ctx) => {
  const text = ctx.message.text;

  const parts = text.trim().split(/\s+/);

  const suppliedKey = parts[1];

  if (!suppliedKey) {
    await ctx.reply(
      'Usage:\n/access <key>',
    );

    return;
  }

  if (suppliedKey !== config.accessKey) {
    await ctx.reply(
      '❌ Invalid access key.',
    );

    return;
  }

  const botCtx = ctx;

  botCtx.session.authorized = true;

  await ctx.reply(
    '✅ Access granted.',
  );

  await sendMainMenu(botCtx);
});

bot.help(async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '🪙 MaterBabe Coin Kirkinator',
      '',
      '/status',
      '/balance',
      '/wallets',
      '/wallet <id>',
      '/create',
      '/fund',
      '/buy',
      '/sell',
      '/token <mint>',
      '/analytics <mint>',
      '/payout',
      '/admin',
    ].join('\n'),
  );
});

bot.command('status', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  try {
    const balance =
      await masterBalance();

    await ctx.reply(
      [
        '🟢 MaterBabe Coin Kirkinator',
        '',
        'Network: Solana Mainnet',
        'RPC: connected',
        `Master: ${shortKey(masterKeypair.publicKey)}`,
        `Balance: ${balance.toFixed(4)} SOL`,
      ].join('\n'),
    );
  } catch (error) {
    await ctx.reply(
      `❌ Status check failed.\n\n${formatError(error)}`,
    );
  }
});

bot.command('balance', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  try {
    const master =
      await masterBalance();

    const wallets =
      getWallets();

    const lines = [
      '💰 SOL BALANCES',
      '',
      `Master: ${master.toFixed(4)} SOL`,
    ];

    for (const wallet of wallets) {
      const balance =
        await solBalance(
          new PublicKey(wallet.publicKey),
        );

      lines.push(
        `${wallet.id}: ${balance.toFixed(4)} SOL`,
      );
    }

    await ctx.reply(
      lines.join('\n'),
    );
  } catch (error) {
    await ctx.reply(
      `❌ Balance lookup failed.\n\n${formatError(error)}`,
    );
  }
});

bot.command('wallets', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  const wallets =
    getWallets();

  const lines = [
    '👛 TREASURY',
    '',
    `Master`,
    shortKey(masterKeypair.publicKey),
    '',
  ];

  if (wallets.length === 0) {
    lines.push(
      'No treasury wallets.',
    );
  }

  for (const wallet of wallets) {
    try {
      const balance =
        await solBalance(
          new PublicKey(wallet.publicKey),
        );

      lines.push(
        `${wallet.id}`,
        `${shortKey(wallet.publicKey)}`,
        `${balance.toFixed(4)} SOL`,
        '',
      );
    } catch {
      lines.push(
        `${wallet.id}`,
        `${shortKey(wallet.publicKey)}`,
        'Balance unavailable',
        '',
      );
    }
  }

  await ctx.reply(
    lines.join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          'Create Wallet',
          'create_wallet',
        ),
      ],
      [
        Markup.button.callback(
          'Refresh',
          'wallets',
        ),
      ],
    ]),
  );
});

bot.command('wallet', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  const parts =
    ctx.message.text.trim().split(/\s+/);

  const id =
    parts[1];

  if (!id) {
    await ctx.reply(
      'Usage:\n/wallet W1',
    );

    return;
  }

  const wallet =
    getWallet(id);

  if (!wallet) {
    await ctx.reply(
      '❌ Treasury wallet not found.',
    );

    return;
  }

  try {
    const balance =
      await solBalance(
        new PublicKey(wallet.publicKey),
      );

    await ctx.reply(
      [
        `👛 ${wallet.id}`,
        '',
        `Address: ${shortKey(wallet.publicKey)}`,
        `SOL: ${balance.toFixed(4)}`,
        '',
        '⚠️ This wallet is controlled by the bot.',
      ].join('\n'),
    );
  } catch (error) {
    await ctx.reply(
      `❌ Wallet lookup failed.\n\n${formatError(error)}`,
    );
  }
});

bot.command('create', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '🚀 CREATE COIN',
      '',
      'Send the following information:',
      '',
      'Name',
      'Symbol',
      'Metadata URI',
      'Initial buy SOL',
      '',
      'Example:',
      '/create MaterBabe MBABE https://example.com/meta.json 0',
    ].join('\n'),
  );
});

bot.command('fund', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '💰 FUND TREASURY',
      '',
      'Treasury funding is owner-only.',
      '',
      'Use:',
      '/fund <walletId> <SOL>',
      '',
      'Example:',
      '/fund W1 0.10',
    ].join('\n'),
  );
});

bot.command('buy', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  const parts =
    ctx.message.text.trim().split(/\s+/);

  if (parts.length < 4) {
    await ctx.reply(
      [
        'Usage:',
        '/buy <walletId> <mint> <SOL>',
        '',
        'Example:',
        '/buy W1 MINT_ADDRESS 0.10',
      ].join('\n'),
    );

    return;
  }

  const walletId = parts[1];

  try {
    const wallet =
      getWallet(walletId);

    if (!wallet) {
      throw new Error(
        'Treasury wallet not found.',
      );
    }

    const mint =
      parsePublicKey(parts[2]);

    const amount =
      parsePositiveNumber(parts[3]);

    if (
      amount >
      config.maxSingleBuySol
    ) {
      throw new Error(
        `Buy exceeds the ${config.maxSingleBuySol} SOL limit.`,
      );
    }

    const key =
      lockKey('buy', wallet.id);

    if (!acquireLock(key)) {
      await ctx.reply(
        `⏳ A transaction is already being processed for ${wallet.id}.`,
      );

      return;
    }

    try {
      const quote =
        await quoteBuy(
          mint,
          new PublicKey(wallet.publicKey),
          amount,
        );

      await ctx.reply(
        [
          '⚠️ CONFIRM TRANSACTION',
          '',
          'Action: BUY',
          `Token: ${shortKey(mint)}`,
          `Wallet: ${wallet.id}`,
          `Amount: ${amount.toFixed(4)} SOL`,
          `Estimated tokens: ${quote.tokens.toString()}`,
          `Slippage: ${config.slippagePercent}%`,
          '',
          'Proceed?',
        ].join('\n'),
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              '✅ Confirm',
              `confirm_buy:${wallet.id}:${mint.toBase58()}:${amount}`,
            ),
            Markup.button.callback(
              '❌ Cancel',
              'cancel_tx',
            ),
          ],
        ]),
      );
    } finally {
      releaseLock(key);
    }
  } catch (error) {
    await ctx.reply(
      `❌ Buy preparation failed.\n\n${formatError(error)}`,
    );
  }
});

bot.command('sell', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '💸 SELL',
      '',
      'Use:',
      '/sell <walletId> <mint> <tokenAmount>',
      '',
      'Example:',
      '/sell W1 MINT_ADDRESS 1000000',
    ].join('\n'),
  );
});

bot.command('token', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  const parts =
    ctx.message.text.trim().split(/\s+/);

  if (!parts[1]) {
    await ctx.reply(
      'Usage:\n/token <mint>',
    );

    return;
  }

  try {
    const mint =
      parsePublicKey(parts[1]);

    const wallets =
      getWallets();

    const lines = [
      '🪙 TOKEN',
      '',
      `Mint: ${mint.toBase58()}`,
      '',
    ];

    for (const wallet of wallets) {
      const balance =
        await tokenBalance(
          mint,
          new PublicKey(wallet.publicKey),
        );

      lines.push(
        `${wallet.id}: ${balance.toString()}`,
      );
    }

    await ctx.reply(
      lines.join('\n'),
    );
  } catch (error) {
    await ctx.reply(
      `❌ Token lookup failed.\n\n${formatError(error)}`,
    );
  }
});

bot.command('analytics', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  const parts =
    ctx.message.text.trim().split(/\s+/);

  if (!parts[1]) {
    await ctx.reply(
      'Usage:\n/analytics <mint>',
    );

    return;
  }

  try {
    const mint =
      parsePublicKey(parts[1]);

    const {
      tokenAnalytics,
    } = await import('./solana.js');

    const analytics =
      await tokenAnalytics(mint);

    await ctx.reply(
      [
        '📊 TOKEN ANALYTICS',
        '',
        `Mint: ${mint.toBase58()}`,
        `Graduated: ${analytics.complete ? 'YES' : 'NO'}`,
        `Token supply: ${analytics.tokenSupply.toString()}`,
        `Virtual token reserves: ${analytics.virtualToken.toString()}`,
        '',
        'Controlled-wallet share:',
        'Read-only monitoring only.',
        '',
        'No automatic corrective trading is performed.',
      ].join('\n'),
    );
  } catch (error) {
    await ctx.reply(
      `❌ Analytics lookup failed.\n\n${formatError(error)}`,
    );
  }
});

bot.command('payout', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  const parts =
    ctx.message.text.trim().split(/\s+/);

  if (!parts[1]) {
    await ctx.reply(
      [
        '📤 PAYOUT',
        '',
        `Destination: ${shortKey(config.payoutWallet)}`,
        `Maximum: ${config.maxPayoutSol} SOL`,
        '',
        'Use:',
        '/payout <SOL>',
      ].join('\n'),
    );

    return;
  }

  try {
    const amount =
      parsePositiveNumber(parts[1]);

    if (
      amount >
      config.maxPayoutSol
    ) {
      throw new Error(
        `Payout exceeds the ${config.maxPayoutSol} SOL limit.`,
      );
    }

    const balance =
      await masterBalance();

    if (balance <= amount) {
      throw new Error(
        'Insufficient master-wallet balance.',
      );
    }

    await ctx.reply(
      [
        '⚠️ CONFIRM PAYOUT',
        '',
        'Action: SOL PAYOUT',
        `Amount: ${amount.toFixed(4)} SOL`,
        `Destination: ${payoutWallet.toBase58()}`,
        `Master balance: ${balance.toFixed(4)} SOL`,
        '',
        'Proceed?',
      ].join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            `Confirm payout ${amount}`,
            `confirm_payout:${amount}`,
          ),
        ],
        [
          Markup.button.callback(
            '❌ Cancel',
            'cancel_tx',
          ),
        ],
      ]),
    );
  } catch (error) {
    await ctx.reply(
      `❌ Payout preparation failed.\n\n${formatError(error)}`,
    );
  }
});

bot.command('admin', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '⚙️ ADMIN',
      '',
      'Owner authorization: ACTIVE',
      `Master: ${shortKey(masterKeypair.publicKey)}`,
      `Buy limit: ${config.maxSingleBuySol} SOL`,
      `Fund limit: ${config.maxSingleFundSol} SOL`,
      `Payout limit: ${config.maxPayoutSol} SOL`,
    ].join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          'Master Balance',
          'master_balance',
        ),
      ],
      [
        Markup.button.callback(
          'Create Treasury Wallet',
          'create_wallet',
        ),
      ],
      [
        Markup.button.callback(
          'View Treasury',
          'wallets',
        ),
      ],
      [
        Markup.button.callback(
          'Payout',
          'payout',
        ),
      ],
    ]),
  );
});

bot.action('create_wallet', async (ctx) => {
  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  try {
    const wallet =
      createWallet();

    await ctx.answerCbQuery();

    await ctx.reply(
      [
        '✅ Treasury wallet created',
        '',
        `Wallet ID: ${wallet.id}`,
        `Address: ${wallet.publicKey}`,
        '',
        '⚠️ This wallet is controlled by the bot.',
        'The private key will never be displayed in Telegram.',
      ].join('\n'),
    );
  } catch (error) {
    await ctx.answerCbQuery();

    await ctx.reply(
      `❌ Wallet creation failed.\n\n${formatError(error)}`,
    );
  }
});

bot.action('wallets', async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    'Use /wallets to refresh the treasury dashboard.',
  );
});

bot.action('balances', async (ctx) => {
  await ctx.answerCbQuery();

  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  await ctx.reply(
    'Use /balance to view current on-chain balances.',
  );
});

bot.action('admin', async (ctx) => {
  await ctx.answerCbQuery();

  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '⚙️ ADMIN',
      '',
      'Owner controls enabled.',
      '',
      '/balance',
      '/wallets',
      '/fund',
      '/payout',
    ].join('\n'),
  );
});

bot.action('create', async (ctx) => {
  await ctx.answerCbQuery();

  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '🚀 CREATE COIN',
      '',
      'Use:',
      '/create <name> <symbol> <metadataURI> <initialBuySOL>',
      '',
      'Example:',
      '/create MaterBabe MBABE https://example.com/meta.json 0',
    ].join('\n'),
  );
});

bot.action('buy', async (ctx) => {
  await ctx.answerCbQuery();

  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '🛒 BUY',
      '',
      'Use:',
      '/buy <walletId> <mint> <SOL>',
    ].join('\n'),
  );
});

bot.action('sell', async (ctx) => {
  await ctx.answerCbQuery();

  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '💸 SELL',
      '',
      'Use:',
      '/sell <walletId> <mint> <tokenAmount>',
    ].join('\n'),
  );
});

bot.action('analytics', async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    '📊 Use /analytics <mint> for token analytics.',
  );
});

bot.action('payout', async (ctx) => {
  await ctx.answerCbQuery();

  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  await ctx.reply(
    [
      '📤 PAYOUT',
      '',
      `Destination: ${payoutWallet.toBase58()}`,
      `Maximum: ${config.maxPayoutSol} SOL`,
      '',
      'Use:',
      '/payout <SOL>',
    ].join('\n'),
  );
});

bot.action('master_balance', async (ctx) => {
  await ctx.answerCbQuery();

  const botCtx = ctx;

  if (!requireAccess(botCtx)) {
    return;
  }

  if (!requireOwner(botCtx)) {
    return;
  }

  try {
    const balance =
      await masterBalance();

    await ctx.reply(
      `💰 Master balance: ${balance.toFixed(4)} SOL`,
    );
  } catch (error) {
    await ctx.reply(
      `❌ Balance lookup failed.\n\n${formatError(error)}`,
    );
  }
});

bot.action('cancel_tx', async (ctx) => {
  await ctx.answerCbQuery(
    'Transaction cancelled.',
  );

  await ctx.editMessageReplyMarkup({
    inline_keyboard: [],
  });
});

bot.action(
  /^confirm_buy:(.+):(.+):(.+)$/,
  async (ctx) => {
    const botCtx =
      ctx;

    if (!requireAccess(botCtx)) {
      await ctx.answerCbQuery();
      return;
    }

    if (!requireOwner(botCtx)) {
      await ctx.answerCbQuery();
      return;
    }

    const match =
      ctx.match;

    const walletId =
      match[1];

    const mintString =
      match[2];

    const amount =
      Number(match[3]);

    const wallet =
      getWallet(walletId);

    if (!wallet) {
      await ctx.answerCbQuery(
        'Wallet not found.',
      );

      return;
    }

    const key =
      lockKey('buy', walletId);

    if (!acquireLock(key)) {
      await ctx.answerCbQuery(
        'Transaction already processing.',
      );

      return;
    }

    try {
      await ctx.answerCbQuery(
        'Submitting transaction...',
      );

      await ctx.editMessageReplyMarkup({
        inline_keyboard: [],
      });

      const mint =
        parsePublicKey(mintString);

      const walletKey =
        Keypair.fromSecretKey(
          Buffer.from(wallet.secretKey),
        );

      const signature =
        await buy(
          mint,
          walletKey,
          amount,
        );

      await ctx.reply(
        [
          '✅ BUY CONFIRMED',
          '',
          `Wallet: ${walletId}`,
          `Token: ${mint.toBase58()}`,
          `Amount: ${amount.toFixed(4)} SOL`,
          '',
          explorerMessage(signature),
        ].join('\n'),
      );
    } catch (error) {
      await ctx.reply(
        [
          '❌ Transaction failed',
          '',
          `Reason: ${formatError(error)}`,
          '',
          'No additional transaction was submitted.',
        ].join('\n'),
      );
    } finally {
      releaseLock(key);
    }
  },
);

bot.action(
  /^confirm_payout:(.+)$/,
  async (ctx) => {
    const botCtx =
      ctx;

    if (!requireAccess(botCtx)) {
      await ctx.answerCbQuery();
      return;
    }

    if (!requireOwner(botCtx)) {
      await ctx.answerCbQuery();
      return;
    }

    const amount =
      Number(ctx.match[1]);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > config.maxPayoutSol
    ) {
      await ctx.answerCbQuery(
        'Invalid payout amount.',
      );

      return;
    }

    const key =
      'payout:master';

    if (!acquireLock(key)) {
      await ctx.answerCbQuery(
        'A payout is already processing.',
      );

      return;
    }

    try {
      await ctx.answerCbQuery(
        'Submitting payout...',
      );

      await ctx.editMessageReplyMarkup({
        inline_keyboard: [],
      });

      const balance =
        await masterBalance();

      if (balance <= amount) {
        throw new Error(
          'Insufficient master-wallet balance.',
        );
      }

      const signature =
        await import('./solana.js').then(
          async ({
            sendSol,
          }) =>
            sendSol(
              masterKeypair,
              payoutWallet,
              amount,
            ),
        );

      await ctx.reply(
        [
          '✅ PAYOUT SENT',
          '',
          `Amount: ${amount.toFixed(4)} SOL`,
          `Destination: ${payoutWallet.toBase58()}`,
          '',
          explorerMessage(signature),
        ].join('\n'),
      );
    } catch (error) {
      await ctx.reply(
        [
          '❌ Transaction failed',
          '',
          `Reason: ${formatError(error)}`,
        ].join('\n'),
      );
    } finally {
      releaseLock(key);
    }
  },
);

bot.catch(async (error, ctx) => {
  console.error(
    'Telegram bot error:',
    error instanceof Error
      ? error.message
      : 'Unknown error',
  );

  try {
    await ctx.reply(
      '❌ An unexpected error occurred.',
    );
  } catch {
    // Ignore Telegram reply failures.
  }
});

function formatError(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error.';
}

async function startup(): Promise<void> {
  console.log(
    'Loading configuration...',
  );

  console.log(
    'Connecting to Solana...',
  );

  await connection.getLatestBlockhash(
    'confirmed',
  );

  console.log(
    'Solana RPC connected.',
  );

  console.log(
    'Loading master wallet...',
  );

  console.log(
    `Master wallet: ${shortKey(masterKeypair.publicKey)}`,
  );

  const balance =
    await masterBalance();

  console.log(
    `Master balance: ${balance.toFixed(4)} SOL`,
  );

  console.log(
    'Loading Pump SDK...',
  );

  console.log(
    'Starting Telegram bot...',
  );

  await bot.launch();

  console.log(
    '🟢 MaterBabe Coin Kirkinator online',
  );

  console.log(
    'Network: Solana Mainnet',
  );

  console.log(
    `Master wallet: ${shortKey(masterKeypair.publicKey)}`,
  );
}

process.once(
  'SIGINT',
  () => bot.stop('SIGINT'),
);

process.once(
  'SIGTERM',
  () => bot.stop('SIGTERM'),
);

startup().catch((error) => {
  console.error(
    'Startup failed:',
    formatError(error),
  );

  process.exit(1);
});
