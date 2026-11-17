'use strict';

/**
 * 批量删账号，只留下你点名要保留的那几个。
 *
 *   node service/prune-users.js --dry-run Bagpipe BagpipeQAQ     # 先看会删谁（不动数据）
 *   node service/prune-users.js Bagpipe BagpipeQAQ               # 真删
 *
 * 参数：
 *   --dry-run          只打印，不写盘
 *   --include-admins   连管理员账号一起删（默认跳过管理员，避免把管理端删到没人能进）
 *   --with-games       顺带删掉「只要有一个被删玩家参与」的对局历史（含你自己打的那几场）
 *   --with-orphan-games  只删「四个人全是被删账号」的对局历史（纯测试局），留着你和朋友真打的
 *
 * 它会做三件事：
 *   1) 删账号；2) 清掉被删账号的登录令牌（否则那个设备的 60 天令牌还挂着）；
 *   3) 空出房间里的席位（否则座位被一个已经不存在的账号永久占着）。
 *
 * 老规矩：**先停服务**（service\stop.cmd），跑完再 service\start.cmd。
 * 不停服务的话，服务内存里的旧 state 会在下次刷盘时把人写回来。
 */

const fs = require('fs');
const path = require('path');
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const includeAdmins = argv.includes('--include-admins');
const withGames = argv.includes('--with-games');
const withOrphanGames = argv.includes('--with-orphan-games');
const keepNames = argv.filter((a) => !a.startsWith('--'));

if (!keepNames.length) {
  console.error('用法：node service\\prune-users.js [--dry-run] [--include-admins] [--with-games] <要保留的昵称...>');
  process.exit(1);
}

store.loadAll();

const keep = new Set(keepNames.map((n) => n.trim().toLowerCase()));
const all = Object.values(store.state.users);

const toDelete = [];
const kept = [];
const skippedAdmin = [];
const notFound = [];

for (const u of all) {
  if (keep.has(u.name.toLowerCase())) { kept.push(u); continue; }
  if (u.role === 'admin' && !includeAdmins) { skippedAdmin.push(u); continue; }
  toDelete.push(u);
}
for (const n of keepNames) {
  if (!all.some((u) => u.name.toLowerCase() === n.trim().toLowerCase())) notFound.push(n);
}

if (!toDelete.length) {
  console.log('没有需要删除的账号。当前账号：' + all.map((u) => u.name).join('、'));
  process.exit(0);
}

// 预演：算清会影响多少令牌、多少席位、多少对局
const delIds = new Set(toDelete.map((u) => u.id));
const tokensHit = Object.entries(store.state.sessions).filter(([, s]) => s && delIds.has(s.userId));
const seatHits = [];
const hostHits = [];
for (const room of Object.values(store.state.rooms)) {
  for (const s of room.seats || []) {
    if (s.userId && delIds.has(s.userId)) seatHits.push({ room: room.code, seat: s.seat, name: s.name });
  }
  if (room.hostUserId && delIds.has(room.hostUserId)) hostHits.push({ room: room.code, name: room.hostName });
}
const gamesHit = store.allGames().filter((g) => (g.players || []).some((p) => p.userId && delIds.has(p.userId)));
// 「孤儿局」：四个人全是被删账号 —— 这种局多半是自测产生的，删掉不留遗憾
const orphanGames = gamesHit.filter((g) => {
  const real = (g.players || []).filter((p) => p.userId && !String(p.userId).startsWith('guest:'));
  return real.length > 0 && real.every((p) => delIds.has(p.userId));
});
const gamesToDrop = withGames ? gamesHit : withOrphanGames ? orphanGames : [];

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('==============================================');
console.log(dryRun ? '【预演】不会改动任何数据' : '【执行】删除以下账号');
console.log('保留：' + kept.map((u) => u.name).join('、') + (skippedAdmin.length ? '（另跳过管理员：' + skippedAdmin.map((u) => u.name).join('、') + '）' : ''));
console.log('----------------------------------------------');
console.log(pad('昵称', 14) + pad('角色', 8) + '创建日期');
for (const u of toDelete) {
  console.log(pad(u.name, 14) + pad(u.role || 'player', 8) + new Date(u.createdAt).toISOString().slice(0, 10));
}
console.log('----------------------------------------------');
console.log('共 ' + toDelete.length + ' 个账号；连带清理 ' + tokensHit.length + ' 个登录令牌、' + seatHits.length + ' 个座位');
for (const s of seatHits) console.log('    空出座位：房间 ' + s.room + ' 第 ' + (s.seat + 1) + ' 席（' + s.name + '）');
for (const h of hostHits) console.log('    ⚠ 房间 ' + h.room + ' 的场风盘是 ' + h.name + '，删掉后这个房间没有主持人了');
if (gamesHit.length) {
  console.log('    对局历史：' + gamesHit.length + ' 条里出现过这些人，其中 ' + orphanGames.length + ' 条四个玩家全是被删账号（纯测试局）');
  console.log('    当前选择：' + (gamesToDrop.length ? '删除 ' + gamesToDrop.length + ' 条历史' : '历史全部保留'));
  if (!gamesToDrop.length) console.log('    要连历史一起删：加 --with-orphan-games（只删纯测试局）或 --with-games（含你真打的）');
}
if (notFound.length) console.log('    注意：这些昵称不存在 —— ' + notFound.join('、'));
console.log('==============================================');

if (dryRun) process.exit(0);

// 备份一份再动手
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(store.DATA_DIR, 'users.backup-' + stamp + '.json');
try {
  fs.writeFileSync(backup, JSON.stringify(Object.fromEntries(all.map((u) => [u.id, u])), null, 2));
  console.log('备份已写到：' + backup);
} catch (e) {
  console.error('备份失败，已中止：' + e.message);
  process.exit(1);
}

for (const u of toDelete) delete store.state.users[u.id];
for (const [tok] of tokensHit) delete store.state.sessions[tok];
for (const room of Object.values(store.state.rooms)) {
  for (const s of room.seats || []) {
    if (s.userId && delIds.has(s.userId)) { s.userId = null; s.name = ''; s.joinedAt = null; }
  }
  if (room.hostUserId && delIds.has(room.hostUserId)) { room.hostUserId = null; room.hostName = ''; }
}
if (gamesToDrop.length) {
  const ids = new Set(gamesToDrop.map((g) => g.id));
  store.state.games = store.state.games.filter((g) => !ids.has(g.id));
  store.save('games');
}

store.save('users');
store.save('sessions');
store.save('rooms');
store.flushNow();

console.log('完成。剩余账号 ' + Object.keys(store.state.users).length + ' 个：' + Object.values(store.state.users).map((u) => u.name + '(' + (u.role || 'player') + ')').join('、'));
