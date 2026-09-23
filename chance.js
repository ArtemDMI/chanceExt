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
                        maxLength: 256,
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

Верни только JSON по переданной схеме.
- Если сообщение не содержит неопределённой попытки получить преимущество, верни actions_for_roll: [].
- Преимущество: награда, секс, деньги, добыча, доступ, спасение, победа, власть, контроль, полезный предмет или слишком удобный исход.
- Не требуй проверки для обычной речи, вопросов, взглядов, жестов, ходьбы и простых перемещений.
- Если подходящих действий несколько, выбери одно с самым низким шансом.
- Верни чистую вероятность без скрытых бонусов; бонус добавит код.
- Шкала: 0 — невозможно; 1–10 — почти невозможно; 11–30 — очень трудно или слишком рано;
  31–55 — трудно; 56–75 — возможно; 76–90 — вероятно; 91–99 — почти наверняка.
- Никогда не возвращай 100.
- failure_text — короткая фраза на языке сцены о том, что именно не удалось.
- Не определяй успех броска: бросок выполняет код.
`.trim();

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function selectTurnMessages(chat, contextCount = 3) {
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

export function buildRandomizerMessages(selection) {
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
    if (!Number.isInteger(percent) || percent < 0 || percent > 99 || !failureText || failureText.length > 256) {
        throw new Error('Invalid roll action');
    }

    return {
        percent,
        failureText,
    };
}

export function effectivePercent(basePercent, bonusPercent) {
    const base = Number.isFinite(Number(basePercent)) ? Math.trunc(Number(basePercent)) : 0;
    const bonus = Number.isFinite(Number(bonusPercent)) ? Math.trunc(Number(bonusPercent)) : 0;
    return Math.min(99, Math.max(0, base + bonus));
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

export function parsePlanNodes(data) {
    const nodes = data?.nodes;
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

export function formatPlanLine(nodes) {
    const plan = nodes.map((node, index) => `${index + 1}. [${node}]`).join(' - ');
    return `ВАЖНО!!! Адаптируй свой ответ под следующий план-структура сюжета: ${plan}. Не выходи из роли. Интерпретируй интересно.`;
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
