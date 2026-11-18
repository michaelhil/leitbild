import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * Browser smoke tests (Einsatz plan F.1 V.6, owner decision 9). They drive a
 * real Chromium against a Leitbild that is already running, so they are not
 * part of `bun run test`: the deploying machine runs them in deploy validation
 * with `bun run test:e2e` in apps/world, naming the origin to test.
 *
 * That Leitbild must serve the base map, because World mounts its surface
 * panels once the map's style has loaded; `bun run dev:stack` loads no map
 * artifacts. A run starts a demo, which creates a Workspace there.
 */
const origin = process.env.LEITBILD_E2E_ORIGIN
if (origin === undefined || origin === '') {
  throw new Error('Set LEITBILD_E2E_ORIGIN to the origin of the Leitbild to test, for example http://127.0.0.1:43100')
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  outputDir: join(tmpdir(), 'leitbild-e2e-results'),
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: origin,
    // The plan's desktop walkthrough viewport.
    viewport: { width: 1366, height: 900 },
  },
})
