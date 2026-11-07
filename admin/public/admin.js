import { fields, isDirty, canPublish } from './editor.js';

const domainLabels = {
    'electronics-embedded': { tr: 'Elektronik & gömülü', en: 'Electronics & embedded' },
    'game-development': { tr: 'Oyun geliştirme', en: 'Game development' },
};

export function mountEditor(
    doc,
    fetcher = fetch,
    confirmDiscard = (message) => window.confirm(message),
) {
    const get = (id) => doc.getElementById(id);
    const form = get('project-form');
    const state = { project: null, sha: null, busy: false, needsReload: false, mode: null };
    const inputs = {};
    for (const field of ['title', 'description'])
        for (const lang of ['tr', 'en']) inputs[`${field}-${lang}`] = get(`${field}-${lang}`);
    const draft = () => ({
        title: { tr: inputs['title-tr'].value, en: inputs['title-en'].value },
        description: { tr: inputs['description-tr'].value, en: inputs['description-en'].value },
    });
    const dirty = () => state.project && isDirty(state.project, draft());
    function status(message, error = false) {
        get('status').textContent = message;
        get('status').dataset.error = String(error);
    }
    function element(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function sync() {
        const value = draft();
        get('edit-fields').disabled = state.busy || !state.project;
        get('reload').disabled = state.busy;
        get('discard').disabled = state.busy || !dirty();
        get('publish').disabled = !canPublish(state.project, value, state.busy, state.needsReload);
        get('publish').textContent = state.busy
            ? 'Please wait…'
            : state.mode === 'mock'
              ? 'Simulate publish →'
              : 'Publish to GitHub →';
        get('dirty-state').textContent = state.needsReload
            ? 'Reload required before publishing'
            : dirty()
              ? 'Unsaved changes'
              : 'No unsaved changes';
        for (const button of get('project-list').querySelectorAll('button'))
            button.disabled = state.busy;
        const previews = get('preview-cards');
        previews.replaceChildren();
        if (!state.project) return;
        for (const lang of ['tr', 'en']) {
            const label = domainLabels[state.project.domain][lang];
            const section = element('section', 'project-domain');
            section.lang = lang;
            section.dataset.domain = state.project.domain;
            section.append(element('h3', '', `${lang.toUpperCase()} / ${label}`));
            const card = element('div', 'project-card');
            const icon = element('img', 'project-symbol');
            icon.src = '/chip.svg';
            icon.alt = '';
            const copy = element('div');
            copy.append(
                element('span', 'badge', label),
                element('h4', '', value.title[lang]),
                element('p', '', value.description[lang]),
            );
            card.append(icon, copy);
            section.append(card);
            previews.append(section);
        }
    }
    function fill() {
        for (const field of ['title', 'description'])
            for (const lang of ['tr', 'en'])
                inputs[`${field}-${lang}`].value = state.project[field][lang];
    }
    async function api(path, options = {}) {
        const response = await fetcher(path, {
            credentials: 'same-origin',
            cache: 'no-store',
            ...options,
        });
        let body;
        try {
            body = await response.json();
        } catch {
            throw Object.assign(
                new Error(
                    'Unable to read the response. Your Access session may have expired. Reload to continue.',
                ),
                { reload: true },
            );
        }
        if (!response.ok)
            throw Object.assign(
                new Error(body.error?.message || 'Request failed. Reload before continuing.'),
                { reload: response.status === 409 || response.status >= 500 },
            );
        return body;
    }
    async function load(id) {
        if (
            state.busy ||
            (dirty() && !confirmDiscard('Discard unsaved edits and reload repository content?'))
        )
            return;
        state.busy = true;
        sync();
        status('Loading repository content…');
        try {
            if (!id) {
                const listing = await api('/api/projects');
                get('project-list').replaceChildren();
                for (const project of listing.projects) {
                    const button = element('button', '', project.title.en);
                    button.type = 'button';
                    button.dataset.id = project.id;
                    button.addEventListener('click', () => load(project.id));
                    get('project-list').append(button);
                }
                id = state.project?.id || listing.projects[0]?.id;
                if (!id) {
                    status('No verified projects are available.');
                    return;
                }
            }
            const result = await api(`/api/projects/${encodeURIComponent(id)}`);
            state.project = result.project;
            state.sha = result.sha;
            state.mode = result.mode;
            state.needsReload = false;
            get('mode').textContent =
                result.mode === 'mock' ? 'Local mock / no GitHub writes' : 'GitHub source';
            get('mock-banner').hidden = result.mode !== 'mock';
            get('project-id').textContent = result.project.id;
            get('project-domain').textContent = result.project.domain;
            for (const button of get('project-list').querySelectorAll('button')) {
                if (button.dataset.id === id) button.setAttribute('aria-current', 'true');
                else button.removeAttribute('aria-current');
            }
            get('editor').hidden = false;
            fill();
            status(
                'Project loaded. Edit either language and review both previews before publishing.',
            );
        } catch (error) {
            state.needsReload = true;
            status(error.message || 'Unable to load. Please reload.', true);
        } finally {
            state.busy = false;
            sync();
        }
    }
    form.addEventListener('input', sync);
    get('discard').addEventListener('click', () => {
        if (state.busy || !dirty()) return;
        fill();
        sync();
        status(
            state.needsReload
                ? 'Edits discarded. Reload source before publishing.'
                : 'Local edits discarded. Nothing was published.',
        );
    });
    get('reload').addEventListener('click', () => load());
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (
            !form.reportValidity() ||
            !canPublish(state.project, draft(), state.busy, state.needsReload)
        )
            return;
        const edit = { sha: state.sha, ...fields(draft()) };
        state.busy = true;
        sync();
        status(
            state.mode === 'mock' ? 'Simulating publish…' : 'Publishing source content to GitHub…',
        );
        try {
            const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(edit),
            });
            state.project = result.project;
            state.sha = result.sha;
            fill();
            for (const button of get('project-list').querySelectorAll('button')) {
                if (button.dataset.id === state.project.id)
                    button.textContent = state.project.title.en;
            }
            status(
                result.mode === 'mock'
                    ? 'Mock publish complete. No GitHub commit was created. Reload restores the sample.'
                    : result.unchanged
                      ? 'Repository already contains these values. No commit was needed.'
                      : `Published source commit ${result.commitSha}. The public site updates after deployment.`,
            );
        } catch (error) {
            state.needsReload = error.reload !== false;
            status(
                error.message ||
                    'Publish result could not be confirmed. Reload before trying again.',
                true,
            );
        } finally {
            state.busy = false;
            sync();
        }
    });
    const ready = load();
    return { state, ready, dirty, sync };
}

if (typeof document !== 'undefined') {
    const editor = mountEditor(document);
    window.addEventListener('beforeunload', (event) => {
        if (editor.dirty() || editor.state.busy) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
}
