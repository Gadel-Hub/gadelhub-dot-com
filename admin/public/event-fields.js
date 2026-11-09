// ISO timestamps are kept as entered, including the explicit offset. Never use
// datetime-local's implicit browser timezone to serialize source content.
export function eventInstant(value) {
    if (typeof value !== 'string') return NaN;
    const match =
        /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
            value,
        );
    if (!match) return NaN;
    const [, year, month, day, hour, minute, second = '0', fraction = '', zone] = match;
    const y = +year,
        m = +month,
        d = +day,
        h = +hour,
        n = +minute,
        s = +second;
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || h > 23 || n > 59 || s > 59)
        return NaN;
    let offset = 0;
    if (zone !== 'Z') {
        const zh = +zone.slice(1, 3),
            zm = +zone.slice(4, 6);
        if (zh > 23 || zm > 59) return NaN;
        offset = (zh * 60 + zm) * (zone[0] === '+' ? 1 : -1);
    }
    const date = new Date(0);
    date.setUTCFullYear(y, m - 1, d);
    date.setUTCHours(h, n, s, +(fraction + '000').slice(0, 3));
    return date.getTime() - offset * 60000;
}
export const validEventDate = (value) => Number.isFinite(eventInstant(value));
export const eventFields = (event) => ({
    date: event.date,
    location: event.location,
    archived: event.archived ?? false,
    title: { tr: event.title.tr, en: event.title.en },
    description: { tr: event.description.tr, en: event.description.en },
});
export const eventDirty = (event, draft) =>
    Boolean(event) && JSON.stringify(eventFields(event)) !== JSON.stringify(eventFields(draft));
export const validEventFields = (value) =>
    validEventDate(value.date) &&
    typeof value.location === 'string' &&
    Boolean(value.location.trim()) &&
    typeof value.archived === 'boolean' &&
    ['title', 'description'].every((field) =>
        ['tr', 'en'].every(
            (lang) =>
                typeof value[field]?.[lang] === 'string' &&
                Boolean(value[field][lang].trim()) &&
                value[field][lang].length <= (field === 'title' ? 160 : 2000),
        ),
    );
export function sortEvents(events, now = Date.now()) {
    const group = (event) => (event.archived ? 2 : eventInstant(event.date) >= now ? 0 : 1);
    return [...events].sort(
        (a, b) =>
            group(a) - group(b) ||
            (group(a) === 1
                ? eventInstant(b.date) - eventInstant(a.date)
                : eventInstant(a.date) - eventInstant(b.date)) ||
            a.id.localeCompare(b.id, 'en'),
    );
}
export const eventState = (event, now = Date.now()) =>
    event.archived
        ? 'Archived / hidden'
        : eventInstant(event.date) < now
          ? 'Past / public'
          : 'Upcoming / public';
