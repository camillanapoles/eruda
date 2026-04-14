/**
 * script-manager.js
 * Full lifecycle management for Greasemonkey/Tampermonkey-compatible user scripts.
 * Handles parsing, storage, URL matching, and execution (with GM_* API bridge).
 */

import { KEYS, get, set } from './storage-sync.js'

/**
 * @typedef {Object} UserScriptMeta
 * @property {string}   name
 * @property {string}   namespace
 * @property {string}   version
 * @property {string}   description
 * @property {string}   author
 * @property {string[]} match
 * @property {string[]} exclude
 * @property {string[]} include
 * @property {string[]} grant
 * @property {string[]} require
 * @property {'document-start'|'document-end'|'document-idle'} runAt
 */

/**
 * @typedef {Object} UserScript
 * @property {string}          id
 * @property {UserScriptMeta}  metadata
 * @property {string}          code
 * @property {boolean}         enabled
 * @property {string|null}     installUrl
 * @property {number}          createdAt
 * @property {number}          updatedAt
 */

// ---------------------------------------------------------------------------
// UUID helper (same as snippet-manager, avoids cross-module import)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Metadata parser
// ---------------------------------------------------------------------------

/**
 * Extract `// ==UserScript== ... // ==/UserScript==` metadata block from
 * a user script string. Returns a normalized metadata object.
 * @param {string} code
 * @returns {UserScriptMeta}
 */
function parseMetadata(code) {
  const meta = {
    name: 'Untitled Script',
    namespace: '',
    version: '1.0.0',
    description: '',
    author: '',
    match: [],
    exclude: [],
    include: [],
    grant: [],
    require: [],
    runAt: 'document-idle',
  }

  const blockMatch = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/)
  if (!blockMatch) return meta

  const block = blockMatch[1]
  const lineRe = /\/\/\s*@(\S+)\s+(.*)/g
  let m
  while ((m = lineRe.exec(block)) !== null) {
    const key = m[1].toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const value = m[2].trim()

    switch (key) {
      case 'name':
      case 'namespace':
      case 'version':
      case 'description':
      case 'author':
        meta[key] = value
        break
      case 'match':
      case 'exclude':
      case 'include':
      case 'grant':
      case 'require':
        meta[key].push(value)
        break
      case 'runAt':
        if (['document-start', 'document-end', 'document-idle'].includes(value)) {
          meta.runAt = value
        }
        break
      default:
        break
    }
  }

  return meta
}

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

/**
 * Determine whether `url` matches a single Chrome match-pattern or glob.
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function urlMatchesPattern(url, pattern) {
  if (pattern === '<all_urls>' || pattern === '*') return true

  try {
    // Convert match-pattern / glob to a RegExp.
    // Escape all regex specials except * which becomes .*
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(url)
  } catch {
    return false
  }
}

/**
 * Determine whether a user script should run on the given URL, respecting
 * @match / @include patterns and @exclude patterns.
 * @param {UserScript} script
 * @param {string} url
 * @returns {boolean}
 */
function shouldRunOn(script, url) {
  if (!script.enabled) return false

  const { match, include, exclude } = script.metadata

  // Check exclusions first
  if (exclude.some((p) => urlMatchesPattern(url, p))) return false

  // Must match at least one @match or @include pattern
  const patterns = [...match, ...include]
  if (patterns.length === 0) return false
  return patterns.some((p) => urlMatchesPattern(url, p))
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getAll() {
  const result = await get(KEYS.USER_SCRIPTS)
  return result[KEYS.USER_SCRIPTS] || []
}

async function saveAll(scripts) {
  await set({ [KEYS.USER_SCRIPTS]: scripts })
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Install / create a new user script from raw source code.
 * @param {string} code
 * @param {string|null} installUrl
 * @returns {Promise<UserScript>}
 */
async function install(code, installUrl = null) {
  const metadata = parseMetadata(code)

  /** @type {UserScript} */
  const script = {
    id: generateId(),
    metadata,
    code,
    enabled: true,
    installUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const scripts = await getAll()
  scripts.push(script)
  await saveAll(scripts)
  return script
}

/**
 * Install a user script from a remote URL. Fetches the raw source and delegates
 * to `install`. Should only be called from the background service worker where
 * CORS restrictions are less likely to apply.
 * @param {string} url
 * @returns {Promise<UserScript>}
 */
async function installFromUrl(url) {
  let code
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    code = await resp.text()
  } catch (err) {
    throw new Error(`Failed to fetch script from ${url}: ${err.message}`)
  }
  return install(code, url)
}

/**
 * Update an existing script's code and/or metadata.
 * @param {string} id
 * @param {Partial<UserScript>} updates  May include `code` and/or `metadata`.
 * @returns {Promise<UserScript|null>}
 */
async function update(id, updates) {
  const scripts = await getAll()
  const idx = scripts.findIndex((s) => s.id === id)
  if (idx === -1) return null

  if (updates.code && !updates.metadata) {
    updates.metadata = parseMetadata(updates.code)
  }

  scripts[idx] = Object.assign({}, scripts[idx], updates, {
    id,
    updatedAt: Date.now(),
  })

  await saveAll(scripts)
  return scripts[idx]
}

/**
 * Toggle the enabled state of a script.
 * @param {string} id
 * @returns {Promise<UserScript|null>}
 */
async function toggle(id) {
  const scripts = await getAll()
  const script = scripts.find((s) => s.id === id)
  if (!script) return null
  return update(id, { enabled: !script.enabled })
}

/**
 * Uninstall (delete) a script by id.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function uninstall(id) {
  const scripts = await getAll()
  const next = scripts.filter((s) => s.id !== id)
  if (next.length === scripts.length) return false
  await saveAll(next)
  return true
}

// ---------------------------------------------------------------------------
// Execution — called from the content script via message passing
// ---------------------------------------------------------------------------

/**
 * Build a self-contained IIFE that wraps the user code with a minimal
 * GM_* API shim. The shim communicates with the background via
 * chrome.runtime.sendMessage for privileged operations.
 *
 * @param {UserScript} script
 * @returns {string}  The source string to be executed via chrome.scripting.
 */
function buildExecutable(script) {
  const { grant } = script.metadata

  // GM_* shim — only include the APIs the script declared via @grant
  const shimParts = []

  if (grant.includes('GM_log')) {
    shimParts.push(`
      function GM_log(...args) {
        console.log('[UserScript:${script.metadata.name}]', ...args);
      }
    `)
  }

  if (grant.includes('GM_addStyle')) {
    shimParts.push(`
      function GM_addStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return style;
      }
    `)
  }

  if (grant.includes('GM_setClipboard')) {
    shimParts.push(`
      function GM_setClipboard(text) {
        navigator.clipboard && navigator.clipboard.writeText(text);
      }
    `)
  }

  // GM_getValue / GM_setValue — stored in chrome.storage via background message
  if (grant.includes('GM_getValue') || grant.includes('GM_setValue')) {
    shimParts.push(`
      function GM_getValue(key, defaultValue) {
        // Synchronous shim: reads from localStorage fallback.
        try {
          const raw = localStorage.getItem('__gm_${script.id}_' + key);
          return raw !== null ? JSON.parse(raw) : defaultValue;
        } catch { return defaultValue; }
      }
      function GM_setValue(key, value) {
        try {
          localStorage.setItem('__gm_${script.id}_' + key, JSON.stringify(value));
        } catch { /* quota exceeded */ }
        // Also persist to chrome.storage via background.
        chrome.runtime.sendMessage({
          type: 'GM_setValue',
          scriptId: '${script.id}',
          key,
          value
        });
      }
    `)
  }

  if (grant.includes('GM_xmlhttpRequest')) {
    shimParts.push(`
      function GM_xmlhttpRequest(details) {
        chrome.runtime.sendMessage(
          { type: 'GM_xmlhttpRequest', scriptId: '${script.id}', details },
          (response) => {
            if (response && response.error && details.onerror) {
              details.onerror(response);
            } else if (response && details.onload) {
              details.onload(response);
            }
          }
        );
      }
    `)
  }

  if (grant.includes('GM_notification')) {
    shimParts.push(`
      function GM_notification(details) {
        chrome.runtime.sendMessage({
          type: 'GM_notification',
          scriptId: '${script.id}',
          details: typeof details === 'string' ? { text: details } : details
        });
      }
    `)
  }

  const unsafeWindowShim = grant.includes('unsafeWindow')
    ? 'var unsafeWindow = window;'
    : ''

  return `
    (function() {
      'use strict';
      ${unsafeWindowShim}
      ${shimParts.join('\n')}
      try {
        ${script.code}
      } catch (err) {
        console.error('[UserScript Error:${script.metadata.name}]', err);
        chrome.runtime.sendMessage({
          type: 'SCRIPT_ERROR',
          scriptId: '${script.id}',
          scriptName: '${script.metadata.name.replace(/'/g, "\\'")}',
          error: { message: err.message, stack: err.stack }
        });
      }
    })();
  `
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

/**
 * Export all user scripts as a JSON string.
 * @returns {Promise<string>}
 */
async function exportScripts() {
  const scripts = await getAll()
  return JSON.stringify({ version: 1, userScripts: scripts }, null, 2)
}

/**
 * Import scripts from a JSON string. Skips duplicates by id.
 * @param {string} jsonString
 * @returns {Promise<number>} number of newly imported scripts
 */
async function importScripts(jsonString) {
  let data
  try {
    data = JSON.parse(jsonString)
  } catch {
    throw new Error('Invalid JSON')
  }

  const incoming = Array.isArray(data) ? data : (data.userScripts || [])
  const existing = await getAll()
  const existingIds = new Set(existing.map((s) => s.id))
  let added = 0

  const merged = [...existing]
  incoming.forEach((s) => {
    if (existingIds.has(s.id)) return
    merged.push(
      Object.assign({}, s, {
        id: s.id || generateId(),
        updatedAt: Date.now(),
      })
    )
    added++
  })

  await saveAll(merged)
  return added
}

export {
  parseMetadata,
  urlMatchesPattern,
  shouldRunOn,
  getAll,
  install,
  installFromUrl,
  update,
  toggle,
  uninstall,
  buildExecutable,
  exportScripts,
  importScripts,
}
