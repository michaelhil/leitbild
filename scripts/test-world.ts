import { resolve } from 'node:path'

// Keep Bun 1.4.0's isolated file semantics, but discard its native VM between
// files. A long World run crashed during cross-file teardown; a related upstream
// report is https://github.com/oven-sh/bun/issues/47245. This contains that risk
// without changing the pinned production runtime or retrying failed tests.
export const discoverWorldTests = (root: string): string[] => [...new Bun.Glob('**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}').scanSync({
  cwd: root, onlyFiles: true, dot: true,
})].filter(path => !path.split('/').slice(0, -1).some(part => part === 'node_modules' || part.startsWith('.'))).sort()

export const runWorldTests = async (root: string, args: string[] = []): Promise<number> => {
  // Explicit developer selections/flags retain Bun's CLI interpretation. The
  // complete release gate has no arguments and always uses one child per file.
  const runs = args.length ? [args] : discoverWorldTests(root).map(path => [`./${path}`])
  if (runs.length === 0) throw new Error('No World test files found')
  let child: ReturnType<typeof Bun.spawn> | undefined
  let cancelled: number | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const cancel = (code: number) => {
    cancelled ??= code
    child?.kill('SIGTERM')
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 5000)
    killTimer.unref()
  }
  const interrupt = () => cancel(130), terminate = () => cancel(143)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    for (const [index, selection] of runs.entries()) {
      if (cancelled !== undefined) return cancelled
      console.log(`World test process ${index + 1}/${runs.length}: ${selection.join(' ')}`)
      child = Bun.spawn([process.execPath, 'test', '--isolate', '--timeout', '120000', ...selection], {
        cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      })
      const code = await child.exited
      child = undefined
      if (cancelled !== undefined) return cancelled
      if (code !== 0) return code
    }
    console.log(`World test processes completed: ${runs.length}/${runs.length}`)
    return 0
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

if (import.meta.main) process.exit(await runWorldTests(resolve(import.meta.dir, '../apps/world'), process.argv.slice(2)))
