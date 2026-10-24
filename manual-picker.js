import { blockPlanNode, normalizePlanNodeCount } from './chance.js';

export function normalizeManualLayout(value) {
    const source = value && typeof value === 'object' ? value : {};
    const number = (value, fallback, min, max) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    };
    return {
        columns: number(source.columns, 6, 1, 15),
        fontSize: number(source.fontSize, 13, 10, 22),
        width: number(source.width, 1200, 320, 4000),
        height: number(source.height, 800, 280, 2400),
        order: Array.isArray(source.order) ? [...new Set(source.order.filter(id => typeof id === 'string'))].slice(0, 5000) : [],
    };
}

function availableNames(sections, blockedText) {
    return new Map(sections.flat().filter(node => blockPlanNode([node.name], blockedText)[0] !== ' ')
        .map(node => [node.name.toLocaleLowerCase('ru'), node.name]));
}

function resolveNodeText(value, names, blockedText) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || blockPlanNode([text], blockedText)[0] === ' ') return '';
    return names.get(text.toLocaleLowerCase('ru')) ?? text;
}

export function resolvePreviousPlanNodes(sections, count, previousNodes, blockedText = '') {
    if (!Array.isArray(previousNodes) || previousNodes.length !== normalizePlanNodeCount(count)) return null;
    const names = availableNames(sections, blockedText);
    const nodes = previousNodes.map(node => resolveNodeText(node, names, blockedText));
    return nodes.every(Boolean) ? nodes : null;
}

export function chooseManualPlanNodes(sections, count, options = {}) {
    if (options.signal?.aborted) {
        return Promise.resolve(null);
    }
    const layout = normalizeManualLayout(options.layout);
    const entries = [];
    const occurrences = new Map();
    for (const [sectionIndex, section] of sections.entries()) {
        if (sectionIndex > 0) {
            entries.push({ id: `separator:${sectionIndex}`, separator: true });
        }
        section.forEach((node, index) => {
            const occurrence = occurrences.get(node.name) ?? 0;
            occurrences.set(node.name, occurrence + 1);
            entries.push({ ...node, id: `node:${node.name}:${occurrence}`, stripe: index % 2 });
        });
    }
    const names = availableNames(sections, options.blockedText);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    let ordered = layout.order.filter(id => byId.has(id)).map(id => byId.get(id));
    const known = new Set(ordered.map(entry => entry.id));
    ordered.push(...entries.filter(entry => !known.has(entry.id)));
    const totalWeight = entries.reduce((total, node) => total + (node.weight || 0), 0);
    const canonicalName = value => resolveNodeText(value, names, options.blockedText);
    const color = index => `hsl(${118 - 70 * index / Math.max(1, normalizePlanNodeCount(count) - 1)} 46% 56%)`;

    return new Promise((resolve, reject) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'chance-ext-picker';
        dialog.setAttribute('aria-label', 'Ручной выбор нод');
        dialog.style.width = `${layout.width}px`;
        dialog.style.height = `${layout.height}px`;
        dialog.innerHTML = `
            <div class="chance-ext-picker-slots-row">
                <div class="chance-ext-picker-slots"></div>
                <button type="button" class="chance-ext-picker-repeat">Повтор</button>
                <button type="button" class="chance-ext-picker-skip" title="Продолжить без нод и инструкции плана">Пропуск</button>
                <div class="chance-ext-picker-size-controls">
                    <label>Колонки <input class="chance-ext-picker-columns" type="number" min="1" max="15"></label>
                    <label>Шрифт <input class="chance-ext-picker-font" type="number" min="10" max="22"></label>
                </div>
                <button type="button" class="chance-ext-picker-close" aria-label="Отменить генерацию">×</button>
            </div>
            <div class="chance-ext-picker-toolbar">
                <input class="chance-ext-picker-search" type="search" placeholder="Найти ноду" aria-label="Найти ноду">
                <button type="button" class="chance-ext-picker-left" aria-label="Сдвинуть список влево">←</button>
                <button type="button" class="chance-ext-picker-right" aria-label="Сдвинуть список вправо">→</button>
            </div>
            <div class="chance-ext-picker-catalog"></div>
            <svg class="chance-ext-picker-links" aria-hidden="true"><line /></svg>`;
        const slotsHost = dialog.querySelector('.chance-ext-picker-slots');
        const catalog = dialog.querySelector('.chance-ext-picker-catalog');
        const columnsInput = dialog.querySelector('.chance-ext-picker-columns');
        const fontInput = dialog.querySelector('.chance-ext-picker-font');
        const search = dialog.querySelector('.chance-ext-picker-search');
        const line = dialog.querySelector('line');
        const inputs = [];
        const repeatButton = dialog.querySelector('.chance-ext-picker-repeat');
        const previousNodes = resolvePreviousPlanNodes(sections, count, options.previousNodes, options.blockedText);
        repeatButton.disabled = !previousNodes;
        repeatButton.title = previousNodes
            ? 'Вставить прошлый выбор и сразу продолжить генерацию'
            : 'Нет прошлого выбора с таким количеством доступных нод';
        repeatButton.addEventListener('click', () => {
            if (!previousNodes) return;
            inputs.forEach((input, index) => { input.value = previousNodes[index]; });
            finish([...previousNodes]);
        });
        let activeIndex = 0;
        let settled = false;
        let frame;
        let observer;
        let dragged = null;
        let dropTarget = null;
        let dropAfter = false;
        let slotDragIndex = null;
        const previousFocus = document.activeElement;

        const saveLayout = () => {
            layout.order = ordered.map(entry => entry.id);
            options.onLayoutChange?.({ ...layout, order: [...layout.order] });
        };
        const finish = (nodes, error) => {
            if (settled) return;
            settled = true;
            observer?.disconnect();
            cancelAnimationFrame(frame);
            options.signal?.removeEventListener('abort', onAbort);
            // Only explicit resizing changes saved dimensions; a phone viewport must not overwrite desktop sizes.
            saveLayout();
            dialog.close();
            dialog.remove();
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
            if (error) reject(error);
            else resolve(nodes);
        };
        const onAbort = () => finish(null);
        dialog.querySelector('.chance-ext-picker-skip').addEventListener('click', () => finish({ skipped: true }));

        function paintLink() {
            line.style.display = 'none';
            if (settled) return;
            const input = inputs[activeIndex];
            const name = canonicalName(input.value);
            const target = [...catalog.querySelectorAll('.chance-ext-picker-node')].find(button => button.dataset.name === name);
            if (!name || !target) return;
            const from = input.getBoundingClientRect();
            const to = target.getBoundingClientRect();
            const bounds = dialog.getBoundingClientRect();
            const visible = catalog.getBoundingClientRect();
            if (to.right <= visible.left || to.left >= visible.right) return;
            line.setAttribute('x1', from.left + from.width / 2 - bounds.left);
            line.setAttribute('y1', from.bottom - bounds.top);
            line.setAttribute('x2', to.left + 8 - bounds.left);
            line.setAttribute('y2', to.top + to.height / 2 - bounds.top);
            line.style.display = '';
            line.style.stroke = color(activeIndex);
        }

        function paintSelection() {
            const selected = inputs.map(input => canonicalName(input.value));
            inputs.forEach((input, index) => {
                input.classList.toggle('is-filled', Boolean(selected[index]));
                input.classList.toggle('is-invalid', Boolean(input.value) && !selected[index]);
                input.setAttribute('aria-invalid', Boolean(input.value && !selected[index]));
            });
            catalog.querySelectorAll('.chance-ext-picker-node').forEach(button => {
                const indices = selected.flatMap((name, index) => name && name === button.dataset.name ? [index] : []);
                button.classList.toggle('is-used', indices.length > 0);
                button.classList.toggle('is-active', button.dataset.name === selected[activeIndex]);
                button.querySelector('.chance-ext-picker-badge').textContent = indices.map(index => index + 1).join(',');
                if (indices.length) button.style.setProperty('--node-color', color(indices[0]));
            });
            paintLink();
        }

        function applyNode(name, index = activeIndex) {
            inputs[index].value = name;
            const selected = inputs.map(input => canonicalName(input.value));
            if (selected.every(Boolean)) {
                finish(selected);
                return;
            }
            activeIndex = selected.findIndex((name, next) => next > index && !name);
            if (activeIndex < 0) activeIndex = selected.findIndex(name => !name);
            inputs[activeIndex].focus({ preventScroll: true });
            paintSelection();
        }

        function renderCatalog() {
            if (settled) return;
            const query = search.value.trim().toLocaleLowerCase('ru');
            const items = query ? ordered.filter(node => node.name?.toLocaleLowerCase('ru').includes(query)) : ordered;
            catalog.style.setProperty('--picker-columns', layout.columns);
            catalog.style.setProperty('--picker-font', `${layout.fontSize}px`);
            const rowHeight = layout.fontSize + 5;
            const height = Math.max(rowHeight, catalog.clientHeight - 16);
            const fragment = document.createDocumentFragment();
            let column;
            let usedHeight = height;
            for (const node of items) {
                const itemHeight = node.separator ? Math.max(4, rowHeight / 3) : rowHeight;
                if (usedHeight + itemHeight > height) {
                    column = document.createElement('div');
                    column.className = 'chance-ext-picker-column';
                    fragment.appendChild(column);
                    usedHeight = 0;
                }
                const row = document.createElement('div');
                row.className = node.separator ? 'chance-ext-picker-separator' : 'chance-ext-picker-item';
                row.dataset.id = node.id;
                row.style.height = `${itemHeight}px`;
                const grip = document.createElement('span');
                grip.className = 'chance-ext-picker-grip';
                grip.textContent = '⋮';
                grip.title = 'Перетащить для изменения порядка';
                grip.setAttribute('aria-label', grip.title);
                row.appendChild(grip);
                if (!node.separator) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = `chance-ext-picker-node${node.stripe ? ' is-stripe' : ''}`;
                    button.dataset.name = node.name;
                    button.setAttribute('aria-label', node.name);
                    button.disabled = !names.has(node.name.toLocaleLowerCase('ru'));
                    button.title = `${node.name} (${node.weight})${button.disabled ? ' - запрещена' : ''}`;
                    // Match manual-sort's nonlinear scale so rare nodes still have a visible frequency bar.
                    button.style.setProperty('--heat-fill', totalWeight ? Math.min(1, 3.64 * (node.weight / totalWeight) ** 0.75) : 0);
                    const label = document.createElement('span');
                    label.className = 'chance-ext-picker-node-label';
                    label.textContent = node.name;
                    const badge = document.createElement('span');
                    badge.className = 'chance-ext-picker-badge';
                    button.append(badge, label);
                    button.addEventListener('click', () => applyNode(node.name));
                    row.appendChild(button);
                }
                column.appendChild(row);
                usedHeight += itemHeight;
            }
            catalog.replaceChildren(fragment);
            paintSelection();
        }

        for (let index = 0; index < normalizePlanNodeCount(count); index++) {
            const label = document.createElement('label');
            label.className = 'chance-ext-picker-slot';
            label.style.setProperty('--node-color', color(index));
            const number = document.createElement('span');
            number.textContent = index + 1;
            number.draggable = true;
            number.title = 'Перетащить номер для обмена ячейками';
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = `Нода ${index + 1}`;
            input.setAttribute('aria-label', input.placeholder);
            input.autocomplete = 'off';
            input.spellcheck = false;
            input.title = 'Любой текст ноды. Enter или Tab завершает ввод поля.';
            input.addEventListener('focus', () => {
                activeIndex = index;
                label.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                paintSelection();
            });
            // Typing must not submit the last slot on its first character or on a matching catalog prefix.
            input.addEventListener('input', paintSelection);
            input.addEventListener('blur', event => {
                if (settled || !canonicalName(input.value)) return;
                const selected = inputs.map(input => canonicalName(input.value));
                // Skip, repeat and close must still win when the user leaves a completed text field to click them.
                const control = event.relatedTarget?.closest('button, .chance-ext-picker-toolbar, .chance-ext-picker-size-controls');
                if (selected.every(Boolean)) {
                    if (!control) finish(selected);
                } else if (!event.relatedTarget?.closest('.chance-ext-picker-slot')) {
                    activeIndex = selected.findIndex((name, next) => next > index && !name);
                    if (activeIndex < 0) activeIndex = selected.findIndex(name => !name);
                    paintSelection();
                }
            });
            input.addEventListener('keydown', event => {
                if (event.key !== 'Tab' && event.key !== 'Enter') return;
                const name = canonicalName(input.value);
                if (name) {
                    event.preventDefault();
                    applyNode(name, index);
                }
            });
            number.addEventListener('dragstart', event => {
                slotDragIndex = index;
                event.dataTransfer.setData('text/plain', String(index));
            });
            number.addEventListener('dragend', () => { slotDragIndex = null; });
            label.addEventListener('dragover', event => { if (slotDragIndex !== null) event.preventDefault(); });
            label.addEventListener('drop', event => {
                if (slotDragIndex === null) return;
                event.preventDefault();
                [inputs[index].value, inputs[slotDragIndex].value] = [inputs[slotDragIndex].value, inputs[index].value];
                slotDragIndex = null;
                input.focus();
                paintSelection();
            });
            label.append(number, input);
            slotsHost.appendChild(label);
            inputs.push(input);
        }

        columnsInput.value = layout.columns;
        fontInput.value = layout.fontSize;
        columnsInput.addEventListener('change', () => {
            layout.columns = normalizeManualLayout({ columns: columnsInput.value }).columns;
            columnsInput.value = layout.columns;
            saveLayout();
            renderCatalog();
        });
        fontInput.addEventListener('change', () => {
            layout.fontSize = normalizeManualLayout({ fontSize: fontInput.value }).fontSize;
            fontInput.value = layout.fontSize;
            saveLayout();
            renderCatalog();
        });
        search.addEventListener('input', () => { catalog.scrollLeft = 0; renderCatalog(); });
        const shiftCatalog = direction => {
            const columnWidth = catalog.querySelector('.chance-ext-picker-column')?.getBoundingClientRect().width ?? catalog.clientWidth;
            catalog.scrollBy({ left: direction * (columnWidth + 8), behavior: 'smooth' });
        };
        dialog.querySelector('.chance-ext-picker-left').addEventListener('click', () => shiftCatalog(-1));
        dialog.querySelector('.chance-ext-picker-right').addEventListener('click', () => shiftCatalog(1));
        catalog.addEventListener('scroll', paintLink);
        catalog.addEventListener('wheel', event => {
            if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || catalog.scrollWidth <= catalog.clientWidth) return;
            event.preventDefault();
            catalog.scrollLeft += event.deltaY;
        }, { passive: false });

        catalog.addEventListener('pointerdown', event => {
            const grip = event.target.closest('.chance-ext-picker-grip');
            if (!grip || event.button !== 0) return;
            dragged = grip.parentElement.dataset.id;
            grip.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        catalog.addEventListener('pointermove', event => {
            if (!dragged) return;
            catalog.querySelector('.is-drop-target')?.classList.remove('is-drop-target');
            const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-id]');
            dropTarget = row && catalog.contains(row) ? row.dataset.id : null;
            dropAfter = row ? event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 : false;
            row?.classList.add('is-drop-target');
            const bounds = catalog.getBoundingClientRect();
            if (event.clientX > bounds.right - 30) catalog.scrollLeft += 20;
            if (event.clientX < bounds.left + 30) catalog.scrollLeft -= 20;
        });
        catalog.addEventListener('pointerup', () => {
            if (!dragged) return;
            if (dragged && dropTarget && dragged !== dropTarget) {
                const moved = ordered.find(entry => entry.id === dragged);
                ordered = ordered.filter(entry => entry.id !== dragged);
                const index = ordered.findIndex(entry => entry.id === dropTarget) + Number(dropAfter);
                ordered.splice(index, 0, moved);
                saveLayout();
            }
            dragged = dropTarget = null;
            renderCatalog();
        });
        catalog.addEventListener('pointercancel', () => {
            dragged = dropTarget = null;
            catalog.querySelector('.is-drop-target')?.classList.remove('is-drop-target');
        });
        dialog.querySelector('.chance-ext-picker-close').addEventListener('click', () => finish(null));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        dialog.addEventListener('close', () => finish(null));
        // Keep SillyTavern's Enter/swipe shortcuts from starting another turn while the picker owns focus.
        dialog.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key === 'Enter' && event.target.closest('.chance-ext-picker-slot')) event.preventDefault();
        });
        options.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            document.body.appendChild(dialog);
            dialog.showModal();
            renderCatalog();
            inputs[0].focus();
            let lastWidth = dialog.offsetWidth;
            let lastHeight = dialog.offsetHeight;
            observer = new ResizeObserver(() => {
                if (dialog.offsetWidth !== lastWidth || dialog.offsetHeight !== lastHeight) {
                    lastWidth = dialog.offsetWidth;
                    lastHeight = dialog.offsetHeight;
                    // Inline sizes change only when the user drags the native resize handle.
                    const width = Number.parseInt(dialog.style.width, 10);
                    const height = Number.parseInt(dialog.style.height, 10);
                    if (width !== layout.width || height !== layout.height) {
                        layout.width = width;
                        layout.height = height;
                        saveLayout();
                    }
                }
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(renderCatalog);
            });
            observer.observe(catalog);
        } catch (error) {
            finish(null, error);
        }
    });
}
