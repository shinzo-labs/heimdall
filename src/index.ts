import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { logger } from './logger.js'
import { CONFIG_DIR, LOG_DIR, POLL_INTERVAL, TOOL_EXECUTION_TIMEOUT } from './config.js'

type ClientConfig = {
  mcpServers: {
    [key: string]: {
      command: string
      args: string[]
      env?: Record<string, string>
    }
  }
}

type ControlConfig = {
  authorizedMcpServers: {
    [key: string]: {
      authorizedTools: string[]
    }
  }
}

type ServerProcess = {
  process: ReturnType<typeof spawn>
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
}

const createServer = () => new McpServer({
  name: "Heimdall",
  version: "1.0.0",
  description: "An MCP server that proxies other MCP servers and enables granular authorization control for your MCPs."
})

let server = createServer()
let transport: StdioServerTransport | null = null
const serverProcesses = new Map<string, ServerProcess>()
const registeredTools = new Set<string>()

const formatResponse = (response: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(response) }] })

const getCompositeToolName = (serverId: string, toolName: string) => `${serverId}/${toolName}`

const executeToolOnServer = async (serverId: string, toolName: string, params: any): Promise<any> => {
  try {
    logger("info", `Executing tool: ${toolName} on server: ${serverId}`)

    const serverProcess = serverProcesses.get(serverId)
    if (!serverProcess) throw new Error(`Server ${serverId} not found`)

    const request = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tool/execute",
      params: {
        name: toolName,
        arguments: params
      }
    }

    const response = await new Promise((resolve, reject) => {
      let responseData = ''

      const responseHandler = (data: Buffer) => {
        responseData += data.toString()

        try {
          const response = JSON.parse(responseData)

          if (response.id === request.id) {
            serverProcess.stdout.removeListener('data', responseHandler)

            if (response.error) {
              reject(new Error(response.error.message))
            } else {
              resolve(response.result)
            }
          }
        } catch (e) {
          // Incomplete JSON, keep waiting
        }
      }

      serverProcess.stdout.on('data', responseHandler)

      serverProcess.stdin.write(JSON.stringify(request) + '\n')

      setTimeout(() => {
        serverProcess.stdout.removeListener('data', responseHandler)
        reject(new Error(`Tool execution timed out for ${toolName} on server ${serverId}`))
      }, TOOL_EXECUTION_TIMEOUT)
    })

    logger("info", `Tool ${toolName} returned: ${JSON.stringify(response)}`)
    return formatResponse(response)
  } catch (error: any) {
    logger("error", `Error executing tool ${toolName} on server ${serverId}: ${error.message}`)
    return formatResponse({ error: error.message })
  }
}

const startServer = async (serverId: string, serverConfig: ClientConfig['mcpServers'][string]) => {
  try {
    const logFile = fs.createWriteStream(path.join(LOG_DIR, `${serverId}.log`))

    const serverEnv = { ...process.env, ...serverConfig.env }

    const childProcess = spawn(serverConfig.command, serverConfig.args, {
      shell: true,
      cwd: CONFIG_DIR,
      env: serverEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    childProcess.on('error', (error) => {
      logger("error", `Server ${serverId} process error: ${error.message}`)
    })

    childProcess.on('exit', (code, signal) => {
      logger("info", `Server ${serverId} exited with code ${code} and signal ${signal}`)
      serverProcesses.delete(serverId)
    })

    childProcess.stdout.pipe(logFile)
    childProcess.stderr.pipe(logFile)

    serverProcesses.set(serverId, {
      process: childProcess,
      stdin: childProcess.stdin,
      stdout: childProcess.stdout,
      stderr: childProcess.stderr
    })

    logger("info", `Started server: ${serverId}`)
  } catch (error: any) {
    logger("error", `Failed to start server ${serverId}: ${error.message}`)
  }
}

const loadConfig = async () => {
  try {
    const clientConfigPath = path.join(CONFIG_DIR, 'config.json')
    if (!fs.existsSync(clientConfigPath)) {
      throw new Error(`Required config file not found: ${clientConfigPath}`)
    }
    const clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf-8')) as ClientConfig

    const controlsPath = path.join(CONFIG_DIR, 'controls.json')
    if (!fs.existsSync(controlsPath)) {
      throw new Error(`Required config file not found: ${controlsPath}`)
    }
    const controlConfig = JSON.parse(fs.readFileSync(controlsPath, 'utf-8')) as ControlConfig

    return { clientConfig, controlConfig }
  } catch (error: any) {
    logger("error", `Failed to load config: ${error.message}`)
    throw error
  }
}

// Function to update tools based on controls.json
const updateTools = async (controlConfig: ControlConfig) => {
  try {
    const currentToolNames = new Set<string>()
    for (const [serverId, serverAuth] of Object.entries(controlConfig.authorizedMcpServers)) {
      for (const toolName of serverAuth.authorizedTools) {
        currentToolNames.add(getCompositeToolName(serverId, toolName))
      }
    }

    const needsRestart = Array.from(registeredTools).some(toolName => !currentToolNames.has(toolName))

    if (needsRestart) {
      logger("info", "Tools were removed, creating new server instance")
      // Create new server instance and transport
      server = createServer()
      transport = new StdioServerTransport()
      await server.connect(transport)
      // Clear registered tools since we're starting fresh
      registeredTools.clear()
    }

    for (const [serverId, serverAuth] of Object.entries(controlConfig.authorizedMcpServers)) {
      for (const toolName of serverAuth.authorizedTools) {
        const compositeToolName = getCompositeToolName(serverId, toolName)
        if (!needsRestart && registeredTools.has(compositeToolName)) continue

        server.tool(
          compositeToolName,
          `Authorized tool: ${toolName} from server ${serverId}`,
          {}, // Parameters will be passed through directly to the underlying server // TODO: update this to pull parameters from spec returned by calling server with `{"method":"tools/list","params":{},"jsonrpc":"2.0","id":2}`
          async (params: any) => executeToolOnServer(serverId, toolName, params)
        )

        registeredTools.add(compositeToolName)
      }
    }

    logger("info", needsRestart ? "MCP server restarted with updated tools" : "Updated tools from controls.json")
  } catch (error: any) {
    logger("error", `Failed to update tools: ${error.message}`)
  }
}

const stopServer = async (serverId: string) => {
  const serverProcess = serverProcesses.get(serverId)
  if (!serverProcess) return

  logger("info", `Stopping server: ${serverId}`)
  serverProcess.process.kill()
  serverProcesses.delete(serverId)
}

const updateServerProcesses = async (clientConfig: ClientConfig) => {
  try {
    const currentServerIds = new Set(serverProcesses.keys())
    const newServerIds = new Set(Object.keys(clientConfig.mcpServers))

    // Stop removed servers
    for (const serverId of currentServerIds) {
      if (!newServerIds.has(serverId)) {
        await stopServer(serverId)
        logger("info", `Removed server: ${serverId}`)
      }
    }

    // Start new servers and update existing ones
    for (const [serverId, serverConfig] of Object.entries(clientConfig.mcpServers)) {
      const currentProcess = serverProcesses.get(serverId)
      
      // Check if config changed for existing server
      if (currentProcess) {
        const currentConfig = JSON.stringify({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env
        })
        
        const existingConfig = JSON.stringify({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env
        })

        if (currentConfig !== existingConfig) {
          await stopServer(serverId)
          await startServer(serverId, serverConfig)
          logger("info", `Updated server: ${serverId}`)
        }
      } else {
        // Start new server
        await startServer(serverId, serverConfig)
        logger("info", `Added new server: ${serverId}`)
      }
    }
  } catch (error: any) {
    logger("error", `Failed to update server processes: ${error.message}`)
    throw error
  }
}

const main = async () => {
  try {
    const { clientConfig, controlConfig } = await loadConfig()

    await updateServerProcesses(clientConfig)
    await updateTools(controlConfig)

    transport = new StdioServerTransport()
    if (transport) {
      await server.connect(transport)
    }

    setInterval(async () => {
      try {
        const { clientConfig, controlConfig } = await loadConfig()

        await updateServerProcesses(clientConfig)
        await updateTools(controlConfig)
      } catch (error: any) {
        logger("error", `Polling update failed: ${error.message}`)
      }
    }, POLL_INTERVAL)

    logger("info", "Heimdall initialized successfully")
  } catch (error: any) {
    logger("error", `Initialization failed: ${error.message}`)
    process.exit(1)
  }
}

await main()

