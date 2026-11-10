# Lifeline: what's left, and how to do it

Submission is due **14 Nov, 20:00 IST** (hard deadline 14 Nov, 23:59 UTC). The code is done and live. What's left is mostly going live on mainnet, the video and the submission. Do the tasks in order; each one says when it's finished.

## Where things are

- Live site: https://lifeline.prashantthakur.dev
  - `/verify`: every security claim checked in the visitor's browser (reads 4 proven, 3 trusted, 0 failed)
  - `/attack`: the "rob the vault" lab (switched off until task 1 is done)
  - `/ledger`, `/position?user=demo.near`, `/check`: the live demo
- Demo keeper (sim): https://lifeline-sim.prashantthakur.dev
- Telegram bot: https://t.me/LifeLineNearBot
- Repo: https://github.com/Prashant-thakur77/LifeLine. Read `README.md`, then `CLAUDE.md` (all the rules and checked facts), then `docs/mainnet.md`.

## Setup (once)

```sh
git clone https://github.com/Prashant-thakur77/LifeLine && cd LifeLine
pnpm install
cp .env.example .env      # ask Prashant for the real values through the password manager, never in chat
pnpm test                 # about 1,480 TypeScript tests plus the vault's cargo tests; all should pass
pnpm demo:sim             # the whole rescue story in under 30 s, no keys needed
```

## Rules

- Never commit `.env`, keys or seed phrases. Keys go only in `.env` and the password manager.
- **Nothing on mainnet without Prashant's yes:** no transactions, no deploys, no spending.
- Work on a branch (`a/<task>`), open a pull request, merge only when CI is green.
- Commit messages: one short plain line saying what changed.
- Don't add credits or mentions of other projects anywhere. Prashant writes those himself.

## Tasks

### 1. Switch on the attack lab (10 min, needs the Cloudflare login)

The demo keeper needs two testnet-only keys, both already in Prashant's `.env`. Run this from the repo root on the machine logged in to Cloudflare:

```sh
cd apps/keeper && for n in TESTNET_LAB_KEEPER_KEY TESTNET_QUOTE_SIGNER_KEY; do grep -m1 "^$n=" ../../.env | cut -d= -f2- | pnpm dlx wrangler@4.158.0 secret put $n --env sim; done
```

Done when, within about 5 minutes, https://lifeline-sim.prashantthakur.dev/api/lab answers with JSON instead of 404, and pressing "Send this attack" on https://lifeline.prashantthakur.dev/attack shows a red "Refused" stamp with "✓ Your browser read it back".

### 2. Top up testnet NEAR (15 min)

`lifeline-team.testnet` has only about 0.18 NEAR left. Get testnet NEAR from the faucet (https://near-faucet.io or `near account create-account sponsor-by-faucet-service <new-name>.testnet ...` and send it on) and move about 5 NEAR to `lifeline-team.testnet`. Leave `lab-keeper.lifeline-team.testnet` as it is (about 0.6 NEAR, enough for about 2,500 attacks).

Done when `lifeline-team.testnet` holds over 3 NEAR.

### 3. Mainnet go-live with one real rescue (2 to 3 h, with Prashant)

This is the biggest gap against the other DeFi entries: a real rescue with real money. Follow `docs/mainnet.md` step by step. It needs:

- the team mainnet account (Prashant's Meteor account), imported into the NEAR CLI with `near account import-account using-seed-phrase network-config mainnet`. **Prashant types the seed phrase himself.**
- about 6 NEAR for accounts, storage and gas
- about 20 USDC on NEAR (the reserve). Prashant's MetaMask USDC can come in through the site's Fund page (`/fund`, step 1) or https://near-intents.org. Send 5 USDC first as a test.
- about 15 USDC in the Hyperliquid account (the MetaMask address), with a small ETH long, Cross margin, about 3x

Steps, in short: create `vault.<team>.near` and `keeper.<team>.near`, build the vault with `cd contracts/vault && cargo near build reproducible-wasm` from a pushed commit, deploy it, give the keeper its rescue-only key, set the real keeper's secrets, deploy it with `pnpm --filter keeper cf:deploy`, set a policy for the account from the dashboard, deposit the reserve. Then raise the policy's trigger above the current health (or wait for a dip) so one rescue fires.

Then add the mainnet deployment to the verify page: one entry in `DEPLOYMENTS` in `apps/web/src/lib/verify.ts` (vault, keeper, code hash, `quoteSigner` set to 1Click's key with `isOneClick: true`), and redeploy the dashboard.

Done when one rescue shows on the ledger with a real NEAR transaction and a real 1Click swap, the margin arrived on Hyperliquid, and `/verify` shows a mainnet section.

### 4. A second Telegram bot for the real keeper (15 min)

The demo keeper owns @LifeLineNearBot. The real keeper needs its own bot: create one with @BotFather, put its token in `.env` as `TELEGRAM_BOT_TOKEN` for the live keeper, and set it as a secret on the `lifeline-keeper` Worker (`wrangler secret put TELEGRAM_BOT_TOKEN`, top-level env, not `--env sim`).

Done when `/start` on the new bot answers and a linked account gets the real keeper's alerts.

### 5. The demo video (half a day)

Check the maximum length and format in https://nearhackathon.com/HACKATHON.md first. Suggested story:

1. The problem, 15 s: a perps trader gets liquidated while asleep, though they had money on another chain.
2. The rescue, 60 s: the landing page replays a rescue; then the real mainnet rescue from task 3 (ledger row, NEAR transaction, the margin landing on Hyperliquid, the Telegram alert).
3. Why it's safe, 45 s: open `/attack`, send two attacks, show the vault refusing on chain; then `/verify` going green.
4. The AI, 20 s: the highlighted model sentence and its signature check on `/verify`.
5. Numbers, 15 s: the backtest (`research/backtest/RESULTS.md`) and the funding-from-any-chain step on `/fund`.

Done when the video is uploaded (unlisted is fine) and the link works signed out.

### 6. Draft the submission, for Prashant to send (1 h)

Write the form answers in a doc, don't submit them. Include: the one-line pitch, the tracks (`defi`, `security`, `open`), links (site, repo, video, bot), what's built on NEAR (copy the README table), the team, and the disclosures the rules ask for (AI tool use, and anything built before the hackathon). Prashant reviews and submits.

Done when Prashant has the draft.

### 7. One more pass on the site (1 h)

Open every page on a phone and a laptop: home, `/position?user=demo.near`, `/check`, `/ledger`, `/verify`, `/attack`, `/fund`, `/start`, `/telegram`. File anything broken or confusing as a GitHub issue with a screenshot.

Done when every page has been checked and the issues are filed.

### 8. The X post, after the video (30 min)

Draft a short post with the video and the site link, for Prashant to approve and post.

## If something breaks

- Demo keeper stuck: https://lifeline-sim.prashantthakur.dev shows `lastTickAt`. A deploy takes up to 5 minutes to reach it. Redeploy with `pnpm --filter keeper cf:deploy:sim`.
- Tests: `pnpm test` must pass before any merge.
- Ask Prashant before anything touching mainnet, money or the submission.
