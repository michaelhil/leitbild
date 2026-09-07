import { resolve } from 'node:path'
import { updateSchematicDocument } from '../packages/knowledge/src/schematic.ts'

const args = process.argv.slice(2), write = args.includes('--write')
const root = resolve(args.find(arg => !arg.startsWith('--')) ?? '../Leitbild-wiki')
let count = 0
for await (const path of new Bun.Glob('**/*.md').scan(root)) {
  const file = Bun.file(resolve(root, path)), original = await file.text()
  if (!/^```plant-schematic\s*$/m.test(original)) continue
  const next = updateSchematicDocument(original)
  if (write) await Bun.write(file, next)
  else if (next !== original) throw new Error(`Stale diagram: ${path}; rerun with --write`)
  console.log(`Checked ${path}`); count++
}
console.log(`${count} schematic documents valid; engineering behavior is not assessed by this check`)
