export const DEFAULT_WORKSPACE_PROMPT = `You are part of samsinn, a collaborative multi-agent system. Be respectful and constructive. When uncertain, say so rather than guessing. Prioritise responding to new messages and direct questions. Use the pass tool when the conversation genuinely does not need your input.`

export const DEFAULT_RESPONSE_FORMAT = `- Write your message as natural text. Your response IS the message other participants will read.
- You may use Markdown formatting (headings, bold, lists, code blocks, etc.).
- To direct a message to a specific agent, use [[AgentName]] in your response.
  Example: [[Analyst-1]] can you elaborate on that point?
- To address all agents with a given tag, use [[tag:TagName]].
  Example: [[tag:Reviewer]] please review this before we proceed.
- Never wrap your response in JSON or data structures.`

export interface WorkspaceSettings {
  readonly getPrompt: () => string
  readonly setPrompt: (prompt: string) => void
  readonly getResponseFormat: () => string
  readonly setResponseFormat: (format: string) => void
  readonly listModuleBindings: () => ReadonlyArray<ModuleBinding>
  readonly getModuleBinding: (moduleId: ModuleId | string) => ModuleBinding | undefined
  readonly setModuleBinding: (binding: ModuleBinding) => void
  readonly removeModuleBinding: (moduleId: ModuleId | string) => boolean
}

export const createWorkspaceSettings = (): WorkspaceSettings => {
  let prompt = DEFAULT_WORKSPACE_PROMPT
  let responseFormat = DEFAULT_RESPONSE_FORMAT
  const moduleBindings = new Map<string, ModuleBinding>()
  return {
    getPrompt: () => prompt,
    setPrompt: (next) => { prompt = next },
    getResponseFormat: () => responseFormat,
    setResponseFormat: (next) => { responseFormat = next },
    listModuleBindings: () => [...moduleBindings.values()],
    getModuleBinding: (moduleId) => moduleBindings.get(moduleId),
    setModuleBinding: (binding) => {
      const parsed = moduleBindingSchema.parse(binding)
      moduleBindings.set(parsed.moduleId, parsed)
    },
    removeModuleBinding: (moduleId) => moduleBindings.delete(moduleId),
  }
}
import {
  moduleBindingSchema,
  type ModuleBinding,
  type ModuleId,
} from '@samsinn-leitbild/platform-contracts'
