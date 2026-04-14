/**
 * extension/test/storage-sync.test.js
 * Unit tests for the storage-sync module using an in-memory chrome.storage mock.
 */

// ---------------------------------------------------------------------------
// In-memory chrome.storage.local mock
// ---------------------------------------------------------------------------
const memStore = {}

global.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const result = {}
        ;(Array.isArray(keys) ? keys : [keys]).forEach((k) => {
          if (memStore[k] !== undefined) result[k] = JSON.parse(JSON.stringify(memStore[k]))
        })
        if (cb) { cb(result); return }
        return Promise.resolve(result)
      },
      set(data, cb) {
        Object.keys(data).forEach((k) => { memStore[k] = JSON.parse(JSON.stringify(data[k])) })
        if (cb) { cb(); return }
        return Promise.resolve()
      },
      remove(keys, cb) {
        ;(Array.isArray(keys) ? keys : [keys]).forEach((k) => delete memStore[k])
        if (cb) { cb(); return }
        return Promise.resolve()
      },
      getBytesInUse(_keys, cb) {
        const size = JSON.stringify(memStore).length
        if (cb) { cb(size); return }
        return Promise.resolve(size)
      },
    },
  },
  runtime: { lastError: null },
}

global.crypto = { randomUUID: () => Math.random().toString(36).slice(2) }

// Clear between tests
beforeEach(() => {
  Object.keys(memStore).forEach((k) => delete memStore[k])
})

const {
  KEYS,
  get,
  set,
  remove,
  getBytesInUse,
  checkQuota,
  cleanOldErrors,
  exportAll,
  importAll,
} = require('../scripts/storage-sync.js')

// ---------------------------------------------------------------------------
// get / set / remove
// ---------------------------------------------------------------------------
describe('basic storage operations', () => {
  test('set and get a value', async () => {
    await set({ myKey: 42 })
    const result = await get('myKey')
    expect(result.myKey).toBe(42)
  })

  test('get returns empty object for missing key', async () => {
    const result = await get('missing')
    expect(result.missing).toBeUndefined()
  })

  test('set multiple keys', async () => {
    await set({ a: 1, b: 2 })
    const result = await get(['a', 'b'])
    expect(result.a).toBe(1)
    expect(result.b).toBe(2)
  })

  test('remove deletes a key', async () => {
    await set({ toDelete: 'yes' })
    await remove('toDelete')
    const result = await get('toDelete')
    expect(result.toDelete).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// checkQuota
// ---------------------------------------------------------------------------
describe('checkQuota', () => {
  test('returns bytes and quota info', async () => {
    await set({ [KEYS.SNIPPETS]: [{ id: '1', name: 'Test' }] })
    const info = await checkQuota()
    expect(info.bytesInUse).toBeGreaterThan(0)
    expect(info.quota).toBe(10 * 1024 * 1024)
    expect(typeof info.usagePercent).toBe('number')
    expect(typeof info.overThreshold).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// cleanOldErrors
// ---------------------------------------------------------------------------
describe('cleanOldErrors', () => {
  test('removes errors older than 7 days', async () => {
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000
    const newTs = Date.now()
    await set({
      [KEYS.ERROR_LOG]: [
        { id: 'old', timestamp: oldTs, resolved: false },
        { id: 'new', timestamp: newTs, resolved: false },
      ],
    })
    const remaining = await cleanOldErrors()
    expect(remaining).toBe(1)
    const result = await get(KEYS.ERROR_LOG)
    expect(result[KEYS.ERROR_LOG]).toHaveLength(1)
    expect(result[KEYS.ERROR_LOG][0].id).toBe('new')
  })

  test('caps at 500 entries', async () => {
    const ts = Date.now()
    const errors = Array.from({ length: 600 }, (_, i) => ({ id: String(i), timestamp: ts }))
    await set({ [KEYS.ERROR_LOG]: errors })
    const remaining = await cleanOldErrors()
    expect(remaining).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// exportAll / importAll
// ---------------------------------------------------------------------------
describe('exportAll', () => {
  test('returns valid JSON with version 1', async () => {
    await set({
      [KEYS.SNIPPETS]: [{ id: '1', name: 'S1' }],
      [KEYS.USER_SCRIPTS]: [{ id: '2', metadata: { name: 'US1' } }],
      [KEYS.SETTINGS]: { theme: 'Dark' },
    })
    const json = await exportAll()
    const data = JSON.parse(json)
    expect(data.version).toBe(1)
    expect(data.snippets).toHaveLength(1)
    expect(data.userScripts).toHaveLength(1)
    expect(data.settings.theme).toBe('Dark')
    expect(data.exportedAt).toBeTruthy()
  })
})

describe('importAll', () => {
  test('replaces all data when replace=true', async () => {
    await set({ [KEYS.SNIPPETS]: [{ id: 'existing', name: 'Old' }] })
    const backup = JSON.stringify({
      version: 1,
      snippets: [{ id: 'imported', name: 'Imported' }],
      userScripts: [],
      settings: {},
    })
    const counts = await importAll(backup, true)
    expect(counts.snippets).toBe(1)
    const result = await get(KEYS.SNIPPETS)
    expect(result[KEYS.SNIPPETS]).toHaveLength(1)
    expect(result[KEYS.SNIPPETS][0].id).toBe('imported')
  })

  test('merges data when replace=false', async () => {
    await set({ [KEYS.SNIPPETS]: [{ id: 'existing', name: 'Old' }] })
    const backup = JSON.stringify({
      version: 1,
      snippets: [
        { id: 'existing', name: 'Old' }, // duplicate — should be skipped
        { id: 'new-one', name: 'New' },
      ],
      userScripts: [],
      settings: {},
    })
    const counts = await importAll(backup, false)
    expect(counts.snippets).toBe(2) // existing + new-one
  })

  test('throws for invalid JSON', async () => {
    await expect(importAll('not json')).rejects.toThrow('Invalid JSON')
  })

  test('throws for wrong version', async () => {
    const bad = JSON.stringify({ version: 99, snippets: [], userScripts: [], settings: {} })
    await expect(importAll(bad)).rejects.toThrow('Unsupported backup version')
  })
})
