import { expect, test } from 'bun:test'
import { parseSchematic, renderSchematic, updateSchematicDocument } from './schematic.ts'
const sample = () => ({
  id: 'EXAMPLE',
  equipment: [
    { id: 'A', label: 'Source', kind: 'vessel', ports: { outlet: 'water' } },
    { id: 'B', label: 'Receiver', kind: 'vessel', ports: { inlet: 'water' } },
  ],
  connections: [{ id: 'AB', from: 'A:outlet', to: 'B:inlet', kind: 'pipe', label: 'Normal reference flow' }],
  views: [{ title: 'Circuit', equipment: ['A', 'B'] }],
})
test('deterministic views come from one validated declaration', () => {
  const data = sample()
  expect(renderSchematic(data)).toContain('AB: Normal reference flow')
  const doc = '```plant-schematic\n' + JSON.stringify(data) + '\n```\n<!-- generated-schematic:start -->\n<!-- generated-schematic:end -->'
  const output = updateSchematicDocument(doc)
  expect(updateSchematicDocument(output)).toBe(output)
})
test('rejects unresolved identities, incompatible media, duplicate identities and hidden links', () => {
  const badPort = sample(); badPort.connections[0]!.to = 'B:missing'
  expect(() => parseSchematic(badPort)).toThrow('Unknown endpoint')
  const badMedium = sample(); badMedium.equipment[1]!.ports = { inlet: 'oil' }
  expect(() => parseSchematic(badMedium)).toThrow('Incompatible media')
  const badKind = sample(); badKind.connections[0]!.kind = 'signal'
  expect(() => parseSchematic(badKind)).toThrow('Wrong connection category')
  const duplicate = sample(); duplicate.equipment.push(duplicate.equipment[0]!)
  expect(() => parseSchematic(duplicate)).toThrow('Duplicate equipment')
  const hidden = sample(); hidden.views[0]!.equipment = ['A']
  expect(() => parseSchematic(hidden)).toThrow('no view')
})
test('rejects unsafe diagram labels and accidental schema expansion', () => {
  expect(() => parseSchematic({ ...sample(), execute: 'anything' })).toThrow()
  const injected = sample(); injected.equipment[0]!.label = '<script>'
  expect(() => parseSchematic(injected)).toThrow()
})
test('diagram text remains literal instead of interpreting replacement-string tokens', () => {
  const data = sample(); data.equipment[0]!.label = "Literal $& $$ $` $'"
  const doc = 'Before\n```plant-schematic\n' + JSON.stringify(data) + '\n```\n<!-- generated-schematic:start -->\n<!-- generated-schematic:end -->\nAfter'
  const output = updateSchematicDocument(doc)
  expect(output).toContain("Literal $& $$ $` $'")
  expect(updateSchematicDocument(output)).toBe(output)
  expect(output.match(/generated-schematic:start/g)).toHaveLength(1)
})
