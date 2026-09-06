// Agents-owned scenario/EAL data; shared procedure format types live in @leitbild/procmd.
export interface ScenarioInjection {
  readonly tag: string
  readonly value: string | number | boolean
  readonly atTimeS: number
}
export type EalClass = 'UE' | 'Alert' | 'SAE' | 'GE'
export interface ParsedScenario {
  readonly scenarioId: string
  readonly title: string
  readonly preamble: string
  readonly initialState: Readonly<Record<string, string | number | boolean>>
  readonly injections: ReadonlyArray<ScenarioInjection>
  readonly expectedTraversal: ReadonlyArray<string>
  readonly expectedTerminalState: Readonly<Record<string, string | number | boolean>>
  readonly expectedEalClass: EalClass
  readonly timingSource: string
  readonly warnings: ReadonlyArray<string>
}
export type ScenarioParseResult = ParsedScenario | { readonly error: string }
