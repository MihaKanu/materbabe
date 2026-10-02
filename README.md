# MaterBabe Coin Kirkinator
Created by: YYLuccys Mom

Telegram-controlled Solana mainnet bot using `@pump-fun/pump-sdk` 2.0.0.

## Important SDK note
The implementation targets the published 2.0.0 API: V2 creation, `OnlinePumpSdk`, fee-aware quote helpers, Token/Token-2022 state, and the current bonding-curve buy/sell instruction builders. The published package documentation identifies `mayhemMode` on V2 creation and `holderReward` for holder-reward launches; cashback launches are retired. See the official package before deployment.

## Environment
Copy `.env.example` to `.env` and fill secrets locally. Never commit `.env`.

Required:
- TELEGRAM_BOT_TOKEN
- OWNER_TELEGRAM_ID
- ACCESS_KEY
- SOLANA_NETWORK=mainnet-beta
- SOLANA_RPC_URL
- MASTER_SECRET
- PAYOUT_WALLET
- MAX_SINGLE_BUY_SOL
- MAX_PAYOUT_SOL
- MAX_SINGLE_FUND_SOL
- SLIPPAGE_PERCENT

## Build
npm install
npm run build
npm start

## Render
Root: `.`
Build: `npm install && npm run build`
Start: `npm start`

## Security
Treasury keys are held only in memory in this first version. Restarting the service loses treasury wallets. For production persistence, replace `store.ts` with an encrypted KMS-backed store. Never send secrets to Telegram or logs.

The bot does not implement automatic 18–26% holder-share rebalancing and does not represent controlled wallets as independent holders.

## Limitations
Bonding-curve buy/sell is implemented. Graduated-token AMM/PumpSwap trading is intentionally not enabled in this first project version; the bot refuses bonding-curve trading after graduation rather than sending an invalid transaction.
