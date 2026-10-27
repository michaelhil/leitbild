/** The raster probe bundles the real painter with a singleton command stream.
 * Keeping this test port inert elsewhere prevents accidental false equivalence. */
export const drawPhysicalPlanDrawing: typeof import('../../../src/ui/physical-layout/plan-drawing.ts').drawPhysicalPlanDrawing = () => { throw new Error('The ordered Plan reference must be built by its raster qualification probe') }
