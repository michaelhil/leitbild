import type { ProcessPlantIcConfig } from '../runtime/index.ts'
import { primaryLoopIdForPump, type CompiledPlantGraph, type CompiledComponent } from '../graph/index.ts'
import { accumulatorReferenceIcRules } from './reference-ic-accumulator.ts'
import { balanceOfPlantReferenceIcRules } from './reference-ic-balance-of-plant.ts'
import { containmentReferenceIcRules } from './reference-ic-containment.ts'
import { electricalReferenceIcRules } from './reference-ic-electrical.ts'
import { pressurizerReferenceIcRules } from './reference-ic-pressurizer.ts'
import { reactorReferenceIcRules } from './reference-ic-reactor.ts'
import { reactorCoolantPumpReferenceIcRules } from './reference-ic-rcp.ts'
import { steamGeneratorReferenceIcRules } from './reference-ic-steam-generator.ts'
import { fourLoopReferenceLetters, sixLoopReferenceLetters, type ProcessPlantReferenceLoop } from './reference-loop.ts'

export const processPlantPressurizedWaterReactorIcRef = 'process-plant.pressurized-water-reactor.ic.v1'
export const processPlantPressurizedWaterReactorSixLoopIcRef = 'process-plant.pressurized-water-reactor-6-loop.ic.v1'
export const processPlantPwrReferenceGraphIcRef = 'process-plant.pwr.reference.graph.ic.v2'
export const processPlantPwrReferenceIcRefForLoopCount = (loopCount: number): string =>
  `process-plant.pwr.reference.${loopCount}-loop.ic.v2`

export const pressurizedWaterReactorReferenceIcFor = (
  loops: ReadonlyArray<ProcessPlantReferenceLoop>,
): ProcessPlantIcConfig => ({
  rules: [
    ...reactorReferenceIcRules(loops),
    ...pressurizerReferenceIcRules(),
    ...loops.flatMap(loop => steamGeneratorReferenceIcRules(loop)),
    ...loops.flatMap(loop => reactorCoolantPumpReferenceIcRules(loop)),
    ...loops.flatMap(loop => accumulatorReferenceIcRules(loop)),
    ...containmentReferenceIcRules(),
    ...electricalReferenceIcRules(),
    ...balanceOfPlantReferenceIcRules(),
  ],
})

export const pressurizedWaterReactorReferenceIc: ProcessPlantIcConfig = pressurizedWaterReactorReferenceIcFor(fourLoopReferenceLetters)
export const pressurizedWaterReactorSixLoopReferenceIc: ProcessPlantIcConfig = pressurizedWaterReactorReferenceIcFor(sixLoopReferenceLetters)

interface GraphLoopEntry {
  readonly loopId: ProcessPlantReferenceLoop
  readonly ordinal: number
}

const rememberLoopEntry = (
  entriesByLoopId: Map<string, GraphLoopEntry>,
  loopId: string,
  ordinal: number,
): void => {
  const existing = entriesByLoopId.get(loopId)
  if (existing !== undefined && existing.ordinal <= ordinal) return
  entriesByLoopId.set(loopId, { loopId, ordinal })
}

const metadataLoopEntry = (component: CompiledComponent): GraphLoopEntry | null => {
  const loopId = component.metadata?.loopId
  if (loopId === undefined) return null
  const isPrimaryLoopMember = component.metadata?.groupId === 'primary-loop'
    || component.kind === 'steamGenerator'
    || component.kind === 'centrifugalPump'
  if (!isPrimaryLoopMember) return null
  return {
    loopId,
    ordinal: component.metadata?.ordinal ?? component.index,
  }
}

export const referenceLoopIdsForGraph = (graph: CompiledPlantGraph): ReadonlyArray<ProcessPlantReferenceLoop> => {
  const entriesByLoopId = new Map<string, GraphLoopEntry>()
  for (const component of graph.components) {
    const metadataEntry = metadataLoopEntry(component)
    if (metadataEntry !== null) rememberLoopEntry(entriesByLoopId, metadataEntry.loopId, metadataEntry.ordinal)
    const pumpLoopId = primaryLoopIdForPump(component)
    if (pumpLoopId !== null) rememberLoopEntry(entriesByLoopId, pumpLoopId, component.index)
  }
  const entries = [...entriesByLoopId.values()].sort((left, right) => left.ordinal === right.ordinal
    ? left.loopId.localeCompare(right.loopId)
    : left.ordinal - right.ordinal)
  if (entries.length === 0) throw new Error(`reference PWR graph I&C requires at least one primary loop`)
  return entries.map(entry => entry.loopId)
}

export const pressurizedWaterReactorReferenceIcForGraph = (graph: CompiledPlantGraph): ProcessPlantIcConfig =>
  pressurizedWaterReactorReferenceIcFor(referenceLoopIdsForGraph(graph))
