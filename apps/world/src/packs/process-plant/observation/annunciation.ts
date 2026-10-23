import type { Annunciation } from '../../../core/observation/annunciation.ts'
import { energyEnds, type CompiledPlantGraph, type ProcessSignalBinding } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { processPlantIcLifecycleIdFor, type ProcessPlantIcCondition, type ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { processPlantIcLifecycleCommandKind } from '../command-kinds.ts'
import { automaticActions } from '../ic/actuations.ts'
import { ruleLimits } from '../ic/alarm-philosophy.ts'
import { icRuleKind, icThresholdsForSignal, UNDECLARED_ACTION } from '../ic/thresholds.ts'

// How the Plant's alarms and trips are annunciated to World (plan v5 W2.3–W2.6,
// D-E: static, kept by the declaration's revision), from what its I&C
// declares, never from a rule's id or title (OLD displays/annunciators.ts):
// - each first-out group by its short label ("RX TRIP"), with the energy ends
//   its own actuations stop (RX TRIP the core whose rods it inserts, TURB TRIP
//   the turbine), which lead the trip line and which its label opens; a group
//   that stops none (AFW START starts pumps) is listed as actuated;
// - its annunciator systems, in declared order, the categories alerts are
//   listed under and a display's tiles, each by its label and short label;
// - each alarm and trip, by the id of its alert: its tag, as a chip and a
//   trend line name its limit, its order and what it annunciates does ("LO-LO ·
//   RX TRIP": the reactor trip safety injection causes is a reactor trip, its
//   own trip SI), or with no limit on one value what it watches in on/off and
//   limit words ("NOT RUN · ALM", "L LO & F LO · ALM", never a bare ALM), or
//   for a trip with none, what it does; the group it is annunciated in; its
//   system; and the first-out group whose actuation brings it in as expected,
//   within how long (expectedAfter);
// - how a person acknowledges one: the Plant's lifecycle command (D-B1, D-E).

/** LO, LO-LO, LO-3; HI, HI-HI: a limit's direction once per order away from normal. */
const orderName = (threshold: { readonly direction: 'low' | 'high'; readonly order: number }): string => {
  const direction = threshold.direction === 'low' ? 'LO' : 'HI'
  return threshold.order <= 1 ? direction : threshold.order === 2 ? `${direction}-${direction}` : `${direction}-${threshold.order}`
}

const leaves = (condition: ProcessPlantIcCondition): ReadonlyArray<Extract<ProcessPlantIcCondition, { type: 'comparison' }>> =>
  condition.type === 'comparison' ? [condition] : condition.type === 'not' ? leaves(condition.condition) : condition.conditions.flatMap(leaves)

/** Its one numeric limit among on/off gates (a level low with a pump stopped): what its words name. */
const gatedLeaf = (condition: ProcessPlantIcCondition): Extract<ProcessPlantIcCondition, { type: 'comparison' }> | null => {
  if (condition.type !== 'all') return null
  const compared = condition.conditions.filter((child): child is Extract<ProcessPlantIcCondition, { type: 'comparison' }> => child.type === 'comparison')
  if (compared.length !== condition.conditions.length) return null
  const numeric = compared.filter(leaf => typeof leaf.value === 'number' && leaf.operator !== '==' && leaf.operator !== '!=')
  const gates = compared.filter(leaf => typeof leaf.value === 'boolean' && (leaf.operator === '==' || leaf.operator === '!='))
  return numeric.length === 1 && gates.length === compared.length - 1 && gates.length > 0 ? numeric[0]! : null
}

const quantityLetters: Readonly<Record<string, string>> = {
  pressure: 'P', pressureDelta: 'ΔP', flowRate: 'F', flowRateDelta: 'ΔF', massDelta: 'ΔINV', powerDelta: 'ΔPWR', energyPerMass: 'H', time: 'TIME',
  temperature: 'T', temperatureDelta: 'ΔT', temperatureRate: 'dT', rotationalSpeed: 'N', radiationDoseRate: 'RAD', power: 'PWR', mass: 'INV',
  voltage: 'V', concentration: 'CONC', countRate: 'NI', electricalCurrent: 'I', startupRate: 'SUR', head: 'HEAD', reactivity: 'RHO', frequency: 'HZ',
  energy: 'E', volume: 'VOL',
}
const measurandLetters: Readonly<Record<string, string>> = {
  level: 'L', position: 'POS', leak: 'LEAK', speed: 'N', load: 'LOAD', voltage: 'V', charge: 'CHG', quality: 'X', void: 'VOID', coverage: 'COV',
  availability: 'AVAIL', depletion: 'DEPL', humidity: 'HUM', contamination: 'CONTAM', insertion: 'INS', served: 'SERV', effectiveness: 'EFF',
}
const variableLetters = (binding: ProcessSignalBinding): string =>
  binding.quantity === 'ratio' ? measurandLetters[binding.measurand!] ?? binding.measurand!.toUpperCase() : quantityLetters[binding.quantity] ?? binding.quantity.toUpperCase()

/** An on/off reading in the words of the aspect its signal serves: a pump read not running is NOT RUN, a dead supply DEAD. */
const discreteWords = (graph: CompiledPlantGraph, binding: ProcessSignalBinding, value: boolean): string => {
  const owner = binding.owner.type === 'component' ? graph.components[binding.owner.componentIndex]! : undefined
  const served = owner?.semantics.aspects.find(aspect => aspect.command === binding.path || aspect.state?.path === binding.path)
  // A flag that serves no aspect says itself: "degraded" true reads DEGRADED.
  const flag = String(binding.path).split('.').at(-1)!.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
  return served?.aspect === 'running' ? (value ? 'RUN' : 'NOT RUN')
    : served?.aspect === 'position' && served.state?.reading === 'closedWhileTrue' ? (value ? 'CLOSED' : 'OPEN')
      : served?.aspect === 'position' ? (value ? 'OPEN' : 'SHUT')
        : served?.aspect === 'energized' ? (value ? 'LIVE' : 'DEAD')
          : (value ? flag : `NOT ${flag}`)
}

/**
 * Where every condition is an on/off reading and some read the alerted equipment's own state, those alone: what is
 * wrong with it ("NOT RUN" for a pump commanded to run, its bus live, that does not run), not the command and the
 * permissives that make it wrong.
 */
const ownStateLeaves = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition, equipment: string | undefined): ReadonlyArray<Extract<ProcessPlantIcCondition, { type: 'comparison' }>> | null => {
  const all = leaves(condition)
  if (condition.type !== 'all' || equipment === undefined || all.length < 2 || all.some(leaf => typeof leaf.value !== 'boolean')) return null
  const own = all.filter(leaf => {
    const binding = resolveProcessPlantSignalBinding(plant.graph, leaf.signal)
    const owner = binding.owner.type === 'component' ? plant.graph.components[binding.owner.componentIndex]! : undefined
    return owner !== undefined && String(owner.id) === equipment && owner.semantics.aspects.some(aspect => aspect.state?.path === binding.path)
  })
  return own.length === 0 ? null : own
}

/** What a rule with no limit on one value watches, as its words name it: "L LO & F LO", "NOT RUN", "DEAD". */
const watches = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, equipment: string | undefined): string => {
  const gated = gatedLeaf(rule.condition)
  const words = [...new Set((gated === null ? ownStateLeaves(plant, rule.condition, equipment) ?? leaves(rule.condition) : [gated]).map(leaf => {
    const binding = resolveProcessPlantSignalBinding(plant.graph, leaf.signal)
    if (typeof leaf.value === 'boolean') return discreteWords(plant.graph, binding, leaf.operator === '!=' ? !leaf.value : leaf.value)
    const low = leaf.operator === '<' || leaf.operator === '<='
    const thresholds = icThresholdsForSignal(plant, binding.path).thresholds
    const own = thresholds.find(threshold => threshold.ruleId === rule.id)
    // As its trend orders it: a limit with another closer to normal on its side reads LO-LO.
    const beyond = thresholds.some(other => other.kind !== 'control' && (other.direction === 'low') === low && (low ? other.value > (leaf.value as number) : other.value < (leaf.value as number)))
    return `${variableLetters(binding)} ${orderName({ direction: low ? 'low' : 'high', order: own?.order ?? (beyond ? 2 : 1) })}`
  }))]
  // Conditions that must all hold read "&", alternatives "or".
  return words.join(rule.condition.type === 'any' ? ' or ' : ' & ')
}

const annunciationByPlant = new WeakMap<CompiledProcessPlant, Annunciation>()

export const plantAnnunciation = (plant: CompiledProcessPlant): Annunciation => {
  const known = annunciationByPlant.get(plant)
  if (known !== undefined) return known
  const declared = plant.automation.firstOutGroups
  const ends = energyEnds(plant.graph)
  const actions = [...automaticActions(plant).values()]
  // A group stops the energy ends that rules annunciating only it command: a rule that trips the reactor besides its
  // own actuation (safety injection) or the turbine besides isolating feedwater says nothing of which write is whose.
  const groupsOf = (rule: ProcessPlantIcRule): ReadonlySet<string> =>
    new Set(rule.effects.flatMap(effect => effect.type === 'trip.enter' && effect.annunciator?.firstOutGroup !== undefined ? [effect.annunciator.firstOutGroup] : []))
  const groups = declared.map(group => {
    const commanding = actions.filter(action => { const named = groupsOf(action.rule); return named.size === 1 && named.has(group.id) })
    const stopped = [...new Set(ends.filter(end => commanding.some(action => action.writes.some(write => write.component === end.component.index))).map(end => String(end.component.id)))]
    return { id: group.id, label: group.shortLabel, ...(stopped.length === 0 ? {} : { ends: stopped.slice(0, 8) }) }
  })
  const label = new Map(declared.map(group => [group.id, group.shortLabel]))
  const alerts = plant.automation.rules.filter(rule => rule.enabled && icRuleKind(rule) !== 'control').flatMap(rule => {
    const limited = ruleLimits(plant, rule)
    const threshold = limited.length === 1 ? icThresholdsForSignal(plant, limited[0]!).thresholds.find(candidate => candidate.ruleId === rule.id) : undefined
    return rule.effects.flatMap(effect => {
      if (effect.type !== 'alarm.enter' && effect.type !== 'trip.enter') return []
      const annunciator = effect.annunciator
      // What it does is its own group's, not its rule's.
      const action = effect.type === 'alarm.enter' ? 'ALM' : label.get(annunciator?.firstOutGroup ?? '') ?? UNDECLARED_ACTION
      const tag = threshold !== undefined ? `${orderName(threshold)} · ${action}` : effect.type === 'alarm.enter' ? `${watches(plant, rule, annunciator?.equipmentId)} · ${action}` : action
      return [{
        id: processPlantIcLifecycleIdFor(effect.type === 'alarm.enter' ? 'alarm' : 'trip', rule.id, effect.id),
        tag: tag.length <= 48 ? tag : action,
        ...(annunciator?.firstOutGroup === undefined ? {} : { group: annunciator.firstOutGroup }),
        ...(annunciator?.system === undefined ? {} : { category: annunciator.system }),
        ...(annunciator?.expectedAfter === undefined ? {} : { expectedAfter: { group: annunciator.expectedAfter.firstOutGroup, withinMs: annunciator.expectedAfter.withinMs } }),
      }]
    })
  })
  const annunciation: Annunciation = {
    // A person acknowledges an alarm or a trip through the Plant's lifecycle command, by its lifecycle (the alert's id).
    acknowledge: { capabilityId: processPlantIcLifecycleCommandKind, input: { action: 'acknowledge' }, objectField: 'plantId', alertField: 'lifecycleId' },
    groups,
    categories: plant.automation.annunciatorSystems.map(system => ({ id: system.id, label: system.label, ...(system.shortLabel === undefined ? {} : { short: system.shortLabel }) })),
    alerts,
  }
  annunciationByPlant.set(plant, annunciation)
  return annunciation
}
