// No hand-typed schedule numbers: a Definition holds inputs only. No job is locked, no option, row, baseline
// or float is carried, and no World value is typed in (World values are read at refresh).
import { expect, test } from 'bun:test'
import { bundledPlanDefinitions } from './index.ts'

const keysIn = (value: unknown, path = ''): string[] => value === null || typeof value !== 'object' ? []
  : Array.isArray(value) ? value.flatMap((entry, index) => keysIn(entry, `${path}[${index}]`))
    : Object.entries(value).flatMap(([key, entry]) => [`${path}.${key}`, ...keysIn(entry, `${path}.${key}`)])

test('no Definition carries a schedule or a typed-in World value', async () => {
  for (const file of ['blank', 'halden-delivery-planning', 'train-a-work-week', 'supply-run']) {
    const document = await Bun.file(new URL(`./${file}.plan-definition.json`, import.meta.url)).json()
    expect(Object.keys(document).sort()).toEqual(['description', 'id', 'inputs', 'title'])
    const paths = keysIn(document.inputs)
    expect(paths.filter(path => /\.(lock|rows|baselines|float|start|finish)$|^\.options$/.test(path) && !path.includes('periods') && !path.includes('window') && !path.includes('replaces') && !path.includes('except') && !path.includes('during'))).toEqual([])
  }
  for (const definition of bundledPlanDefinitions) {
    expect(definition.inputs.world).toEqual({ refreshedAt: null, facts: [] })
    for (const job of definition.inputs.jobs) if (job.duration.origin.by === 'world') expect(job.duration.value).toBeNull()
    for (const resource of definition.inputs.resources) for (const attribute of resource.attributes) if (attribute.origin.by === 'world') expect(attribute.value).toBeNull()
  }
})
