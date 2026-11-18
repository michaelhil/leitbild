import { expect, test, type FrameLocator, type Page } from '@playwright/test'

const demo = 'nuclear-maintenance-planning'

// A fresh public Workspace exercises the same launch path as the carousel.
// Provider work is opt-in for routine smoke runs, but must be run explicitly
// when qualifying a release that changes this demonstration's agent journey.
const withNuclearPlanning = async (page: Page, play: (planning: FrameLocator, workspace: string, run: string) => Promise<void>) => {
  const mapOrigin = process.env.LEITBILD_E2E_MAP_ORIGIN
  if (mapOrigin) {
    await page.route('**/map/**', async route => {
      const source = new URL(route.request().url())
      await route.fulfill({ response: await route.fetch({ url: new URL(source.pathname + source.search, mapOrigin).href }) })
    })
  }
  await page.goto(`/workspaces?demos=world%3A${demo}`)
  const carousel = page.getByRole('dialog')
  await expect(carousel.getByRole('heading', { name: 'Nuclear planning: a pump maintenance window' })).toBeVisible()
  const [created] = await Promise.all([
    page.waitForResponse(response => response.status() === 201
      && response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/workspaces'),
    carousel.getByRole('button', { name: 'Start demo', exact: true }).click(),
  ])
  const { workspace } = await created.json() as { workspace: { id: string } }
  try {
    const world = page.frameLocator('iframe[title="World simulations"]')
    await expect(world.locator('canvas.maplibregl-canvas')).toBeVisible({ timeout: 90_000 })
    const compare = world.getByRole('link', { name: 'Compare maintenance schedules', exact: true })
    await expect(compare).toBeVisible({ timeout: 90_000 })
    const run = new URL(page.url()).searchParams.get('world')
    expect(run).toBeTruthy()
    await compare.click()
    const planning = page.frameLocator('iframe[title="Planning"]')
    await expect(planning.getByRole('heading', { name: 'Nuclear maintenance planning', exact: true })).toBeVisible()
    await expect(planning.getByRole('button', { name: /^One crew\b/ })).toBeVisible({ timeout: 30_000 })
    await play(planning, workspace.id, run!)
  } finally {
    if (!page.isClosed()) await page.goto('about:blank')
    const deleted = await page.request.delete(`/api/workspaces/${encodeURIComponent(workspace.id)}`)
    expect(deleted.ok()).toBe(true)
  }
}

const schedules = async (planning: FrameLocator) => {
  await expect(planning.getByText('Can maintenance finish by 17:00?', { exact: true })).toBeVisible()
  await expect(planning.getByRole('button', { name: /Generate/ })).toHaveCount(0)
  const one = planning.getByRole('button', { name: /^One crew\b/ })
  const extra = planning.getByRole('button', { name: /^Extra crew\b/ })
  await expect(one).toHaveAttribute('aria-pressed', 'true')
  const schedule = planning.getByRole('region', { name: 'Maintenance schedule', exact: true })
  await expect(schedule).toBeVisible()
  const jobs = schedule.getByRole('rowheader')
  await expect(schedule.getByRole('table')).toHaveAccessibleName('One crew maintenance schedule')
  await expect(schedule.getByRole('row')).toHaveCount(6)
  await expect(jobs).toHaveCount(5)
  await expect(jobs.last()).toContainText('19:00')
  await extra.click()
  await expect(extra).toHaveAttribute('aria-pressed', 'true')
  await expect(schedule.getByRole('table')).toHaveAccessibleName('Extra crew maintenance schedule')
  await expect(jobs.last()).toContainText('16:00')
  await expect(jobs.last()).not.toContainText('19:00')
  await expect(planning.getByText(/12[,.\s]000/).first()).toBeVisible()
  await one.click()
  await expect(jobs.last()).toContainText('19:00')
}

test('nuclear planning compares actual crew schedules without opening the editor', async ({ page }) => {
  await withNuclearPlanning(page, async planning => {
    await schedules(planning)
    await page.reload()
    const reopened = page.frameLocator('iframe[title="Planning"]')
    await expect(reopened.getByRole('region', { name: 'Maintenance schedule', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(reopened.getByRole('button', { name: /Generate/ })).toHaveCount(0)
    await reopened.getByRole('button', { name: /^Extra crew\b/ }).click()
    await expect(reopened.getByRole('region', { name: 'Maintenance schedule', exact: true }).getByRole('row').last()).toContainText('16:00')
  })
})

test('the scoped engineering agent produces an inspectable calculation beside the plan', async ({ page }) => {
  test.skip(process.env.LEITBILD_E2E_ENGINEERING_AGENT !== '1', 'Enable LEITBILD_E2E_ENGINEERING_AGENT=1 with the actual configured provider for agent acceptance.')
  test.setTimeout(300_000)
  await withNuclearPlanning(page, async (planning, workspace, run) => {
    await expect(planning.getByRole('heading', { name: 'Estimate heat transport', exact: true })).toBeVisible()
    await planning.getByRole('button', { name: /^Extra crew\b/ }).click()
    await planning.getByRole('button', { name: 'Ask Assistant to calculate', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('agents')).toBeTruthy()
    const room = new URL(page.url()).searchParams.get('agents')!
    expect(new URL(page.url()).searchParams.get('run')).toBe(run)
    await expect(planning.getByRole('heading', { name: 'Nuclear maintenance planning', exact: true })).toBeVisible()
    await expect(planning.getByRole('button', { name: /^Extra crew\b/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(planning.getByRole('region', { name: 'Maintenance schedule', exact: true }).getByRole('row').last()).toContainText('16:00')
    const agents = page.frameLocator('iframe[title="Agents room"]')
    const show = agents.getByRole('button', { name: /^Show the live display in this answer:/ }).first()
    await expect(show).toBeVisible({ timeout: 240_000 })
    await show.click()
    const result = agents.frameLocator('iframe[src*="/agents/embed/engineering.result"]')
    await expect(result.getByRole('heading', { name: 'Inputs used', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(result.getByRole('heading', { name: 'Try changed assumptions', exact: true })).toBeVisible()
    const disclosure = result.locator('details').filter({ has: result.locator('summary', { hasText: 'Full calculation receipt and execution limits' }) })
    await disclosure.locator('summary').click()
    const receipt = JSON.parse(await disclosure.locator('pre').innerText())
    expect(receipt).toMatchObject({
      kind: 'engineering-calculation', mode: 'exploratory-script', qualification: 'research-only',
      request: { operation: 'run' }, outcome: { status: 'completed' },
    })
    expect(receipt.programSource.length).toBeGreaterThan(0)
    expect(receipt.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'observation', value: 350 }),
      expect.objectContaining({ origin: 'assumption', value: 10 }),
    ]))
    expect(receipt.inputs.some((input: { origin: string; value: number; unit: string }) => input.origin === 'assumption'
      && (input.value === 4.18 && input.unit.includes('kJ') || input.value === 4180 && input.unit.includes('J')))).toBe(true)
    expect(receipt.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: 'plant:maintenance', profile: 'plant-maintenance', source: expect.objectContaining({ id: run }) }),
    ]))
    expect(receipt.observationRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantityId: 'componentCoolingWaterPumpB.flowKgPerS' }),
    ]))
    const numbers = (value: unknown): number[] => typeof value === 'number' ? [value]
      : Array.isArray(value) ? value.flatMap(numbers)
      : value !== null && typeof value === 'object' ? Object.values(value).flatMap(numbers) : []
    expect(numbers(receipt.outcome.output).some(value => Math.abs(value - 14.63) < 1e-6
      || Math.abs(value - 14_630) < 1e-3 || Math.abs(value - 14_630_000) < 1e-3)).toBe(true)

    // Confirm this is the retained actual tool attempt, not just text in an answer.
    const frame = agents.locator('iframe[src*="/agents/embed/engineering.result"]')
    const fragment = new URLSearchParams(new URL((await frame.getAttribute('src'))!, page.url()).hash.slice(1))
    const locator = JSON.parse(JSON.parse(fragment.get('view')!).state)
    const attempt = await page.request.get(`/api/workspaces/${workspace}/agents/rooms/${room}/executions/${locator.turnId}/calls/${locator.toolCallId}`)
    expect(attempt.ok()).toBe(true)
    expect(await attempt.json()).toMatchObject({ tool: 'engineering_run' })

    const rise = receipt.request.input.bindings.find((binding: { kind: string; value: number }) => binding.kind === 'assumption' && binding.value === 10)
    expect(rise).toBeTruthy()
    await result.getByLabel(`${rise.name} (${rise.unit})`, { exact: true }).fill('5')
    const [rerun] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/workspaces/${workspace}/agents/rooms/${room}/engineering`),
      result.getByRole('button', { name: 'Rerun these inputs', exact: true }).click(),
    ])
    expect(rerun.ok()).toBe(true)
    const changed = (await rerun.json()).receipt
    expect(changed).toMatchObject({ mode: 'exploratory-script', outcome: { status: 'completed' } })
    expect(changed.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'observation', value: 350 }),
      expect.objectContaining({ name: rise.name, origin: 'assumption', value: 5 }),
    ]))
    expect(changed.inputDigest).not.toBe(receipt.inputDigest)
    expect(changed.sources).toEqual(receipt.sources)
    expect(numbers(changed.outcome.output).some(value => Math.abs(value - 7.315) < 1e-6
      || Math.abs(value - 7_315) < 1e-3 || Math.abs(value - 7_315_000) < 1e-3)).toBe(true)
    await expect(result.getByRole('button', { name: 'Return to original result', exact: true })).toBeVisible()

    await planning.getByRole('link', { name: /World plant/ }).click()
    expect(new URL(page.url()).searchParams.get('agents')).toBe(room)
    const world = page.frameLocator('iframe[title="World simulations"]')
    await world.getByRole('link', { name: 'Compare maintenance schedules', exact: true }).click()
    expect(new URL(page.url()).searchParams.get('agents')).toBe(room)
    await expect(page.frameLocator('iframe[title="Agents room"]').locator('body')).toContainText('Cooling-water calculation')
  })
})
