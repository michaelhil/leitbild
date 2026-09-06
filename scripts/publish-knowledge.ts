import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { publishKnowledge } from '../packages/knowledge/src/publish.ts'

const root = process.argv[2]
if (!root) throw new Error('Usage: bun run knowledge:publish /path/to/knowledge-repository')
const snapshot = await publishKnowledge(resolve(root))
const target = resolve(import.meta.dir, '../knowledge/snapshot.json')
await mkdir(dirname(target), { recursive: true })
await Bun.write(target, JSON.stringify(snapshot))
console.log(`Published ${snapshot.documents.length} knowledge documents at ${snapshot.revision}`)
