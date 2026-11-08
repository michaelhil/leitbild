import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { engineeringContinuationReceiptSchema, type EngineeringContinuationCase } from '@leitbild/contracts'
import { continuationWorkerInputSchema } from './core/engineering/worker-protocol.ts'
import { engineeringCodeDigest } from './core/engineering/fingerprint.ts'
import { engineeringOwnerBasisSchema } from './simulation/engineering-inputs.ts'
import { unrestrictedQueryReadPolicy } from './simulation/query-read-policy.ts'
import { processPlantPack } from './packs/process-plant/pack.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from './packs/process-plant/sim/adapter.ts'
import { electricGridPack } from './packs/electric-grid/pack.ts'
import { createLocalElectricGridPackRuntimeAdapter } from './packs/electric-grid/sim/adapter.ts'
import { weatherPack } from './packs/weather/pack.ts'
import { createLocalWeatherPackRuntimeAdapter } from './packs/weather/sim/adapter.ts'
import { createSimulationRunRegistry } from './core/simulation-runs/registry.ts'
import { createScenarioRuntimeResolver } from './core/scenarios/runtime-resolver.ts'
import { scenarioAuthoringCatalogFor } from './core/scenarios/authoring.ts'
import { compileScenarioDefinition } from './core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from './routing/direct-adapter.ts'
import { writeAtomic } from './core/storage/atomic-write.ts'

// Fixed trusted runner, no HTTP server, account environment, Agent, tool broker,
// generated code, public Run registration or access to the parent's data root.
const [inputPath, outputPath, scratch] = process.argv.slice(2)
if (!inputPath || !outputPath || !scratch) throw new Error('Continuation worker requires three private paths')
const input = continuationWorkerInputSchema.parse(JSON.parse(await readFile(inputPath, 'utf8')))
if (input.codeDigest !== await engineeringCodeDigest()) throw new Error('Continuation execution code changed; capture a new origin')
const receipt = engineeringContinuationReceiptSchema.parse(input.receipt)
// The supervising process owns stdin. EOF also fences orphan workers after an
// abrupt parent crash. The independent deadline bounds all trusted worker work.
process.stdin.resume()
process.stdin.on('end', () => process.exit(1))
const deadline = setTimeout(() => process.exit(1), receipt.limits.wallSeconds * 1000)
deadline.unref()
const memoryGuard = setInterval(() => { if (process.memoryUsage.rss() > 512 * 1024 * 1024) process.exit(1) }, 100)
memoryGuard.unref()
const packs = [processPlantPack, electricGridPack, weatherPack]
const save = async () => {
  const started = performance.now()
  receipt.updatedAt = new Date().toISOString()
  const validated = engineeringContinuationReceiptSchema.parse(receipt)
  await writeAtomic(outputPath, JSON.stringify({ token: input.token, receipt: validated }))
  receipt.timings.publicationMs += performance.now() - started
}
const originMs = Date.parse(input.seed.checkpoint.snapshot.clock!.currentTime)
const request = receipt.request
receipt.status = 'running'
for (const caseId of ['baseline', 'variant'] as const) {
  const result: EngineeringContinuationCase = { id: caseId, label: caseId === 'baseline' ? 'Unchanged baseline' : request.variant.label,
    status: 'running', reachedSeconds: 0, modelElapsedMs: 0, interventions: [], sampleCount: 0, samples: [] }
  receipt.cases.push(result)
  const registry = createSimulationRunRegistry({ dataDir: join(scratch, caseId), workspaceId: receipt.source.workspaceId,
    scenarioDefinitions: [input.seed.definition], scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs), compileScenarioDefinition: source => compileScenarioDefinition(source, packs, { routing: createDirectRoutingAdapter() }),
    runtimeAdapters: [createLocalProcessPlantPackRuntimeAdapter(), createLocalElectricGridPackRuntimeAdapter(), createLocalWeatherPackRuntimeAdapter()],
  })
  let releaseCase: (() => void) | undefined
  try {
    const restoreStarted = performance.now()
    const runtime = await registry.restoreContinuation(structuredClone(input.seed))
    receipt.timings.restoreMs += performance.now() - restoreStarted
    // A case has no browser/API lease. Its supervising job owns this runtime
    // until teardown, including long advances between observed boundaries.
    releaseCase = registry.acquireLease(runtime.id, 'background')
    const model = async () => {
      const started = performance.now()
      try { return engineeringOwnerBasisSchema.parse(await runtime.readAtBoundary({ capabilityId: 'world.process-plant.engineering-basis', input: { subjectId: request.subjectId, purpose: 'capture' }, readPolicy: unrestrictedQueryReadPolicy })) }
      finally { receipt.timings.observationMs += performance.now() - started }
    }
    const initial = await model()
    const sample = async (seconds: number) => {
      const basis = await model()
      result.modelElapsedMs = basis.modelElapsedMs
      if (basis.domainEnd !== null || Math.abs(basis.modelElapsedMs - initial.modelElapsedMs - seconds * 1000) > 1) throw new Error(basis.domainEnd ?? 'Target model did not reach the requested boundary')
      result.samples.push({ elapsedSeconds: seconds, simulationAt: new Date(originMs + seconds * 1000).toISOString(), modelElapsedMs: basis.modelElapsedMs, quantities: basis.quantities })
      result.sampleCount = result.samples.length
      result.reachedSeconds = seconds
      await save()
    }
    const boundaryActions = [...request.variant.actions].sort((a, b) => a.atSeconds - b.atSeconds)
    const actions = caseId === 'variant' ? boundaryActions : []
    const apply = async (seconds: number) => {
      for (const action of actions.filter(action => action.atSeconds === seconds)) {
        const event = { ...action, acceptedAt: null as string | null, status: 'unknown' as 'unknown' | 'accepted' | 'refused', application: 'queued-owner-write' as const }
        result.interventions.push(event)
        await save()
        const outcome = await runtime.invokeCapability({ id: 'actor:engineering-case' as never, label: 'Engineering case action', role: 'ai_agent' }, {
          capabilityId: 'world.process-plant.control.write', input: { plantId: request.subjectId, path: action.path, value: action.value },
        })
        if (outcome.kind !== 'command') throw new Error('Case action was not a command')
        if (!outcome.result.ok) {
          event.status = 'refused'
          Object.assign(event, { reason: outcome.result.reason })
          await save()
          throw new Error(`Intervention refused: ${outcome.result.reason}`)
        }
        event.status = 'accepted'
        event.acceptedAt = new Date(originMs + seconds * 1000).toISOString()
      }
    }
    await apply(0)
    await sample(0)
    let reached = 0
    while (reached < request.horizonSeconds) {
      // Both cases acquire on the same union of interval/intervention/end
      // boundaries, including boundaries where baseline does nothing.
      const nextAction = boundaryActions.find(action => action.atSeconds > reached)?.atSeconds ?? request.horizonSeconds
      const nextSample = (Math.floor(reached / request.sampleEverySeconds) + 1) * request.sampleEverySeconds
      const target = Math.min(nextAction, nextSample, request.horizonSeconds)
      const advanceStarted = performance.now()
      try { await runtime.runMaximumPace(new Date(originMs + target * 1000).toISOString() as never, { shouldStop: () => false }) }
      finally { receipt.timings.advanceMs += performance.now() - advanceStarted }
      reached = target
      await apply(reached)
      await sample(reached)
    }
    result.status = 'completed'
  } catch (error) {
    result.status = result.samples.length ? 'partial' : 'failed'
    result.reason = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
  } finally {
    const teardownStarted = performance.now()
    try { await registry.shutdown() } finally { releaseCase?.(); receipt.timings.teardownMs += performance.now() - teardownStarted }
    await save()
  }
}
receipt.status = receipt.cases.every(result => result.status === 'completed') ? 'completed' : 'partial'
await save()
process.stdin.pause()
process.exit(0)
