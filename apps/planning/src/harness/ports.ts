// Test harness ports: what the harnesses need from the solver lane. Until lane S lands they are served by
// test doubles in the test files; at integration an adapter over solve/generate, solve/explain and
// solve/bounds implements them. Nothing here is a solver.
import type { z } from 'zod'
import type { Certificate, PlanInputs, Status } from '../plan/schema.ts'
import type { explainResultSchema } from '../api/contract.ts'
import type { CheckRow, CheckVariant } from '../check/check.ts'

export type ExplainItem = z.infer<typeof explainResultSchema>['items'][number]

export interface HarnessOption {
  readonly key: string
  readonly variant: CheckVariant
  readonly status: Status
  readonly rows: readonly CheckRow[]
}

export interface GeneratePort {
  /** One generate over the given inputs, with no input of its own (one option per method option). */
  readonly generate: (inputs: PlanInputs) => Promise<readonly HarnessOption[]>
}

export interface ExplainPort {
  /** "Why does it start then?" for one job of a dated option. */
  readonly whyStart: (inputs: PlanInputs, option: HarnessOption, job: string) => Promise<ExplainItem>
}

export interface BoundsPort {
  /** The refusal certificate, if the bounds prove the variant infeasible, and a lower bound per goal. */
  readonly bounds: (inputs: PlanInputs, variant: CheckVariant) => Promise<{
    readonly certificate?: Certificate
    readonly goals: ReadonlyArray<{ readonly goal: number; readonly value: number }>
  }>
}
