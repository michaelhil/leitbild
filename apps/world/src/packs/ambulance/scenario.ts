import { z } from 'zod'
import type { PackScenarioSupport } from '../../core/packs/protocol.ts'
import { ambulanceItemSchema, ambulanceSpecSchema, careSiteSpecSchema, incidentSpecSchema, patientSpecSchema } from './item-schemas.ts'
import { createAmbulanceItem, validateAmbulanceObjects } from './sim/object-state.ts'

export const ambulanceScenarioSupport: PackScenarioSupport = {
  referencedObjects: item => item.type === 'patient' ? [String(item.incidentId)] : typeof item.atObject === 'string' ? [item.atObject] : [],
  itemSchemas: {
    ambulance: ambulanceSpecSchema.extend({ pack: z.literal('ambulance') }),
    incident: incidentSpecSchema.extend({ pack: z.literal('ambulance') }),
    patient: patientSpecSchema.extend({ pack: z.literal('ambulance') }),
    'care-site': careSiteSpecSchema.extend({ pack: z.literal('ambulance') }),
  },
  expandItem: async (raw, context) => {
    const { pack: _, ...input } = raw
    const item = ambulanceItemSchema.parse(input)
    return { objects: [createAmbulanceItem(item, { at: context.at, simulationTimeMs: Date.parse(context.at), objectById: context.objectById })] }
  },
  validateInitialObjects: objects => validateAmbulanceObjects(objects),
}
