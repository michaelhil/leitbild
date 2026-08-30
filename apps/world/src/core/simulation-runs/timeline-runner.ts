import type { ScenarioExecutionState, ScenarioTimeline, ScenarioTimelineCue } from '../model/index.ts'

export interface TimelineDueCueConfig {
  readonly timeline: ScenarioTimeline
  readonly state: ScenarioExecutionState
  readonly nowMs: number
}

export interface ScenarioTimelineRunner {
  readonly start: () => void
  readonly close: () => void
}

const timeMs = (iso: string): number => {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) throw new Error(`invalid scenario timeline timestamp: ${iso}`)
  return parsed
}

const cueDueAtMs = (cue: ScenarioTimelineCue, scenarioStartedAtMs: number): number => {
  if (cue.at.kind === 'after_scenario_start') return scenarioStartedAtMs + cue.at.seconds * 1000
  throw new Error(`unsupported scenario timeline time reference: ${(cue.at as { readonly kind: string }).kind}`)
}

export const dueScenarioTimelineCues = (config: TimelineDueCueConfig): ReadonlyArray<ScenarioTimelineCue> => {
  const timelineState = config.state.timeline
  if (!timelineState) return []
  const scenarioStartedAtMs = timeMs(timelineState.startedAt)
  const firedCueIds = new Set(timelineState.firedCueIds)
  return config.timeline.cues
    .filter(cue => !firedCueIds.has(cue.id))
    .filter(cue => cueDueAtMs(cue, scenarioStartedAtMs) <= config.nowMs)
    .sort((left, right) =>
      cueDueAtMs(left, scenarioStartedAtMs) - cueDueAtMs(right, scenarioStartedAtMs)
      || left.id.localeCompare(right.id))
}

export const createScenarioTimelineRunner = (config: {
  readonly timeline: ScenarioTimeline
  readonly state: ScenarioExecutionState
  readonly nowMs: () => number
  readonly delayMs?: (dueAtMs: number, nowMs: number) => number
  readonly onCueDue: (cue: ScenarioTimelineCue) => Promise<void>
  readonly onCueFailed?: (cue: ScenarioTimelineCue, error: unknown) => Promise<void>
}): ScenarioTimelineRunner => {
  const timeoutIds = new Set<ReturnType<typeof setTimeout>>()
  let closed = false

  const clearTimers = (): void => {
    for (const timeoutId of timeoutIds) clearTimeout(timeoutId)
    timeoutIds.clear()
  }

  const runCue = async (cue: ScenarioTimelineCue): Promise<void> => {
    if (closed) return
    try {
      await config.onCueDue(cue)
    } catch (err) {
      await config.onCueFailed?.(cue, err)
    }
  }

  const start = (): void => {
    clearTimers()
    const timelineState = config.state.timeline
    if (!timelineState) return
    const scenarioStartedAtMs = timeMs(timelineState.startedAt)
    const firedCueIds = new Set(timelineState.firedCueIds)
    for (const cue of config.timeline.cues) {
      if (firedCueIds.has(cue.id)) continue
      const nowMs = config.nowMs()
      const dueAtMs = cueDueAtMs(cue, scenarioStartedAtMs)
      const delayMs = config.delayMs
        ? config.delayMs(dueAtMs, nowMs)
        : Math.max(0, dueAtMs - nowMs)
      const timeoutId = setTimeout(() => {
        timeoutIds.delete(timeoutId)
        void runCue(cue)
      }, delayMs)
      timeoutIds.add(timeoutId)
    }
  }

  return {
    start,
    close: (): void => {
      closed = true
      clearTimers()
    },
  }
}
