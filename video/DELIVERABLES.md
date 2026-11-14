# Lifeline videos: what to post where

Two films, both built from code in this folder:

| File | Length | Use |
| --- | --- | --- |
| `final_full.mp4` | 3:42 | The main film: problem, solution, real testnet activity, the attack lab, how it differs, why NEAR, the numbers. Use it on X if the posting account has X Premium, and on YouTube |
| `final.mp4` | 2:19 | The same story cut to fit a standard X account's 2:20 upload limit |
| `final_tech.mp4` | 3:44 | The technical walkthrough, for YouTube, with chapters in `chapters_tech.txt` |

Captions are burned into both, because most people watch muted on X.

## The X post (the human posts it)

Per HACKATHON.md: lead with the user problem, show one complete moment, say concretely what NEAR enables, give a next step and a genuine question, say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon (optionally @NearLegion and @NearBuilders), attach the video.

Free account (fits 280 characters, attach `final.mp4`, 2:19):

> Traders get liquidated in their sleep. Lifeline tops up your Hyperliquid margin first, from a reserve funded on any chain via NEAR Intents. Proven on mainnet: 57 s.
>
> A hacked keeper still can't steal: lifeline.prashantthakur.dev/attack
>
> Built at NEAR HACKATHON @NEARProtocol #NEARHackathon

X Premium (attach `final_full.mp4`, 3:42):

> Leveraged traders get liquidated in their sleep, often with money sitting on another chain.
>
> Lifeline watches your Hyperliquid account every 5 seconds and tops up your margin before liquidation, from a reserve you fund from any chain. NEAR Intents moves the money: on mainnet, real funds went from NEAR into a Hyperliquid perps balance in 57 seconds.
>
> And a hacked keeper still can't steal: its NEAR key can only call rescue, and the vault checks 1Click's signed quote on chain. Seven attacks, seven refusals. Try to rob it: lifeline.prashantthakur.dev/attack
>
> Which attack would you try first?
>
> Built at NEAR HACKATHON @NEARProtocol #NEARHackathon @NearBuilders

Reply to the post:

> Code, tests and a five-minute way to verify every claim: github.com/Prashant-thakur77/LifeLine
> Technical walkthrough: <YouTube link>

## YouTube: technical walkthrough

Title: `Lifeline: technical walkthrough (NEAR Intents, Hyperliquid, NEAR AI)`

Description:

> Lifeline tops up a Hyperliquid trader's margin before liquidation, from a reserve funded on any chain through NEAR Intents. This walkthrough shows how a rescue is sized and checked, why a hacked keeper can't steal (all seven attack-lab tricks refused on NEAR testnet, live), the reproducible vault build, NEAR AI Cloud's signed and attested explanations, and the backtest.
>
> Try it: https://lifeline.prashantthakur.dev
> Rob the vault: https://lifeline.prashantthakur.dev/attack
> Check every claim: https://lifeline.prashantthakur.dev/verify
> Code: https://github.com/Prashant-thakur77/LifeLine
>
> Built at NEAR HACKATHON.

Chapters: generated from `narration_tech/timeline.json` (see `chapters_tech.txt`).

## The submission form

Draft of "What you built" (under 2,000 characters):

> Leveraged perps traders on Hyperliquid get liquidated when a price drop outruns them, often while they sleep and with money sitting on another chain. Lifeline is a safety net: you fund a reserve from any chain through NEAR Intents (1Click), set a policy (when to warn, when to rescue, caps, cooldown), and a keeper reads your account's health every 5 seconds. Below your trigger, it gets a 1Click quote and asks the Lifeline vault, a Rust contract on NEAR, to pay it straight into your Hyperliquid perps margin.
>
> A hacked keeper can't steal: its only key is a NEAR function-call key that can call rescue and nothing else, and the vault verifies 1Click's ed25519 signature on chain and pays only a quote for your own Hyperliquid address, within your caps. A public attack lab lets anyone send seven tricks to the testnet vault, and all are refused on chain. A verify page checks every claim in the browser, including NEAR AI Cloud's TEE attestation and the signature on each AI explanation.
>
> Proof: the money path ran on mainnet with real funds (NEAR to a Hyperliquid perps balance in 56.9 s, public transactions). The vault runs on NEAR testnet from a reproducible build, with 34 real rescues. A backtest on 18,000 positions over two years of real Hyperliquid prices cut liquidations from 34.2% to 20.6%. 1,519 TypeScript tests and 62 contract tests.
>
> NEAR is the backbone: NEAR Intents for any-chain funding and every rescue, function-call keys for the keeper, the vault's on-chain checks, and NEAR AI for verifiable explanations.

Fields (HACKATHON.md, "Submission API"): project name, lead name, email, team size, tracks, NEAR payout account, repository link, demo post link, idea, consent. The human fills in the personal fields and sends it; draft the "idea" from the README's first paragraph. Tracks: `defi`, `security`, `open`.
