/**
 * 单比特串扰审计（纯逻辑，无 DOM 依赖，浏览器 / Node 通用）。
 *
 * 给定一张前缀无关码表，判定：是否存在"一帧连续发送 1..frameLimit 条警报"
 * 的合法帧，使其连续编码在发生【恰好一次】0/1 反转后，仍能被贪心解码器
 * 【完整】解码为【另一帧】警报（条数可变、码词边界可漂移）。
 *
 * 为什么不能只比较单条码字：反转位可能让解码器在后续比特上重新对齐，
 * 跨越原码词边界后才恰好落回若干完整码词。例如码表
 *   {10,110,0110,1111,000,0101}：单条码字各反转一位都无法被完整解码，
 *   但帧 10|0110 = 100110 首位反转后得到 000110 = 000|110，被误解为
 *   完全不同的两条警报。因此必须联合枚举（原帧连续编码 × 反转位置 ×
 *   受扰流的精确解码）。
 *
 * 精确判定（完整枚举，非抽样）：
 *   在"按原码词边界追加整条码词"的产品视角下，受扰解码器是一个确定性
 *   自动机——状态为解码前缀树中的部分匹配节点（根 = 边界对齐）。追加
 *   整条码词 c 时，从状态 q 逐位转移：走到码词叶子即发出一条警报并回到
 *   根；缺少分支则该流不可完整解码（FAIL）。
 *   反转发生在某个码词的第 j 位（0≤j<|c|）：反转前两路流完全相同，解码
 *   器状态恒为根；反转后受扰机进入 q'，其后再追加 m 条码词能否恰好回到
 *   根，由预计算表 R[m][q'] / C[m][q']（可达性 / 路径数）一次性给出。
 *   于是"是否存在风险"是 帧 × 反转位 全空间上的精确布尔判定；风险组合
 *   数由计数 DP 精确汇总；字典序最小的原帧序列与最早反转位按相同枚举
 *   序贪心重建。最后对受扰比特串再跑一次真实的字符串贪心解码，记录其
 *   实际解出的警报序列，与自动机判定互相印证。
 */

export const MIN_FRAME_LIMIT = 2;
export const MAX_FRAME_LIMIT = 10;

/**
 * 审计入口。
 * @param {Array<{name:string, code:string}>} alerts 已生成码表（按输入顺序）
 * @param {number} frameLimit 一帧连续发送警报条数上限（2–10）
 * @returns 结果对象：
 *   { status:'invalid', errors }
 *   { status:'safe'|'risk', frameLimit, alertCount, legalFrames,
 *     flipCombinations, dangerousCombinations, witness? }
 */
export function audit(alerts, frameLimit) {
  const errors = validateAuditInput(alerts, frameLimit);
  if (errors.length > 0) return { status: 'invalid', errors };

  const n = alerts.length;
  const L = frameLimit;
  const codes = alerts.map((a) => String(a.code));
  const names = alerts.map((a) => String(a.name));
  const trie = buildTrie(codes);
  const { stateCount, adv, flipAdv, FAIL } = trie;

  /*
   * R[k][q]：从受扰状态 q 起再追加【恰好 k 条】完整码词后，能否恰好回到
   * 根（即受扰流剩余部分被完整解码、无悬挂比特）。
   * C[k][q]：同样条件下的后缀码词序列条数（精确计数）。
   */
  const R = [new Uint8Array(stateCount)];
  const C = [new Float64Array(stateCount)];
  R[0][0] = 1;
  C[0][0] = 1;
  for (let k = 1; k <= L; k++) {
    const rk = new Uint8Array(stateCount);
    const ck = new Float64Array(stateCount);
    for (let q = 0; q < stateCount; q++) {
      let count = 0;
      for (let i = 0; i < n; i++) {
        const t = adv[q][i];
        if (t === FAIL) continue;
        if (R[k - 1][t]) {
          rk[q] = 1;
          count += C[k - 1][t];
        }
      }
      ck[q] = count;
    }
    R.push(rk);
    C.push(ck);
  }

  /**
   * G[b][q]：从受扰状态 q 起，至多再追加 b 条码词，能否在某次恰好回到根
   * （= ∃m∈[0,b] R[m][q]）。F[b]：未来还有 b 条码词（反转前机器恒在根），
   * 反转能否发生在其中某条并在这 b 条之内回到根。二者用于按帧枚举序
   * 贪心重建证人，避免最坏情况下的指数搜索。
   */
  const G = [new Uint8Array(stateCount)];
  for (let q = 0; q < stateCount; q++) G[0][q] = R[0][q];
  for (let b = 1; b <= L; b++) {
    const gb = new Uint8Array(stateCount);
    for (let q = 0; q < stateCount; q++) gb[q] = G[b - 1][q] || R[b][q];
    G.push(gb);
  }
  const F = new Uint8Array(L + 1);
  for (let b = 1; b <= L; b++) {
    let exists = false;
    for (let i = 0; i < n && !exists; i++) {
      for (let j = 0; j < codes[i].length; j++) {
        const q = flipAdv(i, j);
        if (q !== FAIL && G[b - 1][q]) {
          exists = true;
          break;
        }
      }
    }
    F[b] = F[b - 1] || exists;
  }

  /**
   * 证人重建：按"前缀优先帧序"逐条码词贪心。每到一个帧节点，先检查已发生
   * 的反转是否恰好回根（该帧的受扰流被完整解码）；否则沿【子树中确有
   * 证人】的最小下标码词继续。子树证人存在 ⇔ 旧反转/本码词新反转能在
   * 剩余预算内回根，或更后面的码词上存在可行反转（F）。
   */
  function findWitness() {
    const seq = [];
    let pendings = []; // 已发生反转：{pos, q}，按位序递增
    let bitPos = 0;
    for (let b = L; b >= 1; b--) {
      // 当前帧本身：最早使受扰机恰好回根的反转位
      for (const pend of pendings) {
        if (pend.q === 0) return { seq, flipPos: pend.pos };
      }
      const budget = b - 1;
      let chosen = -1;
      for (let i = 0; i < n; i++) {
        const viaOld = pendings.some((p) => adv[p.q][i] !== FAIL && G[budget][adv[p.q][i]]);
        let viaNew = false;
        for (let j = 0; j < codes[i].length; j++) {
          const q = flipAdv(i, j);
          if (q !== FAIL && G[budget][q]) {
            viaNew = true;
            break;
          }
        }
        if (viaOld || viaNew || F[budget]) {
          chosen = i;
          break;
        }
      }
      if (chosen < 0) throw new Error('audit_inconsistent：计数值有风险但无法重建证人');
      const code = codes[chosen];
      const next = [];
      for (const pend of pendings) {
        const q = adv[pend.q][chosen];
        if (q !== FAIL) next.push({ pos: pend.pos, q });
      }
      for (let j = 0; j < code.length; j++) {
        const q = flipAdv(chosen, j);
        if (q !== FAIL) next.push({ pos: bitPos + j, q });
      }
      // 同位序反转唯一；next 先旧后新，天然按位序递增
      pendings = next;
      seq.push(chosen);
      bitPos += code.length;
    }
    for (const pend of pendings) {
      if (pend.q === 0) return { seq, flipPos: pend.pos };
    }
    throw new Error('audit_inconsistent：计数值有风险但无法重建证人');
  }

  /* ---------------- 全空间精确计数 ---------------- */

  const totalLen = codes.reduce((s, c) => s + c.length, 0);
  // 合法帧数 Σℓ n^ℓ；（帧, 反转位）组合数 Σℓ n^(ℓ-1)·Σ|c|
  let legalFrames = 0;
  let flipCombinations = 0;
  for (let ell = 1, npow = n; ell <= L; ell++, npow *= n) {
    legalFrames += npow;
    // 长度 ℓ 的帧中，每个码词在每个位置各出现 n^(ℓ-1) 次
    flipCombinations += ell * (npow / n) * totalLen;
  }
  // 会被完整误解的（帧, 反转位）组合数：
  // Σℓ Σ_t n^t · Σ_i Σ_j C[ℓ-t-1][flipAdv(i,j)]
  let dangerousCombinations = 0;
  for (let ell = 1; ell <= L; ell++) {
    for (let t = 0; t < ell; t++) {
      const prefixes = n ** t;
      let perPrefix = 0;
      const m = ell - t - 1;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < codes[i].length; j++) {
          const q = flipAdv(i, j);
          if (q !== FAIL) perPrefix += C[m][q];
        }
      }
      dangerousCombinations += prefixes * perPrefix;
    }
  }

  const base = {
    frameLimit: L,
    alertCount: n,
    legalFrames,
    flipCombinations,
    dangerousCombinations,
  };
  if (dangerousCombinations === 0) return { status: 'safe', ...base };

  /* ---------------- 风险：取字典序最小证人并精确解码受扰流 ---------------- */

  const w = findWitness();
  const originalSegments = w.seq.map((i) => ({ index: i, name: names[i], code: codes[i] }));
  const originalBits = w.seq.map((i) => codes[i]).join('');
  const flippedFrom = originalBits[w.flipPos];
  const disturbedBits =
    originalBits.slice(0, w.flipPos) +
    (flippedFrom === '0' ? '1' : '0') +
    originalBits.slice(w.flipPos + 1);
  const decoded = greedyDecode(disturbedBits, codes);
  if (!decoded) {
    throw new Error('audit_inconsistent：自动机判定可完整解码，但字符串解码失败');
  }
  const decodedSegments = decoded.map((i) => ({ index: i, name: names[i], code: codes[i] }));

  return {
    status: 'risk',
    ...base,
    witness: {
      frameIndices: w.seq,
      frameNames: w.seq.map((i) => names[i]),
      originalSegments,
      originalBits,
      flipPosition: w.flipPos, // 0 基位序
      flippedFrom,
      flippedTo: flippedFrom === '0' ? '1' : '0',
      disturbedBits,
      decodedIndices: decoded,
      decodedNames: decoded.map((i) => names[i]),
      decodedSegments,
    },
  };
}

/** 对真实比特串执行贪心前缀解码；无法完整解码返回 null，否则返回警报下标序列。 */
export function greedyDecode(bits, codes) {
  const out = [];
  let pos = 0;
  while (pos < bits.length) {
    let hit = -1;
    for (let i = 0; i < codes.length; i++) {
      if (bits.startsWith(codes[i], pos)) {
        hit = i;
        break;
      }
    }
    if (hit < 0) return null;
    out.push(hit);
    pos += codes[hit].length;
  }
  return out;
}

/* ---------------- 前缀树与受扰自动机 ---------------- */

/**
 * @returns {{stateCount, adv:number[][], flipAdv:Function, FAIL:number}}
 * 持久状态只含根与内部节点（码词叶子在落入瞬间发出并回到根）。
 */
function buildTrie(codes) {
  const nodes = [{ children: [-1, -1], terminal: false }];
  for (const c of codes) {
    let node = nodes[0];
    for (const ch of c) {
      const bit = ch === '0' ? 0 : 1;
      if (node.children[bit] < 0) {
        node.children[bit] = nodes.length;
        nodes.push({ children: [-1, -1], terminal: false });
      }
      node = nodes[node.children[bit]];
    }
    node.terminal = true;
  }
  const FAIL = -1;
  const stateCount = nodes.length;

  /** 从状态 q 逐位读完码词 i：中途发出码词则回根继续，缺分支即失败。 */
  function transit(q, i, flipAt = -1) {
    const code = codes[i];
    let node = q;
    for (let b = 0; b < code.length; b++) {
      let bit = code[b] === '0' ? 0 : 1;
      if (b === flipAt) bit ^= 1;
      const next = nodes[node].children[bit];
      if (next < 0) return FAIL;
      node = next;
      if (nodes[node].terminal) node = 0; // 发出一条警报，回到边界
    }
    return node;
  }

  const adv = [];
  for (let q = 0; q < stateCount; q++) {
    adv[q] = codes.map((_, i) => transit(q, i));
  }
  // 反转前受扰机与原机相同，必在根；反转码词 i 的第 j 位后落入的状态。
  const flipAdv = (i, j) => transit(0, i, j);
  return { stateCount, adv, flipAdv, FAIL };
}

/* ---------------- 输入校验 ---------------- */

export function validateAuditInput(alerts, frameLimit) {
  const errors = [];
  if (!Array.isArray(alerts) || alerts.length < 2) {
    errors.push('审计至少需要 2 类已分配码字的警报。');
    return errors;
  }
  const seenCodes = new Set();
  const seenNames = new Set();
  alerts.forEach((a, i) => {
    const label = `第 ${i + 1} 类警报`;
    const code = String(a?.code ?? '');
    const name = String(a?.name ?? '').trim();
    if (!/^[01]+$/.test(code)) {
      errors.push(`${label}：码字须为非空 0/1 串。`);
      return;
    }
    if (seenCodes.has(code)) errors.push(`${label}：码字 ${code} 与其他类别重复。`);
    seenCodes.add(code);
    if (name === '') errors.push(`${label}：名称不能为空。`);
    else if (seenNames.has(name)) errors.push(`${label}：名称「${name}」与其他类别重复。`);
    seenNames.add(name);
  });
  if (seenCodes.size >= 2) {
    const list = [...seenCodes];
    for (const a of list) {
      for (const b of list) {
        if (a !== b && b.startsWith(a)) {
          errors.push(`码表不是前缀无关码：码字 ${a} 是 ${b} 的前缀，无法唯一拆分连续电文。`);
        }
      }
    }
  }
  if (!Number.isInteger(frameLimit) || frameLimit < MIN_FRAME_LIMIT || frameLimit > MAX_FRAME_LIMIT) {
    errors.push(`帧警报条数上限须为 ${MIN_FRAME_LIMIT}–${MAX_FRAME_LIMIT} 的整数。`);
  }
  return errors;
}
