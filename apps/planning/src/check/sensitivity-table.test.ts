import { describe, expect, test } from 'bun:test'
import { checkPlan } from './check.ts'
import { judgedInputs, judgeRetiming } from './retime.ts'
import { trainAInputs } from '../solve/fixtures/train-a-case.ts'
import { flagshipOption, renderTable, sensitivityRows } from '../../tests/harness/sensitivity-table.ts'

// The +25 % sensitivity table (lane K batch 2, decision 3): the script runs, and every figure it prints is
// lane K's, recomputed here: each outcome by judgeRetiming on the case's re-timed rows, each outage by the
// checker on the judged rows. The coordinator copies the printed table into the wiki at release.
const script = new URL('../../tests/harness/sensitivity-table.ts', import.meta.url).pathname
const inputs = trainAInputs({ read: true })
const option = await flagshipOption(inputs)
const rows = sensitivityRows(inputs, option)
const markdown = renderTable(inputs, option, rows)
const group = 'COOL-A'   // the flagship's outage goal covers this one group (its span-over goal's scope)
const hours = (value: number) => `${Number(value.toFixed(2))} h`

describe('the sensitivity table', () => {
  test('the outage goal is over the one group the table reads', () => {
    expect(inputs.goals.find(goal => goal.metric === 'span-over')?.scope?.groups).toEqual([group])
  })
  test('the script runs and prints this table', async () => {
    const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' })
    const printed = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(printed.trim()).toBe(markdown)
  }, 60_000)
  test('a row per case: +25 % on every job, every three-point job high, then each alone', () => {
    const ranged = inputs.jobs.filter(job => option.rows.some(row => row.job === job.key) && job.duration.range !== undefined).map(job => job.key)
    expect(rows.map(row => row.high.length > 1 ? row.label : row.high[0])).toEqual(['+25 % on every job', 'Every three-point job at its high estimate', ...ranged])
  })
  test('every outcome is judgeRetiming\'s, on the rows the case re-timed', () => {
    for (const row of rows) {
      if (row.retimed === undefined) throw new Error(`${row.label} was not re-timed: ${row.none}`)
      expect(judgeRetiming(row.inputs, option.variant, option.rows, row.retimed, row.high)).toEqual(row.judged!)
      expect(row.judged!.ok).toBe(true)
    }
  })
  test('every outage is the checker\'s span of the group on the judged rows, or not returned', () => {
    for (const row of rows) {
      const retimed = row.retimed ?? []
      const check = checkPlan(judgedInputs(row.inputs, row.high, retimed), option.variant, retimed)
      const open = inputs.equipment.filter(item => item.group === group).some(item => (check.outages.get(item.key) ?? []).some(interval => interval.to === Infinity))
      expect(row.outage).toBe(open ? 'open' : check.metrics.find(metric => metric.id === `span:${group}`)?.value ?? 0)
    }
  })
  test('every hour figure printed is one of those, or the rule\'s own limit', () => {
    const planned = checkPlan(inputs, option.variant, option.rows).metrics.find(metric => metric.id === `span:${group}`)!.value
    const allowed = new Set([
      hours(planned),
      ...rows.flatMap(row => typeof row.outage === 'number' ? [hours(row.outage)] : []),
      ...rows.flatMap(row => row.judged?.ok === true && !row.judged.outcome.holds && 'rule' in row.judged.outcome ? [hours(row.judged.outcome.by.value)] : []),
      ...inputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [`${rule.limit.value} ${rule.limit.unit}`] : []),
    ])
    const printed = [...markdown.matchAll(/(\d+(?:\.\d+)?) h\b/g)].map(match => match[0])
    expect(printed.length).toBeGreaterThan(rows.length)
    expect(printed.filter(figure => !allowed.has(figure))).toEqual([])
  })
  test('tube cleaning alone at its high estimate leaves the eddy-current test unplaced (lane S\'s real case)', () => {
    const cleaning = rows.find(row => row.high.length === 1 && row.high[0] === 'CCWHXA-CLEAN')!
    expect(cleaning.judged).toEqual({ ok: true, outcome: { holds: false, unplaced: { job: 'CCWHXA-ECT', resource: 'ect-team', after: '2026-11-18T10:30:00.000Z' } } })
  })
})
