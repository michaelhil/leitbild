import type { Observable, Observation } from '../../core/observation/model.ts'

/** True means active only by boolean truth or an explicitly active enum state. */
export const activeState = (value: Observation['value'] | undefined, states: Observable['states']): boolean | null => {
  if (typeof value === 'boolean') return value
  const entries = states ?? []
  if (typeof value !== 'string' || !entries.some(entry => entry.active === true)) return null
  return entries.find(entry => entry.value === value)?.active === true
}
