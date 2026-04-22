# @questionmarket/mcp

MCP server for [question.market](https://question.market) prediction markets on Algorand.

The minimal config gives agents read access plus wallet onboarding. To enable trading and market creation outside the monorepo, you also need the deployment app IDs and USDC ASA ID.

## Quick start

### Read-only + onboarding

All env vars have sensible defaults (public indexer, public testnet algod, public faucet), so the minimal install needs no env block. This enables market browsing, holdings lookups, wallet creation, `set_wallet`, faucet requests, and ALGO balance checks.

### Claude Code

```bash
claude mcp add --transport stdio --scope user \
  question-market -- npx -y @questionmarket/mcp
```

### Codex

```bash
codex mcp add question-market -- npx -y @questionmarket/mcp
```

### JSON config

```json
{
  "mcpServers": {
    "question-market": {
      "command": "npx",
      "args": ["-y", "@questionmarket/mcp"]
    }
  }
}
```

Override any of `INDEXER_URL`, `ALGOD_SERVER`, `ALGOD_PORT`, or `ALGOD_TOKEN` only if you need to point at a different endpoint.

## Enable Trading And Create-Market

The published package ships with the current testnet deployment bundled. When `ALGOD_SERVER` points at a testnet endpoint (the default), the server auto-loads `FACTORY_APP_ID`, `PROTOCOL_CONFIG_APP_ID`, and `USDC_ASA_ID` from that bundle — you do not need to set them manually.

The only thing you still need to add for write tools is a signer:

- `AGENT_MNEMONIC` — 25-word mnemonic preloaded at startup (best for unattended / CI use)
- Runtime `set_wallet(mnemonic)` — overrides `AGENT_MNEMONIC` for the current session; use this after `create_wallet`
- Localnet KMD fallback — only applies when neither of the above is set and you are pointing at a local sandbox

Example (testnet, with preloaded mnemonic):

```json
{
  "mcpServers": {
    "question-market": {
      "command": "npx",
      "args": ["-y", "@questionmarket/mcp"],
      "env": {
        "AGENT_MNEMONIC": "your twenty five word mnemonic goes here ..."
      }
    }
  }
}
```

**Network selection.** By default the server looks at `ALGOD_SERVER` to pick the bundled deployment (mainnet, testnet, or localnet). Override with `QUESTION_MARKET_NETWORK=testnet|mainnet|localnet` or point at a custom deployment file with `QUESTION_MARKET_DEPLOYMENT_PATH`. Env vars (`USDC_ASA_ID`, `FACTORY_APP_ID`, `PROTOCOL_CONFIG_APP_ID`) always win over the bundle.

**Localnet.** Run `algokit localnet start`, deploy the SDK (`npm run deploy:localnet` inside `sdk/`), and the resulting `protocol-deployment.json` will be auto-discovered. Alternatively, set `QUESTION_MARKET_DEPLOYMENT_PATH=/absolute/path/to/protocol-deployment.json`.

## Verify it works

Ask your agent:

> List five active question.market markets and show their current implied probabilities.

If you enabled write config, you can also ask:

> Create a wallet, fund it on testnet, and buy $5 of outcome 0 in market 123.

## Available tools

Read tools:
- `list_markets`
- `get_market`
- `get_price_history`
- `get_market_trades`
- `get_market_positions`
- `get_positions`
- `get_current_holdings`
- `get_leaderboard`

Onboarding tools:
- `create_wallet`
- `set_wallet`
- `request_testnet_tokens`
- `get_balance`

Write tools:
- `buy_shares`
- `sell_shares`
- `refund_shares`
- `claim_winnings`
- `enter_lp_active`
- `claim_lp_fees`
- `withdraw_lp_fees`
- `claim_lp_residual`
- `create_market`

The server only registers write tools when the required env vars are configured.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `INDEXER_URL` | No | question.market API endpoint. Default: `https://question.market/api` |
| `ALGOD_SERVER` | No | Algorand node URL. Default: `https://testnet-api.4160.nodely.dev` |
| `ALGOD_PORT` | No | Algorand node port. Default: `443` |
| `ALGOD_TOKEN` | No | Algorand node auth token. Default: empty (correct for Nodely) |
| `USDC_ASA_ID` | No (auto from bundle) | USDC ASA ID. Required for trading, LP, claims, refunds, and USDC-aware balances. Auto-loaded from the bundled deployment matching `ALGOD_SERVER` |
| `FACTORY_APP_ID` | No (auto from bundle) | MarketFactory application ID. Required for `create_market`. Auto-loaded from the bundled deployment |
| `PROTOCOL_CONFIG_APP_ID` | No (auto from bundle) | ProtocolConfig application ID. Required for `create_market`. Auto-loaded from the bundled deployment |
| `AGENT_MNEMONIC` | No | 25-word mnemonic preloaded as the signer for write tools. Overridden by a runtime `set_wallet` call |
| `FAUCET_URL` | No | Override the faucet endpoint for `request_testnet_tokens`. Default: `https://question.market/api/faucet` |
| `INDEXER_AUTH` | No | Optional basic-auth credentials for self-hosted indexers |
| `INDEXER_WRITE_TOKEN` | No | Optional bearer token used only by `create_market` to persist blueprint JSON to the indexer's meta endpoint. Failures are non-fatal |
| `QUESTION_MARKET_NETWORK` | No | Force network selection (`testnet`, `mainnet`, or `localnet`) when auto-detection from `ALGOD_SERVER` is wrong |
| `QUESTION_MARKET_DEPLOYMENT_PATH` | No | Override path to a `protocol-deployment.json` used to auto-load `FACTORY_APP_ID`, `PROTOCOL_CONFIG_APP_ID`, and `USDC_ASA_ID` |
| `QUESTION_MARKET_DEPLOYMENT_OUT` | No | Same as above, used by some deploy scripts that write to a separate output path |
| `KMD_SERVER` | No | LocalNet KMD URL. Default: `http://localhost` |
| `KMD_PORT` | No | LocalNet KMD port. Default: `4002` |
| `KMD_TOKEN` | No | LocalNet KMD token. Default: 64 × `a` |

## Built on

- [@questionmarket/sdk](https://www.npmjs.com/package/@questionmarket/sdk) -- TypeScript SDK for question.market contracts
- [Model Context Protocol](https://modelcontextprotocol.io/) -- open standard for AI tool access

## License

MIT
