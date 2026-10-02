/** Authored engineering criteria, not an evaluator or equipment execution plan. */
export type ProcedureAssessmentCondition =
  | { readonly type: 'comparison'; readonly tagId: string; readonly operator: '<' | '<=' | '>' | '>=' | '==' | '!='; readonly value: number | boolean; readonly unit: string; readonly bound?: 'value' | 'lower' | 'upper'; readonly evidence: 'instrument' | 'engineering-diagnostic'; readonly source: string; readonly maxAgeSeconds: number }
  | { readonly type: 'all' | 'any' | 'vote'; readonly conditions: ReadonlyArray<ProcedureAssessmentCondition>; readonly required?: number }
  | { readonly type: 'not'; readonly condition: ProcedureAssessmentCondition }
  | { readonly type: 'held'; readonly durationSeconds: number; readonly condition: ProcedureAssessmentCondition }
  | { readonly type: 'manual'; readonly description: string; readonly tagIds: ReadonlyArray<string>; readonly source: string }

export interface ProcedureAssessment {
  readonly condition: ProcedureAssessmentCondition
}

const record = (value: unknown, allowed: ReadonlyArray<string>): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('procedure-assessment requires an object')
  const result = value as Record<string, unknown>
  for (const key of Object.keys(result)) if (!allowed.includes(key)) throw new Error(`unsupported procedure-assessment field ${key}`)
  return result
}
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`procedure-assessment requires ${name}`)
  return value
}
const tag = (value: unknown): string => {
  const id = text(value, 'canonical tagId')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) throw new Error(`invalid assessment tagId ${id}`)
  return id
}
const seconds = (value: unknown, name: string, positive = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) throw new Error(`procedure-assessment ${name} must be ${positive ? 'positive' : 'nonnegative'} finite seconds`)
  return value
}

export const parseProcedureAssessment = (value: unknown): ProcedureAssessment => {
  const root = record(value, ['condition'])
  let count = 0
  const condition = (value: unknown, depth: number): ProcedureAssessmentCondition => {
    if (++count > 512 || depth > 32) throw new Error('procedure-assessment exceeds structural input bounds')
    const node = record(value, ['type', 'tagId', 'operator', 'value', 'unit', 'bound', 'evidence', 'source', 'maxAgeSeconds', 'conditions', 'required', 'condition', 'durationSeconds', 'description', 'tagIds'])
    if (node.type === 'comparison') {
      record(node, ['type', 'tagId', 'operator', 'value', 'unit', 'bound', 'evidence', 'source', 'maxAgeSeconds'])
      const operator = node.operator
      if (!['<', '<=', '>', '>=', '==', '!='].includes(String(operator))) throw new Error('invalid assessment comparison operator')
      if (typeof node.value !== 'boolean' && (typeof node.value !== 'number' || !Number.isFinite(node.value))) throw new Error('assessment comparison value must be finite numeric or boolean')
      if (typeof node.value === 'boolean' && (operator !== '==' && operator !== '!=' || node.bound !== undefined)) throw new Error('boolean assessment comparison requires equality and no bound')
      if (typeof node.value === 'number' && !['value', 'lower', 'upper'].includes(String(node.bound))) throw new Error('numeric assessment comparison requires explicit value/lower/upper bound')
      if (node.evidence !== 'instrument' && node.evidence !== 'engineering-diagnostic') throw new Error('assessment requires explicit evidence class')
      return { type: 'comparison', tagId: tag(node.tagId), operator: operator as '<' | '<=' | '>' | '>=' | '==' | '!=', value: node.value,
        unit: text(node.unit, 'unit'), ...(node.bound === undefined ? {} : { bound: node.bound as 'value' | 'lower' | 'upper' }),
        evidence: node.evidence, source: text(node.source, 'source'), maxAgeSeconds: seconds(node.maxAgeSeconds, 'maxAgeSeconds') }
    }
    if (node.type === 'all' || node.type === 'any' || node.type === 'vote') {
      record(node, node.type === 'vote' ? ['type', 'conditions', 'required'] : ['type', 'conditions'])
      if (!Array.isArray(node.conditions) || !node.conditions.length) throw new Error('assessment group requires nonempty conditions')
      if (node.type === 'vote' && (typeof node.required !== 'number' || !Number.isInteger(node.required) || node.required < 1 || node.required > node.conditions.length)) throw new Error('invalid assessment vote count')
      const conditions = node.conditions.map(child => condition(child, depth + 1))
      if (node.type === 'vote') {
        const seen = new Set<string>()
        for (const child of conditions) {
          const ids = new Set(assessmentLeaves(child).flatMap(leaf => leaf.type === 'comparison' ? [leaf.tagId] : leaf.tagIds))
          for (const id of ids) {
            if (seen.has(id)) throw new Error(`assessment vote repeats tagId ${id} across operands; place common premises outside the vote`)
            seen.add(id)
          }
        }
        if (new Set(conditions.map(child => JSON.stringify(child))).size !== conditions.length) throw new Error('assessment vote contains duplicate operands; repetitions are not independent channels')
      }
      return { type: node.type, conditions, ...(node.type === 'vote' ? { required: node.required as number } : {}) }
    }
    if (node.type === 'not' || node.type === 'held') {
      record(node, node.type === 'held' ? ['type', 'condition', 'durationSeconds'] : ['type', 'condition'])
      return node.type === 'held' ? { type: 'held', condition: condition(node.condition, depth + 1), durationSeconds: seconds(node.durationSeconds, 'durationSeconds', true) }
        : { type: 'not', condition: condition(node.condition, depth + 1) }
    }
    if (node.type === 'manual') {
      record(node, ['type', 'description', 'tagIds', 'source'])
      if (!Array.isArray(node.tagIds)) throw new Error('manual assessment requires explicit tagIds')
      const tagIds = node.tagIds.map(tag)
      if (new Set(tagIds).size !== tagIds.length) throw new Error('manual assessment contains duplicate tagIds')
      return { type: 'manual', description: text(node.description, 'manual judgment description'), tagIds, source: text(node.source, 'source') }
    }
    throw new Error(`unsupported assessment condition ${String(node.type)}`)
  }
  return { condition: condition(root.condition, 0) }
}

export const assessmentLeaves = (condition: ProcedureAssessmentCondition): ReadonlyArray<Extract<ProcedureAssessmentCondition, { type: 'comparison' | 'manual' }>> => {
  if (condition.type === 'comparison' || condition.type === 'manual') return [condition]
  if (condition.type === 'not' || condition.type === 'held') return assessmentLeaves(condition.condition)
  return condition.conditions.flatMap(assessmentLeaves)
}
