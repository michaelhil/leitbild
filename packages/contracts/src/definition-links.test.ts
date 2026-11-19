import { describe, expect, test } from 'bun:test'
import { ABOUT_RELATION, moduleDefinitionDescriptorSchema } from './definitions.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const descriptor = {
  ref: { workspaceId, moduleId: 'planning', type: 'planning.plan-definition', id: 'nuclear-maintenance-planning' },
  title: 'A cooling-train maintenance campaign',
  currentRevisionId: 'r1',
  capabilityIds: [],
}
const scenario = { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'nuclear-maintenance-planning' }

describe('Definition links', () => {
  test('a Definition without links parses to a descriptor without the field', () => {
    expect('links' in moduleDefinitionDescriptorSchema.parse(descriptor)).toBe(false)
  })

  test('a Definition may say which Definition of another Module it is about', () => {
    const parsed = moduleDefinitionDescriptorSchema.parse({ ...descriptor, links: [{ rel: ABOUT_RELATION, ref: scenario }] })
    expect(JSON.parse(JSON.stringify(parsed.links))).toEqual([{ rel: 'about', ref: scenario }])
  })

  test('refuses a link into another Workspace, an empty list and an unknown link field', () => {
    const elsewhere = { ...scenario, workspaceId: '2e828b43-37fc-4437-aa70-302d7f442ceb' }
    expect(moduleDefinitionDescriptorSchema.safeParse({ ...descriptor, links: [{ rel: ABOUT_RELATION, ref: elsewhere }] }).success).toBe(false)
    expect(moduleDefinitionDescriptorSchema.safeParse({ ...descriptor, links: [] }).success).toBe(false)
    expect(moduleDefinitionDescriptorSchema.safeParse({ ...descriptor, links: [{ rel: ABOUT_RELATION, ref: scenario, title: 'x' }] }).success).toBe(false)
  })
})
