import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendFailureMarker,
    appendPlanLine,
    blockPlanNode,
    buildPlanContext,
    buildPlanRequestBody,
    normalizePlanTemperature,
    estimatePlanTokens,
    formatPlanLine,
    isPlanApiOfflineError,
    createPlanRequestGate,
    preparePlanChat,
    parsePlanNodes,
    PLAN_CONTEXT_TOKEN_BUDGET,
    effectivePercent,
    parseRandomizerPayload,
    resolveRoll,
    selectTurnMessages,
} from './chance.js';

test('selects three messages before the latest user message', () => {
    const chat = [
        { is_user: true, mes: 'old' },
        { is_user: false, mes: 'answer one' },
        { is_user: true, mes: 'question two' },
        { is_user: false, mes: 'answer two' },
        { is_user: true, mes: 'target' },
    ];

    const selected = selectTurnMessages(chat, 3);

    assert.equal(selected.target.mes, 'target');
    assert.deepEqual(selected.context.map(message => message.mes), ['answer one', 'question two', 'answer two']);
});

test('adds bonus and caps effective chance at 99', () => {
    assert.equal(effectivePercent(10, 20), 30);
    assert.equal(effectivePercent(90, 20), 99);
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
    const nodes = ['паника', 'новый персонаж', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', 'бег'];
    assert.deepEqual(
        blockPlanNode(nodes, '  новый   персонаж '),
        ['паника', ' ', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', 'бег'],
    );
    assert.deepEqual(blockPlanNode(nodes, ''), nodes);
    assert.deepEqual(blockPlanNode(nodes, 'другая нода'), nodes);
});

test('formats one plan line and appends it after the user turn', () => {
    const nodes = ['паника', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', 'бег', 'внезапные события'];
    assert.deepEqual(parsePlanNodes({ nodes }), nodes);
    assert.equal(parsePlanNodes({ nodes: nodes.slice(0, 9) }), null);

    const withGaps = ['паника', ' ', 'разговор', 'тишина', 'шаг', 'дверь', 'свет', 'голос', 'выбор', ' '];
    assert.deepEqual(parsePlanNodes({ nodes: withGaps }), withGaps);
    assert.equal(
        formatPlanLine(withGaps),
        'ВАЖНО!!! Адаптируй свой ответ под следующий план-структура сюжета: 1. [паника] - 2. [ ] - 3. [разговор] - 4. [тишина] - 5. [шаг] - 6. [дверь] - 7. [свет] - 8. [голос] - 9. [выбор] - 10. [ ]. Не выходи из роли. Интерпретируй интересно.',
    );

    const line = formatPlanLine(nodes);
    assert.equal(
        line,
        'ВАЖНО!!! Адаптируй свой ответ под следующий план-структура сюжета: 1. [паника] - 2. [разговор] - 3. [тишина] - 4. [шаг] - 5. [дверь] - 6. [свет] - 7. [голос] - 8. [выбор] - 9. [бег] - 10. [внезапные события]. Не выходи из роли. Интерпретируй интересно.',
    );
    assert.equal(line.includes('\n'), false);
    assert.equal(appendPlanLine('я прыгаю', line), `я прыгаю\n${line}`);
});
