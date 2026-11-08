/**
 * The backtest's headline results, as research/backtest/RESULTS.md reports them. A test
 * holds these equal to that file, so the page can't drift from the research: regenerate
 * the report with `pnpm backtest`, then update these numbers if the test says so.
 */
export type Row = { label: string; without: number; lifeline: number; lifelineP95: number };

export const BACKTEST = {
  positions: 18_000,
  period: "2024-07-26 to 2026-11-06",
  candles: "4h",
  holdDays: 7,
  /** Liquidation rates in percent, on the real candles. */
  byLeverage: [
    { label: "5×", without: 6.3, lifeline: 2.0, lifelineP95: 2.0 },
    { label: "10×", without: 30.3, lifeline: 14.4, lifelineP95: 14.4 },
    { label: "20×", without: 66.1, lifeline: 45.4, lifelineP95: 45.4 },
    { label: "All", without: 34.2, lifeline: 20.6, lifelineP95: 20.6 },
  ] as Row[],
  byCoin: [
    { label: "BTC", without: 21.8, lifeline: 11.1, lifelineP95: 11.1 },
    { label: "ETH", without: 37.1, lifeline: 22.1, lifelineP95: 22.1 },
    { label: "SOL", without: 43.8, lifeline: 28.7, lifelineP95: 28.7 },
    { label: "All", without: 34.2, lifeline: 20.6, lifelineP95: 20.6 },
  ] as Row[],
  /** The flash-crash stress test: every candle's adverse move in its first minute. */
  flashByLeverage: [
    { label: "5×", without: 6.3, lifeline: 5.5, lifelineP95: 5.5 },
    { label: "10×", without: 30.3, lifeline: 25.9, lifelineP95: 26.1 },
    { label: "20×", without: 66.1, lifeline: 56.0, lifelineP95: 56.7 },
    { label: "All", without: 34.2, lifeline: 29.1, lifelineP95: 29.4 },
  ] as Row[],
  /** Mean profit and loss per position, USD. */
  pnlWithout: -0.15,
  pnlWith: -1.14,
};
