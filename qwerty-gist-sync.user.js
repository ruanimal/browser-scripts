// ==UserScript==
// @name         Qwerty Learner - Gist 云同步
// @namespace    https://github.com/
// @version      1.0.13
// @description  为 Qwerty Learner 添加 GitHub Gist 数据同步功能（IndexedDB + localStorage 配置）
// @author       ruan
// @match        https://qwerty.kaiyi.cool/*
// @updateURL    https://github.com/ruanimal/browser-scripts/raw/master/qwerty-gist-sync.user.js
// @downloadURL  https://github.com/ruanimal/browser-scripts/raw/master/qwerty-gist-sync.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
// @require      https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.min.js
// @require      https://cdn.jsdelivr.net/npm/dexie-export-import@4/dist/dexie-export-import.js
// ==/UserScript==

; (function () {
  'use strict'

  // ─────────────────────────────────────────────────────────
  // 常量
  // ─────────────────────────────────────────────────────────
  const DB_NAME = 'RecordDB'
  const GIST_API = 'https://api.github.com/gists'
  const GIST_DESCRIPTION = 'Qwerty Learner sync data'
  const DB_FILE_NAME = 'qwerty-db.gz.b64'
  const META_FILE_NAME = 'qwerty-meta.json'
  const PANEL_ID = 'ql-gist-sync-panel'

  /** 需要同步的 localStorage key（与 src/store/gistSyncAtom.ts 保持一致） */
  const CONFIG_KEYS = [
    'currentDict',
    'currentChapter',
    'loopWordConfig',
    'keySoundsConfig',
    'hintSoundsConfig',
    'pronunciation',
    'fontsize',
    'randomConfig',
    'isShowPrevAndNextWord',
    'isIgnoreCase',
    'isShowAnswerOnHover',
    'isTextSelectable',
    'phoneticConfig',
    'isOpenDarkModeAtom',
    'wordDictationConfig',
    'hasSeenEnhancedPromotion',
  ]

  // ─────────────────────────────────────────────────────────
  // 持久化状态（用 GM_getValue/GM_setValue 存储，不暴露给页面 JS）
  // ─────────────────────────────────────────────────────────
  function getConfig() {
    return {
      token: GM_getValue('token', ''),
      gistId: GM_getValue('gistId', ''),
      lastSyncAt: GM_getValue('lastSyncAt', 0),
      lastSyncDictId: GM_getValue('lastSyncDictId', ''),
      lastSyncChapter: GM_getValue('lastSyncChapter', 0),
      autoSync: GM_getValue('autoSync', false),
    }
  }

  function saveConfig(partial) {
    if ('token' in partial) GM_setValue('token', partial.token)
    if ('gistId' in partial) GM_setValue('gistId', partial.gistId)
    if ('lastSyncAt' in partial) GM_setValue('lastSyncAt', partial.lastSyncAt)
    if ('lastSyncDictId' in partial) GM_setValue('lastSyncDictId', partial.lastSyncDictId)
    if ('lastSyncChapter' in partial) GM_setValue('lastSyncChapter', partial.lastSyncChapter)
    if ('autoSync' in partial) GM_setValue('autoSync', partial.autoSync)
  }

  // ─────────────────────────────────────────────────────────
  // localStorage 读写（配置同步）
  // ─────────────────────────────────────────────────────────
  function readLocalConfig() {
    const result = {}
    for (const key of CONFIG_KEYS) {
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        try { result[key] = JSON.parse(raw) } catch { result[key] = raw }
      }
    }
    return result
  }

  function writeLocalConfig(config) {
    for (const key of CONFIG_KEYS) {
      if (key in config) {
        try { localStorage.setItem(key, JSON.stringify(config[key])) } catch { /* ignore */ }
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Dexie 实例（独立，不依赖页面内实例）
  // ─────────────────────────────────────────────────────────
  function openDB() {
    const db = new Dexie(DB_NAME)
    // 声明与原项目一致的 schema（版本 3）
    db.version(1).stores({ wordRecords: '++id,word,timeStamp,dict,chapter,errorCount,[dict+chapter]', chapterRecords: '++id,timeStamp,dict,chapter,time,[dict+chapter]' })
    db.version(2).stores({ wordRecords: '++id,word,timeStamp,dict,chapter,wrongCount,[dict+chapter]', chapterRecords: '++id,timeStamp,dict,chapter,time,[dict+chapter]' })
    db.version(3).stores({ wordRecords: '++id,word,timeStamp,dict,chapter,wrongCount,[dict+chapter]', chapterRecords: '++id,timeStamp,dict,chapter,time,[dict+chapter]', reviewRecords: '++id,dict,createTime,isFinished' })
    return db
  }

  // ─────────────────────────────────────────────────────────
  // 序列化（本地 → Gist payload）
  // ─────────────────────────────────────────────────────────
  async function serializePayload(onProgress) {
    const db = openDB()
    try {
      await db.open()
      onProgress?.(5)

      const blob = await db.export({
        progressCallback: ({ totalRows, completedRows, done }) => {
          if (totalRows) onProgress?.(5 + Math.floor((completedRows / totalRows) * 60))
          return !done
        },
      })
      onProgress?.(70)

      const json = await blob.text()
      const compressed = pako.gzip(json)
      onProgress?.(85)

      // Uint8Array → base64
      let binary = ''
      for (let i = 0; i < compressed.byteLength; i++) binary += String.fromCharCode(compressed[i])
      const dbBase64 = btoa(binary)
      onProgress?.(92)

      const config = readLocalConfig()
      const meta = {
        syncAt: Date.now(),
        dictId: String(config.currentDict ?? 'cet4'),
        chapter: Number(config.currentChapter ?? 0),
        config,
      }
      onProgress?.(100)
      return { dbBase64, meta }
    } finally {
      db.close()
    }
  }

  // ─────────────────────────────────────────────────────────
  // 反序列化（Gist payload → 本地）
  // ─────────────────────────────────────────────────────────
  async function deserializePayload(payload, onProgress) {
    // base64 → Uint8Array
    const binary = atob(payload.dbBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    onProgress?.(15)

    const json = pako.ungzip(bytes, { to: 'string' })
    const blob = new Blob([json])
    onProgress?.(25)

    const db = openDB()
    try {
      await db.import(blob, {
        acceptVersionDiff: true,
        acceptMissingTables: true,
        acceptNameDiff: false,
        acceptChangedPrimaryKey: false,
        overwriteValues: true,
        clearTablesBeforeImport: true,
        progressCallback: ({ totalRows, completedRows, done }) => {
          if (totalRows) onProgress?.(25 + Math.floor((completedRows / totalRows) * 65))
          return !done
        },
      })
    } finally {
      db.close()
    }

    onProgress?.(95)
    writeLocalConfig(payload.meta.config)
    onProgress?.(100)
  }

  // ─────────────────────────────────────────────────────────
  // GitHub Gist API（GM_xmlhttpRequest，绕过 CORS）
  // ─────────────────────────────────────────────────────────
  function gmRequest(url, method, token, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload(res) {
          if (res.status >= 400) return reject(new Error(`GitHub API ${res.status}: ${res.responseText}`))
          resolve(res.responseText ? JSON.parse(res.responseText) : null)
        },
        onerror(err) { reject(new Error(`网络错误: ${JSON.stringify(err)}`)) },
      })
    })
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload(res) { resolve(res.responseText) },
        onerror(err) { reject(new Error(`网络错误: ${JSON.stringify(err)}`)) },
      })
    })
  }

  function buildGistBody(payload) {
    return {
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [DB_FILE_NAME]: { content: payload.dbBase64 },
        [META_FILE_NAME]: { content: JSON.stringify(payload.meta, null, 2) },
      },
    }
  }

  async function createGist(token, payload) {
    const data = await gmRequest(GIST_API, 'POST', token, buildGistBody(payload))
    return data.id
  }

  async function updateGist(token, gistId, payload) {
    await gmRequest(`${GIST_API}/${gistId}`, 'PATCH', token, buildGistBody(payload))
  }

  async function fetchGist(token, gistId) {
    const data = await gmRequest(`${GIST_API}/${gistId}`, 'GET', token, null)
    const dbFile = data.files[DB_FILE_NAME]
    const metaFile = data.files[META_FILE_NAME]

    let dbBase64 = dbFile?.content
    if (dbFile?.truncated && dbFile.raw_url) dbBase64 = await gmFetch(dbFile.raw_url)

    let metaRaw = metaFile?.content
    if (metaFile?.truncated && metaFile.raw_url) metaRaw = await gmFetch(metaFile.raw_url)

    if (!dbBase64 || !metaRaw) throw new Error('Gist 文件结构不完整，可能不是 Qwerty Learner 的同步数据。')
    return { dbBase64, meta: JSON.parse(metaRaw) }
  }

  async function fetchRemoteInfo(token, gistId) {
    const payload = await fetchGist(token, gistId)
    return { syncAt: payload.meta.syncAt, dictId: payload.meta.dictId ?? '', chapter: payload.meta.chapter ?? 0 }
  }

  // ─────────────────────────────────────────────────────────
  // 核心同步操作
  // ─────────────────────────────────────────────────────────
  async function upload(onProgress, onDone, onError) {
    const cfg = getConfig()
    if (!cfg.token) return onError('请先填写 GitHub Personal Access Token')
    try {
      const payload = await serializePayload((p) => onProgress(Math.floor(p * 0.85)))
      let gistId = cfg.gistId
      if (!gistId) {
        gistId = await createGist(cfg.token, payload)
      } else {
        await updateGist(cfg.token, gistId, payload)
      }
      saveConfig({ gistId, lastSyncAt: payload.meta.syncAt, lastSyncDictId: payload.meta.dictId, lastSyncChapter: payload.meta.chapter })
      onProgress(100)
      onDone()
    } catch (e) {
      onError(e instanceof Error ? e.message : '上传失败')
    }
  }

  async function download(gistId, token, onProgress, onDone, onError) {
    if (!token || !gistId) return onError('请先填写 Token 和 Gist ID')
    try {
      const payload = await fetchGist(token, gistId)
      await deserializePayload(payload, (p) => onProgress(Math.floor(p * 0.95)))
      saveConfig({ lastSyncAt: payload.meta.syncAt, lastSyncDictId: payload.meta.dictId ?? '', lastSyncChapter: payload.meta.chapter ?? 0 })
      onProgress(100)
      onDone()
    } catch (e) {
      onError(e instanceof Error ? e.message : '下载失败')
    }
  }

  // ─────────────────────────────────────────────────────────
  // 样式注入
  // ─────────────────────────────────────────────────────────
  GM_addStyle(`
    #${PANEL_ID} {
      font-family: inherit;
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 290px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.12);
      padding: 16px;
      z-index: 999999;
      font-size: 13px;
      color: #374151;
      transition: opacity 0.2s;
    }
    html.dark #${PANEL_ID}, body[data-theme="dark"] #${PANEL_ID} {
      background: #1f2937;
      border-color: #374151;
      color: #e5e7eb;
    }
    #${PANEL_ID} h3 {
      font-size: 14px;
      font-weight: 600;
      margin: 0 0 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #${PANEL_ID} .ql-gs-collapse-btn {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      color: #9ca3af;
      padding: 0 2px;
    }
    #${PANEL_ID}.ql-gs-collapsed .ql-gs-body {
      display: none;
    }
    #${PANEL_ID}.ql-gs-collapsed h3 {
      margin-bottom: 2px;
    }
    #${PANEL_ID}.ql-gs-collapsed .ql-gs-msg {
      margin-top: 0;
    }
    #${PANEL_ID} label {
      display: block;
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 3px;
    }
    #${PANEL_ID} input[type=password],
    #${PANEL_ID} input[type=text] {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 10px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 12px;
      margin-bottom: 8px;
      background: #f9fafb;
      color: #111827;
      outline: none;
    }
    html.dark #${PANEL_ID} input,
    body[data-theme="dark"] #${PANEL_ID} input {
      background: #374151;
      border-color: #4b5563;
      color: #f3f4f6;
    }
    #${PANEL_ID} input:focus {
      border-color: #6366f1;
    }
    #${PANEL_ID} .ql-gs-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    #${PANEL_ID} .ql-gs-switch {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }
    #${PANEL_ID} .ql-gs-switch input { opacity: 0; width: 0; height: 0; }
    #${PANEL_ID} .ql-gs-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: #d1d5db;
      border-radius: 20px;
      transition: 0.2s;
    }
    #${PANEL_ID} .ql-gs-slider::before {
      content: '';
      position: absolute;
      height: 14px; width: 14px;
      left: 3px; bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: 0.2s;
    }
    #${PANEL_ID} .ql-gs-switch input:checked + .ql-gs-slider { background: #6366f1; }
    #${PANEL_ID} .ql-gs-switch input:checked + .ql-gs-slider::before { transform: translateX(16px); }
    #${PANEL_ID} .ql-gs-progress-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    #${PANEL_ID} .ql-gs-progress-bar {
      flex: 1;
      height: 6px;
      background: #e5e7eb;
      border-radius: 3px;
      overflow: hidden;
    }
    #${PANEL_ID} .ql-gs-progress-fill {
      height: 100%;
      background: #6366f1;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    #${PANEL_ID} .ql-gs-progress-pct {
      font-size: 11px;
      color: #9ca3af;
      width: 30px;
      text-align: right;
    }
    #${PANEL_ID} .ql-gs-btns {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    #${PANEL_ID} .ql-gs-btn-primary {
      flex: 1;
      padding: 6px 10px;
      background: #6366f1;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    #${PANEL_ID} .ql-gs-btn-primary:hover:not(:disabled) { background: #4f46e5; }
    #${PANEL_ID} .ql-gs-btn-secondary {
      flex: 1;
      padding: 6px 10px;
      background: transparent;
      border: 1px solid #6366f1;
      color: #6366f1;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    #${PANEL_ID} .ql-gs-btn-secondary:hover:not(:disabled) { background: #ede9fe; }
    #${PANEL_ID} button:disabled { opacity: 0.45; cursor: not-allowed; }
    #${PANEL_ID} .ql-gs-msg {
      font-size: 11px;
      margin-top: 6px;
      min-height: 16px;
      line-height: 1.4;
    }
    #${PANEL_ID} .ql-gs-msg.ok { color: #10b981; }
    #${PANEL_ID} .ql-gs-msg.err { color: #ef4444; }
    #${PANEL_ID} .ql-gs-msg.info { color: #9ca3af; }

    /* 冲突弹窗 */
    #ql-gs-conflict-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #ql-gs-conflict-dialog {
      background: white;
      border-radius: 12px;
      padding: 24px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
    }
    html.dark #ql-gs-conflict-dialog,
    body[data-theme="dark"] #ql-gs-conflict-dialog {
      background: #1f2937;
      color: #e5e7eb;
    }
    #ql-gs-conflict-dialog h4 {
      font-size: 15px; font-weight: 700; margin: 0 0 12px;
    }
    #ql-gs-conflict-dialog table {
      width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px;
    }
    #ql-gs-conflict-dialog td {
      padding: 4px 8px; border: 1px solid #e5e7eb;
    }
    html.dark #ql-gs-conflict-dialog td { border-color: #374151; }
    #ql-gs-conflict-dialog .ql-gs-conflict-btns {
      display: flex; gap: 8px;
    }
    #ql-gs-conflict-dialog .ql-gs-conflict-btns button {
      flex: 1; padding: 8px; border-radius: 6px; font-size: 13px;
      font-weight: 600; cursor: pointer; border: none;
    }
    #ql-gs-conflict-dialog .btn-local { background: #6366f1; color: white; }
    #ql-gs-conflict-dialog .btn-remote { background: #10b981; color: white; }
    #ql-gs-conflict-dialog .btn-cancel { background: #f3f4f6; color: #374151; }
  `)

  // ─────────────────────────────────────────────────────────
  // UI：悬浮面板
  // ─────────────────────────────────────────────────────────
  let panel = null
  let isSyncing = false

  function formatDate(ms) {
    if (!ms) return '从未'
    return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  function readLocalStorageValue(key, fallback) {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  function getCurrentLocalState() {
    return {
      lastSyncAt: GM_getValue('lastSyncAt', 0),
      dictId: String(readLocalStorageValue('currentDict', 'cet4')),
      chapter: Number(readLocalStorageValue('currentChapter', 0)),
    }
  }

  /** 将最后一次同步信息格式化为面板底部的一行文字 */
  function formatSyncInfo(cfg) {
    if (!cfg.lastSyncAt) return '尚未同步'
    let text = '上次同步：' + formatDate(cfg.lastSyncAt)
    if (cfg.lastSyncDictId) text += ' · ' + cfg.lastSyncDictId + ' 第 ' + (cfg.lastSyncChapter + 1) + ' 章'
    return text
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return

    const cfg = getConfig()
    panel = document.createElement('div')
    panel.id = PANEL_ID
    panel.classList.add('ql-gs-collapsed')
    panel.innerHTML = `
      <h3>
        🔄 Gist 云同步
        <button class="ql-gs-collapse-btn" title="折叠/展开">+</button>
      </h3>
      <div class="ql-gs-msg info" id="ql-gs-msg">${formatSyncInfo(cfg)}</div>
      <div class="ql-gs-body">
        <label>GitHub Personal Access Token</label>
        <input id="ql-gs-token" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" value="${escHtml(cfg.token)}">

        <label>Gist ID <span style="font-weight:400;color:#9ca3af">（首次同步后自动填入）</span></label>
        <input id="ql-gs-gist-id" type="text" placeholder="留空则首次同步时自动创建" value="${escHtml(cfg.gistId)}">

        <div class="ql-gs-row">
          <label class="ql-gs-switch" title="完成章节后自动同步">
            <input id="ql-gs-auto" type="checkbox" ${cfg.autoSync ? 'checked' : ''}>
            <span class="ql-gs-slider"></span>
          </label>
          <span style="font-size:12px;color:#6b7280">完成章节后自动同步</span>
        </div>

        <div class="ql-gs-progress-wrap">
          <div class="ql-gs-progress-bar"><div class="ql-gs-progress-fill" id="ql-gs-fill" style="width:0%"></div></div>
          <span class="ql-gs-progress-pct" id="ql-gs-pct">0%</span>
        </div>

        <div class="ql-gs-btns">
          <button class="ql-gs-btn-primary" id="ql-gs-sync-btn" title="智能同步（比较时间戳，云端更新则弹出冲突确认）">立即同步</button>
          <button class="ql-gs-btn-secondary" id="ql-gs-restore-btn" title="从云端下载并覆盖本地">从云端恢复</button>
        </div>
      </div>
    `
    document.body.appendChild(panel)
    bindPanelEvents()
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  }

  function setProgress(pct) {
    const fill = document.getElementById('ql-gs-fill')
    const label = document.getElementById('ql-gs-pct')
    if (fill) fill.style.width = pct + '%'
    if (label) label.textContent = pct + '%'
  }

  function setMsg(text, type = 'info') {
    const el = document.getElementById('ql-gs-msg')
    if (el) { el.textContent = text; el.className = 'ql-gs-msg ' + type }
  }

  function setSyncing(syncing) {
    isSyncing = syncing
    const syncBtn = document.getElementById('ql-gs-sync-btn')
    const restoreBtn = document.getElementById('ql-gs-restore-btn')
    if (syncBtn) syncBtn.disabled = syncing
    if (restoreBtn) restoreBtn.disabled = syncing
    const tokenIn = document.getElementById('ql-gs-token')
    const gistIn = document.getElementById('ql-gs-gist-id')
    if (tokenIn) tokenIn.disabled = syncing
    if (gistIn) gistIn.disabled = syncing
  }

  function readPanelInputs() {
    return {
      token: (document.getElementById('ql-gs-token')?.value ?? '').trim(),
      gistId: (document.getElementById('ql-gs-gist-id')?.value ?? '').trim(),
    }
  }

  function bindPanelEvents() {
    // 折叠按钮
    panel.querySelector('.ql-gs-collapse-btn').addEventListener('click', () => {
      panel.classList.toggle('ql-gs-collapsed')
      panel.querySelector('.ql-gs-collapse-btn').textContent = panel.classList.contains('ql-gs-collapsed') ? '+' : '−'
    })

    // Token 变化时保存
    document.getElementById('ql-gs-token').addEventListener('change', (e) => saveConfig({ token: e.target.value.trim() }))
    document.getElementById('ql-gs-gist-id').addEventListener('change', (e) => saveConfig({ gistId: e.target.value.trim() }))
    document.getElementById('ql-gs-auto').addEventListener('change', (e) => saveConfig({ autoSync: e.target.checked }))

    // 立即同步（智能）
    document.getElementById('ql-gs-sync-btn').addEventListener('click', () => {
      const { token, gistId } = readPanelInputs()
      saveConfig({ token, gistId })
      doSmartSync(token, gistId)
    })

    // 从云端恢复
    document.getElementById('ql-gs-restore-btn').addEventListener('click', async () => {
      const { token, gistId } = readPanelInputs()
      saveConfig({ token, gistId })
      if (!token || !gistId) { setMsg('请先填写 Token 和 Gist ID', 'err'); return }

      setSyncing(true)
      setMsg('正在获取云端信息…', 'info')
      try {
        const remote = await fetchRemoteInfo(token, gistId)
        const cfg = getConfig()
        setSyncing(false)
        showRestoreConfirmDialog(cfg, remote, token, gistId)
      } catch (e) {
        setSyncing(false)
        setMsg(e instanceof Error ? e.message : '获取云端数据失败', 'err')
      }
    })
  }

  // ─────────────────────────────────────────────────────────
  // 恢复确认弹窗
  // ─────────────────────────────────────────────────────────
  function buildComparisonTable(localCfg, remote) {
    const localDictId = localCfg.dictId ?? localCfg.lastSyncDictId ?? ''
    const localChapter = localCfg.chapter ?? localCfg.lastSyncChapter ?? 0
    return `
      <table>
        <tr><td></td><td style="text-align:center;font-weight:600">本地</td><td style="text-align:center;font-weight:600">云端</td></tr>
        <tr>
          <td>同步时间</td>
          <td>${formatDate(localCfg.lastSyncAt)}</td>
          <td style="color:#10b981;font-weight:600">${formatDate(remote.syncAt)}</td>
        </tr>
        <tr>
          <td>词典</td>
          <td>${escHtml(localDictId || '—')}</td>
          <td>${escHtml(remote.dictId || '—')}</td>
        </tr>
        <tr>
          <td>章节</td>
          <td>${localChapter + 1}</td>
          <td>${remote.chapter + 1}</td>
        </tr>
      </table>
    `
  }

  async function showRestoreConfirmDialog(localCfg, remote, token, gistId) {
    const overlay = document.createElement('div')
    overlay.id = 'ql-gs-conflict-overlay'
    overlay.innerHTML = `
      <div id="ql-gs-conflict-dialog">
        <h4>确认从云端恢复？</h4>
        <p style="font-size:12px;color:#ef4444;margin-bottom:10px">此操作将完全覆盖本地 IndexedDB 和配置，不可撤销。</p>
        ${buildComparisonTable(localCfg, remote)}
        <div class="ql-gs-conflict-btns">
          <button class="btn-remote" style="background:#ef4444;color:white" title="确认覆盖本地">确认覆盖</button>
          <button class="btn-cancel">取消</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    overlay.querySelector('.btn-remote').addEventListener('click', () => {
      overlay.remove()
      doRestore(token, gistId)
    })
    overlay.querySelector('.btn-cancel').addEventListener('click', () => overlay.remove())
  }

  // ─────────────────────────────────────────────────────────
  // 检查 IndexedDB 中是否存在晚于指定时间戳的 chapterRecord
  // ─────────────────────────────────────────────────────────
  async function hasNewChapterRecordSince(sinceTs) {
    const db = openDB()
    try {
      await db.open()
      const count = await db.table('chapterRecords').where('timeStamp').above(sinceTs).count()
      return count > 0
    } finally {
      db.close()
    }
  }

  // ─────────────────────────────────────────────────────────
  // 智能同步
  // ─────────────────────────────────────────────────────────
  async function doSmartSync(token, gistId) {
    if (!token) { setMsg('请先填写 GitHub Personal Access Token', 'err'); return }
    setSyncing(true)
    setProgress(0)
    setMsg('正在检查云端状态…', 'info')

    if (!gistId) {
      // 无 Gist ID → 直接上传创建
      doUpload()
      return
    }

    try {
      setProgress(10)
      const remote = await fetchRemoteInfo(token, gistId)
      setProgress(30)
      const local = getCurrentLocalState()

      const isSameVersion =
        local.dictId === remote.dictId &&
        local.chapter === remote.chapter &&
        local.lastSyncAt === remote.syncAt

      // 直接上传的条件：
      //   1. 词典相同，且当前章节领先云端
      //   2. 或者词典相同、章节相同，但本地上次同步时间晚于云端
      const localIsAhead =
        local.dictId === remote.dictId && (
          local.chapter > remote.chapter ||
          (local.chapter === remote.chapter && local.lastSyncAt > remote.syncAt)
        )

      if (isSameVersion) {
        // 版本号相同，但仍需检查是否有章节完成后尚未同步的新记录
        const hasNewRecord = await hasNewChapterRecordSince(remote.syncAt)
        if (hasNewRecord) {
          // 存在云端同步时间之后产生的 chapterRecord，本地有新数据，执行上传
          setMsg('检测到新章节记录，正在上传…', 'info')
          doUpload()
          return
        }
        setSyncing(false)
        setProgress(100)
        setMsg('云端已是最新，无需同步', 'ok')
      } else if (localIsAhead) {
        // 本地确认更新，安全直接上传
        setMsg('本地更新，正在上传…', 'info')
        doUpload()
      } else {
        // 其余情况（云端更新 / 换了词典 / 章节倒退）→ 弹冲突弹窗
        setSyncing(false) // 等用户操作
        showConflictDialog(local, remote, token, gistId)
      }
    } catch (e) {
      setSyncing(false)
      setMsg(e instanceof Error ? e.message : '同步检查失败', 'err')
    }
  }

  function doUpload() {
    setSyncing(true)
    setMsg('正在上传数据…', 'info')
    upload(
      setProgress,
      () => {
        setSyncing(false)
        const cfg = getConfig()
        setMsg(formatSyncInfo(cfg), 'ok')
        const gistIn = document.getElementById('ql-gs-gist-id')
        if (gistIn && cfg.gistId) gistIn.value = cfg.gistId
      },
      (err) => { setSyncing(false); setMsg(err, 'err') }
    )
  }

  function doRestore(token, gistId) {
    setSyncing(true)
    setProgress(0)
    setMsg('正在从云端恢复…', 'info')
    download(gistId, token, setProgress,
      () => {
        setSyncing(false)
        setMsg('从云端恢复成功，即将刷新页面…', 'ok')
        setTimeout(() => location.reload(), 1500)
      },
      (err) => { setSyncing(false); setMsg(err, 'err') }
    )
  }

  // ─────────────────────────────────────────────────────────
  // 冲突弹窗
  // ─────────────────────────────────────────────────────────
  function showConflictDialog(localCfg, remote, token, gistId) {
    const overlay = document.createElement('div')
    overlay.id = 'ql-gs-conflict-overlay'
    overlay.innerHTML = `
      <div id="ql-gs-conflict-dialog">
        <h4>⚠️ 数据冲突</h4>
        <p style="font-size:12px;color:#6b7280;margin-bottom:10px">云端数据比本地更新，请选择保留哪份数据：</p>
        ${buildComparisonTable(localCfg, remote)}
        <div class="ql-gs-conflict-btns">
          <button class="btn-local" title="保留本地数据，覆盖云端">保留本地</button>
          <button class="btn-remote" title="使用云端数据，覆盖本地">使用云端</button>
          <button class="btn-cancel">取消</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    overlay.querySelector('.btn-local').addEventListener('click', () => {
      overlay.remove()
      doUpload()
    })
    overlay.querySelector('.btn-remote').addEventListener('click', () => {
      overlay.remove()
      doRestore(token, gistId)
    })
    overlay.querySelector('.btn-cancel').addEventListener('click', () => overlay.remove())
  }

  // ─────────────────────────────────────────────────────────
  // 自动同步（监听"下一章节"按钮点击）
  // ─────────────────────────────────────────────────────────

  function tryAutoSync() {
    const cfg = getConfig()
    if (!cfg.autoSync || !cfg.token) return
    if (isSyncing) return

    // 检测结果页面是否存在
    const nextBtn = document.querySelector('button[title="下一章节"]')
    if (!nextBtn) return

    // 防止重复绑定：用 dataset 标记已绑定的按钮
    if (nextBtn.dataset.gistSyncBound) return
    nextBtn.dataset.gistSyncBound = '1'

    console.log('[GistSync] 检测到结果页，已挂载"下一章节"按钮监听')

    // 记录当前章节号，点击后等 currentChapter 变化再上传
    const chapterBefore = Number(readLocalStorageValue('currentChapter', 0))

    nextBtn.addEventListener('click', () => {
      const curCfg = getConfig()
      if (!curCfg.autoSync || !curCfg.token || isSyncing) return

      console.log('[GistSync] 用户点击"下一章节"，等待 chapter 更新…')
      let waited = 0
      const pollInterval = 300
      const maxWait = 8000
      const poll = setInterval(() => {
        waited += pollInterval
        const chapterNow = Number(readLocalStorageValue('currentChapter', 0))
        if (chapterNow !== chapterBefore || waited >= maxWait) {
          clearInterval(poll)
          if (chapterNow === chapterBefore) {
            console.warn('[GistSync] 等待 chapter 更新超时，仍执行上传')
          }
          console.log('[GistSync] chapter 已更新 %d → %d，开始同步', chapterBefore, chapterNow)
          doSmartSync(curCfg.token, curCfg.gistId)
        }
      }, pollInterval)
    }, { once: true })
  }

  // ─────────────────────────────────────────────────────────
  // 初始化
  // ─────────────────────────────────────────────────────────
  function init() {
    buildPanel()

    // 用 MutationObserver 检测章节完成（ResultScreen 出现）
    const observer = new MutationObserver(() => {
      if (getConfig().autoSync) tryAutoSync()
    })
    observer.observe(document.body, { childList: true, subtree: true })

    // 也用定时轮询兜底（每 5s 检查一次）
    setInterval(() => {
      if (getConfig().autoSync) tryAutoSync()
    }, 5000)

    // 页面加载时自动同步：若已配置 token + gistId，延迟 1.5s 后执行一次智能同步
    const cfg = getConfig()
    if (cfg.token && cfg.gistId) {
      setTimeout(() => {
        setMsg('页面加载，正在自动同步…', 'info')
        doSmartSync(cfg.token, cfg.gistId)
      }, 1500)
    }
  }

  // 等待 DOM 就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    // 延迟一点，让 React 先渲染
    setTimeout(init, 1000)
  }
})()
