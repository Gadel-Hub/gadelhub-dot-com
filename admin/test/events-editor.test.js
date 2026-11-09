import test from 'node:test';
import assert from 'node:assert/strict';
import { mountEventsEditor } from '../public/events.js';
import { createWorker } from '../src/worker.js';

class Element {
    constructor(tag = 'div') {
        this.tag = tag;
        this.value = '';
        this.dataset = {};
        this.children = [];
        this.listeners = new Map();
        this.attributes = {};
        this.disabled = false;
        this.hidden = false;
    }
    append(...children) {
        this.children.push(...children);
    }
    replaceChildren(...children) {
        this.children = children;
    }
    setAttribute(k, v) {
        this.attributes[k] = v;
    }
    removeAttribute(k) {
        delete this.attributes[k];
    }
    addEventListener(k, v) {
        this.listeners.set(k, v);
    }
    querySelectorAll(tag) {
        return this.children.flatMap((c) => [
            ...(c.tag === tag ? [c] : []),
            ...c.querySelectorAll(tag),
        ]);
    }
    reportValidity() {
        return true;
    }
    async emit(type) {
        await this.listeners.get(type)?.({ preventDefault() {} });
    }
}
function setup(fetchOverride, confirm = () => true) {
    const elements = new Map(),
        doc = {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, new Element());
                return elements.get(id);
            },
            createElement(tag) {
                return new Element(tag);
            },
        };
    const worker = createWorker(() => {
        throw new Error('No GitHub');
    });
    const local = (path, options = {}) =>
        worker.fetch(
            new Request(`http://localhost${path}`, {
                ...options,
                headers: { Origin: 'http://localhost', ...options.headers },
            }),
            { MOCK_MODE: 'true' },
        );
    const editor = mountEventsEditor(doc, fetchOverride ? fetchOverride(local) : local, confirm);
    return { editor, get: (id) => doc.getElementById(id) };
}
async function draft(get) {
    await get('new-event').emit('click');
    get('stable-id').value = 'local-test-event';
    get('event-date').value = '2028-02-29T16:00:00+05:30';
    get('event-location').value = 'GTÜ / Online';
    get('title-tr').value = 'Etkinlik';
    get('title-en').value = '<script>text only</script>';
    get('description-tr').value = 'Açıklama';
    get('description-en').value = 'Description';
    await get('event-form').emit('input');
}
function text(node) {
    return (node.textContent || '') + node.children.map(text).join(' ');
}

test('empty Events index creates a hidden bilingual draft; date/location and safe preview validation work', async () => {
    const { editor, get } = setup();
    await editor.ready;
    assert.equal(editor.state.event, null);
    assert.equal(get('new-event').disabled, false);
    await draft(get);
    assert.equal(get('archived').checked, true);
    assert.equal(get('publish').disabled, false);
    assert(text(get('preview-cards')).includes('<script>text only</script>'));
    assert.equal(get('preview-cards').querySelectorAll('script').length, 0);
    get('event-date').value = '2028-02-30T16:00:00Z';
    await get('event-form').emit('input');
    assert.equal(get('publish').disabled, true);
    assert(get('date-error').textContent);
    get('event-date').value = '2028-02-29T16:00:00+05:30';
    get('event-location').value = ' ';
    await get('event-form').emit('input');
    assert.equal(get('publish').disabled, true);
});

test('event create, bilingual edit, discard, archive/restore and reload preserve serialized date', async () => {
    const { editor, get } = setup();
    await editor.ready;
    await draft(get);
    await get('event-form').emit('submit');
    assert.equal(editor.state.creating, false);
    assert.equal(get('stable-id').readOnly, true);
    assert.equal(editor.state.event.archived, true);
    get('archived').checked = false;
    get('event-date').value = '2028-03-01T12:00:00-04:00';
    await get('event-form').emit('change');
    await get('event-form').emit('submit');
    assert.equal(editor.state.event.archived, false);
    await get('reload').emit('click');
    assert.equal(get('event-date').value, '2028-03-01T12:00:00-04:00');
    get('title-en').value = 'Discard this';
    await get('event-form').emit('input');
    await get('discard').emit('click');
    assert.equal(get('title-en').value, '<script>text only</script>');
    get('archived').checked = true;
    await get('event-form').emit('change');
    await get('event-form').emit('submit');
    assert.equal(editor.state.event.archived, true);
});

test('stale event publish retains draft, blocks retry and supports explicit discard/reload', async () => {
    const { editor, get } = setup();
    await editor.ready;
    await draft(get);
    await get('mock-conflict').emit('click');
    await get('event-form').emit('submit');
    assert(editor.state.needsReload);
    assert(editor.state.creating);
    assert.equal(get('publish').disabled, true);
    assert.equal(get('stable-id').value, 'local-test-event');
    await get('discard').emit('click');
    await get('reload').emit('click');
    assert.equal(editor.state.needsReload, false);
});

test('event double submit is blocked while a publish is pending', async () => {
    let release,
        writes = 0;
    const { editor, get } = setup(
        (local) => (path, options) =>
            options.method === 'POST'
                ? (writes++,
                  new Promise((resolve) => {
                      release = () => resolve(local(path, options));
                  }))
                : local(path, options),
    );
    await editor.ready;
    await draft(get);
    const pending = get('event-form').emit('submit');
    await get('event-form').emit('submit');
    assert.equal(writes, 1);
    assert.equal(get('edit-fields').disabled, true);
    release();
    await pending;
    assert.equal(get('edit-fields').disabled, false);
});

test('provenance is displayed read-only and never included in ordinary event writes', async () => {
    const external = {
        candidate_id: 'test:jam',
        source_name: 'Source',
        source_id: 'jam',
        source_url: 'https://example.org/jam',
        attribution: { label: 'Credit', url: 'https://example.org/', active_link_required: true },
        extra_metadata: { keep: 'all' },
    };
    const event = {
        id: 'promoted-event',
        date: '2028-01-01T12:00:00Z',
        location: 'Online',
        archived: false,
        title: { tr: 'TR', en: 'EN' },
        description: { tr: 'TR', en: 'EN' },
        external,
    };
    let sent;
    const { editor, get } = setup(() => async (path, options) => {
        if (options.method === 'PUT') {
            sent = JSON.parse(options.body);
            return Response.json({
                mode: 'mock',
                sha: 'b'.repeat(40),
                event: { ...event, ...sent },
            });
        }
        return Response.json({
            mode: 'mock',
            sha: 'a'.repeat(40),
            ...(path === '/api/events' ? { events: [event] } : { event }),
        });
    });
    await editor.ready;
    assert(text(get('event-provenance')).includes('test:jam'));
    assert(text(get('event-provenance')).includes('Credit'));
    assert(text(get('event-provenance')).includes('extra_metadata'));
    assert.equal(get('event-provenance').querySelectorAll('input').length, 0);
    get('title-en').value = 'Updated';
    await get('event-form').emit('input');
    await get('event-form').emit('submit');
    assert(!Object.hasOwn(sent, 'external'));
});
