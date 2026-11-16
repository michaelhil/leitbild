import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPlan } from './check.ts'
import { judgedInputs, judgeRetiming } from './retime.ts'
import { tableFor } from '../../tests/harness/sensitivity-table.ts'

// The +25 % sensitivity table (lane K batch 2, decision 3; fix round): it runs on a stored plan's baseline,
// names at the top which plan, revision, baseline and option it used, and every figure it prints is lane K's,
// recomputed here: each outcome by judgeRetiming, each outage by the checker on the judged rows. Here the
// plan is the committed increment 1 Train A plan file (plan/fixtures/increment-1-plan.json), made through the
// Module's own operations with its baseline "Freeze"; the coordinator runs the script on the published demo.
const script = new URL('../../tests/harness/sensitivity-table.ts', import.meta.url).pathname
const file = await Bun.file(new URL('../plan/fixtures/increment-1-plan.json', import.meta.url).pathname).text()
const ids = JSON.parse(file.split('\n')[1]!) as { readonly id: string; readonly workspaceId: string }
const root = await mkdtemp(join(tmpdir(), 'lane-k-sensitivity-'))
const module = join(root, 'workspaces', ids.workspaceId, 'planning')
await mkdir(join(module, 'plans'), { recursive: true })
await Bun.write(join(module, 'module.json'), `${JSON.stringify({ workspaceId: ids.workspaceId, moduleId: 'planning' })}\n`)
await Bun.write(join(module, 'plans', `${ids.id}.json`), file)
afterAll(() => rm(root, { recursive: true, force: true }))

const { plan, baseline, rows, markdown } = await tableFor(root, ids.workspaceId, ids.id)
const { inputs, option } = baseline
const group = inputs.goals.find(goal => goal.metric === 'span-over')!.scope!.groups![0]!
const hours = (value: number) => `${Number(value.toFixed(2))} h`

describe('the sensitivity table, on a stored baseline', () => {
  test('the script runs on the plan and prints this table', async () => {
    const child = Bun.spawn(['bun', script, root, ids.workspaceId, ids.id], { stdout: 'pipe', stderr: 'pipe' })
    const printed = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(printed.trim()).toBe(markdown)
  }, 60_000)
  test('it names the plan, its revision, the baseline and the option, at the top', () => {
    expect(plan.baselines.map(entry => entry.key)).toContain(baseline.key)
    const first = markdown.split('\n')[0]!
    for (const part of [plan.id, `revision ${plan.revision}`, `'${baseline.name}' (${baseline.key})`, `'${option.label}' (${option.key})`, `inputs revision ${option.inputsRevision}`]) expect(first).toContain(part)
  })
  test('a baseline the plan does not have is refused, naming the ones it has', async () => {
    await expect(tableFor(root, ids.workspaceId, ids.id, 'no-such-baseline')).rejects.toThrow(baseline.key)
  })
  test('a row per case: +25 % on every job, every three-point job high, then each alone', () => {
    const ranged = inputs.jobs.filter(job => option.rows.some(row => row.job === job.key) && job.duration.range !== undefined).map(job => job.key)
    expect(rows.map(row => row.high.length > 1 ? row.label : row.high[0])).toEqual(['+25 % on every job', 'Every three-point job at its high estimate', ...ranged])
  })
  test('every outcome is judgeRetiming\'s, on the rows the case re-timed', () => {
    for (const row of rows) {
      if (row.retimed === undefined) throw new Error(`${row.label} was not re-timed: ${row.none}`)
      expect(judgeRetiming(row.inputs, option.variant, option.rows, row.retimed, row.high)).toEqual(row.judged!)
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
  test('every hour figure printed is one of those, the rule\'s own limit, or the search bound', () => {
    const planned = checkPlan(inputs, option.variant, option.rows).metrics.find(metric => metric.id === `span:${group}`)!.value
    const allowed = new Set([
      hours(planned),
      ...rows.flatMap(row => typeof row.outage === 'number' ? [hours(row.outage)] : []),
      ...rows.flatMap(row => row.judged?.ok === true && !row.judged.outcome.holds && 'rule' in row.judged.outcome ? [hours(row.judged.outcome.by.value)] : []),
      ...inputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [`${rule.limit.value} ${rule.limit.unit}`] : []),
    ])
    const printed = [...markdown.matchAll(/(\d+(?:\.\d+)?) h\b/g)].map(match => match[0])
    expect(printed.length).toBeGreaterThan(0)
    expect(printed.filter(figure => !allowed.has(figure))).toEqual([])
  })
})

describe('V12: a job that holds alone gives its span against the limit, from lane K\'s judgement', () => {
  test('the walk\'s case: the pump install alone at its high estimate holds with no margin, the chain out exactly 72 h', () => {
    const install = rows.find(row => row.high.length === 1 && row.high[0] === 'SWA-PUMP-IN')!
    expect(install.judged).toMatchObject({ ok: true, outcome: { holds: true } })
    const spans = install.judged!.ok ? (install.judged as { readonly spans?: ReadonlyArray<{ readonly rule: string; readonly hours: number; readonly margin: number }> }).spans : undefined
    expect(spans?.find(entry => entry.rule === 'R2')).toEqual({ rule: 'R2', hours: 72, margin: 0 })
    // every span is the checker's on the judged rows, and its margin the rule's limit less it
    for (const entry of spans ?? []) {
      const rule = inputs.rules.find(candidate => candidate.key === entry.rule)!
      const check = checkPlan(judgedInputs(install.inputs, install.high, install.retimed!), option.variant, install.retimed!)
      if (rule.kind !== 'span-limit') throw new Error('not a span limit')
      expect(entry.hours).toBe(check.metrics.find(metric => metric.id === `span:${rule.group}`)!.value)
      expect(entry.margin).toBe(rule.limit.value - entry.hours)
    }
  })
})
