import type { CompiledComponent, CompiledProcessLink, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { processLinkVariablePath } from './behavior-contract.ts'

export type ComponentLinkReadContext = {
  readonly has: (path: VariablePath) => boolean
  readonly readNumber: (path: VariablePath) => number
}

export const averageIncomingComponentLinkValue = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  localPath: string,
  context: ComponentLinkReadContext,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): number | null => {
  let total = 0
  let count = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link) continue
    if (!linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    count += 1
  }
  return count === 0 ? null : total / count
}

export const averageOutgoingComponentLinkValue = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  localPath: string,
  context: ComponentLinkReadContext,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): number | null => {
  let total = 0
  let count = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link) continue
    if (!linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    count += 1
  }
  return count === 0 ? null : total / count
}

export const sumIncomingComponentLinkValue = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  localPath: string,
  context: ComponentLinkReadContext,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): number => {
  let total = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link) continue
    if (!linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
  }
  return total
}

export const sumOutgoingComponentLinkValue = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  localPath: string,
  context: ComponentLinkReadContext,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): number => {
  let total = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link) continue
    if (!linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
  }
  return total
}

export const sumProcessLinkValueByService = (
  system: CompiledProcessPlantSystem,
  localPath: string,
  context: ComponentLinkReadContext,
  service: string,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): number => {
  let total = 0
  for (const link of system.graph.links) {
    if (link.service !== service) continue
    if (!linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
  }
  return total
}
