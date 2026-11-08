# Lifeline vault

The NEAR contract that holds each user's rescue reserve. A user deposits USDC, sets a policy, and names the one keeper account allowed to act for them. The keeper can then call `rescue`, which sends reserve funds to a 1Click deposit address and nowhere else. Every rule that protects the money is checked here, on chain, whatever the keeper's own policy engine said.

The contract has no owner and no admin methods. Nobody but the user can withdraw, change a policy or unpause.

```sh
cargo test                                  # 36 unit tests, then 9 sandbox tests (they build the wasm first)
cargo near build non-reproducible-wasm      # target/near/lifeline_vault.wasm
```

The sandbox tests run the contract on a local NEAR node with a real NEP-141 token: a deposit, a rescue to a fresh 1Click-style address, a rescue to an attacker, a failed transfer that gets refunded, a withdrawal, and calls to the private callbacks from outside. They need `rustup target add wasm32-unknown-unknown`. `pnpm test` at the repo root runs them too, and fetches the sandbox node first with `scripts/near-sandbox.mjs`.

## On testnet

| Account | What it is |
| --- | --- |
| [`vault.lifeline-team.testnet`](https://testnet.nearblocks.io/address/vault.lifeline-team.testnet) | This contract |
| [`keeper.lifeline-team.testnet`](https://testnet.nearblocks.io/address/keeper.lifeline-team.testnet) | The keeper. Its only key: "only do `rescue` function calls on vault.lifeline-team.testnet with an allowance of 0.5 NEAR" |
| [`usdc.lifeline-team.testnet`](https://testnet.nearblocks.io/address/usdc.lifeline-team.testnet) | A stand-in USDC, the mock token from the tests. 1Click has no testnet, so nothing real swaps here |
| [`alice.lifeline-team.testnet`](https://testnet.nearblocks.io/address/alice.lifeline-team.testnet) | A test user with a policy and a reserve |

What happened there on 8 November 2026:

| Step | Transaction | Result |
| --- | --- | --- |
| Alice sets a policy, with 0.05 NEAR | [CgZBxYEy…](https://testnet.nearblocks.io/txns/CgZBxYEyEM515fLuVDgek6Wq1VCV7iYp2dm2pHnAjKFi) | Registered |
| Alice deposits 20 USDC through `ft_transfer_call` | [Hw239H9C…](https://testnet.nearblocks.io/txns/Hw239H9CPHNq9aDEkhEgrH9dnQoBnQkDnLZYcFJ5cXWc) | Reserve 20 |
| The keeper's full-access key is deleted | [4uXrSTGv…](https://testnet.nearblocks.io/txns/4uXrSTGvcrEX48y1nkmW4c44ztSgbDdT1ERfmCnHaKR8) | Only the `rescue` key is left |
| The keeper rescues 3 USDC to a fresh implicit address | [6XohgcVC…](https://testnet.nearblocks.io/txns/6XohgcVCnW3sn5TUiPX4gv8Qu2qB1zcGmBgvKYWPSV63) | `true`, reserve 17, the address holds 3 |
| The keeper's key tries a rescue to an attacker's address | [BgX8yWQ8…](https://testnet.nearblocks.io/txns/BgX8yWQ8oRGeY24fJ9LfMfLwxjQmXyH2TySsUX6thmad) | Refused: `RECIPIENT_MISMATCH` |
| The keeper's key tries `withdraw` | not sent | NEAR refuses to sign it: a function-call key can't attach a deposit |

## Methods

Amounts are strings in the token's base units (USDC has 6 decimals). Times are nanoseconds since the epoch, as strings.

| Method | Who can call | Deposit | What it does |
| --- | --- | --- | --- |
| `new(tokens)` | Once, at deploy | none | Sets the tokens a reserve may hold |
| `set_policy(policy)` | The user | 0.05 NEAR the first time, then 1 yoctoNEAR | Saves the policy after range checks. The first call registers the user and pays for their storage. Anything over the amount needed is refunded |
| `pause()` | The user | none | Stops rescues for this user at once. Needs no deposit, so any of the user's keys can do it |
| `unpause()` | The user | 1 yoctoNEAR | Allows rescues again |
| `withdraw(token, amount)` | The user | 1 yoctoNEAR | Sends reserve funds back to the user's own account. If the transfer fails, the reserve is restored |
| `ft_on_transfer(sender_id, amount, msg)` | A token contract, through `ft_transfer_call` | none | Credits the deposit to the sender's reserve. Refuses tokens not in the list, and senders who haven't set a policy |
| `rescue(user, token, amount, deposit_address, recipient, quote_id)` | Only the keeper the user named | none | Checks every rule below, then pays `deposit_address`'s storage on the token and transfers `amount` to it. Returns `true` once the transfer succeeds, or `false` if it failed and the reserve was restored |
| `get_policy(user)` | Anyone | view | The policy, or `null` |
| `get_reserve(user)` | Anyone | view | `{ token: amount }` for every token in the list, `"0"` where the user has none |
| `get_rescues(user, from, limit)` | Anyone | view | The user's rescues, oldest first, at most 100 per call |
| `get_users(from, limit)` | Anyone | view | Every registered user, in sign-up order, at most 100 per call |
| `get_tokens()` | Anyone | view | The tokens a reserve may hold |

Deposits and withdrawals need 1 yoctoNEAR because that can only be attached by a full-access key, which means the user's wallet asks them to confirm. A function-call key, like the one a dapp gets at login, can't change a policy or move money. It can pause.

### `rescue` refuses when

1. the caller isn't the keeper the user named in their policy,
2. the user has no policy, or has paused,
3. the token isn't in the list,
4. `recipient` isn't the user's Hyperliquid address (compared in lower case),
5. `amount` is 0 or over `max_per_rescue`,
6. this rescue would take the last 24 hours over `max_per_day`,
7. the last rescue was less than `cooldown_sec` ago,
8. the reserve holds less than `amount`,
9. `quote_id` is empty, or was already used for this user.

A rescue whose transfer failed was refunded. It doesn't count towards the 24-hour cap or the cooldown, and `get_rescues` shows it with `refunded: true`.

The keeper calls with no deposit, because its function-call key can't attach one, and 100 Tgas. The vault pays the 0.00125 NEAR USDC storage for each new deposit address out of its own balance, so the vault account needs a little NEAR beyond its storage. A 1Click deposit address is a fresh implicit account that USDC doesn't know yet, and a plain transfer to it would fail.

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
| `max_per_rescue` | Above 0 |
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
| `rescue` | `user`, `token`, `amount`, `recipient`, `quote_id`, `deposit_address` |
| `rescue_refunded` | `user`, `token`, `amount`, `quote_id` |

## Calling it with the NEAR CLI

These use [near-cli-rs](https://github.com/near/near-cli-rs) and testnet. Mainnet is the same with `network-config mainnet`. `$VAULT` is the vault account, `$USDC` the USDC contract and `$ME` your account.

```sh
# Deploy and initialise (USDC and wNEAR on mainnet)
near contract deploy $VAULT use-file target/near/lifeline_vault.wasm \
  with-init-call new json-args '{"tokens":["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","wrap.near"]}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

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

# A rescue, as the keeper
near contract call-function as-transaction $VAULT rescue \
  json-args '{"user":"'$ME'","token":"'$USDC'","amount":"3000000","deposit_address":"<1Click deposit address>","recipient":"0x1111111111111111111111111111111111111111","quote_id":"<1Click correlationId>"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as keeper.lifeline.testnet network-config testnet sign-with-keychain send

# Views
near contract call-function as-read-only $VAULT get_policy json-args '{"user":"'$ME'"}' network-config testnet now
near contract call-function as-read-only $VAULT get_reserve json-args '{"user":"'$ME'"}' network-config testnet now
near contract call-function as-read-only $VAULT get_rescues json-args '{"user":"'$ME'","from":0,"limit":20}' network-config testnet now
near contract call-function as-read-only $VAULT get_users json-args '{"from":0,"limit":100}' network-config testnet now
```

## The keeper's key

The keeper account should hold only a function-call key for `rescue` on the vault, with no allowance for anything else:

```sh
near account add-key keeper.lifeline.near grant-function-call-access \
  --allowance '1 NEAR' --contract-account-id $VAULT --function-names 'rescue' \
  autogenerate-new-keypair save-to-keychain network-config mainnet sign-with-keychain send
```

Then delete its full-access key, and check with `near account list-keys keeper.lifeline.near network-config mainnet now` that the function-call key is the only one left.
