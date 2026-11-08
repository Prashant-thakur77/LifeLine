# Lifeline

Auto top-up for onchain perps, funded from any chain.

Work in progress. To run the tests: `pnpm install && pnpm test`. That includes the vault contract's Rust tests, which need [Rust](https://rustup.rs) and `rustup target add wasm32-unknown-unknown`; without them it runs the rest and says so.

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

The vault contract is in [contracts/vault](contracts/vault), which lists every method with a NEAR CLI example. It's deployed on testnet at [vault.lifeline-team.testnet](https://testnet.nearblocks.io/address/vault.lifeline-team.testnet), where the keeper's only key can call `rescue` and nothing else. A rescue has to carry the quote 1Click signed, and the vault checks the signature and reads where the money goes from it. There it refused a rescue that named the user's real address and carried a validly signed quote, but pointed the money at the keeper's own account ([transaction](https://testnet.nearblocks.io/txns/A9QZC5bVA1iQUo2CEhksRNFvj77951GrmmJq835joKCn)), and `pnpm demo:attack` checks that refusal on chain again each time it runs.

To get a real dry quote from 1Click, NEAR USDC to Hyperliquid USDC, with no wallet or funds:

```sh
pnpm --filter intents live-quote 5 0xYourHyperliquidAddress
```

To check that the model writing Lifeline's explanations really runs in secure hardware, verified through NVIDIA and Intel with a fresh nonce:

```sh
pnpm --filter keeper attest
```

The same sim keeper runs around the clock on Cloudflare, at https://lifeline-sim.prashantthakur.dev. About every 15 minutes it plays the price drop again and rescues once, and it serves the API the dashboard reads: [stats](https://lifeline-sim.prashantthakur.dev/api/stats), [ledger](https://lifeline-sim.prashantthakur.dev/api/ledger), [health](https://lifeline-sim.prashantthakur.dev/api/health/demo.near) and [attestation](https://lifeline-sim.prashantthakur.dev/api/attestation). Everything in it is simulated except the dry quotes, the ETH price and the attestation check.

To run that Worker on Cloudflare's runtime locally, or to deploy it (needs a Cloudflare login):

```sh
pnpm --filter keeper cf:dev
pnpm --filter keeper cf:deploy:sim
```

To rerun the backtest from the saved candles, which regenerates `research/backtest/RESULTS.md` and its charts in about 15 seconds:

```sh
pnpm backtest
```
