# Lifeline

Automatic margin top-up for Hyperliquid traders, funded from any chain through NEAR Intents. The full plan is the shared doc "Lifeline — Build Plan & Work Split", which is not in git. A human pastes the Do and Done-when lines for each task.

Submit by **14 Nov, 20:00 IST**. Hard deadline: 14 Nov, 23:59 UTC. Tracks: `defi`, `security`, `open`.

## Rules

1. Read https://nearhackathon.com/HACKATHON.md and the Locked decisions below before writing code.
2. Use https://docs.near.org/llms.txt and https://docs.near-intents.org/llms.txt to find docs. Look up every contract ID, endpoint and SDK version. Never guess.
3. Only edit folders owned by the current teammate (table below). Never change `packages/shared` without asking. If you don't know which teammate you are working for, ask.
4. Never commit secrets. Keys live in `.env`; keep `.env.example` current.
5. Never send a mainnet transaction, spend funds, deploy to mainnet, change the repo's visibility or push to `main` without asking the human first.
6. Every new function gets a test. Run `pnpm test` before saying a task is done.
7. Keep the README's run commands correct whenever a command changes.

## How to work

- Plan first, then one micro-task at a time (one file or one function), never a whole task in one go.
- After each micro-task, run the tests or the live script and show the real output.
- Commit when the check passes. The human ticks the task in the Status tracker when its Done-when is met.
- Work on your own branch: `a/<task>` or `b/<task>`, e.g. `a/A4-vault`. Merge to `main` through a pull request once CI passes. Pull `main` at the start of every session.

## Who owns what

A never edits B's folders and B never edits A's. To ask the other side for something, write it in the Status tracker or tell your human to message them.

| Folder | Owner | What lives there |
| --- | --- | --- |
| `packages/shared` | B creates, both approve changes | Types and constants both sides import |
| `spike/` | A | Day-1 throwaway scripts. Kept as evidence, never imported |
| `contracts/vault` | A | The NEAR vault contract (Rust) and its tests |
| `packages/intents` | A | 1Click client: tokens, quote, deposit, status polling |
| `apps/web` | A | Dashboard |
| `packages/hyperliquid` | B | Reads positions and margin from Hyperliquid's info API |
| `packages/policy` | B | The Leash policy engine: a pure function, no network calls |
| `apps/keeper` | B | Watch loop, rescue orchestration, audit log, REST API |
| `apps/bot` | B | Telegram bot |
| `research/backtest` | B | Backtest scripts and `RESULTS.md` |
| `scripts/` | B | `demo:sim`, the attack demo, seeding |
| `README.md`, `docs/` | A writes, B adds sections | The judge-facing story |

## Locked decisions

Settled. Don't reopen them unless the day-1 spike proves one wrong.

**Stack**

| Piece | Choice |
| --- | --- |
| Language | TypeScript, strict mode, Node 22 LTS, pnpm workspaces |
| Vault contract | Rust, `near-sdk` 5.x, built with `cargo-near`, tested with `near-workspaces` sandbox |
| Dashboard | Next.js (App Router) + Tailwind. Wallet via HOT's `near-connect`; NEAR Wallet Selector if it fails |
| Chain calls from TypeScript | `near-api-js` or `near-kit` (whichever the NEAR agent skill recommends) |
| Tests | `vitest` for TypeScript, `cargo test` + `near-workspaces` for the contract |
| Keeper storage | SQLite (`better-sqlite3`), one file |
| Telegram | `grammY` |
| AI explanations | NEAR AI Cloud, OpenAI-compatible API at `https://cloud-api.near.ai/v1` |
| Hosting | Cloudflare, on the human's domain. Keeper and bot: one Worker with a Durable Object (`apps/keeper/wrangler.jsonc`), the real one at `lifeline-keeper.prashantthakur.dev` and the always-on sim at `lifeline-sim.prashantthakur.dev`. Dashboard: Cloudflare too. Changed on 2026-11-08 from Vercel and Railway at the human's request: their Vercel team is paused until 8 Dec 2026 |
| Licence | MIT |

**Accounts**

- The team mainnet account receives the prize and owns the sub-accounts.
- Vault contract at `vault.<team>.near`.
- Keeper at `keeper.<team>.near`. Its only key is a function-call key that can call `rescue` on the vault and nothing else. It can't withdraw, transfer or change policy.
- Testnet mirrors of all three, `.testnet`, for contract development.

**Health formula**

- `health = accountValue / maintenanceMarginUsed`, both read from Hyperliquid's `clearinghouseState`. Hyperliquid liquidates as health approaches 1.0.
- Rescue size: `needed = target × maintenanceMarginUsed − accountValue`. We send `(needed + quote.withdrawFee) × 1.01`, cut down to the policy caps and the reserve balance, and never less than 2 USDC. Changed on 2026-11-06 from a flat 0.2 USDC, which made the policy engine block every rescue needing about $11 or less.

**Default policy** (values are in `packages/shared/src/constants.ts`)

| Setting | Default | Allowed range |
| --- | --- | --- |
| Warn (Telegram alert only) | 1.8 | 1.3 to 3.0 |
| Trigger (rescue fires) | 1.5 | 1.2 to 2.5, must be below warn |
| Target (health after rescue) | 2.0 | above trigger, up to 4.0 |
| Max per rescue | 25 USDC | user sets |
| Max per 24 h | 50 USDC | user sets |
| Cooldown between rescues | 120 s | 30 to 3,600 s |
| Keeper poll interval | 5 s | fixed |
| Max quote slippage | 1% | fixed |
| Max quote age at execution | 60 s | fixed |

**Reserve assets in the first version:** native USDC on NEAR and wNEAR. A user funds the reserve from any chain via 1Click into their own NEAR account, then deposits into the vault.

## Shared interfaces

Both sides build against these at the same time. Neither side changes them without telling the other. If you want to change one, stop and ask.

- Types: `packages/shared/src/types.ts`, as agreed in the plan.
- REST response shapes: `packages/shared/src/api.ts`.
- Fake data for every endpoint: `packages/shared/fixtures`. Import from `@lifeline/shared/fixtures`, or read the JSON.

**Vault contract methods** (A builds these; B's keeper calls `rescue`)

| Method | Who can call | What it does |
| --- | --- | --- |
| `ft_on_transfer` (via `ft_transfer_call`) | Any user | Credits the deposited token to the sender's reserve. Rejects tokens not on the allowlist |
| `set_policy(policy)` | The user | Saves their policy, with range checks. Includes `hl_address` and the keeper allowed to act |
| `pause()` / `unpause()` | The user | Stops or restarts rescues for that user immediately |
| `withdraw(token, amount)` | The user | Returns reserve funds to the user's own NEAR account, any time |
| `rescue(user, token, amount, deposit_address, recipient, quote_id)` | The keeper account only | Checks `recipient == policy.hl_address`, not paused, amount ≤ per-rescue cap, 24 h total ≤ daily cap, cooldown passed, enough reserve. Then sends the tokens to `deposit_address` and emits an event |
| `get_policy(user)`, `get_reserve(user)`, `get_rescues(user, from, limit)` | Anyone (view) | Read state for the dashboard and auditors |

The contract emits NEP-297 events (`EVENT_JSON:`) named `deposit`, `policy_set`, `paused`, `withdraw` and `rescue`. The `rescue` event carries `user`, `amount`, `recipient`, `quote_id` and `deposit_address`.

**Keeper REST API** (B builds it; A's dashboard calls it)

| Endpoint | Returns |
| --- | --- |
| `GET /api/health/:user` | The latest `HealthSnapshot` plus the user's policy |
| `GET /api/audit?user=&limit=` | `AuditRecord[]`, newest first |
| `GET /api/ledger?limit=` | Every user's `AuditRecord[]`, for the public ledger page |
| `GET /api/stats` | Total rescues, total USD rescued, blocked count, p50 and p95 latency |
| `POST /api/telegram/link` | A one-time code the user sends to the bot to link their chat |
| `GET /api/attestation` | The latest NEAR AI Cloud attestation check result |

## Facts checked against live APIs

Checked on 2026-11-06 with no-funds calls. Re-check before relying on one.

- `maintenanceMarginUsed` is the top-level `crossMaintenanceMarginUsed` and `accountValue` is `crossMarginSummary.accountValue`, both in `clearinghouseState`. Don't use `marginSummary.accountValue`: it also counts isolated margin, which can't save a cross position.
- Health covers cross margin only. An isolated position isn't protected by a top-up, and an account with only isolated positions reads 0 maintenance margin. `packages/hyperliquid` reports that as unknown, never safe.
- On 5 sampled single-position cross accounts, the formula matched Hyperliquid's `liquidationPx` exactly on 2. On the other 3 Hyperliquid's price was further away, so health reads low and a rescue fires early, not late. All 4 accounts looked up with `userAbstraction` (both exact matches and 2 of the other 3) were `unifiedAccount`s holding spot USDC, so unified mode alone doesn't explain the gap.
- Hyperliquid keeps only about the most recent 5,000 candles per interval: 1m reaches back about 3.5 days, 5m to October 2026, 15m to September 2026, 1h to April 2026, 4h to July 2024. 1d goes back to August 2020, before Hyperliquid launched, so the older daily candles must come from elsewhere.
- The 1Click destination for margin is `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054` (8 decimals), which credits the perps balance. The similar `1cs_v1:hypercore:erc20:…` USDC lands on HyperEVM and doesn't add margin.
- The minimum for a NEAR USDC → Hyperliquid USDC quote is above 1 USDC: 1 USDC was rejected with "Amount is too low for the destination chain", 2 USDC worked. The docs' 0.5 USDC minimum and 0.2 USDC fee are for deposits from Hyperliquid, the opposite direction.
- Those quotes lose a flat `quote.withdrawFee` of about 0.3153 USDC plus about 0.011%. The keeper reads the fee from a dry quote before sizing each rescue, so it follows any change.
- `minAmountOut` is about 1% of the amount sent below `amountOut`, so the fee isn't part of the slippage. `swapType: EXACT_OUTPUT` also quotes on this route (3.0 USDC out for 3.349117 in), but hasn't been tried with real money.
- `refundTo` must be an existing NEAR account, or the quote fails with a 400.
- `GET /v1/attestation/report` answered without an API key for `deepseek-ai/DeepSeek-V4.1-Flash-1017`, though the NEAR agent skill says one is required, so send the key when there is one. Its `report_data` is the signing address padded to 32 bytes, then the nonce. `pnpm --filter keeper attest` verified it end to end through NVIDIA's NRAS and Intel's DCAP: 8 GPUs, Intel status `UpToDate`.
- The quote response has no `quoteId` field. Its top-level keys are `quote`, `quoteRequest`, `signature`, `timestamp` and `correlationId`. The keeper passes `correlationId` as the vault's `quote_id`.
- `verifyQuoteSignature` from `@defuse-protocol/one-click-sdk-typescript` accepts real dry and non-dry quotes and rejects a changed recipient or deposit address. It costs about 12 ms of CPU (tweetnacl), so the keeper checks the SDK's own `quoteHash` with noble's Ed25519 instead: 1.9 ms, and tests hold it to the SDK's answer on real quotes and on every tampered field. A non-dry quote's `deadline` came back about 3 days out even when we asked for 5 minutes, so a deposit address stays usable long after the keeper's 60 s limit.

Checked on 2026-11-08 on Cloudflare, with the sim deployed at `lifeline-sim.prashantthakur.dev`:

- A Durable Object's SQLite runs the keeper's store unchanged: the triggers refuse `UPDATE` and `DELETE` on the audit log, and `json_extract`, `RETURNING` and a rolled-back `transactionSync` all work. Intel's web verifier (`@phala/dcap-qvl-web`) verifies the attestation on Cloudflare: 6 of 6 checks.
- Alarm invocations used up to 77 ms of CPU (the first, with the attestation check) and 43 ms (a rescue), all with outcome `ok`, so the Durable Object isn't held to the free plan's 10 ms per request.
- An object woken every few seconds never goes idle, so it is billed duration all day: at 128 MB about 11,000 GB-s a day of the free plan's 13,000. The real keeper fits; the sim sleeps between drops so both can run.
- The free plan also allows 100,000 rows written and 5 million rows read a day, and each `setAlarm` counts as a row written. Past a limit, operations of that type fail until 00:00 UTC. So the keeper sets one alarm a minute and ticks every 5 s inside it, writes each user's health at most once a minute, caches stats, limits link codes, and the Worker caches API reads for 5 s.
- After a deferred code update on 2026-11-08 the sim's stored alarm stopped firing, which left it silently idle. The cron now re-arms any alarm more than 2 minutes overdue, and `/` shows `lastTickAt` and `nextAlarmAt` so a stall is visible.
- `wrangler deploy` once failed with "The request to Cloudflare's API timed out" and left the old version live. Check `wrangler deployments list` after a deploy.
- A deploy reaches a running Durable Object only when it hibernates or after 300 s, Cloudflare's default deferred code update. The keeper never hibernates, so a fix takes up to 5 minutes to reach it. On the switch the object restarts, and the keeper picks up any unfinished rescue from its log.

## Commands

```sh
pnpm install
pnpm test                        # all TypeScript tests, then the vault's cargo tests
pnpm typecheck
pnpm --filter <package> test     # one package, e.g. pnpm --filter policy test
pnpm --filter keeper sim         # the keeper with a scripted price drop: no wallet, keys or funds
pnpm --filter keeper live        # the real keeper: reads .env, and mainnet also needs KEEPER_ALLOW_MAINNET=yes
                                 # 1Click has no testnet, so on testnet live stops at the quote
pnpm --filter keeper attest      # one real NEAR AI Cloud attestation check, through NVIDIA and Intel
pnpm backtest                    # regenerates research/backtest/RESULTS.md and its charts from the saved candles
pnpm demo:sim                    # the whole rescue story from the live ETH price: no wallet, keys or funds
pnpm demo:attack                 # a hacked keeper's attacks, all refused, and the saved mainnet refusal re-checked on chain
pnpm --filter hyperliquid live <address>   # print a real snapshot for an account
pnpm --filter keeper cf:dev      # the sim keeper on Cloudflare's runtime, locally
pnpm --filter keeper cf:deploy:sim   # deploys lifeline-sim.prashantthakur.dev (needs a Cloudflare login)
pnpm --filter keeper cf:deploy   # the real keeper: set its secrets first, and ask the human before mainnet
```

Packages are TypeScript source with no build step. `apps/web` needs `transpilePackages: ["@lifeline/shared"]` in its Next config. `.gitkeep` files in `apps/web`, `contracts/vault`, `docs` and `spike` only hold the empty folders; delete them when real files arrive.
