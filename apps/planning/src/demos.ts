import { z } from 'zod'
import { workspaceResourceReferenceSchema, type AccessContext, type PlanningSourceBasis, type PlanningSourceSubject, type WorkspaceId } from '@leitbild/contracts'
import { createPlanningHostClient } from './host-client.ts'
import { planningError } from './errors.ts'
import { planningProblemSchema, type PlanningActivity, type PlanningProblem } from './model.ts'
import { currentProblemRevision, type PlanningAssumption, type SourceBinding } from './study-model.ts'
import type { PlanningService } from './service.ts'
import type { PlanningSourcePort } from './source-port.ts'
import type { PlanningDemoPort } from './module-api.ts'

const descriptors = [
  { id: 'response', title: 'Response handover', description: 'Two real response units and one receiving slot. Explicitly bind a custom temporal property, inspect owner travel estimates, and compare supplied job orders.' },
  { id: 'component-work', title: 'Pump work and shared resources', description: 'Two actual plant pumps, authored work estimates, a shared crew and crane, and a finite crew break. Compare work orders without changing plant physics.' },
] as const

interface DemoInputs {
  readonly title: string
  readonly problem: PlanningProblem
  readonly sourceBindings: SourceBinding[]
  readonly assumptions: PlanningAssumption[]
  readonly alternativeOrder: string[]
}
const numberFact = (basis: PlanningSourceBasis, id: string): number => {
  const fact = basis.subjects.flatMap(subject => subject.facts).find(fact => fact.id === id)
  if (!fact || typeof fact.value !== 'number' || !Number.isFinite(fact.value) || fact.value < 0) throw planningError(422, 'demo_source_incomplete', `Expected a nonnegative owner quantity: ${id}`)
  return fact.value
}
const sourceSubject = (basis: PlanningSourceBasis, factId: string): PlanningSourceSubject => {
  const subject = basis.subjects.find(subject => subject.facts.some(fact => fact.id === factId))
  if (!subject) throw planningError(422, 'demo_source_incomplete', `Expected an owner subject for ${factId}`)
  return subject
}
const chainLinks = (ids: string[]) => ids.slice(1).map((successorId, index) => ({ predecessorId: ids[index]!, successorId, lagSeconds: 0 }))
const subjectRef = (basis: PlanningSourceBasis, subject: PlanningSourceSubject) => ({ resource: basis.source, locator: subject.locator })
const supply = (id: string, title: string, end: number, capacity = 1) => ({ id, title, unit: '1', segments: [{ start: 0, end, capacity }] })
const assumption = (id: string, label: string, value: PlanningAssumption['value'], rationale: string, unit?: string): PlanningAssumption => ({ id, label, value, rationale, ...(unit === undefined ? {} : { unit }) })

/** Templates author a small problem; all live quantities come through the owner port. */
export const responseDemoInputs = (basis: PlanningSourceBasis): DemoInputs => {
  const end = 10_800
  const site = 'site:planning-receiving'
  const assumptions: PlanningAssumption[] = [
    assumption('supplied-assignments', 'Supplied unit assignments', 'Response A → Job A; Response B → Job B', 'The researcher selects these assignments. This calculation does not optimize unit choice.'),
    assumption('no-unmodeled-work', 'Other planning commitments', 'none', 'This paused fictional exercise starts with idle units. World changes require an explicit refresh and a review of commitments.'),
    assumption('preparation-meaning', 'Custom property interpretation', 'preparationSeconds → planned preparation duration', 'An explicit binding gives this authored numeric property temporal meaning. It adds no preparation mechanic to Einsatz.'),
  ]
  const bindings: SourceBinding[] = [{ factId: `${site}/receiving-slots`, target: { kind: 'capacity', supplyId: 'receiving' } }]
  const chains = ['a', 'b'].map(key => {
    const unitId = `unit:planning-${key}`, taskId = `task:planning-${key}`
    const owner = sourceSubject(basis, `${unitId}/service-seconds`)
    const stages = ['prepare', 'arrive', 'service', 'transfer', 'handover'] as const
    const ids = stages.map(stage => `${key}-${stage}`)
    const quantities = [
      { stage: 'prepare', factId: `${unitId}/property/preparationSeconds`, bind: true, title: 'Prepare' },
      { stage: 'arrive', factId: `${unitId}/arrival-seconds/${taskId}`, bind: false, title: 'Mobilize and reach job' },
      { stage: 'service', factId: `${unitId}/service-seconds`, bind: true, title: 'On-task work' },
      { stage: 'transfer', factId: `${unitId}/transfer-seconds/${taskId}/${site}`, bind: false, title: 'Transfer to receiving site' },
      { stage: 'handover', factId: `${site}/handover-seconds`, bind: true, title: 'Shared-site handover' },
    ] as const
    const eligible = owner.facts.find(fact => fact.id === `${unitId}/eligible/${taskId}`)
    if (eligible?.value !== true || numberFact(basis, `${unitId}/queued-steps`) !== 0) throw planningError(422, 'demo_source_not_idle', 'Response demonstration requires the supplied idle eligible units')
    const activities: PlanningActivity[] = quantities.map(quantity => {
      const activityId = `${key}-${quantity.stage}`
      const value = numberFact(basis, quantity.factId)
      if (quantity.bind) bindings.push({ factId: quantity.factId, target: { kind: 'duration', activityId } })
      else assumptions.push({ ...assumption(`${activityId}-rounding`, `${owner.label}: rounded owner ${quantity.stage} estimate`, Math.ceil(value), `Ceiling to whole elapsed seconds from captured fact ${quantity.factId} = ${value}. Refresh retains this authored estimate until explicitly revised; it is not an automatic travel binding.`, 's'), activityId })
      return { id: activityId, title: `${owner.label}: ${quantity.title}`, modeId: 'supplied-assignment', durationSeconds: Math.ceil(value), demands: [{ supplyId: `unit-${key}`, amount: 1 }, ...(quantity.stage === 'handover' ? [{ supplyId: 'receiving', amount: 1 }] : [])], tardinessWeight: key === 'a' ? 3 : 1, ...(quantity.stage === 'handover' ? { due: 2400 } : {}), subject: subjectRef(basis, owner), progress: { kind: 'planned' } }
    })
    return { ids, activities }
  })
  const a = chains[0]!, b = chains[1]!
  const problem = planningProblemSchema.parse({
    profile: 'elapsed-fs', axis: { run: basis.source, unit: 'second' }, horizon: { start: 0, end }, asOf: 0,
    supplies: [supply('unit-a', 'Response A', end), supply('unit-b', 'Response B', end), supply('receiving', 'Receiving slots', end, numberFact(basis, `${site}/receiving-slots`))],
    activities: [...a.activities, ...b.activities], precedences: [...chainLinks(a.ids), ...chainLinks(b.ids)],
    priorityOrder: [...b.ids, ...a.ids], objectives: [{ metric: 'activity-completion', activityId: 'a-handover', direction: 'minimize', tolerance: 0 }, { metric: 'activity-completion', activityId: 'b-handover', direction: 'minimize', tolerance: 0 }, { metric: 'weighted-tardiness', direction: 'minimize', tolerance: 0 }, { metric: 'makespan', direction: 'minimize', tolerance: 0 }],
  })
  assumptions.push(assumption('objective-policy', 'Objective policy', 'Job A handover, then Job B handover, weighted tardiness and makespan', 'A supplied lexicographic research policy. Both job completion times also participate in Pareto comparison, making their tradeoff visible. No clinical quality claim is inferred from speed or priority.'))
  return { title: 'Response handover: evidence and order', problem, sourceBindings: bindings, assumptions, alternativeOrder: [...a.ids, ...b.ids] }
}

export const componentWorkDemoInputs = (basis: PlanningSourceBasis): DemoInputs => {
  const pumps = basis.subjects.filter(subject => subject.kind === 'pump').slice(0, 2)
  if (pumps.length !== 2) throw planningError(422, 'demo_source_incomplete', 'The component demonstration requires two actual pump subjects')
  const end = 28_800
  const assumptions: PlanningAssumption[] = [
    assumption('work-context', 'Work context', 'Fictional isolated offline maintenance exercise', 'The real Run supplies component identity and public condition. Work durations, isolation and crew/crane availability are authored planning inputs, not a plant maintenance simulator or safety procedure.'),
    assumption('crew-capacity', 'Shared crew capacity', 2, 'Two interchangeable planning crew units; available 0–5400 and 7200–28800 elapsed seconds.', '1'),
    assumption('crane-capacity', 'Shared crane capacity', 1, 'One crane available only 1800–12600 elapsed seconds.', '1'),
    assumption('crew-break', 'Crew unavailable interval', '5400–7200 s', 'Finite elapsed-time capacity gap. Activities are noninterruptible and must fit wholly within feasible capacity.'),
  ]
  const chains = pumps.map((pump, index) => {
    const key = index === 0 ? 'a' : 'b'
    const stages = [
      { id: 'isolate', title: 'Prepare and isolate', seconds: 600, crane: false },
      { id: 'remove', title: 'Lift out', seconds: 900, crane: true },
      { id: 'inspect', title: 'Inspect and service', seconds: index === 0 ? 1800 : 3000, crane: false },
      { id: 'install', title: 'Lift in', seconds: 900, crane: true },
      { id: 'verify', title: 'Verify and release', seconds: 600, crane: false },
    ]
    const ids = stages.map(stage => `${key}-${stage.id}`)
    const activities: PlanningActivity[] = stages.map(stage => {
      const activityId = `${key}-${stage.id}`
      assumptions.push({ ...assumption(`${activityId}-duration`, `${pump.label}: ${stage.title}`, stage.seconds, 'Authored work estimate for this demonstration; not derived from pump capacity, run-up response or hidden plant state.', 's'), activityId, subject: subjectRef(basis, pump) })
      return { id: activityId, title: `${pump.label}: ${stage.title}`, modeId: 'supplied-method', durationSeconds: stage.seconds, demands: [{ supplyId: 'crew', amount: 1 }, ...(stage.crane ? [{ supplyId: 'crane', amount: 1 }] : [])], tardinessWeight: 1, subject: subjectRef(basis, pump), progress: { kind: 'planned' } }
    })
    return { ids, activities }
  })
  const a = chains[0]!, b = chains[1]!
  return {
    title: 'Pump work: shared crew, crane and capacity gap', sourceBindings: [], assumptions,
    problem: planningProblemSchema.parse({ profile: 'elapsed-fs', axis: { run: basis.source, unit: 'second' }, horizon: { start: 0, end }, asOf: 0,
      supplies: [{ id: 'crew', title: 'Shared crew', unit: '1', segments: [{ start: 0, end: 5400, capacity: 2 }, { start: 7200, end, capacity: 2 }] }, { id: 'crane', title: 'Shared crane', unit: '1', segments: [{ start: 1800, end: 12600, capacity: 1 }] }],
      activities: [...a.activities, ...b.activities], precedences: [...chainLinks(a.ids), ...chainLinks(b.ids)], priorityOrder: [...a.ids, ...b.ids], objectives: [{ metric: 'makespan', direction: 'minimize', tolerance: 0 }],
    }), alternativeOrder: [...b.ids, ...a.ids],
  }
}

export const createPlanningDemos = (config: { readonly service: PlanningService; readonly sources: PlanningSourcePort; readonly hostUrl: string; readonly fetch?: typeof fetch }): PlanningDemoPort => {
  const host = createPlanningHostClient(config)
  return {
    list: () => descriptors,
    start: async (workspaceId: WorkspaceId, input, access: AccessContext) => {
      if (access.workspaceId !== workspaceId) throw planningError(400, 'source_workspace_mismatch', 'The demonstration must use the initiating Workspace')
      const definitionId = input.case === 'response' ? 'planning-response' : 'planning-component-work'
      const catalog = await host.definitions(workspaceId)
      const definition = catalog.definitions.find(definition => definition.ref.moduleId === 'world' && definition.ref.type === 'world.scenario' && definition.ref.id === definitionId)
      if (!definition?.primaryCapabilityId) throw planningError(503, 'demo_definition_unavailable', `Published World Definition ${definitionId} is unavailable`)
      // No retry: an ambiguous transport failure must not create a second Run.
      const started = z.object({ id: z.string().min(1) }).passthrough().parse(await host.call(access, definition.primaryCapabilityId, { definition: { ...definition.ref, revisionId: definition.currentRevisionId }, input: {} }))
      const source = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: started.id })
      try {
        await host.call(access, 'world.simulation-run.execution.set', { resource: source, input: { playback: 'paused' } })
        const request = { source, profile: input.case === 'response' ? 'einsatz' as const : 'process-plant' as const }
        const basis = await config.sources.capture(request, access)
        const authored = input.case === 'response' ? responseDemoInputs(basis) : componentWorkDemoInputs(basis)
        let study = await config.service.createFromBasis(workspaceId, { title: authored.title, problem: authored.problem, sourceBindings: authored.sourceBindings, assumptions: authored.assumptions, basis, request }, access)
        const baseline = await config.service.solve(workspaceId, study.id, study.revision, access, 100_000)
        study = await config.service.baseline(workspaceId, study.id, baseline.candidate.id, baseline.study.revision, access)
        study = await config.service.revise(workspaceId, study.id, { expectedRevision: study.revision, problem: { ...currentProblemRevision(study).problem, priorityOrder: authored.alternativeOrder } }, access)
        return (await config.service.solve(workspaceId, study.id, study.revision, access, 100_000)).study
      } catch (error) {
        throw planningError(502, 'demo_incomplete', `The World Run was created and retained, but demonstration setup did not complete: ${error instanceof Error ? error.message : String(error)}`, { source })
      }
    },
  }
}
