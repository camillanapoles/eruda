/**
 * content-script.js
 * Injected into every page (document_idle). Responsible for:
 *  1. Listening for TOGGLE_ERUDA / INJECT_ERUDA commands from the popup / background.
 *  2. Running user scripts and auto-run snippets that match the current URL.
 *  3. Installing the error capture listeners and relaying errors to the background.
 *  4. Forwarding GM_* notification messages to Eruda's notification API.
 */

;(async function () {
  'use strict'

  // Guard: run only once per navigation.
  if (window.__erudaExtensionInstalled) return
  window.__erudaExtensionInstalled = true

  const currentUrl = location.href

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  let settings = {}
  try {
    const result = await chrome.storage.local.get('eruda_settings')
    settings = result['eruda_settings'] || {}
  } catch {
    /* storage unavailable */
  }

  // ---------------------------------------------------------------------------
  // Error capture
  // ---------------------------------------------------------------------------
  if (settings.errorCapture !== false) {
    installErrorCapture({ throttleMs: settings.debugThrottleMs || 100 })
  }

  // ---------------------------------------------------------------------------
  // Execute user scripts and auto-run snippets for this URL
  // ---------------------------------------------------------------------------
  const [scriptsData, snippetsData] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_SCRIPTS_FOR_URL', url: currentUrl }),
    chrome.runtime.sendMessage({ type: 'GET_SNIPPETS_FOR_URL', url: currentUrl }),
  ])

  const scripts = Array.isArray(scriptsData) ? scriptsData : []
  const snippets = Array.isArray(snippetsData) ? snippetsData : []

  // Run document-start scripts immediately (they are actually document_idle here
  // because content scripts run at document_idle by default; a future improvement
  // is to add a separate manifest content_scripts entry for document_start).
  const startScripts = scripts.filter((s) => s.metadata.runAt === 'document-start')
  const endScripts = scripts.filter((s) => s.metadata.runAt !== 'document-start')

  startScripts.forEach((s) => injectUserScript(s))

  // document-end scripts: run after DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      endScripts
        .filter((s) => s.metadata.runAt === 'document-end')
        .forEach((s) => injectUserScript(s))
    })
  } else {
    endScripts
      .filter((s) => s.metadata.runAt === 'document-end')
      .forEach((s) => injectUserScript(s))
  }

  // document-idle scripts: run when browser is idle
  const idleCallback = window.requestIdleCallback || ((fn) => setTimeout(fn, 200))
  idleCallback(() => {
    endScripts
      .filter((s) => s.metadata.runAt === 'document-idle' || !s.metadata.runAt)
      .forEach((s) => injectUserScript(s))

    // Auto-run snippets
    snippets.forEach((snippet) => executeSnippet(snippet))
  })

  // ---------------------------------------------------------------------------
  // Message listener (from popup / background)
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'TAB_UPDATED':
        // Swallow — used by background to trigger tab-level logic
        sendResponse({ ok: true })
        break

      case 'SHOW_NOTIFICATION':
        showNotification(message.title, message.text)
        sendResponse({ ok: true })
        break

      case 'RUN_SNIPPET_IN_PAGE':
        executeSnippetCode(message.code, message.name)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ success: false, error: err.message }))
        return true // async

      default:
        sendResponse({ error: 'Unknown message type: ' + message.type })
    }
  })

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Inject a user script into the page via a <script> element in MAIN world.
   * @param {Object} script  UserScript object from storage
   */
  function injectUserScript(script) {
    const el = document.createElement('script')
    el.textContent = buildUserScriptWrapper(script)
    el.setAttribute('data-eruda-script-id', script.id)
    ;(document.head || document.documentElement).appendChild(el)
    el.remove()
  }

  /**
   * Build an IIFE that wraps the user script with minimal GM_* shims.
   * Mirror of script-manager.js:buildExecutable but runs synchronously in page.
   * @param {Object} script
   * @returns {string}
   */
  function buildUserScriptWrapper(script) {
    const { grant = [] } = script.metadata || {}
    const shims = []

    if (grant.includes('GM_log')) {
      shims.push(`function GM_log() { console.log.apply(console, ['[${escAttr(script.metadata.name)}]'].concat([].slice.call(arguments))); }`)
    }
    if (grant.includes('GM_addStyle')) {
      shims.push(`function GM_addStyle(css){var s=document.createElement('style');s.textContent=css;document.head.appendChild(s);}`)
    }
    if (grant.includes('GM_setClipboard')) {
      shims.push(`function GM_setClipboard(t){navigator.clipboard&&navigator.clipboard.writeText(t);}`)
    }
    if (grant.includes('unsafeWindow')) {
      shims.push(`var unsafeWindow=window;`)
    }

    const name = escAttr(script.metadata.name)
    const id = escAttr(script.id)

    return `(function(){
      'use strict';
      ${shims.join('\n')}
      try {
        ${script.code}
      } catch(err) {
        console.error('[UserScript Error:${name}]', err);
        (window.__erudaReportError || function(){})(
          {type:'script',severity:'error',message:err.message,stack:err.stack,
           source:'${id}',line:0,column:0,
           context:{url:location.href,userAgent:navigator.userAgent,
                    scriptId:'${id}',scriptName:'${name}'}}
        );
      }
    })();`
  }

  /**
   * Execute a snippet object.
   * @param {Object} snippet
   */
  async function executeSnippet(snippet) {
    try {
      await executeSnippetCode(snippet.code, snippet.name)
    } catch {
      /* errors already captured by the error capture layer */
    }
  }

  /**
   * Execute arbitrary code in the page by injecting a <script> tag.
   * @param {string} code
   * @param {string} [name]
   * @returns {Promise<{success: boolean}>}
   */
  function executeSnippetCode(code, name) {
    return new Promise((resolve) => {
      const el = document.createElement('script')
      el.textContent = `(function(){try{${code}}catch(e){console.error('[Snippet:${escAttr(name || '')}]',e);}})();`
      ;(document.head || document.documentElement).appendChild(el)
      el.remove()
      resolve({ success: true })
    })
  }

  /**
   * Show a notification using Eruda's notification API if available,
   * or fall back to a simple console message.
   * @param {string} title
   * @param {string} text
   */
  function showNotification(title, text) {
    try {
      if (typeof eruda !== 'undefined' && eruda._isInit && eruda.get) {
        const devTools = eruda.get()
        if (devTools && devTools.notify) {
          devTools.notify(`${title}: ${text}`, { duration: 4000 })
          return
        }
      }
    } catch {
      /* Eruda not available */
    }
    console.info(`[Eruda Extension] ${title}: ${text}`)
  }

  /**
   * Install global error capture and relay to background.
   * @param {Object} options
   */
  function installErrorCapture(options) {
    const throttleMs = options.throttleMs || 100
    const lastSent = {}

    function throttled(key, fn) {
      const now = Date.now()
      if (now - (lastSent[key] || 0) < throttleMs) return
      lastSent[key] = now
      fn()
    }

    function report(payload) {
      try {
        chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', payload })
      } catch {
        /* extension context invalidated */
      }
    }

    // Expose for user script wrappers above
    window.__erudaReportError = report

    window.addEventListener(
      'error',
      (event) => {
        throttled(event.message, () => {
          report({
            type: 'runtime',
            message: event.message || String(event.error),
            stack: (event.error && event.error.stack) || '',
            source: event.filename || location.href,
            line: event.lineno || 0,
            column: event.colno || 0,
            context: { url: location.href, userAgent: navigator.userAgent },
          })
        })
      },
      { capture: true }
    )

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason
      const msg =
        reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection')
      throttled('promise:' + msg, () => {
        report({
          type: 'promise',
          message: msg,
          stack: (reason instanceof Error && reason.stack) || '',
          source: location.href,
          line: 0,
          column: 0,
          context: { url: location.href, userAgent: navigator.userAgent },
        })
      })
    })

    document.addEventListener('securitypolicyviolation', (event) => {
      throttled('csp:' + event.violatedDirective, () => {
        report({
          type: 'csp',
          severity: 'warning',
          message: `CSP violation: ${event.violatedDirective} — blocked URI: ${event.blockedURI}`,
          stack: '',
          source: event.sourceFile || location.href,
          line: event.lineNumber || 0,
          column: event.columnNumber || 0,
          context: { url: location.href, userAgent: navigator.userAgent },
        })
      })
    })
  }

  /**
   * Escape a string for safe embedding in an attribute/template literal.
   * @param {string} str
   * @returns {string}
   */
  function escAttr(str) {
    return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/`/g, '\\`')
  }
})()
