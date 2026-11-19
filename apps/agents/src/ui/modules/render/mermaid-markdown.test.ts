import { expect, test } from 'bun:test'
import { mermaidSources } from '../../../core/diagram-request.ts'
import { renderDiagramMarkdown } from './mermaid-markdown.ts'

test('viewer indices and request source use the same Markdown grammar for alternative fences and nesting', () => {
  const message = '~~~Mermaid\nflowchart LR\nA --> B\n~~~\n\n> ```mermaid\n> flowchart TB\n> B --> C\n> ```\n\n```python\nprint(1)\n```\n\n```MERMAID caption\nflowchart LR\nC --> D\n```'
  const sources = mermaidSources(message)
  expect(sources).toEqual(['flowchart LR\nA --> B', 'flowchart TB\nB --> C', 'flowchart LR\nC --> D'])
  const html = renderDiagramMarkdown(message)
  expect([...html.matchAll(/data-mermaid-index="(\d+)"/g)].map(match => Number(match[1]))).toEqual([0, 1, 2])
  expect(html).toContain('class="language-python"')
  expect(html).not.toContain('class="language-MERMAID"')
})

test('literal HTML and nested fence discussions do not create canonical diagram indices', () => {
  const message = '<pre><code class="language-mermaid">not a fence</code></pre>\n\n````text\n```mermaid\nA --> B\n```\n````\n\n```mermaid\nA["<script>"] --> B\n```'
  expect(mermaidSources(message)).toEqual(['A["<script>"] --> B'])
  const html = renderDiagramMarkdown(message)
  expect([...html.matchAll(/data-mermaid-index="(\d+)"/g)].map(match => match[1])).toEqual(['0'])
  expect(html).toContain('&lt;script&gt;')
})
