# Lifeline

Auto top-up for onchain perps, funded from any chain.

Work in progress. To run the tests: `pnpm install && pnpm test`.

To watch the keeper rescue a position, with no wallet, keys or funds:

```sh
pnpm install
pnpm --filter keeper sim
```

A scripted price drop takes the account below its trigger. The keeper warns, gets a real dry quote from 1Click, runs the policy engine and finishes exactly one rescue, in about 15 seconds. It needs internet access for the quotes. The settlement is simulated, so its latency isn't a real measurement.

To check that the model writing Lifeline's explanations really runs in secure hardware, verified through NVIDIA and Intel with a fresh nonce:

```sh
pnpm --filter keeper attest
```

To rerun the backtest from the saved candles, which regenerates `research/backtest/RESULTS.md` and its charts in about 15 seconds:

```sh
pnpm backtest
```
