// ============================================================================
// Model context-window lookup — dynamic where providers expose it, hardcoded
// table otherwise. Cached in-process (per provider+model).
//
// Ollama:     POST /api/show  → model_info['<arch>.context_length']
// OpenRouter metadata belongs to its adapter's existing /models inventory.
// Cerebras / Groq / Mistral / SambaNova: /models endpoint returns ID only,
//   so we fall back to a curated table derived from public docs.
// ============================================================================

export interface ContextInfo {
  readonly contextMax: number                // 0 if unknown
  readonly source: 'ollama_api' | 'known_table' | 'unknown'
}

// Curated context windows for cloud providers that don't expose it in /models.
// Source: each provider's public docs as of 2026-07-21. When in doubt, omit
// rather than guess — the UI falls back to "unknown" which is honest.
const CLOUD_TABLE: Record<string, Record<string, number>> = {
  anthropic: {
    'claude-haiku-4-5':   200_000,
    'claude-sonnet-4-5':  200_000,
    'claude-opus-4-5':    200_000,
  },
  openai: {
    'gpt-4o-mini':  128_000,
    'gpt-4o':       128_000,
    'gpt-4.1-mini': 1_047_576,
    'gpt-4.1':      1_047_576,
    // gpt-5 family + o-series. Exact-match on the family head; dated
    // snapshots (e.g. 'gpt-5.4-mini-2026-03-17') fall through to the
    // prefix matcher below.
    'gpt-5':        400_000,
    'gpt-5-mini':   400_000,
    'gpt-5-nano':   200_000,
    'gpt-5-pro':    400_000,
    'gpt-5.1':      400_000,
    'gpt-5.1-mini': 400_000,
    'gpt-5.1-pro':  400_000,
    'gpt-5.4':    1_050_000,
    'gpt-5.4-mini': 400_000,
    'gpt-5.4-nano': 200_000,
    'gpt-5.4-pro': 1_050_000,
    'gpt-5.5':     1_050_000,
    'gpt-5.5-pro': 1_050_000,
    'gpt-5.6-sol':   1_050_000,
    'gpt-5.6-terra': 1_050_000,
    'gpt-5.6-luna':  1_050_000,
    'o1':           200_000,
    'o1-mini':      128_000,
    'o3':           200_000,
    'o3-mini':      200_000,
    'o4-mini':      200_000,
  },
  gemini: {
    'gemini-3.6-flash':      1_048_576,
    'gemini-3.5-flash':      1_048_576,
    'gemini-3.1-flash-lite': 1_048_576,
    'gemini-2.5-flash-lite': 1_048_576,
    'gemini-2.5-flash':      1_048_576,
    'gemini-2.5-pro':        2_097_152,
  },
  cerebras: {
    'llama3.1-8b': 8192,
    'qwen-3-235b-a22b-instruct-2507': 64000,
    'gpt-oss-120b': 65536,
    'zai-glm-4.7': 128000,
  },
  kimi: {
    'kimi-k2.6':                       256000,
    'kimi-k2.5':                       256000,
    'moonshot-v1-8k':                    8192,
    'moonshot-v1-32k':                  32768,
    'moonshot-v1-128k':                131072,
    'moonshot-v1-8k-vision-preview':     8192,
    'moonshot-v1-32k-vision-preview':   32768,
    'moonshot-v1-128k-vision-preview': 131072,
    'moonshot-v1-auto':                131072,
  },
  groq: {
    'llama-3.3-70b-versatile': 131072,
    'llama-3.1-8b-instant': 131072,
    'llama-3.1-70b-versatile': 131072,
    'gemma2-9b-it': 8192,
    'kimi-k2-thinking': 128000,
    'openai/gpt-oss-120b': 131072,
    'openai/gpt-oss-20b': 131072,
    'qwen/qwen3-32b': 131072,
    'moonshotai/kimi-k2-instruct': 131072,
    'deepseek-r1-distill-llama-70b': 131072,
  },
  mistral: {
    'mistral-large-latest': 131072,
    'mistral-small-latest': 32768,
    'ministral-8b-latest': 131072,
    'ministral-3b-latest': 131072,
  },
  sambanova: {
    'Meta-Llama-3.3-70B-Instruct': 131072,
    'Meta-Llama-3.1-8B-Instruct': 131072,
    'DeepSeek-V3-0324': 65536,
  },
}

const cache = new Map<string, { info: ContextInfo; expiresAt: number }>()

export interface ContextLookupOptions {
  readonly ollamaBaseUrl?: string
  readonly timeoutMs?: number
}

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try { return await fetch(url, { ...init, signal: controller.signal }) }
  finally { clearTimeout(timer) }
}

export const getContextWindow = async (
  providerName: string,
  modelId: string,
  opts: ContextLookupOptions = {},
): Promise<ContextInfo> => {
  const key = `${providerName}::${providerName === 'ollama' ? opts.ollamaBaseUrl ?? '' : ''}::${modelId}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.info

  const timeoutMs = opts.timeoutMs ?? 3000
  let info: ContextInfo = { contextMax: 0, source: 'unknown' }

  if (providerName === 'ollama' && opts.ollamaBaseUrl) {
    try {
      const r = await fetchWithTimeout(`${opts.ollamaBaseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelId }),
      }, timeoutMs)
      if (r.ok) {
        const d = await r.json() as { model_info?: Record<string, unknown> }
        const mi = d.model_info ?? {}
        for (const [k, v] of Object.entries(mi)) {
          if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) {
            info = { contextMax: v, source: 'ollama_api' }
            break
          }
        }
      }
    } catch (error) { console.warn(`[model-info] ${providerName}:${modelId} capacity unavailable: ${String(error)}`) }
  }

  if (info.source === 'unknown') {
    const hard = CLOUD_TABLE[providerName]?.[modelId]
    if (hard) info = { contextMax: hard, source: 'known_table' }
    else if (providerName === 'openai') {
      const prefix = findOpenAIPrefixMatch(modelId)
      if (prefix) info = { contextMax: prefix, source: 'known_table' }
    }
  }

  // A failed metadata request must recover without a process restart. These
  // are inventory refresh intervals, not Agent behavior or tool-call limits.
  cache.set(key, { info, expiresAt: Date.now() + (info.source === 'unknown' ? 30_000 : 5 * 60_000) })
  return info
}

// Longest-prefix fallback for OpenAI dated/minor variants. OpenAI ships
// dated snapshots like `gpt-5.4-mini-2026-03-17` constantly; without a
// prefix match they'd all show '?%' until someone hand-curates each one.
// Sorted descending by length so the most specific match wins.
const findOpenAIPrefixMatch = (modelId: string): number | undefined => {
  const openai = CLOUD_TABLE['openai']
  if (!openai) return undefined
  const candidates = Object.keys(openai).sort((a, b) => b.length - a.length)
  for (const key of candidates) {
    if (modelId === key || (modelId.startsWith(`${key}-`) && /^\d{4}-\d{2}-\d{2}$/.test(modelId.slice(key.length + 1)))) return openai[key]
  }
  return undefined
}

// Synchronous best-effort lookup — hits the in-process cache and the curated
// CLOUD_TABLE only. Returns `unknown` when neither source has an entry, so
// callers can show capacity as unknown. Used by catalog/UI reads; Agent
// context selection obtains metadata through the actual routed provider.
export const getContextWindowSync = (providerName: string, modelId: string, opts: ContextLookupOptions = {}): ContextInfo => {
  const key = `${providerName}::${providerName === 'ollama' ? opts.ollamaBaseUrl ?? '' : ''}::${modelId}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.info
  const hard = CLOUD_TABLE[providerName]?.[modelId]
  if (hard) return { contextMax: hard, source: 'known_table' }
  // OpenAI-only longest-prefix fallback for dated variants. Other providers
  // either expose context via API (Ollama, OpenRouter) or have stable model
  // names that don't churn.
  if (providerName === 'openai') {
    const prefix = findOpenAIPrefixMatch(modelId)
    if (prefix) return { contextMax: prefix, source: 'known_table' }
  }
  return { contextMax: 0, source: 'unknown' }
}
