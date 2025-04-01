import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import crypto from 'crypto'
import { logger } from './logger.js'
import { CONFIG_DIR, LOG_DIR, POLL_INTERVAL, TOOL_EXECUTION_TIMEOUT } from './config.js'
import { z } from 'zod'

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
  logFile: fs.WriteStream
  configHash: string
}

type ToolDetails = {
  name: string
  description: string
  inputSchema: Record<string, any>
}

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: number
  method: string
  params: Record<string, any>
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number
  result?: any
  error?: {
    message: string
    code?: number
  }
}

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024 // 10MB


const createHeimdallServer = () => new McpServer({
  name: "Heimdall",
  version: "1.0.0",
  description: "An MCP server that proxies other MCP servers and enables granular authorization control for your MCPs."
})

let server: McpServer | null = null
let transport: StdioServerTransport | null = null
const serverSet = new Map<string, ServerProcess>()
let currentClientConfigHash = ''
let currentControlConfigHash = ''

const sha256 = (data: string): string => crypto.createHash('sha256').update(data).digest('hex')

const formatResponse = (response: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(response) }] })

const getCompositeToolName = (serverId: string, toolName: string) => `${serverId}-${toolName}`

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

const createJsonRpcRequest = (method: string, params: Record<string, any> = {}): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: Date.now(),
  method,
  params
})

const sendJsonRpcRequest = async <T>(
  serverProcess: ServerProcess,
  request: JsonRpcRequest,
  timeout: number = TOOL_EXECUTION_TIMEOUT
): Promise<T> => {
  return new Promise((resolve, reject) => {
    let responseData = ''
    let timeoutId: NodeJS.Timeout
    let isCleanedUp = false

    const cleanup = () => {
      if (isCleanedUp) return
      isCleanedUp = true

      serverProcess.stdout.removeListener('data', responseHandler)
      clearTimeout(timeoutId)
    }

    const responseHandler = (data: Buffer) => {
      if (isCleanedUp) return

      // Limit response size to prevent memory issues
      if (responseData.length > MAX_RESPONSE_SIZE) { // 10MB limit
        cleanup()
        reject(new Error(`Response too large for method ${request.method}`))
        return
      }

      responseData += data.toString()

      try {
        const response = JSON.parse(responseData) as JsonRpcResponse

        if (response.id === request.id) {
          cleanup()

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

    timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error(`Request timed out for method ${request.method}`))
    }, timeout)

    // Handle process errors
    const errorHandler = (error: Error) => {
      cleanup()
      reject(error)
    }

    serverProcess.process.on('error', errorHandler)
    serverProcess.stdout.on('data', responseHandler)

    // Write the request
    try {
      serverProcess.stdin.write(JSON.stringify(request) + '\n')
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

const convertJsonSchemaToZod = (schema: Record<string, any>): z.ZodTypeAny => {
  if (!schema || typeof schema !== 'object') return z.any()

  let validator: z.ZodTypeAny

  switch (schema.type) {
    case 'string': {
      validator = schema.enum ? z.enum(schema.enum as [string, ...string[]]) : z.string()
      break
    }
    case 'number':
      validator = z.number()
      break
    case 'boolean':
      validator = z.boolean()
      break
    case 'object': {
      if (!schema.properties) {
        validator = schema.additionalProperties === false ? z.object({}).strict() : z.record(z.any())
        break
      }

      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, value] of Object.entries(schema.properties)) {
        const propertySchema = convertJsonSchemaToZod(value as Record<string, any>)
        shape[key] = schema.required?.includes(key)
          ? propertySchema
          : propertySchema.optional()
      }

      validator = z.object(shape)
      break
    }
    case 'array':
      validator = z.array(convertJsonSchemaToZod(schema.items))
      break
    default:
      validator = z.any()
      break
  }

  return schema.description ? validator.describe(schema.description) : validator
}

const convertInputSchemaToParameters = (inputSchema: Record<string, any>): Record<string, z.ZodTypeAny> => {
  if (!inputSchema?.properties || typeof inputSchema.properties !== 'object') return {}

  const parameters: Record<string, z.ZodTypeAny> = {}

  for (const [key, value] of Object.entries(inputSchema.properties)) {
    parameters[key] = convertJsonSchemaToZod(value as Record<string, any>)
  }

  return parameters
}

const listServerTools = async (serverId: string): Promise<ToolDetails[]> => {
  const serverProcess = serverSet.get(serverId)
  if (!serverProcess) {
    logger("error", `Server ${serverId} not running, skipping tool details fetch`)
    return []
  }

  const request = createJsonRpcRequest('tools/list')
  const response = await sendJsonRpcRequest<{ tools: ToolDetails[] }>(serverProcess, request)
  return response.tools || []
}

const discoverServerTools = async (serverId: string, serverConfig: ClientConfig['mcpServers'][string]): Promise<string[]> => {
  try {
    await startServer(serverId, serverConfig)
    const tools = await listServerTools(serverId)
    await stopServer(serverId)

    return tools.map(tool => tool.name).sort()
  } catch (error: any) {
    logger("error", `Failed to discover tools for server ${serverId}: ${error.message}`)
    await stopServer(serverId)
    return []
  }
}

const executeToolOnServer = async (serverId: string, toolName: string, params: any): Promise<any> => {
  try {
    logger("info", `Executing tool: ${toolName} on server: ${serverId}`)

    const serverProcess = serverSet.get(serverId)
    if (!serverProcess) throw new Error(`Server ${serverId} not found`)

    const request = createJsonRpcRequest('tools/call', { name: toolName, arguments: params })

    const response = await sendJsonRpcRequest(serverProcess, request)

    logger("info", `Tool ${toolName} returned: ${JSON.stringify(response)}`)
    return formatResponse(response)
  } catch (error: any) {
    logger("error", `Error executing tool ${toolName} on server ${serverId}: ${error.message}`)
    return formatResponse({ error: error.message })
  }
}

const startServer = async (serverId: string, serverConfig: ClientConfig['mcpServers'][string]) => {
  try {
    logger("info", `Starting server: ${serverId}`)

    const logPath = path.join(LOG_DIR, `${serverId}.log`)
    const logFile = fs.createWriteStream(logPath, { flags: 'a' })

    const serverEnv = { ...process.env, ...serverConfig.env }

    const childProcess = spawn(serverConfig.command, serverConfig.args, {
      shell: true,
      cwd: CONFIG_DIR,
      env: serverEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    })

    childProcess.on('error', (error) => {
      logger("error", `Server ${serverId} process error: ${error.message}`)
    })

    childProcess.on('exit', (code, signal) => {
      logger("info", `Server ${serverId} exited with code ${code} and signal ${signal}`)
      const serverProcess = serverSet.get(serverId)
      if (serverProcess) {
        serverProcess.logFile.end()
        serverSet.delete(serverId)
      }
    })

    childProcess.stdout.pipe(logFile)
    childProcess.stderr.pipe(logFile)

    serverSet.set(serverId, {
      process: childProcess,
      stdin: childProcess.stdin,
      stdout: childProcess.stdout,
      stderr: childProcess.stderr,
      logFile,
      configHash: sha256(JSON.stringify(serverConfig))
    })

    logger("info", `Started server: ${serverId}`)
  } catch (error: any) {
    logger("error", `Failed to start server ${serverId}: ${error.message}`)
  }
}

const stopServer = async (serverId: string) => {
  const serverProcess = serverSet.get(serverId)
  if (!serverProcess) {
    logger("info", `Server ${serverId} not running, skipping stop`)
    return
  }

  logger("info", `Stopping server: ${serverId}`)

  serverProcess.logFile.end()

  // Force kill the process and its children
  try {
    process.kill(-serverProcess.process.pid!, 'SIGKILL')
  } catch (error) {
    // Fallback if process group kill fails
    serverProcess.process.kill('SIGKILL')
  }

  serverSet.delete(serverId)
  logger("info", `Removed server: ${serverId}`)
}

const refreshChildServers = async (clientConfig: ClientConfig) => {
  logger("info", "Refreshing child servers")

  try {
    for (const serverId of serverSet.keys()) {
      if (!clientConfig.mcpServers[serverId]) {
        await stopServer(serverId)
      }
    }

    // Start new servers and update existing ones
    for (const [serverId, serverConfig] of Object.entries(clientConfig.mcpServers)) {
      const currentProcess = serverSet.get(serverId)

      if (currentProcess) {
        const newConfigHash = sha256(JSON.stringify(serverConfig))

        const existingConfigHash = currentProcess.configHash

        if (newConfigHash !== existingConfigHash) {
          await stopServer(serverId)
          await startServer(serverId, serverConfig)
        }
      } else {
        await startServer(serverId, serverConfig)
      }
    }

    logger("info", "Child servers refreshed successfully")
  } catch (error: any) {
    logger("error", `Failed to refresh child servers: ${error.message}`)
    throw error
  }
}

const refreshHeimdall = async (controlConfig: ControlConfig) => {
  logger("info", "Refreshing Heimdall")

  try {
    if (server) server.close() // TODO double-check if this is needed
    server = createHeimdallServer()
    transport = new StdioServerTransport()

    const serverToolDetails: Record<string, Record<string, ToolDetails>> = {}

    for (const serverId of Object.keys(controlConfig.authorizedMcpServers)) {
      try {
        const tools = await listServerTools(serverId)
        serverToolDetails[serverId] = {}
        for (const tool of tools) {
          serverToolDetails[serverId][tool.name] = tool
        }
      } catch (error: any) {
        logger("error", `Failed to fetch tool details from server ${serverId}: ${error.message}`)
        continue
      }
    }

    for (const [serverId, serverAuth] of Object.entries(controlConfig.authorizedMcpServers)) {
      const serverTools = serverToolDetails[serverId]

      for (const toolName of serverAuth.authorizedTools) {
        logger("info", `Checking tool: ${toolName} from server ${serverId}`)
        const compositeToolName = getCompositeToolName(serverId, toolName)

        const toolDetails = serverTools?.[toolName]

        logger("info", `Adding tool: ${compositeToolName}`)
        server.tool(
          compositeToolName,
          toolDetails?.description || `Authorized tool: ${toolName} from server ${serverId}`,
          toolDetails?.inputSchema
            ? convertInputSchemaToParameters(toolDetails.inputSchema)
            : {},
          async (params: any) => executeToolOnServer(serverId, toolName, params)
        )

        logger("info", `Added tool: ${compositeToolName}`)
      }
    }

    await server.connect(transport)

    logger("info", "Heimdall refreshed successfully")
  } catch (error: any) {
    logger("error", `Failed to refresh Heimdall: ${error.message}`)
  }
}

const setup = async () => {
  console.log("Setting up Heimdall")

  const sourceConfigFile = process.argv[3]
  const heimdallExecutablePath = process.argv[4]

  if (sourceConfigFile && !fs.existsSync(sourceConfigFile)) {
    console.log(`Source config file not found: ${sourceConfigFile}`)
    process.exit(1)
  }

  if (heimdallExecutablePath && !fs.existsSync(heimdallExecutablePath)) {
    console.log(`Heimdall executable not found: ${heimdallExecutablePath}`)
    process.exit(1)
  }

  let clientConfig: ClientConfig = { mcpServers: {} }

  // Create config.json
  const clientConfigFile = path.join(CONFIG_DIR, "config.json")
  if (fs.existsSync(clientConfigFile)) {
    console.log(`${clientConfigFile} already exists, skipping config.json creation`)
    clientConfig = JSON.parse(fs.readFileSync(clientConfigFile, "utf-8"))
  } else {
    if (sourceConfigFile) {
      console.log(`Using source config file: ${sourceConfigFile}`)
      clientConfig = JSON.parse(fs.readFileSync(sourceConfigFile, "utf-8"))
      fs.writeFileSync(clientConfigFile, JSON.stringify(clientConfig, null, 2))
      console.log(`${clientConfigFile} created`)
    } else {
      console.log("No source config file provided, creating empty config.json")
      fs.writeFileSync(clientConfigFile, JSON.stringify(clientConfig, null, 2))
      console.log(`${clientConfigFile} created`)
    }
  }

  // Update original MCP server config (if provided)
  if (sourceConfigFile) {
    const newClientConfig = heimdallExecutablePath
      ? { mcpServers: { heimdall: { command: "node", args: [heimdallExecutablePath] } } }
      : { mcpServers: { heimdall: { command: "npx", args: ["@shinzolabs/heimdall"] } } }
    fs.writeFileSync(sourceConfigFile, JSON.stringify(newClientConfig, null, 2))
    console.log(`${sourceConfigFile} configured with "${heimdallExecutablePath || "@shinzolabs/heimdall"}"`)
  }

  // Create controls.json
  const controlsConfigFile = path.join(CONFIG_DIR, "controls.json")
  if (fs.existsSync(controlsConfigFile)) {
    console.log(`${controlsConfigFile} already exists, skipping controls.json creation`)
  } else {
    const authorizedMcpServers: ControlConfig['authorizedMcpServers'] = {}

    // Discover tools for each server
    const sortedServers = Object.entries(clientConfig.mcpServers).sort((a, b) => a[0].localeCompare(b[0]))
    for (const [serverId, serverConfig] of sortedServers) {
      const tools = await discoverServerTools(serverId, serverConfig)
      if (tools.length > 0) {
        authorizedMcpServers[serverId] = { authorizedTools: tools }
        console.log(`Discovered ${tools.length} tools from server ${serverId}`)
      }
    }

    fs.writeFileSync(controlsConfigFile, JSON.stringify({ authorizedMcpServers }, null, 2))

    const toolCount = Object.values(authorizedMcpServers).reduce((acc, server) => acc + server.authorizedTools.length, 0)
    console.log(`Created ${controlsConfigFile} with ${toolCount} tools`)
  }
}

const refreshSystem = async () => {
  try {
    const { clientConfig, controlConfig } = await loadConfig()
    const newClientConfigHash = sha256(JSON.stringify(clientConfig))
    const newControlConfigHash = sha256(JSON.stringify(controlConfig))

    const clientConfigChanged = newClientConfigHash !== currentClientConfigHash
    const controlConfigChanged = newControlConfigHash !== currentControlConfigHash

    if (clientConfigChanged) {
      logger("info", "Client config changed, updating server processes")
      await refreshChildServers(clientConfig)
    } else {
      logger("info", "Client config unchanged, skipping server processes update")
    }

    if (clientConfigChanged || controlConfigChanged) {
      logger("info", "Client or control config changed, refreshing Heimdall")
      await refreshHeimdall(controlConfig)
    } else {
      logger("info", "Client and control config unchanged, skipping Heimdall refresh")
    }

    currentClientConfigHash = newClientConfigHash
    currentControlConfigHash = newControlConfigHash
  } catch (error: any) {
    logger("error", `System refresh failed: ${error.message}`)
    throw error
  }
}

const main = async () => {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

    if (process.argv[2] === "setup") {
      await setup()
      process.exit(0)
    }

    logger("info", "Initializing Heimdall")

    await refreshSystem()

    setInterval(async () => await refreshSystem(), POLL_INTERVAL)

    logger("info", "Heimdall initialized successfully")
  } catch (error: any) {
    logger("error", `Initialization failed: ${error.message}`)
    console.log(error)
    process.exit(1)
  }
}

await main()
