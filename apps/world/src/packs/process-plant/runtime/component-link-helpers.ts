import type { CompiledComponent, CompiledProcessLink, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { processLinkVariablePath } from './behavior-contract.ts'

export type ComponentLinkReadContext = {
  readonly has: (path: VariablePath) => boolean
  readonly readNumber: (path: VariablePath) => number
}

export const incomingComponentLinks = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): ReadonlyArray<CompiledProcessLink> =>
  (system.graph.incomingLinksByComponent[component.index] ?? [])
    .map(linkIndex => system.graph.links[linkIndex])
    .filter((link): link is CompiledProcessLink => link !== undefined && linkMatches(link))

export const outgoingComponentLinks = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): ReadonlyArray<CompiledProcessLink> =>
  (system.graph.outgoingLinksByComponent[component.index] ?? [])
    .map(linkIndex => system.graph.links[linkIndex])
    .filter((link): link is CompiledProcessLink => link !== undefined && linkMatches(link))

export const firstFluidService = (
  links: ReadonlyArray<CompiledProcessLink>,
): CompiledProcessLink['service'] | undefined =>
  links.find(link => link.kind === 'fluidFlow')?.service

export const fluidLinksForService = (
  links: ReadonlyArray<CompiledProcessLink>,
  service: CompiledProcessLink['service'],
): ReadonlyArray<CompiledProcessLink> =>
  links.filter(link => link.kind === 'fluidFlow' && service !== undefined && link.service === service)

export const sumProcessLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: ComponentLinkReadContext,
): number => {
  let total = 0
  for (const link of links) {
    const path = processLinkVariablePath(link, localPath)
    if (context.has(path)) total += context.readNumber(path)
  }
  return total
}

export const averageIncomingComponentLinkValue = (
  system: CompiledProcessPlant,
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
  system: CompiledProcessPlant,
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
  system: CompiledProcessPlant,
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
  system: CompiledProcessPlant,
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
  system: CompiledProcessPlant,
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

export const flowWeightedProcessLinkValueByService = (
  system: CompiledProcessPlant,
  localPath: string,
  context: ComponentLinkReadContext,
  service: string,
  linkMatches: (link: CompiledProcessLink) => boolean = () => true,
): number | null => {
  let weightedTotal = 0
  let flowTotal = 0
  for (const link of system.graph.links) {
    if (link.service !== service) continue
    if (!linkMatches(link)) continue
    const valuePath = processLinkVariablePath(link, localPath)
    const flowPath = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(valuePath) || !context.has(flowPath)) continue
    const flow = Math.max(0, context.readNumber(flowPath))
    if (flow <= 0) continue
    weightedTotal += context.readNumber(valuePath) * flow
    flowTotal += flow
  }
  return flowTotal <= 0 ? null : weightedTotal / flowTotal
}
