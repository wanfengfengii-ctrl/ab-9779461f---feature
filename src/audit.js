/**
 * 单比特串扰审计（纯逻辑，无 DOM 依赖，浏览器 / Node 通用）。
 *
 * 问题：给定已生效的前缀码表与一帧连续发送的警报条数上限 K（2–10），
 * 判定是否存在某个合法帧（1–K 条警报的码字拼接），其比特流在任意一个
 * 位置发生恰好一次 0/1 反转后，仍能被完整解码为另一合法帧（≤K 条），
 * 即一次误码会不会被接收方完整误报成另一帧警报。
 *
 * 方法（联合枚举原帧连续编码 × 反转位置 × 受扰比特流的精确解码，
 * 不比较单条码字、不抽样）：
 *   前缀码解码唯一，故"翻转一位后被完整误解为另一帧"精确等价于
 *   存在两个不同的合法帧编码，等长且汉明距离恰为 1。
 *   在"原帧侧 × 受扰侧"的积自动机上同步逐位生成两条比特流：
 *     状态 = (原侧未完成码字前缀, 受扰侧未完成前缀, 已用反转数,
 *             原侧已完成条数, 受扰侧已完成条数)；
 *     每步为两侧各生成一位（受扰位 = 原位 ⊕ e，全程恰好一步 e = 1）；
 *     两侧同时回到码字边界且已用反转数为 1，即发现一次完整误解。
 *   先以 BFS 作存在性判定（无风险时快速给出安全结论）；存在风险时
 *   再以"原警报序列字典序"为键的 Dijkstra 求出字典序最小的原序列，
 *   最后对该序列逐位扫描取最早反转位并精确解码受扰比特串。
 *   同一状态对应的原序列长度相同（= 已完成条数），同长字典序满足
 *   右不变性，故每个状态只需保留首次弹出的最小键，搜索有限且精确。
 */

import { isPrefixFree } from './solver.js';

export const MIN_FRAME_CAP = 2;
export const MAX_FRAME_CAP = 10;

/** 校验帧条数上限，返回中文错误信息或 null（通过）。 */
export function validateFrameCap(frameCap) {
  if (!Number.isInteger(frameCap) || frameCap < MIN_FRAME_CAP || frameCap > MAX_FRAME_CAP) {
    return `帧条数上限须为 ${MIN_FRAME_CAP}–${MAX_FRAME_CAP} 的整数。`;
  }
  return null;
}

/** 把警报索引序列按码表拼接为连续比特串。 */
export function encodeSequence(sequence, codes) {
  return sequence.map((i) => codes[i]).join('');
}

/**
 * 前缀码精确解码：从左到右累积比特，命中码字即切出
 * （前缀无关保证每个位置至多一种切法，贪心即唯一解码）。
 * 完整解码返回警报索引数组；中途无匹配或末尾有残余时返回 null。
 */
export function decodeStream(bits, codes) {
  const indexOf = new Map(codes.map((c, i) => [c, i]));
  const out = [];
  let cur = '';
  for (const ch of bits) {
    cur += ch;
    const idx = indexOf.get(cur);
    if (idx !== undefined) {
      out.push(idx);
      cur = '';
    }
  }
  return cur === '' ? out : null;
}

/** 警报索引序列字典序：逐条比较（索引小者居前），一方为另一方前缀时短者居前。 */
export function compareSequences(a, b) {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * 审计码表在帧条数上限 frameCap 内的单比特串扰稳健性。
 * 返回：
 *   { status: 'safe',  frameCap, exploredStates }
 *   { status: 'risk',  frameCap, exploredStates,
 *     witness: { sequence, flipIndex, originalBits, disturbedBits, decoded } }
 *     —— sequence/decoded 为警报索引序列，flipIndex 为 0 起始的比特位置
 *   { status: 'error', reason } —— 输入不合法
 */
export function auditFrameRobustness(codes, frameCap) {
  const capError = validateFrameCap(frameCap);
  if (capError) return { status: 'error', reason: capError };
  if (
    !Array.isArray(codes) ||
    codes.length === 0 ||
    !codes.every((c) => typeof c === 'string' && /^[01]+$/.test(c)) ||
    !isPrefixFree(codes)
  ) {
    return { status: 'error', reason: '码表不是合法的前缀无关码，无法审计。' };
  }

  const K = frameCap;

  /* ---------- 码字前缀自动机：trans[u][bit] = [下一前缀, 完成的码字索引或 -1] ---------- */
  const prefixes = [''];
  const prefixIndex = new Map([['', 0]]);
  for (const c of codes) {
    for (let i = 1; i < c.length; i++) {
      const p = c.slice(0, i);
      if (!prefixIndex.has(p)) {
        prefixIndex.set(p, prefixes.length);
        prefixes.push(p);
      }
    }
  }
  const codeIndex = new Map(codes.map((c, i) => [c, i]));
  const PV = prefixes.length;
  const trans = new Array(PV * 2).fill(null);
  for (let u = 0; u < PV; u++) {
    for (let bit = 0; bit <= 1; bit++) {
      const s = prefixes[u] + bit;
      const ci = codeIndex.get(s);
      if (ci !== undefined) {
        trans[u * 2 + bit] = [0, ci]; // 恰好完成一个码字，回到空前缀
      } else {
        const pi = prefixIndex.get(s);
        if (pi !== undefined) trans[u * 2 + bit] = [pi, -1];
      }
    }
  }

  // 状态编码：(u, v, d, a, b)，条数维 0..K
  const A = K + 1;
  const idOf = (u, v, d, a, b) => (((u * PV + v) * 2 + d) * A + a) * A + b;
  const ID_SPACE = PV * PV * 2 * A * A;
  const decodeId = (id) => {
    let t = id;
    const b = t % A;
    t = (t / A) | 0;
    const a = t % A;
    t = (t / A) | 0;
    const d = t % 2;
    t = (t / 2) | 0;
    const v = t % PV;
    const u = (t / PV) | 0;
    return [u, v, d, a, b];
  };
  const START = idOf(0, 0, 0, 0, 0);
  let explored = 0;

  /* ---------- 阶段一：BFS 完整判定是否存在风险 ---------- */
  let riskFound = false;
  {
    const seen = new Uint8Array(ID_SPACE);
    seen[START] = 1;
    const queue = [START];
    let head = 0;
    while (head < queue.length && !riskFound) {
      const [u, v, d, a, b] = decodeId(queue[head++]);
      explored++;
      for (let bit = 0; bit <= 1 && !riskFound; bit++) {
        const t1 = trans[u * 2 + bit];
        if (!t1) continue;
        const a2 = a + (t1[1] >= 0 ? 1 : 0);
        if (a2 > K) continue;
        for (let e = 0; e <= 1 - d; e++) {
          const t2 = trans[v * 2 + (bit ^ e)];
          if (!t2) continue;
          const b2 = b + (t2[1] >= 0 ? 1 : 0);
          if (b2 > K) continue;
          const u2 = t1[0];
          const v2 = t2[0];
          const d2 = d | e;
          if (u2 === 0 && v2 === 0 && d2 === 1 && a2 >= 1 && b2 >= 1) {
            riskFound = true; // 两侧同时完整成帧且恰好反转一次
            break;
          }
          const id2 = idOf(u2, v2, d2, a2, b2);
          if (!seen[id2]) {
            seen[id2] = 1;
            queue.push(id2);
          }
        }
      }
    }
  }

  if (!riskFound) {
    return { status: 'safe', frameCap: K, exploredStates: explored };
  }

  /* ---------- 阶段二：Dijkstra 求字典序最小的原警报序列 ---------- */
  // 键 = 原帧侧已完成码字序列；同状态键同长，字典序右不变，首次弹出即最小。
  const done = new Uint8Array(ID_SPACE);
  const parent = new Int32Array(ID_SPACE).fill(-1);
  const stepInfo = new Int32Array(ID_SPACE); // bit | e<<1 | (cA+1)<<2 | (cB+1)<<6
  const heap = []; // 元素 [key, stateId, parentId, pack]
  const heapLess = (i, j) => compareSequences(heap[i][0], heap[j][0]) < 0;
  const heapPush = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(i, p)) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(l, m)) m = l;
        if (r < heap.length && heapLess(r, m)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  heapPush([[], START, -1, 0]);
  let goalKey = null;
  while (heap.length > 0 && goalKey === null) {
    const [key, id, pid, pack] = heapPop();
    if (done[id]) continue;
    done[id] = 1;
    parent[id] = pid;
    stepInfo[id] = pack;
    explored++;
    const [u, v, d, a, b] = decodeId(id);
    if (u === 0 && v === 0 && d === 1 && a >= 1 && b >= 1) {
      goalKey = key; // 首次弹出的目标即字典序最小的原序列
      break;
    }
    for (let bit = 0; bit <= 1; bit++) {
      const t1 = trans[u * 2 + bit];
      if (!t1) continue;
      const cA = t1[1];
      const a2 = a + (cA >= 0 ? 1 : 0);
      if (a2 > K) continue;
      for (let e = 0; e <= 1 - d; e++) {
        const t2 = trans[v * 2 + (bit ^ e)];
        if (!t2) continue;
        const cB = t2[1];
        const b2 = b + (cB >= 0 ? 1 : 0);
        if (b2 > K) continue;
        const id2 = idOf(t1[0], t2[0], d | e, a2, b2);
        if (done[id2]) continue;
        const key2 = cA >= 0 ? [...key, cA] : key;
        const pack2 = bit | (e << 1) | ((cA + 1) << 2) | ((cB + 1) << 6);
        heapPush([key2, id2, id, pack2]);
      }
    }
  }

  if (goalKey === null) {
    // 与 BFS 判定矛盾，理论不可达；防御性报错而非给出错误结论
    return { status: 'error', reason: '审计内部状态不一致，请重新生成码表后再试。' };
  }

  /* ---------- 阶段三：对最小序列扫描最早反转位并精确解码 ---------- */
  const sequence = goalKey;
  const originalBits = encodeSequence(sequence, codes);
  for (let p = 0; p < originalBits.length; p++) {
    const disturbedBits =
      originalBits.slice(0, p) + (originalBits[p] === '0' ? '1' : '0') + originalBits.slice(p + 1);
    const decoded = decodeStream(disturbedBits, codes);
    // 受扰串与原串不同 ⇒ 解码序列必不同于原序列（前缀码解码唯一）
    if (decoded && decoded.length >= 1 && decoded.length <= K) {
      return {
        status: 'risk',
        frameCap: K,
        exploredStates: explored,
        witness: { sequence, flipIndex: p, originalBits, disturbedBits, decoded },
      };
    }
  }
  // 阶段二保证该序列至少存在一个可完整误解的反转位，理论不可达
  return { status: 'error', reason: '审计内部状态不一致，请重新生成码表后再试。' };
}
