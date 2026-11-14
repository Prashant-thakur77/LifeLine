# Lifeline videos: what to post where

Two films, both built from code in this folder:

| File | Length | Use |
| --- | --- | --- |
| `final_full.mp4` | 3:33 | The main film: problem, solution, real testnet activity, the attack lab, how it differs, why NEAR, the numbers. Use it on X if the posting account has X Premium, and on YouTube |
| `final.mp4` | 2:19 | The same story cut to fit a standard X account's 2:20 upload limit |
| `final_tech.mp4` | 3:36 | The technical walkthrough, for YouTube, with chapters in `chapters_tech.txt` |

Captions are burned into both, because most people watch muted on X.

## The X post (the human posts it)

The rules (HACKATHON.md, "The demo post"): say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, attach the video, link the demo and the repo, ask a genuine question.

> Lifeline tops up your Hyperliquid margin before you're liquidated, funded from any chain through NEAR Intents.
>
> A hacked keeper still can't steal: the vault on NEAR refuses it on chain. Try to rob it yourself, which trick would you try first?
> lifeline.prashantthakur.dev/attack
>
> Built at NEAR HACKATHON @NEARProtocol #NEARHackathon

Reply to the post with the second link, so the main post stays short:

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

Fields (HACKATHON.md, "Submission API"): project name, lead name, email, team size, tracks, NEAR payout account, repository link, demo post link, idea, consent. The human fills in the personal fields and sends it; draft the "idea" from the README's first paragraph. Tracks: `defi`, `security`, `open`.
