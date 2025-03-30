Heimdall

## Overview

Heimdall is an MCP (Model Context Protocol) server that proxies other MCP servers and enables granular authorization control for your MCPs. Try it for free with our 1-step installation process below.

## Installation

1. Run setup script:
```bash
npx @shinzolabs/heimdall setup <path/to/current/config.json>
// or
git clone https://github.com/shinzo-labs/heimdall.git
pnpm i && pnpm build && pnpm run setup <path/to/current/config.json>
```

2. Modify `~/.heimdall/controls.json` and `~/.heimdall/config.json` manually and Heimdall will refresh the available tools automatically.

## TODO: finish the rest
