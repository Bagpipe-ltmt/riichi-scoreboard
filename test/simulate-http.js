'use strict';
/* HTTP 层回归：把 test/simulate.js 抓出来的 bug 在实际接口上验一遍。
 * 起一个临时服务（独立端口 + 独立数据目录），不碰真实 data/。 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const DATA = path.join(__dirname, '.httpdata');

/* 端口从 8123 起找一个空闲的：本机若正好有别的服务占着 8123，不会误连上去。
 * 想固定端口就设环境变量 RC_TEST_PORT。 */
let PORT = Number(process.env.RC_TEST_PORT) || 0;
let BASE = '';

function freePort(from) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && from < from + 200) resolve(freePort(from + 1));
      else reject(e);
    });
    srv.once('listening', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.listen(from, '127.0.0.1');
  });
}

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra)));
  return false;
}
function eq(a, b, label) { return ok(JSON.stringify(a) === JSON.stringify(b), label + `  (期望 ${JSON.stringify(b)})`, a); }

async function call(method, p, body, headers) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html */ }
  return { status: res.status, json, text };
}

async function main() {
  if (!PORT) PORT = await freePort(8123);
  BASE = `http://127.0.0.1:${PORT}`;
  fs.rmSync(DATA, { recursive: true, force: true });
  const child = spawn(NODE, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), RC_DATA_DIR: DATA, HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d.toString(); });
  child.stderr.on('data', (d) => { bootLog += d.toString(); });

  const waitUp = async () => {
    for (let i = 0; i < 60; i++) {
      try { const r = await call('GET', '/api/ping'); if (r.status === 200) return true; } catch (e) { /* retry */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };

  try {
    if (!(await waitUp())) { ok(false, '临时服务启动失败', bootLog.slice(0, 400)); throw new Error('boot failed'); }

    // 建账号 + 建房
    const reg = await call('POST', '/api/auth/register', { name: '测试庄家', password: 'test1234' });
    ok(reg.status === 200 && reg.json.ok, '注册账号', reg.json && reg.json.error);
    const token = reg.json.token;
    const auth = { Authorization: 'Bearer ' + token };

    // 另外三个账号
    const others = [];
    for (const n of ['测试甲', '测试乙', '测试丙']) {
      const r = await call('POST', '/api/auth/register', { name: n, password: 'test1234' });
      others.push({ token: r.json.token, id: r.json.user.id });
    }

    const created = await call('POST', '/api/rooms', { config: { gameType: 'hanchan', tobi: false, agariYame: false } }, auth);
    ok(created.status === 200, '建房', created.json && created.json.error);
    const code = created.json.code;
    const hostKey = created.json.hostKey;
    eq(String(code).length, 4, '房间号是 4 位');

    // 四个席位：庄家号占 0，另外三个账号占 1..3
    eq((await call('POST', `/api/rooms/${code}/join`, { seat: 0 }, auth)).status, 200, '庄家入座');
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', `/api/rooms/${code}/join`, { seat: i + 1 }, { Authorization: 'Bearer ' + others[i].token });
      eq(r.status, 200, `第 ${i + 1} 号位入座`, r.json && r.json.error);
    }

    eq((await call('POST', `/api/rooms/${code}/action`, { type: 'start', hostKey }, auth)).status, 200, '开始对局');
    eq((await call('POST', `/api/rooms/${code}/action`, { type: 'setStarter', hostKey, payload: { seat: 0 } }, auth)).status, 200, '指定起家');

    // ---- 回归 1：放铳者席次越界应当是 400 + 中文，而不是 500 ----
    for (const bad of [9, -1, 4]) {
      const r = await call('POST', `/api/rooms/${code}/action`, {
        type: 'agari', hostKey, payload: { winnerSeat: 0, han: 2, fu: 30, tsumo: false, loserSeat: bad },
      }, auth);
      eq(r.status, 400, `放铳者=${bad} 返回 400`, r.status);
      ok(r.json && /[\u4e00-\u9fa5]/.test(r.json.error || ''), `放铳者=${bad} 错误信息是中文`, r.json && r.json.error);
    }
    let room = (await call('GET', `/api/rooms/${code}`)).json.room;
    eq(room.seats.map((s) => s.score), [25000, 25000, 25000, 25000], '非法荣和没有改到点数');
    eq(room.hands.length, 0, '非法荣和没有进牌谱');

    // ---- 回归 2：点数修正传垃圾 → 400，不污染 ----
    for (const bad of [[1, 2, 3], [1, 2, 3, 'abc'], [25000, 25000, 25000, null]]) {
      const r = await call('POST', `/api/rooms/${code}/action`, { type: 'adjust', hostKey, payload: { scores: bad } }, auth);
      eq(r.status, 400, `点数修正 ${JSON.stringify(bad)} 返回 400`, r.status);
    }
    room = (await call('GET', `/api/rooms/${code}`)).json.room;
    eq(room.seats.map((s) => s.score), [25000, 25000, 25000, 25000], '非法修正没有污染点数');

    // ---- 回归 3：途中流局庄家连庄（接口层） ----
    const drawRes = await call('POST', `/api/rooms/${code}/action`, {
      type: 'draw', hostKey, payload: { type: 'fourWind', tenpai: [false, false, false, false] },
    }, auth);
    eq(drawRes.status, 200, '四风连打流局 200', drawRes.json && drawRes.json.error);
    room = drawRes.json.room;
    eq(room.round.dealer, 0, '接口层：四风连打后庄家仍为 0');
    eq(room.round.honba, 1, '接口层：四风连打后本场 +1');
    ok(room.hands[0].renchan === true, '接口层：牌谱里 renchan 为 true');

    // ---- 回归 4：正常和了，handTotal 出现在接口返回里 ----
    const ag = await call('POST', `/api/rooms/${code}/action`, {
      type: 'agari', hostKey, payload: { winnerSeat: 1, han: 4, fu: 30, tsumo: false, loserSeat: 2 },
    }, auth);
    eq(ag.status, 200, '和了 200', ag.json && ag.json.error);
    const hand = ag.json.room.hands[ag.json.room.hands.length - 1];
    eq(hand.label, '满贯（切上）', '接口层：4番30符 切上满贯');
    eq(hand.handTotal, 8300, '接口层：handTotal 随牌谱返回（1本场 +300）');
    eq(hand.gain, 8300, '接口层：无供托时 gain = handTotal');

    // ---- 回归 5：终局 → 撤销 → 再终局，历史里只留一条 ----
    await call('POST', `/api/rooms/${code}/action`, { type: 'end', hostKey }, auth);
    let games = (await call('GET', `/api/rooms/${code}/games`)).json.games;
    eq(games.length, 1, '手动终局后历史 1 条');
    const undoRes = await call('POST', `/api/rooms/${code}/action`, { type: 'undo', hostKey }, auth);
    eq(undoRes.status, 200, '撤销终局 200', undoRes.json && undoRes.json.error);
    eq(undoRes.json.room.phase, 'playing', '撤销后回到对局中');
    games = (await call('GET', `/api/rooms/${code}/games`)).json.games;
    eq(games.length, 0, '撤销终局后历史记录被清掉');
    await call('POST', `/api/rooms/${code}/action`, { type: 'end', hostKey }, auth);
    games = (await call('GET', `/api/rooms/${code}/games`)).json.games;
    eq(games.length, 1, '再终局后历史仍只有 1 条');

    // ---- 权限：别人不能操作 ----
    const r403 = await call('POST', `/api/rooms/${code}/action`, {
      type: 'agari', payload: { winnerSeat: 0, han: 2, fu: 30, tsumo: true },
    }, { Authorization: 'Bearer ' + others[0].token });
    eq(r403.status, 403, '非场风盘设备操作被拒', r403.status);
  } finally {
    // Windows 上 SIGTERM 不保证立刻结束进程，之前留下过占着端口的僵尸服务，
    // 这里直接 SIGKILL 并等它真的退出。
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().then(() => {
  console.log('\n=== HTTP 回归 ===');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) { console.log('\n失败明细：'); fails.forEach((f) => console.log('  ✗ ' + f)); }
  process.exit(fails.length ? 1 : 0);
}).catch((e) => {
  console.log('\n[HTTP 回归异常] ' + e.message);
  if (fails.length) { console.log('失败明细：'); fails.forEach((f) => console.log('  ✗ ' + f)); }
  process.exit(1);
});
