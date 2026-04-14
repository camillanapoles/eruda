/******/ var __webpack_modules__ = ({

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
/*!**********************************!*\
  !*** ./extension/popup/popup.js ***!
  \**********************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _scripts_storage_sync_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../scripts/storage-sync.js */ "./extension/scripts/storage-sync.js");
/**
 * popup.js — Controls the extension popup UI.
 */

 // side-effect: sets up chrome.storage access

async function main() {
  await applyI18n();
  await loadState();
  bindEvents();
}

// ---------------------------------------------------------------------------
// i18n helper
// ---------------------------------------------------------------------------
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

// ---------------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------------
async function loadState() {
  // Get the active tab
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab) return;

  // Eruda toggle state
  const state = await chrome.runtime.sendMessage({
    type: 'GET_ERUDA_STATE',
    tabId: tab.id
  });
  const toggle = document.getElementById('eruda-toggle');
  if (toggle) toggle.checked = !!(state && state.active);

  // Scripts active on current URL
  const scripts = await chrome.runtime.sendMessage({
    type: 'GET_SCRIPTS_FOR_URL',
    url: tab.url
  });
  const scriptCount = Array.isArray(scripts) ? scripts.length : 0;
  const scriptsCountEl = document.getElementById('scripts-count');
  if (scriptsCountEl) scriptsCountEl.textContent = scriptCount;

  // All snippets
  const result = await chrome.storage.local.get('eruda_snippets');
  const snippets = result['eruda_snippets'] || [];
  const snippetsCountEl = document.getElementById('snippets-count');
  if (snippetsCountEl) snippetsCountEl.textContent = snippets.length;
  renderSnippetList(snippets, tab.id);

  // Unresolved errors
  const errResult = await chrome.storage.local.get('eruda_error_log');
  const errors = (errResult['eruda_error_log'] || []).filter(e => !e.resolved);
  const errCountEl = document.getElementById('errors-count');
  if (errCountEl) {
    errCountEl.textContent = errors.length;
    if (errors.length > 0) {
      document.getElementById('stat-errors').classList.add('has-errors');
    }
  }
}

// ---------------------------------------------------------------------------
// Snippet list
// ---------------------------------------------------------------------------
function renderSnippetList(snippets, tabId) {
  const list = document.getElementById('snippet-list');
  if (!list) return;
  const enabled = snippets.filter(s => s.enabled);
  if (enabled.length === 0) {
    list.innerHTML = `<li class="empty-hint">${chrome.i18n.getMessage('popupNoSnippets') || 'No snippets yet'}</li>`;
    return;
  }
  list.innerHTML = '';
  // Show at most 5 snippets for quick access
  const shown = enabled.slice(0, 5);
  shown.forEach(snippet => {
    const li = document.createElement('li');
    li.className = 'snippet-item';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'snippet-name';
    nameSpan.textContent = snippet.name;
    const runBtn = document.createElement('button');
    runBtn.className = 'btn-run';
    runBtn.setAttribute('aria-label', `Run ${snippet.name}`);
    runBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>';
    runBtn.dataset.snippetId = snippet.id;
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.classList.add('running');
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'EXECUTE_SNIPPET',
          tabId,
          code: snippet.code,
          snippetName: snippet.name
        });
        if (res && res.success === false) {
          showStatus(res.error || 'Error', 'error');
        } else {
          showStatus(chrome.i18n.getMessage('popupSnippetRan') || 'Snippet executed', 'ok');
        }
      } catch (err) {
        showStatus(err.message, 'error');
      } finally {
        runBtn.disabled = false;
        runBtn.classList.remove('running');
      }
    });
    li.appendChild(nameSpan);
    li.appendChild(runBtn);
    list.appendChild(li);
  });
  if (enabled.length > 5) {
    const moreHint = document.createElement('li');
    moreHint.className = 'more-hint';
    const remaining = enabled.length - 5;
    moreHint.textContent = (chrome.i18n.getMessage('popupMoreSnippets') || `+${remaining} more — open Options`).replace('{n}', remaining);
    list.appendChild(moreHint);
  }
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------
function bindEvents() {
  // Eruda toggle
  const toggle = document.getElementById('eruda-toggle');
  if (toggle) {
    toggle.addEventListener('change', async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });
      if (!tab) return;
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'TOGGLE_ERUDA',
          tabId: tab.id
        });
        if (res && res.error) {
          showStatus(res.error, 'error');
          toggle.checked = !toggle.checked;
        }
      } catch (err) {
        showStatus(err.message, 'error');
        toggle.checked = !toggle.checked;
      }
    });
  }

  // Manage snippets link
  const manageBtn = document.getElementById('manage-snippets');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // Options button
  const optionsBtn = document.getElementById('btn-options');
  if (optionsBtn) {
    optionsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // Reset badge when popup opens
  chrome.runtime.sendMessage({
    type: 'RESET_BADGE'
  });
}

// ---------------------------------------------------------------------------
// Status message
// ---------------------------------------------------------------------------
let statusTimer = null;
function showStatus(text, type) {
  const el = document.getElementById('status-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg status-${type}`;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}
main().catch(console.error);
}();

//# sourceMappingURL=popup.js.map