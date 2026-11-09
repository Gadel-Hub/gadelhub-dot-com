import { validId, completeness } from './editor.js';
import {
    eventFields as fields,
    eventDirty as isDirty,
    validEventFields,
    validEventDate,
    sortEvents,
    eventState,
} from './event-fields.js';

export function mountEventsEditor(
    doc,
    fetcher = fetch,
    confirmDiscard = (message) => window.confirm(message),
) {
    const get = (id) => doc.getElementById(id);
    const form = get('event-form');
    const state = {
        event: null,
        events: [],
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
        date: get('event-date').value,
        location: get('event-location').value,
        archived: get('archived').checked,
        title: { tr: inputs['title-tr'].value, en: inputs['title-en'].value },
        description: { tr: inputs['description-tr'].value, en: inputs['description-en'].value },
    });
    const dirty = () => Boolean(state.event) && (state.creating || isDirty(state.event, draft()));
    const publishable = () =>
        !state.busy &&
        !state.needsReload &&
        validEventFields(draft()) &&
        (state.creating
            ? validId(draft().id) && !state.events.some((event) => event.id === draft().id)
            : isDirty(state.event, draft()));
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
        const nodes = sortEvents(state.events).map((event) => {
            const selected = !state.creating && state.event?.id === event.id;
            const value = selected ? { ...event, ...draft() } : event;
            const button = element('button', 'record-row');
            button.type = 'button';
            button.dataset.id = event.id;
            button.disabled = state.busy;
            if (selected) button.setAttribute('aria-current', 'true');
            button.append(
                element('strong', '', value.title.en || value.title.tr || 'Untitled event'),
                element('code', '', event.id),
                element('time', '', value.date),
                element('small', '', value.location),
                element(
                    'small',
                    '',
                    value.external?.source_name
                        ? `External: ${value.external.source_name}`
                        : 'Community event',
                ),
                element(
                    'small',
                    'row-state',
                    `${eventState(value)}${selected && dirty() ? ' · Modified' : ''}`,
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
            button.addEventListener('click', () => load(event.id, true));
            return button;
        });
        if (!nodes.length)
            nodes.push(
                element('p', '', 'No events yet. Create a bilingual record to get started.'),
            );
        get('event-list').replaceChildren(...nodes);
        get('event-count').textContent = `${state.events.length} records`;
    }
    function sync() {
        const value = draft();
        get('edit-fields').disabled = state.busy || !state.event;
        get('reload').disabled = state.busy;
        get('new-event').disabled = state.busy || !state.sha || state.needsReload;
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
                  ? 'New event · not published'
                  : 'Unsaved changes'
              : 'No unsaved changes';
        get('editor-title').textContent = state.creating ? 'New event' : 'Edit event';
        get('event-id').textContent = state.creating
            ? 'Assigned on first publish'
            : state.event?.id || '—';
        get('event-visibility').textContent = state.event ? eventState(value) : '—';
        get('event-source').textContent = state.event?.external?.source_name || 'Community event';
        get('date-summary').textContent = value.date || 'No date entered';
        get('date-error').textContent =
            value.date && !validEventDate(value.date)
                ? 'Enter a real date/time with an explicit timezone.'
                : '';
        get('event-date').setAttribute(
            'aria-invalid',
            String(Boolean(value.date) && !validEventDate(value.date)),
        );
        get('stable-id').readOnly = !state.creating;
        get('id-note').textContent = state.creating
            ? 'Unique kebab-case slug. It becomes immutable after creation.'
            : 'Immutable stable ID. Existing links and metadata keep this identity.';
        get('id-error').textContent =
            state.creating && state.events.some((p) => p.id === value.id)
                ? 'This ID is already in use.'
                : '';
        get('mock-conflict').hidden = state.mode !== 'mock';
        get('mock-conflict').disabled = state.busy || !dirty() || state.needsReload;
        list();
        const previews = get('preview-cards');
        previews.replaceChildren();
        if (!state.event) return;
        for (const lang of ['tr', 'en']) {
            const section = element('section', 'event-preview');
            section.lang = lang;
            section.append(element('h3', '', lang === 'tr' ? 'TR / ETKİNLİK' : 'EN / EVENT'));
            const card = element('div', 'event-preview-content');
            const time = element('time', '', value.date || '—');
            if (validEventDate(value.date)) time.dateTime = value.date;
            card.append(
                time,
                element('h4', '', value.title[lang] || '—'),
                element('p', 'event-location', value.location || '—'),
                element('p', '', value.description[lang] || '—'),
            );
            const attribution = state.event.external?.attribution;
            if (attribution) card.append(sourceLink(attribution.url, attribution.label));
            section.append(
                card,
                element(
                    'p',
                    'preview-visibility',
                    value.archived
                        ? lang === 'tr'
                            ? 'Arşivlenmiş / herkese açık modülde gizli.'
                            : 'Archived / hidden from the public module.'
                        : lang === 'tr'
                          ? 'Herkese açık / kaynak sıralaması korunur.'
                          : 'Public / source ordering is preserved.',
                ),
            );
            previews.append(section);
        }
    }
    function sourceLink(url, label) {
        const node = element('a', 'source-link', label);
        try {
            if (new URL(url).protocol === 'https:') node.href = url;
        } catch {
            /* Read-only malformed URLs never become links. */
        }
        return node;
    }
    function provenance() {
        const container = get('event-provenance');
        container.replaceChildren();
        const external = state.event?.external;
        if (!external) {
            container.append(element('p', '', 'Community event. No external provenance attached.'));
            return;
        }
        container.append(
            element('p', '', `${external.source_name} / ${external.source_id}`),
            element('p', '', `Candidate: ${external.candidate_id}`),
            sourceLink(external.source_url, external.source_url),
        );
        if (external.attribution)
            container.append(
                element(
                    'p',
                    '',
                    external.attribution.active_link_required
                        ? 'Active attribution link required.'
                        : 'Attribution retained.',
                ),
                sourceLink(external.attribution.url, external.attribution.label),
            );
        const details = element('details');
        details.append(
            element('summary', '', 'Full provenance (read-only)'),
            element('pre', '', JSON.stringify(external, null, 2)),
        );
        container.append(details);
    }
    function fill() {
        for (const field of ['title', 'description'])
            for (const lang of ['tr', 'en'])
                inputs[`${field}-${lang}`].value = state.event[field][lang];
        get('stable-id').value = state.event.id;
        get('event-date').value = state.event.date;
        get('event-location').value = state.event.location;
        get('archived').checked = state.event.archived ?? false;
        provenance();
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
            const listing = await api('/api/events');
            state.events = listing.events;
            state.mode = listing.mode;
            const selected =
                id ||
                (!state.creating && state.event?.id) ||
                sortEvents(listing.events)[0]?.id ||
                listing.events[0]?.id;
            const result = selected
                ? await api(`/api/events/${encodeURIComponent(selected)}`)
                : listing;
            state.sha = result.sha;
            state.needsReload = false;
            state.creating = false;
            state.event = result.event || null;
            get('mode').textContent =
                result.mode === 'mock' ? 'Local mock / no GitHub writes' : 'GitHub source';
            get('mock-banner').hidden = result.mode !== 'mock';
            get('editor').hidden = !state.event;
            if (state.event) fill();
            status(
                state.event
                    ? 'Event loaded. Review both languages, date, location and visibility before publishing.'
                    : 'No events yet. Select New event to begin.',
            );
        } catch (error) {
            state.needsReload = true;
            status(error.message || 'Unable to load. Please reload.', true);
        } finally {
            state.busy = false;
            sync();
        }
        if (focus && state.event) {
            get('editor-title').focus?.();
        }
    }
    function newEvent() {
        if (
            state.busy ||
            !state.sha ||
            state.needsReload ||
            (dirty() && !confirmDiscard('Discard unsaved edits and start a new event?'))
        )
            return;
        state.creating = true;
        state.event = {
            id: '',
            date: '',
            location: '',
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
    get('new-event').addEventListener('click', newEvent);
    get('discard').addEventListener('click', () => {
        if (state.busy || !dirty()) return;
        if (state.creating) {
            state.creating = false;
            state.event = null;
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
                creating ? '/api/events' : `/api/events/${encodeURIComponent(state.event.id)}`,
                {
                    method: creating ? 'POST' : 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(edit),
                },
            );
            state.event = result.event;
            state.sha = result.sha;
            state.creating = false;
            const index = state.events.findIndex((p) => p.id === result.event.id);
            if (index < 0) state.events.push(result.event);
            else state.events[index] = result.event;
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
    const editor = mountEventsEditor(document);
    window.addEventListener('beforeunload', (event) => {
        if (editor.dirty() || editor.state.busy) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
}
