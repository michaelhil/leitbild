// Attention cards, the timeline layout, the shift list and explanations, on lane A's fixtures.
import { describe, expect, test } from 'bun:test'
import { attentionCards } from './attention.ts'
import { causeText, finishChain, floatText, whyStart } from './explain-text.ts'
import { hourMs, modelOf, supplyRunPlanned, trainAInputs, trainAPlanned, trainARows } from './fixtures/plans.ts'
import { createTimeFormat } from './format.ts'
import { certifiedSizeWords, jobsPerSolve } from '../plan/summary.ts'
import { createNames, type PlanModel } from './model.ts'
import { dueMoveEdit } from './edit-forms.ts'
import { weakensRule } from './plan-actions.ts'
import { revealPanel } from './reveal.ts'
import { calendarText, durationView, orderView, resourceHoursText, ruleMark, ruleView, targetMark } from './rules-text.ts'
import { shiftList } from './shift-list.ts'
import type { Context } from './status-text.ts'
import { jobMark, layoutTimeline } from './timeline-layout.ts'

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
      options: { ...planned.options!, items: planned.options!.items.map(option => ({ ...option, warnings: [{ kind: 'redundancy' as const, text: warning, about: [] }] })) },
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
    const size = { decided: false, family: 'single-train work weeks', maxJobs: jobsPerSolve(planned.inputs) - 1, evidence: 'measured 11 Nov' }
    const large: PlanModel = { ...planned, certifiedSize: size }
    const refusal = attentionCards(large, contextOf(large)).find(card => card.title === 'Too large for the certified size.')!
    // The evidence is for reviewers; the card says the size in words only (maint's walk G2).
    // The refusal in planner words, jobs counted per solve (after method selection).
    expect(refusal.text).toBe(`This plan has ${jobsPerSolve(planned.inputs)} jobs. Planning is certified for plans of up to ${size.maxJobs} jobs (single-train work weeks); larger plans wait for the owner's decision.`)
    expect(certifiedSizeWords(size)).toBe('Certified plan size: pending the owner\'s decision')
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
    expect(floatText({ workingHours: 6, limitedBy: { kind: 'span-limit', rule: 'R2' } }, context)).toBe('Float 6 h, limited by: “Once the first cooling-chain item is tagged out, all must be back and tested within 72 h.” (crew availability is not counted)')
    const chain = finishChain({ lines: [], items: [{ job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: false, because: [{ kind: 'link', about: ['SWA-PUMP-OUT'] }] }] }, context)
    expect(chain).toEqual([{ job: 'Restore SW A, fill and vent, pump test', when: 'Tue 12:00–15:30', because: 'it follows Pull SW A pump assembly', due: null }])
  })
})

describe('causes name the real items (walk 2, R2-3)', () => {
  test('a crew cause names the crew and the jobs holding it; a shift cause names who is off duty', () => {
    const train = contextOf(trainAPlanned())
    const busy = causeText({ kind: 'crew', about: ['mech-station', 'SWA-TAG', 'CCWA-TAG'], until: '2026-11-18T09:00:00Z' }, train)
    expect(busy).toBe(`Station mechanical crew is busy with Remove SW A from service and hang tags and Remove CCW A pump and HX A from service and hang tags until ${train.format.clock('2026-11-18T09:00:00Z')}`)
    const supply = contextOf(supplyRunPlanned())
    const shift = causeText({ kind: 'shift', about: ['truck-2'], until: '2026-09-03T08:02:00Z' }, supply)
    expect(shift).toBe(`no working time for ${supply.names.resource('truck-2')} until ${supply.format.clock('2026-09-03T08:02:00Z')}`)
    for (const text of [busy, shift]) expect(text).not.toContain('no longer in this plan')
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
    expect(floatText({ workingHours: 2, limitedBy: { kind: 'due', rule: 'D1' } }, context)).toBe('Float 2 h, limited by: due Fri 15:00 (crew availability is not counted)')
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

describe('review fixes: hours, deadlines, marks, ticks, reveal', () => {
  const planned = trainAPlanned()
  const context = contextOf(planned)
  const calendar = (key: string) => planned.inputs.calendars.find(item => item.key === key)!
  const resource = (key: string) => planned.inputs.resources.find(item => item.key === key)!

  test('shift and crane hours read in words in the plan zone', () => {
    expect(calendarText(calendar('day'), context.format)).toBe('Mon–Fri 07:00–15:00')
    expect(calendarText(calendar('always'), context.format)).toBe('every day around the clock')
    expect(calendarText(calendar('crane'), context.format)).toBe('Tue 07:00–19:00, Wed 07:00–19:00, Thu 07:00–19:00')
    expect(calendarText(calendar('none'), context.format)).toBe('no working time of its own')
    expect(resourceHoursText(resource('mech-station'), planned.inputs, context.format)).toBe('Mon–Fri 07:00–15:00; Mon–Fri 15:00–19:00 if “Station mechanical overtime to 19:00” is bought')
    expect(resourceHoursText(resource('mech-contractor'), planned.inputs, context.format)).toBe('no working time of its own; Mon 19:00 – Tue 07:00, Tue 19:00 – Wed 07:00 and 2 more if “Contractor night crew (nights Mon to Thu)” is bought')
    const supply = supplyRunPlanned()
    const join = supply.inputs.calendars.find(item => item.key === 'joins-0802')!
    // The authored label says 08:02 (scenario clock); the screen's own words are plan-zone time.
    expect(calendarText(join, createTimeFormat(supply.inputs.settings.timeZone))).toBe('Thu 10:02–10:30')
  })

  test('an order deadline in the past says so; before it, it is a decision', () => {
    const purchase = planned.inputs.purchases.find(item => item.orderBy !== undefined)!
    expect(orderView(purchase, planned.inputs, context.format)).toEqual({ mark: { shape: '⚑', word: 'Decision' }, text: `Order “${purchase.label}” by Fri 12:00.` })
    // Hand value: one hour after the deadline.
    const late = { ...planned.inputs, settings: { ...planned.inputs.settings, dataDate: new Date(Date.parse(purchase.orderBy!) + hourMs).toISOString() } }
    expect(orderView(purchase, late, context.format)).toEqual({ mark: { shape: '!', word: 'Deadline passed' }, text: `Order deadline passed Fri 12:00: “${purchase.label}” can no longer be bought.` })
  })

  test('a decision and a test do not share a shape', () => {
    const decision = attentionCards({ ...planned, attention: [{ kind: 'decision', text: 'Choose', about: [] }] }, context).find(card => card.title === 'Choose')!
    expect(decision.mark.shape).not.toBe(jobMark('test').shape)
  })

  test('the window start is the first labelled tick', () => {
    const layout = layoutTimeline(planned.inputs, planned.rows['opt-1']!, context.format)!
    expect(layout.ticks[0]).toEqual({ left: 0, label: 'Mon 07:00' })
    expect(layout.ticks[1]!.label).toBe('Tue 17 Nov')
  })

  test('a revealed panel scrolls its heading into view and focuses it', () => {
    const calls: string[] = []
    const heading = { scrollIntoView: (options?: ScrollIntoViewOptions) => { calls.push(`scroll ${options?.behavior}`) }, focus: (options?: FocusOptions) => { calls.push(`focus ${options?.preventScroll}`) } }
    expect(revealPanel({ querySelector: selector => selector === 'h2' ? heading : null }, false)).toBe(true)
    expect(revealPanel({ querySelector: () => heading }, true)).toBe(true)
    expect(calls).toEqual(['focus true', 'scroll smooth', 'focus true', 'scroll auto'])
    expect(revealPanel({ querySelector: () => null }, false)).toBe(false)
  })
})
