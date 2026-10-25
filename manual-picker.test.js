import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseManualPlanNodes, normalizeManualLayout, resolvePreviousPlanNodes } from './manual-picker.js';

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

test('repeat resolves the saved order against the current catalog without truncating or mutating it', () => {
    const catalog = [[{ name: 'Alpha', weight: 1 }], [{ name: 'Beta', weight: 3 }]];
    const saved = ['beta', ' ALPHA ', 'beta'];
    assert.deepEqual(resolvePreviousPlanNodes(catalog, 3, saved), ['Beta', 'Alpha', 'Beta']);
    assert.deepEqual(saved, ['beta', ' ALPHA ', 'beta']);
    assert.equal(resolvePreviousPlanNodes(catalog, 2, saved), null);
    assert.equal(resolvePreviousPlanNodes(catalog, 3, saved, 'alpha'), null);
    assert.deepEqual(resolvePreviousPlanNodes(catalog, 1, ['Missing']), ['Missing']);
    assert.equal(resolvePreviousPlanNodes(catalog, 1, [null]), null);
    assert.equal(resolvePreviousPlanNodes(catalog, 1, null), null);
});

test('send button submits only filled slots and stays disabled for an empty selection', async t => {
    class Element {
        constructor() {
            this.value = '';
            this.style = { setProperty() {} };
            this.classList = { toggle() {} };
            this.listeners = new Map();
            this.children = [];
        }
        setAttribute() {}
        append(...elements) { this.children.push(...elements); }
        appendChild(element) { this.append(element); }
        replaceChildren(...elements) { this.children = elements; }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        querySelector(selector) {
            if (!this.selectors) this.selectors = new Map();
            if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
            return this.selectors.get(selector);
        }
        querySelectorAll() { return []; }
        focus() {}
        showModal() {}
        close() {}
        remove() {}
        fire(type) { this.listeners.get(type)?.({}); }
    }
    let dialog;
    const originalCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    t.after(() => {
        if (originalCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancel);
        else delete globalThis.cancelAnimationFrame;
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
        else delete globalThis.document;
        if (originalObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalObserver);
        else delete globalThis.ResizeObserver;
    });
    globalThis.cancelAnimationFrame = () => {};
    globalThis.document = {
        body: new Element(),
        createElement: tag => {
            const element = new Element();
            if (tag === 'dialog') dialog = element;
            return element;
        },
        createDocumentFragment: () => new Element(),
    };
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    const pending = chooseManualPlanNodes([], 10);
    const button = dialog.querySelector('.chance-ext-picker-send');
    const slots = dialog.querySelector('.chance-ext-picker-slots').children;
    assert.equal(button.disabled, true);
    button.fire('click');
    slots[0].children[1].value = '  First event  ';
    slots[4].children[1].value = 'Second event';
    slots[8].children[1].value = '   ';
    slots[0].children[1].fire('input');
    assert.equal(button.disabled, false);
    button.fire('click');
    assert.deepEqual(await pending, ['First event', 'Second event']);
});

test('freeform nodes can contain any number of words and do not require a catalog', () => {
    const custom = 'A completely custom event with many words '.repeat(100).trim();
    assert.deepEqual(resolvePreviousPlanNodes([], 2, [`  ${custom}  `, 'Another event']), [custom, 'Another event']);
    assert.deepEqual(resolvePreviousPlanNodes([[{ name: 'Alpha', weight: 1 }]], 2, ['alpha', custom]), ['Alpha', custom]);
    assert.equal(resolvePreviousPlanNodes([], 1, ['   ']), null);
    assert.equal(resolvePreviousPlanNodes([], 1, ['Forbidden'], 'forbidden'), null);
});
