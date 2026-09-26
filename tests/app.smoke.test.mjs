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
const typeReserved = (idx, value) =>
  $('#input-panel').fire('input', { target: new FakeInputElement({ reservedIdx: String(idx) }, value) });

await import('../src/app.js');

test('初始载入示例参数，结果区为占位提示', () => {
  assert.ok($('#alert-rows').innerHTML.includes('特大地震预警'));
  assert.ok($('#results').innerHTML.includes('生成码表'));
  assert.equal($('#audit-panel').hidden, true); // 尚无有效码表，审计区关闭
});

test('生成码表：展示码树、明细、加权贡献、保留分支与总成本', () => {
  $('#solve').fire('click');
  const html = $('#results').innerHTML;
  assert.ok(html.includes('已找到最优码表'));
  assert.ok(html.includes('二叉码树') && html.includes('<svg'));
  assert.ok(html.includes('码字明细') && html.includes('加权贡献'));
  assert.ok(html.includes('保留分支') && html.includes('1110'));
  assert.ok(html.includes('总成本'));
  assert.equal($('#audit-panel').hidden, false); // 码表有效，审计区开放
  assert.ok($('#audit-result').innerHTML.includes('执行审计'));
});

test('单比特串扰审计（示例码表，帧上限 2）：标示风险与两条涉事路径', () => {
  $('#frame-limit').value = '2';
  $('#run-audit').fire('click');
  const auditHtml = $('#audit-result').innerHTML;
  assert.ok(auditHtml.includes('发现串扰风险'));
  assert.ok(auditHtml.includes('特大地震预警')); // 字典序最小原帧
  assert.ok(auditHtml.includes('bit-flip')); // 反转位高亮
  assert.ok(auditHtml.includes('海啸警报')); // 实际误报成的警报
  assert.ok(auditHtml.includes('强余震警报'));
  // 码树与明细标示两条路径
  const resultHtml = $('#results').innerHTML;
  assert.ok(resultHtml.includes('hl-orig') && resultHtml.includes('hl-decoded'));
  assert.ok(resultHtml.includes('tag-orig') && resultHtml.includes('tag-decoded'));
});

test('帧上限变更立即清除旧审计结论并重绘码树/明细', () => {
  $('#frame-limit').value = '3';
  $('#frame-limit').fire('input');
  assert.ok($('#audit-result').innerHTML.includes('失效'));
  const resultHtml = $('#results').innerHTML;
  assert.ok(!resultHtml.includes('hl-orig')); // 过期路径标示一并移除
  assert.ok(!resultHtml.includes('tag-orig'));
  // 码表仍有效
  assert.ok(resultHtml.includes('已找到最优码表'));
  assert.equal($('#audit-panel').hidden, false);
});

test('非法帧上限给出校验提示且不保留审计结论', () => {
  $('#frame-limit').value = '11';
  $('#run-audit').fire('click');
  const auditHtml = $('#audit-result').innerHTML;
  assert.ok(auditHtml.includes('未通过校验'));
  assert.ok(auditHtml.includes('2–10'));
  assert.ok(!$('#results').innerHTML.includes('hl-orig'));
});

test('安全例：无风险时给出帧上限内的明确安全结论', () => {
  $('#reset').fire('click');
  const rows = [
    ['a0', '25', '5', '12'],
    ['a1', '29', '4', '12'],
    ['a2', '16', '6', '12'],
    ['a3', '21', '4', '12'],
    ['a4', '19', '7', '12'],
  ];
  rows.forEach(([name, freq, lo, hi], i) => {
    type(i, 'name', name);
    type(i, 'freq', freq);
    type(i, 'lo', lo);
    type(i, 'hi', hi);
  });
  $('#add-reserved').fire('click');
  typeReserved(0, '11');
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('已找到最优码表'));
  $('#frame-limit').value = '3';
  $('#run-audit').fire('click');
  const auditHtml = $('#audit-result').innerHTML;
  assert.ok(auditHtml.includes('安全结论'));
  assert.ok(auditHtml.includes('都不会'));
  assert.ok(!$('#results').innerHTML.includes('hl-orig'));
});

test('码表输入变更后审计区随旧码表一并关闭，重新生成后恢复可用', () => {
  type(0, 'freq', '26');
  assert.equal($('#audit-panel').hidden, true);
  assert.ok($('#results').innerHTML.includes('失效'));
  type(0, 'freq', '25');
  $('#solve').fire('click');
  assert.equal($('#audit-panel').hidden, false);
  assert.ok($('#audit-result').innerHTML.includes('执行审计'));
  $('#frame-limit').value = '3';
  $('#run-audit').fire('click');
  assert.ok($('#audit-result').innerHTML.includes('安全结论'));
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
