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
}

export const createWorkspaceSettings = (): WorkspaceSettings => {
  let prompt = DEFAULT_WORKSPACE_PROMPT
  let responseFormat = DEFAULT_RESPONSE_FORMAT
  return {
    getPrompt: () => prompt,
    setPrompt: (next) => { prompt = next },
    getResponseFormat: () => responseFormat,
    setResponseFormat: (next) => { responseFormat = next },
  }
}
