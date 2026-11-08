import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const uiRoot = join(import.meta.dir, '..', 'src', 'ui')
const outdir = join(uiRoot, 'dist')

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(uiRoot, 'modules', 'app.ts'), join(uiRoot, 'modules', 'engineering.ts')],
  outdir,
  target: 'browser',
  format: 'esm',
  minify: true,
  splitting: true,
  naming: { entry: '[name].js', chunk: 'chunk-[hash].js', asset: 'asset-[name]-[hash].[ext]' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

for (const name of ['app.js', 'engineering.js']) {
  if (!result.outputs.some(output => output.kind === 'entry-point' && output.path === join(outdir, name))) throw new Error(`Agents UI build did not produce ${name}`)
}

const sourceHtml = await readFile(join(uiRoot, 'index.html'), 'utf8')
await writeFile(join(outdir, 'index.html'), sourceHtml)
for (const name of ['engineering.html', 'engineering.css']) await writeFile(join(outdir, name), await readFile(join(uiRoot, name), 'utf8'))
