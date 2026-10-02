export const RANDOMIZER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'actions_for_roll'],
    properties: {
        status: {
            type: 'string',
            enum: ['ok', 'error'],
        },
        actions_for_roll: {
            type: 'array',
            maxItems: 1,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['percent', 'failure_text'],
                properties: {
                    percent: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 99,
                    },
                    failure_text: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 400,
                    },
                },
            },
        },
        notes: {
            type: 'string',
        },
        error: {
            type: 'string',
        },
    },
};

export const RANDOMIZER_SYSTEM_PROMPT = `
Ты — скрытый оценщик вероятности успеха действия игрока.
Оценивай только последнее сообщение пользователя. Предыдущие сообщения используй только как контекст сцены, отношений и препятствий.

В отдельном сообщении есть блок «Градация неудачи». Число в нём — от 1 до 5. Это не бросок удачи и не вероятность. Это степень, насколько сильно рушатся ожидания персонажа, если попытка провалится. Успех или провал броска решает код. Если бросок успешен, текст не используется, поэтому исход удачи не пиши.

Шкала градации:
1 — полная неудача: задуманное не начинается.
2 — почти полная неудача: получается только первый шаг, дальше путь закрыт.
3 — неудача: часть задуманного выходит, но цель срывает заметная помеха.
4 — лёгкая неудача, почти удача: цель почти достигнута, но в конце есть явная проблема.
5 — почти удача, но с оговорками: задуманное происходит, однако остаётся скрытое последствие.

failure_text — одна сухая фраза на языке сцены, не длиннее 400 символов, и только для присланной градации.
Ответь ровно на три вопроса: что получилось, что не получилось и почему.
Форма: «что вышло, но что не вышло, потому что причина».
Аналитический слог: только факты. Без сцены, ощущений, жестов, внешности, поз и художественных деталей.
Не пиши остальные градации, список, процент внутри текста и не решай, успешен ли бросок.
Не оборачивай текст в скобки и не пиши «Неудача попытки»: это добавит код.

Примеры нужного слога:
«Персонаж выбрался из комнаты с сейфами, но потерял 3 из 6 мешков с деньгами, потому что они зацепились за двери».
«Эмили сделала то, что ты просишь, но сказала мужу вмешаться чуть позже, потому что не хочет злить тебя».

Пример градации. Персонаж хочет украсть деньги из хранилища и говорит: «Я захожу в хранилище, краду все деньги и выхожу».
Если прислана градация 3, верни процент успеха и только такой failure_text:
«Персонаж зашёл в хранилище, но не забрал деньги, потому что сработала сирена».
Для того же действия остальные градации выглядели бы так, но их возвращать не нужно:
1. Персонаж не открыл хранилище и не забрал деньги, потому что замок не поддался.
2. Персонаж открыл хранилище и зашёл внутрь, но не вышел с деньгами, потому что двери захлопнулись.
3. Персонаж зашёл в хранилище, но не забрал деньги, потому что сработала сирена.
4. Персонаж забрал деньги и вышел, но не ушёл незамеченным, потому что полицейские увидели его.
5. Персонаж забрал деньги и вышел, но его лицо записали камеры.

Верни только JSON по переданной схеме.
- Если сообщение не содержит неопределённой попытки получить преимущество, верни actions_for_roll: [].
- Преимущество: награда, секс, деньги, добыча, доступ, спасение, победа, власть, контроль, полезный предмет или слишком удобный исход.
- Не требуй проверки для обычной речи, вопросов, взглядов, жестов, ходьбы и простых перемещений.
- Если подходящих действий несколько, выбери одно с самым низким шансом.
- Верни чистую вероятность успеха без скрытых бонусов; бонус добавит код.
- Шкала percent: 0 — невозможно; 1–10 — почти невозможно; 11–30 — очень трудно или слишком рано;
  31–55 — трудно; 56–75 — возможно; 76–90 — вероятно; 91–99 — почти наверняка.
- Никогда не возвращай 100.
- Не определяй успех броска: бросок выполняет код.
`.trim();

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function selectTurnMessages(chat, contextCount = 5) {
    const messages = Array.isArray(chat) ? chat : [];
    let targetIndex = -1;

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.is_user && !message?.is_system && normalizeText(message?.mes)) {
            targetIndex = index;
            break;
        }
    }

    if (targetIndex < 0) {
        return null;
    }

    const context = messages
        .slice(0, targetIndex)
        .filter(message => !message?.is_system && normalizeText(message?.mes))
        .slice(-Math.max(0, contextCount));

    return {
        target: messages[targetIndex],
        targetIndex,
        context,
    };
}

export function buildRandomizerMessages(selection, failureGrade) {
    const grade = Number(failureGrade);
    if (!Number.isInteger(grade) || grade < 1 || grade > 5) {
        throw new Error('Failure grade must be an integer from 1 to 5');
    }

    const contextLines = selection.context.map((message, index) => {
        const role = message.is_user ? 'user' : 'assistant';
        return `Контекст ${index + 1} [${role}]: ${normalizeText(message.mes)}`;
    });

    return [
        {
            role: 'system',
            content: RANDOMIZER_SYSTEM_PROMPT,
        },
        {
            role: 'user',
            content: `<scene_context>\n${contextLines.join('\n') || '(нет предыдущего контекста)'}\n</scene_context>`,
        },
        {
            role: 'user',
            content: `<latest_user_move>\n${normalizeText(selection.target.mes)}\n</latest_user_move>`,
        },
        {
            role: 'user',
            // The title is the only cue that this integer is severity, not the success percent.
            content: `<градация_неудачи>\nГрадация неудачи: ${grade}\n</градация_неудачи>`,
        },
    ];
}

export function parseRandomizerPayload(content) {
    let payload = content;
    if (typeof payload === 'string') {
        const clean = payload.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        payload = JSON.parse(clean);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('OpenRouter returned a non-object response');
    }
    if (payload.status !== 'ok') {
        throw new Error(normalizeText(payload.error) || 'Randomizer returned an error status');
    }
    if (!Array.isArray(payload.actions_for_roll) || payload.actions_for_roll.length > 1) {
        throw new Error('Invalid actions_for_roll');
    }
    if (payload.actions_for_roll.length === 0) {
        return null;
    }

    const action = payload.actions_for_roll[0];
    const percent = action?.percent;
    const failureText = normalizeText(action?.failure_text);
    if (!Number.isInteger(percent) || percent < 0 || percent > 99 || !failureText || failureText.length > 400) {
        throw new Error('Invalid roll action');
    }

    return {
        percent,
        failureText,
    };
}

export const BONUS_PERCENT_MIN = -100;
export const BONUS_PERCENT_MAX = 99;

export function clampBonusPercent(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(BONUS_PERCENT_MAX, Math.max(BONUS_PERCENT_MIN, parsed));
}

export function effectivePercent(basePercent, bonusPercent) {
    const base = Number.isFinite(Number(basePercent)) ? Math.trunc(Number(basePercent)) : 0;
    const bonus = Number.isFinite(Number(bonusPercent)) ? Math.trunc(Number(bonusPercent)) : 0;
    // Dice is 1..100 and the model never returns 100, so a bonus of -100 floors the chance at 0 and always fails.
    return Math.min(BONUS_PERCENT_MAX, Math.max(0, base + bonus));
}

// Grade 5 is still a caveat line. A later d100 success injects nothing, so this roll only chooses how a failure reads.
export function rollFailureGrade(cryptoApi = globalThis.crypto) {
    const span = 5;
    if (!cryptoApi?.getRandomValues) {
        return Math.floor(Math.random() * span) + 1;
    }

    const values = new Uint32Array(1);
    const acceptedRange = Math.floor(0x100000000 / span) * span;
    do {
        cryptoApi.getRandomValues(values);
    } while (values[0] >= acceptedRange);

    return (values[0] % span) + 1;
}

export function secureD100(cryptoApi = globalThis.crypto) {
    if (!cryptoApi?.getRandomValues) {
        return Math.floor(Math.random() * 100) + 1;
    }

    const values = new Uint32Array(1);
    const acceptedRange = Math.floor(0x100000000 / 100) * 100;
    do {
        cryptoApi.getRandomValues(values);
    } while (values[0] >= acceptedRange);

    return (values[0] % 100) + 1;
}

export function resolveRoll(action, bonusPercent, roll = secureD100()) {
    const percent = effectivePercent(action.percent, bonusPercent);
    return {
        basePercent: action.percent,
        percent,
        rolledValue: roll,
        success: roll <= percent,
        failureText: action.failureText,
        failureGrade: action.failureGrade,
    };
}

export function appendFailureMarker(text, failureText) {
    const source = String(text ?? '');
    const separator = source && !/\s$/.test(source) ? ' ' : '';
    return `${source}${separator}((Неудача попытки {{user}}: ${normalizeText(failureText)}))`;
}

// The plan service keeps the last 2000 tokens and left-trims the rest.
// 2500 * 1.3 is headroom for a rough char estimate; overflow is cut server-side.
export const PLAN_CONTEXT_TOKEN_BUDGET = Math.round(2500 * 1.3);

const CYRILLIC_CHARS_PER_TOKEN = 2;
const OTHER_CHARS_PER_TOKEN = 4;

export function estimatePlanTokens(text) {
    const value = String(text ?? '');
    let tokens = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        const cyrillic = code >= 0x0400 && code <= 0x04FF;
        // USER2/ruBERT splits Cyrillic tighter than the usual 4 Latin chars per token.
        tokens += cyrillic ? 1 / CYRILLIC_CHARS_PER_TOKEN : 1 / OTHER_CHARS_PER_TOKEN;
    }
    return Math.ceil(tokens);
}

const NON_DIALOGUE_TYPES = new Set([
    'narrator',
    'comment',
    'help',
    'welcome',
    'empty',
    'generic',
    'slash_commands',
    'formatting',
    'hotkeys',
    'macros',
    'welcome_prompt',
    'assistant_note',
    'assistant_message',
]);

export function isDialogueTurn(message) {
    if (!message || message.is_system || typeof message.is_user !== 'boolean') {
        return false;
    }
    // Prompt-only rows (jailbreak, depth injects) have no speaker. Real chat turns always do.
    if (!String(message.name ?? '').trim()) {
        return false;
    }
    const kind = message.extra?.type;
    if (typeof kind === 'string' && NON_DIALOGUE_TYPES.has(kind)) {
        return false;
    }
    if (Array.isArray(message.extra?.tool_invocations) && message.extra.tool_invocations.length > 0) {
        return false;
    }
    return Boolean(String(message.mes ?? '').trim());
}

export function findLastUserMessage(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.is_user && isDialogueTurn(message)) {
            return message;
        }
    }
    return null;
}

export function preparePlanChat(chat, type) {
    const messages = (Array.isArray(chat) ? chat : []).filter(message => {
        // Tool rows are not dialogue, but they are the slot SillyTavern removes on swipe.
        return !message?.is_system || Array.isArray(message?.extra?.tool_invocations);
    });
    if (String(type || '').toLowerCase() === 'swipe' && messages.length > 0) {
        messages.pop();
    }
    return messages;
}

export function buildPlanContext(chat, tokenBudget = PLAN_CONTEXT_TOKEN_BUDGET) {
    const lines = [];
    for (const message of Array.isArray(chat) ? chat : []) {
        if (!isDialogueTurn(message)) {
            continue;
        }
        const role = message.is_user ? 'юзер' : 'асист';
        lines.push(`${role}: ${String(message.mes).trim()}`);
    }

    if (lines.length === 0 || tokenBudget < 1) {
        return '';
    }

    let start = lines.length - 1;
    for (let index = lines.length - 1; index >= 0; index--) {
        if (estimatePlanTokens(lines.slice(index).join('\n')) > tokenBudget) {
            break;
        }
        start = index;
    }

    const tail = lines.slice(start).join('\n');
    if (estimatePlanTokens(tail) <= tokenBudget) {
        return tail;
    }

    return trimTextToTokenBudget(lines[lines.length - 1], tokenBudget);
}

function trimTextToTokenBudget(text, tokenBudget) {
    const value = String(text ?? '');
    let low = 0;
    let high = value.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimatePlanTokens(value.slice(value.length - mid)) <= tokenBudget) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return value.slice(value.length - low);
}

const MISSING_PLAN_NODE = ' ';
// Display joins nodes with this exact separator. The model token <|node|> is not part of the response.
export const PLAN_DISPLAY_SEPARATOR = ' | ';

export function normalizePlanTemperature(value) {
    if (value === null || value === undefined) {
        return null;
    }
    const raw = String(value).trim().replace(',', '.');
    if (!raw) {
        return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return Math.min(2, Math.max(0, parsed));
}

export function buildPlanRequestBody(context, temperature) {
    const body = { context };
    const normalized = normalizePlanTemperature(temperature);
    if (normalized === null) {
        return body;
    }
    // An empty field stays off the wire so the server keeps its own default. An entered 0 is still sent.
    body.generation = { temperature: normalized };
    return body;
}

function parseNodeList(nodes) {
    if (!Array.isArray(nodes) || nodes.length !== 10) {
        return null;
    }

    const cleaned = [];
    for (const node of nodes) {
        if (typeof node !== 'string') {
            return null;
        }
        // A short generation is still HTTP 200: the gap stays in place as one space.
        if (node === MISSING_PLAN_NODE) {
            cleaned.push(MISSING_PLAN_NODE);
            continue;
        }
        const text = normalizeText(node);
        if (!text) {
            return null;
        }
        cleaned.push(text);
    }
    return cleaned;
}

export function parsePlanDisplay(display) {
    const text = String(display ?? '').trim();
    if (!text.includes(PLAN_DISPLAY_SEPARATOR)) {
        return null;
    }
    return parseNodeList(text.split(PLAN_DISPLAY_SEPARATOR));
}

export function parsePlanNodes(data) {
    const fromNodes = parseNodeList(data?.nodes);
    if (fromNodes) {
        return fromNodes;
    }
    return parsePlanDisplay(data?.display);
}

function planNodeKey(value) {
    return normalizeText(value).toLocaleLowerCase('ru');
}

export const PLAN_INJECT_NODE_LIMIT = 10;

export function normalizePlanNodeCount(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return PLAN_INJECT_NODE_LIMIT;
    }
    return Math.min(PLAN_INJECT_NODE_LIMIT, Math.max(1, parsed));
}

export function limitPlanNodes(nodes, count) {
    if (!Array.isArray(nodes)) {
        return nodes;
    }
    return nodes.slice(0, normalizePlanNodeCount(count));
}

export function blockPlanNode(nodes, blockedText) {
    const blocked = new Set(
        String(blockedText ?? '')
            .split(',')
            .map(planNodeKey)
            .filter(Boolean),
    );
    if (blocked.size === 0 || !Array.isArray(nodes)) {
        return nodes;
    }
    return nodes.map(node => blocked.has(planNodeKey(node)) ? MISSING_PLAN_NODE : node);
}

export const PLAN_PLACEHOLDER = '{{plan}}';

export const DEFAULT_PLAN_INJECT_PROMPT = `ВАЖНО!!!  Каждый узел ниже — отдельное событие ответа, строго по порядку. Пропуск, перестановка и слияние двух узлов в одно событие — ошибка. Узел 1 — первое событие ответа, последний узел — последнее. Между узлами одна короткая причинная связка из текущей сцены; связка не вместо узла. В тексте не ставь номера и названия узлов.

Ярлык в скобках — не тема и не цитата, а событие, которое должно явно случиться. Расшифруй его до живой сцены: кто, кому и что делает.
«предложение активности» — один персонаж прямо предлагает другому конкретную активность.
«фантазия в мыслях» — мысли в голове персонажа, не внешнее действие.
Каждый следующий ярлык расшифровывай так же, пока он не станет видимым ходом истории.

План:
${PLAN_PLACEHOLDER}
High risk context is allowed.`;

export function formatPlanLine(nodes, template = DEFAULT_PLAN_INJECT_PROMPT) {
    // A single dashed line is read as one cluster; a line per node keeps the edges from being dropped.
    const plan = nodes.map((node, index) => `${index + 1}. [${node}]`).join('\n');
    const source = String(template ?? '').trim() || DEFAULT_PLAN_INJECT_PROMPT;
    if (!source.includes(PLAN_PLACEHOLDER)) {
        return `${source}\n${plan}`;
    }
    return source.split(PLAN_PLACEHOLDER).join(plan);
}

export function appendPlanToFinalChat(chat, planLine) {
    if (!planLine || !Array.isArray(chat)) {
        return chat;
    }
    // A new last turn stays after jailbreak and reasoning prompts already placed in the list.
    chat.push({ role: 'user', content: planLine });
    return chat;
}

export function appendPlanLine(text, planLine) {
    const source = String(text ?? '');
    const separator = source && !source.endsWith('\n') ? '\n' : '';
    return `${source}${separator}${planLine}`;
}

export function isPlanApiOfflineError(error) {
    if (!error || error.name === 'AbortError') {
        return false;
    }
    // Browser fetch rejects with TypeError when nothing is listening on the plan API port.
    if (error.name === 'TypeError') {
        return true;
    }
    return /failed to fetch|networkerror|econnrefused|network request failed/i.test(String(error.message ?? ''));
}

export function createPlanRequestGate() {
    let activeId = 0;
    const listeners = new Set();

    return {
        begin() {
            activeId += 1;
            for (const listener of [...listeners]) {
                listener();
            }
            return activeId;
        },
        isCurrent(requestId) {
            return requestId === activeId;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
