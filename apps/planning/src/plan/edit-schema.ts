// The exact edit vocabulary; the boundary validates with it. Field-level: a given field replaces that
// field, null clears an optional field, an omitted field is kept. A new key needs every required field.
// A list of edits applies all or nothing. Weakening edits need authority. The published schema is this
// one passed through stripForPublication; every field keeps its description.
import { z } from 'zod'
import { planningLocatorSchema } from '@leitbild/contracts'
import {
  amountSchema, goalSchema, instantSchema, keySchema, labelSchema, localTimeSchema, sourceSchema, timeUnitSchema, timeZoneSchema, weekdaySchema, wordsSchema,
} from './schema.ts'

const key = keySchema.describe('Plan-local key')
const keys = z.array(keySchema).max(64)
const time = instantSchema.describe('Time with offset')
const period = z.object({ start: instantSchema.describe('Start'), end: instantSchema.describe('End') }).strict().describe('A period')
const worldRef = z.object({ locator: planningLocatorSchema.describe('World item'), fact: z.string().max(512).describe('World fact id') }).strict()
const source = z.object({
  by: sourceSchema.shape.by.describe('assumption: unconfirmed, flagged; reference: a standard'),
  note: wordsSchema.optional().describe('Where it comes from; names the reference'),
}).strict().refine(given => given.by !== 'reference' || given.note !== undefined, { message: 'A reference source names its reference in the note', path: ['note'] }).describe('Who says so')
const weekly = z.object({
  days: z.array(weekdaySchema).min(1).max(7).describe('Weekdays, mon to sun'),
  from: localTimeSchema.describe('Local start HH:MM'),
  to: localTimeSchema.describe('Local end HH:MM; to<=from ends next day'),
}).strict()
const goal = z.object({
  metric: goalSchema.shape.metric.describe('span-over, finish, extra-cost, unavailable-hours or lateness'),
  scope: z.object({
    groups: z.array(keySchema).max(16).optional().describe('Function groups'),
    tags: z.array(keySchema).max(8).optional().describe('Job tags'),
  }).strict().optional().describe('Which part of the plan'),
  threshold: z.object({ value: z.number().nonnegative().describe('Value'), unit: z.string().max(8).describe('h or currency') }).strict().optional().describe('Only the excess above it counts'),
  tolerance: z.object({ value: z.number().nonnegative().describe('Value'), unit: z.string().max(8).describe('h or currency') }).strict().describe('Differences smaller than this step count as equal'),
}).strict()
const duration = z.object({
  value: z.number().nonnegative().optional().describe('Most-likely value'),
  unit: timeUnitSchema.optional().describe('s, min, h or d'),
  calendar: z.enum(['working', 'elapsed']).optional().describe('working: crew hours only; elapsed: clock time'),
  range: z.object({ low: z.number().nonnegative().describe('Optimistic'), high: z.number().positive().describe('Pessimistic') }).strict().nullable().optional().describe('Estimate range'),
  source: source.optional(),
  fromWorld: z.array(worldRef).max(4).nullable().optional().describe('Use these World values, summed, instead of value'),
}).strict()
const choice = z.object({ choice: keySchema.describe('Method key'), option: keySchema.describe('Option key') }).strict()

export const editSchema = z.discriminatedUnion('edit', [
  z.object({
    edit: z.literal('plan'),
    title: labelSchema.optional().describe('Plan name'),
    purpose: wordsSchema.nullable().optional().describe('What the plan must achieve'),
    timeZone: timeZoneSchema.optional().describe('Site time zone, e.g. Europe/Oslo'),
    window: period.optional().describe('The work or outage window'),
    dataDate: time.optional().describe('The plan\'s "now"'),
    run: z.string().max(128).nullable().optional().describe('World Run to link; null unlinks'),
  }).strict(),
  z.object({
    edit: z.literal('equipment'), key,
    label: labelSchema.optional().describe('Name shown to people'),
    group: keySchema.nullable().optional().describe('Function group, for outage limits'),
    groupLabel: labelSchema.optional().describe('Name of that group'),
    supportedBy: keys.optional().describe('Items whose outage makes this one unavailable'),
    locator: planningLocatorSchema.nullable().optional().describe('World item from planning-facts; values copied at refresh'),
  }).strict(),
  z.object({
    edit: z.literal('calendar'), key,
    label: labelSchema.optional().describe('Name, e.g. Day shift'),
    weekly: z.array(weekly).optional().describe('Working time by weekday'),
    periods: z.array(period).optional().describe('One-off working periods'),
    except: z.array(period).optional().describe('Holidays and other non-working periods'),
    source: source.optional(),
  }).strict(),
  z.object({
    edit: z.literal('resource'), key,
    label: labelSchema.optional().describe('Name, e.g. Station mechanical crew'),
    kind: z.enum(['crew', 'tool']).optional().describe('crew: people; tool: crane, truck'),
    count: z.number().int().min(1).optional().describe('How many crews or tools'),
    crewSize: z.number().int().min(1).nullable().optional().describe('Persons per crew, for per-person prices'),
    calendar: keySchema.optional().describe('Calendar key'),
    attributes: z.array(z.object({
      key,
      label: labelSchema.describe('Name'),
      value: z.number().describe('Value'),
      unit: z.string().max(32).describe('Unit'),
      changes: z.array(z.object({ at: time, value: z.number().describe('New value') }).strict()).optional().describe('Announced changes'),
      source: source.optional(),
      fromWorld: worldRef.optional().describe('Copy the value from World'),
    }).strict()).optional().describe('Properties used by "where" needs'),
    maxJobs: z.number().int().min(1).nullable().optional().describe('Plan at most this many jobs ahead for it'),
    locator: planningLocatorSchema.nullable().optional().describe('World item for this crew or tool'),
    source: source.optional(),
  }).strict(),
  z.object({
    edit: z.literal('purchase'), key,
    label: labelSchema.optional().describe('Name, e.g. Overtime to 19:00'),
    resource: keySchema.optional().describe('Crew or tool it adds time to'),
    calendar: keySchema.nullable().optional().describe('Added weekly time'),
    periods: z.array(period).nullable().optional().describe('Added one-off periods'),
    replaces: z.array(period).optional().describe('Booked time it gives up (a rebooking)'),
    perPersonHour: amountSchema.nullable().optional().describe('Price per person-hour used'),
    perPeriodUsed: amountSchema.nullable().optional().describe('Price per period used, paid in full'),
    once: amountSchema.nullable().optional().describe('One-off price if any of it is used'),
    orderBy: time.nullable().optional().describe('Order deadline'),
    ordered: z.boolean().optional().describe('Already ordered: paid whether used or not'),
    allowed: z.boolean().optional().describe('Generate may buy it'),
  }).strict(),
  z.object({
    edit: z.literal('method'), key,
    label: labelSchema.optional().describe('What is being chosen'),
    options: z.array(z.object({ key, label: labelSchema.describe('Option name'), fixedCost: amountSchema.describe('Parts or fixed cost') }).strict()).min(2).max(4).optional().describe('Real alternatives'),
  }).strict(),
  z.object({
    edit: z.literal('job'), key,
    title: labelSchema.optional().describe('What is done'),
    kind: z.enum(['tag-out', 'work', 'test']).optional().describe('tag-out, work, or restore-and-test'),
    equipment: keys.optional().describe('Equipment it isolates, works on or tests'),
    isolation: z.enum(['inside', 'none']).optional().describe('inside: needs the item tagged out'),
    duration: duration.optional().describe('How long'),
    minimum: z.object({ value: z.number().positive().describe('Value'), unit: timeUnitSchema.describe('Unit'), words: wordsSchema.describe('Why') }).strict().nullable().optional().describe('Tests only: shortest allowed'),
    needs: z.array(z.object({
      anyOf: keys.describe('Any one of these crews or tools'),
      amount: z.number().int().min(1).optional().describe('How many, default 1'),
      where: z.object({ attribute: keySchema.describe('Attribute key'), atLeast: z.number().describe('Minimum'), unit: z.string().max(32).describe('Unit') }).strict().optional().describe('Only units meeting this'),
      handover: z.boolean().optional().describe('Paused work may continue with another one'),
    }).strict()).max(4).optional().describe('Who or what does it'),
    durationWith: z.array(z.object({
      resource: keySchema.describe('Crew or tool'),
      value: z.number().nonnegative().optional().describe('Its duration, in the job\'s unit'),
      fromWorld: z.array(worldRef).max(4).optional().describe('Or these World values, summed'),
      source: source.optional(),
    }).strict()).max(16).nullable().optional().describe('A different duration per crew or tool'),
    continuous: z.boolean().optional().describe('Never paused over a break, e.g. a lift'),
    method: choice.nullable().optional().describe('Exists only if that option is chosen'),
    notBefore: z.object({ at: time, words: wordsSchema.describe('Why'), source }).strict().nullable().optional().describe('Cannot start earlier'),
    target: z.object({ finishBy: time, words: wordsSchema.describe('Why') }).strict().nullable().optional().describe('Wanted finish (a goal, not a rule)'),
    checks: z.array(z.object({
      equipment: keySchema.describe('Equipment key'),
      fact: z.string().max(512).describe('World fact id'),
      expect: z.union([z.boolean(), z.string(), z.number()]).describe('Expected value'),
      words: wordsSchema.describe('In words'),
    }).strict()).max(4).optional().describe('World preconditions at read time'),
    lock: time.nullable().optional().describe('Fix its start; null unlocks'),
    tags: keys.optional().describe('Groupings, e.g. request class'),
    locator: planningLocatorSchema.nullable().optional().describe('World item the job serves, e.g. a request'),
  }).strict(),
  z.object({
    edit: z.literal('link'),
    from: keySchema.describe('Earlier job'),
    to: keySchema.describe('Later job'),
    type: z.enum(['FS', 'SS', 'FF']).describe('finish-start, start-start or finish-finish'),
    lag: z.object({ value: z.number().nonnegative().describe('Value'), unit: timeUnitSchema.describe('Unit') }).strict().optional().describe('Clock-time lag'),
    method: choice.nullable().optional().describe('Exists only with that option'),
  }).strict(),
  z.object({
    edit: z.literal('rule'), key,
    kind: z.enum(['protected', 'keep-in-service', 'span-limit']).optional().describe('Rule kind'),
    words: wordsSchema.optional().describe('The rule in plain words'),
    source: source.optional(),
    equipment: keys.optional().describe('protected: equipment never touched'),
    members: keys.optional().describe('keep-in-service: equipment or crews'),
    atLeast: z.number().int().min(1).optional().describe('keep-in-service: how many'),
    during: period.nullable().optional().describe('keep-in-service: when; default always'),
    group: keySchema.optional().describe('span-limit: function group'),
    limit: z.object({ value: z.number().positive().describe('Value'), unit: timeUnitSchema.describe('Unit') }).strict().optional().describe('span-limit: longest outage'),
    singleEntry: z.boolean().optional().describe('span-limit: one continuous outage'),
  }).strict(),
  z.object({ edit: z.literal('goals'), goals: z.array(goal).min(1).max(6).describe('In priority order') }).strict(),
  z.object({
    edit: z.literal('remove'),
    what: z.enum(['equipment', 'group', 'calendar', 'resource', 'purchase', 'method', 'job', 'link', 'rule']).describe('What to remove'),
    key: keySchema.optional().describe('Its key'),
    from: keySchema.optional().describe('link: earlier job'),
    to: keySchema.optional().describe('link: later job'),
    type: z.enum(['FS', 'SS', 'FF']).optional().describe('link: type'),
  }).strict(),
])
export type Edit = z.infer<typeof editSchema>
