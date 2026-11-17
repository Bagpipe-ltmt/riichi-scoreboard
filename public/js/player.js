/* 玩家端 */
(function () {
  'use strict';
  const esc = RC.esc, fmtScore = RC.fmtScore, fmtSigned = RC.fmtSigned;
  const fmtTime = RC.fmtTime, fmtDate = RC.fmtDate, toast = RC.toast;

  const SEAT_WIND = ['东', '南', '西', '北'];
  const SEAT_POS = ['1号位', '2号位', '3号位', '4号位'];

  let me = null;
  let room = null;
  let sub = null;
  let authMode = 'login';

  function windOf(r, seat) {
    if (r.round.dealer === null || r.round.dealer === undefined) return SEAT_WIND[seat];
    return SEAT_WIND[(seat - r.round.dealer + 4) % 4];
  }
  function nameOf(r, seat) { return (r.seats[seat] && r.seats[seat].name) || '空席'; }
  function roundText(r) {
    const W = { E: '东', S: '南', W: '西' };
    return (W[r.round.wind] || '东') + r.round.num + '局';
  }
  function mySeatIndex(r) {
    if (!me) return -1;
    const s = r.seats.find((x) => x.userId === me.id);
    return s ? s.seat : -1;
  }

  function show(id) {
    ['authView', 'entryView', 'roomView', 'resultView'].forEach((v) => {
      document.getElementById(v).classList.toggle('hidden', v !== id);
    });
  }
  function setConn(on, text) {
    const el = document.getElementById('conn');
    el.className = 'conn ' + (on ? 'on' : 'off');
    document.getElementById('connText').textContent = text || (on ? '已连接' : '未连接');
  }

  /* ============================ 启动 ============================ */

  async function boot() {
    RC.onAuthLost(() => {
      // 会话过期 / 服务器换过数据：把用户送回登录界面，别让他对着 403 发呆
      me = null;
      if (sub) { sub.close(); sub = null; }
      room = null;
      localStorage.removeItem('rc_player_room');
      updateTop();
      show('authView');
      toast('登录已失效，请重新登录（用同一个账号登录会回到原来的席位）', 'err');
    });
    bind();
    if (RC.Auth.token) {
      try {
        const r = await RC.api.me();
        me = r.user;
        RC.Auth.setUser(me);
      } catch (_) { me = null; RC.Auth.clear(); }
    }
    updateTop();
    if (!me) { show('authView'); return; }
    // 支持直接带房间号进房：/player?code=1234（可以用二维码发到手机上）
    const qCode = new URLSearchParams(location.search).get('code');
    if (/^\d{4}$/.test(qCode || '')) {
      try {
        const r = await RC.api.room(qCode);
        enterRoom(qCode, r.room);
        return;
      } catch (_) { toast('房间 ' + qCode + ' 不存在或已关闭', 'err'); }
    }
    const saved = localStorage.getItem('rc_player_room');
    if (saved) {
      try {
        const r = await RC.api.room(saved);
        enterRoom(saved, r.room);
        return;
      } catch (_) { localStorage.removeItem('rc_player_room'); }
    }
    openEntry();
  }

  function updateTop() {
    document.getElementById('userPill').textContent = me ? me.name : '未登录';
    document.getElementById('btnLogout').classList.toggle('hidden', !me);
    document.getElementById('btnLeaveRoom').classList.toggle('hidden', !room);
    document.getElementById('roomPill').classList.toggle('hidden', !room);
    if (room) document.getElementById('roomPill').textContent = '房间 ' + room.code;
  }

  /* ============================ 入口 ============================ */

  async function openEntry() {
    if (sub) { sub.close(); sub = null; }
    room = null;
    localStorage.removeItem('rc_player_room');
    updateTop();
    show('entryView');
    setConn(false, '未进入房间');
    loadRooms();
    loadGames();
  }

  async function loadRooms() {
    const box = document.getElementById('roomList');
    try {
      const r = await RC.api.rooms();
      if (!r.rooms.length) { box.innerHTML = '<div class="muted small">附近没有进行中的房间。请让场风盘先创建房间。</div>'; return; }
      box.innerHTML = r.rooms.map((x) => `
        <div class="game-item" data-code="${x.code}" style="cursor:pointer">
          <div class="room-code gold">${x.code}</div>
          <div class="meta">
            <div><b>${x.phase === 'lobby' ? '准备中' : x.phase === 'ended' ? '已终局' : '对局中'}</b>
              <span class="muted small"> · ${x.gameType === 'tonpuusen' ? '东风战' : '半庄战'} · ${x.round} ${x.honba}本场 · ${x.seatsTaken}/4</span></div>
            <div class="muted tiny">${esc(x.players.join('、') || '还没有人入座')}</div>
          </div>
          <span class="btn sm ghost">${x.phase === 'ended' ? '查看' : '进入'}</span>
        </div>`).join('');
      box.querySelectorAll('[data-code]').forEach((el) => el.onclick = () => {
        document.getElementById('joinCode').value = el.dataset.code;
        joinByCode(el.dataset.code);
      });
    } catch (e) { box.innerHTML = '<div class="danger small">' + esc(e.message) + '</div>'; }
  }

  async function loadGames() {
    const box = document.getElementById('gameList');
    if (!me) { box.innerHTML = '<div class="muted small">登录后可查看历史对局。</div>'; return; }
    try {
      const r = await RC.api.myGames();
      if (!r.games.length) { box.innerHTML = '<div class="muted small">还没有历史对局。打满东四局/南四局后会自动保存。</div>'; return; }
      box.innerHTML = r.games.slice(0, 30).map((g) => `
        <div class="game-item" data-gid="${g.id}" style="cursor:pointer">
          <div class="rank rank-${g.me ? g.me.rank : 2}c">${g.me ? g.me.rank + '位' : '—'}</div>
          <div class="meta">
            <div><b class="gold">${g.me && g.me.diff !== null && g.me.diff !== undefined ? fmtSigned(g.me.diff.toFixed(1)) : ''}</b>
              <span class="muted small"> · ${g.config.gameType === 'tonpuusen' ? '东风战' : '半庄战'} · ${esc(g.endReasonText || '')}</span></div>
            <div class="muted tiny">${fmtDate(g.endedAt)} · ${g.hands} 局 · ${esc(g.players.map((p) => p.name).join('、'))}</div>
          </div>
          <span class="btn sm ghost">明细</span>
        </div>`).join('');
      box.querySelectorAll('[data-gid]').forEach((el) => el.onclick = () => showGameDetail(el.dataset.gid));
    } catch (e) { box.innerHTML = '<div class="danger small">' + esc(e.message) + '</div>'; }
  }

  async function joinByCode(code) {
    if (!/^\d{4}$/.test(code)) { toast('请输入 4 位房间号', 'err'); return; }
    try {
      const r = await RC.api.room(code);
      enterRoom(code, r.room);
    } catch (e) { toast(e.message, 'err'); }
  }

  function enterRoom(code, r) {
    room = r;
    localStorage.setItem('rc_player_room', code);
    updateTop();
    show('roomView');
    if (sub) sub.close();
    sub = RC.subscribeRoom(code, (rm, meta) => {
      if (meta && meta.closed) { toast('房间已关闭', 'err'); setTimeout(openEntry, 800); return; }
      if (!rm) { toast('房间已结束', 'err'); setTimeout(openEntry, 800); return; }
      room = rm;
      render();
    }, (on) => setConn(on));
    render();
  }

  /* ============================ 渲染 ============================ */

  function render() {
    if (!room) return;
    if (room.phase === 'ended') { renderResult(); return; }
    show('roomView');
    updateTop();

    document.getElementById('roomPhase').textContent = room.phase === 'lobby' ? '准备中' : '对局进行中';
    document.getElementById('roomRound').textContent = room.phase === 'lobby' ? ('房间 ' + room.code) : (roundText(room) + ' ' + room.round.honba + '本场');
    document.getElementById('roomSub').textContent = room.phase === 'lobby'
      ? `等待入座 ${room.seats.filter((s) => s.userId).length}/4 · 玩家端输入房间号 ${room.code}`
      : `供托 ${room.sticks * 1000} 点 · ${room.config.gameType === 'tonpuusen' ? '东风战' : '半庄战'} · 起家 ${room.starterSeat === null ? '未定' : nameOf(room, room.starterSeat)}`;

    // 我的面板
    const mi = mySeatIndex(room);
    const panel = document.getElementById('myPanel');
    if (mi < 0) {
      panel.innerHTML = `<div class="center muted">你还没有入座${room.phase === 'playing' ? '（对局已开始，无法入座）' : '，请在下方选择一个席位'}</div>`;
    } else {
      const s = room.seats[mi];
      const canRiichi = room.phase === 'playing' && room.round.dealer !== null && s.score >= 1000;
      panel.innerHTML = `
        <div class="my-head">
          <div class="wind-badge ${room.round.dealer === mi ? 'dealer-wind' : ''}">${esc(windOf(room, mi))}</div>
          <div class="grow">
            <div><b>${esc(s.name)}</b> ${room.round.dealer === mi ? '<span class="pill gold">庄家</span>' : ''} ${room.starterSeat === mi ? '<span class="pill">起家</span>' : ''}</div>
            <div class="muted tiny">${SEAT_POS[mi]}${s.wins ? ' · 和了 ' + s.wins + ' 次' : ''}</div>
          </div>
        </div>
        <div class="my-score ${s.score < 0 ? 'danger' : 'gold'}">${fmtScore(s.score)}<span class="small muted"> 点</span></div>
        <button class="riichi-big${s.riichi ? ' on' : ''}" id="btnRiichi" ${canRiichi ? '' : 'disabled'}>
          ${s.riichi ? '立直中 · 点击取消' : '宣　告　立　直'}
        </button>
        <div class="muted tiny center">立直会立刻扣除 1000 点并放入供托；和了时一并收走。</div>`;
      const rb = panel.querySelector('#btnRiichi');
      if (rb) rb.onclick = () => act('riichi', { seat: mi, on: !s.riichi });
    }

    // 座位列表
    document.getElementById('seatList').innerHTML = room.seats.map((s) => {
      const mine = s.userId && me && s.userId === me.id;
      const dealer = room.round.dealer === s.seat;
      return `<div class="join-seat ${mine ? 'mine' : ''} ${s.userId && !mine ? 'taken' : ''}" data-seat="${s.seat}">
        <div class="pos">${SEAT_POS[s.seat]}${room.round.dealer !== null ? ' · ' + windOf(room, s.seat) + '家' : ''}${dealer ? ' · 庄家' : ''}</div>
        <div class="who ${s.userId ? (mine ? 'gold' : '') : 'muted'}">${esc(s.userId ? s.name : '空席')}</div>
        ${s.userId ? `<div class="mono" style="margin-top:4px">${room.phase === 'lobby' ? '已入座' : fmtScore(s.score) + ' 点'}</div>` : ''}
        ${s.userId && s.riichi ? '<div><span class="pill red">立直</span></div>' : ''}
      </div>`;
    }).join('');
    document.querySelectorAll('#seatList [data-seat]').forEach((el) => {
      el.onclick = () => {
        const seat = Number(el.dataset.seat);
        const occupant = room.seats[seat];
        if (occupant.userId && me && occupant.userId === me.id) { leaveSeat(seat); return; }
        if (occupant.userId) { toast('该席位已被占用', 'err'); return; }
        if (room.phase !== 'lobby') { toast('对局已开始，无法入座', 'err'); return; }
        act('join', { seat });
      };
    });

    // 日志
    const logs = room.log.slice().reverse().slice(0, 50);
    document.getElementById('logList').innerHTML = logs.length
      ? logs.map((l) => `<div class="li k-${esc(l.kind)}"><span class="t mono">${fmtTime(l.at)}</span><span>${esc(l.text)}</span></div>`).join('')
      : '<div class="muted small">还没有记录</div>';
  }

  function renderResult() {
    show('resultView');
    const fr = room.finalRanking;
    const REASON = { tobi: '击飞终局', agariyame: '和了终局', final: '打满终局', westLine: '西入·达到基准点', manual: '手动结束' };
    document.getElementById('resTitle').textContent = '终局 — ' + (REASON[room.endReason] || room.endReason || '');
    document.getElementById('resSub').textContent = `${room.config.gameType === 'tonpuusen' ? '东风战' : '半庄战'} · 共 ${room.hands.length} 局`;
    if (fr) {
      const mine = fr.players.find((p) => me && p.userId === me.id);
      document.getElementById('resTable').innerHTML =
        `<table class="result-table"><tr><th>顺位</th><th>玩家</th><th>点数</th><th>收支</th></tr>` +
        fr.players.map((p) => `<tr class="rank-${p.rank}"><td>${p.rank}位</td><td>${esc(p.name)}${p.rank === 1 ? ' 👑' : ''}</td><td class="mono">${fmtScore(p.score)}</td><td class="mono"><b>${fmtSigned((p.diff || 0).toFixed(1))}</b></td></tr>`).join('') +
        '</table>' +
        (mine ? `<div class="center" style="margin-top:10px">你的成绩：<b class="gold">${mine.rank} 位</b> · ${fmtScore(mine.score)} 点 · 收支 <b class="gold">${fmtSigned((mine.diff || 0).toFixed(1))}</b></div>` : '');
    }
    document.getElementById('resHands').innerHTML = room.hands.length ? room.hands.slice().reverse().map((h) => {
      if (h.type === 'agari') return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span><span><b>${esc(h.winnerName)}</b> ${h.tsumo ? '自摸' : '荣和 ' + esc(h.loserName || '')} <span class="pill">${esc(h.label)}</span> +${h.gain}</span></div>`;
      if (h.type === 'draw') return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span><span>${esc(h.drawLabel || '流局')}</span></div>`;
      return '';
    }).join('') : '<div class="muted small">无</div>';
  }

  /* ============================ 操作 ============================ */

  async function act(type, payload) {
    try {
      const map = { join: 'join', leave: 'leave', riichi: 'action' };
      if (type === 'join') {
        const r = await RC.api.join(room.code, payload.seat, me ? me.name : '玩家');
        room = r.room; toast('已入座 ' + SEAT_POS[payload.seat], 'ok');
      } else if (type === 'leave') {
        const r = await RC.api.leave(room.code, payload.seat);
        room = r.room; toast('已离席', 'ok');
      } else {
        const r = await RC.api.action(room.code, type, payload, '');
        if (r.room) room = r.room;
        if (r.message) toast(r.message, 'ok');
      }
      render();
    } catch (e) { toast(e.message, 'err'); }
  }

  function leaveSeat(seat) {
    if (!confirm('离开这个席位？')) return;
    act('leave', { seat });
  }

  async function showGameDetail(id) {
    try {
      const r = await RC.api.game(id);
      const g = r.game;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `<div class="modal">
        <h3>对局明细</h3>
        <div class="muted small" style="margin-bottom:10px">${fmtDate(g.endedAt)} · ${esc(g.endReasonText || '')} · ${g.hands.length} 局</div>
        <table class="result-table">
          <tr><th>顺位</th><th>玩家</th><th>点数</th><th>收支</th></tr>
          ${g.players.map((p) => `<tr class="rank-${p.rank}"><td>${p.rank}位</td><td>${esc(p.name)}</td><td class="mono">${fmtScore(p.score)}</td><td class="mono"><b>${fmtSigned((p.diff || 0).toFixed(1))}</b></td></tr>`).join('')}
        </table>
        <h3 style="margin:16px 0 6px;font-size:15px">每一局</h3>
        ${g.hands.map((h) => {
          if (h.type === 'agari') return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span><span><b>${esc(h.winnerName)}</b> ${h.tsumo ? '自摸' : '荣和 ' + esc(h.loserName || '')} <span class="pill">${esc(h.label)}</span> ${h.han}番${h.fu}符 +${h.gain}</span></div>`;
          if (h.type === 'draw') return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span><span>${esc(h.drawLabel || '流局')}</span></div>`;
          if (h.type === 'manual') return `<div class="hand-item"><span class="r mono">—</span><span>手动修正点数</span></div>`;
          return '';
        }).join('') || '<div class="muted small">无</div>'}
        <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
      </div>`;
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => { if (e.target === mask || e.target.hasAttribute('data-close')) mask.remove(); });
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ============================ 绑定 ============================ */

  function bind() {
    document.getElementById('btnLogin').onclick = async () => {
      const name = document.getElementById('auName').value.trim();
      const password = document.getElementById('auPass').value;
      try {
        const r = await RC.api.login(name, password);
        RC.Auth.set(r.token, r.user); me = r.user;
        toast('欢迎回来，' + me.name, 'ok');
        boot2();
      } catch (e) { toast(e.message, 'err'); }
    };

    document.getElementById('btnRegister').onclick = async () => {
      const name = document.getElementById('auName').value.trim();
      const password = document.getElementById('auPass').value;
      try {
        const r = await RC.api.register(name, password);
        RC.Auth.set(r.token, r.user); me = r.user;
        toast('注册成功，' + me.name, 'ok');
        boot2();
      } catch (e) { toast(e.message, 'err'); }
    };

    document.getElementById('btnGuest').onclick = async () => {
      const name = document.getElementById('auName').value.trim();
      try {
        const r = await RC.api.guest(name);
        RC.Auth.set(r.token, r.user); me = r.user;
        toast('游客身份：' + me.name, 'ok');
        boot2();
      } catch (e) { toast(e.message, 'err'); }
    };

    document.getElementById('btnLogout').onclick = async () => {
      try { await RC.api.logout(); } catch (_) { /* ignore */ }
      RC.Auth.clear(); me = null;
      if (sub) { sub.close(); sub = null; }
      room = null;
      localStorage.removeItem('rc_player_room');
      updateTop(); show('authView');
    };

    document.getElementById('btnJoin').onclick = () => joinByCode(document.getElementById('joinCode').value.trim());
    document.getElementById('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(e.target.value.trim()); });
    document.getElementById('joinCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });

    document.getElementById('btnLeaveRoom').onclick = () => {
      const i = room ? mySeatIndex(room) : -1;
      if (i >= 0 && room.phase === 'lobby') { act('leave', { seat: i }); }
      openEntry();
    };
    document.getElementById('btnBackEntry').onclick = openEntry;

    document.getElementById('auPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btnLogin').click(); });

    window.addEventListener('beforeunload', () => { if (sub) sub.close(); });
  }

  function boot2() {
    updateTop();
    openEntry();
  }

  boot();
})();
