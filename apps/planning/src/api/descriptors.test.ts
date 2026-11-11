import { afterAll, describe, expect, test } from 'bun:test'
import { moduleCapabilityDescriptorSchema, type ModuleCapabilityDescriptor } from '@leitbild/contracts'
import { createHarness } from './fixtures/harness.ts'

const harness = await createHarness()
afterAll(() => harness.close())
const capabilities: ModuleCapabilityDescriptor[] = (await harness.request(`/internal/workspaces/${harness.workspaceId}/capabilities`)).body.capabilities.map((entry: unknown) => moduleCapabilityDescriptorSchema.parse(entry))
const byId = new Map(capabilities.map(entry => [String(entry.id), entry]))

// Design §5.1: ids, scopes, kinds and risks, and the searchTerms table, exactly.
const table = {
  'planning.plan.create': ['definition', 'command', 'write', ['plan', 'planning', 'new', 'start', 'maintenance', 'outage', 'schedule', 'work', 'week', 'template', 'demo']],
  'planning.plan.edit': ['resource', 'command', 'write', ['change', 'edit', 'add', 'job', 'task', 'link', 'crew', 'shift', 'calendar', 'rule', 'estimate', 'lock', 'move', 'overtime', 'method']],
  'planning.plan.generate': ['resource', 'command', 'write', ['generate', 'schedule', 'plan', 'optimise', 'options', 'alternatives', 'what-if', 'replan', 'fit', 'window']],
  'planning.plan.explain': ['resource', 'query', 'read', ['why', 'explain', 'late', 'critical', 'limits', 'finish', 'driving', 'refused', 'impossible', 'float']],
  'planning.plan.read': ['resource', 'query', 'read', ['status', 'overview', 'attention', 'summary', 'rules', 'crews', 'schedule', 'history']],
  'planning.plan.baseline': ['resource', 'command', 'write', ['baseline', 'commit', 'freeze', 'approve', 'choose']],
  'planning.sources.refresh': ['workspace', 'command', 'write', ['refresh', 'update', 'latest', 'World', 'changed', 'reread']],
  'planning.plan.delete': ['resource', 'command', 'destructive', ['delete', 'remove']],
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
  test('exactly the eight Planning operations, with their scopes, kinds, risks and search terms', () => {
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

  test('every input field is described, and inputs other than create and edit stay within 4 KB', () => {
    for (const descriptor of capabilities) {
      expect(undescribed(descriptor.inputSchema)).toEqual([])
      const bytes = new TextEncoder().encode(JSON.stringify(descriptor.inputSchema)).byteLength
      if (descriptor.id !== 'planning.plan.create' && descriptor.id !== 'planning.plan.edit') expect(bytes).toBeLessThanOrEqual(4_096)
    }
  })

  test('the three Definitions name create as their primary and are not featured', async () => {
    const definitions = (await harness.request(`/internal/workspaces/${harness.workspaceId}/definitions`)).body.definitions
    expect(definitions.map((entry: { ref: { id: string } }) => entry.ref.id)).toEqual(['blank', 'train-a-work-week', 'supply-run'])
    for (const definition of definitions) {
      expect(definition).toMatchObject({ ref: { moduleId: 'planning', type: 'planning.plan-definition' }, primaryCapabilityId: 'planning.plan.create', capabilityIds: ['planning.plan.create'] })
      expect(definition.currentRevisionId).toMatch(/^[0-9a-f]{16}$/)
    }
    expect((await harness.request('/internal/featured-definitions')).body).toEqual({ definitions: [], listed: [] })
  })
})
