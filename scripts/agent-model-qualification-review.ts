/** Offline review of real Workspace probe captures. No model calls, list-price
 * estimates or task-quality judgement: canonical case assertions belong to the
 * probe, and unknown billing/effects remain unknown. */
import { isDeepStrictEqual } from 'node:util'
import { contextCheckpointManifestSchema } from '../apps/agents/src/core/working-context.ts'
import type { ExecutionModelCallSummary } from '../apps/agents/src/core/executions/model-evidence.ts'
import type { ExecutionCall } from '../apps/agents/src/core/executions/store.ts'

export interface QualificationTurnEvidence {
  readonly id: string
  readonly status: string
  readonly models: ReadonlyArray<ExecutionModelCallSummary>
  readonly calls: ReadonlyArray<ExecutionCall>
  readonly stages: ReadonlyArray<{ readonly at: number; readonly event: unknown }>
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export const reviewQualificationExecution = (input: {
  readonly expectedModel: string
  readonly turns: ReadonlyArray<QualificationTurnEvidence>
}) => {
  const errors: string[] = [], warnings: string[] = []
  const models = input.turns.flatMap(turn => turn.models.map(model => ({ turn, model })))
  const calls = input.turns.flatMap(turn => turn.calls.map(call => ({ turn, call })))
  if (!input.turns.length) errors.push('No execution turns captured')
  if (!models.length) errors.push('No model calls captured')
  let uniqueModelEvidence = true
  const turnIds = new Set<string>()
  for (const turn of input.turns) {
    if (turnIds.has(turn.id)) { errors.push(`Duplicate turn ${turn.id}`); uniqueModelEvidence = false }
    turnIds.add(turn.id)
    for (const [kind, entries] of [['model', turn.models], ['tool', turn.calls]] as const) {
      const ids = new Set<string>()
      for (const entry of entries) {
        if (ids.has(entry.id)) {
          errors.push(`Duplicate ${kind} ${turn.id}/${entry.id}`)
          if (kind === 'model') uniqueModelEvidence = false
        }
        ids.add(entry.id)
      }
    }
  }
  let knownCostUsd = 0, knownCalls = 0
  for (const { turn, model } of models) {
    const cost = model.metrics?.costUsd
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) { knownCostUsd += cost; knownCalls++ }
    else if (cost !== undefined) warnings.push(`Invalid reported cost ${turn.id}/${model.id}`)
    // openrouter: is a routing prefix consumed before wire dispatch, not a
    // model alias. Require the exact wire model and serving adapter as well.
    const requested = model.requestedModel.replace(/^openrouter:/, '')
    const expected = input.expectedModel.replace(/^openrouter:/, '')
    if (requested !== expected) errors.push(`Unexpected requested model ${turn.id}/${model.id}: ${model.requestedModel}`)
    const effectiveModels = [model.model, model.metrics?.model].filter((value): value is string => value !== undefined)
    if (!effectiveModels.length || effectiveModels.some(value => value !== expected)) errors.push(`Effective model not established as ${expected}: ${turn.id}/${model.id}`)
    const providers = [model.provider, model.metrics?.provider].filter((value): value is string => value !== undefined)
    if (!providers.length || providers.some(value => value !== 'openrouter')) errors.push(`OpenRouter serving adapter not established: ${turn.id}/${model.id}`)
  }
  const incompleteCalls = calls.filter(({ call }) => call.completedAt === undefined || call.result === undefined)
  const uncertainEffects = calls.filter(({ call }) => !call.result?.effects?.length
    || call.result.effects.some(effect => effect.kind === 'unknown' || effect.outcome === 'unknown'))
  const changes = calls.flatMap(({ turn, call }) => (call.result?.effects ?? []).flatMap(effect =>
    effect.kind === 'change' && effect.outcome !== 'not-dispatched' ? [{ turnId: turn.id, toolCallId: call.id, ...effect }] : []))
  const attemptedChanges = calls.flatMap(({ turn, call }) => (call.result?.effects ?? []).flatMap(effect =>
    effect.kind === 'change' ? [{ turnId: turn.id, toolCallId: call.id, ...effect }] : []))
  const failures = calls.filter(({ call }) => call.result?.success === false)
    .map(({ turn, call }) => ({ turnId: turn.id, toolCallId: call.id, tool: call.tool, error: call.result!.error }))
  // workspace_call can return a successful outer tool receipt containing failed
  // or missing per-operation outcomes. Never label that a first-pass success.
  const operations = calls.flatMap(({ turn, call }) => {
    if (call.tool !== 'workspace_call') return []
    const args = record(call.arguments), data = record(call.result?.data)
    if (!Array.isArray(args?.calls)) return []
    const results = Array.isArray(data?.results) ? data.results : []
    return args.calls.map((input: unknown) => {
      const operation = record(input)
      const matches = typeof operation?.key === 'string' && operation.key.length > 0
        ? results.map(record).filter(row => row !== undefined && row.key === operation.key) : []
      const result = matches.length === 1 ? matches[0] : undefined
      const status = result?.success === true ? 'succeeded' : result?.success === false ? 'failed' : 'unknown'
      return { turnId: turn.id, toolCallId: call.id, key: operation?.key, operationId: operation?.operationId, status,
        ...(status === 'failed' ? { error: result?.error } : {}),
        ...(status === 'unknown' ? { reason: matches.length > 1 ? 'Ambiguous duplicate operation results' : 'No exact operation outcome captured' } : {}) }
    })
  })
  const checkpoints = input.turns.flatMap(turn => turn.stages.flatMap(stage => {
    const event = record(stage.event)
    if (event?.kind === 'model_fallback') errors.push(`Model fallback occurred in ${turn.id}`)
    if (event?.kind !== 'context_checkpoint') return []
    const parsed = contextCheckpointManifestSchema.safeParse(event.manifest)
    if (!parsed.success) { errors.push(`Malformed checkpoint in ${turn.id}`); return [] }
    const manifest = parsed.data
    if (manifest.turnId !== turn.id) errors.push(`Foreign checkpoint ${turn.id}/${manifest.checkpointId}`)
    const preceding = turn.models.find(model => model.id === manifest.precedingModelId)
    if (!preceding) errors.push(`Checkpoint predecessor not captured ${turn.id}/${manifest.checkpointId}`)
    const applied = turn.models.some(model => model.contextCheckpointId === manifest.checkpointId
      && preceding !== undefined && model.ordinal > preceding.ordinal)
    return [{ turnId: turn.id, at: stage.at, manifest, applied }]
  }))
  const recalls = calls.flatMap(({ turn, call }) => {
    if (call.tool !== 'conversation_read' || !call.result?.success) return []
    const args = record(call.arguments), data = record(call.result.data)
    if (args?.part !== 'result' || typeof args.turnId !== 'string' || typeof args.toolCallId !== 'string') return []
    const archived = checkpoints.some(checkpoint => checkpoint.turnId === args.turnId && checkpoint.at <= call.startedAt
      && checkpoint.manifest.archivedGroups.some(group => group.callIds.includes(args.toolCallId as string)))
    if (!archived) return []
    const original = input.turns.find(candidate => candidate.id === args.turnId)?.calls.find(candidate => candidate.id === args.toolCallId)
    const exact = original?.result !== undefined && data?.evidenceKind === 'execution'
      && data.turnId === args.turnId && data.toolCallId === args.toolCallId && isDeepStrictEqual(data.result, original.result)
    if (!exact) errors.push(`Archived recall differs or source is absent: ${turn.id}/${call.id}`)
    return [{ turnId: turn.id, toolCallId: call.id, sourceTurnId: args.turnId, sourceToolCallId: args.toolCallId, exact }]
  })
  const unknownCalls = models.length - knownCalls
  return {
    /** Mechanical completeness is not a correctness verdict for the answer. */
    structurallyComplete: errors.length === 0 && input.turns.every(turn => turn.status === 'completed')
      && models.length > 0 && models.every(({ model }) => model.status === 'completed') && incompleteCalls.length === 0,
    errors, warnings, modelCalls: models.length, toolCalls: calls.length,
    turnStatuses: input.turns.map(turn => ({ id: turn.id, status: turn.status })),
    reportedModels: [...new Set(models.flatMap(({ model }) => model.model === undefined ? [] : [model.model]))],
    upstreamProviders: [...new Set(models.flatMap(({ model }) => model.metrics?.upstreamProvider === undefined ? [] : [model.metrics.upstreamProvider]))],
    billing: { knownCostUsd, knownCalls, unknownCalls, uniqueModelEvidence,
      complete: models.length > 0 && unknownCalls === 0 && uniqueModelEvidence,
      costUsd: models.length > 0 && unknownCalls === 0 && uniqueModelEvidence ? knownCostUsd : null },
    readOnlyEstablished: calls.length > 0 && incompleteCalls.length === 0 && uncertainEffects.length === 0 && attemptedChanges.length === 0,
    changes, attemptedChanges, failures,
    operationFailures: operations.filter(operation => operation.status === 'failed'),
    unknownOperationOutcomes: operations.filter(operation => operation.status === 'unknown'),
    incompleteCalls: incompleteCalls.map(({ turn, call }) => ({ turnId: turn.id, toolCallId: call.id })),
    uncertainEffects: uncertainEffects.map(({ turn, call }) => ({ turnId: turn.id, toolCallId: call.id })),
    checkpoints: checkpoints.map(checkpoint => ({ turnId: checkpoint.turnId, checkpointId: checkpoint.manifest.checkpointId,
      archivedCalls: checkpoint.manifest.counts.archivedCalls, applied: checkpoint.applied })),
    archivedRecalls: recalls,
  }
}
