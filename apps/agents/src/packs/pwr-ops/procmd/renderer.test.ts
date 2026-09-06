import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseProcedure } from '@leitbild/procmd'
import { renderProcedure, renderIndex, renderStep } from './renderer.ts'
import baseline from '../../../../../../packages/procmd/fixtures/pwr-ops-baseline.json'

const fixture = (name: string): string => readFileSync(`${import.meta.dir}/../../../../../../packages/procmd/fixtures/${name}`, 'utf8')
const citationUrl = (id: string): string => `https://example.test/procedures/${id}/`

describe('canonical procedure renderer', () => {
  test('all 39 full documents contain every exact focused step rendering', () => {
    for (const item of baseline) {
      const parsed = parseProcedure(fixture(`pwr-ops/${item.file}`))
      const full = renderProcedure(parsed, citationUrl).markdown
      for (const step of parsed.steps) expect(full).toContain(renderStep(step, parsed.steps, citationUrl))
    }
  })
  test('full and focused outputs share every source-ordered block, path and branch', () => {
    const parsed = parseProcedure(fixture('conformance.md'))
    const focused = renderStep(parsed.steps[0]!, parsed.steps, citationUrl)
    const full = renderProcedure(parsed, citationUrl).markdown
    expect(full).toContain(focused)
    const markers = ['**Caution:**', '**Decision:**', '1. First path', '- Internal choice', '_against:_', '**Action:**',
      'Unclassified prose', '- External choice', '**Note:**', '**Within:**', '```md\n', '**Check:**', 'Future:', '- Manual choice']
    for (let index = 1; index < markers.length; index++) expect(focused.indexOf(markers[index]!)).toBeGreaterThan(focused.indexOf(markers[index - 1]!))
    expect(focused).toContain('[FR-S.1](https://example.test/procedures/FR-S.1/)')
    expect(focused).toContain('```md\n## Step 9 [id: fake]\nAction: fenced «FAKE»\n- Do not execute → #fake\n```')
    expect(full).toContain('Reference plant: reference-only')
    expect(full).toContain('**Format limitations (not execution guarantees):**')
    expect(full).toContain('**Source annotations:**')
    expect(full).toContain('Preserve this explanation after Tags.')
    expect(full).toContain('| Tag | Description | Sim-path | Units | Equipment |')
  })

  test('real source includes CSF prose, tag binding table, rationales and citations', () => {
    const parsed = parseProcedure(fixture('pwr-ops/E-0.md'))
    const markdown = renderProcedure(parsed, citationUrl).markdown
    expect(markdown).toMatch(/^## E-0 — Reactor Trip/)
    expect(markdown).toContain('CSF: subcriticality')
    expect(markdown).toContain('rps.trip_breaker')
    expect(markdown).toContain('_because:_')
    expect(markdown).toContain('Source: [E-0 — Reactor Trip')
    expect(markdown).toContain('https://example.test/procedures/E-0/')
  })

  test('diagram uses safe generated IDs and escaped labels; no invented fall-through edges', () => {
    const parsed = parseProcedure(fixture('conformance.md'))
    const diagram = renderProcedure(parsed, citationUrl).markdown.match(/```mermaid\n([\s\S]*?)\n```/)![1]!
    expect(diagram).toContain('S_0{"')
    expect(diagram).not.toContain('S_choose')
    expect(diagram.match(/ -->/g)).toHaveLength(parsed.steps.reduce((count, step) => count + step.branches.length, 0))
    const titleStress = { ...parsed, steps: parsed.steps.map(step => ({ ...step, title: '<title> | "quote" \\ backslash' })) }
    const escaped = renderProcedure(titleStress, citationUrl).markdown.match(/```mermaid\n([\s\S]*?)\n```/)![1]!
    expect(escaped).toContain('&lt;title&gt; &#124;')
    expect(escaped).toContain('&#92; backslash')
    expect(escaped).not.toContain('<title>')
    expect(diagram).toContain('call supervisor')
  })

  test('index lists supplied IDs and homepage; empty index is explicit', () => {
    const markdown = renderIndex(['E-0', 'FR-S.1'], 'PWR EOPs', 'https://example.test/wiki')
    expect(markdown).toContain('- `E-0`')
    expect(markdown).toContain('https://example.test/wiki')
    expect(renderIndex([], 'X', 'https://example.test')).toContain('No procedures listed yet')
  })
})
