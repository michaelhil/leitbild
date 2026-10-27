import type { ObjectId, SimulationRunId } from '../../../../../core/model/index.ts'
import type { PackElementMarks } from '../../../../../core/packs/protocol.ts'
import type { ProcessPlantProposal } from '../../../operations/proposals.ts'
import { operationClient, type OperationClient } from './operation-client.ts'

// What a drawing in the display window marks on the Plant's items (plan v5
// W3.6, PackEmbedContribution.elementMarks): the items a pending proposal
// waits on (control.proposals), the one that lapses first first, which carry
// OpenBridge's command request badge, and whose
// faceplate a display opened on that equipment pins.

/** The marks, from the Plant's proposals. */
export const elementMarks = (proposals: ReadonlyArray<Pick<ProcessPlantProposal, 'item' | 'status' | 'expiresAtElapsedMs' | 'proposer'>>): PackElementMarks => ({
  pending: proposals.filter(proposal => proposal.status === 'pending')
    .sort((left, right) => left.expiresAtElapsedMs - right.expiresAtElapsedMs)
    .map(proposal => ({ element: proposal.item, ai: proposal.proposer.origin === 'ai' })),
})

/** A reader of a Plant's marks through its operation client. */
export const createMarksReader = (client: OperationClient) =>
  async (runId: SimulationRunId, objectId: ObjectId): Promise<PackElementMarks> =>
    elementMarks((await client.proposals(runId, objectId)).proposals.map(entry => entry.proposal))

export const read = createMarksReader(operationClient)
