/**
 * popup.js — Controls the extension popup UI.
 */

import '../scripts/storage-sync.js' // side-effect: sets up chrome.storage access

async function main() {
  await applyI18n()
  await loadState()
  bindEvents()
}

// ---------------------------------------------------------------------------
// i18n helper
// ---------------------------------------------------------------------------
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    const msg = chrome.i18n.getMessage(key)
    if (msg) el.textContent = msg
  })
}

// ---------------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------------
async function loadState() {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return

  // Eruda toggle state
  const state = await chrome.runtime.sendMessage({ type: 'GET_ERUDA_STATE', tabId: tab.id })
  const toggle = document.getElementById('eruda-toggle')
  if (toggle) toggle.checked = !!(state && state.active)

  // Scripts active on current URL
  const scripts = await chrome.runtime.sendMessage({
    type: 'GET_SCRIPTS_FOR_URL',
    url: tab.url,
  })
  const scriptCount = Array.isArray(scripts) ? scripts.length : 0
  const scriptsCountEl = document.getElementById('scripts-count')
  if (scriptsCountEl) scriptsCountEl.textContent = scriptCount

  // All snippets
  const result = await chrome.storage.local.get('eruda_snippets')
  const snippets = result['eruda_snippets'] || []
  const snippetsCountEl = document.getElementById('snippets-count')
  if (snippetsCountEl) snippetsCountEl.textContent = snippets.length

  renderSnippetList(snippets, tab.id)

  // Unresolved errors
  const errResult = await chrome.storage.local.get('eruda_error_log')
  const errors = (errResult['eruda_error_log'] || []).filter((e) => !e.resolved)
  const errCountEl = document.getElementById('errors-count')
  if (errCountEl) {
    errCountEl.textContent = errors.length
    if (errors.length > 0) {
      document.getElementById('stat-errors').classList.add('has-errors')
    }
  }
}

// ---------------------------------------------------------------------------
// Snippet list
// ---------------------------------------------------------------------------
function renderSnippetList(snippets, tabId) {
  const list = document.getElementById('snippet-list')
  if (!list) return

  const enabled = snippets.filter((s) => s.enabled)

  if (enabled.length === 0) {
    list.innerHTML = `<li class="empty-hint">${chrome.i18n.getMessage('popupNoSnippets') || 'No snippets yet'}</li>`
    return
  }

  list.innerHTML = ''
  // Show at most 5 snippets for quick access
  const shown = enabled.slice(0, 5)
  shown.forEach((snippet) => {
    const li = document.createElement('li')
    li.className = 'snippet-item'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'snippet-name'
    nameSpan.textContent = snippet.name

    const runBtn = document.createElement('button')
    runBtn.className = 'btn-run'
    runBtn.setAttribute('aria-label', `Run ${snippet.name}`)
    runBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>'
    runBtn.dataset.snippetId = snippet.id

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true
      runBtn.classList.add('running')
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'EXECUTE_SNIPPET',
          tabId,
          code: snippet.code,
          snippetName: snippet.name,
        })
        if (res && res.success === false) {
          showStatus(res.error || 'Error', 'error')
        } else {
          showStatus(chrome.i18n.getMessage('popupSnippetRan') || 'Snippet executed', 'ok')
        }
      } catch (err) {
        showStatus(err.message, 'error')
      } finally {
        runBtn.disabled = false
        runBtn.classList.remove('running')
      }
    })

    li.appendChild(nameSpan)
    li.appendChild(runBtn)
    list.appendChild(li)
  })

  if (enabled.length > 5) {
    const moreHint = document.createElement('li')
    moreHint.className = 'more-hint'
    const remaining = enabled.length - 5
    moreHint.textContent =
      (chrome.i18n.getMessage('popupMoreSnippets') || `+${remaining} more — open Options`).replace('{n}', remaining)
    list.appendChild(moreHint)
  }
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------
function bindEvents() {
  // Eruda toggle
  const toggle = document.getElementById('eruda-toggle')
  if (toggle) {
    toggle.addEventListener('change', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab) return
      try {
        const res = await chrome.runtime.sendMessage({ type: 'TOGGLE_ERUDA', tabId: tab.id })
        if (res && res.error) {
          showStatus(res.error, 'error')
          toggle.checked = !toggle.checked
        }
      } catch (err) {
        showStatus(err.message, 'error')
        toggle.checked = !toggle.checked
      }
    })
  }

  // Manage snippets link
  const manageBtn = document.getElementById('manage-snippets')
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage()
    })
  }

  // Options button
  const optionsBtn = document.getElementById('btn-options')
  if (optionsBtn) {
    optionsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage()
    })
  }

  // Reset badge when popup opens
  chrome.runtime.sendMessage({ type: 'RESET_BADGE' })
}

// ---------------------------------------------------------------------------
// Status message
// ---------------------------------------------------------------------------
let statusTimer = null
function showStatus(text, type) {
  const el = document.getElementById('status-msg')
  if (!el) return
  el.textContent = text
  el.className = `status-msg status-${type}`
  el.hidden = false
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    el.hidden = true
  }, 3000)
}

main().catch(console.error)
