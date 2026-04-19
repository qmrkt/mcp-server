# @questionmarket/mcp

MCP server for [question.market](https://question.market) prediction markets on Algorand.

The minimal config gives agents read access plus wallet onboarding. To enable trading and market creation outside the monorepo, you also need the deployment app IDs and USDC ASA ID.

## Quick start

### Read-only + onboarding

This enables market browsing, holdings lookups, wallet creation, `set_wallet`, faucet requests, and ALGO balance checks.

### Claude Code

```bash
claude mcp add --transport stdio --scope user \
  --env INDEXER_URL=https://question.market/api \
  --env ALGOD_SERVER=https://testnet-api.4160.nodely.dev \
  --env ALGOD_PORT=443 \
  --env ALGOD_TOKEN= \
  question-market -- npx -y @questionmarket/mcp
```

### Codex

```bash
codex mcp add question-market \
  --env INDEXER_URL=https://question.market/api \
  --env ALGOD_SERVER=https://testnet-api.4160.nodely.dev \
  --env ALGOD_PORT=443 \
  --env ALGOD_TOKEN= \
  -- npx -y @questionmarket/mcp
```

### JSON config

```json
{
  "mcpServers": {
    "question-market": {
      "command": "npx",
      "args": ["-y", "@questionmarket/mcp"],
      "env": {
        "INDEXER_URL": "https://question.market/api",
        "ALGOD_SERVER": "https://testnet-api.4160.nodely.dev",
        "ALGOD_PORT": "443",
        "ALGOD_TOKEN": ""
      }
    }
  }
}
```

## Enable Trading And Create-Market

Outside the monorepo, set these extra env vars before starting the server:

- `USDC_ASA_ID` to enable trading, LP, claims, refunds, and USDC-aware balances
- `FACTORY_APP_ID` and `PROTOCOL_CONFIG_APP_ID` to enable `create_market`
- `INDEXER_WRITE_TOKEN` to enable `set_market_image` and authenticated image upload during `create_market`

Example:

```json
{
  "mcpServers": {
    "question-market": {
      "command": "npx",
      "args": ["-y", "@questionmarket/mcp"],
      "env": {
        "INDEXER_URL": "https://question.market/api",
        "ALGOD_SERVER": "https://testnet-api.4160.nodely.dev",
        "ALGOD_PORT": "443",
        "ALGOD_TOKEN": "",
        "USDC_ASA_ID": "<usdc_asa_id>",
        "FACTORY_APP_ID": "<factory_app_id>",
        "PROTOCOL_CONFIG_APP_ID": "<protocol_config_app_id>",
        "INDEXER_WRITE_TOKEN": "<optional_indexer_write_token>"
      }
    }
  }
}
```

For local development, the server also looks for a deployment file via `QUESTION_MARKET_DEPLOYMENT_PATH`, `QUESTION_MARKET_DEPLOYMENT_OUT`, the SDK's shared temp cache, and the older monorepo `protocol-deployment.json` locations. Published installs should still set the app IDs explicitly.

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
- `set_market_image`

The server only registers write tools when the required env vars are configured.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `INDEXER_URL` | Yes | question.market API endpoint |
| `ALGOD_SERVER` | Yes | Algorand node URL |
| `ALGOD_PORT` | Yes | Algorand node port |
| `ALGOD_TOKEN` | No | Algorand node auth token |
| `USDC_ASA_ID` | Required for trading | Enables trading, LP, claims, refunds, and USDC-aware balances |
| `FACTORY_APP_ID` | Required for `create_market` | MarketFactory application ID |
| `PROTOCOL_CONFIG_APP_ID` | Required for `create_market` | ProtocolConfig application ID |
| `INDEXER_WRITE_TOKEN` | Required for `set_market_image` | Bearer token for authenticated indexer writes |
| `AGENT_MNEMONIC` | No | Preload a wallet for write tools on startup |
| `FAUCET_URL` | No | Override the faucet endpoint for `request_testnet_tokens` |
| `INDEXER_AUTH` | No | Optional basic-auth credentials for the indexer |
| `KMD_SERVER` | No | LocalNet KMD URL |
| `KMD_PORT` | No | LocalNet KMD port |
| `KMD_TOKEN` | No | LocalNet KMD token |

## Built on

- [@questionmarket/sdk](https://www.npmjs.com/package/@questionmarket/sdk) -- TypeScript SDK for question.market contracts
- [Model Context Protocol](https://modelcontextprotocol.io/) -- open standard for AI tool access

## License

MIT
