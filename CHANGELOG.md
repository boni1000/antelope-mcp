# Changelog

## 0.1.0 — 2026-10-23

First release.

- Read tools: `chain_info` (with consensus mode: Savanna or legacy), `get_account` (permissions
  with `linkauth` links), `get_balances`, `describe_contract` (actions, return types, Ricardian
  titles, tables), `get_table_rows`, `get_table_scopes`, `get_block`, `get_transaction`,
  `call_readonly_action` (read-only calls and permission-checked simulation with `as`).
- `prepare_transaction`: validates and dry-runs, returns the unsigned transaction and an ESR link
  that the wallet signs unchanged, so the returned transaction id is the id that lands on chain.
- `push_transaction` (optional): one key, one `actor@permission`, only the actions linked to that
  permission on chain; dry run before signing, inclusion confirmed after.
- `wait_for_transaction`: transaction-status API where the node has it, block scan otherwise;
  resumable within MCP clients' 60 s call limit.
- Requests paced (`ANTELOPE_MAX_RPS`, default 15) with retries on 429/503 and dropped connections.
- Tested on a private Spring 1.2.2 network, Vaulta, Telos, WAX and Jungle4.
