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

export function createFloatingPanel({ panel, handle, position, size, onPositionChange, onSizeChange, bottom = false }) {
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
        const y = Math.min(Math.max(0, window.innerHeight - height), location.y ?? (bottom ? window.innerHeight - height - 16 : 80));
        panel.style.left = `${Math.max(0, x)}px`;
        panel.style.top = `${Math.max(0, y)}px`;
    }

    function remember() {
        location = { x: panel.offsetLeft, y: panel.offsetTop };
        onPositionChange?.({ ...location });
    }

    const startDrag = event => {
        if (event.button !== 0) return;
        drag = { id: event.pointerId, x: event.clientX - panel.offsetLeft, y: event.clientY - panel.offsetTop };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
    };
    const moveDrag = event => {
        if (!drag || event.pointerId !== drag.id) return;
        location = { x: Math.max(0, event.clientX - drag.x), y: Math.max(0, event.clientY - drag.y) };
        place();
    };
    const endDrag = () => {
        if (!drag) return;
        drag = null;
        remember();
    };
    const moveWithKeyboard = event => {
        const movement = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!movement) return;
        event.preventDefault();
        location = { x: Math.max(0, panel.offsetLeft + movement[0]), y: Math.max(0, panel.offsetTop + movement[1]) };
        place();
        remember();
    };
    // Panel keyboard input must not trigger SillyTavern's send or swipe shortcuts.
    const stopKeyboard = event => event.stopPropagation();
    handle.addEventListener('pointerdown', startDrag);
    handle.addEventListener('pointermove', moveDrag);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('lostpointercapture', endDrag);
    handle.addEventListener('keydown', moveWithKeyboard);
    panel.addEventListener('keydown', stopKeyboard);
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
        update() {
            if (!initialized && dimensions.height === null) {
                // Freeze initial height so content updates cannot move the panel's controls.
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
            handle.removeEventListener('pointerdown', startDrag);
            handle.removeEventListener('pointermove', moveDrag);
            handle.removeEventListener('pointerup', endDrag);
            handle.removeEventListener('pointercancel', endDrag);
            handle.removeEventListener('lostpointercapture', endDrag);
            handle.removeEventListener('keydown', moveWithKeyboard);
            panel.removeEventListener('keydown', stopKeyboard);
            panel.remove();
        },
    };
}
