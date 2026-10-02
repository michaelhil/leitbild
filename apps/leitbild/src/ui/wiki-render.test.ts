import { expect, test } from 'bun:test'
import { headingsFor } from '@leitbild/knowledge'
import { renderWiki } from './wiki-render.ts'
const render = (content: string) =>
  renderWiki({
    path: 'world/packs/index.md',
    content,
    headings: headingsFor(content),
  })
test('wiki renders safe source links, relative navigation and exact heading anchors', () => {
  const html = render(
    '# Packs\n\n[World](../index.md) [Code](source:apps/world/src/packs/process-plant/pack.ts#L10)\n\n## More\nText',
  )
  expect(html).toContain('path=world%2Findex.md')
  expect(html).toContain(
    'data-source="apps/world/src/packs/process-plant/pack.ts#L10"',
  )
  expect(html).toContain('id="more"')
})
test('authored HTML and unsafe protocols never become executable DOM', () => {
  const html = render(
    '<script>alert(1)</script>\n\n[Bad](javascript:alert) ![Bad](data:image/svg+xml,test)\n\n```mermaid\ngraph TD\n A --> B\n```',
  )
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('href="javascript:')
  expect(html).not.toContain('<img')
  expect(html).toContain('class="mermaid"')
})
test('authoring comments stay hidden while literal code and other HTML remain escaped', () => {
  const html = render('# Drawing\n\n<!-- generated-schematic:start -->\n\nVisible\n\n```text\n<!-- literal example -->\n```\n\n<div>Not executable</div>')
  expect(html).not.toContain('generated-schematic:start')
  expect(html).toContain('Visible')
  expect(html).toContain('&lt;!-- literal example --&gt;')
  expect(html).toContain('&lt;div&gt;')
})

const procedureSource = `---
type: procedure
procedure-md: 0.7
procedure-id: EXAMPLE
title: Example inspection
applies-to: Example model only
procedure-status: design-guidance
runtime-bindings: uninstalled
---
# Example inspection

Read-only document.

## Step 1 [id: verify] Verify response
Basis: [Engineering](../index.md#engineering)
Caution: Do not open against pressure.
Action: Request the valve CLOSED.
Check: Verify CLOSED feedback.
Expected: Valve is CLOSED.
RNO: Retain the receiving path.
Unknown: Obtain independent feedback.
- Response obtained [outcome: normal] → #record
- Not obtained [outcome: rno] [execution: parallel] → [[OTHER]]
- Evidence unavailable [outcome: unknown] → ↻

## Step 2 [id: record] Record response
Action: Record the achieved state.
- Recorded → END

## Tags
- id: VALVE
  description: Example valve
  units: boolean
`

test('procedure wiki separates instructions, RNO and unknown without inventing live status', () => {
  const html = render(procedureSource)
  expect(html).toContain('class="procedure-columns"')
  expect(html).toContain('<strong>Action</strong><p>Request the valve CLOSED.</p>')
  expect(html).toContain('<strong>Response not obtained</strong><p>Retain the receiving path.</p>')
  expect(html).toContain('<strong>Evidence unknown</strong><p>Obtain independent feedback.</p>')
  expect(html.indexOf('Do not open against pressure.')).toBeLessThan(html.indexOf('Request the valve CLOSED.'))
  expect(html).toContain('Bindings: uninstalled')
  expect(html).toContain('not live plant assessments')
  expect(html).not.toContain('type="checkbox"')
})

test('procedure source anchors, branch order and basis links survive the structured view', () => {
  const html = render(procedureSource)
  const headings = headingsFor(procedureSource)
  for (const heading of headings) expect(html).toContain(`id="${heading.anchor}"`)
  const secondStep = headings.find(heading => heading.title.includes('[id: record]'))!
  expect(html).toContain(`href="#${secondStep.anchor}"`)
  expect(html.indexOf('data-branch-index="0"')).toBeLessThan(html.indexOf('data-branch-index="1"'))
  expect(html.indexOf('data-branch-index="1"')).toBeLessThan(html.indexOf('data-branch-index="2"'))
  expect(html).toContain('Continue in parallel with OTHER')
  expect(html).toContain('path=world%2Findex.md#engineering')
  expect(html).toContain('<details class="procedure-basis"><summary>Technical basis</summary>')
  expect(html).not.toContain('<details class="procedure-basis" open')
  expect(html).toContain('<summary>Original Markdown</summary>')
})

test('procedure rendering retains safe escaping and exact revision on source links', () => {
  const content = procedureSource.replace('Request the valve CLOSED.', 'Request CLOSED. <script>bad()</script> [Bad](javascript:alert) [Code](source:apps/world/src/core/model/procedures.ts)')
  const html = renderWiki({path: 'world/example.md', content, headings: headingsFor(content)}, 'revision-123')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('href="javascript:')
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain('data-source="apps/world/src/core/model/procedures.ts"')
  expect(html).toContain('revision=revision-123')
})

test('procedure rendering retains interstitial guidance and exposes observations as data only', () => {
  const content = procedureSource.replace('## Step 2', '## Continuing precautions\n\nKeep the receiver available.\n\n## Step 2').replace('Expected: Valve is CLOSED.', 'Expected: Valve is CLOSED.\n\n```procedure-observation\n{"capabilityId":"example.read","input":{},"continuous":true}\n```')
  const html = render(content)
  expect(html).toContain('Keep the receiver available.')
  expect(html).toContain('id="continuing-precautions"')
  expect(html).toContain('Read-only observation specification')
  expect(html).toContain('&quot;capabilityId&quot;: &quot;example.read&quot;')
  expect(html).toContain('&quot;continuous&quot;: true')
  expect(html.indexOf('Keep the receiver available.')).toBeLessThan(html.indexOf('Step 2 — Record response'))
})

test('procedure source anchors survive CRLF-authored documents', () => {
  const content = procedureSource.replaceAll('\n', '\r\n')
  const html = render(content)
  for (const heading of headingsFor(content)) expect(html).toContain(`id="${heading.anchor}"`)
})

test('procedure routes resolve from discovered identities and keep sibling scope and revision', () => {
  const document = { path: 'world/ld/procedure.md', content: procedureSource, headings: headingsFor(procedureSource) }
  const html = renderWiki(document, 'revision-123', [
    { path: 'archive/other.md', procedureId: 'OTHER' },
    { path: 'world/ld/response.md', procedureId: 'OTHER' },
  ])
  expect(html).toContain('Continue in parallel with <a href="/wiki?path=world%2Fld%2Fresponse.md&amp;revision=revision-123">OTHER</a>')
  const ambiguous = renderWiki(document, undefined, [
    { path: 'archive/one.md', procedureId: 'OTHER' },
    { path: 'archive/two.md', procedureId: 'OTHER' },
  ])
  expect(ambiguous).toContain('Continue in parallel with OTHER')
  expect(ambiguous).not.toContain('path=archive')
})

test('canonical procedure tags link to their declared engineering source at the point of use', () => {
  const content = procedureSource.replace('Verify CLOSED feedback.', 'Verify «LD01.VALVE.POS» CLOSED.').replace('- id: VALVE', '- id: LD01.VALVE.POS\n  source: ../instrumentation.md#position')
  const html = renderWiki({ path: 'world/ld/procedure.md', content, headings: headingsFor(content) }, 'revision-123')
  expect(html).toContain('href="/wiki?path=world%2Finstrumentation.md&amp;revision=revision-123#position">«LD01.VALVE.POS»</a>')
  const unsafe = render(content.replace('../instrumentation.md#position', 'javascript:alert'))
  expect(unsafe).not.toContain('href="javascript:')
})

test('tag linking respects Markdown code spans, existing links and case-sensitive identities', () => {
  const content = procedureSource.replace('Verify CLOSED feedback.', 'Verify **«LD01.PCCTank.LT»**; literal `«LD01.PCCTank.LT»`; explicit [«LD01.PCCTank.LT»](../chosen.md).')
    .replace('- id: VALVE', '- id: LD01.PCCTank.LT\n  source: ../instrumentation.md#level')
  const html = render(content)
  expect(html).toContain('<strong><a href="/wiki?path=world%2Finstrumentation.md#level">«LD01.PCCTank.LT»</a></strong>')
  expect(html).toContain('<code>«LD01.PCCTank.LT»</code>')
  expect(html).toContain('href="/wiki?path=world%2Fchosen.md">«LD01.PCCTank.LT»</a>')
  expect(html).not.toMatch(/<a[^>]*>\s*<a/)
})

test('procedure cross-step links open the authored abnormal step, not normal startup', () => {
  const content = procedureSource.replace('[[OTHER]]', '[[OTHER#coast]]')
  const target = { path: 'world/ld/turbine.md', procedureId: 'OTHER', headings: headingsFor('# Turbine\n\n## Step 1 [id: start] Start\n\n## Step 2 [id: coast] Coast') }
  const document = { path: 'world/ld/entry.md', content, headings: headingsFor(content) }
  const html = renderWiki(document, 'revision-123', [target])
  expect(html).toContain('path=world%2Fld%2Fturbine.md&amp;revision=revision-123#step-2-id-coast-coast')
  expect(html).toContain('OTHER — coast</a>')
  const missing = renderWiki(document, undefined, [{ ...target, headings: [] }])
  expect(missing).not.toContain('path=world%2Fld%2Fturbine.md')
})

test('authored assessments remain inspectable data and do not suggest live evaluation', () => {
  const content = procedureSource.replace('Expected: Valve is CLOSED.', 'Expected: Valve is CLOSED.\n```procedure-assessment\n{"condition":{"type":"manual","description":"Verify actual position independently","tagIds":["VALVE"],"source":"../engineering.md#position"}}\n```')
  const html = render(content)
  expect(html).toContain('Evaluation criteria — authored specification')
  expect(html).toContain('not a live assessment or automatic command')
  expect(html).toContain('&quot;tagIds&quot;')
  expect(html).not.toContain('procedure-reference" open')
})
