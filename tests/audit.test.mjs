import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditFrameRobustness,
  validateFrameCap,
  encodeSequence,
  decodeStream,
  compareSequences,
  MIN_FRAME_CAP,
  MAX_FRAME_CAP,
} from '../src/audit.js';
import { solve } from '../src/solver.js';

const alert = (name, freq, lo, hi) => ({ name, freq, lo, hi });

/** 与审计器独立的暴力枚举：枚举全部帧（1..K 条）× 全部反转位 × 精确解码。 */
function bruteAudit(codes, K) {
  const n = codes.length;
  let best = null; // { seq, pos, decoded }
  const seq = [];
  function consider(candidate) {
    if (
      !best ||
      compareSequences(candidate.seq, best.seq) < 0 ||
      (compareSequences(candidate.seq, best.seq) === 0 && candidate.pos < best.pos)
    ) {
      best = candidate;
    }
  }
  function gen() {
    if (seq.length >= 1) {
      const bits = encodeSequence(seq, codes);
      for (let p = 0; p < bits.length; p++) {
        const flipped = bits.slice(0, p) + (bits[p] === '0' ? '1' : '0') + bits.slice(p + 1);
        const dec = decodeStream(flipped, codes);
        if (dec && dec.length >= 1 && dec.length <= K) {
          consider({ seq: seq.slice(), pos: p, decoded: dec });
        }
      }
    }
    if (seq.length === K) return;
    for (let i = 0; i < n; i++) {
      seq.push(i);
      gen();
      seq.pop();
    }
  }
  gen();
  return best;
}

function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机前缀无关码：随机比特串，拒绝与已选码字互为前缀者。 */
function randomPrefixCodes(rand, n, maxLen) {
  for (;;) {
    const codes = [];
    let guard = 0;
    while (codes.length < n && guard++ < 5000) {
      const len = 1 + Math.floor(rand() * maxLen);
      let c = '';
      for (let i = 0; i < len; i++) c += rand() < 0.5 ? '0' : '1';
      const clash = codes.some((o) => c.startsWith(o) || o.startsWith(c));
      if (!clash) codes.push(c);
    }
    if (codes.length === n) return codes;
  }
}

/* ---------------- 基础工具 ---------------- */

test('validateFrameCap：仅接受 2–10 的整数', () => {
  assert.equal(validateFrameCap(MIN_FRAME_CAP), null);
  assert.equal(validateFrameCap(MAX_FRAME_CAP), null);
  assert.ok(validateFrameCap(1));
  assert.ok(validateFrameCap(11));
  assert.ok(validateFrameCap(2.5));
  assert.ok(validateFrameCap(NaN));
  assert.ok(validateFrameCap('4'));
});

test('encodeSequence / decodeStream：编码可精确还原，残缺比特流解码失败', () => {
  const codes = ['00', '01', '10', '110', '111'];
  assert.equal(encodeSequence([0, 3, 2], codes), '0011010');
  assert.deepEqual(decodeStream('0011010', codes), [0, 3, 2]);
  assert.equal(decodeStream('0', codes), null); // 残余比特无法成码
  assert.deepEqual(decodeStream('0110', codes), [1, 2]); // '01'+'10' 恰好完整
  assert.equal(decodeStream('1110', codes), null); // '111' 后余 '0'
  assert.equal(decodeStream('0010' + '1', codes), null); // 末尾残余
});

test('compareSequences：索引字典序，前缀短者居前', () => {
  assert.ok(compareSequences([0], [1]) < 0);
  assert.ok(compareSequences([0], [0, 0]) < 0);
  assert.ok(compareSequences([0, 2], [0, 1]) > 0);
  assert.equal(compareSequences([2, 0], [2, 0]), 0);
});

/* ---------------- 手工核算的审计结论 ---------------- */

test('已知风险：单码字帧翻转一位即成为另一码字', () => {
  // '00' 翻转第 1 位 → '10'（码字 #3）
  const r = auditFrameRobustness(['00', '01', '10', '11'], 4);
  assert.equal(r.status, 'risk');
  assert.deepEqual(r.witness.sequence, [0]);
  assert.equal(r.witness.flipIndex, 0);
  assert.equal(r.witness.originalBits, '00');
  assert.equal(r.witness.disturbedBits, '10');
  assert.deepEqual(r.witness.decoded, [2]);
});

test('已知安全：等长偶校验码，任意两帧编码汉明距离 ≠ 1', () => {
  // 4 位偶校验码字两两汉明距离为 2；等长码 ⇒ 条数不同则帧长不同，条数相同则距离 ≥ 2
  const codes = ['0000', '0011', '0101', '0110', '1001', '1010', '1100', '1111'];
  for (const k of [MIN_FRAME_CAP, 5, MAX_FRAME_CAP]) {
    const r = auditFrameRobustness(codes, k);
    assert.equal(r.status, 'safe', `K=${k} 应安全`);
    assert.equal(r.frameCap, k);
    assert.ok(r.exploredStates > 0);
  }
});

test('跨码字边界的翻转：拼接处一位反转改变切分', () => {
  // 帧 [0,1] = '00'+'11' = '0011'，翻转第 2 位 → '0111' = '01'+'11' = [1,2]
  const codes = ['00', '01', '11', '1010', '1011'];
  const r = auditFrameRobustness(codes, 4);
  assert.equal(r.status, 'risk');
  // 字典序最小原序列：[0] = '00' 翻转第 2 位 → '01' = [1]
  assert.deepEqual(r.witness.sequence, [0]);
  assert.equal(r.witness.flipIndex, 1);
  assert.equal(r.witness.disturbedBits, '01');
  assert.deepEqual(r.witness.decoded, [1]);
});

test('字典序最小与最早反转位：多个候选中取 (序列, 位置) 最小者', () => {
  // 候选：'00' 翻第1位→'10'=[2]（序列[0]位0）；'00' 翻第2位→'01'=[1]（序列[0]位1）；
  //       '01' 翻第2位→'00'=[0]（序列[1]位1）
  const r = auditFrameRobustness(['00', '01', '10', '110', '111'], 3);
  assert.equal(r.status, 'risk');
  assert.deepEqual(r.witness.sequence, [0]); // 序列 [0] 字典序最小
  assert.equal(r.witness.flipIndex, 0); // 同序列取最早反转位
  assert.deepEqual(r.witness.decoded, [2]);
});

test('受扰帧同样受条数上限约束：超出上限的解码不计为风险', () => {
  // 码字 '0' 与 '10'、'110'、'1110'、'1111'：帧 [0] = '0' 翻转为 '1' 无法完整解码；
  // 帧 [0,0] = '00' 翻转第 1 位 → '10' = [1]（1 条 ≤ K）⇒ K≥2 时有风险
  const codes = ['0', '10', '110', '1110', '1111'];
  assert.equal(auditFrameRobustness(codes, 2).status, 'risk');
  // 安全码表换个上限仍安全；这里用偶校验码验证 K=2 与 K=10 结论一致
  const even = ['0000', '0011', '0101', '0110', '1001'];
  assert.equal(auditFrameRobustness(even, MIN_FRAME_CAP).status, 'safe');
  assert.equal(auditFrameRobustness(even, MAX_FRAME_CAP).status, 'safe');
});

test('witness 自洽：受扰串与原串恰好一位不同，且解码结果不同于原序列', () => {
  const codes = ['0', '10', '110', '1110', '1111'];
  const r = auditFrameRobustness(codes, 3);
  assert.equal(r.status, 'risk');
  const w = r.witness;
  assert.equal(w.originalBits, encodeSequence(w.sequence, codes));
  assert.equal(w.disturbedBits.length, w.originalBits.length);
  let diff = 0;
  for (let i = 0; i < w.originalBits.length; i++) {
    if (w.originalBits[i] !== w.disturbedBits[i]) diff++;
  }
  assert.equal(diff, 1, '恰好一次 0/1 反转');
  assert.equal(w.disturbedBits[w.flipIndex] !== w.originalBits[w.flipIndex], true);
  assert.deepEqual(decodeStream(w.disturbedBits, codes), w.decoded);
  assert.notDeepEqual(w.decoded, w.sequence);
});

test('非法输入：帧上限越界或非前缀码', () => {
  assert.equal(auditFrameRobustness(['0', '1'], 1).status, 'error');
  assert.equal(auditFrameRobustness(['0', '1'], 11).status, 'error');
  assert.equal(auditFrameRobustness(['0', '01'], 4).status, 'error'); // 非前缀无关
  assert.equal(auditFrameRobustness([], 4).status, 'error');
  assert.equal(auditFrameRobustness(['0', '12'], 4).status, 'error');
});

/* ---------------- 与暴力枚举对拍 ---------------- */

test('与暴力枚举对拍：随机前缀码的结论与最优证据完全一致', () => {
  const rand = mulberry32(20260925);
  let risks = 0;
  for (let t = 0; t < 200; t++) {
    const n = 5 + Math.floor(rand() * 2); // 5–6 类
    const codes = randomPrefixCodes(rand, n, 4);
    const K = MIN_FRAME_CAP + Math.floor(rand() * 3); // 2–4
    const mine = auditFrameRobustness(codes, K);
    const brute = bruteAudit(codes, K);
    if (!brute) {
      assert.equal(mine.status, 'safe', `用例 ${t}: 暴力安全但审计给出 ${JSON.stringify(mine)}`);
      continue;
    }
    risks++;
    assert.equal(mine.status, 'risk', `用例 ${t}: 暴力有风险但审计安全`);
    const w = mine.witness;
    assert.deepEqual(w.sequence, brute.seq, `用例 ${t} 字典序最小原序列`);
    assert.equal(w.flipIndex, brute.pos, `用例 ${t} 最早反转位`);
    assert.deepEqual(w.decoded, brute.decoded, `用例 ${t} 误报序列`);
    assert.equal(w.originalBits, encodeSequence(brute.seq, codes));
    assert.equal(w.disturbedBits, encodeSequence(brute.decoded, codes));
  }
  assert.ok(risks > 50, `对拍中风险用例过少（${risks}），覆盖不足`);
});

test('对拍：求解器输出的真实码表（含保留前缀）', () => {
  const rand = mulberry32(998244353);
  for (let t = 0; t < 12; t++) {
    const n = 5 + Math.floor(rand() * 3);
    const alerts = Array.from({ length: n }, (_, i) => {
      const lo = 1 + Math.floor(rand() * 2);
      return alert(`a${i}`, 1 + Math.floor(rand() * 9), lo, lo + 1 + Math.floor(rand() * 2));
    });
    const pool = ['0', '1', '00', '01', '10', '11'];
    const reserved = pool.filter(() => rand() < 0.2).slice(0, 2);
    const solved = solve({ alerts, reserved });
    if (solved.status !== 'optimal') continue;
    const codes = solved.alerts.map((a) => a.code);
    const K = 2 + Math.floor(rand() * 3);
    const mine = auditFrameRobustness(codes, K);
    const brute = bruteAudit(codes, K);
    if (!brute) {
      assert.equal(mine.status, 'safe', `用例 ${t}`);
    } else {
      assert.equal(mine.status, 'risk', `用例 ${t}`);
      assert.deepEqual(mine.witness.sequence, brute.seq, `用例 ${t} 序列`);
      assert.equal(mine.witness.flipIndex, brute.pos, `用例 ${t} 反转位`);
    }
  }
});

/* ---------------- 性能 ---------------- */

test('性能：8 类 12 位安全码表在帧上限 10 下快速完成完整判定', () => {
  // 8 个 12 位偶校验码字：两两汉明距离 ≥ 2，任意 K 下安全，状态空间需完整探索
  const even12 = [];
  for (let i = 0; i < 8; i++) {
    let s = i.toString(2).padStart(11, '0');
    const ones = [...s].filter((c) => c === '1').length;
    s += ones % 2 === 0 ? '0' : '1';
    even12.push(s);
  }
  const start = performance.now();
  const r = auditFrameRobustness(even12, MAX_FRAME_CAP);
  const elapsed = performance.now() - start;
  assert.equal(r.status, 'safe');
  assert.ok(elapsed < 3000, `耗时 ${elapsed.toFixed(0)}ms 超出预期`);
});
