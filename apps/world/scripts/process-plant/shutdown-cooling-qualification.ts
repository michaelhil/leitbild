import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantRuntime, createProcessPlantProtectionRunner, type VariablePath } from '../../src/packs/process-plant/index.ts'
import { validateProcessPlantControlWrite } from '../../src/packs/process-plant/control-write-validation.ts'
import { rhrShutdownCoolingAdmission } from '../../src/packs/process-plant/specs/reference-ic-shutdown-cooling.ts'
import { saturationPressureMPaFromTemperatureC } from '../../src/packs/process-plant/runtime/water-properties.ts'
import { actuationResets } from '../../src/packs/process-plant/operations/actuation-reset.ts'
import { evaluateProcessPlantIcCondition } from '../../src/packs/process-plant/runtime/ic/control-protection-conditions.ts'

/** Standalone numerical qualification, not a Scenario, runtime controller,
 * operator procedure, continuous historian claim, or Agent execution proof.
 * Starts from the ordinary full-power model and applies only offered controls
 * with ordinary protection. This experimental operator policy stages a finite
 * secondary-to-RHR transition, then contrasts identical-state counterfactuals.
 * Inventory/feed/pressure targets below are preparation choices, not TS limits.
 * Usage: bun scripts/process-plant/shutdown-cooling-qualification.ts --output-directory /tmp/sdc-proof
 */
const outputArgument = Bun.argv.indexOf('--output-directory')
if (outputArgument < 0 || !Bun.argv[outputArgument + 1]) throw Error('Supply --output-directory for the numerical qualification report and accepted operation ledger')
const output = resolve(Bun.argv[outputArgument + 1]!)
await mkdir(output, { recursive: true })
const git = async (args: string[]) => {
  const result = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(result.stdout).text()
  if (await result.exited !== 0) throw Error(`Could not capture source provenance: git ${args.join(' ')}`)
  return text.trim()
}
const sourceCommit = await git(['rev-parse', 'HEAD']), dirty = (await git(['status', '--porcelain'])).length > 0
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:shutdown-cooling-numerical-qualification' }))
type Runtime = ReturnType<typeof createProcessPlantRuntime>
type Protection = ReturnType<typeof createProcessPlantProtectionRunner>
const read = (runtime: Runtime, path: string) => Number(runtime.readVariable(path as VariablePath))
const operations: unknown[] = []
let phase = 'preparation'
const command = (runtime: Runtime, protection: Protection, path: string, value: number | boolean) => {
  const accepted = validateProcessPlantControlWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, path, value } as never })
  if (!accepted.accepted) throw Error(`${path}: ${accepted.reason}`)
  runtime.writeCommand({ type: 'setVariable', path: accepted.targetPath, value })
  operations.push({ phase, elapsedMs: runtime.elapsedMs(), path: accepted.targetPath, value })
}
const tick = (runtime: Runtime, protection: Protection, milliseconds: number) => {
  runtime.tick(milliseconds)
  protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run:shutdown-cooling-numerical-qualification' as never, sourceRuntimeId: 'process-plant.local' })
}
const sample = (runtime: Runtime) => ({
  elapsedS: runtime.elapsedMs() / 1000,
  primaryPressureMPa: read(runtime, 'pressurizer.pressureMPa'), hotLegTemperatureC: read(runtime, 'core.coolantOutletTemperatureC'), coldLegTemperatureC: read(runtime, 'core.coolantInletTemperatureC'),
  coreExitTemperatureC: read(runtime, 'core.coreExitTemperatureC'),
  pressurizerLevelPercent: read(runtime, 'pressurizer.levelPercent'), subcoolingMarginC: read(runtime, 'vessel.subcoolingMarginC'), collapsedLiquidLevelPercent: read(runtime, 'vessel.collapsedLiquidLevelPercent'),
  primaryMassKg: read(runtime, 'vessel.primaryCoolantInventoryKg') + read(runtime, 'pressurizer.waterInventoryKg') + read(runtime, 'pressurizer.steamMassKg'),
  primaryMassBalanceResidualKg: read(runtime, 'vessel.primaryInventoryBalanceResidualKg'),
  sgPrimaryHeatMw: read(runtime, 'sgA.heatTransferMw'), sgSecondaryHeatMw: read(runtime, 'sgA.secondaryHeatTransferMw'), sgMetalEnergyRateMw: read(runtime, 'sgA.metalStoredEnergyRateMw'), sgMetalBalanceResidualMw: read(runtime, 'sgA.metalEnergyBalanceResidualMw'),
  sgNarrowRangeLevelPercent: ['A', 'B', 'C', 'D'].map(loop => read(runtime, `sg${loop}.levelPercent`)),
  rcsSourceFlowKgPerS: read(runtime, 'rcs-to-rhr-shutdown-suction-a.flowKgPerS'), rhrReturnFlowKgPerS: read(runtime, 'rhr-injection-valve-a-to-cold-leg-a.flowKgPerS'),
  rwstSourceFlowKgPerS: read(runtime, 'rwst-to-rhr-rwst-suction-valve-a.flowKgPerS'), sumpSourceFlowKgPerS: read(runtime, 'containment-sump-to-rhr-sump-suction-valve-a.flowKgPerS'),
  rhrHeatTransferMw: read(runtime, 'rhrHeatExchangerA.heatTransferMw'), terminalHeatTransferMw: read(runtime, 'componentCoolingHeatExchangerA.heatTransferMw'), ccwTemperatureC: read(runtime, 'componentCoolingTankA.temperatureC'),
  rhrHotInletTemperatureC: read(runtime, 'rhrHeatExchangerA.hotInletTemperatureC'), rhrHotOutletTemperatureC: read(runtime, 'rhrHeatExchangerA.hotOutletTemperatureC'),
  ccwHotInletTemperatureC: read(runtime, 'componentCoolingHeatExchangerA.hotInletTemperatureC'), ccwHotOutletTemperatureC: read(runtime, 'componentCoolingHeatExchangerA.hotOutletTemperatureC'),
  rhrColdSideFlowKgPerS: read(runtime, 'rhrHeatExchangerA.coldSideFlowKgPerS'), ccwHotSideFlowKgPerS: read(runtime, 'componentCoolingHeatExchangerA.hotSideFlowKgPerS'), ccwColdSideFlowKgPerS: read(runtime, 'componentCoolingHeatExchangerA.coldSideFlowKgPerS'),
  porvReleaseFlowKgPerS: read(runtime, 'pressurizer.reliefFlowKgPerS'), accumulatorFlowKgPerS: ['A', 'B', 'C', 'D'].reduce((sum, loop) => sum + read(runtime, `safetyAccumulator${loop}.outletFlowKgPerS`), 0),
})
const runtime = createProcessPlantRuntime({ system: plant }), protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
const preparationSamples = [sample(runtime)]
command(runtime, protection, 'reactorTripBreakerA.closed', false)
command(runtime, protection, 'turbineStopValve.positionFraction', 0)
command(runtime, protection, 'turbine.loadFraction', 0)
command(runtime, protection, 'letdownValve.positionFraction', 0)
command(runtime, protection, 'auxFeedwaterPumpMotor.running', true)
command(runtime, protection, 'auxFeedwaterPumpMotorB.running', true)
for (const loop of ['A', 'B', 'C', 'D']) {
  // Planned cooldown explicitly isolates the existing accumulators rather than
  // allowing their ordinary low-pressure injection to overfill the PZR.
  command(runtime, protection, `safetyAccumulator${loop}.dischargeIsolationOpen`, false)
  command(runtime, protection, `steamGeneratorReliefValve${loop}.controllerSetpoint`, 6.9)
  command(runtime, protection, `auxFeedwaterValve${loop}.positionFraction`, .2)
  command(runtime, protection, `rcp${loop}.running`, true)
}
let blocked = false, steamTemperatureTarget = 284.85801502122365, admitted = false
let preparationPorvReleaseKg = 0, preparationAccumulatorInjectionKg = 0
// The 6 h window is a reproducible experiment budget, not a runtime or model
// limit. The report fails if this preparation policy cannot reach admission.
for (let elapsed = 0; elapsed < 6 * 3600; elapsed++) {
  tick(runtime, protection, 1000)
  preparationPorvReleaseKg += read(runtime, 'pressurizer.reliefFlowKgPerS')
  preparationAccumulatorInjectionKg += ['A', 'B', 'C', 'D'].reduce((sum, loop) => sum + read(runtime, `safetyAccumulator${loop}.outletFlowKgPerS`), 0)
  if (!blocked && runtime.readVariable('safetyInjectionBlockLogic.belowP11' as VariablePath) === true) {
    command(runtime, protection, 'safetyInjectionBlockLogic.blockPushbutton', true); blocked = true
  }
  if (elapsed % 10 === 0) {
    const resetContext = { elapsedMs: runtime.elapsedMs(), holds: (condition: Parameters<typeof evaluateProcessPlantIcCondition>[0]['condition']) => evaluateProcessPlantIcCondition({ system: plant, runtime, condition }).matches }
    for (const reset of actuationResets(plant, protection.snapshot(), resetContext).filter(reset => reset.offered && reset.action === 'AFW START')) {
      protection.resetActuation({ ruleId: reset.ruleId, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run:shutdown-cooling-numerical-qualification' as never, sourceRuntimeId: 'process-plant.local' })
      operations.push({ phase, elapsedMs: runtime.elapsedMs(), resetRuleId: reset.ruleId })
    }
    const held = actuationResets(plant, protection.snapshot(), resetContext).some(reset => reset.action === 'AFW START')
    for (const loop of ['A', 'B', 'C', 'D']) command(runtime, protection, `auxFeedwaterValve${loop}.positionFraction`, Math.max(held ? .2 : 0, Math.min(1, read(runtime, `auxFeedwaterValve${loop}.positionFraction`) + .002 * (55 - read(runtime, `sg${loop}.levelPercent`)))))
    if (!held) command(runtime, protection, 'auxFeedwaterPumpTurbine.running', false)
    command(runtime, protection, 'pressurizer.heaterPowerMw', 0)
    command(runtime, protection, 'pressurizer.backupHeatersOn', false)
    if (read(runtime, 'pressurizer.levelPercent') > 20 && read(runtime, 'vessel.collapsedLiquidLevelPercent') > 99) steamTemperatureTarget = Math.max(140, steamTemperatureTarget - .1)
    for (const loop of ['A', 'B', 'C', 'D']) command(runtime, protection, `steamGeneratorReliefValve${loop}.controllerSetpoint`, saturationPressureMPaFromTemperatureC(steamTemperatureTarget))
    const pressureTarget = Math.max(1.5, saturationPressureMPaFromTemperatureC(read(runtime, 'core.coolantOutletTemperatureC') + 35))
    command(runtime, protection, 'pressurizer.sprayFlowKgPerS', read(runtime, 'pressurizer.pressureMPa') > pressureTarget + .1 ? 40 : 0)
    command(runtime, protection, 'pressurizer.reliefValvePositionFraction', 0)
  }
  if (elapsed % 60 === 0) {
    preparationSamples.push(sample(runtime))
    if (elapsed % 600 === 0) console.log(JSON.stringify(preparationSamples.at(-1)))
  }
  admitted = read(runtime, 'pressurizer.pressureMPa') <= rhrShutdownCoolingAdmission.maximumPressureMPa
    && read(runtime, 'core.coolantOutletTemperatureC') <= rhrShutdownCoolingAdmission.maximumHotLegTemperatureC
    && read(runtime, 'pressurizer.levelPercent') > 15 && read(runtime, 'pressurizer.levelPercent') < 85
    && read(runtime, 'vessel.subcoolingMarginC') > 10 && read(runtime, 'vessel.collapsedLiquidLevelPercent') > 99
  if (admitted) break
}
if (!admitted) throw Error('Experiment preparation did not reach its bounded RHR admission state; no successful transition is claimed')
const admission = sample(runtime), checkpoint = runtime.checkpoint(), protectionSnapshot = protection.snapshot()
await Bun.write(resolve(output, 'admission-checkpoint.json'), `${JSON.stringify({ sourceCommit, dirty, modelDigest: plant.modelDigest, checkpoint, protection: protectionSnapshot, admission }, null, 2)}\n`)
const results = []
for (const variant of ['normal', 'no-rhr', 'no-service-water'] as const) {
  phase = variant
  const state = createProcessPlantRuntime({ system: plant, restoredCheckpoint: checkpoint }), runner = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation, restoredSnapshot: protectionSnapshot })
  const advance = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) tick(state, runner, 100) }
  for (const train of ['A', 'B']) for (const valve of ['rhrRwstSuctionValve', 'rhrSumpSuctionValve', 'siPiggybackValve']) command(state, runner, `${valve}${train}.positionFraction`, 0)
  advance(9)
  for (const train of ['A', 'B']) for (const barrier of [1, 2]) command(state, runner, `rhrShutdownSuctionValve${train}${barrier}.positionFraction`, 1)
  advance(9)
  command(state, runner, 'rhrInjectionValveA.positionFraction', 1)
  if (variant !== 'no-rhr') command(state, runner, 'rhrPumpA.running', true)
  if (variant === 'no-service-water') command(state, runner, 'serviceWaterPumpA.running', false)
  const samples = [sample(state)]
  for (let i = 0; i < 18; i++) { advance(10); samples.push(sample(state)) }
  results.push({ variant, samples })
}
const normal = results[0]!, noRhr = results[1]!, failed = results[2]!, first = normal.samples[0]!, last = normal.samples.at(-1)!, failedLast = failed.samples.at(-1)!
const requireFact = (fact: boolean, message: string) => { if (!fact) throw Error(`Numerical qualification failed: ${message}`) }
requireFact(last.hotLegTemperatureC < first.hotLegTemperatureC, 'ordinary admitted RCS does not cool with RHR')
requireFact(last.coreExitTemperatureC < first.coreExitTemperatureC, 'published core-exit indication does not cool with RHR')
requireFact(last.hotLegTemperatureC < noRhr.samples.at(-1)!.hotLegTemperatureC, 'RHR has no causal improvement over identical-state no-RHR counterfactual')
for (const row of normal.samples.slice(1)) {
  requireFact(row.rcsSourceFlowKgPerS > 0 && Math.abs(row.rcsSourceFlowKgPerS - row.rhrReturnFlowKgPerS) < 1e-6, 'actual closed source and returned mass are unequal')
  requireFact(row.rwstSourceFlowKgPerS === 0 && row.sumpSourceFlowKgPerS === 0, 'external source is not isolated')
  requireFact(row.pressurizerLevelPercent > 0 && row.pressurizerLevelPercent < 100 && row.subcoolingMarginC > 0, 'bounded response loses represented liquid/subcooling')
  requireFact(Math.abs(row.primaryMassBalanceResidualKg) < 1e-6 && Math.abs(row.sgMetalBalanceResidualMw) < 1e-6, 'mass or finite metal balance does not close')
  requireFact(row.rhrColdSideFlowKgPerS > 0 && row.ccwHotSideFlowKgPerS > 0 && row.ccwColdSideFlowKgPerS > 0 && row.rhrHotInletTemperatureC > row.rhrHotOutletTemperatureC && row.ccwHotInletTemperatureC > row.ccwHotOutletTemperatureC, 'published heat-exchanger flow/temperature chain is not achieved')
}
requireFact(failedLast.rcsSourceFlowKgPerS > 0 && failedLast.rhrHeatTransferMw > 0, 'failed terminal case does not exercise finite upstream cooling storage')
requireFact(Math.abs(failedLast.terminalHeatTransferMw) < 1e-6 && failedLast.ccwTemperatureC > failed.samples[0]!.ccwTemperatureC, 'lost service water is not visible as terminal heat loss and warming CCW')
const report = { sourceCommit, dirty, modelRef: plant.modelRef, modelDigest: plant.modelDigest, initial: preparationSamples[0], admission, preparationPorvReleaseKg, preparationAccumulatorInjectionKg,
  admissionEngineeringEnvelope: rhrShutdownCoolingAdmission, preparationSamples, results, acceptedOperationCount: operations.length,
  scope: 'Ordinary full-power initial state, actual controls and protection; finite secondary-to-RHR transition and 180 s controlled comparison. Numerical evidence only, not native World procedure/Agent execution qualification.',
  exclusions: ['No claim of cold shutdown, reference procedure completion, CSF green/full core coverage, indefinite endurance, reverse-core natural circulation, NPSH/backflow/cross-pressurization, qualified safety-channel power or full two-phase energy EOS.', 'Collapsed level below 100% is reported rather than relabeled as full coverage. Fixed design-feed-to-steam boiling enthalpy remains a reduced off-design approximation.', 'Preparation feedback targets and six-hour experiment budget are experiment inputs, not new plant limits, hidden Scenario automation or an operator procedure.'],
}
await Bun.write(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
await Bun.write(resolve(output, 'accepted-operations.json'), `${JSON.stringify(operations, null, 2)}\n`)
console.log(JSON.stringify({ sourceCommit, dirty, modelDigest: plant.modelDigest, admission, normalFinal: last, noRhrFinal: noRhr.samples.at(-1), failedTerminalFinal: failedLast, acceptedOperationCount: operations.length }))
