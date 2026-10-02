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
