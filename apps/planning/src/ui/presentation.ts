import type { PlanningProblem, PlanningPlacement } from '../model.ts'

export const elapsed = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  if (hours) return `${hours}h ${minutes}m${remainder ? ` ${remainder}s` : ''}`
  if (minutes) return `${minutes}m${remainder ? ` ${remainder}s` : ''}`
  return `${seconds}s`
}

export const barPosition = (horizon: PlanningProblem['horizon'], placement: Pick<PlanningPlacement, 'start' | 'end'>) => {
  const span = horizon.end - horizon.start
  const left = Math.max(0, Math.min(100, (placement.start - horizon.start) / span * 100))
  const right = Math.max(left, Math.min(100, (placement.end - horizon.start) / span * 100))
  return { left, width: right - left }
}

export const fittedHorizon = (horizon: PlanningProblem['horizon'], placements: ReadonlyArray<Pick<PlanningPlacement, 'end'>>): PlanningProblem['horizon'] => {
  if (!placements.length) return horizon
  const finish = Math.max(horizon.start, ...placements.map(placement => placement.end))
  const span = Math.max(1, finish - horizon.start)
  // Small whole-minute breathing room keeps a final milestone inside the plot.
  return { start: horizon.start, end: Math.min(horizon.end, horizon.start + Math.max(60, Math.ceil(span * 1.08 / 60) * 60)) }
}

export const movePriority = (order: string[], id: string, direction: -1 | 1): string[] => {
  const index = order.indexOf(id)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= order.length) return order
  const next = [...order]
  const other = next[destination]
  if (other === undefined) return order
  next[index] = other
  next[destination] = id
  return next
}

export const optionalSecond = (value: string): number | undefined => {
  if (value.trim() === '') return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Times must be non-negative whole seconds.')
  return number
}
