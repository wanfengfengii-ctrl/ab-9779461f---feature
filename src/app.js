import {
  solve,
  MIN_ALERTS,
  MAX_ALERTS,
  MAX_RESERVED,
  MAX_CODE_LENGTH,
} from './solver.js';
import {
  auditFrameRobustness,
  validateFrameCap,
  MIN_FRAME_CAP,
  MAX_FRAME_CAP,
} from './audit.js';
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
  // 当前仍有效的码表求解结果（非 optimal 或输入已变更时为 null）
  lastResult: null,
  // 单比特串扰审计：帧上限输入值、审计结论、结论被帧上限变更清除的标记
  frameCapInput: '4',
  audit: null,
  auditCleared: false,
};

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
  // 码表 / 保留前缀一旦变动，求解结论与审计结论同时作废
  state.lastResult = null;
  state.audit = null;
  state.auditCleared = false;
  resultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
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

function renderDetailTable(result, hl) {
  const rows = result.alerts
    .map((a, i) => {
      const cls = !hl
        ? ''
        : hl.origAlerts.has(i) && hl.decAlerts.has(i)
          ? ' class="hl-both"'
          : hl.origAlerts.has(i)
            ? ' class="hl-orig"'
            : hl.decAlerts.has(i)
              ? ' class="hl-dec"'
              : '';
      return `
      <tr${cls}>
        <td class="idx">${i + 1}</td>
        <td>${esc(a.name)}</td>
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

function renderTree(result, hl) {
  const { nodes, edges, width, height } = buildTreeLayout(
    result.alerts.map((a) => ({ code: a.code, name: a.name })),
    result.reserved ?? [],
  );

  // 审计高亮：前缀落在原帧 / 误报帧路径上的节点与边分别标色
  const hlClass = (prefix) => {
    if (!hl || prefix === '') return '';
    const inOrig = hl.origPaths.has(prefix);
    const inDec = hl.decPaths.has(prefix);
    if (inOrig && inDec) return ' hl-both';
    if (inOrig) return ' hl-orig';
    if (inDec) return ' hl-dec';
    return '';
  };

  const edgeSvg = edges
    .map((e) => {
      const mx = (e.from.cx + e.to.cx) / 2;
      const my = (e.from.cy + e.to.cy) / 2;
      return `
        <line x1="${e.from.cx}" y1="${e.from.cy}" x2="${e.to.cx}" y2="${e.to.cy}" class="edge${hlClass(e.to.prefix)}"/>
        <text x="${mx}" y="${my - 3}" class="edge-bit">${e.bit}</text>`;
    })
    .join('');

  const nodeSvg = nodes
    .map((n) => {
      const hl = hlClass(n.prefix);
      if (n.type === 'dot') {
        return `<circle cx="${n.cx}" cy="${n.cy}" r="2.6" class="dot"><title>未使用的子树</title></circle>`;
      }
      if (n.type === 'code') {
        return `
          <g class="node code-node${hl}">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>${esc(n.label)}：${esc(n.prefix)}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">${esc(truncate(n.label))}</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      if (n.type === 'reserved') {
        return `
          <g class="node reserved-node${hl}">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>保留前缀：${esc(n.prefix)}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">保留</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      const label = n.type === 'root' ? '根' : '';
      return `
        <g class="node internal-node${hl}">
          <circle cx="${n.cx}" cy="${n.cy}" r="8"><title>前缀 ${n.prefix === '' ? 'ε（空）' : esc(n.prefix)}</title></circle>
          ${label ? `<text x="${n.cx}" y="${n.cy - 14}" class="node-label">${label}</text>` : ''}
        </g>`;
    })
    .join('');

  return `
    <h3>二叉码树</h3>
    <p class="hint">绿节点为已分配码字，红节点为保留分支，灰点为未使用的子树；边标注 0/1。${
      hl ? '<span class="legend orig">蓝＝原帧路径</span> <span class="legend dec">橙＝误报帧路径</span> <span class="legend both">紫＝两条路径共用</span>' : ''
    }</p>
    <div class="tree-wrap">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           role="img" aria-label="二叉码树">
        ${edgeSvg}${nodeSvg}
      </svg>
    </div>`;
}

/* ---------------- 单比特串扰审计 ---------------- */

/** 当前有效审计结论对应的码树/明细高亮集合；无风险结论时为 null。 */
function currentHighlight() {
  const outcome = state.audit?.outcome;
  if (!outcome || outcome.status !== 'risk' || !state.lastResult) return null;
  const codes = state.lastResult.alerts.map((a) => a.code);
  const pathPrefixes = (seq) => {
    const set = new Set();
    for (const i of seq) {
      const c = codes[i];
      for (let d = 1; d <= c.length; d++) set.add(c.slice(0, d));
    }
    return set;
  };
  const { sequence, decoded } = outcome.witness;
  return {
    origPaths: pathPrefixes(sequence),
    decPaths: pathPrefixes(decoded),
    origAlerts: new Set(sequence),
    decAlerts: new Set(decoded),
  };
}

function renderAuditControls() {
  return `
    <h3>单比特串扰审计</h3>
    <p class="hint">检验任意合法帧（1–K 条警报的连续编码）在任一位置发生恰好一次 0/1 反转后，
      是否仍会被完整解码为另一帧警报而造成误报。审计联合枚举全部帧编码、全部反转位置与
      受扰比特流的精确解码，是完整判定而非抽样。</p>
    <div class="audit-controls">
      <label for="frame-cap">一帧连续发送的警报条数上限 K（${MIN_FRAME_CAP}–${MAX_FRAME_CAP}）</label>
      <input type="number" id="frame-cap" min="${MIN_FRAME_CAP}" max="${MAX_FRAME_CAP}" step="1"
             value="${esc(state.frameCapInput)}">
      <button type="button" id="run-audit" class="btn">开始审计</button>
    </div>
    <div id="audit-result"></div>`;
}

function segmentCodes(seq, codes) {
  return seq.map((i) => `<code class="code">${esc(codes[i])}</code>`).join(' ');
}

function renderAuditOutcome() {
  const audit = state.audit;
  if (!audit) {
    return state.auditCleared
      ? '<p class="placeholder stale">帧上限已变更，旧审计结论已清除，请重新审计。</p>'
      : '<p class="hint">尚未审计。设定帧条数上限后点击「开始审计」。</p>';
  }
  if (audit.error) {
    return `<div class="banner fail">✗ ${esc(audit.error)}</div>`;
  }
  const { outcome } = audit;
  const K = outcome.frameCap;
  const method =
    '<p class="hint">审计已联合枚举该上限内全部合法帧的连续编码、每个反转位置及受扰比特流的精确解码' +
    `（非单码字比较、非抽样），共搜索 ${outcome.exploredStates} 个状态。</p>`;
  if (outcome.status === 'safe') {
    return `
      <div class="banner ok">✓ 帧上限 ${K} 内无单比特串扰风险：任意 1–${K} 条警报组成的帧，
        其连续编码在任一位置发生恰好一次 0/1 反转后，都不会被完整误解为另一帧（≤${K} 条）警报。</div>
      ${method}`;
  }
  if (outcome.status !== 'risk') {
    return `<div class="banner fail">✗ 审计中断。<p>${esc(outcome.reason ?? '')}</p></div>`;
  }
  const w = outcome.witness;
  const alerts = state.lastResult.alerts;
  const codes = alerts.map((a) => a.code);
  const nameSeq = (seq) =>
    seq.map((i) => `<b>#${i + 1}</b> ${esc(alerts[i].name)}`).join(' → ');
  // 受扰比特串按原帧码字边界分段，翻转位标红
  const disturbedSeg = [];
  let pos = 0;
  for (const i of w.sequence) {
    const end = pos + codes[i].length;
    let part = '';
    for (let b = pos; b < end; b++) {
      part += b === w.flipIndex ? `<b class="flip-bit">${w.disturbedBits[b]}</b>` : w.disturbedBits[b];
    }
    disturbedSeg.push(part);
    pos = end;
  }
  return `
    <div class="banner fail">✗ 发现单比特串扰风险：一次比特反转即可使一帧警报被完整误报为另一帧。</div>
    <table class="grid detail audit-witness">
      <tbody>
        <tr><th>原警报序列<span class="hint">（字典序最小）</span></th><td>${nameSeq(w.sequence)}</td></tr>
        <tr><th>原帧连续编码</th><td>${segmentCodes(w.sequence, codes)}</td></tr>
        <tr><th>最早反转位</th><td>第 <b>${w.flipIndex + 1}</b> 位（${w.originalBits[w.flipIndex]} → ${w.disturbedBits[w.flipIndex]}）</td></tr>
        <tr><th>受扰比特串</th><td><code class="code">${disturbedSeg.join(' ')}</code></td></tr>
        <tr><th>实际解码为<span class="hint">（误报）</span></th><td>${nameSeq(w.decoded)}<br>${segmentCodes(w.decoded, codes)}</td></tr>
      </tbody>
    </table>
    <p class="hint">两条涉及路径已在上方二叉码树与码字明细中标示：
      <span class="legend orig">蓝＝原帧路径</span>
      <span class="legend dec">橙＝误报帧路径</span>
      <span class="legend both">紫＝两条路径共用</span>。</p>
    ${method}`;
}

/** 局部刷新码树、明细与审计结论（帧上限变更 / 完成审计后调用）。 */
function refreshResultVisuals() {
  if (!state.lastResult) return;
  const hl = currentHighlight();
  $('#tree-container').innerHTML = renderTree(state.lastResult, hl);
  $('#detail-container').innerHTML =
    renderDetailTable(state.lastResult, hl) + renderReserved(state.lastResult);
  $('#audit-result').innerHTML = renderAuditOutcome();
}

function renderResult(result) {
  if (result.status === 'optimal') {
    state.lastResult = result;
    resultsEl.innerHTML = `
      ${renderBanner(result)}
      ${renderStats(result)}
      <div id="tree-container">${renderTree(result, null)}</div>
      <div id="detail-container">${renderDetailTable(result, null)}${renderReserved(result)}</div>
      ${renderAuditControls()}
      <p class="hint">搜索节点数：${result.exploredNodes}。码字两两前缀无关，任意连续电文均可按前缀码唯一拆分。</p>`;
    refreshResultVisuals();
  } else {
    // infeasible / error：明确说明没有可用的完整分配
    state.lastResult = null;
    const reservedInfo =
      result.reserved && result.reserved.length > 0
        ? `<p class="hint">当前保留前缀：${result.reserved
            .map((r) => `<code class="code reserved">${esc(typeof r === 'string' ? r : r.prefix)}</code>`)
            .join('、')}</p>`
        : '';
    resultsEl.innerHTML = `${renderBanner(result)}${reservedInfo}`;
  }
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
  // 重新求解即生成新码表，旧审计结论一并清除（帧上限输入保留）
  state.audit = null;
  state.auditCleared = false;
  const result = solve(collectInput());
  if (result.status === 'invalid') {
    showErrors(result.errors);
    invalidateResults('参数未通过校验，旧结论已清除。');
    return;
  }
  clearErrors();
  renderResult(result);
}

function onRunAudit() {
  if (!state.lastResult) return;
  const cap = parseIntStrict(state.frameCapInput);
  const capError = validateFrameCap(cap);
  if (capError) {
    state.audit = { error: capError };
  } else {
    const codes = state.lastResult.alerts.map((a) => a.code);
    state.audit = { outcome: auditFrameRobustness(codes, cap) };
  }
  state.auditCleared = false;
  refreshResultVisuals();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#solve').addEventListener('click', onSolve);

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

  // 审计交互：帧上限变更立即清除旧审计结论；点击按钮重新审计
  $('#result-panel').addEventListener('input', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || t.id !== 'frame-cap') return;
    state.frameCapInput = t.value;
    if (state.audit) {
      state.audit = null;
      state.auditCleared = true;
      refreshResultVisuals();
    }
  });
  $('#result-panel').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (t && t.id === 'run-audit') onRunAudit();
  });
}

renderForm();
bindEvents();
invalidateResults('配置左侧参数后，点击「生成码表」。');
