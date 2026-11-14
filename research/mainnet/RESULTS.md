# Lifeline's money path on mainnet, through 1Click

Run once on 14 November 2026 at 13:13 UTC with `pnpm demo:mainnet --send`. Real money: 0.86 NEAR went through NEAR Intents' 1Click API into a Hyperliquid mainnet perps balance.

The script uses the keeper's own 1Click client, with 1Click's own quote-signing key (`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`). It checks the quote the same way as the testnet run in [research/tidepool/RESULTS.md](../tidepool/RESULTS.md). It pays from a NEAR implicit account, not from the vault: the vault is still on testnet.

## What happened

| Step | Result |
| --- | --- |
| Hyperliquid mainnet balance of `0x1311b80F726cfA860b948037b455882713908De0`, before | 0 USDC. The account didn't exist yet: `userRole` was `missing`. |
| Sizing | A dry quote for 1 wNEAR promised at least 2.962679 USDC after a 0.3153 USDC flat fee, so the script sent 0.86 wNEAR for about 2.5 USDC out. |
| Live quote from 1Click | `9487fc67-f6fc-4818-8b51-473479041f82`: 0.86 wNEAR in, at least 2.503932 USDC out, refund to the paying account |
| Quote signature | Valid for 1Click's key |
| Quote fields checked before paying | Recipient, destination asset `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054` (perps USDC, not HyperEVM), exact amount in, minimum out of at least 2.3 USDC, refund account, a fresh implicit deposit address |
| Deposit | One transaction on `wrap.near`: register the account, wrap 0.86 NEAR, register the deposit address, transfer 0.86 wNEAR |
| 1Click status | `PENDING_DEPOSIT` at 2.3 s, `PROCESSING` at 17.3 s, `SUCCESS` at 116.5 s |
| Hyperliquid mainnet balance, after | **2.531506 USDC, visible 56.9 s after the deposit** |

Times are measured from the deposit transaction's confirmation, by polling every 2 seconds, so each is up to 2 seconds late. The USDC was spendable on Hyperliquid about a minute before 1Click's status said `SUCCESS`. The quote's own estimate for this route is 30 s.

## Fees

| Fee | Amount |
| --- | --- |
| Swap and delivery, all of 1Click's cost | $2.8552 of wNEAR in, $2.5306 of USDC out (1Click's prices): $0.3246, or 11.4%. Almost all of it is the flat 0.3153 USDC `withdrawFee`, so the share falls as rescues get bigger. |
| NEAR gas | 0.000699 NEAR |
| Storage registrations on `wrap.near` | 2 × 0.00125 NEAR |
| Hyperliquid | None. The ledger entry shows `"fee":"0.0"`, even though the account was new. On testnet, Tidepool's transfer to a new address was charged 1 USDC; 1Click's mainnet delivery wasn't. |

## Checked independently

- NEAR mainnet archival node (`archival-rpc.mainnet.fastnear.com`): the transaction is final, with `SuccessValue` and no failed receipts.
- 1Click's `GET /v0/status`: `SUCCESS`, `amountOut` 2.531506, nothing refunded.
- Hyperliquid mainnet `userNonFundingLedgerUpdates`: a `send` of 2.531506 USDC from 1Click's Hyperliquid account `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24`, from its spot balance to our perps balance, at 13:14:05.413 UTC, fee 0.0. `clearinghouseState` then shows `accountValue` and `withdrawable` of 2.531506.

## Public links

- NEAR mainnet deposit: [6avvisKAmLYnWR2vkGzSfvteFnGHGc3NEAMt9gWLN1Hv](https://nearblocks.io/txns/6avvisKAmLYnWR2vkGzSfvteFnGHGc3NEAMt9gWLN1Hv)
- 1Click's NEAR transactions for the swap, from its status response: [Vg3LKRgc…](https://nearblocks.io/txns/Vg3LKRgcRqciVJMrdxYJD3zqfsGCsRnhqmRTYh4edW8), [2GojgjkM…](https://nearblocks.io/txns/2GojgjkM663wTSFYu9SxPkCdms199hSMfweDhAQGtYi1), [HBgfCZ8B…](https://nearblocks.io/txns/HBgfCZ8B9yMmGgLyDMFPrFdXGq67vZppvtUEKYSQ44oX), [FJz3Bpcq…](https://nearblocks.io/txns/FJz3Bpcq9tBh7YY5D93vcFw2X1h6A1gHVK95dbBdsWVt)
- Payout on Hyperliquid mainnet: [0xde0a883ce25d0f3ddf840448c6f174010100a0227d502e0f81d3338fa150e928](https://app.hyperliquid.xyz/explorer/tx/0xde0a883ce25d0f3ddf840448c6f174010100a0227d502e0f81d3338fa150e928) (from Hyperliquid's ledger; 1Click's status names `0xd2c7e67b59df226611676e68bfe9cc98ca0196be84918d956f48b4adc2acd29c` as its destination transaction)
- The receiving Hyperliquid account: [0x1311b80F726cfA860b948037b455882713908De0](https://app.hyperliquid.xyz/explorer/address/0x1311b80F726cfA860b948037b455882713908De0)
- The paying NEAR account: [3d6e0c641a8a2504385f51080f0ee3ac0918a487182d37c11246a1ab460cdc6a](https://nearblocks.io/address/3d6e0c641a8a2504385f51080f0ee3ac0918a487182d37c11246a1ab460cdc6a)
- 1Click's status for the swap: https://1click.chaindefuser.com/v0/status?depositAddress=bf1eeb6fedde5f04ff276caa3d55608c173f4e2115964f0d18f7b7444b6ef3d2

## The script's summary

```
Quote:              9487fc67-f6fc-4818-8b51-473479041f82
Deposit address:    bf1eeb6fedde5f04ff276caa3d55608c173f4e2115964f0d18f7b7444b6ef3d2
NEAR tx:            6avvisKAmLYnWR2vkGzSfvteFnGHGc3NEAMt9gWLN1Hv
                    https://nearblocks.io/txns/6avvisKAmLYnWR2vkGzSfvteFnGHGc3NEAMt9gWLN1Hv
1Click status:      SUCCESS (https://1click.chaindefuser.com/v0/status?depositAddress=bf1eeb6fedde5f04ff276caa3d55608c173f4e2115964f0d18f7b7444b6ef3d2)
Hyperliquid before: 0 USDC
Hyperliquid after:  2.531506 USDC
Deposit to SUCCESS: 116.5 s
Deposit to balance on Hyperliquid: 56.9 s
Hyperliquid account:  https://app.hyperliquid.xyz/explorer/address/0x1311b80F726cfA860b948037b455882713908De0
```

## What this doesn't prove

- It isn't a Lifeline rescue. The vault still runs on testnet, so this deposit came from an ordinary NEAR account, not from the vault's `rescue`. The keeper's watch loop and the policy engine weren't involved; the keeper's 1Click client and the quote checks were.
- The origin was wNEAR, not the USDC the vault holds. A USDC-to-USDC rescue skips the price conversion but pays the same flat fee.
- It's one sample. The 56.9 s is one swap at one moment, not a p50.

## Run it yourself

- `pnpm demo:mainnet --dry` sends nothing. It reads the balances, sizes and gets a live 1Click quote, checks the signature and every field, and stops before paying. It needs `MAINNET_NEAR_ACCOUNT` (an existing NEAR account, used as the refund account) and `HL_MAINNET_ADDRESS` in `.env`.
- `pnpm demo:mainnet --send` spends real NEAR: at most 1.5 NEAR, and it always leaves at least 0.15 NEAR for gas and storage. It also needs `MAINNET_NEAR_PRIVATE_KEY`.
