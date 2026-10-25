export function createActionPanel({ onAction }) {
    const skipIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 4 11 8-11 8Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M19 4v16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const repeatIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const groups = ['send', 'swipe'].map(action => {
        const group = document.createElement('span');
        const label = action === 'send' ? 'Отправить' : 'Свайп';
        group.className = `chance-ext-actions chance-ext-${action}-actions`;
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `${label}: пропуск или повтор нод`);
        group.innerHTML = `
            <button type="button" data-action="${action}" data-mode="skip" aria-label="${label}: пропуск" title="${label} без нод и инструкции плана">${skipIcon}</button>
            <button type="button" data-action="${action}" data-mode="repeat" aria-label="${label}: повтор" title="${label}, повторяя последнюю ручную комбинацию">${repeatIcon}</button>`;
        // Enter/Space must activate only this button, not the host's send/swipe shortcuts.
        for (const type of ['keydown', 'keyup']) group.addEventListener(type, event => event.stopPropagation());
        group.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const button = event.target.closest('button');
            if (button && !button.disabled) void onAction(button.dataset.action, button.dataset.mode);
        });
        return group;
    });
    let state = { busy: false, canRepeat: false };
    let sendParent = null;
    let swipeMessage = null;
    let frame = null;

    function refresh() {
        const hosts = [
            document.querySelector('#send_but'),
            document.querySelector('#chat .last_mes .swipe_right'),
        ];
        groups.forEach((group, index) => {
            const host = hosts[index];
            if (host && group.nextElementSibling !== host) host.before(group);
            if (!host) group.remove();
            const style = host ? getComputedStyle(host) : null;
            const visible = host && !host.hidden && style.display !== 'none'
                && style.visibility !== 'hidden' && host.getClientRects().length > 0;
            group.hidden = !visible;
            group.setAttribute('aria-busy', String(Boolean(state.busy)));
            for (const button of group.querySelectorAll('button')) {
                button.disabled = !visible || Boolean(state.busy)
                    || (button.dataset.mode === 'repeat' && !state.canRepeat);
            }
        });
        const nextSendParent = hosts[0]?.parentElement ?? null;
        if (sendParent !== nextSendParent) sendParent?.classList.remove('chance-ext-has-send-actions');
        sendParent = nextSendParent;
        sendParent?.classList.toggle('chance-ext-has-send-actions', !groups[0].hidden);
        const nextSwipeMessage = hosts[1]?.closest('.mes') ?? null;
        if (swipeMessage !== nextSwipeMessage) swipeMessage?.classList.remove('chance-ext-has-swipe-actions');
        swipeMessage = nextSwipeMessage;
        swipeMessage?.classList.toggle('chance-ext-has-swipe-actions', !groups[1].hidden);
    }

    const observer = new MutationObserver(mutations => {
        if (frame !== null || mutations.every(mutation => mutation.target.closest?.('.chance-ext-actions'))) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            refresh();
        });
    });
    for (const root of [document.querySelector('#chat'), document.querySelector('#send_form')]) {
        if (root) observer.observe(root, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'],
        });
    }
    // ST hides native controls through body state as well as local classes and attributes.
    observer.observe(document.body, {
        attributes: true, attributeFilter: ['class', 'data-generating', 'data-swiping'],
    });

    function update(nextState) {
        state = nextState;
        refresh();
    }

    function destroy() {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        for (const group of groups) group.remove();
        sendParent?.classList.remove('chance-ext-has-send-actions');
        swipeMessage?.classList.remove('chance-ext-has-swipe-actions');
    }

    update(state);
    return { update, destroy };
}
