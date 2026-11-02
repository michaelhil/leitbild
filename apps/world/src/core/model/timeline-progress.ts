import type { ScenarioTimelineProgressState } from './scenario.ts'

export interface TimelineProgressEvent {
  readonly type: string
  readonly at?: string
  readonly cueId?: string
  readonly actionCount?: number
  readonly actionIndex?: number
  readonly outcome?: string
}

/** Shared by journal and browser projections. Unknown dispatch is retained; it is never permission to replay. */
export const projectTimelineProgress = (timeline: ScenarioTimelineProgressState | undefined, event: TimelineProgressEvent): ScenarioTimelineProgressState => {
  if (event.cueId === undefined) throw new Error('A timeline progress event requires a cue identity')
  if (timeline === undefined && event.at === undefined) throw new Error('A cue admission requires its simulation timestamp')
  if (event.type === 'scenario.cue.started') return {
    ...timeline,
    startedAt: timeline?.startedAt ?? event.at as ScenarioTimelineProgressState['startedAt'],
    firedCueIds: [...new Set([...(timeline?.firedCueIds ?? []), event.cueId])],
    ...(event.actionCount === undefined ? {} : { executions: [...(timeline?.executions ?? []), { cueId: event.cueId, status: 'admitted' as const, actions: Array.from({ length: event.actionCount }, () => 'not_attempted' as const) }] }),
  }
  if (timeline === undefined || timeline.executions === undefined) throw new Error('Cue outcome arrived without an admitted action journal')
  const execution = timeline.executions.find(entry => entry.cueId === event.cueId)
  if (execution === undefined) throw new Error('Cue outcome names an unknown admission')
  if (event.type === 'scenario.cue.action') {
    if (event.actionIndex === undefined || event.actionIndex >= execution.actions.length || !['unknown', 'accepted', 'failed'].includes(event.outcome ?? '')) throw new Error('Invalid cue action outcome')
    const actions = execution.actions.map((outcome, index) => index === event.actionIndex ? event.outcome as 'unknown' | 'accepted' | 'failed' : outcome)
    return { ...timeline, executions: timeline.executions.map(entry => entry === execution ? { ...entry, actions } : entry) }
  }
  if (event.type === 'scenario.cue.finished' && (event.outcome === 'complete' || event.outcome === 'failed')) {
    if (event.outcome === 'complete' && execution.actions.some(outcome => outcome !== 'accepted')) throw new Error('A cue cannot complete without every action accepted')
    return { ...timeline, executions: timeline.executions.map(entry => entry === execution ? { ...entry, status: event.outcome as 'complete' | 'failed' } : entry) }
  }
  return timeline
}
