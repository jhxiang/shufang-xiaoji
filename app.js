/* =========================================================================
 * 小象阅痕 · app.js
 * 阅读计时 / 书架书脊 / 双维度分类 / 读后感（语音·拍照 OCR）/ 人物关系图谱
 * 每日拾页 / 荐书 / 阅读习惯与时段分析 / 备份恢复 / 豆包 AI
 * ========================================================================= */
(() => {
  'use strict';

  /* =============================== 工具函数 =============================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

  const dateKey = (ts = Date.now()) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const fmtDate = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  };
  const fmtDateTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${fmtDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtClock = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  };
  const fmtDuration = (mins) => {
    const m = Math.round(mins || 0);
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
  };
  const fmtWords = (wan) => {
    const v = num(wan, 0);
    if (!v) return '—';
    if (v >= 100) return `${Math.round(v)} 万字`;
    return `${v.toFixed(1)} 万字`;
  };

  const STATUS_LABELS = { want: '想读', reading: '在读', finished: '已读' };
  const NOTE_TYPE_LABELS = { reflection: '读后感', quote: '书摘', scan: '扫描' };
  const GOAL_PRESETS = [12, 24, 36, 50, 100];

  /* =============================== IndexedDB =============================== */
  const DB_NAME = 'shufang-xiaoji';
  const DB_VER = 1;
  let dbPromise = null;
  let idbBroken = false;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB 不可用')); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sessions')) {
          const s = db.createObjectStore('sessions', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      idbBroken = true;
      throw err;
    });
    return dbPromise;
  }

  async function dbAll(store) {
    if (bridge.available) return memAll(store);
    if (idbBroken) return memAll(store);
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch { idbBroken = true; return memAll(store); }
  }
  async function dbPut(store, value) {
    if (bridge.available || idbBroken) { memPut(store, value); return; }
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch { idbBroken = true; memPut(store, value); }
  }
  async function dbDel(store, key) {
    if (bridge.available || idbBroken) { memDel(store, key); return; }
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch { idbBroken = true; memDel(store, key); }
  }
  async function dbClear(store) {
    if (bridge.available || idbBroken) { memClear(store); return; }
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch { idbBroken = true; memClear(store); }
  }

  /* =============================== 本地存储 ===============================
   * 网页端：IndexedDB（异常时降级 localStorage）
   * 原生 App：自定义 scheme 下 WebKit 无法稳定持久化 IndexedDB/localStorage，
   *          因此改用「内存数据 + 原生磁盘快照」方案，保证数据不丢。
   * ====================================================================== */

  const memKey = (s) => `shufang.mem.${s}`;

  const memCache = { books: null, sessions: null, meta: null, kv: null };
  let nativeSaveTimer = null;

  function memAll(store) {
    if (memCache[store]) return memCache[store].slice();
    try { return JSON.parse(localStorage.getItem(memKey(store)) || '[]'); } catch { return []; }
  }
  function memWrite(store, arr) {
    memCache[store] = arr.slice();
    if (bridge.available) { scheduleNativeSave(); return; }
    try { localStorage.setItem(memKey(store), JSON.stringify(arr)); } catch { /* 存储已满 */ }
  }
  function memPut(store, value) {
    const arr = memAll(store);
    const i = arr.findIndex((x) => x.id === value.id || x.key === value.key);
    if (i >= 0) arr[i] = value; else arr.push(value);
    memWrite(store, arr);
  }
  function memDel(store, key) {
    memWrite(store, memAll(store).filter((x) => x.id !== key && x.key !== key));
  }
  function memClear(store) { memWrite(store, []); }

  /* ---- 原生磁盘快照 ---- */
  let stateReadyForSnapshot = false;

  function decodeBase64Utf8(b64) {
    if (!b64 || typeof b64 !== 'string') return null;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      try {
        return decodeURIComponent(escape(atob(b64)));
      } catch {
        return null;
      }
    }
  }

  function snapshotPayload() {
    // 优先使用权威的 state，避免 memCache 与 state 脱节导致空快照覆盖
    const books = stateReadyForSnapshot && Array.isArray(state.books)
      ? state.books
      : (memCache.books || memAll('books'));
    const sessions = stateReadyForSnapshot && Array.isArray(state.sessions)
      ? state.sessions
      : (memCache.sessions || memAll('sessions'));
    const metaArr = stateReadyForSnapshot && state.meta && typeof state.meta === 'object'
      ? Object.keys(state.meta).map((key) => ({ key, value: state.meta[key] }))
      : (memCache.meta || memAll('meta'));
    return JSON.stringify({
      version: DB_VER,
      savedAt: Date.now(),
      books,
      sessions,
      meta: metaArr,
      kv: memCache.kv || { timer: null },
    });
  }

  function scheduleNativeSave() {
    clearTimeout(nativeSaveTimer);
    nativeSaveTimer = setTimeout(() => {
      try { bridge.post({ type: 'saveSnapshot', data: snapshotPayload() }); } catch { /* ignore */ }
    }, 120);
  }

  const FALLBACK_SNAPSHOT_KEY = 'shufang.fallback.snapshot.v2';

  function writeLocalFallback(payload) {
    try {
      if (payload && payload.length < 3_500_000) {
        localStorage.setItem(FALLBACK_SNAPSHOT_KEY, payload);
      }
    } catch { /* ignore quota */ }
  }

  function flushNativeSave() {
    clearTimeout(nativeSaveTimer);
    try {
      const payload = snapshotPayload();
      writeLocalFallback(payload);
      if (bridge.available) {
        bridge.post({ type: 'saveSnapshot', data: payload });
      }
    } catch { /* ignore */ }
  }

  /** 原生端在页面加载后回调，把磁盘快照交还 Web 端 */
  function hydrateFromNative(json) {
    let data = null;
    try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { data = null; }
    if (!data) return false;
    memCache.books = Array.isArray(data.books) ? data.books : [];
    memCache.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    memCache.meta = Array.isArray(data.meta) ? data.meta : [];
    memCache.kv = data.kv && typeof data.kv === 'object' ? data.kv : { timer: null, theme: null };
    window.__shufangHydrated = true;
    return true;
  }

  /* ---- 键值存储（计时状态 / 主题） ---- */
  function kvGet(key) {
    if (bridge.available) {
      const kv = memCache.kv || memAll('kv') || {};
      return kv[key] == null ? null : kv[key];
    }
    try { return localStorage.getItem(`shufang.${key}`); } catch { return null; }
  }
  function kvSet(key, value) {
    if (bridge.available) {
      const kv = memCache.kv || {};
      kv[key] = value;
      memCache.kv = kv;
      scheduleNativeSave();
      return;
    }
    try {
      if (value == null) localStorage.removeItem(`shufang.${key}`);
      else localStorage.setItem(`shufang.${key}`, value);
    } catch { /* ignore */ }
  }

  /* =============================== 原生桥接 =============================== */
  const bridge = (() => {
    const handler = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.shufangBridge) || null;
    return {
      available: !!handler,
      post(payload) {
        if (!handler) return false;
        try { handler.postMessage(payload); return true; } catch { return false; }
      },
    };
  })();

  const pendingRequests = new Map();

  function bridgeRequest(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const requestId = uid('req');
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('请求超时'));
      }, opts.timeout || 25000);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      const ok = bridge.post({
        type: 'fetchUrl',
        requestId,
        url,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body || '',
      });
      if (!ok) {
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        reject(new Error('原生请求通道不可用'));
      }
    });
  }

  function isLocalDevProxy() {
    try {
      const h = window.location && window.location.hostname;
      return h === 'localhost' || h === '127.0.0.1';
    } catch { return false; }
  }

  async function requestJson(url, opts = {}) {
    if (bridge.available && opts.useBridge !== false) {
      const text = await bridgeRequest(url, opts);
      return JSON.parse(text);
    }
    let targetUrl = url;
    if (!bridge.available && isLocalDevProxy() && opts.viaProxy) {
      targetUrl = `/api/fetch?url=${encodeURIComponent(url)}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 25000);
    try {
      const res = await fetch(targetUrl, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body || undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /* 由原生侧回调 */
  window.ShufangNative = {
    isNative: bridge.available,
    /** 原生端注入磁盘快照后调用 */
    hydrate(json) {
      const ok = hydrateFromNative(json);
      if (ok) {
        state.books = memCache.books.map(normalizeBook);
        state.sessions = memCache.sessions || [];
        state.meta = {};
        (memCache.meta || []).forEach((r) => { state.meta[r.key] = r.value; });
        stateReadyForSnapshot = true;
        applyTheme();
        renderAll();
        restoreTimer();
      }
      return ok;
    },
    hydrateBase64(b64) {
      const json = decodeBase64Utf8(b64);
      if (json) return this.hydrate(json);
      return false;
    },
    onFetchResult(requestId, ok, body) {
      const item = pendingRequests.get(requestId);
      if (!item) return;
      clearTimeout(item.timeout);
      pendingRequests.delete(requestId);
      if (ok) item.resolve(String(body || ''));
      else item.reject(new Error(String(body || '网络请求失败')));
    },
    onOcrResult(text, ok) {
      if (ok && text) {
        appendToNoteText(String(text).trim());
        setOcrStatus(`OCR 识别成功 · ${String(text).trim().length} 字`);
        toast('已识别书页文字');
      } else {
        setOcrStatus('OCR 未识别到文字，可手动补充');
        toast('未识别到文字，可手动补充');
      }
    },
    onDictation(text) {
      if (!text) return;
      const ta = $('#noteContentInput');
      if (!ta) return;
      const prefix = state.dictationPrefix != null ? state.dictationPrefix : ta.value;
      const sep = prefix && !prefix.endsWith('\n') ? '\n' : '';
      ta.value = `${prefix}${sep}${String(text)}`;
      ta.scrollTop = ta.scrollHeight;
    },
    onDictationEnd() {
      stopDictationUI();
    },
    onShareResult(ok) {
      toast(ok ? '已打开分享面板' : '分享已取消');
    },
    onPhotoPicked(base64) {
      if (!base64) return;
      const dataUrl = String(base64).startsWith('data:') ? String(base64) : `data:image/jpeg;base64,${base64}`;
      setNoteImage(dataUrl);
      runOcr(dataUrl);
    },
  };

  // 原生端可主动触发落盘（App 切后台 / 即将退出）
  window.__shufangFlush = () => {
    try { flushNativeSave(); } catch { /* ignore */ }
  };

  // 原生权限被拒时的提示
  window.__shufangPermissionDenied = (kind) => {
    stopDictationUI();
    if (kind === 'microphone') {
      toast('麦克风权限被拒绝：请在 设置 › 小象阅痕 中开启麦克风', { duration: 3600 });
    } else if (kind === 'speech') {
      toast('语音识别权限被拒绝：请在 设置 › 小象阅痕 中开启语音识别', { duration: 3600 });
    } else {
      toast('缺少系统权限，请在「设置」中开启');
    }
  };

  /* =============================== 应用状态 =============================== */
  const state = {
    books: [],
    sessions: [],
    meta: {},
    tab: 'shelf',
    statusFilter: 'all',
    groupMode: 'genre',
    viewMode: kvGet('shelfView', 'spine'),
    chipFilter: 'all',
    sort: 'recent',
    search: '',
    selectedBookId: null,
    detailBookId: null,
    detailTab: 'overview',
    addMode: 'search',
    quickAddStatus: 'reading',
    editingId: null,
    coverData: null,
    formRating: 0,
    formColor: (window.SPINE_COLORS || ['#2F6354'])[0],
    formGenre: (window.BOOK_GENRES || ['小说'])[0],
    searchResults: [],
    searchSeq: 0,
    dailyOffset: 0,
    dailyQuotes: [],
    recommendations: [],
    recBatch: 0,
    seenRecTitles: new Set(),
    onlineRecs: [],
    onlineRecKey: '',
    onlineRecLoading: false,
    noteBookId: null,
    noteType: 'reflection',
    noteImage: null,
    charBookId: null,
    editingCharId: null,
    charColor: (window.SPINE_COLORS || ['#2F6354'])[0],
    relBookId: null,
    editingRelId: null,
    timer: { bookId: null, running: false, startedAt: 0, elapsedMs: 0, ambient: 'off' },
    mindmap: null,
    posterQuote: null,
    dictating: false,
    recognition: null,
    lastPersist: 0,
  };

  const getBook = (id) => state.books.find((b) => b.id === id) || null;
  const getMeta = (key, fallback) => (key in state.meta ? state.meta[key] : fallback);
  async function setMeta(key, value) {
    state.meta[key] = value;
    if (bridge.available) {
      const arr = memCache.meta || memAll('meta');
      const i = arr.findIndex((r) => r.key === key);
      if (i >= 0) arr[i] = { key, value }; else arr.push({ key, value });
      memWrite('meta', arr);
      flushNativeSave();
      return;
    }
    await dbPut('meta', { key, value });
  }

  async function loadAll() {
    const [books, sessions, metaRows] = await Promise.all([
      dbAll('books'), dbAll('sessions'), dbAll('meta'),
    ]);
    state.books = (books || []).map(normalizeBook);
    state.sessions = sessions || [];
    state.meta = {};
    (metaRows || []).forEach((r) => { state.meta[r.key] = r.value; });
  }

  function normalizeBook(raw) {
    const b = { ...raw };
    b.id = b.id || uid('bk');
    b.title = b.title || '未命名书籍';
    b.author = b.author || '佚名';
    b.genre = b.genre || '小说';
    b.pages = Math.max(0, num(b.pages, 0));
    b.wordsWan = Math.max(0, num(b.wordsWan, 0));
    b.spineColor = b.spineColor || (window.SPINE_COLORS || ['#2F6354'])[0];
    b.summary = b.summary || '';
    b.coverUrl = b.coverUrl || '';
    b.status = STATUS_LABELS[b.status] ? b.status : 'want';
    b.rating = clamp(num(b.rating, 0), 0, 5);
    b.progress = clamp(num(b.progress, 0), 0, 100);
    b.notes = Array.isArray(b.notes) ? b.notes : [];
    b.characters = Array.isArray(b.characters) ? b.characters : [];
    b.relations = Array.isArray(b.relations) ? b.relations : [];
    b.createdAt = b.createdAt || Date.now();
    b.updatedAt = b.updatedAt || b.createdAt;
    b.lastReadAt = b.lastReadAt || 0;
    return b;
  }

  async function saveBook(book, silent = false) {
    book.updatedAt = Date.now();
    const i = state.books.findIndex((b) => b.id === book.id);
    if (i >= 0) state.books[i] = book; else state.books.push(book);
    await dbPut('books', book);
    flushNativeSave();
    if (!silent) { renderShelf(); renderStats(); renderSettings(); }
  }

  async function removeBook(id) {
    state.books = state.books.filter((b) => b.id !== id);
    const keep = [];
    for (const s of state.sessions) {
      if (s.bookId === id) await dbDel('sessions', s.id); else keep.push(s);
    }
    state.sessions = keep;
    await dbDel('books', id);
    flushNativeSave();
    renderShelf(); renderStats(); renderSettings();
  }

  async function addSession(session) {
    state.sessions.push(session);
    await dbPut('sessions', session);
    flushNativeSave();
  }
  async function removeSession(id) {
    state.sessions = state.sessions.filter((s) => s.id !== id);
    await dbDel('sessions', id);
    flushNativeSave();
    renderStats();
  }
  const sessionsOf = (bookId) => state.sessions.filter((s) => s.bookId === bookId);

  /* =============================== 提示 Toast =============================== */
  let toastTimer = null;
  let toastUndoFn = null;

  function toast(message, opts = {}) {
    const el = $('#toast');
    const textEl = $('#toastText');
    const undoBtn = $('#toastUndoBtn');
    if (!el || !textEl) return;
    textEl.textContent = message;
    toastUndoFn = opts.undo || null;
    if (toastUndoFn) undoBtn.classList.remove('hidden');
    else undoBtn.classList.add('hidden');
    if (opts.sticky) undoBtn.classList.remove('hidden');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      toastUndoFn = null;
    }, opts.duration || 2400);
  }

  function bindToast() {
    $('#toastUndoBtn')?.addEventListener('click', async () => {
      if (!toastUndoFn) return;
      const fn = toastUndoFn;
      toastUndoFn = null;
      $('#toast').classList.remove('show');
      try { await fn(); } catch { /* ignore */ }
    });
  }

  /* =============================== 主题 =============================== */
  const themeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function currentDark() {
    const choice = getMeta('theme', 'auto');
    if (choice === 'auto') return !!(themeQuery && themeQuery.matches);
    return choice === 'dark';
  }

  function applyTheme() {
    const dark = currentDark();
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    $('#themeIconSun')?.classList.toggle('hidden', dark);
    $('#themeIconMoon')?.classList.toggle('hidden', !dark);
    const metaTheme = $('#metaThemeColor');
    if (metaTheme) metaTheme.setAttribute('content', dark ? '#141917' : '#F7F4EE');
    $$('#themeSegControl .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeChoice === getMeta('theme', 'auto'));
    });
    bridge.post({ type: 'setTheme', dark });
    if (state.detailBookId && $('#bookDetailBackdrop').classList.contains('open')) renderDetail();
  }

  async function setTheme(choice) {
    await setMeta('theme', choice);
    applyTheme();
    toast(choice === 'auto' ? '已跟随系统外观' : (choice === 'dark' ? '已切换夜间护眼' : '已切换日间纸白'));
  }

  themeQuery?.addEventListener?.('change', () => { if (getMeta('theme', 'auto') === 'auto') applyTheme(); });

  /* =============================== 顶部与导航 =============================== */
  function switchTab(tab) {
    state.tab = tab;
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page' + tab.charAt(0).toUpperCase() + tab.slice(1)));
    $('#searchBarWrap')?.classList.toggle('hidden', tab !== 'shelf');
    const activePage = $('#page' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (activePage) window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tab === 'daily') renderDaily();
    if (tab === 'stats') renderStats();
    if (tab === 'settings') renderSettings();
  }

  function updateHeaderSummary() {
    const total = state.books.length;
    const finished = state.books.filter((b) => b.status === 'finished').length;
    const reading = state.books.filter((b) => b.status === 'reading').length;
    const el = $('#headerSummary');
    if (el) el.textContent = `${total} 本藏书 · 在读 ${reading} · 已读 ${finished}`;
  }

  /* =============================== 书架 =============================== */
  const SIZE = { wMin: 26, wMax: 44, hMin: 126, hMax: 174 };

  function spineSize(book) {
    const jitterW = (hashStr(`w|${book.title}`) - 0.5) * 6;
    const jitterH = (hashStr(`h|${book.title}`) - 0.5) * 26;
    const baseW = book.wordsWan
      ? SIZE.wMin + Math.log10(Math.max(1, book.wordsWan)) * 8.2
      : SIZE.wMin + 6 + jitterW;
    const baseH = book.pages
      ? SIZE.hMin + Math.sqrt(Math.max(40, book.pages)) * 1.9 + jitterH * 0.45
      : 146 + jitterH;
    const w = clamp(baseW, SIZE.wMin, SIZE.wMax);
    const h = clamp(baseH, SIZE.hMin, SIZE.hMax);
    return { w: Math.round(w), h: Math.round(h) };
  }

  function typoCover(book) {
    return `<div class="typo-cover" style="--spine-bg:${esc(book.spineColor)}">
      <span class="typo-cover-genre">${esc(book.genre)}</span>
      <span class="typo-cover-title">${esc(book.title)}</span>
      <span class="typo-cover-author">${esc(book.author)}</span>
    </div>`;
  }

  function starValueText(rating) {
    if (!rating) return '未评分';
    return `${rating.toFixed(1).replace(/\.0$/, '')} 星`;
  }

  function matchesSearch(book, q) {
    if (!q) return true;
    const hay = [book.title, book.author, book.genre, book.summary, ...(book.characters || []).map((c) => `${c.name}${c.role}${c.bio}`)]
      .join(' ').toLowerCase();
    if (hay.includes(q)) return true;
    return (book.notes || []).some((n) => String(n.content || '').toLowerCase().includes(q));
  }

  function currentSort(a, b) {
    switch (state.sort) {
      case 'rating': return (b.rating || 0) - (a.rating || 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
      case 'progress': return (b.progress || 0) - (a.progress || 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
      case 'words': return (b.wordsWan || 0) - (a.wordsWan || 0);
      case 'newest': return (b.createdAt || 0) - (a.createdAt || 0);
      default: return (b.lastReadAt || 0) - (a.lastReadAt || 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
    }
  }

  function booksForView() {
    const q = state.search.trim().toLowerCase();
    let list = state.books.filter((b) => {
      if (state.statusFilter !== 'all' && b.status !== state.statusFilter) return false;
      if (state.chipFilter !== 'all') {
        if (state.groupMode === 'genre' && b.genre !== state.chipFilter) return false;
        if (state.groupMode === 'author' && b.author !== state.chipFilter) return false;
      }
      return matchesSearch(b, q);
    });
    list = list.slice().sort(currentSort);
    return list;
  }

  function renderShelf() {
    updateHeaderSummary();
    renderChips();
    const list = booksForView();
    const stage = $('#bookshelfContainer');
    const empty = $('#shelfEmpty');
    if (!stage || !empty) return;

    if (!state.books.length) {
      stage.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = `
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
          </svg>
        </div>
        <h3>书房还空着</h3>
        <p>先把正在读或想读的书放上书架，<br>之后就能记录时长、写感悟、梳理人物关系。</p>
        <div class="empty-actions">
          <button class="btn btn-primary btn-sm" type="button" data-empty-act="add">+ 添加第一本书</button>
        </div>`;
      return;
    }

    if (!list.length) {
      stage.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = `
        <div class="empty-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7.5"/><line x1="20" y1="20" x2="16.4" y2="16.4"/>
          </svg>
        </div>
        <h3>没有符合条件的书</h3>
        <p>换个状态、分类或关键词再试试。</p>
        <div class="empty-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-empty-act="reset">清除筛选</button>
        </div>`;
      return;
    }

    empty.classList.add('hidden');

    if (state.search.trim()) {
      stage.innerHTML = shelfTierHtml('搜索结果', list, `共 ${list.length} 本`);
      return;
    }

    const groups = new Map();
    list.forEach((b) => {
      const key = state.groupMode === 'genre' ? b.genre : b.author;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    });
    const ordered = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh'));
    stage.innerHTML = ordered.map(([key, books]) => shelfTierHtml(key, books, `${books.length} 本`)).join('');
  }

  function extractCoverColor(url) {
    return new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const img = new Image();
      if (!String(url).startsWith('data:')) img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => resolve(null), 3500);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas');
          const size = 24;
          c.width = size; c.height = size;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 160) continue;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const sat = max ? (max - min) / max : 0;
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            // 优先采样有色彩且不过白/过黑的区域
            const weight = (lum > 0.08 && lum < 0.9) ? (0.4 + sat * 2.4) : 0.08;
            rSum += r * weight; gSum += g * weight; bSum += b * weight; wSum += weight;
          }
          if (wSum <= 0) { resolve(null); return; }
          let r = rSum / wSum / 255, g = gSum / wSum / 255, b = bSum / wSum / 255;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          let h = 0, s = 0, l = (max + min) / 2;
          if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
          }
          // 校正为沉稳纸感书脊色调，确保浅色文字可读
          s = clamp(s, 0.22, 0.58);
          l = clamp(l, 0.24, 0.40);
          const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
          };
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p = 2 * l - q;
          const rr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
          const gg = Math.round(hue2rgb(p, q, h) * 255);
          const bb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
          const hex = `#${[rr, gg, bb].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          resolve(hex);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = url;
    });
  }

  function syncBookColorFromCover(book) {
    if (!book || !book.coverUrl) return;
    extractCoverColor(book.coverUrl).then((hex) => {
      if (!hex || hex === book.spineColor) return;
      const latest = getBook(book.id);
      if (!latest) return;
      latest.spineColor = hex;
      saveBook(latest, true).then(() => {
        if (state.tab === 'shelf') renderShelf();
      });
    });
  }

  function shelfTierHtml(label, books, right) {
    const mode = state.viewMode || 'spine';
    const selected = state.selectedBookId && books.some((b) => b.id === state.selectedBookId)
      ? books.find((b) => b.id === state.selectedBookId) : null;

    if (mode === 'list') {
      const rows = books.map((b) => {
        const tags = [
          `<span class="mini-tag primary">${esc(b.genre)}</span>`,
          `<span class="mini-tag">${STATUS_LABELS[b.status]}</span>`,
          b.pages ? `<span class="mini-tag">${b.pages} 页</span>` : '',
          b.rating ? `<span class="mini-tag gold">★ ${starValueText(b.rating)}</span>` : '',
        ].filter(Boolean).join('');
        return `<div class="book-list-row" data-open-detail="${esc(b.id)}">
          <div class="physical-book book-list-cover" style="--spine-bg:${esc(b.spineColor)}">
            ${typoCover(b)}
            ${b.coverUrl ? `<img src="${esc(b.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
          </div>
          <div class="book-list-body">
            <div class="book-list-head">
              <div class="book-list-title">${esc(b.title)}</div>
            </div>
            <div class="book-list-author">${esc(b.author)}</div>
            <div class="book-list-tags">${tags}</div>
            <div class="book-list-prog">
              <div class="progress-track"><div class="progress-fill" style="width:${clamp(b.progress, 0, 100)}%"></div></div>
              <span class="book-list-prog-text">${Math.round(b.progress)}%</span>
            </div>
          </div>
          <div class="book-list-actions">
            <button type="button" class="book-list-btn primary" data-act="timer" data-id="${esc(b.id)}">⏱ 计时</button>
            <button type="button" class="book-list-btn" data-act="note" data-id="${esc(b.id)}">✍️ 笔记</button>
            <button type="button" class="book-list-btn danger" data-act="delete" data-id="${esc(b.id)}">删除</button>
          </div>
        </div>`;
      }).join('');
      return `<div class="shelf-tier">
        <div class="shelf-group-label"><span>${esc(label)}</span><span class="shelf-group-count">${esc(right)}</span></div>
        <div class="shelf-list-stack">${rows}</div>
      </div>`;
    }

    if (mode === 'cover') {
      const cards = books.map((b) => {
        const sel = state.selectedBookId === b.id ? ' selected' : '';
        const statusCls = b.status === 'finished' ? 'finished' : (b.status === 'reading' ? 'reading' : '');
        const subText = b.rating ? `${b.author} · ★${starValueText(b.rating)}` : b.author;
        return `<button type="button" class="cover-book-item${sel}" data-cover-id="${esc(b.id)}"
          title="${esc(b.title)} · ${STATUS_LABELS[b.status]}">
          <div class="physical-book" style="--spine-bg:${esc(b.spineColor)}">
            ${typoCover(b)}
            ${b.coverUrl ? `<img src="${esc(b.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
            <span class="cover-badge-status ${statusCls}">${STATUS_LABELS[b.status]}</span>
            <span class="cover-progress-strip"><span style="width:${clamp(b.progress, 0, 100)}%"></span></span>
          </div>
          <div class="cover-book-meta">
            <div class="cover-book-title">${esc(b.title)}</div>
            <div class="cover-book-sub">${esc(subText)}</div>
          </div>
        </button>`;
      }).join('');
      return `<div class="shelf-tier">
        <div class="shelf-group-label"><span>${esc(label)}</span><span class="shelf-group-count">${esc(right)}</span></div>
        <div class="shelf-cover-grid">${cards}</div>
        <div class="shelf-ledge"></div>
        ${selected ? expandedCardHtml(selected) : ''}
      </div>`;
    }

    const spines = books.map((b) => {
      const { w, h } = spineSize(b);
      const sel = state.selectedBookId === b.id ? ' selected' : '';
      const dot = b.status === 'finished' ? 'finished' : (b.status === 'reading' ? 'reading' : '');
      const hasCover = b.coverUrl ? ' has-cover' : '';
      const coverLayer = b.coverUrl
        ? `<img class="spine-cover-img" src="${esc(b.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.remove('has-cover');this.remove()"><span class="spine-cylinder-light"></span>`
        : '';
      return `<button type="button" class="book-spine${sel}${hasCover}" data-book-id="${esc(b.id)}"
        title="${esc(b.title)} · ${esc(b.author)} · ${STATUS_LABELS[b.status]}"
        style="--spine-w:${w}px;--spine-h:${h}px;--spine-bg:${esc(b.spineColor)}">
        ${coverLayer}
        <span class="spine-status-dot ${dot}"></span>
        <span class="spine-title">${esc(b.title)}</span>
        <span class="spine-author">${esc(b.author)}</span>
        <span class="spine-progress-bar"><span class="spine-progress-fill" style="width:${clamp(b.progress, 0, 100)}%"></span></span>
      </button>`;
    }).join('');

    return `<div class="shelf-tier">
      <div class="shelf-group-label"><span>${esc(label)}</span><span class="shelf-group-count">${esc(right)}</span></div>
      <div class="shelf-books-row">${spines}</div>
      <div class="shelf-ledge"></div>
      ${selected ? expandedCardHtml(selected) : ''}
    </div>`;
  }

  function expandedCardHtml(book) {
    const tags = [
      `<span class="mini-tag primary">${esc(book.genre)}</span>`,
      `<span class="mini-tag">${STATUS_LABELS[book.status]}</span>`,
      book.pages ? `<span class="mini-tag">${book.pages} 页</span>` : '',
      book.wordsWan ? `<span class="mini-tag">${fmtWords(book.wordsWan)}</span>` : '',
      book.rating ? `<span class="mini-tag gold">★ ${starValueText(book.rating)}</span>` : '',
    ].filter(Boolean).join('');

    return `<div class="book-expanded-wrap" data-expanded-id="${esc(book.id)}">
      <div class="expanded-top">
        <div class="book-cover-box" style="--spine-bg:${esc(book.spineColor)}" data-open-detail="${esc(book.id)}" role="button" tabindex="0" aria-label="查看详情">
          ${typoCover(book)}
          ${book.coverUrl ? `<img src="${esc(book.coverUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
        </div>
        <div class="expanded-meta">
          <div class="expanded-head-row">
            <h3 class="expanded-title" data-open-detail="${esc(book.id)}">${esc(book.title)}</h3>
            <button class="expanded-close" type="button" data-deselect="1" aria-label="收起">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="expanded-author">${esc(book.author)}</div>
          <div class="expanded-tags">${tags}</div>
          <div class="expanded-progress">
            <div class="progress-label-row">
              <span>阅读进度</span>
              <span>${Math.round(book.progress)}%${book.pages ? ` · ${Math.round(book.pages * book.progress / 100)}/${book.pages} 页` : ''}</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${clamp(book.progress, 0, 100)}%"></div></div>
          </div>
        </div>
      </div>
      <div class="expanded-actions">
        <button class="exp-act-btn primary" type="button" data-act="timer" data-id="${esc(book.id)}">⏱ 计时</button>
        <button class="exp-act-btn" type="button" data-act="note" data-id="${esc(book.id)}">✍️ 笔记</button>
        <button class="exp-act-btn" type="button" data-act="detail" data-id="${esc(book.id)}">📖 详情</button>
        <button class="exp-act-btn" type="button" data-act="finish" data-id="${esc(book.id)}">${book.status === 'finished' ? '✓ 已读' : '✓ 读毕'}</button>
        <button class="exp-act-btn danger-soft" type="button" data-act="delete" data-id="${esc(book.id)}" title="从书架删除" aria-label="删除这本书">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>
    </div>`;
  }

  function renderChips() {
    const bar = $('#filterChipBar');
    if (!bar) return;
    const q = state.search.trim().toLowerCase();
    const base = state.books.filter((b) => {
      if (state.statusFilter !== 'all' && b.status !== state.statusFilter) return false;
      return matchesSearch(b, q);
    });
    const counter = new Map();
    base.forEach((b) => {
      const key = state.groupMode === 'genre' ? b.genre : b.author;
      counter.set(key, (counter.get(key) || 0) + 1);
    });
    const entries = Array.from(counter.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).slice(0, 14);

    if (entries.length <= 1 && state.chipFilter === 'all') { bar.innerHTML = ''; return; }

    const allChip = `<button type="button" class="filter-chip${state.chipFilter === 'all' ? ' active' : ''}" data-chip="all">全部<span class="chip-num">${base.length}</span></button>`;
    bar.innerHTML = allChip + entries.map(([name, count]) => (
      `<button type="button" class="filter-chip${state.chipFilter === name ? ' active' : ''}" data-chip="${esc(name)}">${esc(name)}<span class="chip-num">${count}</span></button>`
    )).join('');
  }

  function bindShelf() {
    const stage = $('#bookshelfContainer');
    stage?.addEventListener('click', (e) => {
      if (e.target.closest('[data-deselect]')) {
        state.selectedBookId = null;
        renderShelf();
        return;
      }
      const actBtn = e.target.closest('[data-act]');
      if (actBtn) {
        const id = actBtn.dataset.id;
        const act = actBtn.dataset.act;
        if (act === 'timer') openTimer(id);
        else if (act === 'note') openNoteEditor(id);
        else if (act === 'detail') openDetail(id);
        else if (act === 'finish') toggleFinished(id);
        else if (act === 'delete') confirmRemoveBook(id);
        return;
      }
      const openBtn = e.target.closest('[data-open-detail]');
      if (openBtn) { openDetail(openBtn.dataset.openDetail); return; }
      const coverItem = e.target.closest('.cover-book-item');
      if (coverItem) {
        const id = coverItem.dataset.coverId;
        if (state.selectedBookId === id) {
          openDetail(id);
        } else {
          state.selectedBookId = id;
          renderShelf();
          requestAnimationFrame(() => {
            const wrap = $('.book-expanded-wrap');
            if (wrap && wrap.getBoundingClientRect().bottom > window.innerHeight - 70) {
              wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          });
        }
        return;
      }
      const spine = e.target.closest('.book-spine');
      if (spine) {
        const id = spine.dataset.bookId;
        state.selectedBookId = state.selectedBookId === id ? null : id;
        renderShelf();
        if (state.selectedBookId) {
          requestAnimationFrame(() => {
            const wrap = $('.book-expanded-wrap');
            if (wrap && wrap.getBoundingClientRect().bottom > window.innerHeight - 70) {
              wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          });
        }
      }
    });

    $('#shelfEmpty')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-empty-act]');
      if (!btn) return;
      if (btn.dataset.emptyAct === 'add') openAddSheet();
      else if (btn.dataset.emptyAct === 'reset') {
        state.statusFilter = 'all';
        state.chipFilter = 'all';
        state.search = '';
        $('#searchInput').value = '';
        $('#searchClearBtn').classList.remove('show');
        $$('#statusPills .status-pill').forEach((p) => p.classList.toggle('active', p.dataset.status === 'all'));
        renderShelf();
      }
    });

    $('#filterChipBar')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chip]');
      if (!chip) return;
      state.chipFilter = chip.dataset.chip;
      renderShelf();
    });

    $('#statusPills')?.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-status]');
      if (!pill) return;
      state.statusFilter = pill.dataset.status;
      state.chipFilter = 'all';
      $$('#statusPills .status-pill').forEach((p) => p.classList.toggle('active', p === pill));
      renderShelf();
    });

    const setViewMode = (mode) => {
      if (!['spine', 'cover', 'list'].includes(mode)) mode = 'spine';
      state.viewMode = mode;
      kvSet('shelfView', mode);
      $$('#shelfViewToggle .view-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === mode));
      const hint = $('#shelfHintText');
      if (hint) {
        hint.textContent = mode === 'spine'
          ? '轻点书脊展开封面 · 再点进入详情'
          : mode === 'cover'
            ? '轻点封面展开操作 · 再点进入详情'
            : '轻点书目查看详情 · 右侧可快速计时';
      }
      renderShelf();
    };
    $('#shelfViewToggle')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (btn) setViewMode(btn.dataset.view);
    });
    // 初始化视图切换状态与提示文案
    $$('#shelfViewToggle .view-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === state.viewMode));
    const initHint = $('#shelfHintText');
    if (initHint && state.viewMode !== 'spine') {
      initHint.textContent = state.viewMode === 'cover'
        ? '轻点封面展开操作 · 再点进入详情'
        : '轻点书目查看详情 · 右侧可快速计时';
    }

    const setGroup = (mode) => {
      state.groupMode = mode;
      state.chipFilter = 'all';
      $('#groupByGenreBtn')?.classList.toggle('active', mode === 'genre');
      $('#groupByAuthorBtn')?.classList.toggle('active', mode === 'author');
      renderShelf();
    };
    $('#groupByGenreBtn')?.addEventListener('click', () => setGroup('genre'));
    $('#groupByAuthorBtn')?.addEventListener('click', () => setGroup('author'));
    $('#shelfSortSelect')?.addEventListener('change', (e) => { state.sort = e.target.value; renderShelf(); });

    let searchTimer = null;
    $('#searchInput')?.addEventListener('input', (e) => {
      const v = e.target.value;
      $('#searchClearBtn')?.classList.toggle('show', !!v);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = v; state.chipFilter = 'all'; renderShelf(); }, 120);
    });
    $('#searchClearBtn')?.addEventListener('click', () => {
      $('#searchInput').value = '';
      $('#searchClearBtn').classList.remove('show');
      state.search = '';
      renderShelf();
    });
  }

  async function confirmRemoveBook(id) {
    const b = getBook(id);
    if (!b) return;
    if (!window.confirm(`确定要从书架删除《${b.title}》吗？该书的笔记与阅读记录也会一并移除。`)) return;
    await removeBook(id);
    if (state.detailBookId === id) closeSheet('bookDetailBackdrop');
    renderShelf();
    renderDaily();
    renderStats();
    renderSettings();
    toast(`已删除《${b.title}》`);
  }

  function toggleFinished(id) {
    const b = getBook(id);
    if (!b) return;
    if (b.status === 'finished') {
      b.status = 'reading';
      b.progress = Math.min(b.progress, 99);
      saveBook(b);
      toast('已移回「在读」书架');
      return;
    }
    const prev = { status: b.status, progress: b.progress };
    b.status = 'finished';
    b.progress = 100;
    b.lastReadAt = Date.now();
    saveBook(b);
    renderDaily();
    toast(`《${b.title}》读毕 ✓ 辛苦了`, {
      undo: async () => {
        b.status = prev.status;
        b.progress = prev.progress;
        await saveBook(b);
        renderDaily();
        toast('已撤销');
      },
    });
    if (state.detailBookId === id) renderDetail();
  }

  /* =============================== 底部弹层 =============================== */
  function openSheet(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open');
    if (!$$('.sheet-backdrop.open').length) document.body.style.overflow = '';
    if (id === 'bookDetailBackdrop') { state.detailBookId = null; state.mindmap = null; }
    if (id === 'noteEditorBackdrop') stopDictation();
  }

  function bindSheets() {
    $$('.sheet-backdrop').forEach((bd) => {
      bd.addEventListener('click', (e) => {
        if (e.target === bd) closeSheet(bd.id);
      });
    });
    document.addEventListener('click', (e) => {
      const closer = e.target.closest('[data-close-sheet]');
      if (closer) closeSheet(closer.dataset.closeSheet);
    });
  }

  /* =============================== 添加 / 编辑书籍 =============================== */
  function buildGenreGrid() {
    const grid = $('#genreSelectGrid');
    if (!grid) return;
    grid.innerHTML = (window.BOOK_GENRES || []).map((g) => (
      `<button type="button" class="genre-opt${g === state.formGenre ? ' active' : ''}" data-genre="${esc(g)}">${esc(g)}</button>`
    )).join('');
  }

  function buildSwatches(container, current, onPick) {
    if (!container) return;
    container.innerHTML = (window.SPINE_COLORS || []).map((c) => (
      `<button type="button" class="swatch-dot${c.toLowerCase() === String(current).toLowerCase() ? ' active' : ''}" data-color="${esc(c)}" style="background:${esc(c)}" aria-label="色调 ${esc(c)}"></button>`
    )).join('');
    container.onclick = (e) => {
      const dot = e.target.closest('[data-color]');
      if (!dot) return;
      onPick(dot.dataset.color);
      $$('.swatch-dot', container).forEach((d) => d.classList.toggle('active', d === dot));
    };
  }

  function buildStarPicker(container, current, onChange) {
    if (!container) return;
    container.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'star-btn';
      btn.dataset.index = String(i);
      const cls = current >= i ? 'full' : (current >= i - 0.5 ? 'half' : 'empty');
      btn.classList.add(cls);
      btn.innerHTML = '<span class="star-glyph">★</span>';
      btn.addEventListener('click', (ev) => {
        const rect = btn.getBoundingClientRect();
        const half = (ev.clientX - rect.left) < rect.width / 2;
        const value = i - (half ? 0.5 : 0);
        const next = Math.abs(value - current) < 0.001 ? 0 : value;
        onChange(next);
      });
      container.appendChild(btn);
    }
    if (!$$('.star-clear-btn', container).length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'star-clear-btn';
      clear.textContent = '清除';
      clear.addEventListener('click', () => onChange(0));
      container.appendChild(clear);
    }
  }

  function setAddMode(mode) {
    state.addMode = mode;
    $$('#addBookModeTabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.addMode === mode));
    $('#bookSearchPanel')?.classList.toggle('hidden', mode !== 'search');
    $('#bookForm')?.classList.toggle('hidden', mode !== 'manual');
    $('#bookFormFooter')?.classList.toggle('hidden', mode !== 'manual');
  }

  function resetBookForm() {
    state.editingId = null;
    state.coverData = null;
    state.formRating = 0;
    state.formGenre = (window.BOOK_GENRES || ['小说'])[0];
    state.formColor = (window.SPINE_COLORS || ['#2F6354'])[0];
    ['bookTitleInput', 'bookAuthorInput', 'bookPagesInput', 'bookWordsInput', 'bookSummaryInput'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const status = $('#bookStatusInput'); if (status) status.value = 'reading';
    const img = $('#coverPreviewImg'); if (img) { img.src = ''; img.classList.add('hidden'); }
    $('#coverPlaceholderBox')?.classList.remove('hidden');
    $('#removeCoverBtn')?.classList.add('hidden');
    $('#formRatingLabel').textContent = '未评分';
    buildSwatches($('#spineSwatchRow'), state.formColor, (c) => { state.formColor = c; });
    buildGenreGrid();
    renderFormStars();
    $('#addBookTitle').textContent = '添加书籍';
    $('#saveBookBtn').textContent = '保存到书架';
  }

  function fillBookForm(book) {
    state.editingId = book.id;
    state.formRating = book.rating || 0;
    state.formGenre = book.genre || (window.BOOK_GENRES || ['小说'])[0];
    state.formColor = book.spineColor || (window.SPINE_COLORS || ['#2F6354'])[0];
    state.coverData = book.coverUrl || null;
    $('#bookTitleInput').value = book.title || '';
    $('#bookAuthorInput').value = book.author || '';
    $('#bookPagesInput').value = book.pages || '';
    $('#bookWordsInput').value = book.wordsWan || '';
    $('#bookStatusInput').value = book.status || 'reading';
    $('#bookSummaryInput').value = book.summary || '';
    if (book.coverUrl) {
      $('#coverPreviewImg').src = book.coverUrl;
      $('#coverPreviewImg').classList.remove('hidden');
      $('#coverPlaceholderBox').classList.add('hidden');
      $('#removeCoverBtn').classList.remove('hidden');
    }
    $('#formRatingLabel').textContent = book.rating ? starValueText(book.rating) : '未评分';
    buildSwatches($('#spineSwatchRow'), state.formColor, (c) => { state.formColor = c; });
    buildGenreGrid();
    renderFormStars();
    $('#addBookTitle').textContent = '编辑书籍';
    $('#saveBookBtn').textContent = '保存修改';
  }

  function renderFormStars() {
    const label = $('#formRatingLabel');
    if (label) label.textContent = state.formRating ? starValueText(state.formRating) : '未评分';
    buildStarPicker($('#formStarPicker'), state.formRating, (v) => {
      state.formRating = v;
      renderFormStars();
    });
  }

  function openAddSheet(book = null) {
    resetBookForm();
    $('#onlineBookList').innerHTML = '';
    $('#onlineBookQuery').value = '';
    $('#onlineBookStatus').textContent = '仅抓取封面、简介、页数与估算字数，不涉及版权正文';
    if (book) {
      fillBookForm(book);
      setAddMode('manual');
    } else {
      setAddMode('search');
    }
    openSheet('addBookBackdrop');
  }

  function bindAddBook() {
    $('#openAddBookBtn')?.addEventListener('click', () => openAddSheet());
    $('#addBookModeTabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add-mode]');
      if (btn) setAddMode(btn.dataset.addMode);
    });
    $('#genreSelectGrid')?.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-genre]');
      if (!opt) return;
      state.formGenre = opt.dataset.genre;
      $$('#genreSelectGrid .genre-opt').forEach((o) => o.classList.toggle('active', o === opt));
    });

    $('#coverPicker')?.addEventListener('click', () => $('#coverFileInput')?.click());
    $('#coverFileInput')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const data = await compressImage(file, 900, 0.82);
      state.coverData = data;
      $('#coverPreviewImg').src = data;
      $('#coverPreviewImg').classList.remove('hidden');
      $('#coverPlaceholderBox').classList.add('hidden');
      $('#removeCoverBtn').classList.remove('hidden');
      extractCoverColor(data).then((hex) => {
        if (hex) {
          state.formColor = hex;
          toast('已根据封面自动匹配书脊色调');
        }
      });
      e.target.value = '';
    });
    $('#removeCoverBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.coverData = null;
      $('#coverPreviewImg').src = '';
      $('#coverPreviewImg').classList.add('hidden');
      $('#coverPlaceholderBox').classList.remove('hidden');
      $('#removeCoverBtn').classList.add('hidden');
    });

    $('#onlineBookSearchBtn')?.addEventListener('click', () => searchOnlineBooks($('#onlineBookQuery').value));
    $('#onlineBookQuery')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); searchOnlineBooks(e.target.value); }
    });
    $('#bookSearchHotTags')?.addEventListener('click', (e) => {
      const tag = e.target.closest('[data-book-hot]');
      if (!tag) return;
      $('#onlineBookQuery').value = tag.dataset.bookHot;
      searchOnlineBooks(tag.dataset.bookHot);
    });
    $('#quickAddStatusSeg')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-quick-status]');
      if (!btn) return;
      state.quickAddStatus = btn.dataset.quickStatus || 'reading';
      $$('#quickAddStatusSeg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    });
    $('#onlineBookList')?.addEventListener('click', (e) => {
      const addBtn = e.target.closest('[data-add-result]');
      const editBtn = e.target.closest('[data-edit-result]');
      if (!addBtn && !editBtn) return;
      const idx = parseInt((addBtn || editBtn).dataset.addResult || (addBtn || editBtn).dataset.editResult, 10);
      const item = state.searchResults[idx];
      if (!item) return;
      const chosenStatus = state.quickAddStatus || 'reading';
      if (addBtn) { quickAddBook(item, chosenStatus); }
      else {
        const draft = normalizeBook({
          title: item.title, author: item.author, genre: item.genre,
          pages: item.pages, wordsWan: item.wordsWan, summary: item.summary,
          coverUrl: item.coverUrl, spineColor: item.spineColor,
          status: chosenStatus, createdAt: Date.now(), updatedAt: Date.now(),
        });
        fillBookForm(draft);
        state.editingId = null;
        setAddMode('manual');
      }
    });

    $('#saveBookBtn')?.addEventListener('click', saveBookFromForm);
  }

  function collectCoverData() {
    return state.coverData || '';
  }

  async function saveBookFromForm() {
    const title = ($('#bookTitleInput').value || '').trim();
    if (!title) { toast('请填写书名'); $('#bookTitleInput').focus(); return; }
    const author = ($('#bookAuthorInput').value || '').trim() || '佚名';
    const pages = Math.round(num($('#bookPagesInput').value, 0));
    let wordsWan = num($('#bookWordsInput').value, 0);
    if (!wordsWan && pages) wordsWan = +(pages * 0.065).toFixed(1);

    const dup = state.books.find((b) => b.title === title && b.author === author && b.id !== state.editingId);
    if (dup) { toast('书架上已有同名同作者的书'); return; }

    if (state.editingId) {
      const book = getBook(state.editingId);
      if (!book) return;
      Object.assign(book, {
        title, author, pages, wordsWan,
        genre: state.formGenre,
        spineColor: state.formColor,
        rating: state.formRating,
        status: $('#bookStatusInput').value,
        summary: ($('#bookSummaryInput').value || '').trim(),
        coverUrl: collectCoverData(),
      });
      if (book.status === 'finished') book.progress = 100;
      await saveBook(book);
      syncBookColorFromCover(book);
      toast('书籍信息已更新');
      closeSheet('addBookBackdrop');
      if (state.detailBookId) renderDetail();
      return;
    }

    const book = normalizeBook({
      id: uid('bk'),
      title, author, pages, wordsWan,
      genre: state.formGenre,
      spineColor: state.formColor,
      rating: state.formRating,
      status: $('#bookStatusInput').value,
      summary: ($('#bookSummaryInput').value || '').trim(),
      coverUrl: collectCoverData(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (book.status === 'finished') book.progress = 100;
    await saveBook(book);
    syncBookColorFromCover(book);
    closeSheet('addBookBackdrop');
    state.selectedBookId = book.id;
    renderShelf();
    renderDaily();
    toast(`《${book.title}》已放上书架`);
  }

  async function quickAddBook(item, preferredStatus) {
    const dup = state.books.find((b) => b.title === item.title && b.author === item.author);
    if (dup) { toast('这本书已在书架上'); return; }
    const status = preferredStatus || state.quickAddStatus || 'reading';
    const book = normalizeBook({
      id: uid('bk'),
      title: item.title,
      author: item.author || '佚名',
      genre: item.genre || '小说',
      pages: item.pages || 0,
      wordsWan: item.wordsWan || 0,
      summary: item.summary || '',
      coverUrl: item.coverUrl || '',
      spineColor: item.spineColor || pickColorFor(item.title),
      status,
      progress: status === 'finished' ? 100 : 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await saveBook(book);
    syncBookColorFromCover(book);
    toast(`《${book.title}》已加入「${STATUS_LABELS[status] || '书架'}」`);
    if (state.searchResults.length) renderOnlineResults(state.searchResults);
    renderDaily();
  }

  function pickColorFor(text) {
    const colors = window.SPINE_COLORS || ['#2F6354'];
    let h = 0;
    for (let i = 0; i < String(text).length; i++) h = (h * 31 + String(text).charCodeAt(i)) % 9973;
    return colors[h % colors.length];
  }

  /* =============================== 联网搜书 =============================== */
  // 精细 16 类题材识别：按高特异度优先匹配（推理/科幻/武侠/技术优先于泛文学小说）
  const GENRE_KEYWORDS = [
    ['推理悬疑', [
      'mystery', 'thriller', 'detective', 'crime', 'suspense', 'whodunit', 'noir', 'murder',
      '推理', '悬疑', '侦探', '谋杀', '凶手', '命案', '密室', '破案', '法医', '犯罪', '刑警', '嫌疑人',
      '东野圭吾', '阿加莎', '克里斯蒂', '柯南道尔', '福尔摩斯', '岛田庄司', '绫辻行人', '江户川乱步',
      '横沟正史', '松本清张', '宫部美雪', '伊坂幸太郎', '紫金陈', '雷米', '秦明', '周浩晖', '白夜行', '恶意', '解忧'
    ]],
    ['科幻奇幻', [
      'science fiction', 'sci-fi', 'fantasy', 'cyberpunk', 'dystopia', 'space opera', 'magic realism',
      '科幻', '奇幻', '魔幻', '赛博朋克', '反乌托邦', '星际', '外星', '宇宙文明', '三体', '基地', '沙丘',
      '刘慈欣', '阿西莫夫', '克拉克', '凡尔纳', '特德·姜', '郝景芳', '托尔金', '魔戒', '哈利·波特', '克苏鲁'
    ]],
    ['武侠仙侠', [
      'wuxia', 'xianxia', 'martial arts',
      '武侠', '仙侠', '江湖', '侠客', '修仙', '金庸', '古龙', '梁羽生', '温瑞安', '射雕', '天龙八部', '笑傲江湖'
    ]],
    ['技术编程', [
      'computers', 'programming', 'software', 'algorithm', 'artificial intelligence', 'machine learning', 'engineering',
      '编程', '算法', '计算机', '人工智能', '深度学习', '大模型', '架构', '代码', 'python', 'javascript', '系统设计', '软件工程'
    ]],
    ['历史纪实', [
      'history', 'historical', 'war', 'ancient', 'civilization', 'nonfiction', 'journalism',
      '历史', '朝代', '通史', '断代史', '战争', '文明史', '纪实', '非虚构', '明朝', '万历', '史记', '资治通鉴', '人类简史', '黄仁宇', '当年明月', '尤瓦尔'
    ]],
    ['哲学思辨', [
      'philosophy', 'ethics', 'logic', 'existentialism', 'stoicism', 'metaphysics',
      '哲学', '思辨', '存在主义', '伦理学', '美学', '逻辑学', '理想国', '尼采', '康德', '柏拉图', '萨特', '加缪', '叔本华', '维特根斯坦', '道德经', '论语', '庄子'
    ]],
    ['心理疗愈', [
      'psychology', 'self-help', 'mental health', 'therapy', 'counseling', 'mindfulness', 'cognitive',
      '心理', '疗愈', '情绪', '认知', '行为心理', '自我成长', '亲密关系', '依恋', '阿德勒', '弗洛伊德', '荣格', '被讨厌的勇气', '蛤蟆先生', '思考，快与慢', '丹尼尔·卡尼曼'
    ]],
    ['人物传记', [
      'biography', 'autobiography', 'memoir', 'diaries', 'letters',
      '传记', '自传', '回忆录', '评传', '书信集', '生平', '苏东坡传', '乔布斯传', '马斯克传', '曾国藩', '茨威格'
    ]],
    ['经济商业', [
      'business', 'economics', 'finance', 'investing', 'management', 'entrepreneurship', 'marketing', 'wealth',
      '经济', '商业', '金融', '投资', '理财', '管理', '创业', '财富', '资本', '市场', '原则', '纳瓦尔', '置身事内', '瑞·达利欧', '芒格', '巴菲特', '国富论'
    ]],
    ['社会政治', [
      'sociology', 'social science', 'political', 'politics', 'law', 'anthropology', 'public policy',
      '社会学', '社科', '政治', '法律', '人类学', '公共政策', '乡土中国', '乌合之众', '费孝通', '项飙', '政府', '制度'
    ]],
    ['科普自然', [
      'popular science', 'natural history', 'biology', 'physics', 'astronomy', 'evolution', 'ecology', 'nature', 'science',
      '科普', '自然科学', '生物学', '物理学', '天文', '进化论', '基因', '博物', '宇宙', '量子', '时间简史', '自私的基因', '道金斯', '霍金', '物种起源'
    ]],
    ['诗歌戏剧', [
      'poetry', 'poems', 'drama', 'plays', 'theater', 'theatre',
      '诗歌', '诗集', '诗词', '戏剧', '剧本', '话剧', '莎士比亚', '海子', '北岛', '顾城', '泰戈尔', '辛波斯卡', '宋词', '唐诗'
    ]],
    ['散文随笔', [
      'essay', 'essays', 'prose', 'belles-lettres', 'travelogue',
      '散文', '随笔', '杂文', '游记', '札记', '笔记', '我与地坛', '沉默的大多数', '史铁生', '王小波', '汪曾祺', '周作人', '梁实秋', '林清玄', '余秋雨'
    ]],
    ['艺术设计', [
      'art', 'design', 'architecture', 'photography', 'music', 'film', 'cinema', 'aesthetics',
      '艺术', '设计', '建筑', '摄影', '电影', '音乐', '美术', '绘画', '书法', '艺术的故事', '贡布里希', '原研哉'
    ]],
    ['生活美学', [
      'cooking', 'food', 'travel', 'lifestyle', 'health', 'fitness', 'gardening', 'minimalism',
      '美食', '烹饪', '旅行', '生活美学', '极简', '断舍离', '家居', '茶道', '咖啡', '健康', '养生'
    ]],
    ['文学小说', [
      'literary', 'literature', 'fiction', 'novel', 'classics', 'romance',
      '文学', '小说', '长篇', '短篇', '名著', '古典', '太宰治', '人间失格', '余华', '活着', '马尔克斯', '红楼梦', '村上春树', '黑塞', '小王子'
    ]],
  ];

  function mapGenre(raw, meta = null) {
    const parts = [raw || ''];
    if (meta) {
      if (meta.title) parts.push(meta.title);
      if (meta.author) parts.push(meta.author);
      if (meta.summary) parts.push(meta.summary.slice(0, 180));
    }
    const text = parts.join(' ').toLowerCase();
    for (const [genre, keys] of GENRE_KEYWORDS) {
      if (keys.some((k) => text.includes(k))) return genre;
    }
    return '文学小说';
  }

  async function searchOnlineBooks(query) {
    const q = String(query || '').trim();
    const status = $('#onlineBookStatus');
    const listEl = $('#onlineBookList');
    if (!q) { status.textContent = '请输入书名、作者或 ISBN'; return; }

    const searchToken = ++state.searchSeq;
    let onlineList = [];
    const sources = new Set();

    const applyMerged = (done) => {
      if (state.searchSeq !== searchToken) return;
      const merged = mergeResults([], onlineList, q);
      state.searchResults = merged;
      if (merged.length) {
        const srcText = [...sources].join(' + ');
        status.textContent = done
          ? `全网来源：${srcText} · 共 ${merged.length} 个版本（含封面、字数与简介）`
          : `已检索到 ${merged.length} 个版本（${srcText}）· 正在加载更多版本与字数…`;
        renderOnlineResults(merged);
      } else if (done) {
        status.textContent = '全网未找到匹配版本，试试更简短的书名或作者，也可以手动录入。';
        listEl.innerHTML = '<div class="search-empty">没有匹配的书籍，可直接「手动录入」。</div>';
      }
    };

    status.textContent = `正在全网检索「${q}」不同版本…`;
    listEl.innerHTML = '<div class="search-skeleton">正在全网检索不同版本封面、简介与字数…</div>';

    // 按查询意图并发全网检索：iOS 原生走 URLSession 无 CORS 限制，直连微信读书 + 豆瓣多版本
    const isbn = parseIsbn(q);
    const isCJK = hasCJK(q);
    const handleSource = (p) => p.then((res) => {
      if (state.searchSeq !== searchToken) return;
      if (res && res.list && res.list.length) {
        const tagged = res.list.map((item, idx) => ({
          ...item,
          _source: res.source || '全网',
          _rank: idx + 1,
        }));
        onlineList = onlineList.concat(tagged);
        if (res.source) sources.add(res.source);
        applyMerged(false);
      }
    }).catch(() => {});

    const canFullWeb = bridge.available || isLocalDevProxy();
    const tasks = [];
    if (isbn) {
      tasks.push(
        handleSource(fetchGoogleBooks(`isbn:${isbn}`)),
        handleSource(fetchOpenLibrary(`isbn:${isbn}`)),
        handleSource(fetchAppleBooks(isbn)),
      );
      if (canFullWeb) {
        tasks.push(handleSource(fetchDoubanBooks(isbn)), handleSource(fetchWeReadBooks(isbn)));
      }
    } else if (isCJK) {
      if (canFullWeb) {
        // 原生 App（URLSession）与本地代理预览：直连中文全网源（微信读书 + 豆瓣多版本 + 百度百科）
        tasks.push(
          handleSource(fetchWeReadBooks(q)),
          handleSource(fetchDoubanBooks(q)),
          handleSource(fetchBaiduBaike(q)),
        );
      }
      tasks.push(
        handleSource(fetchAppleBooks(q)),
        handleSource(fetchGoogleBooks(q)),
        handleSource(fetchOpenLibrary(q)),
      );
    } else {
      tasks.push(
        handleSource(fetchOpenLibrary(q)),
        handleSource(fetchGoogleBooks(q)),
        handleSource(fetchAppleBooks(q)),
      );
      if (canFullWeb) {
        tasks.push(
          handleSource(fetchDoubanBooks(q)),
          handleSource(fetchWeReadBooks(q)),
          handleSource(fetchBaiduBaike(q)),
        );
      }
    }

    await Promise.all(tasks);
    if (state.searchSeq !== searchToken) return;
    applyMerged(true);
  }

  function hasCJK(str) {
    return /[\u4e00-\u9fff]/.test(String(str || ''));
  }

  function parseIsbn(str) {
    const clean = String(str || '').replace(/[-\s]/g, '').toUpperCase();
    return /^(97[89]\d{10}|\d{9}[\dX])$/.test(clean) ? clean : '';
  }

  function diceSimilarity(a, b) {
    const s1 = String(a || '').toLowerCase().replace(/\s+/g, '');
    const s2 = String(b || '').toLowerCase().replace(/\s+/g, '');
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;
    if (s1.length < 2 || s2.length < 2) return s1.includes(s2) || s2.includes(s1) ? 0.8 : 0;
    const bigrams = new Map();
    for (let i = 0; i < s1.length - 1; i++) {
      const bg = s1.slice(i, i + 2);
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
    let inter = 0;
    for (let i = 0; i < s2.length - 1; i++) {
      const bg = s2.slice(i, i + 2);
      const cnt = bigrams.get(bg) || 0;
      if (cnt > 0) {
        inter++;
        bigrams.set(bg, cnt - 1);
      }
    }
    return (2 * inter) / ((s1.length - 1) + (s2.length - 1));
  }

  function normalizeTitleKey(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[《》<>「」『』【】\[\]()（）]/g, '')
      .replace(/[:：\-—·,，.。!！?？\s]+/g, '')
      .replace(/(精装版|平装版|典藏版|珍藏版|完整版|全集|修订版|增订版|插图版|无删减版)$/g, '');
  }

  function scoreSearchItem(item, query) {
    const q = String(query || '').trim().toLowerCase();
    const qIsbn = parseIsbn(q);
    const qNorm = normalizeTitleKey(q);
    const title = String(item.title || '').toLowerCase();
    const tNorm = normalizeTitleKey(title);
    const author = String(item.author || '').toLowerCase();
    const summary = String(item.summary || '').toLowerCase();
    const queryIsCJK = hasCJK(q);

    // 1. RRF 倒数排名融合分（多源共同命中的同一本书自动获得叠加信任分）
    let score = (item._rrfScore || 0) * 1800;

    // 2. ISBN 精确命中最高置信度
    if (qIsbn && item.isbn && item.isbn === qIsbn) score += 160;

    // 3. 标题 & 作者 Dice Bigram 相似度 + 精确/前缀命中
    const titleDice = diceSimilarity(tNorm, qNorm);
    const authorDice = diceSimilarity(author, q);
    score += titleDice * 65 + authorDice * 35;

    if (tNorm === qNorm && qNorm) score += 90;
    else if (qNorm && tNorm.startsWith(qNorm)) score += 45;
    else if (qNorm && tNorm.includes(qNorm)) score += 24;

    if (q && author.includes(q)) score += 24;
    if (q && summary.includes(q)) score += 8;

    // 4. 语言匹配偏好
    if (queryIsCJK) {
      if (hasCJK(item.title)) score += 24;
      else score -= 24;
      if (hasCJK(item.summary)) score += 8;
      if (hasCJK(item.author)) score += 6;
    }

    // 5. 导读/解读/习题等衍生读物降权，让原著排前面
    if (/(导读|解读|精读|拆书|伴读|书评|习题|测试|试卷|考点|合集|名师)/.test(item.title || '')) {
      score -= 24;
    }

    // 6. 元数据完整度加成
    if (item.local) score += 16;
    if (item.coverUrl) score += 14;
    if (item.pages) score += 6;
    if ((item.summary || '').length > 24) score += 8;
    return score;
  }

  function mergeResults(local, online, query = '') {
    const queryIsCJK = hasCJK(query);
    const RRF_K = 60;
    const SOURCE_WEIGHT = {
      '微信读书': 1.35,
      '豆瓣读书': 1.30,
      'Apple Books': queryIsCJK ? 1.15 : 1.0,
      'Google Books': 1.1,
      'Open Library': queryIsCJK ? 0.95 : 1.15,
    };

    // 第一步：按归一化书名收集「最优页数 / 字数 / 简介 / 作者」作为同书元数据知识池，反哺各版本
    const metaByTitle = new Map();
    const allItems = [...(local || []), ...(online || [])].filter((x) => x && x.title);
    allItems.forEach((raw) => {
      const tk = normalizeTitleKey(raw.title);
      if (!tk) return;
      const cur = metaByTitle.get(tk) || { pages: 0, wordsWan: 0, summary: '', author: '' };
      if (!cur.pages && raw.pages) cur.pages = raw.pages;
      if (!cur.wordsWan && raw.wordsWan) cur.wordsWan = raw.wordsWan;
      if (raw.summary) {
        const curBetter = queryIsCJK && hasCJK(cur.summary) && !hasCJK(raw.summary);
        const rawBetter = queryIsCJK && hasCJK(raw.summary) && !hasCJK(cur.summary);
        if (rawBetter || (!curBetter && raw.summary.length > cur.summary.length)) {
          cur.summary = raw.summary;
        }
      }
      if (raw.author && raw.author !== '佚名') {
        if (!cur.author || (queryIsCJK && hasCJK(raw.author) && !hasCJK(cur.author))) {
          cur.author = raw.author;
        }
      }
      metaByTitle.set(tk, cur);
    });

    // 第二步：保留不同版本的独立封面（按「归一化书名 + 版本特征/封面URL」去重，不粗暴折叠不同装帧版本）
    const byEdition = new Map();
    allItems.forEach((raw, i) => {
      const tk = normalizeTitleKey(raw.title) || `${raw.title}|${raw.author}`.toLowerCase();
      const src = raw._source || '全网';
      const rank = raw._rank || (i + 1);
      const rrfDelta = (SOURCE_WEIGHT[src] || 1) / (RRF_K + rank);

      // 同一书名下：如果封面图不同、或年份/出版社不同，保留为独立版本供用户挑选封面
      const coverSig = raw.coverUrl ? raw.coverUrl.replace(/^https?:\/\//, '').split('?')[0] : '';
      const editionSig = coverSig || `${raw.year || ''}|${raw.publisher || ''}|${src}`;
      const edKey = `${tk}@@${editionSig}`;

      const prev = byEdition.get(edKey);
      if (!prev) {
        const shared = metaByTitle.get(tk) || {};
        const enriched = {
          ...raw,
          pages: raw.pages || shared.pages || 0,
          wordsWan: raw.wordsWan || shared.wordsWan || (raw.pages ? +(raw.pages * 0.065).toFixed(1) : (shared.pages ? +(shared.pages * 0.065).toFixed(1) : 0)),
          summary: raw.summary || shared.summary || '',
          author: (raw.author && raw.author !== '佚名') ? raw.author : (shared.author || '佚名'),
          _rrfScore: rrfDelta,
          _sourceLabel: src,
        };
        byEdition.set(edKey, enriched);
      } else {
        prev._rrfScore = (prev._rrfScore || 0) + rrfDelta;
        if (!prev.pages && raw.pages) prev.pages = raw.pages;
        if (!prev.wordsWan && raw.wordsWan) prev.wordsWan = raw.wordsWan;
        if (!prev.summary && raw.summary) prev.summary = raw.summary;
      }
    });

    return [...byEdition.values()]
      .sort((a, b) => scoreSearchItem(b, query) - scoreSearchItem(a, query))
      .slice(0, 18)
      .map((r) => ({ ...r, spineColor: r.spineColor || pickColorFor(r.title) }));
  }

  function renderOnlineResults(results) {
    const listEl = $('#onlineBookList');
    if (!listEl) return;
    listEl.innerHTML = results.map((r, i) => {
      const editionMeta = [
        r.year ? `${r.year}版` : '',
        r.publisher || '',
        r.translator ? `${r.translator} 译` : '',
      ].filter(Boolean).join(' · ');
      const subMeta = [
        r.author,
        r.genre,
        r.pages ? `${r.pages} 页` : '',
        r.wordsWan ? `约 ${fmtWords(r.wordsWan)}` : '',
      ].filter(Boolean).join(' · ');
      return `
      <div class="online-book-item">
        <div class="online-book-cover" style="--spine-bg:${esc(r.spineColor || pickColorFor(r.title))};position:relative">
          ${typoCover(r)}
          ${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
        </div>
        <div class="online-book-info">
          <h4>${esc(r.title)} ${r._sourceLabel ? `<span class="mini-tag primary">${esc(r._sourceLabel)}</span>` : ''}</h4>
          <div class="online-book-sub">${esc(subMeta)}</div>
          ${editionMeta ? `<div class="online-book-sub" style="opacity:.85">${esc(editionMeta)}</div>` : ''}
          <div class="online-book-desc">${esc(r.summary || '暂无简介，可加入后自行补充。')}</div>
          <div class="online-book-btns">
            <button type="button" class="btn btn-primary btn-sm" data-add-result="${i}">加入书架</button>
            <button type="button" class="btn btn-secondary btn-sm" data-edit-result="${i}">先编辑</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function stripHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function fetchWeReadBooks(q, timeout = 5500) {
    const data = await requestJson(`https://weread.qq.com/web/search/global?keyword=${encodeURIComponent(q)}&maxIdx=0&count=12`, { timeout, viaProxy: true });
    const list = (data.books || []).map((entry) => {
      const i = entry.bookInfo || {};
      const title = i.title || '';
      const author = i.author || '佚名';
      const summary = stripHtml(i.intro || '');
      const rawCover = i.cover || '';
      // 微信读书 s_ 替换为 t6_ 获取高清封面图
      const coverUrl = rawCover ? rawCover.replace(/\/s_([^/]+)$/, '/t6_$1') : '';
      const wordsWan = i.totalWords ? +(Number(i.totalWords) / 10000).toFixed(1) : 0;
      const pages = wordsWan ? Math.round(wordsWan / 0.065) : 0;
      return {
        title,
        author,
        translator: i.translator || '',
        publisher: i.publisher || '',
        year: i.publishTime ? String(i.publishTime).slice(0, 4) : '',
        genre: mapGenre(i.category || '', { title, author, summary }),
        pages,
        wordsWan,
        summary: summary.length > 260 ? `${summary.slice(0, 260)}…` : summary,
        coverUrl,
      };
    }).filter((x) => x.title);
    return { list, source: list.length ? '微信读书' : '' };
  }

  async function fetchDoubanBooks(q, timeout = 5500) {
    const data = await requestJson(`https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`, { timeout, viaProxy: true });
    const arr = Array.isArray(data) ? data : [];
    const list = arr.filter((d) => d && d.title && (!d.type || d.type === 'b')).slice(0, 12).map((d) => {
      const title = d.title || '';
      const author = d.author_name || '佚名';
      const rawPic = d.pic || '';
      // 豆瓣 /s/ 缩略图替换为 /l/ 高清版本封面
      const coverUrl = rawPic ? rawPic.replace('/subject/s/', '/subject/l/').replace(/^http:/, 'https:') : '';
      return {
        title,
        author,
        year: d.year || '',
        publisher: '',
        genre: mapGenre('', { title, author, summary: '' }),
        pages: 0,
        wordsWan: 0,
        summary: '',
        coverUrl,
      };
    });
    return { list, source: list.length ? '豆瓣读书' : '' };
  }

  function parseChineseWordsWan(rawText) {
    const s = String(rawText || '').replace(/,/g, '').trim();
    if (!s) return 0;
    const wanM = s.match(/([\d.]+)\s*万/);
    if (wanM) return +Number(wanM[1]).toFixed(1);
    const qianM = s.match(/([\d.]+)\s*千/);
    if (qianM) return +(Number(qianM[1]) / 10).toFixed(1);
    const numM = s.match(/([\d.]+)/);
    if (numM) {
      const n = Number(numM[1]);
      if (n >= 1000) return +(n / 10000).toFixed(1);
    }
    return 0;
  }

  async function fetchBaiduBaike(q, timeout = 5500) {
    const cleanQ = String(q || '').replace(/[《》]/g, '').trim();
    if (!cleanQ) return { list: [], source: '' };
    const data = await requestJson(`https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(cleanQ)}&bk_length=600`, { timeout, viaProxy: true });
    if (!data || !data.title) return { list: [], source: '' };
    const cards = Array.isArray(data.card) ? data.card : [];
    const getCard = (...names) => {
      for (const c of cards) {
        const n = String(c.name || '').trim();
        if (names.some((k) => n.includes(k))) {
          const v = Array.isArray(c.value) ? c.value.map((x) => stripHtml(String(x))).join(' / ') : stripHtml(String(c.value || ''));
          if (v) return v;
        }
      }
      return '';
    };
    const desc = stripHtml(data.desc || '');
    const summary = stripHtml(data.abstract || desc || '');
    const author = getCard('作者', '著者', '原著');
    const publisher = getCard('出版社', '出版机构');
    const translator = getCard('译者');
    const rawWords = getCard('字数');
    const rawPages = getCard('页数');
    const rawYear = getCard('出版时间', '首版时间', '发行时间');
    const rawType = getCard('文学体裁', '作品类型', '题材', '类别');
    const isBookLike = Boolean(author || publisher || rawWords || rawPages || /(小说|书籍|著作|散文|诗集|随笔|传记|长篇|中篇|短篇|文学|出版|丛书|读物|纪实)/.test(`${desc} ${summary} ${rawType}`));
    if (!isBookLike) return { list: [], source: '' };
    const wordsWan = parseChineseWordsWan(rawWords);
    const pagesMatch = rawPages.match(/(\d+)/);
    const pages = pagesMatch ? Number(pagesMatch[1]) : (wordsWan ? Math.round(wordsWan / 0.065) : 0);
    const yearMatch = rawYear.match(/(19|20)\d{2}/);
    const title = stripHtml(data.title || cleanQ);
    const coverUrl = data.image ? String(data.image).replace(/^http:/, 'https:') : '';
    return {
      list: [{
        title,
        author: author || '佚名',
        translator,
        publisher,
        year: yearMatch ? yearMatch[0] : '',
        genre: mapGenre(rawType, { title, author, summary }),
        pages,
        wordsWan,
        summary: summary.length > 260 ? `${summary.slice(0, 260)}…` : summary,
        coverUrl,
      }],
      source: '百度百科',
    };
  }

  async function fetchAppleBooks(q, timeout = 5500) {
    const data = await requestJson(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=ebook&limit=12`, { timeout });
    const list = (data.results || []).map((d) => {
      const art = d.artworkUrl100 || d.artworkUrl60 || '';
      const coverUrl = art ? art.replace(/\/\d+x\d+bb\./, '/400x400bb.') : '';
      const rawDesc = stripHtml(d.description || '');
      const summary = rawDesc.length > 260 ? `${rawDesc.slice(0, 260)}…` : rawDesc;
      const title = d.trackName || '';
      const author = d.artistName || '佚名';
      return {
        title,
        author,
        genre: mapGenre((d.genres || []).join(' '), { title, author, summary }),
        pages: 0,
        wordsWan: 0,
        summary,
        coverUrl,
      };
    }).filter((x) => x.title);
    return { list, source: list.length ? 'Apple Books' : '' };
  }

  async function fetchGoogleBooks(q, timeout = 4500) {
    const data = await requestJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10&printType=books`, { timeout });
    const list = (data.items || []).map((it) => {
      const v = it.volumeInfo || {};
      const pages = num(v.pageCount, 0);
      const img = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '';
      const ids = Array.isArray(v.industryIdentifiers) ? v.industryIdentifiers : [];
      const isbnObj = ids.find((x) => x.type === 'ISBN_13') || ids.find((x) => x.type === 'ISBN_10');
      const title = (v.title || '') + (v.subtitle ? `：${v.subtitle}` : '');
      const author = Array.isArray(v.authors) ? v.authors.join(' / ') : '佚名';
      const summary = stripHtml(v.description || '');
      return {
        title,
        author,
        genre: mapGenre((v.categories || []).join(' '), { title, author, summary }),
        pages,
        wordsWan: pages ? +(pages * 0.065).toFixed(1) : 0,
        summary,
        coverUrl: img ? img.replace(/^http:/, 'https:').replace(/&edge=curl/, '') : '',
        isbn: isbnObj ? isbnObj.identifier : '',
      };
    }).filter((x) => x.title);
    return { list, source: list.length ? 'Google Books' : '' };
  }

  async function fetchOpenLibrary(q, timeout = 4500) {
    const data = await requestJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&mode=everything&limit=10&fields=title,author_name,number_of_pages_median,first_sentence,cover_i,subject,isbn`, { timeout });
    const list = (data.docs || []).map((d) => {
      const pages = num(d.number_of_pages_median, 0);
      const isbns = Array.isArray(d.isbn) ? d.isbn : [];
      const isbn = isbns.find((x) => String(x).length === 13) || isbns[0] || '';
      const author = (d.author_name || ['佚名']).slice(0, 2).join(' / ');
      const summary = Array.isArray(d.first_sentence) ? d.first_sentence[0] : (d.first_sentence || '');
      return {
        title: d.title,
        author,
        genre: mapGenre((d.subject || []).slice(0, 4).join(' '), { title: d.title, author, summary }),
        pages,
        wordsWan: pages ? +(pages * 0.065).toFixed(1) : 0,
        summary,
        coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
        isbn,
      };
    }).filter((x) => x.title);
    return { list, source: list.length ? 'Open Library' : '' };
  }

  async function fetchGutendex(q, timeout = 5000) {
    const data = await requestJson(`https://gutendex.com/books/?search=${encodeURIComponent(q)}`, { timeout });
    const list = (data.results || []).slice(0, 8).map((d) => {
      const authors = (d.authors || []).map((a) => a.name).filter(Boolean).slice(0, 2).join(' / ') || '佚名';
      const subjects = [...(d.subjects || []), ...(d.bookshelves || [])].slice(0, 4).join(' · ');
      const coverUrl = (d.formats && d.formats['image/jpeg']) ? d.formats['image/jpeg'] : '';
      return {
        title: d.title || '',
        author: authors,
        genre: mapGenre(subjects, { title: d.title, author: authors, summary: subjects }),
        pages: 0,
        wordsWan: 0,
        summary: subjects ? `Project Gutenberg 开源公版名著 · 主题：${subjects}` : 'Project Gutenberg 开源公版名著',
        coverUrl,
      };
    }).filter((x) => x.title);
    return { list, source: list.length ? 'Gutendex 公版库' : '' };
  }

  /* =============================== 书籍详情 =============================== */
  function openDetail(id) {
    const book = getBook(id);
    if (!book) return;
    state.detailBookId = id;
    state.detailTab = 'overview';
    openSheet('bookDetailBackdrop');
    renderDetail();
  }

  function renderDetail() {
    const book = getBook(state.detailBookId);
    if (!book) return;
    $('#detailHeaderTitle').textContent = book.title;
    $$('#detailSubtabs .detail-tab').forEach((t) => t.classList.toggle('active', t.dataset.dtab === state.detailTab));
    const body = $('#bookDetailBody');
    if (state.detailTab === 'overview') renderDetailOverview(book, body);
    else if (state.detailTab === 'notes') renderDetailNotes(book, body);
    else if (state.detailTab === 'characters') renderDetailCharacters(book, body);
    else renderDetailLogs(book, body);
  }

  function bookSessionMinutes(bookId) {
    return sessionsOf(bookId).reduce((sum, s) => sum + num(s.minutes, 0), 0);
  }

  function renderDetailOverview(book, body) {
    const mins = bookSessionMinutes(book.id);
    const pagesRead = book.pages ? Math.round(book.pages * book.progress / 100) : 0;
    body.innerHTML = `
      <div class="detail-hero-card">
        <div class="book-cover-box" style="width:84px;--spine-bg:${esc(book.spineColor)}">
          ${typoCover(book)}
          ${book.coverUrl ? `<img src="${esc(book.coverUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
        </div>
        <div class="detail-hero-meta">
          <h2>${esc(book.title)}</h2>
          <div class="detail-hero-author">${esc(book.author)}</div>
          <div class="expanded-tags" style="margin-top:8px">
            <span class="mini-tag primary">${esc(book.genre)}</span>
            <span class="mini-tag">${STATUS_LABELS[book.status]}</span>
            ${book.pages ? `<span class="mini-tag">${book.pages} 页</span>` : ''}
            ${book.wordsWan ? `<span class="mini-tag">${fmtWords(book.wordsWan)}</span>` : ''}
          </div>
          <div class="detail-mini-stats">
            <span>累计 ${fmtDuration(mins)}</span>
            <span>${book.notes.length} 条笔记</span>
            <span>${(book.characters || []).length} 位人物</span>
          </div>
        </div>
      </div>

      <div class="detail-block">
        <div class="detail-block-head">
          <h4>阅读进度</h4>
          <span class="mini-tag primary" id="progressPercentLabel">${Math.round(book.progress)}%</span>
        </div>
        <input type="range" class="progress-slider" id="detailProgressSlider" min="0" max="100" step="1" value="${Math.round(book.progress)}">
        <div class="progress-label-row">
          <span id="detailPagesLabel">${book.pages ? `已读 ${pagesRead} / ${book.pages} 页` : '未填写总页数'}</span>
          <span id="detailWordsLabel">${book.wordsWan ? `约 ${fmtWords(book.wordsWan * book.progress / 100)}` : ''}</span>
        </div>
        <div class="expanded-actions" style="margin-top:12px;padding-top:10px">
          <button class="exp-act-btn" type="button" data-dact="minus10">−10%</button>
          <button class="exp-act-btn" type="button" data-dact="plus10">+10%</button>
          <button class="exp-act-btn primary" type="button" data-dact="finish">${book.status === 'finished' ? '重新在读' : '标记读毕'}</button>
          ${book.pages ? '<button class="exp-act-btn" type="button" data-dact="bypages">按页录入</button>' : '<span></span>'}
        </div>
        ${book.pages ? `<div class="page-entry-row hidden" id="pageEntryRow">
          <input type="number" min="0" max="${book.pages}" class="form-control" id="pageEntryInput" placeholder="输入当前页码 (1-${book.pages})">
          <button class="btn btn-soft btn-sm" type="button" data-dact="applyPages" style="height:42px">确定</button>
        </div>` : ''}
      </div>

      <div class="detail-block">
        <div class="detail-block-head"><h4>我的评分</h4><span class="form-label-hint" id="detailRatingLabel">${starValueText(book.rating)}</span></div>
        <div class="star-picker" id="detailStarPicker"></div>
      </div>

      <div class="detail-block">
        <div class="detail-block-head"><h4>内容简介</h4><span class="mini-tag">版权合规元数据</span></div>
        <p class="summary-prose">${esc(book.summary || '还没有简介。可在「编辑信息」中补充这本书讲了什么、最吸引你的看点。')}</p>
      </div>

      <div class="detail-block">
        <div class="detail-block-head"><h4>书籍信息</h4></div>
        <div class="info-rows">
          <div><span>字数</span><strong>${fmtWords(book.wordsWan)}</strong></div>
          <div><span>页数</span><strong>${book.pages || '—'}</strong></div>
          <div><span>累计阅读</span><strong>${fmtDuration(mins)}</strong></div>
          <div><span>最近阅读</span><strong>${book.lastReadAt ? fmtDate(book.lastReadAt) : '还没开始'}</strong></div>
          <div><span>录入时间</span><strong>${fmtDate(book.createdAt)}</strong></div>
          <div><span>笔记数量</span><strong>${book.notes.length} 条</strong></div>
        </div>
      </div>

      <div class="expanded-actions" style="border-top:none;padding-top:0">
        <button class="exp-act-btn primary" type="button" data-dact="timer">⏱ 开始计时</button>
        <button class="exp-act-btn" type="button" data-dact="note">✍️ 写笔记</button>
        <button class="exp-act-btn" type="button" data-dact="edit">✏️ 编辑</button>
        <button class="exp-act-btn danger-soft" type="button" data-dact="delete">🗑 删除</button>
      </div>`;

    const slider = $('#detailProgressSlider');
    slider?.addEventListener('input', () => {
      const v = clamp(num(slider.value, 0), 0, 100);
      $('#progressPercentLabel').textContent = `${Math.round(v)}%`;
      $('#detailPagesLabel').textContent = book.pages ? `已读 ${Math.round(book.pages * v / 100)} / ${book.pages} 页` : '未填写总页数';
      $('#detailWordsLabel').textContent = book.wordsWan ? `约 ${fmtWords(book.wordsWan * v / 100)}` : '';
    });
    slider?.addEventListener('change', async () => {
      const v = clamp(num(slider.value, 0), 0, 100);
      book.progress = v;
      if (v >= 100 && book.status !== 'finished') book.status = 'finished';
      if (v < 100 && book.status === 'finished') book.status = 'reading';
      book.lastReadAt = Date.now();
      await saveBook(book);
      toast(v >= 100 ? '已标记读完这本书 ✓' : `进度已更新到 ${Math.round(v)}%`);
      renderDetail();
      renderDaily();
    });

    const renderDetailStars = () => {
      buildStarPicker($('#detailStarPicker'), book.rating, async (v) => {
        book.rating = v;
        await saveBook(book, true);
        const label = $('#detailRatingLabel');
        if (label) label.textContent = starValueText(v);
        renderDetailStars();
        renderShelf();
        renderStats();
      });
    };
    renderDetailStars();

    body.querySelector('[data-dact="minus10"]')?.addEventListener('click', async () => {
      book.progress = clamp(book.progress - 10, 0, 100);
      if (book.status === 'finished') book.status = 'reading';
      await saveBook(book); renderDetail();
    });
    body.querySelector('[data-dact="plus10"]')?.addEventListener('click', async () => {
      book.progress = clamp(book.progress + 10, 0, 100);
      book.lastReadAt = Date.now();
      if (book.progress >= 100) book.status = 'finished';
      await saveBook(book); renderDetail();
    });
    body.querySelector('[data-dact="finish"]')?.addEventListener('click', () => { toggleFinished(book.id); renderDetail(); });
    body.querySelector('[data-dact="bypages"]')?.addEventListener('click', () => {
      $('#pageEntryRow')?.classList.toggle('hidden');
    });
    body.querySelector('[data-dact="applyPages"]')?.addEventListener('click', async () => {
      const p = clamp(num($('#pageEntryInput')?.value, 0), 0, book.pages);
      if (!p) { toast('请输入有效页码'); return; }
      book.progress = clamp((p / book.pages) * 100, 0, 100);
      if (book.progress >= 100) book.status = 'finished';
      book.lastReadAt = Date.now();
      await saveBook(book);
      toast(`已记录到第 ${p} 页`);
      renderDetail();
    });
    body.querySelector('[data-dact="timer"]')?.addEventListener('click', () => { closeSheet('bookDetailBackdrop'); openTimer(book.id); });
    body.querySelector('[data-dact="note"]')?.addEventListener('click', () => openNoteEditor(book.id));
    body.querySelector('[data-dact="edit"]')?.addEventListener('click', () => { closeSheet('bookDetailBackdrop'); openAddSheet(book); });
    body.querySelector('[data-dact="delete"]')?.addEventListener('click', async () => {
      closeSheet('bookDetailBackdrop');
      await removeBook(book.id);
      if (state.selectedBookId === book.id) state.selectedBookId = null;
      renderShelf();
      toast(`《${book.title}》已从书架移除`, {
        undo: async () => { await saveBook(book, true); renderShelf(); renderStats(); toast('已恢复'); },
      });
    });
  }

  function renderDetailNotes(book, body) {
    const notes = (book.notes || []).slice().sort((a, b) => b.createdAt - a.createdAt);
    body.innerHTML = `
      <div class="note-toolbar">
        <button class="btn btn-primary btn-sm" type="button" data-nact="add">+ 写一条笔记</button>
        <span class="note-count-hint">共 ${notes.length} 条</span>
      </div>
      <div id="noteListWrap">
        ${notes.length ? notes.map(noteCardHtml).join('') : `<div class="inline-empty">还没有笔记。可以语音口述感受、直接打字，或拍下纸质读书笔记自动提字。</div>`}
      </div>`;

    body.querySelector('[data-nact="add"]')?.addEventListener('click', () => openNoteEditor(book.id));
    body.querySelector('#noteListWrap')?.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del-note]');
      if (del) {
        const note = book.notes.find((n) => n.id === del.dataset.delNote);
        if (!note) return;
        book.notes = book.notes.filter((n) => n.id !== note.id);
        await saveBook(book, true);
        renderDetail(); renderStats(); renderDaily();
        toast('笔记已删除', {
          undo: async () => { book.notes.push(note); await saveBook(book, true); renderDetail(); renderStats(); toast('已恢复'); },
        });
        return;
      }
      const poster = e.target.closest('[data-note-poster]');
      if (poster) {
        const note = book.notes.find((n) => n.id === poster.dataset.notePoster);
        if (note) openPoster({ text: note.content, book: book.title, author: book.author });
      }
    });
  }

  function noteCardHtml(n) {
    return `<div class="note-card">
      <div class="note-card-head">
        <span class="note-type-chip ${esc(n.type || 'reflection')}">${NOTE_TYPE_LABELS[n.type] || '笔记'}</span>
        <span>${fmtDateTime(n.createdAt)}${n.page ? ` · ${esc(n.page)}` : ''}</span>
      </div>
      <div class="note-card-body">${esc(n.content || '')}</div>
      ${n.image ? `<img class="note-card-img" src="${esc(n.image)}" alt="读书笔记扫描图" loading="lazy">` : ''}
      <div class="note-card-actions">
        <button type="button" class="text-link-btn" data-note-poster="${esc(n.id)}">生成卡片</button>
        <button type="button" class="text-link-btn danger" data-del-note="${esc(n.id)}">删除</button>
      </div>
    </div>`;
  }

  function renderDetailCharacters(book, body) {
    const chars = book.characters || [];
    const rels = book.relations || [];
    body.innerHTML = `
      <div class="char-toolbar">
        <button class="btn btn-primary btn-sm" type="button" id="addCharBtn">+ 添加人物</button>
        <button class="btn btn-soft btn-sm" type="button" id="addRelBtn" ${chars.length < 2 ? 'disabled' : ''}>+ 添加关系</button>
        <span class="note-count-hint">${chars.length} 人 · ${rels.length} 条关系</span>
      </div>
      <div class="frontispiece-grid" id="frontispieceGrid">
        ${chars.length ? chars.map(charCardHtml).join('') : `<div class="inline-empty">先添加书中人物，再为人物之间连线，就能自动生成可拖动的思维导图，还能导出高清人物关系图。</div>`}
      </div>
      <div class="mindmap-shell" style="margin-top:14px">
        <div class="mindmap-topbar">
          <div class="mindmap-topbar-group">
            <button class="mm-btn" type="button" data-mm="zoomout">－</button>
            <button class="mm-btn" type="button" data-mm="zoomin">＋</button>
            <button class="mm-btn" type="button" data-mm="reset">复位</button>
          </div>
          <div class="mindmap-topbar-group">
            <button class="mm-btn" type="button" data-mm="relayout">自动排版</button>
            <button class="mm-btn" type="button" data-mm="export">导出图</button>
          </div>
        </div>
        <div class="mindmap-canvas-wrap" id="mindmapCanvasWrap"></div>
        <div class="mindmap-hint">拖动圆点调整位置 · 点击连线编辑关系 · 点节点编辑人物</div>
      </div>`;

    body.querySelector('#addCharBtn')?.addEventListener('click', () => openCharEditor(book.id));
    body.querySelector('#addRelBtn')?.addEventListener('click', () => openRelEditor(book.id));

    body.querySelector('#frontispieceGrid')?.addEventListener('click', (e) => {
      const card = e.target.closest('[data-char-id]');
      if (!card) return;
      const ch = book.characters.find((c) => c.id === card.dataset.charId);
      if (ch) openCharEditor(book.id, ch);
    });

    const wrap = body.querySelector('#mindmapCanvasWrap');
    if (wrap) {
      if (!chars.length) {
        wrap.innerHTML = '<div class="mindmap-empty">添加至少一位人物后，这里会生成可拖动的人物关系图。</div>';
      } else {
        try {
          state.mindmap = window.CharacterMindmap.createMindmap(wrap, book, {
            onTapCharacter: (ch) => openCharEditor(book.id, ch),
            onEditRelation: (rel) => openRelEditor(book.id, rel),
            onPositionsChanged: () => {
              clearTimeout(state.lastPersist);
              state.lastPersist = setTimeout(() => saveBook(book, true), 400);
            },
          });
        } catch {
          wrap.innerHTML = '<div class="mindmap-empty">关系图渲染失败，请重试。</div>';
        }
      }
    }

    body.querySelector('.mindmap-topbar')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-mm]');
      if (!btn) return;
      const mm = state.mindmap;
      const act = btn.dataset.mm;
      if (act === 'export') {
        if (!mm || !chars.length) { toast('先添加人物再导出'); return; }
        const dataUrl = mm.exportPngDataUrl(book.title);
        await shareDataUrl(dataUrl, `《${book.title}》人物关系图.png`);
        return;
      }
      if (!mm) return;
      if (act === 'zoomin') mm.zoom(0.15);
      else if (act === 'zoomout') mm.zoom(-0.15);
      else if (act === 'reset') mm.resetView();
      else if (act === 'relayout') { mm.relayout(); toast('已重新排版'); }
    });
  }

  function charCardHtml(ch) {
    return `<div class="frontispiece-card" data-char-id="${esc(ch.id)}" style="--char-color:${esc(ch.color || '#2F6354')}">
      <div class="frontispiece-head">
        <div class="char-avatar" style="--char-color:${esc(ch.color || '#2F6354')}">${esc((ch.name || '?').slice(0, 1))}</div>
        <div class="frontispiece-title">
          <strong>${esc(ch.name)}</strong>
          <small>${esc(ch.role || '书中人物')}</small>
        </div>
        <span class="mini-tag">编辑</span>
      </div>
      ${(ch.tags && ch.tags.length) ? `<div class="char-tags">${ch.tags.map((t) => `<span class="mini-tag primary">${esc(t)}</span>`).join('')}</div>` : ''}
      ${ch.bio ? `<p class="char-bio">${esc(ch.bio)}</p>` : ''}
      ${ch.quote ? `<div class="char-quote">「${esc(ch.quote)}」</div>` : ''}
    </div>`;
  }

  function renderDetailLogs(book, body) {
    const list = sessionsOf(book.id).slice().sort((a, b) => b.startedAt - a.startedAt);
    const total = list.reduce((s, x) => s + num(x.minutes, 0), 0);
    const byDay = new Map();
    list.forEach((s) => {
      const k = dateKey(s.startedAt);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(s);
    });
    body.innerHTML = `
      <div class="detail-block">
        <div class="detail-block-head"><h4>阅读记录</h4><span class="mini-tag primary">累计 ${fmtDuration(total)}</span></div>
        <div class="expanded-actions" style="border-top:none;padding-top:0">
          <button class="exp-act-btn primary" type="button" data-lact="timer">⏱ 开始计时</button>
          <button class="exp-act-btn" type="button" data-lact="manual">补记一次</button>
        </div>
      </div>
      ${list.length ? Array.from(byDay.entries()).map(([day, items]) => `
        <div class="log-day">
          <div class="log-day-head"><span>${day}</span><span>${fmtDuration(items.reduce((s, x) => s + num(x.minutes, 0), 0))}</span></div>
          ${items.map((s) => `<div class="session-row">
            <div>
              <strong>${fmtDuration(s.minutes)}</strong>
              <small>${pad2(new Date(s.startedAt).getHours())}:${pad2(new Date(s.startedAt).getMinutes())} · ${s.source === 'manual' ? '手动补记' : '专注计时'}</small>
            </div>
            <button class="text-link-btn danger" type="button" data-del-session="${esc(s.id)}">删除</button>
          </div>`).join('')}
        </div>`).join('') : `<div class="inline-empty">还没有阅读记录。用顶部的「计时」开始第一次专注阅读吧。</div>`}`;

    body.querySelector('[data-lact="timer"]')?.addEventListener('click', () => { closeSheet('bookDetailBackdrop'); openTimer(book.id); });
    body.querySelector('[data-lact="manual"]')?.addEventListener('click', () => { closeSheet('bookDetailBackdrop'); openTimer(book.id); setTimeout(() => $('#manualMinInput')?.focus(), 260); });
    body.querySelectorAll('[data-del-session]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await removeSession(btn.dataset.delSession);
        renderDetail();
        toast('记录已删除');
      });
    });
  }

  function bindDetail() {
    $('#detailSubtabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-dtab]');
      if (!tab) return;
      state.detailTab = tab.dataset.dtab;
      renderDetail();
    });
    $('#detailEditBookBtn')?.addEventListener('click', () => {
      const book = getBook(state.detailBookId);
      if (book) { closeSheet('bookDetailBackdrop'); openAddSheet(book); }
    });
  }

  /* =============================== 计时 =============================== */
  let timerInterval = null;

  function restoreTimer() {
    try {
      const raw = kvGet('timer');
      if (!raw) return;
      const t = JSON.parse(raw);
      if (!t || !t.bookId) return;
      state.timer = {
        bookId: t.bookId,
        running: !!t.running,
        startedAt: num(t.startedAt, 0),
        elapsedMs: num(t.elapsedMs, 0),
        ambient: 'off',
      };
      if (state.timer.running) startTimerTicker();
      updateTimerUI();
    } catch { /* ignore */ }
  }

  function persistTimer() {
    try { kvSet('timer', JSON.stringify(state.timer)); } catch { /* ignore */ }
  }

  function elapsedSeconds() {
    const t = state.timer;
    const extra = t.running && t.startedAt ? Date.now() - t.startedAt : 0;
    return (t.elapsedMs + extra) / 1000;
  }

  function startTimerTicker() {
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimerUI, 1000);
  }

  function updateTimerUI() {
    const sec = elapsedSeconds();
    const clock = $('#timerClockDisplay');
    if (clock) clock.textContent = fmtClock(sec);
    const t = state.timer;
    const book = getBook(t.bookId);
    const statusText = $('#timerStatusText');
    if (statusText) {
      if (t.running) statusText.textContent = `${book ? `《${book.title}》` : ''}专注中 · 已读 ${Math.max(1, Math.floor(sec / 60))} 分钟`;
      else if (sec > 2) statusText.textContent = `已暂停 · 本次 ${Math.floor(sec / 60)} 分 ${Math.floor(sec % 60)} 秒`;
      else statusText.textContent = '准备开始 · 自动记录阅读时段与时长';
    }
    const startBtn = $('#timerStartPauseBtn');
    if (startBtn) startBtn.textContent = t.running ? '暂停' : (sec > 2 ? '继续阅读' : '开始阅读');
    $('#timerFinishBtn')?.classList.toggle('hidden', sec < 1);
    $('#timerDiscardBtn')?.classList.toggle('hidden', !t.running && sec < 1);
    const headerLabel = $('#headerTimerLabel');
    if (headerLabel) headerLabel.textContent = sec >= 1 ? `${Math.floor(sec / 60)}:${pad2(Math.floor(sec % 60))}` : '计时';
    $('#openTimerQuickBtn')?.classList.toggle('running', t.running);
  }

  function openTimer(bookId) {
    const options = state.books.slice().sort((a, b) => {
      const rank = (x) => (x.status === 'reading' ? 0 : (x.status === 'want' ? 1 : 2));
      return rank(a) - rank(b) || (b.lastReadAt || 0) - (a.lastReadAt || 0);
    });
    const select = $('#timerBookSelect');
    if (select) {
      if (!state.books.length) {
        select.innerHTML = '<option value="">书架还没有书</option>';
      } else {
        select.innerHTML = options.map((b) => `<option value="${esc(b.id)}">${esc(b.title)} · ${STATUS_LABELS[b.status]}</option>`).join('');
      }
    }

    const t = state.timer;
    if (!t.running) {
      if (bookId && t.bookId !== bookId) {
        t.bookId = bookId;
        t.elapsedMs = 0;
        t.startedAt = 0;
        persistTimer();
      } else if (!t.bookId || !getBook(t.bookId)) {
        const fallback = options[0] ? options[0].id : null;
        t.bookId = fallback;
        persistTimer();
      }
    }
    if (select && t.bookId) select.value = t.bookId;
    // 默认把补记日期/时间初始化为当前日期时间，允许用户自由选择任意历史日期
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const dateInput = $('#manualDateInput');
    if (dateInput) {
      dateInput.max = todayStr;
      if (!dateInput.value) dateInput.value = todayStr;
    }
    const timeInput = $('#manualTimeInput');
    if (timeInput && !timeInput.value) {
      timeInput.value = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    }
    updateTimerUI();
    openSheet('timerBackdrop');
  }

  async function startPauseTimer() {
    const t = state.timer;
    const select = $('#timerBookSelect');
    if (select && select.value) {
      if (t.bookId !== select.value && !t.running) {
        t.bookId = select.value;
        t.elapsedMs = 0;
      }
    }
    if (!t.bookId) { toast('请先在书架添加书籍'); return; }
    if (t.running) {
      t.elapsedMs += Date.now() - t.startedAt;
      t.startedAt = 0;
      t.running = false;
      clearInterval(timerInterval);
      window.AmbientAudio?.stop();
      $$('#ambientSoundRow .ambient-chip').forEach((c) => c.classList.toggle('active', c.dataset.ambient === 'off'));
      t.ambient = 'off';
      toast('已暂停，记得回来继续');
    } else {
      t.startedAt = Date.now();
      t.running = true;
      startTimerTicker();
      if (t.ambient && t.ambient !== 'off') window.AmbientAudio?.setMode(t.ambient);
      toast('开始专注阅读 🕯');
    }
    persistTimer();
    updateTimerUI();
  }

  function discardTimerSession() {
    const t = state.timer;
    t.running = false;
    t.startedAt = 0;
    t.elapsedMs = 0;
    clearInterval(timerInterval);
    window.AmbientAudio?.stop();
    $$('#ambientSoundRow .ambient-chip').forEach((c) => c.classList.toggle('active', c.dataset.ambient === 'off'));
    t.ambient = 'off';
    persistTimer();
    updateTimerUI();
    toast('已撤销本次计时');
  }

  async function finishTimerSession() {
    const t = state.timer;
    const ms = t.running ? t.elapsedMs + (Date.now() - t.startedAt) : t.elapsedMs;
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (!t.bookId) { toast('请选择书籍'); return; }
    if (ms < 30000) {
      // 不足 30 秒时暂停并保留「撤销」按钮，允许用户继续读或一键撤销放弃
      if (t.running) {
        t.elapsedMs = ms;
        t.running = false;
        t.startedAt = 0;
        clearInterval(timerInterval);
        window.AmbientAudio?.stop();
        persistTimer();
        updateTimerUI();
      }
      toast('阅读不足 30 秒，可继续阅读或点「撤销」放弃');
      return;
    }
    const book = getBook(t.bookId);
    const startedAt = Date.now() - ms;
    await addSession({ id: uid('ss'), bookId: t.bookId, startedAt, minutes, source: 'timer' });
    if (book) {
      book.lastReadAt = Date.now();
      if (book.status === 'want') book.status = 'reading';
      await saveBook(book);
    }
    t.running = false;
    t.startedAt = 0;
    t.elapsedMs = 0;
    clearInterval(timerInterval);
    window.AmbientAudio?.stop();
    $$('#ambientSoundRow .ambient-chip').forEach((c) => c.classList.toggle('active', c.dataset.ambient === 'off'));
    t.ambient = 'off';
    persistTimer();
    updateTimerUI();
    closeSheet('timerBackdrop');
    renderStats();
    renderDaily();
    toast(`已记录 ${fmtDuration(minutes)} 阅读时间`);
    if (book) {
      state.detailBookId = book.id;
      state.detailTab = 'overview';
      openSheet('bookDetailBackdrop');
      renderDetail();
    }
  }

  function bindTimer() {
    $('#openTimerQuickBtn')?.addEventListener('click', () => openTimer());
    $('#timerStartPauseBtn')?.addEventListener('click', startPauseTimer);
    $('#timerFinishBtn')?.addEventListener('click', finishTimerSession);
    $('#timerDiscardBtn')?.addEventListener('click', discardTimerSession);
    $('#timerBookSelect')?.addEventListener('change', (e) => {
      if (state.timer.running) {
        toast('请先结束当前计时再切换书籍');
        e.target.value = state.timer.bookId || '';
        return;
      }
      state.timer.bookId = e.target.value;
      state.timer.elapsedMs = 0;
      persistTimer();
      updateTimerUI();
    });
    $('#ambientSoundRow')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-ambient]');
      if (!chip) return;
      const mode = chip.dataset.ambient;
      $$('#ambientSoundRow .ambient-chip').forEach((c) => c.classList.toggle('active', c === chip));
      state.timer.ambient = mode;
      if (mode === 'off' || !state.timer.running) window.AmbientAudio?.stop();
      else window.AmbientAudio?.setMode(mode);
    });

    const dateInput = $('#manualDateInput');
    const timeInput = $('#manualTimeInput');
    const initNow = new Date();
    if (dateInput) {
      const todayStr = `${initNow.getFullYear()}-${pad2(initNow.getMonth() + 1)}-${pad2(initNow.getDate())}`;
      dateInput.value = todayStr;
      dateInput.max = todayStr;
    }
    if (timeInput) {
      timeInput.value = `${pad2(initNow.getHours())}:${pad2(initNow.getMinutes())}`;
    }
    $('#saveManualSessionBtn')?.addEventListener('click', async () => {
      const mins = clamp(Math.round(num($('#manualMinInput').value, 0)), 1, 600);
      const bookId = $('#timerBookSelect')?.value || state.timer.bookId;
      if (!mins) { toast('请输入阅读分钟数'); return; }
      if (!bookId) { toast('请先选择书籍'); return; }
      const dateVal = $('#manualDateInput')?.value || '';
      const timeVal = $('#manualTimeInput')?.value || '';
      const now = new Date();
      let startedAt = now.getTime() - mins * 60000;
      if (dateVal) {
        const [yy, mo, dd] = dateVal.split('-').map((x) => parseInt(x, 10));
        const [hh, mm] = (timeVal || `${pad2(now.getHours())}:${pad2(now.getMinutes())}`).split(':').map((x) => parseInt(x, 10));
        const d = new Date(yy || now.getFullYear(), (mo || (now.getMonth() + 1)) - 1, dd || now.getDate(), hh || 0, mm || 0, 0, 0);
        if (!Number.isNaN(d.getTime())) {
          startedAt = Math.min(d.getTime(), now.getTime());
        }
      } else if (timeVal) {
        const [hh, mm] = timeVal.split(':').map((x) => parseInt(x, 10));
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 0, mm || 0, 0, 0);
        if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
        startedAt = d.getTime();
      }
      await addSession({ id: uid('ss'), bookId, startedAt, minutes: mins, source: 'manual' });
      const book = getBook(bookId);
      if (book) {
        book.lastReadAt = Math.max(book.lastReadAt || 0, startedAt);
        if (book.status === 'want') book.status = 'reading';
        await saveBook(book);
      }
      $('#manualMinInput').value = '';
      renderStats();
      renderShelf();
      renderDaily();
      toast(`已补记 ${dateKey(startedAt)} · ${fmtDuration(mins)}`);
      updateTimerUI();
    });
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateTimerUI(); });

  /* =============================== 笔记编辑器 =============================== */
  function setOcrStatus(text) {
    const el = $('#noteOcrStatus');
    if (el) el.textContent = text;
    const img = $('#noteScanPreviewImg');
    if (img) img.alt = text;
  }

  function setNoteImage(dataUrl) {
    state.noteImage = dataUrl;
    const wrap = $('#noteScanPreviewWrap');
    const img = $('#noteScanPreviewImg');
    if (!wrap || !img) return;
    if (dataUrl) {
      img.src = dataUrl;
      wrap.classList.remove('hidden');
      setOcrStatus('扫描图已保存');
    } else {
      img.src = '';
      wrap.classList.add('hidden');
      state.noteImage = null;
    }
  }

  function appendToNoteText(text) {
    const ta = $('#noteContentInput');
    if (!ta || !text) return;
    const needsNewline = ta.value && !ta.value.endsWith('\n');
    ta.value = ta.value + (needsNewline ? '\n' : '') + text;
    ta.dispatchEvent(new Event('input'));
  }

  function openNoteEditor(bookId, preset = null) {
    const book = getBook(bookId);
    if (!book) { toast('请先选择书籍'); return; }
    state.noteBookId = bookId;
    state.noteType = 'reflection';
    state.noteImage = null;
    $$('#noteTypeRow .hot-tag').forEach((t) => t.classList.toggle('active', t.dataset.noteType === 'reflection'));
    $('#noteContentInput').value = '';
    $('#notePageInput').value = '';
    $('#noteScanPreviewWrap')?.classList.add('hidden');
    if ($('#noteScanPreviewImg')) $('#noteScanPreviewImg').src = '';
    $('#notePhotoInput').value = '';
    $('#noteEditorTitle').textContent = `《${book.title}》笔记`;
    if (preset && preset.quote) {
      state.noteType = 'quote';
      $$('#noteTypeRow .hot-tag').forEach((t) => t.classList.toggle('active', t.dataset.noteType === 'quote'));
      $('#noteContentInput').value = preset.quote;
    }
    openSheet('noteEditorBackdrop');
    setTimeout(() => { if (!preset) $('#noteContentInput')?.focus(); }, 250);
  }

  function stopDictationUI() {
    state.dictating = false;
    state.dictationPrefix = null;
    $('#voiceInputBtn')?.classList.remove('recording');
    const label = $('#voiceBtnLabel');
    if (label) label.textContent = '🎙 语音输入';
  }

  function stopDictation() {
    if (state.recognition) {
      try { state.recognition.stop(); } catch { /* ignore */ }
      state.recognition = null;
    }
    if (state.dictating) bridge.post({ type: 'stopDictation' });
    stopDictationUI();
  }

  function startDictation() {
    const btn = $('#voiceInputBtn');
    const label = $('#voiceBtnLabel');
    if (state.dictating) { stopDictation(); return; }

    if (bridge.available) {
      const ta = $('#noteContentInput');
      state.dictationPrefix = ta ? ta.value : '';
      const ok = bridge.post({ type: 'startDictation', locale: 'zh-CN' });
      if (ok) {
        state.dictating = true;
        btn?.classList.add('recording');
        if (label) label.textContent = '🎙 正在聆听…点击停止';
        return;
      }
      state.dictationPrefix = null;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      try {
        const rec = new SR();
        rec.lang = 'zh-CN';
        rec.continuous = true;
        rec.interimResults = false;
        rec.onresult = (ev) => {
          let text = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            if (ev.results[i].isFinal) text += ev.results[i][0].transcript;
          }
          if (text) appendToNoteText(text.trim());
        };
        rec.onerror = () => { stopDictationUI(); toast('语音识别未开启权限或不受支持'); };
        rec.onend = () => stopDictationUI();
        rec.start();
        state.recognition = rec;
        state.dictating = true;
        btn?.classList.add('recording');
        if (label) label.textContent = '🎙 正在聆听…点击停止';
        return;
      } catch { /* fallthrough */ }
    }
    toast('当前环境不支持语音识别，可直接打字或拍照扫描');
  }

  async function compressImage(file, maxDim = 1400, quality = 0.82) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function runOcr(dataUrl) {
    if (!dataUrl) return;
    const ocrCfg = getMeta('ocrConfig', { mode: 'auto', ocrSpaceKeys: [] }) || { mode: 'auto', ocrSpaceKeys: [] };
    const mode = ocrCfg.mode || 'auto';
    const order = mode === 'vision_ai'
      ? ['vision_ai', 'apple', 'ocrspace']
      : (mode === 'ocrspace' ? ['ocrspace', 'apple', 'vision_ai'] : ['apple', 'vision_ai', 'ocrspace']);

    setOcrStatus('正在识别书页文字…');
    for (const engine of order) {
      if (engine === 'apple' && bridge.available) {
        const base64 = dataUrl.split(',')[1] || '';
        const ok = bridge.post({ type: 'recognizeOcr', imageBase64: base64, languages: ['zh-Hans', 'en-US'] });
        if (ok) return;
      }
      if (engine === 'vision_ai') {
        const visionNodes = getAiPool().filter((p) => p.visionModel && p.keys.length);
        if (visionNodes.length) {
          try {
            setOcrStatus('正在用免费视觉大模型识别…');
            const text = await ocrWithVisionPool(dataUrl);
            if (text) {
              appendToNoteText(text);
              setOcrStatus(`视觉大模型识别完成 · ${text.length} 字`);
              toast('扫描文字已提取');
              return;
            }
          } catch { /* fallback to next engine */ }
        }
      }
      if (engine === 'ocrspace') {
        try {
          setOcrStatus('正在用免费 OCR.space API 识别…');
          const text = await ocrWithOcrSpace(dataUrl);
          if (text) {
            appendToNoteText(text);
            setOcrStatus(`OCR.space 识别完成 · ${text.length} 字`);
            toast('扫描文字已提取');
            return;
          }
        } catch { /* fallback to next engine */ }
      }
    }
    setOcrStatus('未能自动识别文字，可手动输入或在「设置」配置视觉大模型 / OCR Key');
    toast('图片已保存；可手动补充或在设置添加免费 OCR Key');
  }

  async function ocrWithVisionPool(dataUrl) {
    const content = await callDoubao([
      { role: 'system', content: '你是中文读书笔记 OCR 助手，只准确输出图片中的正文文字，自动去掉页眉页码并整理好换行，不要任何解释。' },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: '请准确提取这张读书笔记/书页图片中的文字。' },
      ] },
    ], { vision: true, maxTokens: 1400, temperature: 0.2 });
    return String(content || '').trim();
  }

  async function ocrWithOcrSpace(dataUrl) {
    const ocrCfg = getMeta('ocrConfig', { mode: 'auto', ocrSpaceKeys: [] }) || {};
    const userKeys = Array.isArray(ocrCfg.ocrSpaceKeys) ? ocrCfg.ocrSpaceKeys.filter(Boolean) : [];
    const keys = userKeys.length ? [...userKeys, 'helloworld'] : ['helloworld'];
    let lastErr = null;
    for (const apiKey of keys) {
      try {
        const params = new URLSearchParams();
        params.set('base64Image', dataUrl);
        params.set('language', 'chs');
        params.set('isOverlayRequired', 'false');
        params.set('OCREngine', '2');
        params.set('scale', 'true');
        const data = await requestJson('https://api.ocr.space/parse/image', {
          method: 'POST',
          headers: {
            apikey: apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
          timeout: 25000,
        });
        if (data && !data.IsErroredOnProcessing && Array.isArray(data.ParsedResults)) {
          const text = data.ParsedResults.map((r) => String(r.ParsedText || '').trim()).filter(Boolean).join('\n').trim();
          if (text) return text;
        }
        lastErr = new Error((data && data.ErrorMessage && data.ErrorMessage[0]) || 'OCR.space 未返回文字');
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('OCR.space 识别失败');
  }

  function bindNoteEditor() {
    $('#noteTypeRow')?.addEventListener('click', (e) => {
      const tag = e.target.closest('[data-note-type]');
      if (!tag) return;
      state.noteType = tag.dataset.noteType;
      $$('#noteTypeRow .hot-tag').forEach((t) => t.classList.toggle('active', t === tag));
      if (state.noteType === 'scan') $('#notePhotoInput')?.click();
    });
    $('#voiceInputBtn')?.addEventListener('click', startDictation);
    $('#scanPhotoBtn')?.addEventListener('click', () => {
      $('#notePhotoInput')?.click();
    });
    $('#notePhotoInput')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const data = await compressImage(file, 1500, 0.82);
      setNoteImage(data);
      if (state.noteType !== 'scan') {
        state.noteType = 'scan';
        $$('#noteTypeRow .hot-tag').forEach((t) => t.classList.toggle('active', t.dataset.noteType === 'scan'));
      }
      e.target.value = '';
      runOcr(data);
    });
    $('#rerunOcrBtn')?.addEventListener('click', () => { if (state.noteImage) runOcr(state.noteImage); });
    $('#removeNotePhotoBtn')?.addEventListener('click', () => {
      setNoteImage(null);
      $('#notePhotoInput').value = '';
      setOcrStatus('扫描图已移除');
    });
    $('#saveNoteBtn')?.addEventListener('click', async () => {
      const book = getBook(state.noteBookId);
      if (!book) return;
      const content = ($('#noteContentInput').value || '').trim();
      if (!content && !state.noteImage) { toast('写点什么，或拍一张读书笔记'); return; }
      const note = {
        id: uid('nt'),
        type: state.noteType,
        content,
        page: ($('#notePageInput').value || '').trim(),
        image: state.noteImage || '',
        createdAt: Date.now(),
      };
      book.notes.push(note);
      await saveBook(book, true);
      if (book.status === 'want') book.status = 'reading';
      await saveBook(book, true);
      closeSheet('noteEditorBackdrop');
      renderShelf(); renderStats(); renderDaily();
      if (state.detailBookId === book.id) { state.detailTab = 'notes'; renderDetail(); }
      toast('笔记已保存');
    });
  }

  /* =============================== 人物 & 关系 =============================== */
  function openCharEditor(bookId, ch = null) {
    const book = getBook(bookId);
    if (!book) return;
    state.charBookId = bookId;
    state.editingCharId = ch ? ch.id : null;
    state.charColor = ch ? (ch.color || (window.SPINE_COLORS || ['#2F6354'])[0]) : (window.SPINE_COLORS || ['#2F6354'])[0];
    $('#charNameInput').value = ch ? ch.name : '';
    $('#charRoleInput').value = ch ? (ch.role || '') : '';
    $('#charTagsInput').value = ch && ch.tags ? ch.tags.join(' ') : '';
    $('#charBioInput').value = ch ? (ch.bio || '') : '';
    $('#charQuoteInput').value = ch ? (ch.quote || '') : '';
    $('#charEditorTitle').textContent = ch ? '编辑书中人物' : '添加书中人物';
    $('#deleteCharBtn').classList.toggle('hidden', !ch);
    buildSwatches($('#charColorRow'), state.charColor, (c) => { state.charColor = c; });
    openSheet('charEditorBackdrop');
    setTimeout(() => { if (!ch) $('#charNameInput')?.focus(); }, 250);
  }

  function bindCharEditor() {
    $('#saveCharBtn')?.addEventListener('click', async () => {
      const book = getBook(state.charBookId);
      if (!book) return;
      const name = ($('#charNameInput').value || '').trim();
      if (!name) { toast('请填写人物姓名'); return; }
      const tags = ($('#charTagsInput').value || '').split(/[\s,，、]+/).filter(Boolean).slice(0, 8);
      const payload = {
        name,
        role: ($('#charRoleInput').value || '').trim(),
        color: state.charColor,
        tags,
        bio: ($('#charBioInput').value || '').trim(),
        quote: ($('#charQuoteInput').value || '').trim(),
      };
      if (state.editingCharId) {
        const ch = book.characters.find((c) => c.id === state.editingCharId);
        if (ch) Object.assign(ch, payload);
        toast('人物信息已更新');
      } else {
        book.characters.push({ id: uid('ch'), ...payload });
        toast(`已添加人物「${name}」`);
      }
      await saveBook(book, true);
      closeSheet('charEditorBackdrop');
      if (state.detailBookId === book.id) { state.detailTab = 'characters'; renderDetail(); }
      renderShelf();
    });

    $('#deleteCharBtn')?.addEventListener('click', async () => {
      const book = getBook(state.charBookId);
      if (!book || !state.editingCharId) return;
      book.characters = book.characters.filter((c) => c.id !== state.editingCharId);
      book.relations = book.relations.filter((r) => r.from !== state.editingCharId && r.to !== state.editingCharId);
      await saveBook(book, true);
      closeSheet('charEditorBackdrop');
      if (state.detailBookId === book.id) renderDetail();
      toast('人物已删除');
    });
  }

  function openRelEditor(bookId, rel = null) {
    const book = getBook(bookId);
    if (!book) return;
    const chars = book.characters || [];
    if (chars.length < 2) { toast('至少添加两位人物才能连线'); return; }
    state.relBookId = bookId;
    state.editingRelId = rel ? rel.id : null;
    const fromSel = $('#relFromSelect');
    const toSel = $('#relToSelect');
    const opts = chars.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    fromSel.innerHTML = opts;
    toSel.innerHTML = opts;
    if (rel) {
      fromSel.value = rel.from;
      toSel.value = rel.to;
    } else {
      // 优先选中尚未连线的两个人，避免误覆盖既有关系
      const connected = new Set((book.relations || []).map((r) => `${r.from}|${r.to}`));
      const isFree = (a, b) => a.id !== b.id && !connected.has(`${a.id}|${b.id}`) && !connected.has(`${b.id}|${a.id}`);
      let pair = null;
      for (let i = 0; i < chars.length && !pair; i++) {
        for (let j = 0; j < chars.length; j++) {
          if (isFree(chars[i], chars[j])) { pair = [chars[i], chars[j]]; break; }
        }
      }
      if (!pair) pair = [chars[0], chars[1]];
      fromSel.value = pair[0].id;
      toSel.value = pair[1].id;
    }
    $('#relLabelInput').value = rel ? (rel.label || '') : '';
    $('#relToneSelect').value = rel ? (rel.tone || 'neutral') : 'neutral';
    $('#relEditorTitle').textContent = rel ? '编辑人物关系' : '添加人物关系连线';
    $('#deleteRelBtn').classList.toggle('hidden', !rel);
    openSheet('relEditorBackdrop');
  }

  function bindRelEditor() {
    $('#relPresetTags')?.addEventListener('click', (e) => {
      const tag = e.target.closest('[data-rel-preset]');
      if (!tag) return;
      $('#relLabelInput').value = tag.dataset.relPreset;
      const map = { 家人: 'bond', 挚友: 'bond', 恋人: 'love', 宿敌: 'rival', 师徒: 'mentor', 同盟: 'neutral' };
      const tone = map[tag.dataset.relPreset];
      if (tone) $('#relToneSelect').value = tone;
    });
    $('#saveRelBtn')?.addEventListener('click', async () => {
      const book = getBook(state.relBookId);
      if (!book) return;
      const from = $('#relFromSelect').value;
      const to = $('#relToSelect').value;
      const label = ($('#relLabelInput').value || '').trim();
      if (from === to) { toast('不能把人物连到自己'); return; }
      if (!label) { toast('请填写关系说明'); return; }
      const tone = $('#relToneSelect').value;
      if (state.editingRelId) {
        const rel = book.relations.find((r) => r.id === state.editingRelId);
        if (rel) Object.assign(rel, { from, to, label, tone });
        toast('关系已更新');
      } else {
        const dup = book.relations.find((r) => r.from === from && r.to === to);
        if (dup) { Object.assign(dup, { label, tone }); toast('已更新既有关联'); }
        else { book.relations.push({ id: uid('rl'), from, to, label, tone }); toast('关系已连线'); }
      }
      await saveBook(book, true);
      closeSheet('relEditorBackdrop');
      if (state.detailBookId === book.id) { state.detailTab = 'characters'; renderDetail(); }
    });
    $('#deleteRelBtn')?.addEventListener('click', async () => {
      const book = getBook(state.relBookId);
      if (!book || !state.editingRelId) return;
      book.relations = book.relations.filter((r) => r.id !== state.editingRelId);
      await saveBook(book, true);
      closeSheet('relEditorBackdrop');
      if (state.detailBookId === book.id) renderDetail();
      toast('关系已删除');
    });
  }

  /* =============================== 每日拾页 =============================== */
  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function topGenres(limit = 3) {
    const counter = new Map();
    state.books.forEach((b) => {
      const weight = b.status === 'finished' ? 2 : 1 + (b.rating || 0) / 5;
      counter.set(b.genre, (counter.get(b.genre) || 0) + weight);
    });
    return Array.from(counter.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
  }

  function quotePool() {
    const pool = (window.CURATED_QUOTES || []).map((q) => ({ ...q, own: false }));
    const saved = getMeta('savedQuotes', []);
    saved.forEach((s) => {
      if (s && s.manual && String(s.text || '').trim().length >= 4) {
        pool.push({ text: s.text.trim(), book: s.book || '随笔摘录', author: s.author || '佚名', genre: s.tag || '', own: true });
      }
    });
    state.books.forEach((b) => {
      (b.notes || []).forEach((n) => {
        if (n.type === 'quote' && String(n.content || '').trim().length >= 6) {
          pool.push({ text: n.content.trim(), book: b.title, author: b.author, genre: b.genre, own: true, noteId: n.id, bookId: b.id });
        }
      });
    });
    return pool;
  }

  function pickDailyQuotes() {
    const pool = quotePool();
    if (!pool.length) return [];
    const preferred = topGenres(3);
    const dayKey = dateKey();
    const seedBase = `${dayKey}#${state.dailyOffset}`;
    const scored = pool.map((q, i) => {
      const base = hashStr(`${seedBase}|${i}|${q.text.slice(0, 8)}`);
      const boost = preferred.includes(q.genre) ? 0.42 : (q.own ? 0.3 : 1);
      return { q, score: base * boost };
    }).sort((a, b) => a.score - b.score);
    const seen = new Set();
    const picked = [];
    for (const item of scored) {
      const key = item.q.text.slice(0, 16);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item.q);
      if (picked.length >= 5) break;
    }
    return picked;
  }

  function isQuoteSaved(q) {
    const saved = getMeta('savedQuotes', []);
    return saved.some((s) => s.text === q.text);
  }

  function renderDaily() {
    const label = $('#dailyDateLabel');
    if (label) {
      const d = new Date();
      label.textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 今日 5 条精华摘录`;
    }
    state.dailyQuotes = pickDailyQuotes();
    const listEl = $('#dailyQuotesList');
    if (listEl) {
      listEl.innerHTML = state.dailyQuotes.map((q, i) => {
        const saved = isQuoteSaved(q);
        return `<article class="quote-card">
          <span class="quote-index-badge">0${i + 1}</span>
          <p class="quote-text">「${esc(q.text)}」</p>
          <div class="quote-footer">
            <span class="quote-source">《${esc(q.book)}》 · ${esc(q.author)}${q.own ? ' · 我的书摘' : ''}</span>
            <div class="quote-actions">
              <button class="quote-act-btn${saved ? ' saved' : ''}" type="button" data-quote-save="${i}">${saved ? '已收藏' : '收藏'}</button>
              <button class="quote-act-btn" type="button" data-quote-poster="${i}">卡片</button>
            </div>
          </div>
        </article>`;
      }).join('');
    }
    renderMyQuotes();
    renderRecommendations();
  }

  function renderMyQuotes() {
    const saved = getMeta('savedQuotes', []);
    const sub = $('#myQuotesCountSub');
    if (sub) sub.textContent = `已收录 ${saved.length} 条 · 自动参与每日拾页回顾`;
    const listEl = $('#myQuotesList');
    if (!listEl) return;
    if (!saved.length) {
      listEl.innerHTML = `<div class="inline-empty" style="padding:18px 14px;text-align:center">
        还没有收录金句，点上方「+ 收录金句」记下打动你的句子，或在每日拾页点「收藏」。
      </div>`;
      return;
    }
    listEl.innerHTML = saved.map((q, i) => `
      <article class="quote-card">
        <p class="quote-text">「${esc(q.text)}」</p>
        <div class="quote-footer">
          <span class="quote-source">《${esc(q.book || '随笔摘录')}》${q.author ? ` · ${esc(q.author)}` : ''}${q.page ? ` · ${esc(q.page)}` : ''}${q.tag ? `<span class="my-quote-tag">${esc(q.tag)}</span>` : ''}</span>
          <div class="quote-actions">
            <button class="quote-act-btn" type="button" data-myquote-poster="${i}">卡片</button>
            <button class="quote-act-btn" type="button" data-myquote-del="${i}">删除</button>
          </div>
        </div>
      </article>`).join('');
  }

  function openQuoteCollector() {
    const pick = $('#quoteBookPick');
    if (pick) {
      pick.innerHTML = `<option value="">不从书架选，直接手填书名与作者</option>` + state.books.map((b) => (
        `<option value="${esc(b.id)}">《${esc(b.title)}》 · ${esc(b.author)}</option>`
      )).join('');
      pick.value = '';
    }
    $('#quoteTextInput').value = '';
    $('#quoteBookInput').value = '';
    $('#quoteAuthorInput').value = '';
    $('#quotePageInput').value = '';
    $('#quoteTagInput').value = '';
    openSheet('quoteEditorBackdrop');
    setTimeout(() => $('#quoteTextInput')?.focus(), 220);
  }

  async function saveCollectedQuote() {
    const text = ($('#quoteTextInput').value || '').trim();
    if (!text) { toast('请填写金句正文'); $('#quoteTextInput')?.focus(); return; }
    const book = ($('#quoteBookInput').value || '').trim() || '随笔摘录';
    const author = ($('#quoteAuthorInput').value || '').trim();
    const page = ($('#quotePageInput').value || '').trim();
    const tag = ($('#quoteTagInput').value || '').trim();
    const saved = getMeta('savedQuotes', []);
    saved.unshift({
      id: uid('qt'),
      text,
      book,
      author,
      page,
      tag,
      manual: true,
      savedAt: Date.now(),
    });
    await setMeta('savedQuotes', saved.slice(0, 300));
    closeSheet('quoteEditorBackdrop');
    renderMyQuotes();
    renderSettings();
    toast('金句已收录 ✓');
  }

  function computeUserTaste() {
    const bookMins = new Map();
    (state.sessions || []).forEach((s) => {
      if (!s.bookId) return;
      const mins = s.minutes != null ? num(s.minutes, 0) : (num(s.durationSec, 0) / 60);
      bookMins.set(s.bookId, (bookMins.get(s.bookId) || 0) + mins);
    });
    // 按用户自身平均阅读时长归一化，防止单本挂机时长垄断画像
    const loggedMins = [...bookMins.values()].filter((m) => m > 0);
    const avgBookMins = loggedMins.length ? (loggedMins.reduce((a, b) => a + b, 0) / loggedMins.length) : 60;

    const genreScore = new Map();
    const authorScore = new Map();
    const now = Date.now();
    let prefWordsSum = 0, prefWordsCnt = 0;

    state.books.forEach((b) => {
      const ageDays = Math.max(0, (now - (b.lastReadAt || b.updatedAt || b.createdAt || now)) / 86400000);
      // 指数时间衰减：高分书半衰期 365 天，普通书 180 天
      const halfLife = (b.rating || 0) >= 4.5 ? 365 : 180;
      const timeDecay = Math.pow(0.5, ageDays / halfLife);

      // 显式评分非线性加成 + 低分负反馈（<= 2 星降低同类权重）
      let ratingW = 0;
      if (b.rating > 0) {
        if (b.rating <= 2) ratingW = -1.2;
        else if (b.rating >= 4.5) ratingW = 3.2;
        else ratingW = (b.rating - 2.5) * 1.1;
      }

      const statusW = b.status === 'finished' ? 2.0 : (b.status === 'reading' ? 1.4 : 0.6);
      const normMins = Math.min(2.4, (bookMins.get(b.id) || 0) / Math.max(30, avgBookMins));
      const w = (statusW + ratingW + normMins) * (0.35 + 0.65 * timeDecay);

      genreScore.set(b.genre, (genreScore.get(b.genre) || 0) + w);
      if (b.author && b.author !== '佚名') {
        authorScore.set(b.author, (authorScore.get(b.author) || 0) + w * 0.9);
      }
      if (w > 1.5 && b.wordsWan > 0) {
        prefWordsSum += b.wordsWan;
        prefWordsCnt++;
      }
    });

    const sortedGenres = [...genreScore.entries()].filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    const sortedAuthors = [...authorScore.entries()].filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    const prefWordsWan = prefWordsCnt ? (prefWordsSum / prefWordsCnt) : 20;
    return { genreScore, authorScore, sortedGenres, sortedAuthors, prefWordsWan };
  }

  function bookPairSimilarity(a, b) {
    let sim = 0;
    if (a.author && b.author && a.author === b.author) sim += 0.65;
    if (a.genre && b.genre && a.genre === b.genre) sim += 0.35;
    return Math.min(1, sim);
  }

  function computeRecommendations() {
    const owned = new Set(state.books.map((b) => `${b.title}|${b.author}`.toLowerCase()));
    const ownedTitles = new Set(state.books.map((b) => normalizeTitleKey(b.title)));
    const { genreScore, authorScore, sortedGenres, sortedAuthors, prefWordsWan } = computeUserTaste();
    const finishedGenres = new Set(state.books.filter((b) => b.status === 'finished').map((b) => b.genre));
    const ownedGenres = new Set(state.books.map((b) => b.genre));
    const topGenre = sortedGenres[0]?.[0] || '';
    const topAuthor = sortedAuthors[0]?.[0] || '';

    // 合并内置精选书库 + 联网动态候选池，并去重过滤已录入书籍
    const poolMap = new Map();
    [...(window.CURATED_BOOKS || []), ...(state.onlineRecs || [])].forEach((b) => {
      if (!b || !b.title) return;
      const tk = normalizeTitleKey(b.title);
      if (ownedTitles.has(tk) || owned.has(`${b.title}|${b.author}`.toLowerCase())) return;
      if (!poolMap.has(tk)) poolMap.set(tk, b);
    });

    const allCands = [...poolMap.values()];
    const prevBatchKeys = new Set((state.recommendations || []).map((b) => normalizeTitleKey(b.title)));
    // 严格排除已看过的推荐书，保证手动「换一批」或定时刷新时 100% 全部替换
    let freshCands = allCands.filter((b) => !state.seenRecTitles.has(normalizeTitleKey(b.title)));
    if (freshCands.length < 4 && allCands.length >= 4) {
      // 候选池看遍一轮后重置历史，仅排除刚刚展示的那一批 4 本
      state.seenRecTitles = new Set(prevBatchKeys);
      freshCands = allCands.filter((b) => !prevBatchKeys.has(normalizeTitleKey(b.title)));
      if (freshCands.length < 4) freshCands = allCands;
    }

    const daySeed = `${dateKey()}#${state.dailyOffset}#${state.recBatch}`;
    const scoredPool = freshCands.map((b) => {
      let rel = (genreScore.get(b.genre) || 0) * 1.45 + (authorScore.get(b.author) || 0) * 1.25;
      if (finishedGenres.has(b.genre)) rel += 1.0;
      if (b.wordsWan > 0 && state.books.length) {
        const lenDist = Math.abs(Math.log10(Math.max(1, b.wordsWan)) - Math.log10(Math.max(1, prefWordsWan)));
        rel += Math.max(0, 0.8 - lenDist);
      }
      if (b.fromOnline) rel += 0.9;
      if (!state.books.length) rel += (b.wordsWan && b.wordsWan < 25 ? 1.4 : 0.4);
      rel += hashStr(`${daySeed}|${b.title}`) * 1.5;

      let reason = b.onlineReason || '';
      if (!reason) {
        if (topAuthor && b.author === topAuthor) reason = `契合你对 ${topAuthor} 的高分与长时投入`;
        else if ((authorScore.get(b.author) || 0) > 0) reason = `你读过 ${b.author} 的作品`;
        else if (topGenre && b.genre === topGenre) reason = `契合你在「${b.genre}」的阅读时长与评分画像`;
        else if (finishedGenres.has(b.genre)) reason = `你读完过同题材好书 · ${b.genre}`;
        else if (b.wordsWan && b.wordsWan <= 14) reason = '篇幅轻巧，适合这几天开读';
        else reason = '高口碑经典，值得放进书房';
      }
      return { ...b, reason, rel };
    });

    if (!scoredPool.length) {
      return (window.CURATED_BOOKS || []).slice(0, 3).map((b) => ({ ...b, reason: '书房经典，随时可以重读' }));
    }

    // 归一化相关性到 [0, 1]，使用 MMR（最大边际相关性，λ=0.72）挑选前 3 本，保证精准且不重复
    const maxRel = Math.max(...scoredPool.map((x) => x.rel));
    const minRel = Math.min(...scoredPool.map((x) => x.rel));
    const span = Math.max(0.001, maxRel - minRel);
    const remaining = scoredPool.map((x) => ({ ...x, normRel: (x.rel - minRel) / span }));

    const picked = [];
    const LAMBDA = 0.72;
    const exploitCount = Math.min(3, remaining.length);
    for (let k = 0; k < exploitCount; k++) {
      let bestIdx = 0;
      let bestMmr = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i];
        const maxSim = picked.length ? Math.max(...picked.map((p) => bookPairSimilarity(cand, p))) : 0;
        const mmr = LAMBDA * cand.normRel - (1 - LAMBDA) * maxSim;
        if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
      }
      picked.push(remaining.splice(bestIdx, 1)[0]);
    }

    // 第 4 本：探索位（Explore），优先从用户未读过的题材中挑高口碑书打破信息茧房
    if (remaining.length) {
      const pickedGenres = new Set(picked.map((p) => p.genre));
      const exploreCands = remaining.filter((c) => !ownedGenres.has(c.genre) && !pickedGenres.has(c.genre));
      const pool = exploreCands.length ? exploreCands : remaining.filter((c) => !pickedGenres.has(c.genre));
      const pickFrom = pool.length ? pool : remaining;
      pickFrom.sort((a, b) => hashStr(`${daySeed}|exp|${b.title}`) - hashStr(`${daySeed}|exp|${a.title}`));
      const expBook = pickFrom[0];
      picked.push({
        ...expBook,
        reason: exploreCands.length ? `跨界探索 · 尝试「${expBook.genre}」换换口味` : expBook.reason,
      });
    }

    return picked;
  }

  async function maybeFetchOnlineRecommendations() {
    const { sortedGenres, sortedAuthors } = computeUserTaste();
    const topGenre = sortedGenres[0]?.[0] || '';
    const topAuthor = sortedAuthors[0]?.[0] || '';
    const key = `${dateKey()}|${topGenre}|${topAuthor}`;
    if (state.onlineRecKey === key || state.onlineRecLoading) return;
    const queries = [];
    if (topAuthor) queries.push({ q: topAuthor, reason: `联网发掘 · 你偏爱 ${topAuthor} 的作品` });
    if (topGenre) queries.push({ q: `${topGenre} 经典`, reason: `联网发掘 · 契合你的「${topGenre}」偏好` });
    if (!queries.length) queries.push({ q: '经典文学 畅销', reason: '联网精选 · 口碑佳作推荐' });

    state.onlineRecLoading = true;
    try {
      const reqs = [];
      queries.forEach((item) => {
        reqs.push(fetchAppleBooks(item.q, 4500).then((r) => ({ ...r, reason: item.reason })));
        if (bridge.available || isLocalDevProxy()) {
          reqs.push(fetchWeReadBooks(item.q, 4500).then((r) => ({ ...r, reason: item.reason })));
        }
      });
      const results = await Promise.allSettled(reqs);
      const collected = [];
      results.forEach((res) => {
        if (res.status === 'fulfilled' && res.value.list && res.value.list.length) {
          res.value.list.slice(0, 6).forEach((b) => {
            collected.push({
              ...b,
              fromOnline: true,
              onlineReason: res.value.reason,
              spineColor: pickColorFor(b.title),
            });
          });
        }
      });
      state.onlineRecKey = key;
      if (collected.length) {
        state.onlineRecs = collected;
        if (state.tab === 'daily') renderRecommendations(true);
      }
    } catch { /* offline */ } finally {
      state.onlineRecLoading = false;
    }
  }

  const REC_INTERVAL_OPTIONS = [6, 24, 72];

  function getRecIntervalHours() {
    const h = Number(getMeta('recAutoIntervalHours', 6));
    return REC_INTERVAL_OPTIONS.includes(h) ? h : 6;
  }

  function updateRecScheduleLabel() {
    const el = $('#recScheduleBtn');
    if (!el) return;
    const hours = getRecIntervalHours();
    const lastAt = Number(getMeta('recLastAutoAt', 0)) || Date.now();
    const nextAt = lastAt + hours * 3600000;
    const nextDate = new Date(nextAt);
    const label = hours === 6 ? '每 6 小时' : (hours === 24 ? '每天' : '每 3 天');
    const nextText = `${pad2(nextDate.getHours())}:${pad2(nextDate.getMinutes())}`;
    el.textContent = `⏱ ${label}自动刷新 · 下次 ${nextText}（点击切换）`;
  }

  function checkAutoRefreshRecommendations() {
    const hours = getRecIntervalHours();
    const lastAt = Number(getMeta('recLastAutoAt', 0));
    const now = Date.now();
    if (!lastAt) {
      setMeta('recLastAutoAt', now);
      updateRecScheduleLabel();
      return;
    }
    if (now - lastAt >= hours * 3600000) {
      (state.recommendations || []).forEach((b) => state.seenRecTitles.add(normalizeTitleKey(b.title)));
      state.recBatch += 1;
      setMeta('recLastAutoAt', now);
      renderRecommendations(false);
    } else {
      updateRecScheduleLabel();
    }
  }

  function refreshRecommendationsManually() {
    (state.recommendations || []).forEach((b) => state.seenRecTitles.add(normalizeTitleKey(b.title)));
    state.recBatch += 1;
    setMeta('recLastAutoAt', Date.now());
    renderRecommendations(false);
    toast('已为你换上全新一批好书 ✨');
  }

  function renderRecommendations(skipFetch = false) {
    state.recommendations = computeRecommendations();
    const list = $('#recommendedBooksList');
    if (!list) return;
    list.innerHTML = state.recommendations.map((b, i) => `
      <div class="rec-card">
        <div class="rec-cover" style="--spine-bg:${esc(b.spineColor || pickColorFor(b.title))}">
          ${typoCover(b)}
          ${b.coverUrl ? `<img src="${esc(b.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        </div>
        <div class="rec-info">
          <div class="rec-title-row"><strong>${esc(b.title)}</strong><span class="mini-tag gold">${esc(b.genre)}</span></div>
          <div class="rec-reason">${esc(b.reason || '')}</div>
          <div class="rec-summary">${esc(b.summary || '点击加入书架，开始记录阅读进度与笔记。')}</div>
          <div class="rec-bottom">
            <span class="mini-tag">${b.pages ? `${b.pages} 页 · ` : ''}${b.wordsWan ? fmtWords(b.wordsWan) : (b.fromOnline ? '联网推荐' : '精选书目')}</span>
            <button class="btn btn-soft btn-sm" type="button" data-rec-add="${i}">加入书架</button>
          </div>
        </div>
      </div>`).join('');

    const sub = $('#recReasonSub');
    if (sub) {
      const { sortedGenres } = computeUserTaste();
      const top = sortedGenres.slice(0, 2).map((x) => x[0]);
      sub.textContent = top.length
        ? `综合阅读时长、评分与「${top.join('」「')}」偏好（含全网发掘）`
        : '综合精选与全网书库推荐，读几本后更懂你的口味';
    }
    updateRecScheduleLabel();

    if (!skipFetch) maybeFetchOnlineRecommendations();
  }

  function bindDaily() {
    $('#refreshDailyBtn')?.addEventListener('click', () => {
      state.dailyOffset += 1;
      renderDaily();
      toast('已换一批新摘录');
    });
    $('#dailyQuotesList')?.addEventListener('click', async (e) => {
      const saveBtn = e.target.closest('[data-quote-save]');
      const posterBtn = e.target.closest('[data-quote-poster]');
      if (saveBtn) {
        const q = state.dailyQuotes[parseInt(saveBtn.dataset.quoteSave, 10)];
        if (!q) return;
        const saved = getMeta('savedQuotes', []);
        if (isQuoteSaved(q)) {
          await setMeta('savedQuotes', saved.filter((s) => s.text !== q.text));
          toast('已取消收藏');
        } else {
          saved.unshift({ text: q.text, book: q.book, author: q.author, savedAt: Date.now() });
          await setMeta('savedQuotes', saved.slice(0, 200));
          toast('已收藏到书房');
        }
        renderDaily();
        renderSettings();
        return;
      }
      if (posterBtn) {
        const q = state.dailyQuotes[parseInt(posterBtn.dataset.quotePoster, 10)];
        if (q) openPoster(q);
      }
    });
    $('#openQuoteCollectorBtn')?.addEventListener('click', openQuoteCollector);
    $('#addQuoteInlineBtn')?.addEventListener('click', openQuoteCollector);
    $('#quoteBookPick')?.addEventListener('change', (e) => {
      const b = getBook(e.target.value);
      if (!b) return;
      $('#quoteBookInput').value = b.title || '';
      $('#quoteAuthorInput').value = b.author || '';
    });
    $('#saveQuoteBtn')?.addEventListener('click', saveCollectedQuote);
    $('#myQuotesList')?.addEventListener('click', async (e) => {
      const pBtn = e.target.closest('[data-myquote-poster]');
      const dBtn = e.target.closest('[data-myquote-del]');
      const saved = getMeta('savedQuotes', []);
      if (pBtn) {
        const q = saved[parseInt(pBtn.dataset.myquotePoster, 10)];
        if (q) openPoster(q);
        return;
      }
      if (dBtn) {
        const idx = parseInt(dBtn.dataset.myquoteDel, 10);
        if (!Number.isNaN(idx)) {
          saved.splice(idx, 1);
          await setMeta('savedQuotes', saved);
          renderMyQuotes();
          renderDaily();
          renderSettings();
          toast('已删除该条金句');
        }
      }
    });
    $('#recommendedBooksList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rec-add]');
      if (!btn) return;
      const book = state.recommendations[parseInt(btn.dataset.recAdd, 10)];
      if (book) quickAddBook(book);
      renderRecommendations();
    });
    $('#refreshRecBtn')?.addEventListener('click', refreshRecommendationsManually);
    $('#recScheduleBtn')?.addEventListener('click', async () => {
      const cur = getRecIntervalHours();
      const idx = REC_INTERVAL_OPTIONS.indexOf(cur);
      const next = REC_INTERVAL_OPTIONS[(idx + 1) % REC_INTERVAL_OPTIONS.length];
      await setMeta('recAutoIntervalHours', next);
      updateRecScheduleLabel();
      const label = next === 6 ? '每 6 小时' : (next === 24 ? '每天' : '每 3 天');
      toast(`已切换为「${label}自动刷新」`);
    });
    $('#aiRecommendBtn')?.addEventListener('click', aiRecommendBooks);
    $('#aiInsightBtn')?.addEventListener('click', aiGenerateInsight);
    setInterval(checkAutoRefreshRecommendations, 60000);
  }

  /* =============================== 摘录卡片 =============================== */
  function openPoster(quote) {
    state.posterQuote = quote;
    drawPoster(quote);
    openSheet('posterBackdrop');
  }

  function wrapCanvasText(ctx, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const ch of String(text)) {
      if (ch === '\n') { lines.push(line); line = ''; continue; }
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawPoster(quote) {
    const canvas = $('#posterCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';

    const bg1 = dark ? '#1B2320' : '#FBF7EF';
    const bg2 = dark ? '#121815' : '#F2E9DA';
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, bg1);
    grad.addColorStop(1, bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const accent = dark ? '#4DA887' : '#2B6E57';
    const textColor = dark ? '#ECEEEB' : '#1F2421';
    const subColor = dark ? '#9AA7A0' : '#7A827D';

    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    ctx.strokeRect(34, 34, W - 68, H - 68);
    ctx.globalAlpha = 1;

    // 装饰引号
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.16;
    ctx.font = 'bold 220px Georgia, serif';
    ctx.fillText('“', 44, 250);
    ctx.globalAlpha = 1;

    ctx.fillStyle = textColor;
    ctx.font = '600 40px -apple-system, "PingFang SC", "Songti SC", serif';
    ctx.textBaseline = 'top';
    const lines = wrapCanvasText(ctx, quote.text, W - 190);
    const lineHeight = 64;
    const startY = Math.max(210, (H - lines.length * lineHeight) / 2 - 40);
    lines.forEach((l, i) => {
      ctx.fillText(l, 96, startY + i * lineHeight);
    });

    const footerY = H - 170;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(96, footerY - 26);
    ctx.lineTo(W - 96, footerY - 26);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = subColor;
    ctx.font = '500 26px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(`《${quote.book || '书房摘录'}》`, 96, footerY);
    ctx.font = '400 24px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(quote.author || '', 96, footerY + 42);

    ctx.fillStyle = accent;
    ctx.font = 'bold 24px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('小象阅痕 · 每日拾页', W - 96, footerY + 42);
    ctx.textAlign = 'left';
  }

  async function shareDataUrl(dataUrl, filename) {
    try {
      const base64 = String(dataUrl).split(',')[1] || '';
      const mime = (String(dataUrl).match(/^data:([^;]+)/) || [])[1] || 'image/png';
      if (bridge.available) {
        bridge.post({ type: 'shareFile', filename, mime, base64 });
        return;
      }
      const byteChars = atob(base64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('图片已保存到下载目录');
    } catch {
      toast('保存失败，可长按图片保存');
    }
  }

  function bindPoster() {
    $('#savePosterBtn')?.addEventListener('click', () => {
      const canvas = $('#posterCanvas');
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');
      shareDataUrl(dataUrl, '小象阅痕-摘录卡片.png');
    });
    $('#copyPosterQuoteBtn')?.addEventListener('click', async () => {
      const q = state.posterQuote;
      if (!q) return;
      const text = `「${q.text}」——《${q.book}》${q.author ? ' · ' + q.author : ''}`;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          toast('文字已复制');
        } else throw new Error('no clipboard');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('文字已复制'); }
        catch { toast('复制失败，请手动选择文字'); }
        ta.remove();
      }
    });
  }

  /* =============================== 阅读洞察 =============================== */
  const PERIODS = [
    { name: '凌晨', from: 0, to: 4 },
    { name: '清晨', from: 4, to: 8 },
    { name: '上午', from: 8, to: 12 },
    { name: '下午', from: 12, to: 16 },
    { name: '傍晚', from: 16, to: 20 },
    { name: '夜晚', from: 20, to: 24 },
  ];

  function computeHabitData() {
    const totalMinutes = state.sessions.reduce((s, x) => s + num(x.minutes, 0), 0);
    const hourMinutes = new Array(24).fill(0);
    const periodMinutes = PERIODS.map(() => 0);
    const dayMinutes = new Map();
    state.sessions.forEach((s) => {
      const mins = num(s.minutes, 0);
      const d = new Date(s.startedAt || Date.now());
      const h = d.getHours();
      const span = Math.max(1, Math.ceil(mins / 60));
      for (let k = 0; k < span; k++) {
        const hh = (h + k) % 24;
        hourMinutes[hh] += mins / span;
      }
      const pIdx = PERIODS.findIndex((p) => h >= p.from && h < p.to);
      if (pIdx >= 0) periodMinutes[pIdx] += mins;
      const k = dateKey(s.startedAt || Date.now());
      dayMinutes.set(k, (dayMinutes.get(k) || 0) + mins);
    });
    const peakIdx = periodMinutes.indexOf(Math.max(...periodMinutes));
    const hasData = totalMinutes > 0;

    let chronotype = '待发现';
    if (hasData) {
      const night = periodMinutes[0] + periodMinutes[5];
      const morning = periodMinutes[1] + periodMinutes[2];
      const afternoon = periodMinutes[3] + periodMinutes[4];
      const max = Math.max(night, morning, afternoon);
      if (max < totalMinutes * 0.4) chronotype = '均衡型读者';
      else if (max === night) chronotype = '深夜书房型';
      else if (max === morning) chronotype = '清晨早鸟型';
      else chronotype = '午后沉浸型';
    }

    // 连续阅读天数
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const k = dateKey(d.getTime());
      const has = (dayMinutes.get(k) || 0) > 0
        || state.books.some((b) => (b.notes || []).some((n) => dateKey(n.createdAt) === k));
      if (has) streak++;
      else if (i === 0) continue;
      else break;
    }

    const finished = state.books.filter((b) => b.status === 'finished');
    const rated = state.books.filter((b) => b.rating > 0);
    const avgRating = rated.length ? rated.reduce((s, b) => s + b.rating, 0) / rated.length : 0;

    return {
      totalMinutes,
      hourMinutes,
      periodMinutes,
      peakIdx,
      peakName: hasData ? PERIODS[peakIdx].name : '待发现',
      chronotype,
      streak,
      todayMinutes: dayMinutes.get(dateKey()) || 0,
      finished,
      avgRating,
      totalWords: finished.reduce((s, b) => s + num(b.wordsWan, 0), 0),
      noteCount: state.books.reduce((s, b) => s + (b.notes || []).length, 0),
    };
  }

  function getReadingPlan() {
    const legacyGoal = num(getMeta('goal', 24), 24) || 24;
    const saved = getMeta('plan', null);
    const curYear = new Date().getFullYear();
    return {
      title: (saved && saved.title) ? String(saved.title) : `${curYear} 年阅读计划`,
      year: (saved && num(saved.year, 0)) || curYear,
      booksGoal: (saved && num(saved.booksGoal, 0)) || legacyGoal,
      dailyMinutesGoal: (saved && num(saved.dailyMinutesGoal, 0)) || 30,
      weeklyDaysGoal: clamp((saved && num(saved.weeklyDaysGoal, 0)) || 5, 1, 7),
      wordsWanGoal: saved && saved.wordsWanGoal != null ? Math.max(0, num(saved.wordsWanGoal, 0)) : 300,
    };
  }

  function computeWeekReadDays() {
    const now = new Date();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (startOfWeek.getDay() + 6) % 7;
    startOfWeek.setDate(startOfWeek.getDate() - dow);
    const startTs = startOfWeek.getTime();
    const days = new Set();
    (state.sessions || []).forEach((s) => {
      if (s.startedAt >= startTs) days.add(dateKey(s.startedAt));
    });
    return days.size;
  }

  function renderStats() {
    const h = computeHabitData();
    const plan = getReadingPlan();
    const goal = plan.booksGoal;
    const finishedCount = h.finished.length;

    const percent = clamp(Math.round((finishedCount / goal) * 100), 0, 100);
    const ring = $('#goalRingCircle');
    if (ring) {
      const C = 2 * Math.PI * 36;
      ring.setAttribute('stroke-dasharray', C.toFixed(2));
      ring.setAttribute('stroke-dashoffset', (C * (1 - percent / 100)).toFixed(2));
    }
    const pctEl = $('#goalPercentText'); if (pctEl) pctEl.textContent = `${percent}%`;
    const goalTitle = $('#goalTitleText');
    if (goalTitle) goalTitle.textContent = `${plan.title} · ${finishedCount} / ${goal} 本`;
    const streakSub = $('#streakSubText');
    const weekDays = computeWeekReadDays();
    if (streakSub) streakSub.textContent = `连续阅读 ${h.streak} 天 · 今日 ${Math.round(h.todayMinutes)} 分钟 · 本周 ${weekDays} 天`;

    const subBars = $('#planSubBars');
    if (subBars) {
      const dailyPct = clamp(Math.round((h.todayMinutes / plan.dailyMinutesGoal) * 100), 0, 100);
      const weekPct = clamp(Math.round((weekDays / plan.weeklyDaysGoal) * 100), 0, 100);
      const bars = [
        `<div class="plan-sub-item">
          <div class="plan-sub-row"><span>今日时长目标</span><strong>${Math.round(h.todayMinutes)} / ${plan.dailyMinutesGoal} 分钟</strong></div>
          <div class="plan-sub-track"><div class="plan-sub-fill" style="width:${dailyPct}%"></div></div>
        </div>`,
        `<div class="plan-sub-item">
          <div class="plan-sub-row"><span>本周阅读天数</span><strong>${weekDays} / ${plan.weeklyDaysGoal} 天</strong></div>
          <div class="plan-sub-track"><div class="plan-sub-fill warm" style="width:${weekPct}%"></div></div>
        </div>`,
      ];
      if (plan.wordsWanGoal > 0) {
        const wPct = clamp(Math.round((h.totalWords / plan.wordsWanGoal) * 100), 0, 100);
        bars.push(`<div class="plan-sub-item">
          <div class="plan-sub-row"><span>年度字数目标</span><strong>${h.totalWords.toFixed(1)} / ${plan.wordsWanGoal} 万字</strong></div>
          <div class="plan-sub-track"><div class="plan-sub-fill" style="width:${wPct}%"></div></div>
        </div>`);
      }
      subBars.innerHTML = bars.join('');
    }

    // 读者画像徽章
    const top = topGenres(2);
    const badges = [];
    if (top.length) badges.push(`${top[0]}爱好者`);
    if (h.chronotype !== '待发现') badges.push(h.chronotype);
    if (h.totalMinutes >= 600) badges.push('长时沉浸');
    else if (h.totalMinutes > 0) badges.push('稳步积累');
    if (h.avgRating >= 4) badges.push('高分鉴赏家');
    if (h.finished.length >= 3) badges.push('读完派');
    else if (state.books.length) badges.push('开卷有益');
    const badgeEl = $('#personaBadges');
    if (badgeEl) badgeEl.innerHTML = badges.map((b) => `<span class="mini-tag primary">${esc(b)}</span>`).join('');

    // KPI
    const hours = h.totalMinutes / 60;
    const setVal = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    setVal('statTotalHours', `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)}<small>小时</small>`);
    setVal('statTotalWords', `${h.totalWords >= 100 ? Math.round(h.totalWords) : h.totalWords.toFixed(1)}<small>万字</small>`);
    setVal('statTotalNotes', `${h.noteCount}<small>条</small>`);
    setVal('statAvgRating', h.avgRating ? `${h.avgRating.toFixed(1)}<small>分</small>` : `—<small>分</small>`);

    // 时段
    const peakSummary = $('#peakPeriodSummary');
    if (peakSummary) {
      peakSummary.textContent = h.totalMinutes
        ? `你的黄金阅读时段是「${h.peakName}」 · 累计 ${fmtDuration(h.totalMinutes)}`
        : '记录几次阅读计时后，自动分析你的黄金阅读时段';
    }
    const chronoBadge = $('#chronotypeBadge');
    if (chronoBadge) chronoBadge.textContent = h.chronotype;

    const periodBars = $('#periodBars');
    if (periodBars) {
      const max = Math.max(1, ...h.periodMinutes);
      periodBars.innerHTML = PERIODS.map((p, i) => {
        const mins = h.periodMinutes[i];
        const pct = Math.round((mins / max) * 100);
        const isPeak = h.totalMinutes > 0 && i === h.peakIdx;
        return `<div class="period-col">
          <span class="period-min">${mins ? Math.round(mins) + '分' : ''}</span>
          <div class="period-bar-track"><div class="period-bar-fill${isPeak ? ' peak' : ''}" style="height:${Math.max(mins ? 8 : 2, pct)}%"></div></div>
          <span class="period-name">${p.name}</span>
        </div>`;
      }).join('');
    }

    const hourStrip = $('#hourStrip');
    if (hourStrip) {
      const maxH = Math.max(1, ...h.hourMinutes);
      hourStrip.innerHTML = h.hourMinutes.map((m, i) => {
        const ratio = m / maxH;
        const opacity = m ? (0.25 + ratio * 0.75).toFixed(2) : 0;
        return `<div class="hour-cell" title="${i}:00 · ${Math.round(m)} 分钟" style="background:var(--primary);opacity:${opacity}"></div>`;
      }).join('');
    }

    // 题材偏好
    const genreCounter = new Map();
    state.books.forEach((b) => {
      const w = (b.status === 'finished' ? 2 : 1) + (b.rating || 0) / 5;
      genreCounter.set(b.genre, (genreCounter.get(b.genre) || 0) + w);
    });
    const genres = Array.from(genreCounter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const genreList = $('#genreDistList');
    if (genreList) {
      const maxG = Math.max(1, ...genres.map((g) => g[1]));
      genreList.innerHTML = genres.length ? genres.map(([name, w]) => `<div class="dist-row">
        <span class="dist-name">${esc(name)}</span>
        <span class="dist-bar"><div style="width:${Math.round((w / maxG) * 100)}%"></div></span>
        <span class="dist-val">${state.books.filter((b) => b.genre === name).length} 本</span>
      </div>`).join('') : '<div class="inline-empty">添加书籍后自动统计题材分布。</div>';
    }
    const genreSummary = $('#genreHabitSummary');
    if (genreSummary) {
      genreSummary.textContent = genres.length
        ? `最常读「${genres.slice(0, 2).map((g) => g[0]).join('」与「')}」，共收录 ${state.books.length} 本`
        : '综合藏书量与高分评价';
    }

    // 偏爱作者
    const authorCounter = new Map();
    state.books.forEach((b) => {
      const mins = bookSessionMinutes(b.id);
      const w = (b.status === 'finished' ? 2 : 1) + mins / 300 + (b.rating || 0) / 5;
      authorCounter.set(b.author, (authorCounter.get(b.author) || 0) + w);
    });
    const authors = Array.from(authorCounter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const favAuthors = $('#favAuthorList');
    if (favAuthors) {
      favAuthors.innerHTML = authors.length ? authors.map(([name]) => {
        const count = state.books.filter((b) => b.author === name).length;
        return `<span class="author-chip">${esc(name)}<small>${count} 本</small></span>`;
      }).join('') : '<div class="inline-empty">还没有偏爱的作者。</div>';
    }

    // 评分分布
    const ratingBuckets = [5, 4, 3, 2, 1];
    const rated = state.books.filter((b) => b.rating > 0);
    const ratingDist = $('#ratingDistList');
    if (ratingDist) {
      if (!rated.length) {
        ratingDist.innerHTML = '<div class="inline-empty">给读过的书打分后，这里会显示你的评分分布。</div>';
      } else {
        const counts = ratingBuckets.map((star) => rated.filter((b) => Math.ceil(b.rating) === star).length);
        const maxR = Math.max(1, ...counts);
        ratingDist.innerHTML = ratingBuckets.map((star, i) => `<div class="dist-row">
          <span class="dist-name">${star} 星</span>
          <span class="dist-bar"><div style="width:${Math.round((counts[i] / maxR) * 100)}%;background:var(--gold)"></div></span>
          <span class="dist-val">${counts[i]} 本</span>
        </div>`).join('');
      }
    }
  }

  function openPlanSheet() {
    const plan = getReadingPlan();
    $('#planTitleInput').value = plan.title;
    $('#planYearInput').value = String(plan.year);
    $('#planBooksInput').value = String(plan.booksGoal);
    $('#planDailyMinsInput').value = String(plan.dailyMinutesGoal);
    $('#planWeeklyDaysInput').value = String(plan.weeklyDaysGoal);
    $('#planWordsInput').value = plan.wordsWanGoal ? String(plan.wordsWanGoal) : '';
    openSheet('planBackdrop');
  }

  async function savePlanFromForm() {
    const year = clamp(Math.round(num($('#planYearInput').value, new Date().getFullYear())), 2020, 2035);
    const title = ($('#planTitleInput').value || '').trim() || `${year} 年阅读计划`;
    const booksGoal = clamp(Math.round(num($('#planBooksInput').value, 24)), 1, 365);
    const dailyMinutesGoal = clamp(Math.round(num($('#planDailyMinsInput').value, 30)), 5, 480);
    const weeklyDaysGoal = clamp(Math.round(num($('#planWeeklyDaysInput').value, 5)), 1, 7);
    const wordsWanGoal = Math.max(0, Math.round(num($('#planWordsInput').value, 0)));
    await setMeta('plan', { title, year, booksGoal, dailyMinutesGoal, weeklyDaysGoal, wordsWanGoal });
    await setMeta('goal', booksGoal);
    closeSheet('planBackdrop');
    renderStats();
    toast('阅读计划已更新 ✓');
  }

  function openInsightDetail(kind) {
    const titleEl = $('#insightDetailTitle');
    const subEl = $('#insightDetailSub');
    const bodyEl = $('#insightDetailBody');
    if (!bodyEl) return;

    const noteTypeLabels = { reflection: '💭 读后感', quote: '❝ 书摘划线', scan: '📷 纸质扫描' };

    if (kind === 'hours') {
      const sessions = (state.sessions || []).slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const totalMins = sessions.reduce((s, x) => s + (x.minutes || 0), 0);
      titleEl.textContent = '累计阅读时长明细';
      subEl.textContent = `共 ${sessions.length} 次记录 · 合计 ${fmtDuration(totalMins)}`;
      if (!sessions.length) {
        bodyEl.innerHTML = '<div class="inline-empty">还没有阅读计时记录，点右上角「计时」开始或补记一次阅读吧。</div>';
      } else {
        const groups = new Map();
        sessions.forEach((s) => {
          const dk = dateKey(s.startedAt);
          if (!groups.has(dk)) groups.set(dk, []);
          groups.get(dk).push(s);
        });
        bodyEl.innerHTML = [...groups.entries()].map(([dk, items]) => {
          const dayMins = items.reduce((acc, x) => acc + (x.minutes || 0), 0);
          return `<div class="insight-group-title"><span>${esc(dk)}</span><span>${esc(fmtDuration(dayMins))}</span></div>` +
            items.map((s) => {
              const b = getBook(s.bookId);
              const d = new Date(s.startedAt);
              const timeStr = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
              return `<div class="insight-item-card" data-insight-book="${esc(s.bookId || '')}">
                <div class="insight-item-top">
                  <span class="insight-item-title">${b ? `《${esc(b.title)}》` : '已移除书籍'}</span>
                  <span class="mini-tag primary">${esc(fmtDuration(s.minutes || 0))}</span>
                </div>
                <div class="insight-item-top" style="margin-bottom:0">
                  <span class="insight-item-sub">${timeStr} · ${s.source === 'manual' ? '手动补记' : '专注计时'}</span>
                  <button type="button" class="text-link-btn danger" data-insight-del-session="${esc(s.id)}">删除</button>
                </div>
              </div>`;
            }).join('');
        }).join('');
      }
    } else if (kind === 'notes') {
      const allNotes = [];
      state.books.forEach((b) => {
        (b.notes || []).forEach((n) => {
          allNotes.push({ ...n, bookId: b.id, bookTitle: b.title, bookAuthor: b.author });
        });
      });
      allNotes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      titleEl.textContent = '读后感与书摘明细';
      subEl.textContent = `共 ${allNotes.length} 条记录 · 点击可跳转对应书籍`;
      if (!allNotes.length) {
        bodyEl.innerHTML = '<div class="inline-empty">还没有写过读后感或书摘，点开一本书记录你的第一段感悟吧。</div>';
      } else {
        bodyEl.innerHTML = allNotes.map((n) => `
          <div class="insight-item-card" data-insight-book="${esc(n.bookId)}" data-insight-tab="notes">
            <div class="insight-item-top">
              <span class="insight-item-title">《${esc(n.bookTitle)}》</span>
              <span class="mini-tag">${esc(noteTypeLabels[n.type] || '笔记')}</span>
            </div>
            <div class="insight-note-body">${esc(n.text || '')}</div>
            <div class="insight-item-sub">${n.page ? `P.${esc(n.page)} · ` : ''}${fmtDate(n.createdAt)}</div>
          </div>`).join('');
      }
    } else if (kind === 'words') {
      const list = state.books.map((b) => {
        const total = b.wordsWan || 0;
        const readWan = b.status === 'finished' ? total : +(total * ((b.progress || 0) / 100)).toFixed(1);
        return { book: b, total, readWan };
      }).filter((x) => x.total > 0 || x.readWan > 0).sort((a, b) => b.readWan - a.readWan || b.total - a.total);
      const sumRead = list.reduce((s, x) => s + x.readWan, 0);
      titleEl.textContent = '已读字数明细';
      subEl.textContent = `累计已读约 ${sumRead.toFixed(1)} 万字 · 共 ${list.length} 本含字数书籍`;
      if (!list.length) {
        bodyEl.innerHTML = '<div class="inline-empty">还没有字数统计，录入书籍字数并更新进度后这里会展示明细。</div>';
      } else {
        bodyEl.innerHTML = list.map(({ book: b, total, readWan }) => `
          <div class="insight-item-card" data-insight-book="${esc(b.id)}">
            <div class="insight-item-top">
              <span class="insight-item-title">《${esc(b.title)}》</span>
              <span class="mini-tag primary">已读 ${readWan.toFixed(1)} 万字</span>
            </div>
            <div class="insight-item-sub">${esc(b.author || '佚名')} · ${esc(STATUS_LABELS[b.status] || '')} · 进度 ${b.status === 'finished' ? 100 : (b.progress || 0)}% · 全书 ${total.toFixed(1)} 万字</div>
          </div>`).join('');
      }
    } else if (kind === 'rating') {
      const rated = state.books.filter((b) => (b.rating || 0) > 0).sort((a, b) => (b.rating || 0) - (a.rating || 0));
      const avg = rated.length ? (rated.reduce((s, b) => s + b.rating, 0) / rated.length).toFixed(1) : '—';
      titleEl.textContent = '书籍自主评分明细';
      subEl.textContent = `已评分 ${rated.length} 本 · 平均 ${avg} 分`;
      if (!rated.length) {
        bodyEl.innerHTML = '<div class="inline-empty">还没有给书籍打分，打开任意书籍详情页即可评星。</div>';
      } else {
        bodyEl.innerHTML = rated.map((b) => `
          <div class="insight-item-card" data-insight-book="${esc(b.id)}">
            <div class="insight-item-top">
              <span class="insight-item-title">《${esc(b.title)}》</span>
              <span class="mini-tag gold">★ ${b.rating.toFixed(1)} 分</span>
            </div>
            <div class="insight-item-sub">${esc(b.author || '佚名')} · ${esc(b.genre || '')} · ${esc(STATUS_LABELS[b.status] || '')}</div>
          </div>`).join('');
      }
    }

    openSheet('insightDetailBackdrop');
  }

  function bindStats() {
    $('#editGoalBtn')?.addEventListener('click', openPlanSheet);
    $('#planBookPresets')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-plan-books]');
      if (btn) $('#planBooksInput').value = btn.dataset.planBooks;
    });
    $('#savePlanBtn')?.addEventListener('click', savePlanFromForm);
    $('#statsKpiGrid')?.addEventListener('click', (e) => {
      const card = e.target.closest('[data-stat-detail]');
      if (card) openInsightDetail(card.dataset.statDetail);
    });
    $('#insightDetailBody')?.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('[data-insight-del-session]');
      if (delBtn) {
        e.stopPropagation();
        await removeSession(delBtn.dataset.insightDelSession);
        toast('已删除该条阅读记录');
        openInsightDetail('hours');
        return;
      }
      const item = e.target.closest('[data-insight-book]');
      if (!item) return;
      const bid = item.dataset.insightBook;
      const b = getBook(bid);
      if (!b) return;
      closeSheet('insightDetailBackdrop');
      state.detailBookId = b.id;
      state.detailTab = item.dataset.insightTab || 'overview';
      openSheet('bookDetailBackdrop');
      renderDetail();
    });
  }

  /* =============================== 设置 / 备份 =============================== */
  function renderSettings() {
    const saved = getMeta('savedQuotes', []);
    const countEl = $('#savedQuotesCountText');
    if (countEl) countEl.textContent = `已收藏 ${saved.length} 条金句`;
    const wrap = $('#savedQuotesContainer');
    if (wrap) {
      wrap.innerHTML = saved.length
        ? saved.slice(0, 6).map((q, i) => `<div class="saved-quote-row">
            <div>「${esc(q.text)}」</div>
            <footer><span>《${esc(q.book)}》${esc(q.author || '')}</span><button class="text-link-btn danger" type="button" data-unsave="${i}">移除</button></footer>
          </div>`).join('')
        : '<div class="inline-empty">在「每日」页点「收藏」，喜欢的句子就会留在这里。</div>';
    }

    const bytes = new Blob([JSON.stringify({ books: state.books, sessions: state.sessions })]).size;
    const summary = $('#storageSummary');
    if (summary) summary.textContent = `${state.books.length} 本书 · ${state.sessions.length} 条记录 · 约 ${(bytes / 1024).toFixed(0)} KB`;

    const pool = getAiPool();
    const poolEl = $('#aiPoolList');
    if (poolEl) {
      poolEl.innerHTML = pool.length
        ? pool.map((p, idx) => `
          <div class="ai-pool-item">
            <div class="ai-pool-meta">
              <strong>${esc(p.name || '自定义模型')} · ${p.keys.length} 个 Key${p.visionModel ? ' · 含识图' : ''}</strong>
              <small>${esc(p.model)}${p.visionModel ? ` / 视觉: ${esc(p.visionModel)}` : ''}</small>
            </div>
            <button type="button" class="text-link-btn danger" data-del-ai-pool="${idx}">移除</button>
          </div>`).join('')
        : '<div class="inline-empty">暂未添加模型，点上方「智谱免费」等预设即可一键填好参数，再粘贴免费 Key 即可使用。</div>';
    }

    const ocrCfg = getMeta('ocrConfig', { mode: 'auto', ocrSpaceKeys: [] }) || {};
    const ocrMode = $('#ocrModeSelect');
    if (ocrMode) ocrMode.value = ocrCfg.mode || 'auto';
    const ocrKeysInput = $('#ocrSpaceKeysInput');
    if (ocrKeysInput) ocrKeysInput.value = (ocrCfg.ocrSpaceKeys || []).join('\n');
  }

  function downloadBlob(text, filename, mime = 'application/json') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function exportBackup() {
    const data = {
      app: 'shufang-xiaoji',
      version: 1,
      exportedAt: new Date().toISOString(),
      books: state.books,
      sessions: state.sessions,
      meta: {
        goal: getMeta('goal', 24),
        plan: getMeta('plan', null),
        theme: getMeta('theme', 'auto'),
        savedQuotes: getMeta('savedQuotes', []),
      },
    };
    const json = JSON.stringify(data);
    const filename = `小象阅痕备份-${dateKey()}.json`;
    if (bridge.available) {
      const base64 = btoa(unescape(encodeURIComponent(json)));
      bridge.post({ type: 'shareFile', filename, mime: 'application/json', base64 });
      toast('已打开分享面板，可存到 iCloud Drive');
      return;
    }
    downloadBlob(json, filename);
    toast('备份文件已导出');
  }

  async function importBackup(file) {
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsText(file);
    });
    let data;
    try { data = JSON.parse(text); } catch { toast('备份文件格式不正确'); return; }
    const books = Array.isArray(data.books) ? data.books : [];
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (!books.length && !sessions.length) { toast('备份里没有可恢复的数据'); return; }

    let added = 0;
    let merged = 0;
    for (const raw of books) {
      const nb = normalizeBook(raw);
      const exist = state.books.find((b) => b.id === nb.id || (b.title === nb.title && b.author === nb.author));
      if (exist) {
        exist.notes = mergeById(exist.notes || [], nb.notes || []);
        exist.characters = mergeById(exist.characters || [], nb.characters || []);
        exist.relations = mergeById(exist.relations || [], nb.relations || []);
        exist.progress = Math.max(exist.progress || 0, nb.progress || 0);
        exist.rating = exist.rating || nb.rating;
        exist.status = exist.status === 'want' ? nb.status : exist.status;
        if (!exist.coverUrl && nb.coverUrl) exist.coverUrl = nb.coverUrl;
        await saveBook(exist, true);
        merged++;
      } else {
        state.books.push(nb);
        await dbPut('books', nb);
        added++;
      }
    }
    let sAdded = 0;
    for (const s of sessions) {
      if (!s || !s.id) continue;
      if (state.sessions.some((x) => x.id === s.id)) continue;
      if (!state.books.some((b) => b.id === s.bookId)) continue;
      state.sessions.push(s);
      await dbPut('sessions', s);
      sAdded++;
    }
    if (data.meta) {
      for (const key of ['goal', 'plan', 'savedQuotes', 'theme', 'aiPool', 'ocrConfig']) {
        if (key in data.meta) await setMeta(key, data.meta[key]);
      }
      if (data.meta.theme) applyTheme();
    }
    flushNativeSave();
    renderShelf(); renderDaily(); renderStats(); renderSettings();
    toast(`恢复完成：新增 ${added} 本，合并 ${merged} 本，阅读记录 +${sAdded}`);
  }

  function mergeById(a, b) {
    const map = new Map(a.map((x) => [x.id, x]));
    b.forEach((x) => { if (x && x.id && !map.has(x.id)) map.set(x.id, x); });
    return Array.from(map.values());
  }

  function bindSettings() {
    $('#themeSegControl')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-choice]');
      if (btn) setTheme(btn.dataset.themeChoice);
    });
    $('#themeToggleBtn')?.addEventListener('click', () => {
      setTheme(currentDark() ? 'light' : 'dark');
    });
    $('#savedQuotesContainer')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-unsave]');
      if (!btn) return;
      const saved = getMeta('savedQuotes', []);
      saved.splice(parseInt(btn.dataset.unsave, 10), 1);
      await setMeta('savedQuotes', saved);
      renderSettings();
      renderDaily();
      toast('已移除');
    });

    $('#exportBackupBtn')?.addEventListener('click', exportBackup);
    $('#importBackupBtn')?.addEventListener('click', () => $('#importFileInput')?.click());
    $('#importFileInput')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      await importBackup(file);
      e.target.value = '';
    });

    $('#aiPresetTags')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ai-preset]');
      if (!btn) return;
      const preset = AI_PROVIDER_PRESETS[btn.dataset.aiPreset];
      if (!preset) return;
      if ($('#aiProviderNameInput')) $('#aiProviderNameInput').value = preset.name;
      if ($('#doubaoModelInput')) $('#doubaoModelInput').value = preset.model;
      if ($('#aiVisionModelInput')) $('#aiVisionModelInput').value = preset.visionModel || '';
      if ($('#doubaoUrlInput')) $('#doubaoUrlInput').value = preset.url;
      $('#doubaoKeyInput')?.focus();
      toast(`已填入「${preset.name}」参数，粘贴 Key 后点保存即可`);
    });

    $('#saveDoubaoCfgBtn')?.addEventListener('click', async () => {
      const keys = parseKeysList($('#doubaoKeyInput')?.value || '');
      const name = ($('#aiProviderNameInput')?.value || '').trim() || '自定义大模型';
      const model = ($('#doubaoModelInput')?.value || '').trim() || 'glm-4-flash';
      const visionModel = ($('#aiVisionModelInput')?.value || '').trim();
      const url = ($('#doubaoUrlInput')?.value || '').trim() || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
      if (!keys.length) { toast('请至少填写一个 API Key'); return; }
      const pool = getAiPool().filter((p) => !(p.url === url && p.model === model));
      pool.unshift({ id: uid('ai'), name, model, visionModel, url, keys });
      await setMeta('aiPool', pool);
      await setMeta('ai', { key: keys[0], model, visionModel, url, name });
      if ($('#doubaoKeyInput')) $('#doubaoKeyInput').value = '';
      renderSettings();
      toast(`已保存「${name}」（${keys.length} 个 Key）到引擎池`);
    });

    $('#aiPoolList')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del-ai-pool]');
      if (!btn) return;
      const idx = parseInt(btn.dataset.delAiPool, 10);
      const pool = getAiPool();
      if (!Number.isNaN(idx) && pool[idx]) {
        pool.splice(idx, 1);
        await setMeta('aiPool', pool);
        await setMeta('ai', pool[0] ? { key: pool[0].keys[0], model: pool[0].model, visionModel: pool[0].visionModel, url: pool[0].url, name: pool[0].name } : null);
        renderSettings();
        toast('已移除该模型引擎');
      }
    });

    $('#clearDoubaoCfgBtn')?.addEventListener('click', async () => {
      await setMeta('aiPool', []);
      await setMeta('ai', null);
      renderSettings();
      toast('已清空大模型引擎池');
    });

    $('#saveOcrCfgBtn')?.addEventListener('click', async () => {
      const mode = $('#ocrModeSelect')?.value || 'auto';
      const ocrSpaceKeys = parseKeysList($('#ocrSpaceKeysInput')?.value || '');
      await setMeta('ocrConfig', { mode, ocrSpaceKeys });
      toast('拍照识图 OCR 设置已保存');
    });

    $('#clearAllBtn')?.addEventListener('click', async () => {
      if (!window.confirm('确定要清空所有书籍、读书笔记和阅读记录吗？此操作无法撤销（建议先导出 JSON 备份）。')) {
        return;
      }
      await dbClear('books');
      await dbClear('sessions');
      await dbClear('meta');
      state.books = [];
      state.sessions = [];
      state.meta = {};
      state.selectedBookId = null;
      kvSet('timer', null);
      state.timer = { bookId: null, running: false, startedAt: 0, elapsedMs: 0, ambient: 'off' };
      memCache.kv = { timer: null, theme: 'auto' };
      flushNativeSave();
      applyTheme();
      renderShelf(); renderDaily(); renderStats(); renderSettings();
      toast('已清空本地数据');
    });
  }

  /* =============================== 多厂商 / 多 Key 大模型引擎池 =============================== */
  const AI_PROVIDER_PRESETS = {
    zhipu: {
      name: '智谱免费',
      model: 'glm-4-flash',
      visionModel: 'glm-4v-flash',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    },
    siliconflow: {
      name: '硅基流动开源',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      visionModel: 'Qwen/Qwen2.5-VL-7B-Instruct',
      url: 'https://api.siliconflow.cn/v1/chat/completions',
    },
    doubao: {
      name: '豆包火山方舟',
      model: 'doubao-1-5-pro-32k-250115',
      visionModel: 'doubao-1-5-vision-pro-32k-250115',
      url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    },
    deepseek: {
      name: 'DeepSeek',
      model: 'deepseek-chat',
      visionModel: '',
      url: 'https://api.deepseek.com/v1/chat/completions',
    },
    openrouter: {
      name: 'OpenRouter免费',
      model: 'qwen/qwen-2.5-7b-instruct:free',
      visionModel: '',
      url: 'https://openrouter.ai/api/v1/chat/completions',
    },
  };

  function parseKeysList(raw) {
    return String(raw || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function getAiPool() {
    const saved = getMeta('aiPool', null);
    if (Array.isArray(saved) && saved.length) {
      return saved.filter((p) => p && Array.isArray(p.keys) && p.keys.length);
    }
    const legacy = getMeta('ai', null);
    if (legacy && legacy.key) {
      return [{
        id: 'legacy',
        name: legacy.name || '已配置模型',
        model: legacy.model || 'doubao-1-5-pro-32k-250115',
        visionModel: legacy.visionModel || '',
        url: legacy.url || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
        keys: parseKeysList(legacy.key),
      }];
    }
    return [];
  }

  async function callDoubao(messages, opts = {}) {
    const pool = getAiPool();
    if (!pool.length) throw new Error('请先在「设置」添加免费大模型 Key');
    const needVision = Boolean(opts.vision);
    const candidates = needVision ? pool.filter((p) => p.visionModel) : pool;
    if (!candidates.length) throw new Error('引擎池里尚未配置视觉识图模型（如智谱 glm-4v-flash）');

    let lastErr = null;
    for (const provider of candidates) {
      const model = needVision ? provider.visionModel : provider.model;
      const url = provider.url;
      for (const apiKey of provider.keys) {
        try {
          const body = JSON.stringify({
            model,
            messages,
            temperature: opts.temperature == null ? 0.6 : opts.temperature,
            max_tokens: opts.maxTokens || 1500,
          });
          const data = await requestJson(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body,
            timeout: 45000,
          });
          const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (content) return content;
          lastErr = new Error(`${provider.name} 未返回内容`);
        } catch (err) {
          lastErr = err;
        }
      }
    }
    throw lastErr || new Error('所有可用模型 Key 均调用失败');
  }

  function libraryDigest() {
    return state.books.slice(0, 30).map((b) => {
      const mins = Math.round(bookSessionMinutes(b.id));
      return `《${b.title}》${b.author}｜${b.genre}｜状态:${STATUS_LABELS[b.status]}｜评分:${b.rating || '未评'}｜进度:${Math.round(b.progress)}%｜累计:${mins}分钟｜笔记:${(b.notes || []).length}条`;
    }).join('\n');
  }

  async function aiRecommendBooks() {
    if (!getAiPool().length) {
      toast('请先在「设置」添加免费大模型 Key（如智谱 glm-4-flash）');
      switchTab('settings');
      setTimeout(() => $('#doubaoKeyInput')?.focus(), 400);
      return;
    }
    const btn = $('#aiRecommendBtn');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '荐书中…'; btn.disabled = true; }
    try {
      const owned = state.books.map((b) => `《${b.title}》`).join('、') || '（暂无）';
      const prompt = `我是一位中文读者，我的书架：${owned}。
我的阅读偏好摘要：
${libraryDigest() || '（还没有阅读记录）'}
请为我推荐 4 本我大概率会喜欢、且不在我书架上的书（可以是中外经典或近年好书）。
只输出 JSON 数组，不要任何解释或代码块标记。数组元素格式：
{"title":"书名","author":"作者","genre":"题材(小说/文学/历史/社科/心理/科幻/悬疑/传记/哲学/经管/散文/科普 之一)","pages":页数数字,"wordsWan":字数万字数字,"summary":"40字以内内容简介","reason":"15字以内推荐理由"}`;
      const content = await callDoubao([
        { role: 'system', content: '你是资深中文图书编辑，推荐准确、克制、不虚构书名。' },
        { role: 'user', content: prompt },
      ], { maxTokens: 1200, temperature: 0.7 });
      const arr = extractJsonArray(content);
      if (!arr || !arr.length) throw new Error('解析荐书结果失败');
      state.recommendations = arr.slice(0, 4).map((b) => ({
        title: b.title || '未知书名',
        author: b.author || '佚名',
        genre: (window.BOOK_GENRES || []).includes(b.genre) ? b.genre : '文学',
        pages: num(b.pages, 0),
        wordsWan: num(b.wordsWan, 0) || (b.pages ? +(num(b.pages) * 0.065).toFixed(1) : 0),
        summary: b.summary || '',
        reason: b.reason || 'AI 书友推荐',
        spineColor: pickColorFor(b.title || ''),
      }));
      renderAiRecommendations();
      toast('AI 已为你挑好 4 本书');
    } catch (err) {
      toast(`AI 荐书失败：${err.message || '请检查网络或 Key'}`);
    } finally {
      if (btn) { btn.textContent = original; btn.disabled = false; }
    }
  }

  function renderAiRecommendations() {
    const list = $('#recommendedBooksList');
    if (!list) return;
    list.innerHTML = state.recommendations.map((b, i) => `
      <div class="rec-card">
        <div class="rec-cover" style="--spine-bg:${esc(b.spineColor || pickColorFor(b.title))}">${typoCover(b)}</div>
        <div class="rec-info">
          <div class="rec-title-row"><strong>${esc(b.title)}</strong><span class="mini-tag gold">AI</span></div>
          <div class="rec-reason">${esc(b.reason || '')}</div>
          <div class="rec-summary">${esc(b.summary || '')}</div>
          <div class="rec-bottom">
            <span class="mini-tag">${esc(b.genre)}${b.pages ? ` · ${b.pages} 页` : ''}</span>
            <button class="btn btn-soft btn-sm" type="button" data-rec-add="${i}">加入书架</button>
          </div>
        </div>
      </div>`).join('');
  }

  function extractJsonArray(text) {
    if (!text) return null;
    let str = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = str.indexOf('[');
    const end = str.lastIndexOf(']');
    if (start < 0 || end < 0) return null;
    str = str.slice(start, end + 1);
    try { return JSON.parse(str); } catch { return null; }
  }

  async function aiGenerateInsight() {
    if (!getAiPool().length) {
      toast('请先在「设置」添加免费大模型 Key（如智谱 glm-4-flash）');
      switchTab('settings');
      setTimeout(() => $('#doubaoKeyInput')?.focus(), 400);
      return;
    }
    const btn = $('#aiInsightBtn');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '分析中…'; btn.disabled = true; }
    const box = $('#aiInsightBox');
    box?.classList.remove('hidden');
    if (box) { box.textContent = '正在阅读你的书房数据…'; }
    try {
      const h = computeHabitData();
      const prompt = `这是我的阅读数据：
藏书 ${state.books.length} 本，已读完 ${h.finished.length} 本，累计阅读 ${Math.round(h.totalMinutes)} 分钟，连续 ${h.streak} 天，平均评分 ${h.avgRating.toFixed(1)}，黄金时段「${h.peakName}」，作息类型「${h.chronotype}」。
书架明细：
${libraryDigest() || '（暂无）'}
请用中文写一段 150-220 字的私人阅读画像：概括我的阅读口味与节奏，指出一个优势和一个容易忽视的短板，最后给一条具体可执行的阅读建议。语气温和、具体，不要分点编号，不要出现「作为AI」。`;
      const text = await callDoubao([
        { role: 'system', content: '你是温柔且专业的阅读教练，善于从数据中读出人的状态。' },
        { role: 'user', content: prompt },
      ], { maxTokens: 700, temperature: 0.75 });
      if (box) box.textContent = String(text).trim();
      toast('AI 阅读画像已生成');
    } catch (err) {
      if (box) box.textContent = `生成失败：${err.message || '请检查豆包配置'}`;
      toast('AI 画像生成失败');
    } finally {
      if (btn) { btn.textContent = original; btn.disabled = false; }
    }
  }

  /* =============================== 清理历史测试书 =============================== */
  async function purgeLegacyDemoBooks() {
    if (getMeta('demoPurgedV3', false)) return;
    const demoTitles = new Set(['三体', '人类简史', '活着', '百年孤独']);
    const toRemove = state.books.filter((b) => demoTitles.has(b.title) && !b.coverUrl);
    if (toRemove.length) {
      const rmIds = new Set(toRemove.map((b) => b.id));
      for (const b of toRemove) {
        await dbDel('books', b.id);
      }
      const rmSessions = state.sessions.filter((s) => rmIds.has(s.bookId));
      for (const s of rmSessions) {
        await dbDel('sessions', s.id);
      }
      state.books = state.books.filter((b) => !rmIds.has(b.id));
      state.sessions = state.sessions.filter((s) => !rmIds.has(s.bookId));
      if (rmIds.has(state.selectedBookId)) state.selectedBookId = null;
    }
    await setMeta('demoPurgedV3', true);
  }

  function hideSafariGuideIfNative() {
    if (bridge.available) {
      document.documentElement.classList.add('native-shell');
      $('#safariInstallGuideCard')?.classList.add('hidden');
      $('#installBanner')?.classList.add('hidden');
    }
  }

  function maybeShowInstallBanner() {
    if (bridge.available) return;
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (!isIOS || isStandalone || kvGet('hideInstallBanner', false)) return;
    $('#installBanner')?.classList.remove('hidden');
    $('#closeInstallBanner')?.addEventListener('click', () => {
      $('#installBanner')?.classList.add('hidden');
      kvSet('hideInstallBanner', true);
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* ignore */ });
    });
  }

  function renderAll() {
    renderShelf();
    renderDaily();
    renderStats();
    renderSettings();
    updateHeaderSummary();
  }

  function bindStatic() {
    $$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    bindToast();
    bindSheets();
    bindShelf();
    bindAddBook();
    bindDetail();
    bindTimer();
    bindNoteEditor();
    bindCharEditor();
    bindRelEditor();
    bindDaily();
    bindPoster();
    bindStats();
    bindSettings();
    hideSafariGuideIfNative();
    maybeShowInstallBanner();
  }

  async function init() {
    // 原生 App：磁盘快照由原生端在 documentStart 以 Base64 注入，避免自定义 scheme 下
    // IndexedDB / localStorage 不可持久化或特殊字符转义导致数据丢失。
    if (bridge.available) {
      try {
        if (window.__shufangSnapshotB64) {
          const decoded = decodeBase64Utf8(window.__shufangSnapshotB64);
          if (decoded) hydrateFromNative(decoded);
        } else if (window.__shufangSnapshot) {
          hydrateFromNative(window.__shufangSnapshot);
        }
      } catch { /* ignore */ }
    }

    if (bridge.available && memCache.books) {
      state.books = memCache.books.map(normalizeBook);
      state.sessions = memCache.sessions || [];
      state.meta = {};
      (memCache.meta || []).forEach((r) => { state.meta[r.key] = r.value; });
    } else {
      try {
        await loadAll();
      } catch {
        state.books = memAll('books').map(normalizeBook);
        state.sessions = memAll('sessions');
        state.meta = {};
        memAll('meta').forEach((r) => { state.meta[r.key] = r.value; });
      }
    }
    // 终极兜底：若启动后书架为空但 localStorage 容错快照里有书，自动找回并回写原生磁盘
    if (!state.books.length) {
      try {
        const fbRaw = localStorage.getItem(FALLBACK_SNAPSHOT_KEY);
        if (fbRaw) {
          const fb = JSON.parse(fbRaw);
          if (fb && Array.isArray(fb.books) && fb.books.length) {
            state.books = fb.books.map(normalizeBook);
            if (!state.sessions.length && Array.isArray(fb.sessions)) state.sessions = fb.sessions;
            if (Array.isArray(fb.meta)) fb.meta.forEach((r) => { if (r && r.key && !(r.key in state.meta)) state.meta[r.key] = r.value; });
            memCache.books = state.books.slice();
            memCache.sessions = state.sessions.slice();
            stateReadyForSnapshot = true;
            flushNativeSave();
          }
        }
      } catch { /* ignore */ }
    }
    stateReadyForSnapshot = true;

    applyTheme();
    try { await purgeLegacyDemoBooks(); } catch { /* ignore */ }
    bindStatic();

    const theme = getMeta('theme', 'auto');
    if (!theme) await setMeta('theme', 'auto');

    // 默认选中最近在读的一本
    if (!state.selectedBookId) {
      const reading = state.books.filter((b) => b.status === 'reading').sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))[0];
      state.selectedBookId = reading ? reading.id : null;
    }

    renderAll();
    checkAutoRefreshRecommendations();
    restoreTimer();
    updateTimerUI();
    registerSW();

    // 离开 / 切后台时立即落盘，避免丢数据
    if (bridge.available) {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) flushNativeSave();
      });
      window.addEventListener('pagehide', flushNativeSave);
      window.addEventListener('beforeunload', flushNativeSave);
    }

    // 首次进入且无数据：轻提示
    if (!state.books.length) {
      setTimeout(() => toast('点右上角「添书」，把第一本书放上书架', { duration: 3200 }), 700);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
