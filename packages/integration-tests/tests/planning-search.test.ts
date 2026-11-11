// Search-phrase ranking (design 9 row 5): the real workspace_explore over the combined catalogue of the real
// World (two Runs: the Supply run and a cooling-chain plant), the real Agents and the real Planning Modules,
// with maint's frozen phrasings (R/maint/phrasings.md, sha256 ca09915d...). P1-P20 gate at >= 18 of 20 with
// the expected operation in the top 3; A1-A4 are reported, not gated.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createPlanningStack } from './planning-stack.ts'

const phrasingsFile = new URL('./fixtures/planning-phrasings.md', import.meta.url)
const frozen = 'ca09915dcd9a9cedb782d7e5f6cf641e0eb43c5f71bf0551607ff606692542b1'
const text = await Bun.file(phrasingsFile).text()

/** Rows of maint's tables: scored rows name one expected operation, ambiguous rows a set. */
const rows = text.split('\n').filter(line => /^\| [PA]\d+ \|/.test(line)).map(line => {
  const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
  const id = cells[0]!
  const phrase = id.startsWith('P') ? cells[2]! : cells[1]!
  const expected = [...(id.startsWith('P') ? cells[3]! : cells[2]!).matchAll(/`([a-z][a-z0-9.-]+)`/g)].map(match => match[1]!)
  return { id, phrase, expected }
})

let stack: Awaited<ReturnType<typeof createPlanningStack>>
let explore: (query: string) => Promise<string[]>

beforeAll(async () => {
  stack = await createPlanningStack({ realAgents: true })
  await stack.start('world.scenario', 'supply-run', 'world.scenario.start')
  await stack.start('world.scenario', 'halden-rhr-cooling-chain', 'world.scenario.start')
  await stack.start('planning.plan-definition', 'train-a-work-week', 'planning.plan.create')
  const room = stack.room('room')
  explore = async query => {
    const answer = await room.explore({ view: 'operations', queries: [query], limit: 3 }) as { success: boolean; data: { operations: Array<{ operationId: string }> } }
    if (!answer.success) throw new Error(`workspace_explore failed: ${JSON.stringify(answer)}`)
    return answer.data.operations.map(operation => operation.operationId)
  }
}, 120_000)

afterAll(() => stack.close())

test('the phrasings are maint\'s frozen file', async () => {
  expect(createHash('sha256').update(new Uint8Array(await Bun.file(phrasingsFile).arrayBuffer())).digest('hex')).toBe(frozen)
  expect(rows.filter(row => row.id.startsWith('P')).map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => `P${index + 1}`))
  expect(rows.filter(row => row.id.startsWith('A')).map(row => row.id)).toEqual(['A1', 'A2', 'A3', 'A4'])
})

test('at least 18 of P1-P20 rank the expected operation in the top 3; A1-A4 are reported', async () => {
  const scored = [] as Array<{ id: string; hit: boolean; top: string[] }>
  for (const row of rows.filter(entry => entry.id.startsWith('P'))) {
    const top = await explore(row.phrase)
    scored.push({ id: row.id, hit: top.includes(row.expected[0]!), top })
  }
  const reported = [] as Array<{ id: string; hit: boolean; top: string[] }>
  for (const row of rows.filter(entry => entry.id.startsWith('A'))) {
    const top = await explore(row.phrase)
    reported.push({ id: row.id, hit: top.some(id => row.expected.includes(id)), top })
  }
  console.log(`Search ranking: ${scored.filter(entry => entry.hit).length}/20 scored; ambiguous ${reported.filter(entry => entry.hit).length}/4 within an acceptable set`)
  for (const entry of [...scored, ...reported]) console.log(`${entry.hit ? 'hit ' : 'MISS'} ${entry.id}: ${entry.top.join(', ')}`)
  expect(scored.filter(entry => entry.hit).length).toBeGreaterThanOrEqual(18)
}, 60_000)
