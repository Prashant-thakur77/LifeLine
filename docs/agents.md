# Lifeline for AI agents

An MCP server at `https://lifeline-mcp.prashantthakur.dev/mcp` (streamable HTTP, no sign-in). Agents can read and prepare; only a person can sign.

```sh
claude mcp add --transport http lifeline https://lifeline-mcp.prashantthakur.dev/mcp
```

For other clients: `{ "mcpServers": { "lifeline": { "type": "http", "url": "https://lifeline-mcp.prashantthakur.dev/mcp" } } }`

| Tool | What it gives |
| --- | --- |
| `check_account` | Any Hyperliquid account's health in its own margin mode, its positions, which a top-up reaches, which have a stop, how many keys can trade it |
| `storm_test` | The move that liquidates it, and how much further it lasts with a reserve |
| `get_protection` | A NEAR account's policy, reserve and rescue count, from the vault |
| `get_recent_decisions` | The demo keeper's latest decisions, marked as the simulation |
| `explain_refusal` | What one of the vault's refusal codes means |
| `prepare_policy` | A checked, unsigned `set_policy` transaction, warnings and a review link |
| `prepare_pause` | An unsigned `pause` |
| `prepare_withdrawal` | An unsigned `withdraw`, back to the user's own account |

## What an agent can't do

- **Move money.** The server has no key. `set_policy`, `unpause` and `withdraw` need an attached yoctoNEAR, which NEAR only lets a full-access key attach, so a wallet always asks the person.
- **Choose the keeper or the payee.** `prepare_policy` always names Lifeline's keeper, and the vault only ever pays the one Hyperliquid address in the policy.
- **Be steered by text in the data.** Tools return codes, numbers, addresses and checked names. Written explanations, key names and unusual coin names are left out.
- **Mistake a failed reading for a safe one.** It's an error that says so.
- **Send a mainnet policy as if it protected anyone.** Until the mainnet keeper runs around the clock, that comes back `blocked`.

An agent may hold one useful key: a function-call key on the vault limited to `pause`. It stops rescues and can do nothing else.

## How it speaks

It implements MCP 2026-07-28 (stateless, `server/discover`, checked headers) and answers older clients that open with `initialize`. Browser pages from other sites are refused by their Origin. 60 calls a minute per address.
