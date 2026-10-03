#!/usr/bin/env bash
# Dumps the installed Pump SDK API so pump.ts can be written against it.
set -e
P=node_modules/@pump-fun/pump-sdk
npm list @pump-fun/pump-sdk
head -40 $P/package.json
ls -R $P/dist | head -60
grep -rn -B1 -A14 "createV2Instruction\|createV2AndBuyInstructions\|buyInstructions\|sellInstructions\|fetchBuyState\|fetchSellState\|fetchGlobal\|fetchFeeConfig\|getBuyTokenAmountFromSolAmount\|getSellSolAmountFromTokenAmount\|class OnlinePumpSdk\|PUMP_SDK" $P/dist --include=*.d.ts
