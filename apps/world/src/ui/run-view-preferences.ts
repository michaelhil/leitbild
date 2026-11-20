/** Browser-local presentation preferences. Nothing here is a command or Run state. */
export interface RunViewPreferences {
  /** Presentation preferences only; not tutorial progress or Run state. */
  readonly guidance: {
    readonly mode: 'running' | 'paused' | 'stopped'
    readonly dismissedId: string | null
    readonly presentedId: string | null
  }
  readonly alarms: boolean
  readonly layout: boolean
  readonly panels: Readonly<Record<string, boolean>>
  /** Map layer groups switched in the rail, by group id; a group absent here follows its `defaultVisible`. */
  readonly layers: Readonly<Record<string, boolean>>
  readonly weather: boolean
  /** The rail's per-category map eyes, by category id; a category absent here is shown. */
  readonly categories: Readonly<Record<string, boolean>>
  /** The physical layouts' representation, as last chosen on the map's 3D switch. */
  readonly layoutMode: '2d' | '3d'
}
export const initialRunViewPreferences = (): RunViewPreferences => ({ guidance: { mode: 'running', dismissedId: null, presentedId: null }, alarms: false, layout: false, panels: {}, layers: {}, weather: true, categories: {}, layoutMode: '2d' })
export const runViewPreferencesKey = (workspaceId: string, runId: string): string => `leitbild.run-view:${encodeURIComponent(workspaceId)}:${encodeURIComponent(runId)}`
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
const choices = (value: unknown): value is Record<string, boolean> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(choice => typeof choice === 'boolean')
/** Strict: a record of any other shape, such as one written before a field existed, reads as the defaults. */
export const readRunViewPreferences = (storage: Storage, key: string): RunViewPreferences => {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    if (typeof value !== 'object' || value === null) return initialRunViewPreferences()
    const candidate = value as Partial<RunViewPreferences>
    const guidance = candidate.guidance
    if (!guidance || !['running', 'paused', 'stopped'].includes(guidance.mode) || !(guidance.dismissedId === null || typeof guidance.dismissedId === 'string') || !(guidance.presentedId === null || typeof guidance.presentedId === 'string')
      || typeof candidate.alarms !== 'boolean' || typeof candidate.layout !== 'boolean' || !choices(candidate.panels)
      || !choices(candidate.layers) || typeof candidate.weather !== 'boolean' || !choices(candidate.categories) || (candidate.layoutMode !== '2d' && candidate.layoutMode !== '3d')) return initialRunViewPreferences()
    return { guidance: { ...guidance }, alarms: candidate.alarms, layout: candidate.layout, panels: { ...candidate.panels }, layers: { ...candidate.layers }, weather: candidate.weather, categories: { ...candidate.categories }, layoutMode: candidate.layoutMode }
  } catch { return initialRunViewPreferences() }
}
export const writeRunViewPreferences = (storage: Storage, key: string, value: RunViewPreferences): void => {
  try { storage.setItem(key, JSON.stringify(value)) } catch { /* Presentation remains usable when browser storage is unavailable. */ }
}
