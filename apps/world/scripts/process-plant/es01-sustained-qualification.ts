import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantRuntime, createProcessPlantProtectionRunner, type VariablePath } from '../../src/packs/process-plant/index.ts'
import { validateProcessPlantControlWrite } from '../../src/packs/process-plant/control-write-validation.ts'
import { processPlantAutomationDigest } from '../../src/packs/process-plant/evidence-frame.ts'
import { evaluateSafetyFunctions } from '../../src/packs/process-plant/safety-functions.ts'

/** Numerical counterfactuals, not an installed controller, Scenario, procedure
 * runner, historian or Agent qualification. Ordinary full-power model and
 * protection, validated operator writes only. Recipe and 20-minute experiment
 * duration are explicit experiment inputs, not plant ratings or generic limits.
 * Usage: bun scripts/process-plant/es01-sustained-qualification.ts --output-directory /absolute/path
 */
const argument = Bun.argv.indexOf('--output-directory')
assert(argument >= 0 && Bun.argv[argument + 1], 'Supply --output-directory')
const output = resolve(Bun.argv[argument + 1]!)
await mkdir(output, { recursive: true })
const git = async (args: string[]) => {
  const process = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const value = await new Response(process.stdout).text()
  assert.equal(await process.exited, 0, `git ${args.join(' ')}`)
  return value.trim()
}
const sourceCommit = await git(['rev-parse', 'HEAD']), dirty = (await git(['status', '--porcelain'])).length > 0
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:es01-sustained-numerical-qualification' }))
type Runtime = ReturnType<typeof createProcessPlantRuntime>
type Protection = ReturnType<typeof createProcessPlantProtectionRunner>
const loops = ['A', 'B', 'C', 'D'] as const
const paths = [
  'reactorTripBreakerA.closedState', 'reactorTripBreakerB.closedState', 'core.rodsOnBottom', 'core.powerRangePercent',
  'core.powerMw', 'core.coreExitTemperatureC', 'vessel.subcoolingMarginC', 'pressurizer.pressureMPa', 'pressurizer.levelPercent',
  'auxFeedwaterTank.levelPercent', 'auxFeedwaterHeader.outletFlowKgPerS', 'turbineStopValve.effectivePositionFraction',
  'turbineBypassValve.effectivePositionFraction', 'turbineBypassValve.outletFlowKgPerS', 'turbineBypassValve.controllerSetpoint', 'condenser.coolingWaterFlowKgPerS',
  'auxFeedwaterPumpMotor.runningState', 'auxFeedwaterPumpMotorB.runningState', 'auxFeedwaterPumpTurbine.runningState',
  'auxFeedwaterPumpTurbine.speedRpm', 'auxFeedwaterPumpTurbine.flowKgPerS',
  'auxFeedwaterTurbineSteamValveB.effectivePositionFraction', 'auxFeedwaterTurbineSteamValveC.effectivePositionFraction',
  'auxFeedwaterTurbineSteamValveB.outletFlowKgPerS', 'auxFeedwaterTurbineSteamValveC.outletFlowKgPerS',
  'vessel.collapsedLiquidLevelPercent', 'vessel.primaryInventoryBalanceResidualKg',
  ...loops.flatMap(loop => [`sg${loop}.pressureMPa`, `sg${loop}.levelPercent`, `sg${loop}.wideRangeLevelPercent`,
    `sg${loop}.secondaryInventoryKg`, `sg${loop}.feedwaterFlowKgPerS`, `sg${loop}.boilingRateKgPerS`,
    `sg${loop}.secondaryInventoryBalanceResidualKg`, `sg${loop}.metalEnergyBalanceResidualMw`,
    `auxFeedwaterValve${loop}.positionFraction`, `auxFeedwaterValve${loop}.effectivePositionFraction`,
    `aux-feedwater-valve-${loop.toLowerCase()}-to-sg-${loop.toLowerCase()}.flowKgPerS`,
    `steamGeneratorReliefValve${loop}.effectivePositionFraction`,
    `steam-generator-relief-valve-${loop.toLowerCase()}-to-atmosphere.flowKgPerS`]),
] as VariablePath[]
const read = (runtime: Runtime, path: string) => runtime.readVariable(path as VariablePath)
const number = (runtime: Runtime, path: string) => Number(read(runtime, path))
let phase: 'trip' | 'feed-recovery' | 'secondary-regulation' | 'condenser-loss' | 'atmospheric-recovery' = 'trip'
const operations: { variant: string; phase: string; elapsedMs: number; path: VariablePath; value: number | boolean }[] = []
const command = (variant: string, runtime: Runtime, protection: Protection, path: string, value: number | boolean) => {
  const accepted = validateProcessPlantControlWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, path, value } as never })
  if (!accepted.accepted) throw Error(`${path}: ${accepted.reason}`)
  runtime.writeCommand({ type: 'setVariable', path: accepted.targetPath, value })
  operations.push({ variant, phase, elapsedMs: runtime.elapsedMs(), path: accepted.targetPath, value })
}
const tick = (runtime: Runtime, protection: Protection) => {
  runtime.tick(1_000)
  protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run:es01-sustained-numerical-qualification' as never, sourceRuntimeId: 'process-plant.local' })
}
const sample = (runtime: Runtime) => ({ elapsedSeconds: runtime.elapsedMs() / 1_000, values: Object.fromEntries(paths.map(path => [path, read(runtime, path)])) })
// Emergency open-line delivery and later regulation have distinct objectives.
// Keep AFW protection armed and its existing throttle floor in force.
const regulateFeed = (variant: string, runtime: Runtime, protection: Protection) => {
  for (const loop of loops) {
    const level = number(runtime, `sg${loop}.levelPercent`), old = number(runtime, `auxFeedwaterValve${loop}.positionFraction`)
    const proposed = level >= 50 ? Math.max(.2, old - .1) : level <= 40 ? Math.min(1, old + .1) : old
    if (Math.abs(proposed - old) > 1e-9) command(variant, runtime, protection, `auxFeedwaterValve${loop}.positionFraction`, proposed)
  }
}
const checkAccounting = (runtime: Runtime) => {
  assert(Math.abs(number(runtime, 'vessel.primaryInventoryBalanceResidualKg')) < 1e-6, 'primary material balance residual')
  for (const loop of loops) {
    assert(Math.abs(number(runtime, `sg${loop}.secondaryInventoryBalanceResidualKg`)) < 1e-6, `SG ${loop} material balance residual`)
    assert(Math.abs(number(runtime, `sg${loop}.metalEnergyBalanceResidualMw`)) < 1e-6, `SG ${loop} finite-metal energy balance residual`)
  }
}
const results = []
for (const variant of ['unregulated-feed', 'regulated-feed', 'condenser-loss-unrecovered', 'condenser-loss-atmospheric-recovery'] as const) {
  const runtime = createProcessPlantRuntime({ system: plant }), protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const samples = [sample(runtime)]
  phase = 'trip'
  let lowerRangeTransientSeen = false, steamRegulationStartedAtSeconds: number | null = null
  const receiverHistory: { elapsedMs: number; masses: number[] }[] = []
  const phaseTransitions: { phase: string; elapsedSeconds: number; values: ReturnType<typeof sample>['values'] }[] = []
  let maximumNr = -Infinity, minimumNr = Infinity, maximumPressure = -Infinity, minimumTotalAfw = Infinity, minimumSubcooling = Infinity
  command(variant, runtime, protection, 'manualReactorTrip.pushbutton', true)
  for (let elapsed = 0; elapsed < 1_200; elapsed++) {
    if (elapsed === 16) {
      phase = 'feed-recovery'
      command(variant, runtime, protection, 'auxFeedwaterPumpMotor.running', true)
      command(variant, runtime, protection, 'auxFeedwaterPumpMotorB.running', true)
      command(variant, runtime, protection, 'auxFeedwaterTurbineSteamValveB.positionFraction', 1)
      command(variant, runtime, protection, 'auxFeedwaterTurbineSteamValveC.positionFraction', 1)
      command(variant, runtime, protection, 'auxFeedwaterPumpTurbine.running', true)
      for (const loop of loops) command(variant, runtime, protection, `auxFeedwaterValve${loop}.positionFraction`, 1)
      command(variant, runtime, protection, 'turbineBypassValve.controllerAutomatic', true)
      // Preserve the existing 7.6 MPa target during feed/receiver acquisition.
      // Elective early lowering is a different, adverse experiment.
      phaseTransitions.push({ phase, elapsedSeconds: runtime.elapsedMs() / 1_000, values: sample(runtime).values })
    }
    if (steamRegulationStartedAtSeconds !== null && elapsed % 30 === 0 && variant !== 'unregulated-feed') regulateFeed(variant, runtime, protection)
    if (elapsed === 600 && variant.startsWith('condenser-loss-')) {
      phase = 'condenser-loss'
      command(variant, runtime, protection, 'circulatingWaterPump.running', false)
      phaseTransitions.push({ phase, elapsedSeconds: runtime.elapsedMs() / 1_000, values: sample(runtime).values })
    }
    if (elapsed === 630 && variant === 'condenser-loss-atmospheric-recovery') {
      phase = 'atmospheric-recovery'
      phaseTransitions.push({ phase, elapsedSeconds: runtime.elapsedMs() / 1_000, values: sample(runtime).values })
      for (const loop of loops) {
        command(variant, runtime, protection, `steamGeneratorReliefValve${loop}.controllerAutomatic`, true)
        command(variant, runtime, protection, `steamGeneratorReliefValve${loop}.controllerSetpoint`, 7.4)
      }
    }
    tick(runtime, protection)
    checkAccounting(runtime)
    const levels = loops.map(loop => number(runtime, `sg${loop}.levelPercent`))
    const masses = loops.map(loop => number(runtime, `sg${loop}.secondaryInventoryKg`))
    receiverHistory.push({ elapsedMs: runtime.elapsedMs(), masses })
    const beforeFiveSeconds = receiverHistory.find(row => row.elapsedMs === runtime.elapsedMs() - 5_000)
    lowerRangeTransientSeen ||= levels.some(level => level <= 20)
    if (steamRegulationStartedAtSeconds === null && runtime.elapsedMs() > 16_000 && lowerRangeTransientSeen
      && levels.every(level => level > 20 && level < 82)
      && loops.every(loop => number(runtime, `aux-feedwater-valve-${loop.toLowerCase()}-to-sg-${loop.toLowerCase()}.flowKgPerS`) >= 1)
      && number(runtime, 'auxFeedwaterHeader.outletFlowKgPerS') >= 27.8
      && beforeFiveSeconds !== undefined && masses.every((mass, index) => mass > beforeFiveSeconds.masses[index]!)
      && evaluateSafetyFunctions(plant, runtime).every(assessment => assessment.status === 'green')) {
      phase = 'secondary-regulation'
      steamRegulationStartedAtSeconds = runtime.elapsedMs() / 1_000
      command(variant, runtime, protection, 'turbineBypassValve.controllerSetpoint', 7.4)
      phaseTransitions.push({ phase, elapsedSeconds: steamRegulationStartedAtSeconds, values: sample(runtime).values })
    }
    if (steamRegulationStartedAtSeconds !== null) {
      for (const loop of loops) {
        maximumNr = Math.max(maximumNr, number(runtime, `sg${loop}.levelPercent`))
        minimumNr = Math.min(minimumNr, number(runtime, `sg${loop}.levelPercent`))
        maximumPressure = Math.max(maximumPressure, number(runtime, `sg${loop}.pressureMPa`))
      }
      minimumTotalAfw = Math.min(minimumTotalAfw, number(runtime, 'auxFeedwaterHeader.outletFlowKgPerS'))
      minimumSubcooling = Math.min(minimumSubcooling, number(runtime, 'vessel.subcoolingMarginC'))
    }
    if (elapsed < 31 || (elapsed + 1) % 10 === 0) samples.push(sample(runtime))
  }
  assert(steamRegulationStartedAtSeconds !== null, 'actual feed and receiver reacquisition never admitted elective steam regulation')
  const final = sample(runtime)
  assert.equal(read(runtime, 'reactorTripBreakerA.closedState'), false)
  assert.equal(read(runtime, 'reactorTripBreakerB.closedState'), false)
  assert.equal(read(runtime, 'core.rodsOnBottom'), true)
  assert(minimumTotalAfw >= 27.8, `${variant} lost total emergency-feed criterion`)
  assert(minimumSubcooling >= 16.7, `${variant} lost modeled subcooling`)
  if (variant === 'unregulated-feed') assert(maximumNr >= 82, 'open-line baseline did not expose later overfill')
  else assert(minimumNr > 20 && maximumNr < 82, `${variant} left finite inventory envelope`)
  if (variant === 'regulated-feed' || variant === 'condenser-loss-atmospheric-recovery') for (const loop of loops) {
    assert(number(runtime, `sg${loop}.pressureMPa`) <= 7.55, `${variant} did not retain pressure response`)
    assert(number(runtime, `aux-feedwater-valve-${loop.toLowerCase()}-to-sg-${loop.toLowerCase()}.flowKgPerS`) >= 1, `SG ${loop} actual feed delivery`)
  }
  if (variant.startsWith('condenser-loss-')) assert(number(runtime, 'condenser.coolingWaterFlowKgPerS') < 7_000, 'condenser countercase still has healthy cooling water')
  if (variant === 'condenser-loss-unrecovered') assert(loops.some(loop => number(runtime, `sg${loop}.pressureMPa`) > 7.55), 'unrecovered release-loss case falsely meets pressure objective')
  if (variant === 'condenser-loss-atmospheric-recovery') for (const loop of loops) assert(number(runtime, `steam-generator-relief-valve-${loop.toLowerCase()}-to-atmosphere.flowKgPerS`) >= 1, `SG ${loop} actual atmospheric release`)
  const summary = { variant, steamRegulationStartedAtSeconds, phaseTransitions, maximumNr, minimumNr, maximumPressure, minimumTotalAfw, minimumSubcooling, final }
  results.push({ ...summary, samples })
  console.log(JSON.stringify(summary))
}
assert(Number(results[3]!.final.values['sgA.pressureMPa']) < Number(results[2]!.final.values['sgA.pressureMPa']), 'atmospheric recovery has no pressure improvement over the actual lost-condenser case')
const report = { sourceCommit, dirty, modelRef: plant.modelRef, modelDigest: plant.modelDigest, automationRef: plant.automationRef, automationDigest: processPlantAutomationDigest(plant.automation),
  experiment: { durationSeconds: 1_200, integratorTickSeconds: 1, reportSamplingSeconds: 10, monitoringChecksFrom: 'actual receiver reacquisition and subsequent elective steam-target operation', feedReviewCadenceSeconds: 30,
    preparation: 'Ordinary manual trip at 0 s; all three AFW starts, actual TD steam-valve alignment and full AFW valve demands at 16 s. Retain existing bypass AUTO 7.6 MPa until the low-NR transient has been observed, all NR >20%, actual delivery and positive five-second receiver mass change are reacquired with all six CSFs green; only then lower the elective steam target to 7.4 MPa. Ordinary protection remains active.',
    regulationRecipe: 'At 30 s review timestamps after entry reduce each AFW demand by 0.1 if its NR >=50; increase by 0.1 if <=40; retain between. Respect the existing 0.2 protection floor and 1 physical endpoint. No unchanged writes.',
    counterfactual: 'Condenser variants stop offered CW pump at 600 s; only recovery selects all ARV AUTO 7.4 MPa at 630 s.' },
  acceptedOperationCount: operations.length, results,
  scope: 'Numerical actual-response evidence for a bounded 20-minute exercise from ordinary full power; not World-native procedure, Agent, instrument qualification, reference hot standby, complete recovery or indefinite endurance.',
  limitations: ['Initial NR shrink below 20% precedes receiver reacquisition; this transient and its declined mass remain in raw samples. This numerical experiment is not qualification of every source/Agent waiting decision during preparation.', 'Floor-limited AFW can still exceed late evaporation. Finite monitoring does not establish indefinite inventory stability.', 'Historian completeness and exact source-pinned decisions require independent World-native qualification.', 'Recipe is experiment-owned actor policy, not installed I&C, runtime monitoring or a new generic limit. No graph, layout, solver, controller or persistent-state change.'],
}
await Bun.write(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
await Bun.write(join(output, 'accepted-operations.json'), `${JSON.stringify(operations, null, 2)}\n`)
