import { ApiError } from './errors.js';
import {
    object,
    invalid,
    localized,
    validId,
    validSha,
    parseContent,
    valueSpans,
    applyChanges,
} from './content.js';
import { validEventDate } from '../public/event-fields.js';

export function validateEventWrite(body, create = false) {
    const required = ['sha', 'date', 'location', 'title', 'description', ...(create ? ['id'] : [])];
    if (
        !object(body) ||
        required.some((key) => !Object.hasOwn(body, key)) ||
        Object.keys(body).some((key) => ![...required, 'archived'].includes(key)) ||
        !validSha(body.sha)
    )
        invalid('Expected file SHA and allowlisted event fields only.');
    if (create && !validId(body.id))
        invalid('ID must be a kebab-case slug of at most 100 characters.');
    if (!validEventDate(body.date))
        invalid('Date must be a real ISO 8601 date/time with an explicit timezone (Z or ±HH:MM).');
    if (typeof body.location !== 'string' || !body.location.trim())
        invalid('Location is required.');
    if (Object.hasOwn(body, 'archived') && typeof body.archived !== 'boolean')
        invalid('archived must be a boolean.');
    localized(body.title, 'Title', 160);
    localized(body.description, 'Description', 2000);
    return body;
}
export function findEvent(data, id) {
    const event = data.events.items.find((event) => event.id === id);
    if (!event) throw new ApiError(404, 'event_not_found', 'Event not found.');
    return event;
}
export const eventView = (event) => ({
    id: event.id,
    date: event.date,
    location: event.location,
    title: event.title,
    description: event.description,
    archived: event.archived ?? false,
    ...(event.external ? { external: event.external } : {}),
});

export function updateEvent(text, id, edit) {
    validateEventWrite(edit);
    const data = parseContent(text),
        event = findEvent(data, id),
        index = data.events.items.indexOf(event);
    const spans = valueSpans(text),
        replacements = [];
    function replace(path, value) {
        const [start, end] = spans.get(JSON.stringify(path));
        replacements.push({ start, end, value: JSON.stringify(value) });
    }
    for (const field of ['title', 'description'])
        for (const lang of ['tr', 'en']) {
            if (event[field][lang] !== edit[field][lang]) {
                replace(['events', 'items', index, field, lang], edit[field][lang]);
                event[field][lang] = edit[field][lang];
            }
        }
    for (const field of ['date', 'location', 'archived']) {
        if (!Object.hasOwn(edit, field) || (event[field] ?? false) === edit[field]) continue;
        if (Object.hasOwn(event, field)) replace(['events', 'items', index, field], edit[field]);
        else {
            let end = spans.get(JSON.stringify(['events', 'items', index]))[1] - 1;
            while (/\s/.test(text[end - 1])) end--;
            replacements.push({
                start: end,
                end,
                value: `, "${field}": ${JSON.stringify(edit[field])}`,
            });
        }
        event[field] = edit[field];
    }
    return { text: applyChanges(text, data, replacements), event: eventView(event) };
}
export function createEvent(text, body) {
    validateEventWrite(body, true);
    const data = parseContent(text);
    const records = [
        data.featured,
        ...data.projects,
        data.week,
        ...data.week.resources,
        data.events,
        ...data.events.items,
        data.teams,
    ];
    if (records.some((record) => record.id === body.id))
        throw new ApiError(
            422,
            'duplicate_id',
            'This stable ID is already in use. Choose another ID.',
        );
    const event = {
        id: body.id,
        date: body.date,
        location: body.location,
        title: body.title,
        description: body.description,
        archived: body.archived ?? true,
    };
    let end = valueSpans(text).get(JSON.stringify(['events', 'items']))[1] - 1;
    while (/\s/.test(text[end - 1])) end--;
    const record = JSON.stringify(event, null, 2)
        .split('\n')
        .map((line) => '      ' + line)
        .join('\n');
    const insertion = {
        start: end,
        end,
        value: `${data.events.items.length ? ',' : ''}\n${record}${data.events.items.length ? '' : '\n    '}`,
    };
    data.events.items.push(event);
    return { text: applyChanges(text, data, [insertion]), event: eventView(event) };
}
