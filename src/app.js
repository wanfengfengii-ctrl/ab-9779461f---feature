import {
  solve,
  MIN_ALERTS,
  MAX_ALERTS,
  MAX_RESERVED,
  MAX_CODE_LENGTH,
} from './solver.js';
import { audit, MIN_FRAME_LIMIT, MAX_FRAME_LIMIT } from './audit.js';
import { buildTreeLayout } from './tree.js';

const SAMPLE = {
  alerts: [
    { name: '特大地震预警', freq: '3', lo: '2', hi: '6' },
    { name: '强余震警报', freq: '8', lo: '2', hi: '5' },
    { name: '海啸警报', freq: '5', lo: '2', hi: '5' },
    { name: '滑坡泥石流警报', freq: '12', lo: '1', hi: '4' },
    { name: '应急演练通知', freq: '20', lo: '1', hi: '3' },
    { name: '解除警报', freq: '15', lo: '1', hi: '4' },
  ],
  reserved: ['1110'],
};

const EMPTY_ALERT = () => ({ name: '', freq: '', lo: '', hi: '' });

const state = {
  alerts: structuredClone(SAMPLE.alerts),
  reserved: [...SAMPLE.reserved],
};

/** 当前仍有效的码表（optimal 结果）；码表/保留前缀变更即置空。审计随其失效。 */
let currentResult = null;
/** 最近一次审计结论；码表、保留前缀或帧上限变更后立即置空。 */
let currentAudit = null;

const $ = (sel) => document.querySelector(sel);
const alertRowsEl = $('#alert-rows');
const reservedRowsEl = $('#reserved-rows');
const errorsEl = $('#errors');
const resultsEl = $('#results');

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ---------------- 输入区渲染 ---------------- */

function renderAlertRows() {
  const canRemove = state.alerts.length > MIN_ALERTS;
  const rows = state.alerts
    .map(
      (a, i) => `
      <tr>
        <td class="idx">${i + 1}</td>
        <td><input type="text" data-idx="${i}" data-field="name" value="${esc(a.name)}"
             placeholder="警报名称" maxlength="24"></td>
        <td><input type="number" data-idx="${i}" data-field="freq" value="${esc(a.freq)}"
             min="1" step="1" placeholder="正整数"></td>
        <td><input type="number" data-idx="${i}" data-field="lo" value="${esc(a.lo)}"
             min="1" max="${MAX_CODE_LENGTH}" step="1"></td>
        <td><input type="number" data-idx="${i}" data-field="hi" value="${esc(a.hi)}"
             min="1" max="${MAX_CODE_LENGTH}" step="1"></td>
        <td><button type="button" class="btn small danger" data-remove-alert="${i}"
             ${canRemove ? '' : 'disabled'} title="删除此类别">删除</button></td>
      </tr>`,
    )
    .join('');
  alertRowsEl.innerHTML = `
    <table class="grid">
      <thead>
        <tr>
          <th>#</th><th>警报名称</th><th>预计发送频次</th>
          <th>码长下限</th><th>码长上限</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  $('#add-alert').disabled = state.alerts.length >= MAX_ALERTS;
  $('#alert-count').textContent = `${state.alerts.length} / ${MAX_ALERTS} 类（至少 ${MIN_ALERTS} 类）`;
}

function renderReservedRows() {
  reservedRowsEl.innerHTML =
    state.reserved.length === 0
      ? '<p class="hint">暂无保留前缀，可添加 0–3 条。</p>'
      : state.reserved
          .map(
            (r, i) => `
        <div class="reserved-row">
          <span class="idx">#${i + 1}</span>
          <input type="text" data-reserved-idx="${i}" value="${esc(r)}"
                 placeholder="如 0110（1–${MAX_CODE_LENGTH} 位 0/1）" pattern="[01]+" spellcheck="false">
          <button type="button" class="btn small danger" data-remove-reserved="${i}">删除</button>
        </div>`,
          )
          .join('');
  $('#add-reserved').disabled = state.reserved.length >= MAX_RESERVED;
}

function renderForm() {
  renderAlertRows();
  renderReservedRows();
}

/* ---------------- 结论失效 ---------------- */

function invalidateResults(message = '输入已变更，旧结论已失效，请重新生成码表。') {
  // 码表、保留前缀或录入参数变更：旧码表与旧审计结论一并清除
  currentResult = null;
  currentAudit = null;
  $('#audit-panel').hidden = true;
  resultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
}

/** 仅清除旧审计结论（帧上限变更时码表本身仍然有效）。 */
function invalidateAudit(message = '审计结论已失效，请重新执行审计。') {
  currentAudit = null;
  renderAudit(null, message);
}

function clearErrors() {
  errorsEl.hidden = true;
  errorsEl.innerHTML = '';
}

function showErrors(errors) {
  errorsEl.hidden = false;
  errorsEl.innerHTML = `<strong>参数未通过校验：</strong><ul>${
    errors.map((e) => `<li>${esc(e)}</li>`).join('')
  }</ul>`;
}

/* ---------------- 结果区渲染 ---------------- */

function renderBanner(result) {
  if (result.status === 'optimal') {
    return `<div class="banner ok">✓ 已找到最优码表：总加权码长 <b>${result.cost}</b>，最大码长 <b>${result.maxLength}</b>。</div>`;
  }
  if (result.status === 'error') {
    return `<div class="banner fail">✗ 求解中断。<p>${esc(result.reason ?? '')}</p></div>`;
  }
  const reason = result.reason ? `<p>${esc(result.reason)}</p>` : '';
  return `<div class="banner fail">✗ 没有可用的完整分配。${reason}</div>`;
}

function renderStats(result) {
  const { kraft } = result;
  return `
    <div class="stats">
      <div class="stat"><span class="stat-label">总加权码长（总成本）</span><span class="stat-value">${result.cost}</span></div>
      <div class="stat"><span class="stat-label">最大码长</span><span class="stat-value">${result.maxLength}</span></div>
      <div class="stat"><span class="stat-label">码字占用码空间</span><span class="stat-value">${kraft.codes} / ${kraft.unit}</span></div>
      <div class="stat"><span class="stat-label">保留分支占用</span><span class="stat-value">${kraft.reserved} / ${kraft.unit}</span></div>
      <div class="stat"><span class="stat-label">剩余空闲</span><span class="stat-value">${kraft.free} / ${kraft.unit}</span></div>
    </div>`;
}

function renderDetailTable(result, involved = null) {
  // involved: { orig: Set<警报下标>, decoded: Set<警报下标> } —— 审计风险时标示涉事行
  const rows = result.alerts
    .map((a, i) => {
      const badges = involved
        ? [
            involved.orig.has(i) ? '<span class="tag tag-orig">原帧</span>' : '',
            involved.decoded.has(i) ? '<span class="tag tag-decoded">误报帧</span>' : '',
          ].join('')
        : '';
      const rowClass = involved
        ? `${involved.orig.has(i) ? 'audit-orig-row' : ''} ${involved.decoded.has(i) ? 'audit-decoded-row' : ''}`
        : '';
      return `
      <tr class="${rowClass}">
        <td class="idx">${i + 1}</td>
        <td>${esc(a.name)}${badges ? `<div class="tag-row">${badges}</div>` : ''}</td>
        <td><code class="code">${esc(a.code)}</code></td>
        <td>${a.length}</td>
        <td>${a.freq}</td>
        <td>${a.freq} × ${a.length} = <b>${a.contribution}</b></td>
      </tr>`;
    })
    .join('');
  return `
    <h3>码字明细</h3>
    <table class="grid detail">
      <thead>
        <tr><th>#</th><th>警报</th><th>码字</th><th>码长</th><th>频次</th><th>加权贡献</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="5">总成本（加权码长总和）</td><td><b>${result.cost}</b></td></tr>
      </tfoot>
    </table>`;
}

function renderReserved(result) {
  if (!result.reserved || result.reserved.length === 0) {
    return '<h3>保留分支</h3><p class="hint">未设置保留前缀。</p>';
  }
  const rows = result.reserved
    .map(
      (r) => `
      <tr>
        <td><code class="code reserved">${esc(r.prefix)}</code></td>
        <td>${r.length}</td>
        <td>2<sup>-${r.length}</sup> = ${r.weight} / ${result.kraft.unit}</td>
        <td>该前缀的子树整体封禁，码字既不落入也不遮蔽</td>
      </tr>`,
    )
    .join('');
  return `
    <h3>保留分支</h3>
    <table class="grid detail">
      <thead><tr><th>保留前缀</th><th>长度</th><th>占用码空间</th><th>约束</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function truncate(s, n = 6) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 计算涉事码词在码树中的全部祖先前缀集合（根到叶子的路径）。 */
function pathPrefixes(result, indexSet) {
  const prefixes = new Set();
  for (const i of indexSet) {
    const code = result.alerts[i].code;
    for (let d = 1; d <= code.length; d++) prefixes.add(code.slice(0, d));
  }
  return prefixes;
}

function hlClass(prefix, origPrefixes, decodedPrefixes) {
  const o = origPrefixes.has(prefix);
  const d = decodedPrefixes.has(prefix);
  return o && d ? 'hl-both' : o ? 'hl-orig' : d ? 'hl-decoded' : '';
}

function renderTree(result, involved = null) {
  const { nodes, edges, width, height } = buildTreeLayout(
    result.alerts.map((a) => ({ code: a.code, name: a.name })),
    result.reserved ?? [],
  );
  const origPrefixes = involved ? pathPrefixes(result, involved.orig) : new Set();
  const decodedPrefixes = involved ? pathPrefixes(result, involved.decoded) : new Set();

  const edgeSvg = edges
    .map((e) => {
      const mx = (e.from.cx + e.to.cx) / 2;
      const my = (e.from.cy + e.to.cy) / 2;
      const cls = involved ? hlClass(e.to.prefix, origPrefixes, decodedPrefixes) : '';
      return `
        <line x1="${e.from.cx}" y1="${e.from.cy}" x2="${e.to.cx}" y2="${e.to.cy}" class="edge ${cls}"/>
        <text x="${mx}" y="${my - 3}" class="edge-bit ${cls}">${e.bit}</text>`;
    })
    .join('');

  const nodeSvg = nodes
    .map((n) => {
      if (n.type === 'dot') {
        return `<circle cx="${n.cx}" cy="${n.cy}" r="2.6" class="dot"><title>未使用的子树</title></circle>`;
      }
      const nodeHl = involved && n.type !== 'root' ? hlClass(n.prefix, origPrefixes, decodedPrefixes) : '';
      if (n.type === 'code') {
        return `
          <g class="node code-node ${nodeHl}">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>${esc(n.label)}：${esc(n.prefix)}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">${esc(truncate(n.label))}</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      if (n.type === 'reserved') {
        return `
          <g class="node reserved-node ${nodeHl}">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>保留前缀：${esc(n.prefix)}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">保留</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      const label = n.type === 'root' ? '根' : '';
      return `
        <g class="node internal-node ${nodeHl}">
          <circle cx="${n.cx}" cy="${n.cy}" r="8"><title>前缀 ${n.prefix === '' ? 'ε（空）' : esc(n.prefix)}</title></circle>
          ${label ? `<text x="${n.cx}" y="${n.cy - 14}" class="node-label">${label}</text>` : ''}
        </g>`;
    })
    .join('');

  const legend = involved
    ? `<p class="hint tree-legend">
        路径标示：<span class="swatch hl-orig"></span>原帧码词路径
        <span class="swatch hl-decoded"></span>受扰后实际解出（误报帧）路径
        <span class="swatch hl-both"></span>两条路径重合段
      </p>`
    : '';

  return `
    <h3>二叉码树</h3>
    <p class="hint">绿节点为已分配码字，红节点为保留分支，灰点为未使用的子树；边标注 0/1。</p>
    ${legend}
    <div class="tree-wrap">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           role="img" aria-label="二叉码树">
        ${edgeSvg}${nodeSvg}
      </svg>
    </div>`;
}

/** 审计风险时两条涉事路径上的警报下标集合；无结论或安全时为 null。 */
function involvedSets(auditResult) {
  if (!auditResult || auditResult.status !== 'risk') return null;
  const w = auditResult.witness;
  return { orig: new Set(w.frameIndices), decoded: new Set(w.decodedIndices) };
}

function paintResult() {
  const involved = involvedSets(currentAudit);
  resultsEl.innerHTML = `
    ${renderBanner(currentResult)}
    ${renderStats(currentResult)}
    ${renderTree(currentResult, involved)}
    ${renderDetailTable(currentResult, involved)}
    ${renderReserved(currentResult)}
    <p class="hint">搜索节点数：${currentResult.exploredNodes}。码字两两前缀无关，任意连续电文均可按前缀码唯一拆分。</p>`;
}

function renderResult(result) {
  if (result.status === 'optimal') {
    currentResult = result;
    currentAudit = null;
    paintResult();
    $('#audit-panel').hidden = false;
    renderAuditPlaceholder();
  } else {
    // infeasible / error：明确说明没有可用的完整分配；码表无效，审计一并关闭
    currentResult = null;
    currentAudit = null;
    $('#audit-panel').hidden = true;
    const reservedInfo =
      result.reserved && result.reserved.length > 0
        ? `<p class="hint">当前保留前缀：${result.reserved
            .map((r) => `<code class="code reserved">${esc(typeof r === 'string' ? r : r.prefix)}</code>`)
            .join('、')}</p>`
        : '';
    resultsEl.innerHTML = `${renderBanner(result)}${reservedInfo}`;
  }
}

/* ---------------- 单比特串扰审计 ---------------- */

const auditEl = $('#audit-result');

function renderAuditPlaceholder(message = '填写上方「一帧连续发送的警报条数上限」（2–10）后执行审计。') {
  auditEl.innerHTML = `<p class="placeholder">${esc(message)}</p>`;
}

/** 把比特串按码词边界分段渲染，并高亮反转位（0 基 flipPosition）。 */
function renderSegments(segments, opts = {}) {
  const { flipInSegment = -1 } = opts;
  let global = 0;
  return segments
    .map((seg) => {
      const bits = [...seg.code]
        .map((b) => {
          const pos = global++;
          return pos === flipInSegment
            ? `<span class="bit bit-flip" title="第 ${pos + 1} 位发生 ${b}→${b === '0' ? '1' : '0'} 反转">${b}</span>`
            : `<span class="bit">${b}</span>`;
        })
        .join('');
      return `<span class="seg"><code class="code">${bits}</code><span class="seg-name">${esc(seg.name)}</span></span>`;
    })
    .join('<span class="seg-sep">|</span>');
}

/** 受扰比特串：按受扰后的真实解码边界分段，反转位单独高亮。 */
function renderDisturbed(w) {
  let cursor = 0;
  return w.decodedSegments
    .map((seg) => {
      const start = cursor;
      const end = start + seg.code.length;
      const bits = [...seg.code]
        .map((b, k) => {
          const pos = start + k;
          return pos === w.flipPosition
            ? `<span class="bit bit-flip" title="第 ${pos + 1} 位：${w.flippedFrom}→${w.flippedTo}">${b}</span>`
            : `<span class="bit">${b}</span>`;
        })
        .join('');
      cursor = end;
      return `<span class="seg decoded-seg"><code class="code code-decoded">${bits}</code><span class="seg-name">${esc(seg.name)}</span></span>`;
    })
    .join('<span class="seg-sep">|</span>');
}

function renderAudit(auditResultOrMessage, maybeMessage) {
  // 两参：renderAudit(null, message) 仅重绘占位
  if (!auditResultOrMessage) {
    auditEl.innerHTML = `<p class="placeholder stale">${esc(maybeMessage ?? '审计结论已失效，请重新执行审计。')}</p>`;
    paintResult();
    return;
  }
  const a = auditResultOrMessage;
  if (a.status === 'invalid') {
    auditEl.innerHTML =
      `<div class="banner fail">审计参数未通过校验：<ul>${a.errors
        .map((e) => `<li>${esc(e)}</li>`)
        .join('')}</ul></div>`;
    return;
  }
  if (a.status === 'safe') {
    paintResult();
    auditEl.innerHTML = `
      <div class="banner ok audit-banner">
        ✓ <b>安全结论：</b>在当前有效码表下，已完整枚举
        <b>${a.legalFrames.toLocaleString('en-US')}</b> 个合法帧
        （一帧 1–${a.frameLimit} 条警报，按警报输入顺序）及其
        <b>${a.flipCombinations.toLocaleString('en-US')}</b> 个（帧 × 反转位）组合，
        任意帧发生恰好一次 0/1 反转后，<b>都不会</b>被完整误解为另一帧警报。
      </div>
      <p class="hint">判定为联合枚举：对每个原帧的连续编码逐位反转，并对受扰比特串执行完整贪心解码；
      单条码字比较或抽样均不能替代该结论。</p>`;
    return;
  }

  // risk
  const w = a.witness;
  paintResult(); // 码树与明细标示两条涉事路径
  auditEl.innerHTML = `
    <div class="banner fail audit-banner">
      ✗ <b>发现串扰风险：</b>在
      <b>${a.legalFrames.toLocaleString('en-US')}</b> 个合法帧、
      <b>${a.flipCombinations.toLocaleString('en-US')}</b> 个（帧 × 反转位）组合中，
      有 <b>${a.dangerousCombinations.toLocaleString('en-US')}</b> 个组合会在一次反转后被完整误解为另一帧警报。
    </div>
    <h4>字典序最小的风险原帧（按警报输入顺序）与最早反转位</h4>
    <div class="trace">
      <div class="trace-row">
        <span class="trace-tag tag-orig">原帧</span>
        <span class="trace-bits">${renderSegments(w.originalSegments, { flipInSegment: w.flipPosition })}</span>
      </div>
      <div class="trace-row trace-plain">
        <span class="trace-tag">连续编码</span>
        <code class="code stream">${renderBitStream(w.originalBits, w.flipPosition, false)}</code>
        <span class="hint">第 <b>${w.flipPosition + 1}</b> 位 <code>${w.flippedFrom}</code>→<code>${w.flippedTo}</code>（位序自 1 起）</span>
      </div>
      <div class="trace-row trace-plain">
        <span class="trace-tag">受扰串</span>
        <code class="code stream stream-flip">${renderBitStream(w.originalBits, w.flipPosition, true)}</code>
      </div>
      <div class="trace-row">
        <span class="trace-tag tag-decoded">实际解出</span>
        <span class="trace-bits">${renderDisturbed(w)}</span>
      </div>
    </div>
    <p class="hint">
      原帧序列：${w.frameNames.map((n) => `「${esc(n)}」`).join(' → ')}；
      受扰后被误报为：${w.decodedNames.map((n) => `「${esc(n)}」`).join(' → ')}
      （${w.frameIndices.length} 条变成 ${w.decodedIndices.length} 条，码词边界已重新对齐）。
      码树与上方码字明细中，<span class="tag tag-orig">原帧</span>与
      <span class="tag tag-decoded">误报帧</span>两条路径已分别标示。
    </p>`;
}

/** 连续比特串（不按码词分段），可选把反转位渲染成反转后的值并高亮。 */
function renderBitStream(bits, flipPos, applyFlip) {
  return [...bits]
    .map((b, pos) => {
      if (pos !== flipPos) return esc(b);
      const shown = applyFlip ? (b === '0' ? '1' : '0') : b;
      return `<span class="bit bit-flip">${shown}</span>`;
    })
    .join('');
}

/* ---------------- 收集与求解 ---------------- */

function parseIntStrict(s) {
  const t = String(s).trim();
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

function collectInput() {
  return {
    alerts: state.alerts.map((a) => ({
      name: a.name.trim(),
      freq: parseIntStrict(a.freq),
      lo: parseIntStrict(a.lo),
      hi: parseIntStrict(a.hi),
    })),
    // 空白的保留前缀行视为未填写
    reserved: state.reserved.map((r) => r.trim()).filter((r) => r !== ''),
  };
}

function onSolve() {
  const result = solve(collectInput());
  if (result.status === 'invalid') {
    showErrors(result.errors);
    invalidateResults('参数未通过校验，旧结论已清除。');
    return;
  }
  clearErrors();
  renderResult(result);
}

function onAudit() {
  if (!currentResult || currentResult.status !== 'optimal') {
    invalidateAudit('当前没有仍有效的码表，请先生成码表。');
    return;
  }
  const raw = String($('#frame-limit').value ?? '').trim();
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const a = audit(
    currentResult.alerts.map((x) => ({ name: x.name, code: x.code })),
    limit,
  );
  if (a.status === 'invalid') {
    // 参数非法：不保留任何审计结论，也不改动码树/明细标示
    currentAudit = null;
    paintResult();
    renderAudit(a);
    return;
  }
  currentAudit = a;
  renderAudit(a);
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#solve').addEventListener('click', onSolve);
  $('#run-audit').addEventListener('click', onAudit);

  // 帧上限一变，旧审计结论立即失效（码表本身不受影响）；尚无结论时不动占位提示
  $('#frame-limit').addEventListener('input', () => {
    if (currentResult?.status === 'optimal' && currentAudit) {
      invalidateAudit('帧上限已变更，旧审计结论已失效，请重新执行审计。');
    }
  });

  $('#add-alert').addEventListener('click', () => {
    if (state.alerts.length >= MAX_ALERTS) return;
    state.alerts.push(EMPTY_ALERT());
    renderAlertRows();
    invalidateResults();
  });
  $('#add-reserved').addEventListener('click', () => {
    if (state.reserved.length >= MAX_RESERVED) return;
    state.reserved.push('');
    renderReservedRows();
    invalidateResults();
  });
  $('#load-sample').addEventListener('click', () => {
    state.alerts = structuredClone(SAMPLE.alerts);
    state.reserved = [...SAMPLE.reserved];
    renderForm();
    clearErrors();
    invalidateResults('已载入示例参数，请点击「生成码表」。');
  });
  $('#reset').addEventListener('click', () => {
    state.alerts = Array.from({ length: MIN_ALERTS }, EMPTY_ALERT);
    state.reserved = [];
    renderForm();
    clearErrors();
    invalidateResults('已清空，请录入参数后生成码表。');
  });

  // 任何输入变动都会使旧结论失效
  $('#input-panel').addEventListener('input', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.dataset.idx !== undefined && t.dataset.field) {
      state.alerts[Number(t.dataset.idx)][t.dataset.field] = t.value;
    } else if (t.dataset.reservedIdx !== undefined) {
      state.reserved[Number(t.dataset.reservedIdx)] = t.value;
    }
    invalidateResults();
  });

  $('#input-panel').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.removeAlert !== undefined) {
      state.alerts.splice(Number(t.dataset.removeAlert), 1);
      renderAlertRows();
      invalidateResults();
    } else if (t.dataset.removeReserved !== undefined) {
      state.reserved.splice(Number(t.dataset.removeReserved), 1);
      renderReservedRows();
      invalidateResults();
    }
  });
}

renderForm();
bindEvents();
invalidateResults('配置左侧参数后，点击「生成码表」。');
