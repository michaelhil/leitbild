import type { EmbeddedViewEnvelope } from './embedded-views.ts'

// Zod-free so browser bundles can build view routes without the schema
// runtime. Callers pass envelopes that were validated where they entered.

/** Same-origin route of an embedded view; the envelope itself goes in the fragment. */
export const embeddedViewPath = (envelope: EmbeddedViewEnvelope): string =>
  `/workspaces/${envelope.subject.workspaceId}/${envelope.moduleId}/embed/${envelope.viewType}`

export const EMBEDDED_VIEW_FRAGMENT_KEY = 'view='

export const embeddedViewFragment = (envelope: EmbeddedViewEnvelope): string =>
  `#${EMBEDDED_VIEW_FRAGMENT_KEY}${encodeURIComponent(JSON.stringify(envelope))}`
