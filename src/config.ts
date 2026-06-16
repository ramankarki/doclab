import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DlConfig, SourceConfig } from './types'
import { DEFAULT_CONFIG } from './types'

const DOCLAB_DIR = join(homedir(), '.doclab')
const CONFIG_PATH = join(DOCLAB_DIR, 'dlconfig.json')

export function ensureDoclabDir(): void {
  if (!existsSync(DOCLAB_DIR)) {
    mkdirSync(DOCLAB_DIR, { recursive: true })
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH
}

export function getDoclabDir(): string {
  return DOCLAB_DIR
}

export function loadConfig(): { config: DlConfig; errors: string[] } {
  const errors: string[] = []

  if (!existsSync(CONFIG_PATH)) {
    // First run — create empty config
    ensureDoclabDir()
    const empty = { ...DEFAULT_CONFIG }
    saveConfigRaw(empty)
    return {
      config: empty,
      errors: ['No config yet. Add sources with: doclab add <url>']
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch (e: any) {
    return {
      config: { ...DEFAULT_CONFIG },
      errors: [`dlconfig.json: Invalid JSON at line ${extractLineFromError(e)}.`]
    }
  }

  const obj = raw as Record<string, unknown>
  const config: DlConfig = { ...DEFAULT_CONFIG }

  // sources
  if (obj.sources !== undefined) {
    if (!Array.isArray(obj.sources)) {
      errors.push("dlconfig.json: 'sources' must be an array.")
    } else {
      const sources: SourceConfig[] = []
      const seenNames = new Set<string>()
      for (let i = 0; i < obj.sources.length; i++) {
        const src = obj.sources[i] as Record<string, unknown>
        const name = String(src.name ?? `source-${i}`)
        const url = String(src.url ?? '')

        if (!src.url || url.trim() === '') {
          errors.push(
            `dlconfig.json: Source '${name}' missing 'url'. Fix: Add a 'url' field or remove the source with 'doclab remove ${name}'.`
          )
          continue
        }

        if (!isValidUrl(url)) {
          errors.push(`dlconfig.json: '${url}' is not a valid URL.`)
          continue
        }

        if (seenNames.has(name)) {
          errors.push(`dlconfig.json: Duplicate source name '${name}'.`)
          continue
        }

        seenNames.add(name)
        sources.push({ name, url })
      }
      config.sources = sources
    }
  }

  // embedding
  if (obj.embedding !== undefined) {
    const emb = obj.embedding as Record<string, unknown>
    const provider = emb.provider as string
    if (provider && !['ollama', 'openai', 'voyage'].includes(provider)) {
      errors.push(
        `dlconfig.json: Unknown embedding provider '${provider}'. Valid: ollama, openai, voyage.`
      )
    } else {
      config.embedding = {
        ...DEFAULT_CONFIG.embedding,
        ...(emb as any)
      }
    }
  }

  // rebuildInterval
  if (obj.rebuildInterval !== undefined) {
    const ri = String(obj.rebuildInterval)
    if (!isValidInterval(ri)) {
      errors.push(`dlconfig.json: Invalid rebuildInterval '${ri}'. Using default: 24h.`)
    } else {
      config.rebuildInterval = ri
    }
  }

  // maxChunksPerQuery
  if (obj.maxChunksPerQuery !== undefined) {
    const n = Number(obj.maxChunksPerQuery)
    if (isNaN(n) || n < 1) {
      errors.push(`dlconfig.json: Invalid maxChunksPerQuery. Using default: 10.`)
    } else {
      config.maxChunksPerQuery = n
    }
  }

  // idleTimeout
  if (obj.idleTimeout !== undefined) {
    const it = String(obj.idleTimeout)
    if (!isValidInterval(it)) {
      errors.push(`dlconfig.json: Invalid idleTimeout '${it}'. Using default: 30m.`)
    } else {
      config.idleTimeout = it
    }
  }

  // port
  if (obj.port !== undefined) {
    config.port = Number(obj.port)
  }

  return { config, errors }
}

export function saveConfig(config: DlConfig): void {
  ensureDoclabDir()
  saveConfigRaw(config)
}

function saveConfigRaw(config: DlConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function addSourceToConfig(source: { name: string; url: string }): DlConfig {
  const { config, errors } = loadConfig()
  if (errors.length > 0 && errors.some((e) => e.includes('Invalid JSON'))) {
    throw new Error(errors[0])
  }

  // Remove existing source with same name
  config.sources = config.sources.filter((s) => s.name !== source.name)
  config.sources.push(source)
  saveConfig(config)
  return config
}

export function removeSourceFromConfig(name: string): DlConfig {
  const { config, errors } = loadConfig()
  if (errors.length > 0 && errors.some((e) => e.includes('Invalid JSON'))) {
    throw new Error(errors[0])
  }

  config.sources = config.sources.filter((s) => s.name !== name)
  saveConfig(config)
  return config
}

// ─── Helpers ───

export function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function isValidInterval(s: string): boolean {
  return /^\d+(h|m|d)$/.test(s) || s === 'never'
}

function extractLineFromError(e: Error): string {
  const msg = e.message
  const match = msg.match(/line (\d+)/i)
  return match ? match[1] : '?'
}

export function parseInterval(interval: string): number {
  if (interval === 'never') return 0
  const match = interval.match(/^(\d+)(h|m|d)$/)
  if (!match) return 24 * 60 * 60 * 1000 // default 24h
  const value = parseInt(match[1])
  const unit = match[2]
  switch (unit) {
    case 'h':
      return value * 60 * 60 * 1000
    case 'm':
      return value * 60 * 1000
    case 'd':
      return value * 24 * 60 * 60 * 1000
    default:
      return 24 * 60 * 60 * 1000
  }
}
