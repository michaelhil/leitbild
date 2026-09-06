// Prior replay is a working-context choice, not the model's hard capacity.
// The output/safety allowances here are estimates for selecting history;
// they are NOT output limits sent to a provider or a guarantee of fit.

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
  readonly historyTokenBudget?: number
  readonly toolDefinitions: ReadonlyArray<BudgetableToolDef>
}

export type EstimateTokensFn = (text: string) => number

export const computeContextBudget = (inputs: BudgetInputs, estimateTokens: EstimateTokensFn): ContextBudget => {
  const toolDefinitionTokens = inputs.toolDefinitions.reduce((total, tool) => total + estimateTokens(JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })), 0)
  const target = inputs.historyTokenBudget ?? AUTO_BUDGET_FALLBACK
  if (!Number.isSafeInteger(target) || target < 1) throw new Error('History replay target must be a positive integer')
  const contextMax = inputs.contextMax > 0 ? Math.min(inputs.contextMax, target) : target
  const available = contextMax - toolDefinitionTokens - OUTPUT_RESERVE - SAFETY_MARGIN
  return {
    budget: Math.max(0, available),
    toolDefinitionTokens,
    reason: `replay=${target}; capacity=${inputs.contextMax > 0 ? inputs.contextMax : 'unknown-model'}; selected=${contextMax} - tools=${toolDefinitionTokens} - estimated-output=${OUTPUT_RESERVE} - safety=${SAFETY_MARGIN}`,
  }
}
