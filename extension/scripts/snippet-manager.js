/**
 * snippet-manager.js
 * Full CRUD lifecycle for user-defined snippets stored in chrome.storage.local.
 * Snippets can be executed in the active tab via chrome.scripting.executeScript.
 */

import { KEYS, get, set } from './storage-sync.js'

/**
 * @typedef {Object} Snippet
 * @property {string}   id          - UUID
 * @property {string}   name        - Display name
 * @property {string}   description - Short description shown in the UI
 * @property {string}   code        - JavaScript to execute
 * @property {boolean}  enabled     - Whether the snippet is active
 * @property {boolean}  autoRun     - Execute automatically on matching pages
 * @property {string[]} runOn       - URL match patterns for auto-run
 * @property {string[]} tags        - Arbitrary tags for organisation
 * @property {number}   order       - Sort order (lower = earlier)
 * @property {number}   createdAt   - Unix ms timestamp
 * @property {number}   updatedAt   - Unix ms timestamp
 */

/**
 * Generate a version-4-like UUID without crypto.randomUUID to stay compatible
 * with all Chromium builds that don't expose it in every context.
 * @returns {string}
 */
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

/**
 * Load all snippets from storage.
 * @returns {Promise<Snippet[]>}
 */
async function getAll() {
  const result = await get(KEYS.SNIPPETS)
  const snippets = result[KEYS.SNIPPETS] || []
  return snippets.slice().sort((a, b) => a.order - b.order)
}

/**
 * Persist the full array to storage.
 * @param {Snippet[]} snippets
 * @returns {Promise<void>}
 */
async function saveAll(snippets) {
  await set({ [KEYS.SNIPPETS]: snippets })
}

/**
 * Create a new snippet.
 * @param {Partial<Snippet>} data
 * @returns {Promise<Snippet>}
 */
async function create(data) {
  const snippets = await getAll()
  const maxOrder = snippets.reduce((m, s) => Math.max(m, s.order), -1)

  /** @type {Snippet} */
  const snippet = {
    id: generateId(),
    name: data.name || 'Untitled Snippet',
    description: data.description || '',
    code: data.code || '',
    enabled: data.enabled !== false,
    autoRun: data.autoRun || false,
    runOn: data.runOn || [],
    tags: data.tags || [],
    order: maxOrder + 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  snippets.push(snippet)
  await saveAll(snippets)
  return snippet
}

/**
 * Update an existing snippet by id.
 * @param {string} id
 * @param {Partial<Snippet>} updates
 * @returns {Promise<Snippet|null>}
 */
async function update(id, updates) {
  const snippets = await getAll()
  const idx = snippets.findIndex((s) => s.id === id)
  if (idx === -1) return null

  snippets[idx] = Object.assign({}, snippets[idx], updates, {
    id,
    updatedAt: Date.now(),
  })

  await saveAll(snippets)
  return snippets[idx]
}

/**
 * Delete a snippet by id.
 * @param {string} id
 * @returns {Promise<boolean>} true if a snippet was deleted
 */
async function remove(id) {
  const snippets = await getAll()
  const next = snippets.filter((s) => s.id !== id)
  if (next.length === snippets.length) return false
  await saveAll(next)
  return true
}

/**
 * Delete all snippets.
 * @returns {Promise<void>}
 */
async function clear() {
  await saveAll([])
}

/**
 * Reorder snippets. `orderedIds` should contain all snippet IDs in the
 * desired display order.
 * @param {string[]} orderedIds
 * @returns {Promise<void>}
 */
async function reorder(orderedIds) {
  const snippets = await getAll()
  const map = Object.fromEntries(snippets.map((s) => [s.id, s]))
  const reordered = orderedIds
    .filter((id) => map[id])
    .map((id, idx) => Object.assign({}, map[id], { order: idx }))
  await saveAll(reordered)
}

/**
 * Execute a snippet's code in the given tab (defaults to active tab).
 * Returns the result or an error object.
 * @param {string|Snippet} snippetOrId
 * @param {number} [tabId]
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
async function execute(snippetOrId, tabId) {
  let snippet
  if (typeof snippetOrId === 'string') {
    const snippets = await getAll()
    snippet = snippets.find((s) => s.id === snippetOrId)
    if (!snippet) return { success: false, error: 'Snippet not found' }
  } else {
    snippet = snippetOrId
  }

  if (!snippet.enabled) {
    return { success: false, error: 'Snippet is disabled' }
  }

  let target
  if (tabId) {
    target = { tabId }
  } else {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    })
    if (!activeTab) return { success: false, error: 'No active tab' }
    target = { tabId: activeTab.id }
  }

  // Wrap the user code so errors are caught and returned cleanly.
  const wrappedCode = `
    (function() {
      try {
        ${snippet.code}
      } catch (err) {
        return { __erudaError: true, message: err.message, stack: err.stack };
      }
    })()
  `

  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: new Function(wrappedCode),
      world: 'MAIN',
    })

    const value = results && results[0] && results[0].result
    if (value && value.__erudaError) {
      return { success: false, error: value.message, stack: value.stack }
    }
    return { success: true, result: value }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Check if a snippet should auto-run for the given URL.
 * Supports `<all_urls>` and `scheme://host/path` patterns with * wildcards.
 * @param {Snippet} snippet
 * @param {string} url
 * @returns {boolean}
 */
function matchesUrl(snippet, url) {
  if (!snippet.autoRun || !snippet.enabled) return false
  if (!snippet.runOn || snippet.runOn.length === 0) return false

  return snippet.runOn.some((pattern) => urlMatchesPattern(url, pattern))
}

/**
 * Minimal Chrome match-pattern checker. Handles `<all_urls>` and patterns of
 * the form `scheme://host/path` where * is a wildcard.
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function urlMatchesPattern(url, pattern) {
  if (pattern === '<all_urls>') return true

  try {
    // Escape regex special chars except * which becomes .*
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(url)
  } catch {
    return false
  }
}

/**
 * Export snippets as a JSON string.
 * @returns {Promise<string>}
 */
async function exportSnippets() {
  const snippets = await getAll()
  return JSON.stringify({ version: 1, snippets }, null, 2)
}

/**
 * Import snippets from a JSON string. Skips duplicates by id.
 * @param {string} jsonString
 * @returns {Promise<number>} number of newly imported snippets
 */
async function importSnippets(jsonString) {
  let data
  try {
    data = JSON.parse(jsonString)
  } catch {
    throw new Error('Invalid JSON')
  }

  const incoming = Array.isArray(data) ? data : (data.snippets || [])
  const existing = await getAll()
  const existingIds = new Set(existing.map((s) => s.id))
  const maxOrder = existing.reduce((m, s) => Math.max(m, s.order), -1)

  let added = 0
  const merged = [...existing]
  incoming.forEach((s, i) => {
    if (existingIds.has(s.id)) return
    merged.push(
      Object.assign({}, s, {
        id: s.id || generateId(),
        order: maxOrder + 1 + i,
        updatedAt: Date.now(),
      })
    )
    added++
  })

  await saveAll(merged)
  return added
}

export {
  getAll,
  create,
  update,
  remove,
  clear,
  reorder,
  execute,
  matchesUrl,
  urlMatchesPattern,
  exportSnippets,
  importSnippets,
}
