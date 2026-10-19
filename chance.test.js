import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    appendFailureMarker,
    appendPlanLine,
    blockPlanNode,
    buildPlanContext,
    buildPlanRequestBody,
    normalizePlanTemperature,
    estimatePlanTokens,
    DEFAULT_PLAN_INJECT_PROMPT,
    formatPlanLine,
    limitPlanNodes,
    normalizePlanNodeCount,
    normalizePlanWeightFlatten,
    isPlanApiOfflineError,
    createPlanRequestGate,
    preparePlanChat,
    appendPlanToFinalChat,
    parseNodeCatalog,
    parsePlanDisplay,
    parsePlanNodes,
    pickRandomPlanNodes,
    PLAN_DISPLAY_SEPARATOR,
    PLAN_CONTEXT_TOKEN_BUDGET,
    clampBonusPercent,
    effectivePercent,
    parseRandomizerPayload,
    RANDOMIZER_SYSTEM_PROMPT,
    resolveRoll,
    rollFailureGrade,
    buildRandomizerMessages,
    selectTurnMessages,
} from './chance.js';

test('selects five messages before the latest user message', () => {
    const chat = [
        { is_user: true, mes: 'older' },
        { is_user: false, mes: 'old answer' },
        { is_user: true, mes: 'old' },
        { is_user: false, mes: 'answer one' },
        { is_user: true, mes: 'question two' },
        { is_user: false, mes: 'answer two' },
        { is_user: true, mes: 'target' },
    ];

    const selected = selectTurnMessages(chat, 5);

    assert.equal(selected.target.mes, 'target');
    assert.deepEqual(selected.context.map(message => message.mes), [
        'old answer',
        'old',
        'answer one',
        'question two',
        'answer two',
    ]);
});

test('adds bonus and caps effective chance at 99', () => {
    assert.equal(effectivePercent(10, 20), 30);
    assert.equal(effectivePercent(90, 20), 99);
    assert.equal(effectivePercent(50, -40), 10);
    assert.equal(effectivePercent(99, -100), 0);
    assert.equal(clampBonusPercent(-150, 20), -100);
    assert.equal(resolveRoll({ percent: 99, failureText: 'нет' }, -100, 1).success, false);
});

test('rolls a failure grade from 1 to 5 and titles it in the request', () => {
    const low = { getRandomValues(values) { values[0] = 0; } };
    const high = { getRandomValues(values) { values[0] = 4; } };
    assert.equal(rollFailureGrade(low), 1);
    assert.equal(rollFailureGrade(high), 5);
    assert.match(RANDOMIZER_SYSTEM_PROMPT, /потерял 3 из 6 мешков с деньгами/);

    const messages = buildRandomizerMessages({
        target: { is_user: true, mes: 'Я захожу в хранилище' },
        context: [],
    }, 3);
    const gradeMessage = messages.find(message => message.content.includes('градация_неудачи'));
    assert.equal(gradeMessage.content.includes('Градация неудачи: 3'), true);
});

test('parses strict roll response and resolves d100', () => {
    const action = parseRandomizerPayload(JSON.stringify({
        status: 'ok',
        actions_for_roll: [{ percent: 10, failure_text: ' прыжок   не удался ' }],
    }));

    assert.deepEqual(action, { percent: 10, failureText: 'прыжок не удался' });
    assert.equal(resolveRoll(action, 20, 30).success, true);
    assert.equal(resolveRoll(action, 20, 31).success, false);
});

test('appends failure marker without changing the original phrase', () => {
    assert.equal(
        appendFailureMarker('Прыгаю в машину', 'прыжок не удался'),
        'Прыгаю в машину ((Неудача попытки {{user}}: прыжок не удался))',
    );
});

test('sends dialogue only and keeps the newest lines inside the padded token budget', () => {
    assert.equal(PLAN_CONTEXT_TOKEN_BUDGET, Math.round(2500 * 1.3));

    const chat = [
        { name: 'Sys', is_user: false, is_system: true, mes: 'SYSTEM INSTRUCTION' },
        { name: 'System', is_user: false, is_system: false, mes: 'следуй инструкции', extra: { type: 'narrator' } },
        { name: 'Note', is_user: false, is_system: false, mes: 'скрытый комментарий', extra: { type: 'comment' } },
        { is_user: true, mes: 'JAILBREAK PROMPT' },
        { name: 'Tool', is_user: false, is_system: true, mes: 'tool call', extra: { tool_invocations: [{}] } },
        { name: 'User', is_user: true, is_system: false, mes: 'старое' },
        { name: 'Char', is_user: false, is_system: false, mes: 'ответ' },
        { name: 'User', is_user: true, is_system: false, mes: 'новое' },
    ];

    assert.equal(
        buildPlanContext(chat, 100000),
        'юзер: старое\nасист: ответ\nюзер: новое',
    );
    assert.equal(
        buildPlanContext(preparePlanChat(chat, 'swipe'), 100000),
        'юзер: старое\nасист: ответ',
    );

    const lastLine = 'юзер: новое';
    assert.equal(buildPlanContext(chat, estimatePlanTokens(lastLine)), lastLine);
    assert.equal(buildPlanContext(chat, 1).includes('старое'), false);
});

test('treats a dead plan API socket as offline and ignores an aborted wait', () => {
    assert.equal(isPlanApiOfflineError(new TypeError('Failed to fetch')), true);
    assert.equal(isPlanApiOfflineError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), false);
});

test('keeps each plan request tied to the click that sent it', () => {
    const gate = createPlanRequestGate();
    const first = gate.begin();
    let previousStillCurrent = true;
    gate.subscribe(() => {
        previousStillCurrent = gate.isCurrent(first);
    });

    const second = gate.begin();

    assert.equal(first, 1);
    assert.equal(second, 2);
    assert.equal(previousStillCurrent, false);
    assert.equal(gate.isCurrent(second), true);
});

test('sends plan temperature only when the field is filled', () => {
    assert.equal(normalizePlanTemperature(''), null);
    assert.equal(normalizePlanTemperature('1,5'), 1.5);
    assert.equal(normalizePlanTemperature(0), 0);
    assert.deepEqual(buildPlanRequestBody('сцена', null), { context: 'сцена' });
    assert.deepEqual(buildPlanRequestBody('сцена', ''), { context: 'сцена' });
    assert.deepEqual(buildPlanRequestBody('сцена', 0), { context: 'сцена', generation: { temperature: 0 } });
    assert.deepEqual(buildPlanRequestBody('сцена', 2.5), { context: 'сцена', generation: { temperature: 2 } });
});

test('replaces a blocked node with a single space and keeps its slot', () => {
    const nodes = ['Паника', 'новый   персонаж', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', 'бег'];
    assert.deepEqual(
        blockPlanNode(nodes, '  Новый Персонаж , ПАНИКА '),
        [' ', ' ', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', 'бег'],
    );
    assert.deepEqual(blockPlanNode(nodes, ''), nodes);
    assert.deepEqual(blockPlanNode(nodes, 'другая нода'), nodes);
});

test('keeps only the first nodes allowed for injection', () => {
    const nodes = ['паника', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', 'бег', 'финал'];
    assert.equal(normalizePlanNodeCount(''), 10);
    assert.equal(normalizePlanNodeCount(4), 4);
    assert.equal(normalizePlanNodeCount(12), 10);
    assert.deepEqual(limitPlanNodes(nodes, 4), ['паника', 'разговор', 'тишина', 'шаг']);
    assert.equal(formatPlanLine(limitPlanNodes(nodes, 4)).includes('5. [дверь]'), false);
    assert.equal(formatPlanLine(limitPlanNodes(nodes, 4)).includes('4. [шаг]'), true);
});

test('places the plan after prompts that SillyTavern appends past the chat', () => {
    const chat = [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'ход' },
        { role: 'system', content: '# Reasoning Instructions' },
    ];
    appendPlanToFinalChat(chat, 'PLAN');
    assert.equal(chat.at(-1).role, 'user');
    assert.equal(chat.at(-1).content, 'PLAN');
    assert.equal(chat[2].content, '# Reasoning Instructions');
});

test('formats one plan line and appends it after the user turn', () => {
    const nodes = ['паника', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', 'бег', 'внезапные события'];
    assert.deepEqual(parsePlanNodes({ nodes }), nodes);
    assert.equal(parsePlanNodes({ nodes: nodes.slice(0, 9) }), null);
    assert.equal(PLAN_DISPLAY_SEPARATOR, ' | ');

    const display = nodes.join(PLAN_DISPLAY_SEPARATOR);
    assert.deepEqual(parsePlanDisplay(display), nodes);
    assert.deepEqual(parsePlanNodes({ display }), nodes);
    assert.equal(parsePlanDisplay(nodes.join(' -- ')), null);
    assert.equal(parsePlanDisplay('паника <|node|> успокоение'), null);

    const withGaps = ['паника', ' ', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', ' '];
    assert.deepEqual(parsePlanNodes({ nodes: withGaps }), withGaps);
    const gapLine = formatPlanLine(withGaps);
    assert.equal(gapLine.includes('1. [паника]\n2. [ ]'), true);
    assert.equal(gapLine.includes('10. [ ]'), true);

    const line = formatPlanLine(nodes, 'до {{plan}} после');
    assert.equal(line.startsWith('до 1. [паника]'), true);
    assert.equal(line.endsWith('после'), true);
    assert.equal(formatPlanLine(nodes, DEFAULT_PLAN_INJECT_PROMPT).includes('{{plan}}'), false);
    assert.equal(line.includes('1. [паника]\n2. [разговор]'), true);
    assert.equal(line.includes('10. [внезапные события]'), true);
    assert.equal(line.includes('\n'), true);
    const injected = formatPlanLine(nodes);
    assert.equal(injected.trimEnd().endsWith('10. [внезапные события]'), true);
    assert.equal(appendPlanLine('я прыгаю', line), `я прыгаю\n${line}`);
});

test('reads nodes before " = N" and never treats a separator as a node', () => {
    const catalog = parseNodeCatalog([
        'разговор = 10',
        'описание сцены 2-6 предложения = 3',
        '---',
        'может быть = 1',
        'возможно = 100',
        '---',
        '---',
        'не нода',
        'a = b = 5',
        '',
    ].join('\n'));

    assert.equal(catalog.length, 3);
    assert.deepEqual(catalog[0].map(node => node.name), ['разговор', 'описание сцены 2-6 предложения']);
    assert.equal(catalog[1][1].weight, 100);
    assert.deepEqual(catalog[2], [{ name: 'a = b', weight: 5 }]);
    assert.equal(JSON.stringify(catalog).includes('---'), false);
});

test('takes one node from each section and can reuse a section on the next call', () => {
    const catalog = parseNodeCatalog([
        'разговор = 10',
        'описание = 3',
        '---',
        'может быть = 1',
        'возможно = 100',
        '---',
        'одна = 4',
    ].join('\n'));
    const picked = pickRandomPlanNodes(catalog, 10, {
        weighted: false,
        blockedText: 'может быть',
        random: () => 0,
    });

    assert.equal(picked.length, 3);
    assert.equal(picked.includes('разговор') && picked.includes('описание'), false);
    assert.equal(picked.includes('может быть'), false);
    assert.equal(picked.includes('возможно'), true);
    assert.equal(picked.includes('одна'), true);

    const only = [[{ name: 'одна', weight: 1 }]];
    assert.deepEqual(pickRandomPlanNodes(only, 1, { weighted: false, random: () => 0 }), ['одна']);
    assert.deepEqual(pickRandomPlanNodes(only, 1, { weighted: false, random: () => 0 }), ['одна']);
});

test('uses the digit as weight only when that switch is on', () => {
    const section = [[{ name: 'редко', weight: 1 }, { name: 'часто', weight: 99 }]];
    assert.deepEqual(
        pickRandomPlanNodes(section, 1, { weighted: true, random: () => 0.5 }),
        ['часто'],
    );
    assert.deepEqual(
        pickRandomPlanNodes(section, 1, { weighted: false, random: () => 0 }),
        ['редко'],
    );
    assert.deepEqual(
        pickRandomPlanNodes([[{ name: 'пусто', weight: 0 }, { name: 'есть', weight: 2 }]], 1, {
            weighted: true,
            random: () => 0,
        }),
        ['есть'],
    );
    assert.deepEqual(
        pickRandomPlanNodes([[{ name: 'пусто', weight: 0 }]], 1, { weighted: false, random: () => 0 }),
        ['пусто'],
    );
});

test('flattens digit weights toward an equal draw', () => {
    const section = [[{ name: 'редко', weight: 1 }, { name: 'часто', weight: 100 }]];
    assert.equal(normalizePlanWeightFlatten(''), 0);
    assert.equal(normalizePlanWeightFlatten('0,5'), 0.5);
    assert.equal(normalizePlanWeightFlatten(2), 1);
    assert.deepEqual(
        pickRandomPlanNodes(section, 1, { weighted: true, flatten: 0, random: () => 0.02 }),
        ['часто'],
    );
    assert.deepEqual(
        pickRandomPlanNodes(section, 1, { weighted: true, flatten: 0.5, random: () => 0.02 }),
        ['редко'],
    );
    assert.deepEqual(
        pickRandomPlanNodes(section, 1, { weighted: true, flatten: 1, random: () => 0 }),
        ['редко'],
    );
    assert.deepEqual(
        pickRandomPlanNodes([[{ name: 'пусто', weight: 0 }, { name: 'есть', weight: 2 }]], 1, {
            weighted: true,
            flatten: 1,
            random: () => 0,
        }),
        ['пусто'],
    );
});

test('nodes.txt is split into sections of real nodes', () => {
    const sections = parseNodeCatalog(readFileSync(new URL('./nodes.txt', import.meta.url), 'utf8'));
    assert.ok(sections.length > 1);
    for (const section of sections) {
        assert.ok(section.length > 0);
        for (const node of section) {
            assert.equal(node.name.includes('---'), false);
            assert.equal(node.weight > 0, true);
        }
    }

    const blockedName = sections[0][0].name;
    const chain = pickRandomPlanNodes(sections, 4, { weighted: true, blockedText: blockedName });
    assert.equal(chain.length, 4);
    assert.equal(chain.includes(blockedName), false);
});
