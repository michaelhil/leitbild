/** Manual, real-service evaluation of AI-composed operator displays. Creates
 * only its own Workspace and Runs. Each scenario copies a paused Halden Run,
 * optionally injects a Pack-declared fault on Unit 2, advances simulated time,
 * asks a fresh Assistant Room one question and records what it presented.
 *
 *   bun scripts/agent-display-probe.ts <stage> <absolute-output-dir> [scenario-id ...]
 *
 * Uses the configured production Assistant and provider; never reads
 * credentials. LEITBILD_PROBE_ORIGIN selects another deployment. Results are
 * generated evidence for review, not fixtures or a statistical benchmark.
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

interface Scenario {
  readonly id: string
  readonly prompt: string
  readonly expect: 'display' | 'none'
  readonly fault?: { readonly actionId: string; readonly parameters?: Record<string, unknown> }
  /** Simulated minutes played after the fault, so the situation has developed. */
  readonly advanceMinutes?: number
  /** Any of these tags or paths in an accepted composition counts as on-topic. */
  readonly keySignals?: ReadonlyArray<string>
  readonly keyPanel?: 'trend' | 'comparison' | 'readouts' | 'alarms'
}

const scenarios: ReadonlyArray<Scenario> = [
  { id: 'sg-b-runback', fault: { actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 } }, advanceMinutes: 3, expect: 'display',
    prompt: 'Unit 2: SG B level looks off. What is going on and what should I watch?', keySignals: ['SG-B-LVL-NR', 'sgB.levelPercent'] },
  { id: 'porv-open', fault: { actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, advanceMinutes: 2, expect: 'display',
    prompt: 'Unit 2 pressurizer pressure is dropping. What is happening and is it getting worse?', keySignals: ['PT-455', 'PZR-LVL'] },
  { id: 'sg-a-tube-leak', fault: { actionId: 'steam-generator-tube-leak-a', parameters: { leakPercent: 1.2 } }, advanceMinutes: 3, expect: 'display',
    prompt: 'We have secondary radiation indications on Unit 2. Assess the situation.', keySignals: ['SG-A-N16', 'SG-A-TUBE-LEAK'] },
  { id: 'loss-main-feedwater', fault: { actionId: 'loss-main-feedwater' }, advanceMinutes: 2, expect: 'display',
    prompt: 'Unit 2 lost main feedwater. What should I monitor right now?', keySignals: ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-C-LVL-NR', 'SG-D-LVL-NR'] },
  { id: 'rcp-trip', fault: { actionId: 'trip-reactor-coolant-pumps' }, advanceMinutes: 1, expect: 'display',
    prompt: 'All reactor coolant pumps tripped on Unit 2. Is core cooling holding?', keySignals: ['TAVG', 'RCP-A-FLOW', 'SUB-MARGIN', 'TE-411-HOT'] },
  { id: 'turbine-trip', fault: { actionId: 'turbine-trip' }, advanceMinutes: 1, expect: 'display',
    prompt: 'Unit 2 turbine tripped. What do I need to watch over the next minutes?', keySignals: ['SG-A-PRESS', 'SG-B-PRESS', 'PT-455', 'TAVG', 'GEN-MW'] },
  { id: 'loss-offsite-power', fault: { actionId: 'loss-offsite-power' }, advanceMinutes: 1, expect: 'display',
    prompt: 'Unit 2 lost offsite power. What is the state of its electrical supply and what should I watch?', keySignals: ['BUS-A-VOLTAGE', 'EDG-A-RUN', 'BUS-B-VOLTAGE', 'EDG-B-RUN'] },
  { id: 'power-stable', advanceMinutes: 1, expect: 'display',
    prompt: 'Is reactor power on Unit 2 stable over the last few minutes?', keySignals: ['core.powerMw', 'NIS-PR', 'GEN-MW'] },
  { id: 'compare-sg-levels', advanceMinutes: 1, expect: 'display', keyPanel: 'comparison',
    prompt: 'Compare the four steam generator levels on Unit 2.', keySignals: ['SG-A-LVL-NR', 'SG-B-LVL-NR'] },
  { id: 'show-tavg', advanceMinutes: 1, expect: 'display',
    prompt: 'Show me Unit 2 average coolant temperature over the last 10 minutes.', keySignals: ['TAVG'] },
  { id: 'single-value', advanceMinutes: 1, expect: 'none', prompt: 'What is the current pressurizer pressure on Unit 2?' },
  { id: 'explanation', expect: 'none', prompt: 'Briefly explain what the pressurizer spray does in this model.' },
  { id: 'text-only', advanceMinutes: 1, expect: 'none', prompt: 'Give me Unit 2 status in one sentence, text only please.' },
  { id: 'product-question', expect: 'none', prompt: 'What is a reference design in Leitbild?' },
]

const [stage, directory, ...selected] = Bun.argv.slice(2)
if (!stage || !/^[a-z0-9-]+$/.test(stage) || !directory || !isAbsolute(directory)) {
  throw new Error('Usage: bun scripts/agent-display-probe.ts <stage> <absolute-output-dir> [scenario-id ...]')
}
const unknown = selected.filter(id => !scenarios.some(scenario => scenario.id === id))
if (unknown.length > 0) throw new Error(`Unknown scenarios: ${unknown.join(', ')}`)
const chosen = selected.length === 0 ? scenarios : scenarios.filter(scenario => selected.includes(scenario.id))
const origin = process.env.LEITBILD_PROBE_ORIGIN ?? 'https://leitbild.app'
const plantId = 'plant:halden-2'
await mkdir(directory, { recursive: true })
if (await Bun.file(join(directory, `${stage}-summary.json`)).exists()) throw new Error('Stage already exists; choose a new stage name, do not overwrite evidence')

const request = async (path: string, body?: unknown, method = 'POST'): Promise<any> => {
  const response = await fetch(origin + path, {
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 400)}`)
  return JSON.parse(text)
}
const save = (name: string, value: unknown) => Bun.write(join(directory, `${name}.json`), JSON.stringify(value, null, 2))
const actor = { kind: 'human', id: 'display-probe', displayName: 'Display probe' }
const invoke = (workspaceId: string, operationId: string, input: unknown, target: Record<string, unknown> = {}) =>
  request(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, { ...target, input, actor })

// One paused seed Run per output directory; every scenario works on its own copy.
const seedFile = Bun.file(join(directory, 'seed.json'))
const seed: { workspaceId: string; resource: Record<string, string> } = await seedFile.exists() ? await seedFile.json() : await (async () => {
  const { workspace } = await request('/api/workspaces', { name: 'Operator display evaluation' })
  const { definitions } = await request(`/api/workspaces/${workspace.id}/definitions`)
  const definition = definitions.find((entry: { ref: { id: string } }) => entry.ref.id === 'halden-power-complex')
  if (!definition) throw new Error('Expected bundled Halden scenario is absent')
  const launched = await invoke(workspace.id, 'world.scenario.start', {}, { definition: { ...definition.ref, revisionId: definition.currentRevisionId } })
  const resource = launched.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? launched.result?.resource
  if (!resource) throw new Error('Launch did not return a Simulation Run reference')
  await invoke(workspace.id, 'world.simulation-run.execution.set', { playback: 'paused' }, { resource })
  const created = { workspaceId: workspace.id as string, resource }
  await save('seed', created)
  return created
})()
const { workspaceId } = seed

const presence = (runId: string) => request(`/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(runId)}/presence`)

const advance = async (resource: Record<string, string>, minutes: number): Promise<void> => {
  const before = Date.parse((await presence(resource.id!)).execution.currentSimulationTime)
  await invoke(workspaceId, 'world.simulation-run.execution.advance', { minutes, onComplete: 'pause' }, { resource })
  const target = before + minutes * 60_000
  const deadline = Date.now() + 300_000 // Probe patience, not a product limit.
  while (Date.now() < deadline) {
    const state = await presence(resource.id!)
    if (state.execution.playback === 'paused' && Date.parse(state.execution.currentSimulationTime) >= target) return
    await Bun.sleep(2_000)
  }
  throw new Error(`Run ${resource.id} did not advance ${minutes} min within the probe deadline`)
}

interface ComposeOutcome { readonly accepted: boolean; readonly panels: ReadonlyArray<string>; readonly signals: ReadonlyArray<string>; readonly error?: string }

// Exact compose inputs and outcomes from the answer's own execution evidence.
const composeOutcomes = async (roomId: string, turnId: string): Promise<ReadonlyArray<ComposeOutcome>> => {
  const turn = await request(`/api/workspaces/${workspaceId}/agents/rooms/${roomId}/executions/${turnId}`)
  const outcomes: ComposeOutcome[] = []
  for (const summary of turn.calls ?? []) {
    if (summary.tool !== 'workspace_call') continue
    const call = await request(`/api/workspaces/${workspaceId}/agents/rooms/${roomId}/executions/${turnId}/calls/${summary.id}`)
    const entries = call.arguments?.calls ?? []
    const results = call.result?.data?.results ?? []
    for (const entry of entries) {
      if (entry.operationId !== 'world.process-plant.display.compose') continue
      const result = results.find((candidate: { key: string }) => candidate.key === entry.key)
      const panels = (entry.input?.panels ?? []) as ReadonlyArray<{ kind: string; signals?: ReadonlyArray<{ ref: string }> }>
      outcomes.push({
        accepted: result?.success === true && typeof result.viewRef === 'string',
        panels: panels.map(panel => panel.kind),
        signals: panels.flatMap(panel => (panel.signals ?? []).map(signal => signal.ref)),
        ...(result?.success === true ? {} : { error: String(result?.error ?? 'no result').slice(0, 400) }),
      })
    }
  }
  return outcomes
}

const rows: Array<Record<string, unknown>> = []
for (const scenario of chosen) {
  const copy = await invoke(workspaceId, 'world.simulation-run.copy', { name: `Display probe · ${stage} · ${scenario.id}` }, { resource: seed.resource })
  const resource = copy.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? copy.result?.resource
  if (!resource) throw new Error('Copy did not return a Simulation Run reference')
  if (scenario.fault) await invoke(workspaceId, 'world.process-plant.action.invoke', { plantId, actionId: scenario.fault.actionId, parameters: scenario.fault.parameters ?? {} }, { resource })
  if (scenario.advanceMinutes !== undefined) await advance(resource, scenario.advanceMinutes)
  const opened = await invoke(workspaceId, 'agents.assistance.open', { scope: { kind: 'resource', resource }, title: `Display probe · ${scenario.id}`, focusedSubjects: [resource] })
  if (opened.result.reused) throw new Error('Probe requires a fresh Room per scenario')
  const roomId = opened.result.resource.id as string
  const roomPath = `/api/workspaces/${workspaceId}/agents/rooms/${roomId}`
  const members = await request(roomPath + '/members')
  const human = members.find((member: { kind: string }) => member.kind === 'human')
  const agent = members.find((member: { kind: string }) => member.kind === 'ai')
  // The Room already holds the Assistant's join notice; only a new chat reply counts.
  const prior = new Set((await request(roomPath + '?limit=100')).messages.map((message: { id: string }) => message.id))
  const startedAt = Date.now()
  await request(`/api/workspaces/${workspaceId}/agents/messages`, { senderId: human.id, senderName: human.name, content: scenario.prompt, target: { rooms: [roomId] } })
  let answer: any
  while (Date.now() - startedAt < 300_000) { // Probe deadline, not a product limit.
    answer = (await request(roomPath + '?limit=100')).messages.find((message: { id: string; senderId: string; type: string }) =>
      !prior.has(message.id) && message.senderId === agent.id && message.type === 'chat')
    if (answer) break
    await Bun.sleep(2_000)
  }
  if (!answer) throw new Error(`No answer for ${scenario.id} within the probe deadline`)
  const wallMs = Date.now() - startedAt
  const fence = /```leitbild-view\n(view \S+)\n```/.exec(answer.content)?.[1] ?? null
  const composes = answer.generationTraceId ? await composeOutcomes(roomId, answer.generationTraceId) : []
  const accepted = composes.filter(outcome => outcome.accepted)
  const usedSignals = new Set(accepted.flatMap(outcome => outcome.signals))
  const row = {
    id: scenario.id,
    expect: scenario.expect,
    displayed: fence !== null,
    correct: (fence !== null) === (scenario.expect === 'display'),
    composeCalls: composes.length,
    firstComposeAccepted: composes.length === 0 ? null : composes[0]!.accepted,
    panels: accepted.at(-1)?.panels ?? [],
    signals: [...usedSignals],
    keySignalHit: scenario.keySignals === undefined || fence === null ? null : scenario.keySignals.some(signal => usedSignals.has(signal)),
    keyPanelHit: scenario.keyPanel === undefined || fence === null ? null : (accepted.at(-1)?.panels ?? []).includes(scenario.keyPanel),
    rejections: composes.filter(outcome => !outcome.accepted).map(outcome => outcome.error),
    wallMs,
    modelCalls: answer.modelCalls,
    promptTokens: answer.promptTokens,
    completionTokens: answer.completionTokens,
    answerChars: answer.content.length,
    roomId,
    runId: resource.id,
  }
  rows.push(row)
  await save(`${stage}-${scenario.id}`, { scenario, row, answer })
  console.log(JSON.stringify(row))
}

const ratio = (hits: number, total: number): number | null => total === 0 ? null : Math.round((hits / total) * 100) / 100
const expectDisplay = rows.filter(row => row.expect === 'display')
const expectNone = rows.filter(row => row.expect === 'none')
const composed = rows.filter(row => row.firstComposeAccepted !== null)
const keyed = rows.filter(row => row.keySignalHit !== null)
const latencies = rows.map(row => row.wallMs as number).sort((left, right) => left - right)
const summary = {
  stage,
  origin,
  scenarios: rows.length,
  displayRecall: ratio(expectDisplay.filter(row => row.displayed).length, expectDisplay.length),
  falsePositiveRate: ratio(expectNone.filter(row => row.displayed).length, expectNone.length),
  firstComposeValid: ratio(composed.filter(row => row.firstComposeAccepted).length, composed.length),
  keySignalRecall: ratio(keyed.filter(row => row.keySignalHit).length, keyed.length),
  medianWallMs: latencies[Math.floor(latencies.length / 2)] ?? null,
  meanPromptTokens: rows.length === 0 ? null : Math.round(rows.reduce((sum, row) => sum + (row.promptTokens as number), 0) / rows.length),
  rows,
}
await save(`${stage}-summary`, summary)
console.log(JSON.stringify({ ...summary, rows: undefined }))
