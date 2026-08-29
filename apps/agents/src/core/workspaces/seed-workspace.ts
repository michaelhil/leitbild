// ============================================================================
// seedWorkspace — first-boot seed for a fresh Workspace.
//
// Creates room "Cafe" (broadcast mode) with one AI ("Aiden") and one Human
// ("You"). Replaces the prior welcome-scenario seed path. Plain TS — no
// scenario engine, no markdown parser, no ops.
//
// The AI's model is the current curated default (via resolveDefaultModel
// against live provider state). If nothing qualifies — fresh boot before any
// provider key is set — we still spawn the agent with 'gpt-5.4' as the
// preferred model; the per-call effective-model resolver in agent eval will
// swap it out for whatever's available once the user adds a key. This keeps
// the snapshot stable across "no key → key added" transitions.
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

export const seedWorkspace = async (system: AgentsWorkspaceRuntime): Promise<void> => {
  // Idempotency: if a Cafe already exists (e.g. re-seed call), bail.
  const existing = system.rooms.listAllRooms().some(p => p.name === 'Cafe')
  if (existing) return

  const model = resolveDefaultModel(buildProviderSnapshots(system)) || DEFAULT_MODEL_ID

  // Room first so spawned agents have something to join.
  const room = system.rooms.createRoom({ name: 'Cafe', createdBy: 'system' })

  // AI: Aiden — a friendly default companion. No tool whitelist → sees every
  // tool active in the room (pack-aware filter at the call site).
  const aiden = await system.spawnAIAgent({
    name: 'Aiden',
    model,
    persona: 'You are Aiden, a friendly and curious assistant. You help the user explore what this system can do — answer questions directly, call tools when useful, and keep replies concise.',
  })
  await system.addAgentToRoom(aiden.id, room.profile.id, 'seed')

  // Human: "You" — the seat the connecting user will adopt on first connect.
  // The transport `send` is a no-op until a real WS attaches via the
  // adoptHuman path; spawnHumanAgent installs it lazily.
  const you = await system.spawnHumanAgent({ name: 'You' }, () => { /* no transport yet */ })
  await system.addAgentToRoom(you.id, room.profile.id, 'seed')
}
