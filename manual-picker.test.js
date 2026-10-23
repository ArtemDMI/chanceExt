import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseManualPlanNodes, normalizeManualLayout } from './manual-picker.js';

test('manual layout supplies safe defaults for missing or invalid settings', () => {
    const defaults = { columns: 6, fontSize: 13, width: 1200, height: 800, order: [] };
    assert.deepEqual(normalizeManualLayout(), defaults);
    assert.deepEqual(normalizeManualLayout(null), defaults);
    assert.deepEqual(normalizeManualLayout({ columns: 'invalid', fontSize: '' }), defaults);
});

test('manual layout preserves preferences and clamps sizes to supported bounds', () => {
    assert.deepEqual(normalizeManualLayout({ columns: 4, fontSize: 15, width: 950, height: 650, order: ['b', 'a'] }), {
        columns: 4, fontSize: 15, width: 950, height: 650, order: ['b', 'a'],
    });
    assert.deepEqual(normalizeManualLayout({ columns: 100, fontSize: 0, width: 10, height: 99999 }), {
        columns: 15, fontSize: 10, width: 320, height: 2400, order: [],
    });
});

test('manual layout ignores invalid order entries without mutating stored settings', () => {
    const order = ['node:a:0', null, 'separator:1', 'node:a:0', 5];
    const normalized = normalizeManualLayout({ order });
    assert.deepEqual(normalized.order, ['node:a:0', 'separator:1']);
    assert.equal(order.length, 5);
    assert.notEqual(normalized.order, order);
    assert.equal(normalizeManualLayout({ order: Array.from({ length: 6000 }, (_, i) => String(i)) }).order.length, 5000);
});

test('an already cancelled picker never opens a window', async () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(await chooseManualPlanNodes([], 3, { signal: controller.signal }), null);
});

test('an empty or entirely blocked catalog cannot silently start manual generation', () => {
    assert.throws(() => chooseManualPlanNodes([], 3), /нет доступных нод/);
    assert.throws(() => chooseManualPlanNodes([[{ name: 'Alpha', weight: 1 }]], 1, { blockedText: 'alpha' }), /нет доступных нод/);
});
