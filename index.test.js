import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

import * as chance from './chance.js';
import { resolvePreviousPlanNodes } from './manual-picker.js';
import { normalizeNodePanelPosition, normalizeNodePanelSize } from './node-panel.js';

const indexUrl = new URL('./index.js', import.meta.url);
// Run the production interceptor without SillyTavern's imports or browser startup, and without experimental VM flags.
const source = readFileSync(indexUrl, 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(indexUrl.href));
const catalogText = 'Alpha = 1\nBeta = 3\n---\nGamma = 2\nDelta = 4';
const probabilityUrl = '/api/backends/chat-completions/generate';

test('reorganized settings preserve every control and its existing ID', () => {
    const html = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
    const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(controls.sort(), [
        'chance_ext_enabled', 'chance_ext_bonus', 'chance_ext_model', 'chance_ext_plan_injecting',
        'chance_ext_plan_source', 'chance_ext_plan_node_count', 'chance_ext_plan_blocked_node',
        'chance_ext_plan_manual', 'chance_ext_plan_node_panel', 'chance_ext_plan_action_panel', 'chance_ext_plan_weighted',
        'chance_ext_plan_flatten', 'chance_ext_plan_temperature', 'chance_ext_plan_inject_prompt',
    ].sort());
    assert.equal(html.includes('Gen nodes подбирает комбинацию'), false);
});

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
        'GENERATION_STARTED', 'GENERATION_ENDED',
    ].map(name => [name, name]));
    const context = {
        chat: [{ name: 'User', is_user: true, mes: 'Open the door' }],
        extensionSettings: {},
        saveSettingsDebounced() {},
        eventSource,
        eventTypes,
    };
    const requests = [];
    const picks = [];
    const randomPicks = [];
    const aborts = [];
    const panels = [];
    const actionPanels = [];
    const hostCalls = [];
    const pending = [];
    let harness;
    const hostAction = async (action, ...args) => {
        hostCalls.push({ action, args });
        // The host can await command/swipe processing without ever invoking the interceptor.
        await Promise.resolve();
        return await (options.hostAction ? options.hostAction(action, harness) : harness.run(action === 'send' ? 'normal' : 'swipe'));
    };
    context.swipe = { to: (...args) => hostAction('swipe', ...args) };
    const sandbox = vm.createContext({
        ...chance,
        AbortController,
        URL,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        isGenerating: () => typeof options.isGenerating === 'function' ? options.isGenerating() : Boolean(options.isGenerating),
        sendTextareaMessage: () => hostAction('send'),
        resolvePreviousPlanNodes,
        console: { info() {}, log() {}, warn() {}, error() {} },
        toastr: { success() {}, warning() {}, error() {} },
        SillyTavern: { getContext: () => context },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        normalizeManualLayout: layout => layout ?? null,
        normalizeNodePanelPosition,
        normalizeNodePanelSize,
        createNodePanel(panelOptions) {
            const panel = {
                options: panelOptions,
                states: [],
                destroyed: false,
                update(state) { this.states.push(state); },
                destroy() { this.destroyed = true; },
            };
            panels.push(panel);
            return panel;
        },
        createActionPanel(panelOptions) {
            const panel = {
                options: panelOptions,
                states: [],
                destroyed: false,
                update(state) { this.states.push(state); },
                destroy() { this.destroyed = true; },
            };
            actionPanels.push(panel);
            return panel;
        },
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
            if (options.apiResponse && String(url).startsWith('http://127.0.0.1:8010/')) {
                return options.apiResponse(String(url), init);
            }
            assert.equal(String(url), probabilityUrl, 'file mode must not call the plan API or health endpoint');
            return options.probabilityResponse ? options.probabilityResponse(init) : probabilityResponse();
        },
    });
    vm.runInContext(source, sandbox, { filename: indexUrl.pathname });
    const api = vm.runInContext('({ interceptGeneration, settings, installPlanFinalizer, normalizeSettings, syncNodePanel, regeneratePanelNodes, syncActionPanel, runPanelAction })', sandbox);
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
        api.settings.planNodePanel = false;
        api.settings.planActionPanel = false;
        api.syncNodePanel();
        api.syncActionPanel();
        for (const complete of pending) complete();
    });
    harness = {
        ...api,
        context,
        requests,
        picks,
        randomPicks,
        aborts,
        panels,
        actionPanels,
        hostCalls,
        defer(value) {
            const task = deferred();
            pending.push(() => task.resolve(value));
            return task;
        },
        run(type = 'normal', chat = context.chat.map(message => ({ ...message }))) {
            return api.interceptGeneration(chat, 4096, value => aborts.push(value), type);
        },
        finalize(chat = [{ role: 'system', content: 'Last host prompt' }], dryRun = false) {
            eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, { chat, dryRun });
            return chat;
        },
        emit(name) { eventSource.emit(eventTypes[name]); },
    };
    return harness;
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

for (const type of ['normal', 'swipe']) {
    test(`skipping manual ${type} continues without any plan injection or overwriting the previous selection`, async t => {
        const previousNodes = ['Delta', 'Alpha'];
        const h = createHarness(t, { settings: { planManualLastNodes: previousNodes } });
        const chat = structuredClone(h.context.chat);
        const run = h.run(type, chat);
        await setImmediate();
        h.picks[0].selection.resolve({ skipped: true });
        await run;
        assert.deepEqual(h.aborts, []);
        assert.equal(h.requests.length, 2, 'the normal probability check still runs');
        assert.equal(h.randomPicks.length, 0);
        assert.deepEqual(chat, h.context.chat);
        assert.deepEqual(h.settings.planManualLastNodes, previousNodes);
        const prompt = [{ role: 'user', content: 'Original prompt' }];
        assert.deepEqual(h.finalize(prompt), [{ role: 'user', content: 'Original prompt' }]);
    });
}

test('skipping with probability disabled still permits the original prompt without a plan', async t => {
    const h = createHarness(t, { settings: { enabled: false } });
    const run = h.run();
    await setImmediate();
    h.picks[0].selection.resolve({ skipped: true });
    await run;
    assert.deepEqual(h.aborts, []);
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

test('panel combination is reused for messages and swipes instead of the API or manual picker', async t => {
    const h = createHarness(t, { settings: {
        planNodePanel: true, planPanelNodes: ['Delta', 'Alpha'], planSource: 'api',
    } });
    for (const type of ['normal', 'swipe', 'normal']) {
        await h.run(type);
        assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
    }
    assert.equal(h.picks.length, 0);
    assert.equal(h.randomPicks.length, 0);
    assert.equal(h.requests.length, 3);
    assert.ok(h.requests.every(request => request.url === probabilityUrl));
    assert.deepEqual([...h.settings.planPanelNodes], ['Delta', 'Alpha']);
    assert.deepEqual(h.aborts, []);
});

test('showing the panel, changing chats and stopping generation never draws nodes or closes the panel', t => {
    const h = createHarness(t, { settings: { planNodePanel: true, planPanelNodes: ['Delta', 'Alpha'] } });
    h.syncNodePanel();
    h.emit('CHAT_CHANGED');
    h.emit('GENERATION_STOPPED');
    h.syncNodePanel();
    assert.equal(h.requests.length, 0);
    assert.equal(h.randomPicks.length, 0);
    assert.equal(h.panels.length, 1);
    assert.equal(h.panels[0].destroyed, false);
    assert.deepEqual([...h.panels[0].states.at(-1).nodes], ['Delta', 'Alpha']);
});

test('disabling the panel restores the original API flow without losing the pinned nodes', async t => {
    const h = createHarness(t, {
        settings: { planNodePanel: true, planPanelNodes: ['Delta', 'Alpha'], planSource: 'api' },
        apiResponse: async url => url.endsWith('/health')
            ? { ok: true }
            : { ok: true, json: async () => ({ nodes: Array.from({ length: 10 }, (_, index) => `API ${index + 1}`) }) },
    });
    h.syncNodePanel();
    h.settings.planNodePanel = false;
    h.syncNodePanel();
    await h.run();
    assert.equal(h.panels[0].destroyed, true);
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [API 1]\n2. [API 2]');
    assert.equal(h.requests.filter(request => request.url.endsWith('/health')).length, 1);
    assert.equal(h.requests.filter(request => request.url.endsWith('/plans')).length, 1);
    assert.equal(h.requests.filter(request => request.url === probabilityUrl).length, 1);
    assert.equal(h.picks.length, 0);
    assert.deepEqual([...h.settings.planPanelNodes], ['Delta', 'Alpha']);
});

test('disabling the panel restores the manual picker and preserves the pinned nodes', async t => {
    const h = createHarness(t, { settings: { planNodePanel: true, planPanelNodes: ['Delta', 'Alpha'] } });
    h.settings.planNodePanel = false;
    h.syncNodePanel();
    const run = h.run();
    await setImmediate();
    assert.equal(h.picks.length, 1);
    h.picks[0].selection.resolve(['Gamma', 'Beta']);
    await run;
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Gamma]\n2. [Beta]');
    assert.deepEqual([...h.settings.planPanelNodes], ['Delta', 'Alpha']);
});

test('Gen nodes uses the existing random rules without generating a message or changing manual history', async t => {
    const h = createHarness(t, { settings: {
        planNodePanel: true, planInjecting: false, planSource: 'api',
        planWeighted: false, planWeightFlatten: 0.7, planBlockedNode: 'Gamma',
        planManualLastNodes: ['Delta'],
    } });
    h.syncNodePanel();
    await h.panels[0].options.onGenerate();
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].url.includes('/nodes.txt?'));
    assert.equal(h.requests[0].init.cache, 'no-store');
    assert.deepEqual(h.randomPicks[0].options, { weighted: false, flatten: 0.7, blockedText: 'Gamma' });
    assert.deepEqual([...h.settings.planPanelNodes], ['Delta', 'Alpha']);
    assert.deepEqual([...h.context.extensionSettings.ChanceExt.planPanelNodes], ['Delta', 'Alpha']);
    assert.deepEqual(h.settings.planManualLastNodes, ['Delta']);
    assert.equal(h.finalize().length, 1);
    assert.equal(h.picks.length, 0);
    assert.equal(h.panels[0].states.at(-1).busy, false);
});

test('weighted panel rolls honor flattening, count and blocked nodes on every explicit reroll', async t => {
    const h = createHarness(t, { settings: {
        planNodePanel: true, planWeighted: true, planWeightFlatten: 0.4, planBlockedNode: 'Beta',
    } });
    await h.regeneratePanelNodes();
    await h.regeneratePanelNodes();
    assert.equal(h.randomPicks.length, 2);
    assert.ok(h.randomPicks.every(pick => pick.count === 2));
    assert.deepEqual(h.randomPicks[1].options, { weighted: true, flatten: 0.4, blockedText: 'Beta' });
    assert.equal(h.settings.planPanelNodes.includes('Beta'), false);
    assert.equal(h.requests.length, 2);
});

test('a running generation keeps its panel snapshot when Gen nodes or settings change', async t => {
    const probability = deferred();
    t.after(() => probability.resolve(probabilityResponse()));
    const h = createHarness(t, {
        probabilityResponse: () => probability.promise,
        settings: { planNodePanel: true, planPanelNodes: ['Delta', 'Alpha'] },
    });
    const run = h.run();
    await setImmediate();
    h.settings.planPanelNodes = ['Gamma', 'Beta'];
    h.settings.planNodeCount = 1;
    h.settings.planBlockedNode = 'Alpha';
    h.settings.planInjectPrompt = 'Changed {{plan}}';
    probability.resolve(probabilityResponse());
    await run;
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
    await h.run('swipe');
    assert.equal(h.finalize().at(-1).content, 'Changed 1. [Gamma]');
});

for (const nodes of [[], ['Alpha'], ['Alpha', 'Gamma']]) {
    test(`panel generation refuses an incomplete or newly blocked selection: ${JSON.stringify(nodes)}`, async t => {
        const h = createHarness(t, { settings: {
            planNodePanel: true, planPanelNodes: nodes, planBlockedNode: 'Gamma',
        } });
        await h.run();
        assert.deepEqual(h.aborts, [true]);
        assert.equal(h.requests.length, 0);
        assert.equal(h.picks.length, 0);
        assert.equal(h.finalize().length, 1);
    });
}

test('only the latest panel roll can replace the pinned combination', async t => {
    const firstFile = deferred();
    let calls = 0;
    const h = createHarness(t, {
        settings: { planNodePanel: true, planPanelNodes: ['Old', 'Selection'] },
        fileResponse: () => ++calls === 1 ? firstFile.promise : { ok: true, text: async () => catalogText },
    });
    const oldRoll = h.regeneratePanelNodes();
    await h.regeneratePanelNodes();
    assert.equal(h.requests[0].init.signal.aborted, true);
    const latest = [...h.settings.planPanelNodes];
    firstFile.resolve({ ok: true, text: async () => 'Obsolete = 1\n---\nAnswer = 1' });
    await oldRoll;
    assert.deepEqual([...h.settings.planPanelNodes], latest);
    assert.equal(h.randomPicks.length, 1);
});

for (const change of ['disable', 'count', 'weighted', 'flatten', 'blocked']) {
    test(`panel roll cannot pin stale results after ${change} changes`, async t => {
        const file = deferred();
        const h = createHarness(t, {
            settings: { planNodePanel: true, planPanelNodes: ['Old', 'Selection'] },
            fileResponse: () => file.promise,
        });
        const run = h.regeneratePanelNodes();
        if (change === 'disable') { h.settings.planNodePanel = false; h.syncNodePanel(); }
        if (change === 'count') h.settings.planNodeCount = 1;
        if (change === 'weighted') h.settings.planWeighted = false;
        if (change === 'flatten') h.settings.planWeightFlatten = 0.5;
        if (change === 'blocked') h.settings.planBlockedNode = 'Alpha';
        file.resolve({ ok: true, text: async () => catalogText });
        await run;
        assert.deepEqual([...h.settings.planPanelNodes], ['Old', 'Selection']);
        assert.equal(h.randomPicks.length, 0);
        if (change === 'disable') {
            assert.equal(h.requests[0].init.signal.aborted, true);
            assert.equal(h.panels[0].destroyed, true);
        }
    });
}

test('failed or short panel rolls retain the previous combination', async t => {
    for (const response of [
        () => { throw new TypeError('Offline'); },
        () => ({ ok: false, status: 500 }),
        () => ({ ok: true, text: async () => 'Only one section = 1' }),
    ]) {
        const h = createHarness(t, {
            settings: { planNodePanel: true, planPanelNodes: ['Delta', 'Alpha'] },
            fileResponse: response,
        });
        await h.regeneratePanelNodes();
        assert.deepEqual([...h.settings.planPanelNodes], ['Delta', 'Alpha']);
        assert.ok(h.panels[0].states.at(-1).error);
        assert.equal(h.panels[0].states.at(-1).busy, false);
        await h.run();
        assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
    }
});

test('panel preferences survive normalization and position changes are saved', t => {
    const h = createHarness(t, { settings: { planNodePanel: true, planPanelPosition: { x: 40, y: 100 } } });
    h.syncNodePanel();
    h.panels[0].options.onPositionChange({ x: 180, y: 220 });
    assert.deepEqual(h.context.extensionSettings.ChanceExt.planPanelPosition, { x: 180, y: 220 });
    const normalized = h.normalizeSettings({
        planNodePanel: true, planPanelNodes: ['Delta', 'Alpha'], planPanelPosition: { x: 180, y: 220 },
    });
    assert.equal(normalized.planNodePanel, true);
    assert.deepEqual([...normalized.planPanelNodes], ['Delta', 'Alpha']);
    assert.deepEqual(normalized.planPanelPosition, { x: 180, y: 220 });
    for (const nodes of [null, 'Alpha', [' '], [1], Array(11).fill('Alpha')]) {
        assert.deepEqual([...h.normalizeSettings({ planPanelNodes: nodes }).planPanelNodes], []);
    }
    assert.deepEqual(normalizeNodePanelPosition({ x: -10, y: Infinity }), { x: 0, y: null });
});

test('panel sizes are normalized without losing existing position preferences', t => {
    const h = createHarness(t);
    const old = h.normalizeSettings({ planPanelPosition: { x: 40, y: 100 } });
    assert.deepEqual(old.planPanelPosition, { x: 40, y: 100 });
    assert.deepEqual(old.planPanelSize, { width: 250, height: null });
    assert.deepEqual(normalizeNodePanelSize({ width: 560, height: 350 }), { width: 560, height: 350 });
    assert.deepEqual(normalizeNodePanelSize({ width: -1, height: 0 }), { width: 180, height: 120 });
    assert.deepEqual(normalizeNodePanelSize({ width: 99999, height: 99999 }), { width: 4000, height: 2400 });
    assert.deepEqual(normalizeNodePanelSize({ width: NaN, height: Infinity }), { width: 250, height: null });
    assert.deepEqual(normalizeNodePanelSize({ width: '500', height: '400' }), { width: 250, height: null });
});

test('panel size changes are saved and supplied when the panel is reopened', t => {
    const h = createHarness(t, { settings: {
        planNodePanel: true, planPanelSize: { width: 400, height: 200 }, planPanelPosition: { x: 50, y: 80 },
    } });
    h.syncNodePanel();
    assert.deepEqual(h.panels[0].options.size, { width: 400, height: 200 });
    h.panels[0].options.onSizeChange({ width: 600, height: 300 });
    h.panels[0].options.onPositionChange({ x: 100, y: 120 });
    assert.deepEqual(h.context.extensionSettings.ChanceExt.planPanelSize, { width: 600, height: 300 });
    h.settings.planNodePanel = false;
    h.syncNodePanel();
    h.settings.planNodePanel = true;
    h.syncNodePanel();
    assert.deepEqual(h.panels[1].options.size, { width: 600, height: 300 });
    assert.deepEqual(h.panels[1].options.position, { x: 100, y: 120 });
});

for (const action of ['send', 'swipe']) {
    for (const mode of ['skip', 'repeat']) {
        test(`action panel ${action}/${mode} bypasses manual selection exactly once`, { timeout: 3000 }, async t => {
            const nodes = ['Delta', 'Alpha'];
            const h = createHarness(t, { settings: { planManualLastNodes: nodes } });
            h.syncActionPanel();
            await h.actionPanels[0].options.onAction(action, mode);
            assert.deepEqual(h.hostCalls, [{ action, args: action === 'swipe' ? [null, 'right'] : [] }]);
            assert.equal(h.picks.length, 0);
            assert.equal(h.randomPicks.length, 0);
            assert.equal(h.requests.filter(request => request.url.includes('/nodes.txt?')).length, mode === 'skip' ? 0 : 1);
            assert.equal(h.requests.filter(request => request.url === probabilityUrl).length, 1);
            const prompt = h.finalize();
            assert.equal(prompt.length, mode === 'skip' ? 1 : 2);
            if (mode === 'repeat') assert.equal(prompt.at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
            assert.deepEqual(h.settings.planManualLastNodes, nodes);
            assert.equal(h.actionPanels[0].states.at(-1).busy, false);

            const normal = h.run();
            await setImmediate();
            assert.equal(h.picks.length, 1, 'an ordinary run must reopen the manual picker');
            h.picks[0].selection.resolve(['Gamma', 'Beta']);
            await normal;
            assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Gamma]\n2. [Beta]');
            assert.deepEqual(h.aborts, []);
        });
    }
}

test('action repeat prefers manual history over pinned panel nodes, including API source', async t => {
    const h = createHarness(t, { settings: {
        planSource: 'api', planNodePanel: true, planPanelNodes: ['Gamma', 'Beta'],
        planManualLastNodes: ['Delta', 'Alpha'],
    } });
    await h.runPanelAction('send', 'repeat');
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
    assert.deepEqual(h.settings.planPanelNodes, ['Gamma', 'Beta']);
    assert.deepEqual(h.settings.planManualLastNodes, ['Delta', 'Alpha']);
    assert.equal(h.picks.length, 0);
    assert.equal(h.randomPicks.length, 0);
    await h.run();
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Gamma]\n2. [Beta]');
});

test('Send continue and nested quiet helpers keep the one-time panel choice tied to the main request', async t => {
    for (const type of ['normal', 'continue']) {
        const h = createHarness(t, {
            settings: { planManualLastNodes: ['Delta', 'Alpha'] },
            hostAction: async (_action, harness) => {
                await harness.run('quiet');
                await harness.run(type);
            },
        });
        await h.runPanelAction('send', 'repeat');
        assert.equal(h.picks.length, 0);
        assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
        assert.deepEqual(h.aborts, []);
    }
});

test('action repeat rereads the current catalog and resolves canonical names without rewriting history', async t => {
    let catalog = 'ALPHA = 9\n---\nDELTA = 2';
    const saved = ['delta', 'alpha'];
    const h = createHarness(t, {
        settings: { planManualLastNodes: saved },
        fileResponse: async () => ({ ok: true, text: async () => catalog }),
    });
    await h.runPanelAction('send', 'repeat');
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [DELTA]\n2. [ALPHA]');
    catalog = 'Alpha = 1\n---\nDelta = 1';
    await h.runPanelAction('swipe', 'repeat');
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
    const files = h.requests.filter(request => request.url.includes('/nodes.txt?'));
    assert.equal(files.length, 2);
    assert.ok(files.every(request => request.init.cache === 'no-store' && new URL(request.url).searchParams.has('t')));
    assert.deepEqual(h.settings.planManualLastNodes, saved);
});

test('no-op Send, existing swipe and rejected hosts cannot leak a panel choice into later generation', async t => {
    for (const action of ['send', 'swipe']) {
        for (const reject of [false, true]) {
            const h = createHarness(t, {
                settings: { planManualLastNodes: ['Delta', 'Alpha'] },
                hostAction: async () => { if (reject) throw new Error('Host rejected'); },
            });
            await h.runPanelAction(action, 'repeat');
            assert.equal(h.hostCalls.length, 1);
            assert.equal(h.finalize().length, 1);
            const run = h.run(action === 'send' ? 'normal' : 'swipe');
            await setImmediate();
            assert.equal(h.picks.length, 1);
            h.picks[0].selection.resolve({ skipped: true });
            await run;
            assert.equal(h.finalize().length, 1);
            assert.equal(h.actionPanels[0].states.at(-1).busy, false);
        }
    }
});

test('repeat refuses wrong counts, blocked and deleted catalog nodes without mutating saved selections', async t => {
    for (const settings of [
        { planNodeCount: 1 },
        { planBlockedNode: 'Alpha' },
        { planManualLastNodes: ['Delta', 'Deleted'] },
    ]) {
        const h = createHarness(t, { settings: {
            planManualLastNodes: ['Delta', 'Alpha'], planPanelNodes: ['Gamma', 'Beta'], ...settings,
        } });
        const previous = [...h.settings.planManualLastNodes];
        h.syncActionPanel();
        await h.runPanelAction('send', 'repeat');
        assert.equal(h.hostCalls.length, 0);
        assert.equal(h.picks.length, 0);
        assert.equal(h.finalize().length, 1);
        assert.deepEqual([...h.settings.planManualLastNodes], previous);
        assert.deepEqual(h.settings.planPanelNodes, ['Gamma', 'Beta']);
        assert.equal(h.requests.length, settings.planManualLastNodes ? 1 : 0);
    }
});

test('repeat preflight blocks double clicks and awaits the entire host promise', async t => {
    let file;
    let host;
    const h = createHarness(t, {
        settings: { planManualLastNodes: ['Delta', 'Alpha'] },
        fileResponse: () => file.promise,
        hostAction: async (_action, harness) => { await harness.run(); await host.promise; },
    });
    file = h.defer({ ok: true, text: async () => catalogText });
    host = h.defer();
    const run = h.runPanelAction('send', 'repeat');
    await h.runPanelAction('swipe', 'skip');
    assert.equal(h.requests.length, 1);
    assert.equal(h.hostCalls.length, 0);
    assert.equal(h.actionPanels[0].states.at(-1).busy, true);
    file.resolve({ ok: true, text: async () => catalogText });
    await setImmediate();
    assert.equal(h.hostCalls.length, 1);
    assert.equal(h.actionPanels[0].states.at(-1).busy, true);
    await h.runPanelAction('send', 'repeat');
    assert.equal(h.hostCalls.length, 1);
    host.resolve();
    await run;
    assert.equal(h.actionPanels[0].states.at(-1).busy, false);
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
});

for (const event of ['GENERATION_STOPPED', 'CHAT_CHANGED']) {
    test(`${event} cancels repeat preflight before a late catalog can invoke the host`, async t => {
        let file;
        const h = createHarness(t, {
            settings: { planManualLastNodes: ['Delta', 'Alpha'] }, fileResponse: () => file.promise,
        });
        file = h.defer({ ok: true, text: async () => catalogText });
        const run = h.runPanelAction('swipe', 'repeat');
        h.emit(event);
        assert.equal(h.requests[0].init.signal.aborted, true);
        file.resolve({ ok: true, text: async () => catalogText });
        await run;
        assert.equal(h.hostCalls.length, 0);
        assert.equal(h.picks.length, 0);
        assert.equal(h.finalize().length, 1);
        assert.deepEqual(h.settings.planManualLastNodes, ['Delta', 'Alpha']);
        assert.equal(h.actionPanels[0].states.at(-1).busy, false);
    });
}

test('host generation state blocks actions and lifecycle events refresh panel busy state', async t => {
    let busy = true;
    const h = createHarness(t, {
        isGenerating: () => busy, settings: { planManualLastNodes: ['Delta', 'Alpha'] },
    });
    h.syncActionPanel();
    assert.equal(h.actionPanels[0].states.at(-1).busy, true);
    for (const action of ['send', 'swipe']) {
        for (const mode of ['skip', 'repeat']) await h.runPanelAction(action, mode);
    }
    assert.equal(h.hostCalls.length, 0);
    assert.equal(h.requests.length, 0);
    busy = false;
    h.emit('GENERATION_ENDED');
    await setImmediate();
    assert.equal(h.actionPanels[0].states.at(-1).busy, false);
    busy = true;
    h.emit('GENERATION_STARTED');
    await setImmediate();
    assert.equal(h.actionPanels[0].states.at(-1).busy, true);
});

test('repeat preflight rejects stale count, blocked nodes, visibility, chat and host busy state', { timeout: 3000 }, async t => {
    for (const change of ['count', 'blocked', 'disabled', 'source', 'plan', 'chat', 'busy']) {
        let file;
        let busy = false;
        const h = createHarness(t, {
            settings: { planManualLastNodes: ['Delta', 'Alpha'] },
            isGenerating: () => busy,
            fileResponse: () => file.promise,
            hostAction: async () => {},
        });
        file = h.defer({ ok: true, text: async () => catalogText });
        const run = h.runPanelAction('send', 'repeat');
        if (change === 'count') h.settings.planNodeCount = 1;
        if (change === 'blocked') h.settings.planBlockedNode = 'Alpha';
        if (change === 'disabled') h.settings.planActionPanel = false;
        if (change === 'source') h.settings.planSource = 'api';
        if (change === 'plan') h.settings.planInjecting = false;
        if (change === 'chat') h.context.chatId = 'another-chat';
        if (change === 'busy') busy = true;
        file.resolve({ ok: true, text: async () => catalogText });
        await run;
        assert.equal(h.hostCalls.length, 0, change);
        assert.equal(h.finalize().length, 1, change);
        assert.deepEqual(h.settings.planManualLastNodes, ['Delta', 'Alpha']);
    }
});

test('repeat snapshots nodes and injection settings before host awaits probability', async t => {
    let probability;
    const h = createHarness(t, {
        settings: { planManualLastNodes: ['Delta', 'Alpha'] },
        probabilityResponse: () => probability.promise,
    });
    probability = h.defer(probabilityResponse());
    const run = h.runPanelAction('send', 'repeat');
    await setImmediate();
    assert.equal(h.hostCalls.length, 1);
    h.settings.planManualLastNodes.splice(0, 2, 'Gamma', 'Beta');
    h.settings.planPanelNodes = ['Gamma', 'Beta'];
    h.settings.planNodeCount = 1;
    h.settings.planBlockedNode = 'Alpha';
    h.settings.planInjectPrompt = 'Changed {{plan}}';
    probability.resolve(probabilityResponse());
    await run;
    assert.equal(h.finalize().at(-1).content, 'Plan:\n1. [Delta]\n2. [Alpha]');
    assert.deepEqual(h.settings.planManualLastNodes, ['Gamma', 'Beta']);
});

test('action panel position and size persist, normalize and restore independently of the node panel', t => {
    const h = createHarness(t, { settings: {
        planActionPosition: { x: 50, y: 80 }, planActionSize: { width: 400, height: 200 },
        planPanelPosition: { x: 10, y: 20 }, planPanelSize: { width: 300, height: 180 },
    } });
    h.syncActionPanel();
    const panel = h.actionPanels[0];
    assert.deepEqual(panel.options.position, { x: 50, y: 80 });
    assert.deepEqual(panel.options.size, { width: 400, height: 200 });
    panel.options.onPositionChange({ x: 100, y: 120 });
    panel.options.onSizeChange({ width: 600, height: 300 });
    const saved = h.context.extensionSettings.ChanceExt;
    assert.deepEqual(saved.planActionPosition, { x: 100, y: 120 });
    assert.deepEqual(saved.planActionSize, { width: 600, height: 300 });
    assert.deepEqual(saved.planPanelPosition, { x: 10, y: 20 });
    assert.deepEqual(saved.planPanelSize, { width: 300, height: 180 });
    const normalized = h.normalizeSettings(saved);
    assert.deepEqual(normalized.planActionPosition, saved.planActionPosition);
    assert.deepEqual(normalized.planActionSize, saved.planActionSize);
    assert.equal(h.normalizeSettings({}).planActionPanel, true);
    assert.equal(h.normalizeSettings({ planActionPanel: false }).planActionPanel, false);
    h.settings.planActionPanel = false;
    h.syncActionPanel();
    assert.equal(panel.destroyed, true);
    h.settings.planActionPanel = true;
    h.syncActionPanel();
    assert.deepEqual(h.actionPanels[1].options.position, saved.planActionPosition);
    assert.deepEqual(h.actionPanels[1].options.size, saved.planActionSize);
});

test('action panel visibility follows its own enable flag, file source or node panel, and plan injection', async t => {
    const h = createHarness(t);
    h.syncActionPanel();
    h.syncActionPanel();
    assert.equal(h.actionPanels.length, 1);
    for (const settings of [
        { planActionPanel: false },
        { planActionPanel: true, planInjecting: false },
        { planInjecting: true, planSource: 'api' },
    ]) {
        Object.assign(h.settings, settings);
        h.syncActionPanel();
        await h.runPanelAction('send', 'skip');
        assert.equal(h.actionPanels[0].destroyed, true);
        assert.equal(h.hostCalls.length, 0);
    }
    h.settings.planNodePanel = true;
    h.syncActionPanel();
    assert.equal(h.actionPanels.length, 2);
    assert.equal(h.actionPanels[1].destroyed, false);
    assert.equal(h.actionPanels[1].states.at(-1).canRepeat, false);
    h.settings.planManualLastNodes = ['Delta', 'Alpha'];
    h.syncActionPanel();
    assert.equal(h.actionPanels[1].states.at(-1).canRepeat, true);
    assert.equal(h.requests.length, 0);
});
