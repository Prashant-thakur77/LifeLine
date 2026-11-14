# Security

Lifeline is designed on the assumption that its own keeper gets hacked. The [safety model](README.md#safety-model) lists every check the vault makes before money moves, and the [limitations](README.md#limitations) list what it can't stop.

## What the vault guarantees

- Money from a reserve only ever goes to the Hyperliquid address the user named in their own policy, through a quote signed by 1Click, with failed swaps refunded to the user's own NEAR account.
- The keeper can't withdraw, transfer or change a policy: its only key is a function-call key for `rescue`.
- Caps per rescue and per 24 hours, a cooldown, and single-use deposit addresses hold even against a hacked keeper.
- The user can pause rescues or withdraw the whole reserve at any time.

What these guarantees rest on:

- The vault pays the 1Click deposit address named in the signed quote. Delivery from there to Hyperliquid is 1Click's job.
- The testnet vault trusts a team key to sign quotes in 1Click's place, because 1Click has no testnet. A mainnet vault is deployed trusting 1Click's own key ([docs/mainnet.md](docs/mainnet.md)); `get_config` shows which key a vault trusts.
- The vault account keeps its full-access key, so the team could deploy different code. The verify page shows whether that key still exists, and deleting it after an audit is on the [roadmap](ROADMAP.md).

## Check it yourself

- Try to rob the testnet vault: https://lifeline.prashantthakur.dev/attack
- Check the on-chain claims in your browser: https://lifeline.prashantthakur.dev/verify
- `pnpm demo:attack` replays a hacked keeper's attacks and re-checks a refusal on a public NEAR node.

## Reporting a problem

Please don't open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), with the steps to reproduce it. We will reply within 72 hours.

The vault has not had an external audit yet; that is the first step under Trust in the [roadmap](ROADMAP.md).
