import type { Priority } from '../../../core/model/index.ts'
import type { Observation } from '../../../core/observation/model.ts'
import { challengePriority } from '../ic/alarm-philosophy.ts'
import { formatQuantity } from '../quantity-text.ts'
import { safetyFunctionStatusWords, type SafetyFunctionComparison, type SafetyFunctionEvaluation, type SafetyFunctionStep } from '../safety-functions.ts'

// A critical safety function's status as World reads it each sample (plan v5
// W4.1): coloured at its challenge's priority; the restoration procedure its
// colour sends operators to as its chip's pointer (`note`, "FR-H.3"); its
// tree's path with the readings that answered each question, then what the
// path ends in, as its title (`why`, the old chips' tooltip). A function not
// judged in this state reads outside its validity ("—", D-89), one that
// cannot be judged as uncertain. Read per sample, never stored.

/** The most `why` holds (core/observation/model.ts). */
const WHY_MAX = 300

/** What a comparison read: "SG-A-LVL-NR 0 %", "total 114 kg/s", "TE-411-COLD − sgA.secondaryTemperatureC −0.02 °C". */
const readText = (comparison: SafetyFunctionComparison): string => {
  const quantity = (value: number | boolean, unit: string): string => typeof value === 'boolean' ? (value ? 'on' : 'off') : formatQuantity(value, unit).replace('-', '−')
  if (comparison.combines === 'total' && comparison.measured !== undefined) return `total ${quantity(comparison.measured, comparison.unit)}`
  if (comparison.combines === 'difference' && comparison.measured !== undefined) return `${comparison.reads.map(read => read.signal).join(' − ')} ${quantity(comparison.measured, comparison.unit)}`
  const read = comparison.reads[0]
  return read === undefined ? comparison.reason ?? 'not read' : `${read.signal} ${quantity(read.value, read.unit)}`
}

/** A question as it was answered, with the readings that answered as it did (every one where it is unknown): "Power range below 5 %: yes (NIS-PR-AVG 0.09 %)". */
const stepText = (step: SafetyFunctionStep): string => {
  const deciding = step.comparisons.filter(comparison => comparison.answer === step.answer)
  return `${step.question}: ${step.answer} (${(deciding.length > 0 ? deciding : step.comparisons).map(readText).join(', ')})`
}

/** The path to the status, then the status and what it means; within WHY_MAX, the earliest questions give way first. */
const pathText = (evaluation: SafetyFunctionEvaluation): string => {
  const ends = `${safetyFunctionStatusWords(evaluation.status)}${evaluation.procedure === undefined ? '' : ` · ${evaluation.procedure}`}: ${evaluation.meaning}`
  const steps = evaluation.path.map(stepText)
  for (let from = 0; from <= steps.length; from += 1) {
    const text = [...(from === 0 ? [] : ['…']), ...steps.slice(from), ends].join(' · ')
    if (text.length <= WHY_MAX) return text
  }
  return `${ends.slice(0, WHY_MAX - 1)}…`
}

/** A safety function's status observation now, but for its ref and time. */
export const safetyFunctionReading = (evaluation: SafetyFunctionEvaluation): Pick<Observation, 'value' | 'quality' | 'priority' | 'note' | 'why'> => {
  const priority: Priority = challengePriority[evaluation.status] ?? 'none'
  return {
    value: evaluation.status,
    quality: evaluation.status === 'unknown' ? 'uncertain' : evaluation.status === 'not-monitored' ? 'not-applicable' : 'good',
    priority,
    ...(evaluation.procedure === undefined ? {} : { note: evaluation.procedure }),
    why: pathText(evaluation),
  }
}
