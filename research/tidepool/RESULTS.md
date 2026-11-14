# Lifeline's money path on testnet, through Tidepool

Run once on 13 November 2026 at 07:54 UTC with `pnpm demo:tidepool`. Testnet only: the USDC is test USDC with no value.

1Click has no testnet, so this run goes through [Tidepool](https://www.usetidepool.tech), a community-built testnet sandbox with 1Click's API (quote, deposit, status) and quotes signed the same way. Tidepool isn't official NEAR Intents infrastructure: it runs NEAR's unmodified verifier contract on testnet, with its own maker and its own relayer to Hyperliquid testnet. The script uses the same 1Click client as the keeper, pointed at Tidepool's base URL and Tidepool's quote-signing key.

## What happened

| Step | Result |
| --- | --- |
| Hyperliquid testnet balance of `0xeb53d86545691F875b0F35745899A7A1E27706a9`, before | 0 USDC |
| Live quote from Tidepool, 3 NEAR testnet USDC to that perps balance | `61f68aad-72a9-41fc-98a4-bc367fcb9bb7`: 3 USDC in, at least 2.962278 out, refund to `soham-lifeline.testnet` |
| Quote signature | Valid for Tidepool's maker key `ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY`, the only key on `maker.tidepool-sandbox.testnet` |
| Quote fields checked before paying | Recipient, destination asset `nep141:hypercore.tp-omft.testnet`, amount, minimum out (at least 97% of what's sent), refund account, a fresh implicit deposit address |
| Deposit from `soham-lifeline.testnet` | One transaction on `usdc.tidepool-sandbox.testnet`: `storage_deposit` for the deposit address, then `ft_transfer` of 3 USDC |
| Tidepool status | `KNOWN_DEPOSIT_TX` at 1.7 s, `PROCESSING` at 8.7 s, `SUCCESS` at 13.4 s |
| Hyperliquid testnet balance, after | 1.9922 USDC, visible 14.6 s after the deposit |

Times are measured from the deposit transaction's confirmation, by polling every 2 seconds, so each is up to 2 seconds late.

Tidepool paid 2.9922 USDC, which is what it quoted. Hyperliquid kept 1 USDC of it as its fee for the first transfer to a new address, and the ledger entry shows `"fee":"1.0"`. A second rescue to the same account wouldn't pay that fee.

## Public links

- NEAR testnet deposit: [5TcTu5rQ4yejKkkZwpwnf16zhcTpaUmMzD9AvtrcPD2T](https://testnet.nearblocks.io/txns/5TcTu5rQ4yejKkkZwpwnf16zhcTpaUmMzD9AvtrcPD2T)
- Tidepool's steps, from its status response:
  - Gas top-up for the deposit address: [8NUXSRNvn5LKttTpFRnpVHPJTbDeXR7qZGeu51mfJGcv](https://testnet.nearblocks.io/txns/8NUXSRNvn5LKttTpFRnpVHPJTbDeXR7qZGeu51mfJGcv)
  - Deposit moved into the verifier: [B357ZRW19qphZWS8YjCcp66mJgSijZVa7VSGarAKvYf9](https://testnet.nearblocks.io/txns/B357ZRW19qphZWS8YjCcp66mJgSijZVa7VSGarAKvYf9)
  - The swap, `execute_intents`: [AFLY8WwE3ZVaTS53w2D5DWbWR2TwtThCtfPnE5aWathC](https://testnet.nearblocks.io/txns/AFLY8WwE3ZVaTS53w2D5DWbWR2TwtThCtfPnE5aWathC)
- Payout on Hyperliquid testnet, from Tidepool's treasury `0x55f2c8044d790e1b8369508c31c756c0c2ca0e93`: [0x11bc84cc637b893d1336042e07a4e10102009cb1fe7ea80fb585301f227f6327](https://app.hyperliquid-testnet.xyz/explorer/tx/0x11bc84cc637b893d1336042e07a4e10102009cb1fe7ea80fb585301f227f6327)
- The receiving Hyperliquid testnet account: [0xeb53d86545691F875b0F35745899A7A1E27706a9](https://app.hyperliquid-testnet.xyz/explorer/address/0xeb53d86545691F875b0F35745899A7A1E27706a9)
- Tidepool's status for the swap: https://www.usetidepool.tech/v0/status?depositAddress=78b5b0e911904274d011a9a90f181da62fc56368c4a1f05448ed43e2cddd2749

## The script's summary

```
Quote:              61f68aad-72a9-41fc-98a4-bc367fcb9bb7
Deposit address:    78b5b0e911904274d011a9a90f181da62fc56368c4a1f05448ed43e2cddd2749
NEAR testnet tx:    5TcTu5rQ4yejKkkZwpwnf16zhcTpaUmMzD9AvtrcPD2T
                    https://testnet.nearblocks.io/txns/5TcTu5rQ4yejKkkZwpwnf16zhcTpaUmMzD9AvtrcPD2T
Tidepool status:    SUCCESS (https://www.usetidepool.tech/v0/status?depositAddress=78b5b0e911904274d011a9a90f181da62fc56368c4a1f05448ed43e2cddd2749)
Hyperliquid before: 0 USDC
Hyperliquid after:  1.9922 USDC
Deposit to SUCCESS: 13.4 s
Deposit to balance on Hyperliquid: 14.6 s
Hyperliquid account:  https://app.hyperliquid-testnet.xyz/explorer/address/0xeb53d86545691F875b0F35745899A7A1E27706a9
```

## What this does and doesn't show

It shows that the keeper's 1Click client gets and checks a signed quote, that a real NEAR deposit pays it, and that USDC lands in a Hyperliquid perps balance in about 15 seconds. Lifeline's mainnet route quotes 30 seconds for the same leg.

It doesn't show mainnet 1Click's speed or fees. Tidepool's single maker and its own relayer stand in for 1Click's solvers and bridges. It also doesn't go through the vault: the deposit here is sent from an ordinary testnet account, not by the vault's `rescue`.

## Run it yourself

- `pnpm demo:tidepool --dry 0xAnyAddress` needs no keys or funds. It reads the Hyperliquid testnet balance, gets a live Tidepool quote, checks the signature and every field, and stops before paying.
- `pnpm demo:tidepool` does the whole run. It needs `NEAR_TESTNET_ACCOUNT`, `NEAR_TESTNET_PRIVATE_KEY` and `HL_TESTNET_ADDRESS` in `.env` (see `.env.example`), and at least 3 Tidepool test USDC in that NEAR account, from https://app.usetidepool.tech/faucet. It sends 3 test USDC.
