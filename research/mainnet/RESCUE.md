# The first Lifeline rescue on mainnet

On 14 November 2026 at 20:16 UTC, Lifeline's keeper rescued a real Hyperliquid position from Lifeline's vault on NEAR mainnet, through 1Click.

**Why it fired:** the trigger was set above the account's current health, not because the price fell. The policy's trigger was 2.5. The position's health was 2.31 when it was opened and 2.27 when the keeper read it, after XMR had moved down about 0.6%. Either reading is below 2.5, so the keeper rescued on its first look. The position was small on purpose: **0.022 XMR, about $11**, long at 5x cross, on an account holding 2.53 USDC.

## The setup

| What | Value |
| --- | --- |
| Vault | [`vault.lifeline-hq.near`](https://nearblocks.io/address/vault.lifeline-hq.near), code hash `FUWd4fuXeaL5eu5k6YfkmufXfm7T8uq7gDD6PvuuzAnq`: the reproducible build of commit `37e98488`, the same code `vault.lifeline-team.testnet` runs |
| Vault config (`get_config`) | tokens: native USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, then `wrap.near`; quote signer: 1Click's key `ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc` |
| Keeper | [`keeper.lifeline-hq.near`](https://nearblocks.io/address/keeper.lifeline-hq.near): one key only, a function-call key for `rescue` on the vault. It never had a full-access key |
| User | NEAR implicit account `3d6e0c641a8a2504385f51080f0ee3ac0918a487182d37c11246a1ab460cdc6a`, with 3.148452 USDC in reserve |
| Policy | Hyperliquid `0x1311b80f726cfa860b948037b455882713908de0`; warn 3.0, trigger 2.5, target 3.0; 3 USDC per rescue and per day; 3,600 s cooldown |
| Position | XMR 0.022 long at $495.74, cross 5x ([open](https://app.hyperliquid.xyz/explorer/tx/0x748f999b08543c7f76090448cc4be802021d0080a3575b51185844edc758166a)); health 2.31, liquidation $423.22 |

The keeper ran locally in live mainnet mode for this one rescue, then was stopped.

## The rescue

| Step | When (UTC) | From the rescue transaction |
| --- | --- | --- |
| Keeper reads health 2.27, under the 2.5 trigger | 20:16:17.8 | |
| Policy engine allows; keeper sends `rescue` for 2 USDC | 20:16:20.7 | |
| [Rescue transaction](https://nearblocks.io/txns/Dz7iBdE4Rouk9ECTUxutCUbvjCAVwMFw7XArmrgxzTcZ) included in block 224563141 | 20:16:21.8 | 0 s |
| [1.684355 USDC credited](https://app.hyperliquid.xyz/explorer/tx/0xd0ea28ef0b687453d2630448cc66d901010040d4a66b932574b2d441ca6c4e3e) to the Hyperliquid perps balance | 20:17:10.3 | **48.6 s** |
| 1Click reports `SUCCESS` | 20:18:14 | 112.2 s |
| Keeper records `RESCUE_DONE`: health 2.27 to 3.82 | 20:18:15.5 | 113.7 s; the keeper's own detection-to-done time was 117.7 s |

As on the earlier mainnet run, the USDC was usable on Hyperliquid about a minute before 1Click's status said `SUCCESS`.

**NEAR** (checked on `archival-rpc.mainnet.fastnear.com`):
- **Transaction:** [`Dz7iBdE4Rouk9ECTUxutCUbvjCAVwMFw7XArmrgxzTcZ`](https://nearblocks.io/txns/Dz7iBdE4Rouk9ECTUxutCUbvjCAVwMFw7XArmrgxzTcZ), signed by `keeper.lifeline-hq.near` and sent to `vault.lifeline-hq.near` `rescue` with 100 Tgas.
- **Result:** `SuccessValue` `true`, FINAL, no failed receipts. 0.001054 NEAR of gas was burned.
- **Events:** the vault emitted `rescue` (2000000 to `0x1311…8de0`), and USDC emitted `ft_transfer` of 2000000 from the vault to the deposit address `32995b6c1e8ff90b5aa1ce9ff54a0fc752bcb8426c1352cbae70a7ffa4ee4796`, memo "Lifeline rescue 7d553dc5-…".

**1Click:**
- **Quote:** `7d553dc5-ea55-4715-b287-c79715357f1d`, signed with 1Click's key and checked by the keeper, then by the vault on chain.
- **Status:** [`SUCCESS`](https://1click.chaindefuser.com/v0/status?depositAddress=32995b6c1e8ff90b5aa1ce9ff54a0fc752bcb8426c1352cbae70a7ffa4ee4796). 2.0 USDC in, 1.684355 USDC out, nothing refunded. 1Click's destination transaction is `0x37825c7f5d23cc18c09dc74a81468a5bb45d5bf377a153ed044770d9bc12f21e`.

**Hyperliquid** (mainnet `userNonFundingLedgerUpdates`):
- **Ledger entry:** a `send` of 1.684355 USDC from 1Click's account `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24`, spot to perps, `"fee":"0.0"`, hash `0xd0ea28ef0b687453d2630448cc66d901010040d4a66b932574b2d441ca6c4e3e`.
- **After the rescue:** `accountValue` 4.148914, maintenance margin 1.084424, health 3.83. Liquidation moved from $423.22 to $338.15.

**The vault, read back afterwards:**
- `get_rescue_count`: 1.
- `get_rescues`: 2000000 of USDC to `0x1311…8de0`, quote `7d553dc5-…`, deposit address `32995b6c…4796`, `refunded: false`.
- `get_reserve`: 1148452 USDC (3.148452 − 2).

**Cost of the rescue:**
- **1Click:** 0.315645 of the 2 USDC, almost all of it its flat 0.3153 USDC fee.
- **Keeper:** 0.001054 NEAR of gas.
- **Vault:** 0.00125 NEAR to register the deposit address with USDC, plus the rescue record's storage.

## Before and after

- **The first attempt failed** because the keeper's account had 0.03 NEAR, too little for gas, and no funds moved. The NEAR node refused the transaction before accepting it: a 100 Tgas call needs about 0.1 NEAR held up front. The vault's rescue count stayed 0 and the keeper's key was unused. The keeper was topped up by 0.12 NEAR ([tx](https://nearblocks.io/txns/B7E7K3PVEbVdckQ5bSMY1g1B5qR9uSafKKKWJadgYjjb)), and the second attempt is the rescue above.
- **The Hyperliquid account was switched** from unified to standard mode by API before the position was opened. In unified mode the perps `accountValue` the keeper reads is 0, so its health figure would have been wrong.
- **The position was closed** after the rescue with a reduce-only sell of 0.022 XMR at $493.04 ([close](https://app.hyperliquid.xyz/explorer/tx/0x951844ed04a20f3996920448cc6df202097800d29fa52e0b38e0f03fc3a5e924)). The account then held 4.146673 USDC and no position.

## Every mainnet transaction

| Step | Transaction |
| --- | --- |
| Create `lifeline-hq.near` | [6kRdHD1yDxdVCqbRdoHuseUG5PoCZevwh9qKstwPVQro](https://nearblocks.io/txns/6kRdHD1yDxdVCqbRdoHuseUG5PoCZevwh9qKstwPVQro) |
| Create `vault.lifeline-hq.near` | [GvMqeeuyTX8NSenD6ncdNBcrE7kxdHZwHTPkqxYfFbRF](https://nearblocks.io/txns/GvMqeeuyTX8NSenD6ncdNBcrE7kxdHZwHTPkqxYfFbRF) |
| Deploy, first attempt: refused for balance, nothing deployed | [J7RwENwmU8Ug4oyhGjj4qqfxpjKYWL25q3Wz4fs8kRpx](https://nearblocks.io/txns/J7RwENwmU8Ug4oyhGjj4qqfxpjKYWL25q3Wz4fs8kRpx) |
| Top up the vault | [5emt3xZd7nc7bgox6DMfzP1azumfdCqeBs9JwyjpLnH1](https://nearblocks.io/txns/5emt3xZd7nc7bgox6DMfzP1azumfdCqeBs9JwyjpLnH1) |
| Deploy the wasm and `new(...)` | [B9HeaqsthcVtnx6TjhwjM5eMgAtxeLcCXjXoTN9iY2iD](https://nearblocks.io/txns/B9HeaqsthcVtnx6TjhwjM5eMgAtxeLcCXjXoTN9iY2iD) |
| Create `keeper.lifeline-hq.near` with only the rescue key | [EjDaRehHRqp4dbtXZFmSuKgJJPQbCMdfQK3cDzudsoiH](https://nearblocks.io/txns/EjDaRehHRqp4dbtXZFmSuKgJJPQbCMdfQK3cDzudsoiH) |
| Register the vault and user with USDC | [8WpM4FuD9uWJBnEEXxNjW5ZoQfUgL4j49bvaL2G9Y2Qf](https://nearblocks.io/txns/8WpM4FuD9uWJBnEEXxNjW5ZoQfUgL4j49bvaL2G9Y2Qf) |
| Swap 0.95 NEAR to 3.148452 USDC via 1Click, quote `4f1fe623-16c6-4287-9130-2d912fa22fdc` | [HgYTJdHaJabHVtF58Z1oSSw2vAXnjfBFsopjCUZ87s3b](https://nearblocks.io/txns/HgYTJdHaJabHVtF58Z1oSSw2vAXnjfBFsopjCUZ87s3b) |
| `set_policy` | [BWyoqfLfmjUJrwRdsvUqNAoUq4QpTWwYNRe7ENEiS8XK](https://nearblocks.io/txns/BWyoqfLfmjUJrwRdsvUqNAoUq4QpTWwYNRe7ENEiS8XK) |
| Deposit 3.148452 USDC into the vault | [81cZsC9MCPu2Td9V84m9RpBcf4WStwiUokmd5apDdwR3](https://nearblocks.io/txns/81cZsC9MCPu2Td9V84m9RpBcf4WStwiUokmd5apDdwR3) |
| Top up the keeper by 0.12 NEAR | [B7E7K3PVEbVdckQ5bSMY1g1B5qR9uSafKKKWJadgYjjb](https://nearblocks.io/txns/B7E7K3PVEbVdckQ5bSMY1g1B5qR9uSafKKKWJadgYjjb) |
| **The rescue** | [**Dz7iBdE4Rouk9ECTUxutCUbvjCAVwMFw7XArmrgxzTcZ**](https://nearblocks.io/txns/Dz7iBdE4Rouk9ECTUxutCUbvjCAVwMFw7XArmrgxzTcZ) |

The scripts that sent these are `scripts/src/mainnet-vault.ts` (NEAR), `scripts/src/hl-account.ts` (Hyperliquid) and `scripts/src/keeper-dry-tick.ts` (the keeper tick run before it, with the rescue captured and not sent).
