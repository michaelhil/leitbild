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
