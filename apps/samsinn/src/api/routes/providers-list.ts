// GET /providers — provider status list (never returns raw keys).
//
// Combines the on-disk providers store, env-var fallback (mergeWithEnv),
// and the live monitor snapshot into a stable shape the UI renders
// top-to-bottom in router order.

import { json } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import {
  loadProviderStore, mergeWithEnv,
} from '../../llm/providers-store.ts'
import {
  PROVIDER_PROFILES, type CloudProviderName, isLocal,
} from '../../llm/providers-config.ts'
import type { MonitorState, FailureRecord } from '../../llm/provider-monitor.ts'
import { resolveProviderAvailability } from '../../llm/provider-availability.ts'

interface ProviderStatusEntry {
  readonly name: string
  readonly kind: 'cloud' | 'ollama'
  readonly keyMask: string
  readonly source: 'env' | 'stored' | 'none'
  readonly enabled: boolean            // effective (has key AND userEnabled)
  readonly userEnabled: boolean        // user intent, independent of key
  readonly hasKey: boolean
  // Local providers (llamacpp): URL-configurable, no key required. UI uses
  // this flag to render a URL field instead of a key field on the row.
  readonly isLocal: boolean
  readonly baseUrl?: string
  readonly maxConcurrent: number | null
  readonly availability: MonitorState
  readonly recentFailures: ReadonlyArray<FailureRecord>
}

export const providersListRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/providers$/,
    handler: async (_req, _match, { system }) => {
      const { data: store, warnings } = await loadProviderStore(system.providersStorePath)
      const merged = mergeWithEnv(store)
      const monitorSnap = system.llm.getMonitorSnapshot()
      const monitors = system.monitors ?? {}
      const activeOrder = system.llm.getOrder()
      const orderLockedByEnv = !!process.env.PROVIDER_ORDER

      const byName = new Map<string, ProviderStatusEntry>()

      for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
        const m = merged.cloud[name]
        if (!m) continue
        // Read hasKey from the in-memory registry (the same source the
        // monitor and gateway use) so the UI never reports green when the
        // chat path would fail, or gray when the registry has a key.
        const hasKey = system.providerKeys.get(name).length > 0
        const userEnabled = system.providerKeys.isUserEnabled(name)
        const monState = monitorSnap[name] ?? null
        const failures = monitors[name]?.getRecentFailures() ?? []
        const local = isLocal(name)
        byName.set(name, {
          name, kind: 'cloud',
          keyMask: m.maskedKey,
          source: m.source,
          hasKey,
          isLocal: local,
          ...(local ? { baseUrl: m.baseUrl ?? PROVIDER_PROFILES[name].baseUrl } : {}),
          userEnabled,
          // Local providers are "enabled" once user-enabled — no key required.
          enabled: local ? userEnabled : (hasKey && userEnabled),
          maxConcurrent: m.maxConcurrent ?? PROVIDER_PROFILES[name].defaultMaxConcurrent,
          availability: resolveProviderAvailability(monState, {
            fallbackSub: !userEnabled ? 'disabled' : (!hasKey && !local) ? 'no_key' : 'ok',
            requireModels: local,
          }),
          recentFailures: failures,
        })
      }

      // Ollama — no key concept, but still has a user-enabled toggle.
      const ollamaUserEnabled = merged.ollama.enabled
      const ollamaMon = monitorSnap.ollama ?? null
      const ollamaFailures = monitors.ollama?.getRecentFailures() ?? []
      byName.set('ollama', {
        name: 'ollama', kind: 'ollama',
        keyMask: '',
        source: 'none',
        hasKey: true,
        isLocal: true,
        userEnabled: ollamaUserEnabled,
        enabled: ollamaUserEnabled,
        maxConcurrent: merged.ollama.maxConcurrent ?? 2,
        availability: resolveProviderAvailability(ollamaMon, {
          fallbackSub: ollamaUserEnabled ? 'ok' : 'disabled',
          requireModels: true,
        }),
        recentFailures: ollamaFailures,
      })

      // Emit in router order so the UI can just render top-to-bottom.
      const entries: ProviderStatusEntry[] = []
      for (const name of activeOrder) {
        const entry = byName.get(name)
        if (entry) entries.push(entry)
      }

      return json({
        providers: entries,
        activeOrder,
        orderLockedByEnv,
        droppedFromOrder: system.providerConfig.droppedFromOrder,
        forceFailProvider: system.providerConfig.forceFailProvider,
        storeWarnings: warnings,
      })
    },
  },
]
