/* 场风盘 */
(function () {
  'use strict';
  const esc = RC.esc, fmtScore = RC.fmtScore, fmtSigned = RC.fmtSigned;
  const fmtTime = RC.fmtTime, fmtDate = RC.fmtDate, dieHtml = RC.dieHtml, toast = RC.toast;

  const SEAT_WIND = ['东', '南', '西', '北'];
  const SEAT_POS = ['1号位', '2号位', '3号位', '4号位'];
  const DRAW_TYPES = {
    exhaustive: '荒牌平局', kyuushu: '九种九牌', fourRiichi: '四家立直',
    tripleRon: '三家和了', fourKan: '四开杠', fourWind: '四风连打',
  };

  let room = null;
  let code = '';
  let hostKey = '';
  let sub = null;
  let lastDiceAt = 0;
  let diceAnimUntil = 0;
  let me = null;              // 本设备登录的场风盘账号
  let canHost = false;        // 本设备是否还有主持权限（由服务器 /whoami 告知）
  let hostWarnReason = '';

  /* ============================ 工具 ============================ */

  function windOf(r, seat) {
    if (r.round.dealer === null || r.round.dealer === undefined) return SEAT_WIND[seat];
    return SEAT_WIND[(seat - r.round.dealer + 4) % 4];
  }
  function isDealer(r, seat) { return r.round.dealer === seat; }
  function nameOf(r, seat) { return (r.seats[seat] && r.seats[seat].name) || '空席'; }
  /** 只在「满贯／跳满／倍满／三倍满／役满」这类牌型名时出徽章，普通牌型不重复番符 */
  function limitPill(h) {
    const plain = h.han + '番' + h.fu + '符';
    return h.label && h.label !== plain ? `<span class="pill">${esc(h.label)}</span> ` : '';
  }
  function isLastRound(r) {
    const c = r.config;
    if (c.gameType === 'tonpuusen') return r.round.wind === 'E' && r.round.num === 4;
    if (c.westExtension) return r.round.wind === 'W' && r.round.num === 4;
    return r.round.wind === 'S' && r.round.num === 4;
  }
  function roundText(r) {
    const W = { E: '东', S: '南', W: '西' };
    return (W[r.round.wind] || '东') + r.round.num + '局';
  }

  function setConn(on) {
    const el = document.getElementById('conn');
    if (!el) return;
    el.className = 'conn ' + (on ? 'on' : 'off');
    document.getElementById('connText').textContent = on ? '已连接' : '重连中…';
  }

  function openModal(html, onMount) {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal">' + html + '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    const m = mask.querySelector('.modal');
    if (onMount) onMount(m);
    return m;
  }
  function closeModal() {
    const m = document.querySelector('.modal-mask');
    if (m) m.remove();
  }

  /* ---- 点数计算（与服务端 lib/scoring.js 保持一致，仅用于即时预览） ---- */
  function limitBase(han) {
    if (han >= 13) return { base: 8000, label: '役满' };
    if (han >= 11) return { base: 6000, label: '三倍满' };
    if (han >= 8) return { base: 4000, label: '倍满' };
    if (han >= 6) return { base: 3000, label: '跳满' };
    if (han >= 5) return { base: 2000, label: '满贯' };
    return null;
  }
  function basicPoints(han, fu, kiriage) {
    const lim = limitBase(han);
    if (lim) return lim;
    const raw = fu * Math.pow(2, 2 + han);
    if (kiriage && ((han === 4 && fu === 30) || (han === 3 && fu === 60))) return { base: 2000, label: '满贯' };
    if (raw > 2000) return { base: 2000, label: '满贯' };
    return { base: raw, label: null };
  }
  function ceil100(n) { return Math.ceil(n / 100) * 100; }
  function preview(k) {
    const bp = basicPoints(k.han, k.fu, room.config.kiriageMangan);
    const base = bp.base;
    const sums = [0, 0, 0, 0];
    if (k.tsumo) {
      if (k.winnerSeat === k.dealerSeat) {
        const a = ceil100(base * 2);
        for (let i = 0; i < 4; i++) if (i !== k.winnerSeat) { sums[i] -= a; sums[k.winnerSeat] += a; }
      } else {
        const d = ceil100(base * 2), c = ceil100(base);
        for (let i = 0; i < 4; i++) if (i !== k.winnerSeat) {
          const a = i === k.dealerSeat ? d : c;
          sums[i] -= a; sums[k.winnerSeat] += a;
        }
      }
    } else {
      const a = ceil100(base * (k.loserSeat === k.dealerSeat ? 6 : 4));
      sums[k.loserSeat] -= a; sums[k.winnerSeat] += a;
    }
    const honbaPer = k.tsumo ? 100 : 300;
    if (k.honba) for (let i = 0; i < 4; i++) if (i !== k.winnerSeat) { sums[i] -= honbaPer; sums[k.winnerSeat] += honbaPer; }
    let total = sums[k.winnerSeat];
    const parts = [];
    for (let i = 0; i < 4; i++) if (sums[i] < 0) parts.push({ from: i, amount: -sums[i] });
    return { sums, parts, total, label: bp.label, base };
  }

  /* ============================ 启动 ============================ */

  async function boot() {
    RC.onAuthLost((msg) => {
      me = null; canHost = false; hostWarnReason = msg || '登录已失效';
      renderHostWarn();
      toast('场风盘登录已失效，请重新登录', 'err');
    });
    bindGlobal();
    // 先确认这台设备还登录着：没登录也能打开房间界面（GET 房间是公开接口），
    // 但那样所有计分操作都会 403，用户只会看到一句莫名其妙的报错。
    if (RC.Auth.token) {
      try { const m = await RC.api.me(); me = m.user; RC.Auth.setUser(me); } catch (_) { me = null; }
    }
    const q = RC.qs('code') || localStorage.getItem('rc_table_code') || '';
    if (q) {
      try {
        const r = await RC.api.room(q);
        hostKey = localStorage.getItem('rc_host_' + q) || '';
        enterRoom(q, r.room);
        return;
      } catch (_) {
        localStorage.removeItem('rc_table_code');
      }
    }
    show('createView');
  }

  /** 问服务器「本设备还有没有主持权限」，没有就亮出恢复登录的横幅 */
  async function checkHost() {
    if (!code) { canHost = false; renderHostWarn(); return; }
    try {
      const r = await RC.api.whoami(code, hostKey);
      canHost = !!r.isHost;
      hostWarnReason = canHost ? ''
        : (r.tokenExpired || !me
          ? '这台设备没有有效的场风盘登录。用当初建房的账号登录即可恢复全部计分权限（房间号和玩家都不用动）。'
          : `当前登录的是「${me.name}」，不是建房的那个账号，所以不能计分。请换回场风盘账号登录。`);
    } catch (_) {
      canHost = false;
      hostWarnReason = '无法确认本设备的主持权限，请检查网络后重试。';
    }
    renderHostWarn();
  }

  function renderHostWarn() {
    const el = document.getElementById('hostWarn');
    if (!el) return;
    const showIt = !!code && !canHost;
    el.classList.toggle('hidden', !showIt);
    if (!showIt) return;
    const msg = document.getElementById('hostWarnMsg');
    if (msg) msg.textContent = hostWarnReason || '这台设备没有场风盘权限。';
    document.querySelectorAll('#hostWarn .btn, #hostWarn .input').forEach((b) => { b.disabled = false; });
    const n = document.getElementById('hwName');
    if (n && !n.value && me) n.value = me.name || '';
  }

  async function hostWarnLogin() {
    const name = document.getElementById('hwName').value.trim();
    const pass = document.getElementById('hwPass').value;
    const btn = document.getElementById('btnHwLogin');
    if (!name || !pass) { toast('请输入场风盘昵称和密码', 'err'); return; }
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const r = await RC.api.login(name, pass);
      RC.Auth.set(r.token, r.user);
      me = r.user;
      toast(`已登录：${me.name}`, 'ok');
      document.getElementById('hwPass').value = '';
      await checkHost();
      if (!canHost) toast('这个账号不是本房间的房主，仍无法计分', 'err');
    } catch (e) {
      toast(e.message || '登录失败', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '登录，恢复主持权限';
    }
  }

  function enterRoom(c, r) {
    code = c;
    room = r;
    localStorage.setItem('rc_table_code', c);
    document.getElementById('roomPill').textContent = '房间 ' + c;
    document.getElementById('btnClose').classList.remove('hidden');
    if (sub) sub.close();
    sub = RC.subscribeRoom(code, (rm, meta) => {
      if (meta && meta.closed) { toast('房间已关闭', 'err'); setTimeout(() => location.href = '/table', 900); return; }
      if (!rm) { toast('房间已不存在', 'err'); localStorage.removeItem('rc_table_code'); setTimeout(() => location.href = '/table', 900); return; }
      room = rm;
      render();
    }, setConn);
    render();
    checkHost();
  }

  function show(id) {
    ['createView', 'lobbyView', 'playView', 'endView'].forEach((v) => {
      document.getElementById(v).classList.toggle('hidden', v !== id);
    });
  }

  /* ============================ 渲染 ============================ */
  function render() {
    if (!room) return;
    document.getElementById('roomPill').textContent = '房间 ' + room.code;
    const phaseText = room.phase === 'lobby' ? '准备中' : room.phase === 'playing' ? (roundText(room) + ' ' + room.round.honba + '本场') : '已终局';
    document.getElementById('phasePill').textContent = phaseText;

    if (room.phase === 'lobby') { show('lobbyView'); renderLobby(); }
    else if (room.phase === 'playing') { show('playView'); renderPlay(); }
    else { show('endView'); renderEnd(); }
  }

  /* ---- 大厅 ---- */
  function renderLobby() {
    document.getElementById('lobbyCode').textContent = room.code;
    const taken = room.seats.filter((s) => s.userId).length;
    document.getElementById('lobbyHint').innerHTML = (taken === 4
      ? '4 位玩家已就座，可以开始了'
      : `等待玩家入座…（${taken}/4）。玩家端输入房间号 <b>${esc(room.code)}</b> 后选择席位。`)
      + `<div class="muted tiny" style="margin-top:8px">手机也可以直接打开 <span class="mono">${esc(location.origin)}/player?code=${esc(room.code)}</span> 进房</div>`;

    const c = room.config;
    document.getElementById('lobbyRules').innerHTML = [
      ['对局形式', c.gameType === 'tonpuusen' ? '东风战（东四局）' : '半庄战（南四局）'],
      ['起始点数', fmtScore(c.startScore)],
      ['终局条件', [c.tobi ? '击飞' : null, c.agariYame ? '和了终局' : null, c.westExtension ? '西入' : null].filter(Boolean).join('·') || '打满'],
      ['其他', [c.kiriageMangan ? '切上满贯' : null, c.notenBappu ? '不听罚符' : '不听不罚', c.yakitori ? '烧鸟' : null].filter(Boolean).join('·')],
    ].map((r) => `<div class="stat"><div class="k">${esc(r[0])}</div><div class="v">${esc(r[1])}</div></div>`).join('');

    const meId = me && me.id;
    document.getElementById('lobbySeats').innerHTML = room.seats.map((s) => {
      const mine = !!(s.userId && meId && s.userId === meId);
      // 空席点一下就能自己入座：以前场风盘建完房没人能坐 1 号位，
      // 「开始对局」永远是灰的，整间房就卡在大厅里开不了也结束不了。
      const cls = s.userId ? ('join-seat' + (mine ? ' mine' : '')) : 'join-seat free';
      const who = s.userId
        ? esc(s.name) + (mine ? ' <span class="tiny muted">（本机）</span>' : '')
        : (meId ? '空席 · 点这里入座' : '空席');
      return `<div class="${cls}" data-seat="${s.seat}"${s.userId ? '' : ' data-sit="1"'}>
        <div class="pos">${SEAT_POS[s.seat]}</div>
        <div class="who ${s.userId ? 'gold' : 'muted'}">${who}</div>
        ${s.userId ? '<button class="btn sm ghost kick" data-seat="' + s.seat + '" style="margin-top:8px">移除</button>' : ''}
      </div>`;
    }).join('');

    document.getElementById('btnStart').disabled = taken !== 4;
  }

  /** 大厅里点空席 = 用当前登录的场风盘账号坐下去 */
  async function sitSeat(seat) {
    if (!me) { toast('请先用场风盘账号登录，再点席位入座', 'err'); return; }
    try {
      const r = await RC.api.join(room.code, seat);
      if (r && r.room) room = r.room;
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* ---- 对局中 ---- */
  function renderPlay() {
    const r = room;
    for (let i = 0; i < 4; i++) renderSeat(i);
    renderCenter();

    document.getElementById('btnUndo').disabled = !r.canUndo;
    document.getElementById('btnAgari').disabled = r.round.dealer === null;
    document.getElementById('btnDraw').disabled = r.round.dealer === null;

    const logs = r.log.slice().reverse().slice(0, 60);
    document.getElementById('logList').innerHTML = logs.length
      ? logs.map((l) => `<div class="li k-${esc(l.kind)}"><span class="t mono">${fmtTime(l.at)}</span><span>${esc(l.text)}</span></div>`).join('')
      : '<div class="muted small">还没有记录</div>';
  }

  function renderSeat(seat) {
    const r = room;
    const s = r.seats[seat];
    const el = document.getElementById('seatArea' + seat);
    const wind = windOf(r, seat);
    const dealer = isDealer(r, seat);
    const diceDecided = r.round.dealer !== null;

    el.className = 'seat-card seat-' + ['bottom', 'right', 'top', 'left'][seat]
      + (dealer && diceDecided ? ' dealer' : '') + (s.riichi ? ' riichi' : '') + (s.userId ? '' : ' empty');

    const tags = [];
    if (dealer && diceDecided) tags.push('<span class="pill gold">庄家</span>');
    if (s.userId && r.starterSeat === seat) tags.push('<span class="pill">起家</span>');
    if (s.riichi) tags.push('<span class="pill red">立直 −1000</span>');
    if (s.wins) tags.push('<span class="pill green">和了 ' + s.wins + '</span>');

    el.innerHTML = `
      <div class="seat-head">
        <div class="wind-badge${dealer && diceDecided ? ' dealer-wind' : ''}">${esc(wind)}</div>
        <div style="min-width:0;flex:1 1 auto">
          <div class="seat-name">${esc(s.userId ? s.name : '空席')}</div>
          <div class="muted tiny">${SEAT_POS[seat]}${s.userId ? '' : ' · 等待入座'}</div>
        </div>
      </div>
      <div class="seat-score ${s.score < 0 ? 'neg' : ''}" style="margin-top:6px">${fmtScore(s.score)}<small> 点</small></div>
      <div class="seat-tags">${tags.join('')}</div>
      <div class="seat-actions">
        <button class="riichi-btn${s.riichi ? ' on' : ''}" data-riichi="${seat}" ${s.userId ? '' : 'disabled'}>
          ${s.riichi ? '立直中 · 取消' : '立　直'}
        </button>
      </div>`;
  }

  function renderCenter() {
    const r = room;
    const d = r.round.dice;
    const rolling = Date.now() < diceAnimUntil;
    const diceHtml2 = d
      ? `<div class="dice-box">${dieHtml(d.d1, rolling)}${dieHtml(d.d2, rolling)}</div>
         <div class="muted small">${d.d1} + ${d.d2} = <b class="gold">${d.sum}</b>${d.decided ? ' · 已定起家' : ''}</div>`
      : '<div class="muted small">尚未掷骰子</div>';

    const starter = r.starterSeat === null || r.starterSeat === undefined
      ? '<span class="muted">起家：未定</span>'
      : `起家（东1局庄家）：<b class="gold">${esc(nameOf(r, r.starterSeat))}</b> <span class="muted tiny">${SEAT_POS[r.starterSeat]}</span>`;

    document.getElementById('centerPanel').innerHTML = `
      <div class="round-label gold">${esc(roundText(r))}</div>
      <div class="round-sub">${r.round.honba} 本场 · 供托 ${r.sticks * 1000} 点</div>
      ${diceHtml2}
      <div class="small">${starter}</div>
      <div class="row" style="width:100%;margin-top:6px">
        <button class="btn sm ghost" id="btnStarter">手动定起家</button>
      </div>`;
  }

  /* ---- 结算 ---- */
  function renderEnd() {
    const r = room;
    const fr = r.finalRanking;
    const REASON = { tobi: '击飞终局', agariyame: '和了终局', final: '打满终局', westLine: '西入·达到基准点', manual: '手动结束' };
    document.getElementById('endTitle').textContent = '终局 — ' + (REASON[r.endReason] || r.endReason || '');
    document.getElementById('endSub').textContent = `${r.config.gameType === 'tonpuusen' ? '东风战' : '半庄战'} · 共 ${r.hands.length} 局 · ${fmtDate(r.endedAt)}`;
    document.getElementById('endSaved').textContent = r.savedGameId ? ('对局记录已存入玩家账号（ID ' + r.savedGameId + '）') : '';

    if (!fr) { document.getElementById('endTable').innerHTML = '<div class="muted">无结算数据</div>'; }
    else {
      const head = '<tr><th>顺位</th><th>玩家</th><th>点数</th><th>收支</th></tr>';
      const rows = fr.players.map((p) => `
        <tr class="rank-${p.rank}">
          <td>${p.rank}位</td>
          <td>${esc(p.name)}${p.starter ? ' <span class="pill tiny">起家</span>' : ''}</td>
          <td class="mono">${fmtScore(p.score)}</td>
          <td class="mono"><b>${fmtSigned((p.diff || 0).toFixed(1))}</b></td>
        </tr>`).join('');
      document.getElementById('endTable').innerHTML = '<table class="result-table">' + head + rows + '</table>'
        + `<div class="muted tiny" style="margin-top:8px">收支 = (点数 − 起始点数) ÷ 1000${fr.yakitori ? ' ± 烧鸟' : ''}</div>`;
    }

    document.getElementById('endHands').innerHTML = r.hands.length ? r.hands.map((h) => {
      if (h.type === 'agari') {
        return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span>
          <span><b class="gold">${esc(h.winnerName)}</b>（${esc(h.winnerWind)}家）${h.tsumo ? '自摸' : '荣和 ' + esc(h.loserName || '')}
          ${limitPill(h)}${h.han}番${h.fu}符 <b>+${h.gain}</b>${h.stickGain ? ' +供托' + h.stickGain : ''}</span></div>`;
      }
      if (h.type === 'draw') {
        const tps = (h.tenpai || []).map((v, i) => (v ? nameOf(r, i) : null)).filter(Boolean);
        const tp = tps.join('、');
        const nT = tps.length;
        const bappu = (h.bappuTotal && nT > 0 && nT < 4)
          ? ` ｜不听者各 −${h.bappuTotal / (4 - nT)}，听牌者各 +${h.bappuTotal / nT}`
          : '';
        return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span>
          <span>${esc(h.drawLabel || '')} ｜听牌：${esc(tp || '无')}${bappu} ｜庄家${h.renchan ? '连庄' : '下庄'}</span></div>`;
      }
      return '';
    }).join('') : '<div class="muted small">本场没有打完任何一局</div>';
  }

  /* ============================ 操作 ============================ */

  async function act(type, payload) {
    if (!room) return;
    try {
      const r = await RC.api.action(room.code, type, payload || {}, hostKey);
      if (r.room) { room = r.room; }
      if (r.message) toast(r.message, 'ok');
      closeModal();
      render();
    } catch (e) {
      toast(e.message, 'err');
      // 是权限问题就顺手刷新横幅，把「登录恢复权限」的入口摆出来
      if (e.code === 'NOT_HOST' || e.code === 'NO_SESSION' || e.status === 403) checkHost();
    }
  }

  /* ---- 和了 ---- */
  function openAgari() {
    const r = room;
    const ag = {
      winnerSeat: null, tsumo: true, loserSeat: null, han: 1, fu: 30,
    };
    const m = openModal('<h3>和了</h3><div id="agBody"></div>', (modal) => {
      const body = modal.querySelector('#agBody');
      const draw = () => {
        const seats = r.seats.map((s) => ({ s, on: ag.winnerSeat === s.seat }));
        const okReady = ag.winnerSeat !== null && (ag.tsumo || (ag.loserSeat !== null && ag.loserSeat !== ag.winnerSeat));
        let pv = null;
        if (okReady) pv = preview({ ...ag, dealerSeat: r.round.dealer, honba: r.round.honba });

        body.innerHTML = `
          <div class="field"><label>和了者</label>
            <div class="seg">${seats.map((x) => `<div class="opt${x.on ? ' on' : ''}" data-w="${x.s.seat}" ${x.s.userId ? '' : 'style="opacity:.35;pointer-events:none"'}>${esc(windOf(r, x.s.seat))}<br><span class="tiny">${esc(nameOf(r, x.s.seat))}</span></div>`).join('')}</div>
          </div>
          <div class="field"><label>和了方式</label>
            <div class="seg">
              <div class="opt${ag.tsumo ? ' on' : ''}" data-t="1">自摸</div>
              <div class="opt${ag.tsumo ? '' : ' on'}" data-t="0">荣和</div>
            </div>
          </div>
          <div class="field ${ag.tsumo ? 'hidden' : ''}" id="loserField"><label>放铳者</label>
            <div class="seg">${r.seats.map((s) => `<div class="opt${ag.loserSeat === s.seat ? ' on' : ''}${s.seat === ag.winnerSeat ? ' red' : ''}" data-l="${s.seat}" ${(!s.userId || s.seat === ag.winnerSeat) ? 'style="opacity:.35;pointer-events:none"' : ''}>${esc(windOf(r, s.seat))}<br><span class="tiny">${esc(nameOf(r, s.seat))}</span></div>`).join('')}</div>
          </div>
          <div class="field"><label>番数</label>
            <div class="seg" style="margin-bottom:8px">${[1,2,3,4,5,6,7,8,9,10,11,12,13].map((h) => `<div class="opt${ag.han === h ? ' on' : ''}" data-h="${h}" style="min-width:44px;min-height:40px">${h}</div>`).join('')}</div>
            <input class="input mono" id="agHan" type="number" min="1" max="13" value="${ag.han}">
          </div>
          <div class="field"><label>符数</label>
            <div class="seg">${[20,25,30,40,50,60,70,80,90,100,110].map((f) => `<div class="opt${ag.fu === f ? ' on' : ''}" data-f="${f}" style="min-width:52px;min-height:40px">${f}</div>`).join('')}</div>
          </div>
          <div class="card" id="agPv" style="background:rgba(0,0,0,.25)"></div>
          <div class="modal-actions">
            <button class="btn ghost" data-x="cancel">取消</button>
            <button class="btn gold" id="agOk" ${okReady ? '' : 'disabled'}>确认和了</button>
          </div>`;

        const pvBox = body.querySelector('#agPv');
        if (!okReady) pvBox.innerHTML = '<div class="muted small">请选择和了者' + (ag.tsumo ? '' : '与放铳者') + '</div>';
        else {
          const seq = ag.tsumo
            ? pv.parts.map((p) => `${esc(nameOf(r, p.from))} ${p.amount}`).join(' + ') + ' 全自摸'
            : `${esc(nameOf(r, pv.parts[0].from))} 放铳 ${pv.parts[0].amount}`;
          pvBox.innerHTML = `<div class="row" style="align-items:baseline">
              <div class="grow"><span class="pill gold">${esc(pv.label || (ag.han + '番' + ag.fu + '符'))}</span>
              <span class="muted small" style="margin-left:6px">${ag.han}番 ${ag.fu}符</span></div>
              <div class="big gold mono">+${pv.total + r.sticks * 1000}</div>
            </div>
            <div class="muted small" style="margin-top:6px">${seq}${r.round.honba ? ' ｜ 本场 ' + r.round.honba : ''}${r.sticks ? ' ｜ 供托 ' + r.sticks * 1000 : ''}</div>`;
        }

        body.querySelectorAll('[data-w]').forEach((el) => el.onclick = () => { ag.winnerSeat = Number(el.dataset.w); if (ag.loserSeat === ag.winnerSeat) ag.loserSeat = null; draw(); });
        body.querySelectorAll('[data-t]').forEach((el) => el.onclick = () => { ag.tsumo = el.dataset.t === '1'; draw(); });
        body.querySelectorAll('[data-l]').forEach((el) => el.onclick = () => { ag.loserSeat = Number(el.dataset.l); draw(); });
        body.querySelectorAll('[data-h]').forEach((el) => el.onclick = () => { ag.han = Number(el.dataset.h); draw(); });
        body.querySelectorAll('[data-f]').forEach((el) => el.onclick = () => { ag.fu = Number(el.dataset.f); draw(); });
        const hanInput = body.querySelector('#agHan');
        hanInput.onchange = () => { ag.han = Math.max(1, Math.min(13, Number(hanInput.value) || 1)); draw(); };
        const ok = body.querySelector('#agOk');
        if (ok) ok.onclick = () => act('agari', { winnerSeat: ag.winnerSeat, tsumo: ag.tsumo, loserSeat: ag.tsumo ? null : ag.loserSeat, han: ag.han, fu: ag.fu });
        const cx = body.querySelector('[data-x="cancel"]');
        if (cx) cx.onclick = closeModal;
      };
      draw();
    });
    return m;
  }

  /* ---- 流局 ---- */
  function openDraw() {
    const r = room;
    const dr = { type: 'exhaustive', tenpai: [false, false, false, false] };
    openModal('<h3>流局</h3><div id="drBody"></div>', (modal) => {
      const body = modal.querySelector('#drBody');
      const draw = () => {
        body.innerHTML = `
          <div class="field"><label>流局种类</label>
            <div class="seg">${Object.keys(DRAW_TYPES).map((k) => `<div class="opt wide${dr.type === k ? ' on' : ''}" data-d="${k}">${DRAW_TYPES[k]}</div>`).join('')}</div>
          </div>
          <div class="field ${dr.type === 'exhaustive' ? '' : 'hidden'}"><label>听牌者（${dr.type === 'exhaustive' ? '不听者合计支付 3000 点' : '仅作记录'}）</label>
            <div class="seg">${r.seats.map((s) => `<div class="opt${dr.tenpai[s.seat] ? ' on' : ''}" data-n="${s.seat}">${esc(windOf(r, s.seat))}<br><span class="tiny">${esc(nameOf(r, s.seat))}</span><br><span class="tiny">${dr.tenpai[s.seat] ? '听牌' : '不听'}</span></div>`).join('')}</div>
          </div>
          <div class="card" style="background:rgba(0,0,0,.25)">
            <div class="small">${dr.type === 'exhaustive'
              ? (() => {
                const nT = dr.tenpai.filter(Boolean).length;
                const nN = 4 - nT;
                const dealer = dr.tenpai[r.round.dealer] ? '庄家听牌 → 连庄' : '庄家不听 → 下庄';
                if (nT === 0 || nT === 4) return '全员同状态 → 无罚符收支 ｜ ' + dealer;
                // 罚符池固定 3000：不听者按人数分担，听牌者按人数平分（nN、nT ∈ {1,2,3}，恒整除）
                return `不听者 ${nN} 人各 −${3000 / nN}，听牌者 ${nT} 人各 +${3000 / nT} ｜ ` + dealer;
              })()
              : '途中流局 → 庄家连庄，本场 +1，不计不听罚符'}</div>
          </div>
          <div class="modal-actions">
            <button class="btn ghost" data-x="cancel">取消</button>
            <button class="btn gold" id="drOk">确认流局</button>
          </div>`;
        body.querySelectorAll('[data-d]').forEach((el) => el.onclick = () => { dr.type = el.dataset.d; draw(); });
        body.querySelectorAll('[data-n]').forEach((el) => el.onclick = () => { const i = Number(el.dataset.n); dr.tenpai[i] = !dr.tenpai[i]; draw(); });
        body.querySelector('#drOk').onclick = () => act('draw', { type: dr.type, tenpai: dr.tenpai });
        body.querySelector('[data-x="cancel"]').onclick = closeModal;
      };
      draw();
    });
  }

  /* ---- 点数修正 ---- */
  function openAdjust() {
    const r = room;
    openModal(`<h3>点数修正</h3>
      <div class="muted small" style="margin-bottom:12px">直接输入四家当前的点数总和需为 ${fmtScore(4 * r.config.startScore)}（仅作提醒，不会强制校验）。</div>
      <div id="adjBody"></div>
      <div class="modal-actions">
        <button class="btn ghost" data-x="cancel">取消</button>
        <button class="btn gold" id="adjOk">保存</button>
      </div>`, (modal) => {
      const body = modal.querySelector('#adjBody');
      body.innerHTML = r.seats.map((s) => `
        <div class="field"><label>${esc(windOf(r, s.seat))}家 · ${esc(nameOf(r, s.seat))}</label>
        <input class="input mono" data-a="${s.seat}" type="number" step="100" value="${s.score}"></div>`).join('');
      modal.querySelector('[data-x="cancel"]').onclick = closeModal;
      modal.querySelector('#adjOk').onclick = () => {
        const vals = [0, 1, 2, 3].map((i) => Number(body.querySelector('[data-a="' + i + '"]').value) || 0);
        act('adjust', { scores: vals });
      };
    });
  }

  /* ---- 本场数 ---- */
  function openHonba() {
    const r = room;
    openModal(`<h3>本场数</h3>
      <div class="seg" style="margin-bottom:12px">${[0, 1, 2, 3, 4, 5].map((n) => `<div class="opt${r.round.honba === n ? ' on' : ''}" data-b="${n}">${n}</div>`).join('')}</div>
      <input class="input mono" id="honbaVal" type="number" min="0" max="99" value="${r.round.honba}">
      <div class="modal-actions">
        <button class="btn ghost" data-x="cancel">取消</button>
        <button class="btn gold" id="honbaOk">保存</button>
      </div>`, (modal) => {
      const inp = modal.querySelector('#honbaVal');
      modal.querySelectorAll('[data-b]').forEach((el) => el.onclick = () => { inp.value = el.dataset.b; });
      modal.querySelector('[data-x="cancel"]').onclick = closeModal;
      modal.querySelector('#honbaOk').onclick = () => act('honba', { honba: Number(inp.value) || 0 });
    });
  }

  /* ---- 手动定起家 ---- */
  function openStarter() {
    const r = room;
    openModal('<h3>手动指定起家</h3><div class="muted small" style="margin-bottom:12px">正式流程请掷骰子；此处仅在需要时手动纠正。</div>' +
      '<div class="seg">' + r.seats.map((s) => `<div class="opt" data-s="${s.seat}">${SEAT_POS[s.seat]}<br><span class="tiny">${esc(nameOf(r, s.seat))}</span></div>`).join('') + '</div>' +
      '<div class="modal-actions"><button class="btn ghost" data-x="cancel">取消</button><button class="btn gold" id="stOk" disabled>确定</button></div>',
      (modal) => {
        let pick = null;
        modal.querySelectorAll('[data-s]').forEach((el) => el.onclick = () => {
          pick = Number(el.dataset.s);
          modal.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('on', x === el));
          modal.querySelector('#stOk').disabled = false;
        });
        modal.querySelector('[data-x="cancel"]').onclick = closeModal;
        modal.querySelector('#stOk').onclick = () => { if (pick !== null) act('setStarter', { seat: pick }); };
      });
  }

  /* ---- 规则 ---- */
  function openRules(editable) {
    const c = room ? room.config : {};
    openModal(`<h3>${editable ? '对局规则' : '当前规则'}</h3>
      <div class="field"><label>对局形式</label>
        <div class="seg" id="rType">
          <div class="opt wide${c.gameType === 'tonpuusen' ? ' on' : ''}" data-v="tonpuusen">东风战（东四局）</div>
          <div class="opt wide${c.gameType !== 'tonpuusen' ? ' on' : ''}" data-v="hanchan">半庄战（南四局）</div>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>起始点数</label><input class="input mono" id="rStart" type="number" value="${c.startScore || 25000}"></div>
      </div>
      <div class="field"><label>其他</label>
        <div class="seg" id="rToggles">
          ${[['kiriageMangan', '切上满贯'], ['agariYame', '和了终局'], ['tobi', '击飞终局'], ['notenBappu', '不听罚符'], ['westExtension', '西入'], ['yakitori', '烧鸟']]
            .map(([k, label]) => `<div class="opt wide${c[k] ? ' on' : ''}" data-k="${k}">${label}</div>`).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" data-x="cancel">${editable ? '取消' : '关闭'}</button>
        ${editable ? '<button class="btn gold" id="rOk">保存规则</button>' : ''}
      </div>`, (modal) => {
      if (!editable) {
        modal.querySelector('#rStart').disabled = true;
        modal.querySelectorAll('#rType .opt, #rToggles .opt').forEach((el) => { el.style.pointerEvents = 'none'; });
      }
      modal.querySelector('[data-x="cancel"]').onclick = closeModal;
      modal.querySelectorAll('#rType .opt').forEach((el) => el.onclick = () => { modal.querySelectorAll('#rType .opt').forEach((x) => x.classList.toggle('on', x === el)); });
      modal.querySelectorAll('#rToggles .opt').forEach((el) => el.onclick = () => el.classList.toggle('on'));
      const ok = modal.querySelector('#rOk');
      if (ok) ok.onclick = () => {
        const cfg = {
          gameType: modal.querySelector('#rType .opt.on').dataset.v,
          startScore: Number(modal.querySelector('#rStart').value) || 25000,
        };
        modal.querySelectorAll('#rToggles .opt').forEach((el) => { cfg[el.dataset.k] = el.classList.contains('on'); });
        act('config', { config: cfg });
      };
    });
  }

  /* ---- 历史存档 ---- */
  async function openHistory() {
    openModal('<h3>本房间的历史对局</h3><div id="hisBody"><div class="muted">读取中…</div></div>' +
      '<div class="modal-actions"><button class="btn ghost" data-x="cancel">关闭</button></div>', (modal) => {
      modal.querySelector('[data-x="cancel"]').onclick = closeModal;
    });
    try {
      const r = await RC.req('/api/rooms/' + room.code + '/games');
      const body = document.getElementById('hisBody');
      if (!body) return;
      if (!r.games.length) { body.innerHTML = '<div class="muted small">还没有已保存的对局记录。打满东四局/南四局（或击飞、和了终局）后会自动保存。</div>'; return; }
      body.innerHTML = r.games.map((g) => `
        <div class="card" style="margin-bottom:10px;background:rgba(0,0,0,.2)">
          <div class="row" style="align-items:baseline">
            <div class="grow"><b>${esc(g.config.gameType === 'tonpuusen' ? '东风战' : '半庄战')}</b>
              <span class="muted small"> · ${esc(g.endReasonText || '')} · ${fmtDate(g.endedAt)}</span></div>
            <button class="btn sm ghost" data-open="${g.id}">明细</button>
          </div>
          <table class="result-table" style="margin-top:6px">
            <tr><th>顺位</th><th>玩家</th><th>点数</th><th>收支</th></tr>
            ${g.players.map((p) => `<tr class="rank-${p.rank}"><td>${p.rank}位</td><td>${esc(p.name)}</td><td class="mono">${fmtScore(p.score)}</td><td class="mono">${fmtSigned((p.diff || 0).toFixed(1))}</td></tr>`).join('')}
          </table>
        </div>`).join('');
      body.querySelectorAll('[data-open]').forEach((el) => el.onclick = () => showGameDetail(el.dataset.open));
    } catch (e) {
      toast(e.message, 'err');
      closeModal();
    }
  }

  async function showGameDetail(id) {
    try {
      const r = await RC.api.game(id);
      const g = r.game;
      openModal(`<h3>对局明细</h3>
        <div class="muted small" style="margin-bottom:10px">${fmtDate(g.endedAt)} · ${esc(g.endReasonText || '')} · ${g.hands.length} 局</div>
        <div class="hand-list">${g.hands.map((h) => {
          if (h.type === 'agari') return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span><span><b>${esc(h.winnerName)}</b> ${h.tsumo ? '自摸' : '荣和 ' + esc(h.loserName || '')} ${limitPill(h)}${h.han}番${h.fu}符 +${h.gain}</span></div>`;
          if (h.type === 'draw') return `<div class="hand-item"><span class="r mono">${esc(h.round)}${h.honba}本场</span><span>${esc(h.drawLabel || '流局')}</span></div>`;
          if (h.type === 'manual') return `<div class="hand-item"><span class="r mono">—</span><span>手动修正点数</span></div>`;
          return '';
        }).join('')}</div>
        <div class="modal-actions"><button class="btn ghost" data-x="cancel">关闭</button></div>`, (modal) => {
        modal.querySelector('[data-x="cancel"]').onclick = closeModal;
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ============================ 事件绑定 ============================ */

  function bindGlobal() {
    const cfg = { gameType: 'hanchan', kiriageMangan: true, agariYame: true, tobi: true, notenBappu: true, westExtension: false, yakitori: false };

    function refreshCreateSegs(root) {
      root.querySelectorAll('.opt').forEach((el) => {
        if (el.dataset.k) el.classList.toggle('on', !!cfg[el.dataset.k]);
        else if (el.dataset.v) el.classList.toggle('on', cfg.gameType === el.dataset.v);
      });
    }

    document.querySelectorAll('#cfgType .opt, #cfgToggles .opt').forEach((el) => {
      el.onclick = () => {
        if (el.dataset.k) cfg[el.dataset.k] = !cfg[el.dataset.k];
        else cfg.gameType = el.dataset.v;
        refreshCreateSegs(document.getElementById('createView'));
      };
    });

    /* ---------------- 场风盘账号 ---------------- */

    function refreshHostAuth() {
      const u = RC.Auth.user;
      const out = document.getElementById('hostAuthLoggedOut');
      const inn = document.getElementById('hostAuthLoggedIn');
      if (!out) return;
      out.classList.toggle('hidden', !!u);
      inn.classList.toggle('hidden', !u);
      if (u) document.getElementById('hostWho').textContent = u.name;
      const btn = document.getElementById('btnCreate');
      if (btn) { btn.disabled = !u; btn.style.opacity = u ? '' : '.45'; }
    }

    async function bootHostAuth() {
      if (RC.Auth.token) {
        try { const r = await RC.api.me(); RC.Auth.setUser(r.user); }
        catch (_) { RC.Auth.clear(); }
      }
      refreshHostAuth();
    }

    async function hostAuth(mode) {
      const name = document.getElementById('hostName').value.trim();
      const pass = document.getElementById('hostPass').value;
      const msg = document.getElementById('hostAuthMsg');
      msg.textContent = '';
      if (!name || !pass) { msg.textContent = '请填写昵称和密码'; return; }
      try {
        const r = mode === 'register' ? await RC.api.register(name, pass) : await RC.api.login(name, pass);
        RC.Auth.set(r.token, r.user);
        me = r.user;
        document.getElementById('hostPass').value = '';
        refreshHostAuth();
        toast((mode === 'register' ? '注册成功：' : '登录成功：') + r.user.name, 'ok');
        if (code) checkHost();
      } catch (e) { msg.textContent = e.message; }
    }

    if (document.getElementById('btnHostLogin')) {
      document.getElementById('btnHostLogin').onclick = () => hostAuth('login');
      document.getElementById('btnHostRegister').onclick = () => hostAuth('register');
      document.getElementById('btnHostLogout').onclick = () => {
        RC.Auth.clear(); me = null; refreshHostAuth();
        toast('已退出场风盘账号');
        if (code) checkHost();
      };
      document.getElementById('hostPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') hostAuth('login'); });
      bootHostAuth();
    }

    if (document.getElementById('btnHwLogin')) {
      document.getElementById('btnHwLogin').onclick = hostWarnLogin;
      document.getElementById('hwPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') hostWarnLogin(); });
    }

    document.getElementById('btnCreate').onclick = async () => {
      if (!RC.Auth.token) { toast('请先登录场风盘账号', 'err'); return; }
      const body = {
        config: {
          ...cfg,
          startScore: Number(document.getElementById('cfgStart').value) || 25000,
        },
      };
      try {
        const r = await RC.api.createRoom(body.config);
        hostKey = r.hostKey;
        localStorage.setItem('rc_host_' + r.code, r.hostKey);
        enterRoom(r.code, r.room);
        toast('房间已创建：' + r.code, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };

    document.getElementById('btnStart').onclick = () => act('start');    document.getElementById('btnEditRules').onclick = () => openRules(true);
    document.getElementById('btnRules').onclick = () => openRules(room && room.phase === 'lobby');
    document.getElementById('btnHistory').onclick = () => { if (room) openHistory(); };
    document.getElementById('btnDice').onclick = () => { diceAnimUntil = Date.now() + 700; act('rollDice'); };
    document.getElementById('btnAgari').onclick = openAgari;
    document.getElementById('btnDraw').onclick = openDraw;
    document.getElementById('btnAdjust').onclick = openAdjust;
    document.getElementById('btnHonba').onclick = openHonba;
    document.getElementById('btnUndo').onclick = () => act('undo');
    document.getElementById('btnEnd').onclick = () => {
      if (confirm('确定要结束本场对局并结算吗？')) act('end');
    };
    document.getElementById('btnRematch').onclick = () => act('rematch');
    document.getElementById('btnViewRecord').onclick = () => openHistory();
    document.getElementById('btnClose').onclick = async () => {
      if (!confirm('关闭房间后所有设备会退出，确认？')) return;
      try { await RC.api.closeRoom(room.code, hostKey); } catch (_) { /* ignore */ }
      localStorage.removeItem('rc_table_code');
      toast('房间已关闭', 'ok');
      setTimeout(() => location.href = '/table', 700);
    };

    // 事件委托：座位按钮 / 大厅入座
    document.body.addEventListener('click', (e) => {
      const ri = e.target.closest('[data-riichi]');
      if (ri) { act('riichi', { seat: Number(ri.dataset.riichi), on: !room.seats[Number(ri.dataset.riichi)].riichi }); return; }
      const kick = e.target.closest('.kick');
      if (kick) { act('kick', { seat: Number(kick.dataset.seat) }); return; }
      const sit = e.target.closest('[data-sit]');
      if (sit) { sitSeat(Number(sit.dataset.seat)); return; }
      if (e.target.id === 'btnStarter' || e.target.closest('#btnStarter')) { openStarter(); return; }
    });

    window.addEventListener('beforeunload', () => { if (sub) sub.close(); });
  }

  boot();
})();
