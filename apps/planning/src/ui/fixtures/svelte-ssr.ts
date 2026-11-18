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

/** Text the Module wrote that was cut off: it does not end a sentence (maint's walk 2, T20-04). */
export const cutShort = (texts: readonly string[]): readonly string[] => texts.filter(text => !/[.!?…"”')]\s*$/.test(text.trim()))

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
  // Provenance that is not planner information (maint's walk J-05, T1-04, S-03): model digests, World
  // locators, bare step numbers, and any unbreakable run of text that would push a column wide.
  if (/\b[0-9a-f]{16,}\b/i.test(text)) breaches.push('hex digest')
  if (/%[0-9A-F]{2}/.test(text) || /\b[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/\S+/.test(text)) breaches.push('World locator')
  if (/(^|[^\d.,:–\-])\d \d(\s\d)*($|[^\d])/.test(text)) breaches.push('bare step numbers')
  if (/\S{48,}/.test(text)) breaches.push('unbreakable text')
  // Raw kinds and codes (maint's walk 2: "world-unread:", "no-tag-out:", "link:"), and a key no name was found for.
  if (/\b[a-z]+(?:[-_][a-z]+)+:\s/.test(text) || /\b(?:link|bracket|tag-before-test|support-order)\s?:\s/.test(text)) breaches.push('raw kind prefix')
  if (/\b[a-z]+(?:_[a-z]+)+\b/.test(text)) breaches.push('snake_case code')
  if (/no longer in this plan/.test(text)) breaches.push('unresolved name')
  if (/\b\d+\.\d+\s?s\b/.test(text)) breaches.push('fractional seconds')
  // A count of seconds of a minute or more, unless it is the planner's own words quoted from the plan.
  for (const match of text.matchAll(/(\d[\d,]*)\s?s\b/g)) {
    if (Number(match[1]!.replaceAll(',', '')) >= 60 && !words.includes(match[0])) breaches.push(`seconds count ${match[0]}`)
  }
  return breaches
}
