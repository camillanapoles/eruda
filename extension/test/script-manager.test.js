/**
 * extension/test/script-manager.test.js
 * Unit tests for the user script manager.
 */

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
    ;(Array.isArray(keys) ? keys : [keys]).forEach((k) => { result[k] = store[k] })
    return result
  }
  async function set(data) { Object.assign(store, data) }
  async function remove(keys) {
    ;(Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k])
  }
  return { KEYS, get, set, remove }
})

global.crypto = { randomUUID: () => Math.random().toString(36).slice(2) }

const {
  parseMetadata,
  urlMatchesPattern,
  shouldRunOn,
  getAll,
  install,
  update,
  toggle,
  uninstall,
  buildExecutable,
  exportScripts,
  importScripts,
} = require('../scripts/script-manager.js')

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
const SAMPLE_SCRIPT = `// ==UserScript==
// @name        Hello World
// @namespace   https://example.com
// @version     2.1.0
// @description A test script
// @author      Tester
// @match       *://*.example.com/*
// @match       https://other.org/page
// @exclude     *://banned.example.com/*
// @grant       GM_log
// @grant       GM_addStyle
// @run-at      document-end
// ==/UserScript==

console.log('hello');
`

// ---------------------------------------------------------------------------
// Metadata parser
// ---------------------------------------------------------------------------
describe('parseMetadata', () => {
  test('parses all standard fields', () => {
    const m = parseMetadata(SAMPLE_SCRIPT)
    expect(m.name).toBe('Hello World')
    expect(m.namespace).toBe('https://example.com')
    expect(m.version).toBe('2.1.0')
    expect(m.description).toBe('A test script')
    expect(m.author).toBe('Tester')
    expect(m.match).toEqual(['*://*.example.com/*', 'https://other.org/page'])
    expect(m.exclude).toEqual(['*://banned.example.com/*'])
    expect(m.grant).toEqual(['GM_log', 'GM_addStyle'])
    expect(m.runAt).toBe('document-end')
  })

  test('returns defaults for code without a header block', () => {
    const m = parseMetadata('console.log("bare")')
    expect(m.name).toBe('Untitled Script')
    expect(m.match).toEqual([])
    expect(m.runAt).toBe('document-idle')
  })

  test('ignores invalid runAt values', () => {
    const code = `// ==UserScript==\n// @run-at invalid-value\n// ==/UserScript==`
    const m = parseMetadata(code)
    expect(m.runAt).toBe('document-idle')
  })
})

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------
describe('urlMatchesPattern', () => {
  test('<all_urls> always matches', () => {
    expect(urlMatchesPattern('https://anything.com/path', '<all_urls>')).toBe(true)
  })

  test('wildcard scheme matches http and https', () => {
    expect(urlMatchesPattern('http://example.com/p', '*://example.com/p')).toBe(true)
    expect(urlMatchesPattern('https://example.com/p', '*://example.com/p')).toBe(true)
  })

  test('subdomain wildcard works', () => {
    expect(urlMatchesPattern('https://sub.foo.com/bar', '*://*.foo.com/*')).toBe(true)
    expect(urlMatchesPattern('https://other.com/bar', '*://*.foo.com/*')).toBe(false)
  })

  test('no false positive on partial domain match', () => {
    expect(urlMatchesPattern('https://notexample.com', '*://example.com/*')).toBe(false)
  })
})

describe('shouldRunOn', () => {
  const makeScript = (match, exclude, enabled = true) => ({
    enabled,
    metadata: { match, include: [], exclude },
  })

  test('returns false for disabled script', () => {
    const s = makeScript(['<all_urls>'], [], false)
    expect(shouldRunOn(s, 'https://example.com')).toBe(false)
  })

  test('returns false when excluded', () => {
    const s = makeScript(['*://*.example.com/*'], ['*://banned.example.com/*'])
    expect(shouldRunOn(s, 'https://banned.example.com/page')).toBe(false)
  })

  test('returns false when no patterns given', () => {
    const s = makeScript([], [])
    expect(shouldRunOn(s, 'https://example.com')).toBe(false)
  })

  test('returns true when URL matches @match', () => {
    const s = makeScript(['*://*.example.com/*'], [])
    expect(shouldRunOn(s, 'https://www.example.com/page')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
async function clearAllScripts() {
  const { KEYS, set } = require('../scripts/storage-sync.js')
  await set({ [KEYS.USER_SCRIPTS]: [] })
}

beforeEach(clearAllScripts)

describe('script CRUD', () => {
  test('install creates a script with parsed metadata', async () => {
    const s = await install(SAMPLE_SCRIPT)
    expect(s.id).toBeTruthy()
    expect(s.metadata.name).toBe('Hello World')
    expect(s.enabled).toBe(true)
    expect(s.installUrl).toBeNull()
  })

  test('install from raw code without header uses defaults', async () => {
    const s = await install('console.log("bare")')
    expect(s.metadata.name).toBe('Untitled Script')
  })

  test('update changes code and re-parses metadata', async () => {
    const s = await install(SAMPLE_SCRIPT)
    const newCode = SAMPLE_SCRIPT.replace('Hello World', 'Updated Script')
    const updated = await update(s.id, { code: newCode })
    expect(updated.metadata.name).toBe('Updated Script')
  })

  test('toggle flips enabled state', async () => {
    const s = await install(SAMPLE_SCRIPT)
    expect(s.enabled).toBe(true)
    const toggled = await toggle(s.id)
    expect(toggled.enabled).toBe(false)
    const toggled2 = await toggle(s.id)
    expect(toggled2.enabled).toBe(true)
  })

  test('uninstall removes the script', async () => {
    const s = await install(SAMPLE_SCRIPT)
    const ok = await uninstall(s.id)
    expect(ok).toBe(true)
    expect(await getAll()).toHaveLength(0)
  })

  test('uninstall returns false for unknown id', async () => {
    const ok = await uninstall('no-such-id')
    expect(ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildExecutable
// ---------------------------------------------------------------------------
describe('buildExecutable', () => {
  test('wraps code in IIFE', () => {
    const s = {
      id: 'test-id',
      metadata: { name: 'Test', grant: [] },
      code: 'var x = 1;',
    }
    const exe = buildExecutable(s)
    expect(exe).toContain('(function()')
    expect(exe).toContain('var x = 1;')
    expect(exe).toContain('SCRIPT_ERROR')
  })

  test('includes GM_log shim when granted', () => {
    const s = {
      id: 'test-id',
      metadata: { name: 'Test', grant: ['GM_log'] },
      code: 'GM_log("hi")',
    }
    const exe = buildExecutable(s)
    expect(exe).toContain('function GM_log')
  })

  test('includes GM_addStyle shim when granted', () => {
    const s = {
      id: 'test-id',
      metadata: { name: 'Test', grant: ['GM_addStyle'] },
      code: '',
    }
    const exe = buildExecutable(s)
    expect(exe).toContain('function GM_addStyle')
  })

  test('does not include ungranted shims', () => {
    const s = {
      id: 'test-id',
      metadata: { name: 'Test', grant: [] },
      code: '',
    }
    const exe = buildExecutable(s)
    expect(exe).not.toContain('function GM_log')
    expect(exe).not.toContain('function GM_addStyle')
  })
})

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------
describe('import / export scripts', () => {
  test('exportScripts produces valid JSON', async () => {
    await install(SAMPLE_SCRIPT)
    const json = await exportScripts()
    const data = JSON.parse(json)
    expect(data.version).toBe(1)
    expect(data.userScripts.length).toBe(1)
  })

  test('importScripts skips duplicates', async () => {
    const s = await install(SAMPLE_SCRIPT)
    const json = JSON.stringify({
      version: 1,
      userScripts: [
        s, // duplicate
        { id: 'fresh', metadata: { name: 'New' }, code: '', enabled: true, installUrl: null, createdAt: Date.now(), updatedAt: Date.now() },
      ],
    })
    const added = await importScripts(json)
    expect(added).toBe(1)
    expect(await getAll()).toHaveLength(2)
  })

  test('importScripts throws on invalid JSON', async () => {
    await expect(importScripts('bad{}')).rejects.toThrow('Invalid JSON')
  })
})
