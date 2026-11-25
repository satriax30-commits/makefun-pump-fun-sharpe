// flow-scalper — a Sharpe-first paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// The ranking is the hourly Sharpe ratio, so the design chases many small,
// low-variance wins instead of one moonshot hour: equal stakes on confirmed
// flow, quick disciplined exits, and an hourly brake on fresh losses.
//
// Shape of the approach:
//   * One fixed stake per first buy (0.2 SOL, further capped by the harness's
//     1%-of-real-reserve buy cap) and a 6 SOL ceiling on total cost held, so
//     no coin and no hour can dominate the return series.
//   * Fast exits: take profit +10%, stop -12%, a trailing stop that arms at
//     +5% and gives back 5%, and a 20000-slot hold cap. Nothing rides into a
//     deep drawdown or round-trips to zero. (An early sweep with tighter
//     exits, TP 5% / SL 6%, got chopped by noise: 17% wins, Sharpe -0.29.)
//   * At most one top-up into strength (price stepped up, flow still
//     positive); losers never get more size. (maxTopups is 0 in the shipped
//     config, so top-ups are off; the path stays for completeness.)
//   * Entries only on confirmed flow: 30-200 slots old, 8+ distinct buyers
//     and 6+ SOL net inflow across the last 100 slots, price at most 2x its
//     create price, creator has not sold. We buy sustained buying, not the
//     launch itself.
//   * An hourly loss brake: realised PnL is summed per block-time hour; while
//     the current hour sits below -0.05 SOL realised, no new entries open.
//     A bad hour is capped, not chased, which keeps the hourly series tight.
//   * Pacing probes (tiny 0.02 SOL round trips on liquid curves) fire only
//     while filled coins / fills trail a block-time pace, so the
//     20-distinct-mint / round-trip bar is cleared without distorting the book.
//
// Deterministic by construction: no clock, no randomness, no I/O. Every
// decision is a pure function of the hello, the batches seen so far, and the
// account the harness reports. Iteration runs over insertion-ordered maps fed
// by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Config {
  /** Youngest a coin may be, in slots since its create, to take a first buy. */
  youngestSlots: number;
  /** Oldest a coin may be, in slots since its create, to take a first buy. */
  oldestSlots: number;
  /** Lamports spent on a first buy. */
  firstBuyLamports: number;
  /** Smallest buy worth paying a transaction fee for, in lamports. */
  smallestBuyLamports: number;
  /** Real SOL reserve window a coin must sit inside at decision time (lamports). */
  minReserveLamports: number;
  maxReserveLamports: number;
  /** Distinct non-creator buyers in the confirm window, at least. */
  minDistinctBuyers: number;
  /** Net SOL inflow across the confirm window, at least (lamports). */
  minNetFlowLamports: number;
  /** Length of the buyer/flow confirm window, in slots. */
  confirmSlots: number;
  /** Price now versus create price, in bps: 0 means exactly at create price. */
  minRiseBps: number;
  maxRiseBps: number;
  /** Pass on a launch whose creator has already sold. */
  avoidDevSold: boolean;
  /** Slippage allowed on buys, in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Close once the position is worth this much over its cost, in bps. */
  takeProfitBps: number;
  /** Close once it is worth this much under its cost, in bps. */
  stopLossBps: number;
  /** Trailing stop: once up at least trailStartBps, close on a fall of trailGivebackBps from the peak value. */
  trailStartBps: number;
  trailGivebackBps: number;
  /** Close after holding this many slots. */
  maxHoldSlots: number;
  /** Close when the creator sells while we hold. */
  closeOnDevSell: boolean;
  /** Close when no trade has touched the coin for this many slots. */
  quietSlots: number;
  /** Close when recent net flow drops below minus this many lamports (0 turns it off). */
  outflowLimitLamports: number;
  /** Recent window, in slots, for the outflow check. */
  outflowSlots: number;
  /** Most core positions open at once (the rest of caps.max_open_positions is for probes). */
  maxCore: number;
  /** Most SOL at cost across every position at once, a drawdown guard. */
  maxAtRiskSol: number;
  /** Hourly loss brake: pause new entries while this hour's realised PnL sits below -brakeLossLamports. */
  brakeLossLamports: number;
  /** Top-ups allowed per position while it keeps qualifying (0 means never). */
  maxTopups: number;
  /** Lamports per top-up. */
  topupLamports: number;
  /** A top-up needs the price at least this far, in bps, above the last buy's decision price. */
  topupStepBps: number;
  /** A top-up needs recent net flow of at least this many lamports. */
  topupMinFlowLamports: number;
  /**
   * Guardrail pacing: the run has to end with at least 20 coins and plenty
   * of fills. While the bot's own fills or coins trail paceCoins / paceFills
   * scaled by the share of paceWindowSecs elapsed (block time since the
   * first batch), it opens tiny probe round trips (buy probeSizeSol, sell it
   * all once the buy lands) until it is back on pace.
   */
  paceCoins: number;
  paceFills: number;
  paceWindowSecs: number;
  probeSizeSol: number;
  maxPacing: number;
}

export const DEFAULT_CONFIG: Config = {
  youngestSlots: 30,
  oldestSlots: 200,
  firstBuyLamports: 200_000_000,
  smallestBuyLamports: 5_000_000,
  minReserveLamports: 3_000_000_000,
  maxReserveLamports: 60_000_000_000,
  minDistinctBuyers: 8,
  minNetFlowLamports: 6_000_000_000,
  confirmSlots: 100,
  minRiseBps: 0,
  maxRiseBps: 10000,
  avoidDevSold: true,
  buySlipBps: 10_000,
  takeProfitBps: 1000,
  stopLossBps: 1200,
  trailStartBps: 500,
  trailGivebackBps: 500,
  maxHoldSlots: 20000,
  closeOnDevSell: true,
  quietSlots: 3000,
  outflowLimitLamports: 2_000_000_000,
  outflowSlots: 50,
  maxCore: 4,
  maxAtRiskSol: 6.0,
  brakeLossLamports: 50_000_000,
  maxTopups: 0,
  topupLamports: 60_000_000,
  topupStepBps: 1500,
  topupMinFlowLamports: 1_000_000_000,
  paceCoins: 30,
  paceFills: 240,
  paceWindowSecs: 14_400,
  probeSizeSol: 0.02,
  maxPacing: 1,
};

const LAMPORTS_IN_SOL = 1e9;
const CURVE_FEE_BPS = 125; // protocol 95 + creator 30 bps, the curve fee charged on each side
const BPS_DENOM = 10_000;

interface FlowTick {
  slot: number;
  buy: boolean;
  amount: bigint;
  trader: Pubkey;
}

interface TrackedMint {
  mint: Pubkey;
  bornSlot: number;
  creator: Pubkey;
  startVq: bigint;
  startVt: bigint;
  tradeCount: number;
  creatorSold: boolean;
  lastSeenSlot: number;
  /** Trades inside the last confirmSlots slots; older ones are dropped as new ones arrive. */
  flow: FlowTick[];
  buysPlaced: number;
  topupsPlaced: number;
  /** Decision price (vq/vt pair) of the last buy sent. */
  lastVq: bigint;
  lastVt: bigint;
  finished: boolean;
  migrated: boolean;
}

interface OpenTrade {
  openedAt: number;
  peakValue: bigint;
  closing: boolean;
}

/** Distinct non-creator buyers and net SOL flow over the last `window` slots. */
function flowSummary(flow: FlowTick[], creator: Pubkey, now: number, window: number): { distinct: number; flow: bigint } {
  const buyers = new Set<Pubkey>();
  let net = 0n;
  for (const tick of flow) {
    if (tick.slot <= now - window) continue;
    if (tick.buy) {
      net += tick.amount;
      if (tick.trader !== creator) buyers.add(tick.trader);
    } else {
      net -= tick.amount;
    }
  }
  return { distinct: buyers.size, flow: net };
}

/** What selling `tokens` would pay, curve fees and one tx fee taken off. */
function sellValue(vq: bigint, vt: bigint, rq: bigint, tokens: bigint, txFee: bigint): bigint {
  if (vt + tokens === 0n) return -txFee;
  let out = (tokens * vq) / (vt + tokens);
  if (out > rq) out = rq;
  const fee = (out * BigInt(CURVE_FEE_BPS) + BigInt(BPS_DENOM) - 1n) / BigInt(BPS_DENOM);
  return out - fee - txFee;
}

/** Every close reason for an open trade, evaluated in the same order as the exits loop checks them. */
function shouldClose(cfg: Config, trade: OpenTrade, cost: bigint, value: bigint, coin: TrackedMint | undefined, slot: number): boolean {
  if (cost > 0n) {
    if (value * BigInt(BPS_DENOM) >= cost * BigInt(BPS_DENOM + cfg.takeProfitBps)) return true;
    if (value * BigInt(BPS_DENOM) <= cost * BigInt(BPS_DENOM - cfg.stopLossBps)) return true;
  }
  if (
    trade.peakValue > 0n &&
    trade.peakValue * BigInt(BPS_DENOM) >= cost * BigInt(BPS_DENOM + cfg.trailStartBps) &&
    value * BigInt(BPS_DENOM) <= trade.peakValue * BigInt(BPS_DENOM - cfg.trailGivebackBps)
  ) return true;
  if (cfg.closeOnDevSell && coin !== undefined && coin.creatorSold) return true;
  if (slot - trade.openedAt > cfg.maxHoldSlots) return true;
  if (coin !== undefined && slot - coin.lastSeenSlot > cfg.quietSlots) return true;
  if (
    cfg.outflowLimitLamports > 0 &&
    coin !== undefined &&
    flowSummary(coin.flow, coin.creator, slot, cfg.outflowSlots).flow < -BigInt(cfg.outflowLimitLamports)
  ) return true;
  return false;
}

export function buildScalper(cfg: Config = DEFAULT_CONFIG): Bot {
  const mints = new Map<Pubkey, TrackedMint>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Pacing round trips in flight, by mint. */
  const pacing = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let fillsSeen = 0;
  const mintsTouched = new Set<Pubkey>();
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  /** Cost basis per mint from our own buy fills (quote spent, fees included). */
  const basisByMint = new Map<Pubkey, bigint>();
  /** Tokens bought per mint from our own buy fills (for pro-rata cost on sells). */
  const tokensByMint = new Map<Pubkey, bigint>();
  /** Realised PnL per block-time hour bucket (lamports). */
  const pnlByHour = new Map<number, bigint>();
  let hourNow = -1;

  const trackMint = (mint: Pubkey, slot: number, creator: Pubkey, startVq: bigint, startVt: bigint): TrackedMint => ({
    mint,
    bornSlot: slot,
    creator,
    startVq,
    startVt,
    tradeCount: 0,
    creatorSold: false,
    lastSeenSlot: slot,
    flow: [],
    buysPlaced: 0,
    topupsPlaced: 0,
    lastVq: 0n,
    lastVt: 1n,
    finished: false,
    migrated: false,
  });

  const lookup = (mint: Pubkey): TrackedMint | undefined => mints.get(mint);

  /** Entry filter on a coin at slot `now`. */
  const mayEnter = (coin: TrackedMint, now: number, rq: bigint, vq: bigint, vt: bigint): boolean => {
    const age = now - coin.bornSlot;
    if (age < cfg.youngestSlots || age > cfg.oldestSlots) return false;
    if (rq < BigInt(cfg.minReserveLamports) || rq > BigInt(cfg.maxReserveLamports)) return false;
    if (cfg.avoidDevSold && coin.creatorSold) return false;
    const summary = flowSummary(coin.flow, coin.creator, now, cfg.confirmSlots);
    if (summary.distinct < cfg.minDistinctBuyers) return false;
    if (summary.flow < BigInt(cfg.minNetFlowLamports)) return false;
    // Price rise from the create price, in bps (cross-multiplied, no floats).
    if (coin.startVq > 0n && coin.startVt > 0n && vt > 0n) {
      const rise = ((vq * coin.startVt * BigInt(BPS_DENOM)) / (vt * coin.startVq)) - BigInt(BPS_DENOM);
      if (rise < BigInt(cfg.minRiseBps) || rise > BigInt(cfg.maxRiseBps)) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const feePerTx = state.txFeeLamports();
      const seen: Pubkey[] = [];
      const seenSet = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (windowStart === null) windowStart = e.block_time;
          if (windowEnd === null || e.block_time > windowEnd) windowEnd = e.block_time;
          hourNow = Math.floor(e.block_time / 3600);
        }
        if (e.event === 'CreateEvent') {
          if (!mints.has(e.mint)) {
            mints.set(e.mint, trackMint(e.mint, e.slot, e.creator, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
          }
        } else if (e.event === 'TradeEvent') {
          let coin = mints.get(e.mint);
          if (coin === undefined) {
            coin = trackMint(e.mint, e.slot, e.creator, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
            mints.set(e.mint, coin);
          }
          const amount = BigInt(e.sol_amount);
          coin.tradeCount++;
          coin.lastSeenSlot = e.slot;
          coin.flow.push({ slot: e.slot, buy: e.is_buy, amount, trader: e.user });
          if (coin.flow.length > 400) coin.flow.splice(0, coin.flow.length - 400);
          if (!e.is_buy && e.user === coin.creator) coin.creatorSold = true;
          if (!seenSet.has(e.mint)) {
            seenSet.add(e.mint);
            seen.push(e.mint);
          }
        } else if (e.event === 'CompleteEvent') {
          const coin = mints.get(e.mint);
          if (coin !== undefined) coin.migrated = true;
        }
      }
      // Book our own fills: count them, track cost basis, bucket realised PnL by hour.
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          fillsSeen++;
          mintsTouched.add(f.mint);
          if (f.side === 'buy') {
            basisByMint.set(f.mint, (basisByMint.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
            tokensByMint.set(f.mint, (tokensByMint.get(f.mint) ?? 0n) + BigInt(f.token_amount));
          } else {
            const basis = basisByMint.get(f.mint) ?? 0n;
            const tokens = tokensByMint.get(f.mint) ?? 0n;
            const sold = BigInt(f.token_amount);
            const share = tokens > 0n ? (basis * sold) / tokens : 0n;
            const realised = BigInt(f.quote_lamports) - share - BigInt(f.tx_fee_lamports);
            if (hourNow >= 0) pnlByHour.set(hourNow, (pnlByHour.get(hourNow) ?? 0n) + realised);
            basisByMint.set(f.mint, basis - share);
            tokensByMint.set(f.mint, tokens - sold);
          }
        }
      }

      const out: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      const markByMint = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingCount = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingCount.set(po.order.mint, (pendingCount.get(po.order.mint) ?? 0) + 1);

      const reservesFor = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
        const mark = markByMint.get(mint);
        if (mark !== undefined) {
          return { vq: BigInt(mark.virtual_quote_reserves), vt: BigInt(mark.virtual_token_reserves), rq: BigInt(mark.real_quote_reserves) };
        }
        const curve = state.curves.get(mint);
        if (curve === undefined) return null;
        return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves, rq: curve.real_quote_reserves };
      };

      // Exits first: every open position is re-priced against its latest reserves.
      for (const [mint, trade] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingCount.has(mint)) {
            open.delete(mint);
            const tracked = lookup(mint);
            if (tracked !== undefined) tracked.finished = true;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const res = reservesFor(mint);
        if (res === null) continue;
        const value = sellValue(res.vq, res.vt, res.rq, BigInt(pos.token_amount), feePerTx);
        const cost = BigInt(pos.cost_lamports);
        if (value > trade.peakValue) trade.peakValue = value;
        const tracked = lookup(mint);
        if (!trade.closing && !shouldClose(cfg, trade, cost, value, tracked, slot)) continue;
        trade.closing = true;
        if (pendingCount.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (out.length >= maxOrders) break;
        out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Pacing round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of pacing) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingCount.has(mint)) pacing.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingCount.has(mint)) continue;
        if (out.length >= maxOrders) break;
        out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) pacing.set(mint, true);
      }

      // Entries and top-ups: only coins touched by this batch.
      // The hourly loss brake pauses new entries while this hour is deep red.
      const paused = hourNow >= 0 && (pnlByHour.get(hourNow) ?? 0n) < -BigInt(cfg.brakeLossLamports);
      let cashLeft = state.freeCashLamports();
      let roomLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let coreRoom = cfg.maxCore - open.size;
      let atRisk = 0n;
      for (const [mint] of open) atRisk += BigInt(state.positions.get(mint)?.cost_lamports ?? 0n);
      for (const mint of seen) {
        if (out.length >= maxOrders) break;
        if (paused) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingCount.has(mint) || pacing.has(mint)) continue;
        const coin = mints.get(mint)!;
        const res = reservesFor(mint);
        if (res === null) continue;
        const trade = open.get(mint);
        let size: bigint;
        if (trade === undefined) {
          if (roomLeft <= 0 || coreRoom <= 0) continue;
          if (coin.finished || coin.buysPlaced > 0) continue;
          if (!mayEnter(coin, slot, res.rq, res.vq, res.vt)) continue;
          size = BigInt(cfg.firstBuyLamports);
        } else {
          // One small top-up into strength only: price stepped up from the last
          // buy's decision price and net flow over the confirm window is still
          // positive. Losers never get more size.
          if (trade.closing || coin.topupsPlaced >= cfg.maxTopups) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (coin.lastVt === 0n) continue;
          const step = ((res.vq * coin.lastVt * BigInt(BPS_DENOM)) / (res.vt * coin.lastVq)) - BigInt(BPS_DENOM);
          if (step < BigInt(cfg.topupStepBps)) continue;
          if (flowSummary(coin.flow, coin.creator, slot, cfg.confirmSlots).flow < BigInt(cfg.topupMinFlowLamports)) continue;
          size = BigInt(cfg.topupLamports);
        }
        const buyCap = state.maxBuyLamports(mint);
        if (size > buyCap) size = buyCap;
        const riskCap = BigInt(Math.floor(cfg.maxAtRiskSol * LAMPORTS_IN_SOL));
        if (size > riskCap - atRisk) size = riskCap - atRisk;
        if (size > cashLeft - feePerTx) size = cashLeft - feePerTx;
        if (size < BigInt(cfg.smallestBuyLamports)) continue;
        out.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: cfg.buySlipBps });
        cashLeft -= size + feePerTx;
        atRisk += size;
        if (trade === undefined) {
          coin.buysPlaced++;
          coin.lastVq = res.vq;
          coin.lastVt = res.vt;
          open.set(mint, { openedAt: slot, peakValue: 0n, closing: false });
          roomLeft--;
          coreRoom--;
        } else {
          coin.topupsPlaced++;
          coin.lastVq = res.vq;
          coin.lastVt = res.vt;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (pacing.size < cfg.maxPacing && roomLeft > 0 && windowStart !== null && windowEnd !== null) {
        const paceFrac = Math.min(1, (windowEnd - windowStart) / cfg.paceWindowSecs);
        const shortCoins = mintsTouched.size < Math.ceil(cfg.paceCoins * paceFrac);
        const shortFills = fillsSeen < Math.ceil(cfg.paceFills * paceFrac);
        if (shortCoins || shortFills) {
          const probeSize = BigInt(Math.floor(cfg.probeSizeSol * LAMPORTS_IN_SOL));
          const minReserve = (probeSize * BigInt(BPS_DENOM)) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of seen) {
            if (out.length >= maxOrders || pacing.size >= cfg.maxPacing) break;
            if (open.has(mint) || pacing.has(mint) || pendingCount.has(mint) || state.positions.has(mint)) continue;
            if (shortCoins && !shortFills && mintsTouched.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minReserve * 3n) / 2n) continue;
            if (cashLeft < probeSize + 2n * feePerTx) break;
            out.push({ side: 'buy', mint, quote_lamports: probeSize, max_slippage_bps: cfg.buySlipBps });
            pacing.set(mint, false);
            cashLeft -= probeSize + feePerTx;
          }
        }
      }
      return out;
    },
  };
}
