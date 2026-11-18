import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Hash actual trusted execution sources, not a hand-maintained Pack version.
 * A saved origin refuses replay after solver or orchestration code changes. */
export const engineeringCodeDigest = async (): Promise<string> => {
  const root = join(import.meta.dir, '../../../../..')
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ bun: process.versions.bun, platform: process.platform, arch: process.arch }))
  const paths: string[] = []
  for (const folder of ['apps/world/src', 'packages/contracts/src', 'packages/module-runtime/src']) {
    for await (const path of new Bun.Glob('**/*.{ts,json}').scan({ cwd: join(root, folder) })) paths.push(`${folder}/${path}`)
  }
  paths.push('bun.lock')
  for (const path of paths.sort()) { hash.update(path); hash.update(Buffer.from(await Bun.file(join(root, path)).arrayBuffer())) }
  return hash.digest('hex')
}
