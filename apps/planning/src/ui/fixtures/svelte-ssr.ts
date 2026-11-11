// Test-only: renders the screen's Svelte components on the server, so tests read the words a person
// would see. Registers a Bun loader that compiles .svelte files for SSR.
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'

let registered = false
export const registerSvelte = (): void => {
  if (registered) return
  registered = true
  Bun.plugin({
    name: 'planning-svelte-ssr',
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const result = compile(await Bun.file(path).text(), { filename: path, generate: 'server', runes: true })
        return { contents: result.js.code, loader: 'js' }
      })
    },
  })
}

export const renderHtml = <Props extends Record<string, unknown>>(component: Component<Props>, props: Props): string =>
  render(component, { props }).body

const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

/** What a person reads or hears: text between tags plus aria-label and title values. */
export const readableText = (html: string): string => {
  const spoken = [...html.matchAll(/\s(?:aria-label|title|placeholder)="([^"]*)"/g)].map(match => match[1]!)
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')
  return [text, ...spoken].join(' \n ').replace(/&[a-z#0-9]+;/g, entity => entities[entity] ?? entity).replace(/[ \t]+/g, ' ')
}

/**
 * Routine screens show no ids, JSON or seconds. Returns each breach found: an id-like plan-local key or
 * locator that no label uses, JSON punctuation, an ISO timestamp, a UUID, or a count of seconds of a minute or more.
 */
export const routineBreaches = (text: string, identifiers: readonly string[], labels: readonly string[]): readonly string[] => {
  const breaches: string[] = []
  const words = labels.join(' \n ')
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A key that is a plain word ("day", "crane", "always") cannot be told from text; the rest look like ids.
  const idLike = (id: string) => /[0-9._/%:-]/.test(id) || /[A-Z]/.test(id.slice(1))
  for (const id of new Set(identifiers)) {
    if (!idLike(id)) continue
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escape(id)}($|[^A-Za-z0-9_-])`)
    if (pattern.test(text) && !pattern.test(words)) breaches.push(`id ${id}`)
  }
  if (/[{}]|":|\[\s*"/.test(text)) breaches.push('JSON punctuation')
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) breaches.push('ISO timestamp')
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) breaches.push('UUID')
  if (/\bseconds\b|\b1 second\b|\bsecs?\b/i.test(text)) breaches.push('the word seconds')
  // A count of seconds of a minute or more, unless it is the planner's own words quoted from the plan.
  for (const match of text.matchAll(/(\d[\d,]*)\s?s\b/g)) {
    if (Number(match[1]!.replaceAll(',', '')) >= 60 && !words.includes(match[0])) breaches.push(`seconds count ${match[0]}`)
  }
  return breaches
}
