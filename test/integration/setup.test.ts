import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(os.tmpdir(), 'heimdall-test')

const originalConfig = {
  mcpServers: {
    "test-server": {
      command: 'node',
      args: [path.resolve(process.cwd(), 'test/test-server/index.js')]
    }
  }
}

const newControlsConfig = {
  authorizedMcpServers: {
    "test-server": {
      authorizedTools: ["tool1", "tool2"]
    }
  }
}

const createTempClientConfigFile = (content: any): string => {
  const configPath = path.join(os.tmpdir(), `test-config-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(content, null, 2))
  return configPath
}

const runHeimdallSetup = async (args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> => {
  return new Promise((resolve) => {
    const heimdallPath = path.resolve(process.cwd(), 'dist/index.js')
    const child = spawn('node', [heimdallPath, 'setup', ...args], { 
      env: {
        ...process.env,
        CONFIG_DIR
      }
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => stdout += data.toString())
    child.stderr.on('data', (data) => stderr += data.toString())
    child.on('close', (code) => resolve({ stdout, stderr, code: code || 0 }))
  })
}

const readJsonFile = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf-8'))

describe('Heimdall Setup Integration Tests', () => {
  const getConfigPath = () => path.join(process.env.CONFIG_DIR!, 'config.json')
  const getControlsPath = () => path.join(process.env.CONFIG_DIR!, 'controls.json')

  beforeEach(() => {
    process.env.CONFIG_DIR = CONFIG_DIR
    fs.mkdirSync(path.join(process.env.CONFIG_DIR, 'logs'), { recursive: true })
  })

  afterEach(() => {
    if (process.env.CONFIG_DIR) {
      fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true })
    }
  })

  describe('When running setup for the first time', () => {
    it('should copy config from client config path and create default heimdall config', async () => {
      const newConfig = {
        mcpServers: {
          heimdall: {
            command: 'npx',
            args: ['@shinzolabs/heimdall']
          }
        }
      }

      const newControls = {
        authorizedMcpServers: {
          "test-server": {
            authorizedTools: ["tool1", "tool2"]
          }
        }
      }

      const configPath = createTempClientConfigFile(originalConfig)
      const result = await runHeimdallSetup([configPath])
      expect(result.code).toBe(0)

      // Verify original config was copied to new location
      const copiedConfig = readJsonFile(getConfigPath())
      expect(copiedConfig).toEqual(originalConfig)

      // Verify original config was replaced with heimdall config
      const updatedOriginalConfig = readJsonFile(configPath)
      expect(updatedOriginalConfig).toEqual(newConfig)

      // Verify controls.json was created
      const controls = readJsonFile(getControlsPath())
      expect(controls).toEqual(newControls)
    })

    it('should use custom command when second argument is provided', async () => {
      const customCommand = path.resolve(process.cwd(), 'dist/index.js')
      const newConfig = {
        mcpServers: {
          heimdall: {
            command: 'node',
            args: [customCommand]
          }
        }
      }

      const configPath = createTempClientConfigFile(originalConfig)
      const result = await runHeimdallSetup([configPath, customCommand])
      expect(result.code).toBe(0)

      // Verify new config uses custom command
      const updatedOriginalConfig = readJsonFile(configPath)
      expect(updatedOriginalConfig).toEqual(newConfig)
    })

    it('should throw an error if the source config file is not found', async () => {
      const configPath = createTempClientConfigFile(originalConfig)

      const result = await runHeimdallSetup([configPath + '/nonexistent'])
      expect(result.code).toBe(1)
    })

    it('should throw an error if the heimdall executable is not found', async () => {
      const configPath = createTempClientConfigFile(originalConfig)

      const result = await runHeimdallSetup([configPath, 'nonexistent'])
      expect(result.code).toBe(1)
    })
  })

  describe('When running setup with existing files', () => {
    it('should not modify existing config.json but create controls.json if missing', async () => {
      fs.writeFileSync(getConfigPath(), JSON.stringify(originalConfig, null, 2))

      const result = await runHeimdallSetup()
      expect(result.code).toBe(0)

      // Verify config.json was not modified
      const config = readJsonFile(getConfigPath())
      expect(config).toEqual(originalConfig)

      const controls = readJsonFile(getControlsPath())
      expect(controls).toEqual(newControlsConfig)
    })

    it('should not modify existing controls.json', async () => {
      const existingControls = {
        authorizedMcpServers: {
          "test-server": {
            authorizedTools: ['tool1']
          }
        }
      }

      fs.writeFileSync(getControlsPath(), JSON.stringify(existingControls, null, 2))

      const result = await runHeimdallSetup()
      expect(result.code).toBe(0)

      // Verify controls.json was not modified
      const controls = readJsonFile(getControlsPath())
      expect(controls).toEqual(existingControls)
    })
  })
}) 