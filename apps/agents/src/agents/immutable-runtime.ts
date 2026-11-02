import type { AIAgent } from '../core/types/agent.ts'

/** A Perspective runtime is an immutable instance of a public Profile template.
 * Tool refresh may retire contributions; it cannot edit the instance's selection.
 */
export const immutablePerspectiveRuntime = (agent: AIAgent): AIAgent => {
  const refuse = (): never => { throw Object.assign(new Error('Perspective runtime configuration is immutable; edit the public template and prepare a fresh compartment'), { code: 'perspective_template_immutable' }) }
  return { ...agent,
    updatePersona: refuse, updateModel: refuse, updateTemperature: refuse, updateHistoryLimit: refuse,
    updateHistoryTokenBudget: refuse, updateThinking: refuse, updateReasoningEffort: refuse,
    updateTools: refuse, updateSkills: refuse, updateTags: refuse, updateDescription: refuse,
    updateIncludePrompts: refuse, updateIncludeContext: refuse, updateIncludeTools: refuse,
    updatePromptsEnabled: refuse, updateContextEnabled: refuse, updateMaxToolIterations: refuse,
    setName: refuse, addTrigger: refuse, updateTrigger: refuse, deleteTrigger: refuse,
    fireTriggerExecute: async () => refuse(), requestTurn: refuse,
  }
}
