import { ApiError } from './errors.js';

const invalid = (message) => {
    throw new ApiError(422, 'validation', message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) =>
    object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
export const validId = (id) =>
    typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 100;
export const validSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);

function localized(value, label, max = Infinity) {
    if (!keys(value, ['tr', 'en'])) invalid(`${label} must contain TR and EN only.`);
    for (const lang of ['tr', 'en']) {
        if (typeof value[lang] !== 'string' || !value[lang].trim() || value[lang].length > max) {
            invalid(
                `${label} ${lang.toUpperCase()} is required and must be at most ${max} characters.`,
            );
        }
    }
}

export function validateContent(data) {
    if (
        !keys(data, ['featured', 'projects', 'week', 'events', 'teams']) ||
        !Array.isArray(data.projects) ||
        !Array.isArray(data.week?.resources) ||
        !Array.isArray(data.events?.items)
    ) {
        invalid('Repository content has an unexpected structure.');
    }
    const seen = new Set();
    const records = [
        data.featured,
        ...data.projects,
        data.week,
        ...data.week.resources,
        data.events,
        ...data.events.items,
        data.teams,
    ];
    for (const item of records) {
        if (!object(item) || !validId(item.id) || seen.has(item.id))
            invalid('Repository record IDs are invalid.');
        seen.add(item.id);
    }
    if (typeof data.featured.placeholder !== 'boolean') invalid('Invalid featured placeholder.');
    for (const field of ['badge', 'title', 'description']) localized(data.featured[field], field);
    for (const project of data.projects) {
        if (
            !['game-development', 'electronics-embedded'].includes(project.domain) ||
            typeof project.verified !== 'boolean' ||
            (project.archived !== undefined && typeof project.archived !== 'boolean') ||
            typeof project.symbol !== 'string' ||
            !project.symbol.trim()
        )
            invalid('Invalid project metadata.');
        localized(project.title, 'Title');
        localized(project.description, 'Description');
    }
    localized(data.week.notice, 'Weekly notice');
    localized(data.events.notice, 'Event notice');
    localized(data.events.description, 'Event description');
    localized(data.teams.description, 'Team description');
    localized(data.teams.link_label, 'Team link');
    for (const item of [...data.week.resources, ...data.events.items]) {
        localized(item.title, 'Title');
        localized(item.description, 'Description');
    }
    return data;
}

export function parseContent(text) {
    try {
        return validateContent(JSON.parse(text));
    } catch {
        throw new ApiError(
            502,
            'invalid_repository_content',
            'Repository content is malformed or unsupported.',
        );
    }
}

export function findProject(data, id) {
    const project = data.projects.find((item) => item.id === id);
    if (!project) throw new ApiError(404, 'project_not_found', 'Project not found.');
    return project;
}

export function projectView(project) {
    return {
        id: project.id,
        domain: project.domain,
        verified: project.verified,
        archived: project.archived ?? false,
        symbol: project.symbol,
        title: project.title,
        description: project.description,
    };
}

export const domains = ['game-development', 'electronics-embedded'];

function validateFields(body, create) {
    const required = [
        'sha',
        'title',
        'description',
        ...(create ? ['id', 'domain', 'verified'] : []),
    ];
    const allowed = [...required, 'domain', 'verified', 'archived'];
    if (
        !object(body) ||
        required.some((key) => !Object.hasOwn(body, key)) ||
        Object.keys(body).some((key) => !allowed.includes(key)) ||
        !validSha(body.sha)
    )
        invalid('Expected file SHA and allowlisted project fields only.');
    if (create && !validId(body.id))
        invalid('ID must be a kebab-case slug of at most 100 characters.');
    if (Object.hasOwn(body, 'domain') && !domains.includes(body.domain))
        invalid('Invalid project domain.');
    for (const key of ['verified', 'archived'])
        if (Object.hasOwn(body, key) && typeof body[key] !== 'boolean')
            invalid(`${key} must be a boolean.`);
    localized(body.title, 'Title', 160);
    localized(body.description, 'Description', 2000);
    return body;
}

export const validateEdit = (body) => validateFields(body, false);
export const validateCreate = (body) => validateFields(body, true);

// Locate JSON values by structural path. All untouched whitespace, key order,
// records and compact objects remain byte-for-byte intact. JSON.parse validates first.
function valueSpans(text) {
    let cursor = 0;
    const spans = new Map();
    const space = () => {
        while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
    };
    function string() {
        const start = cursor++;
        while (cursor < text.length) {
            if (text[cursor] === '\\') cursor += 2;
            else if (text[cursor++] === '"') break;
        }
        return [start, cursor];
    }
    function value(path) {
        space();
        const start = cursor;
        if (text[cursor] === '"') {
            const span = string();
            spans.set(JSON.stringify(path), span);
        } else if (text[cursor] === '{') {
            cursor++;
            space();
            while (text[cursor] !== '}') {
                const [start, end] = string();
                const key = JSON.parse(text.slice(start, end));
                space();
                cursor++;
                value([...path, key]);
                space();
                if (text[cursor] !== ',') break;
                cursor++;
                space();
            }
            cursor++;
        } else if (text[cursor] === '[') {
            cursor++;
            space();
            let index = 0;
            while (text[cursor] !== ']') {
                value([...path, index++]);
                space();
                if (text[cursor] !== ',') break;
                cursor++;
                space();
            }
            cursor++;
        } else {
            while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
        }
        spans.set(JSON.stringify(path), [start, cursor]);
    }
    value([]);
    return spans;
}

function applyChanges(text, data, replacements) {
    validateContent(data);
    let result = text;
    for (const change of replacements.sort((a, b) => b.start - a.start))
        result = result.slice(0, change.start) + change.value + result.slice(change.end);
    if (JSON.stringify(parseContent(result)) !== JSON.stringify(data))
        throw new ApiError(
            502,
            'invalid_repository_content',
            'Project source could not be updated safely.',
        );
    return result;
}

export function updateProject(text, id, edit) {
    validateEdit(edit);
    const data = parseContent(text);
    const project = findProject(data, id);
    const index = data.projects.indexOf(project);
    const spans = valueSpans(text);
    const replacements = [];
    function replace(path, value) {
        const span = spans.get(JSON.stringify(path));
        replacements.push({ start: span[0], end: span[1], value: JSON.stringify(value) });
    }
    for (const field of ['title', 'description']) {
        for (const lang of ['tr', 'en']) {
            if (project[field][lang] !== edit[field][lang]) {
                replace(['projects', index, field, lang], edit[field][lang]);
                project[field][lang] = edit[field][lang];
            }
        }
    }
    for (const field of ['domain', 'verified', 'archived']) {
        if (!Object.hasOwn(edit, field) || (project[field] ?? false) === edit[field]) continue;
        if (Object.hasOwn(project, field)) replace(['projects', index, field], edit[field]);
        else {
            let end = spans.get(JSON.stringify(['projects', index]))[1] - 1;
            while (/\s/.test(text[end - 1])) end--;
            replacements.push({
                start: end,
                end,
                value: `, "${field}": ${JSON.stringify(edit[field])}`,
            });
        }
        project[field] = edit[field];
    }
    return { text: applyChanges(text, data, replacements), project: projectView(project) };
}

export function createProject(text, body) {
    validateCreate(body);
    const data = parseContent(text);
    const ids = [
        data.featured,
        ...data.projects,
        data.week,
        ...data.week.resources,
        data.events,
        ...data.events.items,
        data.teams,
    ].map((record) => record.id);
    if (ids.includes(body.id))
        throw new ApiError(
            422,
            'duplicate_id',
            'This stable ID is already in use. Choose another ID.',
        );
    const project = {
        id: body.id,
        verified: body.verified,
        domain: body.domain,
        symbol: body.domain === 'game-development' ? '✦' : '▣',
        title: body.title,
        description: body.description,
        ...(body.archived ? { archived: true } : {}),
    };
    let end = valueSpans(text).get(JSON.stringify(['projects']))[1] - 1;
    while (/\s/.test(text[end - 1])) end--;
    const record = JSON.stringify(project, null, 2)
        .split('\n')
        .map((line) => '    ' + line)
        .join('\n');
    const insertion = {
        start: end,
        end,
        value: `${data.projects.length ? ',' : ''}\n${record}${data.projects.length ? '' : '\n  '}`,
    };
    data.projects.push(project);
    return { text: applyChanges(text, data, [insertion]), project: projectView(project) };
}
