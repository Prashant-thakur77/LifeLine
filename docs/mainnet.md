# Going live on mainnet

The steps for Gate 2: the vault and keeper on mainnet, then the first real rescue. Each step that sends a transaction or spends money needs a human's yes first.

`$TEAM` is the team's mainnet account (for example `lifeline-team.near`). Keys stay in `~/.near-credentials` and the password manager, never in git or chat.

## What it costs

| Item | Amount |
| --- | --- |
| Vault account: contract storage (240 KB), and about 0.005 NEAR per rescue for its record and the deposit address's USDC registration | about 3.5 NEAR |
| Keeper account: gas for rescues | 0.5 NEAR |
| Alice's (the demo user's) registration in the vault | 0.05 NEAR |
| Reserve to rescue from | 10 to 20 USDC on NEAR |
| Hyperliquid margin for the test position | about 15 USDC |

## 1. Accounts (human)

1. Create `$TEAM` in a NEAR wallet and fund it with at least 5 NEAR.
2. Import its key into the NEAR CLI on this machine. The CLI asks for the seed phrase itself, so it never goes through chat: type `! near account import-account using-seed-phrase network-config mainnet` in the Claude prompt.

## 2. Vault and keeper

```sh
# Sub-accounts
near account create-account fund-myself vault.$TEAM '3 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as $TEAM network-config mainnet sign-with-legacy-keychain send
near account create-account fund-myself keeper.$TEAM '0.5 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as $TEAM network-config mainnet sign-with-legacy-keychain send

# The contract: USDC for rescues, wNEAR for deposits, and 1Click's quote-signing key (from its SDK)
cd contracts/vault && cargo near build non-reproducible-wasm
near contract deploy vault.$TEAM use-file target/near/lifeline_vault.wasm \
  with-init-call new json-args '{"tokens":["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","wrap.near"],"quote_signer":"ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send

# Register the vault with USDC, so deposits can reach it
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit \
  json-args '{"account_id":"vault.'$TEAM'","registration_only":true}' \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as $TEAM network-config mainnet sign-with-legacy-keychain send

# The keeper's only key: rescue on the vault. No allowance cap: it can only call rescue,
# and a key that ran out of allowance would stop rescues silently.
near account add-key keeper.$TEAM grant-function-call-access --allowance unlimited \
  --contract-account-id vault.$TEAM --function-names 'rescue' \
  autogenerate-new-keypair save-to-legacy-keychain network-config mainnet sign-with-legacy-keychain send
# Then delete keeper.$TEAM's full-access key (near account delete-keys …) and check:
near account list-keys keeper.$TEAM network-config mainnet now
```

The A6 check: `get_policy` and `get_reserve` answer, and the keeper's key list shows only the function-call key.

## 3. The demo user

The user signs these with their own wallet, through the dashboard or the CLI:

1. `set_policy` with their Hyperliquid address, `keeper: keeper.$TEAM`, and 0.05 NEAR attached.
2. Deposit 10 to 20 USDC with `ft_transfer_call` on USDC to `vault.$TEAM`.
3. Open a small cross position on Hyperliquid, about 15 USDC of margin.

## 4. The keeper on Cloudflare

Add the live settings to the top level of `apps/keeper/wrangler.jsonc` (`NEAR_NETWORK: "mainnet"`, `NEAR_RPC_URL`, `VAULT_CONTRACT_ID`, `KEEPER_ACCOUNT_ID`, `KEEPER_ALLOW_MAINNET: "yes"`). Then set the key from the file the CLI saved, without printing it, and deploy:

```sh
python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['private_key'])" ~/.near-credentials/mainnet/keeper.$TEAM/<function-call key>.json \
  | pnpm dlx wrangler@4.158.0 secret put KEEPER_PRIVATE_KEY --config apps/keeper/wrangler.jsonc
pnpm --filter keeper cf:deploy
```

`https://lifeline-keeper.prashantthakur.dev/` then shows `mode: live`, and `/api/health/<user>` shows the real health.

## 5. Gate 2: the first rescue

Set the user's trigger just above their current health (the vault allows triggers up to 2.5), so the next tick fires on purpose. The keeper warns, rescues, and the USDC lands in the Hyperliquid perps balance. The audit record at `/api/audit?user=<user>` carries the NEAR transaction and the measured latency, and `/api/stats` starts reporting p50 and p95.

Then `pnpm demo:attack --send-mainnet` records the mainnet refusal, and `pnpm demo:attack` shows it from then on. It sends one failing transaction with the keeper's key: a real 1Click quote for the user's address, with the keeper's own account as where the money goes.
