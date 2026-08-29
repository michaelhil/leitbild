import { apiFetch } from "./api-client.ts"
// Model dropdown builder. Fetches /models, renders a <select> grouped
// by provider with status tags. The show-all toggle is persisted in
// localStorage so the UI remembers the user's last filter.

import { retryRemainingSeconds } from '../lib/format-retry.ts'

interface ModelCatalogModel {
  id: string
  contextMax: number
  recommended: boolean
  pinned?: boolean
  running?: boolean
  label?: string
}

interface ModelCatalogProvider {
  name: string
  availability: {
    sub: 'ok' | 'backoff' | 'unhealthy' | 'no_key' | 'disabled' | 'down'
    reason: string
    retryAt: number | null
  }
  models: ModelCatalogModel[]
}

interface ModelCatalogResponse {
  providers: ModelCatalogProvider[]
  defaultModel: string
}

const SHOW_ALL_KEY = 'leitbild-model-show-all'

export const getShowAllModels = (): boolean =>
  typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_ALL_KEY) === 'true'

export const setShowAllModels = (v: boolean): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SHOW_ALL_KEY, String(v))
}

const formatContext = (n: number): string => {
  if (!n || n <= 0) return ''
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// Returns the BARE model id (no `provider:` prefix). Auto-prefixing pins
// the model to one provider and disables router failover, which causes
// hard failures during routine upstream throttling. Users can still type
// a `provider:model` prefix manually if they want explicit pinning.
const fullModelId = (_providerName: string, modelId: string): string => modelId

// Brief inline tag shown next to the optgroup label. Falls back to the
// availability state; includes a countdown for explicit backoff windows.
const statusLabel = (provider: ModelCatalogProvider): string => {
  const { availability } = provider
  if (availability.sub === 'ok') return ''
  if (availability.sub === 'no_key') return ' (no API key)'
  if (availability.sub === 'disabled') return ' (disabled)'
  if (availability.sub === 'backoff') {
    if (availability.retryAt !== null) {
      const remaining = retryRemainingSeconds(availability.retryAt)
      return ` (backoff — ${remaining}s)`
    }
    return ' (backoff)'
  }
  return ` (${availability.sub})`
}

// User-facing remediation hint as a per-option tooltip. Same source of
// truth as the toast remediation strings but UI-local because the dropdown
// fetches from /models, not /providers.
const remediationHint = (sub: ModelCatalogProvider['availability']['sub'], providerName: string): string => {
  if (sub === 'no_key') return `Add an API key for ${providerName} in the Providers panel`
  if (sub === 'disabled') return `Enable ${providerName} in the Providers panel`
  if (sub === 'backoff') return `${providerName} is rate-limited — wait for the backoff to expire or pick a model on a different provider`
  if (sub === 'down' || sub === 'unhealthy') return `${providerName} is unavailable — try again or switch providers`
  return ''
}

const fetchModelCatalog = async (): Promise<ModelCatalogResponse> => {
  try {
    const res = await apiFetch('/models')
    if (!res.ok) return { providers: [], defaultModel: '' }
    return await res.json() as ModelCatalogResponse
  } catch {
    return { providers: [], defaultModel: '' }
  }
}

/**
 * Populate a <select> with models grouped by provider. Providers with status
 * 'no_key' are hidden. When showAll=false (default), only curated/recommended
 * models are listed; when true, all provider-reported models appear.
 *
 * `preferredModel` — when provided, it's pre-selected if present. Otherwise
 * the server-reported `defaultModel` wins.
 *
 * Returns the value that ended up selected (possibly empty).
 */
export const populateModelSelect = async (
  select: HTMLSelectElement,
  options: { preferredModel?: string; showAll?: boolean } = {},
): Promise<string> => {
  select.innerHTML = '<option value="">Loading...</option>'
  const data = await fetchModelCatalog()
  const showAll = options.showAll ?? getShowAllModels()

  select.innerHTML = ''

  if (data.providers.length === 0) {
    select.innerHTML = '<option value="">No providers configured</option>'
    return ''
  }

  // Two-bucket render: routable providers (ok/backoff) first, structurally
  // unavailable ones at the bottom. Unavailable groups render
  // with an actionable label so the user sees *why* they can't pick a
  // particular model — and how to fix it — rather than the model just
  // being missing from the list.
  //
  // Both buckets are populated; only ok/backoff options are routable and
  // get added to the eligible-for-selection set. Other options are
  // shown but disabled, with a tooltip explaining the remediation step.
  const routable: string[] = []
  const orderedProviders = [
    ...data.providers.filter(p => p.availability.sub === 'ok' || p.availability.sub === 'backoff'),
    ...data.providers.filter(p => p.availability.sub !== 'ok' && p.availability.sub !== 'backoff'),
  ]
  for (const prov of orderedProviders) {
    const models = showAll ? prov.models : prov.models.filter(m => m.recommended)
    if (models.length === 0) continue
    const group = document.createElement('optgroup')
    group.label = `${prov.name}${statusLabel(prov)}`
    const tooltip = remediationHint(prov.availability.sub, prov.name)
    for (const m of models) {
      const opt = document.createElement('option')
      const full = fullModelId(prov.name, m.id)
      opt.value = full
      const label = m.label ? `${m.id} — ${m.label}` : m.id
      const ctx = formatContext(m.contextMax)
      const pinTag = m.pinned ? '★ ' : ''
      const runTag = m.running ? ' (running)' : ''
      opt.textContent = ctx
        ? `${pinTag}${label} · ${ctx}${runTag}`
        : `${pinTag}${label}${runTag}`
      if (tooltip) opt.title = tooltip
      if (prov.availability.sub !== 'ok') opt.classList.add('text-text-muted')
      if (prov.availability.sub !== 'ok' && prov.availability.sub !== 'backoff') {
        // Disable so the user can't pick a model that has no chance of
        // routing right now. Backoff stays selectable because it will recover.
        opt.disabled = true
        opt.classList.add('text-text-muted', 'opacity-60')
      } else {
        routable.push(full)
      }
      group.appendChild(opt)
    }
    select.appendChild(group)
  }

  if (routable.length === 0) {
    // Everything was unavailable. Keep groups visible (so user sees why)
    // but prepend a clear placeholder.
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'No routable models — add an API key in the Providers panel'
    placeholder.disabled = true
    placeholder.selected = true
    select.insertBefore(placeholder, select.firstChild)
    return ''
  }

  const chosen = (options.preferredModel && routable.includes(options.preferredModel))
    ? options.preferredModel
    : (data.defaultModel && routable.includes(data.defaultModel) ? data.defaultModel : routable[0]!)
  select.value = chosen

  // If the preferred model is not currently reported, show the configured
  // value explicitly as unavailable.
  if (options.preferredModel && !routable.includes(options.preferredModel)) {
    const opt = document.createElement('option')
    opt.value = options.preferredModel
    opt.textContent = `${options.preferredModel} (not available)`
    opt.selected = true
    select.insertBefore(opt, select.firstChild)
    return options.preferredModel
  }

  return chosen
}
