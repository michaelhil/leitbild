import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
import type { VignetteOpening } from './opening.svelte.ts'

// A person acknowledging alerts in a list (plan v5 W2.7): each press sends the rows' acknowledgements through their
// Packs' commands (opening.acknowledge, the display window only), and keeps them as on their way, for the occurrence
// pressed, until a sample shows them acknowledged; a refusal says why (`failed`) and lets them be pressed again.

export const acknowledging = (opening: () => VignetteOpening | undefined, failed: (reason: string | null) => void) => {
  /** By row: the raise time of the occurrence pressed. */
  let sent = $state<ReadonlyMap<string, string>>(new Map())
  const acking = (row: AlertRow): boolean => row.acknowledge !== undefined && sent.get(row.key) === row.alert.raisedAt
  /** Acknowledges these rows (those still asking), as a press handler. */
  const ack = (rows: ReadonlyArray<AlertRow>) => (): void => {
    const asked = rows.filter(row => row.acknowledge !== undefined && !acking(row))
    const by = opening()
    if (by === undefined || !by.acknowledges || asked.length === 0) return
    sent = new Map([...sent, ...asked.map(row => [row.key, row.alert.raisedAt] as const)])
    void by.acknowledge(asked).then(reason => {
      failed(reason === null ? null : `Not acknowledged: ${reason}`)
      if (reason !== null) sent = new Map([...sent].filter(([key]) => !asked.some(row => row.key === key)))
    })
  }
  return { acking, ack }
}
