/**
 * storage-sync.js
 * Centralized storage management for the Eruda Cromite extension.
 * Provides a clean API over chrome.storage.local with quota monitoring,
 * automatic cleanup of old error logs, and convenience helpers.
 */

const STORAGE_WARNING_THRESHOLD = 0.8 // 80% of quota
const MAX_STORAGE_BYTES = 10 * 1024 * 1024 // 10 MB

const KEYS = {
  SNIPPETS: 'eruda_snippets',
  USER_SCRIPTS: 'eruda_user_scripts',
  ERROR_LOG: 'eruda_error_log',
  SETTINGS: 'eruda_settings',
  ERUDA_ACTIVE_TABS: 'eruda_active_tabs',
}

const ERROR_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const ERROR_LOG_MAX_ENTRIES = 500

/**
 * Read one or more keys from chrome.storage.local.
 * @param {string|string[]} keys
 * @returns {Promise<Object>}
 */
async function get(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(result)
      }
    })
  })
}

/**
 * Write an object into chrome.storage.local.
 * @param {Object} data
 * @returns {Promise<void>}
 */
async function set(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve()
      }
    })
  })
}

/**
 * Remove one or more keys from chrome.storage.local.
 * @param {string|string[]} keys
 * @returns {Promise<void>}
 */
async function remove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve()
      }
    })
  })
}

/**
 * Get the current storage usage in bytes.
 * @returns {Promise<number>}
 */
async function getBytesInUse() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(bytesInUse)
      }
    })
  })
}

/**
 * Check if storage usage is above the warning threshold.
 * @returns {Promise<{bytesInUse: number, quota: number, overThreshold: boolean}>}
 */
async function checkQuota() {
  const bytesInUse = await getBytesInUse()
  const quota = MAX_STORAGE_BYTES
  return {
    bytesInUse,
    quota,
    overThreshold: bytesInUse / quota > STORAGE_WARNING_THRESHOLD,
    usagePercent: Math.round((bytesInUse / quota) * 100),
  }
}

/**
 * Remove error log entries older than ERROR_LOG_MAX_AGE_MS and enforce
 * the maximum entry cap. Called periodically by the background service worker.
 */
async function cleanOldErrors() {
  const result = await get(KEYS.ERROR_LOG)
  let errors = result[KEYS.ERROR_LOG] || []

  const cutoff = Date.now() - ERROR_LOG_MAX_AGE_MS
  errors = errors.filter((e) => e.timestamp > cutoff)

  if (errors.length > ERROR_LOG_MAX_ENTRIES) {
    errors = errors.slice(errors.length - ERROR_LOG_MAX_ENTRIES)
  }

  await set({ [KEYS.ERROR_LOG]: errors })
  return errors.length
}

/**
 * Export all extension data as a JSON string for backup.
 * @returns {Promise<string>}
 */
async function exportAll() {
  const result = await get([
    KEYS.SNIPPETS,
    KEYS.USER_SCRIPTS,
    KEYS.SETTINGS,
  ])
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      snippets: result[KEYS.SNIPPETS] || [],
      userScripts: result[KEYS.USER_SCRIPTS] || [],
      settings: result[KEYS.SETTINGS] || {},
    },
    null,
    2
  )
}

/**
 * Import data from a previously exported JSON string. Merges by default;
 * pass replace=true to completely replace existing data.
 * @param {string} jsonString
 * @param {boolean} replace
 * @returns {Promise<{snippets: number, userScripts: number}>}
 */
async function importAll(jsonString, replace = false) {
  let data
  try {
    data = JSON.parse(jsonString)
  } catch {
    throw new Error('Invalid JSON backup file')
  }

  if (!data.version || data.version !== 1) {
    throw new Error('Unsupported backup version')
  }

  const toWrite = {}

  if (replace) {
    toWrite[KEYS.SNIPPETS] = data.snippets || []
    toWrite[KEYS.USER_SCRIPTS] = data.userScripts || []
    toWrite[KEYS.SETTINGS] = data.settings || {}
  } else {
    const existing = await get([KEYS.SNIPPETS, KEYS.USER_SCRIPTS, KEYS.SETTINGS])

    const existingSnippets = existing[KEYS.SNIPPETS] || []
    const importedSnippets = data.snippets || []
    const existingIds = new Set(existingSnippets.map((s) => s.id))
    const newSnippets = importedSnippets.filter((s) => !existingIds.has(s.id))
    toWrite[KEYS.SNIPPETS] = [...existingSnippets, ...newSnippets]

    const existingScripts = existing[KEYS.USER_SCRIPTS] || []
    const importedScripts = data.userScripts || []
    const existingScriptIds = new Set(existingScripts.map((s) => s.id))
    const newScripts = importedScripts.filter((s) => !existingScriptIds.has(s.id))
    toWrite[KEYS.USER_SCRIPTS] = [...existingScripts, ...newScripts]

    toWrite[KEYS.SETTINGS] = Object.assign(
      {},
      existing[KEYS.SETTINGS] || {},
      data.settings || {}
    )
  }

  await set(toWrite)
  return {
    snippets: (toWrite[KEYS.SNIPPETS] || []).length,
    userScripts: (toWrite[KEYS.USER_SCRIPTS] || []).length,
  }
}

export {
  KEYS,
  get,
  set,
  remove,
  getBytesInUse,
  checkQuota,
  cleanOldErrors,
  exportAll,
  importAll,
}
