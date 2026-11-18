import { marked, Renderer } from 'marked'
import { isMermaidLanguage } from '../../../core/diagram-request.ts'

// Stamp only Markdown code tokens: raw HTML resembling a Mermaid fence must
// not silently change the selected diagram's ordinal. Sanitization is still
// applied by the caller to the complete Markdown output.
export const renderDiagramMarkdown = (text: string): string => {
  const renderer = new Renderer()
  const ordinaryCode = renderer.code.bind(renderer)
  let index = 0
  renderer.code = token => {
    if (!isMermaidLanguage(token.lang)) return ordinaryCode(token)
    const source = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<pre><code class="language-mermaid" data-mermaid-index="${index++}">${source}</code></pre>\n`
  }
  return marked.parse(text, { renderer, async: false })
}
