/**
 * background.js — Service Worker
 * Handles lifecycle, tab monitoring, message routing, badge updates,
 * GM_* API bridge, and periodic storage maintenance.
 *
 * Cromite / Android Chromium compatibility notes:
 *  - Uses chrome.action (not browserAction)
 *  - Avoids chrome.windows, chrome.sidePanel, chrome.devtools
 *  - contextMenus may not be available on Android; guarded with optional chaining
 */

import {
  KEYS,
  get,
  set,
  cleanOldErrors,
  checkQuota,
} from './scripts/storage-sync.js'
import {
  getAll as getAllScripts,
  shouldRunOn,
  installFromUrl,
} from './scripts/script-manager.js'
import { getAll as getAllSnippets, matchesUrl } from './scripts/snippet-manager.js'
import { appendError } from './scripts/error-debugger.js'

// ---------------------------------------------------------------------------
// Installation / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await set({
      [KEYS.SETTINGS]: {
        autoInjectEruda: false,
        autoInjectPatterns: [],
        errorCapture: true,
        debugThrottleMs: 100,
        theme: 'Light',
      },
      [KEYS.SNIPPETS]: [],
      [KEYS.USER_SCRIPTS]: [],
      [KEYS.ERROR_LOG]: [],
      [KEYS.ERUDA_ACTIVE_TABS]: {},
    })
  }

  // Set up context menu (desktop Chromium; silently ignored on Android)
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'inject-eruda',
        title: chrome.i18n.getMessage('contextMenuInjectEruda'),
        contexts: ['page'],
      })
      chrome.contextMenus.create({
        id: 'separator',
        type: 'separator',
        contexts: ['page'],
      })
      chrome.contextMenus.create({
        id: 'open-options',
        title: chrome.i18n.getMessage('contextMenuOpenOptions'),
        contexts: ['page'],
      })
    })
  } catch {
    /* context menus not available (Android) */
  }

  await updateBadge()
})

chrome.runtime.onStartup.addListener(async () => {
  await cleanOldErrors()
  await updateBadge()
})

// ---------------------------------------------------------------------------
// Context menu actions
// ---------------------------------------------------------------------------

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab) return
    switch (info.menuItemId) {
      case 'inject-eruda':
        await injectEruda(tab.id, true)
        break
      case 'open-options':
        chrome.runtime.openOptionsPage()
        break
    }
  })
}

// ---------------------------------------------------------------------------
// Tab lifecycle — auto-inject scripts and Eruda when configured
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return

  const settingsResult = await get(KEYS.SETTINGS)
  const settings = settingsResult[KEYS.SETTINGS] || {}

  // Auto-inject Eruda if the URL matches a configured pattern
  if (settings.autoInjectEruda) {
    const patterns = settings.autoInjectPatterns || []
    const matches =
      patterns.length === 0 ||
      patterns.some((p) => {
        try {
          const re = new RegExp(
            '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
          )
          return re.test(tab.url)
        } catch {
          return false
        }
      })
    if (matches) {
      await injectEruda(tabId, false)
    }
  }

  // Notify content script about this tab update so it can run document-end / idle scripts
  try {
    chrome.tabs.sendMessage(tabId, { type: 'TAB_UPDATED', url: tab.url })
  } catch {
    /* content script not present */
  }
})

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }))
  return true // keep channel open for async response
})

async function handleMessage(message, sender) {
  switch (message.type) {
    // -- Eruda activation -------------------------------------------------------
    case 'TOGGLE_ERUDA': {
      const tabId = sender.tab ? sender.tab.id : message.tabId
      return toggleEruda(tabId)
    }

    case 'INJECT_ERUDA': {
      const tabId = sender.tab ? sender.tab.id : message.tabId
      return injectEruda(tabId, true)
    }

    case 'GET_ERUDA_STATE': {
      const tabId = sender.tab ? sender.tab.id : message.tabId
      return getErudaState(tabId)
    }

    // -- Script execution -------------------------------------------------------
    case 'GET_SCRIPTS_FOR_URL': {
      const scripts = await getAllScripts()
      return scripts.filter((s) => shouldRunOn(s, message.url))
    }

    case 'GET_SNIPPETS_FOR_URL': {
      const snippets = await getAllSnippets()
      return snippets.filter((s) => matchesUrl(s, message.url))
    }

    case 'EXECUTE_SNIPPET': {
      // Content script asks background to inject a snippet code string
      const tabId = sender.tab ? sender.tab.id : message.tabId
      return executeCodeInTab(tabId, message.code, message.snippetName)
    }

    case 'INSTALL_SCRIPT_FROM_URL': {
      const script = await installFromUrl(message.url)
      return { success: true, script }
    }

    // -- Error capture ----------------------------------------------------------
    case 'CAPTURE_ERROR': {
      const entry = await appendError(message.payload)
      await updateBadge()
      return { id: entry.id }
    }

    case 'SCRIPT_ERROR': {
      const entry = await appendError({
        type: 'script',
        severity: 'error',
        message: message.error.message,
        stack: message.error.stack,
        source: message.scriptId,
        line: 0,
        column: 0,
        context: {
          url: sender.tab ? sender.tab.url : '',
          userAgent: navigator.userAgent,
          scriptId: message.scriptId,
          scriptName: message.scriptName,
        },
      })
      await updateBadge()
      return { id: entry.id }
    }

    // -- GM_* bridge ------------------------------------------------------------
    case 'GM_setValue': {
      const storageKey = `gm_${message.scriptId}_${message.key}`
      await set({ [storageKey]: message.value })
      return { ok: true }
    }

    case 'GM_getValue': {
      const storageKey = `gm_${message.scriptId}_${message.key}`
      const result = await get(storageKey)
      return { value: result[storageKey] !== undefined ? result[storageKey] : message.defaultValue }
    }

    case 'GM_xmlhttpRequest': {
      return gmXmlhttpRequest(message.details)
    }

    case 'GM_notification': {
      return gmNotification(message.details, message.scriptId)
    }

    // -- Badge reset ------------------------------------------------------------
    case 'RESET_BADGE': {
      await chrome.action.setBadgeText({ text: '' })
      return { ok: true }
    }

    // -- Storage quota info -----------------------------------------------------
    case 'GET_QUOTA': {
      return checkQuota()
    }

    default:
      return { error: 'Unknown message type: ' + message.type }
  }
}

// ---------------------------------------------------------------------------
// Eruda injection helpers
// ---------------------------------------------------------------------------

async function getErudaState(tabId) {
  const result = await get(KEYS.ERUDA_ACTIVE_TABS)
  const activeTabs = result[KEYS.ERUDA_ACTIVE_TABS] || {}
  return { active: !!activeTabs[tabId] }
}

async function setErudaState(tabId, active) {
  const result = await get(KEYS.ERUDA_ACTIVE_TABS)
  const activeTabs = result[KEYS.ERUDA_ACTIVE_TABS] || {}
  if (active) {
    activeTabs[tabId] = true
  } else {
    delete activeTabs[tabId]
  }
  await set({ [KEYS.ERUDA_ACTIVE_TABS]: activeTabs })
}

async function injectEruda(tabId, forceShow) {
  try {
    // Inject eruda library
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/eruda.js'],
    })

    // Initialise and optionally show
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (show) => {
        if (typeof eruda !== 'undefined') {
          if (!eruda._isInit) {
            eruda.init({ useShadowDom: true, autoScale: true })
          }
          if (show) eruda.show()
        }
      },
      args: [forceShow],
      world: 'MAIN',
    })

    await setErudaState(tabId, true)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function toggleEruda(tabId) {
  const state = await getErudaState(tabId)
  if (state.active) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { if (typeof eruda !== 'undefined' && eruda._isInit) eruda.hide() },
        world: 'MAIN',
      })
      await setErudaState(tabId, false)
      return { active: false }
    } catch (err) {
      return { error: err.message }
    }
  } else {
    await injectEruda(tabId, true)
    return { active: true }
  }
}

async function executeCodeInTab(tabId, code) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: new Function(`
        try { ${code} } catch(e) {
          return { __error: true, message: e.message, stack: e.stack };
        }
      `),
      world: 'MAIN',
    })
    const val = results && results[0] && results[0].result
    if (val && val.__error) return { success: false, error: val.message }
    return { success: true, result: val }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// GM_* bridge implementations
// ---------------------------------------------------------------------------

async function gmXmlhttpRequest(details) {
  const { method = 'GET', url, data, headers = {}, responseType = 'text' } = details

  try {
    const init = { method, headers }
    if (data) init.body = data

    const resp = await fetch(url, init)
    let responseText = ''
    let response = null

    if (responseType === 'json') {
      response = await resp.json()
      responseText = JSON.stringify(response)
    } else {
      responseText = await resp.text()
    }

    return {
      status: resp.status,
      statusText: resp.statusText,
      responseText,
      response,
      responseHeaders: Object.fromEntries(resp.headers.entries()),
    }
  } catch (err) {
    return { error: true, message: err.message }
  }
}

async function gmNotification(details) {
  if (chrome.notifications) {
    const opts = {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
      title: details.title || 'User Script',
      message: details.text || '',
    }
    return new Promise((resolve) => {
      chrome.notifications.create(opts, resolve)
    })
  }
  // Fallback: relay to content script to show inside Eruda
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tabs[0]) {
    chrome.tabs.sendMessage(tabs[0].id, {
      type: 'SHOW_NOTIFICATION',
      text: details.text,
      title: details.title,
    })
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Badge management
// ---------------------------------------------------------------------------

async function updateBadge() {
  try {
    const result = await get(KEYS.ERROR_LOG)
    const errors = result[KEYS.ERROR_LOG] || []
    const unresolved = errors.filter((e) => !e.resolved && e.severity !== 'info')

    if (unresolved.length === 0) {
      await chrome.action.setBadgeText({ text: '' })
    } else {
      const label = unresolved.length > 99 ? '99+' : String(unresolved.length)
      await chrome.action.setBadgeText({ text: label })
      await chrome.action.setBadgeBackgroundColor({ color: '#e53935' })
    }
  } catch {
    /* badge API may not be supported */
  }
}

// ---------------------------------------------------------------------------
// Periodic cleanup (every 30 minutes)
// ---------------------------------------------------------------------------

const CLEANUP_INTERVAL_MS = 30 * 60 * 1000

async function periodicCleanup() {
  await cleanOldErrors()
  await updateBadge()
  setTimeout(periodicCleanup, CLEANUP_INTERVAL_MS)
}

setTimeout(periodicCleanup, CLEANUP_INTERVAL_MS)
