import { mkdir } from 'node:fs/promises'
import { z } from 'zod'

// Explicit maintenance command, never a build/runtime network dependency. Keep artwork and metadata pinned together.
const version = '1.0.1'
const base = `https://unpkg.com/lucide-static@${version}/`
const read = async (name: string) => {
  const response = await fetch(base + name)
  if (!response.ok) throw new Error(`Lucide ${name}: HTTP ${response.status}`)
  return await response.text()
}
const [nodeText, tagText, license] = await Promise.all(['icon-nodes.json', 'tags.json', 'LICENSE'].map(read))
const nodes = z.record(z.string(), z.array(z.tuple([z.enum(['path','circle','rect','line','polyline','polygon','ellipse']), z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/), z.union([z.string(), z.number()]))]))).parse(JSON.parse(nodeText!))
const tags = z.record(z.string(), z.array(z.string())).parse(JSON.parse(tagText!))
const escape = (value: string | number) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const catalog = Object.entries(nodes).map(([id, shapes]) => {
  for (const [, attrs] of shapes) if (Object.keys(attrs).some(key => /^on|href|style/i.test(key))) throw new Error('Unexpected SVG attribute')
  return { id, tags: tags[id] ?? [], body: shapes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}/>`).join('') }
})
const commonNames = new Set(['ambulance','hospital','triangle-alert','cloud-rain','factory','network','zap','utility-pole','plug','battery','map-pin','plus','square','circle-question-mark','x','drone'])
const common = Object.fromEntries(catalog.filter(icon => commonNames.has(icon.id)).map(icon => [icon.id, icon.body]))
if (Object.keys(common).length !== commonNames.size) throw new Error('Common icon is missing from pinned Lucide release')
const output = new URL('../../src/core/map-symbols/', import.meta.url)
await mkdir(output, { recursive: true })
await Bun.write(new URL('catalog.json', output), JSON.stringify({ library: 'Lucide', version, source: base, icons: catalog }) + '\n')
await Bun.write(new URL('common.json', output), JSON.stringify(common) + '\n')
await Bun.write(new URL('LICENSE', output), license!)
console.log(`Updated ${catalog.length} searchable Lucide icons; ${commonNames.size} small synchronous UI/map glyphs.`)
