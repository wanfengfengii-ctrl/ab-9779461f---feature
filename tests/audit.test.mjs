/**
 * 单比特串扰审计测试：
 *   - 手工核算的跨码词边界风险例（证明不能只比较单条码字）；
 *   - 与求解器端到端联动的安全例 / 风险例；
 *   - 完整枚举计数（合法帧、帧×反转位组合、风险组合）；
 *   - 与独立暴力枚举的随机对拍（判定、计数、字典序最小证人、最早反转位）；
 *   - 输入校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, greedyDecode, validateAuditInput, MIN_FRAME_LIMIT, MAX_FRAME_LIMIT } from '../src/audit.js';
import { solve } from '../src/solver.js';

const mk = (codes, names) => codes.map((c, i) => ({ name: names?.[i] ?? `A${i}`, code: c }));

/* ---------------- 手工核算 ---------------- */

test('跨码词边界风险：单条码字安全、两条连发即被误解', () => {
  // 码表 {10,110,0110,1111,000,0101}：
  // 每个单条码字任意翻一位都不能被完整解码；但帧 10|0110 = 100110
  // 首位翻转为 000110 = 000|110，完整误解为另一条两警报帧。
  const codes = ['10', '110', '0110', '1111', '000', '0101'];
  // 直接核验"单条码字比较"确实发现不了：
  for (const c of codes) {
    for (let p = 0; p < c.length; p++) {
      const y = c.slice(0, p) + (c[p] === '0' ? '1' : '0') + c.slice(p + 1);
      assert.equal(greedyDecode(y, codes), null, `单条码字 ${c} 翻转 ${p} 不应可解码`);
    }
  }
  const r = audit(mk(codes), 2);
  assert.equal(r.status, 'risk');
  const w = r.witness;
  assert.deepEqual(w.frameIndices, [0, 2]); // 字典序最小原帧
  assert.equal(w.flipPosition, 0); // 最早反转位（位序自 0 起）
  assert.equal(w.originalBits, '100110');
  assert.equal(w.disturbedBits, '000110');
  assert.deepEqual(w.decodedIndices, [4, 1]); // 受扰串的实际解码
  assert.notDeepEqual(w.frameIndices, w.decodedIndices);
  // 受扰流按解出序列重新编码必须逐位吻合
  assert.equal(w.decodedIndices.map((i) => codes[i]).join(''), w.disturbedBits);
  assert.ok(r.dangerousCombinations > 0);

  // 帧上限 1 非法（需求规定 2–10）
  assert.equal(audit(mk(codes), 1).status, 'invalid');
});

test('完整等长码：任意单比特翻转都落回另一条码词，全部组合皆风险', () => {
  const codes = ['000', '001', '010', '011', '100', '101', '110', '111'];
  const r = audit(mk(codes), 2);
  assert.equal(r.status, 'risk');
  assert.equal(r.legalFrames, 8 + 64); // n + n^2
  assert.equal(r.flipCombinations, 1 * 8 * 3 + 2 * 64 * 3); // 408
  assert.equal(r.dangerousCombinations, r.flipCombinations);
  const w = r.witness;
  assert.deepEqual(w.frameIndices, [0]); // 字典序最小帧为单条 A0
  assert.equal(w.flipPosition, 0);
  assert.equal(w.originalBits, '000');
  assert.equal(w.disturbedBits, '100');
  assert.deepEqual(w.decodedIndices, [4]);
});

test('两位满码 {0,1}：计数与证人精确', () => {
  const r = audit(mk(['0', '1']), 2);
  assert.equal(r.status, 'risk');
  assert.equal(r.legalFrames, 6);
  assert.equal(r.flipCombinations, 10);
  assert.equal(r.dangerousCombinations, 10);
  assert.deepEqual(r.witness.frameIndices, [0]);
  assert.equal(r.witness.disturbedBits, '1');
  assert.deepEqual(r.witness.decodedIndices, [1]);
});

/* ---------------- 与求解器端到端 ---------------- */

test('端到端安全例：求解器码表在帧上限 2–10 内均给出明确安全结论', () => {
  const input = {
    alerts: [
      { name: 'a0', freq: 25, lo: 5, hi: 12 },
      { name: 'a1', freq: 29, lo: 4, hi: 12 },
      { name: 'a2', freq: 16, lo: 6, hi: 12 },
      { name: 'a3', freq: 21, lo: 4, hi: 12 },
      { name: 'a4', freq: 19, lo: 7, hi: 12 },
    ],
    reserved: ['11'],
  };
  const solved = solve(input);
  assert.equal(solved.status, 'optimal');
  assert.deepEqual(solved.alerts.map((a) => a.code), ['00000', '0001', '000010', '0010', '0000110']);
  for (const L of [2, 3, 5, 10]) {
    const r = audit(solved.alerts.map((a) => ({ name: a.name, code: a.code })), L);
    assert.equal(r.status, 'safe', `L=${L}`);
    assert.equal(r.dangerousCombinations, 0);
    assert.ok(r.legalFrames > 0);
    assert.ok(r.flipCombinations > 0);
    assert.equal(r.frameLimit, L);
  }
});

test('端到端风险例（内置示例码表）：返回原帧、最早反转位、受扰串与误报序列', () => {
  const solved = solve({
    alerts: [
      { name: '特大地震预警', freq: 3, lo: 2, hi: 6 },
      { name: '强余震警报', freq: 8, lo: 2, hi: 5 },
      { name: '海啸警报', freq: 5, lo: 2, hi: 5 },
      { name: '滑坡泥石流警报', freq: 12, lo: 1, hi: 4 },
      { name: '应急演练通知', freq: 20, lo: 1, hi: 3 },
      { name: '解除警报', freq: 15, lo: 1, hi: 4 },
    ],
    reserved: ['1110'],
  });
  assert.equal(solved.status, 'optimal');
  const r = audit(solved.alerts.map((a) => ({ name: a.name, code: a.code })), 2);
  assert.equal(r.status, 'risk');
  const w = r.witness;
  assert.deepEqual(w.frameNames, ['特大地震预警', '强余震警报']);
  assert.equal(w.originalBits, '1111000'); // 1111|000
  assert.equal(w.flipPosition, 6); // 最后一位
  assert.equal(w.flippedFrom, '0');
  assert.equal(w.flippedTo, '1');
  assert.equal(w.disturbedBits, '1111001'); // 1111|001
  assert.deepEqual(w.decodedNames, ['特大地震预警', '海啸警报']);
  assert.equal(w.originalSegments.length, 2);
  assert.equal(w.decodedSegments.length, 2);
});

/* ---------------- 独立暴力对拍 ---------------- */

function bruteAudit(codes, L) {
  let legalFrames = 0;
  let flipCombinations = 0;
  let dangerous = 0;
  let best = null;
  const cmp = (a, b) => {
    for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) return a[k] - b[k];
    return a.length - b.length;
  };
  const rec = (seq, bits) => {
    if (seq.length >= 1) {
      legalFrames++;
      flipCombinations += bits.length;
      for (let p = 0; p < bits.length; p++) {
        const y = bits.slice(0, p) + (bits[p] === '0' ? '1' : '0') + bits.slice(p + 1);
        const d = greedyDecode(y, codes);
        if (d) {
          dangerous++;
          if (!best || cmp(seq, best.seq) < 0 || (cmp(seq, best.seq) === 0 && p < best.p)) {
            best = { seq: seq.slice(), p, d };
          }
        }
      }
    }
    if (seq.length === L) return;
    for (let i = 0; i < codes.length; i++) {
      seq.push(i);
      rec(seq, bits + codes[i]);
      seq.pop();
    }
  };
  rec([], '');
  return { legalFrames, flipCombinations, dangerous, best };
}

function isPrefixFreeDistinct(cs) {
  if (new Set(cs).size !== cs.length) return false;
  return cs.every((a) => cs.every((b) => a === b || !(b.startsWith(a) || a.startsWith(b))));
}
function rngMaker(seed) {
  let s = seed;
  return () => {
    s += 0x6d2b79f5;
    let r = Math.imul(s ^ (s >>> 15), s | 1);
    r ^= r + Math.imul(r ^ (s >>> 7), r | 61);
    return ((r ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

test('与独立暴力枚举对拍：判定、计数、字典序最小证人完全一致', () => {
  let tested = 0;
  for (let seed = 1; seed < 8000 && tested < 120; seed++) {
    const rng = rngMaker(seed * 104729 + 7);
    const n = 2 + Math.floor(rng() * 6);
    const maxLen = 2 + Math.floor(rng() * 2);
    const L = 2 + Math.floor(rng() * 4);
    const codes = [];
    let guard = 0;
    while (codes.length < n && guard++ < 2000) {
      const len = 1 + Math.floor(rng() * maxLen);
      let c = '';
      for (let k = 0; k < len; k++) c += rng() < 0.5 ? '0' : '1';
      if (!codes.includes(c) && isPrefixFreeDistinct([...codes, c])) codes.push(c);
    }
    if (codes.length < n) continue;
    tested++;
    const got = audit(mk(codes), L);
    const want = bruteAudit(codes, L);
    assert.equal(got.legalFrames, want.legalFrames);
    assert.equal(got.flipCombinations, want.flipCombinations);
    assert.equal(got.dangerousCombinations, want.dangerous, `codes=${codes} L=${L}`);
    if (want.dangerous === 0) {
      assert.equal(got.status, 'safe');
    } else {
      assert.equal(got.status, 'risk');
      assert.deepEqual(got.witness.frameIndices, want.best.seq, `证人帧 codes=${codes} L=${L}`);
      assert.equal(got.witness.flipPosition, want.best.p, `反转位 codes=${codes} L=${L}`);
      assert.deepEqual(got.witness.decodedIndices, want.best.d);
    }
  }
  assert.ok(tested >= 100, `对拍用例数不足：${tested}`);
});

/* ---------------- 校验 ---------------- */

test('validateAuditInput：帧上限、前缀无关性、重名重码', () => {
  const good = mk(['00', '01', '10', '11', '110']).slice(0, 4);
  assert.deepEqual(validateAuditInput(good, MIN_FRAME_LIMIT), []);
  assert.deepEqual(validateAuditInput(good, MAX_FRAME_LIMIT), []);
  assert.ok(validateAuditInput(good, MIN_FRAME_LIMIT - 1).length > 0);
  assert.ok(validateAuditInput(good, MAX_FRAME_LIMIT + 1).length > 0);
  assert.ok(validateAuditInput(good, 2.5).length > 0);
  assert.ok(validateAuditInput([{ name: 'a', code: '0' }], 3).length > 0);
  assert.ok(validateAuditInput([{ name: 'a', code: '0' }, { name: 'b', code: '01' }], 3)
    .some((e) => e.includes('前缀无关')));
  assert.ok(validateAuditInput([{ name: 'a', code: '00' }, { name: 'a', code: '01' }], 3)
    .some((e) => e.includes('重复') || e.includes('名称')));
  assert.ok(validateAuditInput([{ name: 'a', code: '00' }, { name: 'b', code: '00' }], 3)
    .some((e) => e.includes('重复')));
  assert.ok(validateAuditInput([{ name: 'a', code: '2' }, { name: 'b', code: '01' }], 3)
    .some((e) => e.includes('0/1')));
});
