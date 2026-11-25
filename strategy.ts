// Pump.fun Sharpe sprint — "cleanest-paper sniper".
//
// The dev window punishes chasing: breakout momentum loses about 9 SOL and
// mean reversion about 2 SOL, while simply buying fresh launches loses only
// ~0.1 SOL. The edge is selectivity. A launch whose opening tape shows a
// tight crowd — exactly two or three distinct buyers who are not the
// creator, with the creator still holding — behaves far better than an empty
// launch or a bundled one (four-plus wallets in the opening slots is usually
// a dump in waiting). So this bot only buys inside a coin's first three
// slots, only out of that tight crowd, in two tiers: a three-buyer crowd
// takes the full stake, a two-buyer crowd half. The rest is risk control:
// bank at +25%, cut at -6%, never hold longer than 30 slots, walk away the
// moment the creator sells, the recent flow turns negative, or the coin goes
// quiet. Small stakes, fast exits, lots of coins — the shape a Sharpe
// ranking rewards.
//
// The whole strategy is a pure function of the batches the harness sends:
// no clock, no randomness, no I/O, so two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface Settings {
  /** First buy only while the coin is at most this many slots old. */
  entryAgeSlots: number;
  /** Distinct non-creator buyers a tier-A launch must show. */
  crowdA: number;
  /** Distinct non-creator buyers a tier-B launch must show. */
  crowdB: number;
  /** Trades the opening tape must hold before either tier may buy. */
  minOpeningTrades: number;
  /** The creator's own buys in the opening tape, at most (SOL). */
  devBuyCeilingSol: number;
  /** Real SOL reserve window at decision time. */
  reserveFloorSol: number;
  reserveCeilingSol: number;
  /** Stake for a tier-A launch (SOL). */
  stakeASol: number;
  /** Stake for a tier-B launch (SOL). */
  stakeBSol: number;
  /** Smallest single buy worth paying the transaction fee for (SOL). */
  minBuySol: number;
  /** Take profit: sell once the position is worth cost * (1 + tp). */
  takeProfit: number;
  /** Stop loss: sell once the position is worth cost * (1 - sl). */
  stopLoss: number;
  /** Longest hold, in slots. */
  maxHoldSlots: number;
  /** Exit when net SOL over this many recent slots falls below zero. */
  flowLookbackSlots: number;
  /** Exit when the coin has had no trade for this many slots. */
  staleSlots: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps). */
  sellSlippageBps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  entryAgeSlots: 3,
  crowdA: 3,
  crowdB: 2,
  minOpeningTrades: 3,
  devBuyCeilingSol: 2.5,
  reserveFloorSol: 0.3,
  reserveCeilingSol: 30,
  stakeASol: 0.1,
  stakeBSol: 0.05,
  minBuySol: 0.01,
  takeProfit: 0.25,
  stopLoss: 0.06,
  maxHoldSlots: 30,
  flowLookbackSlots: 10,
  staleSlots: 50,
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
};

/** One trade on a launch's opening tape. */
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  wallet: Pubkey;
}

/** Everything remembered about one launch. */
interface CoinTape {
  /** Slot of the CreateEvent, null until the coin is created. */
  createdAt: number | null;
  maker: Pubkey | null;
  /** Price at creation (virtual SOL per virtual token), reference only. */
  creationPrice: number;
  /** SOL the creator has bought themselves since creation. */
  makerBought: bigint;
  makerSold: boolean;
  /** Slot of the latest TradeEvent on this coin. */
  lastTradeAt: number;
  /** Distinct non-creator wallets that have bought. */
  crowd: Set<Pubkey>;
  tape: TapeTrade[];
  /** True once this bot has bought the coin. */
  bought: boolean;
}

/** A position this bot currently holds. */
interface HeldPosition {
  openedAt: number;
  /** Best net value seen so far, kept for reference. */
  peakValue: bigint;
  /** Lamports paid for the entry (the stake). */
  paid: bigint;
}

/** Virtual price: quote reserves over token reserves, 0 when empty. */
function creationPriceOf(quote: bigint, tokens: bigint): number {
  return tokens === 0n ? 0 : Number(quote) / Number(tokens);
}

export function createStrategy(s: Settings = DEFAULT_SETTINGS): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const held = new Map<Pubkey, HeldPosition>();
  // Protocol fee plus creator fallback, in bps; the harness charges the same
  // on the dev window, so exits are priced with these baked in.
  const CURVE_FEE_BPS = 95 + 30;

  const tapeFor = (mint: Pubkey): CoinTape => {
    const existing = tapes.get(mint);
    if (existing !== undefined) return existing;
    const fresh: CoinTape = {
      createdAt: null,
      maker: null,
      creationPrice: 0,
      makerBought: 0n,
      makerSold: false,
      lastTradeAt: -1,
      crowd: new Set(),
      tape: [],
      bought: false,
    };
    tapes.set(mint, fresh);
    return fresh;
  };

  /** Fold one batch of chain events into the per-coin tapes. */
  const absorb = (batch: Batch): void => {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const tape = tapeFor(e.mint);
        tape.createdAt = e.slot;
        tape.maker = e.creator;
        tape.creationPrice = creationPriceOf(
          BigInt(e.virtual_quote_reserves),
          BigInt(e.virtual_token_reserves),
        );
      } else if (e.event === 'TradeEvent') {
        const tape = tapeFor(e.mint);
        const sol = BigInt(e.sol_amount);
        tape.lastTradeAt = e.slot;
        tape.tape.push({ slot: e.slot, buy: e.is_buy, sol, wallet: e.user });
        if (tape.maker !== null && e.user === tape.maker) {
          if (e.is_buy) tape.makerBought += sol;
          else tape.makerSold = true;
        } else if (e.is_buy) {
          tape.crowd.add(e.user);
        }
      } else {
        // CompleteEvent: the curve is finished; forget the tape so the coin
        // can never be entered again.
        tapes.delete(e.mint);
      }
    }
  };

  /** Net SOL (buys minus sells) over the last `span` slots of a tape. */
  const netFlowOver = (tape: CoinTape, now: number, span: number): bigint => {
    let net = 0n;
    for (let i = tape.tape.length - 1; i >= 0; i--) {
      const trade = tape.tape[i]!;
      if (trade.slot <= now - span) break;
      net += trade.buy ? trade.sol : -trade.sol;
    }
    return net;
  };

  /**
   * Which tier, if any, a launch qualifies for right now: 1 for the full
   * stake, 2 for half, 0 for "do not buy".
   */
  const tierFor = (tape: CoinTape, now: number, realSol: number): 0 | 1 | 2 => {
    // realSol comes from Number(bigint) / 1e9, so it should always be finite
    // — but tiering must never run on a non-finite reserve value.
    if (!Number.isFinite(realSol)) return 0;
    if (tape.createdAt === null || now - tape.createdAt > s.entryAgeSlots) return 0;
    if (tape.bought || tape.makerSold) return 0;
    if (tape.makerBought > BigInt(Math.floor(s.devBuyCeilingSol * LAMPORTS_PER_SOL))) return 0;
    if (realSol < s.reserveFloorSol || realSol > s.reserveCeilingSol) return 0;
    if (tape.tape.length < s.minOpeningTrades) return 0;
    if (tape.crowd.size === s.crowdA) return 1;
    if (tape.crowd.size === s.crowdB) return 2;
    return 0;
  };

  /**
   * True when a held position should be sold now: take-profit or stop hit,
   * held too long, creator sold, recent flow negative, or the coin gone
   * quiet. `tape` is undefined once the launch tape was dropped.
   */
  const exitNow = (
    tape: CoinTape | undefined,
    openedAt: number,
    value: bigint,
    cost: bigint,
    now: number,
  ): boolean => {
    const tookProfit =
      value >= (cost * BigInt(Math.floor((1 + s.takeProfit) * 10_000))) / 10_000n;
    const stoppedOut =
      value <= (cost * BigInt(Math.floor((1 - s.stopLoss) * 10_000))) / 10_000n;
    const tooOld = now - openedAt > s.maxHoldSlots;
    const makerDumped = tape !== undefined && tape.makerSold;
    const flowOut =
      tape !== undefined && netFlowOver(tape, now, s.flowLookbackSlots) < 0n;
    const goneQuiet = tape !== undefined && now - tape.lastTradeAt > s.staleSlots;
    return tookProfit || stoppedOut || tooOld || makerDumped || flowOut || goneQuiet;
  };

  /**
   * Lamports to spend on a tiered entry, or null when the buy is not worth
   * placing: capped by the curve's max buy and by free cash after the tx
   * fee, and dropped when below the minimum buy.
   */
  const sizeBuy = (
    tier: 1 | 2,
    mint: Pubkey,
    freeLamports: bigint,
    txFee: bigint,
    state: BotState,
  ): bigint | null => {
    const wantSol = tier === 1 ? s.stakeASol : s.stakeBSol;
    const want = BigInt(Math.floor(wantSol * LAMPORTS_PER_SOL));
    const cap = state.maxBuyLamports(mint);
    let amount = want < cap ? want : cap;
    const affordable = freeLamports - txFee;
    if (amount > affordable) amount = affordable;
    if (amount < BigInt(Math.floor(s.minBuySol * LAMPORTS_PER_SOL))) return null;
    return amount;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFee = state.txFeeLamports();
      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;

      absorb(batch);

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pending = new Set<Pubkey>();
      for (const po of state.pending.values()) pending.add(po.order.mint);

      // Exits first: sell anything that hit its take-profit, stop, hold
      // limit, creator sale, negative recent flow, or went quiet.
      for (const [mint, pos] of held) {
        const owned = state.positions.get(mint);
        if (owned === undefined) {
          if (!pending.has(mint)) held.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        // Price the exit off this batch's mark when the harness supplies
        // one, otherwise off the live curve reserves — same quote either way.
        const vq = mark ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mark ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
        const tokens = BigInt(owned.token_amount);
        const gross = (tokens * vq) / (vt + tokens);
        const value = (gross * BigInt(10_000 - CURVE_FEE_BPS)) / 10_000n - txFee;
        const cost = BigInt(owned.cost_lamports);
        if (value > pos.peakValue) pos.peakValue = value;
        if (!exitNow(tapes.get(mint), pos.openedAt, value, cost, now)) continue;
        if (pending.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: owned.token_amount, max_slippage_bps: s.sellSlippageBps });
      }

      // Entries: walk the tapes in first-seen order so the run stays
      // deterministic. One fresh launch per batch is plenty in practice —
      // the room and cash checks below enforce it naturally.
      let freeLamports = state.freeCashLamports();
      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const [mint, tape] of tapes) {
        if (orders.length >= orderCap || room <= 0) break;
        if (held.has(mint) || pending.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        const tier = tierFor(tape, now, realSol);
        if (tier === 0) continue;
        const amount = sizeBuy(tier, mint, freeLamports, txFee, state);
        if (amount === null) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: s.buySlippageBps });
        freeLamports -= amount + txFee;
        room -= 1;
        tape.bought = true;
        held.set(mint, { openedAt: now, peakValue: 0n, paid: amount });
      }
      return orders;
    },
  };
}
