import { expect, test, type Request } from '@playwright/test'
import { doubleClickMs } from '../../src/packs/einsatz/ui/selection.ts'

/**
 * Einsatz plan F.1 V.6: from the landing page, "Try the dispatch demo" and
 * "Start demo" open the map with the Dispatch panel; opening the waiting call
 * C-1 and pressing its Dispatch button sends `world.einsatz.unit.order`, and
 * the Run accepts the order.
 *
 * Each click is made once. The panel ignores only the second half of a
 * double-click, a click within `doubleClickMs` of the last one that acted;
 * a test runner can click that fast where no person does, so the test lets
 * that interval pass after opening the card, as a person's pace does.
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
  await row.click()
  const openedAt = Date.now()
  await expect(card).toBeVisible()

  // The call card's first Dispatch button is its pinned proposal, "Dispatch A4 · 4 min".
  const proposal = card.getByRole('button', { name: /^Dispatch / }).first()
  await expect(proposal).toBeEnabled({ timeout: 30_000 })
  await page.waitForTimeout(Math.max(0, openedAt + doubleClickMs - Date.now()))
  const ordered = page.waitForRequest(isOrder, { timeout: 30_000 })
  await proposal.click()

  const response = await (await ordered).response()
  expect(response?.status()).toBe(200)
  expect(await response?.json()).toMatchObject({ kind: 'command', result: { ok: true } })
})
