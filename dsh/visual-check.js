import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 })
const MIN_VIEWPORT = Object.freeze({ width: 320, height: 240 })
const MAX_VIEWPORT = Object.freeze({ width: 3840, height: 2160 })
const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024

const UNSAFE_BROWSER_FLAGS = [
  /^--no-sandbox(?:=|$)/,
  /^--disable-web-security(?:=|$)/,
  /^--allow-running-insecure-content(?:=|$)/,
  /^--remote-debugging-/,
]

/**
 * Preview URLs are intentionally restricted to local development servers.
 * This helper does not perform DNS resolution; callers must still treat the
 * page as untrusted content and keep browser capabilities disabled.
 */
export function isAllowedPreviewUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false

  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false

  const hostname = parsed.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname === '[::1]') return true

  const octets = hostname.split('.')
  if (octets.length !== 4 || !octets.every((octet) => /^\d+$/.test(octet))) return false
  const numbers = octets.map((octet) => Number(octet))
  return numbers.every((octet) => octet >= 0 && octet <= 255) && numbers[0] === 127
}

function assertViewportDimension(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`viewport ${name} must be an integer between ${minimum} and ${maximum}`)
  }
}

/** Parse a WxH string or a { width, height } object into a bounded viewport. */
export function parseViewport(value) {
  if (value === undefined || value === null || value === '') {
    return { ...DEFAULT_VIEWPORT }
  }

  let width
  let height
  if (typeof value === 'string') {
    const match = /^(\d+)x(\d+)$/.exec(value.trim())
    if (!match) throw new TypeError('viewport must be formatted as WIDTHxHEIGHT')
    width = Number(match[1])
    height = Number(match[2])
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    width = value.width
    height = value.height
  } else {
    throw new TypeError('viewport must be formatted as WIDTHxHEIGHT or an object')
  }

  assertViewportDimension('width', width, MIN_VIEWPORT.width, MAX_VIEWPORT.width)
  assertViewportDimension('height', height, MIN_VIEWPORT.height, MAX_VIEWPORT.height)
  return { width, height }
}

function canUse(path, exists) {
  try {
    return Boolean(exists(path))
  } catch {
    return false
  }
}

function macCandidates(env) {
  const roots = ['/Applications']
  if (typeof env.HOME === 'string' && env.HOME.trim() !== '') {
    roots.push(join(env.HOME, 'Applications'))
  }
  return roots.flatMap((root) => [
    join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
  ])
}

function linuxCandidates() {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/snap/bin/chromium',
  ]
}

function windowsCandidates(env) {
  const roots = [
    env.ProgramW6432,
    env.PROGRAMW6432,
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.LOCALAPPDATA,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter((root, index, all) => typeof root === 'string' && root !== '' && all.indexOf(root) === index)

  return roots.flatMap((root) => [
    join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(root, 'Chromium', 'Application', 'chrome.exe'),
    join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ])
}

/** Find a local Chrome-family executable without invoking a shell or PATH lookup. */
export function findBrowserExecutable(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? ((candidate) => existsSync(candidate))
  const override = typeof env.DEEPSEE_BROWSER_PATH === 'string' ? env.DEEPSEE_BROWSER_PATH.trim() : ''
  if (override && canUse(override, exists)) return override

  let candidates
  if (platform === 'darwin') candidates = macCandidates(env)
  else if (platform === 'win32') candidates = windowsCandidates(env)
  else if (platform === 'linux') candidates = linuxCandidates()
  else candidates = []

  return candidates.find((candidate) => canUse(candidate, exists)) ?? null
}

function abortError(message) {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function reasonForSignal(signal, fallback) {
  if (signal?.reason instanceof Error) return signal.reason
  if (signal?.reason) return new Error(String(signal.reason))
  return abortError(fallback)
}

function delayWithSignal(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      rejectPromise(reasonForSignal(signal, 'browser capture cancelled'))
    }
    function finish() {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
}

/** Spawn Chrome with an argument vector; no shell is involved. */
export function runBrowser({ browserPath, args, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let abortedReason
    let stderr = ''
    let child
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      abortedReason = reasonForSignal(signal, 'browser capture cancelled')
      if (child && !settled) child.kill('SIGTERM')
    }

    try {
      child = spawn(browserPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (error) {
      finish(rejectPromise, error)
      return
    }

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => finish(rejectPromise, error))
    child.once('close', (code, signalName) => {
      if (abortedReason) {
        finish(rejectPromise, abortedReason)
        return
      }
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 500)
        finish(rejectPromise, new Error(`browser exited with code ${code ?? 'null'}${detail ? `: ${detail}` : ''}`))
        return
      }
      finish(resolvePromise, { code, signal: signalName })
    })

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
}

function browserArgs(outputPath, viewport, profilePath, url) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1000',
    `--window-size=${viewport.width},${viewport.height}`,
    `--user-data-dir=${profilePath}`,
    `--screenshot=${outputPath}`,
    url,
  ]
  if (args.some((argument) => UNSAFE_BROWSER_FLAGS.some((pattern) => pattern.test(argument)))) {
    throw new Error('unsafe browser flag')
  }
  return args
}

function isPng(header) {
  return (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  )
}

function isJpeg(header) {
  return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
}

function isWebp(header) {
  return header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
}

async function validateScreenshot(outputPath) {
  let details = await stat(outputPath)
  if (!details.isFile()) throw new Error('browser screenshot output is not a regular file')
  if (details.size <= 0) throw new Error('browser screenshot output is empty')
  if (details.size > MAX_SCREENSHOT_BYTES) throw new Error('browser screenshot output exceeds 25 MiB')

  const handle = await open(outputPath, 'r')
  const header = Buffer.alloc(12)
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < 3 || (!isPng(header) && !isJpeg(header) && !isWebp(header))) {
      throw new Error('browser screenshot output is not PNG, JPEG, or WebP')
    }
  } finally {
    await handle.close()
  }

  details = await stat(outputPath)
  if (details.size <= 0) throw new Error('browser screenshot output is empty')
  if (details.size > MAX_SCREENSHOT_BYTES) throw new Error('browser screenshot output exceeds 25 MiB')
}

async function waitForScreenshot(outputPath, signal) {
  let previousSize = -1
  while (true) {
    if (signal?.aborted) throw reasonForSignal(signal, 'browser capture cancelled')
    try {
      const details = await stat(outputPath)
      if (!details.isFile()) throw new Error('browser screenshot output is not a regular file')
      if (details.size > MAX_SCREENSHOT_BYTES) throw new Error('browser screenshot output exceeds 25 MiB')
      if (details.size > 0 && details.size === previousSize) {
        try {
          await validateScreenshot(outputPath)
          return
        } catch (error) {
          if (/not a regular file|exceeds 25 MiB/.test(String(error?.message ?? error))) throw error
        }
      }
      previousSize = details.size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      previousSize = -1
    }
    await delayWithSignal(50, signal)
  }
}

function normalizeTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('timeoutMs must be a positive number')
  return Math.floor(value)
}

/**
 * Capture a local preview using a disposable Chrome profile.
 * `runBrowser` may be injected in tests; it receives browserPath, args,
 * outputPath, profilePath, url, viewport, signal, and timeoutMs.
 */
export async function capturePreviewScreenshot(options = {}) {
  const rawUrl = options.url
  if (!isAllowedPreviewUrl(rawUrl)) {
    throw new TypeError('preview URL must be an http(s) localhost or loopback URL without credentials')
  }
  const url = rawUrl.trim()
  const viewport = parseViewport(options.viewport)
  if (typeof options.outputPath !== 'string' || options.outputPath.trim() === '') {
    throw new TypeError('outputPath must be a non-empty string')
  }
  const outputPath = resolve(options.outputPath)
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const browser =
    typeof options.browserPath === 'string' && options.browserPath.trim() !== ''
      ? options.browserPath.trim()
      : findBrowserExecutable()
  if (!browser) throw new Error('no Chrome, Chromium, or Edge executable was found')

  await mkdir(dirname(outputPath), { recursive: true })
  const profilePath = await mkdtemp(join(tmpdir(), 'deepsee-visual-check-'))
  const operationController = new AbortController()
  const browserController = new AbortController()
  const screenshotController = new AbortController()
  const timeoutReason = abortError(`browser capture timed out after ${timeoutMs}ms`)
  const captureCompleteReason = abortError('browser screenshot capture complete')
  let timeoutHandle
  let onCallerAbort
  let onOperationAbort
  let result
  let failure

  try {
    onCallerAbort = () => operationController.abort(reasonForSignal(options.signal, 'browser capture cancelled'))
    if (options.signal) {
      if (options.signal.aborted) onCallerAbort()
      else options.signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    onOperationAbort = () => {
      const reason = reasonForSignal(operationController.signal, 'browser capture cancelled')
      browserController.abort(reason)
      screenshotController.abort(reason)
    }
    operationController.signal.addEventListener('abort', onOperationAbort, { once: true })
    timeoutHandle = setTimeout(() => operationController.abort(timeoutReason), timeoutMs)
    if (operationController.signal.aborted) {
      throw reasonForSignal(operationController.signal, 'browser capture cancelled')
    }

    const args = browserArgs(outputPath, viewport, profilePath, url)
    const runner = options.runBrowser ?? runBrowser
    const browserOutcome = Promise.resolve()
      .then(() =>
        runner({
          browserPath: browser,
          args,
          outputPath,
          profilePath,
          url,
          viewport,
          signal: browserController.signal,
          timeoutMs,
        }),
      )
      .then(
        (value) => ({ kind: 'browser', value }),
        (error) => ({ kind: 'browser-error', error }),
      )
    const screenshotOutcome = waitForScreenshot(outputPath, screenshotController.signal).then(
      () => ({ kind: 'screenshot' }),
      (error) => ({ kind: 'screenshot-error', error }),
    )
    const outcome = await Promise.race([browserOutcome, screenshotOutcome])
    if (outcome.kind === 'browser-error' || outcome.kind === 'screenshot-error') throw outcome.error
    if (outcome.kind === 'screenshot') {
      browserController.abort(captureCompleteReason)
      await browserOutcome
    } else {
      screenshotController.abort(captureCompleteReason)
    }
    if (operationController.signal.aborted) {
      throw reasonForSignal(operationController.signal, 'browser capture cancelled')
    }
    await validateScreenshot(outputPath)
    result = { url, path: outputPath, viewport, browser }
  } catch (error) {
    failure = error
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (options.signal && onCallerAbort) options.signal.removeEventListener('abort', onCallerAbort)
    if (onOperationAbort) operationController.signal.removeEventListener('abort', onOperationAbort)
    browserController.abort(reasonForSignal(operationController.signal, 'browser capture cleanup'))
    screenshotController.abort(reasonForSignal(operationController.signal, 'browser capture cleanup'))
    try {
      await rm(profilePath, { recursive: true, force: true })
    } catch (cleanupError) {
      if (!failure) failure = cleanupError
    }
  }

  if (failure) throw failure
  return result
}
