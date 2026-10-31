// Image admission uses provider-advertised modalities before local model hints.
// Providers such as OpenRouter publish these through their existing /models
// inventory. An explicit text-only report must override every catalog/name hint.
// Providers without modality metadata retain the curated/local-model policy;
// unknown models get a visible text placeholder and drop metric, never guessed
// image support. New OpenRouter models do not require a released name allowlist.

import type { ModelInfo } from '../core/types/model-info.ts'
import { modelSupportsImagesFromCatalog } from './models/catalog.ts'

const MULTIMODAL_MODEL_SUBSTRINGS: ReadonlyArray<string> = [
  // OpenAI
  'gpt-4o',
  'gpt-4-vision',
  'gpt-5',          // gpt-5.4, gpt-5-pro, etc. all multimodal
  'gpt-6',          // gpt-6-sol, gpt-6.1-sol, gpt-6-luna, gpt-6-astra
  // Anthropic
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-',
  'claude-3.5',
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4',
  // Google
  'gemini-1.5',
  'gemini-2',
  'gemini-pro-vision',
  'gemini-flash',
  // Meta (multimodal Llama variants)
  'llama-3.2-vision',
  'llama-4',
  // Mistral
  'pixtral',
  // Qwen
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
]

const stripProviderPrefix = (model: string): string => {
  const colonIdx = model.indexOf(':')
  return colonIdx >= 0 ? model.slice(colonIdx + 1) : model
}

export const modelSupportsImages = (modelId: string, info?: Pick<ModelInfo, 'inputModalities'>): boolean => {
  if (info?.inputModalities !== undefined) return info.inputModalities.includes('image')
  if (!modelId) return false
  // Without a provider report, consult the explicit local catalog. When the catalog
  // declares the model, trust it — even if a substring would also match.
  const catalogVerdict = modelSupportsImagesFromCatalog(modelId)
  if (catalogVerdict !== undefined) return catalogVerdict
  // Tier 2: substring allowlist. Conservative default for uncatalogued models.
  const id = stripProviderPrefix(modelId).toLowerCase()
  for (const needle of MULTIMODAL_MODEL_SUBSTRINGS) {
    if (id.includes(needle.toLowerCase())) return true
  }
  return false
}

// Text placeholder used when a message has image attachments but the
// receiving model is not multimodal. The placeholder gives the model
// enough information to ask the user for a description.
export const imagePlaceholder = (att: { width: number; height: number; mimeType: string; source?: string }): string => {
  const src = att.source ? ` (${att.source})` : ''
  return `[image attached${src}: ${att.mimeType} ${att.width}×${att.height} — this request cannot view images directly; ask the user to describe what's in the screenshot]`
}

// Warn-once tracker. Module-level Set keyed by `${model}::${callerId}` so
// the same agent attaching multiple images to one conversation sees the
// warn ONCE (not per-image), but a different agent or a fresh session
// triggers a fresh warn. Bounded by (agent count × distinct models ever used)
// — small in practice. Reset on process restart, which is the right scope
// for "operator notices it in journalctl when it first happens."
const warnedKeys = new Set<string>()

// Reset the warn-once tracker. Tests call this between cases; production
// code never calls it (the module-level Set is the desired scope).
export const __resetMultimodalWarnTracker = (): void => { warnedKeys.clear() }

// Warn-once helper. Call from the placeholder-substitution site. Records
// the silent loss of an image as a single warn line per (model, callerId).
// Production effect: operator running `journalctl -u leitbild -f` sees one
// `[multimodal] dropped image ...` line per new (model, agent) pair —
// distinguishes "this agent can't see images, by design" from "I just
// switched my agent to gpt-6 and didn't realize the catalog doesn't know
// it yet."
//
// Counter sink: process-global counter increments EVERY time (not just on
// the first warn per pair) so the operator can see total cumulative drops
// in /api/system/health.anomalies.multimodalImagesDropped. The warn-once
// is for journalctl readability; the counter is for aggregate visibility.
export const warnImageDroppedOnce = (
  model: string,
  callerId: string,
  imageCount: number,
  attDescriptions: string,
  countSink?: { inc: (field: 'multimodalImagesDropped', by?: number) => void },
): void => {
  // Counter always bumps so /api/system/health shows true cumulative drops.
  countSink?.inc('multimodalImagesDropped', imageCount)
  const key = `${model}::${callerId}`
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(`[multimodal] model=${model} caller=${callerId} dropped ${imageCount} image(s) via text placeholder — image input is not admitted by provider metadata or local model policy. Attach: ${attDescriptions}`)
}
