// ============================================================================
// First-boot identity seed. Rooms and AI Agents are created explicitly from
// Room Definitions or ordinary create Capabilities.
//
// Model resolution remains here because Room Definitions use the same live
// provider-aware default without duplicating provider policy.
// ============================================================================

import type { AgentsWorkspaceRuntime } from '../../main.ts'
import { resolveDefaultModel, type ProviderSnapshot } from '../../llm/models/default-resolver.ts'
import { CURATED_MODELS, DEFAULT_MODEL_ID } from '../../llm/models/catalog.ts'
import { resolveProviderAvailability } from '../../llm/provider-availability.ts'

// Build a minimal ProviderSnapshot[] from live AgentsWorkspaceRuntime state. Mirrors the
// subset of /api/routes/runtime.ts:/api/models that resolveDefaultModel needs.
// No /api/models HTTP call — that would self-trigger before the server has
// bound a port.
const buildProviderSnapshots = (system: AgentsWorkspaceRuntime): ReadonlyArray<ProviderSnapshot> => {
  const out: ProviderSnapshot[] = []
  const monitor = system.llm.getMonitorSnapshot()
  for (const name of system.providerConfig.order) {
    if (name === 'ollama') {
      const gw = system.ollama
      const m = monitor.ollama
      const available = gw?.getHealth().availableModels ?? []
      out.push({
        name: 'ollama',
        availability: resolveProviderAvailability(m, {
          fallbackSub: 'ok',
          modelCount: available.length,
          requireModels: true,
        }),
        models: available.map(id => ({ id })),
      })
      continue
    }
    const hasKey = system.providerKeys.get(name).length > 0
    const userEnabled = system.providerKeys.isUserEnabled(name)
    const m = monitor[name]
    // Curated order defines preference, but only provider-reported models are
    // routable. Do not seed an unavailable recommendation into a live system.
    const reportedIds = system.gateways[name]?.getHealth().availableModels ?? []
    const reportedSet = new Set(reportedIds)
    const curated = (CURATED_MODELS[name] ?? []).filter(c => reportedSet.has(c.id)).map(c => ({ id: c.id }))
    const reported = reportedIds.map(id => ({ id }))
    const seen = new Set<string>()
    const models: Array<{ id: string }> = []
    for (const m of [...curated, ...reported]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      models.push(m)
    }
    out.push({
      name,
      availability: resolveProviderAvailability(m, {
        fallbackSub: !userEnabled ? 'disabled' : !hasKey ? 'no_key' : 'ok',
        modelCount: models.length,
        requireModels: true,
      }),
      models,
    })
  }
  return out
}

export const resolveWorkspaceDefaultModel = (system: AgentsWorkspaceRuntime): string =>
  resolveDefaultModel(buildProviderSnapshots(system)) || DEFAULT_MODEL_ID

export const seedWorkspaceIdentity = async (system: AgentsWorkspaceRuntime): Promise<void> => {
  if (system.team.listByKind('human').some(actor => actor.name === 'You')) return
  await system.spawnHumanAgent({ name: 'You' }, () => { /* transport attaches when a user connects */ })
}
