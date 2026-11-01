/** Manual, staged real-service qualification. Every invocation owns a fresh
 * Workspace, paused Run and Assistant. Default prepares only; --run explicitly
 * permits one paid delegation. Never reads credentials or changes defaults.
 *
 * --review-usd cancels the test-owned Agent after observed reported charges
 * reach that amount. It is NOT a hard cap: an in-flight call or unreported
 * charge may exceed it. Review each saved case before starting the next.
 */
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { MessageAttachment } from '../apps/agents/src/core/types/messaging.ts'

export const qualificationCases = {
  'single-value': 'What is the current generator electrical output of Unit 2? Give the value and unit from live evidence. Do not change anything.',
  'unit-sitrep': 'Give me a concise current sitrep of Unit 2, including electrical output and material operational concerns, using live evidence. Do not change anything.',
  'whole-sitrep': 'Give me a concise sitrep of the whole Halden situation: all four nuclear units and their shared electric grid. Use live evidence, distinguish actual problems from unknowns, and do not change anything.',
  'cross-pack-display': 'Show one live composed display combining the shared Halden electric grid and process vignettes for Units 2 and 3, so I can compare their generation and electrical supply. Do not change the simulation.',
  'cross-pack-diagram': 'Show one live display with actual process diagrams for Units 2 and 3 and a diagram of their shared Halden switchyard and grid connections. I want to see equipment and connections, with live generation and supply information, rather than only lists of values or trends. Do not change the simulation.',
  'exact-control': 'Trip the reactor on Unit 3 only. Discover the offered control, execute it, allow the simulation to respond, and verify actual feedback. Do not operate the other units. Report the result.',
  'procedure-takeover': 'I started E-0 on Unit 2 and have handed it back. Take over the existing procedure and continue through its first supported step only, reporting the result in chat, then release it back to me. Preserve the existing procedure run and source; do not reset, restart or close it.',
  'sustained-monitoring': 'Run the model-scoped E-0 on Unit 2, then continue through the receiving ES-0.1 task into secondary-cooling monitoring. Complete 600 simulation seconds of source-required sampled monitoring after entering that monitoring step, including its recorded reviews and five-minute episode decisions. Report every procedure step in chat. Continue autonomously where current evidence and offered controls support it; request my input clearly if actually needed. Preserve the reference distinction, protection and assigned duties. At the end leave the Run paused and release the procedure back to me; do not reset, close it or claim continuous stability or recovery beyond the model-scoped evidence.',
  'checkpoint-recall': 'Read Unit 2 generator electrical output from live evidence. Separately obtain its signal definition so you can explain what it measures. At that boundary create a working-context checkpoint retaining the definition and archiving the earlier reading. Retrieve the exact archived result with conversation_read using its turnId, toolCallId and part: result, and report the original value, unit and meaning. Do not take a replacement reading or change the simulation. This is an archive-recall qualification test.',
  'image-read': 'Look only at the attached Inspector screenshot. What model-call count does it show, and what does its offline/provider connection label say? Do not infer these from the current simulation or use tools to obtain substitute data.',
  cancellation: 'Read the current simulation clock, then use the simulation wait capability to wait until one minute after that reading. Leave playback and pace as they are; do not advance or change them yourself. I will cancel your wait externally. Do not substitute a wall-clock sleep or claim the time passed.',
} as const
export type QualificationCase = keyof typeof qualificationCases
export interface QualificationOptions {
  readonly origin: string; readonly directory: string; readonly model: string
  readonly caseId: QualificationCase; readonly runModel: boolean
  readonly effort: string | null; readonly patienceMs: number; readonly reviewUsd: number
  readonly image?: string
}
export const parseQualificationOptions = (args: ReadonlyArray<string>): QualificationOptions => {
  const flags = new Map<string, string>(); let runModel = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!
    if (key === '--run') { if (runModel) throw Error('Duplicate --run'); runModel = true; continue }
    if (!['--origin', '--out', '--model', '--case', '--effort', '--patience-minutes', '--review-usd', '--image'].includes(key) || flags.has(key)) throw Error(`Unknown or duplicate option ${key}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`)
    flags.set(key, value)
  }
  for (const required of ['--origin', '--out', '--model', '--case']) if (!flags.has(required)) throw Error(`Required ${required}`)
  const url = new URL(flags.get('--origin')!)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Origin must be HTTP(S), without credentials, path, query or fragment')
  const caseId = flags.get('--case')! as QualificationCase
  if (!Object.hasOwn(qualificationCases, caseId)) throw Error(`Unknown qualification case ${caseId}`)
  if ((caseId === 'image-read') !== flags.has('--image')) throw Error('Only image-read requires --image PNG path')
  const patienceMs = Number(flags.get('--patience-minutes') ?? '5') * 60_000
  const reviewUsd = Number(flags.get('--review-usd') ?? '1')
  if (!Number.isFinite(patienceMs) || patienceMs <= 0 || !Number.isFinite(reviewUsd) || reviewUsd <= 0) throw Error('Positive finite observer patience and spend review required')
  const model = flags.get('--model')!
  if (model.trim() !== model || !model) throw Error('Exact nonempty model required')
  return { origin: url.origin, directory: resolve(flags.get('--out')!), model, caseId, runModel,
    effort: !flags.has('--effort') || flags.get('--effort') === 'default' ? null : flags.get('--effort')!, patienceMs, reviewUsd,
    ...(flags.has('--image') ? { image: resolve(flags.get('--image')!) } : {}) }
}

export const qualificationBilling = (models: ReadonlyArray<any>) => ({
  knownCostUsd: models.reduce((sum, model) => sum + (typeof model.metrics?.costUsd === 'number' && Number.isFinite(model.metrics.costUsd) && model.metrics.costUsd >= 0 ? model.metrics.costUsd : 0), 0),
  unknownCalls: models.filter(model => model.status !== 'running' && !(typeof model.metrics?.costUsd === 'number' && Number.isFinite(model.metrics.costUsd) && model.metrics.costUsd >= 0)).length,
  runningCalls: models.filter(model => model.status === 'running').length,
})

export const runQualification = async (options: QualificationOptions): Promise<any> => {
  const { origin, directory, model, caseId } = options
  // Refuse existing evidence before making even a preparation request.
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const record: any = { ...options, startedAt: new Date().toISOString(), prompt: qualificationCases[caseId], capture: { turns: {}, calls: {}, models: {} } }
  const save = () => Bun.write(join(directory, 'capture.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
  const request = async (path: string, body?: unknown, method = 'POST'): Promise<any> => {
    const response = await fetch(origin + path, { headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(120_000),
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw Error(`${response.status} ${path}: ${text.slice(0, 1200)}`)
    return JSON.parse(text)
  }
  let agentPath: string | undefined
  let paidStarted = false
  let captureCurrent: (() => Promise<any[]>) | undefined
  let pauseOwnedRun: (() => Promise<any>) | undefined
  const cancelAndSettle = async (reason: string) => {
    if (!agentPath || !captureCurrent) throw Error('Cannot settle cancellation without owned Agent and capture')
    record.cancellationRequestedAt = Date.now()
    record.cancellationReason = reason
    await save()
    record.cancellation = await request(agentPath + '/cancel', {})
    record.cancellationAcknowledgedAt = Date.now()
    const deadline = Date.now() + options.patienceMs
    for (;;) {
      const turns = await captureCurrent()
      if (turns.length && turns.every(turn => turn.status !== 'running') && qualificationBilling(Object.values(record.capture.models)).runningCalls === 0) {
        record.cancellationSettledAt = Date.now()
        const identities = Object.keys(record.capture.models).sort()
        const toolIdentities = Object.keys(record.capture.calls).sort()
        await Bun.sleep(2_000)
        await captureCurrent()
        record.quietWindowNoNewDispatch = JSON.stringify(identities) === JSON.stringify(Object.keys(record.capture.models).sort())
          && JSON.stringify(toolIdentities) === JSON.stringify(Object.keys(record.capture.calls).sort())
        record.dispatchesAfterCancellationAck = [...Object.values(record.capture.models), ...Object.values(record.capture.calls)]
          .filter((call: any) => call.startedAt > record.cancellationAcknowledgedAt).map((call: any) => ({ id: call.id, startedAt: call.startedAt }))
        await save()
        paidStarted = false
        return
      }
      if (Date.now() >= deadline) throw Error('Cancellation did not settle within external observer patience')
      await Bun.sleep(500)
    }
  }
  try {
    record.workspaceId = (await request('/api/workspaces', { name: `Model qualification · ${caseId} · ${model}` })).workspace.id
    await save()
    const wp = `/api/workspaces/${record.workspaceId}`
    const invoke = async (operationId: string, input: unknown, target: any = { resource: record.resource }) => {
      const receipt = await request(`${wp}/capabilities/${operationId}/invoke`, { ...target, input, actor: { kind: 'human', id: 'model-qualification', displayName: 'Model qualification observer' } })
      if (receipt.result === undefined) throw Error(`No result from ${operationId}`)
      return receipt
    }
    record.operationCatalog = (await request(wp + '/capabilities')).capabilities.map(({ id, kind, risk }: any) => ({ id, kind, risk }))
    const definition = (await request(wp + '/definitions')).definitions.find((entry: any) => entry.ref.moduleId === 'world' && entry.ref.id === 'halden-normal-operation')
    if (!definition) throw Error('Published normal-operation scenario absent')
    record.definition = { ...definition.ref, revisionId: definition.currentRevisionId }
    const launched = await invoke('world.scenario.start', {}, { definition: record.definition })
    record.resource = launched.createdResources?.find((entry: any) => entry.type === 'world.simulation-run') ?? launched.result?.resource
    if (!record.resource) throw Error('No Simulation Run returned')
    await save()
    await invoke('world.simulation-run.execution.set', { playback: 'paused' })
    pauseOwnedRun = () => invoke('world.simulation-run.execution.set', { playback: 'paused' })
    if (caseId === 'procedure-takeover') {
      record.humanProcedureStart = await invoke('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId: 'plant:halden-2' } })
      const before = (await invoke('world.procedure.runs.list', { includeEvidence: true })).result
      record.originalProcedure = before.runs.find((run: any) => run.procedureId === 'E-0' && run.scope.plantId === 'plant:halden-2')
      if (!record.originalProcedure) throw Error('Human-started procedure absent')
      record.humanClaim = await invoke('world.procedure.run.drive', { runId: record.originalProcedure.runId, action: 'claim' })
      record.humanRelease = await invoke('world.procedure.run.drive', { runId: record.originalProcedure.runId, action: 'release' })
    }
    const observe = async () => {
      const plants = (await invoke('world.process-plant.plants.list', {})).result
      const signals: Record<string, unknown> = {}
      for (const plant of plants.plants) signals[plant.id] = (await invoke('world.process-plant.signals.read', { plantId: plant.id,
        signals: ['GEN-MW', 'RX-TRIP-MAN-DEMAND', 'TRIP-BKR-A-POS', 'TRIP-BKR-B-POS'].map(tagId => ({ tagId })), evidence: true, operations: true })).result
      return { execution: (await invoke('world.simulation-run.execution.read', {})).result, plants, signals,
        procedures: (await invoke('world.procedure.runs.list', { includeEvidence: true })).result }
    }
    record.observedBefore = await observe()
    const resources = (await request(wp + '/resources?moduleId=world')).resources
    const run = resources.find((item: any) => item.ref.type === record.resource.type && item.ref.id === record.resource.id)
    const family = run?.links.find((link: any) => link.rel === 'member-of' && link.ref.type === 'world.run-family')?.ref
    if (!family) throw Error('Scenario Run has no owning family')
    record.family = family
    const opened = await invoke('agents.assistance.open', { scope: { kind: 'collection', collection: family, members: { mode: 'all', except: [] } }, title: `Qualification · ${caseId} · ${model}`, focusedSubjects: [record.resource] }, {})
    if (opened.result.reused) throw Error('Fresh qualification unexpectedly reused an Assistant Room')
    record.roomId = opened.result.resource.id
    const roomPath = `${wp}/agents/rooms/${record.roomId}`
    const members = await request(roomPath + '/members')
    record.agent = members.find((member: any) => member.kind === 'ai')
    record.human = members.find((member: any) => member.kind === 'human')
    if (!record.agent || !record.human) throw Error('Missing Assistant participants')
    agentPath = `${wp}/agents/agents/${record.agent.id}`
    record.profileBefore = await request(agentPath)
    const routedModel = model.startsWith('openrouter:') ? model : `openrouter:${model}`
    await request(agentPath, { model: routedModel, reasoningEffort: options.effort }, 'PATCH')
    record.profile = await request(agentPath)
    if (record.profile.model !== routedModel || (record.profile.reasoningEffort ?? null) !== options.effort) throw Error('Exact model settings not applied')
    if (record.profile.modelInfo?.source === 'no_eligible_route') throw Error('No eligible model route')
    record.url = `${origin}/workspaces/${record.workspaceId}?world=${record.resource.id}`
    record.preparedAt = new Date().toISOString()
    await save()
    console.log(JSON.stringify({ caseId, prepared: true, runModel: options.runModel, model, url: record.url, directory }))
    if (!options.runModel) return record

    const allTurns = async () => {
      const turns: any[] = []; let next: any
      do {
        const query = next ? '?' + new URLSearchParams({ beforeId: next.id, beforeStartedAt: String(next.startedAt) }) : ''
        const page = await request(roomPath + '/executions' + query)
        turns.push(...page.turns); next = page.next
      } while (next)
      return turns
    }
    if ((await allTurns()).length) throw Error('Fresh Room contains prior execution')
    const capture = async () => {
      const turns = await allTurns()
      for (const turn of turns) {
        const execution = await request(`${roomPath}/executions/${turn.id}`)
        record.capture.turns[turn.id] = execution
        for (const call of execution.calls) {
          const key = `${turn.id}/${call.id}`
          if (!record.capture.calls[key]?.completedAt) record.capture.calls[key] = await request(`${roomPath}/executions/${turn.id}/calls/${call.id}`)
        }
        // Public Inspector evidence suffices for qualification; opaque protocol remains private in the service.
        for (const call of execution.models) {
          const key = `${turn.id}/${call.id}`
          if (!record.capture.models[key]?.completedAt) record.capture.models[key] = await request(`${roomPath}/executions/${turn.id}/models/${call.id}`)
        }
      }
      record.billing = qualificationBilling(Object.values(record.capture.models))
      record.messages = await request(roomPath + '/export')
      record.observedAt = new Date().toISOString()
      await save()
      return turns
    }
    captureCurrent = capture
    let attachments: MessageAttachment[] | undefined
    if (options.image) {
      const bytes = Buffer.from(await Bun.file(options.image).arrayBuffer())
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('Image fixture must be a PNG')
      record.image = { path: options.image, sha256: createHash('sha256').update(bytes).digest('hex'), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      attachments = [{ kind: 'image', mimeType: 'image/png', width: record.image.width, height: record.image.height,
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, source: 'user-upload', capturedAt: (await Bun.file(options.image).stat()).mtime.getTime() }]
    }
    record.sendStartedAt = new Date().toISOString(); await save()
    // A paused clock legitimately refuses a future-time wait immediately.
    // Start only this test-owned clock so the wait actually remains pending;
    // the observer pauses it again after cancellation, including on failure.
    if (caseId === 'cancellation') record.observerClockStart = await invoke('world.simulation-run.execution.set', { playback: 'playing' })
    paidStarted = true
    record.receipt = await request(wp + '/agents/messages', { senderId: record.human.id, senderName: record.human.name, content: record.prompt, target: { rooms: [record.roomId] }, ...(attachments ? { attachments } : {}) })
    await save()
    const started = Date.now()
    for (;;) {
      const turns = await capture()
      const terminal = turns.length > 0 && turns.every(turn => turn.status !== 'running')
      const models = Object.values(record.capture.models) as any[]
      const expected = model.replace(/^openrouter:/, '')
      const substituted = models.some(call => call.status === 'completed' && (call.model !== expected || call.metrics?.provider !== 'openrouter'))
        || Object.values(record.capture.turns).some((execution: any) => execution.stages.some((stage: any) => stage.event.kind === 'model_fallback'))
      if (terminal) {
        if (substituted) throw Error('Actual serving model/provider substituted; result disqualified')
        break
      }
      const pendingWait = Object.values(record.capture.calls).find((call: any) => call.completedAt === undefined
        && call.tool === 'workspace_call' && call.arguments.calls?.some((operation: any) => operation.operationId === 'world.simulation-run.wait')) as any
      if (caseId === 'cancellation' && pendingWait) {
        record.cancelledWaitCall = pendingWait.id
        await cancelAndSettle('Planned cancellation while the actual simulation wait is pending')
        break
      }
      const stopReason = substituted ? 'Actual serving model/provider substituted; inspect before spending more.'
        : record.billing.unknownCalls > 0 ? 'A completed or failed model call has unknown billing; inspect before spending more.'
        : record.billing.knownCostUsd >= options.reviewUsd ? 'Observed spend review threshold reached; not a hard billing cap.'
          : Date.now() - started >= options.patienceMs ? 'External observer patience reached.' : undefined
      if (stopReason) {
        record.observerStop = { reason: stopReason, at: new Date().toISOString() }; await save()
        await cancelAndSettle(stopReason)
        throw Error(stopReason)
      }
      await Bun.sleep(2_000)
    }
    paidStarted = false
    if (record.observerClockStart) record.observerClockPause = await pauseOwnedRun!()
    record.observedAfter = await observe()
    record.effectiveModels = [...new Set(Object.values(record.capture.models).map((call: any) => call.model ?? call.metrics?.model))]
    record.finishedAt = new Date().toISOString()
    await save()
    console.log(JSON.stringify({ caseId, model, billing: record.billing, turns: Object.values(record.capture.turns).map((entry: any) => ({ id: entry.turn.id, status: entry.turn.status })), modelCalls: Object.keys(record.capture.models).length, toolCalls: Object.keys(record.capture.calls).length, directory }))
    return record
  } catch (error) {
    record.error = String(error)
    if (paidStarted && agentPath) {
      try { await cancelAndSettle(record.error) }
      catch (cancelError) { record.cancellationError = String(cancelError) }
    }
    await save()
    throw error
  } finally {
    if (record.observerClockStart && !record.observerClockPause && pauseOwnedRun) {
      try { record.observerClockPause = await pauseOwnedRun() }
      catch (error) { record.observerClockPauseError = String(error) }
      await save()
    }
  }
}

if (import.meta.main) await runQualification(parseQualificationOptions(Bun.argv.slice(2)))
