# Contributing

## Set up

Node 22 and pnpm, plus Rust and `cargo-near` for the vault.

```sh
pnpm install
pnpm test        # every TypeScript test, then the vault's unit and sandbox tests
pnpm typecheck
```

`pnpm demo:sim` runs the whole rescue story from the live ETH price with no wallet, keys or funds. [README.md](README.md#all-the-commands) lists every other command.

## Where things live

| Folder | What it is |
| --- | --- |
| `contracts/vault` | The vault contract (Rust) and its tests |
| `packages/policy` | The policy engine, a pure function |
| `packages/intents` | The 1Click client |
| `packages/hyperliquid` | Hyperliquid health and candles |
| `apps/keeper` | Watch loop, rescues, audit log, API |
| `apps/web` | The dashboard |
| `research/` | Backtest, latency and money-path runs, each with a `RESULTS.md` |

## Making a change

- Work on a branch and open a pull request. CI runs the tests and the typecheck, and a change merges once it passes.
- Every new function gets a test.
- Never commit keys. They live in `.env`; keep `.env.example` current.
- A number in the README or a film comes from a file in `research/` or from the chain. Change the source, not the copy.
- Report a vulnerability privately, as [SECURITY.md](SECURITY.md) explains.
