// The case Definitions are lane A's fixtures, unchanged: a change to a case goes through the fixture (and
// maint's freeze), never through the Definition. Run the scratch generator again if a fixture changes.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { stableJson } from '@leitbild/module-runtime'
import { bundledPlanDefinitions, definitionRevisionId } from './index.ts'

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).json()
const fixture = async (name: string) => read(`../plan/fixtures/${name}`)

describe('Definition fidelity', () => {
  test('Train A work week is the Train A fixture, unchanged', async () => {
    expect((await read('./train-a-work-week.plan-definition.json')).inputs).toEqual(await fixture('train-a.fragment.json'))
  })

  test('Supply run is the converted case2 fixture, unchanged, from the frozen case2.json', async () => {
    expect((await read('./supply-run.plan-definition.json')).inputs).toEqual(await fixture('supply-run.case2.json'))
    const recorded = (await Bun.file(new URL('../plan/fixtures/supply-run.case2.sha256', import.meta.url)).text()).split(/\s+/)[0]
    expect(recorded).toBe('7339108b116d0e86c9cb7380ef1eb389dddf2694c3556ab2b7146540705fdb42')
  })

  test('each Definition starts unlinked; the cases name their World Scenario; the revision is 16 hex of its document', async () => {
    for (const [file, scenario] of [['blank', undefined], ['train-a-work-week', 'train-a-work-week'], ['supply-run', 'supply-run']] as const) {
      const document = await read(`./${file}.plan-definition.json`)
      const definition = bundledPlanDefinitions.find(entry => entry.id === document.id)!
      expect(definition.inputs.settings.run).toBeNull()
      expect(definition.inputs.settings.scenario?.id).toBe(scenario)
      expect(definition.revisionId).toBe(definitionRevisionId(document))
      expect(definition.revisionId).toBe(createHash('sha256').update(stableJson(document)).digest('hex').slice(0, 16))
    }
  })

  test('New plan has no zone, window, Run or Scenario', () => {
    const blank = bundledPlanDefinitions.find(entry => entry.id === 'blank')!
    expect(blank.inputs.settings).toMatchObject({ title: 'New plan', timeZone: null, window: null, run: null, grid: '30min' })
    expect(blank.inputs.settings.scenario).toBeUndefined()
    expect([blank.inputs.jobs, blank.inputs.equipment, blank.inputs.resources, blank.inputs.rules]).toEqual([[], [], [], []])
  })
})
