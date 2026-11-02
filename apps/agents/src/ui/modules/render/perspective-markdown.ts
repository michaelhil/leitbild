import { marked, Renderer } from 'marked'

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** The read/attention pilot has no model-authored media or HTML execution.
 * Ordinary message rendering retains its existing rich processors.
 */
export const perspectiveMarkdown = (text: string): string => {
  const renderer = new Renderer()
  renderer.html = token => escape(token.text)
  renderer.image = token => `<span>[Image unavailable in this exercise Assistant${token.text ? `: ${escape(token.text)}` : ''}]</span>`
  return marked.parse(text, { renderer, async: false })
}
