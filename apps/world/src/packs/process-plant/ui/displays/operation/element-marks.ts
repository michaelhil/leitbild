import type { ObjectId, SimulationRunId } from '../../../../../core/model/index.ts'
import type { PackElementMarks } from '../../../../../core/packs/protocol.ts'
import type { ProcessPlantProposal } from '../../../operations/proposals.ts'
import type { ListedItem } from '../../../operations/instance-ports.ts'
import { operationClient, type OperationClient } from './operation-client.ts'

// What a drawing in the display window marks on the Plant's items (plan v5
// W3.6, PackEmbedContribution.elementMarks): the items World offers controls
// on (controls.list), whose magnifier always shows, and the items a pending
// proposal waits on (control.proposals), the one that lapses first first,
// which carry OpenBridge's command request badge and whose faceplate a
// display opened on that equipment pins. The items offered change rarely, so
// they are read again only every OFFERED_EVERY_MS; the proposals every time.

export const OFFERED_EVERY_MS = 10_000

/** The marks, from the Plant's listed items and its proposals. */
export const elementMarks = (items: ReadonlyArray<Pick<ListedItem, 'id' | 'offered'>>, proposals: ReadonlyArray<Pick<ProcessPlantProposal, 'item' | 'status' | 'expiresAtElapsedMs' | 'proposer'>>): PackElementMarks => ({
  operated: items.filter(item => item.offered.length > 0).map(item => item.id),
  pending: proposals.filter(proposal => proposal.status === 'pending')
    .sort((left, right) => left.expiresAtElapsedMs - right.expiresAtElapsedMs)
    .map(proposal => ({ element: proposal.item, ai: proposal.proposer.origin === 'ai' })),
})

/** A reader that keeps each Plant's offered items for OFFERED_EVERY_MS. */
export const createMarksReader = (client: OperationClient, now: () => number = () => Date.now()) => {
  const offered = new Map<string, { readonly at: number; readonly items: ReadonlyArray<Pick<ListedItem, 'id' | 'offered'>> }>()
  return async (runId: SimulationRunId, objectId: ObjectId): Promise<PackElementMarks> => {
    const key = `${runId}\u0000${objectId}`
    const known = offered.get(key)
    const [items, held] = await Promise.all([
      known !== undefined && now() - known.at < OFFERED_EVERY_MS ? Promise.resolve(known.items) : client.controls(runId, objectId, null).then(listed => {
        offered.set(key, { at: now(), items: listed.items })
        return listed.items
      }),
      client.proposals(runId, objectId),
    ])
    return elementMarks(items, held.proposals.map(entry => entry.proposal))
  }
}

export const read = createMarksReader(operationClient)
