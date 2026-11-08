import { engineeringOwnerInputSchema, engineeringProjectionCapability } from '../../../simulation/engineering-inputs.ts'
import { unavailableQueryReadScope } from '../../../simulation/query-read-policy.ts'
import { gridFor, type ElectricGridQuery } from './common.ts'

export const gridEngineeringInputsQuery: ElectricGridQuery = {
  capability: engineeringProjectionCapability('world.electric-grid.engineering-basis'),
  answer: (raw, grids, _recording, policy) => {
    const input = engineeringOwnerInputSchema.parse(raw)
    if (!policy.canInspect(input.subjectId)) unavailableQueryReadScope('This source is outside the shared engineering research profile')
    const grid = gridFor(grids, input.subjectId)
    if (input.purpose === 'qualify') return { allowed: true }
    const projection = grid.projection
    const quantities = [
      { id: 'generation', label: 'Total generation', value: projection.totalGenerationMw },
      { id: 'demand', label: 'Total demand', value: projection.totalLoadMw },
      { id: 'served', label: 'Served load', value: projection.servedLoadMw },
      { id: 'unserved', label: 'Unserved load', value: projection.unservedLoadMw },
      { id: 'reserve', label: 'Reserve margin', value: projection.reserveMarginMw },
    ].map(row => ({ ...row, quantity: 'power', unit: 'MW', quality: projection.notConvergedIslandCount > 0 ? 'unknown' : 'good' }))
    return { quantities, modelElapsedMs: grid.elapsedMs, modelDigest: grid.definition.model.id, domainEnd: null }
  },
}
