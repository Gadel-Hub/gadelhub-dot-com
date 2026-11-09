export const domains = ['game-development', 'electronics-embedded'];
export const fields = (project) => ({
    domain: project.domain,
    verified: project.verified,
    archived: project.archived ?? false,
    title: { tr: project.title.tr, en: project.title.en },
    description: { tr: project.description.tr, en: project.description.en },
});
export const isDirty = (project, draft) =>
    Boolean(project) && JSON.stringify(fields(project)) !== JSON.stringify(fields(draft));
export function validFields(draft) {
    return (
        domains.includes(draft.domain) &&
        typeof draft.verified === 'boolean' &&
        typeof draft.archived === 'boolean' &&
        ['title', 'description'].every((field) =>
            ['tr', 'en'].every(
                (lang) =>
                    typeof draft[field]?.[lang] === 'string' &&
                    draft[field][lang].trim().length > 0 &&
                    draft[field][lang].length <= (field === 'title' ? 160 : 2000),
            ),
        )
    );
}
export const validId = (id) =>
    typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 100;
export const canPublish = (project, draft, busy, needsReload, creating = false) =>
    !busy &&
    !needsReload &&
    (creating ? validId(draft.id) : isDirty(project, draft)) &&
    validFields(draft);
export const completeness = (project, lang) =>
    ['title', 'description'].every((field) => Boolean(project[field]?.[lang]?.trim()));
export const visibility = (project) =>
    project.archived
        ? 'Archived / hidden'
        : project.verified
          ? 'Verified / public'
          : 'Unverified / directory only';
