'use strict';
/* 立直麻将 场风盘 —— 逻辑自测（node test/run-tests.js） */

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
// 测试用独立数据目录，避免污染真实的 data/（必须在 require store 之前设置）
process.env.RC_DATA_DIR = path.join(__dirname, '.data');
fs.rmSync(process.env.RC_DATA_DIR, { recursive: true, force: true });
const scoring = require(path.join(ROOT, 'lib', 'scoring.js'));
const game = require(path.join(ROOT, 'lib', 'game.js'));

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
function total(room) { return room.seats.reduce((s, x) => s + x.score, 0) + (room.sticks || 0) * 1000; }

/* ============================ 1. 点数计算 ============================ */

function testScoring() {
  const G = (o) => {
    const merged = Object.assign({ dealerSeat: 0, winnerSeat: 1, kiriageMangan: true }, o);
    if (!merged.tsumo) {
      if (merged.loserSeat === undefined || merged.loserSeat === merged.winnerSeat) merged.loserSeat = (merged.winnerSeat + 1) % 4;
    }
    return scoring.calcHand(merged);
  };

  eq(G({ han: 3, fu: 30, tsumo: false, loserSeat: 0 }).handTotal, 3900, '闲家荣和 30符3番');
  eq(G({ han: 3, fu: 30, tsumo: false, loserSeat: 0, winnerSeat: 0 }).handTotal, 5800, '庄家荣和 30符3番');
  eq(G({ han: 3, fu: 30, tsumo: true }).handTotal, 4000, '闲家自摸 30符3番 合計');
  eq(G({ han: 3, fu: 30, tsumo: true }).payments.map((p) => p.amount), [2000, 1000, 1000], '闲家自摸 30符3番 明细(庄家2000/子1000)');
  eq(G({ han: 3, fu: 30, tsumo: true, winnerSeat: 0 }).handTotal, 6000, '庄家自摸 30符3番 每家 2000');
  eq(G({ han: 2, fu: 20, tsumo: true }).handTotal, 1500, '平和自摸 20符2番 400/400/700');
  eq(G({ han: 2, fu: 25, tsumo: false, loserSeat: 0 }).handTotal, 1600, '七对子 25符2番 1600');
  eq(G({ han: 4, fu: 40, tsumo: false, loserSeat: 0 }).handTotal, 8000, '闲家荣和 40符4番 = 满贯 8000');
  eq(G({ han: 4, fu: 30, tsumo: false, loserSeat: 0 }).handTotal, 8000, '切上满贯 30符4番 = 8000');
  eq(G({ han: 3, fu: 60, tsumo: false, loserSeat: 0 }).handTotal, 8000, '切上满贯 60符3番 = 8000');
  ok(scoring.limitOf(3, 60, false).base === 1920, '关闭切上满贯时 60符3番 = 1920基本点', scoring.limitOf(3, 60, false));
  eq(G({ han: 5, fu: 30, tsumo: false, loserSeat: 0 }).handTotal, 8000, '满贯 5番 闲家荣和 8000');
  eq(G({ han: 6, fu: 30, tsumo: false, loserSeat: 0 }).handTotal, 12000, '跳满 6番 闲家荣和 12000');
  eq(G({ han: 8, fu: 30, tsumo: false, loserSeat: 0 }).handTotal, 16000, '倍满 8番 闲家荣和 16000');
  eq(G({ han: 11, fu: 30, tsumo: false, loserSeat: 0 }).handTotal, 24000, '三倍满 11番 闲家荣和 24000');
  eq(G({ han: 13, fu: 30, tsumo: false, loserSeat: 0 }).handTotal, 32000, '役满 13番 闲家荣和 32000');
  eq(G({ han: 13, fu: 30, tsumo: false, loserSeat: 0, winnerSeat: 0 }).handTotal, 48000, '役满 庄家荣和 48000');
  eq(G({ han: 26, fu: 30, tsumo: true, winnerSeat: 0 }).handTotal, 96000, '二倍役满 庄家自摸 3每家 2000');
  eq(G({ han: 3, fu: 30, tsumo: false, loserSeat: 0, honba: 2 }).handTotal, 4500, '本場2 闲家荣和 3900+600');
  eq(G({ han: 3, fu: 30, tsumo: true, honba: 2 }).handTotal, 4600, '本場2 闲家自摸 4000+300');
  eq(G({ han: 3, fu: 30, tsumo: false, loserSeat: 0, sticks: 2 }).gain, 5900, '供託2本 合计收入');

  // 不听罚符：罚符池固定 3000，不听者按人数均摊、听牌者按人数均分
  const netBappu = (t) => {
    const pay = [0, 0, 0, 0], recv = [0, 0, 0, 0];
    for (const p of scoring.notenPenalty(t)) { pay[p.from] += p.amount; recv[p.to] += p.amount; }
    return { pay, recv };
  };
  const b0 = netBappu([false, false, false, false]);
  eq(b0.pay, [0, 0, 0, 0], '全不听 → 无罚符支付');
  eq(b0.recv, [0, 0, 0, 0], '全不听 → 无罚符收入');
  const b4 = netBappu([true, true, true, true]);
  eq(b4.pay, [0, 0, 0, 0], '全听 → 无罚符支付');
  eq(b4.recv, [0, 0, 0, 0], '全听 → 无罚符收入');
  const b1 = netBappu([true, false, false, false]);
  eq(b1.pay, [0, 1000, 1000, 1000], '1人听牌 → 不听者各付 1000');
  eq(b1.recv, [3000, 0, 0, 0], '1人听牌 → 听牌者收 3000');
  const b2 = netBappu([true, true, false, false]);
  eq(b2.pay, [0, 0, 1500, 1500], '2人听牌 → 不听者各付 1500');
  eq(b2.recv, [1500, 1500, 0, 0], '2人听牌 → 听牌者各收 1500');
  const b3 = netBappu([true, true, true, false]);
  eq(b3.pay, [0, 0, 0, 3000], '3人听牌 → 不听者付 3000');
  eq(b3.recv, [1000, 1000, 1000, 0], '3人听牌 → 听牌者各收 1000');
  eq(scoring.notenPenalty([true, false, true, false]).every((p) => Number.isInteger(p.amount)), true, '罚符额恒为整数（无取整误差）');
  eq(scoring.notenSummary([true, true, false, false]), { none: false, perNoten: 1500, perTenpai: 1500, nNoten: 2, nTenpai: 2 }, 'notenSummary 2听2不听');
  eq(scoring.notenSummary([true, true, true, true]), { none: true, perNoten: 0, perTenpai: 0, nNoten: 0, nTenpai: 4 }, 'notenSummary 全听 → none');
  eq(scoring.notenSummary([true, false, false, false]), { none: false, perNoten: 1000, perTenpai: 3000, nNoten: 3, nTenpai: 1 }, 'notenSummary 1听3不听');

  // 顺位精算：只按起始点数算收支，无任何加成
  const st = scoring.settle(
    [{ seat: 0, score: 45000 }, { seat: 1, score: 30000 }, { seat: 2, score: 20000 }, { seat: 3, score: 5000 }],
    { startScore: 25000 }, 0);
  eq(st.map((x) => x.rank), [1, 2, 3, 4], '顺位判定');
  eq(st[0].diff, 20, '一位 45000 → (45-25) = +20.0');
  eq(st[3].diff, -20, '四位 5000 → (5-25) = -20.0');
  eq(st[1].diff, 5, '二位 30000 → +5.0');
  ok(Math.abs(st.reduce((a, x) => a + x.diff, 0)) < 0.01, '四人收支恒为 0', st.map((x) => x.diff));
  ok(st[0].uma === undefined && st[0].oka === undefined && st[0].total === undefined, '不再输出顺位马／返点加成');
}

/* ============================ 2. 对局流程 ============================ */

function makeRoom(cfg) {
  const room = game.createRoom({ userId: 'host', name: '场风盘', config: cfg || {} });
  room.code = '1234';
  for (let i = 0; i < 4; i++) game.joinSeat(room, { userId: 'u' + i, name: 'P' + i, seat: i });
  return room;
}

function testFlow() {
  const room = makeRoom({ gameType: 'tonpuusen' });
  eq(room.seats.map((s) => s.userId), ['u0', 'u1', 'u2', 'u3'], '四人入座');

  let err = null;
  try { game.startGame(room); } catch (e) { err = e.message; }
  ok(!err, '开始对局');
  eq(room.seats.map((s) => s.score), [25000, 25000, 25000, 25000], '起始点数');
  eq(room.phase, 'playing', '进入对局状态');

  // 掷骰定起家
  game.rollDice(room);
  ok(room.starterSeat !== null && room.round.dealer === room.starterSeat, '掷骰后确定起家与庄家');
  ok(room.round.dice.d1 >= 1 && room.round.dice.d1 <= 6 && room.round.dice.sum === room.round.dice.d1 + room.round.dice.d2, '骰子点数范围正确');

  const dealer = room.round.dealer;
  // 立直：自动扣 1000
  game.setRiichi(room, 1, true);
  eq(room.seats[1].score, 24000, '立直自动扣 1000 点');
  eq(room.sticks, 1, '供託 +1 本');
  eq(total(room), 100000, '立直后点数守恒（1000 点进入供託）');
  game.setRiichi(room, 1, false);
  eq(room.seats[1].score, 25000, '取消立直退回 1000 点');
  eq(room.sticks, 0, '供託 -1 本');
  game.setRiichi(room, 1, true);

  // 子家自摸（和了者避开庄家）
  const child = (dealer + 1) % 4;
  const hand = game.declareAgari(room, { winnerSeat: child, tsumo: true, han: 3, fu: 30 });
  eq(hand.round, '东1局', '局数标记');
  ok(room.sticks === 0, '和了后供託清零');
  eq(total(room), 100000, '和了后点数守恒');
  eq(room.seats[1].riichi, false, '和了后立直状态清零');
  ok(room.seats[child].wins === 1, '和了次数 +1');
  eq(room.round.num, 2, '庄家下庄 → 进入东2局');
  eq(room.seats[room.round.dealer].seat, (dealer + 1) % 4, '亲移动到下家');

  // 荒牌平局：亲不听、其余三家听牌
  const before = total(room);
  const curDealer = room.round.dealer;
  const tp1 = [true, true, true, true];
  tp1[curDealer] = false;
  const d = game.declareDraw(room, { type: 'exhaustive', tenpai: tp1 });
  eq(d.bappuTotal, 3000, '荒牌平局罚符 3000');
  eq(total(room), before, '流局后点数守恒');
  eq(room.round.dealer, (curDealer + 1) % 4, '庄家不听 → 庄家下庄到下家');
  eq(room.round.num, 3, '进入东3局');
  eq(room.round.honba, 0, '庄家下庄时本场归零');

  // 庄家听牌 → 连庄 + 本场 +1
  const dealer2 = room.round.dealer;
  const hb = room.round.honba;
  const tenpai2 = [false, false, false, false];
  tenpai2[dealer2] = true;
  game.declareDraw(room, { type: 'exhaustive', tenpai: tenpai2 });
  eq(room.round.dealer, dealer2, '庄家听牌 → 连庄');
  eq(room.round.num, 3, '连庄时局数不变');
  eq(room.round.honba, hb + 1, '连庄时本场 +1');

  // 撤销
  const snapNum = room.round.num, snapHonba = room.round.honba;
  game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
  game.undo(room);
  eq(room.round.num, snapNum, '撤销恢复局数');
  eq(room.round.honba, snapHonba, '撤销恢复本场');
  eq(total(room), 100000, '撤销后点数守恒');

  // 东风战：打到东4局后终局
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 40) {
    game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
  }
  eq(room.phase, 'ended', '东风战打完');
  eq(room.endReason, 'final', '终局原因 = 打满');
  ok(room.round.wind === 'E' && room.round.num === 4, '停在东4局', game.roundLabel(room));
  eq(total(room), 100000, '终局点数守恒');
  ok(room.finalRanking && room.finalRanking.players.length === 4, '生成顺位结算');
  ok(Math.abs(room.finalRanking.players.reduce((a, p) => a + p.diff, 0)) < 0.05, '收支总计为 0');
}

/* ============================ 3. 特殊终局 ============================ */

function testTobi() {
  const room = makeRoom({ gameType: 'hanchan', tobi: true });
  game.startGame(room);
  game.rollDice(room);
  const dealer = room.round.dealer;
  const child = (dealer + 1) % 4;
  // 直接把子家点数打到 0 未满
  room.seats[child].score = 500;
  game.declareAgari(room, { winnerSeat: dealer, tsumo: true, han: 13, fu: 30 });
  ok(room.seats[child].score < 0, '被击飞者点数 < 0', room.seats[child].score);
  eq(room.phase, 'ended', '击飞终局');
  eq(room.endReason, 'tobi', '终局原因 = 击飞');
}

function testAgariYame() {
  const room = makeRoom({ gameType: 'tonpuusen', agariYame: true });
  game.startGame(room);
  game.rollDice(room);
  const starter = room.starterSeat;
  room.seats[starter].score = 60000;
  room.seats[(starter + 1) % 4].score = 20000;
  room.seats[(starter + 2) % 4].score = 10000;
  room.seats[(starter + 3) % 4].score = 10000;
  // 快进到东4局，庄家 = 起家
  room.round = { wind: 'E', num: 4, honba: 0, dealer: starter, dice: null };
  game.declareAgari(room, { winnerSeat: starter, tsumo: true, han: 4, fu: 30 });
  eq(room.phase, 'ended', '最后一局庄家和了且第一 → 和了终局');
  eq(room.endReason, 'agariyame', '终局原因 = 和了终局');
}

function testWestExtension() {
  const room = makeRoom({ gameType: 'hanchan', westExtension: true, tobi: false });
  game.startGame(room);
  game.rollDice(room);
  const starter = room.starterSeat;
  room.seats[starter].score = 29000;
  room.seats[(starter + 1) % 4].score = 27000;
  room.seats[(starter + 2) % 4].score = 24000;
  room.seats[(starter + 3) % 4].score = 20000;
  room.round = { wind: 'S', num: 4, honba: 0, dealer: starter, dice: null };
  game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
  eq(room.round.wind, 'W', '南4无人达基准点 → 西入');
  eq(room.round.num, 1, '西入从西1局开始');
  eq(room.phase, 'playing', '继续对局');

  // 有人达到基准点（25000 + 5000 = 30000）→ 终了
  room.seats[(starter + 1) % 4].score = 31000;
  game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
  eq(room.phase, 'ended', '西入中有人达基准点 → 终局');
  eq(room.endReason, 'westLine', '终局原因 = 西入·达到基准点');
}

function testHanchanFull() {
  const room = makeRoom({ gameType: 'hanchan', tobi: false, agariYame: false });
  game.startGame(room);
  game.rollDice(room);
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 80) {
    game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
  }
  eq(room.phase, 'ended', '半庄战打完');
  ok(room.round.wind === 'S' && room.round.num === 4, '停在南4局', game.roundLabel(room));
  eq(total(room), 100000, '半庄终局点数守恒');
  ok(guard <= 9, '半庄共 8 局（东1-4 + 南1-4）', guard);
}

function testRecord() {
  const room = makeRoom({ gameType: 'tonpuusen' });
  game.startGame(room);
  game.rollDice(room);
  const rec = game.buildGameRecord(room);
  ok(rec.id && rec.players.length === 4 && Array.isArray(rec.hands), '生成对局存档结构');
  eq(rec.players.map((p) => p.userId), ['u0', 'u1', 'u2', 'u3'], '存档中带 userId（用于账号历史）');
  eq(rec.hostUserId, 'host', '存档中带 hostUserId（场风盘账号能查到自己主持的对局）');
}

function testFinalSticks() {
  // 终局时桌上剩下的立直棒归一位
  const room = makeRoom({ gameType: 'tonpuusen' });
  game.startGame(room);
  game.rollDice(room);
  game.setRiichi(room, (room.round.dealer + 1) % 4, true);
  game.setRiichi(room, (room.round.dealer + 2) % 4, true);
  eq(room.sticks, 2, '两家立直后供托 2 根');
  const topBefore = game.topSeat(room);
  const before = room.seats[topBefore].score;
  game.endGame(room, 'final');
  eq(room.sticks, 0, '终局后供托清零');
  eq(room.seats[topBefore].score, before + 2000, '剩余供托 2000 点归一位');
  const tot = room.finalRanking.players.reduce((a, p) => a + p.diff, 0);
  ok(Math.abs(tot) < 0.001, '终局收支总和为 0', tot);
}

/* ======================= 3.5 数据文件容错 ======================= */

function testStoreIndex() {
  // 数据文件被写成数组形态时，房间仍必须能按房间号取到。
  // 真实事故：data/rooms.json 变成 [{...}]，房间列表里能看到，但点进去 404「房间不存在」。
  const store = require(path.join(ROOT, 'lib', 'store.js'));
  eq(typeof store.rebuildIndex, 'function', 'store 导出 rebuildIndex');
  const rebuilt = store.rebuildIndex('rooms', [
    { code: '4609', phase: 'lobby' },
    { code: '1234', phase: 'playing' },
    null,
    { phase: 'lobby' },
  ]);
  eq(Object.keys(rebuilt).sort(), ['1234', '4609'], '数组形态按 code 重建房间索引');
  eq(rebuilt['4609'] && rebuilt['4609'].phase, 'lobby', '重建后能按房间号取到房间');
  const users = store.rebuildIndex('users', [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }]);
  eq(Object.keys(users).sort(), ['u1', 'u2'], '用户数组按 id 重建索引');
  eq(Object.keys(store.rebuildIndex('rooms', [])).length, 0, '空数组得到空索引对象');
}

/* ============= 3.6 规则边角（整场模拟 test/simulate.js 抓出来的 bug） ============= */

function testRuleEdgeCases() {
  // 结束对局不能在「还没开局 / 已经终局」时静默成功。
  // 曾经的 bug：endGame 直接 return room.finalRanking，接口回一句「对局已结束」，
  // 房间却原地不动 —— 于是大厅里的房间永远开不了也关不掉。
  {
    const room = makeRoom({ gameType: 'hanchan' });
    let e = null;
    try { game.endGame(room, 'manual'); } catch (err) { e = err; }
    ok(e && e.code === 'NOT_STARTED', '大厅阶段调 endGame 报 NOT_STARTED', e && e.code);
    eq(room.phase, 'lobby', '大厅阶段调 endGame 不改房间状态');

    game.startGame(room);
    game.setStarter(room, 0);
    game.endGame(room, 'manual');
    eq(room.phase, 'ended', '对局中调 endGame 正常终局');
    e = null;
    try { game.endGame(room, 'manual'); } catch (err) { e = err; }
    ok(e && e.code === 'ALREADY_ENDED', '已终局再调 endGame 报 ALREADY_ENDED', e && e.code);
  }

  // 途中流局一律庄家连庄。
  // 曾经的 bug：四种途中流局沿用「庄家不听就下庄」的荒牌逻辑，把庄家赶下庄，
  // 本场数也跟着归零，整局推进全错。
  for (const t of ['kyuushu', 'fourWind', 'fourRiichi', 'tripleRon', 'fourKan']) {
    const room = makeRoom({ gameType: 'hanchan', tobi: false, agariYame: false });
    game.startGame(room);
    game.setStarter(room, 0);
    const dealer = room.round.dealer;
    const h = game.declareDraw(room, { type: t, tenpai: [false, false, false, false] });
    eq(room.round.dealer, dealer, `途中流局 ${game.DRAW_TYPES[t]}：庄家连庄`);
    eq(room.round.honba, 1, `途中流局 ${game.DRAW_TYPES[t]}：本场 +1`);
    eq(h.renchan, true, `途中流局 ${game.DRAW_TYPES[t]}：renchan 标记`);
    eq(h.bappuTotal, 0, `途中流局 ${game.DRAW_TYPES[t]}：不计不听罚符`);
  }

  // 荒牌平局仍然按听牌判定
  {
    const room = makeRoom({ gameType: 'hanchan', tobi: false, agariYame: false });
    game.startGame(room);
    game.setStarter(room, 0);
    game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
    eq(room.round.dealer, 1, '荒牌：庄家不听则下庄');
    eq(room.round.honba, 0, '荒牌：下庄时本场归零');
  }

  // 放铳者席次越界：必须是业务错误，不能是 TypeError（否则接口直接 500）
  {
    const room = makeRoom({ gameType: 'hanchan', tobi: false });
    game.startGame(room);
    game.setStarter(room, 0);
    for (const bad of [9, -1, 4, 1.5, 'x']) {
      let e = null;
      try { game.declareAgari(room, { winnerSeat: 0, han: 2, fu: 30, tsumo: false, loserSeat: bad }); }
      catch (err) { e = err; }
      ok(e && !(e instanceof TypeError), `放铳者=${String(bad)} 报业务错误`, e && e.message);
      ok(e && /[\u4e00-\u9fa5]/.test(e.message), `放铳者=${String(bad)} 错误信息是中文`, e && e.message);
    }
    eq(total(room), 100000, '非法荣和没有改到任何点数');
    eq(room.hands.length, 0, '非法荣和没有写进牌谱');
  }

  // 点数修正传入垃圾：拒绝，且不能污染点数（以前会静默变成 NaN/0）
  {
    const room = makeRoom({ gameType: 'hanchan', tobi: false });
    game.startGame(room);
    game.setStarter(room, 0);
    for (const bad of [[1, 2, 3], [1, 2, 3, 'abc'], [25000, 25000, 25000, NaN], [25000, 25000, 25000, '']]) {
      let e = null;
      try { game.adjustScores(room, bad); } catch (err) { e = err; }
      ok(e && /[\u4e00-\u9fa5]/.test(e.message), '点数修正传入 ' + JSON.stringify(bad) + ' 被拒绝', e && e.message);
    }
    eq(room.seats.map((s) => s.score), [25000, 25000, 25000, 25000], '非法修正没有污染点数');
    game.adjustScores(room, [30000, 30000, 20000, 20000]);
    eq(room.seats.map((s) => s.score), [30000, 30000, 20000, 20000], '合法修正生效');
    game.undo(room);
    eq(room.seats.map((s) => s.score), [25000, 25000, 25000, 25000], '点数修正可以撤销');
  }

  // 和了记录必须带 handTotal，且 gain = handTotal + 供托
  {
    const room = makeRoom({ gameType: 'hanchan', tobi: false, agariYame: false });
    game.startGame(room);
    game.setStarter(room, 0);
    game.setRiichi(room, 2, true);
    game.setRiichi(room, 3, true);
    const h = game.declareAgari(room, { winnerSeat: 1, han: 4, fu: 30, tsumo: false, loserSeat: 2 });
    eq(h.label, '满贯（切上）', '4番30符 走切上满贯');
    eq(h.handTotal, 8000, 'handTotal = 纯手牌点');
    eq(h.stickGain, 2000, 'stickGain = 两根立直棒');
    eq(h.gain, 10000, 'gain = 手牌点 + 供托');
    eq(room.seats[1].score, 35000, '和了者到手 = 25000 + 8000 + 供托 2000');
    eq(total(room), 100000, '和了后点数守恒');
  }

  // 西入：南4 已有人达到基准点时，应当「打满终局」而不是标成「西入达标」
  {
    const room = makeRoom({ gameType: 'hanchan', tobi: false, agariYame: false, westExtension: true });
    game.startGame(room);
    game.setStarter(room, 0);
    room.round.wind = 'S';
    room.round.num = 4;
    room.round.dealer = 0;
    room.seats[0].score = 24000;
    room.seats[1].score = 31000;
    room.seats[2].score = 24000;
    room.seats[3].score = 21000;
    game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
    eq(room.phase, 'ended', '西入：南4 有人达标即终局');
    eq(room.endReason, 'final', '西入：原因用「打满」而不是「西入达标」');
  }

  // 西入：南4 无人达标 → 进西1
  {
    const room = makeRoom({ gameType: 'hanchan', tobi: false, agariYame: false, westExtension: true });
    game.startGame(room);
    game.setStarter(room, 0);
    room.round.wind = 'S';
    room.round.num = 4;
    room.round.dealer = 0;
    game.declareDraw(room, { type: 'exhaustive', tenpai: [false, false, false, false] });
    eq(room.phase, 'playing', '西入：南4 无人达标则继续');
    eq(room.round.wind, 'W', '西入：进入西场');
    eq(room.round.num, 1, '西入：西1局');
  }

  // 大厅阶段不能改本场数
  {
    const room = makeRoom({});
    let e = null;
    try { game.setHonba(room, 3); } catch (err) { e = err; }
    ok(e && /对局尚未开始/.test(e.message), '大厅阶段不能改本场数', e && e.message);
  }
}

/* ============================ 4. HTTP 接口 ============================ */

const http = require('node:http');

function httpJson(method, fullUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const data = body === undefined || body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch (e) { parsed = { _raw: buf }; }
        resolve({ status: res.statusCode, body: parsed, text: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 读取 SSE 前若干条事件后主动断开 */
function sseCollect(fullUrl, ms, maxEvents) {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const events = [];
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { req.destroy(); return resolve({ status: res.statusCode, events }); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = chunk.match(/^event: (.+)$/m);
          const dt = chunk.match(/^data: (.+)$/m);
          if (ev || dt) events.push({ event: ev ? ev[1] : 'message', data: dt ? dt[1] : null });
          if (events.length >= (maxEvents || 1)) { req.destroy(); return resolve({ status: 200, events }); }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, events }));
      setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, events }); }, ms || 1200).unref?.();
    });
    req.on('error', (e) => { if (events.length) resolve({ status: 200, events }); else reject(e); });
    req.end();
  });
}

async function testHttp() {
  process.env.PORT = String(18000 + Math.floor(Math.random() * 900));
  process.env.HOST = '127.0.0.1';
  process.env.ADMIN_PASSWORD = 'admin-test-pass'; // 让管理端测试拿到一个确定的密码
  const serverPath = path.join(ROOT, 'server.js');
  delete require.cache[require.resolve(serverPath)];
  require(serverPath);
  await new Promise((r) => setTimeout(r, 700));
  const base = 'http://127.0.0.1:' + process.env.PORT;

  const j = (p, opt) => httpJson((opt && opt.method) || 'GET', base + p, { 'Content-Type': 'application/json' }, opt && opt.body);

  let r = await j('/api/ping');
  eq(r.body.ok, true, 'GET /api/ping');

  // 注册 5 个账号（1 场风盘 + 4 玩家）
  const tokens = [];
  for (let i = 0; i < 5; i++) {
    r = await j('/api/auth/register', { method: 'POST', body: { name: 'T' + Date.now() + '_' + i, password: 'pass1234' } });
    ok(r.body.ok && r.body.token, '注册账号 ' + i, r.body);
    tokens.push(r.body.token);
  }

  const nm = 'dup' + Date.now().toString(36);
  await j('/api/auth/register', { method: 'POST', body: { name: nm, password: 'pass1234' } });
  r = await j('/api/auth/register', { method: 'POST', body: { name: nm, password: 'pass1234' } });
  ok(r.status >= 400, '重复昵称注册被拒绝');

  r = await j('/api/auth/login', { method: 'POST', body: { name: nm, password: 'wrong' } });
  ok(r.status === 401, '错误密码登录被拒绝');

  r = await j('/api/auth/login', { method: 'POST', body: { name: nm, password: 'pass1234' } });
  ok(r.body.ok && r.body.token, '正确密码登录成功', r.body);

  r = await j('/api/auth/register', { method: 'POST', body: { name: 'x', password: '123' } });
  ok(r.status >= 400, '过短密码被拒绝');

  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  // 未登录不能创建房间
  const noAuthRoom = await httpJson('POST', base + '/api/rooms', { 'Content-Type': 'application/json' }, { config: {} });
  ok(noAuthRoom.status === 401, '未登录不能创建场风盘房间');

  // 创建房间
  r = await httpJson('POST', base + '/api/rooms', H(tokens[0]), { config: { gameType: 'tonpuusen' } });
  const created = r.body;
  ok(created.ok && /^\d{4}$/.test(created.code), '创建房间返回 4 位房间号', created);
  const code = created.code, hostKey = created.hostKey;
  ok(typeof hostKey === 'string' && hostKey.length >= 16, '创建时下发场风盘密钥');
  ok(created.room.hostKey === undefined, '房间广播数据不含场风盘密钥');

  // 访客（未登录）可以用临时身份入座，但不计入任何账号的历史
  const guestRoom = (await httpJson('POST', base + '/api/rooms', H(tokens[4]), { config: { gameType: 'tonpuusen' } })).body;
  const gJoin = await httpJson('POST', base + '/api/rooms/' + guestRoom.code + '/join', { 'Content-Type': 'application/json' }, { seat: 0 });
  ok(gJoin.body.ok && /^guest:/.test(gJoin.body.room.seats[0].userId), '未登录访客可以入座（记为 guest）', gJoin.body.error);

  // SSE 先挂上，才能看到后续推送
  const ssePromise = sseCollect(base + '/api/rooms/' + code + '/events', 3000, 2);

  // 4 个玩家入座
  for (let i = 0; i < 4; i++) {
    const rr = await httpJson('POST', base + '/api/rooms/' + code + '/join', H(tokens[i + 1]), { seat: i });
    ok(rr.body.ok, '玩家 ' + i + ' 入座席位 ' + i, rr.body.error);
  }

  // 同一玩家重复入座 = 重连，幂等；抢别人占着的席位 = 拒绝；搬到空席位 = 允许
  const before0 = await httpJson('GET', base + '/api/rooms/' + code);
  const seat0Id = before0.body.room.seats[0].userId;
  const dupSeat = await httpJson('POST', base + '/api/rooms/' + code + '/join', H(tokens[1]), { seat: 0 });
  ok(dupSeat.body.ok && dupSeat.body.room.seats[0].userId === seat0Id, '同一玩家重复入座（重连）幂等', dupSeat.body.error);
  const steal = await httpJson('POST', base + '/api/rooms/' + code + '/join', H(tokens[3]), { seat: 0 });
  ok(!steal.body.ok, '别人不能抢占已占用席位', steal.body.error);

  // 非场风盘不能执行场风盘操作
  const bad = await httpJson('POST', base + '/api/rooms/' + code + '/action', H(tokens[1]), { type: 'start' });
  ok(bad.status === 403, '玩家端无法执行场风盘操作');

  // 玩家冒充场风盘密钥也不行
  const badKey = await httpJson('POST', base + '/api/rooms/' + code + '/action', H(tokens[1]), { type: 'start', hostKey: 'deadbeef' });
  ok(badKey.status === 403, '玩家伪造场风盘密钥被拒绝');

  const hostAct = async (type, payload) => httpJson('POST', base + '/api/rooms/' + code + '/action', Object.assign(H(tokens[0]), { 'X-Host-Key': hostKey }), { type, payload, hostKey });

  r = await hostAct('start');
  ok(r.body.ok, '开始对局', r.body);
  r = await hostAct('rollDice');
  ok(r.body.ok && r.body.room.round.dice, '掷骰子');
  const dealer = r.body.room.round.dealer;
  ok(dealer >= 0 && dealer <= 3, '掷骰返回有效亲位');

  // 玩家自己宣告立直
  const mySeat = 1;
  let rr = await httpJson('POST', base + '/api/rooms/' + code + '/action', H(tokens[mySeat + 1]), { type: 'riichi', payload: { seat: mySeat, on: true } });
  ok(rr.body.ok && rr.body.room.seats[mySeat].score === 24000, '玩家端自己立直并扣 1000 点', rr.body);

  // 玩家不能替别人立直
  rr = await httpJson('POST', base + '/api/rooms/' + code + '/action', H(tokens[mySeat + 1]), { type: 'riichi', payload: { seat: 3, on: true } });
  ok(rr.status === 403, '玩家端不能替他人立直');

  // 和了
  const child = (dealer + 1) % 4 === mySeat ? mySeat : (dealer + 1) % 4;
  r = await hostAct('agari', { winnerSeat: child, tsumo: true, han: 3, fu: 30 });
  ok(r.body.ok, '录入和了', r.body.error);
  ok(r.body.room.hands.length === 1, '对局记录 +1 局');
  ok(r.body.room.sticks === 0, '和了后供託清零');

  // 撤销
  r = await hostAct('undo');
  ok(r.body.ok && r.body.room.phase === 'playing', '可撤销上一手');
  r = await hostAct('agari', { winnerSeat: child, tsumo: true, han: 3, fu: 30 });
  ok(r.body.ok, '撤销后重新录入和了');

  // 打到终局
  let guard = 0;
  while (r.body.room.phase === 'playing' && guard++ < 20) r = await hostAct('draw', { type: 'exhaustive', tenpai: [false, false, false, false] });
  eq(r.body.room.phase, 'ended', 'API 层面打满东风战');
  ok(r.body.room.finalRanking && r.body.room.finalRanking.players.length === 4, '终局返回顺位结算');

  // SSE 推送
  const sse = await ssePromise;
  ok(sse.events.length >= 1, 'SSE 订阅收到推送', sse.events);

  // 历史记录
  await new Promise((x) => setTimeout(x, 600));
  let res = await httpJson('GET', base + '/api/me/games', H(tokens[1 + 1]));
  let gb = res.body;
  ok(gb.games.length >= 1, '玩家账号能查到历史对局', gb.games.length);
  const g0 = gb.games[0];
  ok(g0.players.length === 4, '历史记录含 4 名玩家');
  ok(g0.players.some((p) => p.userId), '历史记录带玩家 userId');

  res = await httpJson('GET', base + '/api/rooms/' + code + '/games');
  ok(res.body.games.length >= 1, '场风盘按房间号查到历史对局');

  res = await httpJson('GET', base + '/api/games/' + g0.id);
  ok(res.body.ok && res.body.game.hands.length >= 1, '对局明细可读取');

  // 场风盘账号（没坐任何席位）也能在「我的历史对局」里看到自己主持的对局
  res = await httpJson('GET', base + '/api/me/games', H(tokens[0]));
  ok(res.body.games.some((g) => g.id === g0.id), '场风盘账号能查到本场对局', res.body.games.length);

  res = await httpJson('GET', base + '/api/auth/me', H(tokens[2]));
  ok(res.body.user && res.body.user.name.startsWith('T'), 'GET /api/auth/me 返回当前用户');

  /* ---- 回归（报障 m01936）：再来一局之后场风盘必须还能开局 ---- */
  // 关键点：这里只带 hostKey、不带 token，模拟场风盘设备的真实用法。
  // 早先 resetForRematch 会把 server 注入的 hostKey 抹掉，导致场风盘被自己的房间 403。
  const hostKeyOnly = { 'Content-Type': 'application/json', 'X-Host-Key': hostKey };
  r = await httpJson('POST', base + '/api/rooms/' + code + '/action', hostKeyOnly, { type: 'rematch', hostKey });
  ok(r.body.ok, '再来一局：退回大厅', r.body.error);

  r = await httpJson('GET', base + '/api/rooms/' + code + '/whoami', hostKeyOnly);
  ok(r.body.isHost === true, 'rematch 之后场风盘密钥依然有效', r.body);

  r = await httpJson('POST', base + '/api/rooms/' + code + '/action', hostKeyOnly, { type: 'start', hostKey });
  ok(r.body.ok, 'rematch 之后场风盘能重新开局', r.body.error);
  r = await httpJson('POST', base + '/api/rooms/' + code + '/action', hostKeyOnly, { type: 'rollDice', hostKey });
  ok(r.body.ok, 'rematch 之后能掷骰子定起家', r.body.error);

  r = await httpJson('GET', base + '/api/rooms/' + code + '/whoami', H(tokens[1]));
  ok(r.body.isHost === false, '普通玩家自查结果为「不是场风盘」', r.body);
  r = await httpJson('POST', base + '/api/rooms/' + code + '/action', H(tokens[1]), { type: 'start' });
  ok(r.status === 403 && r.body.code === 'NOT_HOST', '非场风盘操作被拒且带可识别原因', r.body);

  /* ---- 回归（报障 m01936）：玩家端立直失败要给出能看懂的原因 ---- */
  r = await httpJson('POST', base + '/api/rooms/' + code + '/action', H(tokens[4]), { type: 'riichi', payload: { seat: 0, on: true } });
  ok(r.status === 403 && r.body.code === 'NOT_OWN_SEAT', '替别人立直被拒且带 NOT_OWN_SEAT', r.body);
  r = await httpJson('POST', base + '/api/rooms/' + code + '/action', H(tokens[4]), { type: 'riichi', payload: { seat: 3, on: true } });
  ok(r.body.ok, '本人可以为自己所在席位立直', r.body.error);
  r = await httpJson('POST', base + '/api/rooms/' + code + '/action', { 'Content-Type': 'application/json' }, { type: 'riichi', payload: { seat: 3, on: false } });
  ok(r.status === 403 && r.body.code === 'NO_SESSION', '未登录立直被拒且带 NO_SESSION（提示重新登录）', r.body);

  /* ---- 回归：失效令牌必须报 401，不能假装成功 ---- */
  res = await httpJson('GET', base + '/api/auth/me', { 'Content-Type': 'application/json', Authorization: 'Bearer 0000000000000000' });
  ok(res.status === 401 && res.body.ok === false, '失效令牌访问 /api/auth/me 返回 401', res.status);
  res = await httpJson('GET', base + '/api/auth/me', { 'Content-Type': 'application/json' });
  ok(res.status === 200 && res.body.user === null, '完全没带令牌时 /api/auth/me 返回 200 + 空用户');

  /* ---- 回归：退出登录会释放大厅席位（否则游客再也回不来） ---- */
  const logoutToken = (await j('/api/auth/register', { method: 'POST', body: { name: 'L' + Date.now(), password: 'pass1234' } })).body.token;
  const lbRoom = (await httpJson('POST', base + '/api/rooms', H(tokens[0]), { config: { gameType: 'tonpuusen' } })).body;
  await httpJson('POST', base + '/api/rooms/' + lbRoom.code + '/join', H(logoutToken), { seat: 0 });
  r = await httpJson('GET', base + '/api/rooms/' + lbRoom.code);
  ok(!!r.body.room.seats[0].userId, '入座后席位被占用');
  await httpJson('POST', base + '/api/auth/logout', H(logoutToken));
  r = await httpJson('GET', base + '/api/rooms/' + lbRoom.code);
  ok(!r.body.room.seats[0].userId, '退出登录会释放大厅里的席位', r.body.room.seats[0]);

  /* ---- 管理端：只有 admin 角色能看全站记录 ---- */
  let ad = await httpJson('POST', base + '/api/auth/login', {}, { name: 'admin', password: 'admin-test-pass' });
  ok(ad.status === 200 && ad.body.user && ad.body.user.role === 'admin', '管理员账号已自动创建且 role=admin', ad.body.user);
  const adminTok = ad.body.token;

  r = await httpJson('GET', base + '/api/admin/overview', H(adminTok));
  ok(r.body.ok && r.body.overview.games >= 1, '管理员能拿到概览（对局数 ≥ 1）', r.body.error);
  const gamesTotal = r.body.overview.games;

  r = await httpJson('GET', base + '/api/admin/games', H(adminTok));
  ok(r.body.ok && r.body.total === gamesTotal && r.body.games.length === gamesTotal, '管理员能拿到全部对局记录', { t: r.body.total, n: (r.body.games || []).length });
  const anyGame = r.body.games[0];
  ok(anyGame && Array.isArray(anyGame.players) && anyGame.players.length === 4, '对局记录里带四家明细');

  r = await httpJson('GET', base + '/api/admin/games?q=' + encodeURIComponent(anyGame.players[0].name), H(adminTok));
  ok(r.body.ok && r.body.total >= 1, '按玩家名搜索能命中', r.body.total);
  r = await httpJson('GET', base + '/api/admin/games?q=zzz-not-exist', H(adminTok));
  ok(r.body.ok && r.body.total === 0, '搜不到时返回空列表', r.body.total);

  r = await httpJson('GET', base + '/api/admin/games/' + anyGame.id, H(adminTok));
  ok(r.body.ok && r.body.game.id === anyGame.id && Array.isArray(r.body.game.hands), '管理员能看单场对局详单');

  r = await httpJson('GET', base + '/api/admin/players', H(adminTok));
  ok(r.body.ok && r.body.players.length >= 1 && typeof r.body.players[0].avgRank === 'number', '玩家统计带平均顺位', r.body.players && r.body.players[0]);

  r = await httpJson('GET', base + '/api/admin/rooms', H(adminTok));
  ok(r.body.ok && Array.isArray(r.body.rooms), '管理员能看房间列表');

  const csvR = await httpJson('GET', base + '/api/admin/export?format=csv', H(adminTok));
  ok(csvR.status === 200 && /对局ID/.test(csvR.text) && csvR.text.charCodeAt(0) === 0xFEFF, 'CSV 导出带 BOM 和表头');

  r = await httpJson('GET', base + '/api/admin/overview', H(tokens[1]));
  ok(r.status === 403 && r.body.error === '该账号不是管理员', '普通玩家访问管理接口被拒（403）', r.body);
  r = await httpJson('GET', base + '/api/admin/overview', {});
  ok(r.status === 401, '未登录访问管理接口被拒（401）', r.status);

  // 改密码后旧密码失效、新密码可用
  r = await httpJson('POST', base + '/api/admin/password', H(adminTok), { password: 'new-admin-pass' });
  ok(r.body.ok, '管理员能改自己的密码', r.body.error);
  ad = await httpJson('POST', base + '/api/auth/login', {}, { name: 'admin', password: 'new-admin-pass' });
  ok(ad.status === 200 && ad.body.ok, '改完密码后新密码可以登录', ad.status);
  ad = await httpJson('POST', base + '/api/auth/login', {}, { name: 'admin', password: 'admin-test-pass' });
  ok(ad.status === 401, '改完密码后旧密码失效', ad.status);

  /* ---- 手动录入一局：登录后直接填四家最终点数 ---- */
  const stamp = Date.now().toString(36);
  const mA = 'MA' + stamp, mB = 'MB' + stamp, mC = 'MC' + stamp, mD = 'MD' + stamp;
  const mkPlayers = (arr) => arr.map(([name, score]) => ({ name, score }));

  r = await httpJson('POST', base + '/api/games', { 'Content-Type': 'application/json' }, {
    players: mkPlayers([[mA, 25000], [mB, 25000], [mC, 25000], [mD, 25000]]),
  });
  ok(r.status === 401, '未登录不能录入对局（401）', r.status);

  r = await httpJson('POST', base + '/api/games', H(tokens[1]), { players: mkPlayers([[mA, 25000], [mB, 25000], [mC, 25000]]) });
  ok(r.status === 400 && /4 名/.test(r.body.error), '只有 3 家时被拒绝', r.body.error);

  r = await httpJson('POST', base + '/api/games', H(tokens[1]), { players: mkPlayers([[mA, 25000], ['', 25000], [mC, 25000], [mD, 25000]]) });
  ok(r.status === 400 && /昵称不能为空/.test(r.body.error), '空昵称被拒绝', r.body.error);

  r = await httpJson('POST', base + '/api/games', H(tokens[1]), { players: mkPlayers([[mA, 25000], [mB, 'abc'], [mC, 25000], [mD, 25000]]) });
  ok(r.status === 400 && /整数/.test(r.body.error), '非整数点数被拒绝', r.body.error);

  r = await httpJson('POST', base + '/api/games', H(tokens[1]), { players: mkPlayers([[mA, 25000], [mA, 25000], [mC, 25000], [mD, 25000]]) });
  ok(r.status === 400 && /重复/.test(r.body.error), '四家重名被拒绝', r.body.error);

  r = await httpJson('POST', base + '/api/games', H(tokens[1]), {
    players: mkPlayers([[mA, 30000], [mB, 25000], [mC, 25000], [mD, 25000]]),
  });
  ok(r.status === 400 && r.body.code === 'UNBALANCED', '点数不守恒被拒绝并带 UNBALANCED 码', { s: r.status, c: r.body.code });

  // 正常录入：合计 100000，顺位与收支都要算对
  r = await httpJson('POST', base + '/api/games', H(tokens[1]), {
    config: { gameType: 'tonpuusen', startScore: 25000 },
    note: '自测录入',
    players: mkPlayers([[mA, 42000], [mB, 31000], [mC, 18000], [mD, 9000]]),
  });
  ok(r.body.ok && /^[a-f0-9]{12}$/.test(r.body.game.id), '手动录入成功并返回记录 ID', r.body.error);
  const manualId = r.body.game.id;
  const rank = r.body.game.ranking;
  ok(rank[0].name === mA && rank[0].rank === 1 && rank[0].diff === 17, '顺位 1 = 421000 点那位，收支 +17.0', rank[0]);
  ok(rank[3].name === mD && rank[3].rank === 4 && rank[3].diff === -16, '顺位 4 = 9000 点那位，收支 −16.0', rank[3]);

  r = await httpJson('GET', base + '/api/games/' + manualId);
  ok(r.body.ok && r.body.game.manual === true && r.body.game.hands.length === 0, '手动录入的对局能被单场接口打开（无牌谱）', r.body.error);

  r = await httpJson('GET', base + '/api/me/games', H(tokens[1]));
  ok(r.body.ok && r.body.games.some((g) => g.id === manualId), '录入的记录出现在录入者自己的历史里');

  // 昵称对上已注册账号 → 那一局也进对方历史
  const regA = await httpJson('POST', base + '/api/auth/register', {}, { name: mA, password: 'pass1234' });
  ok(regA.body.ok, '陪打账号注册成功', regA.body.error);
  const manual2 = (await httpJson('POST', base + '/api/games', H(tokens[1]), {
    config: { gameType: 'hanchan' },
    players: mkPlayers([[mA, 50000], [mB, 20000], [mC, 20000], [mD, 10000]]),
  })).body.game;
  ok(!!manual2.id, '第二局录入成功', manual2.error);
  r = await httpJson('GET', base + '/api/me/games', H(regA.body.token));
  const seenByA = r.body.games.find((g) => g.id === manual2.id);
  ok(!!seenByA && seenByA.me && seenByA.me.rank === 1 && seenByA.me.diff === 25, '昵称对上账号时这一局也进对方历史（1位 +25.0）', seenByA && seenByA.me);

  // 管理端能看见，且 hands=0、gameType 跟着录入时的选择走
  r = await httpJson('GET', base + '/api/admin/games?q=' + encodeURIComponent(mA), H(adminTok));
  ok(r.body.ok && r.body.total >= 1, '管理端能搜到手动录入的对局', r.body.total);
  const admManual = (r.body.games || []).find((g) => g.id === manual2.id);
  ok(!!admManual && admManual.hands === 0 && admManual.gameType === 'hanchan', '管理端里手动录入的对局 hands=0、形式正确', admManual);

  // 允许不平：先确认再存，记录里标出差额
  r = await httpJson('POST', base + '/api/games', H(tokens[1]), {
    allowUnbalanced: true,
    players: mkPlayers([[mA, 30000], [mB, 25000], [mC, 25000], [mD, 25000]]),
  });
  ok(r.body.ok && r.body.game.balanceDiff === 5000, '允许不平时能存，并标出 +5000 差额', r.body.game && r.body.game.balanceDiff);

  /* ---- 结束对局：大厅关房 / 对局中结算 / 管理员兜底 ---- */
  const mkRoom = async (tok, cfg) => (await httpJson('POST', base + '/api/rooms', H(tok), { config: cfg || { gameType: 'tonpuusen' } })).body;
  const seatAll = async (room, toks) => {
    for (let i = 0; i < 4; i++) await httpJson('POST', base + '/api/rooms/' + room.code + '/join', H(toks[i]), { seat: i });
  };

  // 1) 大厅阶段点「结束对局」= 关掉房间（以前是静默假成功，房间永远挂着）
  const lobbyRoom = await mkRoom(tokens[0]);
  r = await httpJson('POST', base + '/api/rooms/' + lobbyRoom.code + '/action', H(tokens[0]), { type: 'end', hostKey: lobbyRoom.hostKey });
  ok(r.status === 200 && r.body.closed === true && /关闭/.test(r.body.message), '大厅阶段点结束对局 → 直接关闭房间', r.body);
  r = await httpJson('GET', base + '/api/rooms/' + lobbyRoom.code);
  ok(r.status === 404, '关掉的房间再查是 404', r.status);

  // 2) 对局中点「结束对局」→ 结算并落一条记录
  const playRoom = await mkRoom(tokens[0]);
  await seatAll(playRoom, tokens.slice(0, 4));
  r = await httpJson('POST', base + '/api/rooms/' + playRoom.code + '/action', H(tokens[0]), { type: 'start', hostKey: playRoom.hostKey });
  ok(r.body.ok && r.body.room.phase === 'playing', '房间进入对局中', r.body.error);
  r = await httpJson('POST', base + '/api/rooms/' + playRoom.code + '/action', H(tokens[0]), { type: 'end', hostKey: playRoom.hostKey });
  ok(r.status === 200 && r.body.room && r.body.room.phase === 'ended', '对局中点结束对局 → 终局', r.body);
  ok(/^[a-f0-9]{12}$/.test(r.body.room.savedGameId || ''), '终局后自动落一条对局记录', r.body.room && r.body.room.savedGameId);

  // 3) 已经终局再点结束 → 400 ALREADY_ENDED（不再假成功）
  r = await httpJson('POST', base + '/api/rooms/' + playRoom.code + '/action', H(tokens[0]), { type: 'end', hostKey: playRoom.hostKey });
  ok(r.status === 400 && r.body.code === 'ALREADY_ENDED', '已终局再点结束 → 400 ALREADY_ENDED', { s: r.status, c: r.body.code });

  // 4) 非房主且非管理员不能结束别人的房间
  r = await httpJson('POST', base + '/api/rooms/' + playRoom.code + '/action', H(tokens[3]), { type: 'rematch' });
  ok(r.status === 403 && r.body.code === 'NOT_HOST', '非房主不能操作别人的房间', { s: r.status, c: r.body.code });

  // 5) 场风盘设备丢了登录（没 hostKey、也不是房主）→ 管理员端可以替它结束
  const bossRoom = await mkRoom(tokens[2]);
  await seatAll(bossRoom, [tokens[2], tokens[0], tokens[1], tokens[3]]);
  await httpJson('POST', base + '/api/rooms/' + bossRoom.code + '/action', H(tokens[2]), { type: 'start', hostKey: bossRoom.hostKey });
  r = await httpJson('POST', base + '/api/rooms/' + bossRoom.code + '/action', H(tokens[0]), { type: 'end' });
  ok(r.status === 403 && r.body.code === 'NOT_HOST', '普通玩家（非房主）不能替别人结束', { s: r.status, c: r.body.code });
  r = await httpJson('POST', base + '/api/admin/rooms/' + bossRoom.code + '/end', H(adminTok), {});
  ok(r.status === 200 && r.body.ok && /^[a-f0-9]{12}$/.test(r.body.gameId || ''), '管理员能结束别人的房间并存档', r.body);
  ok(Array.isArray(r.body.ranking) && r.body.ranking.length === 4, '管理员结束返回四家顺位', r.body.ranking);

  // 6) 管理员关闭房间（不结算）
  const closeRoom2 = await mkRoom(tokens[3]);
  r = await httpJson('POST', base + '/api/admin/rooms/' + closeRoom2.code + '/close', H(adminTok), {});
  ok(r.status === 200 && r.body.closed === true, '管理员能关闭不需要结算的房间', r.body);
  r = await httpJson('GET', base + '/api/rooms/' + closeRoom2.code);
  ok(r.status === 404, '管理员关掉的房间再查是 404', r.status);

  // 7) 管理员端房间列表带 savedGameId，且不存在的房间给出明确 404
  r = await httpJson('GET', base + '/api/admin/rooms', H(adminTok));
  ok(r.status === 200 && Array.isArray(r.body.rooms), '管理员端房间列表可用');
  r = await httpJson('POST', base + '/api/admin/rooms/9999/end', H(adminTok), {});
  ok(r.status === 404 && /不存在/.test(r.body.error), '结束不存在的房间 → 404 且提示明确', r.body.error);

  // 静态页面
  res = await httpJson('GET', base + '/record');
  ok(res.status === 200 && /录入一局/.test(res.text), 'GET /record 返回录入页');

  // 静态页面
  res = await httpJson('GET', base + '/admin');
  ok(res.status === 200 && /管理员端/.test(res.text), 'GET /admin 返回管理员端页面');

  // 静态页面可访问
  res = await httpJson('GET', base + '/table');
  ok(res.status === 200 && /场风盘/.test(res.text), 'GET /table 返回场风盘页面');
  res = await httpJson('GET', base + '/player');
  ok(res.status === 200 && res.text.length > 500, 'GET /player 返回玩家端页面');

  console.log('\n=== HTTP 接口测试 ===');
  console.log('累计通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) { console.log('\n失败明细：'); fails.forEach((f) => console.log('  ✗ ' + f)); }

  // 清掉测试期间产生的临时数据目录，不留垃圾
  try { fs.rmSync(process.env.RC_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
}

/* ============================ 运行 ============================ */

testScoring();
testFlow();
testTobi();
testAgariYame();
testWestExtension();
testHanchanFull();
testRecord();
testFinalSticks();
testStoreIndex();
testRuleEdgeCases();

console.log('\n=== 核心逻辑测试 ===');
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) { console.log('失败明细：'); fails.forEach((f) => console.log('  ✗ ' + f)); }

testHttp().catch((e) => {
  console.log('\n[HTTP 测试异常] ' + e.message);
  console.log(e.stack);
  process.exit(1);
});
