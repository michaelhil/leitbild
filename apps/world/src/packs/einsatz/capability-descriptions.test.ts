import { describe, expect, test } from 'bun:test'
import { capabilityJsonSchema, isPublicCapability } from '../../simulation/capabilities.ts'
import { einsatzCapabilities, einsatzGuidance } from './capabilities.ts'
import { einsatzPack } from './pack.ts'

/**
 * The Einsatz Capability surface an agent reads: seventeen Capabilities, each
 * public one described in at most 600 characters with an example, every
 * input field described, search terms set, and one line of Pack guidance.
 * The planning projection is World core's system read, not an agent's.
 */

type JsonSchema = { readonly description?: string; readonly properties?: Readonly<Record<string, JsonSchema>>; readonly items?: JsonSchema; readonly anyOf?: ReadonlyArray<JsonSchema>; readonly oneOf?: ReadonlyArray<JsonSchema> }

/** A GeoJSON point is core's wire value, described as a whole where a field takes one. */
const isPoint = (schema: JsonSchema): boolean => Object.keys(schema.properties ?? {}).sort().join() === 'coordinates,type'

/** Every object property under a schema, by path, with whether it carries a description. */
const fields = (schema: JsonSchema, path: string): Array<readonly [string, boolean]> => isPoint(schema) ? [] : [
  ...Object.entries(schema.properties ?? {}).flatMap(([key, value]) => [[`${path}.${key}`, typeof value.description === 'string' && value.description.length > 0] as const, ...fields(value, `${path}.${key}`)]),
  ...(schema.items === undefined ? [] : fields(schema.items, `${path}[]`)),
  ...[...schema.anyOf ?? [], ...schema.oneOf ?? []].flatMap(member => fields(member, path)),
]

describe('Einsatz Capability descriptions', () => {
  test('seventeen Capabilities: six queries, eleven commands, none of the cut ids', () => {
    expect(einsatzCapabilities).toHaveLength(17)
    expect(einsatzCapabilities.filter(capability => capability.kind === 'query')).toHaveLength(6)
    const ids = einsatzCapabilities.map(capability => capability.id)
    for (const cut of ['send', 'queue', 'step.remove', 'resume', 'clear', 'hold', 'plan.reorder']) expect(ids).not.toContain(`world.einsatz.unit.${cut}`)
  })

  for (const capability of einsatzCapabilities.filter(isPublicCapability)) {
    test(`${capability.id}: at most 600 characters with an example, search terms, every input field described`, () => {
      expect(capability.description.length).toBeLessThanOrEqual(600)
      expect(capability.description).toContain('Example')
      expect(capability.searchTerms?.length ?? 0).toBeGreaterThan(0)
      const undescribed = fields(capabilityJsonSchema(capability.input) as JsonSchema, 'input').filter(([, described]) => !described).map(([path]) => path)
      expect(undescribed).toEqual([])
    })
  }

  test('the Pack guidance fits one line and names the three-call recipe', () => {
    expect(einsatzGuidance.length).toBeLessThanOrEqual(200)
    expect(einsatzPack.knowledge?.guidance).toBe(einsatzGuidance)
    for (const id of ['world.einsatz.situation', 'world.einsatz.recommend', 'world.einsatz.unit.order']) expect(einsatzGuidance).toContain(id)
  })
})
