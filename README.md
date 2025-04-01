Heimdall

[![npm version](https://badge.fury.io/js/@shinzolabs%2Fheimdall.svg)](https://badge.fury.io/js/@shinzolabs%2Fheimdall)
[![smithery badge](https://smithery.ai/badge/@shinzo-labs/heimdall)](https://smithery.ai/server/@shinzo-labs/heimdall)

Heimdall is a lightweight service to manage local [MCP Servers]((https://modelcontextprotocol.io/introduction)) and can be installed with a single `npx` command. Specific MCP server tools can be authorized for your MCP clients, and the same config is accessible to all MCP clients on your device.

## Installation

⚠️ <strong>NOTE:</strong> We strongly recommend backing up your MCP server config before installation to protect against unexpected loss of credentials.

The setup script performs a few key actions:
- Moves the `mcpServers` config JSON from the path you specify to `~/.heimdall/config.json`
- Inserts a single config for `heimdall` in place of the previous `mcpServers` config path
- Initializes the controls at `~/.heimdall/controls.json` to authorize all methods on all current servers

See [Configuration](#configuration) for steps to modify `~/.heimdall/controls.json` to limit the authorized tools for a given server, and add new servers to `~/.heimdall/config.json`.

### Via NPX (Recommended)

1. Run setup script (generates an empty config if no path is given):
```bash
npx @shinzolabs/heimdall setup <optional: path/to/current/config.json>
```

### Via Local Instance

1. Download the package:
```bash
git clone https://github.com/shinzo-labs/heimdall.git
```

2. Install and build dependencies:
```bash
cd heimdall && pnpm i && pnpm build
```

3. Run setup script (generates an empty config if no path is given):
```bash
pnpm run setup <optional: path/to/current/config.json> <optional: path to local Heimdall instance\'s `index.js` file, ex. `/path/to/local/heimdall/dist/index.js`>
```

## Configuration

### Edit Server List

To add or update available servers, simply update the configuration at `~/.heimdall/config.json` as your regular `mcpServers` config JSON. Note that you will not see tools for new servers through Heimdall unless you also add the server and authorized tools to `~/.heimdall/controls.json`.

### Edit Authorized Tools

To add authorized tools to a new or existing server, add them as needed to `~/.heimdall/controls.json` and Heimdall will update its internal config after a few seconds. If your MCP client supports dynamic tool list caching, you should see it update the authorized tools automatically. Other clients (ex. Claude Desktop) may require a restart to see the new tools.

This is the schema for `~/.heimdall/controls.json`:
```javascript
{
  "authorizedMcpServers": {
    "server1": {
      "authorizedTools": [
        "tool1",
        "tool2",
        ...
      ]
    },
    "server2": {
      "authorizedTools": [
        "tool1",
        "tool2",
        ...
      ]
    }
```

## Troubleshooting

### Available Tools

Some MCP Clients have limits on the number of tools available to agents at a given time. For example, Cursor only supports up to 40 tools across all servers, so the sum of `authorizedTools` in `controls.json` cannot exceed this number.

### Logging

For logs on running instances, go to `~/.heimdall/logs`. Logs for each MCP client's instance of Heimdall and child servers are stored in separate directories identified by random UUIDs.

### Orphaned Child Processes

If your MCP client shut downs unexpectedly or fails to send the correct `SIGTERM` signal to Heimdall before closing, there may be orphaned `node` (and `npm`) processes still running on your device afterward. For the time being these must be force stopped manually. If there are no other sensitive `node` processes running on your device, you can use this command as post-cleanup:
```bash
pkill -aif node
```

## Contributing

Contributions are welcomed and encouraged. Contact austin@shinzolabs.com with any questions, comments or concerns.
