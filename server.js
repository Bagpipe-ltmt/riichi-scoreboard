'use strict';

/**
 * 立直麻将 场风盘 —— 服务器
 * 零依赖：Node 内置 http + SSE 实时推送，局域网内 5 台设备（1 场风盘 + 4 玩家端）互联。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const store = require('./lib/store');
const game = require('./lib/game');

store.loadAll();

/**
 * 管理端账号：首次启动时自动创建（role = 'admin'），
 * 密码来自环境变量 ADMIN_PASSWORD，没设就随机生成，并落一份到 data/admin-password.txt。
 * 之后可以在 /admin 页面里自己改密码。
 */
function ensureAdmin() {
  const existed = store.adminUser();
  if (existed) return existed;
  const name = (process.env.ADMIN_NAME || 'admin').slice(0, 16);
  const pass = process.env.ADMIN_PASSWORD || crypto.randomBytes(4).toString('hex');
  let user;
  try {
    user = store.createUser(name, pass, 'admin');
  } catch (e) {
    // 昵称被普通玩家占了 → 换一个不冲突的
    user = store.createUser('admin' + crypto.randomBytes(2).toString('hex'), pass, 'admin');
  }
  try {
    fs.writeFileSync(
      path.join(store.DATA_DIR, 'admin-password.txt'),
      '管理员账号：' + user.name + '\n初始密码：' + pass + '\n（登录后可在 /admin 页面里改密码）\n',
      'utf8'
    );
  } catch (_) { /* 写不了就算了，日志里也有 */ }
  console.log('');
  console.log('  ★ 已创建管理员账号：' + user.name + '  初始密码：' + pass);
  console.log('    密码也存到了 ' + path.join(store.DATA_DIR, 'admin-password.txt'));
  console.log('');
  return user;
}

const ADMIN_USER = ensureAdmin();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------ SSE ------------------------------ */

const clients = new Map(); // code -> Set<res>

function sseSend(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch (_) { /* ignore */ }
}

function broadcast(code) {
  const set = clients.get(code);
  if (!set || !set.size) return;
  const room = store.getRoom(code);
  const body = { room: room ? game.publicRoom(room) : null };
  for (const res of set) sseSend(res, body);
}

/* 房间收掉时要把 SSE 订阅者一起踢掉：他们手里还攥着 EventSource，
 * 不发 { room: null, closed: true } 的话，5 台设备会一直显示一个已经不存在的房间。 */
function closeRoom(code) {
  broadcast(code);
  const set = clients.get(code);
  store.dropRoom(code);
  if (set) { for (const r of set) sseSend(r, { room: null, closed: true }); }
}

/* ------------------------------ 工具 ------------------------------ */

function lanUrls() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${PORT}`);
    }
  }
  if (!out.length) out.push(`http://127.0.0.1:${PORT}`);
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authOf(req, query) {
  const h = req.headers['authorization'] || '';
  let token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token && query && query.token) token = String(query.token);
  const user = store.userForToken(token);
  return { token, user };
}

function publicSelf(user) {
  return store.publicUser(user);
}

// 管理端权限：必须登录，且账号 role === 'admin'
function requireAdmin(req, query) {
  const { user } = authOf(req, query);
  if (!user) {
    const e = new Error('请先登录管理员账号');
    e.status = 401;
    throw e;
  }
  if (user.role !== 'admin') {
    const e = new Error('该账号不是管理员');
    e.status = 403;
    throw e;
  }
  return user;
}

function getRoomOrThrow(code) {
  const room = store.getRoom(code);
  if (!room) {
    const err = new Error('房间不存在或已关闭');
    err.status = 404;
    throw err;
  }
  return room;
}

function isHost(req, body, room, user) {
  const key = req.headers['x-host-key'] || (body && body.hostKey) || '';
  if (room.hostKey && key && key === room.hostKey) return true;
  if (room.hostUserId && user && user.id === room.hostUserId) return true;
  // 管理员兜底：场风盘那台设备丢了登录（换浏览器、清了缓存、手机重装）时，
  // 房间会卡在对局中再也结束不了。管理员端给一条出口。
  if (user && user.role === 'admin') return true;
  return false;
}

/* ------------------------------ 业务 ------------------------------ */

function persistRoom(room, touch = true) {
  if (room && !room.code) room.code = store.newRoomCode();
  if (room) store.putRoom(room);
  if (touch && room) broadcast(room.code);
}

function afterAction(room) {
  if (room.phase === 'ended' && !room.savedGameId) {
    const record = game.buildGameRecord(room);
    store.saveGame(record);
    room.savedGameId = record.id;
  }
}

/** 退出登录时把该账号在大厅阶段房间里的席位清空（对局中不动，避免牌局中途掉人） */
function releaseSeatsOf(userId) {
  for (const room of store.listRooms()) {
    if (room.phase !== 'lobby') continue;
    let touched = false;
    for (const s of room.seats) {
      if (s.userId === userId) {
        game.leaveSeat(room, s.seat);
        touched = true;
      }
    }
    if (touched) persistRoom(room);
  }
}

function handleAction(req, room, user, body) {
  try {
    return handleActionInner(req, room, user, body);
  } catch (e) {
    // 业务校验失败（番数不对、放铳者越界、点数格式错……）本来就该是 4xx。
    // 以前没有 status，全被 catch 兜成 500，日志里刷出误导性堆栈，
    // 前端也分不清「服务器挂了」和「自己填错了」。
    if (!e.status) e.status = 400;
    throw e;
  }
}

function handleActionInner(req, room, user, body) {
  const type = body.type;
  const payload = body.payload || {};
  const host = isHost(req, body, room, user);

  const needHost = (fn) => {
    if (!host) {
      // 分清「没登录/登录失效」和「登了但不是场风盘那台设备」，
      // 否则用户只会看到一句无从下手的「只有场风盘设备可以执行该操作」。
      const e = new Error(user
        ? `本设备不是场风盘设备（当前登录：${user.name}）。计分操作只能由建房的那台场风盘执行。`
        : '本设备未登录或登录已失效，请在页面上重新登录场风盘账号后再操作。');
      e.status = 403;
      e.code = user ? 'NOT_HOST' : 'NO_SESSION';
      throw e;
    }
    return fn();
  };

  switch (type) {
    case 'start':
      return needHost(() => { game.startGame(room); return '对局开始'; });
    case 'rematch':
      return needHost(() => { game.resetForRematch(room); return '已退回大厅，可再开一局'; });
    case 'rollDice':
      return needHost(() => { const d = game.rollDice(room); return `掷骰 ${d.d1}+${d.d2}=${d.sum}`; });
    case 'setStarter':
      return needHost(() => { game.setStarter(room, payload.seat); return '已指定起家'; });
    case 'riichi': {
      const seat = Number(payload.seat);
      if (!Number.isInteger(seat) || seat < 0 || seat > 3) {
        const e = new Error('席位不正确'); e.status = 400; throw e;
      }
      const s = room.seats[seat];
      const own = user && s && s.userId === user.id;
      if (!host && !own) {
        const e = new Error(user
          ? `只能为自己操作立直（当前登录：${user.name}，${seat + 1}号位是 ${(s && s.name) || '空席'}）。如果这台设备上换了账号，请用原来入座的账号重新登录。`
          : '本设备登录已失效，请输入昵称密码重新登录后再立直。');
        e.status = 403;
        e.code = user ? 'NOT_OWN_SEAT' : 'NO_SESSION';
        throw e;
      }
      game.setRiichi(room, seat, payload.on);
      return payload.on ? '立直 −1000' : '取消立直 +1000';
    }
    case 'agari':
      return needHost(() => { const h = game.declareAgari(room, payload); return `${h.winnerName} ${h.label} +${h.gain}`; });
    case 'draw':
      return needHost(() => { const h = game.declareDraw(room, payload); return h.drawLabel; });
    case 'adjust':
      return needHost(() => { game.adjustScores(room, payload.scores); return '点数已修正'; });
    case 'honba':
      return needHost(() => { game.setHonba(room, payload.honba); return `本场数 = ${room.round.honba}`; });
    case 'undo':
      return needHost(() => {
        // 撤销掉「终局」这一步时，要顺手把已经落库的记录删掉。
        // 否则「终局 → 撤销 → 再终局」会在历史里留下同一房间的两条记录。
        const saved = room.savedGameId;
        game.undo(room);
        if (saved && room.phase === 'playing' && store.getGame(saved)) store.deleteGame(saved);
        return '已撤销';
      });
    case 'end':
      return needHost(() => {
        // 大厅里「结束对局」= 把这间房收掉：大厅没有可结算的牌局，
        // 以前这里静默成功，房间就一直挂着，谁都开不了也关不掉。
        if (room.phase === 'lobby') { closeRoom(room.code); return '房间已关闭（还没开局，没有可结算的牌局）'; }
        game.endGame(room, 'manual');
        return '对局已结束';
      });
    case 'kick':
      return needHost(() => { game.leaveSeat(room, payload.seat); return '已清空该席位'; });
    case 'config':
      return needHost(() => { game.updateConfig(room, payload.config); return '规则已更新'; });
    default: {
      const e = new Error('未知操作：' + type);
      e.status = 400;
      throw e;
    }
  }
}

/* ------------------------------ 路由 ------------------------------ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method;

  if (p === '/api/ping') return sendJson(res, 200, { ok: true, now: Date.now() });

  if (p === '/api/host-info') {
    return sendJson(res, 200, { ok: true, port: PORT, urls: lanUrls(), hostname: os.hostname() });
  }

  /* ---- 账号 ---- */
  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    const user = store.createUser(b.name, b.password);
    const token = store.createSession(user.id);
    return sendJson(res, 200, { ok: true, token, user: publicSelf(user) });
  }

  if (p === '/api/auth/guest' && method === 'POST') {
    const b = await readBody(req);
    let name = String(b.name || '').trim() || `玩家${Math.floor(100 + Math.random() * 900)}`;
    if (store.findUserByName(name)) name = `${name}#${Math.floor(10 + Math.random() * 90)}`;
    const password = crypto.randomBytes(12).toString('hex');
    const user = store.createUser(name.slice(0, 16), password);
    const token = store.createSession(user.id);
    return sendJson(res, 200, { ok: true, token, user: publicSelf(user), guest: true });
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const user = store.verifyUser(b.name, b.password);
    if (!user) return sendJson(res, 401, { ok: false, error: '昵称或密码不正确' });
    const token = store.createSession(user.id);
    return sendJson(res, 200, { ok: true, token, user: publicSelf(user) });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    const { token, user } = authOf(req, q);
    if (token) store.dropSession(token);
    // 退出登录时释放该账号在大厅阶段房间里的席位：
    // 否则（尤其是游客账号，密码是随机生成的）这个席位就再也拿不回来了。
    if (user) releaseSeatsOf(user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/me') {
    const { token, user } = authOf(req, q);
    // token 失效时必须报错，否则客户端拿到 ok:true + user:null，
    // 会以为「已登录但没昵称」，继续用旧身份操作，最后卡在 403 上。
    if (token && !user) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });
    return sendJson(res, 200, { ok: true, user: publicSelf(user) });
  }

  /* ---- 房间列表 ---- */
  if (p === '/api/rooms' && method === 'GET') {
    const list = store.listRooms()
      .filter((r) => Date.now() - r.createdAt < 1000 * 60 * 60 * 12)
      .map((r) => game.summary(r));
    return sendJson(res, 200, { ok: true, rooms: list });
  }

  if (p === '/api/rooms' && method === 'POST') {
    const { user } = authOf(req, q);
    if (!user) { const e = new Error('请先登录场风盘账号'); e.status = 401; throw e; }
    const b = await readBody(req);
    const room = game.createRoom({
      userId: user.id,
      name: user.name,
      config: b.config,
    });
    room.code = store.newRoomCode();
    room.hostKey = crypto.randomBytes(12).toString('hex');
    store.putRoom(room);
    return sendJson(res, 200, {
      ok: true,
      code: room.code,
      hostKey: room.hostKey,
      room: game.publicRoom(room),
    });
  }

  /* ---- 单个房间 ---- */
  const m = p.match(/^\/api\/rooms\/(\d{4})(\/[a-z]+)?$/);
  if (m) {
    const code = m[1];
    const sub = m[2] || '';

    if (!sub && method === 'GET') {
      const room = getRoomOrThrow(code);
      return sendJson(res, 200, { ok: true, room: game.publicRoom(room) });
    }

    // 让场风盘设备自查「我现在到底还有没有主持权限」。
    // publicRoom 会剥掉 hostKey，客户端自己比对不了，所以必须问服务器。
    if (sub === '/whoami' && method === 'GET') {
      const room = getRoomOrThrow(code);
      const { user, token } = authOf(req, q);
      return sendJson(res, 200, {
        ok: true,
        isHost: isHost(req, null, room, user),
        user: publicSelf(user),
        tokenExpired: !!token && !user,
      });
    }

    if (sub === '/events' && method === 'GET') {
      const room = store.getRoom(code);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      sseSend(res, { room: room ? game.publicRoom(room) : null });
      if (!clients.has(code)) clients.set(code, new Set());
      clients.get(code).add(res);
      const hb = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
      }, 20000);
      req.on('close', () => {
        clearInterval(hb);
        const set = clients.get(code);
        if (set) { set.delete(res); if (!set.size) clients.delete(code); }
      });
      return undefined;
    }

    if (sub === '/join' && method === 'POST') {
      const room = getRoomOrThrow(code);
      const { user } = authOf(req, q);
      const b = await readBody(req);
      if (b.seat === undefined || b.seat === null) {
        return sendJson(res, 400, { ok: false, error: '请选择席位' });
      }
      const seat = game.joinSeat(room, {
        userId: user ? user.id : null,
        name: (user && user.name) || b.name || '玩家',
        seat: b.seat,
      });
      persistRoom(room);
      return sendJson(res, 200, { ok: true, seat: seat.seat, room: game.publicRoom(room) });
    }

    if (sub === '/leave' && method === 'POST') {
      const room = getRoomOrThrow(code);
      const b = await readBody(req);
      game.leaveSeat(room, b.seat);
      persistRoom(room);
      return sendJson(res, 200, { ok: true, room: game.publicRoom(room) });
    }

    if (sub === '/action' && method === 'POST') {
      const room = getRoomOrThrow(code);
      const { user } = authOf(req, q);
      const b = await readBody(req);
      const message = handleAction(req, room, user, b);
      // 「结束对局」在大厅阶段会直接把房间收掉，这时 room 已经不在库里了
      if (!store.getRoom(code)) return sendJson(res, 200, { ok: true, message, room: null, closed: true });
      afterAction(room);
      persistRoom(room);
      return sendJson(res, 200, { ok: true, message, room: game.publicRoom(room) });
    }

    if (sub === '/games' && method === 'GET') {
      const games = store.state.games
        .filter((g) => g.code === code)
        .map((g) => ({
          id: g.id,
          endedAt: g.endedAt,
          startAt: g.startedAt,
          config: g.config,
          endReasonText: g.endReasonText,
          players: g.players,
          hands: g.hands.length,
        }));
      return sendJson(res, 200, { ok: true, games });
    }

    if (sub === '/close' && method === 'POST') {
      const room = getRoomOrThrow(code);
      const { user } = authOf(req, q);
      if (!isHost(req, {}, room, user)) {
        return sendJson(res, 403, { ok: false, error: '只有场风盘设备可以关闭房间' });
      }
      closeRoom(code);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  }

  /* ---- 手动录入一局（不建房，直接录四家最终点数）---- */
  if (p === '/api/games' && method === 'POST') {
    const { user } = authOf(req, q);
    if (!user) {
      const e = new Error('请先登录账号，再录入对局');
      e.status = 401;
      throw e;
    }
    const b = await readBody(req);
    const list = Array.isArray(b.players) ? b.players : [];
    // 昵称能对上账号的，把 userId 挂上 —— 这样对方在「我的历史对局」里也能看到这一局
    const players = list.map((x) => {
      const nm = String((x && x.name) || '').trim();
      const matched = nm ? store.findUserByName(nm) : null;
      return {
        name: matched ? matched.name : nm,
        score: x && x.score,
        userId: matched ? matched.id : null,
      };
    });
    const rec = game.buildManualGame({
      config: b.config,
      players,
      allowUnbalanced: !!b.allowUnbalanced,
      note: b.note,
      playedAt: b.playedAt,
      hostUser: user,
    });
    store.saveGame(rec);
    return sendJson(res, 200, {
      ok: true,
      game: {
        id: rec.id,
        endedAt: rec.endedAt,
        endReasonText: rec.endReasonText,
        balanceDiff: rec.balanceDiff,
        players: rec.players,
        ranking: rec.finalRanking.players,
      },
    });
  }

  /* ---- 历史对局 ---- */
  if (p === '/api/me/games' && method === 'GET') {
    const { user } = authOf(req, q);
    if (!user) return sendJson(res, 401, { ok: false, error: '请先登录' });
    const games = store.gamesForUser(user.id).map((g) => ({
      id: g.id,
      code: g.code,
      endedAt: g.endedAt,
      config: g.config,
      endReasonText: g.endReasonText,
      players: g.players,
      me: g.players.find((x) => x.userId === user.id) || null,
      hands: g.hands.length,
    }));
    return sendJson(res, 200, { ok: true, games });
  }

  const gm = p.match(/^\/api\/games\/([a-f0-9]{6,32})$/);
  if (gm && method === 'GET') {
    const g = store.getGame(gm[1]);
    if (!g) return sendJson(res, 404, { ok: false, error: '找不到该对局记录' });
    return sendJson(res, 200, { ok: true, game: g });
  }

  /* ---- 管理端（只有本机的管理员账号能用） ---- */
  if (p.startsWith('/api/admin/')) {
    return handleAdmin(req, res, url, p.slice('/api/admin'.length), method);
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

/* ---------------------------- 管理端 ---------------------------- */

function hourOf(ts) {
  return Math.floor(ts / 3600000);
}

function adminGameRow(g) {
  const players = (g.players || []).map((x) => ({
    seat: x.seat,
    name: x.name,
    userId: x.userId || null,
    score: x.score,
    rank: x.rank,
    diff: x.diff === undefined ? null : x.diff,
    wins: x.wins || 0,
  }));
  const total = players.reduce((a, x) => a + (Number(x.score) || 0), 0);
  return {
    id: g.id,
    code: g.code,
    startedAt: g.startedAt || null,
    endedAt: g.endedAt || null,
    gameType: (g.config && g.config.gameType) || 'hanchan',
    startScore: (g.config && g.config.startScore) || 25000,
    endReason: g.endReason || 'manual',
    endReasonText: g.endReasonText || '',
    hostName: g.hostName || '',
    hands: (g.hands || []).length,
    players,
    totalScore: total,
  };
}

async function handleAdmin(req, res, url, sub, method) {
  requireAdmin(req, url.searchParams);

  if (sub === '/overview' && method === 'GET') {
    const games = store.allGames();
    const users = store.listUsers();
    const rooms = store.listRooms();
    const now = Date.now();
    let hands = 0;
    let agari = 0;
    for (const g of games) {
      const hs = g.hands || [];
      hands += hs.length;
      agari += hs.filter((h) => h.type === 'agari').length;
    }
    const last7 = games.filter((g) => (g.endedAt || 0) > now - 7 * 86400000).length;
    return sendJson(res, 200, {
      ok: true,
      overview: {
        games: games.length,
        players: users.filter((u) => u.role !== 'admin').length,
        admins: users.filter((u) => u.role === 'admin').length,
        rooms: rooms.length,
        roomsLive: rooms.filter((r) => r.phase === 'playing').length,
        hands,
        agari,
        last7,
        latestAt: games.length ? (games[0].endedAt || null) : null,
        startScoreTotal: games.reduce((a, g) => a + ((g.config && g.config.startScore) || 25000) * 4, 0),
      },
    });
  }

  if (sub === '/games' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const from = Number(url.searchParams.get('from') || 0);
    const to = Number(url.searchParams.get('to') || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

    let list = store.allGames();
    if (from) list = list.filter((g) => (g.endedAt || g.startedAt || 0) >= from);
    if (to) list = list.filter((g) => (g.endedAt || g.startedAt || 0) <= to);
    if (q) {
      list = list.filter((g) => {
        if (String(g.code || '').includes(q)) return true;
        if (String(g.hostName || '').toLowerCase().includes(q)) return true;
        if (String(g.endReasonText || '').toLowerCase().includes(q)) return true;
        return (g.players || []).some((x) => String(x.name || '').toLowerCase().includes(q));
      });
    }
    const total = list.length;
    return sendJson(res, 200, {
      ok: true,
      total,
      games: list.slice(offset, offset + limit).map(adminGameRow),
    });
  }

  const one = sub.match(/^\/games\/([a-f0-9]{6,32})$/);
  if (one) {
    const g = store.getGame(one[1]);
    if (!g) return sendJson(res, 404, { ok: false, error: '找不到该对局记录' });
    if (method === 'GET') return sendJson(res, 200, { ok: true, game: g });
    if (method === 'DELETE') {
      store.deleteGame(g.id);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { ok: false, error: '不支持的方法' });
  }

  if (sub === '/players' && method === 'GET') {
    const map = new Map();
    for (const g of store.allGames()) {
      for (const p of g.players || []) {
        if (!p.userId) continue;
        let it = map.get(p.userId);
        if (!it) {
          it = { userId: p.userId, name: p.name, games: 0, first: 0, second: 0, third: 0, fourth: 0, rankSum: 0, wins: 0, scoreSum: 0, lastAt: 0 };
          map.set(p.userId, it);
        }
        it.name = p.name || it.name;
        it.games += 1;
        it.rankSum += p.rank || 4;
        it.wins += p.wins || 0;
        it.scoreSum += Number(p.score) || 0;
        if (p.rank === 1) it.first += 1;
        else if (p.rank === 2) it.second += 1;
        else if (p.rank === 3) it.third += 1;
        else it.fourth += 1;
        it.lastAt = Math.max(it.lastAt, g.endedAt || 0);
      }
    }
    const players = [...map.values()]
      .map((it) => ({
        userId: it.userId,
        name: it.name,
        games: it.games,
        first: it.first,
        second: it.second,
        third: it.third,
        fourth: it.fourth,
        wins: it.wins,
        avgRank: it.games ? +(it.rankSum / it.games).toFixed(2) : 0,
        avgScore: it.games ? Math.round(it.scoreSum / it.games) : 0,
        lastAt: it.lastAt,
      }))
      .sort((a, b) => b.games - a.games || a.avgRank - b.avgRank);
    return sendJson(res, 200, { ok: true, players });
  }

  if (sub === '/rooms' && method === 'GET') {
    const rooms = store.listRooms().map((r) => ({
      code: r.code,
      phase: r.phase,
      createdAt: r.createdAt,
      hostName: r.hostName,
      startedAt: r.startedAt || null,
      round: r.round ? { wind: r.round.wind, num: r.round.num, honba: r.round.honba } : null,
      hands: (r.hands || []).length,
      seats: (r.seats || []).map((s) => ({
        seat: s.seat, name: s.name, score: s.score, riichi: !!s.riichi, wins: s.wins || 0,
      })),
      savedGameId: r.savedGameId || null,
      endedAt: r.endedAt || null,
    }));
    return sendJson(res, 200, { ok: true, rooms });
  }

  /* 房间收口：管理员端可以替任何一间房收尾（场风盘那台设备丢了登录时这是唯一出口） */
  const roomOp = sub.match(/^\/rooms\/([0-9A-Za-z]{1,16})\/(end|close)$/);
  if (roomOp && method === 'POST') {
    const code = roomOp[1];
    const op = roomOp[2];
    const room = store.getRoom(code);
    if (!room) return sendJson(res, 404, { ok: false, error: '房间已经不存在了（可能已被关闭）' });

    if (op === 'close') {
      closeRoom(code);
      return sendJson(res, 200, { ok: true, closed: true, message: `房间 ${code} 已关闭` });
    }

    if (room.phase === 'lobby') {
      closeRoom(code);
      return sendJson(res, 200, { ok: true, closed: true, message: `房间 ${code} 在大厅阶段，已直接关闭（没有可结算的牌局）` });
    }
    if (room.phase === 'ended') {
      // 已终局但没落库（比如结算中途出错）—— 补存一条记录，而不是再结算一次
      afterAction(room);
      persistRoom(room);
      return sendJson(res, 200, {
        ok: true,
        alreadyEnded: true,
        message: room.savedGameId ? `房间 ${code} 早已终局，记录已确认入库` : `房间 ${code} 早已终局，已补存记录`,
        gameId: room.savedGameId || null,
      });
    }
    game.endGame(room, 'manual');
    afterAction(room);
    persistRoom(room);
    return sendJson(res, 200, {
      ok: true,
      gameId: room.savedGameId || null,
      message: `房间 ${code} 已结束并结算`,
      ranking: room.finalRanking ? room.finalRanking.players.map((p) => ({ seat: p.seat, name: p.name, score: p.score, rank: p.rank, diff: p.diff })) : [],
    });
  }

  if (sub === '/password' && method === 'POST') {
    const me = requireAdmin(req, url.searchParams);
    const b = await readBody(req);
    if (String(b.password || '').length < 4) {
      return sendJson(res, 400, { ok: false, error: '密码至少 4 位' });
    }
    store.setPassword(me, b.password);
    store.flushNow();
    // 改完密码让其他会话失效，只保留当前这个
    const keep = authOf(req, url.searchParams).token;
    for (const t of Object.keys(store.state.sessions)) {
      if (t !== keep && store.state.sessions[t].userId === me.id) delete store.state.sessions[t];
    }
    store.save('sessions');
    return sendJson(res, 200, { ok: true, user: publicSelf(me) });
  }

  if (sub === '/export' && method === 'GET') {
    const fmt = (url.searchParams.get('format') || 'csv').toLowerCase();
    const games = store.allGames().map(adminGameRow);
    if (fmt === 'json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="riichi-games.json"',
      });
      return res.end(JSON.stringify({ exportedAt: Date.now(), games }, null, 2));
    }
    const head = ['对局ID', '房间号', '开始时间', '结束时间', '对局形式', '起始点数', '终局原因', '主持', '局数',
      '1位', '1位点数', '2位', '2位点数', '3位', '3位点数', '4位', '4位点数'];
    const pad = (n) => String(n).padStart(2, '0');
    const dt = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    };
    const esc = (v) => {
      const s = String(v === null || v === undefined ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [head.map(esc).join(',')];
    for (const g of games) {
      const byRank = [1, 2, 3, 4].map((r) => g.players.find((p) => p.rank === r) || null);
      const row = [
        g.id, g.code, dt(g.startedAt), dt(g.endedAt),
        g.gameType === 'tonpuusen' ? '东风战' : '半庄战',
        g.startScore, g.endReasonText, g.hostName, g.hands,
      ];
      for (const p of byRank) {
        row.push(p ? p.name : '');
        row.push(p ? p.score : '');
      }
      lines.push(row.map(esc).join(','));
    }
    // 加 BOM，Excel 直接双击打开不会乱码
    const body = '\uFEFF' + lines.join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="riichi-games.csv"',
    });
    return res.end(body);
  }

  return sendJson(res, 404, { ok: false, error: '管理接口不存在' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/table' || rel === '/table/') rel = '/table.html';
  if (rel === '/player' || rel === '/player/') rel = '/player.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  if (rel === '/record' || rel === '/record/') rel = '/record.html';

  const full = path.join(PUBLIC_DIR, rel);
  const normalized = path.resolve(full);
  if (!normalized.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------ 启动 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Host-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    // 带上 e.code（NO_SESSION / NOT_HOST / NOT_OWN_SEAT …），
    // 客户端才能区分「该重新登录」和「这台设备本来就不是场风盘」。
    if (!res.headersSent) sendJson(res, e.status || 500, { ok: false, error: e.message || '服务器错误', code: e.code || undefined });
    else {
      try { res.end(); } catch (_) { /* ignore */ }
    }
    if (!e.status || e.status >= 500) console.error('[error]', req.method, url.pathname, e);
  }
});

server.listen(PORT, HOST, () => {
  const urls = lanUrls();
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │   立直麻将 · 场风盘  (Riichi Scoreboard)      │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log('  场风盘（本机 / 平板）：');
  console.log(`    ${urls[0]}/table`);
  console.log('');
  console.log('  玩家端（4 台手机扫码或输入网址）：');
  for (const u of urls) console.log(`    ${u}/player`);
  console.log('');
  console.log('  管理员端（本机，看所有对局记录）：');
  console.log(`    ${urls[0]}/admin   账号：${ADMIN_USER.name}`);
  console.log('');
  console.log('  数据目录：' + store.DATA_DIR);
  console.log('  按 Ctrl+C 结束服务');
  console.log('');
});

const autosave = setInterval(() => store.flushNow(), 30000);
autosave.unref();

function shutdown() {
  console.log('\n正在保存数据…');
  clearInterval(autosave);
  store.flushNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
  store.flushNow();
});
