/** Manual, real-service comparison probe. Creates only its own Workspace/Runs.
 * bun scripts/agent-conversation-probe.ts <stage> <absolute-output-dir>
 * Uses the configured production Assistant/provider; never reads credentials.
 * Optional LEITBILD_PROBE_MODEL and LEITBILD_PROBE_REASONING select explicit
 * candidate settings on the test-owned Agent only (reasoning=default clears it).
 * Results are generated evidence, not fixtures or a statistical benchmark.
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const [stage, directory] = Bun.argv.slice(2)
if (!stage || !/^[a-z0-9-]+$/.test(stage) || !directory || !isAbsolute(directory)) {
  throw new Error('Usage: bun scripts/agent-conversation-probe.ts <stage> <absolute-output-dir>')
}
const origin = process.env.LEITBILD_PROBE_ORIGIN ?? 'https://leitbild.app'
const requestedModel = process.env.LEITBILD_PROBE_MODEL
const requestedReasoning = process.env.LEITBILD_PROBE_REASONING
await mkdir(directory, { recursive: true })
const json = async (path: string, body?: unknown, method: 'POST' | 'PATCH' = 'POST') => {
  const response = await fetch(origin + path, {
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let result: any
  try { result = JSON.parse(text) }
  catch { throw new Error(`${path}: ${response.status} non-JSON response: ${text.slice(0, 300)}`) }
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`)
  return result
}
const save = (name: string, value: unknown) => Bun.write(join(directory, name + '.json'), JSON.stringify(value, null, 2))
const seedFile = Bun.file(join(directory, 'seed.json'))
let seed: { workspaceId: string; resource: Record<string, string>; definition: unknown; execution: unknown }
const invoke = (workspaceId: string, operationId: string, input: unknown, target: Record<string, unknown> = {}) =>
  json(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, {
    ...target, input, actor: { kind: 'human', id: 'foundation-probe', displayName: 'Foundation probe' },
  })
if (await seedFile.exists()) {
  seed = await seedFile.json()
} else {
  const { workspace } = await json('/api/workspaces', { name: 'Agent foundations · evaluation' })
  const workspaceId = workspace.id as string
  await save('workspace', workspace)
  const { definitions } = await json(`/api/workspaces/${workspaceId}/definitions`)
  const definition = definitions.find((entry: { ref: { id: string } }) => entry.ref.id === 'halden-power-complex')
  if (!definition) throw new Error('Expected bundled evaluation scenario is absent')
  const launched = await invoke(workspaceId, 'world.scenario.start', {}, {
    definition: { ...definition.ref, revisionId: definition.currentRevisionId },
  })
  await save('seed-launch', launched)
  const resource = launched.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run')
    ?? launched.result?.resource
  if (!resource) throw new Error('Launch did not return a Simulation Run reference; inspect seed-launch.json')
  const execution = await invoke(workspaceId, 'world.simulation-run.execution.set', { playback: 'paused' }, { resource })
  seed = { workspaceId, resource, definition, execution }
  await save('seed', seed)
}
const stageFile = Bun.file(join(directory, stage + '-run.json'))
if (await stageFile.exists()) throw new Error('Stage already exists; choose a new stage name, do not overwrite evidence')
const copy = await invoke(seed.workspaceId, 'world.simulation-run.copy', { name: `Foundation probe · ${stage}` }, { resource: seed.resource })
await save(stage + '-copy', copy)
const resource = copy.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? copy.result?.resource
if (!resource) throw new Error('Copy did not return a Simulation Run reference; inspect copy JSON')
await invoke(seed.workspaceId, 'world.simulation-run.execution.set', { playback: 'paused' }, { resource })
const opened = await invoke(seed.workspaceId, 'agents.assistance.open', {
  scope: { kind: 'resource', resource }, title: `Foundation probe · ${stage}`, focusedSubjects: [resource],
})
if (opened.result.reused) throw new Error('Probe requires a fresh Room; no comparison messages sent')
const roomId = opened.result.resource.id as string
const roomPath = `/api/workspaces/${seed.workspaceId}/agents/rooms/${roomId}`
const members = await json(roomPath + '/members')
const human = members.find((member: { kind: string }) => member.kind === 'human')
const agent = members.find((member: { kind: string }) => member.kind === 'ai')
if (!human || !agent) throw new Error('Assistant Room is missing participants')
const agentPath = `/api/workspaces/${seed.workspaceId}/agents/agents/${agent.id}`
if (requestedModel !== undefined || requestedReasoning !== undefined) {
  await json(agentPath, {
    ...(requestedModel === undefined ? {} : { model: requestedModel }),
    ...(requestedReasoning === undefined ? {} : { reasoningEffort: requestedReasoning === 'default' ? null : requestedReasoning }),
  }, 'PATCH')
}
const profile = await json(agentPath)
if (requestedModel !== undefined && profile.model !== requestedModel) throw new Error('Requested model was not applied; no comparison messages sent')
if (requestedReasoning !== undefined && profile.reasoningEffort !== (requestedReasoning === 'default' ? undefined : requestedReasoning)) throw new Error('Requested reasoning setting was not applied; no comparison messages sent')
await save(stage + '-run', { seed, resource, roomId, profile, opened, requestedModel, requestedReasoning, recordedAt: new Date().toISOString() })
console.log(JSON.stringify({ stage, workspaceId: seed.workspaceId, runId: resource.id, roomId, model: profile.model, reasoningEffort: profile.reasoningEffort ?? 'provider-default' }))

const prompts = [
  'Give me a concise current sitrep of Unit 2. Include its electrical output and any material operational concerns, using live evidence. Do not change anything.',
  'What does its generator electrical output actually measure in this model, and what is its current value? Distinguish the measured value from any model limitations you can establish.',
  'Recover the exact electrical-output value and its units from the evidence used for your first answer. This is a question about that earlier observation, not a request for a new reading.',
  'I have removed Unit 2 from this run. Check the current plants and tell me whether it is still available, and how many remain. Do not rely on the earlier inventory.',
]
for (let index = 0; index < prompts.length; index++) {
  if (index === 3) await save(stage + '-deletion', await invoke(seed.workspaceId, 'world.object.delete', { objectId: 'plant:halden-2' }, { resource }))
  const before = await json(roomPath + '?limit=1000')
  const priorIds = new Set(before.messages.map((message: { id: string }) => message.id))
  const startedAt = Date.now()
  const posted = await json(`/api/workspaces/${seed.workspaceId}/agents/messages`, {
    senderId: human.id, senderName: human.name, content: prompts[index], target: { rooms: [roomId] },
  })
  await save(`${stage}-${index + 1}-request`, posted)
  const deadline = Date.now() + 240_000 // Probe deadline, not a product behavioral limit.
  let answer: Record<string, any> | undefined
  while (Date.now() < deadline) {
    const room = await json(roomPath + '?limit=1000')
    answer = room.messages.find((message: { id: string; senderId: string }) => !priorIds.has(message.id) && message.senderId === agent.id)
    if (answer) break
    await Bun.sleep(2000)
  }
  if (!answer) {
    await save(`${stage}-${index + 1}-timeout-cancellation`, await json(agentPath + '/cancel', {}))
    throw new Error(`No answer within probe deadline for question ${index + 1}; test-owned Agent cancelled`)
  }
  await save(`${stage}-${index + 1}-answer`, { prompt: prompts[index], wallMs: Date.now() - startedAt, answer })
  const inspection = await json(`${roomPath}/messages/${answer.id}/generation-query`)
  await save(`${stage}-${index + 1}-inspection`, inspection)
  console.log(JSON.stringify({ stage, question: index + 1, ms: answer.generationMs, calls: answer.modelCalls, input: answer.promptTokens, output: answer.completionTokens, cacheRead: answer.cacheRead, toolCalls: answer.toolTrace?.length, text: answer.content }))
}
console.log(`Completed ${stage}. Exact evidence: ${directory}`)
