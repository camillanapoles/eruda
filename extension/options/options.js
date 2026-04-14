/**
 * options.js — Options page controller.
 * Handles the Scripts, Snippets, Debug, and Settings tabs.
 */

import {
  getAll as getAllScripts,
  install as installScript,
  update as updateScript,
  toggle as toggleScript,
  uninstall,
  parseMetadata,
  exportScripts,
  importScripts,
} from '../scripts/script-manager.js'

import {
  getAll as getAllSnippets,
  create as createSnippet,
  update as updateSnippet,
  remove as removeSnippet,
  exportSnippets,
  importSnippets,
} from '../scripts/snippet-manager.js'

import {
  loadErrors,
  resolveError,
  clearResolved,
  clearAll as clearAllErrors,
} from '../scripts/error-debugger.js'

import {
  KEYS,
  get,
  set,
  exportAll,
  importAll,
  checkQuota,
} from '../scripts/storage-sync.js'

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------
async function main() {
  applyI18n()
  initTabs()
  await renderScripts()
  await renderSnippets()
  await renderErrors()
  await renderSettings()
  bindGlobalEvents()
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    const msg = chrome.i18n.getMessage(key)
    if (msg) el.textContent = msg
  })
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
function initTabs() {
  const btns = document.querySelectorAll('.tab-btn')
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      btns.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      const target = btn.dataset.tab
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${target}`)
      })
    })
  })
}

// ---------------------------------------------------------------------------
// SCRIPTS TAB
// ---------------------------------------------------------------------------
let editingScriptId = null

async function renderScripts() {
  const scripts = await getAllScripts()
  const list = document.getElementById('scripts-list')
  if (!list) return

  if (scripts.length === 0) {
    list.innerHTML = `<li class="empty-state">${msg('emptyScripts')}</li>`
    return
  }

  list.innerHTML = ''
  scripts.forEach((s) => {
    const li = buildScriptItem(s)
    list.appendChild(li)
  })
}

function buildScriptItem(s) {
  const li = document.createElement('li')
  li.className = `item-row ${s.enabled ? '' : 'item-disabled'}`
  li.dataset.id = s.id

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
  `

  li.querySelector('.item-toggle').addEventListener('change', async () => {
    await toggleScript(s.id)
    await renderScripts()
  })

  li.querySelector('.item-edit').addEventListener('click', () => openScriptEditor(s))

  li.querySelector('.item-delete').addEventListener('click', async () => {
    if (!confirm(`Uninstall "${s.metadata.name}"?`)) return
    await uninstall(s.id)
    await renderScripts()
  })

  return li
}

function openScriptEditor(script) {
  editingScriptId = script ? script.id : null
  const panel = document.getElementById('script-editor')
  const title = document.getElementById('editor-script-title')
  const nameInput = document.getElementById('editor-script-name')
  const descInput = document.getElementById('editor-script-desc')
  const matchInput = document.getElementById('editor-script-match')
  const runatSelect = document.getElementById('editor-script-runat')
  const codeArea = document.getElementById('editor-script-code')

  if (script) {
    title.textContent = script.metadata.name
    nameInput.value = script.metadata.name
    descInput.value = script.metadata.description
    matchInput.value = (script.metadata.match || []).join('\n')
    runatSelect.value = script.metadata.runAt || 'document-idle'
    codeArea.value = script.code
  } else {
    title.textContent = msg('editorNewScript')
    nameInput.value = ''
    descInput.value = ''
    matchInput.value = ''
    runatSelect.value = 'document-idle'
    codeArea.value = ''
  }

  panel.hidden = false
  panel.scrollIntoView({ behavior: 'smooth' })
  codeArea.focus()
}

function closeScriptEditor() {
  document.getElementById('script-editor').hidden = true
  editingScriptId = null
}

async function saveScriptEditor() {
  const nameInput = document.getElementById('editor-script-name')
  const descInput = document.getElementById('editor-script-desc')
  const matchInput = document.getElementById('editor-script-match')
  const runatSelect = document.getElementById('editor-script-runat')
  const codeArea = document.getElementById('editor-script-code')

  let code = codeArea.value.trim()
  if (!code) {
    toast(msg('errorEmptyCode') || 'Code cannot be empty', 'error')
    return
  }

  // Build metadata header from fields if user hasn't written their own
  const hasHeader = /\/\/\s*==UserScript==/i.test(code)
  if (!hasHeader) {
    const name = nameInput.value.trim() || 'My Script'
    const desc = descInput.value.trim()
    const matches = matchInput.value.trim().split(/\s*[\n,]\s*/).filter(Boolean)
    const runat = runatSelect.value
    const matchLines = matches.map((m) => `// @match       ${m}`).join('\n')
    const header = [
      '// ==UserScript==',
      `// @name        ${name}`,
      desc ? `// @description ${desc}` : null,
      matchLines || null,
      `// @run-at      ${runat}`,
      '// ==/UserScript==',
    ]
      .filter(Boolean)
      .join('\n')
    code = `${header}\n\n${code}`
  }

  try {
    if (editingScriptId) {
      await updateScript(editingScriptId, { code })
    } else {
      await installScript(code)
    }
    closeScriptEditor()
    await renderScripts()
    toast(msg('savedOk') || 'Saved!', 'ok')
  } catch (err) {
    toast(err.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// SNIPPETS TAB
// ---------------------------------------------------------------------------
let editingSnippetId = null

async function renderSnippets() {
  const snippets = await getAllSnippets()
  const list = document.getElementById('snippets-list')
  if (!list) return

  if (snippets.length === 0) {
    list.innerHTML = `<li class="empty-state">${msg('emptySnippets')}</li>`
    return
  }

  list.innerHTML = ''
  snippets.forEach((s) => {
    const li = buildSnippetItem(s)
    list.appendChild(li)
  })
}

function buildSnippetItem(s) {
  const li = document.createElement('li')
  li.className = `item-row ${s.enabled ? '' : 'item-disabled'}`
  li.dataset.id = s.id

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
  `

  li.querySelector('.item-toggle').addEventListener('change', async (e) => {
    await updateSnippet(s.id, { enabled: e.target.checked })
    await renderSnippets()
  })

  li.querySelector('.item-edit').addEventListener('click', () => openSnippetEditor(s))

  li.querySelector('.item-delete').addEventListener('click', async () => {
    if (!confirm(`Delete snippet "${s.name}"?`)) return
    await removeSnippet(s.id)
    await renderSnippets()
  })

  return li
}

function openSnippetEditor(snippet) {
  editingSnippetId = snippet ? snippet.id : null
  const panel = document.getElementById('snippet-editor')
  const title = document.getElementById('editor-snippet-title')

  if (snippet) {
    title.textContent = snippet.name
    document.getElementById('editor-snippet-name').value = snippet.name
    document.getElementById('editor-snippet-desc').value = snippet.description || ''
    document.getElementById('editor-snippet-runon').value = (snippet.runOn || []).join(', ')
    document.getElementById('editor-snippet-autorun').checked = !!snippet.autoRun
    document.getElementById('editor-snippet-enabled').checked = snippet.enabled !== false
    document.getElementById('editor-snippet-code').value = snippet.code
  } else {
    title.textContent = msg('editorNewSnippet')
    document.getElementById('editor-snippet-name').value = ''
    document.getElementById('editor-snippet-desc').value = ''
    document.getElementById('editor-snippet-runon').value = ''
    document.getElementById('editor-snippet-autorun').checked = false
    document.getElementById('editor-snippet-enabled').checked = true
    document.getElementById('editor-snippet-code').value = ''
  }

  panel.hidden = false
  panel.scrollIntoView({ behavior: 'smooth' })
  document.getElementById('editor-snippet-name').focus()
}

function closeSnippetEditor() {
  document.getElementById('snippet-editor').hidden = true
  editingSnippetId = null
}

async function saveSnippetEditor() {
  const name = document.getElementById('editor-snippet-name').value.trim()
  const description = document.getElementById('editor-snippet-desc').value.trim()
  const runOnRaw = document.getElementById('editor-snippet-runon').value.trim()
  const autoRun = document.getElementById('editor-snippet-autorun').checked
  const enabled = document.getElementById('editor-snippet-enabled').checked
  const code = document.getElementById('editor-snippet-code').value.trim()

  if (!name) {
    toast(msg('errorEmptyName') || 'Name is required', 'error')
    return
  }

  const runOn = runOnRaw
    ? runOnRaw.split(/\s*,\s*|\s*\n\s*/).filter(Boolean)
    : []

  const data = { name, description, code, enabled, autoRun, runOn }

  try {
    if (editingSnippetId) {
      await updateSnippet(editingSnippetId, data)
    } else {
      await createSnippet(data)
    }
    closeSnippetEditor()
    await renderSnippets()
    toast(msg('savedOk') || 'Saved!', 'ok')
  } catch (err) {
    toast(err.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// DEBUG TAB
// ---------------------------------------------------------------------------
async function renderErrors(filterType, filterSeverity) {
  let errors = await loadErrors()
  if (filterType) errors = errors.filter((e) => e.type === filterType)
  if (filterSeverity) errors = errors.filter((e) => e.severity === filterSeverity)
  // Newest first
  errors = errors.slice().reverse()

  const list = document.getElementById('error-list')
  if (!list) return

  if (errors.length === 0) {
    list.innerHTML = `<li class="empty-state">${msg('emptyErrors')}</li>`
    return
  }

  list.innerHTML = ''
  errors.forEach((e) => {
    const li = document.createElement('li')
    li.className = `error-item severity-${e.severity} ${e.resolved ? 'resolved' : ''}`
    li.dataset.id = e.id

    const countBadge = e.count > 1 ? `<span class="count-badge">×${e.count}</span>` : ''
    const timestamp = new Date(e.timestamp).toLocaleString()
    const scriptName = e.context && e.context.scriptName
      ? ` <em>(${esc(e.context.scriptName)})</em>`
      : ''

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
    `

    const dismissBtn = li.querySelector('.dismiss-btn')
    if (dismissBtn) {
      dismissBtn.addEventListener('click', async () => {
        await resolveError(e.id)
        await renderErrors(
          document.getElementById('debug-filter-type').value,
          document.getElementById('debug-filter-severity').value
        )
      })
    }

    list.appendChild(li)
  })
}

// ---------------------------------------------------------------------------
// SETTINGS TAB
// ---------------------------------------------------------------------------
async function renderSettings() {
  const result = await get(KEYS.SETTINGS)
  const settings = result[KEYS.SETTINGS] || {}

  const autoInjectEl = document.getElementById('setting-auto-inject')
  const patternsEl = document.getElementById('setting-inject-patterns')
  const errorCaptureEl = document.getElementById('setting-error-capture')
  const throttleEl = document.getElementById('setting-throttle-ms')

  if (autoInjectEl) autoInjectEl.checked = !!settings.autoInjectEruda
  if (patternsEl) patternsEl.value = (settings.autoInjectPatterns || []).join('\n')
  if (errorCaptureEl) errorCaptureEl.checked = settings.errorCapture !== false
  if (throttleEl) throttleEl.value = settings.debugThrottleMs || 100

  // Quota info
  const quota = await checkQuota()
  const quotaEl = document.getElementById('quota-info')
  if (quotaEl) {
    quotaEl.textContent = `Storage: ${formatBytes(quota.bytesInUse)} / ${formatBytes(quota.quota)} (${quota.usagePercent}%)`
    if (quota.overThreshold) quotaEl.classList.add('quota-warning')
  }
}

async function saveSettings() {
  const autoInjectEruda = document.getElementById('setting-auto-inject').checked
  const patternsRaw = document.getElementById('setting-inject-patterns').value.trim()
  const errorCapture = document.getElementById('setting-error-capture').checked
  const debugThrottleMs = parseInt(document.getElementById('setting-throttle-ms').value, 10) || 100

  const autoInjectPatterns = patternsRaw
    ? patternsRaw.split('\n').map((l) => l.trim()).filter(Boolean)
    : []

  await set({
    [KEYS.SETTINGS]: { autoInjectEruda, autoInjectPatterns, errorCapture, debugThrottleMs },
  })
  toast(msg('savedOk') || 'Saved!', 'ok')
}

// ---------------------------------------------------------------------------
// Global event bindings
// ---------------------------------------------------------------------------
function bindGlobalEvents() {
  // ---- Scripts ----
  document.getElementById('btn-add-script').addEventListener('click', () => openScriptEditor(null))
  document.getElementById('btn-editor-cancel').addEventListener('click', closeScriptEditor)
  document.getElementById('btn-editor-save').addEventListener('click', saveScriptEditor)

  document.getElementById('btn-import-script').addEventListener('click', () => {
    triggerFileImport(async (text, file) => {
      if (file.name.endsWith('.user.js') || file.name.endsWith('.js')) {
        await installScript(text)
        await renderScripts()
        toast(`Installed: ${parseMetadata(text).name}`, 'ok')
      } else {
        const count = await importScripts(text)
        await renderScripts()
        toast(`Imported ${count} script(s)`, 'ok')
      }
    })
  })

  document.getElementById('btn-export-scripts').addEventListener('click', async () => {
    const json = await exportScripts()
    downloadFile(json, 'eruda-scripts.json', 'application/json')
  })

  // URL install bar
  document.getElementById('btn-install-url').addEventListener('click', async () => {
    const url = document.getElementById('script-url-input').value.trim()
    if (!url) return
    try {
      const script = await chrome.runtime.sendMessage({ type: 'INSTALL_SCRIPT_FROM_URL', url })
      if (script && script.error) throw new Error(script.error)
      await renderScripts()
      document.getElementById('url-install-bar').hidden = true
      toast(`Installed: ${script.script?.metadata?.name || 'Unknown'}`, 'ok')
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  document.getElementById('btn-cancel-url').addEventListener('click', () => {
    document.getElementById('url-install-bar').hidden = true
  })

  // ---- Snippets ----
  document.getElementById('btn-add-snippet').addEventListener('click', () => openSnippetEditor(null))
  document.getElementById('btn-snippet-editor-cancel').addEventListener('click', closeSnippetEditor)
  document.getElementById('btn-snippet-editor-save').addEventListener('click', saveSnippetEditor)

  document.getElementById('btn-import-snippet').addEventListener('click', () => {
    triggerFileImport(async (text) => {
      const count = await importSnippets(text)
      await renderSnippets()
      toast(`Imported ${count} snippet(s)`, 'ok')
    })
  })

  document.getElementById('btn-export-snippets').addEventListener('click', async () => {
    const json = await exportSnippets()
    downloadFile(json, 'eruda-snippets.json', 'application/json')
  })

  // ---- Debug ----
  document.getElementById('btn-clear-resolved').addEventListener('click', async () => {
    const n = await clearResolved()
    await renderErrors()
    toast(`Cleared ${n} resolved error(s)`, 'ok')
  })

  document.getElementById('btn-clear-errors').addEventListener('click', async () => {
    if (!confirm('Clear all error logs?')) return
    await clearAllErrors()
    await renderErrors()
    toast('Error log cleared', 'ok')
  })

  document.getElementById('debug-filter-type').addEventListener('change', async (e) => {
    await renderErrors(e.target.value, document.getElementById('debug-filter-severity').value)
  })

  document.getElementById('debug-filter-severity').addEventListener('change', async (e) => {
    await renderErrors(document.getElementById('debug-filter-type').value, e.target.value)
  })

  // ---- Settings ----
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings)

  document.getElementById('btn-backup').addEventListener('click', async () => {
    const json = await exportAll()
    downloadFile(json, `eruda-backup-${Date.now()}.json`, 'application/json')
  })

  document.getElementById('btn-restore').addEventListener('click', () => {
    triggerFileImport(async (text) => {
      const counts = await importAll(text)
      await renderScripts()
      await renderSnippets()
      await renderSettings()
      toast(`Restored: ${counts.snippets} snippets, ${counts.userScripts} scripts`, 'ok')
    })
  })

  document.getElementById('btn-export-all').addEventListener('click', async () => {
    const json = await exportAll()
    downloadFile(json, `eruda-backup-${Date.now()}.json`, 'application/json')
  })
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function msg(key) {
  return chrome.i18n.getMessage(key) || ''
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function downloadFile(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function triggerFileImport(callback) {
  const input = document.getElementById('file-import')
  input.onchange = () => {
    const file = input.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        await callback(e.target.result, file)
      } catch (err) {
        toast(err.message, 'error')
      }
    }
    reader.readAsText(file)
    input.value = ''
  }
  input.click()
}

let toastTimer = null
function toast(text, type = 'ok') {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = text
  el.className = `toast toast-${type}`
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.hidden = true
  }, 3000)
}

main().catch(console.error)
