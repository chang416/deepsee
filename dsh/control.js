// Shared control plane for the DeepSee dsh plugin. This file deliberately uses
// only Node built-ins so the published plugin remains a zero-dependency Cordis
// bundle.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const AUTO_MODEL_ID = 'deepsee-auto'
export const CUSTOMIZE_MODEL_ID = 'deepsee-customize'

export const TASK_CATEGORIES = [
  'discovery',
  'documentation',
  'tests',
  'small-edit',
  'bug-fix',
  'ui-implementation',
  'visual-review',
  'refactor',
  'architecture',
  'security',
  'integration',
  'review',
]

// The free-first preset: Flash handles bounded, low-risk execution; Pro owns
// decisions whose blast radius or ambiguity benefits from deeper reasoning.
export const AUTO_ASSIGNMENTS = Object.freeze({
  discovery: 'flash',
  documentation: 'flash',
  tests: 'flash',
  'small-edit': 'flash',
  'bug-fix': 'flash',
  'ui-implementation': 'flash',
  'visual-review': 'pro',
  refactor: 'pro',
  architecture: 'pro',
  security: 'pro',
  integration: 'pro',
  review: 'pro',
})

export function configPath() {
  return process.env.DEEPSEE_CONFIG_PATH || join(homedir(), '.deepsee', 'config.json')
}

function cleanKeys(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : []
  return [...new Set(raw.map((key) => String(key).trim()).filter(Boolean))]
}

function lane(value, fallback) {
  return value === 'flash' || value === 'pro' ? value : fallback
}

export function normalizeControlSettings(raw = {}) {
  const route = raw?.routing?.customize ?? {}
  const visual = raw?.routing?.visualCheck ?? {}
  const custom = {}
  for (const category of TASK_CATEGORIES) {
    custom[category] = lane(route.assignments?.[category], AUTO_ASSIGNMENTS[category])
  }
  const keys = cleanKeys(raw?.providers?.['gemini-api']?.apiKeys)
  const legacyKey = String(raw?.providers?.['gemini-api']?.apiKey ?? '').trim()
  if (legacyKey && !keys.includes(legacyKey)) keys.unshift(legacyKey)
  const maxParallel = Number.isSafeInteger(route.maxParallel) ? Math.min(6, Math.max(1, route.maxParallel)) : 3
  return {
    keyCount: keys.length,
    customizeConfigured: route.configured === true,
    assignments: custom,
    maxParallel,
    flashModel: String(raw?.routing?.models?.flash ?? 'deepseek-v4-flash'),
    proModel: String(raw?.routing?.models?.pro ?? 'deepseek-v4-pro'),
    // Which live route each lane uses. Empty means "whatever the discovery
    // order finds first", the behavior before this was configurable.
    flashProvider: String(raw?.routing?.providers?.flash ?? ''),
    proProvider: String(raw?.routing?.providers?.pro ?? ''),
    // How hard that choice is. Locked means the lane runs on that route or
    // not at all: the point of choosing a free route is that nothing may
    // quietly promote the work to a paid one, so a lock fails loudly instead
    // of spending money the user did not agree to spend. Unlocked keeps the
    // rest of the chain behind the choice, which is the right default when
    // availability matters more than which subscription pays.
    flashLock: raw?.routing?.locks?.flash === true,
    proLock: raw?.routing?.locks?.pro === true,
    visualCheck: {
      enabled: visual.enabled !== false,
      milestones: visual.milestones !== false,
      final: visual.final !== false,
      maxRounds: Number.isSafeInteger(visual.maxRounds) ? Math.min(4, Math.max(1, visual.maxRounds)) : 2,
      previewUrl: typeof visual.previewUrl === 'string' ? visual.previewUrl.trim() : '',
      viewport: typeof visual.viewport === 'string' && visual.viewport.trim() ? visual.viewport.trim() : '1440x900',
    },
  }
}

export async function readControlFile(path = configPath()) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Cannot read DeepSee settings: ${error?.message ?? error}`)
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function updateControlFile(update, path = configPath()) {
  const raw = await readControlFile(path)
  if (Object.hasOwn(update, 'keysText')) {
    raw.providers ??= {}
    raw.providers['gemini-api'] ??= {}
    const keys = cleanKeys(update.keysText)
    if (keys.length === 0) {
      delete raw.providers['gemini-api'].apiKeys
      delete raw.providers['gemini-api'].apiKey
    } else {
      raw.providers['gemini-api'].apiKeys = keys
      // Avoid keeping a stale legacy key at a higher precedence.
      delete raw.providers['gemini-api'].apiKey
    }
  }
  raw.routing ??= {}
  raw.routing.customize ??= {}
  if (update.assignments !== undefined) {
    const assignments = {}
    for (const category of TASK_CATEGORIES) {
      assignments[category] = lane(update.assignments?.[category], AUTO_ASSIGNMENTS[category])
    }
    raw.routing.customize.assignments = assignments
    raw.routing.customize.configured = true
  }
  if (update.maxParallel !== undefined) {
    if (!Number.isSafeInteger(update.maxParallel) || update.maxParallel < 1 || update.maxParallel > 6) {
      throw new Error('maxParallel must be an integer from 1 to 6')
    }
    raw.routing.customize.maxParallel = update.maxParallel
  }
  if (update.lanes !== undefined) {
    if (!update.lanes || typeof update.lanes !== 'object' || Array.isArray(update.lanes)) {
      throw new Error('lanes must be an object')
    }
    raw.routing.providers ??= {}
    raw.routing.models ??= {}
    raw.routing.locks ??= {}
    for (const name of ['flash', 'pro']) {
      if (!Object.hasOwn(update.lanes, name)) continue
      const choice = update.lanes[name]
      // '' clears the choice and restores discovery order. Anything else must
      // name both halves: a provider alone cannot resolve to a model, and a
      // model alone is what the previous, unpinnable behavior already did.
      if (choice === '' || choice === null) {
        delete raw.routing.providers[name]
        delete raw.routing.models[name]
        delete raw.routing.locks[name]
        continue
      }
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
        throw new Error(`lanes.${name} must be an object or an empty string`)
      }
      const provider = String(choice.provider ?? '').trim()
      const model = String(choice.model ?? '').trim()
      if (!provider || !model) throw new Error(`lanes.${name} needs both provider and model`)
      if (Object.hasOwn(choice, 'lock') && typeof choice.lock !== 'boolean') {
        throw new Error(`lanes.${name}.lock must be boolean`)
      }
      raw.routing.providers[name] = provider
      raw.routing.models[name] = model
      if (choice.lock === true) raw.routing.locks[name] = true
      else delete raw.routing.locks[name]
    }
  }
  if (update.visualCheck !== undefined) {
    if (!update.visualCheck || typeof update.visualCheck !== 'object' || Array.isArray(update.visualCheck)) {
      throw new Error('visualCheck must be an object')
    }
    const previous = raw.routing.visualCheck ?? {}
    const next = { ...previous }
    for (const field of ['enabled', 'milestones', 'final']) {
      if (Object.hasOwn(update.visualCheck, field)) {
        if (typeof update.visualCheck[field] !== 'boolean') throw new Error(`visualCheck.${field} must be boolean`)
        next[field] = update.visualCheck[field]
      }
    }
    if (Object.hasOwn(update.visualCheck, 'maxRounds')) {
      if (
        !Number.isSafeInteger(update.visualCheck.maxRounds) ||
        update.visualCheck.maxRounds < 1 ||
        update.visualCheck.maxRounds > 4
      ) {
        throw new Error('visualCheck.maxRounds must be an integer from 1 to 4')
      }
      next.maxRounds = update.visualCheck.maxRounds
    }
    for (const field of ['previewUrl', 'viewport']) {
      if (Object.hasOwn(update.visualCheck, field)) {
        if (typeof update.visualCheck[field] !== 'string') throw new Error(`visualCheck.${field} must be a string`)
        next[field] = update.visualCheck[field].trim()
      }
    }
    raw.routing.visualCheck = next
  }
  await atomicWriteJson(path, raw)
  return normalizeControlSettings(raw)
}

export async function publicControlSettings(path = configPath()) {
  return normalizeControlSettings(await readControlFile(path))
}

export function chooseLane(task, category, mode, settings) {
  if (mode === 'customize') {
    return settings.assignments[category] ?? AUTO_ASSIGNMENTS[category] ?? 'pro'
  }
  if (TASK_CATEGORIES.includes(category)) return AUTO_ASSIGNMENTS[category]
  const text = String(task ?? '').toLowerCase()
  if (/security|auth|permission|migration|architecture|跨模組|架構|安全|權限|遷移/.test(text)) return 'pro'
  if (/refactor|integration|review|重構|整合|審查/.test(text)) return 'pro'
  return 'flash'
}

export function keyFingerprint(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 8)
}
