/**
 * error-debugger.js
 * Intelligent error capture, classification, and suggestion engine.
 * Runs inside the page (injected by content-script.js) and reports
 * errors back to the extension via chrome.runtime.sendMessage.
 */

import { KEYS, get, set } from './storage-sync.js'

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/**
 * @typedef {'runtime'|'syntax'|'network'|'promise'|'csp'|'script'} ErrorType
 * @typedef {'critical'|'error'|'warning'|'info'} ErrorSeverity
 *
 * @typedef {Object} DebugError
 * @property {string}        id
 * @property {number}        timestamp
 * @property {ErrorType}     type
 * @property {string}        message
 * @property {string}        stack
 * @property {string}        source
 * @property {number}        line
 * @property {number}        column
 * @property {ErrorContext}  context
 * @property {string|null}   suggestion
 * @property {ErrorSeverity} severity
 * @property {boolean}       resolved
 * @property {number}        count   – how many times this identical error occurred
 */

/**
 * @typedef {Object} ErrorContext
 * @property {string}      url
 * @property {string}      userAgent
 * @property {string|null} scriptId
 * @property {string|null} scriptName
 */

// ---------------------------------------------------------------------------
// Suggestion patterns
// ---------------------------------------------------------------------------

const PATTERNS = [
  {
    re: /Cannot read propert(?:y|ies)(?: ['"]?(\w+)['"]?)? of (undefined|null)|Cannot read propert(?:y|ies) of (undefined|null)/i,
    suggestion: (m) => {
      const nullish = m[2] || m[3] || 'undefined/null'
      const prop = m[1] ? `.${m[1]}` : ''
      return (
        `The object is ${nullish} when you try to access "${prop || 'the property'}". ` +
        `Add a null check or use optional chaining: \`obj?${prop || '.prop'}\`.`
      )
    },
    type: 'runtime',
    severity: 'error',
  },
  {
    re: /(\w+) is not defined/i,
    suggestion: (m) =>
      `"${m[1]}" has not been declared. Check the variable name, scope, ` +
      'whether the required script/library is loaded, and import statements.',
    type: 'runtime',
    severity: 'error',
  },
  {
    re: /SyntaxError/i,
    suggestion: () =>
      'A syntax error was detected. Check for missing brackets, parentheses, ' +
      'or commas near the indicated line.',
    type: 'syntax',
    severity: 'critical',
  },
  {
    re: /Failed to fetch|NetworkError|net::ERR_/i,
    suggestion: () =>
      'A network request failed. Verify the URL, your internet connection, and ' +
      'that the extension has the required host permissions. ' +
      'For cross-origin requests inside a user script use GM_xmlhttpRequest.',
    type: 'network',
    severity: 'error',
  },
  {
    re: /blocked by CORS policy|Access-Control-Allow-Origin/i,
    suggestion: () =>
      'The browser blocked a cross-origin request (CORS). In a user script ' +
      'use GM_xmlhttpRequest which routes through the background service worker ' +
      'and bypasses CORS. Alternatively add the target origin to host_permissions.',
    type: 'network',
    severity: 'error',
  },
  {
    re: /Content Security Policy|CSP/i,
    suggestion: () =>
      'The page\'s Content Security Policy blocked an action. ' +
      'Consider injecting via chrome.scripting.executeScript (world: MAIN) ' +
      'instead of inline script, or use GM_addStyle for styles.',
    type: 'csp',
    severity: 'warning',
  },
  {
    re: /QuotaExceededError|QUOTA_EXCEEDED_ERR/i,
    suggestion: () =>
      'Storage quota exceeded. Clear old data via the extension\'s Debug tab, ' +
      'or reduce the maximum error log retention period in Settings.',
    type: 'runtime',
    severity: 'warning',
  },
  {
    re: /Unhandled promise rejection/i,
    suggestion: () =>
      'A promise was rejected without a .catch() handler. Add error handling: ' +
      '`somePromise.catch(err => console.error(err))` or use try/await.',
    type: 'promise',
    severity: 'error',
  },
  {
    re: /Maximum call stack/i,
    suggestion: () =>
      'Infinite recursion detected. Check for a function that calls itself ' +
      'without a proper base case.',
    type: 'runtime',
    severity: 'critical',
  },
  {
    re: /is not a function/i,
    suggestion: (m) =>
      `Something expected to be a function is not. Check that the method ` +
      `exists and that the object it belongs to is properly initialised. ` +
      `Full message: "${m[0]}"`,
    type: 'runtime',
    severity: 'error',
  },
]

/**
 * Classify an error message and return type, severity, and suggestion.
 * @param {string} message
 * @returns {{type: ErrorType, severity: ErrorSeverity, suggestion: string|null}}
 */
function classify(message) {
  for (const p of PATTERNS) {
    const m = message.match(p.re)
    if (m) {
      return {
        type: p.type,
        severity: p.severity,
        suggestion: p.suggestion(m),
      }
    }
  }
  return { type: 'runtime', severity: 'error', suggestion: null }
}

// ---------------------------------------------------------------------------
// Deduplication fingerprint
// ---------------------------------------------------------------------------

/**
 * Create a stable fingerprint for grouping identical errors.
 * @param {string} message
 * @param {string} source
 * @param {number} line
 * @returns {string}
 */
function fingerprint(message, source, line) {
  return `${message}|${source}|${line}`
}

// ---------------------------------------------------------------------------
// Storage helpers (called from background service worker side)
// ---------------------------------------------------------------------------

async function loadErrors() {
  const result = await get(KEYS.ERROR_LOG)
  return result[KEYS.ERROR_LOG] || []
}

async function saveErrors(errors) {
  await set({ [KEYS.ERROR_LOG]: errors })
}

/**
 * Append (or increment count of) a DebugError in persistent storage.
 * Called from the background service worker when it receives a CAPTURE_ERROR message.
 * @param {Partial<DebugError>} rawError
 * @returns {Promise<DebugError>}
 */
async function appendError(rawError) {
  const errors = await loadErrors()

  const fp = fingerprint(rawError.message, rawError.source, rawError.line)
  const existing = errors.find((e) => !e.resolved && fingerprint(e.message, e.source, e.line) === fp)

  if (existing) {
    existing.count = (existing.count || 1) + 1
    existing.timestamp = rawError.timestamp || Date.now()
    await saveErrors(errors)
    return existing
  }

  const { type, severity, suggestion } = classify(rawError.message || '')

  /** @type {DebugError} */
  const entry = {
    id: rawError.id || generateId(),
    timestamp: rawError.timestamp || Date.now(),
    type: rawError.type || type,
    message: rawError.message || '',
    stack: rawError.stack || '',
    source: rawError.source || '',
    line: rawError.line || 0,
    column: rawError.column || 0,
    context: rawError.context || { url: '', userAgent: '' },
    suggestion: rawError.suggestion || suggestion,
    severity: rawError.severity || severity,
    resolved: false,
    count: 1,
  }

  errors.push(entry)

  // Enforce max entry cap
  const MAX = 500
  const trimmed = errors.length > MAX ? errors.slice(errors.length - MAX) : errors
  await saveErrors(trimmed)
  return entry
}

/**
 * Mark an error as resolved.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function resolveError(id) {
  const errors = await loadErrors()
  const err = errors.find((e) => e.id === id)
  if (!err) return false
  err.resolved = true
  await saveErrors(errors)
  return true
}

/**
 * Delete all resolved errors.
 * @returns {Promise<number>} number removed
 */
async function clearResolved() {
  const errors = await loadErrors()
  const active = errors.filter((e) => !e.resolved)
  await saveErrors(active)
  return errors.length - active.length
}

/**
 * Delete all errors.
 * @returns {Promise<void>}
 */
async function clearAll() {
  await saveErrors([])
}

// ---------------------------------------------------------------------------
// In-page capture (injected into the content script world)
// ---------------------------------------------------------------------------

/**
 * Install global error listeners inside the page and relay captured errors
 * to the background service worker. Call this from content-script.js.
 *
 * @param {Object} [options]
 * @param {boolean} [options.captureGlobalErrors=true]
 * @param {boolean} [options.capturePromiseRejections=true]
 * @param {boolean} [options.captureNetworkErrors=true]
 * @param {boolean} [options.captureCSPViolations=true]
 * @param {boolean} [options.captureConsoleErrors=true]
 * @param {number}  [options.throttleMs=100] min ms between reports (per type)
 * @returns {() => void} uninstall function
 */
function installCapture(options = {}) {
  const cfg = Object.assign(
    {
      captureGlobalErrors: true,
      capturePromiseRejections: true,
      captureNetworkErrors: true,
      captureCSPViolations: true,
      captureConsoleErrors: true,
      throttleMs: 100,
    },
    options
  )

  const lastSent = {}
  function throttled(key, fn) {
    const now = Date.now()
    if (now - (lastSent[key] || 0) < cfg.throttleMs) return
    lastSent[key] = now
    fn()
  }

  function report(payload) {
    try {
      chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', payload })
    } catch {
      /* extension context invalidated – ignore */
    }
  }

  const handlers = []

  // Global runtime errors
  if (cfg.captureGlobalErrors) {
    const handler = (event) => {
      throttled(event.message, () => {
        report({
          type: 'runtime',
          message: event.message || String(event.error),
          stack: (event.error && event.error.stack) || '',
          source: event.filename || location.href,
          line: event.lineno || 0,
          column: event.colno || 0,
          context: { url: location.href, userAgent: navigator.userAgent },
        })
      })
    }
    window.addEventListener('error', handler, { capture: true })
    handlers.push(() => window.removeEventListener('error', handler, { capture: true }))
  }

  // Unhandled promise rejections
  if (cfg.capturePromiseRejections) {
    const handler = (event) => {
      const reason = event.reason
      const message =
        reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection')
      throttled('promise:' + message, () => {
        report({
          type: 'promise',
          message,
          stack: (reason instanceof Error && reason.stack) || '',
          source: location.href,
          line: 0,
          column: 0,
          context: { url: location.href, userAgent: navigator.userAgent },
        })
      })
    }
    window.addEventListener('unhandledrejection', handler)
    handlers.push(() => window.removeEventListener('unhandledrejection', handler))
  }

  // CSP violations
  if (cfg.captureCSPViolations) {
    const handler = (event) => {
      throttled('csp:' + event.violatedDirective, () => {
        report({
          type: 'csp',
          message: `CSP violation: ${event.violatedDirective} — blocked URI: ${event.blockedURI}`,
          stack: '',
          source: event.sourceFile || location.href,
          line: event.lineNumber || 0,
          column: event.columnNumber || 0,
          context: { url: location.href, userAgent: navigator.userAgent },
          severity: 'warning',
        })
      })
    }
    document.addEventListener('securitypolicyviolation', handler)
    handlers.push(() => document.removeEventListener('securitypolicyviolation', handler))
  }

  // Network errors (fetch patch)
  if (cfg.captureNetworkErrors) {
    const origFetch = window.fetch
    window.fetch = async function (...args) {
      try {
        const res = await origFetch.apply(this, args)
        if (!res.ok) {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''
          throttled('net:' + res.status + url, () => {
            report({
              type: 'network',
              message: `Network error: ${res.status} ${res.statusText} — ${url}`,
              stack: '',
              source: url,
              line: 0,
              column: 0,
              context: { url: location.href, userAgent: navigator.userAgent },
              severity: 'warning',
            })
          })
        }
        return res
      } catch (err) {
        const url = typeof args[0] === 'string' ? args[0] : ''
        throttled('net:' + url, () => {
          report({
            type: 'network',
            message: err.message,
            stack: err.stack || '',
            source: url,
            line: 0,
            column: 0,
            context: { url: location.href, userAgent: navigator.userAgent },
          })
        })
        throw err
      }
    }
    handlers.push(() => { window.fetch = origFetch })
  }

  // console.error / console.warn intercept
  if (cfg.captureConsoleErrors) {
    const origError = console.error
    const origWarn = console.warn

    console.error = function (...args) {
      origError.apply(this, args)
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')
      throttled('console.error:' + message, () => {
        report({
          type: 'runtime',
          severity: 'error',
          message,
          stack: (args[0] instanceof Error && args[0].stack) || '',
          source: location.href,
          line: 0,
          column: 0,
          context: { url: location.href, userAgent: navigator.userAgent },
        })
      })
    }

    console.warn = function (...args) {
      origWarn.apply(this, args)
      const message = args.map((a) => String(a)).join(' ')
      throttled('console.warn:' + message, () => {
        report({
          type: 'runtime',
          severity: 'warning',
          message,
          stack: '',
          source: location.href,
          line: 0,
          column: 0,
          context: { url: location.href, userAgent: navigator.userAgent },
        })
      })
    }

    handlers.push(() => {
      console.error = origError
      console.warn = origWarn
    })
  }

  // Return uninstall function
  return function uninstall() {
    handlers.forEach((h) => h())
  }
}

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export {
  classify,
  fingerprint,
  loadErrors,
  saveErrors,
  appendError,
  resolveError,
  clearResolved,
  clearAll,
  installCapture,
}
