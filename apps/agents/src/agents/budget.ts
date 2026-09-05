// One model-aware policy for the system-prompt and conversation-history
// budget. Tool schemas, expected output, and estimation drift consume the
// same context window, so they are reserved explicitly for every evaluation.

export const AUTO_BUDGET_FALLBACK = 64_000
export const OUTPUT_RESERVE = 4_096
export const SAFETY_MARGIN = 1_000

interface BudgetableToolDef {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface ContextBudget {
  readonly budget: number
  readonly toolDefinitionTokens: number
  readonly reason: string
}

export interface BudgetInputs {
  readonly contextMax: number
  readonly toolDefinitions: ReadonlyArray<BudgetableToolDef>
}

export type EstimateTokensFn = (text: string) => number

export const computeContextBudget = (inputs: BudgetInputs, estimateTokens: EstimateTokensFn): ContextBudget => {
  const toolDefinitionTokens = inputs.toolDefinitions.reduce((total, tool) => total + estimateTokens(JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })), 0)
  const contextMax = inputs.contextMax > 0 ? inputs.contextMax : AUTO_BUDGET_FALLBACK
  const available = contextMax - toolDefinitionTokens - OUTPUT_RESERVE - SAFETY_MARGIN
  return {
    budget: Math.max(0, available),
    toolDefinitionTokens,
    reason: `${inputs.contextMax > 0 ? contextMax : `unknown-model:${contextMax}`} - tools=${toolDefinitionTokens} - output=${OUTPUT_RESERVE} - safety=${SAFETY_MARGIN}`,
  }
}
