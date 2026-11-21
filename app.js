/* =========================================================================
 * 书房小记 · app.js
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
  const TONE_LABELS = { neutral: '关联', bond: '亲情/友好', love: '爱情/羁绊', rival: '对立/宿敌', mentor: '师徒/传承' };
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
    if (idbBroken) return memPut(store, value);
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
    if (idbBroken) return memDel(store, key);
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
    if (idbBroken) { memClear(store); return; }
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

  /* localStorage 兜底（IndexedDB 被禁用时） */
  const memKey = (s) => `shufang.mem.${s}`;
  function memAll(store) { try { return JSON.parse(localStorage.getItem(memKey(store)) || '[]'); } catch { return []; } }
  function memWrite(store, arr) { try { localStorage.setItem(memKey(store), JSON.stringify(arr)); } catch { /* 存储已满 */ } }
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

  async function requestJson(url, opts = {}) {
    if (bridge.available && opts.useBridge !== false) {
      const text = await bridgeRequest(url, opts);
      return JSON.parse(text);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 25000);
    try {
      const res = await fetch(url, {
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
      if (text) appendToNoteText(String(text));
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

  // 原生权限被拒时的提示
  window.__shufangPermissionDenied = (kind) => {
    stopDictationUI();
    if (kind === 'microphone') {
      toast('麦克风权限被拒绝：请在 设置 › 书房小记 中开启麦克风', { duration: 3600 });
    } else if (kind === 'speech') {
      toast('语音识别权限被拒绝：请在 设置 › 书房小记 中开启语音识别', { duration: 3600 });
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
    chipFilter: 'all',
    sort: 'recent',
    search: '',
    selectedBookId: null,
    detailBookId: null,
    detailTab: 'overview',
    addMode: 'search',
    editingId: null,
    coverData: null,
    formRating: 0,
    formColor: (window.SPINE_COLORS || ['#2F6354'])[0],
    formGenre: (window.BOOK_GENRES || ['小说'])[0],
    searchResults: [],
    dailyOffset: 0,
    dailyQuotes: [],
    recommendations: [],
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
    renderShelf(); renderStats(); renderSettings();
  }

  async function addSession(session) {
    state.sessions.push(session);
    await dbPut('sessions', session);
  }
  async function removeSession(id) {
    state.sessions = state.sessions.filter((s) => s.id !== id);
    await dbDel('sessions', id);
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
  const SIZE = { wMin: 34, wMax: 52, hMin: 130, hMax: 178 };

  function spineSize(book) {
    const w = clamp(SIZE.wMin + Math.log10(Math.max(1, book.wordsWan || 1)) * 9.5, SIZE.wMin, SIZE.wMax);
    const h = clamp(SIZE.hMin + Math.sqrt(Math.max(1, book.pages || 60)) * 2.4, SIZE.hMin, SIZE.hMax);
    return { w: Math.round(w), h: Math.round(h) };
  }

  function typoCover(book) {
    return `<div class="typo-cover" style="--spine-bg:${esc(book.spineColor)}">
      <span class="typo-cover-genre">${esc(book.genre)}</span>
      <span class="typo-cover-title">${esc(book.title)}</span>
      <span class="typo-cover-author">${esc(book.author)}</span>
    </div>`;
  }

  function coverBox(book, extraStyle = '') {
    return `<div class="book-cover-box" style="--spine-bg:${esc(book.spineColor)};${extraStyle}">
      ${typoCover(book)}
      ${book.coverUrl ? `<img src="${esc(book.coverUrl)}" alt="${esc(book.title)}封面" loading="lazy" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
    </div>`;
  }

  function starValueText(rating) {
    if (!rating) return '未评分';
    return `${rating.toFixed(1).replace(/\.0$/, '')} 星`;
  }

  function miniStars(rating) {
    if (!rating) return '';
    const full = Math.floor(rating + 1e-6);
    const half = rating - full >= 0.5;
    let html = '<span class="mini-stars">';
    for (let i = 1; i <= 5; i++) {
      if (i <= full) html += '★';
      else if (i === full + 1 && half) html += '⯨';
      else html += '<span class="off">★</span>';
    }
    html += `<span class="mini-star-num">${starValueText(rating)}</span></span>`;
    return html;
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
          <button class="btn btn-soft btn-sm" type="button" data-empty-act="demo">导入示例书</button>
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

  function shelfTierHtml(label, books, right) {
    const spines = books.map((b) => {
      const { w, h } = spineSize(b);
      const sel = state.selectedBookId === b.id ? ' selected' : '';
      const dot = b.status === 'finished' ? 'finished' : (b.status === 'reading' ? 'reading' : '');
      return `<button type="button" class="book-spine${sel}" data-book-id="${esc(b.id)}"
        title="${esc(b.title)} · ${STATUS_LABELS[b.status]}"
        style="--spine-w:${w}px;--spine-h:${h}px;--spine-bg:${esc(b.spineColor)}">
        <span class="spine-status-dot ${dot}"></span>
        <span class="spine-title">${esc(b.title)}</span>
        <span class="spine-author">${esc(b.author)}</span>
        <span class="spine-progress-bar"><span class="spine-progress-fill" style="width:${clamp(b.progress, 0, 100)}%"></span></span>
      </button>`;
    }).join('');

    const selected = state.selectedBookId && books.some((b) => b.id === state.selectedBookId)
      ? books.find((b) => b.id === state.selectedBookId) : null;

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
          ${book.coverUrl ? `<img src="${esc(book.coverUrl)}" alt="" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
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
        return;
      }
      const openBtn = e.target.closest('[data-open-detail]');
      if (openBtn) { openDetail(openBtn.dataset.openDetail); return; }
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
      else if (btn.dataset.emptyAct === 'demo') loadDemoBooks();
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
    $('#onlineBookList')?.addEventListener('click', (e) => {
      const addBtn = e.target.closest('[data-add-result]');
      const editBtn = e.target.closest('[data-edit-result]');
      if (!addBtn && !editBtn) return;
      const idx = parseInt((addBtn || editBtn).dataset.addResult || (addBtn || editBtn).dataset.editResult, 10);
      const item = state.searchResults[idx];
      if (!item) return;
      if (addBtn) { quickAddBook(item); }
      else {
        const draft = normalizeBook({
          title: item.title, author: item.author, genre: item.genre,
          pages: item.pages, wordsWan: item.wordsWan, summary: item.summary,
          coverUrl: item.coverUrl, spineColor: item.spineColor,
          status: 'want', createdAt: Date.now(), updatedAt: Date.now(),
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
    closeSheet('addBookBackdrop');
    state.selectedBookId = book.id;
    renderShelf();
    renderDaily();
    toast(`《${book.title}》已放上书架`);
  }

  async function quickAddBook(item) {
    const dup = state.books.find((b) => b.title === item.title && b.author === item.author);
    if (dup) { toast('这本书已在书架上'); return; }
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
      status: 'want',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await saveBook(book);
    toast(`《${book.title}》已加入想读`);
    renderDaily();
  }

  function pickColorFor(text) {
    const colors = window.SPINE_COLORS || ['#2F6354'];
    let h = 0;
    for (let i = 0; i < String(text).length; i++) h = (h * 31 + String(text).charCodeAt(i)) % 9973;
    return colors[h % colors.length];
  }

  /* =============================== 联网搜书 =============================== */
  const GENRE_KEYWORDS = [
    ['科幻', ['science fiction', 'sci-fi', 'space', '科幻']],
    ['悬疑', ['mystery', 'thriller', 'detective', 'crime', '悬疑', '推理']],
    ['历史', ['history', 'historical', '历史']],
    ['心理', ['psychology', 'self-help', 'mental', '心理']],
    ['哲学', ['philosophy', '哲学']],
    ['经管', ['business', 'economics', 'finance', 'management', '经济', '管理']],
    ['传记', ['biography', 'autobiography', 'memoir', '传记']],
    ['科普', ['science', 'popular science', '科普']],
    ['散文', ['essay', 'essays', '散文']],
    ['社科', ['sociology', 'social', 'politics', '社科']],
    ['文学', ['literary', 'literature', 'poetry', 'fiction', '文学', '小说']],
  ];

  function mapGenre(raw) {
    const text = String(raw || '').toLowerCase();
    for (const [genre, keys] of GENRE_KEYWORDS) {
      if (keys.some((k) => text.includes(k))) return genre;
    }
    return '小说';
  }

  async function searchOnlineBooks(query) {
    const q = String(query || '').trim();
    const status = $('#onlineBookStatus');
    const listEl = $('#onlineBookList');
    if (!q) { status.textContent = '请输入书名、作者或 ISBN'; return; }

    const lower = q.toLowerCase();
    const localHits = (window.CURATED_BOOKS || []).filter((b) => (
      b.title.toLowerCase().includes(lower)
      || b.author.toLowerCase().includes(lower)
      || b.genre.includes(q)
      || (b.summary || '').toLowerCase().includes(lower)
    )).map((b) => ({ ...b, local: true }));

    // 本地精选库命中时立即展示，联网结果稍后追加
    state.searchResults = localHits;
    if (localHits.length) {
      status.textContent = `精选库命中 ${localHits.length} 本 · 正在联网补充更多版本…`;
      renderOnlineResults(localHits);
    } else {
      status.textContent = `正在检索「${q}」…`;
      listEl.innerHTML = '<div class="search-skeleton">正在联网获取书籍信息…</div>';
    }

    const online = await fetchOnlineBooks(q);
    const merged = mergeResults(localHits, online.list);
    const sourceText = [online.source, localHits.length ? '内置精选书库' : ''].filter(Boolean).join(' + ');

    if (!merged.length) {
      status.textContent = '没有找到结果，试试更简短的书名或作者，也可以手动录入。';
      listEl.innerHTML = '<div class="search-empty">没有匹配的书籍，可直接「手动录入」。</div>';
      state.searchResults = [];
      return;
    }

    state.searchResults = merged;
    status.textContent = `${sourceText ? `来源：${sourceText} · ` : ''}仅含封面、简介、页数与估算字数（共 ${merged.length} 条）`;
    renderOnlineResults(merged);
  }

  function mergeResults(local, online) {
    const out = [];
    const seen = new Set();
    const push = (item) => {
      if (!item || !item.title) return;
      const key = `${item.title}|${item.author}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };
    local.forEach(push);
    online.forEach(push);
    return out.slice(0, 14).map((r) => ({ ...r, spineColor: r.spineColor || pickColorFor(r.title) }));
  }

  function renderOnlineResults(results) {
    const listEl = $('#onlineBookList');
    if (!listEl) return;
    listEl.innerHTML = results.map((r, i) => `
      <div class="online-book-item">
        <div class="online-book-cover" style="--spine-bg:${esc(r.spineColor || pickColorFor(r.title))};position:relative">
          ${typoCover(r)}
          ${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="" loading="lazy" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
        </div>
        <div class="online-book-info">
          <h4>${esc(r.title)} ${r.local ? '<span class="mini-tag primary">精选</span>' : ''}</h4>
          <div class="online-book-sub">${esc(r.author)} · ${esc(r.genre)}${r.pages ? ` · ${r.pages} 页` : ''}${r.wordsWan ? ` · 约 ${fmtWords(r.wordsWan)}` : ''}</div>
          <div class="online-book-desc">${esc(r.summary || '暂无简介，可加入后自行补充。')}</div>
          <div class="online-book-btns">
            <button type="button" class="btn btn-primary btn-sm" data-add-result="${i}">加入书架</button>
            <button type="button" class="btn btn-secondary btn-sm" data-edit-result="${i}">先编辑</button>
          </div>
        </div>
      </div>`).join('');
  }

  async function fetchOnlineBooks(q) {
    const timeout = 6500;
    try {
      const data = await requestJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=12&printType=books`, { timeout });
      const list = (data.items || []).map((it) => {
        const v = it.volumeInfo || {};
        const pages = num(v.pageCount, 0);
        const img = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '';
        return {
          title: (v.title || '') + (v.subtitle ? `：${v.subtitle}` : ''),
          author: Array.isArray(v.authors) ? v.authors.join(' / ') : '佚名',
          genre: mapGenre((v.categories || []).join(' ')),
          pages,
          wordsWan: pages ? +(pages * 0.065).toFixed(1) : 0,
          summary: v.description || '',
          coverUrl: img ? img.replace(/^http:/, 'https:').replace(/&edge=curl/, '') : '',
        };
      }).filter((x) => x.title);
      if (list.length) return { list, source: 'Google Books' };
    } catch { /* try next source */ }

    try {
      const data = await requestJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=title,author_name,number_of_pages_median,first_sentence,cover_i,subject`, { timeout });
      const list = (data.docs || []).map((d) => {
        const pages = num(d.number_of_pages_median, 0);
        return {
          title: d.title,
          author: (d.author_name || ['佚名']).slice(0, 2).join(' / '),
          genre: mapGenre((d.subject || []).slice(0, 4).join(' ')),
          pages,
          wordsWan: pages ? +(pages * 0.065).toFixed(1) : 0,
          summary: Array.isArray(d.first_sentence) ? d.first_sentence[0] : (d.first_sentence || ''),
          coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
        };
      }).filter((x) => x.title);
      return { list, source: 'Open Library' };
    } catch { /* offline */ }

    return { list: [], source: '' };
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
          ${book.coverUrl ? `<img src="${esc(book.coverUrl)}" alt="" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
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

    buildStarPicker($('#detailStarPicker'), book.rating, async (v) => {
      book.rating = v;
      await saveBook(book, true);
      const label = $('#detailRatingLabel');
      if (label) label.textContent = starValueText(v);
      buildStarPicker($('#detailStarPicker'), v, async (nv) => {
        book.rating = nv;
        await saveBook(book, true);
        if (label) label.textContent = starValueText(nv);
        buildStarPicker($('#detailStarPicker'), nv, () => {});
        renderStats();
      });
      renderStats();
    });

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
      const raw = localStorage.getItem('shufang.timer');
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
    try { localStorage.setItem('shufang.timer', JSON.stringify(state.timer)); } catch { /* ignore */ }
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
      } else if (!t.bookId) {
        const fallback = options[0] ? options[0].id : null;
        t.bookId = fallback;
      }
    }
    if (select && t.bookId) select.value = t.bookId;
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

  async function finishTimerSession() {
    const t = state.timer;
    const ms = t.running ? t.elapsedMs + (Date.now() - t.startedAt) : t.elapsedMs;
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (!t.bookId) { toast('请选择书籍'); return; }
    if (ms < 30000) { toast('阅读不足 30 秒，暂不记录'); return; }
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

    const timeInput = $('#manualTimeInput');
    if (timeInput) {
      const d = new Date();
      timeInput.value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    $('#saveManualSessionBtn')?.addEventListener('click', async () => {
      const mins = clamp(Math.round(num($('#manualMinInput').value, 0)), 1, 600);
      const bookId = $('#timerBookSelect')?.value || state.timer.bookId;
      if (!mins) { toast('请输入阅读分钟数'); return; }
      if (!bookId) { toast('请先选择书籍'); return; }
      const timeVal = $('#manualTimeInput')?.value || '';
      const now = new Date();
      let startedAt = now.getTime() - mins * 60000;
      if (timeVal) {
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
      toast(`已补记 ${fmtDuration(mins)}`);
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
      const ok = bridge.post({ type: 'startDictation', locale: 'zh-CN' });
      if (ok) {
        state.dictating = true;
        btn?.classList.add('recording');
        if (label) label.textContent = '🎙 正在聆听…点击停止';
        return;
      }
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
    setOcrStatus('正在识别文字…');
    if (bridge.available) {
      const base64 = dataUrl.split(',')[1] || '';
      const ok = bridge.post({ type: 'recognizeOcr', imageBase64: base64, languages: ['zh-Hans', 'en-US'] });
      if (ok) return;
    }
    const ai = getMeta('ai', null);
    if (ai && ai.key) {
      try {
        const text = await ocrWithDoubao(dataUrl, ai);
        if (text) {
          appendToNoteText(text);
          setOcrStatus(`已用豆包识别 · ${text.length} 字`);
          toast('扫描文字已提取');
        } else {
          setOcrStatus('未识别到文字，可手动补充');
        }
      } catch (err) {
        setOcrStatus('识别失败，请检查豆包 Key 或手动输入');
      }
      return;
    }
    setOcrStatus('已保存扫描图（当前环境无 OCR，可打字补充或配置豆包 Key）');
    toast('图片已保存；配置豆包 Key 后可自动提取文字');
  }

  async function ocrWithDoubao(dataUrl, ai) {
    const content = await callDoubao([
      { role: 'system', content: '你是中文 OCR 助手，只输出图片中的文字，保持段落，不要解释。' },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: '请提取这张读书笔记图片中的所有文字。' },
      ] },
    ], { ai, maxTokens: 1200 });
    return String(content || '').trim();
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
    renderRecommendations();
  }

  function computeRecommendations() {
    const owned = new Set(state.books.map((b) => `${b.title}|${b.author}`));
    const ownedTitles = new Set(state.books.map((b) => b.title));
    const genreScore = new Map();
    const authorScore = new Map();
    state.books.forEach((b) => {
      const w = (b.status === 'finished' ? 2.2 : 1) + (b.rating || 0) / 2.5;
      genreScore.set(b.genre, (genreScore.get(b.genre) || 0) + w);
      authorScore.set(b.author, (authorScore.get(b.author) || 0) + w * 0.8);
    });
    const finishedGenres = new Set(state.books.filter((b) => b.status === 'finished').map((b) => b.genre));
    const top = topGenres(1)[0];

    const candidates = (window.CURATED_BOOKS || [])
      .filter((b) => !owned.has(`${b.title}|${b.author}`) && !ownedTitles.has(b.title))
      .map((b) => {
        let score = (genreScore.get(b.genre) || 0) * 1.4 + (authorScore.get(b.author) || 0);
        if (finishedGenres.has(b.genre)) score += 1.2;
        if (!state.books.length) score += (b.wordsWan < 25 ? 1.6 : 0);
        score += hashStr(b.title) * 0.8;
        let reason = '';
        if (top && b.genre === top) reason = `延续你在「${b.genre}」上的口味`;
        else if (authorScore.get(b.author)) reason = `你读过 ${b.author} 的作品`;
        else if (finishedGenres.has(b.genre)) reason = `你读完过同题材好书 · ${b.genre}`;
        else if (b.wordsWan && b.wordsWan <= 14) reason = '篇幅轻巧，适合这几天开读';
        else reason = '高口碑经典，值得放进书房';
        return { ...b, reason, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (!candidates.length) {
      return (window.CURATED_BOOKS || []).slice(0, 3).map((b) => ({ ...b, reason: '书房经典，随时可以重读' }));
    }
    return candidates;
  }

  function renderRecommendations() {
    state.recommendations = computeRecommendations();
    const list = $('#recommendedBooksList');
    if (!list) return;
    list.innerHTML = state.recommendations.map((b, i) => `
      <div class="rec-card">
        <div class="rec-cover" style="--spine-bg:${esc(b.spineColor || pickColorFor(b.title))}">
          ${typoCover(b)}
        </div>
        <div class="rec-info">
          <div class="rec-title-row"><strong>${esc(b.title)}</strong><span class="mini-tag gold">${esc(b.genre)}</span></div>
          <div class="rec-reason">${esc(b.reason || '')}</div>
          <div class="rec-summary">${esc(b.summary || '')}</div>
          <div class="rec-bottom">
            <span class="mini-tag">${b.pages ? `${b.pages} 页 · ` : ''}${fmtWords(b.wordsWan)}</span>
            <button class="btn btn-soft btn-sm" type="button" data-rec-add="${i}">加入书架</button>
          </div>
        </div>
      </div>`).join('');

    const sub = $('#recReasonSub');
    if (sub) {
      const top = topGenres(2);
      sub.textContent = top.length ? `基于你偏爱的「${top.join('」「')}」与评分习惯` : '基于内置精选书库，先读几本再个性化推荐';
    }
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
    $('#recommendedBooksList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rec-add]');
      if (!btn) return;
      const book = state.recommendations[parseInt(btn.dataset.recAdd, 10)];
      if (book) quickAddBook(book);
      renderRecommendations();
    });
    $('#aiRecommendBtn')?.addEventListener('click', aiRecommendBooks);
    $('#aiInsightBtn')?.addEventListener('click', aiGenerateInsight);
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
    ctx.fillText('书房小记 · 每日拾页', W - 96, footerY + 42);
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
      shareDataUrl(dataUrl, '书房小记-摘录卡片.png');
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

  function renderStats() {
    const h = computeHabitData();
    const goal = num(getMeta('goal', 24), 24) || 24;
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
    if (goalTitle) goalTitle.textContent = `${new Date().getFullYear()} 年已读 ${finishedCount} / ${goal} 本`;
    const streakSub = $('#streakSubText');
    if (streakSub) streakSub.textContent = `连续阅读 ${h.streak} 天 · 今日 ${Math.round(h.todayMinutes)} 分钟`;

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

  function bindStats() {
    $('#editGoalBtn')?.addEventListener('click', async () => {
      const current = num(getMeta('goal', 24), 24);
      const idx = GOAL_PRESETS.indexOf(current);
      const next = GOAL_PRESETS[(idx + 1) % GOAL_PRESETS.length];
      await setMeta('goal', next);
      renderStats();
      toast(`年度目标已调整为 ${next} 本`);
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

    const ai = getMeta('ai', null);
    const keyInput = $('#doubaoKeyInput');
    const modelInput = $('#doubaoModelInput');
    const urlInput = $('#doubaoUrlInput');
    if (ai) {
      if (keyInput) keyInput.value = ai.key || '';
      if (modelInput) modelInput.value = ai.model || '';
      if (urlInput) urlInput.value = ai.url || '';
    } else {
      if (keyInput) keyInput.value = '';
      if (modelInput) modelInput.value = 'doubao-1-5-pro-32k-250115';
      if (urlInput) urlInput.value = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    }
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
        theme: getMeta('theme', 'auto'),
        savedQuotes: getMeta('savedQuotes', []),
      },
    };
    const json = JSON.stringify(data);
    const filename = `书房小记备份-${dateKey()}.json`;
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
      for (const key of ['goal', 'savedQuotes', 'theme']) {
        if (key in data.meta) await setMeta(key, data.meta[key]);
      }
      if (data.meta.theme) applyTheme();
    }
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

    $('#saveDoubaoCfgBtn')?.addEventListener('click', async () => {
      const key = ($('#doubaoKeyInput').value || '').trim();
      const model = ($('#doubaoModelInput').value || '').trim() || 'doubao-1-5-pro-32k-250115';
      const url = ($('#doubaoUrlInput').value || '').trim() || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
      if (!key) { toast('请填写火山方舟 API Key'); return; }
      await setMeta('ai', { key, model, url });
      toast('豆包配置已保存（仅存本机）');
    });
    $('#clearDoubaoCfgBtn')?.addEventListener('click', async () => {
      await setMeta('ai', null);
      renderSettings();
      toast('已清除豆包配置');
    });

    $('#loadDemoBooksBtn')?.addEventListener('click', loadDemoBooks);
    $('#clearAllBtn')?.addEventListener('click', async () => {
      await dbClear('books');
      await dbClear('sessions');
      await dbClear('meta');
      state.books = [];
      state.sessions = [];
      state.meta = {};
      state.selectedBookId = null;
      localStorage.removeItem('shufang.timer');
      state.timer = { bookId: null, running: false, startedAt: 0, elapsedMs: 0, ambient: 'off' };
      applyTheme();
      renderShelf(); renderDaily(); renderStats(); renderSettings();
      toast('已清空本地数据');
    });
  }

  /* =============================== 豆包 AI =============================== */
  async function callDoubao(messages, opts = {}) {
    const ai = opts.ai || getMeta('ai', null);
    if (!ai || !ai.key) throw new Error('未配置豆包 Key');
    const url = ai.url || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    const body = JSON.stringify({
      model: ai.model || 'doubao-1-5-pro-32k-250115',
      messages,
      temperature: opts.temperature == null ? 0.6 : opts.temperature,
      max_tokens: opts.maxTokens || 1500,
    });
    const data = await requestJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.key}`,
      },
      body,
      timeout: 45000,
    });
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('AI 未返回内容');
    return content;
  }

  function libraryDigest() {
    return state.books.slice(0, 30).map((b) => {
      const mins = Math.round(bookSessionMinutes(b.id));
      return `《${b.title}》${b.author}｜${b.genre}｜状态:${STATUS_LABELS[b.status]}｜评分:${b.rating || '未评'}｜进度:${Math.round(b.progress)}%｜累计:${mins}分钟｜笔记:${(b.notes || []).length}条`;
    }).join('\n');
  }

  async function aiRecommendBooks() {
    const ai = getMeta('ai', null);
    if (!ai || !ai.key) {
      toast('请先在「设置」配置豆包 API Key');
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
      ], { ai, maxTokens: 1200, temperature: 0.7 });
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
      toast('豆包已为你挑好 4 本书');
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
    const ai = getMeta('ai', null);
    if (!ai || !ai.key) {
      toast('请先在「设置」配置豆包 API Key');
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
      ], { ai, maxTokens: 700, temperature: 0.75 });
      if (box) box.textContent = String(text).trim();
      toast('AI 阅读画像已生成');
    } catch (err) {
      if (box) box.textContent = `生成失败：${err.message || '请检查豆包配置'}`;
      toast('AI 画像生成失败');
    } finally {
      if (btn) { btn.textContent = original; btn.disabled = false; }
    }
  }

  /* =============================== 示例数据 =============================== */
  const DEMO_BOOKS = [
    {
      key: '三体',
      status: 'reading',
      rating: 4.5,
      progress: 62,
      sessions: [
        { daysAgo: 6, hour: 22, minutes: 45 },
        { daysAgo: 4, hour: 21, minutes: 38 },
        { daysAgo: 2, hour: 23, minutes: 52 },
        { daysAgo: 1, hour: 22, minutes: 41 },
      ],
      notes: [
        { type: 'quote', content: '我们都是阴沟里的虫子，但总还是得有人仰望星空。', page: 'P.213', image: '', daysAgo: 3, hour: 22 },
        { type: 'reflection', content: '第一次真正理解"宏大"两个字。叶文洁按下发射键的那一刻，个人的绝望变成了整个文明的转折点，这种因果的重量让人喘不过气。', page: '第 12 章', image: '', daysAgo: 1, hour: 23 },
      ],
      characters: [
        { name: '叶文洁', role: '天体物理学家', color: '#3D5A73', tags: ['绝望', '理性', '关键抉择'], bio: '亲历时代创伤后对人类文明彻底失望，在红岸基地向宇宙发出第一声呼唤，成为两个文明命运的转折点。', quote: '到这里来吧，我将帮助你们获得这个世界。' },
        { name: '汪淼', role: '纳米材料学家', color: '#2F6354', tags: ['好奇', '坚韧'], bio: '被卷入科学家自杀谜局的纳米学者，通过三体游戏逐步逼近真相，也是读者进入这个世界的眼睛。', quote: '整个宇宙将为你闪烁。' },
        { name: '史强', role: '刑警 / 反恐', color: '#8A5A44', tags: ['粗粝', '可靠'], bio: '不修边幅却极其可靠的老刑警，用最朴素的生存智慧对抗最宏大的未知威胁。', quote: '邪乎到家必有鬼。' },
        { name: '罗辑', role: '社会学者', color: '#6E4B6A', tags: ['玩世不恭', '洞察'], bio: '被推上历史舞台的普通人，在孤独中推演出黑暗森林法则，成为悬在两个文明头顶的执剑人。', quote: '我对三体世界说话。' },
      ],
      relations: [
        { from: 0, to: 1, label: '引导', tone: 'neutral' },
        { from: 1, to: 2, label: '并肩', tone: 'bond' },
        { from: 1, to: 3, label: '同路', tone: 'neutral' },
        { from: 2, to: 3, label: '护佑', tone: 'mentor' },
        { from: 0, to: 3, label: '命运交错', tone: 'rival' },
      ],
    },
    {
      key: '活着',
      status: 'finished',
      rating: 5,
      progress: 100,
      sessions: [
        { daysAgo: 9, hour: 8, minutes: 62 },
        { daysAgo: 7, hour: 7, minutes: 55 },
        { daysAgo: 5, hour: 9, minutes: 48 },
        { daysAgo: 3, hour: 8, minutes: 39 },
      ],
      notes: [
        { type: 'reflection', content: '读到最后福贵牵着老牛走过田埂，突然明白"活着"本身就是答案。余华把苦难写得极轻，反而更重。', page: '结尾', image: '', daysAgo: 3, hour: 9 },
      ],
      characters: [
        { name: '福贵', role: '主人公', color: '#9A7234', tags: ['坚韧', '认命', '温厚'], bio: '从败家少爷到一无所有的老人，一生送走所有至亲，最后与一头老牛平静度日。', quote: '人是为了活着本身而活着的。' },
        { name: '家珍', role: '妻子', color: '#7B3E4B', tags: ['隐忍', '深情'], bio: '出身米行千金，却用一生包容福贵的荒唐，在贫病中始终不曾离开。', quote: '我不图什么，就想跟你过日子。' },
        { name: '有庆', role: '儿子', color: '#4A6B52', tags: ['纯真', '赤脚奔跑'], bio: '每天赤脚跑十几里路上学的少年，为了给校长献血意外离世，是全书最锋利的一刀。', quote: '' },
      ],
      relations: [
        { from: 0, to: 1, label: '夫妻', tone: 'love' },
        { from: 0, to: 2, label: '父子', tone: 'bond' },
        { from: 1, to: 2, label: '母子', tone: 'bond' },
      ],
    },
    {
      key: '人类简史',
      status: 'reading',
      rating: 4,
      progress: 28,
      sessions: [
        { daysAgo: 8, hour: 20, minutes: 34 },
        { daysAgo: 2, hour: 21, minutes: 46 },
      ],
      notes: [],
      characters: [],
      relations: [],
    },
    {
      key: '白夜行',
      status: 'want',
      rating: 0,
      progress: 0,
      sessions: [],
      notes: [],
      characters: [
        { name: '桐原亮司', role: '黑暗中的守护者', color: '#3E5266', tags: ['沉默', '赎罪'], bio: '在父亲命案后隐入黑暗，用一生为雪穗清除障碍，自己却始终不被阳光照到。', quote: '我的人生就像在白夜里走路。' },
        { name: '唐泽雪穗', role: '完美女性', color: '#7B3E4B', tags: ['优雅', '深渊'], bio: '外表无懈可击的女性，内心背负童年创伤，与亮司在暗处共生。', quote: '' },
      ],
      relations: [{ from: 0, to: 1, label: '共生', tone: 'love' }],
    },
  ];

  function dayAt(daysAgo, hour, baseTs = Date.now()) {
    const d = new Date(baseTs);
    d.setDate(d.getDate() - (daysAgo || 0));
    d.setHours(hour == null ? 20 : hour, Math.floor(Math.random() * 50), 0, 0);
    return d.getTime();
  }

  async function loadDemoBooks() {    if (state.books.length) {
      toast('书架里已有书，示例将追加导入');
    }
    let added = 0;
    for (const demo of DEMO_BOOKS) {
      const meta = (window.CURATED_BOOKS || []).find((b) => b.title === demo.key);
      if (!meta) continue;
      if (state.books.some((b) => b.title === meta.title)) continue;
      const now = Date.now();
      const chars = demo.characters.map((c) => ({ id: uid('ch'), ...c }));
      const relations = demo.relations.map((r) => ({
        id: uid('rl'),
        from: chars[r.from] ? chars[r.from].id : (chars[0] && chars[0].id),
        to: chars[r.to] ? chars[r.to].id : (chars[1] && chars[1].id),
        label: r.label,
        tone: r.tone,
      })).filter((r) => r.from && r.to);
      const notes = demo.notes.map((n) => ({
        id: uid('nt'),
        type: n.type,
        content: n.content,
        page: n.page,
        image: n.image || '',
        createdAt: dayAt(n.daysAgo, n.hour, now),
      }));
      const book = normalizeBook({
        id: uid('bk'),
        title: meta.title,
        author: meta.author,
        genre: meta.genre,
        pages: meta.pages,
        wordsWan: meta.wordsWan,
        spineColor: meta.spineColor,
        summary: meta.summary,
        coverUrl: '',
        status: demo.status,
        rating: demo.rating,
        progress: demo.progress,
        notes,
        characters: chars,
        relations,
        createdAt: now - 86400000 * 12,
        updatedAt: now,
        lastReadAt: demo.sessions.length ? dayAt(demo.sessions[demo.sessions.length - 1].daysAgo, demo.sessions[demo.sessions.length - 1].hour, now) : 0,
      });
      await saveBook(book, true);
      added++;

      for (const s of demo.sessions) {
        await addSession({
          id: uid('ss'),
          bookId: book.id,
          startedAt: dayAt(s.daysAgo, s.hour, now),
          minutes: s.minutes,
          source: 'timer',
        });
      }
    }
    renderShelf(); renderDaily(); renderStats(); renderSettings();
    if (added) {
      state.selectedBookId = state.books[state.books.length - 1].id;
      renderShelf();
      toast(`已导入 ${added} 本示例书，含人物图谱与阅读记录`);
    } else {
      toast('示例书籍已在书架中');
    }
  }

  /* =============================== 启动 =============================== */
  function maybeShowInstallBanner() {
    const banner = $('#installBanner');
    if (!banner) return;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const dismissed = getMeta('installDismissed', false);
    if (standalone || dismissed || bridge.available) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    $('#closeInstallBanner')?.addEventListener('click', async () => {
      banner.classList.add('hidden');
      await setMeta('installDismissed', true);
    });
  }

  function hideSafariGuideIfNative() {
    if (bridge.available) $('#safariInstallGuideCard')?.classList.add('hidden');
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
    try {
      await loadAll();
    } catch {
      state.books = memAll('books').map(normalizeBook);
      state.sessions = memAll('sessions');
      state.meta = {};
      memAll('meta').forEach((r) => { state.meta[r.key] = r.value; });
    }

    applyTheme();
    bindStatic();

    const theme = getMeta('theme', 'auto');
    if (!theme) await setMeta('theme', 'auto');

    // 默认选中最近在读的一本
    if (!state.selectedBookId) {
      const reading = state.books.filter((b) => b.status === 'reading').sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))[0];
      state.selectedBookId = reading ? reading.id : null;
    }

    renderAll();
    restoreTimer();
    updateTimerUI();
    registerSW();

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
