import { getRequestHeaders } from '../../../../script.js';
import {
    RANDOMIZER_SCHEMA,
    appendFailureMarker,
    appendPlanLine,
    buildPlanContext,
    buildPlanRequestBody,
    buildRandomizerMessages,
    estimatePlanTokens,
    createPlanRequestGate,
    isPlanApiOfflineError,
    findLastUserMessage,
    formatPlanLine,
    preparePlanChat,
    normalizePlanTemperature,
    parsePlanNodes,
    parseRandomizerPayload,
    resolveRoll,
    selectTurnMessages,
} from './chance.js';

const EXTENSION_NAME = 'ChanceExt';
const INTERCEPTOR_NAME = 'chanceExtInterceptor';
const RESULT_EXTRA_KEY = 'chanceExtRoll';
const REQUEST_TIMEOUT_MS = 30_000;
const PLAN_API_URL = 'http://127.0.0.1:8010/v1/plans';
const PLAN_API_HEALTH_URL = 'http://127.0.0.1:8010/v1/health';
const PLAN_REQUEST_TIMEOUT_MS = 6_000;
const PLAN_HEALTH_TIMEOUT_MS = 2_000;
const TOAST_OPTIONS = Object.freeze({
    timeOut: 10_000,
    extendedTimeOut: 3_000,
    preventDuplicates: false,
});
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    bonusPercent: 20,
    model: 'google/gemini-3.8-flash',
    planInjecting: false,
    planTemperature: null,
});

let settings = { ...DEFAULT_SETTINGS };
const pendingResults = new Map();
let chatObserver = null;
const planRequests = createPlanRequestGate();

function notifyError(message, error) {
    const details = error instanceof Error ? error.message : String(error ?? '');
    console.error(`[${EXTENSION_NAME}] ${message}`, error);
    toastr.error(details ? `${message}: ${details}` : message, EXTENSION_NAME, TOAST_OPTIONS);
}

function notifyResult(result) {
    if (result.noRoll) {
        toastr.success('УДАЧА: бросок для этого хода не требуется', EXTENSION_NAME, TOAST_OPTIONS);
        return;
    }

    const message = `${result.success ? 'УДАЧА' : 'НЕУДАЧА'}: бросок ${result.rolledValue}, шанс ${result.percent}% (модель ${result.basePercent}% + бонус ${result.bonusPercent}%)`;
    const notify = result.success ? toastr.success.bind(toastr) : toastr.error.bind(toastr);
    notify(message, EXTENSION_NAME, TOAST_OPTIONS);
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const parsedBonus = Number.parseInt(source.bonusPercent, 10);

    return {
        enabled: source.enabled !== false,
        bonusPercent: Number.isFinite(parsedBonus) ? Math.min(99, Math.max(0, parsedBonus)) : DEFAULT_SETTINGS.bonusPercent,
        model: String(source.model || DEFAULT_SETTINGS.model).trim(),
        planInjecting: source.planInjecting === true,
        planTemperature: normalizePlanTemperature(source.planTemperature),
    };
}

function loadSettings() {
    const context = SillyTavern.getContext();
    context.extensionSettings[EXTENSION_NAME] ??= {};
    settings = normalizeSettings(context.extensionSettings[EXTENSION_NAME]);
    Object.assign(context.extensionSettings[EXTENSION_NAME], settings);
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.extensionSettings[EXTENSION_NAME] = { ...settings };
    context.saveSettingsDebounced();
}

function updateSettingsUi() {
    $('#chance_ext_enabled').prop('checked', settings.enabled);
    $('#chance_ext_bonus').val(settings.bonusPercent);
    $('#chance_ext_model').val(settings.model);
    $('#chance_ext_plan_injecting').prop('checked', settings.planInjecting);
    $('#chance_ext_plan_temperature').val(settings.planTemperature ?? '');
}

function bindSettingsUi() {
    $('#chance_ext_enabled').on('change', event => {
        settings.enabled = event.target.checked;
        saveSettings();
    });

    $('#chance_ext_bonus').on('change input', event => {
        const parsed = Number.parseInt(event.target.value, 10);
        settings.bonusPercent = Number.isFinite(parsed)
            ? Math.min(99, Math.max(0, parsed))
            : DEFAULT_SETTINGS.bonusPercent;
        saveSettings();
    });

    $('#chance_ext_model').on('change', event => {
        settings.model = String(event.target.value || '').trim() || DEFAULT_SETTINGS.model;
        event.target.value = settings.model;
        saveSettings();
    });

    $('#chance_ext_plan_injecting').on('change', event => {
        settings.planInjecting = event.target.checked;
        saveSettings();
    });

    $('#chance_ext_plan_temperature').on('change', event => {
        settings.planTemperature = normalizePlanTemperature(event.target.value);
        event.target.value = settings.planTemperature ?? '';
        saveSettings();
    });
}

async function installSettingsUi() {
    const response = await fetch(new URL('./settings.html', import.meta.url));
    if (!response.ok) {
        throw new Error(`settings.html: HTTP ${response.status}`);
    }

    const html = await response.text();
    const container = document.querySelector('#extensions_settings');
    if (!container) {
        throw new Error('SillyTavern extension settings container was not found');
    }

    container.querySelector('.chance-ext-settings')?.remove();
    container.insertAdjacentHTML('beforeend', html);
    updateSettingsUi();
    bindSettingsUi();
}

function extractProviderContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
        return content
            .filter(part => part?.type === 'text' && typeof part?.text === 'string')
            .map(part => part.text)
            .join('');
    }
    return content;
}

async function requestProbability(messages, model, cancelSignal) {
    const controller = new AbortController();
    // A stalled helper request must not leave this and all following generations waiting until a page reload.
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onCancel = () => controller.abort();
    if (cancelSignal?.aborted) {
        controller.abort();
    } else {
        cancelSignal?.addEventListener?.('abort', onCancel, { once: true });
    }

    // The SillyTavern backend keeps the OpenRouter secret server-side, so the extension never reads or stores the API key.
    try {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            signal: controller.signal,
            body: JSON.stringify({
                type: 'quiet',
                chat_completion_source: 'openrouter',
                model,
                messages,
                temperature: 0.15,
                max_tokens: 600,
                stream: false,
                top_p: 0.98,
                top_k: 0,
                min_p: 0,
                top_a: 1,
                repetition_penalty: 1,
                include_reasoning: false,
                reasoning_effort: 'low',
                allow_fallbacks: true,
                json_schema: {
                    name: 'chance_ext_randomizer_v1',
                    strict: true,
                    value: RANDOMIZER_SCHEMA,
                },
            }),
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`OpenRouter HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }

        const data = await response.json();
        if (data?.error) {
            throw new Error(data.error.message || String(data.error));
        }

        return parseRandomizerPayload(extractProviderContent(data));
    } catch (error) {
        if (cancelSignal?.aborted) {
            throw error;
        }
        if (controller.signal.aborted) {
            throw new Error(`OpenRouter не ответил за ${REQUEST_TIMEOUT_MS / 1000} секунд`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        cancelSignal?.removeEventListener?.('abort', onCancel);
    }
}

function shouldProcessGeneration(type) {
    return !['quiet', 'impersonate', 'continue'].includes(String(type || '').toLowerCase());
}

function shouldRequestPlan(type) {
    // quiet is an internal helper call; a story plan there would stall it and pollute its prompt.
    return String(type || '').toLowerCase() !== 'quiet';
}

function notifyPlanApiOff() {
    const message = 'API плана выключен. Включите API плана';
    console.error(`[${EXTENSION_NAME}] ${message}`);
    toastr.error(message, EXTENSION_NAME, TOAST_OPTIONS);
}

function stopGeneration(abortGeneration) {
    if (typeof abortGeneration === 'function') {
        abortGeneration(true);
    }
}

function notifyPlanSkipped(message, error) {
    console.warn(`[${EXTENSION_NAME}] ${message}`, error ?? '');
    toastr.warning(message, EXTENSION_NAME, {
        ...TOAST_OPTIONS,
        timeOut: 4_000,
    });
}

async function requestPlanNodes(contextText, requestId, controller) {
    // Stop waiting after 6s. The server still finishes this POST; a later body is not reused.
    const timeoutId = setTimeout(() => controller.abort(), PLAN_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(PLAN_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            signal: controller.signal,
            body: JSON.stringify(buildPlanRequestBody(contextText, settings.planTemperature)),
        });

        if (!planRequests.isCurrent(requestId)) {
            return null;
        }
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Plan API HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }

        const nodes = parsePlanNodes(await response.json());
        if (!planRequests.isCurrent(requestId)) {
            return null;
        }
        if (!nodes) {
            throw new Error('Plan API returned an unexpected payload');
        }
        return nodes;
    } catch (error) {
        if (!planRequests.isCurrent(requestId)) {
            return null;
        }
        if (isPlanApiOfflineError(error)) {
            return { offline: true };
        }
        if (controller.signal.aborted) {
            notifyPlanSkipped(`План не получен за ${PLAN_REQUEST_TIMEOUT_MS / 1000} с, генерация без него`);
            return null;
        }
        notifyPlanSkipped('План не получен, генерация без него', error);
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function probePlanApi(requestId) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PLAN_HEALTH_TIMEOUT_MS);
    const unsubscribe = planRequests.subscribe(() => {
        if (!planRequests.isCurrent(requestId)) {
            controller.abort();
        }
    });

    try {
        const response = await fetch(PLAN_API_HEALTH_URL, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!planRequests.isCurrent(requestId)) {
            return 'superseded';
        }
        return response.ok ? 'online' : 'offline';
    } catch {
        if (!planRequests.isCurrent(requestId)) {
            return 'superseded';
        }
        return 'offline';
    } finally {
        clearTimeout(timeoutId);
        unsubscribe();
    }
}

function startPlanRequest(type) {
    // A new click gets its own POST. The API will not cancel or replace the previous one.
    const requestId = planRequests.begin();
    const cancel = new AbortController();
    const planController = new AbortController();
    const unsubscribe = planRequests.subscribe(() => {
        if (!planRequests.isCurrent(requestId)) {
            cancel.abort();
            planController.abort();
        }
    });
    const ready = probePlanApi(requestId);
    // Saved chat only: the interceptor copy already contains reasoning, attachments, and regex prompt edits.
    const source = preparePlanChat(SillyTavern.getContext().chat, type);
    const contextText = findLastUserMessage(source) ? buildPlanContext(source) : '';

    return {
        requestId,
        cancel,
        unsubscribe,
        ready,
        task: ready.then(status => {
            if (status === 'offline') {
                return { offline: true };
            }
            if (status !== 'online' || !planRequests.isCurrent(requestId) || !contextText) {
                if (!contextText && status === 'online') {
                    console.info(`[${EXTENSION_NAME}] План пропущен: нет сообщения пользователя`);
                }
                return null;
            }
            console.info(`[${EXTENSION_NAME}] Запрос плана`, { requestId, tokens: estimatePlanTokens(contextText) });
            return requestPlanNodes(contextText, requestId, planController);
        }),
    };
}

function applyPlanInjection(chat, nodes) {
    if (!nodes) {
        return;
    }

    const target = findLastUserMessage(chat);
    if (!target) {
        console.info(`[${EXTENSION_NAME}] План получен, но сообщение пользователя для вставки не найдено`);
        return;
    }

    const planLine = formatPlanLine(nodes);
    // Same prompt copy as the failure marker: the saved chat message stays unchanged.
    target.mes = appendPlanLine(target.mes, planLine);
    console.info(`[${EXTENSION_NAME}] План внедрён`, planLine);
}

function getExpectedMessageId(type) {
    const chat = SillyTavern.getContext().chat;
    return String(type || '').toLowerCase() === 'swipe' ? chat.length - 1 : chat.length;
}

function clearInheritedSwipeResult(type, messageId) {
    if (String(type || '').toLowerCase() !== 'swipe') {
        return;
    }

    const message = SillyTavern.getContext().chat[messageId];
    if (message?.extra && typeof message.extra === 'object') {
        // SillyTavern reuses the current message extras for a new swipe, so remove the prior swipe's badge after it has been saved in swipe_info.
        delete message.extra[RESULT_EXTRA_KEY];
        renderResultIcon(messageId);
    }
}

function saveResultToMessage(messageId, result) {
    const message = SillyTavern.getContext().chat[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    message.extra[RESULT_EXTRA_KEY] = { ...result };

    const swipeId = message.swipe_id;
    const swipeExtra = Number.isInteger(swipeId) && message.swipe_info?.[swipeId]?.extra;
    if (swipeExtra && typeof swipeExtra === 'object') {
        // Streaming has already copied extras into swipe_info before the rendered event, so keep both representations aligned.
        swipeExtra[RESULT_EXTRA_KEY] = { ...result };
    }
}

function renderResultIcon(messageId) {
    const id = Number(messageId);
    if (!Number.isInteger(id)) {
        return;
    }

    const messageElement = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!messageElement) {
        return;
    }

    messageElement.querySelectorAll('.chance-ext-result-icon').forEach(icon => icon.remove());
    messageElement.classList.remove('chance-ext-has-result');

    const result = SillyTavern.getContext().chat[id]?.extra?.[RESULT_EXTRA_KEY];
    if (typeof result?.success !== 'boolean') {
        return;
    }

    const icon = document.createElement('div');
    const outcome = result.success ? 'Удача' : 'Неудача';
    icon.className = `chance-ext-result-icon fa-solid ${result.success ? 'fa-circle-check' : 'fa-circle-xmark'}`;
    icon.dataset.outcome = result.success ? 'success' : 'failure';
    icon.title = result.noRoll ? `${outcome}: бросок не требовался` : outcome;
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', icon.title);

    const host = messageElement.querySelector('.mes_block') || messageElement;
    messageElement.classList.add('chance-ext-has-result');
    host.appendChild(icon);
}

function renderAllResultIcons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(message => {
        renderResultIcon(message.getAttribute('mesid'));
    });
}

function handleCharacterMessageRendered(messageId) {
    const id = Number(messageId);
    const result = pendingResults.get(id);
    if (result) {
        pendingResults.delete(id);
        saveResultToMessage(id, result);
    }
    renderResultIcon(id);
}

function scheduleAllResultIcons() {
    requestAnimationFrame(renderAllResultIcons);
}

function installResultUi() {
    const context = SillyTavern.getContext();
    context.eventSource.on(context.eventTypes.CHARACTER_MESSAGE_RENDERED, handleCharacterMessageRendered);
    context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, renderResultIcon);
    context.eventSource.on(context.eventTypes.MORE_MESSAGES_LOADED, scheduleAllResultIcons);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        pendingResults.clear();
        scheduleAllResultIcons();
    });

    const chatElement = document.querySelector('#chat');
    if (chatElement) {
        chatObserver?.disconnect();
        chatObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) {
                        continue;
                    }
                    if (node.matches('.mes[mesid]')) {
                        renderResultIcon(node.getAttribute('mesid'));
                    }
                    node.querySelectorAll?.('.mes[mesid]').forEach(message => {
                        renderResultIcon(message.getAttribute('mesid'));
                    });
                }
            }
        });
        chatObserver.observe(chatElement, { childList: true, subtree: true });
    }

    renderAllResultIcons();
}

async function interceptGeneration(chat, _contextSize, abortGeneration, type) {
    const runPlan = settings.planInjecting && shouldRequestPlan(type);
    const runChance = settings.enabled && Boolean(settings.model) && shouldProcessGeneration(type);
    if (!runPlan && !runChance) {
        return;
    }

    // Snapshot the dialogue before the dice marker is merged, then inject the plan last.
    const planRun = runPlan ? startPlanRequest(type) : null;

    try {
        if (planRun) {
            const status = await planRun.ready;
            // API is off, or this click was replaced: do not start the main prompt.
            if (status !== 'online') {
                return;
            }
        }

        if (!runChance) {
            return;
        }

        const selection = selectTurnMessages(chat, 3);
        if (!selection) {
            console.info(`[${EXTENSION_NAME}] Проверка пропущена: последнее сообщение пользователя не найдено`);
            return;
        }

        const messageId = getExpectedMessageId(type);
        pendingResults.delete(messageId);
        clearInheritedSwipeResult(type, messageId);

        try {
            console.info(`[${EXTENSION_NAME}] Проверка вероятности`, { type, messageId });
            const action = await requestProbability(buildRandomizerMessages(selection), settings.model, planRun?.cancel.signal);
            if (!action) {
                const result = {
                    success: true,
                    noRoll: true,
                    bonusPercent: settings.bonusPercent,
                };
                pendingResults.set(messageId, result);
                console.info(`[${EXTENSION_NAME}] УДАЧА: бросок не требуется`, { type, messageId });
                notifyResult(result);
                return;
            }

            const result = resolveRoll(action, settings.bonusPercent);
            if (!result.success) {
                // The interceptor receives SillyTavern's prompt copy, keeping the visible and saved user message untouched.
                selection.target.mes = appendFailureMarker(selection.target.mes, result.failureText);
            }

            const storedResult = {
                ...result,
                noRoll: false,
                bonusPercent: settings.bonusPercent,
            };
            pendingResults.set(messageId, storedResult);
            console.info(`[${EXTENSION_NAME}] ${result.success ? 'УДАЧА' : 'НЕУДАЧА'}`, storedResult);
            notifyResult(storedResult);
        } catch (error) {
            if (planRun?.cancel.signal.aborted) {
                return;
            }
            pendingResults.delete(messageId);
            // A helper-model outage must not prevent the user's main SillyTavern generation.
            notifyError('Проверка вероятности пропущена', error);
        }
    } finally {
        try {
            if (planRun) {
                const nodes = await planRun.task;
                if (nodes?.offline) {
                    if (planRequests.isCurrent(planRun.requestId)) {
                        notifyPlanApiOff();
                    }
                    stopGeneration(abortGeneration);
                } else if (planRequests.isCurrent(planRun.requestId)) {
                    applyPlanInjection(chat, nodes);
                } else {
                    // The API answers every POST. This body belongs to the click that sent it, not the newer one.
                    console.info(`[${EXTENSION_NAME}] План ${planRun.requestId} отброшен: уже есть более новый запрос`);
                    stopGeneration(abortGeneration);
                }
            }
        } finally {
            planRun?.unsubscribe();
        }
    }
}

globalThis[INTERCEPTOR_NAME] = interceptGeneration;

jQuery(async () => {
    try {
        loadSettings();
        installResultUi();
        console.log(`[${EXTENSION_NAME}] Ready`);
    } catch (error) {
        notifyError('Ошибка запуска расширения', error);
        return;
    }

    try {
        await installSettingsUi();
    } catch (error) {
        notifyError('Ошибка интерфейса настроек', error);
    }
});
