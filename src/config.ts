import path from 'path'
import os from 'os'

export const CONFIG_DIR = process.env.CONFIG_DIR || path.join(os.homedir(), '.heimdall')
export const LOG_DIR = path.join(CONFIG_DIR, 'logs')
export const POLL_INTERVAL = 10000 // 10 seconds
export const TOOL_EXECUTION_TIMEOUT = 30000 // 30 seconds
