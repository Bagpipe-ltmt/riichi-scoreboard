/* 录入一局：登录 → 填四家最终点数 → 存成对局记录 */
(function () {
  'use strict';

  const { Auth, api, req, esc, fmtScore, fmtSigned, toast } = window.RC;

  const el = (id) => document.getElementById(id);
  const state = {
    type: 'hanchan',
    startScore: 25000,
    rows: [], // [{ name, score }]
  };

  /* ---------------- 登录 ---------------- */

  function showAuth() {
    el('authView').classList.remove('hidden');
    el('formView').classList.add('hidden');
    el('userPill').textContent = '未登录';
    el('btnLogout').classList.add('hidden');
  }

  function showForm(user) {
    el('authView').classList.add('hidden');
    el('formView').classList.remove('hidden');
    el('userPill').textContent = user ? user.name : '已登录';
    el('btnLogout').classList.remove('hidden');
    if (state.rows.length === 0) {
      state.rows = [
        { name: (user && user.name) || '', score: '' },
        { name: '', score: '' },
        { name: '', score: '' },
        { name: '', score: '' },
      ];
    }
    renderRows();
    renderPreview();
  }

  async function doAuth(kind) {
    const name = el('auName').value.trim();
    const pass = el('auPass').value;
    if (!name || !pass) return toast('昵称和密码都要填', 'danger');
    try {
      const r = kind === 'register' ? await api.register(name, pass) : await api.login(name, pass);
      Auth.set(r.token, r.user);
      el('auPass').value = '';
      showForm(r.user);
      toast(kind === 'register' ? '注册好了，直接录吧' : '登录成功');
    } catch (e) {
      toast(e.message, 'danger');
    }
  }

  /* ---------------- 四家输入 ---------------- */

  function renderRows() {
    const box = el('playerRows');
    box.innerHTML = state.rows.map((r, i) => `
      <div class="row" style="margin-bottom:8px;gap:8px">
        <input class="input" data-i="${i}" data-k="name" maxlength="16" placeholder="第 ${i + 1} 家昵称"
               value="${esc(r.name)}" style="flex:1.4 1 0">
        <input class="input mono" data-i="${i}" data-k="score" inputmode="numeric" placeholder="点数"
               value="${esc(r.score)}" style="flex:1 1 0;text-align:right">
      </div>`).join('');

    box.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const i = Number(inp.dataset.i);
        state.rows[i][inp.dataset.k] = inp.value;
        renderPreview();
      });
    });
  }

  /* ---------------- 实时预览 ---------------- */

  function parsed() {
    return state.rows.map((r, i) => ({
      i,
      name: String(r.name || '').trim(),
      score: /^-?\d+$/.test(String(r.score).trim()) ? Number(String(r.score).trim()) : null,
    }));
  }

  function renderPreview() {
    const list = parsed();
    const filled = list.filter((p) => p.score !== null && p.name);
    const total = list.reduce((a, p) => a + (p.score === null ? 0 : p.score), 0);
    const expect = state.startScore * 4;
    const diff = total - expect;

    const box = el('preview');
    if (filled.length < 4) {
      box.innerHTML = `已填 <b class="gold">${filled.length}</b> / 4 家。四家都填好后这里会显示顺位和收支预览。`;
      return;
    }

    const sorted = filled.slice().sort((a, b) => (b.score - a.score) || (a.i - b.i));
    const rows = sorted.map((p, idx) => {
      const d = (p.score - state.startScore) / 1000;
      return `<tr class="rank-${idx + 1}"><td>${idx + 1}位</td><td>${esc(p.name)}</td>
        <td class="mono">${fmtScore(p.score)}</td><td class="mono"><b>${fmtSigned(d.toFixed(1))}</b></td></tr>`;
    }).join('');

    box.innerHTML = '<table class="result-table"><tr><th>顺位</th><th>玩家</th><th>点数</th><th>收支</th></tr>'
      + rows + '</table>'
      + `<div class="tiny ${diff === 0 ? 'muted' : 'danger'}" style="margin-top:8px">`
      + `合计 ${fmtScore(total)} 点（应为 ${fmtScore(expect)}）`
      + (diff === 0 ? ' · 点数守恒 ✓' : ` · 差 <b>${fmtSigned(diff)}</b> 点`) + '</div>';
  }

  /* ---------------- 保存 ---------------- */

  async function save() {
    const list = parsed();
    for (let i = 0; i < 4; i++) {
      if (!list[i].name) return toast(`第 ${i + 1} 家的昵称还没填`, 'danger');
      if (list[i].score === null) return toast(`第 ${i + 1} 家的点数要填整数`, 'danger');
    }
    const names = list.map((p) => p.name.toLowerCase());
    if (new Set(names).size !== 4) return toast('四家昵称不能有重复', 'danger');

    const total = list.reduce((a, p) => a + p.score, 0);
    const expect = state.startScore * 4;
    let allowUnbalanced = false;
    if (total !== expect) {
      const diff = total - expect;
      const ok = window.confirm(
        `四家合计 ${total} 点，与 4×${state.startScore}=${expect} 差 ${diff >= 0 ? '+' : ''}${diff} 点。\n\n`
        + '正常一局应该正好相等。确定要按这个数字保存吗？（会在记录里标注「点数未守恒」）');
      if (!ok) return;
      allowUnbalanced = true;
    }

    const btn = el('btnSave');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const r = await req('/api/games', {
        method: 'POST',
        body: {
          config: { gameType: state.type, startScore: state.startScore },
          allowUnbalanced,
          note: el('note').value.trim(),
          players: list.map((p) => ({ name: p.name, score: p.score })),
        },
      });
      showDone(r.game);
      toast('存好了');
    } catch (e) {
      if (e.code === 'UNBALANCED') {
        // 服务端也拦了一道（防止有人绕过前端），把原话显示出来
        toast('点数对不上，服务端拒绝了：' + e.message, 'danger');
      } else {
        toast(e.message, 'danger');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '保存这局记录';
    }
  }

  function showDone(g) {
    const rows = (g.ranking || []).map((p) => `
      <tr class="rank-${p.rank}"><td>${p.rank}位</td><td>${esc(p.name)}${p.rank === 1 ? ' 👑' : ''}</td>
      <td class="mono">${fmtScore(p.score)}</td><td class="mono"><b>${fmtSigned((p.diff || 0).toFixed(1))}</b></td></tr>`).join('');
    el('doneBody').innerHTML = '<table class="result-table"><tr><th>顺位</th><th>玩家</th><th>点数</th><th>收支</th></tr>'
      + rows + '</table>'
      + `<div class="muted tiny" style="margin-top:8px">记录 ID ${esc(g.id)}`
      + (g.balanceDiff ? ` · 点数未守恒（差 ${fmtSigned(g.balanceDiff)}）` : '') + '</div>';
    el('doneCard').classList.remove('hidden');
    el('doneCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function resetForm() {
    el('doneCard').classList.add('hidden');
    el('note').value = '';
    const me = Auth.user;
    state.rows = [
      { name: (me && me.name) || '', score: '' },
      { name: '', score: '' },
      { name: '', score: '' },
      { name: '', score: '' },
    ];
    renderRows();
    renderPreview();
    el('formView').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- 绑定 ---------------- */

  el('btnLogin').onclick = () => doAuth('login');
  el('btnRegister').onclick = () => doAuth('register');
  el('auPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });

  el('btnLogout').onclick = async () => {
    try { await api.logout(); } catch (_) { /* 本地照样清 */ }
    Auth.clear();
    showAuth();
  };

  el('segType').querySelectorAll('[data-t]').forEach((node) => {
    node.onclick = () => {
      state.type = node.dataset.t;
      el('segType').querySelectorAll('[data-t]').forEach((n) => n.classList.toggle('on', n === node));
    };
  });

  el('startScore').addEventListener('input', () => {
    const v = Number(el('startScore').value);
    state.startScore = Number.isInteger(v) && v > 0 ? v : 25000;
    renderPreview();
  });
  el('startScore').addEventListener('blur', () => {
    el('startScore').value = state.startScore;
  });

  el('btnSave').onclick = save;
  el('btnAgain').onclick = resetForm;

  window.RC.onAuthLost((msg) => {
    toast(msg || '登录已失效，请重新登录', 'danger');
    showAuth();
  });

  /* ---------------- 启动 ---------------- */
  (async function init() {
    try {
      const r = await api.me();
      if (r.user) { showForm(r.user); return; }
    } catch (_) { /* 未登录 */ }
    showAuth();
  })();
})();
