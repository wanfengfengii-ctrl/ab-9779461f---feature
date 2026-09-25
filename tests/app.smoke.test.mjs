/**
 * UI 无头冒烟：用最小 DOM 桩加载 app.js，验证加载、求解渲染、
 * 结论失效、校验提示与增删行等交互逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeInputElement {
  constructor(dataset = {}, value = '') {
    this.dataset = dataset;
    this.value = value;
  }
}
globalThis.HTMLInputElement = FakeInputElement;

class StubElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  closest() {
    return null;
  }
}

const registry = new Map();
globalThis.document = {
  querySelector(sel) {
    if (!registry.has(sel)) registry.set(sel, new StubElement(sel));
    return registry.get(sel);
  },
};
const $ = (sel) => document.querySelector(sel);
const type = (idx, field, value) =>
  $('#input-panel').fire('input', { target: new FakeInputElement({ idx: String(idx), field }, value) });

await import('../src/app.js');

test('初始载入示例参数，结果区为占位提示', () => {
  assert.ok($('#alert-rows').innerHTML.includes('特大地震预警'));
  assert.ok($('#results').innerHTML.includes('生成码表'));
});

test('生成码表：展示码树、明细、加权贡献、保留分支与总成本', () => {
  $('#solve').fire('click');
  const html = $('#results').innerHTML;
  assert.ok(html.includes('已找到最优码表'));
  assert.ok(html.includes('二叉码树') && html.includes('<svg'));
  assert.ok(html.includes('码字明细') && html.includes('加权贡献'));
  assert.ok(html.includes('保留分支') && html.includes('1110'));
  assert.ok(html.includes('总成本'));
});

test('输入变动后旧结论失效，重新生成可恢复', () => {
  type(0, 'freq', '4');
  assert.ok($('#results').innerHTML.includes('失效'));
  type(0, 'freq', '3');
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('已找到最优码表'));
});

test('无解时明确说明没有可用的完整分配', () => {
  for (let i = 0; i < 5; i++) {
    type(i, 'lo', '1');
    type(i, 'hi', '1');
  }
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('没有可用的完整分配'));
});

test('非法参数给出校验错误且不保留旧结论', () => {
  type(0, 'freq', '0');
  type(0, 'hi', '3');
  $('#solve').fire('click');
  assert.equal($('#errors').hidden, false);
  assert.ok($('#errors').innerHTML.includes('频次'));
  assert.ok($('#results').innerHTML.includes('清除'));
});

test('警报类别与保留前缀的增删及数量上限', () => {
  $('#load-sample').fire('click');
  $('#add-alert').fire('click');
  assert.ok($('#alert-rows').innerHTML.includes('data-idx="6"'));
  $('#add-alert').fire('click');
  $('#add-alert').fire('click');
  assert.equal($('#add-alert').disabled, true); // 8 类封顶
  $('#add-reserved').fire('click');
  assert.ok($('#reserved-rows').innerHTML.includes('data-reserved-idx="1"'));
  $('#add-reserved').fire('click');
  $('#add-reserved').fire('click');
  assert.equal($('#add-reserved').disabled, true); // 3 条封顶
});

/* ---------------- 单比特串扰审计 ---------------- */

const setFrameCap = (value) => {
  const input = new FakeInputElement({}, value);
  input.id = 'frame-cap';
  $('#result-panel').fire('input', { target: input });
};
const clickAudit = () =>
  $('#result-panel').fire('click', { target: { closest: () => ({ id: 'run-audit' }) } });

test('生成码表后出现审计区，未审计时无结论', () => {
  $('#load-sample').fire('click');
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('单比特串扰审计'));
  assert.ok($('#audit-result').innerHTML.includes('尚未审计'));
});

test('审计发现风险：展示最小序列、最早反转位、受扰串与误报序列，并高亮两条路径', () => {
  // 示例码表 K=4：帧 [特大地震预警×3, 强余震警报] = 1111 1111 1111 000，
  // 第 15 位 0→1 后解码为 [特大地震预警×3, 海啸警报]（'000' 误报为 '001'）
  clickAudit();
  const html = $('#audit-result').innerHTML;
  assert.ok(html.includes('发现单比特串扰风险'));
  assert.ok(html.includes('特大地震预警') && html.includes('强余震警报'));
  assert.ok(html.includes('第 <b>15</b> 位'));
  assert.ok(html.includes('1111 1111 1111 00<b class="flip-bit">1</b>'));
  assert.ok(html.includes('海啸警报'));
  // 码树与明细中出现两条路径的高亮
  const tree = $('#tree-container').innerHTML;
  assert.ok(tree.includes('hl-orig') && tree.includes('hl-dec'));
  assert.ok($('#detail-container').innerHTML.includes('hl-'));
});

test('帧上限变更立即清除旧审计结论，重新审计后恢复', () => {
  setFrameCap('3');
  assert.ok($('#audit-result').innerHTML.includes('已清除'));
  assert.ok(!$('#tree-container').innerHTML.includes('hl-orig')); // 高亮一并移除
  clickAudit();
  assert.ok($('#audit-result').innerHTML.includes('发现单比特串扰风险'));
});

test('非法帧上限给出校验提示且不产生结论', () => {
  setFrameCap('1');
  clickAudit();
  assert.ok($('#audit-result').innerHTML.includes('帧条数上限须为'));
  setFrameCap('11');
  clickAudit();
  assert.ok($('#audit-result').innerHTML.includes('帧条数上限须为'));
});

test('安全码表给出帧上限内的明确安全结论', () => {
  // 该参数组合的最优码表 00/010/0110/100/11 在任意帧上限内均无单比特串扰风险
  $('#reset').fire('click');
  const params = [
    ['甲', '10', '2', '4'],
    ['乙', '14', '3', '5'],
    ['丙', '3', '4', '6'],
    ['丁', '14', '3', '3'],
    ['戊', '5', '2', '2'],
  ];
  params.forEach(([name, freq, lo, hi], i) => {
    type(i, 'name', name);
    type(i, 'freq', freq);
    type(i, 'lo', lo);
    type(i, 'hi', hi);
  });
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('已找到最优码表'));
  setFrameCap('10');
  clickAudit();
  const html = $('#audit-result').innerHTML;
  assert.ok(html.includes('无单比特串扰风险'), html);
  assert.ok(html.includes('1–10 条'));
  assert.ok(!$('#tree-container').innerHTML.includes('hl-orig')); // 安全时无高亮
});

test('码表输入变更后审计结论随旧码表一并失效', () => {
  $('#load-sample').fire('click');
  $('#solve').fire('click');
  setFrameCap('4');
  clickAudit();
  assert.ok($('#audit-result').innerHTML.includes('发现单比特串扰风险'));
  type(0, 'freq', '4'); // 任意输入变动
  assert.ok($('#results').innerHTML.includes('失效'));
  $('#solve').fire('click'); // 重新生成后审计区复位
  assert.ok($('#audit-result').innerHTML.includes('尚未审计'));
});
