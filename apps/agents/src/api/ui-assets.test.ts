import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentsUiAssetFromPath, agentsUiAssetPath, serveAgentsUiAsset } from './ui-assets.ts'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Agents UI asset namespace', () => {
  test('uses one explicit, collision-free public namespace', () => {
    expect(agentsUiAssetPath('app.js')).toBe('/assets/agents/app.js')
    expect(agentsUiAssetPath('styles.css')).toBe('/assets/agents/styles.css')
  })

  test('does not expose arbitrary files from the UI tree', () => {
    expect(agentsUiAssetFromPath('/assets/agents/app.js')).toBe('app.js')
    expect(agentsUiAssetFromPath('/assets/agents/styles.css')).toBe('styles.css')
    expect(agentsUiAssetFromPath('/assets/agents/../modules/app.ts')).toBeNull()
    expect(agentsUiAssetFromPath('/dist/app.js')).toBeNull()
  })

  test('serves only the built application and stylesheet', async () => {
    const uiPath = await mkdtemp(join(tmpdir(), 'leitbild-agents-ui-'))
    temporaryDirectories.push(uiPath)
    await mkdir(join(uiPath, 'dist'))
    await writeFile(join(uiPath, 'dist', 'app.js'), 'globalThis.booted = true')
    await writeFile(join(uiPath, 'dist.css'), 'body { color: black }')

    const script = await serveAgentsUiAsset('/assets/agents/app.js', uiPath)
    expect(script?.headers.get('content-type')).toBe('application/javascript')
    expect(script?.headers.get('cache-control')).toBe('no-cache')
    expect(await script?.text()).toBe('globalThis.booted = true')

    const stylesheet = await serveAgentsUiAsset('/assets/agents/styles.css', uiPath)
    expect(stylesheet?.headers.get('content-type')).toBe('text/css')
    expect(await stylesheet?.text()).toBe('body { color: black }')
    expect(await serveAgentsUiAsset('/assets/agents/secrets.json', uiPath)).toBeNull()
  })
})
