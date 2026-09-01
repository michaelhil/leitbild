import type { ToolRegistryEntry } from './tool.ts'

/** The Pack that owns this tool, or undefined for built-in/local sources. */
export const owningPackFor = (entry: ToolRegistryEntry): string | undefined =>
  entry.source.pack

/** Human-readable provenance without pretending every tool belongs to a Pack. */
export const contributionSourceFor = (entry: ToolRegistryEntry): string =>
  owningPackFor(entry) ?? (entry.source.kind === 'built-in' ? 'built-in' : 'local')
