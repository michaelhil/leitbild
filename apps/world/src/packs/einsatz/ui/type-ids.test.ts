import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod'
import { roeModes } from '../config-schema.ts'
import { einsatzPackId } from '../ids.ts'
import { lexiconKeys } from '../lexicon.ts'

/**
 * The Dispatch panel derives everything from the Run's read models, so no
 * id a shipped configuration declares (a unit type, task template, load
 * class, group, priority or property) appears in its code, tests included:
 * not as a string literal, and an id of more than one word not inside any
 * text either. The demo words themselves are `tests/einsatz-vocabulary.test.ts`'s.
 * An id that is also one of the Pack's closed mechanism words (a rule of
 * engagement such as "hold", a lexicon key) names the mechanism, not the
 * configuration, and is not looked for.
 */

const mechanismWords: ReadonlySet<string> = new Set<string>([...roeModes, ...lexiconKeys])

const packRoot = join(import.meta.dir, '..')
const scenariosRoot = join(import.meta.dir, '..', '..', '..', 'scenarios')

const entriesSchema = z.array(z.object({ id: z.string().min(1), properties: z.array(z.object({ id: z.string().min(1) }).loose()).optional() }).loose()).optional()
const configSchema = z.object({
  unitTypes: entriesSchema,
  taskTemplates: entriesSchema,
  loadClasses: entriesSchema,
  groups: entriesSchema,
  priorities: entriesSchema,
}).loose()
const definitionSchema = z.object({ packs: z.array(z.object({ id: z.string(), config: z.unknown().optional() }).loose()).optional() }).loose()

const shippedIds = async (): Promise<ReadonlySet<string>> => {
  const ids = new Set<string>()
  for await (const path of new Bun.Glob('*.scenario.json').scan({ cwd: scenariosRoot })) {
    const definition = definitionSchema.parse(await Bun.file(join(scenariosRoot, path)).json())
    for (const pack of definition.packs ?? []) {
      if (pack.id !== einsatzPackId) continue
      const config = configSchema.parse(pack.config ?? {})
      for (const entries of [config.unitTypes, config.taskTemplates, config.loadClasses, config.groups, config.priorities]) {
        for (const entry of entries ?? []) {
          ids.add(entry.id)
          for (const property of entry.properties ?? []) ids.add(property.id)
        }
      }
    }
  }
  for (const word of mechanismWords) ids.delete(word)
  return ids
}

const uiFiles = async (): Promise<ReadonlyArray<string>> => {
  const files = ['ui-pack.ts', 'ui-pack.test.ts']
  for await (const path of new Bun.Glob('ui/**/*.{ts,svelte}').scan({ cwd: packRoot })) files.push(path)
  return files.sort()
}

/** Every string literal's content, as written. */
const literals = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)].map(match => match[1] ?? match[2] ?? '')

describe('Dispatch panel vocabulary', () => {
  test('the shipped configurations declare ids to look for, and the scope holds the panel\'s code and tests', async () => {
    const ids = await shippedIds()
    expect(ids.size).toBeGreaterThan(20)
    const files = await uiFiles()
    expect(files).toContain('ui/DispatchPanel.svelte')
    expect(files).toContain('ui/selection.ts')
    expect(files).toContain('ui/presenters.test.ts')
  })

  test('the check reads every string literal', () => {
    expect(literals(`const a = 'x-y'; const b = "z"`)).toEqual(['x-y', 'z'])
  })

  test('no shipped configuration id appears in the panel\'s code', async () => {
    const ids = await shippedIds()
    const findings: string[] = []
    for (const file of await uiFiles()) {
      const source = await Bun.file(join(packRoot, file)).text()
      for (const literal of literals(source)) if (ids.has(literal)) findings.push(`${file}: '${literal}'`)
      for (const id of ids) {
        if (id.includes('-') && new RegExp(`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`).test(source)) findings.push(`${file}: ${id}`)
      }
    }
    expect([...new Set(findings)]).toEqual([])
  })
})
