/** Format data only. Reading these declarations never evaluates or executes them. */
export interface ProcedureTextBlock {
  readonly kind: 'check' | 'action' | 'decision' | 'when' | 'until' | 'abort-if' | 'abort-to' | 'within' | 'concurrent' | 'caution' | 'note' | 'because' | 'against' | 'text'
  readonly text: string
  readonly paths?: ReadonlyArray<string>
  readonly tagIds: ReadonlyArray<string>
  readonly sourceLine: number
}

export interface ProcedureBranch {
  readonly label: string
  readonly target: string
  readonly targetKind: 'step' | 'procedure' | 'end' | 'retry' | 'abort' | 'unknown'
  readonly because?: string
  readonly against?: string
  readonly tagIds: ReadonlyArray<string>
  readonly sourceLine: number
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
  readonly annotations: Readonly<Record<string, string>>
  readonly diagnostics: ReadonlyArray<string>
  readonly rawMarkdown: string
  readonly steps: ReadonlyArray<ProcedureStep>
  readonly tags: ReadonlyArray<ProcedureTag>
}
