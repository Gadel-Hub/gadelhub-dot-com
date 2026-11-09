import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountEditor } from '../public/admin.js';
import { fields, isDirty, validFields, canPublish } from '../public/editor.js';
import { mockProject } from '../src/mock-project.js';
import { createWorker } from '../src/worker.js';

// Small DOM adapter exercises the real event handlers without a browser dependency.
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
    setAttribute(key, value) {
        this.attributes[key] = value;
    }
    removeAttribute(key) {
        delete this.attributes[key];
    }
    addEventListener(type, handler) {
        this.listeners.set(type, handler);
    }
    querySelectorAll(tag) {
        return this.children.flatMap((child) => [
            ...(child.tag === tag ? [child] : []),
            ...child.querySelectorAll(tag),
        ]);
    }
    reportValidity() {
        return true;
    }
    async emit(type) {
        await this.listeners.get(type)?.({ preventDefault() {} });
    }
}
function documentStub() {
    const elements = new Map();
    return {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement(tag) {
            return new Element(tag);
        },
    };
}
let mockWorker;
beforeEach(() => {
    mockWorker = createWorker(async () => {
        throw new Error('No GitHub calls permitted');
    });
});
const localFetch = (path, options = {}) =>
    mockWorker.fetch(
        new Request(`http://localhost${path}`, {
            ...options,
            headers: { Origin: 'http://localhost', ...options.headers },
        }),
        { MOCK_MODE: 'true' },
    );

test('dirty state and validation cover both languages, discard and publishing guards', () => {
    const draft = fields(mockProject);
    assert.equal(isDirty(null, draft), false);
    assert.equal(isDirty(mockProject, draft), false);
    draft.title.tr += ' düzenleme';
    assert.equal(isDirty(mockProject, draft), true);
    assert.equal(canPublish(mockProject, draft, false, false), true);
    assert.equal(canPublish(mockProject, draft, true, false), false);
    assert.equal(canPublish(mockProject, draft, false, true), false);
    draft.description.en = ' ';
    assert.equal(validFields(draft), false);
    draft.description.en = 'x'.repeat(2001);
    assert.equal(validFields(draft), false);
    assert.equal(isDirty(mockProject, fields(mockProject)), false);
});

test('real UI loads source, previews text safely, tracks changes, discards, and simulates publish', async () => {
    const doc = documentStub(),
        get = (id) => doc.getElementById(id);
    const editor = mountEditor(doc, localFetch);
    await editor.ready;
    assert.equal(editor.state.project.id, mockProject.id);
    assert.equal(get('mock-banner').hidden, false);
    assert.equal(get('publish').disabled, true);
    assert.equal(get('preview-cards').children.length, 2);
    get('title-en').value = '<script>editorial text</script>';
    await get('project-form').emit('input');
    assert.equal(editor.dirty(), true);
    assert.equal(get('publish').disabled, false);
    const heading = get('preview-cards').children[1].children[1].children[1].children[1];
    assert.equal(heading.textContent, '<script>editorial text</script>');
    await get('discard').emit('click');
    assert.equal(get('title-en').value, mockProject.title.en);
    get('title-tr').value += ' yeni';
    await get('project-form').emit('input');
    await get('project-form').emit('submit');
    assert.equal(editor.dirty(), false);
    assert.equal(get('publish').disabled, true);
    assert(get('status').textContent.includes('No GitHub commit'));
});

test('conflict preserves draft, blocks republish and requires explicit reload', async () => {
    const doc = documentStub(),
        get = (id) => doc.getElementById(id);
    let puts = 0;
    const fetcher = (path, options) => {
        if (options.method === 'PUT') {
            puts++;
            return Response.json(
                {
                    error: {
                        code: 'conflict',
                        message: 'Content changed in the repository. Reload before publishing.',
                    },
                },
                { status: 409 },
            );
        }
        return localFetch(path, options);
    };
    const editor = mountEditor(doc, fetcher, () => false);
    await editor.ready;
    get('title-en').value = 'Unsaved title';
    await get('project-form').emit('input');
    await get('project-form').emit('submit');
    assert.equal(editor.state.needsReload, true);
    assert.equal(get('title-en').value, 'Unsaved title');
    assert.equal(get('publish').disabled, true);
    await get('project-form').emit('submit');
    assert.equal(puts, 1);
    await get('reload').emit('click'); // Decline discarding unsaved changes.
    assert.equal(get('title-en').value, 'Unsaved title');
    await get('discard').emit('click');
    await get('reload').emit('click');
    assert.equal(editor.state.needsReload, false);
});

test('publish disables fields and rejects a double submit while request is pending', async () => {
    const doc = documentStub(),
        get = (id) => doc.getElementById(id);
    let release,
        writes = 0;
    const fetcher = (path, options) => {
        if (options.method === 'PUT') {
            writes++;
            return new Promise((resolve) => {
                release = () => resolve(localFetch(path, options));
            });
        }
        return localFetch(path, options);
    };
    const editor = mountEditor(doc, fetcher);
    await editor.ready;
    get('title-en').value = 'Updated';
    await get('project-form').emit('input');
    const pending = get('project-form').emit('submit');
    assert.equal(get('edit-fields').disabled, true);
    assert.equal(get('publish').disabled, true);
    await get('project-form').emit('submit');
    assert.equal(writes, 1);
    release();
    await pending;
    assert.equal(get('edit-fields').disabled, false);
});

test('loading failure leaves publishing disabled and offers reload', async () => {
    const doc = documentStub();
    const editor = mountEditor(doc, async () => {
        throw new Error('Connection unavailable');
    });
    await editor.ready;
    assert.equal(editor.state.project, null);
    assert.equal(doc.getElementById('publish').disabled, true);
    assert.equal(doc.getElementById('reload').disabled, false);
    assert.equal(doc.getElementById('status').dataset.error, 'true');
});

test('bilingual edits update previews, discard, mock publish and reload', async () => {
    const doc = documentStub(),
        get = (id) => doc.getElementById(id);
    const editor = mountEditor(doc, localFetch, () => true);
    await editor.ready;
    get('title-tr').value = 'Yeni başlık';
    get('description-en').value = 'Updated English description';
    await get('project-form').emit('input');
    const previews = get('preview-cards').children;
    assert.equal(previews[0].children[1].children[1].children[1].textContent, 'Yeni başlık');
    assert.equal(
        previews[1].children[1].children[1].children[2].textContent,
        'Updated English description',
    );
    await get('discard').emit('click');
    assert.equal(get('title-tr').value, mockProject.title.tr);
    assert.equal(get('description-en').value, mockProject.description.en);
    assert.equal(editor.dirty(), false);
    get('title-tr').value = 'Yeni başlık';
    await get('project-form').emit('input');
    assert.equal(get('publish').disabled, false);
    await get('project-form').emit('submit');
    assert(get('status').textContent.includes('Mock publish complete'));
    await get('reload').emit('click');
    assert.equal(get('title-tr').value, 'Yeni başlık');
});

test('new-project flow validates identity, creates once, locks ID, edits domain, and archives without deletion', async () => {
    const doc = documentStub(),
        get = (id) => doc.getElementById(id);
    const editor = mountEditor(doc, localFetch, () => true);
    await editor.ready;
    await get('new-project').emit('click');
    assert(editor.state.creating);
    assert.equal(get('stable-id').readOnly, false);
    assert.equal(get('archived').checked, true);
    assert.equal(get('publish').disabled, true);
    get('stable-id').value = 'local-editor-project';
    get('title-tr').value = 'Yerel test';
    get('title-en').value = 'Local test';
    get('description-tr').value = 'Yerel açıklama';
    get('description-en').value = 'Local description';
    await get('project-form').emit('input');
    assert.equal(get('publish').disabled, false);
    get('stable-id').value = 'game-development-area';
    await get('project-form').emit('input');
    assert.equal(get('publish').disabled, true);
    get('stable-id').value = 'local-editor-project';
    get('verified').checked = true;
    get('archived').checked = false;
    await get('project-form').emit('change');
    await get('project-form').emit('submit');
    assert.equal(editor.state.creating, false);
    assert.equal(editor.state.project.id, 'local-editor-project');
    assert.equal(get('stable-id').readOnly, true);
    assert.equal(editor.state.projects.length, 3);
    get('archived').checked = true;
    get('domain').value = 'electronics-embedded';
    await get('project-form').emit('change');
    assert(get('project-visibility').textContent.includes('Archived'));
    await get('project-form').emit('submit');
    assert.equal(editor.state.project.archived, true);
    assert.equal(editor.state.project.verified, true);
    assert.equal(editor.state.project.domain, 'electronics-embedded');
    await get('reload').emit('click');
    assert.equal(get('archived').checked, true);
});

test('switching selection protects dirty edits and completeness reflects current draft', async () => {
    const doc = documentStub(),
        get = (id) => doc.getElementById(id);
    let accept = false;
    const editor = mountEditor(doc, localFetch, () => accept);
    await editor.ready;
    get('description-en').value = '';
    await get('project-form').emit('input');
    assert.equal(get('publish').disabled, true);
    const buttons = get('project-list').querySelectorAll('button');
    assert(
        buttons
            .find((b) => b.dataset.id === mockProject.id)
            .children.some((c) => c.textContent === 'TR ✓ / EN incomplete'),
    );
    await buttons.find((b) => b.dataset.id === 'game-development-area').emit('click');
    assert.equal(editor.state.project.id, mockProject.id);
    accept = true;
    await get('project-list')
        .querySelectorAll('button')
        .find((b) => b.dataset.id === 'game-development-area')
        .emit('click');
    assert.equal(editor.state.project.verified, false);
    assert.equal(get('description-en').value, 'Games, prototypes, game design, and tools.');
});

test('mock conflict control retains new drafts and prevents duplicate POSTs', async () => {
    const doc = documentStub(),
        get = (id) => doc.getElementById(id);
    let posts = 0,
        release;
    const fetcher = (path, options) =>
        options.method === 'POST'
            ? (posts++,
              new Promise((resolve) => {
                  release = () => resolve(localFetch(path, options));
              }))
            : localFetch(path, options);
    const editor = mountEditor(doc, fetcher);
    await editor.ready;
    await get('new-project').emit('click');
    get('stable-id').value = 'double-create';
    get('title-tr').value = 'TR';
    get('title-en').value = 'EN';
    get('description-tr').value = 'TR';
    get('description-en').value = 'EN';
    await get('project-form').emit('input');
    await get('mock-conflict').emit('click');
    const pending = get('project-form').emit('submit');
    await get('project-form').emit('submit');
    assert.equal(posts, 1);
    release();
    await pending;
    assert(editor.state.creating);
    assert(editor.state.needsReload);
    assert.equal(get('stable-id').value, 'double-create');
});

test('an empty project index still permits a new bilingual draft', async () => {
    const doc = documentStub();
    const editor = mountEditor(doc, async () =>
        Response.json({ mode: 'mock', projects: [], sha: '0'.repeat(40) }),
    );
    await editor.ready;
    assert.equal(editor.state.project, null);
    assert.equal(doc.getElementById('new-project').disabled, false);
    await doc.getElementById('new-project').emit('click');
    assert(editor.state.creating);
    assert.equal(doc.getElementById('editor').hidden, false);
    assert.equal(doc.getElementById('publish').disabled, true);
});
