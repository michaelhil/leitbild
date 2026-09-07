import { z } from 'zod'

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
const label = z.string().min(1).max(160).regex(/^[^"<>\n\r]*$/)
const equipment = z.object({
  id: identifier, label, kind: z.enum(['vessel', 'pump', 'exchanger', 'valve', 'instrument', 'controller', 'boundary']),
  ports: z.record(identifier, z.string().min(1)),
}).strict()
export const schematicSchema = z.object({
  id: identifier,
  equipment: z.array(equipment).min(1),
  connections: z.array(z.object({
    id: identifier, from: z.string(), to: z.string(),
    kind: z.enum(['pipe', 'signal', 'heat', 'electric']), label,
  }).strict()),
  views: z.array(z.object({ title: label, equipment: z.array(identifier).min(1) }).strict()).min(1),
}).strict()

export const parseSchematic = (input: unknown) => {
  const data = schematicSchema.parse(input)
  const byId = new Map(data.equipment.map(item => [item.id, item]))
  if (byId.size !== data.equipment.length) throw new Error('Duplicate equipment identity')
  const ids = new Set<string>()
  const endpoint = (ref: string) => {
    const parts = ref.split(':')
    if (parts.length !== 2) throw new Error(`Expected equipment:port: ${ref}`)
    const item = byId.get(parts[0]!)
    const medium = item && Object.hasOwn(item.ports, parts[1]!) ? item.ports[parts[1]!] : undefined
    if (!medium) throw new Error(`Unknown endpoint: ${ref}`)
    return medium
  }
  for (const connection of data.connections) {
    if (ids.has(connection.id)) throw new Error(`Duplicate connection: ${connection.id}`)
    ids.add(connection.id)
    const from = endpoint(connection.from), to = endpoint(connection.to)
    if (connection.from === connection.to) throw new Error(`Self-connection: ${connection.id}`)
    if (from !== to) throw new Error(`Incompatible media: ${connection.id}: ${from} / ${to}`)
    const reserved = new Set(['signal', 'heat', 'electric'])
    if (connection.kind === 'pipe' ? reserved.has(from) : from !== connection.kind)
      throw new Error(`Wrong connection category: ${connection.id}`)
  }
  const titles = new Set<string>()
  const visibleConnections = new Set<string>()
  for (const view of data.views) {
    if (titles.has(view.title)) throw new Error(`Duplicate view: ${view.title}`)
    titles.add(view.title)
    if (new Set(view.equipment).size !== view.equipment.length) throw new Error(`Repeated equipment in ${view.title}`)
    for (const id of view.equipment) if (!byId.has(id)) throw new Error(`Unknown view equipment: ${id}`)
    for (const c of data.connections) if (view.equipment.includes(c.from.split(':')[0]!) && view.equipment.includes(c.to.split(':')[0]!)) visibleConnections.add(c.id)
  }
  for (const c of data.connections) if (!visibleConnections.has(c.id)) throw new Error(`Connection has no view: ${c.id}`)
  for (const e of data.equipment) if (!data.views.some(v => v.equipment.includes(e.id))) throw new Error(`Equipment has no view: ${e.id}`)
  return data
}

export const renderSchematic = (input: unknown): string => {
  const data = parseSchematic(input)
  const names = new Map(data.equipment.map((item, i) => [item.id, `n${i}`]))
  return data.views.map(view => {
    const lines = ['flowchart TB']
    for (const item of data.equipment.filter(e => view.equipment.includes(e.id))) {
      const text = `${item.id} — ${item.label}`
      const node = item.kind === 'instrument' ? `(("${text}"))` : item.kind === 'valve' ? `{"${text}"}` : `["${text}"]`
      lines.push(`  ${names.get(item.id)}${node}`)
    }
    for (const c of data.connections) {
      const [from] = c.from.split(':'), [to] = c.to.split(':')
      if (!view.equipment.includes(from!) || !view.equipment.includes(to!)) continue
      const edge = c.kind === 'pipe' ? '-->' : c.kind === 'signal' ? '-.->' : '==>'
      lines.push(`  ${names.get(from!)} ${edge}|"${c.id}: ${c.label}"| ${names.get(to!)}`)
    }
    return `### ${view.title}\n\n\`\`\`mermaid\n${lines.join('\n')}\n\`\`\``
  }).join('\n\n')
}

export const updateSchematicDocument = (text: string): string => {
  const blocks = [...text.matchAll(/```plant-schematic\s*\n([\s\S]*?)\n```/g)]
  if (blocks.length !== 1) throw new Error('Expected exactly one plant-schematic declaration')
  const marker = /<!-- generated-schematic:start -->[\s\S]*?<!-- generated-schematic:end -->/g
  if ([...text.matchAll(marker)].length !== 1) throw new Error('Expected one generated diagram region')
  const rendered = renderSchematic(JSON.parse(blocks[0]![1]!))
  return text.replace(marker, () => `<!-- generated-schematic:start -->\n${rendered}\n<!-- generated-schematic:end -->`)
}
