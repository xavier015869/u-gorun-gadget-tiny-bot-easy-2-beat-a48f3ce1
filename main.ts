// Tiny Bot: patient dip-buyer on hourly Solana bars.
//
// Strategy: sit in cash most of the time and buy only sharp oversold dips.
// A symbol is bought when its 6-bar return is at or below -4% AND its 14-bar
// RSI is at or below 35 — a fast fall that has exhausted itself — and sold
// when it bounces +2% from the entry close, falls a further -3% (stop-loss),
// or 12 bars have passed without either. One buy risks 10% of cash, so at
// most a few positions are open at once and a bad window costs little. After
// 10 bars with no order at all, a small 5% probe buys the strongest symbol,
// so even a calm 3-day window clears the 8-trade guardrail; it exits on the
// same rules.
// Long only, no leverage, fully deterministic: the same hello seed and the
// same bars always give the same orders, so the two grading runs match
// byte for byte.
//
// Why this shape: on the dev window every symbol fell (-3% to -14%) and
// hourly returns show no momentum edge (lag-1 autocorrelation near zero),
// so buying strength lost on every trade (v1: -417 USDC, 0% win rate) while
// the house's low-exposure mean-reversion baseline nearly broke even. The
// prize only needs beating buy-and-hold (-869 USDC on dev), so a bot that
// trades rarely, exits fast and keeps most capital in cash is the robust
// play for a 3-day final window in any regime.
//
// The harness speaks agent-fun/bars-replay/v1: one hello line, then one batch
// per bar, and our reply per batch carries the orders for that bar. Orders
// decided on a batch fill at the next bar's open, so a sell's proceeds never
// fund a buy in the same reply: buys are sized from the cash on hand when
// the batch is answered.

import { runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const DIP_BPS = -400;
const RSI_BARS = 14;
const RSI_MAX_BPS = 3500;
const TAKE_PROFIT_BPS = 200;
const STOP_LOSS_BPS = -300;
const MAX_HOLD_BARS = 12;
const POSITION_CASH_PCT = 10;
const PROBE_CASH_PCT = 5;
const PROBE_GAP_BARS = 10;
const PROBE_LOOKBACK_BARS = 24;
const MAX_SLIPPAGE_BPS = 10_000;

/** Each universe symbol's latest close as of every batch so far (null before its first bar), by seq. */
const history = new Map<string, (bigint | null)[]>();
/** Entry close (the close at the batch the buy was decided on) per held symbol. */
const entryClose = new Map<string, bigint>();
/** Batch seq the buy was decided on per held symbol, for the max-hold exit. */
const entrySeq = new Map<string, number>();
/** Batch seq of the last bar on which any order was decided; the probe trade watches it. */
let lastTradeSeq = -1000;

/** The held-out symbol with the best trailing 24-bar return as of batch `seq`, or null. */
function topMomentum(state: BarsState, seq: number): string | null {
  let best: { symbol: string; now: bigint; then: bigint } | null = null;
  for (const { symbol } of state.hello.symbols) {
    if (state.positions.has(symbol)) continue;
    const closes = history.get(symbol)!;
    const now = closes[seq];
    const then = closes[seq - PROBE_LOOKBACK_BARS];
    if (now === null || now === undefined || then === null || then === undefined) continue;
    if (best === null || now * best.then > best.now * then) best = { symbol, now, then };
  }
  return best === null ? null : best.symbol;
}

/** 14-bar RSI in basis points (0..10000), or null when history is too short. */
function rsiBps(symbol: string, seq: number): bigint | null {
  const closes = history.get(symbol)!;
  if (seq < RSI_BARS) return null;
  let gains = 0n;
  let losses = 0n;
  for (let i = seq - RSI_BARS + 1; i <= seq; i++) {
    const now = closes[i];
    const prev = closes[i - 1];
    if (now === null || now === undefined || prev === null || prev === undefined) return null;
    if (now > prev) gains += now - prev;
    else losses += prev - now;
  }
  if (losses === 0n) return 10_000n;
  const rsBps = (gains * 10_000n) / losses;
  return (10_000n * rsBps) / (10_000n + rsBps);
}

/** True when the symbol's 6-bar return is at or below the dip line. */
function dipped(symbol: string, seq: number): boolean {
  const closes = history.get(symbol)!;
  const now = closes[seq];
  const sixBack = closes[seq - 6];
  if (now === null || now === undefined || sixBack === null || sixBack === undefined) return false;
  return now * 10_000n <= sixBack * BigInt(10_000 + DIP_BPS);
}

await runBars({
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol) ?? [];
      closes.push(state.close(symbol));
      history.set(symbol, closes);
    }
    if (state.warmingUp) return [];
    const orders: OrderInput[] = [];
    // Exits first: take profit, stop-loss, or the hold has run out.
    for (const [symbol, p] of state.positions) {
      const now = state.close(symbol);
      const entry = entryClose.get(symbol);
      if (now === null || entry === undefined) continue;
      const up = now * 10_000n >= entry * BigInt(10_000 + TAKE_PROFIT_BPS);
      const down = now * 10_000n <= entry * BigInt(10_000 + STOP_LOSS_BPS);
      const stale = (entrySeq.get(symbol) ?? batch.seq) + MAX_HOLD_BARS <= batch.seq;
      if (up || down || stale) {
        orders.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryClose.delete(symbol);
        entrySeq.delete(symbol);
      }
    }
    // Entries: oversold dip, one buy per symbol per bar, sized from cash on hand.
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    for (const { symbol } of state.hello.symbols) {
      if (state.positions.has(symbol)) continue;
      if (orders.some((o) => o.symbol === symbol)) continue;
      const rsi = rsiBps(symbol, batch.seq);
      if (rsi === null || rsi > RSI_MAX_BPS) continue;
      if (!dipped(symbol, batch.seq)) continue;
      const size = state.cash / BigInt(100 / POSITION_CASH_PCT);
      if (size < minNotional) continue;
      const close = state.close(symbol);
      if (close !== null) {
        entryClose.set(symbol, close);
        entrySeq.set(symbol, batch.seq);
      }
      orders.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    // Probe trade: after 10 bars with no order at all, buy a small 5% slice
    // of the strongest symbol so a calm window still clears the 8-trade
    // guardrail. It exits on the same take-profit / stop-loss / hold rules.
    if (orders.length === 0 && batch.seq >= PROBE_LOOKBACK_BARS && batch.seq - lastTradeSeq >= PROBE_GAP_BARS) {
      const symbol = topMomentum(state, batch.seq);
      if (symbol !== null) {
        const size = state.cash / BigInt(100 / PROBE_CASH_PCT);
        if (size >= minNotional) {
          const close = state.close(symbol);
          if (close !== null) {
            entryClose.set(symbol, close);
            entrySeq.set(symbol, batch.seq);
          }
          orders.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }
    if (orders.length > 0) lastTradeSeq = batch.seq;
    return orders;
  },
});
