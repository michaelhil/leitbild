import type { OperationalObject } from '../../../../../core/model/index.ts'
import { procedureIdSchema, type ProcedureId } from '../../../../../core/model/procedures.ts'
import { processPlantUnitPackDataSchema, type ProcessPlantUnitProjection } from '../../../model.ts'
import { safetyFunctionStatusWords } from '../../../safety-functions.ts'

// What the Plant's tools in the display window read from the unit's
// projection, which the page holds already: whether its runtime has started,
// and the procedure its most challenged critical safety function sends
// operators to where no active run on the unit runs it, which one press opens
// in the procedure window; and whether they offer the Instructor's events and
// faults. Everything else the unit says (its mode, trip, energy, alarms and
// safety functions) its display says itself. An object that is no Plant has
// none of these, nor the Plant's engineering views.

export interface WindowUnit {
  /** False until the Plant's runtime runs: a pending projection says nothing of the unit. */
  readonly started: boolean
  /** The procedure its most challenged critical safety function calls for, where no active run on the unit runs it. */
  readonly notRunning: {
    readonly procedureId: ProcedureId
    /** The function, its status and what that means. */
    readonly why: string
  } | null
  /** The Instructor's scenario events and faults are offered: only where this screen plays the Run's controller. */
  readonly instructor: boolean
}

/** What the window reads of the screen: the procedures the unit's active runs run, and whether it plays the Run's controller. */
export interface WindowScreen {
  readonly running: ReadonlyArray<ProcedureId>
  readonly controller: boolean
}

const notRunningOf = (projection: ProcessPlantUnitProjection, running: ReadonlyArray<ProcedureId>): WindowUnit['notRunning'] => {
  const worst = projection.worstSafetyFunction
  if (worst === undefined || worst.status === 'green' || worst.status === 'not-monitored' || worst.procedure === undefined) return null
  // A procedure name the procedure window cannot open is the display's to name, not a button.
  const procedure = procedureIdSchema.safeParse(worst.procedure)
  if (!procedure.success || running.includes(procedure.data)) return null
  return { procedureId: procedure.data, why: `${worst.label}: ${safetyFunctionStatusWords(worst.status)}\n${worst.meaning}` }
}

/** The unit as the window's Plant tools read it, or null for an object that is no Plant. */
export const windowUnit = (object: OperationalObject, screen: WindowScreen): WindowUnit | null => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  if (!parsed.success) return null
  const projection = parsed.data.projection
  const live = projection !== undefined && projection.statusTone !== 'idle' ? projection : null
  return {
    started: live !== null,
    notRunning: live === null ? null : notRunningOf(live, screen.running),
    instructor: screen.controller,
  }
}
