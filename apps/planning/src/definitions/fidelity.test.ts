// The case Definitions are lane A's fixtures, unchanged: a change to a case goes through the fixture (and
// maint's freeze), never through the Definition. Run the scratch generator again if a fixture changes.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { workspaceIdSchema } from '@leitbild/contracts'
import { stableJson } from '@leitbild/module-runtime'
import { bundledPlanDefinitions, definitionRevisionId } from './index.ts'
import { startPlan } from './start.ts'

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).json()
const fixture = async (name: string) => read(`../plan/fixtures/${name}`)

describe('Definition fidelity', () => {
  test('Train A work week is the full frozen case v0.2 (train-a.case.json), unchanged', async () => {
    const inputs = (await read('./train-a-work-week.plan-definition.json')).inputs
    const frozen = await fixture('train-a.case.json')
    expect(inputs).toEqual(frozen)
    expect([inputs.jobs.length, inputs.links.length]).toEqual([frozen.jobs.length, frozen.links.length])
  })

  test('Train A states what each SW A method leaves unpriced: the frozen case\'s spare exposure (design §1.1, T10)', async () => {
    const frozen = await read('../solve/fixtures/train-a-case-v0.2.json')
    const measure = frozen.measures.find((entry: { id?: string }) => entry.id === 'spare-exposure')
    const options = (await read('./train-a-work-week.plan-definition.json')).inputs.methods[0].options
    const caseMethod: Record<string, string> = { rebuild: 'M1-rebuild', swap: 'M2-swap' }
    expect(options.map((option: { key: string }) => option.key)).toEqual(Object.keys(caseMethod))
    for (const option of options) {
      const method = frozen.methods.SWA.find((entry: { id: string }) => entry.id === caseMethod[option.key])
      expect(option.caveats).toEqual([{ label: measure.label, value: method.spareExposureWeeks, unit: measure.unit, words: method.spareExposureBasis ?? measure.definition }])
    }
    // The two methods differ on it, as the case's own comparison table shows.
    expect(new Set(options.map((option: { caveats: Array<{ value: number }> }) => option.caveats[0]!.value)).size).toBe(2)
  })

  test('Supply run is the converted case2 fixture, unchanged, from the frozen case2 v1.1', async () => {
    expect((await read('./supply-run.plan-definition.json')).inputs).toEqual(await fixture('supply-run.case2.json'))
    const recorded = (await Bun.file(new URL('../plan/fixtures/supply-run.case2.sha256', import.meta.url)).text()).trim().split(/\s+/)
    expect(recorded).toEqual(['b1f7ee7d112ebfb55fbb3a683f958c96019a785f7d8f272642e6e6ed6637e542', 'case2-v1.1.json'])
  })

  test('each Definition starts unlinked; the cases name their World Scenario; the revision is 16 hex of its document', async () => {
    for (const [file, scenario] of [['blank', undefined], ['halden-delivery-planning', 'halden-delivery-planning'], ['train-a-work-week', 'train-a-work-week'], ['supply-run', 'supply-run']] as const) {
      const document = await read(`./${file}.plan-definition.json`)
      const definition = bundledPlanDefinitions.find(entry => entry.id === document.id)!
      expect(definition.inputs.settings.run).toBeNull()
      expect(definition.inputs.settings.scenario?.id).toBe(scenario)
      expect(definition.revisionId).toBe(definitionRevisionId(document))
      expect(definition.revisionId).toBe(createHash('sha256').update(stableJson(document)).digest('hex').slice(0, 16))
    }
  })

  test('a plan Definition reads differently from the World Scenario it starts from (walk fix 12)', () => {
    for (const definition of bundledPlanDefinitions.filter(entry => entry.inputs.settings.scenario !== undefined)) {
      expect(definition.title.startsWith('Plan: ')).toBe(true)
      expect(definition.title).not.toBe(definition.inputs.settings.scenario!.title)
      expect(definition.title).not.toBe(definition.inputs.settings.title)
    }
  })

  test('a plan made from a case Definition is titled apart from its World Run; a title the caller gives wins (walk 2, R2-9)', () => {
    const start = (id: string, edits: Parameters<typeof startPlan>[0]['edits'] = []) => startPlan({
      definition: bundledPlanDefinitions.find(entry => entry.id === id)!, workspaceId: workspaceIdSchema.parse('00000000-0000-4000-8000-0000000000aa'), id: '00000000-0000-4000-8000-000000000009',
      at: '2026-11-11T08:00:00Z', by: { kind: 'human' }, edits,
    }).plan.inputs.settings.title
    for (const definition of bundledPlanDefinitions.filter(entry => entry.inputs.settings.scenario !== undefined)) {
      const title = start(definition.id)
      expect(title).toBe(`${definition.inputs.settings.title}: plan`)
      expect(title).not.toBe(definition.inputs.settings.scenario!.title)
    }
    expect(start('train-a-work-week', [{ edit: 'plan', title: 'Week 47' }])).toBe('Week 47')
    expect(start('blank')).toBe('New plan')
  })

  test('New plan has no zone, window, Run or Scenario', () => {
    const blank = bundledPlanDefinitions.find(entry => entry.id === 'blank')!
    expect(blank.inputs.settings).toMatchObject({ title: 'New plan', timeZone: null, window: null, run: null, grid: '30min' })
    expect(blank.inputs.settings.scenario).toBeUndefined()
    expect([blank.inputs.jobs, blank.inputs.equipment, blank.inputs.resources, blank.inputs.rules]).toEqual([[], [], [], []])
  })
})
