// Heimdall

/*

Heimdall is an MCP (Model Context Protocol) server that proxies other MCP
servers and enables granular authorization control for your MCPs. The following
steps describe how Heimdall functions:

1. Compute config directory path (default: `~/.heimdall/`)
2. Open MCP server config `~/.heimdall/config.json`
3. For each server and start command, start the server in a new process and pipe the output to a log file.
4. Open authorized tools from `~/.heimdall/controls.json`
5. For each server, append all authorized tools to Heimdall's tool set and route requests to the correct server.
6. Poll every 10 seconds for new or updated tools from `~/.heimdall/controls.json` and update Heimdall's tool set accordingly.

*/

import { logger } from './logger.js'
import { CONFIG_DIR } from './config.js'
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from 'zod'
const server = new McpServer({
  name: "Heimdall",
  version: "1.0.0",
  description: "An MCP server that proxies other MCP servers and enables granular authorization control for your MCPs."
})

const formatResponse = (response: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(response) }] })

const handleTool = async (toolName: string, apiCall: () => Promise<any>) => {
  try {
    logger("info", `Calling tool: ${toolName}`)
    const response = await apiCall()
    logger("info", `Tool ${toolName} returned: ${JSON.stringify(response)}`)
    return formatResponse(response)
  } catch (error: any) {
    logger("error", `Error calling tool ${toolName}: ${error.message}`)
    return formatResponse(`Error: ${error.message}`)
  }
}

server.tool("tool1",
  "Description of tool1",
  {
    "param1": z.string(),
    "param2": z.number()
  },
  async (params: any) => handleTool("tool1", async () => await Promise.resolve(params))
)

const transport = new StdioServerTransport()
await server.connect(transport)
