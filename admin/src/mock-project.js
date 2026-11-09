// Build-time source snapshot, used only for local simulation. Never written back.
import source from '../../content/home.json' with { type: 'json' };
export const mockContent = source;
export const mockProject = source.projects.find(
    (project) => project.id === 'stm32-beginner-resources',
);
