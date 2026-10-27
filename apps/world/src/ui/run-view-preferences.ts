/** Browser-local presentation preferences. Nothing here is a command or Run state. */
export interface RunViewPreferences {
  readonly briefing: boolean
  readonly alarms: boolean
  readonly layout: boolean
  readonly panels: Readonly<Record<string, boolean>>
}
export const initialRunViewPreferences = (): RunViewPreferences => ({ briefing: true, alarms: false, layout: false, panels: {} })
export const runViewPreferencesKey = (workspaceId: string, runId: string): string => `leitbild.run-view.v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(runId)}`
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
export const readRunViewPreferences = (storage: Storage, key: string): RunViewPreferences => {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    if (typeof value !== 'object' || value === null) return initialRunViewPreferences()
    const candidate = value as Partial<RunViewPreferences>
    if (typeof candidate.briefing !== 'boolean' || typeof candidate.alarms !== 'boolean' || typeof candidate.layout !== 'boolean' || typeof candidate.panels !== 'object' || candidate.panels === null || Array.isArray(candidate.panels) || Object.values(candidate.panels).some(value => typeof value !== 'boolean')) return initialRunViewPreferences()
    return { briefing: candidate.briefing, alarms: candidate.alarms, layout: candidate.layout, panels: { ...candidate.panels } }
  } catch { return initialRunViewPreferences() }
}
export const writeRunViewPreferences = (storage: Storage, key: string, value: RunViewPreferences): void => {
  try { storage.setItem(key, JSON.stringify(value)) } catch { /* Presentation remains usable when browser storage is unavailable. */ }
}
