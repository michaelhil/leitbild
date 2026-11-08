/** Format data only. Reading these declarations never evaluates or executes them. */
import type { ProcedureAssessment } from './assessment.ts'
import type { ProcedureDecision } from './decisions.ts'
import type { ProcedureLimits } from './limits.ts'
export interface ProcedureTextBlock {
  readonly kind: 'check' | 'action' | 'expected' | 'rno' | 'unknown' | 'basis' | 'decision' | 'when' | 'until' | 'abort-if' | 'abort-to' | 'within' | 'concurrent' | 'caution' | 'note' | 'because' | 'against' | 'text'
  readonly text: string
  readonly paths?: ReadonlyArray<string>
  readonly tagIds: ReadonlyArray<string>
  readonly sourceLine: number
  /** Limits authored at the end of a Check, Expected or When line; its text then names their tags once. */
  readonly limits?: ProcedureLimits
}

export interface ProcedureBranch {
  readonly label: string
  readonly target: string
  readonly targetKind: 'step' | 'procedure' | 'end' | 'retry' | 'abort' | 'unknown'
  readonly targetStepId?: string
  /** Authored meaning, never inferred from a label or destination. */
  readonly outcome?: 'normal' | 'rno' | 'unknown'
  readonly execution?: 'transfer' | 'parallel'
  readonly because?: string
  readonly against?: string
  readonly tagIds: ReadonlyArray<string>
  readonly sourceLine: number
  /** A fork's test: limits on the branch line itself. They decide an AI's selection and never light for a person. */
  readonly limits?: ProcedureLimits
}

/** A presentation boundary within a Step. It has no placekeeping or execution state. */
export interface ProcedureResponsePair {
  readonly id: string
  readonly sourceLine: number
  /** Existing criterion which exactly expresses the paired expected response. */
  readonly advisoryBranchIndex?: number
}

export interface ProcedureStep {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly level: number
  readonly blocks: ReadonlyArray<ProcedureTextBlock>
  /** Source branch order is also the persisted command's branchIndex order. */
  readonly branches: ReadonlyArray<ProcedureBranch>
  readonly tagIds: ReadonlyArray<string>
  readonly sourceLine: number
  readonly sourceEndLine: number
  readonly pairs?: ReadonlyArray<ProcedureResponsePair>
  /** Engineering criteria; no live binding or automatic execution is implied. */
  readonly assessment?: ProcedureAssessment
  /** Explicit eligibility for source-ordered branches; absent branches are unestablished. */
  readonly decisions?: ReadonlyArray<ProcedureDecision>
  /** A read-only owning-Pack query; this document never executes equipment commands. */
  readonly observation?: {
    readonly capabilityId: string
    readonly input: Readonly<Record<string, unknown>>
    readonly continuous: boolean
  }
}

export interface ProcedureTag {
  readonly id: string
  readonly description?: string
  readonly simPath?: string
  readonly units?: string
  readonly equipment?: string
  readonly source?: string
  readonly range?: ReadonlyArray<number>
  readonly annotations: Readonly<Record<string, string>>
}

/** Standing duties, shown with every step. Plain text with readings: no branches, no lights. */
export interface ProcedureFoldout {
  readonly title: string
  readonly text: string
  readonly tagIds: ReadonlyArray<string>
  readonly sourceLine: number
}

export interface ParsedProcedure {
  readonly procedureId: string
  readonly title: string
  readonly profile?: string
  readonly category?: string
  readonly appliesTo?: string
  readonly referencePlant?: string
  readonly csfsMonitored: ReadonlyArray<string>
  readonly entryTriggers: ReadonlyArray<string>
  readonly description: string
  readonly foldout?: ProcedureFoldout
  readonly annotations: Readonly<Record<string, string>>
  readonly diagnostics: ReadonlyArray<string>
  readonly rawMarkdown: string
  readonly steps: ReadonlyArray<ProcedureStep>
  readonly tags: ReadonlyArray<ProcedureTag>
}
