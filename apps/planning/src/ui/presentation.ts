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
