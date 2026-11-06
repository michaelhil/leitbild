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
}
export const initialRunViewPreferences = (): RunViewPreferences => ({ guidance: { mode: 'running', dismissedId: null, presentedId: null }, alarms: false, layout: false, panels: {} })
export const runViewPreferencesKey = (workspaceId: string, runId: string): string => `leitbild.run-view:${encodeURIComponent(workspaceId)}:${encodeURIComponent(runId)}`
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
export const readRunViewPreferences = (storage: Storage, key: string): RunViewPreferences => {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    if (typeof value !== 'object' || value === null) return initialRunViewPreferences()
    const candidate = value as Partial<RunViewPreferences>
    const guidance = candidate.guidance
    if (!guidance || !['running', 'paused', 'stopped'].includes(guidance.mode) || !(guidance.dismissedId === null || typeof guidance.dismissedId === 'string') || !(guidance.presentedId === null || typeof guidance.presentedId === 'string') || typeof candidate.alarms !== 'boolean' || typeof candidate.layout !== 'boolean' || typeof candidate.panels !== 'object' || candidate.panels === null || Array.isArray(candidate.panels) || Object.values(candidate.panels).some(value => typeof value !== 'boolean')) return initialRunViewPreferences()
    return { guidance: { ...guidance }, alarms: candidate.alarms, layout: candidate.layout, panels: { ...candidate.panels } }
  } catch { return initialRunViewPreferences() }
}
export const writeRunViewPreferences = (storage: Storage, key: string, value: RunViewPreferences): void => {
  try { storage.setItem(key, JSON.stringify(value)) } catch { /* Presentation remains usable when browser storage is unavailable. */ }
}
