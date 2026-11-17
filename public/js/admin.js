/* 管理员端：全站对局记录 */
(function () {
  'use strict';
  const { Auth, api, esc, fmtScore, fmtSigned, fmtDate, toast, onAuthLost } = RC;

  const $ = (id) => document.getElementById(id);
  const WIND = { E: '东', S: '南', W: '西' };
  const PHASE = { lobby: '准备中', playing: '对局中', ended: '已终局' };

  let me = null;
  let page = 0;
  const PAGE = 60;
  let lastQuery = '';
  let hasMore = false;

  /* ---------------------------- 登录 ---------------------------- */

  function show(id) {
    for (const v of ['loginView', 'mainView']) $(v).classList.toggle('hidden', v !== id);
    for (const b of ['btnExport', 'btnRefresh', 'btnPasswd', 'btnLogout']) {
      $(b).classList.toggle('hidden', id !== 'mainView');
    }
  }

  async function doLogin() {
    const name = $('auName').value.trim();
    const pass = $('auPass').value;
    if (!name || !pass) return toast('请填账号和密码', 'err');
    $('btnLogin').disabled = true;
    $('loginMsg').textContent = '';
    try {
      const r = await api.login(name, pass);
      if (!r.user || r.user.role !== 'admin') {
        await api.logout().catch(() => {});
        Auth.clear();
        $('loginMsg').textContent = '这个账号不是管理员（' + (r.user ? r.user.name : '?') + '），请用管理员账号登录。';
        return;
      }
      Auth.set(r.token, r.user);
      me = r.user;
      enter();
    } catch (e) {
      $('loginMsg').textContent = e.message;
    } finally {
      $('btnLogin').disabled = false;
    }
  }

  async function boot() {
    if (!Auth.token) return show('loginView');
    try {
      const r = await api.me();
      if (!r.user) return show('loginView');
      if (r.user.role !== 'admin') {
        $('loginMsg').textContent = '当前登录的是普通玩家账号「' + r.user.name + '」，请用管理员账号登录。';
        return show('loginView');
      }
      me = r.user;
      enter();
    } catch (e) {
      show('loginView');
    }
  }

  function enter() {
    show('mainView');
    $('whoPill').textContent = me.name + '（管理员）';
    $('auName').value = me.name;
    loadAll();
  }

  /* ---------------------------- 概览 ---------------------------- */

  async function loadOverview() {
    try {
      const r = await api.adminOverview();
      const o = r.overview;
      const kpi = (k, v, small) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v${small ? ' sm' : ''}">${v}</div></div>`;
      $('kpis').innerHTML = [
        kpi('对局总数', o.games),
        kpi('局数（小局）', o.hands),
        kpi('和了次数', o.agari),
        kpi('玩家数', o.players),
        kpi('房间数', o.rooms),
        kpi('进行中房间', o.roomsLive),
        kpi('最近 7 天对局', o.last7),
        kpi('最近一局', o.latestAt ? esc(fmtDate(o.latestAt)) : '—', true),
      ].join('');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* -------------------------- 对局记录 -------------------------- */

  function playerCells(g) {
    const by = {};
    for (const p of g.players) by[p.rank] = p;
    let html = '';
    for (let r = 1; r <= 4; r++) {
      const p = by[r];
      html += `<td class="${r === 1 ? 'r1' : ''}">${p ? esc(p.name) : '—'}</td>`;
      html += `<td class="num">${p ? fmtScore(p.score) : '—'}</td>`;
    }
    return html;
  }

  function gameRow(g) {
    return `<tr data-id="${esc(g.id)}">
      <td>${esc(fmtDate(g.endedAt || g.startedAt))}</td>
      <td class="code">${esc(g.code)}</td>
      <td>${g.gameType === 'tonpuusen' ? '东风战' : '半庄战'}</td>
      <td class="num">${g.hands}</td>
      <td>${esc(g.endReasonText || g.endReason)}</td>
      ${playerCells(g)}
      <td><button class="btn sm ghost" data-view="${esc(g.id)}">查看</button></td>
    </tr>`;
  }

  function buildQuery(offset) {
    const p = new URLSearchParams();
    const q = $('fq').value.trim();
    if (q) p.set('q', q);
    if ($('fFrom').value) p.set('from', String(new Date($('fFrom').value + 'T00:00:00').getTime()));
    if ($('fTo').value) p.set('to', String(new Date($('fTo').value + 'T23:59:59').getTime()));
    p.set('limit', String(PAGE));
    p.set('offset', String(offset));
    return '?' + p.toString();
  }

  async function loadGames(more) {
    if (!more) { page = 0; }
    try {
      const q = buildQuery(page * PAGE);
      const r = await api.adminGames(q.replace(/^\?/, '?'));
      lastQuery = q;
      if (!more) $('gamesBody').innerHTML = '';
      if (!r.games.length && !more) {
        $('gamesBody').innerHTML = '<tr><td colspan="15" class="adm-empty">还没有对局记录</td></tr>';
      }
      $('gamesBody').insertAdjacentHTML('beforeend', r.games.map(gameRow).join(''));
      hasMore = page * PAGE + r.games.length < r.total;
      $('btnMore').classList.toggle('hidden', !hasMore);
      $('gamesCount').textContent = '共 ' + r.total + ' 场，已显示 ' + (page * PAGE + r.games.length) + ' 场';
      bindView();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function bindView() {
    document.querySelectorAll('[data-view]').forEach((b) => {
      if (b._bound) return;
      b._bound = true;
      b.onclick = () => openDetail(b.getAttribute('data-view'));
    });
  }

  async function openDetail(id) {
    try {
      const r = await api.adminGame(id);
      const g = r.game;
      const by = {};
      for (const p of g.players || []) by[p.rank] = p;
      const rows = [1, 2, 3, 4].map((rank) => {
        const p = by[rank];
        if (!p) return '';
        return `<tr class="${rank === 1 ? 'rank-1' : ''}">
          <td>${rank}位</td>
          <td>${esc(p.name)}${p.starter ? ' <span class="pill gold">起家</span>' : ''}</td>
          <td class="num">${fmtScore(p.score)}</td>
          <td class="num">${p.diff === null || p.diff === undefined ? '—' : fmtSigned(Number(p.diff).toFixed(1))}</td>
          <td class="num">${p.wins || 0}</td>
        </tr>`;
      }).join('');

      const hands = (g.hands || []).map((h, i) => {
        // h.round 在记录里是字符串（如「东1局」），不是对象
        const rl = (typeof h.round === 'string' ? h.round : '') + (h.honba || 0) + '本场';
        let text;
        if (h.type === 'agari') {
          text = `${esc(h.winnerName)}（${esc(h.winnerWind || '')}家）` +
            (h.tsumo ? '自摸' : `荣和 ${esc(h.loserName || '')}`) +
            ` · ${esc(h.label || '')} <span class="gold">${fmtSigned(h.gain)}</span>` +
            (h.stickGain ? ` <span class="muted">+供托${fmtScore(h.stickGain)}</span>` : '');
        } else {
          const tenpai = (h.tenpai || []).map((t, k) => t ? k : -1).filter((k) => k >= 0);
          const names = tenpai.map((k) => (g.players[k] || {}).name || ('席' + (k + 1)));
          text = `${esc(h.drawLabel || '流局')} ｜听牌: ${names.length ? names.map(esc).join('、') : '无'}`;
        }
        return `<div class="adm-hand"><span class="r">${esc(rl)}</span><span>${text}</span></div>`;
      }).join('') || '<div class="adm-empty">没有小局记录</div>';

      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal" style="max-width:720px">
          <h3>${esc(g.endReasonText || '对局记录')}</h3>
          <p class="small muted" style="margin:-8px 0 12px">
            房间 ${esc(g.code)} · ${g.config && g.config.gameType === 'tonpuusen' ? '东风战' : '半庄战'} ·
            ${esc(fmtDate(g.endedAt || g.startedAt))} · 主持 ${esc(g.hostName || '—')}
          </p>
          <div class="adm-scroll">
            <table class="result-table">
              <thead><tr><th>顺位</th><th>玩家</th><th style="text-align:right">点数</th><th style="text-align:right">收支</th><th style="text-align:right">和了</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <p class="tiny muted" style="margin:10px 0 0">收支 =（点数 − 起始点数）÷ 1000 ± 烧鸟</p>
          <h4 style="margin:18px 0 8px;font-size:15px">小局明细（${(g.hands || []).length} 局）</h4>
          <div class="adm-card">${hands}</div>
          <div class="modal-actions">
            <button class="btn ghost" data-x="del" style="color:#ff9b9b">删除这条记录</button>
            <button class="btn" data-x="close">关闭</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      mask.addEventListener('click', async (ev) => {
        const t = ev.target;
        if (t === mask || t.getAttribute('data-x') === 'close') {
          mask.remove();
          return;
        }
        if (t.getAttribute('data-x') === 'del') {
          if (!confirm('确定删除这条对局记录？删除后不可恢复。')) return;
          try {
            await api.adminDeleteGame(g.id);
            toast('已删除', 'ok');
            mask.remove();
            loadGames(false);
            loadOverview();
          } catch (e) {
            toast(e.message, 'err');
          }
        }
      });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* -------------------------- 玩家统计 -------------------------- */

  async function loadPlayers() {
    try {
      const r = await api.adminPlayers();
      if (!r.players.length) {
        $('playersBody').innerHTML = '<tr><td colspan="10" class="adm-empty">还没有数据</td></tr>';
        return;
      }
      $('playersBody').innerHTML = r.players.map((p) => `<tr>
        <td>${esc(p.name)}</td>
        <td class="num">${p.games}</td>
        <td class="num">${p.first}</td>
        <td class="num">${p.second}</td>
        <td class="num">${p.third}</td>
        <td class="num">${p.fourth}</td>
        <td class="num">${p.avgRank}</td>
        <td class="num">${p.wins}</td>
        <td class="num">${fmtScore(p.avgScore)}</td>
        <td>${p.lastAt ? esc(fmtDate(p.lastAt)) : '—'}</td>
      </tr>`).join('');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* ---------------------------- 房间 ---------------------------- */

  async function loadRooms() {
    try {
      const r = await api.adminRooms();
      if (!r.rooms.length) {
        $('roomsBody').innerHTML = '<tr><td colspan="7" class="adm-empty">当前没有房间</td></tr>';
        return;
      }
      $('roomsBody').innerHTML = r.rooms.map((x) => {
        const buttons = x.phase === 'ended'
          ? `<button class="btn sm ghost" data-room-close="${esc(x.code)}">关闭房间</button>`
          : `<button class="btn sm primary" data-room-end="${esc(x.code)}">结束对局</button>
             <button class="btn sm ghost" data-room-close="${esc(x.code)}">关闭房间</button>`;
        return `<tr>
        <td class="code">${esc(x.code)}</td>
        <td>${esc(PHASE[x.phase] || x.phase)}</td>
        <td>${esc(x.hostName || '—')}</td>
        <td>${x.round ? esc(WIND[x.round.wind] + x.round.num + '局' + x.round.honba + '本场') : '—'}</td>
        <td class="num">${x.hands}</td>
        <td>${x.seats.map((s) => (s.name
          ? esc(s.name) + ' <span class="muted">' + fmtScore(s.score) + '</span>'
          : '<span class="muted">空席</span>')).join(' · ')}</td>
        <td class="nowrap">${buttons}</td>
      </tr>`;
      }).join('');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /** 管理员替房间收尾：对局中 → 结算存档；大厅 → 直接关；已终局 → 补存 */
  async function roomEnd(code) {
    if (!confirm(`结束房间 ${code} 的对局并按当前点数结算？\n结算后会存成一条对局记录。`)) return;
    try {
      const r = await api.adminRoomEnd(code);
      toast(r.message || '已结束', 'ok');
      loadRooms();
      loadOverview();
      loadGames(false);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function roomClose(code) {
    if (!confirm(`关闭房间 ${code}？\n不结算、不存档，5 台设备会立刻退出。`)) return;
    try {
      const r = await api.adminRoomClose(code);
      toast(r.message || '房间已关闭', 'ok');
      loadRooms();
      loadOverview();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* ---------------------------- 交互 ---------------------------- */

  const TABS = { overview: loadOverview, games: () => loadGames(false), players: loadPlayers, rooms: loadRooms };

  function loadAll() {
    loadOverview();
    loadGames(false);
    loadPlayers();
    loadRooms();
  }

  function switchTab(name) {
    document.querySelectorAll('.adm-tabs .tab').forEach((t) => t.classList.toggle('on', t.getAttribute('data-tab') === name));
    for (const k of Object.keys(TABS)) $('tab-' + k).classList.toggle('hidden', k !== name);
    if (TABS[name]) TABS[name]();
  }

  function openPasswd() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:400px">
        <h3>修改管理员密码</h3>
        <div class="field"><label>新密码（至少 4 位）</label><input class="input" id="pwNew" type="password"></div>
        <div class="field"><label>再输一次</label><input class="input" id="pwNew2" type="password"></div>
        <div class="modal-actions">
          <button class="btn ghost" data-x="close">取消</button>
          <button class="btn primary" data-x="ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', async (ev) => {
      const t = ev.target;
      if (t === mask || t.getAttribute('data-x') === 'close') return mask.remove();
      if (t.getAttribute('data-x') !== 'ok') return;
      const a = $('pwNew').value, b = $('pwNew2').value;
      if (a.length < 4) return toast('密码至少 4 位', 'err');
      if (a !== b) return toast('两次输入不一致', 'err');
      try {
        await api.adminPassword(a);
        toast('密码已更新', 'ok');
        mask.remove();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }

  /* ---------------------------- 绑定 ---------------------------- */

  $('btnLogin').onclick = doLogin;
  $('auPass').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  $('auName').onkeydown = (e) => { if (e.key === 'Enter') $('auPass').focus(); };

  document.querySelectorAll('.adm-tabs .tab').forEach((t) => {
    t.onclick = () => switchTab(t.getAttribute('data-tab'));
  });

  $('btnRefresh').onclick = () => { loadAll(); toast('已刷新'); };
  $('btnSearch').onclick = () => loadGames(false);
  $('fq').onkeydown = (e) => { if (e.key === 'Enter') loadGames(false); };
  $('btnReset').onclick = () => { $('fq').value = ''; $('fFrom').value = ''; $('fTo').value = ''; loadGames(false); };
  $('btnMore').onclick = () => { page += 1; loadGames(true); };
  $('btnPasswd').onclick = openPasswd;

  $('btnExport').onclick = () => {
    const tk = Auth.token;
    if (!tk) return toast('请先登录', 'err');
    window.location.href = '/api/admin/export?format=csv&token=' + encodeURIComponent(tk);
  };

  $('btnLogout').onclick = async () => {
    try { await api.logout(); } catch (_) { /* ignore */ }
    Auth.clear();
    me = null;
    $('whoPill').textContent = '未登录';
    $('auPass').value = '';
    show('loginView');
  };

  onAuthLost(() => {
    me = null;
    show('loginView');
    $('loginMsg').textContent = '登录已失效，请重新登录。';
  });

  // 房间表格里的「结束对局 / 关闭房间」是动态渲染的，用事件委托
  $('roomsBody').addEventListener('click', (e) => {
    const endBtn = e.target.closest('[data-room-end]');
    if (endBtn) return roomEnd(endBtn.getAttribute('data-room-end'));
    const closeBtn = e.target.closest('[data-room-close]');
    if (closeBtn) return roomClose(closeBtn.getAttribute('data-room-close'));
  });

  boot();
})();
