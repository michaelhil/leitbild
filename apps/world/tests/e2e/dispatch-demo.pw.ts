import { expect, test, type FrameLocator, type Locator, type Page, type Request } from '@playwright/test'
import { doubleClickMs } from '../../src/packs/einsatz/ui/selection.ts'

const isUnitCommand = (request: Request, command: string): boolean => request.method() === 'POST'
  && new URL(request.url()).pathname.endsWith(`/capabilities/world.einsatz.unit.${command}/invoke`)

const unitCommand = async (page: Page, command: string, click: () => Promise<void>, accepted = true) => {
  const [response] = await Promise.all([
    page.waitForResponse(response => isUnitCommand(response.request(), command), { timeout: 30_000 }),
    click(),
  ])
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ kind: 'command', result: { ok: accepted } })
  return response.request().postDataJSON()
}

// Each smoke test owns and removes the Workspace it created.
const withDispatchDemo = async (page: Page, play: (world: FrameLocator, panel: Locator) => Promise<void>): Promise<void> => {
  const mapOrigin = process.env.LEITBILD_E2E_MAP_ORIGIN
  if (mapOrigin) {
    await page.route('**/map/**', async route => {
      const source = new URL(route.request().url())
      await route.fulfill({ response: await route.fetch({ url: new URL(source.pathname + source.search, mapOrigin).href }) })
    })
  }
  await page.goto('/workspaces')
  await page.getByRole('button', { name: 'Stop automatic slide show' }).click()
  await page.getByRole('tab', { name: /Dispatch by touch/ }).click()
  await page.getByRole('link', { name: 'Try the dispatch demo' }).click()

  const [created] = await Promise.all([
    page.waitForResponse(response => response.status() === 201
      && response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/workspaces'),
    page.getByRole('dialog').getByRole('button', { name: 'Start demo' }).click(),
  ])
  const { workspace } = await created.json() as { workspace: { id: string } }
  try {
    const world = page.frameLocator('iframe[title="World simulations"]')
    const panel = world.getByRole('region', { name: 'Dispatch' })
    await expect(panel).toBeVisible({ timeout: 90_000 })
    await play(world, panel)
  } finally {
    if (!page.isClosed()) await page.goto('about:blank')
    const response = await page.request.delete(`/api/workspaces/${encodeURIComponent(workspace.id)}`)
    expect(response.ok()).toBe(true)
  }
}

test('the dispatch demo sends a suggested unit from its call card', async ({ page }) => {
  await withDispatchDemo(page, async (_, panel) => {
    const row = panel.getByRole('region', { name: 'Calls' }).getByRole('button', { name: /C-1 / })
    const card = panel.getByRole('article', { name: /^C-1 / })
    await row.click()
    const openedAt = Date.now()
    await expect(card).toBeVisible()

    const proposal = card.getByRole('button', { name: /^Dispatch / }).first()
    await expect(proposal).toBeEnabled({ timeout: 30_000 })
    // Let the panel's double-click interval pass before pressing another command.
    await page.waitForTimeout(Math.max(0, openedAt + doubleClickMs - Date.now()))
    await unitCommand(page, 'order', () => proposal.click())
  })
})

test('selecting a unit allows direct dispatch and editing its assigned stops', async ({ page }) => {
  const orders: Request[] = []
  page.on('request', request => { if (isUnitCommand(request, 'order')) orders.push(request) })
  await withDispatchDemo(page, async (world, panel) => {
    // Keep arrivals from changing the plan while this test exercises its edits.
    await page.getByRole('button', { name: 'Pause simulation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Play simulation', exact: true })).toBeVisible()
    const asset = panel.getByRole('region', { name: 'Units' }).getByRole('button', { name: /^A4\b/ })
    await asset.click()
    const unit = panel.getByRole('article', { name: /^A4\b/ })
    await unit.getByText('Targets', { exact: true }).click()

    const call = unit.getByRole('button', { name: /C-1 Tistedal fall/ })
    expect(await unitCommand(page, 'order', () => call.click())).toMatchObject({
      input: { stops: [{ taskId: 'task:tistedal-fall' }] },
    })
    await expect(unit).toBeHidden()
    await expect(asset).toHaveAttribute('data-progress', 'active', { timeout: 15_000 })
    await expect(panel.getByRole('region', { name: 'Calls' }).getByRole('button', { name: /C-1 Tistedal fall/ })).toHaveAttribute('data-progress', 'active')
    await asset.click()
    await expect(unit.getByRole('button', { name: /Remove stop 1:.*C-1 Tistedal fall/ })).toBeVisible({ timeout: 15_000 })
    await unit.getByText('Targets', { exact: true }).click()

    const dialog = world.getByRole('dialog', { name: 'Change the plan?' })
    const clinic = unit.getByRole('button', { name: /Halden emergency clinic/ })
    await clinic.click()
    await expect(dialog.getByRole('button', { name: 'Replace current target' })).toBeVisible()
    const cancel = dialog.getByRole('button', { name: 'Cancel' })
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(clinic).toBeFocused()
    expect(orders).toHaveLength(1)

    await clinic.click()
    const add = dialog.getByRole('button', { name: 'Add to plan' })
    const clinicRoute = page.waitForResponse(response => isUnitCommand(response.request(), 'plan.routes')
      && response.request().postDataJSON().input.expectedPlan.length === 2, { timeout: 15_000 })
    expect(await unitCommand(page, 'order', () => add.click())).toMatchObject({
      input: { stops: [{ siteId: 'site:halden-clinic' }], when: 'after' },
    })
    await expect(unit.getByRole('button', { name: /Remove stop 2:.*Halden emergency clinic/ })).toBeVisible()
    const route = await clinicRoute
    expect(route.status()).toBe(200)
    expect(await route.json()).toMatchObject({
      kind: 'query',
      result: { features: [expect.objectContaining({ lineDashed: true, geometry: { type: 'LineString', coordinates: expect.any(Array) } })] },
    })

    const triage = unit.getByRole('button', { name: /Remmen triage post/ })
    await triage.click()
    await unitCommand(page, 'order', () => add.click())
    const earlier = unit.getByRole('button', { name: /Move stop 3 earlier:.*Remmen triage post/ })
    const removeTriage = unit.getByRole('button', { name: /Remove stop 3:.*Remmen triage post/ })
    const inFlight = Promise.withResolvers<void>()
    await page.route('**/capabilities/world.einsatz.unit.plan.reorder/invoke', async route => {
      await inFlight.promise
      await route.continue()
    }, { times: 1 })
    const reorder = unitCommand(page, 'plan.reorder', () => earlier.click(), false)
    try {
      await expect(removeTriage).toBeDisabled()
      await expect(unit.getByText('Updating plan…', { exact: true })).toBeVisible()
    } finally {
      inFlight.resolve()
      await reorder
    }
    await expect(unit.getByRole('alert')).toContainText('must follow the pickup it delivers')
    await expect(panel.locator('.selection')).toHaveAttribute('aria-busy', 'false')

    // The numbered stop row exercises the same confirmation as clicking a red map destination.
    await removeTriage.click()
    const removal = world.getByRole('dialog', { name: 'Remove stop?' })
    await expect(removal).toBeVisible()
    await unitCommand(page, 'stop.remove', () => removal.getByRole('button', { name: 'Remove stop', exact: true }).click())
    await expect(removeTriage).toBeHidden()
    await expect(unit.getByRole('button', { name: /Remove stop 1:.*C-1 Tistedal fall/ })).toBeVisible()
    expect(orders).toHaveLength(3)
  })
})
