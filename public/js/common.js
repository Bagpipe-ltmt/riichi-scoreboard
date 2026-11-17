/* 共用：API 客户端、登录态、小工具 */
(function () {
  'use strict';

  const TOKEN_KEY = 'rc_token';
  const USER_KEY = 'rc_user';

  const Auth = {
    get token() { return localStorage.getItem(TOKEN_KEY) || ''; },
    get user() {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; }
    },
    set(token, user) {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user || null));
    },
    setUser(user) { localStorage.setItem(USER_KEY, JSON.stringify(user || null)); },
    clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); },
  };

  // 登录失效的统一钩子：带着 token 却被服务器判 401（会话过期 / 服务器重启换过数据 /
  // 换了账号）时触发，页面订阅它就能把用户送回登录界面，而不是让他对着 403 发呆。
  const authLostHandlers = [];
  function onAuthLost(fn) { authLostHandlers.push(fn); }
  let authLostFired = false;
  function fireAuthLost(msg) {
    Auth.clear();
    if (authLostFired) return;
    authLostFired = true;
    authLostHandlers.forEach((f) => { try { f(msg); } catch (_) { /* ignore */ } });
    setTimeout(() => { authLostFired = false; }, 2000);
  }

  async function req(path, opts) {
    opts = opts || {};
    const sentToken = Auth.token;
    const headers = { 'Content-Type': 'application/json' };
    if (sentToken) headers['Authorization'] = 'Bearer ' + sentToken;
    if (opts.hostKey) headers['X-Host-Key'] = opts.hostKey;
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok || !data || data.ok === false) {
      const msg = (data && data.error) || ('请求失败 (' + res.status + ')');
      const isAuthEntry = /^\/api\/auth\/(login|register|guest)$/.test(path);
      if (res.status === 401 && sentToken && sentToken === Auth.token && !isAuthEntry) {
        fireAuthLost(msg);
      }
      const e = new Error(msg);
      e.status = res.status;
      e.code = data && data.code;
      throw e;
    }
    return data;
  }

  const api = {
    ping: () => req('/api/ping'),
    hostInfo: () => req('/api/host-info'),
    register: (name, password) => req('/api/auth/register', { method: 'POST', body: { name, password } }),
    login: (name, password) => req('/api/auth/login', { method: 'POST', body: { name, password } }),
    guest: (name) => req('/api/auth/guest', { method: 'POST', body: { name } }),
    logout: () => req('/api/auth/logout', { method: 'POST' }),
    me: () => req('/api/auth/me'),
    rooms: () => req('/api/rooms'),
    createRoom: (config) => req('/api/rooms', { method: 'POST', body: { config } }),
    room: (code) => req('/api/rooms/' + code),
    whoami: (code, hostKey) => req('/api/rooms/' + code + '/whoami', { hostKey }),
    join: (code, seat, name) => req('/api/rooms/' + code + '/join', { method: 'POST', body: { seat, name } }),
    leave: (code, seat) => req('/api/rooms/' + code + '/leave', { method: 'POST', body: { seat } }),
    action: (code, type, payload, hostKey) =>
      req('/api/rooms/' + code + '/action', { method: 'POST', body: { type, payload, hostKey }, hostKey }),
    closeRoom: (code, hostKey) => req('/api/rooms/' + code + '/close', { method: 'POST', body: { hostKey }, hostKey }),
    myGames: () => req('/api/me/games'),
    game: (id) => req('/api/games/' + id),
    /* 管理端 */
    adminOverview: () => req('/api/admin/overview'),
    adminGames: (query) => req('/api/admin/games' + (query || '')),
    adminGame: (id) => req('/api/admin/games/' + id),
    adminDeleteGame: (id) => req('/api/admin/games/' + id, { method: 'DELETE' }),
    adminPlayers: () => req('/api/admin/players'),
    adminRooms: () => req('/api/admin/rooms'),
    adminRoomEnd: (code) => req('/api/admin/rooms/' + encodeURIComponent(code) + '/end', { method: 'POST' }),
    adminRoomClose: (code) => req('/api/admin/rooms/' + encodeURIComponent(code) + '/close', { method: 'POST' }),
    adminPassword: (password) => req('/api/admin/password', { method: 'POST', body: { password } }),
  };

  /* ---------------- 小工具 ---------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtScore(n) {
    const v = Number(n) || 0;
    const sign = v < 0 ? '−' : '';
    return sign + Math.abs(v).toLocaleString('en-US');
  }

  function fmtSigned(n) {
    const v = Number(n) || 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US');
  }

  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtDate(ts) {
    const d = new Date(ts || Date.now());
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    let node = document.querySelector('.toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast';
      document.body.appendChild(node);
    }
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 2600);
  }

  /** 骰子点数 → 3x3 点阵 HTML */
  const PIP_MAP = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  function dieHtml(v, rolling) {
    const pips = PIP_MAP[v] || [];
    let inner = '';
    for (let i = 0; i < 9; i++) inner += `<i class="${pips.indexOf(i) >= 0 ? 'on' : ''}"></i>`;
    return `<div class="die${rolling ? ' rolling' : ''}">${inner}</div>`;
  }

  /** SSE 订阅房间状态 */
  function subscribeRoom(code, onRoom, onStatus) {
    let es = null;
    let closed = false;
    let retry = 0;

    function open() {
      if (closed) return;
      const q = Auth.token ? ('?token=' + encodeURIComponent(Auth.token)) : '';
      es = new EventSource('/api/rooms/' + code + '/events' + q);
      es.onopen = () => { retry = 0; onStatus && onStatus(true); };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          onRoom && onRoom(data.room, data);
        } catch (_) { /* ignore */ }
      };
      es.onerror = () => {
        onStatus && onStatus(false);
        try { es.close(); } catch (_) { /* ignore */ }
        es = null;
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        setTimeout(open, 800 * retry);
      };
    }
    open();
    return {
      close() { closed = true; if (es) { try { es.close(); } catch (_) { /* ignore */ } } },
    };
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function shell(title) {
    // 统一顶栏
    return `
      <div class="topbar">
        <span class="title gold">${esc(title || '立直麻将 · 场风盘')}</span>
        <span class="spacer"></span>
        <span class="conn off" id="conn"><span class="dot"></span><span id="connText">连接中</span></span>
        <a class="btn sm ghost" href="/">首页</a>
      </div>`;
  }

  window.RC = { Auth, api, req, onAuthLost, esc, fmtScore, fmtSigned, fmtTime, fmtDate, toast, dieHtml, subscribeRoom, qs, shell, PIP_MAP };
})();
