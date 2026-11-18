import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const demo = 'nuclear-maintenance-planning'
const completionTitle = 'Restore, test and accept the A cooling train'
const evidenceRun = new Date().toISOString().replaceAll(':', '-')
const evidenceDirectory = (): string | null => {
  const destination = process.env.LEITBILD_E2E_EVIDENCE_DIR
  return destination === undefined ? null : join(resolve(destination), `${evidenceRun}-${test.info().title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 110)}`)
}
const saveEvidence = async (name: string, value: unknown): Promise<void> => {
  const directory = evidenceDirectory()
  if (directory === null) return
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${name}.json`)
  await writeFile(path, JSON.stringify(value, null, 2))
  await test.info().attach(name, { path, contentType: 'application/json' })
}
const saveEvidenceImage = async (name: string, capture: (path: string) => Promise<unknown>): Promise<void> => {
  const directory = evidenceDirectory()
  if (directory === null) return
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${name}.png`)
  await capture(path)
  await test.info().attach(name, { path, contentType: 'image/png' })
}
const captureRoomEvidence = async (page: Page, workspace: string, playFailed = false): Promise<void> => {
  if (evidenceDirectory() === null) return
  await saveEvidence('test-context', { workspace, url: page.url(), capturedAt: new Date().toISOString(), status: playFailed ? 'failed' : test.info().status })
  if (!page.isClosed()) await saveEvidenceImage('workspace-final', path => page.screenshot({ path, fullPage: true }))
  const room = new URL(page.url()).searchParams.get('agents')
  if (room === null) return
  const base = `/api/workspaces/${workspace}/agents/rooms/${encodeURIComponent(room)}`
  const read = async (path: string) => {
    const response = await page.request.get(path)
    const body = await response.json()
    return { status: response.status(), body }
  }
  const conversation = await read(`${base}/export`)
  await saveEvidence('room-export', conversation)
  expect(conversation.status).toBe(200)
  const turns: Array<{ id: string; startedAt: number }> = []
  let next: { id: string; startedAt: number } | undefined
  let indexPage = 0
  do {
    const query = new URLSearchParams({ limit: '100', ...(next === undefined ? {} : { beforeId: next.id, beforeStartedAt: String(next.startedAt) }) })
    const index = await read(`${base}/executions?${query}`)
    await saveEvidence(`execution-index-page-${indexPage++}`, index)
    expect(index.status).toBe(200)
    turns.push(...index.body.turns)
    next = index.body.next
  } while (next !== undefined)
  await saveEvidence('execution-index', { room, turns })
  for (const turn of turns) {
    const execution = await read(`${base}/executions/${encodeURIComponent(turn.id)}`)
    await saveEvidence(`execution-${turn.id}-summary`, execution)
    expect(execution.status).toBe(200)
    const calls = await Promise.all(execution.body.calls.map(async (call: { id: string }) => read(`${base}/executions/${encodeURIComponent(turn.id)}/calls/${encodeURIComponent(call.id)}`)))
    await saveEvidence(`execution-${turn.id}`, { ...execution, calls })
    expect(calls.every((call: { status: number }) => call.status === 200)).toBe(true)
  }
}

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
  await expect(carousel.getByRole('heading', { name: 'Nuclear maintenance and outage planning' })).toBeVisible()
  const [created] = await Promise.all([
    page.waitForResponse(response => response.status() === 201
      && response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/workspaces'),
    carousel.getByRole('button', { name: 'Start demo', exact: true }).click(),
  ])
  const { workspace } = await created.json() as { workspace: { id: string } }
  let playFailed = false
  let playFailure: unknown
  try {
    const qaName = `QA nuclear planning verification ${evidenceRun} ${test.info().title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 90)}`
    const renamed = await page.request.patch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { data: { name: qaName } })
    const renameText = await renamed.text()
    await saveEvidence('workspace-label', { workspace: workspace.id, name: qaName, status: renamed.status(), body: renameText })
    const renameBody = JSON.parse(renameText)
    expect(renamed.ok()).toBe(true)
    expect(renameBody.workspace).toMatchObject({ id: workspace.id, name: qaName })
    const world = page.frameLocator('iframe[title="World simulations"]')
    await expect(world.locator('canvas.maplibregl-canvas')).toBeVisible({ timeout: 90_000 })
    const compare = world.getByRole('link', { name: 'Compare maintenance schedules', exact: true })
    await expect(compare).toBeVisible({ timeout: 90_000 })
    const run = new URL(page.url()).searchParams.get('world')
    expect(run).toBeTruthy()
    await compare.click()
    const planning = page.frameLocator('iframe[title="Planning"]')
    await expect(planning.getByRole('heading', { name: 'Nuclear maintenance planning', exact: true })).toBeVisible()
    await expect(page.locator('.workspace-name')).toHaveText(qaName)
    await expect(planning.getByRole('button', { name: /^Existing crews\b/ })).toBeVisible({ timeout: 30_000 })
    await play(planning, workspace.id, run!)
  } catch (error) {
    playFailed = true
    playFailure = error
  } finally {
    const finalizationErrors: Array<{ stage: string; error: unknown }> = []
    const finalize = async (stage: string, work: () => Promise<void>) => {
      try { await work() } catch (error) { finalizationErrors.push({ stage, error }) }
    }
    await finalize('capture evidence', () => captureRoomEvidence(page, workspace.id, playFailed))
    await finalize('leave Workspace', async () => { if (!page.isClosed()) await page.goto('about:blank') })
    await finalize('delete owned Workspace', async () => {
      const deleted = await page.request.delete(`/api/workspaces/${encodeURIComponent(workspace.id)}`)
      const text = await deleted.text()
      await saveEvidence('workspace-cleanup', { workspace: workspace.id, status: deleted.status(), body: text })
      const body = text === '' ? null : JSON.parse(text)
      const alreadyGone = deleted.status() === 404 && body?.error?.code === 'workspace_not_found'
      expect(deleted.ok() || alreadyGone).toBe(true)
    })
    if (finalizationErrors.length > 0) {
      const details = finalizationErrors.map(({ stage, error }) => ({ stage, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }))
      test.info().annotations.push({ type: 'finalization errors', description: JSON.stringify(details) })
      await saveEvidence('finalization-errors', details).catch(error => console.error('Could not retain finalization errors', error))
      if (!playFailed) throw new AggregateError(finalizationErrors.map(entry => entry.error), 'Nuclear demo evidence capture or cleanup failed')
    }
  }
  if (playFailed) throw playFailure
}

const schedules = async (planning: FrameLocator) => {
  await expect(planning.getByLabel('Ask about the deadline', { exact: true })).toHaveValue(/21:00/)
  await expect(planning.getByRole('button', { name: /Generate/ })).toHaveCount(0)
  const one = planning.getByRole('button', { name: /^Existing crews\b/ })
  const extra = planning.getByRole('button', { name: /^With HX contractor\b/ })
  await expect(one).toHaveAttribute('aria-pressed', 'true')
  const schedule = planning.getByRole('region', { name: 'Maintenance schedule', exact: true })
  await expect(schedule).toBeVisible()
  const jobs = schedule.getByRole('rowheader')
  await expect(schedule.getByRole('table')).toHaveAccessibleName('Existing crews maintenance schedule')
  await expect(jobs).toHaveCount(16)
  await expect(jobs.filter({ hasText: completionTitle })).toContainText('12:00')
  await extra.click()
  await expect(extra).toHaveAttribute('aria-pressed', 'true')
  await expect(schedule.getByRole('table')).toHaveAccessibleName('With HX contractor maintenance schedule')
  await expect(jobs.filter({ hasText: completionTitle })).toContainText('20:00')
  await expect(jobs.filter({ hasText: completionTitle })).not.toContainText('12:00')
  await expect(planning.getByText(/24[,.\s]000/).first()).toBeVisible()
  await one.click()
  await expect(jobs.filter({ hasText: completionTitle })).toContainText('12:00')
}

test('nuclear planning coordinates real crews, task handoffs and an unsaved estimate preview', async ({ page }) => {
  await withNuclearPlanning(page, async (planning, workspace) => {
    await schedules(planning)
    await planning.getByRole('button', { name: /^With HX contractor\b/ }).click()
    const table = planning.getByRole('table', { name: 'With HX contractor maintenance schedule', exact: true })
    await table.getByRole('button', { name: 'Clean HX A tubes', exact: true }).click()
    const details = planning.getByRole('region', { name: 'Task details', exact: true })
    await expect(details.getByRole('heading', { name: 'Clean HX A tubes', exact: true })).toBeVisible()
    await expect(details.getByText('Why it starts then', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(details).toContainText('Qualified HX contractor')
    await expect(details.getByRole('button', { name: 'Open HX A channel heads', exact: true })).toBeVisible()
    await expect(details.getByRole('button', { name: 'HX A specialist inspection and QA acceptance', exact: true })).toBeVisible()
    await planning.getByRole('button', { name: 'What sets the finish', exact: true }).click()
    const chain = planning.getByRole('region', { name: 'Returned finish chain', exact: true })
    await expect.poll(() => chain.getByRole('listitem').count()).toBeGreaterThan(7)
    await expect(planning.getByRole('status', { name: 'Finish explanation', exact: true })).toBeVisible()

    await planning.getByRole('button', { name: 'Crews and tools', exact: true }).click()
    const crewTable = planning.getByRole('table', { name: 'Crew and tool schedule', exact: true })
    await expect(crewTable).toContainText('Station mechanical crew')
    await expect(crewTable).toContainText('Qualified HX contractor')
    await saveEvidenceImage('crew-assignments', path => crewTable.screenshot({ path }))
    await planning.getByRole('button', { name: 'Tasks', exact: true }).click()
    await details.getByLabel('Duration (h)', { exact: true }).fill('3')
    const [previewResponse] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/workspaces/${workspace}/capabilities/planning.plan.edit/invoke`),
      details.getByRole('button', { name: 'Preview impact', exact: true }).click(),
    ])
    expect(previewResponse.ok()).toBe(true)
    const preview = (await previewResponse.json()).result
    await saveEvidence('estimate-preview', preview)
    expect(preview.preview.saved).toBe(false)
    expect(preview.preview.violations.join(' ')).toMatch(/15:00|1 h|deadline/)
    const previewView = details.getByRole('region', { name: 'Estimate preview', exact: true })
    await expect(previewView).toContainText('16:00')
    await expect(table.getByRole('rowheader').filter({ hasText: completionTitle })).toContainText('20:00')
    await saveEvidenceImage('estimate-preview', path => planning.locator('body').screenshot({ path }))
    await previewView.getByRole('button', { name: 'Discard preview', exact: true }).click()
    await expect(details.getByLabel('Duration (h)', { exact: true })).toHaveValue('2')

    for (const asset of [
      { key: 'hxa', task: 'Clean HX A tubes', label: 'Component Cooling Heat Exchanger A', element: 'componentCoolingHeatExchangerA', view: 'Tasks', flow: 350 },
      { key: 'ccwa', task: 'Service the CCW A pump seal', label: 'Component Cooling Water Pump A', element: 'componentCoolingWaterPumpA', view: 'Crews and tools', flow: 350 },
      { key: 'swa', task: 'Service the SW A discharge strainer', label: 'Service Water Pump A', element: 'serviceWaterPumpA', view: 'Tasks', flow: 450 },
    ]) {
      const current = page.frameLocator('iframe[title="Planning"]')
      await current.getByRole('button', { name: 'Tasks', exact: true }).click()
      await current.getByRole('table', { name: 'With HX contractor maintenance schedule', exact: true }).getByRole('button', { name: asset.task, exact: true }).click()
      const inspector = current.getByRole('region', { name: 'Task details', exact: true })
      await expect(inspector.getByRole('heading', { name: asset.task, exact: true })).toBeVisible()
      await current.getByRole('button', { name: asset.view, exact: true }).click()
      const subject = `plant:maintenance#${asset.element}`
      const [displayResponse] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname.endsWith('/displays/default')
          && response.request().postDataJSON()?.subject === subject, { timeout: 30_000 }),
        inspector.getByRole('link', { name: `Inspect ${asset.label} in World`, exact: true }).click(),
      ])
      expect(displayResponse.ok()).toBe(true)
      const display = (await displayResponse.json()).result.view
      const state = JSON.parse(display.state)
      await saveEvidence(`world-${asset.key}-display`, { request: displayResponse.request().postDataJSON(), display, state })
      const title = `Fictional reference PWR · ${asset.label}`
      expect(display.title).toBe(title)
      expect(state.title).toBe(title)
      expect(state.views).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'values', lead: { objectId: 'plant:maintenance', element: asset.element } }),
        expect.objectContaining({ kind: 'topology', objectId: 'plant:maintenance', request: expect.objectContaining({ around: [asset.element] }) }),
      ]))
      const world = page.frameLocator('iframe[title="World simulations"]')
      await expect(world.locator('.display-window-title strong')).toHaveText(title, { timeout: 30_000 })
      const ownerView = world.frameLocator(`iframe[title^="${title}"]`)
      await expect(ownerView.getByRole('article', { name: title, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(ownerView.getByRole('group', { name: 'Flow topology', exact: true })).toBeVisible({ timeout: 30_000 })
      // The owner shell can mount before its first sample. A known reading
      // qualifies the capture even when the user has paused the Run.
      const readings = ownerView.locator('obc-readout-list-item')
      await expect.poll(() => readings.evaluateAll((items, flow) => items.some(item => {
        const reading = item as HTMLElement & { value: unknown; unit: unknown }
        return reading.value === flow && reading.unit === 'kg/s'
      }), asset.flow), { timeout: 30_000 }).toBe(true)
      await saveEvidence(`world-${asset.key}-readings`, await readings.evaluateAll(items => items.map(item => {
        const reading = item as HTMLElement & { value: unknown; unit: unknown }
        return { label: item.closest('.row')?.querySelector('.full')?.textContent, value: reading.value, unit: reading.unit }
      })))
      await saveEvidenceImage(`world-${asset.key}-detail`, path => page.screenshot({ path }))
      await world.getByRole('link', { name: 'Back to planning demo', exact: true }).click()
      const returned = page.frameLocator('iframe[title="Planning"]')
      await expect(returned.getByRole('button', { name: /^With HX contractor\b/ })).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
      await expect(returned.getByRole('region', { name: 'Task details', exact: true }).getByRole('heading', { name: asset.task, exact: true })).toBeVisible()
      await expect(returned.getByRole('button', { name: asset.view, exact: true })).toHaveAttribute('aria-pressed', 'true')
    }
    await page.reload()
    const reopened = page.frameLocator('iframe[title="Planning"]')
    await expect(reopened.getByRole('region', { name: 'Maintenance schedule', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(reopened.getByRole('button', { name: /Generate/ })).toHaveCount(0)
    await reopened.getByRole('button', { name: /^With HX contractor\b/ }).click()
    await expect(reopened.getByRole('rowheader').filter({ hasText: completionTitle })).toContainText('20:00')

    const recheckCalls: string[] = []
    const rememberRecheck = (request: { method: () => string; url: () => string }) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && /\/capabilities\/planning\.(sources\.refresh|plan\.generate)\/invoke$/.test(path)) recheckCalls.push(path)
    }
    page.on('request', rememberRecheck)
    const [refreshed, regenerated] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/capabilities/planning.sources.refresh/invoke')),
      page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/capabilities/planning.plan.generate/invoke')),
      reopened.getByRole('button', { name: 'Recalculate comparison', exact: true }).click(),
    ])
    page.off('request', rememberRecheck)
    expect(refreshed.ok()).toBe(true)
    expect(regenerated.ok()).toBe(true)
    expect(recheckCalls.map(path => path.split('/capabilities/')[1])).toEqual(['planning.sources.refresh/invoke', 'planning.plan.generate/invoke'])
    expect(regenerated.request().postDataJSON().expectedRevision).toBe((await refreshed.json()).result.plan.revision)
    await expect(reopened.getByRole('region', { name: 'Maintenance schedule', exact: true })).toBeVisible()
  })
})

test('one schedule viewer changes from a Wednesday 20:00 success to the actual 19:00 refusal', async ({ page }) => {
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
      ['20:00', '2026-11-18T19:00:00Z', 'validated feasible'],
      ['19:00', '2026-11-18T18:00:00Z', 'proven infeasible'],
    ]) {
      const due = { kind: 'due', key: `requested-${time!.replace(':', '-')}`, job: 'restore', finishBy, words: `Requested finish by ${time}`, source: { by: 'assumption', note: 'Browser acceptance deadline question.' } }
      const generated = await invoke('planning.plan.generate', {
        seconds: 5, keep: true, variants: [{ label: `HX contractor by ${time}`, buy: ['extra-maintenance-crew'], also: [due] }],
      }, revision)
      const option = generated.options.find((candidate: { label: string }) => candidate.label === `HX contractor by ${time}`)
      expect(option.status.word).toBe(status)
      const published = await invoke('planning.plan.display', { option: option.key })
      expect(published.schedule.option.fresh).toBe(true)
      const envelope = { moduleId: 'planning', subject: resource, ...published.view }
      // The second navigation changes only the fragment, as the shared display
      // window does when another retained option is opened in the same frame.
      await page.goto(`/workspaces/${workspace}/planning/embed/planning.schedule#view=${encodeURIComponent(JSON.stringify(envelope))}`)
      await expect(page.locator('header .requested')).toContainText(time!, { timeout: 30_000 })
      await expect(page.getByRole('region', { name: 'Checked schedule', exact: true })).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(16)
      await expect(page.getByRole('rowheader').filter({ hasText: completionTitle })).toContainText('20:00')
      if (time === '20:00') {
        await expect(page.getByText('Meets the requested deadline.', { exact: false })).toBeVisible()
        expect(published.schedule.option.cost).toBe(24_000)
      } else {
        await expect(page.getByText('The requested deadline is proven infeasible for this option.', { exact: true })).toBeVisible()
        await expect(page.getByText('Red outlines mark tasks named by the infeasibility proof.', { exact: true })).toBeVisible()
        await expect(page.locator('header .requested')).not.toContainText('20:00')
        expect(published.schedule.certificate).toMatchObject({ kind: 'chain', workHours: 13, availableHours: 12 })
      }
    }
  })
})

test('the scoped engineering agent produces an inspectable calculation beside the plan', async ({ page }) => {
  test.skip(process.env.LEITBILD_E2E_ENGINEERING_AGENT !== '1', 'Enable LEITBILD_E2E_ENGINEERING_AGENT=1 with the actual configured provider for agent acceptance.')
  test.setTimeout(300_000)
  await withNuclearPlanning(page, async (planning, workspace, run) => {
    await expect(planning.getByRole('heading', { name: 'Estimate heat transport', exact: true })).toBeVisible()
    await planning.getByRole('button', { name: /^With HX contractor\b/ }).click()
    await planning.getByRole('button', { name: 'Ask Assistant to calculate', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('agents')).toBeTruthy()
    const room = new URL(page.url()).searchParams.get('agents')!
    expect(new URL(page.url()).searchParams.get('run')).toBe(run)
    await expect(planning.getByRole('heading', { name: 'Nuclear maintenance planning', exact: true })).toBeVisible()
    await expect(planning.getByRole('button', { name: /^With HX contractor\b/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(planning.getByRole('rowheader').filter({ hasText: completionTitle })).toContainText('20:00')
    const agents = page.frameLocator('iframe[title="Agents room"]')
    const show = agents.getByRole('button', { name: /^Show the engineering calculation in this answer:/ }).first()
    await expect(show).toBeVisible({ timeout: 240_000 })
    await show.click()
    const result = agents.frameLocator('iframe[src*="/agents/embed/engineering.result"]')
    await expect(result.getByRole('heading', { name: 'Inputs used', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(result.getByRole('heading', { name: 'Try changed assumptions', exact: true })).toBeVisible()
    await saveEvidenceImage('engineering-original', path => result.locator('body').screenshot({ path }))
    const disclosure = result.getByText('Full calculation receipt and execution limits', { exact: true }).locator('..')
    await disclosure.locator('summary').click()
    const receipt = JSON.parse(await disclosure.locator('pre').innerText())
    await saveEvidence('engineering-original', receipt)
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
    expect(receipt.outcome.output.heatTransportMw).toBeCloseTo(14.63, 6)

    // Confirm this is the retained actual tool attempt, not just text in an answer.
    const frame = agents.locator('iframe[src*="/agents/embed/engineering.result"]')
    const fragment = new URLSearchParams(new URL((await frame.getAttribute('src'))!, page.url()).hash.slice(1))
    const locator = JSON.parse(JSON.parse(fragment.get('view')!).state)
    const attempt = await page.request.get(`/api/workspaces/${workspace}/agents/rooms/${room}/executions/${locator.turnId}/calls/${locator.toolCallId}`)
    expect(attempt.ok()).toBe(true)
    const actualAttempt = await attempt.json()
    await saveEvidence('engineering-tool-attempt', actualAttempt)
    expect(actualAttempt).toMatchObject({ tool: 'engineering_run' })

    const rise = receipt.request.input.bindings.find((binding: { kind: string; value: number }) => binding.kind === 'assumption' && binding.value === 10)
    expect(rise).toBeTruthy()
    await result.getByLabel(`${rise.name} (${rise.unit})`, { exact: false }).fill('5')
    const [rerun] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/workspaces/${workspace}/agents/rooms/${room}/engineering`),
      result.getByRole('button', { name: 'Rerun these inputs', exact: true }).click(),
    ])
    expect(rerun.ok()).toBe(true)
    const changedAttempt = await rerun.json()
    await saveEvidence('engineering-rerun', changedAttempt)
    const changed = changedAttempt.receipt
    expect(changed).toMatchObject({ mode: 'exploratory-script', outcome: { status: 'completed' } })
    expect(changed.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'observation', value: 350 }),
      expect.objectContaining({ name: rise.name, origin: 'assumption', value: 5 }),
    ]))
    expect(changed.inputDigest).not.toBe(receipt.inputDigest)
    expect(changed.sources).toEqual(receipt.sources)
    expect(changed.outcome.output.heatTransportMw).toBeCloseTo(7.315, 6)
    await expect(result.getByRole('button', { name: 'Return to original result', exact: true })).toBeVisible()
    await saveEvidenceImage('engineering-rerun', path => result.locator('body').screenshot({ path }))

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
  test.setTimeout(900_000)
  await withNuclearPlanning(page, async (planning, workspace) => {
    await planning.getByLabel('Ask about the deadline', { exact: true }).fill('Can we complete maintenance by 20:00 on Wednesday 18 November? Show me how, or explain why not.')
    await planning.getByRole('button', { name: 'Ask Assistant', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('agents')).toBeTruthy()
    const agents = page.frameLocator('iframe[title="Agents room"]')
    const displays = agents.getByRole('button', { name: /^(Show|Hide) the planning schedule in this answer:/ })

    const checkedDisplay = async (after: number, deadline: string, status: string, expectedCost?: number) => {
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
        expect(state).toHaveProperty('reference')
        expect(envelope).toMatchObject({ moduleId: 'planning', viewType: 'planning.schedule', subject: { workspaceId: workspace, type: 'planning.plan', id: state.plan } })
        const read = await page.request.post(`/api/workspaces/${workspace}/capabilities/planning.plan.display/invoke`, {
          data: {
            resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: state.plan },
            input: { option: state.option, digest: state.digest, reference: state.reference }, actor: { kind: 'human' },
          },
        })
        expect(read.ok()).toBe(true)
        const publication = (await read.json()).result
        await saveEvidence(`planning-publication-${after}-${index}`, { envelope, publication })
        const schedule = publication.schedule
        expect(state.reference).toBe(schedule.reference?.key ?? null)
        if (schedule.deadline === null || Date.parse(schedule.deadline.finishBy) !== Date.parse(deadline)
          || schedule.option.status.word !== status
          || expectedCost !== undefined && schedule.option.cost !== expectedCost) continue
        expect(schedule.option.fresh).toBe(true)
        expect(schedule.deadline.job).toBe('restore')
        const result = frame.contentFrame()
        await expect(result.getByRole('region', { name: 'Checked schedule', exact: true })).toBeVisible({ timeout: 30_000 })
        await expect(result.getByRole('table', { name: 'Checked work schedule', exact: true }).getByRole('rowheader')).toHaveCount(16)
        return { result, schedule, state, plan: state.plan }
      }
      throw new Error(`The Assistant did not publish a ${status} Planning schedule for ${deadline}.`)
    }

    const fits = await checkedDisplay(0, '2026-11-18T19:00:00Z', 'validated feasible', 24_000)
    expect(Date.parse(fits.schedule.option.finish)).toBe(Date.parse('2026-11-18T19:00:00Z'))
    expect(fits.schedule.option.cost).toBe(24_000)
    await expect(fits.result.locator('header .requested')).toContainText('20:00')
    await expect(fits.result.getByText('Meets the requested deadline.', { exact: false })).toBeVisible()
    await expect(fits.result.getByRole('rowheader').filter({ hasText: completionTitle })).toContainText('20:00')
    await saveEvidenceImage('deadline-wednesday-20', path => fits.result.locator('body').screenshot({ path }))

    const previousDisplays = await displays.count()
    const followup = agents.getByPlaceholder('Type a message... (Shift+Enter for newline)', { exact: true })
    await expect(followup).toBeEnabled()
    await followup.fill('What about 19:00 on Wednesday? Show why it can or cannot finish by then.')
    await agents.getByRole('button', { name: 'Send', exact: true }).click()
    const refuses = await checkedDisplay(previousDisplays, '2026-11-18T18:00:00Z', 'proven infeasible')
    expect(refuses.plan).toBe(fits.plan)
    expect(refuses.schedule.certificate).toMatchObject({ kind: 'chain', workHours: 13, availableHours: 12 })
    expect(refuses.schedule.certificate.jobs).toEqual(expect.arrayContaining(['isolate', 'hx-work', 'hx-nde', 'sw-restore', 'restore']))
    expect(refuses.schedule.reference.fresh).toBe(true)
    expect(Date.parse(refuses.schedule.reference.finish)).toBe(Date.parse('2026-11-18T19:00:00Z'))
    await expect(refuses.result.locator('header .requested')).toContainText('19:00')
    await expect(refuses.result.getByText('The requested deadline is proven infeasible for this option.', { exact: true })).toBeVisible()
    await expect(refuses.result.getByText('Red outlines mark tasks named by the infeasibility proof.', { exact: true })).toBeVisible()
    await expect(refuses.result.getByRole('rowheader').filter({ hasText: completionTitle })).toContainText('20:00')
    await saveEvidenceImage('deadline-wednesday-19', path => refuses.result.locator('body').screenshot({ path }))

    const displaysBeforeLaterDeadline = await displays.count()
    await followup.fill('Can we complete by 12:00 on Thursday 19 November using the existing crews, with no contractor or extra crew booking?')
    await agents.getByRole('button', { name: 'Send', exact: true }).click()
    const existingCrew = await checkedDisplay(displaysBeforeLaterDeadline, '2026-11-19T11:00:00Z', 'validated feasible', 0)
    expect(existingCrew.plan).toBe(fits.plan)
    expect(Date.parse(existingCrew.schedule.option.finish)).toBe(Date.parse('2026-11-19T11:00:00Z'))
    expect(existingCrew.schedule.option.cost).toBe(0)
    await expect(existingCrew.result.locator('header .requested')).toContainText('12:00')
    await expect(existingCrew.result.getByText('Meets the requested deadline.', { exact: false })).toBeVisible()
    await expect(existingCrew.result.getByRole('rowheader').filter({ hasText: completionTitle })).toContainText('12:00')
    await saveEvidenceImage('deadline-thursday-noon-existing-crews', path => existingCrew.result.locator('body').screenshot({ path }))

    // Later current-state reads and new options must not replace the evidence
    // behind the earlier success/refusal while those options remain retained.
    for (const [label, earlier] of [['wednesday-20', fits], ['wednesday-19', refuses]] as const) {
      const response = await page.request.post(`/api/workspaces/${workspace}/capabilities/planning.plan.display/invoke`, {
        data: {
          resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: earlier.plan },
          input: { option: earlier.state.option, digest: earlier.state.digest, reference: earlier.state.reference },
          actor: { kind: 'human' },
        },
      })
      const retained = await response.json()
      await saveEvidence(`planning-retained-${label}`, { status: response.status(), publication: retained })
      expect(response.ok()).toBe(true)
      expect(retained.result.schedule.digest).toBe(earlier.state.digest)
      expect(retained.result.schedule.option.key).toBe(earlier.schedule.option.key)
      expect(retained.result.schedule.option.status.word).toBe(earlier.schedule.option.status.word)
      expect(retained.result.schedule.deadline).toEqual(earlier.schedule.deadline)
      expect(retained.result.schedule.reference?.key ?? null).toBe(earlier.schedule.reference?.key ?? null)
    }

    // A question must remain a what-if; the authored return target is unchanged.
    const authoredJobs: Array<{ job?: { key: string; target?: { finishBy: string } } }> = []
    let cursor: string | undefined
    do {
      const jobs = await page.request.post(`/api/workspaces/${workspace}/capabilities/planning.plan.read/invoke`, {
        data: {
          resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: fits.plan },
          input: { section: 'jobs', ...(cursor === undefined ? {} : { cursor }) }, actor: { kind: 'human' },
        },
      })
      expect(jobs.ok()).toBe(true)
      const section = (await jobs.json()).result.sections.find((entry: { id: string }) => entry.id === 'jobs')
      authoredJobs.push(...section.data.items)
      cursor = section.data.more
    } while (cursor !== undefined)
    const restoration = authoredJobs.find(entry => entry.job?.key === 'restore')!.job!
    expect(Date.parse(restoration.target!.finishBy)).toBe(Date.parse('2026-11-18T20:00:00Z'))
    await page.reload()
    await expect(page.frameLocator('iframe[title="Planning"]').getByRole('region', { name: 'Compare crew schedules', exact: true }).getByRole('button')).toHaveCount(2, { timeout: 30_000 })
  })
})
