# Roadmap

What comes after the hackathon, in order. Each step either takes Lifeline to real users or closes a limitation listed in the [README](README.md#limitations).

## 1. Mainnet

Done during the hackathon:

- The vault is live on NEAR mainnet at [`vault.lifeline-hq.near`](https://nearblocks.io/address/vault.lifeline-hq.near), from the same reproducible build as testnet and trusting 1Click's own signing key. Its keeper, `keeper.lifeline-hq.near`, holds only a function-call key for `rescue`.
- The first real rescue: 2 USDC from the vault through 1Click, and 1.684355 USDC in a Hyperliquid perps balance 48.6 s after the rescue transaction ([research/mainnet/RESCUE.md](research/mainnet/RESCUE.md)).

Next:

- Run the keeper against the mainnet vault around the clock, with its own Cloudflare Worker and alerts when it stops.
- Point the hosted dashboard at the mainnet vault and open sign-up. The footer and the verify page switch to mainnet on their own once a mainnet vault is configured.

## 2. Trust

- An external audit of the vault contract.
- After the audit, delete the vault account's full-access key, so its code can never change. The verify page already shows whether that key exists.
- Prove ownership before linking Telegram alerts, so only the account's owner can subscribe.
- A second, independent keeper. The vault already lets a user name the keeper they trust; a fallback keeper would cover the time one is down.

## 3. Revenue

- A Lifeline fee of up to 0.25% per rescue through 1Click's `appFees`, paid by 1Click to the team's account. The vault's quote checks already allow it, and the trader sees it in the signed quote ([README](README.md#why-this-is-a-business)).
- Keep running costs near zero: the keeper runs on Cloudflare's free plan, and the vault's storage costs about 0.005 NEAR per rescue.

## 4. Reach

- An SDK for perps front-ends that already fund through NEAR Intents, so a trader can turn Lifeline on where they trade.
- Rescues paid from wNEAR as well as USDC: the vault can already allow wNEAR deposits, and the caps need a per-token unit.
- More venues after Hyperliquid, wherever 1Click can deliver margin.
