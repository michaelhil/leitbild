// A vignette's link to its Run (architecture B): the view compiled once, then
// one sample a second while the vignette can be seen, none while it cannot.
// A values section that holds a lead request takes its values from each
// sample, in the rows it reserved, so the lead follows its Pack's mode and
// nothing else in the view moves.
// The records it draws (trend pens, values rows' sparklines: kept-series.ts)
// are read on open, and again after a gap (hidden, slow, or the Run reset), so
// no line is drawn across time it did not see: values first, from a sample
// without them, and the records with the sample asked straight after it, so
// reading ten minutes of every record never holds back what the display shows
// now (§5.8); a row that appears when its lead changes has its record read
// once with the next sample (W8.5); every sample extends them. It never loads
// a Run: one that is not loaded is asked about again until someone loads it.
import type { SimulationRunId } from '../../../core/model/index.ts'
import { withActiveRoleSet } from '../../roles/role-session.ts'
import { workspaceApiPath } from '../../workspace-context.ts'
import { zoneRows, type VignetteSample, type VignetteView } from '../../../features/displays/compose/model.ts'
import { keptAfter, shownSeries, unkept, widestWindow } from './kept-series.ts'
import type { DrawnSeries } from './trend.ts'

export interface RunPresence {
  readonly loaded: boolean
  /** The Run's time now. */
  readonly at: string
}

export interface VignetteRoutes {
  /** null when the Run no longer exists. Never loads it. */
  readonly presence: (runId: SimulationRunId) => Promise<RunPresence | null>
  readonly view: (runId: SimulationRunId, state: string) => Promise<VignetteView>
  /** `history`: each record it draws from `fromMs`, or only those of `refs`. */
  readonly sample: (runId: SimulationRunId, state: string, history?: { readonly fromMs: number; readonly refs?: ReadonlyArray<string> }) => Promise<VignetteSample>
}

export type VignettePhase = 'connecting' | 'live' | 'inactive' | 'missing' | 'failed'

export interface VignetteSnapshot {
  readonly phase: VignettePhase
  readonly failure?: string
  readonly view?: VignetteView
  readonly latest?: VignetteSample
  /** Each record it draws by ref (a trend pen's, a values row's), within its window, with the hold the Historian served it with. */
  readonly series: ReadonlyMap<string, DrawnSeries>
  /** Its values are drawn and its records are being read (on open, after a gap): a trend without one yet says nothing. */
  readonly recordsDue?: true
  /** The last sample's failure; null once one succeeds again. */
  readonly sampleError: string | null
  /** Wall time of the last sample answered. */
  readonly lastSampleWallMs?: number
}

export const SAMPLE_INTERVAL_MS = 1_000
/** After a slow or failed answer the next request waits longer: 2 s, then 3 s, which leaves an answer of up to 2 s before the vignette reads stale. */
export const SAMPLE_BACKOFF_MS: ReadonlyArray<number> = [SAMPLE_INTERVAL_MS, 2_000, 3_000]
/** A live vignette whose last sample is older than this, or failed, is stale: its footer says FROZEN. */
export const STALE_AFTER_MS = 5_000
/** Whether a live vignette's values are too old to show as live, at wall time `wallNowMs`. */
export const sampleStale = (snapshot: VignetteSnapshot, wallNowMs: number): boolean => snapshot.phase === 'live'
  && (snapshot.sampleError !== null || (snapshot.lastSampleWallMs !== undefined && wallNowMs - snapshot.lastSampleWallMs > STALE_AFTER_MS))
/** Samples further apart than this missed some: the next one reads the history again. */
export const GAP_MS = 5_000
export const PRESENCE_EVERY_SAMPLES = 5
export const INACTIVE_RETRY_MS = 5_000

export type ScheduleTimer = (run: () => void, delayMs: number) => () => void
const realTimer: ScheduleTimer = (run, delayMs) => {
  const handle = setTimeout(run, delayMs)
  return () => clearTimeout(handle)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The view as the latest sample draws it: each values section holding a lead request with the values it leads with
 * now (the sample's `leads`), within its rows; every other section, and the view itself where none changed, as it was,
 * so a drawing, its pop-over and the scroll stand as they were.
 */
export const viewWithLeads = (view: VignetteView, sample: VignetteSample): VignetteView => {
  const leads = sample.leads
  if (leads === undefined) return view
  let changed = false
  const sections = view.sections.map(section => {
    const now = section.kind === 'values' && section.lead !== undefined ? leads[section.lead]?.slice(0, section.rows - (section.table?.rows ?? 0) - zoneRows(section)) : undefined
    if (section.kind !== 'values' || now === undefined || (now.length === section.values.length && now.every((value, at) => value.ref === section.values[at]!.ref))) return section
    changed = true
    return { ...section, values: now }
  })
  return changed ? { ...view, sections } : view
}

export const createVignetteSession = (config: {
  readonly runId: SimulationRunId
  readonly state: string
  readonly routes: VignetteRoutes
  readonly onChange: (snapshot: VignetteSnapshot) => void
  readonly schedule?: ScheduleTimer
  readonly wallNow?: () => number
}) => {
  const schedule = config.schedule ?? realTimer
  const wallNow = config.wallNow ?? (() => Date.now())
  let snapshot: VignetteSnapshot = { phase: 'connecting', series: new Map(), sampleError: null }
  let closed = false
  let visible = true
  let cancel: (() => void) | null = null
  let running = false
  let samples = 0
  let backoff = 0
  /**
   * What its records wait for: `values`, a sample without them that draws its values (on open, after a gap, a reset or
   * an unloaded Run); `records`, its values drawn, the sample asked at once that reads every record; null: they are
   * kept, and every sample extends them.
   */
  let due: 'values' | 'records' | null = 'values'
  let lastSampleWall: number | null = null

  const replace = (next: VignetteSnapshot): void => {
    if (closed) return
    snapshot = next
    config.onChange(snapshot)
  }
  const update = (patch: Partial<VignetteSnapshot>): void => { replace({ ...snapshot, ...patch }) }
  const stop = (): void => { cancel?.(); cancel = null }
  const next = (delayMs: number): void => {
    stop()
    if (!closed && visible) cancel = schedule(() => { cancel = null; void step() }, delayMs)
  }

  /** The Run is there and loaded; otherwise the phase says why not, and an unloaded Run is asked about again. */
  const present = async (): Promise<RunPresence | null> => {
    const presence = await config.routes.presence(config.runId)
    if (presence === null) { update({ phase: 'missing' }); return null }
    if (!presence.loaded) { update({ phase: 'inactive' }); return null }
    return presence
  }

  /** Refs whose record was asked for once since the last full read: a record the Run could not serve is not asked for again. */
  let asked = new Set<string>()

  const absorb = (view: VignetteView, sample: VignetteSample, fresh: boolean): void => {
    const drawn = viewWithLeads(view, sample)
    const series = keptAfter(snapshot.series, shownSeries(drawn), sample, fresh)
    const { recordsDue: _drawn, ...rest } = snapshot
    replace({ ...rest, phase: 'live', view: drawn, latest: sample, series, sampleError: null, lastSampleWallMs: wallNow() })
  }
  /** Values first: its records stand as they were (none on open; after a gap, not drawn on across it) until they are read. */
  const absorbValues = (view: VignetteView, sample: VignetteSample): void => {
    update({ phase: 'live', view: viewWithLeads(view, sample), latest: sample, sampleError: null, lastSampleWallMs: wallNow(), recordsDue: true })
  }

  const sampleOnce = async (view: VignetteView, known: RunPresence | undefined): Promise<void> => {
    if (lastSampleWall !== null && wallNow() - lastSampleWall > GAP_MS) due = 'values'
    let presence = known
    if (presence === undefined && (due === 'values' || samples % PRESENCE_EVERY_SAMPLES === 0)) {
      const now = await present()
      if (now === null) return
      presence = now
    }
    // The records it draws now (its lead rows as the last sample drew them): all of them with the sample after the one
    // that drew its values on open or after a gap, else only those not kept yet and not asked for (a row that appeared
    // when its lead changed).
    const shown = shownSeries(snapshot.view ?? view)
    const horizon = widestWindow(shown)
    const at = presence?.at ?? snapshot.latest?.at.at
    const first = due === 'values' && horizon > 0
    const whole = due === 'records' && horizon > 0 && at !== undefined
    const missing = first || whole ? [] : unkept(shown, snapshot.series).filter(ref => !asked.has(ref))
    const history = whole ? { fromMs: Date.parse(at!) - horizon } : missing.length > 0 && at !== undefined ? { fromMs: Date.parse(at) - horizon, refs: missing } : undefined
    const sample = await config.routes.sample(config.runId, config.state, history)
    if (closed) return
    // The Run's time going back is a reset: what was drawn is no longer its history.
    const reset = snapshot.latest !== undefined && Date.parse(sample.at.at) < Date.parse(snapshot.latest.at.at)
    samples += 1
    lastSampleWall = wallNow()
    if (reset && !whole) { due = 'values'; asked = new Set(); update({ series: new Map() }); return }
    if (first) { due = 'records'; absorbValues(view, sample); return }
    due = null
    if (whole) asked = new Set()
    for (const ref of history?.refs ?? []) asked.add(ref)
    absorb(view, sample, whole)
  }

  const step = async (): Promise<void> => {
    if (closed || running) return
    running = true
    const started = wallNow()
    let failed = false
    try {
      if (snapshot.view === undefined) {
        // Presence first: the view route may hold the Run, and a vignette never loads one.
        const presence = await present()
        if (presence !== null) {
          const view = await config.routes.view(config.runId, config.state)
          update({ view })
          await sampleOnce(view, presence)
        }
      } else await sampleOnce(snapshot.view, undefined)
    } catch (error) {
      failed = true
      if (snapshot.view === undefined) { update({ phase: 'failed', failure: messageOf(error) }); return }
      update({ sampleError: messageOf(error) })
    } finally {
      running = false
    }
    if (snapshot.phase === 'missing') return
    if (snapshot.phase === 'inactive') { due = 'values'; next(INACTIVE_RETRY_MS); return }
    const latency = wallNow() - started
    backoff = failed || latency > SAMPLE_INTERVAL_MS ? Math.min(backoff + 1, SAMPLE_BACKOFF_MS.length - 1) : 0
    // Its values drawn, its records are asked for at once.
    if (!failed && due === 'records') { next(0); return }
    next(backoff === 0 ? Math.max(0, SAMPLE_INTERVAL_MS - latency) : SAMPLE_BACKOFF_MS[backoff]!)
  }

  return {
    start: (): void => { void step() },
    /** Off-screen it asks the Run nothing; shown again it samples at once. */
    setVisible: (shown: boolean): void => {
      if (shown === visible) return
      visible = shown
      if (!shown) { stop(); return }
      if (snapshot.phase !== 'missing' && snapshot.phase !== 'failed') void step()
    },
    close: (): void => { closed = true; stop() },
  }
}

export type VignetteSession = ReturnType<typeof createVignetteSession>

/** A Run's World-direct path, with the role set this view plays where its Run declares roles (ui/embed/main.ts). */
const runPath = (runId: SimulationRunId, suffix: string): string => withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(runId)}${suffix}` as `/${string}`))

const read = async <T>(response: Response, action: string): Promise<T> => {
  const text = await response.text()
  if (response.ok) return JSON.parse(text) as T
  let message: unknown
  try { message = (JSON.parse(text) as { readonly error?: { readonly message?: unknown } }).error?.message } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  throw new Error(typeof message === 'string' ? `${action}: ${message}` : `${action} failed with HTTP ${response.status}`)
}

const post = async <T>(runId: SimulationRunId, suffix: string, body: unknown, action: string): Promise<T> =>
  read<T>(await fetch(runPath(runId, suffix), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), action)

/** World's display routes, as a person calls them. */
export const vignetteRoutes: VignetteRoutes = {
  presence: async runId => {
    const response = await fetch(runPath(runId, '/presence'))
    if (response.status === 404) return null
    const body = await read<{ readonly loaded: boolean; readonly execution: { readonly currentSimulationTime: string } }>(response, 'Run status')
    return { loaded: body.loaded, at: body.execution.currentSimulationTime }
  },
  view: async (runId, state) => (await post<{ readonly view: VignetteView }>(runId, '/displays/view', { state }, 'Drawing the display')).view,
  sample: async (runId, state, history) => (await post<{ readonly sample: VignetteSample }>(runId, '/displays/sample', { state, ...(history === undefined ? {} : { history }) }, 'Reading the display')).sample,
}
