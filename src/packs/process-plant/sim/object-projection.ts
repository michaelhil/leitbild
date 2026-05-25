import type { IsoTimestamp, ObjectId, OperationalObject, Provenance } from '../../../core/model/index.ts'
import type { SimulationEvent } from '../../../simulation/protocol.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { processPlantUnitDomainDataSchema } from '../model.ts'
import { processPlantProjectionKey, projectedProcessPlantUnit } from '../projection.ts'

export const processPlantUnitSystemId = (object: OperationalObject): string | null => {
  const parsed = processPlantUnitDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data.systemId : null
}

export const initialProcessPlantObjects = (config: {
  readonly initialObjects?: ReadonlyArray<OperationalObject>
  readonly scenario?: { readonly initialObjects?: ReadonlyArray<OperationalObject> }
}): ReadonlyArray<OperationalObject> =>
  config.initialObjects ?? config.scenario?.initialObjects ?? []

export const projectedInitialProcessPlantObjects = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): ReadonlyArray<OperationalObject> =>
  config.objects.map(object => {
    const systemId = processPlantUnitSystemId(object)
    return systemId === null
      ? object
      : projectedProcessPlantUnit({
          object,
          system: config.systems.get(systemId),
          at: config.at,
        })
  })

export const processPlantProjectionEvents = (config: {
  readonly objectsById: Map<ObjectId, OperationalObject>
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
  readonly provenance: Provenance
}): ReadonlyArray<SimulationEvent> => {
  const events: SimulationEvent[] = []
  for (const object of config.objectsById.values()) {
    const systemId = processPlantUnitSystemId(object)
    if (systemId === null) continue
    const next = projectedProcessPlantUnit({
      object,
      system: config.systems.get(systemId),
      at: config.at,
    })
    if (processPlantProjectionKey(object) === processPlantProjectionKey(next)) continue
    config.objectsById.set(next.id, next)
    events.push({
      type: 'object.upserted',
      object: next,
      at: config.at,
      provenance: config.provenance,
    })
  }
  return events
}
