import { createFloatingPanel } from './floating-panel.js';

export { normalizeNodePanelPosition, normalizeNodePanelSize } from './floating-panel.js';

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
    const floating = createFloatingPanel({ panel, handle, position, size, onPositionChange, onSizeChange });
    button.addEventListener('click', () => { void onGenerate(); });

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
            floating.update();
        },
        destroy() {
            floating.destroy();
        },
    };
}
