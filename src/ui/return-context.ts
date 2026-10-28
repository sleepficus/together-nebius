import type {ProjectState} from '../../lib/types.ts';

export function contextIsCurrent(brief: any, state: ProjectState): boolean {
  return Boolean(brief && brief.revisionId === state.project.revision &&
    brief.planRevisionId === (state.project.adoptedPlanRevisionId ?? null) &&
    brief.stopped === state.stopped);
}
