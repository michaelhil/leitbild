import { afterAll, describe, expect, test } from 'bun:test'
import { moduleCapabilityDescriptorSchema, type ModuleCapabilityDescriptor } from '@leitbild/contracts'
import { createHarness } from './fixtures/harness.ts'

const harness = await createHarness()
afterAll(() => harness.close())
const capabilities: ModuleCapabilityDescriptor[] = (await harness.request(`/internal/workspaces/${harness.workspaceId}/capabilities`)).body.capabilities.map((entry: unknown) => moduleCapabilityDescriptorSchema.parse(entry))
const byId = new Map(capabilities.map(entry => [String(entry.id), entry]))

// Design §5.1: ids, scopes, kinds and risks, exactly; the searchTerms as tuned on the controls phrasings
// (packages/integration-tests/tests/planning-vocabulary.test.ts).
const table = {
  'planning.plan.create': ['definition', 'command', 'write', ['new', 'blank', 'empty', 'template', 'example', 'demo', 'start', 'outage', 'maintenance', 'work week']],
  'planning.plan.edit': ['resource', 'command', 'write', ['job', 'activity', 'crew', 'shift', 'calendar', 'buy', 'scope', 'supported by', 'tag-out', 'link', 'FS', 'SS', 'FF', 'lag', 'protected', 'off limits', 'keep in service', 'at least one', 'available', 'finish on or before', 'data date', 'simulation run', 'schedule']],
  'planning.plan.generate': ['resource', 'command', 'write', ['optimise', 'alternatives', 'what-if', 'replan', 'reschedule', 'level', 'levelling', 'fit', 'window', 'variants', 'compress', 'overtime']],
  'planning.plan.explain': ['resource', 'query', 'read', ['why', 'late', 'critical path', 'longest path', 'driving', 'completion', 'limits', 'float', 'slack', 'held up', 'refused', 'impossible', 'why not earlier']],
  'planning.plan.read': ['resource', 'query', 'read', ['status', 'overview', 'attention', 'summary', 'rules', 'crews', 'schedule', 'history']],
  'planning.plan.baseline': ['resource', 'command', 'write', ['baseline', 'commit', 'freeze', 'approve', 'choose', 'target']],
  'planning.sources.refresh': ['workspace', 'command', 'write', ['refresh', 'update', 'latest', 'World', 'changed', 'reread', 'sync']],
  'planning.plan.display': ['resource', 'query', 'read', ['visualize', 'chart', 'gantt', 'show', 'schedule', 'deadline', 'can we finish', 'by a time']],
  'planning.plan.delete': ['resource', 'command', 'destructive', ['delete', 'remove', 'get rid of', 'discard', 'scrap', 'throw away']],
} as const

const undescribed = (schema: unknown, path = ''): string[] => {
  if (schema === null || typeof schema !== 'object') return []
  const node = schema as { properties?: Record<string, { description?: string }>; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[] }
  return [
    // The `edit` discriminator names itself (as in contract.test.ts).
    ...Object.entries(node.properties ?? {}).flatMap(([name, child]) => [...(child.description === undefined && (child as { anyOf?: unknown }).anyOf === undefined && name !== 'edit' ? [`${path}.${name}`] : []), ...undescribed(child, `${path}.${name}`)]),
    ...(node.items === undefined ? [] : undescribed(node.items, `${path}[]`)),
    ...[...(node.anyOf ?? []), ...(node.oneOf ?? [])].flatMap((branch, index) => undescribed(branch, `${path}|${index}`)),
  ]
}

describe('the Planning operations as published (design §5.1)', () => {
  test('exactly the published Planning operations, with their scopes, kinds, risks and search terms', () => {
    expect([...byId.keys()].sort()).toEqual(Object.keys(table).sort())
    for (const [id, [scope, kind, risk, terms]] of Object.entries(table)) {
      const descriptor = byId.get(id)!
      expect([descriptor.scope.kind, descriptor.kind, descriptor.risk]).toEqual([scope, kind, risk])
      expect(descriptor.searchTerms).toEqual([...terms])
      if (descriptor.scope.kind === 'resource') expect(String(descriptor.scope.resourceType)).toBe('planning.plan')
      if (descriptor.scope.kind === 'definition') expect(String(descriptor.scope.definitionType)).toBe('planning.plan-definition')
    }
  })

  test('descriptions are 300-700 characters in planner words, without the retired vocabulary', () => {
    for (const descriptor of capabilities) {
      expect(descriptor.description.length).toBeGreaterThanOrEqual(300)
      expect(descriptor.description.length).toBeLessThanOrEqual(700)
      expect(descriptor.description).not.toMatch(/study|qualification|digest|epoch|profile|production ready/i)
      if (descriptor.kind === 'command' && descriptor.id !== 'planning.plan.create' && descriptor.id !== 'planning.plan.delete') expect(descriptor.description).toContain('current revision')
    }
  })

  test('authority is a named person\'s, never the caller\'s own', () => {
    const edit = byId.get('planning.plan.edit')!
    const authority = (edit.inputSchema as { properties: Record<string, { description: string; properties: Record<string, { description: string }> }> }).properties.authority!
    expect(authority.description).toContain('Ask them; never fill this in yourself')
    expect(authority.properties.name!.description).toContain('named person')
    // The caller's actor kind is its own statement, not authentication (arch D2); an Assistant is refused anyway (adversary item 19).
    expect(edit.description).toContain('an Assistant is refused and asks a person to make it in the plan screen')
    expect(authority.description).toContain('An Assistant\'s edit that needs it is refused')
  })

  test('every input field is described, and inputs other than create and edit stay within 4 KB', () => {
    for (const descriptor of capabilities) {
      expect(undescribed(descriptor.inputSchema)).toEqual([])
      const bytes = new TextEncoder().encode(JSON.stringify(descriptor.inputSchema)).byteLength
      if (descriptor.id !== 'planning.plan.create' && descriptor.id !== 'planning.plan.edit') expect(bytes).toBeLessThanOrEqual(4_096)
    }
  })

  test('only the plans that can start independently expose a primary action', async () => {
    const definitions = (await harness.request(`/internal/workspaces/${harness.workspaceId}/definitions`)).body.definitions
    expect(definitions.map((entry: { ref: { id: string } }) => entry.ref.id)).toEqual(['blank', 'nuclear-maintenance-planning', 'halden-delivery-planning', 'train-a-work-week', 'supply-run'])
    for (const definition of definitions) {
      expect(definition).toMatchObject({ ref: { moduleId: 'planning', type: 'planning.plan-definition' }, capabilityIds: ['planning.plan.create'] })
      expect(definition.primaryCapabilityId).toBe(['halden-delivery-planning', 'nuclear-maintenance-planning'].includes(definition.ref.id) ? undefined : 'planning.plan.create')
      expect(definition.currentRevisionId).toMatch(/^[0-9a-f]{16}$/)
    }
    expect((await harness.request('/internal/featured-definitions')).body).toEqual({ definitions: [], listed: [] })
  })
})
