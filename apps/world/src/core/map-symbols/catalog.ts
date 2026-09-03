import { z } from 'zod'
import catalog from './catalog.json'

export const mapSymbolsInput = z.object({
  text: z.string().max(100).default(''), ids: z.array(z.string().max(100)).max(32).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30), artwork: z.boolean().default(false),
}).strict()
export const mapSymbolsOutput = z.object({
  library: z.string(), version: z.string(), total: z.number().int(),
  icons: z.array(z.object({ id: z.string(), tags: z.array(z.string()), svg: z.string().optional() }).strict()),
}).strict()
const index = new Map(catalog.icons.map(icon => [icon.id, icon]))
export const isMapSymbol = (id: string): boolean => index.has(id)
export const searchMapSymbols = (raw: unknown): z.infer<typeof mapSymbolsOutput> => {
  const input = mapSymbolsInput.parse(raw), terms = input.text.toLowerCase().split(/\s+/).filter(Boolean)
  if (input.ids?.some(id => !index.has(id))) throw new Error('Unknown icon name; discover available names with world.map.symbols')
  const selected = (input.ids ? input.ids.map(id => index.get(id)!) : catalog.icons).filter(icon => terms.every(term => (icon.id + ' ' + icon.tags.join(' ')).includes(term)))
  return { library: catalog.library, version: catalog.version, total: selected.length, icons: selected.slice(input.offset, input.offset + input.limit).map(icon => ({ id: icon.id, tags: icon.tags,
    ...(input.artwork ? { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.body}</svg>` } : {}),
  })) }
}
