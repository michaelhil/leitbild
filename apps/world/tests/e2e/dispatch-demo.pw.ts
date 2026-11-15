import { expect, test } from '@playwright/test'

/**
 * Einsatz plan F.1 V.6: from the landing page, "Try the dispatch demo" and
 * "Start demo" open the map with the Dispatch panel; opening the waiting call
 * C-1 and pressing its Dispatch button sends `world.einsatz.unit.order`, and
 * the Run accepts the order.
 */
test('the dispatch demo sends an order from the landing page in four clicks', async ({ page }) => {
  await page.goto('/workspaces')
  // Setup, not part of the path: stop the hero carousel on the dispatch slide.
  await page.getByRole('button', { name: 'Stop automatic slide show' }).click()
  await page.getByRole('tab', { name: /Dispatch by touch/ }).click()

  await page.getByRole('link', { name: 'Try the dispatch demo' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Start demo' }).click()

  const world = page.frameLocator('iframe[title="World simulations"]')
  const panel = world.getByRole('region', { name: 'Dispatch' })
  await expect(panel).toBeVisible({ timeout: 90_000 })

  await panel.getByRole('region', { name: 'Calls' }).getByRole('button', { name: /C-1 / }).click()
  // The call card's first Dispatch button is its pinned proposal, "Dispatch A4 · 4 min".
  const proposal = panel.getByRole('article', { name: /^C-1 / }).getByRole('button', { name: /^Dispatch / }).first()
  await expect(proposal).toBeEnabled({ timeout: 30_000 })

  const answered = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/capabilities/world.einsatz.unit.order/invoke'))
  await proposal.click()
  const response = await answered
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ kind: 'command', result: { ok: true } })
})
