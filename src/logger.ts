import fs from "fs"
import path from 'path'
import { LOG_DIR } from "./config.js"

const HEIMDALL_LOG_PATH = path.join(LOG_DIR, 'heimdall.log')

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

type Log = {
  timestamp: string
  level: LogLevel
  message: string
  data?: any
}

export const logger = (level: LogLevel, message: string, data?: any) => {
  const log: Log = { timestamp: new Date().toISOString(), level, message }
  if (data) log.data = data

  try {
    fs.appendFileSync(HEIMDALL_LOG_PATH, JSON.stringify(log) + '\n')
  } catch (error: any) {
    console.error('Error writing to log file:', { error: error.message })
  }
}
