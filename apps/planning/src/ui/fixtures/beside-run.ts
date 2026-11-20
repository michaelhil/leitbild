// Test-only: the Host's catalogue entries for the Library beside a Run, as Planning and World publish them.
import { moduleResourceDescriptorSchema, workspaceIdSchema, type ModuleResourceDescriptor } from '@leitbild/contracts'
import { createPlanDefinitions, definitionDescriptors } from '../../definitions/index.ts'

export const workspace = workspaceIdSchema.parse('0b4b9a52-2f7e-4c1a-9d3e-00000000000a')
const observedAt = '2026-11-20T09:00:00.000Z'

/** The descriptors Planning publishes for its bundled Definitions. */
export const published = definitionDescriptors(workspace, createPlanDefinitions(), ['planning.plan.create'])

/** A World Run started from `scenario`. */
export const runResource = (id: string, title: string, scenario: string | null): ModuleResourceDescriptor => moduleResourceDescriptorSchema.parse({
  ref: { workspaceId: workspace, moduleId: 'world', type: 'world.simulation-run', id }, title,
  ...(scenario === null ? {} : { sourceDefinition: { workspaceId: workspace, moduleId: 'world', type: 'world.scenario', id: scenario, revisionId: 'r1' } }),
  links: [{ rel: 'member-of', ref: { workspaceId: workspace, moduleId: 'world', type: 'world.simulation-family', id } }],
  capabilityIds: [], summary: [{ key: 'status', label: 'Status', kind: 'status', value: 'Running' }], observedAt,
})

/** A plan; `run` is the Run its `about` link names, as Planning publishes it for a linked plan. */
export const planResource = (id: string, title: string, run: string | null): ModuleResourceDescriptor => moduleResourceDescriptorSchema.parse({
  ref: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id }, title,
  links: run === null ? [] : [{ rel: 'about', ref: { workspaceId: workspace, moduleId: 'world', type: 'world.simulation-run', id: run } }],
  uiPath: `/workspaces/${workspace}/planning?plan=${id}`, capabilityIds: [],
  summary: [{ key: 'updated-at', label: 'Updated', kind: 'timestamp', value: observedAt }], observedAt,
})
