/** Provider catalog facts, not a second availability/permission registry. */
export interface ModelInfo {
  readonly id: string
  readonly provider: string
  readonly contextMax: number // 0 = unknown, never unlimited
  readonly source: string
  readonly maxOutputTokens?: number
  readonly supportedParameters?: ReadonlyArray<string>
  readonly reasoning?: {
    /** Omitted = no advertised selector; null = all gateway effort values. */
    readonly supportedEfforts?: ReadonlyArray<string> | null
    readonly mandatory?: boolean
    readonly defaultEffort?: string
  }
}
