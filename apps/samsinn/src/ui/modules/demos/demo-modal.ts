// ============================================================================
// Demo modal — a new launch creates and selects a dedicated room, then shows
// the blurb + clickable prompt rows. Click a row → post the prompt as the
// current human. The 🎬 header icon re-opens the modal in that same room.
// ============================================================================

import { createModal } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'
import { send } from '../ws-send.ts'
import { $selectedRoomId, $selectedAgentId, $rooms, $agents, $roomMembers, $selectedHumanByRoom } from '../stores.ts'
import { updateLeitbildPanelForRoom } from '../leitbild-iframe-panel.ts'
import { icon } from '../icon.ts'
import { getDemo, type Demo, type DemoAgentSpec, type DemoPrompt, type LeitbildDemoSetup } from './catalog.ts'
import { $activeDemoByRoom } from './active-demo-store.ts'

interface DedicatedDemoRoom {
  readonly id: string
  readonly name: string
}

// Every new demo launch gets an isolated room. This prevents stale script
// state, unrelated agents, delivery settings, and old messages from changing
// the demo. The currently selected human follows the user into the room so
// click-to-send prompts work immediately.
const createDedicatedDemoRoom = async (demo: Demo): Promise<DedicatedDemoRoom | undefined> => {
  const previousRoomId = $selectedRoomId.get()
  const preferredHumanId = previousRoomId
    ? $selectedHumanByRoom.get()[previousRoomId]
    : undefined
  let createdRoomName: string | undefined

  try {
    const agentsRes = await fetch('/api/agents', { credentials: 'same-origin' })
    if (!agentsRes.ok) throw new Error(`could not list agents (${agentsRes.status})`)
    const agentList = await agentsRes.json() as ReadonlyArray<{ id: string; name: string; kind: 'ai' | 'human' }>
    const human = agentList.find(a => a.id === preferredHumanId && a.kind === 'human')
      ?? agentList.find(a => a.kind === 'human' && a.name === 'You')
      ?? agentList.find(a => a.kind === 'human')

    const create = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name: `Demo: ${demo.title}`, createdBy: 'demo-launcher' }),
    })
    if (!create.ok) throw new Error(`could not create room: ${await parseErrorResponse(create)}`)
    const created = await create.json() as {
      value?: { profile?: { id?: unknown; name?: unknown } }
    }
    const id = created.value?.profile?.id
    const name = created.value?.profile?.name
    if (typeof id !== 'string' || typeof name !== 'string') {
      throw new Error('room creation returned no room identity')
    }
    createdRoomName = name

    let demoHuman = human
    if (demoHuman) {
      const add = await fetch(`/api/rooms/${encodeURIComponent(name)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ agentName: demoHuman.name }),
      })
      if (!add.ok) throw new Error(`could not add ${demoHuman.name}: ${await parseErrorResponse(add)}`)
    } else {
      const existingNames = new Set(agentList.map(a => a.name))
      let humanName = 'Demo User'
      let suffix = 2
      while (existingNames.has(humanName)) humanName = `Demo User ${suffix++}`
      const addHuman = await fetch('/api/agents/human', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: humanName, roomName: name }),
      })
      if (!addHuman.ok) throw new Error(`could not create demo user: ${await parseErrorResponse(addHuman)}`)
      const body = await addHuman.json() as { id?: unknown; name?: unknown }
      if (typeof body.id !== 'string' || typeof body.name !== 'string') {
        throw new Error('demo user creation returned no identity')
      }
      demoHuman = { id: body.id, name: body.name, kind: 'human' }
      $agents.setKey(demoHuman.id, { ...demoHuman, state: 'idle' })
    }

    // Mirror the already-authoritative REST results immediately. Matching WS
    // events may arrive before or after these writes; setKey is idempotent.
    $rooms.setKey(id, { id, name })
    $roomMembers.setKey(id, [demoHuman.id])
    $selectedHumanByRoom.setKey(id, demoHuman.id)
    $selectedAgentId.set(null)
    $selectedRoomId.set(id)
    createdRoomName = undefined
    return { id, name }
  } catch (err) {
    if (createdRoomName) {
      try {
        await fetch(`/api/rooms/${encodeURIComponent(createdRoomName)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        })
      } catch { /* best-effort rollback of this launch's empty room */ }
    }
    showToast(
      document.body,
      `Could not create demo room: ${err instanceof Error ? err.message : String(err)}`,
      { type: 'error', position: 'fixed', durationMs: 10000 },
    )
    return undefined
  }
}

// Post `content` as if the user typed it in chat. Mirrors the same
// resolution logic the chat form uses (sender = last-picked human for
// the room, or the sole human if exactly one is present). Returns false
// with a toast when prerequisites aren't met.
const sendAsCurrentHuman = (content: string): boolean => {
  const roomId = $selectedRoomId.get()
  if (!roomId) {
    showToast(document.body, 'Open a room first to try a demo prompt.', { type: 'error', position: 'fixed' })
    return false
  }
  const roomName = $rooms.get()[roomId]?.name
  if (!roomName) return false

  const members = $roomMembers.get()[roomId] ?? []
  const agents = $agents.get()
  const memberAgents = members.map(id => agents[id]).filter((a): a is NonNullable<typeof a> => !!a)
  const humans = memberAgents.filter(a => a.kind === 'human')
  const ais = memberAgents.filter(a => a.kind === 'ai')

  if (humans.length === 0) {
    showToast(document.body, 'This room has no human member to post as. Add one in the room members panel.', { type: 'error', position: 'fixed', durationMs: 8000 })
    return false
  }
  if (ais.length === 0) {
    showToast(document.body, 'No AI in this room — the prompt will post, but no agent will reply. Add an AI from the room members panel.', { type: 'error', position: 'fixed', durationMs: 8000 })
    // Continue anyway — the user explicitly clicked the demo prompt.
  }

  let senderId = $selectedHumanByRoom.get()[roomId]
  if (!senderId) {
    if (humans.length === 1) {
      senderId = humans[0]!.id
      $selectedHumanByRoom.setKey(roomId, senderId)
    } else {
      showToast(document.body, 'Multiple humans in this room — pick one with the send-as control, then click the prompt again.', { type: 'error', position: 'fixed', durationMs: 8000 })
      return false
    }
  }

  send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId })
  return true
}

const buildPromptRow = (demo: Demo, entry: DemoPrompt, onSent: () => void): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.className = 'w-full text-left px-3 py-2 mb-2 rounded border border-border bg-surface hover:bg-surface-strong'
  btn.title = entry.prompt ?? entry.description

  const label = document.createElement('div')
  label.className = 'text-sm font-semibold text-text'
  label.textContent = entry.label

  const desc = document.createElement('div')
  desc.className = 'text-xs text-text-subtle mt-0.5'
  desc.textContent = entry.description

  btn.appendChild(label)
  btn.appendChild(desc)
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.classList.add('opacity-60', 'cursor-wait')
    const completed = await executeDemoPrompt(demo, entry)
    if (completed) onSent()
    else {
      btn.disabled = false
      btn.classList.remove('opacity-60', 'cursor-wait')
    }
  })
  return btn
}

// Ensure the demo packs are merged into the selected demo room's active set.
// Awaited so the user can't click a prompt before activation lands and
// hit "no tools available." Returns true iff activation succeeded (or
// was a no-op because packs were already active).
const ensureRoomPacks = async (roomId: string, packs: ReadonlyArray<string>): Promise<boolean> => {
  if (packs.length === 0) return true
  const roomName = $rooms.get()[roomId]?.name
  if (!roomName) return false
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/packs`)
    if (!res.ok) return false
    const data = await res.json() as { activePacks?: ReadonlyArray<string> }
    const current = new Set(data.activePacks ?? [])
    let changed = false
    for (const p of packs) {
      if (!current.has(p)) { current.add(p); changed = true }
    }
    if (!changed) return true
    const put = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/packs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activePacks: [...current] }),
    })
    return put.ok
  } catch {
    return false
  }
}

interface LeitbildSelectResponse {
  readonly id?: string
  readonly workspaceId?: string
  readonly created?: boolean
  readonly reused?: boolean
  readonly scenarioId?: string
  readonly systemIds?: ReadonlyArray<string>
}

interface LeitbildSelectOk {
  readonly ok: true
  readonly workspaceId: string
  readonly created: boolean
  readonly systemIds: ReadonlyArray<string>
}

interface LeitbildModelUpdate {
  readonly agentName: string
  readonly from: string
  readonly to: string
}

interface LeitbildSetupOk extends LeitbildSelectOk {
  readonly modelUpdates: ReadonlyArray<LeitbildModelUpdate>
}

interface LeitbildSetupFail {
  readonly ok: false
  readonly reason: string
}

interface DemoModelProvider {
  readonly name: string
  readonly status: 'ok' | 'no_key' | 'cooldown' | 'down'
  readonly models: ReadonlyArray<{ readonly id: string }>
}

interface DemoModelCatalog {
  readonly providers: ReadonlyArray<DemoModelProvider>
  readonly defaultModel: string
}

const parseErrorResponse = async (res: Response): Promise<string> => {
  try {
    const body = await res.json() as { error?: unknown }
    return typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

const fetchDemoModelCatalog = async (): Promise<DemoModelCatalog | undefined> => {
  try {
    const res = await fetch('/api/models', { credentials: 'same-origin' })
    if (!res.ok) {
      console.warn(`[demos] Could not load model catalog for demo setup: HTTP ${res.status}`)
      return undefined
    }
    const body = await res.json() as { providers?: unknown; defaultModel?: unknown }
    const rawProviders = Array.isArray(body.providers) ? body.providers : []
    const providers: DemoModelProvider[] = []
    for (const p of rawProviders) {
      if (!p || typeof p !== 'object') continue
      const r = p as { name?: unknown; status?: unknown; models?: unknown }
      if (typeof r.name !== 'string') continue
      if (r.status !== 'ok' && r.status !== 'no_key' && r.status !== 'cooldown' && r.status !== 'down') continue
      const models = Array.isArray(r.models)
        ? r.models
          .map(m => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string') ? { id: (m as { id: string }).id } : undefined)
          .filter((m): m is { readonly id: string } => m !== undefined)
        : []
      providers.push({ name: r.name, status: r.status, models })
    }
    const defaultModel = typeof body.defaultModel === 'string' ? body.defaultModel.trim() : ''
    return { providers, defaultModel }
  } catch (err) {
    console.warn(`[demos] Could not load model catalog for demo setup: ${(err as Error).message}`)
    return undefined
  }
}

const parseModelRef = (modelRef: string): { readonly provider?: string; readonly modelId: string } => {
  const idx = modelRef.indexOf(':')
  if (idx <= 0) return { modelId: modelRef }
  return { provider: modelRef.slice(0, idx), modelId: modelRef.slice(idx + 1) }
}

const modelIsRoutable = (modelRef: string, catalog: DemoModelCatalog): boolean => {
  const trimmed = modelRef.trim()
  if (!trimmed) return false
  const parsed = parseModelRef(trimmed)
  return catalog.providers.some(p =>
    p.status === 'ok' &&
    (!parsed.provider || p.name === parsed.provider) &&
    p.models.some(m => m.id === parsed.modelId))
}

const rescueModelForDemo = (currentModel: string | undefined, catalog: DemoModelCatalog | undefined): string | undefined => {
  if (!catalog || !catalog.defaultModel) return undefined
  const current = currentModel?.trim()
  if (current) {
    if (modelIsRoutable(current, catalog)) return undefined
  }
  if (!modelIsRoutable(catalog.defaultModel, catalog)) return undefined
  return catalog.defaultModel
}

const selectLeitbildInstance = async (setup: LeitbildDemoSetup): Promise<LeitbildSelectOk | LeitbildSetupFail> => {
  try {
    const res = await fetch('/api/leitbild-proxy/control-instances/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        baseUrl: setup.baseUrl,
        preferredScenarioId: setup.preferredScenarioId,
        candidateScenarioIds: setup.candidateScenarioIds,
        requiredPackId: setup.requiredPackId,
        requiredQueryKind: setup.requiredQueryKind,
        probePayload: setup.probePayload,
      }),
    })
    if (!res.ok) return { ok: false, reason: `Failed to select Leitbild Control Instance: ${await parseErrorResponse(res)}` }
    const body = await res.json() as LeitbildSelectResponse
    const workspaceId = body.workspaceId ?? body.id
    if (!workspaceId) return { ok: false, reason: 'Leitbild selection returned no instance id' }
    return {
      ok: true,
      workspaceId,
      created: body.created === true,
      systemIds: Array.isArray(body.systemIds) ? body.systemIds.filter((v): v is string => typeof v === 'string') : [],
    }
  } catch (err) {
    return { ok: false, reason: `Could not reach Samsinn Leitbild proxy: ${(err as Error).message}` }
  }
}

// Leitbild demo setup: select or create a CI that satisfies the demo's
// declared pack/query probe, bind the current room's mirror to it, and
// patch any AI agents in the room to add a matching leitbildBinding plus
// the demo's tool allowlist. If no AI is in the room, the mirror still
// works and the iframe shows; the user just won't get agent answers until
// they add an AI member.
const setupLeitbildDemo = async (
  roomId: string,
  setup: LeitbildDemoSetup,
  onlyAgentNames?: ReadonlySet<string>,
): Promise<LeitbildSetupOk | LeitbildSetupFail> => {
  const roomName = $rooms.get()[roomId]?.name
  if (!roomName) return { ok: false, reason: 'Room not found' }

  // 1. Select an existing readable CI or create a fresh one via the
  //    Samsinn-side proxy (avoids CORS; Leitbild declares no direct browser
  //    access in its manifest).
  const selected = await selectLeitbildInstance(setup)
  if (selected.ok === false) return selected

  // 2. Bind the room mirror
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/leitbild-mirror`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ baseUrl: setup.baseUrl, workspaceId: selected.workspaceId, format: 'summary' }),
    })
    if (!res.ok) return { ok: false, reason: `Failed to bind room mirror: HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, reason: `Bind error: ${(err as Error).message}` }
  }

  // 3. PATCH any AI members of the room with leitbildBinding + lb_* tools.
  const members = $roomMembers.get()[roomId] ?? []
  const agents = $agents.get()
  const ais: ReadonlyArray<{ readonly name: string; readonly model?: string }> = onlyAgentNames
    ? [...onlyAgentNames].map(name => ({ name }))
    : members
      .map(id => agents[id])
      .filter((a): a is NonNullable<typeof a> => !!a && a.kind === 'ai')
      .map(a => ({ name: a.name, model: a.model }))
  const modelCatalog = ais.length > 0 ? await fetchDemoModelCatalog() : undefined
  const modelUpdates: LeitbildModelUpdate[] = []
  for (const ai of ais) {
    try {
      // Fetch current tools so we don't overwrite the agent's allowlist.
      const detailRes = await fetch(`/api/agents/${encodeURIComponent(ai.name)}`, { credentials: 'same-origin' })
      const detail = detailRes.ok
        ? await detailRes.json() as { model?: string; tools?: ReadonlyArray<string> }
        : { model: ai.model, tools: [] as string[] }
      const existingTools = new Set(detail.tools ?? [])
      for (const t of setup.agentTools) existingTools.add(t)
      const currentModel = typeof detail.model === 'string' ? detail.model : ai.model
      const rescueModel = rescueModelForDemo(currentModel, modelCatalog)
      const patchBody: {
        tools: string[]
        leitbildBinding: { baseUrl: string; workspaceId: string; role: 'observer' }
        model?: string
      } = {
        tools: [...existingTools],
        leitbildBinding: { baseUrl: setup.baseUrl, workspaceId: selected.workspaceId, role: 'observer' },
        ...(rescueModel ? { model: rescueModel } : {}),
      }
      const patchRes = await fetch(`/api/agents/${encodeURIComponent(ai.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patchBody),
      })
      if (patchRes.ok && rescueModel && currentModel && currentModel !== rescueModel) {
        modelUpdates.push({ agentName: ai.name, from: currentModel, to: rescueModel })
      }
    } catch (err) {
      console.warn(`[demos] Non-fatal Leitbild agent setup failure for ${ai.name}: ${(err as Error).message}`)
    }
  }

  return { ...selected, modelUpdates }
}

// Best-effort: install an external pack if it isn't already present.
// Biometrics demo uses this for `samsinn-packs/biometrics`. Awaited so
// the room-pack-activation step (which only succeeds if the pack is
// already known) finds it.
const ensurePackInstalled = async (packShortName: string, registryFullName: string): Promise<void> => {
  try {
    const res = await fetch('/api/packs')
    if (!res.ok) return
    const data = await res.json() as { packs?: ReadonlyArray<{ namespace: string }> }
    const installed = (data.packs ?? []).some(p => p.namespace === packShortName)
    if (installed) return
    await fetch('/api/packs/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: registryFullName }),
    })
  } catch { /* non-fatal — modal still opens; tool calls will surface a clearer error */ }
}

interface CreatedDemoAgents {
  readonly ok: true
  readonly names: ReadonlyArray<string>
}

interface DemoActionFailure {
  readonly ok: false
  readonly reason: string
}

const createDemoAgents = async (
  roomId: string,
  roomName: string,
  specs: ReadonlyArray<DemoAgentSpec>,
): Promise<CreatedDemoAgents | DemoActionFailure> => {
  const catalog = await fetchDemoModelCatalog()
  if (!catalog?.defaultModel || !modelIsRoutable(catalog.defaultModel, catalog)) {
    return { ok: false, reason: 'No routable default model is available for demo agents' }
  }
  const model = catalog.defaultModel

  let existingNames: Set<string>
  try {
    const res = await fetch('/api/agents', { credentials: 'same-origin' })
    if (!res.ok) return { ok: false, reason: `Could not list agents: HTTP ${res.status}` }
    const body = await res.json() as ReadonlyArray<{ name?: unknown }>
    existingNames = new Set(body.flatMap(a => typeof a.name === 'string' ? [a.name] : []))
  } catch (err) {
    return { ok: false, reason: `Could not list agents: ${(err as Error).message}` }
  }

  const names: string[] = []
  for (const spec of specs) {
    let name = spec.name
    let suffix = 2
    while (existingNames.has(name)) name = `${spec.name}${suffix++}`
    existingNames.add(name)

    try {
      const create = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name,
          model,
          persona: spec.persona,
          ...(spec.tools ? { tools: spec.tools } : {}),
          ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
        }),
      })
      if (!create.ok) return { ok: false, reason: `Could not create ${name}: ${await parseErrorResponse(create)}` }
      const createdAgent = await create.json() as { id?: unknown; name?: unknown }
      if (typeof createdAgent.id !== 'string' || typeof createdAgent.name !== 'string') {
        return { ok: false, reason: `Agent creation returned no identity for ${name}` }
      }

      const add = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ agentName: name }),
      })
      if (!add.ok) return { ok: false, reason: `Created ${name}, but could not add it to the room: ${await parseErrorResponse(add)}` }

      // Do not depend on websocket event ordering. Leitbild setup and prompt
      // sending both inspect these stores immediately after this function.
      $agents.setKey(createdAgent.id, {
        id: createdAgent.id,
        name: createdAgent.name,
        kind: 'ai',
        model,
        state: 'idle',
      })
      const members = $roomMembers.get()[roomId] ?? []
      if (!members.includes(createdAgent.id)) {
        $roomMembers.setKey(roomId, [...members, createdAgent.id])
      }
      names.push(createdAgent.name)
    } catch (err) {
      return { ok: false, reason: `Could not set up ${name}: ${(err as Error).message}` }
    }
  }
  return { ok: true, names }
}

const setRoomDeliveryMode = async (roomName: string, mode: 'broadcast' | 'manual'): Promise<DemoActionFailure | { readonly ok: true }> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/delivery-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ mode }),
    })
    return res.ok ? { ok: true } : { ok: false, reason: `Could not set ${mode} mode: ${await parseErrorResponse(res)}` }
  } catch (err) {
    return { ok: false, reason: `Could not set ${mode} mode: ${(err as Error).message}` }
  }
}

const setRoomPaused = async (roomName: string, paused: boolean): Promise<boolean> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/pause`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ paused }),
    })
    return res.ok
  } catch {
    return false
  }
}

const executeDemoPrompt = async (demo: Demo, entry: DemoPrompt): Promise<boolean> => {
  const roomId = $selectedRoomId.get()
  const roomName = roomId ? $rooms.get()[roomId]?.name : undefined
  if (!roomId || !roomName) {
    showToast(document.body, 'Open a room first to run this demo.', { type: 'error', position: 'fixed' })
    return false
  }

  const action = entry.action
  if (!action) {
    if (!entry.prompt) {
      showToast(document.body, 'This demo action has no prompt.', { type: 'error', position: 'fixed' })
      return false
    }
    return sendAsCurrentHuman(entry.prompt)
  }

  if (action.kind === 'start-script') {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/script/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ scriptName: action.scriptName }),
      })
      if (!res.ok) {
        showToast(document.body, `Could not start script: ${await parseErrorResponse(res)}`, { type: 'error', position: 'fixed', durationMs: 10000 })
        return false
      }
      showToast(document.body, 'Structured control-room script started. Follow the living document in the right rail.', { type: 'success', position: 'fixed', durationMs: 8000 })
      return true
    } catch (err) {
      showToast(document.body, `Could not start script: ${(err as Error).message}`, { type: 'error', position: 'fixed', durationMs: 10000 })
      return false
    }
  }

  const created = await createDemoAgents(roomId, roomName, action.agents)
  if (created.ok === false) {
    showToast(document.body, created.reason, { type: 'error', position: 'fixed', durationMs: 10000 })
    return false
  }

  if (action.kind === 'spawn-grounded') {
    if (!demo.leitbildSetup) {
      showToast(document.body, 'Grounded demo has no Leitbild setup.', { type: 'error', position: 'fixed' })
      return false
    }
    const setup = await setupLeitbildDemo(roomId, demo.leitbildSetup, new Set(created.names))
    if (setup.ok === false) {
      showToast(document.body, `Leitbild setup failed: ${setup.reason}`, { type: 'error', position: 'fixed', durationMs: 10000 })
      return false
    }
    const prompt = entry.prompt?.replaceAll('{{agent}}', created.names[0] ?? '')
    if (!prompt || !sendAsCurrentHuman(prompt)) return false
    const roomForPanel = $rooms.get()[roomId]?.name
    if (roomForPanel) void updateLeitbildPanelForRoom(roomForPanel, roomId)
    showToast(document.body, `${created.names.join(', ')} created and connected read-only to Leitbild.`, { type: 'success', position: 'fixed', durationMs: 8000 })
    return true
  }

  const mode = await setRoomDeliveryMode(roomName, 'broadcast')
  if (mode.ok === false) {
    showToast(document.body, mode.reason, { type: 'error', position: 'fixed', durationMs: 10000 })
    return false
  }
  await setRoomPaused(roomName, false)
  if (!entry.prompt || !sendAsCurrentHuman(entry.prompt)) return false
  showToast(document.body, `${created.names.length} agents created. Broadcast discussion will auto-pause after ${Math.round(action.autoPauseAfterMs / 1000)} seconds.`, { type: 'success', position: 'fixed', durationMs: 8000 })
  window.setTimeout(() => {
    void setRoomPaused(roomName, true).then(paused => {
      if (paused) showToast(document.body, 'Unstructured demo paused automatically. Inspect the cross-talk, then unpause manually if you want more.', { type: 'success', position: 'fixed', durationMs: 10000 })
    })
  }, action.autoPauseAfterMs)
  return true
}

export const openDemoModal = async (
  demoId: string,
  options: { readonly reuseCurrentRoom?: boolean } = {},
): Promise<void> => {
  const demo = getDemo(demoId)
  if (!demo) {
    showToast(document.body, `Unknown demo: ${demoId}`, { type: 'error', position: 'fixed' })
    return
  }

  let roomId = $selectedRoomId.get()
  if (!options.reuseCurrentRoom) {
    const dedicated = await createDedicatedDemoRoom(demo)
    if (!dedicated) return
    roomId = dedicated.id
  } else if (!roomId) {
    showToast(document.body, 'The demo room is no longer available.', { type: 'error', position: 'fixed' })
    return
  }
  if (!roomId) return

  // Side-effects: install biometrics if needed, then merge required packs
  // into the dedicated room's active set so the tools become visible to the
  // AI BEFORE the user can click a prompt. Order matters: pack must be
  // installed before activation can succeed.
  if (demo.id === 'biometrics') {
    await ensurePackInstalled('biometrics', 'samsinn-packs/biometrics')
  }
  const activated = await ensureRoomPacks(roomId, demo.requiredPacks)
  if (!activated) {
    showToast(document.body, `Couldn't activate required packs (${demo.requiredPacks.join(', ')}) — the AI may not see this demo's tools.`, { type: 'error', position: 'fixed', durationMs: 8000 })
  }

  // Script/spawn actions create their own cast when clicked. Plain-prompt
  // demos previously borrowed whatever AI happened to be in the room; a
  // dedicated room therefore needs one purpose-built guide up front.
  if (!options.reuseCurrentRoom && demo.prompts.some(prompt => !prompt.action)) {
    const roomName = $rooms.get()[roomId]?.name
    if (!roomName) {
      showToast(document.body, 'The new demo room could not be resolved.', { type: 'error', position: 'fixed' })
      return
    }
    const created = await createDemoAgents(roomId, roomName, [{
      name: `${demo.title} Guide`,
      persona: [
        `You are the dedicated facilitator for the "${demo.title}" demonstration.`,
        'Follow the prompt the user selects, use the available demo tools when they are relevant, and report tool evidence clearly and concisely.',
        'For nuclear-domain material, act as a training and reference assistant—not as real-time operational authority.',
      ].join(' '),
      tools: demo.requiredTools,
    }])
    if (created.ok === false) {
      showToast(document.body, `Could not create the demo guide: ${created.reason}`, { type: 'error', position: 'fixed', durationMs: 10000 })
      return
    }
  }

  if (demo.id === 'leitbild') {
    if (!demo.leitbildSetup) {
      showToast(document.body, 'Leitbild demo setup is missing from the catalog.', { type: 'error', position: 'fixed', durationMs: 10000 })
      return
    }
    const setup = await setupLeitbildDemo(roomId, demo.leitbildSetup)
    if (setup.ok === false) {
      showToast(document.body, `Leitbild demo setup failed: ${setup.reason}`, { type: 'error', position: 'fixed', durationMs: 10000 })
      return
    }
    // Inform the user — and warn if no AI to consume the agent tools.
    const aiCount = ($roomMembers.get()[roomId] ?? [])
      .map(id => $agents.get()[id])
      .filter(a => !!a && a.kind === 'ai').length
    const aiHint = aiCount > 0
      ? `${aiCount} AI agent${aiCount > 1 ? 's' : ''} configured with Leitbild + procedure tools.`
      : 'Add an AI agent to this room (from room members panel) so it can use the Leitbild + procedure tools — then try the prompts.'
    const modelHint = setup.modelUpdates.length > 0
      ? ` Model rescue applied: ${setup.modelUpdates.map(u => `${u.agentName} ${u.from}→${u.to}`).join(', ')}.`
      : ''
    const action = setup.created ? 'created' : 'reused'
    const systems = setup.systemIds.length > 0 ? ` · systems: ${setup.systemIds.slice(0, 3).join(', ')}` : ''
    showToast(document.body, `Leitbild ${action}: ${setup.workspaceId.slice(0, 36)}…${systems} · ${aiHint}${modelHint}`, { type: 'success', position: 'fixed', durationMs: 10000 })
    // Refresh the iframe panel for the current room — it was last evaluated
    // when the room was selected (before the mirror existed), so the toggle
    // button is currently hidden. Re-evaluate so it appears.
    const roomName = $rooms.get()[roomId]?.name
    if (roomName) void updateLeitbildPanelForRoom(roomName, roomId)
  }

  $activeDemoByRoom.setKey(roomId, demo.id)

  const modal = createModal({ title: demo.title, width: 'max-w-2xl' })

  const blurb = document.createElement('p')
  blurb.className = 'text-sm text-text mb-3'
  blurb.textContent = demo.blurb
  modal.scrollBody.appendChild(blurb)

  const hint = document.createElement('div')
  hint.className = 'text-xs text-text-subtle mb-2'
  hint.textContent = 'Click any prompt to post it as you in this dedicated demo room:'
  modal.scrollBody.appendChild(hint)

  const onSent = (): void => { modal.close() }
  for (const p of demo.prompts) {
    modal.scrollBody.appendChild(buildPromptRow(demo, p, onSent))
  }

  document.body.appendChild(modal.overlay)
}

// === Room-header icon ============================================================
// Keep a 🪄 entry point in every open room. With no pinned demo it opens the
// picker; once a demo is pinned it re-opens that demo directly.

const HEADER_ICON_ID = 'demo-header-icon'

const buildHeaderIcon = (demo?: Demo): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.id = HEADER_ICON_ID
  btn.setAttribute('data-room-icon-id', 'demo')
  btn.setAttribute('data-room-icon-label', 'Demo')
  btn.className = 'mode-btn icon-btn'
  btn.dataset.demoId = demo?.id ?? ''
  const title = demo ? `Open ${demo.title}` : 'Browse demos'
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.appendChild(icon('wand', { size: 16, title }))
  btn.addEventListener('click', () => {
    if (demo) void openDemoModal(demo.id, { reuseCurrentRoom: true })
    else void import('./index.ts').then(m => m.openDemosNavPicker())
  })
  return btn
}

export const refreshDemoHeaderIcon = (): void => {
  const roomId = $selectedRoomId.get()
  // Room header layout: `#room-header > div(name) + div(icon-cluster)` with
  // `justify-between`. Append into the icon cluster (second child) so the
  // existing right-aligned cluster keeps its layout. Appending to
  // `#room-header` directly adds a third flex child and the name/cluster
  // pair collapses to centered.
  const cluster = document.querySelector('#room-header > div:nth-child(2)') as HTMLElement | null
  if (!cluster) return
  const existingGroup = document.getElementById(`${HEADER_ICON_ID}-group`)
  const removeIcon = (): void => { existingGroup?.remove() }
  if (!roomId) { removeIcon(); return }
  const demoId = $activeDemoByRoom.get()[roomId]
  const demo = demoId ? getDemo(demoId) : undefined
  const existingButton = existingGroup?.querySelector(`#${HEADER_ICON_ID}`) as HTMLButtonElement | null
  if (existingButton?.dataset.demoId === (demo?.id ?? '')) return
  existingGroup?.remove()
  // Append as a new toolbar-group at the end of the icon cluster so the
  // wand sits to the right of the Summary group, with a divider.
  const group = document.createElement('div')
  group.className = 'toolbar-group toolbar-divider'
  group.id = `${HEADER_ICON_ID}-group`
  group.appendChild(buildHeaderIcon(demo))
  cluster.appendChild(group)
}
