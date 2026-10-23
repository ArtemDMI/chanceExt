export function normalizeNodePanelPosition(value) {
    const coordinate = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
    return { x: coordinate(value?.x), y: coordinate(value?.y) };
}

export function createNodePanel({ position, onGenerate, onPositionChange }) {
    const panel = document.createElement('section');
    panel.className = 'chance-ext-node-panel';
    panel.setAttribute('aria-label', 'Панель нод');
    panel.innerHTML = `
        <div class="chance-ext-node-panel-handle" tabindex="0" role="button" aria-label="Переместить панель нод" title="Перетащите панель или используйте стрелки">Ноды <span aria-hidden="true">::</span></div>
        <ol class="chance-ext-node-panel-list"></ol>
        <div class="chance-ext-node-panel-status" role="status"></div>
        <button type="button" class="chance-ext-node-panel-generate">Gen nodes</button>`;
    const handle = panel.querySelector('.chance-ext-node-panel-handle');
    const list = panel.querySelector('ol');
    const status = panel.querySelector('[role="status"]');
    const button = panel.querySelector('button');
    let location = normalizeNodePanelPosition(position);
    let drag = null;
    document.body.appendChild(panel);

    function place() {
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const x = Math.min(Math.max(0, window.innerWidth - width), location.x ?? window.innerWidth - width - 16);
        const y = Math.min(Math.max(0, window.innerHeight - height), location.y ?? 80);
        panel.style.left = `${Math.max(0, x)}px`;
        panel.style.top = `${Math.max(0, y)}px`;
    }

    function remember() {
        location = { x: panel.offsetLeft, y: panel.offsetTop };
        onPositionChange(location);
    }

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        drag = { id: event.pointerId, x: event.clientX - panel.offsetLeft, y: event.clientY - panel.offsetTop };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        location = { x: Math.max(0, event.clientX - drag.x), y: Math.max(0, event.clientY - drag.y) };
        place();
    });
    const endDrag = () => {
        if (!drag) return;
        drag = null;
        remember();
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('lostpointercapture', endDrag);
    handle.addEventListener('keydown', event => {
        const movement = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!movement) return;
        event.preventDefault();
        location = { x: Math.max(0, panel.offsetLeft + movement[0]), y: Math.max(0, panel.offsetTop + movement[1]) };
        place();
        remember();
    });
    // Panel keyboard input must not trigger SillyTavern's send or swipe shortcuts.
    panel.addEventListener('keydown', event => event.stopPropagation());
    button.addEventListener('click', () => { void onGenerate(); });
    window.addEventListener('resize', place);

    return {
        update({ nodes, count, blockedNodes, busy, error }) {
            const fragment = document.createDocumentFragment();
            for (let index = 0; index < count; index++) {
                const row = document.createElement('li');
                const name = nodes[index] || '';
                row.textContent = name || 'Не выбрана';
                row.title = name;
                row.classList.toggle('is-empty', !name);
                row.classList.toggle('is-blocked', Boolean(name) && blockedNodes[index] === ' ');
                fragment.appendChild(row);
            }
            list.replaceChildren(fragment);
            const valid = nodes.length >= count && blockedNodes.slice(0, count).every(node => node.trim());
            status.textContent = busy ? 'Подбор нод...' : error || (valid ? '' : 'Нажмите Gen nodes');
            status.hidden = !status.textContent;
            button.setAttribute('aria-busy', String(busy));
            place();
        },
        destroy() {
            window.removeEventListener('resize', place);
            panel.remove();
        },
    };
}
