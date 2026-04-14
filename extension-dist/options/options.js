/******/ var __webpack_modules__ = ({

/***/ "./extension/scripts/error-debugger.js":
/*!*********************************************!*\
  !*** ./extension/scripts/error-debugger.js ***!
  \*********************************************/
/***/ (function(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   appendError: function() { return /* binding */ appendError; },
/* harmony export */   classify: function() { return /* binding */ classify; },
/* harmony export */   clearAll: function() { return /* binding */ clearAll; },
/* harmony export */   clearResolved: function() { return /* binding */ clearResolved; },
/* harmony export */   fingerprint: function() { return /* binding */ fingerprint; },
/* harmony export */   installCapture: function() { return /* binding */ installCapture; },
/* harmony export */   loadErrors: function() { return /* binding */ loadErrors; },
/* harmony export */   resolveError: function() { return /* binding */ resolveError; },
/* harmony export */   saveErrors: function() { return /* binding */ saveErrors; }
/* harmony export */ });
/* harmony import */ var _storage_sync_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./storage-sync.js */ "./extension/scripts/storage-sync.js");
/**
 * error-debugger.js
 * Intelligent error capture, classification, and suggestion engine.
 * Runs inside the page (injected by content-script.js) and reports
 * errors back to the extension via chrome.runtime.sendMessage.
 */



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

const PATTERNS = [{
  re: /Cannot read propert(?:y|ies)(?: ['"]?(\w+)['"]?)? of (undefined|null)|Cannot read propert(?:y|ies) of (undefined|null)/i,
  suggestion: m => {
    const nullish = m[2] || m[3] || 'undefined/null';
    const prop = m[1] ? `.${m[1]}` : '';
    return `The object is ${nullish} when you try to access "${prop || 'the property'}". ` + `Add a null check or use optional chaining: \`obj?${prop || '.prop'}\`.`;
  },
  type: 'runtime',
  severity: 'error'
}, {
  re: /(\w+) is not defined/i,
  suggestion: m => `"${m[1]}" has not been declared. Check the variable name, scope, ` + 'whether the required script/library is loaded, and import statements.',
  type: 'runtime',
  severity: 'error'
}, {
  re: /SyntaxError/i,
  suggestion: () => 'A syntax error was detected. Check for missing brackets, parentheses, ' + 'or commas near the indicated line.',
  type: 'syntax',
  severity: 'critical'
}, {
  re: /Failed to fetch|NetworkError|net::ERR_/i,
  suggestion: () => 'A network request failed. Verify the URL, your internet connection, and ' + 'that the extension has the required host permissions. ' + 'For cross-origin requests inside a user script use GM_xmlhttpRequest.',
  type: 'network',
  severity: 'error'
}, {
  re: /blocked by CORS policy|Access-Control-Allow-Origin/i,
  suggestion: () => 'The browser blocked a cross-origin request (CORS). In a user script ' + 'use GM_xmlhttpRequest which routes through the background service worker ' + 'and bypasses CORS. Alternatively add the target origin to host_permissions.',
  type: 'network',
  severity: 'error'
}, {
  re: /Content Security Policy|CSP/i,
  suggestion: () => 'The page\'s Content Security Policy blocked an action. ' + 'Consider injecting via chrome.scripting.executeScript (world: MAIN) ' + 'instead of inline script, or use GM_addStyle for styles.',
  type: 'csp',
  severity: 'warning'
}, {
  re: /QuotaExceededError|QUOTA_EXCEEDED_ERR/i,
  suggestion: () => 'Storage quota exceeded. Clear old data via the extension\'s Debug tab, ' + 'or reduce the maximum error log retention period in Settings.',
  type: 'runtime',
  severity: 'warning'
}, {
  re: /Unhandled promise rejection/i,
  suggestion: () => 'A promise was rejected without a .catch() handler. Add error handling: ' + '`somePromise.catch(err => console.error(err))` or use try/await.',
  type: 'promise',
  severity: 'error'
}, {
  re: /Maximum call stack/i,
  suggestion: () => 'Infinite recursion detected. Check for a function that calls itself ' + 'without a proper base case.',
  type: 'runtime',
  severity: 'critical'
}, {
  re: /is not a function/i,
  suggestion: m => `Something expected to be a function is not. Check that the method ` + `exists and that the object it belongs to is properly initialised. ` + `Full message: "${m[0]}"`,
  type: 'runtime',
  severity: 'error'
}];

/**
 * Classify an error message and return type, severity, and suggestion.
 * @param {string} message
 * @returns {{type: ErrorType, severity: ErrorSeverity, suggestion: string|null}}
 */
function classify(message) {
  for (const p of PATTERNS) {
    const m = message.match(p.re);
    if (m) {
      return {
        type: p.type,
        severity: p.severity,
        suggestion: p.suggestion(m)
      };
    }
  }
  return {
    type: 'runtime',
    severity: 'error',
    suggestion: null
  };
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
  return `${message}|${source}|${line}`;
}

// ---------------------------------------------------------------------------
// Storage helpers (called from background service worker side)
// ---------------------------------------------------------------------------

async function loadErrors() {
  const result = await (0,_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.get)(_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.ERROR_LOG);
  return result[_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.ERROR_LOG] || [];
}
async function saveErrors(errors) {
  await (0,_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.set)({
    [_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.ERROR_LOG]: errors
  });
}

/**
 * Append (or increment count of) a DebugError in persistent storage.
 * Called from the background service worker when it receives a CAPTURE_ERROR message.
 * @param {Partial<DebugError>} rawError
 * @returns {Promise<DebugError>}
 */
async function appendError(rawError) {
  const errors = await loadErrors();
  const fp = fingerprint(rawError.message, rawError.source, rawError.line);
  const existing = errors.find(e => !e.resolved && fingerprint(e.message, e.source, e.line) === fp);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.timestamp = rawError.timestamp || Date.now();
    await saveErrors(errors);
    return existing;
  }
  const {
    type,
    severity,
    suggestion
  } = classify(rawError.message || '');

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
    context: rawError.context || {
      url: '',
      userAgent: ''
    },
    suggestion: rawError.suggestion || suggestion,
    severity: rawError.severity || severity,
    resolved: false,
    count: 1
  };
  errors.push(entry);

  // Enforce max entry cap
  const MAX = 500;
  const trimmed = errors.length > MAX ? errors.slice(errors.length - MAX) : errors;
  await saveErrors(trimmed);
  return entry;
}

/**
 * Mark an error as resolved.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function resolveError(id) {
  const errors = await loadErrors();
  const err = errors.find(e => e.id === id);
  if (!err) return false;
  err.resolved = true;
  await saveErrors(errors);
  return true;
}

/**
 * Delete all resolved errors.
 * @returns {Promise<number>} number removed
 */
async function clearResolved() {
  const errors = await loadErrors();
  const active = errors.filter(e => !e.resolved);
  await saveErrors(active);
  return errors.length - active.length;
}

/**
 * Delete all errors.
 * @returns {Promise<void>}
 */
async function clearAll() {
  await saveErrors([]);
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
  const cfg = Object.assign({
    captureGlobalErrors: true,
    capturePromiseRejections: true,
    captureNetworkErrors: true,
    captureCSPViolations: true,
    captureConsoleErrors: true,
    throttleMs: 100
  }, options);
  const lastSent = {};
  function throttled(key, fn) {
    const now = Date.now();
    if (now - (lastSent[key] || 0) < cfg.throttleMs) return;
    lastSent[key] = now;
    fn();
  }
  function report(payload) {
    try {
      chrome.runtime.sendMessage({
        type: 'CAPTURE_ERROR',
        payload
      });
    } catch {
      /* extension context invalidated – ignore */
    }
  }
  const handlers = [];

  // Global runtime errors
  if (cfg.captureGlobalErrors) {
    const handler = event => {
      throttled(event.message, () => {
        report({
          type: 'runtime',
          message: event.message || String(event.error),
          stack: event.error && event.error.stack || '',
          source: event.filename || location.href,
          line: event.lineno || 0,
          column: event.colno || 0,
          context: {
            url: location.href,
            userAgent: navigator.userAgent
          }
        });
      });
    };
    window.addEventListener('error', handler, {
      capture: true
    });
    handlers.push(() => window.removeEventListener('error', handler, {
      capture: true
    }));
  }

  // Unhandled promise rejections
  if (cfg.capturePromiseRejections) {
    const handler = event => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection');
      throttled('promise:' + message, () => {
        report({
          type: 'promise',
          message,
          stack: reason instanceof Error && reason.stack || '',
          source: location.href,
          line: 0,
          column: 0,
          context: {
            url: location.href,
            userAgent: navigator.userAgent
          }
        });
      });
    };
    window.addEventListener('unhandledrejection', handler);
    handlers.push(() => window.removeEventListener('unhandledrejection', handler));
  }

  // CSP violations
  if (cfg.captureCSPViolations) {
    const handler = event => {
      throttled('csp:' + event.violatedDirective, () => {
        report({
          type: 'csp',
          message: `CSP violation: ${event.violatedDirective} — blocked URI: ${event.blockedURI}`,
          stack: '',
          source: event.sourceFile || location.href,
          line: event.lineNumber || 0,
          column: event.columnNumber || 0,
          context: {
            url: location.href,
            userAgent: navigator.userAgent
          },
          severity: 'warning'
        });
      });
    };
    document.addEventListener('securitypolicyviolation', handler);
    handlers.push(() => document.removeEventListener('securitypolicyviolation', handler));
  }

  // Network errors (fetch patch)
  if (cfg.captureNetworkErrors) {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      try {
        const res = await origFetch.apply(this, args);
        if (!res.ok) {
          const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url || '';
          throttled('net:' + res.status + url, () => {
            report({
              type: 'network',
              message: `Network error: ${res.status} ${res.statusText} — ${url}`,
              stack: '',
              source: url,
              line: 0,
              column: 0,
              context: {
                url: location.href,
                userAgent: navigator.userAgent
              },
              severity: 'warning'
            });
          });
        }
        return res;
      } catch (err) {
        const url = typeof args[0] === 'string' ? args[0] : '';
        throttled('net:' + url, () => {
          report({
            type: 'network',
            message: err.message,
            stack: err.stack || '',
            source: url,
            line: 0,
            column: 0,
            context: {
              url: location.href,
              userAgent: navigator.userAgent
            }
          });
        });
        throw err;
      }
    };
    handlers.push(() => {
      window.fetch = origFetch;
    });
  }

  // console.error / console.warn intercept
  if (cfg.captureConsoleErrors) {
    const origError = console.error;
    const origWarn = console.warn;
    console.error = function (...args) {
      origError.apply(this, args);
      const message = args.map(a => a instanceof Error ? a.message : String(a)).join(' ');
      throttled('console.error:' + message, () => {
        report({
          type: 'runtime',
          severity: 'error',
          message,
          stack: args[0] instanceof Error && args[0].stack || '',
          source: location.href,
          line: 0,
          column: 0,
          context: {
            url: location.href,
            userAgent: navigator.userAgent
          }
        });
      });
    };
    console.warn = function (...args) {
      origWarn.apply(this, args);
      const message = args.map(a => String(a)).join(' ');
      throttled('console.warn:' + message, () => {
        report({
          type: 'runtime',
          severity: 'warning',
          message,
          stack: '',
          source: location.href,
          line: 0,
          column: 0,
          context: {
            url: location.href,
            userAgent: navigator.userAgent
          }
        });
      });
    };
    handlers.push(() => {
      console.error = origError;
      console.warn = origWarn;
    });
  }

  // Return uninstall function
  return function uninstall() {
    handlers.forEach(h => h());
  };
}
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : r & 0x3 | 0x8;
    return v.toString(16);
  });
}


/***/ }),

/***/ "./extension/scripts/script-manager.js":
/*!*********************************************!*\
  !*** ./extension/scripts/script-manager.js ***!
  \*********************************************/
/***/ (function(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   buildExecutable: function() { return /* binding */ buildExecutable; },
/* harmony export */   exportScripts: function() { return /* binding */ exportScripts; },
/* harmony export */   getAll: function() { return /* binding */ getAll; },
/* harmony export */   importScripts: function() { return /* binding */ importScripts; },
/* harmony export */   install: function() { return /* binding */ install; },
/* harmony export */   installFromUrl: function() { return /* binding */ installFromUrl; },
/* harmony export */   parseMetadata: function() { return /* binding */ parseMetadata; },
/* harmony export */   shouldRunOn: function() { return /* binding */ shouldRunOn; },
/* harmony export */   toggle: function() { return /* binding */ toggle; },
/* harmony export */   uninstall: function() { return /* binding */ uninstall; },
/* harmony export */   update: function() { return /* binding */ update; },
/* harmony export */   urlMatchesPattern: function() { return /* binding */ urlMatchesPattern; }
/* harmony export */ });
/* harmony import */ var _storage_sync_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./storage-sync.js */ "./extension/scripts/storage-sync.js");
/**
 * script-manager.js
 * Full lifecycle management for Greasemonkey/Tampermonkey-compatible user scripts.
 * Handles parsing, storage, URL matching, and execution (with GM_* API bridge).
 */



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
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : r & 0x3 | 0x8;
    return v.toString(16);
  });
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
    runAt: 'document-idle'
  };
  const blockMatch = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!blockMatch) return meta;
  const block = blockMatch[1];
  const lineRe = /\/\/\s*@(\S+)\s+(.*)/g;
  let m;
  while ((m = lineRe.exec(block)) !== null) {
    const key = m[1].toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = m[2].trim();
    switch (key) {
      case 'name':
      case 'namespace':
      case 'version':
      case 'description':
      case 'author':
        meta[key] = value;
        break;
      case 'match':
      case 'exclude':
      case 'include':
      case 'grant':
      case 'require':
        meta[key].push(value);
        break;
      case 'runAt':
        if (['document-start', 'document-end', 'document-idle'].includes(value)) {
          meta.runAt = value;
        }
        break;
      default:
        break;
    }
  }
  return meta;
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
  if (pattern === '<all_urls>' || pattern === '*') return true;
  try {
    // Convert match-pattern / glob to a RegExp.
    // Escape all regex specials except * which becomes .*
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(url);
  } catch {
    return false;
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
  if (!script.enabled) return false;
  const {
    match,
    include,
    exclude
  } = script.metadata;

  // Check exclusions first
  if (exclude.some(p => urlMatchesPattern(url, p))) return false;

  // Must match at least one @match or @include pattern
  const patterns = [...match, ...include];
  if (patterns.length === 0) return false;
  return patterns.some(p => urlMatchesPattern(url, p));
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getAll() {
  const result = await (0,_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.get)(_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.USER_SCRIPTS);
  return result[_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.USER_SCRIPTS] || [];
}
async function saveAll(scripts) {
  await (0,_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.set)({
    [_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.USER_SCRIPTS]: scripts
  });
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
  const metadata = parseMetadata(code);

  /** @type {UserScript} */
  const script = {
    id: generateId(),
    metadata,
    code,
    enabled: true,
    installUrl,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const scripts = await getAll();
  scripts.push(script);
  await saveAll(scripts);
  return script;
}

/**
 * Install a user script from a remote URL. Fetches the raw source and delegates
 * to `install`. Should only be called from the background service worker where
 * CORS restrictions are less likely to apply.
 * @param {string} url
 * @returns {Promise<UserScript>}
 */
async function installFromUrl(url) {
  let code;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    code = await resp.text();
  } catch (err) {
    throw new Error(`Failed to fetch script from ${url}: ${err.message}`);
  }
  return install(code, url);
}

/**
 * Update an existing script's code and/or metadata.
 * @param {string} id
 * @param {Partial<UserScript>} updates  May include `code` and/or `metadata`.
 * @returns {Promise<UserScript|null>}
 */
async function update(id, updates) {
  const scripts = await getAll();
  const idx = scripts.findIndex(s => s.id === id);
  if (idx === -1) return null;
  if (updates.code && !updates.metadata) {
    updates.metadata = parseMetadata(updates.code);
  }
  scripts[idx] = Object.assign({}, scripts[idx], updates, {
    id,
    updatedAt: Date.now()
  });
  await saveAll(scripts);
  return scripts[idx];
}

/**
 * Toggle the enabled state of a script.
 * @param {string} id
 * @returns {Promise<UserScript|null>}
 */
async function toggle(id) {
  const scripts = await getAll();
  const script = scripts.find(s => s.id === id);
  if (!script) return null;
  return update(id, {
    enabled: !script.enabled
  });
}

/**
 * Uninstall (delete) a script by id.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function uninstall(id) {
  const scripts = await getAll();
  const next = scripts.filter(s => s.id !== id);
  if (next.length === scripts.length) return false;
  await saveAll(next);
  return true;
}

// ---------------------------------------------------------------------------
// Execution — called from the content script via message passing
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe embedding inside a single-quoted JS string literal.
 * Handles backslashes first so they are not double-escaped.
 * @param {string} str
 * @returns {string}
 */
function escapeForStringLiteral(str) {
  return String(str).replace(/\\/g, '\\\\') // backslash must come first
  .replace(/'/g, "\\'") // single quote
  .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/**
 * Build a self-contained IIFE that wraps the user code with a minimal
 * GM_* API shim. The shim communicates with the background via
 * chrome.runtime.sendMessage for privileged operations.
 *
 * @param {UserScript} script
 * @returns {string}  The source string to be executed via chrome.scripting.
 */
function buildExecutable(script) {
  const {
    grant
  } = script.metadata;

  // Pre-escape all metadata strings that will be embedded into the generated source
  const safeId = escapeForStringLiteral(script.id);
  const safeName = escapeForStringLiteral(script.metadata.name);

  // GM_* shim — only include the APIs the script declared via @grant
  const shimParts = [];
  if (grant.includes('GM_log')) {
    shimParts.push(`
      function GM_log(...args) {
        console.log('[UserScript:${safeName}]', ...args);
      }
    `);
  }
  if (grant.includes('GM_addStyle')) {
    shimParts.push(`
      function GM_addStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return style;
      }
    `);
  }
  if (grant.includes('GM_setClipboard')) {
    shimParts.push(`
      function GM_setClipboard(text) {
        navigator.clipboard && navigator.clipboard.writeText(text);
      }
    `);
  }

  // GM_getValue / GM_setValue — stored in chrome.storage via background message
  if (grant.includes('GM_getValue') || grant.includes('GM_setValue')) {
    shimParts.push(`
      function GM_getValue(key, defaultValue) {
        // Synchronous shim: reads from localStorage fallback.
        try {
          const raw = localStorage.getItem('__gm_${safeId}_' + key);
          return raw !== null ? JSON.parse(raw) : defaultValue;
        } catch { return defaultValue; }
      }
      function GM_setValue(key, value) {
        try {
          localStorage.setItem('__gm_${safeId}_' + key, JSON.stringify(value));
        } catch { /* quota exceeded */ }
        // Also persist to chrome.storage via background.
        chrome.runtime.sendMessage({
          type: 'GM_setValue',
          scriptId: '${safeId}',
          key,
          value
        });
      }
    `);
  }
  if (grant.includes('GM_xmlhttpRequest')) {
    shimParts.push(`
      function GM_xmlhttpRequest(details) {
        chrome.runtime.sendMessage(
          { type: 'GM_xmlhttpRequest', scriptId: '${safeId}', details },
          (response) => {
            if (response && response.error && details.onerror) {
              details.onerror(response);
            } else if (response && details.onload) {
              details.onload(response);
            }
          }
        );
      }
    `);
  }
  if (grant.includes('GM_notification')) {
    shimParts.push(`
      function GM_notification(details) {
        chrome.runtime.sendMessage({
          type: 'GM_notification',
          scriptId: '${safeId}',
          details: typeof details === 'string' ? { text: details } : details
        });
      }
    `);
  }
  const unsafeWindowShim = grant.includes('unsafeWindow') ? 'var unsafeWindow = window;' : '';
  return `
    (function() {
      'use strict';
      ${unsafeWindowShim}
      ${shimParts.join('\n')}
      try {
        ${script.code}
      } catch (err) {
        console.error('[UserScript Error:${safeName}]', err);
        chrome.runtime.sendMessage({
          type: 'SCRIPT_ERROR',
          scriptId: '${safeId}',
          scriptName: '${safeName}',
          error: { message: err.message, stack: err.stack }
        });
      }
    })();
  `;
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

/**
 * Export all user scripts as a JSON string.
 * @returns {Promise<string>}
 */
async function exportScripts() {
  const scripts = await getAll();
  return JSON.stringify({
    version: 1,
    userScripts: scripts
  }, null, 2);
}

/**
 * Import scripts from a JSON string. Skips duplicates by id.
 * @param {string} jsonString
 * @returns {Promise<number>} number of newly imported scripts
 */
async function importScripts(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON');
  }
  const incoming = Array.isArray(data) ? data : data.userScripts || [];
  const existing = await getAll();
  const existingIds = new Set(existing.map(s => s.id));
  let added = 0;
  const merged = [...existing];
  incoming.forEach(s => {
    if (existingIds.has(s.id)) return;
    merged.push(Object.assign({}, s, {
      id: s.id || generateId(),
      updatedAt: Date.now()
    }));
    added++;
  });
  await saveAll(merged);
  return added;
}


/***/ }),

/***/ "./extension/scripts/snippet-manager.js":
/*!**********************************************!*\
  !*** ./extension/scripts/snippet-manager.js ***!
  \**********************************************/
/***/ (function(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   clear: function() { return /* binding */ clear; },
/* harmony export */   create: function() { return /* binding */ create; },
/* harmony export */   execute: function() { return /* binding */ execute; },
/* harmony export */   exportSnippets: function() { return /* binding */ exportSnippets; },
/* harmony export */   getAll: function() { return /* binding */ getAll; },
/* harmony export */   importSnippets: function() { return /* binding */ importSnippets; },
/* harmony export */   matchesUrl: function() { return /* binding */ matchesUrl; },
/* harmony export */   remove: function() { return /* binding */ remove; },
/* harmony export */   reorder: function() { return /* binding */ reorder; },
/* harmony export */   update: function() { return /* binding */ update; },
/* harmony export */   urlMatchesPattern: function() { return /* binding */ urlMatchesPattern; }
/* harmony export */ });
/* harmony import */ var _storage_sync_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./storage-sync.js */ "./extension/scripts/storage-sync.js");
/**
 * snippet-manager.js
 * Full CRUD lifecycle for user-defined snippets stored in chrome.storage.local.
 * Snippets can be executed in the active tab via chrome.scripting.executeScript.
 */



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
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : r & 0x3 | 0x8;
    return v.toString(16);
  });
}

/**
 * Load all snippets from storage.
 * @returns {Promise<Snippet[]>}
 */
async function getAll() {
  const result = await (0,_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.get)(_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.SNIPPETS);
  const snippets = result[_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.SNIPPETS] || [];
  return snippets.slice().sort((a, b) => a.order - b.order);
}

/**
 * Persist the full array to storage.
 * @param {Snippet[]} snippets
 * @returns {Promise<void>}
 */
async function saveAll(snippets) {
  await (0,_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.set)({
    [_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__.KEYS.SNIPPETS]: snippets
  });
}

/**
 * Create a new snippet.
 * @param {Partial<Snippet>} data
 * @returns {Promise<Snippet>}
 */
async function create(data) {
  const snippets = await getAll();
  const maxOrder = snippets.reduce((m, s) => Math.max(m, s.order), -1);

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
    updatedAt: Date.now()
  };
  snippets.push(snippet);
  await saveAll(snippets);
  return snippet;
}

/**
 * Update an existing snippet by id.
 * @param {string} id
 * @param {Partial<Snippet>} updates
 * @returns {Promise<Snippet|null>}
 */
async function update(id, updates) {
  const snippets = await getAll();
  const idx = snippets.findIndex(s => s.id === id);
  if (idx === -1) return null;
  snippets[idx] = Object.assign({}, snippets[idx], updates, {
    id,
    updatedAt: Date.now()
  });
  await saveAll(snippets);
  return snippets[idx];
}

/**
 * Delete a snippet by id.
 * @param {string} id
 * @returns {Promise<boolean>} true if a snippet was deleted
 */
async function remove(id) {
  const snippets = await getAll();
  const next = snippets.filter(s => s.id !== id);
  if (next.length === snippets.length) return false;
  await saveAll(next);
  return true;
}

/**
 * Delete all snippets.
 * @returns {Promise<void>}
 */
async function clear() {
  await saveAll([]);
}

/**
 * Reorder snippets. `orderedIds` should contain all snippet IDs in the
 * desired display order.
 * @param {string[]} orderedIds
 * @returns {Promise<void>}
 */
async function reorder(orderedIds) {
  const snippets = await getAll();
  const map = Object.fromEntries(snippets.map(s => [s.id, s]));
  const reordered = orderedIds.filter(id => map[id]).map((id, idx) => Object.assign({}, map[id], {
    order: idx
  }));
  await saveAll(reordered);
}

/**
 * Execute a snippet's code in the given tab (defaults to active tab).
 * Returns the result or an error object.
 * @param {string|Snippet} snippetOrId
 * @param {number} [tabId]
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
async function execute(snippetOrId, tabId) {
  let snippet;
  if (typeof snippetOrId === 'string') {
    const snippets = await getAll();
    snippet = snippets.find(s => s.id === snippetOrId);
    if (!snippet) return {
      success: false,
      error: 'Snippet not found'
    };
  } else {
    snippet = snippetOrId;
  }
  if (!snippet.enabled) {
    return {
      success: false,
      error: 'Snippet is disabled'
    };
  }
  let target;
  if (tabId) {
    target = {
      tabId
    };
  } else {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (!activeTab) return {
      success: false,
      error: 'No active tab'
    };
    target = {
      tabId: activeTab.id
    };
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
  `;
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: new Function(wrappedCode),
      world: 'MAIN'
    });
    const value = results && results[0] && results[0].result;
    if (value && value.__erudaError) {
      return {
        success: false,
        error: value.message,
        stack: value.stack
      };
    }
    return {
      success: true,
      result: value
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
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
  if (!snippet.autoRun || !snippet.enabled) return false;
  if (!snippet.runOn || snippet.runOn.length === 0) return false;
  return snippet.runOn.some(pattern => urlMatchesPattern(url, pattern));
}

/**
 * Minimal Chrome match-pattern checker. Handles `<all_urls>` and patterns of
 * the form `scheme://host/path` where * is a wildcard.
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function urlMatchesPattern(url, pattern) {
  if (pattern === '<all_urls>') return true;
  try {
    // Escape regex special chars except * which becomes .*
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(url);
  } catch {
    return false;
  }
}

/**
 * Export snippets as a JSON string.
 * @returns {Promise<string>}
 */
async function exportSnippets() {
  const snippets = await getAll();
  return JSON.stringify({
    version: 1,
    snippets
  }, null, 2);
}

/**
 * Import snippets from a JSON string. Skips duplicates by id.
 * @param {string} jsonString
 * @returns {Promise<number>} number of newly imported snippets
 */
async function importSnippets(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON');
  }
  const incoming = Array.isArray(data) ? data : data.snippets || [];
  const existing = await getAll();
  const existingIds = new Set(existing.map(s => s.id));
  const maxOrder = existing.reduce((m, s) => Math.max(m, s.order), -1);
  let added = 0;
  const merged = [...existing];
  incoming.forEach((s, i) => {
    if (existingIds.has(s.id)) return;
    merged.push(Object.assign({}, s, {
      id: s.id || generateId(),
      order: maxOrder + 1 + i,
      updatedAt: Date.now()
    }));
    added++;
  });
  await saveAll(merged);
  return added;
}


/***/ }),

/***/ "./extension/scripts/storage-sync.js":
/*!*******************************************!*\
  !*** ./extension/scripts/storage-sync.js ***!
  \*******************************************/
/***/ (function(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   KEYS: function() { return /* binding */ KEYS; },
/* harmony export */   checkQuota: function() { return /* binding */ checkQuota; },
/* harmony export */   cleanOldErrors: function() { return /* binding */ cleanOldErrors; },
/* harmony export */   exportAll: function() { return /* binding */ exportAll; },
/* harmony export */   get: function() { return /* binding */ get; },
/* harmony export */   getBytesInUse: function() { return /* binding */ getBytesInUse; },
/* harmony export */   importAll: function() { return /* binding */ importAll; },
/* harmony export */   remove: function() { return /* binding */ remove; },
/* harmony export */   set: function() { return /* binding */ set; }
/* harmony export */ });
/**
 * storage-sync.js
 * Centralized storage management for the Eruda Cromite extension.
 * Provides a clean API over chrome.storage.local with quota monitoring,
 * automatic cleanup of old error logs, and convenience helpers.
 */

const STORAGE_WARNING_THRESHOLD = 0.8; // 80% of quota
const MAX_STORAGE_BYTES = 10 * 1024 * 1024; // 10 MB

const KEYS = {
  SNIPPETS: 'eruda_snippets',
  USER_SCRIPTS: 'eruda_user_scripts',
  ERROR_LOG: 'eruda_error_log',
  SETTINGS: 'eruda_settings',
  ERUDA_ACTIVE_TABS: 'eruda_active_tabs'
};
const ERROR_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ERROR_LOG_MAX_ENTRIES = 500;

/**
 * Read one or more keys from chrome.storage.local.
 * @param {string|string[]} keys
 * @returns {Promise<Object>}
 */
async function get(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
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
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
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
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Get the current storage usage in bytes.
 * @returns {Promise<number>}
 */
async function getBytesInUse() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.getBytesInUse(null, bytesInUse => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(bytesInUse);
      }
    });
  });
}

/**
 * Check if storage usage is above the warning threshold.
 * @returns {Promise<{bytesInUse: number, quota: number, overThreshold: boolean}>}
 */
async function checkQuota() {
  const bytesInUse = await getBytesInUse();
  const quota = MAX_STORAGE_BYTES;
  return {
    bytesInUse,
    quota,
    overThreshold: bytesInUse / quota > STORAGE_WARNING_THRESHOLD,
    usagePercent: Math.round(bytesInUse / quota * 100)
  };
}

/**
 * Remove error log entries older than ERROR_LOG_MAX_AGE_MS and enforce
 * the maximum entry cap. Called periodically by the background service worker.
 */
async function cleanOldErrors() {
  const result = await get(KEYS.ERROR_LOG);
  let errors = result[KEYS.ERROR_LOG] || [];
  const cutoff = Date.now() - ERROR_LOG_MAX_AGE_MS;
  errors = errors.filter(e => e.timestamp > cutoff);
  if (errors.length > ERROR_LOG_MAX_ENTRIES) {
    errors = errors.slice(errors.length - ERROR_LOG_MAX_ENTRIES);
  }
  await set({
    [KEYS.ERROR_LOG]: errors
  });
  return errors.length;
}

/**
 * Export all extension data as a JSON string for backup.
 * @returns {Promise<string>}
 */
async function exportAll() {
  const result = await get([KEYS.SNIPPETS, KEYS.USER_SCRIPTS, KEYS.SETTINGS]);
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    snippets: result[KEYS.SNIPPETS] || [],
    userScripts: result[KEYS.USER_SCRIPTS] || [],
    settings: result[KEYS.SETTINGS] || {}
  }, null, 2);
}

/**
 * Import data from a previously exported JSON string. Merges by default;
 * pass replace=true to completely replace existing data.
 * @param {string} jsonString
 * @param {boolean} replace
 * @returns {Promise<{snippets: number, userScripts: number}>}
 */
async function importAll(jsonString, replace = false) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON backup file');
  }
  if (!data.version || data.version !== 1) {
    throw new Error('Unsupported backup version');
  }
  const toWrite = {};
  if (replace) {
    toWrite[KEYS.SNIPPETS] = data.snippets || [];
    toWrite[KEYS.USER_SCRIPTS] = data.userScripts || [];
    toWrite[KEYS.SETTINGS] = data.settings || {};
  } else {
    const existing = await get([KEYS.SNIPPETS, KEYS.USER_SCRIPTS, KEYS.SETTINGS]);
    const existingSnippets = existing[KEYS.SNIPPETS] || [];
    const importedSnippets = data.snippets || [];
    const existingIds = new Set(existingSnippets.map(s => s.id));
    const newSnippets = importedSnippets.filter(s => !existingIds.has(s.id));
    toWrite[KEYS.SNIPPETS] = [...existingSnippets, ...newSnippets];
    const existingScripts = existing[KEYS.USER_SCRIPTS] || [];
    const importedScripts = data.userScripts || [];
    const existingScriptIds = new Set(existingScripts.map(s => s.id));
    const newScripts = importedScripts.filter(s => !existingScriptIds.has(s.id));
    toWrite[KEYS.USER_SCRIPTS] = [...existingScripts, ...newScripts];
    toWrite[KEYS.SETTINGS] = Object.assign({}, existing[KEYS.SETTINGS] || {}, data.settings || {});
  }
  await set(toWrite);
  return {
    snippets: (toWrite[KEYS.SNIPPETS] || []).length,
    userScripts: (toWrite[KEYS.USER_SCRIPTS] || []).length
  };
}


/***/ })

/******/ });
/************************************************************************/
/******/ // The module cache
/******/ var __webpack_module_cache__ = {};
/******/ 
/******/ // The require function
/******/ function __webpack_require__(moduleId) {
/******/ 	// Check if module is in cache
/******/ 	var cachedModule = __webpack_module_cache__[moduleId];
/******/ 	if (cachedModule !== undefined) {
/******/ 		return cachedModule.exports;
/******/ 	}
/******/ 	// Create a new module (and put it into the cache)
/******/ 	var module = __webpack_module_cache__[moduleId] = {
/******/ 		// no module.id needed
/******/ 		// no module.loaded needed
/******/ 		exports: {}
/******/ 	};
/******/ 
/******/ 	// Execute the module function
/******/ 	if (!(moduleId in __webpack_modules__)) {
/******/ 		delete __webpack_module_cache__[moduleId];
/******/ 		var e = new Error("Cannot find module '" + moduleId + "'");
/******/ 		e.code = 'MODULE_NOT_FOUND';
/******/ 		throw e;
/******/ 	}
/******/ 	__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 
/******/ 	// Return the exports of the module
/******/ 	return module.exports;
/******/ }
/******/ 
/************************************************************************/
/******/ /* webpack/runtime/define property getters */
/******/ !function() {
/******/ 	// define getter functions for harmony exports
/******/ 	__webpack_require__.d = function(exports, definition) {
/******/ 		for(var key in definition) {
/******/ 			if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/ }();
/******/ 
/******/ /* webpack/runtime/hasOwnProperty shorthand */
/******/ !function() {
/******/ 	__webpack_require__.o = function(obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); }
/******/ }();
/******/ 
/******/ /* webpack/runtime/make namespace object */
/******/ !function() {
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = function(exports) {
/******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		}
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/ }();
/******/ 
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
!function() {
/*!**************************************!*\
  !*** ./extension/options/options.js ***!
  \**************************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../scripts/script-manager.js */ "./extension/scripts/script-manager.js");
/* harmony import */ var _scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../scripts/snippet-manager.js */ "./extension/scripts/snippet-manager.js");
/* harmony import */ var _scripts_error_debugger_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../scripts/error-debugger.js */ "./extension/scripts/error-debugger.js");
/* harmony import */ var _scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../scripts/storage-sync.js */ "./extension/scripts/storage-sync.js");
/**
 * options.js — Options page controller.
 * Handles the Scripts, Snippets, Debug, and Settings tabs.
 */






// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------
async function main() {
  applyI18n();
  initTabs();
  await renderScripts();
  await renderSnippets();
  await renderErrors();
  await renderSettings();
  bindGlobalEvents();
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
function initTabs() {
  const btns = document.querySelectorAll('.tab-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === `tab-${target}`);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// SCRIPTS TAB
// ---------------------------------------------------------------------------
let editingScriptId = null;
async function renderScripts() {
  const scripts = await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.getAll)();
  const list = document.getElementById('scripts-list');
  if (!list) return;
  if (scripts.length === 0) {
    list.innerHTML = `<li class="empty-state">${msg('emptyScripts')}</li>`;
    return;
  }
  list.innerHTML = '';
  scripts.forEach(s => {
    const li = buildScriptItem(s);
    list.appendChild(li);
  });
}
function buildScriptItem(s) {
  const li = document.createElement('li');
  li.className = `item-row ${s.enabled ? '' : 'item-disabled'}`;
  li.dataset.id = s.id;
  li.innerHTML = `
    <div class="item-info">
      <span class="item-name">${esc(s.metadata.name)}</span>
      <span class="item-desc">${esc(s.metadata.description || s.metadata.version || '')}</span>
    </div>
    <div class="item-actions">
      <label class="switch mini">
        <input type="checkbox" class="item-toggle" ${s.enabled ? 'checked' : ''} />
        <span class="slider"></span>
      </label>
      <button class="btn-icon item-edit" title="Edit">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      </button>
      <button class="btn-icon btn-danger-icon item-delete" title="Uninstall">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>
  `;
  li.querySelector('.item-toggle').addEventListener('change', async () => {
    await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.toggle)(s.id);
    await renderScripts();
  });
  li.querySelector('.item-edit').addEventListener('click', () => openScriptEditor(s));
  li.querySelector('.item-delete').addEventListener('click', async () => {
    if (!confirm(`Uninstall "${s.metadata.name}"?`)) return;
    await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.uninstall)(s.id);
    await renderScripts();
  });
  return li;
}
function openScriptEditor(script) {
  editingScriptId = script ? script.id : null;
  const panel = document.getElementById('script-editor');
  const title = document.getElementById('editor-script-title');
  const nameInput = document.getElementById('editor-script-name');
  const descInput = document.getElementById('editor-script-desc');
  const matchInput = document.getElementById('editor-script-match');
  const runatSelect = document.getElementById('editor-script-runat');
  const codeArea = document.getElementById('editor-script-code');
  if (script) {
    title.textContent = script.metadata.name;
    nameInput.value = script.metadata.name;
    descInput.value = script.metadata.description;
    matchInput.value = (script.metadata.match || []).join('\n');
    runatSelect.value = script.metadata.runAt || 'document-idle';
    codeArea.value = script.code;
  } else {
    title.textContent = msg('editorNewScript');
    nameInput.value = '';
    descInput.value = '';
    matchInput.value = '';
    runatSelect.value = 'document-idle';
    codeArea.value = '';
  }
  panel.hidden = false;
  panel.scrollIntoView({
    behavior: 'smooth'
  });
  codeArea.focus();
}
function closeScriptEditor() {
  document.getElementById('script-editor').hidden = true;
  editingScriptId = null;
}
async function saveScriptEditor() {
  const nameInput = document.getElementById('editor-script-name');
  const descInput = document.getElementById('editor-script-desc');
  const matchInput = document.getElementById('editor-script-match');
  const runatSelect = document.getElementById('editor-script-runat');
  const codeArea = document.getElementById('editor-script-code');
  let code = codeArea.value.trim();
  if (!code) {
    toast(msg('errorEmptyCode') || 'Code cannot be empty', 'error');
    return;
  }

  // Build metadata header from fields if user hasn't written their own
  const hasHeader = /\/\/\s*==UserScript==/i.test(code);
  if (!hasHeader) {
    const name = nameInput.value.trim() || 'My Script';
    const desc = descInput.value.trim();
    const matches = matchInput.value.trim().split(/\s*[\n,]\s*/).filter(Boolean);
    const runat = runatSelect.value;
    const matchLines = matches.map(m => `// @match       ${m}`).join('\n');
    const header = ['// ==UserScript==', `// @name        ${name}`, desc ? `// @description ${desc}` : null, matchLines || null, `// @run-at      ${runat}`, '// ==/UserScript=='].filter(Boolean).join('\n');
    code = `${header}\n\n${code}`;
  }
  try {
    if (editingScriptId) {
      await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.update)(editingScriptId, {
        code
      });
    } else {
      await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.install)(code);
    }
    closeScriptEditor();
    await renderScripts();
    toast(msg('savedOk') || 'Saved!', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// SNIPPETS TAB
// ---------------------------------------------------------------------------
let editingSnippetId = null;
async function renderSnippets() {
  const snippets = await (0,_scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__.getAll)();
  const list = document.getElementById('snippets-list');
  if (!list) return;
  if (snippets.length === 0) {
    list.innerHTML = `<li class="empty-state">${msg('emptySnippets')}</li>`;
    return;
  }
  list.innerHTML = '';
  snippets.forEach(s => {
    const li = buildSnippetItem(s);
    list.appendChild(li);
  });
}
function buildSnippetItem(s) {
  const li = document.createElement('li');
  li.className = `item-row ${s.enabled ? '' : 'item-disabled'}`;
  li.dataset.id = s.id;
  li.innerHTML = `
    <div class="item-info">
      <span class="item-name">${esc(s.name)}</span>
      <span class="item-desc">${esc(s.description || '')}</span>
    </div>
    <div class="item-actions">
      <label class="switch mini">
        <input type="checkbox" class="item-toggle" ${s.enabled ? 'checked' : ''} />
        <span class="slider"></span>
      </label>
      <button class="btn-icon item-edit" title="Edit">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      </button>
      <button class="btn-icon btn-danger-icon item-delete" title="Delete">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>
  `;
  li.querySelector('.item-toggle').addEventListener('change', async e => {
    await (0,_scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__.update)(s.id, {
      enabled: e.target.checked
    });
    await renderSnippets();
  });
  li.querySelector('.item-edit').addEventListener('click', () => openSnippetEditor(s));
  li.querySelector('.item-delete').addEventListener('click', async () => {
    if (!confirm(`Delete snippet "${s.name}"?`)) return;
    await (0,_scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__.remove)(s.id);
    await renderSnippets();
  });
  return li;
}
function openSnippetEditor(snippet) {
  editingSnippetId = snippet ? snippet.id : null;
  const panel = document.getElementById('snippet-editor');
  const title = document.getElementById('editor-snippet-title');
  if (snippet) {
    title.textContent = snippet.name;
    document.getElementById('editor-snippet-name').value = snippet.name;
    document.getElementById('editor-snippet-desc').value = snippet.description || '';
    document.getElementById('editor-snippet-runon').value = (snippet.runOn || []).join(', ');
    document.getElementById('editor-snippet-autorun').checked = !!snippet.autoRun;
    document.getElementById('editor-snippet-enabled').checked = snippet.enabled !== false;
    document.getElementById('editor-snippet-code').value = snippet.code;
  } else {
    title.textContent = msg('editorNewSnippet');
    document.getElementById('editor-snippet-name').value = '';
    document.getElementById('editor-snippet-desc').value = '';
    document.getElementById('editor-snippet-runon').value = '';
    document.getElementById('editor-snippet-autorun').checked = false;
    document.getElementById('editor-snippet-enabled').checked = true;
    document.getElementById('editor-snippet-code').value = '';
  }
  panel.hidden = false;
  panel.scrollIntoView({
    behavior: 'smooth'
  });
  document.getElementById('editor-snippet-name').focus();
}
function closeSnippetEditor() {
  document.getElementById('snippet-editor').hidden = true;
  editingSnippetId = null;
}
async function saveSnippetEditor() {
  const name = document.getElementById('editor-snippet-name').value.trim();
  const description = document.getElementById('editor-snippet-desc').value.trim();
  const runOnRaw = document.getElementById('editor-snippet-runon').value.trim();
  const autoRun = document.getElementById('editor-snippet-autorun').checked;
  const enabled = document.getElementById('editor-snippet-enabled').checked;
  const code = document.getElementById('editor-snippet-code').value.trim();
  if (!name) {
    toast(msg('errorEmptyName') || 'Name is required', 'error');
    return;
  }
  const runOn = runOnRaw ? runOnRaw.split(/\s*,\s*|\s*\n\s*/).filter(Boolean) : [];
  const data = {
    name,
    description,
    code,
    enabled,
    autoRun,
    runOn
  };
  try {
    if (editingSnippetId) {
      await (0,_scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__.update)(editingSnippetId, data);
    } else {
      await (0,_scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__.create)(data);
    }
    closeSnippetEditor();
    await renderSnippets();
    toast(msg('savedOk') || 'Saved!', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// DEBUG TAB
// ---------------------------------------------------------------------------
async function renderErrors(filterType, filterSeverity) {
  let errors = await (0,_scripts_error_debugger_js__WEBPACK_IMPORTED_MODULE_2__.loadErrors)();
  if (filterType) errors = errors.filter(e => e.type === filterType);
  if (filterSeverity) errors = errors.filter(e => e.severity === filterSeverity);
  // Newest first
  errors = errors.slice().reverse();
  const list = document.getElementById('error-list');
  if (!list) return;
  if (errors.length === 0) {
    list.innerHTML = `<li class="empty-state">${msg('emptyErrors')}</li>`;
    return;
  }
  list.innerHTML = '';
  errors.forEach(e => {
    const li = document.createElement('li');
    li.className = `error-item severity-${e.severity} ${e.resolved ? 'resolved' : ''}`;
    li.dataset.id = e.id;
    const countBadge = e.count > 1 ? `<span class="count-badge">×${e.count}</span>` : '';
    const timestamp = new Date(e.timestamp).toLocaleString();
    const scriptName = e.context && e.context.scriptName ? ` <em>(${esc(e.context.scriptName)})</em>` : '';
    li.innerHTML = `
      <div class="error-header">
        <span class="error-type-badge type-${e.type}">${e.type}</span>
        <span class="error-severity sev-${e.severity}">${e.severity}</span>
        ${countBadge}
        <span class="error-time">${timestamp}</span>
        ${!e.resolved ? `<button class="btn-ghost btn-sm dismiss-btn" title="Dismiss">✓</button>` : '<span class="resolved-badge">✓ resolved</span>'}
      </div>
      <div class="error-message">${esc(e.message)}${scriptName}</div>
      ${e.suggestion ? `<div class="error-suggestion">💡 ${esc(e.suggestion)}</div>` : ''}
      ${e.stack ? `<details class="stack-details"><summary>Stack trace</summary><pre class="stack-trace">${esc(e.stack)}</pre></details>` : ''}
    `;
    const dismissBtn = li.querySelector('.dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', async () => {
        await (0,_scripts_error_debugger_js__WEBPACK_IMPORTED_MODULE_2__.resolveError)(e.id);
        await renderErrors(document.getElementById('debug-filter-type').value, document.getElementById('debug-filter-severity').value);
      });
    }
    list.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// SETTINGS TAB
// ---------------------------------------------------------------------------
async function renderSettings() {
  const result = await (0,_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.get)(_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.KEYS.SETTINGS);
  const settings = result[_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.KEYS.SETTINGS] || {};
  const autoInjectEl = document.getElementById('setting-auto-inject');
  const patternsEl = document.getElementById('setting-inject-patterns');
  const errorCaptureEl = document.getElementById('setting-error-capture');
  const throttleEl = document.getElementById('setting-throttle-ms');
  if (autoInjectEl) autoInjectEl.checked = !!settings.autoInjectEruda;
  if (patternsEl) patternsEl.value = (settings.autoInjectPatterns || []).join('\n');
  if (errorCaptureEl) errorCaptureEl.checked = settings.errorCapture !== false;
  if (throttleEl) throttleEl.value = settings.debugThrottleMs || 100;

  // Quota info
  const quota = await (0,_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.checkQuota)();
  const quotaEl = document.getElementById('quota-info');
  if (quotaEl) {
    quotaEl.textContent = `Storage: ${formatBytes(quota.bytesInUse)} / ${formatBytes(quota.quota)} (${quota.usagePercent}%)`;
    if (quota.overThreshold) quotaEl.classList.add('quota-warning');
  }
}
async function saveSettings() {
  const autoInjectEruda = document.getElementById('setting-auto-inject').checked;
  const patternsRaw = document.getElementById('setting-inject-patterns').value.trim();
  const errorCapture = document.getElementById('setting-error-capture').checked;
  const debugThrottleMs = parseInt(document.getElementById('setting-throttle-ms').value, 10) || 100;
  const autoInjectPatterns = patternsRaw ? patternsRaw.split('\n').map(l => l.trim()).filter(Boolean) : [];
  await (0,_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.set)({
    [_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.KEYS.SETTINGS]: {
      autoInjectEruda,
      autoInjectPatterns,
      errorCapture,
      debugThrottleMs
    }
  });
  toast(msg('savedOk') || 'Saved!', 'ok');
}

// ---------------------------------------------------------------------------
// Global event bindings
// ---------------------------------------------------------------------------
function bindGlobalEvents() {
  // ---- Scripts ----
  document.getElementById('btn-add-script').addEventListener('click', () => openScriptEditor(null));
  document.getElementById('btn-editor-cancel').addEventListener('click', closeScriptEditor);
  document.getElementById('btn-editor-save').addEventListener('click', saveScriptEditor);
  document.getElementById('btn-import-script').addEventListener('click', () => {
    triggerFileImport(async (text, file) => {
      if (file.name.endsWith('.user.js') || file.name.endsWith('.js')) {
        await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.install)(text);
        await renderScripts();
        toast(`Installed: ${(0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.parseMetadata)(text).name}`, 'ok');
      } else {
        const count = await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.importScripts)(text);
        await renderScripts();
        toast(`Imported ${count} script(s)`, 'ok');
      }
    });
  });
  document.getElementById('btn-export-scripts').addEventListener('click', async () => {
    const json = await (0,_scripts_script_manager_js__WEBPACK_IMPORTED_MODULE_0__.exportScripts)();
    downloadFile(json, 'eruda-scripts.json', 'application/json');
  });

  // URL install bar
  document.getElementById('btn-install-url').addEventListener('click', async () => {
    const url = document.getElementById('script-url-input').value.trim();
    if (!url) return;
    try {
      const script = await chrome.runtime.sendMessage({
        type: 'INSTALL_SCRIPT_FROM_URL',
        url
      });
      if (script && script.error) throw new Error(script.error);
      await renderScripts();
      document.getElementById('url-install-bar').hidden = true;
      toast(`Installed: ${script.script?.metadata?.name || 'Unknown'}`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  document.getElementById('btn-cancel-url').addEventListener('click', () => {
    document.getElementById('url-install-bar').hidden = true;
  });

  // ---- Snippets ----
  document.getElementById('btn-add-snippet').addEventListener('click', () => openSnippetEditor(null));
  document.getElementById('btn-snippet-editor-cancel').addEventListener('click', closeSnippetEditor);
  document.getElementById('btn-snippet-editor-save').addEventListener('click', saveSnippetEditor);
  document.getElementById('btn-import-snippet').addEventListener('click', () => {
    triggerFileImport(async text => {
      const count = await (0,_scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__.importSnippets)(text);
      await renderSnippets();
      toast(`Imported ${count} snippet(s)`, 'ok');
    });
  });
  document.getElementById('btn-export-snippets').addEventListener('click', async () => {
    const json = await (0,_scripts_snippet_manager_js__WEBPACK_IMPORTED_MODULE_1__.exportSnippets)();
    downloadFile(json, 'eruda-snippets.json', 'application/json');
  });

  // ---- Debug ----
  document.getElementById('btn-clear-resolved').addEventListener('click', async () => {
    const n = await (0,_scripts_error_debugger_js__WEBPACK_IMPORTED_MODULE_2__.clearResolved)();
    await renderErrors();
    toast(`Cleared ${n} resolved error(s)`, 'ok');
  });
  document.getElementById('btn-clear-errors').addEventListener('click', async () => {
    if (!confirm('Clear all error logs?')) return;
    await (0,_scripts_error_debugger_js__WEBPACK_IMPORTED_MODULE_2__.clearAll)();
    await renderErrors();
    toast('Error log cleared', 'ok');
  });
  document.getElementById('debug-filter-type').addEventListener('change', async e => {
    await renderErrors(e.target.value, document.getElementById('debug-filter-severity').value);
  });
  document.getElementById('debug-filter-severity').addEventListener('change', async e => {
    await renderErrors(document.getElementById('debug-filter-type').value, e.target.value);
  });

  // ---- Settings ----
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-backup').addEventListener('click', async () => {
    const json = await (0,_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.exportAll)();
    downloadFile(json, `eruda-backup-${Date.now()}.json`, 'application/json');
  });
  document.getElementById('btn-restore').addEventListener('click', () => {
    triggerFileImport(async text => {
      const counts = await (0,_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.importAll)(text);
      await renderScripts();
      await renderSnippets();
      await renderSettings();
      toast(`Restored: ${counts.snippets} snippets, ${counts.userScripts} scripts`, 'ok');
    });
  });
  document.getElementById('btn-export-all').addEventListener('click', async () => {
    const json = await (0,_scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_3__.exportAll)();
    downloadFile(json, `eruda-backup-${Date.now()}.json`, 'application/json');
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function msg(key) {
  return chrome.i18n.getMessage(key) || '';
}
function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function downloadFile(text, filename, mimeType) {
  const blob = new Blob([text], {
    type: mimeType
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function triggerFileImport(callback) {
  const input = document.getElementById('file-import');
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        await callback(e.target.result, file);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    reader.readAsText(file);
    input.value = '';
  };
  input.click();
}
let toastTimer = null;
function toast(text, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.className = `toast toast-${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}
main().catch(console.error);
}();

//# sourceMappingURL=options.js.map