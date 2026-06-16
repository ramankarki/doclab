import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  loadConfig,
  saveConfig,
  addSourceToConfig,
  removeSourceFromConfig,
  getConfigPath
} from '../src/config'
import { DEFAULT_CONFIG, type DlConfig } from '../src/types'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CONFIG_PATH = getConfigPath()
let originalConfig: string | null = null

describe('config', () => {
  beforeAll(() => {
    // Backup real config if it exists
    if (existsSync(CONFIG_PATH)) {
      originalConfig = readFileSync(CONFIG_PATH, 'utf-8')
    }
  })

  afterAll(() => {
    // Restore original config
    if (originalConfig !== null) {
      writeFileSync(CONFIG_PATH, originalConfig, 'utf-8')
    } else {
      // Remove if it didn't exist before
      try {
        const { unlinkSync } = require('node:fs')
        unlinkSync(CONFIG_PATH)
      } catch {}
    }
  })

  test('loadConfig returns valid config object', () => {
    const { config, errors } = loadConfig()
    expect(config).toBeDefined()
    expect(config.sources).toBeDefined()
    expect(config.embedding.provider).toBe('ollama')
    expect(config.maxChunksPerQuery).toBeGreaterThan(0)
  })

  test('loadConfig validates sources array', () => {
    const { config } = loadConfig()
    expect(Array.isArray(config.sources)).toBe(true)
  })

  test('DEFAULT_CONFIG has correct structure', () => {
    expect(DEFAULT_CONFIG.embedding.provider).toBe('ollama')
    expect(DEFAULT_CONFIG.embedding.model).toBe('nomic-embed-text')
    expect(DEFAULT_CONFIG.rebuildInterval).toBe('24h')
    expect(DEFAULT_CONFIG.maxChunksPerQuery).toBe(10)
    expect(DEFAULT_CONFIG.idleTimeout).toBe('30m')
  })

  test('config persistence round-trips', () => {
    const config = { ...DEFAULT_CONFIG }
    config.sources = [{ name: 'test-source', url: 'https://example.com/docs' }]
    saveConfig(config)

    const { config: loaded } = loadConfig()
    expect(loaded.sources.length).toBeGreaterThanOrEqual(1)
    expect(loaded.sources.some((s) => s.name === 'test-source')).toBe(true)
  })

  test('addSourceToConfig adds a source', () => {
    const config = addSourceToConfig({
      name: 'another-test',
      url: 'https://another.example.com'
    })
    expect(config.sources.some((s) => s.name === 'another-test')).toBe(true)
  })

  test('addSourceToConfig updates existing source', () => {
    addSourceToConfig({
      name: 'another-test',
      url: 'https://updated.example.com'
    })
    const { config } = loadConfig()
    const src = config.sources.find((s) => s.name === 'another-test')
    expect(src).toBeDefined()
    expect(src!.url).toBe('https://updated.example.com')
  })

  test('removeSourceFromConfig removes a source', () => {
    removeSourceFromConfig('another-test')
    const { config } = loadConfig()
    expect(config.sources.some((s) => s.name === 'another-test')).toBe(false)
  })
})
