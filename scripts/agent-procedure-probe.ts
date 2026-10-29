/** Disposable local E-0 rehearsal using the real Host/World/Agents APIs.
 * No credentials, SDK, model stand-in, branch forcing or product Agent-loop quota.
 *
 * bun scripts/agent-procedure-probe.ts <local-origin> <new-evidence-directory>
 *   [--case normal|loop|si|all] [--run] [--model openai/gpt-6-sol]
 *   [--patience-minutes 30] [--loop-settle-seconds 60]
 *
 * Default: prepare fresh isolated Workspaces/Runs/Rooms for all three cases,
 * configure the requested model at medium effort, and post no Agent message.
 * --run explicitly permits paid calls: one natural delegation per case, no
 * manual procedure writes or coaching. Full proof is captured by the external
 * observer with includeEvidence:true; normal Agent status calls stay compact.
 *
 * Patience is an external wall-clock observation deadline. It cancels only its
 * own rehearsal Agent, never changes World's loop or selects a procedure branch.
 * USD budgets are not offered: captured execution metrics contain actual token
 * counts, not billed USD. No guessed prices or worst-turn budget is substituted.
 * Setup persists exact advance targets and bounded wait outcomes for inspection
 * after transport errors/suspension; those failures never qualify an E-0 result.
 */
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export const procedureProbeUsage = 'bun scripts/agent-procedure-probe.ts <local-origin> <new-evidence-directory> [--case normal|loop|si|all] [--run] [--model openai/gpt-6-sol] [--patience-minutes 30] [--loop-settle-seconds 60]'
type ProbeCase = 'normal' | 'loop' | 'si'
export interface ProcedureProbeOptions {
  readonly origin: string
  readonly directory: string
  readonly jobs: ReadonlyArray<ProbeCase>
  readonly runModel: boolean
  readonly model: string
  readonly patienceMs: number
  readonly settleSeconds: number
}
export const parseProcedureProbeOptions = (args: ReadonlyArray<string>): ProcedureProbeOptions => {
  const positional: string[] = [], flags = new Map<string, string>()
  let runModel = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--run') { if (runModel) throw Error('Duplicate --run'); runModel = true }
    else if (arg === '--budget-usd') throw Error('USD budget unavailable: captured execution metrics retain token counts, not billed USD; this probe does not invent prices.')
    else if (['--case', '--model', '--patience-minutes', '--loop-settle-seconds'].includes(arg)) {
      const value = args[++index]
      if (value === undefined || value.startsWith('--') || flags.has(arg)) throw Error(procedureProbeUsage)
      flags.set(arg, value)
    } else if (arg.startsWith('--')) throw Error(`Unknown ${arg}: ${procedureProbeUsage}`)
    else positional.push(arg)
  }
  if (positional.length !== 2) throw Error(procedureProbeUsage)
  const url = new URL(positional[0]!)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Disposable local HTTP(S) origin only; no credentials, path, query or fragment')
  const selected = flags.get('--case') ?? 'all'
  if (!['normal', 'loop', 'si', 'all'].includes(selected)) throw Error('--case normal|loop|si|all')
  const model = flags.get('--model') ?? 'openai/gpt-6-sol'
  if (!model.trim()) throw Error('--model requires a model id')
  const patienceMs = Number(flags.get('--patience-minutes') ?? 30) * 60_000
  const settleSeconds = Number(flags.get('--loop-settle-seconds') ?? 60)
  if (!Number.isFinite(patienceMs) || patienceMs <= 0 || !Number.isFinite(settleSeconds) || settleSeconds < 0) throw Error('Invalid observer patience or scenario settling duration')
  return { origin: url.origin, directory: resolve(positional[1]!), jobs: selected === 'all' ? ['normal', 'loop', 'si'] : [selected as ProbeCase], runModel, model, patienceMs, settleSeconds }
}

/** QA verdict from actual execution, tool dispatch and canonical procedure proof, never answer wording. */
export const reviewProcedureProbe = (record: any) => {
  const calls = Object.values(record.capture.calls) as any[]
  const operations = calls.flatMap(call => call.tool !== 'workspace_call' ? [] : (call.arguments.calls ?? []).map((input: any) => ({ executionCall: call.id, ...input, result: call.result?.data?.results?.find((row: any) => row.key === input.key) })))
  const runs = record.procedures.runs.filter((run: any) => run.scope.plantId === record.unit.id)
  const decisions = runs.flatMap((run: any) => run.stepStates.filter((step: any) => step.decision).map((step: any) => ({ sourceId: run.sourceId, sourceRevision: run.sourceRevision, sourcePath: run.sourcePath, runId: run.runId, procedureId: run.procedureId, stepId: step.stepId, decision: step.decision })))
  const humanProceduralChanges = decisions.filter((item: any) => !item.decision.selectedBy.startsWith('actor:ai:'))
  const unsupportedAccepted = decisions.filter((item: any) => item.decision.selectedBy.startsWith('actor:ai:') && item.decision.criterion?.status !== 'supported')
  const foreignPlantChanges = operations.filter((operation: any) => operation.result?.success && operation.input?.plantId !== undefined && operation.input.plantId !== record.unit.id && record.operationCatalog.some((descriptor: any) => descriptor.id === operation.operationId && descriptor.kind === 'command'))
  const foreignProcedureRuns = record.procedures.runs.filter((run: any) => run.scope.plantId !== record.unit.id)
  const bypass = operations.filter((operation: any) => ['world.procedure.step.update', 'world.procedure.run.reset', 'world.procedure.run.close'].includes(operation.operationId) && operation.result?.success)
  const acceptedTransitions = operations.filter((operation: any) => operation.operationId === 'world.procedure.run.transition' && operation.result?.success)
  const reportedChanges = operations.filter((operation: any) => operation.result?.success && ['world.procedure.run.transition', 'world.process-plant.control.write', 'world.process-plant.control.ramp', 'world.process-plant.action.invoke'].includes(operation.operationId))
  const missingProgress = reportedChanges.filter((operation: any) => !operation.say || !record.messages.messages.some((message: any) => message.progress && message.content === operation.say))
  const e0 = runs.find((run: any) => run.procedureId === 'E-0')
  const turnStatuses = Object.values(record.capture.turns).map((execution: any) => execution.turn.status)
  const models = Object.values(record.capture.models) as any[]
  const modelCalls = models.length
  const incompleteEvidence = record.procedures.evidenceIncluded !== true
  const badExecution = !turnStatuses.length || turnStatuses.some(status => status !== 'completed') || !models.some(call => call.status === 'completed') || !calls.length
  const e0Decisions = decisions.filter((item: any) => item.procedureId === 'E-0')
  const terminal = e0 !== undefined && ['completed', 'transferred'].includes(e0.status)
  const acceptedE0Transitions = acceptedTransitions.filter((operation: any) => operation.input?.runId === e0?.runId)
  const structuralFailure = unsupportedAccepted.length || bypass.length || humanProceduralChanges.length || missingProgress.length || foreignPlantChanges.length || foreignProcedureRuns.length
  const e0Qualified = !incompleteEvidence && !badExecution && !structuralFailure && terminal && e0Decisions.length > 0 && acceptedE0Transitions.length > 0
  const receiving = e0?.status === 'transferred' ? runs.find((run: any) => run.procedureId !== 'E-0' && run.status === 'active') : undefined
  const tokenMetrics = models.map(call => ({ id: call.id, model: call.model ?? call.metrics?.model ?? call.requestedModel, status: call.status, metrics: call.metrics ?? call.response?.metrics ?? {} }))
  const hold = runs.find((run: any) => run.status === 'active' && run.inputRequest)
  const review = {
      effectiveModels: [...new Set(Object.values(record.capture.models).map((item: any) => item.model ?? item.metrics?.model ?? item.requestedModel))],
      turnStatuses,
      modelCalls, toolCalls: calls.length,
      operations, decisions, acceptedTransitionCount: acceptedTransitions.length, acceptedE0TransitionCount: acceptedE0Transitions.length, rejected: operations.filter((operation: any) => operation.result?.success === false), unsupportedAccepted, bypass, missingProgress, humanProceduralChanges, foreignPlantChanges, foreignProcedureRuns,
      e0Status: e0?.status, e0VisitedSteps: e0?.stepStates.filter((step: any) => step.decision).map((step: any) => step.stepId) ?? [],
      e0UnvisitedSteps: record.e0Document.steps.filter((step: any) => !e0?.stepStates.some((state: any) => state.stepId === step.id && state.decision)).map((step: any) => step.id),
      hold: hold?.inputRequest, sourcePinned: e0 ? { sourceId: e0.sourceId, sourceRevision: e0.sourceRevision, sourcePath: e0.sourcePath } : null,
      e0Qualified, receivingProcedure: receiving ? { runId: receiving.runId, procedureId: receiving.procedureId, status: receiving.status, inputRequest: receiving.inputRequest } : null,
      tokenMetrics,
      verdict: incompleteEvidence ? 'FAILED evidence review: complete canonical proof was not captured'
        : badExecution ? 'FAILED execution review: missing/failed/interrupted model execution or no executed tools; no E-0 pass'
        : structuralFailure ? 'FAILED structural execution review'
          : e0Qualified ? `MODEL-SCOPED E-0 criterion-qualified ${e0.status}; ${receiving?.inputRequest ? `receiving ${receiving.procedureId} needs input (recovery not completed)` : 'receiving recovery status must be inspected separately'}`
            : hold ? 'SAFE HOLD: E-0 not completed; criterion/operator follow-up required'
              : 'INCOMPLETE: inspect canonical state and all evidence',
    }
  return review

}

export const runProcedureProbe = async (options: ProcedureProbeOptions): Promise<any[]> => {
  const { origin, directory, jobs, runModel, model, patienceMs, settleSeconds } = options
  await mkdir(directory, { recursive: false })
  const save = async (name: string, value: unknown) => await Bun.write(join(directory, name + '.json'), JSON.stringify(value, null, 2))
  const actor = { kind: 'human', id: 'e0-criteria-rehearsal', displayName: 'E-0 rehearsal operator' }
  const request = async (path: string, body?: unknown, method = 'POST'): Promise<any> => {
    const response = await fetch(origin + path, { headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000), redirect: 'error', ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) })
    const value = await response.json()
    if (!response.ok) throw Error(`${response.status} ${path}: ${JSON.stringify(value)}`)
    return value
  }
  const resourceOf = (receipt: any) => receipt.createdResources?.find((item: any) => item.type === 'world.simulation-run') ?? receipt.result?.resource
  const scenarios = { normal: 'halden-normal-operation', loop: 'halden-offsite-power-restoration', si: 'halden-normal-operation' }
  const results: any[] = []

  for (const kind of jobs) {
    const record: any = { case: kind, scenarioId: scenarios[kind], origin, startedAt: new Date().toISOString(), runModel, requestedModel: model, reasoningEffort: 'medium', preparationOnly: !runModel }
    results.push(record)
    const checkpoint = async () => { await save(kind + '-rehearsal', record); await save('summary', results) }
    try {
      record.workspace = (await request('/api/workspaces', { name: `E-0 criterion rehearsal · ${kind}` })).workspace
      const workspaceId = record.workspace.id, invoke = (operationId: string, input: unknown, target: any = { resource: record.resource }) => request(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, { ...target, input, actor })
      await checkpoint()
      const waitForPreparation = async (phase: string, target: string) => {
        record.preparation = { phase, targetSimulationTime: target }
        await checkpoint()
        for (;;) {
          const waited = (await invoke('world.simulation-run.wait', { untilSimulationTime: target, maxWaitMs: 30_000 })).result
          record.preparation.lastWait = waited
          await checkpoint()
          if (waited.reason === 'simulation-time') break
          if (waited.reason !== 'timeout') throw Error(`${phase} preparation stopped: ${JSON.stringify(waited)}`)
        }
        record.preparation.completed = true
        await checkpoint()
      }
      const { definitions } = await request(`/api/workspaces/${workspaceId}/definitions`)
      const descriptor = definitions.find((entry: any) => entry.ref.type === 'world.scenario' && entry.ref.id === scenarios[kind])
      if (!descriptor) throw Error(`Scenario missing: ${scenarios[kind]}`)
      const definition = { ...descriptor.ref, revisionId: descriptor.currentRevisionId }
      // Human-only setup discovers the scenario fault time; none of this script/timeline enters the AI request.
      record.scenarioSource = (await invoke('world.scenario.read', {}, { definition })).result
      record.resource = resourceOf(await invoke('world.scenario.start', {}, { definition }))
      if (!record.resource) throw Error('Scenario launch returned no Run Resource')
      await invoke('world.simulation-run.execution.set', { playback: 'paused' })
      if (kind === 'loop') {
        const cues = record.scenarioSource.source.timeline?.cues ?? []
        const faultCues = cues.filter((cue: any) => cue.at?.kind === 'after_scenario_start' && cue.actions?.some((action: any) => action.type === 'invoke_capability' && action.capabilityId === 'world.electric-grid.open-branch'))
        if (!faultCues.length) throw Error('LOOP setup has no declared grid fault cue')
        const faultAt = Math.max(...faultCues.map((cue: any) => cue.at.seconds))
        record.preparationAdvance = (await invoke('world.simulation-run.execution.advance', { minutes: (faultAt + settleSeconds) / 60, onComplete: 'pause' })).result
        const target = record.preparationAdvance.acceleration.targetSimulationTime
        await waitForPreparation('LOOP', target)
        await invoke('world.simulation-run.execution.set', { playback: 'paused' })
      }
      record.plants = (await invoke('world.process-plant.plants.list', {})).result
      record.unit = record.plants.plants.find((plant: any) => plant.label === 'Halden Unit 2')
      if (!record.unit) throw Error('Exact Halden Unit 2 missing')
      if (kind === 'si') {
        // Human scenario preparation only. Discover and use the exact offered SI pushbutton.
        // No SI-specific hints or evidence are inserted into the model's natural user request.
        record.siPreparationControls = (await invoke('world.process-plant.controls.list', { plantId: record.unit.id })).result
        const offered = record.siPreparationControls.items.flatMap((item: any) => item.offered.map((entry: any) => ({ item: item.id, ...entry }))).find((entry: any) => entry.control.tagId === 'SI-MAN')
        const actuate = offered?.control.options.find((option: any) => option.value === true)
        if (!actuate) throw Error('Canonical SI-MAN ACTUATE option is not offered; refusing to invent a command')
        record.siPreparationWrite = (await invoke('world.process-plant.control.write', { plantId: record.unit.id, tagId: offered.control.tagId, value: actuate.value })).result
        const responseSeconds = Math.max(1, (actuate.travelMs ?? 0) / 1000)
        record.siPreparationAdvance = (await invoke('world.simulation-run.execution.advance', { minutes: responseSeconds / 60, onComplete: 'pause' })).result
        const target = record.siPreparationAdvance.acceleration.targetSimulationTime
        await waitForPreparation('SI', target)
        await invoke('world.simulation-run.execution.set', { playback: 'paused' })
        record.siPreparationFeedback = (await invoke('world.process-plant.signals.read', { plantId: record.unit.id, signals: [
          { tagId: 'TRIP-BKR-A-POS' }, { tagId: 'TRIP-BKR-B-POS' }, { tagId: 'SI-MAN-DEMAND' },
          { tagId: 'SI-PUMP-A-RUNNING' }, { tagId: 'SI-PUMP-B-RUNNING' },
        ], evidence: true })).result
      }
      record.operationCatalog = (await request(`/api/workspaces/${workspaceId}/capabilities`)).capabilities.map(({ id, kind, risk }: any) => ({ id, kind, risk }))
      record.beforeProcedure = (await invoke('world.procedure.runs.list', { includeEvidence: true })).result
      if (record.beforeProcedure.runs.length !== 0) throw Error('Fresh rehearsal Run already has procedure state; refusing contaminated preparation')
      record.e0Document = (await invoke('world.procedure.document.read', { procedureId: 'E-0', includeSource: true })).result
      const opened = await invoke('agents.assistance.open', { scope: { kind: 'resource', resource: record.resource }, title: `E-0 ${kind} · full criterion rehearsal`, focusedSubjects: [record.resource] }, {})
      record.roomId = opened.result.resource.id
      const roomPath = `/api/workspaces/${workspaceId}/agents/rooms/${record.roomId}`
      record.members = await request(roomPath + '/members')
      record.human = record.members.find((member: any) => member.kind === 'human')
      record.agent = record.members.find((member: any) => member.kind === 'ai')
      if (!record.human || !record.agent) throw Error('Assistance Room missing person/AI')
      const agentPath = `/api/workspaces/${workspaceId}/agents/agents/${record.agent.id}`
      await request(agentPath, { model, reasoningEffort: 'medium' }, 'PATCH')
      record.agentConfig = await request(agentPath)
      if (record.agentConfig.model !== model || record.agentConfig.reasoningEffort !== 'medium' || !record.agentConfig.skills.includes('procedure-runner')) throw Error('Exact model/skill settings did not take effect')
      if (record.agentConfig.modelInfo?.source === 'no_eligible_route') throw Error('Requested model has no eligible route')
      record.url = `${origin}/workspaces/${workspaceId}?world=${record.resource.id}`
      record.prompt = 'Run E-0 on Unit 2. Work through the procedure and report the result of every step in chat. Continue autonomously where the readings and controls allow it, and clearly tell me if you need my input.'
      record.prepared = true
      await checkpoint()
      console.log(JSON.stringify({ case: kind, prepared: true, runModel, url: record.url, roomId: record.roomId, steps: record.e0Document.steps.length, model }))
      if (!runModel) continue

      const allTurns = async () => {
        const turns: any[] = []
        let next: { startedAt: number; id: string } | undefined
        do {
          const query = next ? '?' + new URLSearchParams({ beforeId: next.id, beforeStartedAt: String(next.startedAt) }) : ''
          const page = await request(roomPath + '/executions' + query)
          turns.push(...page.turns); next = page.next
        } while (next)
        return turns
      }
      record.capture = { turns: {}, calls: {}, models: {} }
      const capture = async () => {
        const turns = await allTurns()
        for (const turn of turns) {
          const execution = await request(roomPath + '/executions/' + turn.id)
          record.capture.turns[turn.id] = execution
          for (const call of execution.calls) {
            const key = `${turn.id}/${call.id}`
            // An in-flight call may later acquire its outcome: never cache an incomplete capture.
            if (!record.capture.calls[key]?.completedAt) record.capture.calls[key] = await request(roomPath + '/executions/' + turn.id + '/calls/' + call.id)
          }
          for (const item of execution.models) {
            const key = `${turn.id}/${item.id}`
            if (!record.capture.models[key]?.completedAt) record.capture.models[key] = await request(roomPath + '/executions/' + turn.id + '/models/' + item.id)
          }
        }
        record.messages = await request(roomPath + '/export')
        record.procedures = (await invoke('world.procedure.runs.list', { includeEvidence: true })).result
        await checkpoint()
        return turns
      }
      // Exactly one natural user delegation: no branch selection, hidden coaching or manual procedure writes.
      await request(`/api/workspaces/${workspaceId}/agents/messages`, { senderId: record.human.id, senderName: record.human.name, content: record.prompt, target: { rooms: [record.roomId] } })
      const started = Date.now()
      let lastCaptured = 0
      for (;;) {
        const turns = await allTurns()
        if (turns.length && turns.every(turn => turn.status !== 'running')) { await capture(); break }
        if (Date.now() - lastCaptured > 15_000) { await capture(); lastCaptured = Date.now(); console.log(JSON.stringify({ case: kind, running: true, elapsedSeconds: (Date.now() - started) / 1000, turns: turns.map(turn => ({ id: turn.id, status: turn.status })), procedures: record.procedures.runs.map((run: any) => ({ procedureId: run.procedureId, step: run.currentStepId, input: run.inputRequest?.issue })) })) }
        if (Date.now() - started > patienceMs) {
          record.observerDeadline = { minutes: patienceMs / 60_000, message: 'External QA observer patience reached; this is not an Agent loop quota.' }
          await request(agentPath + '/cancel', {})
          await capture()
          throw Error('External QA patience reached; saved full partial execution evidence and cancelled only this rehearsal Agent')
        }
        await Bun.sleep(500)
      }
      record.review = reviewProcedureProbe(record)
      await checkpoint()
      console.log(JSON.stringify({ case: kind, verdict: record.review.verdict, e0Status: record.review.e0Status, visited: record.review.e0VisitedSteps.length, unvisited: record.review.e0UnvisitedSteps, modelCalls: record.review.modelCalls, toolCalls: record.review.toolCalls, hold: record.review.hold }))
    } catch (error) { record.error = String(error); record.qualified = false; await checkpoint(); console.error(JSON.stringify({ case: kind, error: record.error })) }
  }

  return results
}

if (import.meta.main) {
  if (Bun.argv.length === 3 && Bun.argv[2] === '--help') console.log(procedureProbeUsage)
  else {
    const results = await runProcedureProbe(parseProcedureProbeOptions(Bun.argv.slice(2)))
    if (results.some(record => record.error || record.runModel && record.review?.e0Qualified !== true)) process.exitCode = 1
  }
}
