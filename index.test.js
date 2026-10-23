import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

import * as chance from './chance.js';

const indexUrl = new URL('./index.js', import.meta.url);
// Run the production interceptor without SillyTavern's imports or browser startup, and without experimental VM flags.
const source = readFileSync(indexUrl, 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(indexUrl.href));
const catalogText = 'Alpha = 1\nBeta = 3\n---\nGamma = 2\nDelta = 4';
const probabilityUrl = '/api/backends/chat-completions/generate';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function probabilityResponse() {
    return {
        ok: true,
        json: async () => ({
            choices: [{ message: { content: JSON.stringify({ status: 'ok', actions_for_roll: [] }) } }],
        }),
    };
}

function createHarness(t, options = {}) {
    const eventSource = new EventEmitter();
    const eventTypes = Object.fromEntries([
        'CHAT_COMPLETION_PROMPT_READY', 'GENERATE_AFTER_DATA', 'GENERATION_STOPPED', 'CHAT_CHANGED',
    ].map(name => [name, name]));
    const context = {
        chat: [{ is_user: true, mes: 'Open the door' }],
        extensionSettings: {},
        saveSettingsDebounced() {},
        eventSource,
        eventTypes,
    };
    const requests = [];
    const picks = [];
    const randomPicks = [];
    const aborts = [];
    const sandbox = vm.createContext({
        ...chance,
        AbortController,
        URL,
        setTimeout,
        clearTimeout,
        console: { info() {}, log() {}, warn() {}, error() {} },
        toastr: { success() {}, warning() {}, error() {} },
        SillyTavern: { getContext: () => context },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        normalizeManualLayout: layout => layout ?? null,
        jQuery: callback => { assert.equal(typeof callback, 'function'); },
        chooseManualPlanNodes(catalog, count, pickerOptions) {
            const selection = deferred();
            const pick = { catalog, count, ...pickerOptions, selection, aborted: false };
            picks.push(pick);
            pickerOptions.signal.addEventListener('abort', () => {
                pick.aborted = true;
                // A late selection deliberately survives cancellation to exercise the interceptor's stale-result guard.
                selection.resolve(options.lateNodes ?? null);
            }, { once: true });
            return selection.promise;
        },
        pickRandomPlanNodes(catalog, count, pickerOptions) {
            // Copy VM options into this realm so strict assertions compare values, not foreign prototypes.
            randomPicks.push({ catalog, count, options: { ...pickerOptions } });
            return chance.pickRandomPlanNodes(catalog, count, {
                ...pickerOptions,
                random: () => options.random ?? 0,
            });
        },
        async fetch(url, init = {}) {
            requests.push({ url: String(url), init });
            if (url instanceof URL && url.pathname.endsWith('/nodes.txt')) {
                if (options.fileResponse) {
                    return options.fileResponse(url, init);
                }
                return { ok: true, text: async () => catalogText };
            }
            assert.equal(String(url), probabilityUrl, 'file mode must not call the plan API or health endpoint');
            return options.probabilityResponse ? options.probabilityResponse(init) : probabilityResponse();
        },
    });
    vm.runInContext(source, sandbox, { filename: indexUrl.pathname });
    const api = vm.runInContext('({ interceptGeneration, settings, installPlanFinalizer, normalizeSettings })', sandbox);
    Object.assign(api.settings, {
        planInjecting: true,
        planSource: 'file',
        planManualSelection: true,
        planNodeCount: 2,
        planInjectPrompt: 'Plan:\n{{plan}}',
        ...options.settings,
    });
    api.installPlanFinalizer();
    t.after(() => {
        eventSource.emit(eventTypes.GENERATION_STOPPED);
        for (const pick of picks) {
            pick.selection.resolve(null);
        }
    });
    return {
        ...api,
        context,
        requests,
        picks,
        randomPicks,
        aborts,
        run(type = 'normal', chat = context.chat.map(message => ({ ...message }))) {
            return api.interceptGeneration(chat, 4096, value => aborts.push(value), type);
        },
        finalize(chat = [{ role: 'system', content: 'Last host prompt' }], dryRun = false) {
            eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, { chat, dryRun });
            return chat;
        },
        emit(name) { eventSource.emit(eventTypes[name]); },
    };
}

for (const type of ['normal', 'swipe']) {
    test(`manual file ${type} waits for selection and probability, then injects only on prompt-ready`, { timeout: 3000 }, async t => {
        const file = deferred();
        const probability = deferred();
        t.after(() => {
            file.resolve({ ok: true, text: async () => catalogText });
            probability.resolve(probabilityResponse());
        });
        const h = createHarness(t, {
            fileResponse: () => file.promise,
            probabilityResponse: () => probability.promise,
            settings: { planBlockedNode: 'Blocked', planManualLayout: { columns: 3 } },
        });
        if (type === 'swipe') {
            h.context.chat.push({ is_user: false, mes: 'Previous answer' });
        }
        const originalChat = structuredClone(h.context.chat);
        let finished = false;
        const run = h.run(type).then(() => { finished = true; });
        await setImmediate();
        assert.equal(finished, false);
        assert.equal(h.picks.length, 0);
        assert.equal(h.requests.length, 1);
        assert.equal(h.finalize().length, 1);

        file.resolve({ ok: true, text: async () => catalogText });
        await setImmediate();
        assert.equal(h.picks.length, 1);
        const pick = h.picks[0];
        assert.deepEqual(pick.catalog, chance.parseNodeCatalog(catalogText));
        assert.equal(pick.count, 2);
        assert.equal(pick.blockedText, 'Blocked');
        assert.deepEqual(pick.layout, { columns: 3 });
        assert.equal(pick.signal.aborted, false);
        assert.equal(h.requests.length, 1, 'probability must wait for the picker');
        assert.equal(finished, false);
        assert.equal(h.finalize().length, 1);

        pick.selection.resolve(['Delta', 'Alpha']);
        await setImmediate();
        assert.equal(h.requests.length, 2);
        assert.equal(h.requests[1].url, probabilityUrl);
        assert.equal(finished, false, 'the interceptor must still await probability completion');
        assert.equal(h.finalize().length, 1);
        assert.deepEqual(h.context.chat, originalChat);

        probability.resolve(probabilityResponse());
        await run;
        assert.deepEqual(h.aborts, []);
        assert.equal(h.finalize(undefined, true).length, 1, 'dry runs must not consume the plan');
        const finalChat = h.finalize();
        assert.deepEqual(finalChat, [
            { role: 'system', content: 'Last host prompt' },
            { role: 'user', content: 'Plan:\n1. [Delta]\n2. [Alpha]' },
        ]);
        assert.equal(h.finalize().length, 1, 'the pending plan is consumed exactly once');
        assert.equal(h.randomPicks.length, 0);
    });
}

test('cancelled manual selection aborts generation without starting probability', { timeout: 3000 }, async t => {
    const h = createHarness(t);
    const run = h.run();
    await setImmediate();
    h.picks[0].selection.resolve(null);
    await run;
    assert.deepEqual(h.aborts, [true]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.finalize().length, 1);
});

test('completed manual selection is saved and supplied unchanged to the next picker', async t => {
    const h = createHarness(t);
    const run = h.run();
    await setImmediate();
    const nodes = ['Delta', 'Alpha'];
    h.picks[0].selection.resolve(nodes);
    await run;
    assert.deepEqual([...h.settings.planManualLastNodes], nodes);
    assert.deepEqual([...h.context.extensionSettings.ChanceExt.planManualLastNodes], nodes);
    assert.notEqual(h.settings.planManualLastNodes, nodes);
    h.finalize();

    h.settings.planNodeCount = 3;
    const nextRun = h.run('swipe');
    await setImmediate();
    assert.equal(h.picks[1].count, 3);
    assert.deepEqual([...h.picks[1].previousNodes], nodes, 'do not truncate the saved selection to match a new count');
    h.picks[1].selection.resolve(null);
    await nextRun;
    assert.deepEqual([...h.settings.planManualLastNodes], nodes, 'cancellation must preserve the completed selection');
});

test('automatic file generation does not overwrite the last manual selection', async t => {
    const nodes = ['Delta', 'Alpha'];
    const h = createHarness(t, { settings: { planManualSelection: false, planManualLastNodes: nodes } });
    await h.run();
    assert.deepEqual(h.settings.planManualLastNodes, nodes);
});

test('last manual selection survives settings normalization and rejects malformed saved data', t => {
    const h = createHarness(t);
    const saved = ['Delta', 'Alpha'];
    const normalized = h.normalizeSettings({ planManualLastNodes: saved });
    assert.deepEqual([...normalized.planManualLastNodes], saved);
    assert.notEqual(normalized.planManualLastNodes, saved);
    for (const value of [null, 'Alpha', [3], [''], ['Alpha', ' '], Array(11).fill('Alpha')]) {
        assert.deepEqual([...h.normalizeSettings({ planManualLastNodes: value }).planManualLastNodes], []);
    }
});

test('automatic file mode uses the random picker without opening manual selection or calling the plan API', { timeout: 3000 }, async t => {
    const plans = [];
    for (const random of [0, 0.999]) {
        const h = createHarness(t, {
            random,
            settings: { planManualSelection: false, planWeighted: true, planWeightFlatten: 0.25 },
        });
        await h.run();
        assert.equal(h.picks.length, 0);
        assert.equal(h.randomPicks.length, 1);
        assert.deepEqual(h.randomPicks[0], {
            catalog: chance.parseNodeCatalog(catalogText),
            count: 2,
            options: { weighted: true, flatten: 0.25, blockedText: '' },
        });
        assert.equal(h.requests.length, 2);
        assert.equal(h.requests[1].url, probabilityUrl);
        const fileUrl = new URL(h.requests[0].url);
        assert.equal(fileUrl.protocol, 'file:');
        assert.equal(fileUrl.pathname.endsWith('/nodes.txt'), true);
        assert.equal(fileUrl.searchParams.has('t'), true);
        assert.equal(h.requests[0].init.cache, 'no-store');
        assert.deepEqual(h.aborts, []);
        plans.push(h.finalize().at(-1).content);
    }
    assert.equal(plans[0], 'Plan:\n1. [Gamma]\n2. [Alpha]');
    assert.equal(plans[1], 'Plan:\n1. [Beta]\n2. [Delta]');
});

test('superseding a pending manual request aborts its signal and only injects the newer selection', { timeout: 3000 }, async t => {
    const h = createHarness(t, { lateNodes: ['Stale node'] });
    const oldRun = h.run();
    await setImmediate();
    const oldPick = h.picks[0];
    const newRun = h.run('swipe');
    await setImmediate();
    assert.equal(oldPick.signal.aborted, true);
    assert.equal(oldPick.aborted, true);
    assert.equal(h.picks.length, 2);
    assert.equal(h.requests.length, 2, 'neither pending picker may start probability');
    await oldRun;
    assert.equal(h.finalize().length, 1);
    assert.equal(h.picks[1].signal.aborted, false);
    h.picks[1].selection.resolve(['Fresh node']);
    await newRun;
    assert.deepEqual(h.aborts, [true]);
    assert.equal(h.requests.length, 3);
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Fresh node]');
});

for (const event of ['GENERATION_STOPPED', 'CHAT_CHANGED']) {
    test(`${event} closes pending manual selection through its signal and discards late nodes`, { timeout: 3000 }, async t => {
        const h = createHarness(t, { lateNodes: ['Stale node'] });
        const run = h.run();
        await setImmediate();
        const pick = h.picks[0];
        h.emit(event);
        assert.equal(pick.signal.aborted, true);
        assert.equal(pick.aborted, true);
        await run;
        assert.equal(h.requests.length, 1);
        assert.deepEqual(h.aborts, [true]);
        assert.equal(h.finalize().length, 1);
    });

    test(`${event} clears a selected plan queued for prompt-ready`, { timeout: 3000 }, async t => {
        const h = createHarness(t);
        const run = h.run();
        await setImmediate();
        h.picks[0].selection.resolve(['Stale node']);
        await run;
        h.emit(event);
        assert.equal(h.finalize().length, 1);
    });
}

for (const failure of ['network', 'http', 'body']) {
    test(`manual catalog ${failure} failure aborts generation without probability or injection`, { timeout: 3000 }, async t => {
        const h = createHarness(t, {
            fileResponse: async () => {
                if (failure === 'network') {
                    throw new TypeError('Failed to fetch');
                }
                return {
                    ok: failure !== 'http',
                    status: 503,
                    text: async () => { throw new Error('Catalog body unavailable'); },
                };
            },
        });
        await h.run();
        assert.deepEqual(h.aborts, [true]);
        assert.equal(h.picks.length, 0);
        assert.equal(h.requests.length, 1);
        assert.equal(h.finalize().length, 1);
    });
}
