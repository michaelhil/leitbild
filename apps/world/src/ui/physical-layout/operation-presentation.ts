import type { PhysicalSubjectOperation } from './operation.ts'

/** Words follow explicit operational roles, never equipment-name heuristics. */
export const physicalOperationWord = (operation: PhysicalSubjectOperation | undefined): string | null => {
  const equipment = operation?.equipment
  if (!equipment) return null
  if (equipment.running) return equipment.running.word ?? (equipment.running.active === null ? 'Running state unknown' : equipment.running.active ? 'Running' : 'Stopped')
  if (equipment.positions.length) return equipment.positions.map(position => position.word ?? 'Position unknown').join(' · ')
  if (equipment.conducting) return equipment.conducting.word ?? (equipment.conducting.active === null ? 'State unknown' : equipment.conducting.active ? 'Conducting' : 'Not conducting')
  return null
}

/** Actuating flow movers/switches expose their state by default. Ordinary
 * converter/assembly words stay opt-in so one turbine subject's many casings
 * do not bury the architectural drawing under repeated normal labels. */
export const physicalOperationBadgeWord = (operation: PhysicalSubjectOperation | undefined, ordinary: boolean): string | null =>
  ordinary || operation?.equipment?.class === 'mover' || operation?.equipment?.class === 'switch' ? physicalOperationWord(operation) : null

/** Pointer context; connection cards may also show their endpoints and live flow.
 * Equipment cards use the shared process faceplate without these layout lists. */
export const physicalOperationContext = (operation: PhysicalSubjectOperation | undefined): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  if (!operation) return []
  const context: Array<{ label: string; value: string }> = []
  if (operation.connection) {
    const { from, to, medium } = operation.connection
    context.push({ label: 'From', value: `${from.label} · ${from.port}` }, { label: 'To', value: `${to.label} · ${to.port}` }, { label: 'Medium', value: medium.label })
  }
  if (operation.componentConnections !== null) {
    if (!operation.componentConnections.length) context.push({ label: 'Component-level connections', value: 'None declared in owner topology' })
    for (const { from, to, medium, directed } of operation.componentConnections) context.push({ label: 'Component-level connection', value: `${from.label} · ${from.port} ${directed ? '→' : '↔'} ${to.label} · ${to.port} · ${medium.label}` })
  }
  if (operation.flow) {
    const flow = operation.flow
    const direction = flow.state === 'stopped' ? 'No flow' : flow.direction === 'forward' ? 'From → To' : flow.direction === 'reverse' ? 'To → From' : flow.state === 'flowing' ? 'Flowing · direction not measured' : 'Unknown'
    context.push({ label: 'Flow', value: [direction, flow.word, flow.quality !== 'good' ? flow.reason ?? flow.quality : null].filter(Boolean).join(' · ') })
  } else if (operation.flows.length) {
    for (const flow of operation.flows) context.push({ label: flow.label, value: flow.word ?? flow.reason ?? 'Unknown' })
  }
  if (operation.conducting) context.push({ label: 'State', value: operation.conducting.word ?? (operation.conducting.active === null ? 'Unknown' : operation.conducting.active ? 'Conducting' : 'Not conducting') })
  const word = physicalOperationWord(operation)
  if (word) context.push({ label: 'Equipment', value: word })
  return context
}
