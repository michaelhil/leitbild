export interface WikiAssistantPage {
  readonly path: string
  readonly title: string
  readonly revision: string
}

/** A visible reference, not a copy of the wiki or an extra system instruction. */
export function wikiAssistantPrompt(prompt: string, page: WikiAssistantPage | null): string {
  if (!page) return prompt
  return `${prompt}\n\nWiki page I am viewing: ${page.title}\nSource: knowledge/${page.path}\nKnowledge revision: ${page.revision}`
}

/** Open the host shell, not the standalone Agents iframe route. */
export function wikiAssistantDestination(workspaceId: string, roomId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ agents: roomId })}`
}
