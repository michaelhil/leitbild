// One solver runs at a time in Planning, for Generate and edit previews. The screen holds previews while
// the person's own Generate runs, never shows "solver busy" for that run, and words it for another plan's.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { createPlanningClient, refusalText } from './api.ts'
import { trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames } from './model.ts'
import { createPreviewGate } from './preview-gate.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: PlanHeader } = await import('./PlanHeader.svelte') as { default: Any }
const { default: JobForm } = await import('./JobForm.svelte') as { default: Any }

const model = trainAPlanned()
const context: Context = { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) }
const none = () => {}

describe('one solver at a time', () => {
  test('while the person\'s Generate runs, the screen says "Generating…" and preview actions are held', () => {
    const header = readableText(renderHtml(PlanHeader, { context, title: model.title, size: null, generating: true, onGenerate: none, onCancel: none }))
    expect(header).toContain('Generating…')
    expect(header).toContain('Cancel')
    // The forms' Preview buttons are disabled while it runs (the screen passes busy for the run).
    const form = renderHtml(JobForm, { context, busy: true, onPreview: none })
    expect([...form.matchAll(/<button type="submit"[^>]*>Preview<\/button>/g)].every(match => / disabled/.test(match[0]))).toBe(true)
  })

  test('a preview asked for during the run waits and runs when Generate ends; only the latest is kept', () => {
    const gate = createPreviewGate()
    expect(gate.request({ edits: [], label: 'before' })).toBe(true)
    gate.start()
    expect(gate.request({ edits: [{ edit: 'plan', title: 'First' }], label: 'first' })).toBe(false)
    expect(gate.request({ edits: [{ edit: 'plan', title: 'Second' }], label: 'second' })).toBe(false)
    expect(gate.end()).toEqual({ edits: [{ edit: 'plan', title: 'Second' }], label: 'second' })
    expect(gate.end()).toBeNull()
    expect(gate.request({ edits: [], label: 'after' })).toBe(true)
  })

  test('a solver-busy answer from another plan\'s run is said in planner words, never as a raw error', async () => {
    const client = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => Response.json({ error: { code: 'solver_busy', message: 'solver_busy: the solver child is running', retryable: true } }, { status: 503 }))
    const error = await client.edit(model.id, model.revision, { edits: [{ edit: 'plan', title: 'x' }], preview: true }).catch((cause: unknown) => cause)
    expect(refusalText(error)).toBe('Planning is generating another plan; try again in about 20 seconds.')
  })
})
