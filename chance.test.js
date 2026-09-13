import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendFailureMarker,
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
