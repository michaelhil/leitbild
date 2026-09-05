import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const uiRoot = join(import.meta.dir, '..', 'src', 'ui')
const outdir = join(uiRoot, 'dist')

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(uiRoot, 'modules', 'app.ts')],
  outdir,
  target: 'browser',
  format: 'esm',
  minify: true,
  naming: '[name]-[hash].[ext]',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const entry = result.outputs.find(output => output.kind === 'entry-point' && output.path.endsWith('.js'))
if (!entry) throw new Error('Agents UI build did not produce a JavaScript entry point')

const sourceHtml = await readFile(join(uiRoot, 'index.html'), 'utf8')
const html = sourceHtml
  .replace(/^\s*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/marked\/marked\.min\.js"><\/script>\s*$/m, '')
  .replace(/^\s*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/dompurify\/dist\/purify\.min\.js"><\/script>\s*$/m, '')
  .replace('<script type="module" src="/modules/app.ts"></script>', `<script type="module" src="/dist/${basename(entry.path)}"></script>`)

await writeFile(join(outdir, 'index.html'), html)
