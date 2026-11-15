// The goals editor (T12, design §7 GoalsEditor) and "Restore the goal order" (goals review 5): goals move up
// and down, their threshold and step change, and the change goes through the preview as one goals edit.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { trainACaseInputs } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { draftOf, goalsEditOf, goalsFromDraft, goalsLabel, moved, sameGoals } from './goals-editor.ts'
import { createNames } from './model.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: GoalsEditor } = await import('./GoalsEditor.svelte') as { default: Any }

const inputs = trainACaseInputs()
const context: Context = { inputs, names: createNames(inputs), format: createTimeFormat(inputs.settings.timeZone) }
const none = () => {}

describe('the goals editor', () => {
  test('moving cost first gives one goals edit with every goal kept whole, and a label that names the order', () => {
    const draft = moved(draftOf(inputs.goals), 1, -1)
    const built = goalsFromDraft(draft, inputs.goals, context)
    if (!built.ok) throw new Error(built.problems.join(' '))
    expect(built.goals).toEqual([inputs.goals[1]!, inputs.goals[0]!, inputs.goals[2]!])
    expect(goalsEditOf(built.goals)).toEqual([{ edit: 'goals', goals: [inputs.goals[1]!, inputs.goals[0]!, inputs.goals[2]!] }])
    expect(goalsLabel(built.goals, context)).toBe('New goal order: 1. Extra cost · 2. Over the 54 h guideline · 3. Equipment-hours out of service')
    // At either end nothing moves.
    expect(moved(draftOf(inputs.goals), 0, -1)).toEqual(draftOf(inputs.goals))
  })

  test('a threshold and a step change in their own units; a value that is not a number is said, never sent', () => {
    const draft = draftOf(inputs.goals).map((row, index) => index === 0 ? { ...row, threshold: '48' } : index === 1 ? { ...row, step: '10000' } : row)
    const built = goalsFromDraft(draft, inputs.goals, context)
    if (!built.ok) throw new Error(built.problems.join(' '))
    expect(built.goals[0]!.threshold).toEqual({ value: 48, unit: inputs.goals[0]!.threshold!.unit })
    expect(built.goals[1]!.tolerance).toEqual({ value: 10_000, unit: inputs.goals[1]!.tolerance.unit })
    expect(goalsFromDraft(draftOf(inputs.goals).map((row, index) => index === 1 ? { ...row, step: 'a lot' } : row), inputs.goals, context))
      .toEqual({ ok: false, problems: ['Extra cost: give the step as a number, 0 or more.'] })
    expect(sameGoals(goalsFromDraft(draftOf(inputs.goals), inputs.goals, context).ok ? inputs.goals : [], inputs.goals)).toBe(true)
  })

  test('"Restore the goal order" is offered once the goals differ from the order before the first change, and previews it', () => {
    const plain = readableText(renderHtml(GoalsEditor, { context, onPreview: none }))
    expect(plain).not.toContain('Restore the goal order')
    for (const word of ['Goals, in order', 'Move Extra cost up', 'Threshold (h)', 'Step (NOK)', 'Preview the goal change']) expect(plain).toContain(word)
    const earlier = [inputs.goals[1]!, inputs.goals[0]!, inputs.goals[2]!]
    const offered = readableText(renderHtml(GoalsEditor, { context, earlier, onPreview: none }))
    expect(offered).toContain('Restore the goal order')
    expect(offered).toContain('Restore puts back the goals as they were before your first goal change in this session, through the preview.')
    // Once restored, the goals equal the earlier ones and nothing is offered.
    expect(readableText(renderHtml(GoalsEditor, { context: { ...context, inputs: { ...inputs, goals: earlier } }, earlier, onPreview: none }))).not.toContain('Restore the goal order')
  })
})
