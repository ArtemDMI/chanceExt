export function normalizeNodePanelPosition(value) {
    const coordinate = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
    return { x: coordinate(value?.x), y: coordinate(value?.y) };
}

export function normalizeNodePanelSize(value) {
    const dimension = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value)) : fallback;
    return {
        width: dimension(value?.width, 180, 4000, 250),
        height: dimension(value?.height, 120, 2400, null),
    };
}

export function createNodePanel({ position, size, onGenerate, onPositionChange, onSizeChange }) {
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
    let dimensions = normalizeNodePanelSize(size);
    let initialized = false;
    let drag = null;
    panel.style.width = `${dimensions.width}px`;
    if (dimensions.height !== null) panel.style.height = `${dimensions.height}px`;
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
    const sizeObserver = new ResizeObserver(() => {
        if (!initialized) return;
        const width = Number.parseFloat(panel.style.width);
        const height = Number.parseFloat(panel.style.height);
        // Viewport clamping must not overwrite the user's preferred desktop size.
        if (width === dimensions.width && height === dimensions.height) return;
        dimensions = normalizeNodePanelSize({ width, height });
        place();
        remember();
        onSizeChange?.({ ...dimensions });
    });
    sizeObserver.observe(panel);

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
            status.textContent = error || (valid ? '' : 'Нажмите Gen nodes');
            status.hidden = !status.textContent;
            button.setAttribute('aria-busy', String(busy));
            if (!initialized && dimensions.height === null) {
                // Freeze the initial height so new node text or a status cannot move Gen nodes.
                dimensions.height = Math.ceil(panel.getBoundingClientRect().height);
                panel.style.height = `${dimensions.height}px`;
                onSizeChange?.({ ...dimensions });
            }
            place();
            if (!initialized) {
                location = { x: panel.offsetLeft, y: panel.offsetTop };
                initialized = true;
            }
        },
        destroy() {
            sizeObserver.disconnect();
            window.removeEventListener('resize', place);
            panel.remove();
        },
    };
}
