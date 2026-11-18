import { expect, test } from '@playwright/test'

test('a public planning demo opens the map, compares two schedules, and returns to the truck', async ({ page }) => {
  const mapOrigin = process.env.LEITBILD_E2E_MAP_ORIGIN
  if (mapOrigin) {
    await page.route('**/map/**', async route => {
      const source = new URL(route.request().url())
      await route.fulfill({ response: await route.fetch({ url: new URL(source.pathname + source.search, mapOrigin).href }) })
    })
  }
  await page.goto('/workspaces?scenarios')
  const scenarios = page.getByRole('dialog')
  await expect(scenarios.getByRole('heading', { name: 'More scenarios', exact: true })).toBeVisible()
  const [created] = await Promise.all([
    page.waitForResponse(response => response.status() === 201
      && response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/workspaces'),
    scenarios.getByRole('button', { name: 'Start Halden: plan two deliveries', exact: true }).click(),
  ])
  const { workspace } = await created.json() as { workspace: { id: string } }
  try {

    const worldFrame = page.locator('iframe[title="World simulations"]')
    const world = worldFrame.contentFrame()
    const openPlanning = world.getByRole('link', { name: 'Open planning demo' })
    await expect(openPlanning).toBeVisible({ timeout: 90_000 })
    const run = new URL(page.url()).searchParams.get('world')
    expect(run).toBeTruthy()
    await expect(world.locator('canvas.maplibregl-canvas')).toBeVisible()
    await openPlanning.click()

    const planning = page.frameLocator('iframe[title="Planning"]')
    await expect(planning.getByRole('heading', { name: 'Plan two deliveries' })).toBeVisible()
    await expect(planning.getByText(/10 min to unload at each stop/)).toBeVisible({ timeout: 30_000 })
    const generate = planning.getByRole('button', { name: 'Generate schedules' })
    await expect(generate).toBeEnabled({ timeout: 30_000 })
    await generate.click()
    const schoolFirst = planning.getByRole('button', { name: 'School first' })
    const sportsHallFirst = planning.getByRole('button', { name: 'Sports hall first' })
    const stops = planning.getByRole('region', { name: 'Delivery schedule' }).getByRole('listitem')
    await expect(schoolFirst).toBeVisible({ timeout: 30_000 })
    await sportsHallFirst.click()
    await expect(sportsHallFirst).toHaveAttribute('aria-pressed', 'true')
    await expect(stops.first()).toContainText('Sports hall delivery')
    await expect(stops.first()).toContainText('On time')
    await expect(stops.last()).toContainText('late')
    await schoolFirst.click()
    await expect(schoolFirst).toHaveAttribute('aria-pressed', 'true')
    await expect(stops.first()).toContainText('School delivery')

    await planning.getByRole('link', { name: 'Show truck on map' }).click()
    await expect(worldFrame).toHaveAttribute('src', new RegExp(`/world/runs/${run}\\?focus=unit%3Adelivery-truck$`))
    expect(new URL(page.url()).searchParams.get('world')).toBe(run)
    await expect(world.getByText(/Showing .*truck on the map\./i)).toBeVisible({ timeout: 90_000 })
    await world.getByRole('link', { name: 'Back to planning demo' }).click()
    await expect(schoolFirst).toBeVisible({ timeout: 30_000 })
    await expect(sportsHallFirst).toBeVisible()
    await expect(stops).toHaveCount(2)
    await expect(generate).toHaveCount(0)
  } finally {
    if (!page.isClosed()) await page.goto('about:blank')
    const deleted = await page.request.delete(`/api/workspaces/${encodeURIComponent(workspace.id)}`)
    expect(deleted.ok()).toBe(true)
  }
})
