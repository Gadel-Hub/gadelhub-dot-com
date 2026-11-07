export const fields = (project) => ({
    title: { tr: project.title.tr, en: project.title.en },
    description: { tr: project.description.tr, en: project.description.en },
});
export const isDirty = (project, draft) =>
    Boolean(project) && JSON.stringify(fields(project)) !== JSON.stringify(fields(draft));
export function validFields(draft) {
    return ['title', 'description'].every((field) =>
        ['tr', 'en'].every(
            (lang) =>
                typeof draft[field]?.[lang] === 'string' &&
                draft[field][lang].trim().length > 0 &&
                draft[field][lang].length <= (field === 'title' ? 160 : 2000),
        ),
    );
}
export const canPublish = (project, draft, busy, needsReload) =>
    !busy && !needsReload && isDirty(project, draft) && validFields(draft);
