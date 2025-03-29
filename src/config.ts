import path from 'path'
import os from 'os'

export const CONFIG_DIR = process.env.CONFIG_DIR || path.join(os.homedir(), '.heimdall')
export const LOG_PATH = path.join(CONFIG_DIR, 'heimdall.log')
