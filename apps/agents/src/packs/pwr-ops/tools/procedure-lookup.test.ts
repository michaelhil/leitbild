import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProcedureLookupTool, type ProcedureLookupTelemetry } from './procedure-lookup.ts'
import type { WikiSourceBinding } from '../../types.ts'

const REVISION = 'b'.repeat(40)
const BINDING: WikiSourceBinding = {
  org: 'leitbild-wikis',
  repo: 'pwr-ops',
  branch: 'main',
  manifestUrl: 'https://leitbild-wikis.github.io/pwr-ops/_manifest.json',
  citationBase: 'https://leitbild-wikis.github.io/pwr-ops/procedures/',
}

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, '..', 'fixtures', name), 'utf-8')

const installFetchMock = (responder: (url: string) => Response | Promise<Response>) => {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    return Promise.resolve(responder(url))
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

const manifestEntry = (id: string, title: string) => ({
  id,
  title,
  file: `wiki/procedures/${id}.md`,
  csfsMonitored: [],
  entryTriggers: [],
  coverage: 'developed',
  stepCount: 1,
  tagDefinitionCount: 0,
})
const manifest = (procedures = [
  manifestEntry('E-0', 'Reactor Trip'),
  manifestEntry('FR-S.1', 'ATWS'),
]) => ({
  version: 1,
  wiki: 'pwr-ops',
  revision: REVISION,
  procmdVersion: '0.7',
  procedures,
  pages: [],
})

const fixtureResponder = (url: string): Response => {
  if (url.endsWith('/_manifest.json')) return new Response(JSON.stringify(manifest()), { status: 200 })
  if (url.endsWith('/wiki/procedures/E-0.md')) return new Response(fixture('E-0.md'), { status: 200 })
  if (url.endsWith('/wiki/procedures/FR-S.1.md')) return new Response(fixture('FR-S.1.md'), { status: 200 })
  return new Response('not found', { status: 404 })
}

const ctx = { callerId: 't', callerName: 't' }

describe('procedure_lookup — integration with mocked GitHub', () => {
  let restore: () => void
  beforeEach(() => { restore = installFetchMock(fixtureResponder) })
  afterEach(() => restore())

  test('no id → returns index of procedures from real fixture', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({}, ctx)
    expect(r.success).toBe(true)
    const data = r.data as string
    expect(data).toContain('## PWR EOPs')
    expect(data).toContain('`E-0`')
  })

  test('id="E-0" → returns rendered markdown with mermaid', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as string
    expect(data).toMatch(/^## E-0 — Reactor Trip/)
    expect(data).toContain('```mermaid')
    expect(data).toContain('Source: [E-0 — Reactor Trip')
    expect(data).toContain('https://leitbild-wikis.github.io/pwr-ops/procedures/E-0/')
  })

  test('unknown id → structured error with fuzzy suggestions', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0X' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('E-0X')
    expect(r.error).toMatch(/(Did you mean|Available)/)
  })

  test('case-sensitive id lookup (wiki uses canonical ids)', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'e-0' }, ctx)  // lowercase
    expect(r.success).toBe(false)  // wiki ids are canonical-case
  })
})

describe('procedure_lookup — format / step / mode parameters', () => {
  let restore: () => void
  beforeEach(() => { restore = installFetchMock(fixtureResponder) })
  afterEach(() => restore())

  test('format: "json" returns the parsed shape, not markdown', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0', format: 'json' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as { kind: string; procedureId: string; parsed: { frontmatter: { procedureId: string }; steps: unknown[]; csfChannels: string[] } }
    expect(data.kind).toBe('procedure')
    expect(data.procedureId).toBe('E-0')
    expect(data.parsed.frontmatter.procedureId).toBe('E-0')
    expect(data.parsed.steps.length).toBeGreaterThan(5)
    expect(data.parsed.csfChannels).toContain('subcriticality')
  })

  test('format: "json" with no id returns an index object', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ format: 'json' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as { kind: string; ids: string[] }
    expect(data.kind).toBe('index')
    expect(data.ids).toContain('E-0')
  })

  test('step: "<id>" returns only that step (markdown)', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0', step: 'verify-reactor-trip' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as string
    expect(data).toContain('verify-reactor-trip')
    expect(data).toContain('**Check:**')
    expect(data).not.toContain('check-rcs-conditions')
  })

  test('step: "<id>" returns the step in JSON mode', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0', step: 'verify-reactor-trip', format: 'json' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as { kind: string; step: { id: string; checks: string[] } }
    expect(data.kind).toBe('step')
    expect(data.step.id).toBe('verify-reactor-trip')
    expect(data.step.checks.length).toBeGreaterThan(0)
  })

  test('unknown step → structured error with fuzzy suggestions', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0', step: 'no-such-step' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('no-such-step')
  })

  test('mode: "summary" returns frontmatter + step ids, no step bodies', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0', mode: 'summary' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as string
    expect(data).toContain('(summary)')
    expect(data).toMatch(/\*\*Steps \(\d+\):\*\*/)
    expect(data).not.toContain('**Check:**')
  })

  test('mode: "summary" with format: "json" returns structured summary', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0', mode: 'summary', format: 'json' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as { kind: string; stepIds: string[]; entryTriggers: string[] }
    expect(data.kind).toBe('summary')
    expect(data.stepIds.length).toBeGreaterThan(5)
    expect(data.entryTriggers).toContain('reactor-trip-signal')
  })
})

describe('procedure_lookup — telemetry', () => {
  let restore: () => void
  beforeEach(() => { restore = installFetchMock(fixtureResponder) })
  afterEach(() => restore())

  test('emits one telemetry event per call with success + duration + indexSource', async () => {
    const events: ProcedureLookupTelemetry[] = []
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/', e => events.push(e))
    await tool.execute({ id: 'E-0' }, ctx)
    expect(events.length).toBe(1)
    expect(events[0]!.tool).toBe('procedure_lookup')
    expect(events[0]!.success).toBe(true)
    expect(events[0]!.id).toBe('E-0')
    expect(events[0]!.indexSource).toBe('manifest')
    expect(events[0]!.callerId).toBe('t')
    expect(typeof events[0]!.durationMs).toBe('number')
  })

  test('emits error-classified telemetry on unknown id', async () => {
    const events: ProcedureLookupTelemetry[] = []
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/', e => events.push(e))
    await tool.execute({ id: 'NONESUCH' }, ctx)
    expect(events.length).toBe(1)
    expect(events[0]!.success).toBe(false)
    expect(events[0]!.errorClass).toBe('unknown-id')
  })

  test('indexSource reports "manifest" when manifest is consumed', async () => {
    restore()
    restore = installFetchMock((url) => {
      if (url.endsWith('/_manifest.json')) return new Response(JSON.stringify({
        ...manifest([manifestEntry('E-0', 'Reactor Trip')]),
      }), { status: 200 })
      return fixtureResponder(url)
    })
    const events: ProcedureLookupTelemetry[] = []
    const tool = createProcedureLookupTool(
      BINDING,
      'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/',
      e => events.push(e),
    )
    await tool.execute({ id: 'E-0' }, ctx)
    expect(events[0]!.indexSource).toBe('manifest')
  })
})

describe('procedure_lookup — strict manifest discovery', () => {
  let restore: () => void
  afterEach(() => restore?.())

  test('discovers a procedure solely from its manifest entry', async () => {
    const aop = manifestEntry('AOP-1', 'Generic AOP')
    restore = installFetchMock((url) => {
      if (url.endsWith('/_manifest.json')) return new Response(JSON.stringify(manifest([aop])), { status: 200 })
      if (url.endsWith('/wiki/procedures/AOP-1.md')) return new Response(`---
procedure-id: AOP-1
title: Generic AOP
profile: nuclear-erg
applies-to: anywhere
---

## Step 1 [id: x]
Check: ok
`, { status: 200 })
      return new Response('not found', { status: 404 })
    })
    const tool = createProcedureLookupTool(
      BINDING,
      'PWR EOPs',
      'https://leitbild-wikis.github.io/pwr-ops/',
    )
    const r = await tool.execute({ id: 'AOP-1' }, ctx)
    expect(r.success).toBe(true)
    expect(r.data as string).toContain('AOP-1')
  })

  test('manifest fetch failure fails clearly without a second discovery mechanism', async () => {
    restore = installFetchMock(() => new Response('', { status: 404 }))
    const tool = createProcedureLookupTool(
      BINDING,
      'PWR EOPs',
      'https://leitbild-wikis.github.io/pwr-ops/',
    )
    const r = await tool.execute({ id: 'E-0' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('index fetch failed')
  })

  test('malformed manifest is rejected', async () => {
    restore = installFetchMock(() => new Response('{"version":2,"procedures":[]}', { status: 200 }))
    const tool = createProcedureLookupTool(
      BINDING,
      'PWR EOPs',
      'https://leitbild-wikis.github.io/pwr-ops/',
    )
    const r = await tool.execute({ id: 'E-0' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('index fetch failed')
  })
})

describe('procedure_lookup — failure modes', () => {
  let restore: () => void
  afterEach(() => restore?.())

  test('GitHub 5xx on procedure fetch → structured error mentioning the id', async () => {
    restore = installFetchMock((url) => {
      if (url.endsWith('/_manifest.json')) return new Response(JSON.stringify(manifest()), { status: 200 })
      return new Response('boom', { status: 503 })
    })
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({ id: 'E-0' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('E-0')
    expect(r.error).toMatch(/(HTTP 503|fetch)/)
  })

  test('GitHub error on index fetch → user-facing message names the wiki', async () => {
    restore = installFetchMock(() => new Response('', { status: 503 }))
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://leitbild-wikis.github.io/pwr-ops/')
    const r = await tool.execute({}, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('PWR EOPs')
  })
})
