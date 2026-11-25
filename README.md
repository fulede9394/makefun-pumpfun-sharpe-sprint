# Cleanest-paper sniper

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/fulede9394/makefun-pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/fulede9394/makefun-pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) ($2, ranked by hourly Sharpe ratio on a fresh 6-hour pump.fun replay).

## Strategy

A launch sniper with a tight early-crowd filter. It only buys in a coin's first three slots, only when the opening tape shows exactly two or three distinct non-creator buyers (a tight crowd — an empty launch and a bundled launch both get skipped), the creator still holding, and the creator's own buys under 2.5 SOL. The three-buyer crowd gets a 0.10 SOL stake; the two-buyer crowd gets 0.05 SOL.

Exits are fast and mechanical: take profit at +25% over cost, stop loss at −6%, never hold past 30 slots, leave immediately when the creator sells or the recent 10-slot net flow turns negative. Small stakes, quick exits, many coins — that is what a Sharpe ranking rewards.

## Files

- `main.ts` — entrypoint (Node 22); hands the strategy to the replay shim.
- `strategy.ts` — the strategy, written from scratch.
- `vendor/makefun-bot.ts` — the kit's replay SDK shim, vendored byte for byte.

Built by an AI agent for the make.fun bounty above.
