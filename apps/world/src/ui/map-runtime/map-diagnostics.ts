import type {
  MapRuntimeDiagnostic,
  MapRuntimeDiagnosticDetail,
  MapRuntimeDiagnosticsSnapshot,
  MapRuntimeError,
} from './types.ts'

export interface MapDiagnostics {
  readonly start: (phase: MapRuntimeDiagnostic['phase'], message: string, details?: ReadonlyArray<MapRuntimeDiagnosticDetail>) => void
  readonly ready: (phase: MapRuntimeDiagnostic['phase'], message: string, details?: ReadonlyArray<MapRuntimeDiagnosticDetail>) => void
  readonly fail: (phase: MapRuntimeDiagnostic['phase'], error: MapRuntimeError, details?: ReadonlyArray<MapRuntimeDiagnosticDetail>) => void
  readonly details: (phase: MapRuntimeDiagnostic['phase'], details: ReadonlyArray<MapRuntimeDiagnosticDetail>) => void
  readonly snapshot: () => MapRuntimeDiagnosticsSnapshot
}

const phases: ReadonlyArray<MapRuntimeDiagnostic['phase']> = [
  'base',
  'reference',
  'operational-static',
  'operational-dynamic',
  'ui-overlay',
]

const emptyDiagnostic = (
  phase: MapRuntimeDiagnostic['phase'],
  nowMs: number,
): MapRuntimeDiagnostic => ({
  phase,
  status: 'pending',
  message: 'Pending',
  startedAtMs: nowMs,
  details: [],
})

export const createMapDiagnostics = (
  now: () => number = () => performance.now(),
): MapDiagnostics => {
  const entries = new Map<MapRuntimeDiagnostic['phase'], MapRuntimeDiagnostic>(
    phases.map(phase => [phase, emptyDiagnostic(phase, now())]),
  )
  let latestError: MapRuntimeError | undefined

  const current = (
    phase: MapRuntimeDiagnostic['phase'],
  ): MapRuntimeDiagnostic =>
    entries.get(phase) ?? {
      phase,
      status: 'pending',
      message: 'Pending',
      startedAtMs: now(),
      details: [],
    }

  const write = (entry: MapRuntimeDiagnostic): void => {
    entries.set(entry.phase, entry)
  }

  return {
    start: (phase, message, details = []) => {
      const existing = current(phase)
      const { completedAtMs: _completedAtMs, ...withoutCompletion } = existing
      write({
        ...withoutCompletion,
        status: 'running',
        message,
        startedAtMs: now(),
        details,
      })
    },
    ready: (phase, message, details = []) => {
      const existing = current(phase)
      write({
        ...existing,
        status: 'ready',
        message,
        completedAtMs: now(),
        details,
      })
    },
    fail: (phase, error, details = []) => {
      latestError = error
      const existing = current(phase)
      write({
        ...existing,
        status: 'failed',
        message: error.message,
        completedAtMs: now(),
        details,
      })
    },
    details: (phase, details) => {
      const existing = current(phase)
      write({ ...existing, details })
    },
    snapshot: () => ({
      phases: [...entries.values()],
      ...(latestError === undefined ? {} : { latestError }),
    }),
  }
}

export const runtimeDiagnosticDetails = (
  snapshot: MapRuntimeDiagnosticsSnapshot,
): ReadonlyArray<MapRuntimeDiagnosticDetail> =>
  snapshot.phases.flatMap(phase => [
    { label: `${phase.phase} status`, value: phase.status },
    { label: `${phase.phase} message`, value: phase.message },
    ...phase.details.map(detail => ({
      label: `${phase.phase} ${detail.label}`,
      value: detail.value,
    })),
  ])
