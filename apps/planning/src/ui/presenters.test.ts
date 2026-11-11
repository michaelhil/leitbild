// Attention cards, the timeline layout, the shift list and explanations, on lane A's fixtures.
import { describe, expect, test } from 'bun:test'
import { attentionCards } from './attention.ts'
import { finishChain, floatText, whyStart } from './explain-text.ts'
import { hourMs, modelOf, supplyRunPlanned, trainAInputs, trainAPlanned, trainARows } from './fixtures/plans.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import { dueMoveEdit } from './edit-forms.ts'
import { weakensRule } from './plan-actions.ts'
import { durationView, ruleMark, ruleView, targetMark } from './rules-text.ts'
import { shiftList } from './shift-list.ts'
import type { Context } from './status-text.ts'
import { layoutTimeline } from './timeline-layout.ts'

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })

describe('Needs your attention', () => {
  test('the link card comes first until a Run is linked; then reading World; then the plan', () => {
    const unlinked = modelOf(trainAInputs())
    const cards = attentionCards(unlinked, contextOf(unlinked))
    expect(cards[0]!.actions).toEqual(['open-workspace', 'link-run'])
    expect(cards[0]!.steps).toHaveLength(3)

    const inputs = trainAInputs()
    const linked = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: '2026-11-12T09:00:00Z' } } })
    expect(attentionCards(linked, contextOf(linked))[0]!.actions).toEqual(['refresh'])
  })

  test('the Module\'s own items follow in acting order, then the recommended option with its warnings beside the status', () => {
    const planned = trainAPlanned()
    const warning = 'MFW A and MFW B are taken out and no rule keeps any of them in service.'
    const model: PlanModel = {
      ...planned,
      attention: [
        { kind: 'warning', text: 'A warning', about: [] },
        { kind: 'not-ready', text: 'The spare depends on the vendor\'s promise, Mon 12:00.', about: ['SWA-SPARE-PREP'] },
        { kind: 'refusal', text: 'A refusal', about: [] },
      ],
      options: { ...planned.options!, items: planned.options!.items.map(option => ({ ...option, warnings: [{ text: warning, about: [] }] })) },
    }
    const cards = attentionCards(model, contextOf(model))
    const titles = cards.map(card => card.title)
    expect(titles.indexOf('A refusal')).toBeLessThan(titles.indexOf('The spare depends on the vendor\'s promise, Mon 12:00.'))
    expect(titles.indexOf('The spare depends on the vendor\'s promise, Mon 12:00.')).toBeLessThan(titles.indexOf('A warning'))
    const answer = cards[cards.length - 1]!
    expect(answer.title).toBe('Option 1: validated feasible.')
    expect(answer.steps).toEqual([warning])
    expect(answer.actions).toEqual(['why-finish'])
  })

  test('a stale option claims no status; above the certified size Generate is refused in words', () => {
    const planned = trainAPlanned()
    const stale: PlanModel = { ...planned, options: { ...planned.options!, items: planned.options!.items.map(option => ({ ...option, fresh: false })) } }
    expect(attentionCards(stale, contextOf(stale)).at(-1)!.title).toContain('was made before the latest change')
    const size = { family: 'single-train work weeks', maxJobs: planned.inputs.jobs.length - 1, evidence: 'measured 11 Nov' }
    const large: PlanModel = { ...planned, certifiedSize: size }
    const refusal = attentionCards(large, contextOf(large)).find(card => card.title === 'Too large for the certified size.')!
    expect(refusal.text).toBe(`Generate is certified for single-train work weeks up to ${size.maxJobs} jobs (measured 11 Nov); this plan has ${planned.inputs.jobs.length}.`)
  })
})

describe('the timeline', () => {
  test('availability per group follows supports; limit and guideline marks come from the plan', () => {
    const model = trainAPlanned()
    const layout = layoutTimeline(model.inputs, model.rows['opt-1']!, createTimeFormat(model.inputs.settings.timeZone))!
    const chain = layout.availability.find(lane => lane.group === model.inputs.groups.find(group => group.key === 'COOL-A')!.label)!
    // CCW A, HX A, RHR A and HHSI A are out while SW A is out (supports), so all five share its outage.
    const supported = model.inputs.equipment.filter(item => item.group === 'COOL-A').map(item => item.label)
    expect(chain.items.filter(item => item.segments.length === 1).map(item => item.label)).toEqual(supported)
    const rows = trainARows(model.inputs)
    const window = (Date.parse(model.inputs.settings.window!.end) - Date.parse(model.inputs.settings.window!.start))
    // The limit mark sits 72 h after the first tag-out, as a share of the window.
    const rule = model.inputs.rules.find(item => item.kind === 'span-limit')!
    if (rule.kind !== 'span-limit') throw new Error('fixture')
    expect(chain.limitAt).toBeCloseTo((Date.parse(rows[0]!.start) + rule.limit.value * hourMs - Date.parse(model.inputs.settings.window!.start)) / window * 100, 6)
    expect(chain.breaks).toBeNull()
    // Groups with nothing planned still say their limit.
    expect(layout.availability.find(lane => lane.group === model.inputs.groups.find(group => group.key === 'CS-A')!.label)!.summary).toBe('No outage limit. Not planned yet.')
  })

  test('load lanes count crews in use against their number and hatch time off shift', () => {
    const model = trainAPlanned()
    const layout = layoutTimeline(model.inputs, model.rows['opt-1']!, createTimeFormat(model.inputs.settings.timeZone))!
    const mech = layout.loads.find(lane => lane.label === 'Station mechanical crew')!
    // One pull of 5 h by one of two crews: 5 crew-hours.
    expect(mech.summary).toBe('5 crew-hours used.')
    expect(mech.capacity).toBe('2 at a time')
    expect(mech.offShift.length).toBeGreaterThan(0)
    const workControl = layout.loads.find(lane => lane.label.startsWith('Work-control'))!
    expect(workControl.capacity).toBe('one at a time')
    expect(workControl.offShift).toEqual([])
    expect(layout.jobs.map(bar => bar.mark.word)).toEqual(['Tag-out', 'Work', 'Test'])
  })

  test('the Supply run draws trucks as lanes with no group lanes', () => {
    const model = supplyRunPlanned()
    const layout = layoutTimeline(model.inputs, model.rows['opt-1']!, createTimeFormat(model.inputs.settings.timeZone))!
    expect(layout.availability).toEqual([])
    expect(layout.loads.map(lane => lane.label)).toEqual(model.inputs.resources.map(resource => resource.label))
    expect(layout.ticks[0]!.label).toBe('10:00')
  })
})

describe('shift list, estimates, rules and explanations', () => {
  test('the phone list groups jobs by 12-hour shift from the window start', () => {
    const model = trainAPlanned()
    const shifts = shiftList(model.inputs, model.rows['opt-1']!, createTimeFormat(model.inputs.settings.timeZone))
    expect(shifts.map(shift => shift.title)).toEqual(['Mon 07:00–19:00', 'Tue 07:00–19:00'])
    expect(shifts[1]!.entries.map(entry => entry.who)).toEqual(['Station mechanical crew and 60 t mobile crane with operator and rigger', 'Work-control operator (one tag-out or restoration at a time) and Test team (one return-to-service test at a time)'])
  })

  test('estimates show ranges and sources; unread World values show no number', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const pull = model.inputs.jobs.find(job => job.key === 'SWA-PUMP-OUT')!
    expect(durationView(pull, [], context.format).text).toBe(`${pull.duration.value} h of working time (${pull.duration.range!.low} h to ${pull.duration.range!.high} h)`)
    const supply = supplyRunPlanned()
    const unread = durationView(supply.inputs.jobs[0]!, [], createTimeFormat(supply.inputs.settings.timeZone))
    expect(unread.text).toBe('Not read from World yet')
    expect(unread.mark.word).toBe('Unknown')
  })

  test('rules read in words with kind and source mark', () => {
    const model = supplyRunPlanned()
    const view = ruleView(model.inputs.rules[0]!, contextOf(model))
    expect(view.kind).toBe('Keep in service')
    expect(view.mark).toEqual({ shape: '■', word: 'Rule' })
  })

  test('why it starts then names joint causes and float with what limits it', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const rows = model.rows['opt-1']!
    const pull = rows.find(row => row.job === 'SWA-PUMP-OUT')!
    const why = whyStart({
      job: 'SWA-PUMP-OUT', start: pull.start, finish: pull.finish, floatHours: pull.float.workingHours, joint: true,
      because: [{ kind: 'tool', about: ['crane'], until: pull.start }, { kind: 'link', about: ['SWA-TAG'] }],
    }, context, pull)
    expect(why.joint).toBe(true)
    expect(why.sentence).toBe('It starts then because all of these hold at once (easing only one does not move it): 60 t mobile crane with operator and rigger is in use until Tue 07:00; it follows Remove SW A from service and hang tags.')
    expect(floatText({ workingHours: 6, limitedBy: { kind: 'span-limit', rule: 'R2' } }, context)).toBe('Float 6 h, limited by: “Once the first cooling-chain item is tagged out, all must be back and tested within 72 h.” (logic and shifts only; crews and outage limits are checked separately)')
    const chain = finishChain({ lines: [], items: [{ job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: false, because: [{ kind: 'link', about: ['SWA-PUMP-OUT'] }] }] }, context)
    expect(chain).toEqual([{ job: 'Restore SW A, fill and vent, pump test', when: 'Tue 12:00–15:30', because: 'it follows Pull SW A pump assembly', due: null }])
  })
})

describe('the hard due rule', () => {
  // Hand calculation: the window ends Sat 07:00 local, so 16 h earlier is Fri 15:00, inside the window.
  const base = trainAPlanned()
  const finishBy = new Date(Date.parse(base.inputs.settings.window!.end) - 16 * hourMs).toISOString()
  const due = { kind: 'due' as const, key: 'D1', job: 'SWA-RTS', finishBy, words: 'SW A must be back for the Friday surveillance.', source: { by: 'reference' as const, note: 'Surveillance schedule' } }
  const model: PlanModel = { ...base, inputs: { ...base.inputs, rules: [...base.inputs.rules, due] } }
  const context = contextOf(model)

  test('reads as a rule with its source, and limits float and the finish', () => {
    const view = ruleView(due, context)
    expect([view.kind, view.mark.word, view.source.mark.word, view.covers]).toEqual(['Due', 'Rule', 'Reference', 'Restore SW A, fill and vent, pump test must finish by Fri 15:00. No plan may finish it later.'])
    expect(floatText({ workingHours: 2, limitedBy: { kind: 'due', rule: 'D1' } }, context)).toBe('Float 2 h, limited by: due Fri 15:00 (logic and shifts only; crews and outage limits are checked separately)')
    const rows = model.rows['opt-1']!
    const [step] = finishChain({ lines: [], items: [{ job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: false, because: [{ kind: 'link', about: ['SWA-PUMP-OUT'] }] }] }, context)
    expect(step!.due).toBe(`Due Fri 15:00: ${due.words}`)
  })

  test('a soft target and a hard due differ by shape and word', () => {
    expect(targetMark).not.toEqual(ruleMark)
    expect([targetMark.shape, ruleMark.shape]).toEqual(['◎', '■'])
  })

  test('moving it later or removing it asks who agreed; moving it earlier does not', () => {
    const later = dueMoveEdit('D1', '2026-11-20T18:00', model.inputs)
    const earlier = dueMoveEdit('D1', '2026-11-20T12:00', model.inputs)
    expect(later.ok && earlier.ok).toBe(true)
    if (!later.ok || !earlier.ok) return
    expect(weakensRule(model, later.edits)).toBe('Moving a due time later weakens it')
    expect(weakensRule(model, earlier.edits)).toBeNull()
    expect(weakensRule(model, [{ edit: 'remove', what: 'rule', key: 'D1' }])).toBe('Removing this rule weakens it')
    expect(dueMoveEdit('D1', '2026-11-22T12:00', model.inputs)).toEqual({ ok: false, problems: ['The due time must lie inside the plan window.'] })
  })
})
