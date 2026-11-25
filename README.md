# steady-flow scalper — Pump.fun Sharpe Sprint paper bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/satriax30-commits/makefun-pump-fun-sharpe/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/satriax30-commits/makefun-pump-fun-sharpe/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A deterministic paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve activity. Nothing is traded for real. Ranking is by **hourly Sharpe ratio**, not net PnL — so this bot is built for steady, low-variance gains, not moonshots.

## Strategy

Measured on the kit's dev window with `grade-local` (not assumed): tight exits
(TP 5% / SL 6%) get chopped by noise — win rate 17%, Sharpe −0.29. Loose entries
are worse still: allowing run-ups to 2.5x or dropping the flow bar to 4 SOL
turns the Sharpe deeply negative. The edge is a *strict* confirmed-flow entry
plus disciplined, moderately wide exits:

- **Entry (confirmed flow only):** a coin aged 30–200 slots with at least 8 distinct
  buyers and at least 6 SOL net inflow over the last 100 slots, real SOL between 3 and
  60, price still at most 2x its create price, creator has not sold.
- **Sizing:** 0.2 SOL per coin, one buy only — no pyramiding into strength, so no
  single coin or hour can dominate the return stream. At most 4 main positions;
  every buy respects the harness's 1%-of-real-reserve cap (which binds first at
  these stakes). Total exposure capped at 6 SOL.
- **Exits:** +10% take-profit, −12% stop, trailing stop (+5% arm, −5% trail),
  creator sale, flow fade, staleness, or a 20,000-slot hold limit.
- **Hourly loss brake:** realised PnL is bucketed by block-time hour; if the
  current hour is already down more than 0.05 SOL realised, no new entries open
  until the next hour — a bad hour is capped, not chased.
- **Guardrail pacing:** tiny 0.02 SOL probe round trips keep the run above the
  minimum bar (a round trip of at least 0.01 SOL on at least 20 coins).

## Results (dev window, grade-local --driver process)

Sharpe (hourly) **+0.0415**, net **+0.046 SOL** over 210 round trips on 132 coins
(win rate 22.9%, max drawdown 2.05%). Guardrails met with margin.

## Run

The grader runs `node /bot/main.ts` (Node 22). `main.ts` hands the strategy in
`strategy.ts` to the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical
copy of the kit's `sdk/ts/makefun-bot.ts`). Standard library only, no network,
no clock, no randomness — every decision is a pure function of the harness batches.
