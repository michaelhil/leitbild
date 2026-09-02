import type { ScenarioExecutionState,ScenarioTimeline,ScenarioTimelineCue } from '../model/index.ts'

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
      cueDueAtMs(left, scenarioStartedAtMs) - cueDueAtMs(right, scenarioStartedAtMs))
}

export const createScenarioTimelineRunner = (config: {
  readonly timeline: ScenarioTimeline
  readonly state: ScenarioExecutionState
  readonly nowMs: () => number
  readonly delayMs?: (dueAtMs: number, nowMs: number) => number
  readonly onCueDue: (cue: ScenarioTimelineCue) => Promise<void>
  readonly onCueFailed?: (cue: ScenarioTimelineCue, error: unknown) => Promise<void>
}): ScenarioTimelineRunner => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let running = false
  const pending = config.timeline.cues
    .filter(cue => !config.state.timeline?.firedCueIds.includes(cue.id))
    .sort((a, b) => a.at.seconds - b.at.seconds)

  const clearTimers = (): void => {
    clearTimeout(timeoutId)
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
    if (closed || running) return
    const timelineState = config.state.timeline
    if (!timelineState) return
    const scenarioStartedAtMs = timeMs(timelineState.startedAt)
    const cue = pending[0]
    if (cue) {
      const nowMs = config.nowMs()
      const dueAtMs = cueDueAtMs(cue, scenarioStartedAtMs)
      const delayMs = config.delayMs
        ? config.delayMs(dueAtMs, nowMs)
        : Math.max(0, dueAtMs - nowMs)
      timeoutId = setTimeout(() => {
        if (config.nowMs() < dueAtMs) { start(); return }
        running = true
        pending.shift()
        void runCue(cue).finally(() => { running = false; start() })
      }, Math.min(delayMs, 2_147_483_647))
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
