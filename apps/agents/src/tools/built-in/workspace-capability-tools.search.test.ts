import { describe, expect, test } from 'bun:test'
import { capabilityIdSchema, moduleIdSchema, newWorkspaceId } from '@leitbild/contracts'
import { createWorkspaceCapabilityTools } from './workspace-capability-tools.ts'

// Small synthetic catalogues of Workspace operations, each built so that one
// ranking rule decides the order. Every id begins `test.`, so every operation
// shares that word; ids are chosen so that id order alone would give another
// answer. Each comment counts an operation's searched words after stop words.

const workspaceId = newWorkspaceId()
const moduleId = moduleIdSchema.parse('test')
const context = { callerId: 'agent', callerName: 'Analyst', roomId: 'room' }

interface Entry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly searchTerms?: ReadonlyArray<string>
  readonly kind?: 'command' | 'query'
  readonly risk?: 'read' | 'write' | 'destructive'
}

const searchOver = (entries: ReadonlyArray<Entry>) => {
  const modules = [{ moduleId, status: 'ready' }]
  const capabilities = entries.map(entry => ({
    id: capabilityIdSchema.parse(`test.${entry.id}`), moduleId, kind: entry.kind ?? 'query', scope: { kind: 'workspace' },
    title: entry.title, description: entry.description, ...(entry.searchTerms === undefined ? {} : { searchTerms: entry.searchTerms }),
    risk: entry.risk ?? 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  }))
  const [explore] = createWorkspaceCapabilityTools({
    workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'workspace' }),
    fetchImpl: (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path.endsWith('/capabilities')) return Response.json({ workspaceId, modules, capabilities })
      if (path.endsWith('/resources')) return Response.json({ workspaceId, modules, resources: [] })
      if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules, definitions: [] })
      throw new Error(`unexpected request ${path}`)
    }) as typeof fetch,
  })
  return async (...queries: ReadonlyArray<string>) => {
    const result = await explore!.execute({ view: 'operations', queries, limit: 100 }, context)
    expect(result.success).toBe(true)
    return (result.data as { operations: Array<{ operationId: string; matchedTerms?: ReadonlyArray<string> }> }).operations
      .map(operation => ({ id: operation.operationId.slice('test.'.length), matchedTerms: operation.matchedTerms }))
  }
}

const idsOf = (operations: ReadonlyArray<{ readonly id: string }>) => operations.map(operation => operation.id)

describe('workspace_explore ranking', () => {
  test('stop words neither select an operation nor count as matched; words that carry a question stay', async () => {
    const search = searchOver([
      { id: 'log', title: 'Read the log', description: 'Shows the log of the shift.' },
      { id: 'restart', title: 'Restart pump', description: 'Restarts a pump that tripped.' },
      { id: 'explain', title: 'Explain step', description: 'Says why a step did not run, when, and all that held it up, down, out or off.' },
    ])
    expect(await search('the')).toEqual([])
    expect(await search('of the', 'that a')).toEqual([])
    expect(await search('the log for the shift')).toEqual([{ id: 'log', matchedTerms: ['log', 'shift'] }])
    expect(await search('why when up down out off not all')).toEqual([
      { id: 'explain', matchedTerms: ['why', 'when', 'up', 'down', 'out', 'off', 'not', 'all'] },
    ])
  })

  test('a word finds its plural, -ing, -ed and -e forms through its stem, reported as the word asked', async () => {
    const search = searchOver([
      { id: 'facts', title: 'Planning facts', description: 'Lists the facts a schedule needs.' },
      { id: 'history', title: 'History', description: 'Shows how values moved.', searchTerms: ['trends'] },
      { id: 'clock', title: 'Clock', description: 'Holds a paused run, or keeps skipping ahead.' },
    ])
    expect(await search('plan')).toEqual([{ id: 'facts', matchedTerms: ['plan'] }])
    expect(idsOf(await search('plans'))).toEqual(['facts'])
    expect(idsOf(await search('planned'))).toEqual(['facts'])
    expect(await search('trend')).toEqual([{ id: 'history', matchedTerms: ['trend'] }])
    expect(await search('pause skip')).toEqual([{ id: 'clock', matchedTerms: ['pause', 'skip'] }])
    expect(idsOf(await search('running'))).toEqual(['clock'])
  })

  test('an exact word outranks the same word found through its stem', async () => {
    // Both: name {test, plan|planning}, description {shows, facts}: 4 words, one length factor.
    // "plan": b-plan exact 3 × idf(1 holds plan) beats a-planning 0.5 × 3 × idf(2 hold its stem).
    const search = searchOver([
      { id: 'a-planning', title: 'Planning', description: 'Shows facts.' },
      { id: 'b-plan', title: 'Plan', description: 'Shows facts.' },
    ])
    expect(idsOf(await search('plan'))).toEqual(['b-plan', 'a-planning'])
    expect(idsOf(await search('planning'))).toEqual(['a-planning', 'b-plan'])
  })

  test('a word counts by the best field holding it: name 3, search terms 2, description 1', async () => {
    // Each holds "valve" once and 4 words in all, so idf and length factor are shared.
    const search = searchOver([
      { id: 'alpha', title: 'Alpha', description: 'Shows the valve.' },
      { id: 'bravo', title: 'Bravo', description: 'Shows.', searchTerms: ['valve'] },
      { id: 'valve', title: 'Valve', description: 'Shows lines.' },
    ])
    expect(idsOf(await search('valve'))).toEqual(['valve', 'bravo', 'alpha'])
  })

  test('a word found only through its stem counts half its field weight', async () => {
    // 40 operations; the three below hold 4 words each, so they share one length factor L.
    // "trend": exact in 2 (alpha, charlie), its stem in 3 (and trends).
    //   idf(2) = ln((40 - 2 + 0.5) / 2.5 + 1) = ln 16.4 ≈ 2.797
    //   idf(3) = ln((40 - 3 + 0.5) / 3.5 + 1) = ln 11.71 ≈ 2.461
    //   charlie, search term:   2 × 2.797       ≈ 5.59 L
    //   trends, stem in name:   0.5 × 3 × 2.461 ≈ 3.69 L  (a full-weight stem, 7.38 L, would rank first)
    //   alpha, description:     1 × 2.797       ≈ 2.80 L
    const search = searchOver([
      { id: 'alpha', title: 'Alpha', description: 'Shows the trend.' },
      { id: 'charlie', title: 'Charlie', description: 'Shows.', searchTerms: ['trend'] },
      { id: 'trends', title: 'Trends', description: 'Shows values.' },
      ...Array.from({ length: 37 }, (_, index) => ({ id: `filler-${index}`, title: `Filler ${index}`, description: 'Shows values.' })),
    ])
    expect(idsOf(await search('trend'))).toEqual(['charlie', 'trends', 'alpha'])
  })

  test('the sum is scaled by the share of query words matched, so three described words beat one name word', async () => {
    // 22 operations. isolate {test, isolate, shuts, lines, quickly} and lineup {test, lineup,
    // isolate, feed, pump} hold 5 words each: one length factor L. 20 others say "feed pump".
    //   idf(isolate, in 2)  = ln((22 - 2 + 0.5) / 2.5 + 1)   = ln 9.2   ≈ 2.219
    //   idf(feed|pump, 21)  = ln((22 - 21 + 0.5) / 21.5 + 1) = ln 1.070 ≈ 0.0675
    //   isolate: 3 × 2.219 = 6.657 L, × 1/3 matched = 2.219 L
    //   lineup:  2.219 + 2 × 0.0675 = 2.354 L, × 3/3 matched = 2.354 L
    // Unscaled, or sorted by name first, isolate would rank first.
    const search = searchOver([
      { id: 'isolate', title: 'Isolate', description: 'Shuts lines quickly.' },
      { id: 'lineup', title: 'Lineup', description: 'Isolate the feed pump.' },
      ...Array.from({ length: 20 }, (_, index) => ({ id: `supply-${index}`, title: `Supply ${index}`, description: 'Feed pump status.' })),
    ])
    const ranked = await search('isolate feed pump')
    expect(ranked.slice(0, 2)).toEqual([
      { id: 'lineup', matchedTerms: ['isolate', 'feed', 'pump'] },
      { id: 'isolate', matchedTerms: ['isolate'] },
    ])
    expect(ranked).toHaveLength(22)
  })

  test('kind and risk are not searched', async () => {
    const search = searchOver([
      { id: 'remove-log', title: 'Remove log', description: 'Removes a log entry.', kind: 'command', risk: 'destructive' },
      { id: 'change-limit', title: 'Change limit', description: 'Changes a limit.', kind: 'command', risk: 'write' },
      { id: 'limits', title: 'Limits', description: 'Lists limits.', kind: 'query', risk: 'read' },
    ])
    for (const word of ['command', 'query', 'read', 'write', 'destructive']) expect(await search(word)).toEqual([])
    expect(idsOf(await search('limit'))).toEqual(['change-limit', 'limits'])
  })

  test('equal scores go to the operation whose name holds the word, then by id, whatever the catalogue order', async () => {
    // alpha and zulu are alike; trends also names the word. Each holds 4 words and "trend" in its description.
    const entries: ReadonlyArray<Entry> = [
      { id: 'zulu', title: 'Zulu', description: 'Shows the trend.' },
      { id: 'trends', title: 'Trends', description: 'Shows the trend.' },
      { id: 'alpha', title: 'Alpha', description: 'Shows the trend.' },
    ]
    expect(idsOf(await searchOver(entries)('trend'))).toEqual(['trends', 'alpha', 'zulu'])
    expect(idsOf(await searchOver([...entries].reverse())('trend'))).toEqual(['trends', 'alpha', 'zulu'])
  })
})
