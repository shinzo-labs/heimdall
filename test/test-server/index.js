import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from 'zod'

const server = new McpServer({
  name: "TestServer",
  version: "1.0.0",
  description: "Test MCP server"
})

server.tool(
  "tool1",
  "Test tool 1",
  {
    "message": z.string()
  },
  async (params) => ({ content: [{ type: "text", text: `tool1 response: ${params.message}` }] })
)

server.tool(
  "tool2",
  "Test tool 2",
  {
    "message": z.string()
  },
  async (params) => ({ content: [{ type: "text", text: `tool2 response: ${params.message}` }] })
)

const transport = new StdioServerTransport()
await server.connect(transport) 