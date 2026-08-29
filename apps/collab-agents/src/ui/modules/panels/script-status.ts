import type { ActiveScript } from '../stores.ts'

export interface ScriptStatusRow {
  readonly name: string
  readonly utterances: number
  readonly ready: boolean
  readonly readyStreak: number
}

export interface ScriptStatusSnapshot {
  readonly stepIndex: number
  readonly stepTitle: string
  readonly complete: boolean
  readonly goal?: string
  readonly rows: ReadonlyArray<ScriptStatusRow>
}

// Pure status projection so the panel remains a renderer, not a second source
// of script state. Counts are deliberately scoped to the displayed step and
// include only cast utterances (director/user posts do not count for an agent).
export const buildScriptStatusSnapshot = (active: ActiveScript): ScriptStatusSnapshot => {
  const stepIndex = active.ended
    ? Math.max(0, active.totalSteps - 1)
    : Math.min(active.stepIndex, Math.max(0, active.totalSteps - 1))
  const entries = active.stepLogs[stepIndex] ?? []
  const step = active.steps[stepIndex]
  return {
    stepIndex,
    stepTitle: active.ended ? 'Complete' : (active.stepTitle || 'Current step'),
    complete: active.ended,
    ...(step?.goal && !active.ended ? { goal: step.goal } : {}),
    rows: active.cast.map(cast => ({
      name: cast.name,
      utterances: entries.filter(entry => entry.speaker === cast.name).length,
      ready: active.ended || active.readiness[cast.name] === true,
      readyStreak: active.readyStreak[cast.name] ?? 0,
    })),
  }
}
