import { getRequestHeaders } from '../../../../script.js';
import {
    RANDOMIZER_SCHEMA,
    appendFailureMarker,
    buildRandomizerMessages,
    parseRandomizerPayload,
    resolveRoll,
    selectTurnMessages,
} from './chance.js';

const EXTENSION_NAME = 'ChanceExt';
const INTERCEPTOR_NAME = 'chanceExtInterceptor';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    bonusPercent: 20,
    model: 'google/gemini-3.8-flash',
});

let settings = { ...DEFAULT_SETTINGS };
let requestInProgress = false;

function notifyError(message, error) {
    const details = error instanceof Error ? error.message : String(error ?? '');
    console.error(`[${EXTENSION_NAME}] ${message}`, error);
    toastr.error(details ? `${message}: ${details}` : message, EXTENSION_NAME);
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const parsedBonus = Number.parseInt(source.bonusPercent, 10);

    return {
        enabled: source.enabled !== false,
        bonusPercent: Number.isFinite(parsedBonus) ? Math.min(99, Math.max(0, parsedBonus)) : DEFAULT_SETTINGS.bonusPercent,
        model: String(source.model || DEFAULT_SETTINGS.model).trim(),
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

async function requestProbability(messages, model) {
    // The SillyTavern backend keeps the OpenRouter secret server-side, so the extension never reads or stores the API key.
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
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
}

function shouldProcessGeneration(type) {
    return !['quiet', 'impersonate', 'continue'].includes(String(type || '').toLowerCase());
}

async function interceptGeneration(chat, _contextSize, _abort, type) {
    if (!settings.enabled || !settings.model || requestInProgress || !shouldProcessGeneration(type)) {
        return;
    }

    const selection = selectTurnMessages(chat, 3);
    if (!selection) {
        return;
    }

    requestInProgress = true;
    try {
        const action = await requestProbability(buildRandomizerMessages(selection), settings.model);
        if (!action) {
            return;
        }

        const result = resolveRoll(action, settings.bonusPercent);
        if (!result.success) {
            // The interceptor receives SillyTavern's prompt copy, keeping the visible and saved user message untouched.
            selection.target.mes = appendFailureMarker(selection.target.mes, result.failureText);
        }

        const outcome = result.success ? 'УДАЧА' : 'НЕУДАЧА';
        toastr.info(
            `${outcome}: бросок ${result.rolledValue}, шанс ${result.percent}% (модель ${result.basePercent}% + бонус ${settings.bonusPercent}%)`,
            EXTENSION_NAME,
        );
    } catch (error) {
        // A helper-model outage must not prevent the user's main SillyTavern generation.
        notifyError('Проверка вероятности пропущена', error);
    } finally {
        requestInProgress = false;
    }
}

globalThis[INTERCEPTOR_NAME] = interceptGeneration;

jQuery(async () => {
    try {
        loadSettings();
        await installSettingsUi();
        console.log(`[${EXTENSION_NAME}] Ready`);
    } catch (error) {
        notifyError('Ошибка запуска расширения', error);
    }
});
