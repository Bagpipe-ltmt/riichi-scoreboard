'use strict';

/**
 * 立直麻将点数计算
 *  - 符·番 → 基本点 → 实际支付点数（不足 100 点进位）
 *  - 本场（连庄数）加算：荣和 +300/本场、自摸 +100/本场（每家）
 *  - 供托立直棒：和了者全部收走
 */

// 符的选择项（20 符为平和自摸专用、25 符为七对子专用）
const FU_LIST = [20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110];

function ceil100(n) {
  return Math.ceil(n / 100) * 100;
}

/**
 * 求基本点与牌型等级名
 * @returns {{base:number, name:string, limit:boolean}}
 */
function limitOf(han, fu, kiriageMangan = true) {
  if (han >= 13) {
    const mult = Math.floor(han / 13);
    return { base: 8000 * mult, name: mult >= 2 ? `役满×${mult}` : '役满', limit: true };
  }
  if (han >= 11) return { base: 6000, name: '三倍满', limit: true };
  if (han >= 8) return { base: 4000, name: '倍满', limit: true };
  if (han >= 6) return { base: 3000, name: '跳满', limit: true };
  if (han >= 5) return { base: 2000, name: '满贯', limit: true };
  // 切上满贯：4 番 30 符 / 3 番 60 符
  if (kiriageMangan && ((han === 4 && fu === 30) || (han === 3 && fu === 60))) {
    return { base: 2000, name: '满贯（切上）', limit: true };
  }
  const raw = fu * Math.pow(2, 2 + han);
  if (raw >= 2000) return { base: 2000, name: '满贯', limit: true };
  return { base: raw, name: `${han}番${fu}符`, limit: false };
}

/**
 * 计算一手和了的收授明细
 * @param {object} o
 * @param {number} o.han          番数 (1..26)
 * @param {number} o.fu           符
 * @param {boolean} o.tsumo       是否自摸
 * @param {number} o.winnerSeat   和了者席次 0..3
 * @param {number} o.dealerSeat   庄家席次 0..3
 * @param {number} [o.loserSeat]  放铳者席次（荣和时必填）
 * @param {number} [o.honba]      本场数
 * @param {number} [o.sticks]     供托立直棒数
 * @param {boolean} [o.kiriageMangan]
 * @returns {{label:string,isDealer:boolean,base:number,tsumo:boolean,
 *            payments:Array<{from:number,to:number,amount:number}>,
 *            handTotal:number,stickTotal:number,gain:number}}
 */
function calcHand(o) {
  const han = Number(o.han);
  const fu = Number(o.fu);
  const tsumo = !!o.tsumo;
  const winnerSeat = Number(o.winnerSeat);
  const dealerSeat = Number(o.dealerSeat);
  const honba = Number(o.honba || 0);
  const sticks = Number(o.sticks || 0);
  const kiriageMangan = o.kiriageMangan !== false;

  if (!Number.isInteger(winnerSeat) || winnerSeat < 0 || winnerSeat > 3) {
    throw new Error('和了者席次不正确');
  }
  if (!Number.isInteger(han) || han < 1 || han > 26) throw new Error('番数不正确');
  if (!Number.isInteger(fu) || fu < 20 || fu > 110) throw new Error('符不正确');

  // 放铳者必须是一个真实存在的席位。
  // 之前只挡了「没填」和「等于和了者」，漏了越界值（0..3 之外），
  // 结果 payments 会指向 room.seats[9] 这种不存在的席位，
  // 在 game.js 里减分时抛 TypeError，整个请求变成 500。
  let loserSeat = null;
  if (!tsumo) {
    if (o.loserSeat === null || o.loserSeat === undefined) throw new Error('请选择放铳者');
    loserSeat = Number(o.loserSeat);
    if (!Number.isInteger(loserSeat) || loserSeat < 0 || loserSeat > 3) throw new Error('放铳者席次不正确');
    if (loserSeat === winnerSeat) throw new Error('放铳者不能是和了者');
  }

  const isDealer = winnerSeat === dealerSeat;
  const lim = limitOf(han, fu, kiriageMangan);
  const base = lim.base;
  const payments = [];

  if (tsumo) {
    for (let s = 0; s < 4; s++) {
      if (s === winnerSeat) continue;
      // 庄家自摸：每家 base×2 / 闲家自摸：庄家 base×2、闲家 base×1
      const mult = isDealer ? 2 : (s === dealerSeat ? 2 : 1);
      payments.push({ from: s, to: winnerSeat, amount: ceil100(base * mult) + 100 * honba });
    }
  } else {
    const mult = isDealer ? 6 : 4;
    payments.push({
      from: loserSeat,
      to: winnerSeat,
      amount: ceil100(base * mult) + 300 * honba,
    });
  }

  const handTotal = payments.reduce((a, p) => a + p.amount, 0);
  const stickTotal = sticks * 1000;

  return {
    label: lim.name,
    isDealer,
    base,
    tsumo,
    payments,
    handTotal,
    stickTotal,
    gain: handTotal + stickTotal,
  };
}

/**
 * 荒牌平局的不听罚符。
 *
 * 罚符池固定 3000 点：不听者**合计**支付 3000（按不听人数均摊），
 * 听牌者**合计**收取 3000（按听牌人数均分）。于是每一对
 * (不听者 → 听牌者) 的转移额 = 3000 ÷ (不听人数 × 听牌人数)：
 *   1 人听牌：不听者各付 1000，听牌者收 3000
 *   2 人听牌：不听者各付 1500，听牌者各收 1500
 *   3 人听牌：不听者付 3000，听牌者各收 1000
 * nNoten、nTenpai 只能是 1/2/3，3000 必被二者之积整除，故无需取整。
 * 四家全听或全不听：无罚符。
 * @param {boolean[]} tenpai 长度4
 * @returns {Array<{from:number,to:number,amount:number}>}
 */
function notenPenalty(tenpai) {
  const t = tenpai.map(Boolean);
  const nTenpai = t.filter(Boolean).length;
  const out = [];
  if (nTenpai === 0 || nTenpai === 4) return out;
  const nNoten = 4 - nTenpai;
  const per = 3000 / (nNoten * nTenpai);
  for (let f = 0; f < 4; f++) {
    if (t[f]) continue;
    for (let to = 0; to < 4; to++) {
      if (!t[to]) continue;
      out.push({ from: f, to, amount: per });
    }
  }
  return out;
}

/**
 * 不听罚符的净额一览（给前端预览用）
 * @param {boolean[]} tenpai 长度4
 * @returns {{none:boolean, perNoten:number, perTenpai:number, nNoten:number, nTenpai:number}}
 */
function notenSummary(tenpai) {
  const t = tenpai.map(Boolean);
  const nTenpai = t.filter(Boolean).length;
  const nNoten = 4 - nTenpai;
  if (nTenpai === 0 || nTenpai === 4) return { none: true, perNoten: 0, perTenpai: 0, nNoten, nTenpai };
  return { none: false, perNoten: 3000 / nNoten, perTenpai: 3000 / nTenpai, nNoten, nTenpai };
}

/**
 * 顺位精算：只按起始点数算收支，不做任何加成
 * 收支 = (最终点数 − 起始点数) ÷ 1000，四家合计恒为 0
 * @param {Array<{seat:number,score:number}>} seats
 * @param {object} cfg
 * @param {number} starterSeat 起家席次（同点时靠起家近者上位）
 */
function settle(seats, cfg, starterSeat = 0) {
  const order = seats.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = (a.seat - starterSeat + 4) % 4;
    const db = (b.seat - starterSeat + 4) % 4;
    return da - db;
  });
  const start = cfg.startScore;
  return order.map((s, i) => {
    const diff = +((s.score - start) / 1000).toFixed(1);
    return {
      seat: s.seat,
      score: s.score,
      rank: i + 1,
      diff,
    };
  });
}

module.exports = { FU_LIST, ceil100, limitOf, calcHand, notenPenalty, notenSummary, settle };
