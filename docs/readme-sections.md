## Safety model

A rescue moves a user's money without asking them first, so the question that matters is what happens if the keeper is hacked or simply wrong. Lifeline has two independent layers, and the second one doesn't trust the first.

The first layer is the policy engine in `packages/policy`, a pure function with no network access. It checks every rescue against 16 rules and reports every rule that fails: recipient, refund account, destination asset, pause, per-rescue cap, 24-hour cap, cooldown, whether health is really below the trigger, how old the health reading and quote are, slippage, reserve balance and token. Anything it can't read blocks the rescue. It judges what 1Click answered, not what the keeper asked for, and the keeper checks 1Click's signature on the quote before reading any of it.

The second layer is the vault contract, and it doesn't take the keeper's word for anything. A rescue has to carry the quote 1Click signed, and the vault checks 1Click's signature itself, then reads from the signed quote where the money goes: the deposit address, the Hyperliquid address it pays, the amount, and the account a failed swap refunds. They must match the rescue and the user's policy, and a quote more than 2 minutes old is refused. So a hacked keeper can't pay itself, even with a genuine quote and the right recipient. The vault also checks that the caller is the keeper the user named, that the user hasn't paused, that the amount fits both caps and the reserve, and that the cooldown has passed. If the transfer fails, a callback puts the money back in the reserve.

Changing a policy, unpausing and withdrawing each need 1 yoctoNEAR attached, which only a full-access key can do, so the user's wallet always asks them. A dapp's login key can pause, and nothing else.

The keeper's key can do very little. It's a NEAR function-call key that can call `rescue` on the vault and nothing else, so it can't withdraw, transfer funds or change anyone's policy. Only the user can do those things, and they can pause or withdraw at any time with their own signature. The Telegram bot's `/pause` only links to the dashboard, because the bot can't sign for them.

To watch it work, run `pnpm demo:attack`. It uses real signed 1Click quotes and needs no keys.

| Attack | Refused by |
| --- | --- |
| Pay a genuinely signed quote to the attacker's address | Policy engine: `RECIPIENT_MISMATCH` |
| Send a failed swap's refund to the attacker | Policy engine: `REFUND_MISMATCH` |
| Deliver to HyperEVM, where USDC adds no margin | Policy engine: `WRONG_DEST_ASSET` |
| Drain 1,000 USDC in one rescue | Policy engine: `OVER_PER_RESCUE`, `OVER_DAILY`, `INSUFFICIENT_RESERVE` |
| Rescue while the user has paused | Policy engine: `PAUSED` |
| Rescue again during the cooldown | Policy engine: `COOLDOWN` |
| Rescue a healthy account, to burn its reserve | Policy engine: `NOT_BELOW_TRIGGER` |
| Reuse a stale quote | Policy engine: `QUOTE_STALE` |
| Change a quote's recipient after 1Click signed it | Quote signature check |
| Call `rescue` itself, with the user's real address, a genuinely signed quote and its own account as the destination | Vault contract, on chain: `BAD_QUOTE` (testnet now, mainnet at Gate 2) |

The same run allows an honest rescue as a control, so it's clear the engine isn't just refusing everything. The last row is a real failed transaction, signed with the keeper's own restricted key, and the demo asks a public NEAR node about it each time rather than trusting a saved result.

Every warning, rescue, block and failure goes into an append-only audit log, where database triggers refuse any update or delete, and the whole log is public at `/api/ledger`. Before the keeper sends anything, it writes down that it's about to. After a crash or a timed-out send it looks for that rescue's quote ID in the vault's own history before freeing the user for another one, so a lost answer can't turn into a second payment.

The AI has no authority. After each decision, a model on NEAR AI Cloud adds a sentence or two of plain language, and nothing reads those words to decide anything. Each explanation starts with the record's own facts, generated from the record, so a figure on the ledger can't be wrong. The model's words come after them, and they're dropped if they contain a digit or a link, or claim something that didn't happen. The keeper's own notes, like "the money may still arrive", are kept word for word.

Run `pnpm --filter keeper attest` to check that the model runs in secure hardware. It requests a report with a fresh random nonce, checks every GPU through NVIDIA, checks the CPU quote through Intel, and confirms the quote vouches for the signing key, that nonce and the running software. It then does the same for NEAR AI's gateway. We last saw it pass on 8 GPUs with Intel status `UpToDate`. If NVIDIA or Intel can't be reached it says "not available", not "failed", because an outage isn't evidence of anything.

## Backtest results

We ran 18,000 random BTC, ETH and SOL positions through real Hyperliquid 4h candles from 26 July 2024 to 6 November 2026, at 5×, 10× and 20×, long and short, each held for 7 days. Each had $100 of margin and a $50 reserve. The rescue rules are the keeper's own, and a test holds the backtest's rescue size equal to the keeper's real sizing code. `pnpm backtest` regenerates everything from the candles saved in the repo, and two runs give identical output.

These numbers use assumed latency, 35 s and 120 s, until the measured figures replace them.

| Share of positions liquidated | No protection | Lifeline at 35 s | Lifeline at 120 s |
| --- | --- | --- | --- |
| 5× | 6.3% | 2.0% | 2.0% |
| 10× | 30.3% | 14.4% | 14.4% |
| 20× | 66.1% | 45.4% | 45.4% |
| All | 34.2% | 20.6% | 20.6% |

![Liquidation rate by leverage](research/backtest/charts/liquidation-rate.svg)

Candles can't show how fast a price moved inside them, so on 4h data almost no rescue is ever too late. That result comes from the data's coarseness, not from Lifeline being fast. To bound it, a second run squeezes each candle's adverse move into one minute, which is harsher than most real markets. Liquidations then come to 29.1% at 35 s and 29.4% at 120 s, against 34.2% unprotected, and 38.4% of rescues arrive too late. At that speed the fall from trigger to liquidation takes seconds, so neither latency gets there first. On 1m candles, the closest we have to real price speed, 2.1% of rescues were too late at 35 s and 4.2% at 120 s, but those cover only 4 days.

Lifeline costs money on average, and you should know that before using it. Across all positions the average result was -$0.15 without it and -$1.14 with it. A saved position finished $68.74 better on average. A position liquidated anyway finished $49.98 worse, because the reserve went with it, and 4,088 of the 18,000 lost more than the fee this way. Rescued positions used $41.86 of their $50 reserve on average. So Lifeline buys survival, not profit. Random entries have no edge, so this test can't show what a saved position earns for a trader who does.

Here's a real case where it failed. A SOL 10× long opened on 5 October 2025 at $232.70. In the crash of 10 October, SOL reached $137.51. Lifeline fired 5 rescues, spent the whole $50 reserve, and the position was liquidated anyway, for a result of -$128.33 against -$76.93 with no protection.

The full report, with the method, stress test, failure cases and how much the answer depends on our choices, is in [research/backtest/RESULTS.md](research/backtest/RESULTS.md).

## Limitations

These are the ones we know about.

- A hacked keeper can still rescue when no rescue is needed. The vault can't see Hyperliquid, so it can't check that health really is below the trigger. The money only ever goes to the user's own Hyperliquid account, within the caps (25 USDC per rescue and 50 USDC per 24 hours by default), and the user can pause or withdraw at any time.
- The vault trusts 1Click's signing key, set when the vault is deployed. If 1Click changes its key, rescues stop until the vault is redeployed with the new one. If 1Click's key were stolen, a hacked keeper with it could sign its own quotes.
- You trust the code with your reserve. The vault is a hackathon contract with no audit. A rescue also relies on 1Click and NEAR Intents to deliver, and on Hyperliquid to credit the account.
- The team can replace the vault's code. The vault account keeps its full-access key, so whoever holds that key could deploy a different contract. Deleting the key would make the code permanent; we haven't, because a bug fix would then need a new vault and every user would have to move.
- A rescue takes time, and a crash can be faster. Lifeline looks every 5 s, then has to get a quote, send it and wait for delivery. A price that falls from the trigger to liquidation within that time wins, and the flash-crash test shows how often that could happen.
- A top-up can be lost. It keeps a position open, and if the price keeps falling the reserve goes with it. Each rescue also costs 1Click's flat fee of about 0.32 USDC, and the smallest rescue is 2 USDC, so small rescues lose a large share to the fee.
- Only cross margin is protected. A top-up credits the perps balance and can't reach an isolated position's margin. An account with only isolated positions reads as unknown, never as safe.
- Health is an approximation of Hyperliquid's own calculation. On 5 sampled accounts our formula matched its liquidation price exactly on 2. On the other 3 its price was further away, so health read low and a rescue would fire early, not late. We haven't established why.
- Rescues use USDC only. The vault accepts wNEAR, but the caps are in USDC units and don't fit a 24-decimal token, so a wNEAR reserve can't pay for a rescue yet.
- The keeper is one Cloudflare Durable Object. Its alarm wakes it every 5 s, a cron re-arms the alarm if the loop ever stops, and the audit log lives in the object's own storage, so a restart or a deploy loses nothing. If Cloudflare or the object is down, nobody is watching. It picks up unfinished rescues when it restarts, but it can't start one while it's off. It runs on Cloudflare's free plan, whose daily limits it has to share with the public sim: an object that never sleeps uses about 85% of the duration allowance, so the sim sleeps between drops, and the keeper sets one alarm a minute and writes health once a minute to stay well inside the storage limits. `GET /` shows when it last ticked.
- Attestation shows that the hardware and signing key are genuine, not which model is running or that a given explanation came from it. The report's model name isn't signed, the software hash isn't pinned to a known build, and we don't check each answer's signature. It's rechecked every 6 hours. Explanations don't move money, so a wrong one could mislead a reader but can't lose funds.
- Anyone can request a Telegram link code for any watched account, because linking has no proof of ownership yet. A stranger could get a copy of someone's alerts and the owner couldn't remove them, though the same information is public on the ledger. One account can have several chats, so it can't cut off the owner.
- The backtest ignores funding, trading fees and price impact, and each account holds a single position. Real results would be somewhat worse.
