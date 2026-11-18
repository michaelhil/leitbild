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
  await expect(planning.getByLabel('Ask about the deadline', { exact: true })).toHaveValue('Can we complete maintenance by 17:00?')
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

test('one schedule viewer changes from an 18:00 success to the actual 15:00 refusal', async ({ page }) => {
  await withNuclearPlanning(page, async (planning, workspace) => {
    const fullPlan = new URL((await planning.getByRole('link', { name: 'Open full plan', exact: true }).getAttribute('href'))!, page.url())
    const plan = fullPlan.searchParams.get('planning')!
    const resource = { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: plan }
    const invoke = async (capability: string, input: unknown, expectedRevision?: number) => {
      const response = await page.request.post(`/api/workspaces/${workspace}/capabilities/${capability}/invoke`, {
        data: { resource, input, actor: { kind: 'human' }, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
      })
      expect(response.ok()).toBe(true)
      return (await response.json()).result
    }
    const summary = await invoke('planning.plan.read', { section: 'summary' })
    const revision = summary.sections.find((section: { id: string }) => section.id === 'summary').data.plan.revision
    for (const [time, finishBy, status] of [
      ['18:00', '2026-11-18T17:00:00Z', 'validated feasible'],
      ['15:00', '2026-11-18T14:00:00Z', 'proven infeasible'],
    ]) {
      const due = { kind: 'due', key: `requested-${time!.replace(':', '-')}`, job: 'restore', finishBy, words: `Requested finish by ${time}`, source: { by: 'assumption', note: 'Browser acceptance deadline question.' } }
      const generated = await invoke('planning.plan.generate', {
        seconds: 5, keep: true, variants: [{ label: `Extra crew by ${time}`, buy: ['extra-maintenance-crew'], also: [due] }],
      }, revision)
      const option = generated.options.find((candidate: { label: string }) => candidate.label === `Extra crew by ${time}`)
      expect(option.status.word).toBe(status)
      const published = await invoke('planning.plan.display', { option: option.key })
      expect(published.schedule.option.fresh).toBe(true)
      const envelope = { moduleId: 'planning', subject: resource, ...published.view }
      // The second navigation changes only the fragment, as the shared display
      // window does when another retained option is opened in the same frame.
      await page.goto(`/workspaces/${workspace}/planning/embed/planning.schedule#view=${encodeURIComponent(JSON.stringify(envelope))}`)
      await expect(page.getByText(new RegExp(`Requested finish by ${time}`))).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('region', { name: 'Checked schedule', exact: true })).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(5)
      await expect(page.getByRole('rowheader').last()).toContainText('16:00')
      if (time === '18:00') {
        await expect(page.getByText('Meets the requested deadline.', { exact: false })).toBeVisible()
        expect(published.schedule.option.cost).toBe(12_000)
      } else {
        await expect(page.getByText('The requested deadline is proven infeasible for this option.', { exact: true })).toBeVisible()
        await expect(page.getByText('Highlighted work belongs to the infeasibility proof.', { exact: true })).toBeVisible()
        await expect(page.getByText(/Requested finish by 18:00/)).toHaveCount(0)
        expect(published.schedule.certificate).toMatchObject({ kind: 'chain', workHours: 7, availableHours: 6 })
      }
    }
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
    const show = agents.getByRole('button', { name: /^Show the engineering calculation in this answer:/ }).first()
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
    await world.getByRole('link', { name: 'Back to planning demo', exact: true }).click()
    expect(new URL(page.url()).searchParams.get('agents')).toBe(room)
    await expect(page.frameLocator('iframe[title="Agents room"]').locator('body')).toContainText('Cooling-water calculation')
  })
})

test('plain deadline questions produce checked success and refusal visualizations', async ({ page }) => {
  test.skip(process.env.LEITBILD_E2E_ENGINEERING_AGENT !== '1', 'Enable LEITBILD_E2E_ENGINEERING_AGENT=1 with the actual configured provider for agent acceptance.')
  test.setTimeout(600_000)
  await withNuclearPlanning(page, async (planning, workspace) => {
    await planning.getByLabel('Ask about the deadline', { exact: true }).fill('Can we complete maintenance by 18:00? Show me how, or explain why not.')
    await planning.getByRole('button', { name: 'Ask Assistant', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('agents')).toBeTruthy()
    const agents = page.frameLocator('iframe[title="Agents room"]')
    const displays = agents.getByRole('button', { name: /^(Show|Hide) the planning schedule in this answer:/ })

    const checkedDisplay = async (after: number, deadline: string, status: string) => {
      await expect.poll(() => displays.count(), { timeout: 240_000 }).toBeGreaterThan(after)
      await expect(agents.locator('[data-live-view="preparing"]')).toHaveCount(0, { timeout: 30_000 })
      const count = await displays.count()
      for (let index = after; index < count; index += 1) {
        const toggle = displays.nth(index)
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
        const host = toggle.locator('xpath=ancestor::*[@data-live-view][1]')
        const frame = host.locator('iframe[src*="/planning/embed/planning.schedule"]')
        await expect(frame).toBeVisible({ timeout: 30_000 })
        const fragment = new URLSearchParams(new URL((await frame.getAttribute('src'))!, page.url()).hash.slice(1))
        const envelope = JSON.parse(fragment.get('view')!)
        const state = JSON.parse(envelope.state)
        expect(envelope).toMatchObject({ moduleId: 'planning', viewType: 'planning.schedule', subject: { workspaceId: workspace, type: 'planning.plan', id: state.plan } })
        const read = await page.request.post(`/api/workspaces/${workspace}/capabilities/planning.plan.display/invoke`, {
          data: {
            resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: state.plan },
            input: { option: state.option, digest: state.digest }, actor: { kind: 'human' },
          },
        })
        expect(read.ok()).toBe(true)
        const schedule = (await read.json()).result.schedule
        if (schedule.deadline === null || Date.parse(schedule.deadline.finishBy) !== Date.parse(deadline)
          || schedule.option.status.word !== status) continue
        expect(schedule.option.fresh).toBe(true)
        expect(schedule.deadline.job).toBe('restore')
        const result = frame.contentFrame()
        await expect(result.getByRole('region', { name: 'Checked schedule', exact: true })).toBeVisible({ timeout: 30_000 })
        await expect(result.getByRole('table', { name: 'Checked work schedule', exact: true }).getByRole('rowheader')).toHaveCount(5)
        return { result, schedule, plan: state.plan }
      }
      throw new Error(`The Assistant did not publish a ${status} Planning schedule for ${deadline}.`)
    }

    const fits = await checkedDisplay(0, '2026-11-18T17:00:00Z', 'validated feasible')
    expect(Date.parse(fits.schedule.option.finish)).toBe(Date.parse('2026-11-18T15:00:00Z'))
    expect(fits.schedule.option.cost).toBe(12_000)
    await expect(fits.result.getByText(/Requested finish by 18:00/)).toBeVisible()
    await expect(fits.result.getByText('Meets the requested deadline.', { exact: false })).toBeVisible()
    await expect(fits.result.getByRole('rowheader').last()).toContainText('16:00')

    const previousDisplays = await displays.count()
    const followup = agents.getByPlaceholder('Type a message... (Shift+Enter for newline)', { exact: true })
    await expect(followup).toBeEnabled()
    await followup.fill('What about 15:00? Show why it can or cannot finish by then.')
    await agents.getByRole('button', { name: 'Send', exact: true }).click()
    const refuses = await checkedDisplay(previousDisplays, '2026-11-18T14:00:00Z', 'proven infeasible')
    expect(refuses.plan).toBe(fits.plan)
    expect(refuses.schedule.certificate).toMatchObject({ kind: 'chain', workHours: 7, availableHours: 6 })
    expect(refuses.schedule.certificate.jobs).toEqual(expect.arrayContaining(['isolate', 'pump-work', 'inspect', 'restore']))
    expect(refuses.schedule.reference.fresh).toBe(true)
    expect(Date.parse(refuses.schedule.reference.finish)).toBe(Date.parse('2026-11-18T15:00:00Z'))
    await expect(refuses.result.getByText(/Requested finish by 15:00/)).toBeVisible()
    await expect(refuses.result.getByText('The requested deadline is proven infeasible for this option.', { exact: true })).toBeVisible()
    await expect(refuses.result.getByText('Highlighted work belongs to the infeasibility proof.', { exact: true })).toBeVisible()
    await expect(refuses.result.getByRole('rowheader').last()).toContainText('16:00')

    // A question must remain a what-if; the authored return target is unchanged.
    const jobs = await page.request.post(`/api/workspaces/${workspace}/capabilities/planning.plan.read/invoke`, {
      data: {
        resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: fits.plan },
        input: { section: 'jobs' }, actor: { kind: 'human' },
      },
    })
    expect(jobs.ok()).toBe(true)
    const section = (await jobs.json()).result.sections.find((entry: { id: string }) => entry.id === 'jobs')
    const restoration = section.data.items.find((entry: { job?: { key: string } }) => entry.job?.key === 'restore').job
    expect(Date.parse(restoration.target.finishBy)).toBe(Date.parse('2026-11-18T16:00:00Z'))
    await page.reload()
    await expect(page.frameLocator('iframe[title="Planning"]').getByRole('region', { name: 'Compare crew schedules', exact: true }).getByRole('button')).toHaveCount(2, { timeout: 30_000 })
  })
})
