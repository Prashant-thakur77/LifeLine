# Lifeline vault

The NEAR contract that holds each user's rescue reserve. A user deposits USDC, sets a policy, and names the one keeper account allowed to act for them. The keeper can then call `rescue`, which pays reserve funds to a 1Click deposit address, and only to one from a quote 1Click signed for that user's own Hyperliquid address. The vault checks 1Click's signature itself and reads the deposit address, recipient, amount and refund account from the signed quote, so a hacked keeper can't send the money anywhere else. The caps, cooldown and pause are checked here too, whatever the keeper's own policy engine said.

There are no admin methods: nobody but the user can withdraw, change a policy or unpause. The vault account itself still has a full-access key, though, so whoever holds it could deploy different code. See the README's Limitations.

```sh
cargo test                                  # 51 unit tests, then 11 sandbox tests (they build the wasm first)
cargo near build non-reproducible-wasm      # target/near/lifeline_vault.wasm
```

The unit tests check every rule on a mocked chain, including a real quote 1Click signed on 6 November 2026, verified with 1Click's real key. The sandbox tests run the contract on a local NEAR node with a real NEP-141 token:
- a deposit, and a token that isn't on the list going straight back,
- a rescue paid to its quote's fresh deposit address,
- a rescue naming an attacker's Hyperliquid address,
- a correctly signed quote with the money pointed at the attacker's account,
- a quote the keeper wrote itself,
- a failed transfer that gets refunded,
- a withdrawal,
- calls to the private callbacks, and a second `new`, from outside.

They need `rustup target add wasm32-unknown-unknown`. `pnpm test` at the repo root runs them too, and fetches the sandbox node first with `scripts/near-sandbox.mjs`. Set `NEAR_SANDBOX_BIN_PATH` to that node when you run `cargo test` yourself, or near-workspaces downloads it again.

## On testnet

| Account | What it is |
| --- | --- |
| [`vault.lifeline-team.testnet`](https://testnet.nearblocks.io/address/vault.lifeline-team.testnet) | This contract |
| [`keeper.lifeline-team.testnet`](https://testnet.nearblocks.io/address/keeper.lifeline-team.testnet) | The keeper. Its only key: "only do `rescue` function calls on vault.lifeline-team.testnet" |
| [`usdc.lifeline-team.testnet`](https://testnet.nearblocks.io/address/usdc.lifeline-team.testnet) | A stand-in USDC, the mock token from the tests |
| [`alice.lifeline-team.testnet`](https://testnet.nearblocks.io/address/alice.lifeline-team.testnet) | A test user with a policy and a reserve |

1Click has no testnet, so the testnet vault trusts a team key (`ed25519:82DdwitgHq5bvhASvXLPn2Anwc2YtJthFYXv616pej8U`) to sign quotes in 1Click's place. The mainnet vault trusts 1Click's own key, and `get_config` shows which key a vault trusts.

What happened there on 8 November 2026, all signed by the keeper's restricted key:

| Step | Transaction | Result |
| --- | --- | --- |
| The keeper's full-access key is deleted | [4uXrSTGv…](https://testnet.nearblocks.io/txns/4uXrSTGvcrEX48y1nkmW4c44ztSgbDdT1ERfmCnHaKR8) | Only the `rescue` key is left |
| A rescue of 2 USDC with a signed quote, paid to its fresh deposit address | [A7P6pJz3…](https://testnet.nearblocks.io/txns/A7P6pJz3VxEGt6hPxgMHkk9meSFLbxmsFD6TvEhL9mDE) | `true`, and the address holds 2 USDC |
| A rescue with Alice's real address as recipient and a signed quote, but the money pointed at the keeper's own account | [A9QZC5bV…](https://testnet.nearblocks.io/txns/A9QZC5bVA1iQUo2CEhksRNFvj77951GrmmJq835joKCn) | Refused: `BAD_QUOTE: its deposit address isn't the one this rescue pays` |
| The keeper's key tries `withdraw` | not sent | NEAR refuses to sign it: a function-call key can't attach a deposit |

## Methods

Amounts are strings in the token's base units (USDC has 6 decimals). Times are nanoseconds since the epoch, as strings.

| Method | Who can call | Deposit | What it does |
| --- | --- | --- | --- |
| `new(tokens, quote_signer)` | The vault account, once | none | Sets the tokens a reserve may hold (the first is the one rescues pay in) and the key that signs quotes: 1Click's on mainnet |
| `set_policy(policy)` | The user | 0.05 NEAR the first time, then 1 yoctoNEAR | Saves the policy after range checks. The first call registers the user and pays for their storage. Anything over the amount needed is refunded |
| `pause()` | The user | none | Stops rescues for this user at once. Needs no deposit, so any of the user's keys can do it |
| `unpause()` | The user | 1 yoctoNEAR | Allows rescues again |
| `withdraw(token, amount)` | The user | 1 yoctoNEAR | Sends reserve funds back to the user's own account. If the transfer fails, the reserve is restored |
| `ft_on_transfer(sender_id, amount, msg)` | A token contract, through `ft_transfer_call` | none | Credits the deposit to the sender's reserve. Refuses tokens not in the list, and senders who haven't set a policy |
| `rescue(user, token, amount, deposit_address, recipient, quote_id, quote, signature)` | Only the keeper the user named | none | Checks every rule below, then pays `deposit_address`'s storage on the token and transfers `amount` to it. Returns `true` once the transfer succeeds, or `false` if it failed and the reserve was restored |
| `get_policy(user)` | Anyone | view | The policy, or `null` |
| `get_reserve(user)` | Anyone | view | `{ token: amount }` for every token in the list, `"0"` where the user has none |
| `get_rescues(user, from, limit)` | Anyone | view | The user's rescues, oldest first, at most 100 per call |
| `get_rescue_count(user)` | Anyone | view | How many rescues the user has had, so a reader can start from the newest |
| `get_users(from, limit)` | Anyone | view | Every registered user, in sign-up order, at most 100 per call |
| `get_tokens()` | Anyone | view | The tokens a reserve may hold |
| `get_config()` | Anyone | view | The tokens, the rescue token, the quote signer's key, the destination asset and the quote age limit |

Changing a policy, unpausing and withdrawing need 1 yoctoNEAR because only a full-access key can attach a deposit, so the user's wallet asks them to confirm. A function-call key, like the one a dapp gets at login, can't change a policy or move money. It can pause.

### The quote

`quote` is the exact text 1Click signed: the stable JSON of the quote request, the quote and its timestamp. `signature` is 1Click's Ed25519 signature over the base58 SHA-256 of that text, as its SDK's `verifyQuoteSignature` checks it. The keeper takes both from 1Click's quote response (`packages/intents/src/signed.ts`).

### `rescue` refuses when

1. the user has no policy, or the caller isn't the keeper the user named,
2. the user has paused,
3. the token isn't the rescue token (the first in the list), since the caps are in its units,
4. `recipient` isn't the user's Hyperliquid address (compared in lower case),
5. `amount` is 0 or over `max_per_rescue`,
6. `deposit_address` was already paid by any rescue, for any user,
7. the quote isn't signed by the vault's quote signer, or doesn't say all of these:
   - a live quote, not a dry run,
   - exact input, deposited on NEAR, paid out on the destination chain,
   - from this token, to Hyperliquid perps USDC,
   - for exactly `amount`,
   - refunds to the user, to their own NEAR account (`refundType` `ORIGIN_CHAIN`),
   - no field that could send the money or a refund elsewhere (`virtualChainRecipient`, `virtualChainRefundRecipient`, `customRecipientMsg`, `depositMemo`),
   - delivers, after a flat fee of at most 1 USDC and at most a fifth of the rescue, at least 99.7% of what's sent, so nobody can skim an app fee (app fees aren't in the signed text, but they lower `amountOut`, which is),
   - a slippage floor (`minAmountOut`) at most 1% of the amount below that,
   - pays the user's Hyperliquid address,
   - through `deposit_address`,
   - at most 1% slippage,
   - dated no more than 2 minutes before the block (and no more than 30 s after it),
8. this rescue would take the last 24 hours over `max_per_day`, or make more than 200 rescues in 24 hours,
9. the last rescue was less than `cooldown_sec` ago,
10. the reserve holds less than `amount`,
11. `quote_id`, the keeper's own label, is empty or over 128 characters.

`quote_id` is only the keeper's label for the quote. To tie a rescue to the swap 1Click signed, match its `deposit_address`, or its `quote_hash`: the base58 SHA-256 of the signed text, which is the message 1Click signed.

A rescue whose transfer failed was refunded. It doesn't count towards the 24-hour cap or the cooldown, and `get_rescues` shows it with `refunded: true`.

The vault can't see Hyperliquid, so it doesn't check that health really is below the trigger. A hacked keeper could still move reserve money into the user's own Hyperliquid account when no rescue is needed, within the caps.

The keeper calls with no deposit, because its function-call key can't attach one, and 100 Tgas. The vault pays for each rescue's storage out of its own balance: 0.00125 NEAR to register the deposit address with USDC, and about 0.004 NEAR for the record and the used-address entry. A user's 0.05 NEAR registration covers about ten rescues, so keep the vault account topped up beyond its contract storage and watch its balance. A 1Click deposit address is a fresh implicit account that USDC doesn't know yet, and a plain transfer to it would fail.

### Policy

```json
{
  "hl_address": "0x1111111111111111111111111111111111111111",
  "keeper": "keeper.lifeline.near",
  "warn": 1.8,
  "trigger": 1.5,
  "target": 2.0,
  "max_per_rescue": "25000000",
  "max_per_day": "50000000",
  "cooldown_sec": 120
}
```

| Field | Allowed |
| --- | --- |
| `hl_address` | `0x` and 40 hex characters. Stored in lower case |
| `keeper` | Any NEAR account. Only this account can call `rescue` for the user |
| `warn` | 1.3 to 3.0 |
| `trigger` | 1.2 to 2.5, and below `warn` |
| `target` | Above `trigger`, up to 4.0 |
| `max_per_rescue` | Above 0, in the rescue token's base units |
| `max_per_day` | At least `max_per_rescue` |
| `cooldown_sec` | 30 to 3,600 |

`get_policy` returns the same fields plus `paused`. Setting a policy again keeps the paused flag as it was.

## Events

Every change logs a [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md) event, `EVENT_JSON:{"standard":"lifeline","version":"1.0.0","event":…,"data":[…]}`.

| Event | Data |
| --- | --- |
| `policy_set` | `user`, `hl_address`, `keeper` |
| `deposit` | `user`, `token`, `amount` |
| `paused` | `user`, `paused` (`true` or `false`) |
| `withdraw` | `user`, `token`, `amount` |
| `withdraw_refunded` | `user`, `token`, `amount` |
| `rescue` | `user`, `token`, `amount`, `recipient`, `quote_id`, `deposit_address`, `quote_hash` |
| `rescue_refunded` | `user`, `token`, `amount`, `quote_id` |

## Calling it with the NEAR CLI

These use [near-cli-rs](https://github.com/near/near-cli-rs) and testnet. Mainnet is the same with `network-config mainnet`. `$VAULT` is the vault account, `$USDC` the USDC contract and `$ME` your account.

```sh
# Deploy and initialise. On mainnet: USDC (rescues) and wNEAR (deposits only), trusting 1Click's key.
near contract deploy $VAULT use-file target/near/lifeline_vault.wasm \
  with-init-call new json-args '{"tokens":["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","wrap.near"],"quote_signer":"ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send

# Set a policy (0.05 NEAR the first time, 1 yoctoNEAR after that)
near contract call-function as-transaction $VAULT set_policy \
  json-args '{"policy":{"hl_address":"0x1111111111111111111111111111111111111111","keeper":"keeper.lifeline.testnet","warn":1.8,"trigger":1.5,"target":2.0,"max_per_rescue":"25000000","max_per_day":"50000000","cooldown_sec":120}}' \
  prepaid-gas '30 Tgas' attached-deposit '0.05 NEAR' sign-as $ME network-config testnet sign-with-keychain send

# Deposit 10 USDC into the reserve (the vault must be registered with USDC first: storage_deposit on $USDC)
near contract call-function as-transaction $USDC ft_transfer_call \
  json-args '{"receiver_id":"'$VAULT'","amount":"10000000","msg":""}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ME network-config testnet sign-with-keychain send

# Pause and unpause
near contract call-function as-transaction $VAULT pause json-args '{}' \
  prepaid-gas '10 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
near contract call-function as-transaction $VAULT unpause json-args '{}' \
  prepaid-gas '10 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ME network-config testnet sign-with-keychain send

# Withdraw 5 USDC
near contract call-function as-transaction $VAULT withdraw \
  json-args '{"token":"'$USDC'","amount":"5000000"}' \
  prepaid-gas '50 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ME network-config testnet sign-with-keychain send

# Views
near contract call-function as-read-only $VAULT get_config json-args '{}' network-config testnet now
near contract call-function as-read-only $VAULT get_policy json-args '{"user":"'$ME'"}' network-config testnet now
near contract call-function as-read-only $VAULT get_reserve json-args '{"user":"'$ME'"}' network-config testnet now
near contract call-function as-read-only $VAULT get_rescues json-args '{"user":"'$ME'","from":0,"limit":20}' network-config testnet now
near contract call-function as-read-only $VAULT get_users json-args '{"from":0,"limit":100}' network-config testnet now
```

A rescue needs a signed quote, so it's the keeper that sends it, not a person at a prompt. `pnpm latency --near-testnet 3` sends real testnet rescues, and `pnpm demo:attack --send-testnet` sends the attack above.

## The keeper's key

The keeper account should hold only a function-call key for `rescue` on the vault. Give it no allowance limit (`unlimited`): it can only call `rescue`, and a key that runs out of gas allowance would stop rescues without warning. Watch the keeper account's balance instead.

```sh
near account add-key keeper.lifeline.near grant-function-call-access \
  --allowance unlimited --contract-account-id $VAULT --function-names 'rescue' \
  autogenerate-new-keypair save-to-keychain network-config mainnet sign-with-keychain send
```

Then delete its full-access key, and check with `near account list-keys keeper.lifeline.near network-config mainnet now` that the function-call key is the only one left.
