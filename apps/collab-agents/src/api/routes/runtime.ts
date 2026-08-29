import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { MonitorState } from '../../llm/provider-monitor.ts'
import { resolveProviderAvailability } from '../../llm/provider-availability.ts'

export const runtimeRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    handler: (_req, _match, { system }) => {
      const health = system.ollama?.getHealth()
      return json({
        status: 'ok',
        ollama: health ? health.status !== 'down' : false,
        ollamaStatus: health?.status ?? 'unconfigured',
        ollamaLatencyMs: health?.latencyMs ?? 0,
        providers: system.providerConfig.order,
        rooms: system.rooms.listAllRooms().length,
        agents: system.team.listAgents().length,
      })
    },
  },
  // Cross-cutting deployment/runtime reads live here rather than inside a
  // Room or Workspace settings adapter.
  {
    method: 'GET',
    pattern: /^\/models$/,
    handler: async (_req, _match, { system }) => {
      // Structured response grouped by provider, with per-model metadata
      // (context window, running flag, recommended flag). Consumed by the
      // UI's model-selection dropdown.
      try {
        const { CURATED_MODELS, isCuratedModel } =
          await import('../../llm/models/catalog.ts')
        const { resolveDefaultModel } = await import('../../llm/models/default-resolver.ts')
        const { PROVIDER_PROFILES, isLocal } = await import('../../llm/providers-config.ts')
        const { getContextWindowSync } = await import('../../llm/models/context-window.ts')
        const { loadProviderStore, mergeWithEnv } = await import('../../llm/providers-store.ts')

        const { data: storeData } = await loadProviderStore(system.providersStorePath)
        const merged = mergeWithEnv(storeData)

        const monitor = system.llm.getMonitorSnapshot()
        const providers: Array<{
          name: string
          availability: MonitorState
          models: Array<{ id: string; contextMax: number; recommended: boolean; pinned?: boolean; running?: boolean; label?: string }>
        }> = []

        // Cloud providers, in router order (so UI shows them in priority order)
        for (const name of system.providerConfig.order) {
          if (name === 'ollama') continue
          const gw = system.gateways[name]
          const hasKey = system.providerKeys.get(name).length > 0
          const userEnabled = system.providerKeys.isUserEnabled(name)
          const m = monitor[name]

          const reported = gw?.getHealth().availableModels ?? []
          const reportedSet = new Set(reported)
          const curated = CURATED_MODELS[name] ?? []
          const pinnedList = merged.cloud[name as keyof typeof merged.cloud]?.pinnedModels ?? []
          const pinnedSet = new Set(pinnedList)

          // Merge order:
          //   1. Curated models (defines the system default)
          //   2. User-pinned models not already curated
          //   3. Everything else the provider reported
          const seen = new Set<string>()
          const models: typeof providers[number]['models'] = []
          const curatedLabel: Record<string, string | undefined> = {}
          for (const c of curated) curatedLabel[c.id] = c.label

          for (const c of curated) {
            if (seen.has(c.id) || !reportedSet.has(c.id)) continue
            seen.add(c.id)
            const ctx = getContextWindowSync(name, c.id)
            models.push({
              id: c.id,
              contextMax: ctx.contextMax,
              recommended: true,
              ...(pinnedSet.has(c.id) ? { pinned: true } : {}),
              ...(c.label ? { label: c.label } : {}),
            })
          }
          for (const id of pinnedList) {
            if (seen.has(id) || !reportedSet.has(id)) continue
            seen.add(id)
            const ctx = getContextWindowSync(name, id)
            models.push({
              id,
              contextMax: ctx.contextMax,
              recommended: true,
              pinned: true,
              ...(curatedLabel[id] ? { label: curatedLabel[id] } : {}),
            })
          }
          for (const id of reported) {
            if (seen.has(id)) continue
            const ctx = getContextWindowSync(name, id)
            models.push({ id, contextMax: ctx.contextMax, recommended: false, pinned: pinnedSet.has(id) })
          }
          providers.push({
            name,
            availability: resolveProviderAvailability(m, {
              fallbackSub: !userEnabled ? 'disabled' : (!hasKey && !isLocal(name)) ? 'no_key' : 'ok',
              modelCount: models.length,
              requireModels: true,
            }),
            models,
          })
          void PROVIDER_PROFILES
        }

        // Ollama: running vs on-disk. "recommended" = running.
        if (system.ollama) {
          const [running, all] = await Promise.all([
            (system.ollama.runningModels?.() ?? Promise.resolve([] as string[])).catch(() => [] as string[]),
            system.ollama.models().catch(() => [] as string[]),
          ])
          const runSet = new Set(running)
          const ollamaMon = monitor.ollama ?? null
          // All Ollama models are "recommended" — they're local and free, so
          // there's no reason to hide them behind "show all". Running models
          // just get an extra star.
          const models = all.map(id => {
            const ctx = getContextWindowSync('ollama', id)
            return {
              id, contextMax: ctx.contextMax,
              recommended: true,
              running: runSet.has(id),
            }
          })
          providers.push({
            name: 'ollama',
            availability: resolveProviderAvailability(ollamaMon, {
              fallbackSub: merged.ollama.enabled ? 'ok' : 'disabled',
              modelCount: models.length,
              requireModels: true,
            }),
            models,
          })
        }

        // Default model pick — delegated to the pure resolver so the same logic
        // can be reused by per-call effective-model resolution in agent eval.
        // The resolver only sees available providers as candidates.
        const defaultModel = resolveDefaultModel(providers)

        void isCuratedModel

        return json({ providers, defaultModel })
      } catch (err) {
        console.error('/models error:', err)
        return json({ providers: [], defaultModel: '' })
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/ollama\/urls$/,
    handler: (_req, _match, { system }) =>
      json({ current: system.ollamaUrls.getCurrent(), saved: system.ollamaUrls.list() }),
  },
  {
    method: 'PUT',
    pattern: /^\/ollama\/urls$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (typeof body.url === 'string') {
        system.ollamaUrls.setCurrent(body.url)
        return json({ current: system.ollamaUrls.getCurrent(), saved: system.ollamaUrls.list() })
      }
      return errorResponse('url is required')
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/ollama\/urls$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (typeof body.url === 'string') {
        if (body.url === system.ollamaUrls.getCurrent()) return errorResponse('Cannot delete the active URL')
        system.ollamaUrls.remove(body.url)
        return json({ saved: system.ollamaUrls.list() })
      }
      return errorResponse('url is required')
    },
  },
]
