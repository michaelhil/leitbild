import type { CompiledProcessPlant } from '../../process-plant/plant-compiler.ts'
import type { z } from 'zod'
import { physicalCorrespondenceSchema } from '../model.ts'
import type { PhysicalCoverageEvidence } from '../coverage.ts'
import type { Source } from '../native/drafting/source.ts'

/** An offline installation step for the explicitly modeled DC assemblies.
 * Retained battery/inverter/control-bank machinery stays geometrically exact.
 * New cabinet positions are illustrative; they do not set electrical capacity.
 * The caller solves new exact graph-port electrical routes after this step. */
export const installPwrDcSupportHardware = (input: {
  readonly source: Source
  readonly bindings: Array<z.infer<typeof physicalCorrespondenceSchema>>
  readonly coverage: PhysicalCoverageEvidence
  readonly plant: CompiledProcessPlant
}): ReadonlyArray<string> => {
  const { source, bindings, coverage, plant } = input
  if (!source.routing || !source.planAnnotations) throw Error('DC installation requires native routing and Plan annotations')
  const added: string[] = []
  for (const [train, x] of [['A', 4], ['B', 33]] as const) {
    const battery = source.elements.find(element => element.id === `equipment/vitalBattery${train}`)
    const inverter = source.elements.find(element => element.id === `equipment/dcInverter${train}`)
    if (!battery || !inverter?.typeId) throw Error(`DC installation has no retained battery/inverter machinery for train ${train}`)
    battery.label = `Vital DC supply ${train} — battery and integrated charger`
    const retained = coverage.dispositions.find(row => row.subjectId === `vitalBattery${train}`)
    if (!retained) throw Error(`DC installation has no battery coverage for train ${train}`)
    retained.reason = 'Exact graph-owned finite battery and integrated AC charger assembly. Retained battery-rack geometry represents the bounded assembly abstraction; charging supply, actual energy, losses and downstream load are native model observations, not geometry-derived capacities.'
    // The graph channel is its processing function. Its explicitly authored
    // cabinet housing anchors the power cable, without inventing field RTD
    // positions or drawing overlapping duplicate cabinets for each channel.
    const cabinet = source.elements.find(element => element.id === `equipment/plantControlsLoad${train}`)
    if (!cabinet) throw Error(`No retained train ${train} processing cabinet`)
    for (const channel of plant.sourceGraph.components.filter(component => component.kind === 'deltaTProtectionChannel' && plant.sourceGraph.connections.some(edge => edge.from === `dcInverter${train}.acOutlet` && edge.to === `${component.id}.power`))) {
      const subjectId = String(channel.id), row = coverage.dispositions.find(entry => entry.subjectId === subjectId)
      if (!row) throw Error(`No retained instrument coverage ${subjectId}`)
      row.physicalElementIds = [cabinet.id]
      row.reason = 'Graph-owned delta-T processing function with actual vital inverter power. The retained controls cabinet explicitly houses its illustrative electronics and anchors its exact power-port route; individual field temperature/flow sensor locations remain unprovided.'
      bindings.push({ physicalElementId: cabinet.id, elementId: subjectId, relation: 'houses' })
    }
    const subject = `dcNonessentialLoad${train}`, id = `equipment/${subject}`, label = `UPS discretionary loads ${train}`
    if (!plant.sourceGraph.components.some(component => String(component.id) === subject)) throw Error(`DC installation has no graph subject ${subject}`)
    if (source.elements.some(element => element.id === id)) throw Error(`Duplicate DC installation ${id}`)
    source.elements.push({ id, label, kind: 'equipment', equipmentKind: 'cabinet', typeId: inverter.typeId, levelId: 'service',
      pose: { position: [x, 73, 8], yaw: 0 }, buildingId: 'building/electrical-control', spaceIds: [`space/battery-${train.toLowerCase()}`], disposition: 'installed' })
    source.routing.obstacleElementIds.push(id)
    bindings.push({ physicalElementId: id, elementId: subject, relation: 'represents' })
    coverage.dispositions.push({ subjectId: subject, disposition: 'direct', reason: 'Named native discretionary UPS load group with actual feeder control and served demand. The cabinet is an illustrative grouped-load installation, not an invented extra battery or a calibrated equipment load schedule.', physicalElementIds: [id] })
    source.planAnnotations.push({ id: `annotation/label/${subject}`, kind: 'label', role: 'equipment', text: label, levelIds: ['service'],
      scopeIds: [source.rootScope.id, 'building/electrical-control', `space/battery-${train.toLowerCase()}`], layerId: 'plan-labels',
      anchor: { elementId: id, local: [1.5, 2, 2.5] }, rotation: 0 })
    added.push(id)
  }
  return added
}
