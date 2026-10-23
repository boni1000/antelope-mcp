# antelope-mcp

**An MCP server for any Antelope chain. Reads everything; writes only what an on-chain permission allows.**

[Model Context Protocol](https://modelcontextprotocol.io) lets an AI agent (Claude, Cursor, a local
Ollama model, …) call tools. This server gives it an Antelope chain — Vaulta (EOS), Telos, WAX,
Jungle, or a private network — over the standard chain API:

- **Read**: chain state, accounts and their permissions (with `linkauth` links), balances, any
  contract's actions and tables described from its ABI, table rows, blocks, transaction status, and
  **read-only / simulated action calls** that return the action's result without committing it.
- **Prepare**: build and dry-run a transaction and return it unsigned, with an **ESR link**
  (`esr://`) that the account holder signs in [Anchor](https://www.greymass.com/anchor) or any ESR
  wallet. No key on the server.
- **Push** (optional): sign with **one key, one `actor@permission`**, and only the actions that
  permission is **linked to on chain**. The chain decides what the agent may do, not the prompt.

Built on [WharfKit](https://wharfkit.com). No API keys, no history service required.

## Why keys stay small

Antelope lets an account create a custom permission and link it to specific contract actions
(`updateauth` + `linkauth`). Give that permission's key to this server and set
`ANTELOPE_SIGNER=account@permission`. At start the server checks that the key really belongs to
that permission and reads the linked actions: those, and only those, become `push_transaction`'s
allowed actions. An unlinked permission such as `active` can do anything, so for it the server
allows **nothing** unless `ANTELOPE_ALLOWED_ACTIONS` lists the actions explicitly.

Every push is dry-run first (`compute_transaction`) and refused if it would fail; after
broadcasting, the server waits until the transaction is really in a block, because an API node's
immediate answer is only advisory.

## Install

Requires Node ≥ 20.

```bash
npm install -g antelope-mcp      # or run from a clone: npm ci && npm run build
```

Configuration is by environment variables, see [antelope-mcp.env.example](antelope-mcp.env.example).
Only `ANTELOPE_URL` is required.

### Claude Desktop / Claude Code / Cursor

```json
{
  "mcpServers": {
    "antelope": {
      "command": "antelope-mcp",
      "env": {
        "ANTELOPE_URL": "https://jungle4.greymass.com",
        "ANTELOPE_CHAIN_NAME": "Jungle4"
      }
    }
  }
}
```

The server speaks MCP over stdio, so it can also run on another machine through SSH
(`"command": "ssh", "args": ["myserver", "antelope-mcp"]`) with the key staying on that machine.

## Tools

| Tool | Needs a key | What it does |
|---|---|---|
| `chain_info` | no | chain id, node version, head and irreversible block, finality lag |
| `get_account` | no | resources, permissions with keys and linked actions |
| `get_balances` | no | token balances at a token contract |
| `describe_contract` | no | actions (fields, return types, Ricardian titles) and tables from the ABI |
| `get_table_rows` | no | decoded table rows, primary or secondary index |
| `get_table_scopes` | no | which scopes of a table hold rows |
| `get_block` | no | a block with its transactions and actions |
| `get_transaction` | no | status by id; actions too if a Hyperion URL is configured |
| `call_readonly_action` | no | run an action without committing: return value, console; `as` to simulate an authority |
| `prepare_transaction` | no | validate, dry-run, return unsigned transaction + `esr://` link for a wallet |
| `wait_for_transaction` | no | wait until a transaction is in a block, optionally irreversible (scans blocks, works on any node) |
| `push_transaction` | **yes** | sign as the configured authority, only allowed actions, dry-run first, confirm inclusion |

### Example session

> *Agent:* `describe_contract eosio.token` → learns `transfer(from, to, quantity, memo)`
> *Agent:* `prepare_transaction` with that transfer as `alice@active` → gets a dry-run result and an `esr://…` link
> *Human:* opens the link in Anchor, reviews the action, signs
> *Agent:* `wait_for_transaction` with the id → `{ block: 1234567, irreversible: true }`

## Setting up a scoped signer

On any Antelope chain, as the account holder:

```bash
cleos create key --file mcp.key && chmod 600 mcp.key          # on the machine that runs the server
# add a permission "mcp" under active with that public key, linked to one action:
cleos push action eosio updateauth '{"account":"alice","permission":"mcp","parent":"active",
  "auth":{"threshold":1,"keys":[{"key":"EOS…","weight":1}],"accounts":[],"waits":[]}}' -p alice@active
cleos push action eosio linkauth '["alice","mycontract","submit","mcp"]' -p alice@active
```

Or let the server prepare both actions with `prepare_transaction` and sign the ESR link in Anchor,
as in this repository's own test. Then:

```
ANTELOPE_SIGNER=alice@mcp
ANTELOPE_PRIVATE_KEY_FILE=/path/mcp.key
```

`push_transaction` now signs `mycontract::submit` as `alice@mcp` and nothing else. Even if the
agent is misled, the chain refuses any other action from that key.

## Tested on

- A five-producer private network (Spring 1.2.2): all tools, including a scoped push as
  `boni@mcp` linked to a single test action, with the unlinked actions refused and a failing
  action caught by the dry run.
- Vaulta (`eos.greymass.com`), Telos (`telos.greymass.com`), WAX (`wax.greymass.com`) and the
  Jungle4 testnet (`jungle4.greymass.com`): every tool except a signed push — reads, secondary
  indexes, simulation, transaction status, and `prepare_transaction` with a successful dry run.
  `chain_info` tells Savanna chains (finality in about a second) from legacy ones (tens of
  seconds) and from forks that predate Spring, such as WAX's.

Nodes that have `read-only-threads = 0` (common) cannot serve `send_read_only_transaction`; the
server then falls back to a dry run under the contract's own authority, which gives the same
result for getter actions. Nodes without the transaction-status plugin answer `get_transaction`
with an explanation; `wait_for_transaction` does not need it.

## Development

```bash
npm ci && npm run build && npm test
node scripts/smoke.mjs https://jungle4.greymass.com '[["chain_info",{}]]'   # real MCP round trip
```

## Related

- [x402-spend-guard](https://github.com/boni1000/x402-spend-guard): spending limits, human approval
  and audit for AI agents that pay with x402, enforced by an Antelope contract. antelope-mcp is the
  general-purpose sibling: any chain, any contract.

## License

MIT
