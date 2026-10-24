import { createFloatingPanel, normalizeNodePanelSize } from './floating-panel.js';

export function createActionPanel({ position, size, onAction, onPositionChange, onSizeChange }) {
    const panel = document.createElement('section');
    panel.className = 'chance-ext-node-panel chance-ext-action-panel';
    panel.setAttribute('aria-label', 'Отправка и свайп');
    const sendIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M22 2 15 22l-4-9-9-4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m22 2-11 11" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
    const swipeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 4 8 8-8 8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    panel.innerHTML = `
        <div class="chance-ext-node-panel-handle chance-ext-action-panel-handle" tabindex="0" role="button" aria-label="Переместить панель отправки и свайпа" title="Перетащите панель или используйте стрелки">Отправка и свайп <span aria-hidden="true">::</span></div>
        <div class="chance-ext-action-panel-grid">
            <button type="button" data-action="swipe" data-mode="repeat" aria-label="Свайп: повтор" title="Свайп, повторяя последнюю ручную комбинацию">${swipeIcon}</button>
            <button type="button" data-action="swipe" data-mode="skip" aria-label="Свайп: пропуск" title="Свайп без нод и инструкции плана">${swipeIcon}</button>
            <button type="button" data-action="send" data-mode="repeat" aria-label="Отправить: повтор" title="Отправить, повторяя последнюю ручную комбинацию">${sendIcon}</button>
            <button type="button" data-action="send" data-mode="skip" aria-label="Отправить: пропуск" title="Отправить без нод и инструкции плана">${sendIcon}</button>
        </div>`;
    const buttons = [...panel.querySelectorAll('button')];
    const dimensions = normalizeNodePanelSize(size);
    const floating = createFloatingPanel({
        panel,
        handle: panel.querySelector('.chance-ext-action-panel-handle'),
        position,
        size: { ...dimensions, height: dimensions.height ?? 150 },
        onPositionChange,
        onSizeChange,
        bottom: true,
    });
    for (const button of buttons) {
        button.addEventListener('click', () => {
            if (!button.disabled) void onAction(button.dataset.action, button.dataset.mode);
        });
    }

    function update({ busy, canRepeat }) {
        panel.setAttribute('aria-busy', String(Boolean(busy)));
        for (const button of buttons) {
            button.disabled = Boolean(busy) || (button.dataset.mode === 'repeat' && !canRepeat);
        }
        floating.update();
    }

    update({ busy: false, canRepeat: false });
    return { update, destroy: () => floating.destroy() };
}
