/**
 * extension/test/error-debugger.test.js
 * Unit tests for the error classification and storage modules.
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
  return { KEYS, get, set }
})

global.crypto = { randomUUID: () => Math.random().toString(36).slice(2) }

const {
  classify,
  fingerprint,
  loadErrors,
  appendError,
  resolveError,
  clearResolved,
  clearAll,
} = require('../scripts/error-debugger.js')

// ---------------------------------------------------------------------------
// Reset error log between tests
// ---------------------------------------------------------------------------
beforeEach(async () => {
  await clearAll()
})

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------
describe('classify', () => {
  const cases = [
    {
      message: "Cannot read property 'foo' of undefined",
      expectedType: 'runtime',
      expectedSeverity: 'error',
      suggestionFragment: 'optional chaining',
    },
    {
      message: "Cannot read properties of null (reading 'bar')",
      expectedType: 'runtime',
      expectedSeverity: 'error',
      suggestionFragment: 'optional chaining',
    },
    {
      message: 'myVar is not defined',
      expectedType: 'runtime',
      expectedSeverity: 'error',
      suggestionFragment: 'declared',
    },
    {
      message: 'SyntaxError: Unexpected token }',
      expectedType: 'syntax',
      expectedSeverity: 'critical',
      suggestionFragment: 'syntax error',
    },
    {
      message: 'Failed to fetch https://api.example.com/data',
      expectedType: 'network',
      expectedSeverity: 'error',
      suggestionFragment: 'network request',
    },
    {
      message: 'Access to fetch blocked by CORS policy: No Access-Control-Allow-Origin header',
      expectedType: 'network',
      expectedSeverity: 'error',
      suggestionFragment: 'cross-origin',
    },
    {
      message: 'Content Security Policy blocked inline script',
      expectedType: 'csp',
      expectedSeverity: 'warning',
      suggestionFragment: 'Content Security Policy',
    },
    {
      message: 'QuotaExceededError: DOM Exception 22',
      expectedType: 'runtime',
      expectedSeverity: 'warning',
      suggestionFragment: 'Storage quota',
    },
    {
      message: 'Maximum call stack size exceeded',
      expectedType: 'runtime',
      expectedSeverity: 'critical',
      suggestionFragment: 'recursion',
    },
    {
      message: 'undefined is not a function',
      expectedType: 'runtime',
      expectedSeverity: 'error',
      suggestionFragment: 'function',
    },
  ]

  cases.forEach(({ message, expectedType, expectedSeverity, suggestionFragment }) => {
    test(`classifies "${message.slice(0, 50)}…"`, () => {
      const result = classify(message)
      expect(result.type).toBe(expectedType)
      expect(result.severity).toBe(expectedSeverity)
      expect(result.suggestion.toLowerCase()).toContain(suggestionFragment.toLowerCase())
    })
  })

  test('returns null suggestion for unknown error', () => {
    const result = classify('Some completely unknown error message XYZ123')
    expect(result.suggestion).toBeNull()
    expect(result.type).toBe('runtime')
  })
})

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------
describe('fingerprint', () => {
  test('same message+source+line produces same fingerprint', () => {
    const a = fingerprint('TypeError', 'script.js', 42)
    const b = fingerprint('TypeError', 'script.js', 42)
    expect(a).toBe(b)
  })

  test('different line produces different fingerprint', () => {
    const a = fingerprint('TypeError', 'script.js', 42)
    const b = fingerprint('TypeError', 'script.js', 43)
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// appendError / storage
// ---------------------------------------------------------------------------
describe('appendError', () => {
  const BASE = {
    type: 'runtime',
    message: 'Test error',
    stack: 'Error: Test error\n  at foo:1:1',
    source: 'test.js',
    line: 10,
    column: 0,
    context: { url: 'https://example.com', userAgent: 'TestAgent' },
  }

  test('appends a new error entry', async () => {
    const entry = await appendError(BASE)
    expect(entry.id).toBeTruthy()
    expect(entry.message).toBe('Test error')
    expect(entry.resolved).toBe(false)
    expect(entry.count).toBe(1)

    const errors = await loadErrors()
    expect(errors).toHaveLength(1)
  })

  test('increments count for duplicate error', async () => {
    await appendError(BASE)
    const entry2 = await appendError(BASE)
    expect(entry2.count).toBe(2)

    const errors = await loadErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0].count).toBe(2)
  })

  test('does not deduplicate resolved errors', async () => {
    const e1 = await appendError(BASE)
    await resolveError(e1.id)
    await appendError(BASE)

    const errors = await loadErrors()
    expect(errors).toHaveLength(2)
  })

  test('auto-classifies when type not provided', async () => {
    const entry = await appendError({
      message: "Cannot read property 'x' of null",
      stack: '',
      source: 'page.js',
      line: 5,
      column: 0,
      context: {},
    })
    expect(entry.type).toBe('runtime')
    expect(entry.severity).toBe('error')
    expect(entry.suggestion).toBeTruthy()
  })

  test('applies timestamp when not provided', async () => {
    const before = Date.now()
    const entry = await appendError({ ...BASE, timestamp: undefined })
    expect(entry.timestamp).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------
// resolveError
// ---------------------------------------------------------------------------
describe('resolveError', () => {
  test('marks error as resolved', async () => {
    const e = await appendError({ ...BASE_ERROR(), message: 'resolve-me' })
    const ok = await resolveError(e.id)
    expect(ok).toBe(true)

    const errors = await loadErrors()
    const found = errors.find((x) => x.id === e.id)
    expect(found.resolved).toBe(true)
  })

  test('returns false for unknown id', async () => {
    const ok = await resolveError('nonexistent-id')
    expect(ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// clearResolved
// ---------------------------------------------------------------------------
describe('clearResolved', () => {
  test('removes only resolved entries', async () => {
    const e1 = await appendError({ ...BASE_ERROR(), message: 'err1' })
    const e2 = await appendError({ ...BASE_ERROR(), message: 'err2', source: 'other.js' })
    await resolveError(e1.id)

    const removed = await clearResolved()
    expect(removed).toBe(1)

    const remaining = await loadErrors()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(e2.id)
  })
})

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------
describe('clearAll', () => {
  test('removes all errors', async () => {
    await appendError(BASE_ERROR())
    await appendError({ ...BASE_ERROR(), message: 'other', source: 'b.js' })
    await clearAll()
    expect(await loadErrors()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Shared fixtures (used by tests after appendError describe block)
// ---------------------------------------------------------------------------
const BASE_ERROR_TEMPLATE = {
  type: 'runtime',
  message: 'Test error',
  stack: '',
  source: 'test.js',
  line: 10,
  column: 0,
  context: { url: 'https://example.com', userAgent: 'TestAgent' },
}

function BASE_ERROR(overrides) {
  return Object.assign({}, BASE_ERROR_TEMPLATE, overrides)
}
