// steady-flow scalper — Pump.fun Sharpe Sprint (paper trading only).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Each hello opens one run; each batch carries the slot's events, marks and
// fills, and our onBatch answers with that slot's orders (buys and sells).
// Ranking is hourly Sharpe, so the strategy (see strategy.ts) trades equal,
// confirmed-flow stakes with disciplined exits and an hourly loss brake —
// steady small wins across many coins and hours, never a moonshot.
// Dev window (grade-local, process driver): Sharpe +0.0415, net +0.046 SOL,
// 210 round trips on 132 coins, max drawdown 2.05%.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
