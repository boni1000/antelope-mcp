# Security

## Model

- **Keyless by default.** Without `ANTELOPE_SIGNER` the server holds no key. It reads, simulates
  and prepares transactions; a person signs them in their own wallet.
- **One key, one authority, chain-defined scope.** With a signer, the server signs only as the
  configured `actor@permission`. The actions it may push are the ones that permission is linked to
  with `linkauth`. The chain enforces this independently of the server: a signature from a linked
  permission is simply invalid for any other action.
- **An unlinked permission allows nothing** unless `ANTELOPE_ALLOWED_ACTIONS` names actions. Do not
  give the server an `active` or `owner` key.
- **Fixed endpoint.** Tools never take a URL. Set `ANTELOPE_CHAIN_ID` so the server refuses an
  endpoint that serves a different chain.
- **Dry run before push; inclusion confirmed after.** A push that would fail is refused before
  signing. After broadcasting, the server waits for the transaction in a block (the API node's
  answer alone is advisory on Antelope).

## What this does not protect against

- A compromised host can read the key file. Keep the key's permission scoped so the damage is
  bounded to the linked actions, and use a separate account for the agent where possible.
- The server trusts the configured API node for reads. Use a node you operate or trust.
- `prepare_transaction` output is only as safe as the person who signs it: review the actions in
  the wallet before signing.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository rather than a public issue.
