'use strict';

const crypto = require('crypto');
const scoring = require('./scoring');

const SEAT_WIND = ['东', '南', '西', '北'];
const WIND_CHAR = { E: '东', S: '南', W: '西' };

const DRAW_TYPES = {
  exhaustive: '荒牌平局',
  kyuushu: '九种九牌',
  fourRiichi: '四家立直',
  tripleRon: '三家和了',
  fourKan: '四开杠',
  fourWind: '四风连打',
};

const END_REASON = {
  tobi: '击飞终局',
  agariyame: '和了终局',
  final: '打满终局',
  westLine: '西入·达到基准点',
  manual: '手动结束',
};

// 西入的判定基准 = 起始点数 + 5000（起始 25000 时即 30000 那条线）
const WEST_LINE_BONUS = 5000;

const DEFAULT_CONFIG = {
  gameType: 'hanchan',      // 'tonpuusen' 东风战 | 'hanchan' 半庄战
  startScore: 25000,
  kiriageMangan: true,      // 切上满贯（4番30符 / 3番60符 算满贯）
  agariYame: true,          // 和了终局（最后一局庄家和了且已是第一则终局）
  tobi: true,               // 击飞终局（有人点数 < 0）
  yakitori: false,          // 烧鸟（全场没和过牌的人给每个和过牌的人 1000 点）
  westExtension: false,     // 西入（南四局无人达标则续行西场）
  notenBappu: true,         // 荒牌平局的不听罚符
  akaDora: 3,               // 赤宝牌枚数（仅记录）
};

function normalizeConfig(input) {
  const c = { ...DEFAULT_CONFIG, ...(input || {}) };
  c.gameType = c.gameType === 'tonpuusen' ? 'tonpuusen' : 'hanchan';
  c.startScore = clampInt(c.startScore, 1000, 200000, DEFAULT_CONFIG.startScore);
  c.kiriageMangan = !!c.kiriageMangan;
  c.agariYame = !!c.agariYame;
  c.tobi = !!c.tobi;
  c.yakitori = !!c.yakitori;
  c.westExtension = !!c.westExtension;
  c.notenBappu = !!c.notenBappu;
  c.akaDora = clampInt(c.akaDora, 0, 4, 3);
  delete c.returnScore;
  delete c.uma;
  delete c.umaName;
  return c;
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/* ------------------------------ 辅助 ------------------------------ */

function roundLabel(room) {
  const r = room.round;
  return `${WIND_CHAR[r.wind] || '东'}${r.num}局`;
}

function windOf(room, seat) {
  if (room.round.dealer === null || room.round.dealer === undefined) return SEAT_WIND[seat];
  return SEAT_WIND[(seat - room.round.dealer + 4) % 4];
}

function topSeat(room) {
  const starter = room.starterSeat === null ? 0 : room.starterSeat;
  let best = null;
  for (const s of room.seats) {
    if (!best) { best = s; continue; }
    if (s.score > best.score) best = s;
    else if (s.score === best.score) {
      const da = (s.seat - starter + 4) % 4;
      const db = (best.seat - starter + 4) % 4;
      if (da < db) best = s;
    }
  }
  return best ? best.seat : 0;
}

function pushLog(room, kind, text) {
  room.log.push({ at: Date.now(), kind, text });
  if (room.log.length > 500) room.log.shift();
}

function occupied(room, seat) {
  const s = room.seats[seat];
  return !!(s && s.userId);
}

/* ------------------------------ 房间生命周期 ------------------------------ */

function createRoom(host) {
  const cfg = normalizeConfig(host && host.config);
  const room = {
    code: null,
    createdAt: Date.now(),
    hostUserId: (host && host.userId) || null,
    hostName: (host && host.name) || '场风盘',
    phase: 'lobby', // lobby | playing | ended
    config: cfg,
    seats: [0, 1, 2, 3].map((i) => ({
      seat: i, userId: null, name: '', score: cfg.startScore, riichi: false, wins: 0, joinedAt: null,
    })),
    round: { wind: 'E', num: 1, honba: 0, dealer: null, dice: null },
    starterSeat: null,
    sticks: 0,
    lastResult: null,
    hands: [],
    undoStack: [],
    log: [],
    startedAt: null,
    endedAt: null,
    endReason: null,
    finalRanking: null,
    savedGameId: null,
  };
  pushLog(room, 'create', `房间创建：${room.config.gameType === 'tonpuusen' ? '东风战' : '半庄战'} / 起始点数 ${room.config.startScore}`);
  return room;
}

function joinSeat(room, { userId, name, seat }) {
  if (room.phase !== 'lobby') throw new Error('对局已开始，无法入座');
  const idx = Number(seat);
  if (!(idx >= 0 && idx <= 3)) throw new Error('席位不正确');
  const target = room.seats[idx];
  if (target.userId && target.userId !== userId) throw new Error('该席位已被占用');
  for (const s of room.seats) {
    if (s.seat !== idx && s.userId && userId && s.userId === userId) {
      s.userId = null; s.name = ''; s.joinedAt = null;
    }
  }
  const isNew = !target.userId;
  target.userId = userId || ('guest:' + crypto.randomBytes(4).toString('hex'));
  target.name = String(name || '玩家').slice(0, 16);
  target.joinedAt = target.joinedAt || Date.now();
  if (isNew) pushLog(room, 'seat', `${SEAT_WIND[idx]}家席位：${target.name} 入座`);  return target;
}

function leaveSeat(room, seat) {
  if (room.phase !== 'lobby') throw new Error('对局进行中无法离席');
  const s = room.seats[Number(seat)];
  if (!s || !s.userId) return;
  pushLog(room, 'seat', `${SEAT_WIND[s.seat]}家席位：${s.name} 离席`);
  s.userId = null; s.name = ''; s.joinedAt = null;
}

function updateConfig(room, config) {
  if (room.phase !== 'lobby') throw new Error('对局中无法修改规则');
  room.config = normalizeConfig(config);
}

function startGame(room) {
  if (room.phase === 'playing') throw new Error('对局已经开始');
  if (room.phase === 'ended') resetForRematch(room);
  const empty = room.seats.filter((s) => !s.userId);
  if (empty.length) throw new Error(`还有 ${empty.length} 个席位是空的`);
  room.phase = 'playing';
  room.startedAt = Date.now();
  room.endedAt = null;
  room.endReason = null;
  room.finalRanking = null;
  room.savedGameId = null;
  room.seats.forEach((s) => { s.score = room.config.startScore; s.riichi = false; s.wins = 0; });
  room.round = { wind: 'E', num: 1, honba: 0, dealer: null, dice: null };
  room.starterSeat = null;
  room.sticks = 0;
  room.hands = [];
  room.lastResult = null;
  room.undoStack = [];
  room.log = [];
  pushLog(room, 'start', '对局开始，请掷骰子决定起家');
}

/** 把已结束的房间退回大厅，保留房间号、规则与座位（用于「再来一局」） */
function resetForRematch(room) {
  const code = room.code;
  // hostKey 由 server.js 在建房时注入，createRoom 并不生成它。
  // 这里必须原样保留，否则「再来一局」之后场风盘设备就失去了主持权限。
  const hostKey = room.hostKey;
  const seatsBackup = room.seats.map((s) => ({ ...s, score: room.config.startScore, riichi: false, wins: 0 }));
  const fresh = createRoom({ userId: room.hostUserId, name: room.hostName, config: room.config });
  for (const k of Object.keys(room)) delete room[k];
  Object.assign(room, fresh);
  room.code = code;
  if (hostKey) room.hostKey = hostKey;
  room.seats = seatsBackup;
  pushLog(room, 'info', '准备下一场对局');
  return room;
}

/* ------------------------------ 掷骰 / 起家 ------------------------------ */

function rollDice(room) {
  if (room.phase !== 'playing') throw new Error('对局尚未开始');
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  const sum = d1 + d2;
  const r = room.round;
  let decided = false;
  if (room.starterSeat === null || room.starterSeat === undefined) {
    const seat = (sum - 1) % 4;
    room.starterSeat = seat;
    r.dealer = seat;
    decided = true;
    pushLog(room, 'dice', `掷骰 ${d1}+${d2}=${sum} → 自暂定庄（1号位）起数第 ${sum} 位，起家＝ ${room.seats[seat].name}（${SEAT_WIND[seat]}家）`);
  } else {
    pushLog(room, 'dice', `掷骰 ${d1}+${d2}=${sum}（开牌位置：从庄家数起第 ${sum} 家）`);
  }
  r.dice = { d1, d2, sum, at: Date.now(), decided };
  return r.dice;
}

function setStarter(room, seat) {
  if (room.phase !== 'playing') throw new Error('对局尚未开始');
  if (room.hands.length) throw new Error('已经开打，无法更改起家');
  const idx = Number(seat);
  if (!(idx >= 0 && idx <= 3)) throw new Error('席位不正确');
  room.starterSeat = idx;
  room.round.dealer = idx;
  pushLog(room, 'dice', `手动指定起家（${roundLabel(room)}亲）＝ ${room.seats[idx].name}`);
}

/* ------------------------------ 立直 ------------------------------ */

function setRiichi(room, seat, on) {
  if (room.phase !== 'playing') throw new Error('对局尚未开始');
  if (room.round.dealer === null) throw new Error('请先掷骰子决定起家');
  const s = room.seats[Number(seat)];
  if (!s || !s.userId) throw new Error('该席位没有玩家');
  const want = !!on;
  if (want === s.riichi) return s;
  if (want) {
    if (s.score < 1000) throw new Error(`${s.name} 点数不足 1000，无法立直`);
    s.riichi = true;
    s.score -= 1000;
    room.sticks += 1;
    pushLog(room, 'riichi', `立直：${s.name}（${windOf(room, s.seat)}家）−1000 → 供托 ${room.sticks * 1000} 点`);
  } else {
    s.riichi = false;
    s.score += 1000;
    room.sticks = Math.max(0, room.sticks - 1);
    pushLog(room, 'riichi', `取消立直：${s.name}（${windOf(room, s.seat)}家）+1000 → 供托 ${room.sticks * 1000} 点`);
  }
  return s;
}

/* ------------------------------ 和了 ------------------------------ */

function declareAgari(room, payload) {
  if (room.phase !== 'playing') throw new Error('对局尚未开始');
  const r = room.round;
  if (r.dealer === null) throw new Error('请先掷骰子决定起家');

  const winnerSeat = Number(payload.winnerSeat);
  if (!occupied(room, winnerSeat)) throw new Error('和了者席位无人');
  // 荣和时必须指定一个真实存在的放铳者席位，否则减分会打到不存在的席位上
  let loserSeat = null;
  if (!payload.tsumo) {
    if (payload.loserSeat === undefined || payload.loserSeat === null || payload.loserSeat === '') {
      throw new Error('请选择放铳者');
    }
    loserSeat = Number(payload.loserSeat);
    if (!Number.isInteger(loserSeat) || loserSeat < 0 || loserSeat > 3) throw new Error('放铳者席次不正确');
    if (loserSeat === winnerSeat) throw new Error('放铳者不能是和了者');
    if (!occupied(room, loserSeat)) throw new Error('放铳者席位无人');
  }

  const calc = scoring.calcHand({
    han: payload.han,
    fu: payload.fu,
    tsumo: !!payload.tsumo,
    winnerSeat,
    dealerSeat: r.dealer,
    loserSeat,
    honba: r.honba,
    sticks: room.sticks,
    kiriageMangan: room.config.kiriageMangan,
  });

  snapshot(room);

  for (const p of calc.payments) {
    room.seats[p.from].score -= p.amount;
    room.seats[p.to].score += p.amount;
  }
  const stickGain = room.sticks * 1000;
  room.seats[winnerSeat].score += stickGain;
  room.sticks = 0;
  room.seats[winnerSeat].wins += 1;
  room.seats.forEach((s) => { s.riichi = false; });

  const renchan = winnerSeat === r.dealer;
  const hand = {
    index: room.hands.length + 1,
    round: roundLabel(room),
    honba: r.honba,
    dealerSeat: r.dealer,
    type: 'agari',
    tsumo: !!payload.tsumo,
    winnerSeat,
    winnerName: room.seats[winnerSeat].name,
    winnerWind: windOf(room, winnerSeat),
    loserSeat: calc.tsumo ? null : loserSeat,
    loserName: calc.tsumo ? null : room.seats[loserSeat].name,
    han: Number(payload.han),
    fu: Number(payload.fu),
    label: calc.label,
    handTotal: calc.handTotal,
    gain: calc.gain,
    stickGain,
    payments: calc.payments,
    renchan,
    scoresAfter: room.seats.map((s) => s.score),
    at: Date.now(),
  };
  room.hands.push(hand);
  room.lastResult = hand;

  const parts = calc.payments.map((p) => `${room.seats[p.from].name} −${p.amount}`).join('、');
  pushLog(room, 'agari',
    `${hand.round}${r.honba}本场：${hand.winnerName}（${hand.winnerWind}家）${calc.tsumo ? '自摸' : '荣和' + (hand.loserName ? ' ' + hand.loserName : '')} ` +
    `${calc.label} +${calc.handTotal}${stickGain ? ` +供托${stickGain}` : ''}｜${parts}`);

  const endInfo = shouldEndAfterHand(room, renchan);
  if (endInfo.end) {
    endGame(room, endInfo.reason);
  } else {
    if (endInfo.reason === 'westExtension') pushLog(room, 'info', '无人达到基准点 → 进入西入');
    nextRound(room, renchan);
  }
  return hand;
}

/* ------------------------------ 流局 ------------------------------ */

function declareDraw(room, payload) {
  if (room.phase !== 'playing') throw new Error('对局尚未开始');
  const r = room.round;
  if (r.dealer === null) throw new Error('请先掷骰子决定起家');
  // 兼容两种写法：payload.type / payload.drawType（前者与动作 type 同名，容易混淆）
  const type = payload.type || payload.drawType || 'exhaustive';
  if (!DRAW_TYPES[type]) throw new Error('流局种类不正确');

  const tenpai = [0, 1, 2, 3].map((i) => !!(payload.tenpai && payload.tenpai[i]));
  snapshot(room);

  let payments = [];
  if (type === 'exhaustive' && room.config.notenBappu) payments = scoring.notenPenalty(tenpai);
  for (const p of payments) {
    room.seats[p.from].score -= p.amount;
    room.seats[p.to].score += p.amount;
  }
  room.seats.forEach((s) => { s.riichi = false; });

  const dealerTenpai = type === 'exhaustive' && tenpai[r.dealer];
  // 荒牌平局：只有庄家听牌才连庄。
  // 途中流局（九种九牌 / 四风连打 / 四家立直 / 三家和了 / 四开杠）与听牌无关，
  // 按通行规则（天凤、主流雀庄）一律**庄家连庄、本场 +1**。
  // 之前这里统一用 dealerTenpai，导致四种途中流局都把庄家赶下庄，
  // 局推进和本场数全错，场风盘上显示「下庄」。
  const renchan = type === 'exhaustive' ? !!dealerTenpai : true;
  const bappuTotal = payments.reduce((a, p) => a + p.amount, 0);

  const hand = {
    index: room.hands.length + 1,
    round: roundLabel(room),
    honba: r.honba,
    dealerSeat: r.dealer,
    type: 'draw',
    drawType: type,
    drawLabel: DRAW_TYPES[type],
    tenpai,
    payments,
    bappuTotal,
    renchan,
    dealerTenpai: !!dealerTenpai,
    scoresAfter: room.seats.map((s) => s.score),
    at: Date.now(),
  };
  room.hands.push(hand);
  room.lastResult = hand;

  const tp = tenpai.map((v, i) => (v ? room.seats[i].name : null)).filter(Boolean);
  pushLog(room, 'draw',
    `${hand.round}${r.honba}本场：${DRAW_TYPES[type]}｜听牌：${tp.length ? tp.join('、') : '无'}｜庄家${dealerTenpai ? '听牌 → 连庄' : '不听 → 庄家下庄'}${bappuTotal ? `｜罚符合计 ${bappuTotal}` : ''}`);

  const endInfo = shouldEndAfterHand(room, renchan);
  if (endInfo.end) endGame(room, endInfo.reason);
  else {
    if (endInfo.reason === 'westExtension') pushLog(room, 'info', '无人达到基准点 → 进入西入');
    nextRound(room, renchan);
  }
  return hand;
}

/* ------------------------------ 手动点数修正 ------------------------------ */

function adjustScores(room, scores) {
  if (room.phase !== 'playing') throw new Error('对局尚未开始');
  if (!Array.isArray(scores) || scores.length !== 4) throw new Error('点数格式不正确');
  // 逐个数校验：以前直接 Math.round(Number(x))，'abc' / 空串 / NaN 会静默变成
  // NaN 或 0，把整张桌子的点数污染掉，而且再也算不回来（终局收支全是 NaN）。
  const next = scores.map((v, i) => {
    if (v === '' || v === null || v === undefined) throw new Error(`第 ${i + 1} 家点数没有填写`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`第 ${i + 1} 家点数不是数字：${v}`);
    const r = Math.round(n);
    if (r < -9999999 || r > 9999999) throw new Error(`第 ${i + 1} 家点数超出范围：${v}`);
    return r;
  });
  snapshot(room);
  const before = room.seats.map((s) => s.score);
  room.seats.forEach((s, i) => { s.score = next[i]; });
  pushLog(room, 'manual', `手动修正点数：${room.seats.map((s, i) => `${s.name} ${before[i]}→${s.score}`).join('、')}`);
  const total = room.seats.reduce((a, s) => a + s.score, 0) + room.sticks * 1000;
  const std = room.config.startScore * 4;
  if (total !== std) {
    pushLog(room, 'manual', `注意：修正后总点数 ${total} ≠ 标准总额 ${std}，终局收支合计将不为 0`);
  }
  room.lastResult = { type: 'manual', scoresAfter: room.seats.map((s) => s.score), at: Date.now() };
}

function setHonba(room, honba) {
  if (room.phase !== 'playing') throw new Error('对局尚未开始');
  const n = clampInt(honba, 0, 99, 0);
  room.round.honba = n;
  pushLog(room, 'manual', `手动设置本场数 = ${n}`);
}

/* ------------------------------ 局推进 / 终局 ------------------------------ */

function isLastRound(room) {
  const r = room.round;
  const cfg = room.config;
  if (cfg.gameType === 'tonpuusen') return r.wind === 'E' && r.num === 4;
  if (cfg.westExtension) return r.wind === 'W' && r.num === 4;
  return r.wind === 'S' && r.num === 4;
}

function shouldEndAfterHand(room, renchan) {
  const cfg = room.config;
  const r = room.round;

  if (cfg.tobi && room.seats.some((s) => s.score < 0)) return { end: true, reason: 'tobi' };

  const last = isLastRound(room);
  const westLine = cfg.startScore + WEST_LINE_BONUS;
  if (cfg.agariYame && renchan && last && topSeat(room) === r.dealer) {
    return { end: true, reason: 'agariyame' };
  }
  if (renchan) return { end: false };

  if (!last) {
    if (cfg.gameType === 'hanchan' && cfg.westExtension) {
      if (r.wind === 'S' && r.num === 4) {
        // 南4 结束时已有人达到基准点 → 不进西入，正常打满终局
        if (room.seats.some((s) => s.score >= westLine)) return { end: true, reason: 'final' };
        return { end: false, reason: 'westExtension' };
      }
      if (r.wind === 'W' && room.seats.some((s) => s.score >= westLine)) {
        return { end: true, reason: 'westLine' };
      }
    }
    return { end: false };
  }
  return { end: true, reason: 'final' };
}

function nextRound(room, renchan) {
  const r = room.round;
  if (renchan) {
    r.honba += 1;
  } else {
    r.honba = 0;
    r.dealer = (r.dealer + 1) % 4;
    r.num += 1;
    if (r.num > 4) {
      r.num = 1;
      r.wind = r.wind === 'E' ? 'S' : 'W';
    }
  }
  r.dice = null;
  pushLog(room, 'info', `下一局：${roundLabel(room)} ${r.honba}本场（庄家：${room.seats[r.dealer].name}）`);
}

function endGame(room, reason) {
  // 以前这里 return room.finalRanking 静默略过：大厅里点「结束对局」会拿到一句
  // 「对局已结束」的假成功，房间却原地不动 —— 于是这间房永远开不了也关不掉。
  if (room.phase === 'ended') {
    const e = new Error('这局已经结束了。要再打一局，请点「再来一局」。');
    e.status = 400;
    e.code = 'ALREADY_ENDED';
    throw e;
  }
  if (room.phase !== 'playing') {
    const e = new Error('对局还没开始（现在在大厅），没有可结算的牌局。');
    e.status = 400;
    e.code = 'NOT_STARTED';
    throw e;
  }
  const cfg = room.config;
  const starter = room.starterSeat === null ? 0 : room.starterSeat;

  // 终局时桌上剩余的供托（立直棒）归一位 —— 雀庄公式战的通行做法
  if (room.sticks > 0) {
    const top = topSeat(room);
    const bonus = room.sticks * 1000;
    room.seats[top].score += bonus;
    pushLog(room, 'end', `终局供托 ${room.sticks} 根（${bonus} 点）归一位 ${room.seats[top].name}`);
    room.sticks = 0;
  }

  const order = scoring.settle(
    room.seats.map((s) => ({ seat: s.seat, score: s.score })),
    cfg,
    starter,
  );

  const yakitoriAdj = [0, 0, 0, 0];
  if (cfg.yakitori) {
    const winners = room.seats.filter((s) => s.wins > 0).map((s) => s.seat);
    const birds = room.seats.filter((s) => s.wins === 0).map((s) => s.seat);
    if (winners.length && birds.length) {
      for (const b of birds) yakitoriAdj[b] = -1000 * winners.length;
      for (const w of winners) yakitoriAdj[w] = 1000 * birds.length;
    }
  }

  const players = order.map((o) => {
    const s = room.seats[o.seat];
    const adj = yakitoriAdj[o.seat] || 0;
    return {
      seat: o.seat,
      userId: s.userId,
      name: s.name,
      score: s.score,
      rank: o.rank,
      diff: +(o.diff + adj / 1000).toFixed(1),
      yakitori: adj,
      wins: s.wins,
      starter: o.seat === room.starterSeat,
    };
  });

  room.finalRanking = { players, reason, at: Date.now(), yakitori: !!cfg.yakitori };
  room.phase = 'ended';
  room.endedAt = Date.now();
  room.endReason = reason;
  pushLog(room, 'end', `对局结束：${END_REASON[reason] || reason}`);
  return room.finalRanking;
}

/* ------------------------------ 撤销 ------------------------------ */

function snapshot(room) {
  const copy = JSON.parse(JSON.stringify({ ...room, undoStack: undefined }));
  room.undoStack.push(copy);
  if (room.undoStack.length > 40) room.undoStack.shift();
}

function undo(room) {
  const raw = room.undoStack.pop();
  if (!raw) throw new Error('没有可撤销的操作');
  const stack = room.undoStack;
  const code = room.code;
  for (const k of Object.keys(room)) delete room[k];
  Object.assign(room, raw);
  room.code = code;
  room.undoStack = stack;
  pushLog(room, 'manual', '撤销上一步操作');
}

/* ------------------------------ 手动录入一局 ------------------------------ */

/**
 * 手工录入一局：不建房、不记每一手，只把四家的最终点数存成一条对局记录。
 *
 * 适用场景：线下已经打完了、或者用的是别的记分工具，只想把这一局留进历史。
 *
 * 校验写在这里而不是路由里，测试可以直接打这个函数。
 * input: { config, players: [{name, score, userId}], allowUnbalanced, note, playedAt, hostUser }
 */
function buildManualGame(input) {
  input = input || {};
  const cfg = normalizeConfig(input.config);
  const raw = input.players;

  if (!Array.isArray(raw) || raw.length !== 4) {
    const e = new Error('需要正好 4 名玩家的最终点数');
    e.status = 400;
    throw e;
  }

  const seen = new Set();
  const seats = raw.map((p, i) => {
    const name = String((p && p.name) || '').trim();
    if (!name) {
      const e = new Error(`第 ${i + 1} 家的昵称不能为空`);
      e.status = 400;
      throw e;
    }
    if (name.length > 16) {
      const e = new Error(`第 ${i + 1} 家的昵称最多 16 个字`);
      e.status = 400;
      throw e;
    }
    if (seen.has(name.toLowerCase())) {
      const e = new Error(`昵称「${name}」重复了，一局里不能有两个同名`);
      e.status = 400;
      throw e;
    }
    seen.add(name.toLowerCase());

    // 点数：整数，允许负数（被击飞就是负的），上限防手滑多敲几个 0
    const score = Number(p.score);
    if (p.score === '' || p.score === null || p.score === undefined || !Number.isInteger(score)) {
      const e = new Error(`第 ${i + 1} 家（${name}）的点数必须是整数`);
      e.status = 400;
      throw e;
    }
    if (Math.abs(score) > 10000000) {
      const e = new Error(`第 ${i + 1} 家（${name}）的点数超出范围（±1000 万）`);
      e.status = 400;
      throw e;
    }

    return { seat: i, userId: p.userId || null, name, score: score, wins: 0, riichi: false, yakitori: 0 };
  });

  // 点数守恒：四家合计必须等于 4×起始点数，否则录进去的账永远是错的
  const total = seats.reduce((a, s) => a + s.score, 0);
  const expect = cfg.startScore * 4;
  if (total !== expect && !input.allowUnbalanced) {
    const e = new Error(`四家点数合计 ${total} 点，与 4×${cfg.startScore}=${expect} 对不上（差 ${total - expect} 点）。`
      + '确认要这样存的话，勾上「允许点数不平」。');
    e.status = 400;
    e.code = 'UNBALANCED';
    throw e;
  }

  const starterSeat = 0;
  const order = scoring.settle(seats.map((s) => ({ seat: s.seat, score: s.score })), cfg, starterSeat);

  const ranked = order.map((o) => {
    const s = seats[o.seat];
    return {
      seat: o.seat,
      userId: s.userId,
      name: s.name,
      score: s.score,
      rank: o.rank,
      diff: o.diff,
      yakitori: 0,
      wins: 0,
      starter: o.seat === starterSeat,
    };
  });

  const at = Number(input.playedAt) || Date.now();
  const note = String(input.note || '').trim().slice(0, 200);

  const log = [{
    at,
    kind: 'manual',
    text: '手动录入最终点数：' + ranked.map((p) => `${p.rank}位 ${p.name} ${p.score}`).join(' / '),
  }];
  if (note) log.push({ at, kind: 'note', text: '备注：' + note });
  if (total !== expect) log.push({ at, kind: 'note', text: `点数未守恒：合计 ${total}，应为 ${expect}（差 ${total - expect}）` });

  return {
    id: crypto.randomBytes(6).toString('hex'),
    code: null,
    manual: true,
    hostUserId: (input.hostUser && input.hostUser.id) || null,
    hostName: (input.hostUser && input.hostUser.name) || seats[0].name,
    createdAt: at,
    startedAt: at,
    endedAt: at,
    config: cfg,
    endReason: 'manual',
    endReasonText: '手动录入',
    starterSeat,
    // finalRanking 是顺位顺序；players 是座次顺序（管理端按这个列）
    finalRanking: { players: ranked, reason: 'manual', at, yakitori: false },
    players: seats.map((s) => {
      const r = ranked.find((x) => x.seat === s.seat);
      return {
        seat: s.seat,
        userId: s.userId,
        name: s.name,
        score: s.score,
        wins: 0,
        rank: r.rank,
        diff: r.diff,
        yakitori: 0,
      };
    }),
    hands: [],
    log,
    note,
    balanceDiff: total - expect,
  };
}

/* ------------------------------ 序列化 ------------------------------ */

function publicRoom(room) {
  // hostKey 属于场风盘设备私有凭证，绝不能出现在下发给玩家端的房间数据里
  const { undoStack, hostKey, ...rest } = room;
  return { ...rest, canUndo: (undoStack || []).length > 0 };
}

function summary(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostName: room.hostName,
    createdAt: room.createdAt,
    gameType: room.config.gameType,
    round: roundLabel(room),
    honba: room.round.honba,
    players: room.seats.filter((s) => s.userId).map((s) => s.name),
    seatsTaken: room.seats.filter((s) => s.userId).length,
  };
}

function buildGameRecord(room) {
  // 无论是否终局，都固定输出 4 名玩家的 userId —— 账号历史依赖它
  const ranked = (room.finalRanking && room.finalRanking.players) || [];
  const players = room.seats.map((s) => {
    const r = ranked.find((p) => p.seat === s.seat) || {};
    return {
      seat: s.seat,
      userId: s.userId || null,
      name: s.name,
      score: s.score,
      wins: s.wins,
      rank: r.rank || null,
      diff: r.diff === undefined ? null : r.diff,
      yakitori: r.yakitori || 0,
    };
  });

  return {
    id: crypto.randomBytes(6).toString('hex'),
    code: room.code,
    hostUserId: room.hostUserId || null,
    hostName: room.hostName || null,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt || Date.now(),
    config: room.config,
    endReason: room.endReason,
    endReasonText: END_REASON[room.endReason] || room.endReason,
    starterSeat: room.starterSeat,
    finalRanking: room.finalRanking,
    players,
    hands: room.hands,
    log: room.log,
  };
}

module.exports = {
  SEAT_WIND,
  WIND_CHAR,
  DRAW_TYPES,
  END_REASON,
  DEFAULT_CONFIG,
  normalizeConfig,
  roundLabel,
  windOf,
  topSeat,
  createRoom,
  joinSeat,
  leaveSeat,
  updateConfig,
  startGame,
  resetForRematch,
  rollDice,
  setStarter,
  setRiichi,
  declareAgari,
  declareDraw,
  adjustScores,
  setHonba,
  nextRound,
  endGame,
  undo,
  publicRoom,
  summary,
  buildGameRecord,
  buildManualGame,
};
