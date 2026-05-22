import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { componentVariablePath } from './behavior-contract.ts'
import { boundedApproach, firstOrderLag } from './physics.ts'

export type ComponentNumericReadContext = {
  readonly has: (path: VariablePath) => boolean
  readonly readNumber: (path: VariablePath) => number
}

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export const approach = (current: number, target: number, maxDelta: number): number =>
  boundedApproach({ current, target, maxDelta })

export const relaxToward = (current: number, target: number, dtSeconds: number, timeConstantSeconds: number): number =>
  firstOrderLag({ current, target, dtSeconds, timeConstantSeconds })

export const parameterNumber = (component: CompiledComponent, key: string): number => {
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`component ${component.id} parameters are not an object`)
  const value = (parameters as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`component ${component.id} missing numeric parameter ${key}`)
  return value
}

export const optionalParameterNumber = (component: CompiledComponent, key: string, defaultValue: number): number => {
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`component ${component.id} parameters are not an object`)
  const value = (parameters as Record<string, unknown>)[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`component ${component.id} parameter ${key} must be numeric`)
  return value
}

export const optionalParameterBoolean = (component: CompiledComponent, key: string, defaultValue: boolean): boolean => {
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`component ${component.id} parameters are not an object`)
  const value = (parameters as Record<string, unknown>)[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') throw new Error(`component ${component.id} parameter ${key} must be boolean`)
  return value
}

export const hasComponentVariable = (component: CompiledComponent, localPath: string): boolean =>
  component.variables.some(variable => variable.path === componentVariablePath(component, localPath))

export const averageFor = (
  components: ReadonlyArray<CompiledComponent>,
  valueFor: (component: CompiledComponent) => number | null,
): number | null => {
  let total = 0
  let count = 0
  for (const component of components) {
    const value = valueFor(component)
    if (value === null) continue
    total += value
    count += 1
  }
  return count === 0 ? null : total / count
}

export const findFirstComponentByKind = (
  system: CompiledProcessPlantSystem,
  kind: string,
): CompiledComponent | null =>
  system.graph.components.find(component => String(component.kind) === kind) ?? null

export const sumComponentValueByKind = (
  system: CompiledProcessPlantSystem,
  kind: string,
  localPath: string,
  context: ComponentNumericReadContext,
): number => {
  let total = 0
  for (const component of system.graph.components) {
    if (String(component.kind) !== kind) continue
    const path = componentVariablePath(component, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
  }
  return total
}
