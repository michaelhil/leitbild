// The solver seam: plain data a Worker receives by structured clone. Times are slot indexes from `origin`.

export interface NormalizedProblem {
  readonly slotMs: number
  readonly origin: number
  readonly horizon: number
  /** Compiler, bounds and engine versions, the grid and time/zone.ts zoneDataFingerprint(). Proofs are reused only on an equal formulation. */
  readonly formulation: string
  readonly calendars: ReadonlyArray<{ readonly id: string; readonly work: Uint8Array }>
  readonly resources: ReadonlyArray<{
    readonly id: string
    readonly capacity: Int16Array
    readonly pricePerUnitSlot: Float64Array
    readonly periods: ReadonlyArray<{ readonly purchase: string; readonly from: number; readonly to: number; readonly price: number; readonly committed: boolean }>
    readonly once: ReadonlyArray<{ readonly purchase: string; readonly price: number; readonly committed: boolean }>
    readonly forbiddenWhenUsed: ReadonlyArray<{ readonly purchase: string; readonly from: number; readonly to: number }>
    readonly maxJobs?: number
  }>
  readonly activities: ReadonlyArray<{
    readonly id: string
    readonly modes: ReadonlyArray<{
      readonly work: number
      readonly calendar: number
      readonly continuous: boolean
      readonly demands: ReadonlyArray<{ readonly resource: number; readonly amount: number; readonly when: number }>
      readonly fixedCost: number
      readonly release: number
    }>
    readonly release: number
    readonly deadline: number
    readonly due?: number
    readonly fixed?: { readonly mode: number; readonly start: number; readonly history: boolean }
  }>
  readonly links: ReadonlyArray<{
    readonly from: number; readonly to: number; readonly type: 'FS' | 'SS' | 'FF'; readonly min: number; readonly max?: number
    readonly origin: 'link' | 'bracket' | 'tag-before-test' | 'support-order'
  }>
  readonly items: ReadonlyArray<{ readonly id: string; readonly openers: readonly number[]; readonly closers: readonly number[]; readonly supportedBy: readonly number[] }>
  readonly spans: ReadonlyArray<{ readonly id: string; readonly items: readonly number[]; readonly limit?: number; readonly singleEntry: boolean }>
  readonly coverage: ReadonlyArray<{ readonly id: string; readonly items: readonly number[]; readonly resources: readonly number[]; readonly atLeast: number; readonly from: number; readonly to: number }>
  /**
   * Ranking goals, in order. The metric value x is already net of `threshold` (only the excess counts),
   * so the threshold is never subtracted again. The key is x when `step` is 0, else floor(x / step).
   * Options compare by keys lexicographically; exact ties are broken by option key.
   */
  readonly goals: ReadonlyArray<{ readonly metric: string; readonly spans?: readonly number[]; readonly tagged?: readonly number[]; readonly threshold: number; readonly step: number }>
}

export interface Schedule { readonly mode: Int32Array; readonly start: Int32Array }

export interface EngineBudget { readonly evals: number; readonly cpuMs: number; readonly wallMs: number; readonly memoryMb: number }

export type EngineStop = 'done' | 'evals' | 'cpu' | 'wall' | 'memory' | 'cancelled'
export type BoundSource = 'logic+calendars' | 'crew-energy' | 'availability-rule' | 'fixed-costs'

export interface EngineResult {
  readonly candidates: ReadonlyArray<Schedule>
  readonly stoppedBy: EngineStop
  readonly evals: number
  readonly cpuMs: number
  readonly wallMs: number
  readonly bounds: ReadonlyArray<{ readonly goal: number; readonly value: number; readonly source: BoundSource }>
}

export interface Engine {
  readonly name: string
  readonly solve: (problem: NormalizedProblem, options: {
    readonly budget: EngineBudget
    readonly seed: number
    readonly signal: AbortSignal
    readonly initial?: Schedule
  }) => Promise<EngineResult>
}
