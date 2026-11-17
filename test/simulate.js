'use strict';
/* 立直麻将 场风盘 —— 整场对局模拟自检（node test/simulate.js）
 *
 * 目的：真的把「一局半庄战」「一局东风战」从头打到终局，
 *       中间穿插真人打牌会遇到的各种情况（立直、荒牌流局、四种途中流局、
 *       击飞、和了终局、西入、烧鸡、本场、撤销、点数修正、再来一局），
 *       每一步都校验计分不变量，用来找出局推进与点数精算里的 bug。
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

// 独立数据目录，绝不碰真实 data/
process.env.RC_DATA_DIR = path.join(__dirname, '.simdata');
fs.rmSync(process.env.RC_DATA_DIR, { recursive: true, force: true });

const game = require(path.join(ROOT, 'lib', 'game.js'));
const scoring = require(path.join(ROOT, 'lib', 'scoring.js'));
const store = require(path.join(ROOT, 'lib', 'store.js'));

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra)));
  return false;
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(a === e, label + `  (期望 ${e})`, actual);
}

/* ------------------------- 房间搭建 ------------------------- */

let codeSeq = 4200;
function makeRoom(cfg) {
  const room = game.createRoom({ userId: 'u-host', name: '场风盘', config: cfg });
  room.code = String(++codeSeq);
  room.hostKey = 'hostkey-' + room.code;
  store.putRoom(room);
  const names = ['雀宝A', '雀宝B', '雀宝C', '雀宝D'];
  for (let i = 0; i < 4; i++) {
    game.joinSeat(room, { userId: 'u' + i, name: names[i], seat: i });
  }
  return room;
}

function startRoom(room, starter) {
  game.startGame(room);
  game.setStarter(room, starter === undefined ? 0 : starter);
  return room;
}

/* ------------------------- 不变量校验 ------------------------- */

let expectTotal = null; // 手动修正点数会合法地改变总额，之后用新基准

function resetExpect(room) {
  expectTotal = room.seats.reduce((a, s) => a + s.score, 0) + room.sticks * 1000;
}

function invariant(room, tag) {
  const sum = room.seats.reduce((a, s) => a + s.score, 0);
  const withSticks = sum + room.sticks * 1000;
  if (expectTotal === null) expectTotal = room.config.startScore * 4;
  ok(withSticks === expectTotal,
    `${tag}：点数守恒 合计${sum} + 供托${room.sticks * 1000} = ${withSticks}，应为 ${expectTotal}`, withSticks);

  for (const s of room.seats) {
    ok(Number.isInteger(s.score), `${tag}：${s.name} 点数是整数`, s.score);
    ok(Number.isInteger(s.wins) && s.wins >= 0, `${tag}：${s.name} 和了次数合法`, s.wins);
  }
  ok(Number.isInteger(room.sticks) && room.sticks >= 0, `${tag}：供托数合法`, room.sticks);
  ok(room.seats.every((s) => s.seat >= 0 && s.seat <= 3), `${tag}：席位号合法`);

  if (room.round.dealer !== null && room.round.dealer !== undefined) {
    eq(game.windOf(room, room.round.dealer), '东', `${tag}：庄家是东家`);
    ok(room.round.dealer >= 0 && room.round.dealer <= 3, `${tag}：庄家席位合法`, room.round.dealer);
    ok(room.round.num >= 1 && room.round.num <= 4, `${tag}：局数在 1..4`, room.round.num);
    ok(['E', 'S', 'W'].includes(room.round.wind), `${tag}：场风合法`, room.round.wind);
  }

  if (room.phase === 'ended') {
    const fr = room.finalRanking;
    ok(!!fr, `${tag}：终局有 finalRanking`);
    if (fr) {
      const ranks = fr.players.map((p) => p.rank).sort();
      eq(ranks, [1, 2, 3, 4], `${tag}：顺位是 1..4`);
      const diffSum = +fr.players.reduce((a, p) => a + p.diff, 0).toFixed(1);
      ok(Math.abs(diffSum) < 0.001, `${tag}：四家收支合计为 0`, diffSum);
      ok(!!game.END_REASON[fr.reason], `${tag}：终局原因已知`, fr.reason);
      eq(room.sticks, 0, `${tag}：终局后供托清零`);
    }
  } else {
    ok(room.phase === 'playing' || room.phase === 'lobby', `${tag}：阶段合法`, room.phase);
  }
  return room;
}

/* ------------------------- 动作封装（带校验） ------------------------- */

function actAgari(room, p, tag) {
  const before = room.hands.length;
  const beforeDealer = room.round.dealer;
  const beforeHonba = room.round.honba;
  const beforeWins = room.seats[p.winnerSeat].wins;
  const sticksBefore = room.sticks;
  const h = game.declareAgari(room, p);
  eq(room.hands.length, before + 1, `${tag}：牌谱新增一手`);
  eq(room.lastResult, h, `${tag}：lastResult 指向这手`);
  eq(h.scoresAfter, room.seats.map((s) => s.score), `${tag}：scoresAfter 与当前点数一致`);
  ok(h.gain > 0, `${tag}：gain 为正`, h.gain);
  // 供托：和了者收走全部立直棒（含自己那根）
  if (sticksBefore > 0) {
    ok(h.stickGain === sticksBefore * 1000, `${tag}：供托全额被和了者收走`, { stickGain: h.stickGain, sticksBefore });
    eq(room.sticks, 0, `${tag}：和了后供托清零`);
  }
  eq(room.seats[p.winnerSeat].wins, beforeWins + 1, `${tag}：和了者 win+1`);
  eq(h.gain, h.handTotal + h.stickGain, `${tag}：gain = 手牌点 + 供托`);
  // 连庄判定
  if (room.phase === 'playing') {
    if (h.renchan) {
      eq(room.round.dealer, beforeDealer, `${tag}：连庄则庄家不变`);
      eq(room.round.honba, beforeHonba + 1, `${tag}：连庄则本场 +1`);
    } else {
      eq(room.round.dealer, (beforeDealer + 1) % 4, `${tag}：下庄则庄家顺移`);
    }
  }
  return h;
}

function actDraw(room, p, tag) {
  const before = room.hands.length;
  const h = game.declareDraw(room, p);
  eq(room.hands.length, before + 1, `${tag}：牌谱新增一手`);
  eq(h.scoresAfter, room.seats.map((s) => s.score), `${tag}：scoresAfter 与当前点数一致`);
  ok(!!h.drawLabel, `${tag}：流局有名称`, h.drawType);
  return h;
}

/* ===================== 场景一：半庄战全场 ===================== */

function simulateHanchan() {
  const room = makeRoom({
    gameType: 'hanchan',
    startScore: 25000,
    kiriageMangan: true,
    agariYame: true,
    // 关掉击飞，让这局一定打满到南4；击飞单独在 simulateTobi 里验
    tobi: false,
    yakitori: true,
    westExtension: false,
    notenBappu: true,
  });
  startRoom(room, 0);
  resetExpect(room);
  invariant(room, '半庄·开局');
  eq(room.round.wind, 'E', '半庄·开局是东场');
  eq(room.round.dealer, 0, '半庄·起家 0');

  console.log('\n──── 半庄战（南4打切）牌谱 ────');
  const log = [];

  // 东1 亲0：子1 荣和 子2，2番30符
  let h = actAgari(room, { winnerSeat: 1, han: 2, fu: 30, tsumo: false, loserSeat: 2 }, '东1');
  eq(h.label, '2番30符', '东1：2番30符');
  eq(h.handTotal, 2000, '东1：子荣和 2番30符 = 2000');
  log.push(`东1 0本场　子1 荣和 子2　2番30符 2000`);
  invariant(room, '半庄·东1后');

  // 东2 亲1：亲家自摸 3番40符
  h = actAgari(room, { winnerSeat: 1, han: 3, fu: 40, tsumo: true }, '东2');
  eq(h.label, '3番40符', '东2：3番40符');
  eq(h.handTotal, 7800, '东2：亲自摸 3番40符 = 2600×3');
  eq(h.renchan, true, '东2：亲家和了连庄');
  log.push(`东2 0本场　子1(亲) 自摸　3番40符 7800　连庄`);
  invariant(room, '半庄·东2后');

  // 东2 1本场：两家立直 + 流局荒牌，亲听牌
  game.setRiichi(room, 2, true);
  game.setRiichi(room, 3, true);
  eq(room.sticks, 2, '东2 1本场：立直棒 2 根');
  const sumA = room.seats.reduce((a, s) => a + s.score, 0);
  invariant(room, '半庄·两家立直后');
  ok(sumA === 25000 * 4 - 2000, '立直扣点进供托，总额不变');
  h = actDraw(room, { type: 'exhaustive', tenpai: [false, true, false, false] }, '东2 1本场');
  eq(h.bappuTotal, 3000, '荒牌：一家听牌，罚符合计 3000');
  eq(h.payments.length, 3, '荒牌：三家不听各付一条');
  eq(h.renchan, true, '荒牌：亲听牌连庄');
  eq(room.sticks, 2, '流局后立直棒留在桌上');
  log.push(`东2 1本场　荒牌平局（亲听牌）　不听罚符 3000　连庄`);
  invariant(room, '半庄·东2 1本场后');

  // 东2 2本场：四开杠流局（途中流局）—— 亲无论如何都连庄
  h = actDraw(room, { type: 'fourKan', tenpai: [false, false, false, false] }, '东2 2本场');
  eq(h.renchan, true, '四开杠：途中流局庄家连庄');
  log.push(`东2 2本场　四开杠流局　连庄`);
  invariant(room, '半庄·东2 2本场后');

  // 东2 3本场：子2 荣和 亲1，满贯；亲下庄
  h = actAgari(room, { winnerSeat: 2, han: 5, fu: 30, tsumo: false, loserSeat: 1 }, '东2 3本场');
  eq(h.label, '满贯', '东2 3本场：5番=满贯');
  ok(h.renchan === false, '东2 3本场：子家和了，亲下庄');
  eq(room.round.dealer, 2, '东3 亲为 2');
  log.push(`东2 3本场　子2 荣和 亲1　满贯 8000+ 供托3000`);
  invariant(room, '半庄·东3开局');

  // 东3 亲2：切上满贯 4番30符
  h = actAgari(room, { winnerSeat: 0, han: 4, fu: 30, tsumo: true }, '东3');
  eq(h.label, '满贯（切上）', '东3：4番30符 走切上满贯');
  ok(h.renchan === false, '东3：子家自摸，亲下庄');
  log.push(`东3 0本场　子0 自摸　4番30符 切上满贯 8000`);
  invariant(room, '半庄·东4开局');

  // 东4 亲3：三家和了流局
  h = actDraw(room, { type: 'tripleRon', tenpai: [true, true, true, false] }, '东4');
  eq(h.renchan, true, '三家和了：途中流局庄家连庄');
  log.push(`东4 0本场　三家和了流局　连庄`);
  invariant(room, '半庄·东4 1本场');

  // 东4 1本场：亲3 役满自摸，连庄
  h = actAgari(room, { winnerSeat: 3, han: 13, fu: 40, tsumo: true }, '东4 1本场');
  eq(h.label, '役满', '东4 1本场：13番=役满');
  eq(h.handTotal, 48300, '役满亲自摸 = (16000+100本场)×3');
  eq(h.renchan, true, '东4 1本场：亲家役满连庄');
  log.push(`东4 1本场　子3(亲) 自摸　役满 48000　连庄`);
  invariant(room, '半庄·东4 2本场');

  // 东4 2本场：四风连打
  h = actDraw(room, { type: 'fourWind', tenpai: [false, true, false, false] }, '东4 2本场');
  eq(h.renchan, true, '四风连打：途中流局庄家连庄');
  log.push(`东4 2本场　四风连打流局　连庄`);

  // 东4 3本场：九种九牌
  h = actDraw(room, { type: 'kyuushu', tenpai: [false, false, true, false] }, '东4 3本场');
  eq(h.renchan, true, '九种九牌：途中流局庄家连庄');
  log.push(`东4 3本场　九种九牌流局　连庄`);

  // 东4 4本场：四家立直
  h = actDraw(room, { type: 'fourRiichi', tenpai: [true, true, true, true] }, '东4 4本场');
  eq(h.renchan, true, '四家立直：途中流局庄家连庄');
  log.push(`东4 4本场　四家立直流局　连庄`);
  invariant(room, '半庄·东4 5本场');

  // 东4 5本场：子0 荣和 子1，跳满 → 亲下庄，走完东场进南场
  h = actAgari(room, { winnerSeat: 0, han: 6, fu: 30, tsumo: false, loserSeat: 1 }, '东4 5本场');
  eq(h.label, '跳满', '东4 5本场：6番=跳满');
  eq(h.renchan, false, '东4 5本场：子家和了，亲下庄');
  eq(room.round.wind, 'S', '走完东4进南场');
  eq(room.round.num, 1, '南1局');
  log.push(`东4 5本场　子0 荣和 子1　跳满 12000+本场　→ 南1局`);
  invariant(room, '半庄·南1');

  // 手动改本场 + 撤销
  game.setHonba(room, 2);
  eq(room.round.honba, 2, '手动设置本场数');
  const snapshotHands = room.hands.length;
  h = actAgari(room, { winnerSeat: 2, han: 1, fu: 30, tsumo: false, loserSeat: 1 }, '南1 2本场');
  eq(h.honba, 2, '南1 2本场：记录本场数');
  eq(h.handTotal, 1000 + 600, '1番30符 子荣和 +2本场 = 1600');

  // 撤销这一手
  game.undo(room);
  eq(room.hands.length, snapshotHands, '撤销后牌谱回到上一手');
  eq(room.round.honba, 2, '撤销后本场数恢复');
  invariant(room, '半庄·撤销后');
  log.push(`南1 2本场　（测试撤销：和了一手又撤回）`);

  // 重打
  h = actAgari(room, { winnerSeat: 2, han: 1, fu: 30, tsumo: false, loserSeat: 1 }, '南1 2本场-重打');
  invariant(room, '半庄·南1 2本场后');

  // 一路打到终局：剩下的局都用「子家 2番30符 荣和 庄家」推进
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 80) {
    if (room.round.dealer === null) game.rollDice(room);
    const dealer = room.round.dealer;
    const loser = (dealer + 1) % 4;
    const winner = (dealer + 2) % 4;
    const roundTag = `${game.roundLabel(room)} ${room.round.honba}本场`;
    const hh = actAgari(room, { winnerSeat: winner, han: 2, fu: 30, tsumo: false, loserSeat: loser }, roundTag);
    log.push(`${roundTag}　${room.seats[winner].name} 荣和 ${room.seats[loser].name}　2番30符 2000`);
    invariant(room, '半庄·' + roundTag);
    ok(guard < 80, '半庄：局推进不超过 80 手');
    if (hh.renchan) log[log.length - 1] += '　连庄';
  }

  eq(room.phase, 'ended', '半庄：正常终局');
  eq(room.endReason, 'final', '半庄：打满终局');
  invariant(room, '半庄·终局');
  ok(room.hands.length > 10, '半庄：牌谱手数合理', room.hands.length);

  // 终局原因必须有中文
  eq(game.END_REASON[room.endReason], '打满终局', '终局原因文本');
  console.log(log.join('\n'));
  console.log(`（共 ${room.hands.length} 手，终局原因：${game.END_REASON[room.endReason]}）`);
  return room;
}

/* ===================== 场景二：东风战全场 ===================== */

function simulateTonpuusen() {
  const room = makeRoom({
    gameType: 'tonpuusen',
    startScore: 25000,
    kiriageMangan: true,
    agariYame: true,
    tobi: true,
    yakitori: true,
    westExtension: true, // 东风战不该有西入，用来验证它被忽略
    notenBappu: true,
  });
  startRoom(room, 0);
  resetExpect(room);
  invariant(room, '东风·开局');

  console.log('\n──── 东风战牌谱 ────');
  const log = [];

  // 东1：荒牌全不听（无罚符）
  let h = actDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] }, '东风·东1');
  eq(h.bappuTotal, 0, '东风·东1：四家全不听无罚符');
  eq(h.renchan, false, '东风·东1：亲不听下庄');
  log.push('东1 0本场　荒牌（全不听）　无罚符　亲下庄');

  // 东2：荒牌三家听牌
  h = actDraw(room, { type: 'exhaustive', tenpai: [true, true, true, false] }, '东风·东2');
  eq(h.bappuTotal, 3000, '东风·东2：三听一不听，罚符 3000');
  eq(h.payments.length, 3, '东风·东2：一个不听者付三家');
  log.push('东2 0本场　荒牌（三听）　不听者付 3000');

  // 东3：两家立直 + 二家听牌流局
  game.setRiichi(room, 1, true);
  game.setRiichi(room, 2, true);
  h = actDraw(room, { type: 'exhaustive', tenpai: [true, true, false, false] }, '东风·东3');
  eq(h.bappuTotal, 3000, '东风·东3：二听二不听，罚符 3000');
  eq(h.payments.length, 4, '东风·东3：2×2 四条转移');
  log.push('东3 0本场　两家立直后荒牌（二听）　罚符 3000');

  // 东4：先确认不是和了终局的情况，正常打完
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 40) {
    const dealer = room.round.dealer;
    const roundTag = `${game.roundLabel(room)} ${room.round.honba}本场`;
    // 子家自摸 1番30符，确保亲下庄、推进局数
    const winner = (dealer + 1) % 4;
    actAgari(room, { winnerSeat: winner, han: 1, fu: 30, tsumo: true }, roundTag);
    log.push(`${roundTag}　${room.seats[winner].name} 子自摸 1番30符（东4 前推进）`);
    invariant(room, '东风·' + roundTag);
  }

  eq(room.phase, 'ended', '东风：正常终局');
  eq(room.endReason, 'final', '东风：打满终局（东4 结束）');
  ok(room.hands.length <= 40, '东风：手数没有无限增长', room.hands.length);
  console.log(log.join('\n'));
  console.log(`（共 ${room.hands.length} 手，终局原因：${game.END_REASON[room.endReason]}）`);
  return room;
}

/* ===================== 场景三：击飞终局 ===================== */

function simulateTobi() {
  const room = makeRoom({ gameType: 'hanchan', tobi: true, agariYame: false, yakitori: false });
  startRoom(room, 0);
  resetExpect(room);

  // 把 3 号位点数压到 2000（点数修正要守恒，否则收支合计不为 0）
  game.adjustScores(room, [25000, 25000, 48000, 2000]);
  resetExpect(room);
  invariant(room, '击飞·修正后');

  // 3 号位被役满荣和 → -30000 出头
  const h = actAgari(room, { winnerSeat: 0, han: 13, fu: 40, tsumo: false, loserSeat: 3 }, '击飞');
  ok(room.seats[3].score < 0, '击飞：被击飞者点数为负', room.seats[3].score);
  eq(room.phase, 'ended', '击飞：立即终局');
  eq(room.endReason, 'tobi', '击飞：终局原因 tobi');
  invariant(room, '击飞·终局');
  eq(h.handTotal, 48000, '击飞：亲家役满荣和 48000');
  ok(room.finalRanking.players[3].rank === 4, '击飞：垫底顺位 4');
  return room;
}

/* ===================== 场景四：和了终局 ===================== */

function simulateAgariYame() {
  const room = makeRoom({ gameType: 'tonpuusen', agariYame: true, tobi: true, yakitori: false });
  startRoom(room, 0);
  resetExpect(room);

  // 直接把局面推到东4：让亲家一直是 0 号位并每局连庄不现实，
  // 这里用手动点数 + 循环推进到东4。
  let guard = 0;
  while (room.phase === 'playing' && !(room.round.wind === 'E' && room.round.num === 4) && guard++ < 20) {
    const dealer = room.round.dealer;
    actAgari(room, { winnerSeat: (dealer + 1) % 4, han: 1, fu: 30, tsumo: true }, '和了终局·推进');
    invariant(room, '和了终局·推进');
  }
  eq(room.phase, 'playing', '和了终局：能推进到东4');
  eq(room.round.wind, 'E', '和了终局：在东场');
  eq(room.round.num, 4, '和了终局：东4局');

  const dealer = room.round.dealer;

  // 让庄家成为一位
  const scores = room.seats.map((s) => s.score);
  let maxOther = -Infinity;
  for (let i = 0; i < 4; i++) if (i !== dealer) maxOther = Math.max(maxOther, scores[i]);
  scores[dealer] = Math.max(scores[dealer], maxOther + 10000);
  // 保持总额不变：从其他家按比例扣
  const diff = scores[dealer] - room.seats[dealer].score;
  const others = [0, 1, 2, 3].filter((i) => i !== dealer);
  let left = diff;
  for (let k = 0; k < others.length && left > 0; k++) {
    const take = Math.min(left, Math.max(0, scores[others[k]] - 1000));
    scores[others[k]] -= take;
    left -= take;
  }
  if (left > 0) scores[dealer] -= left;
  game.adjustScores(room, scores);
  resetExpect(room);
  eq(game.topSeat(room), dealer, '和了终局：庄家已是一位');

  const h = actAgari(room, { winnerSeat: dealer, han: 2, fu: 30, tsumo: true }, '和了终局·东4');
  eq(h.renchan, true, '和了终局：庄家和了连庄');
  eq(room.phase, 'ended', '和了终局：立即终局');
  eq(room.endReason, 'agariyame', '和了终局：原因 agariyame');
  invariant(room, '和了终局·终局');
  return room;
}

/* ===================== 场景五：西入 ===================== */

function simulateWestExtension() {
  const room = makeRoom({
    gameType: 'hanchan', agariYame: false, tobi: false, westExtension: true,
    notenBappu: true, yakitori: false, startScore: 25000,
  });
  startRoom(room, 0);
  resetExpect(room);

  // 一路用「小额子家自摸」推进，避免任何人超过 30000
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 120) {
    const dealer = room.round.dealer;
    const winner = (dealer + 1) % 4;
    const roundTag = `${game.roundLabel(room)} ${room.round.honba}本场`;
    actAgari(room, { winnerSeat: winner, han: 1, fu: 30, tsumo: true }, roundTag);
    invariant(room, '西入·' + roundTag);
    // 一旦有人过 30000 立即停止循环（终局判定应已结束对局）
    if (room.phase === 'ended') break;
  }
  eq(room.phase, 'ended', '西入：最终会终局');
  ok(['westLine', 'final'].includes(room.endReason), '西入：终局原因合理', room.endReason);
  // 西入成立时局数应曾到达西场
  const wentWest = room.hands.some((h) => /^西/.test(h.round));
  ok(wentWest || room.endReason === 'final', '西入：确实进过西场（或南4就有人达标）', room.endReason);
  invariant(room, '西入·终局');
  return room;
}

/* ===================== 场景六：烧鸡精算 ===================== */

function simulateYakitori() {
  const room = makeRoom({ gameType: 'tonpuusen', yakitori: true, tobi: false, agariYame: false });
  startRoom(room, 0);
  resetExpect(room);

  // 只让 1 号位和牌，其余三家全程不和 → 三家烧鸟
  const h = actAgari(room, { winnerSeat: 1, han: 1, fu: 30, tsumo: false, loserSeat: 2 }, '烧鸡·东1');
  invariant(room, '烧鸡·东1后');
  game.endGame(room, 'manual');
  invariant(room, '烧鸡·终局');

  const fr = room.finalRanking;
  eq(fr.yakitori, true, '烧鸡：终局标记 yakitori');
  const w = fr.players.find((p) => p.seat === 1);
  const birds = fr.players.filter((p) => p.seat !== 1);
  eq(w.yakitori, 3000, '烧鸡：和牌者收 1000×3');
  birds.forEach((b) => eq(b.yakitori, -1000, `烧鸡：${b.name} 付 1000`));
  eq(birds.reduce((a, b) => a + b.yakitori, 0) + w.yakitori, 0, '烧鸡：收支合计为 0');
  return room;
}

/* ===================== 场景七：非法输入必须报错而不是崩 ===================== */

function simulateBadInput() {
  const room = makeRoom({ gameType: 'hanchan', tobi: false, agariYame: false });
  startRoom(room, 0);
  resetExpect(room);

  const throwsClean = (fn, label) => {
    try {
      fn();
      ok(false, label + '：应当报错');
    } catch (e) {
      ok(!(e instanceof TypeError) && !(e instanceof RangeError),
        label + '：报的是业务错误而不是运行时异常（' + e.constructor.name + '）', e.message);
      ok(/[\u4e00-\u9fa5]/.test(e.message), label + '：错误信息是中文', e.message);
    }
  };

  // 放铳者席次越界
  throwsClean(() => game.declareAgari(room, { winnerSeat: 0, han: 2, fu: 30, tsumo: false, loserSeat: 9 }), '放铳者=9');
  throwsClean(() => game.declareAgari(room, { winnerSeat: 0, han: 2, fu: 30, tsumo: false, loserSeat: -1 }), '放铳者=-1');
  // 和了者越界 / 空席
  throwsClean(() => game.declareAgari(room, { winnerSeat: 7, han: 2, fu: 30, tsumo: true }), '和了者=7');
  throwsClean(() => game.declareAgari(room, { winnerSeat: 0, han: 0, fu: 30, tsumo: true }), '番数=0');
  throwsClean(() => game.declareAgari(room, { winnerSeat: 0, han: 2, fu: 15, tsumo: true }), '符=15');
  throwsClean(() => game.declareAgari(room, { winnerSeat: 0, han: 99, fu: 30, tsumo: true }), '番数=99');
  // 点数修正传入垃圾
  throwsClean(() => game.adjustScores(room, [1, 2, 3]), '点数只有 3 个');
  throwsClean(() => game.adjustScores(room, [1, 2, 3, 'abc']), '点数含非数字');
  throwsClean(() => game.adjustScores(room, [1, 2, 3, NaN]), '点数含 NaN');
  // 流局种类非法
  throwsClean(() => game.declareDraw(room, { type: 'nonsense' }), '流局种类非法');
  // 立直：点数为负数的席位不能立直
  game.adjustScores(room, [25000, 25000, 25000, 500]);
  resetExpect(room);
  throwsClean(() => game.setRiichi(room, 3, true), '点数 500 不能立直');

  invariant(room, '非法输入后仍然自洽');
  return room;
}

/* ===================== 场景八：再来一局 ===================== */

function simulateRematch() {
  const room = makeRoom({ gameType: 'tonpuusen', tobi: true });
  startRoom(room, 0);
  resetExpect(room);
  const hostKey = room.hostKey;
  game.endGame(room, 'manual');
  eq(room.phase, 'ended', '再来一局：先终局');

  game.resetForRematch(room);
  eq(room.phase, 'lobby', '再来一局：回到大厅');
  eq(room.hostKey, hostKey, '再来一局：保持主持凭证');
  eq(room.seats.filter((s) => s.userId).length, 4, '再来一局：四个席位都还在');
  eq(room.seats.map((s) => s.name), ['雀宝A', '雀宝B', '雀宝C', '雀宝D'], '再来一局：玩家名保留');
  eq(room.hands.length, 0, '再来一局：牌谱清空');
  eq(room.sticks, 0, '再来一局：供托清零');
  eq(room.finalRanking, null, '再来一局：清掉上一场排名');
  ok(room.seats.every((s) => s.score === 25000), '再来一局：点数复位');

  game.startGame(room);
  eq(room.phase, 'playing', '再来一局：能直接再开');
  resetExpect(room);
  invariant(room, '再来一局·重开');
  return room;
}

/* ===================== 场景九：点数计算口径 ===================== */

function checkScoringTable() {
  const cases = [
    // [han, fu, tsumo, isDealer, expectedTotal, label]
    [1, 30, false, false, 1000, '1番30符 子荣和'],
    [1, 30, false, true, 1500, '1番30符 亲荣和'],
    [1, 30, true, false, 1100, '1番30符 子自摸 300/500'],
    [2, 30, false, false, 2000, '2番30符 子荣和'],
    [3, 30, false, false, 3900, '3番30符 子荣和'],
    [4, 30, false, false, 8000, '4番30符 子荣和（切上满贯）'],
    [3, 60, false, false, 8000, '3番60符 子荣和（切上满贯）'],
    [4, 40, false, false, 8000, '4番40符 子荣和（满贯）'],
    [5, 30, false, false, 8000, '5番 满贯'],
    [6, 30, false, false, 12000, '6番 跳满'],
    [8, 30, false, false, 16000, '8番 倍满'],
    [11, 30, false, false, 24000, '11番 三倍满'],
    [13, 30, false, false, 32000, '13番 役满'],
    [26, 30, false, false, 64000, '26番 两倍役满'],
    [3, 40, true, false, 2600 + 1300 + 1300, '3番40符 子自摸 1300/2600'],
    [4, 30, true, true, 4000 * 3, '4番30符 亲自摸 4000 all'],
  ];
  for (const [han, fu, tsumo, dealer, expected, label] of cases) {
    const r = scoring.calcHand({
      han, fu, tsumo, winnerSeat: dealer ? 0 : 1, dealerSeat: 0,
      loserSeat: tsumo ? null : 2, kiriageMangan: true,
    });
    eq(r.handTotal, expected, '点数口径：' + label);
  }
  // 关掉切上满贯后 4番30符 应回落到 7700
  const noKiriage = scoring.calcHand({
    han: 4, fu: 30, tsumo: false, winnerSeat: 1, dealerSeat: 0, loserSeat: 2, kiriageMangan: false,
  });
  eq(noKiriage.handTotal, 7700, '点数口径：关掉切上满贯 4番30符 = 7700');
  eq(noKiriage.label, '4番30符', '点数口径：关掉切上满贯原名');
}

/* ===================== 运行 ===================== */

const started = Date.now();
try {
  checkScoringTable();
  const han = simulateHanchan();
  const ton = simulateTonpuusen();
  const tobi = simulateTobi();
  const yame = simulateAgariYame();
  const west = simulateWestExtension();
  const yaki = simulateYakitori();
  simulateBadInput();
  simulateRematch();

  // 终局记录能落库、能被历史查询到
  const rec = game.buildGameRecord(han);
  eq(rec.players.length, 4, '对局记录：四名玩家');
  eq(rec.hands.length, han.hands.length, '对局记录：牌谱完整');
  ok(rec.players.every((p) => p.rank >= 1 && p.rank <= 4), '对局记录：每人都带顺位');
  ok(rec.players.every((p) => typeof p.diff === 'number'), '对局记录：每人都带收支');
  ok(!!rec.endReasonText, '对局记录：终局原因有中文');
  store.saveGame(rec);
  eq(store.getGame(rec.id).id, rec.id, '对局记录：能按 id 取回');
  eq(store.gamesForUser('u1').length, 1, '对局记录：玩家历史能查到');
} catch (e) {
  fails.push('模拟过程抛出异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
}

console.log('\n=== 对局模拟自检 ===');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项　耗时 ${Date.now() - started}ms`);
if (fails.length) {
  console.log('\n失败明细：');
  fails.forEach((f) => console.log('  ✗ ' + f));
}
try { fs.rmSync(process.env.RC_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fails.length ? 1 : 0);
