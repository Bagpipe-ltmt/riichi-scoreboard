'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { biz } = require('./errors');

// 数据目录：默认 <项目>/data，可用环境变量 RC_DATA_DIR 覆盖（测试用独立目录，避免污染真实数据）
const DATA_DIR = process.env.RC_DATA_DIR
  ? path.resolve(process.env.RC_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const state = {
  users: {},    // id -> {id, name, salt, hash, createdAt}
  sessions: {}, // token -> {userId, createdAt, expires}
  rooms: {},    // code -> room
  games: [],    // 已结束的对局记录（倒序）
};

function fileOf(name) {
  return path.join(DATA_DIR, name + '.json');
}

// 把「数组形态」的数据文件按主键重建成索引对象。
// 为什么需要：如果有人用脚本把 rooms.json 写成 [{...}]（数组也是 object），
// state.rooms 就变成数组，getRoom('4609') 永远返回 null —— 表现为「房间列表里有，
// 但点进去 404 / 打不开」。这里统一兜住，避免一份手改的数据把房间废掉。
function rebuildIndex(name, list) {
  const rebuilt = {};
  for (const item of list || []) {
    if (!item || typeof item !== 'object') continue;
    const key = name === 'rooms' ? item.code : item.id;
    if (key !== undefined && key !== null && key !== '') rebuilt[String(key)] = item;
  }
  return rebuilt;
}

function loadAll() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of ['users', 'sessions', 'rooms', 'games']) {
    try {
      const raw = fs.readFileSync(fileOf(name), 'utf8');
      const parsed = JSON.parse(raw);
      if (name === 'games') {
        if (Array.isArray(parsed)) state.games = parsed;
      } else if (Array.isArray(parsed)) {
        state[name] = rebuildIndex(name, parsed);
      } else if (parsed && typeof parsed === 'object') {
        state[name] = parsed;
      }
    } catch (_) {
      /* 文件不存在或损坏 → 使用默认值 */
    }
  }
  // 清理过期会话
  const now = Date.now();
  let changed = false;
  for (const [tok, s] of Object.entries(state.sessions)) {
    if (!s || !s.expires || s.expires < now) {
      delete state.sessions[tok];
      changed = true;
    }
  }
  if (changed) save('sessions');
}

const dirty = new Set();
let timer = null;

function flush() {
  timer = null;
  const names = [...dirty];
  dirty.clear();
  for (const name of names) {
    try {
      const tmp = fileOf(name) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state[name]));
      fs.renameSync(tmp, fileOf(name));
    } catch (e) {
      console.error('[store] 写入失败', name, e.message);
    }
  }
}

function save(name) {
  dirty.add(name);
  if (!timer) timer = setTimeout(flush, 200);
}

function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  flush();
}

/* ------------------------------ 账号 ------------------------------ */

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, createdAt: u.createdAt, role: u.role || 'player' };
}

function findUserByName(name) {
  const key = String(name || '').trim().toLowerCase();
  return Object.values(state.users).find((u) => u.name.toLowerCase() === key) || null;
}

function getUser(id) {
  return state.users[id] || null;
}

function createUser(name, password, role) {
  const clean = String(name || '').trim();
  if (clean.length < 1 || clean.length > 16) throw biz('昵称需为 1~16 个字符');
  if (String(password).length < 4) throw biz('密码至少 4 位');
  if (findUserByName(clean)) throw biz('该昵称已被注册');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    name: clean,
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
    role: role === 'admin' ? 'admin' : 'player',
  };
  state.users[user.id] = user;
  save('users');
  return user;
}

function listUsers() {
  return Object.values(state.users).sort((a, b) => b.createdAt - a.createdAt);
}

function adminUser() {
  return Object.values(state.users).find((u) => u.role === 'admin') || null;
}

// 改密码（管理员重置用）
function setPassword(user, password) {
  if (!user) throw biz('用户不存在');
  if (String(password).length < 4) throw biz('密码至少 4 位');
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(password, user.salt);
  save('users');
  return user;
}

function verifyUser(name, password) {
  const u = findUserByName(name);
  if (!u) return null;
  const h = hashPassword(password, u.salt);
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return u;
}

const SESSION_TTL = 1000 * 60 * 60 * 24 * 60; // 60天

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions[token] = { userId, createdAt: Date.now(), expires: Date.now() + SESSION_TTL };
  save('sessions');
  return token;
}

function userForToken(token) {
  if (!token) return null;
  const s = state.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete state.sessions[token];
    save('sessions');
    return null;
  }
  return getUser(s.userId);
}

function dropSession(token) {
  if (state.sessions[token]) {
    delete state.sessions[token];
    save('sessions');
  }
}

/* ------------------------------ 房间 ------------------------------ */

function getRoom(code) {
  return state.rooms[String(code || '').trim()] || null;
}

function newRoomCode() {
  for (let i = 0; i < 500; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!state.rooms[code]) return code;
  }
  throw new Error('房间号已用尽，请重启服务');
}

function putRoom(room, persist = true) {
  state.rooms[room.code] = room;
  if (persist) save('rooms');
}

function dropRoom(code) {
  delete state.rooms[code];
  save('rooms');
}

function listRooms() {
  return Object.values(state.rooms).sort((a, b) => b.createdAt - a.createdAt);
}

/* --------------------------- 历史对局记录 --------------------------- */

function saveGame(record) {
  state.games.unshift(record);
  if (state.games.length > 2000) state.games.length = 2000;
  save('games');
}

function getGame(id) {
  return state.games.find((g) => g.id === id) || null;
}

function gamesForUser(userId) {
  if (!userId) return [];
  // 自己坐过的对局，以及自己这台场风盘主持过的对局
  return state.games.filter((g) =>
    (g.players || []).some((p) => p.userId === userId) || g.hostUserId === userId);
}

// 管理端：全部对局（已是倒序）
function allGames() {
  return state.games;
}

function deleteGame(id) {
  const i = state.games.findIndex((g) => g.id === id);
  if (i < 0) return false;
  state.games.splice(i, 1);
  save('games');
  return true;
}

module.exports = {
  state,
  DATA_DIR,
  loadAll,
  rebuildIndex,
  save,
  flushNow,
  publicUser,
  createUser,
  verifyUser,
  findUserByName,
  getUser,
  listUsers,
  adminUser,
  setPassword,
  createSession,
  userForToken,
  dropSession,
  getRoom,
  newRoomCode,
  putRoom,
  dropRoom,
  listRooms,
  saveGame,
  getGame,
  gamesForUser,
  allGames,
  deleteGame,
};
