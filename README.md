# Lifeline

Auto top-up for onchain perps, funded from any chain.

Work in progress. To run the tests: `pnpm install && pnpm test`.

To watch the keeper rescue a position, with no wallet, keys or funds:

```sh
pnpm install
pnpm demo:sim
```

It opens a pretend position at the live ETH price from Hyperliquid and shocks the price below its trigger. The real keeper warns, gets a real dry quote from 1Click, runs the policy engine and finishes exactly one rescue, in about 15 seconds. It needs internet access. The settlement is simulated, so its latency isn't a real measurement.

To watch a hacked keeper try to steal a user's reserve, and get refused:

```sh
pnpm demo:attack
```

To check that the model writing Lifeline's explanations really runs in secure hardware, verified through NVIDIA and Intel with a fresh nonce:

```sh
pnpm --filter keeper attest
```

To check that the model writing Lifeline's explanations really runs in secure hardware, verified through NVIDIA and Intel with a fresh nonce:

```sh
pnpm --filter keeper attest
```

To rerun the backtest from the saved candles, which regenerates `research/backtest/RESULTS.md` and its charts in about 15 seconds:

```sh
pnpm backtest
```
