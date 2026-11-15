import { expect, test, type Request } from '@playwright/test'

/**
 * Einsatz plan F.1 V.6: from the landing page, "Try the dispatch demo" and
 * "Start demo" open the map with the Dispatch panel; opening the waiting call
 * C-1 and pressing its Dispatch button sends `world.einsatz.unit.order`, and
 * the Run accepts the order.
 *
 * The panel ignores a click that lands within 500 ms of its layout changing
 * (its double-click guard), which no person manages but a test runner does
 * as soon as the panel or the card appears. So the test clicks again until
 * the click acts: the call's row until its card is open, and Dispatch until
 * the order is on the network, never twice once it is.
 */
const isOrder = (request: Request): boolean => request.method() === 'POST'
  && new URL(request.url()).pathname.endsWith('/capabilities/world.einsatz.unit.order/invoke')

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

  const row = panel.getByRole('region', { name: 'Calls' }).getByRole('button', { name: /C-1 / })
  const card = panel.getByRole('article', { name: /^C-1 / })
  await expect(async () => {
    await row.click()
    await expect(card).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 30_000 })

  // The call card's first Dispatch button is its pinned proposal, "Dispatch A4 · 4 min".
  const proposal = card.getByRole('button', { name: /^Dispatch / }).first()
  await expect(proposal).toBeEnabled({ timeout: 30_000 })
  const ordered = page.waitForRequest(isOrder, { timeout: 30_000 })
  const seen: { request: Request | null } = { request: null }
  ordered.then(request => { seen.request = request }, () => {})
  await expect(async () => {
    if (seen.request === null) await proposal.click()
    await expect.poll(() => seen.request, { timeout: 1_000 }).not.toBeNull()
  }).toPass({ timeout: 30_000 })

  const response = await (await ordered).response()
  expect(response?.status()).toBe(200)
  expect(await response?.json()).toMatchObject({ kind: 'command', result: { ok: true } })
})
