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
    const project = data.projects.find((item) => item.id === id && item.verified);
    if (!project) throw new ApiError(404, 'project_not_found', 'Verified project not found.');
    return project;
}

export function projectView(project) {
    return {
        id: project.id,
        domain: project.domain,
        verified: project.verified,
        title: project.title,
        description: project.description,
    };
}

export function validateEdit(body) {
    if (!keys(body, ['sha', 'title', 'description']) || !validSha(body.sha))
        invalid('Expected file SHA, title and description only.');
    localized(body.title, 'Title', 160);
    localized(body.description, 'Description', 2000);
    return body;
}

// Locate JSON string tokens by structural path. All untouched whitespace, key order,
// records and compact objects remain byte-for-byte intact. JSON.parse validates first.
function stringSpans(text) {
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
    }
    value([]);
    return spans;
}

export function updateProject(text, id, edit) {
    validateEdit(edit);
    const data = parseContent(text);
    const project = findProject(data, id);
    const index = data.projects.indexOf(project);
    const spans = stringSpans(text);
    const replacements = [];
    for (const field of ['title', 'description']) {
        for (const lang of ['tr', 'en']) {
            const span = spans.get(JSON.stringify(['projects', index, field, lang]));
            if (!span)
                throw new ApiError(
                    502,
                    'invalid_repository_content',
                    'Project source could not be updated safely.',
                );
            if (project[field][lang] !== edit[field][lang]) {
                replacements.push({
                    start: span[0],
                    end: span[1],
                    value: JSON.stringify(edit[field][lang]),
                });
            }
        }
    }
    project.title.tr = edit.title.tr;
    project.title.en = edit.title.en;
    project.description.tr = edit.description.tr;
    project.description.en = edit.description.en;
    validateContent(data);
    let result = text;
    for (const change of replacements.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, change.start) + change.value + result.slice(change.end);
    }
    if (!result.endsWith('\n')) result += '\n';
    if (JSON.stringify(parseContent(result)) !== JSON.stringify(data)) {
        throw new ApiError(
            502,
            'invalid_repository_content',
            'Project source could not be updated safely.',
        );
    }
    return { text: result, project: projectView(project) };
}
