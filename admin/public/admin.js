import { fields, isDirty, canPublish, completeness, visibility } from './editor.js';

const domainLabels = {
    'electronics-embedded': { tr: 'Elektronik / gömülü', en: 'Electronics / embedded' },
    'game-development': { tr: 'Oyun geliştirme', en: 'Game development' },
};

export function mountEditor(
    doc,
    fetcher = fetch,
    confirmDiscard = (message) => window.confirm(message),
) {
    const get = (id) => doc.getElementById(id);
    const form = get('project-form');
    const state = {
        project: null,
        projects: [],
        sha: null,
        busy: false,
        needsReload: false,
        mode: null,
        creating: false,
    };
    const inputs = {};
    for (const field of ['title', 'description'])
        for (const lang of ['tr', 'en']) inputs[`${field}-${lang}`] = get(`${field}-${lang}`);
    const draft = () => ({
        id: get('stable-id').value,
        domain: get('domain').value,
        verified: get('verified').checked,
        archived: get('archived').checked,
        title: { tr: inputs['title-tr'].value, en: inputs['title-en'].value },
        description: { tr: inputs['description-tr'].value, en: inputs['description-en'].value },
    });
    const dirty = () =>
        Boolean(state.project) && (state.creating || isDirty(state.project, draft()));
    const publishable = () =>
        canPublish(state.project, draft(), state.busy, state.needsReload, state.creating) &&
        (!state.creating || !state.projects.some((p) => p.id === draft().id));
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
    function list() {
        const nodes = state.projects.map((project) => {
            const selected = !state.creating && state.project?.id === project.id;
            const value = selected ? { ...project, ...draft() } : project;
            const button = element('button', 'project-row');
            button.type = 'button';
            button.dataset.id = project.id;
            button.disabled = state.busy;
            if (selected) button.setAttribute('aria-current', 'true');
            button.append(
                element('strong', '', value.title.en || value.title.tr || 'Untitled project'),
                element('code', '', project.id),
                element('small', '', domainLabels[value.domain]?.en || value.domain),
                element(
                    'small',
                    'row-state',
                    `${visibility(value)}${selected && dirty() ? ' · Modified' : ''}`,
                ),
                element(
                    'small',
                    '',
                    ['tr', 'en']
                        .map(
                            (lang) =>
                                `${lang.toUpperCase()} ${completeness(value, lang) ? '✓' : 'incomplete'}`,
                        )
                        .join(' / '),
                ),
            );
            button.addEventListener('click', () => load(project.id, true));
            return button;
        });
        if (!nodes.length)
            nodes.push(
                element('p', '', 'No projects yet. Create a bilingual record to get started.'),
            );
        get('project-list').replaceChildren(...nodes);
        get('project-count').textContent = `${state.projects.length} records`;
    }
    function sync() {
        const value = draft();
        get('edit-fields').disabled = state.busy || !state.project;
        get('reload').disabled = state.busy;
        get('new-project').disabled = state.busy || !state.sha || state.needsReload;
        get('discard').disabled = state.busy || !dirty();
        get('publish').disabled = !publishable();
        get('publish').textContent = state.busy
            ? 'Please wait…'
            : state.mode === 'mock'
              ? 'Simulate publish →'
              : state.creating
                ? 'Create on GitHub →'
                : 'Publish to GitHub →';
        get('dirty-state').textContent = state.needsReload
            ? 'Reload required before publishing'
            : dirty()
              ? state.creating
                  ? 'New project · not published'
                  : 'Unsaved changes'
              : 'No unsaved changes';
        get('editor-title').textContent = state.creating ? 'New project' : 'Edit project';
        get('project-id').textContent = state.creating
            ? 'Assigned on first publish'
            : state.project?.id || '—';
        get('project-domain').textContent = value.domain || '—';
        get('project-symbol').textContent = state.creating
            ? 'Assigned from domain on creation'
            : state.project?.symbol || '—';
        get('project-visibility').textContent = state.project ? visibility(value) : '—';
        get('stable-id').readOnly = !state.creating;
        get('id-note').textContent = state.creating
            ? 'Unique kebab-case slug. It becomes immutable after creation.'
            : 'Immutable stable ID. Existing links and metadata keep this identity.';
        get('id-error').textContent =
            state.creating && state.projects.some((p) => p.id === value.id)
                ? 'This ID is already in use.'
                : '';
        get('mock-conflict').hidden = state.mode !== 'mock';
        get('mock-conflict').disabled = state.busy || !dirty() || state.needsReload;
        list();
        const previews = get('preview-cards');
        previews.replaceChildren();
        if (!state.project) return;
        for (const lang of ['tr', 'en']) {
            const label = domainLabels[value.domain]?.[lang] || 'Choose a domain';
            const section = element('section', 'project-domain');
            section.lang = lang;
            section.dataset.domain = value.domain;
            section.append(element('h3', '', `${lang.toUpperCase()} / ${label}`));
            const card = element('div', 'project-card');
            const icon = element('img', 'project-symbol');
            icon.src = value.domain === 'game-development' ? '/gamepad.svg' : '/chip.svg';
            icon.alt = '';
            const copy = element('div');
            copy.append(
                element('span', 'badge', label),
                element('h4', '', value.title[lang] || '—'),
                element('p', '', value.description[lang] || '—'),
            );
            card.append(icon, copy);
            section.append(
                card,
                element(
                    'p',
                    'preview-visibility',
                    lang === 'tr'
                        ? value.archived
                            ? 'Arşivlenmiş: herkese açık listelerde gizli.'
                            : value.verified
                              ? 'Doğrulanmış: Projeler sayfasında yayımlanır.'
                              : 'Doğrulanmamış: yalnızca ana sayfa alan dizininde; Projeler sayfasında gizli.'
                        : `${visibility(value)}. ${value.archived ? 'Hidden from public listings.' : value.verified ? 'Shown on the Projects page.' : 'Homepage directory only; hidden on the Projects page.'}`,
                ),
            );
            previews.append(section);
        }
    }
    function fill() {
        for (const field of ['title', 'description'])
            for (const lang of ['tr', 'en'])
                inputs[`${field}-${lang}`].value = state.project[field][lang];
        get('stable-id').value = state.project.id;
        get('domain').value = state.project.domain;
        get('verified').checked = state.project.verified;
        get('archived').checked = state.project.archived ?? false;
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
    async function load(id, focus = false) {
        if (
            state.busy ||
            (dirty() && !confirmDiscard('Discard unsaved edits and reload repository content?'))
        )
            return;
        state.busy = true;
        sync();
        status('Loading repository content…');
        try {
            const listing = await api('/api/projects');
            state.projects = listing.projects;
            state.mode = listing.mode;
            const selected =
                id ||
                (!state.creating && state.project?.id) ||
                listing.projects.find((p) => p.verified && !p.archived)?.id ||
                listing.projects[0]?.id;
            const result = selected
                ? await api(`/api/projects/${encodeURIComponent(selected)}`)
                : listing;
            state.sha = result.sha;
            state.needsReload = false;
            state.creating = false;
            state.project = result.project || null;
            get('mode').textContent =
                result.mode === 'mock' ? 'Local mock / no GitHub writes' : 'GitHub source';
            get('mock-banner').hidden = result.mode !== 'mock';
            get('editor').hidden = !state.project;
            if (state.project) fill();
            status(
                state.project
                    ? 'Project loaded. Review both languages and visibility before publishing.'
                    : 'No projects yet. Select New project to begin.',
            );
        } catch (error) {
            state.needsReload = true;
            status(error.message || 'Unable to load. Please reload.', true);
        } finally {
            state.busy = false;
            sync();
        }
        if (focus && state.project) {
            get('editor-title').focus?.();
        }
    }
    function newProject() {
        if (
            state.busy ||
            !state.sha ||
            state.needsReload ||
            (dirty() && !confirmDiscard('Discard unsaved edits and start a new project?'))
        )
            return;
        state.creating = true;
        state.project = {
            id: '',
            domain: 'game-development',
            verified: false,
            archived: true,
            title: { tr: '', en: '' },
            description: { tr: '', en: '' },
        };
        get('editor').hidden = false;
        fill();
        sync();
        status(
            'New local draft. Complete both languages, review visibility and previews, then explicitly publish.',
        );
        get('stable-id').focus?.();
    }
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    get('new-project').addEventListener('click', newProject);
    get('discard').addEventListener('click', () => {
        if (state.busy || !dirty()) return;
        if (state.creating) {
            state.creating = false;
            state.project = null;
            get('editor').hidden = true;
        } else fill();
        sync();
        status(
            state.needsReload
                ? 'Edits discarded. Reload source before publishing.'
                : 'Local edits discarded. Nothing was published.',
        );
    });
    get('reload').addEventListener('click', () => load());
    get('mock-conflict').addEventListener('click', () => {
        if (state.mode !== 'mock' || state.busy || !dirty() || state.needsReload) return;
        state.sha = 'f'.repeat(40);
        status(
            'Mock stale SHA armed. Simulate publish to test conflict handling; your draft will be retained.',
        );
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!form.reportValidity() || !publishable()) return;
        const creating = state.creating;
        const edit = {
            sha: state.sha,
            ...fields(draft()),
            ...(creating ? { id: draft().id } : {}),
        };
        state.busy = true;
        sync();
        status(
            state.mode === 'mock' ? 'Simulating publish…' : 'Publishing source content to GitHub…',
        );
        try {
            const result = await api(
                creating
                    ? '/api/projects'
                    : `/api/projects/${encodeURIComponent(state.project.id)}`,
                {
                    method: creating ? 'POST' : 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(edit),
                },
            );
            state.project = result.project;
            state.sha = result.sha;
            state.creating = false;
            const index = state.projects.findIndex((p) => p.id === result.project.id);
            if (index < 0) state.projects.push(result.project);
            else state.projects[index] = result.project;
            fill();
            status(
                result.mode === 'mock'
                    ? 'Mock publish complete. No GitHub commit was created. Changes live only in this local Worker session.'
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
