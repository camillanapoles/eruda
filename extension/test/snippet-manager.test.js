/**
 * extension/test/snippet-manager.test.js
 * Unit tests for the snippet manager using a chrome.storage.local mock.
 * Run with: node --experimental-vm-modules node_modules/.bin/jest extension/test
 * or manually in a browser extension context.
 *
 * These tests use a lightweight in-memory mock for chrome APIs so they can
 * execute in any Node / Jest environment without a real browser.
 */

// ---------------------------------------------------------------------------
// Chrome API mock (in-memory storage + scripting stub)
// ---------------------------------------------------------------------------
const store = {}

const chromeMock = {
  storage: {
    local: {
      get(keys, cb) {
        const result = {}
        const keyArr = Array.isArray(keys) ? keys : [keys]
        keyArr.forEach((k) => { result[k] = store[k] })
        if (cb) cb(result)
        else return Promise.resolve(result)
      },
      set(data, cb) {
        Object.assign(store, data)
        if (cb) cb()
        else return Promise.resolve()
      },
      remove(keys, cb) {
        const keyArr = Array.isArray(keys) ? keys : [keys]
        keyArr.forEach((k) => delete store[k])
        if (cb) cb()
        else return Promise.resolve()
      },
      getBytesInUse(_keys, cb) {
        const size = JSON.stringify(store).length
        if (cb) cb(size)
        else return Promise.resolve(size)
      },
    },
  },
  runtime: { lastError: null },
  scripting: {
    executeScript: async ({ func, args }) => {
      const result = await func(...(args || []))
      return [{ result }]
    },
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/' }],
  },
}

// Inject mock globally before importing modules
global.chrome = chromeMock
global.crypto = { randomUUID: () => Math.random().toString(36).slice(2) }

// We need to re-mock storage-sync since it wraps chrome.storage.local
jest.mock('../scripts/storage-sync.js', () => {
  const KEYS = {
    SNIPPETS: 'eruda_snippets',
    USER_SCRIPTS: 'eruda_user_scripts',
    ERROR_LOG: 'eruda_error_log',
    SETTINGS: 'eruda_settings',
    ERUDA_ACTIVE_TABS: 'eruda_active_tabs',
  }

  const store = {}

  async function get(keys) {
    const result = {}
    const arr = Array.isArray(keys) ? keys : [keys]
    arr.forEach((k) => { result[k] = store[k] })
    return result
  }

  async function set(data) {
    Object.assign(store, data)
  }

  async function remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys]
    arr.forEach((k) => delete store[k])
  }

  async function getBytesInUse() { return JSON.stringify(store).length }
  async function checkQuota() {
    const bytesInUse = await getBytesInUse()
    const quota = 10 * 1024 * 1024
    return { bytesInUse, quota, overThreshold: false, usagePercent: 0 }
  }
  async function cleanOldErrors() {}
  async function exportAll() { return JSON.stringify({ version: 1, snippets: [], userScripts: [], settings: {} }) }
  async function importAll() { return { snippets: 0, userScripts: 0 } }

  return { KEYS, get, set, remove, getBytesInUse, checkQuota, cleanOldErrors, exportAll, importAll }
})

const {
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
} = require('../scripts/snippet-manager.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await clear()
})

describe('snippet-manager — CRUD', () => {
  test('create returns a snippet with defaults', async () => {
    const s = await create({ name: 'Test', code: 'console.log(1)' })
    expect(s.id).toBeTruthy()
    expect(s.name).toBe('Test')
    expect(s.enabled).toBe(true)
    expect(s.autoRun).toBe(false)
    expect(s.runOn).toEqual([])
    expect(s.tags).toEqual([])
    expect(typeof s.createdAt).toBe('number')
    expect(typeof s.updatedAt).toBe('number')
  })

  test('getAll returns sorted snippets', async () => {
    await create({ name: 'B', code: '' })
    await create({ name: 'A', code: '' })
    const all = await getAll()
    expect(all.length).toBe(2)
    expect(all[0].name).toBe('B') // order 0 first
  })

  test('update modifies fields and bumps updatedAt', async () => {
    const s = await create({ name: 'Original', code: 'x' })
    const before = s.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    const updated = await update(s.id, { name: 'Changed' })
    expect(updated.name).toBe('Changed')
    expect(updated.updatedAt).toBeGreaterThan(before)
  })

  test('update returns null for unknown id', async () => {
    const result = await update('nonexistent', { name: 'x' })
    expect(result).toBeNull()
  })

  test('remove deletes snippet', async () => {
    const s = await create({ name: 'Del', code: '' })
    const ok = await remove(s.id)
    expect(ok).toBe(true)
    const all = await getAll()
    expect(all.length).toBe(0)
  })

  test('remove returns false for unknown id', async () => {
    const ok = await remove('none')
    expect(ok).toBe(false)
  })

  test('clear empties all snippets', async () => {
    await create({ name: 'A', code: '' })
    await create({ name: 'B', code: '' })
    await clear()
    expect(await getAll()).toEqual([])
  })
})

describe('snippet-manager — reorder', () => {
  test('reorder changes snippet order', async () => {
    const a = await create({ name: 'A', code: '' })
    const b = await create({ name: 'B', code: '' })
    await reorder([b.id, a.id])
    const all = await getAll()
    expect(all[0].name).toBe('B')
    expect(all[1].name).toBe('A')
  })
})

describe('snippet-manager — URL matching', () => {
  test('<all_urls> matches any URL', () => {
    expect(urlMatchesPattern('https://google.com', '<all_urls>')).toBe(true)
  })

  test('exact scheme+host+path matches', () => {
    expect(urlMatchesPattern('https://example.com/path', 'https://example.com/path')).toBe(true)
    expect(urlMatchesPattern('https://other.com/path', 'https://example.com/path')).toBe(false)
  })

  test('wildcard in host matches', () => {
    expect(urlMatchesPattern('https://sub.example.com/page', '*://*.example.com/*')).toBe(true)
    expect(urlMatchesPattern('https://notexample.org/page', '*://*.example.com/*')).toBe(false)
  })

  test('matchesUrl returns false when autoRun is off', () => {
    const snippet = { enabled: true, autoRun: false, runOn: ['<all_urls>'] }
    expect(matchesUrl(snippet, 'https://example.com')).toBe(false)
  })

  test('matchesUrl returns false when disabled', () => {
    const snippet = { enabled: false, autoRun: true, runOn: ['<all_urls>'] }
    expect(matchesUrl(snippet, 'https://example.com')).toBe(false)
  })

  test('matchesUrl returns true when pattern matches', () => {
    const snippet = { enabled: true, autoRun: true, runOn: ['*://*.example.com/*'] }
    expect(matchesUrl(snippet, 'https://www.example.com/page')).toBe(true)
  })
})

describe('snippet-manager — import/export', () => {
  test('export produces valid JSON with version field', async () => {
    await create({ name: 'Exp', code: 'alert(1)' })
    const json = await exportSnippets()
    const data = JSON.parse(json)
    expect(data.version).toBe(1)
    expect(data.snippets.length).toBe(1)
    expect(data.snippets[0].name).toBe('Exp')
  })

  test('import adds new snippets and skips duplicates', async () => {
    const s = await create({ name: 'Existing', code: '' })
    const toImport = JSON.stringify({
      version: 1,
      snippets: [
        { id: s.id, name: 'Existing', code: '' }, // duplicate
        { id: 'new-id-1', name: 'New', code: 'alert(2)' },
      ],
    })
    const added = await importSnippets(toImport)
    expect(added).toBe(1)
    const all = await getAll()
    expect(all.length).toBe(2)
  })

  test('import throws on invalid JSON', async () => {
    await expect(importSnippets('not json')).rejects.toThrow('Invalid JSON')
  })
})
