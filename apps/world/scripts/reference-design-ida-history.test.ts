import { expect, test } from 'bun:test';

// Static IEEE-754 arithmetic only: this is the scalar order-one association in
// IDA/IDAS7.5's small-constraint-correction and CompleteStep history paths.
// It neither runs a solver nor recovers the UNRECORDED operands of the CMT case.
function correctedHistory(old: number, firstDifference: number, nonlinearCorrection: number) {
  const predictor = old + firstDifference;
  const raw = predictor + nonlinearCorrection;
  // Assume the solver has selected its small correction for a failed >=0 or <=0
  // constraint. Its constraint mask leaves this scalar raw value unchanged.
  const corrected = nonlinearCorrection - raw;
  const correctedEndpoint = predictor + corrected;
  const nextDifference = firstDifference + corrected;
  const nextHistory = old + nextDifference;
  return { predictor, raw, corrected, correctedEndpoint, nextDifference, nextHistory };
}

test('a zero corrected endpoint can become the exact observed negative history magnitude', () => {
  const scale = 2 ** -50;
  const row = correctedHistory(.1 * scale, .3 * scale, -.5 * scale);
  expect(row.raw).toBeLessThan(0);
  expect(row.corrected).toBe(-row.predictor);
  expect(row.correctedEndpoint).toBe(0);
  expect(row.nextHistory).toBe(-2.46519032881566189e-32);
  expect(row.nextHistory >= 0).toBe(false);
});

test('the defect is general history association, not a plant-Q-specific operation', () => {
  const ordinary = correctedHistory(.1, .3, -.5);
  expect(ordinary.correctedEndpoint).toBe(0);
  expect(ordinary.nextHistory).toBe(-2.7755575615628914e-17);
  const mirrored = correctedHistory(-.1, -.3, .5);
  expect(mirrored.raw).toBeGreaterThan(0);
  expect(mirrored.correctedEndpoint).toBe(0);
  expect(mirrored.nextHistory).toBe(2.7755575615628914e-17);
  expect(mirrored.nextHistory <= 0).toBe(false);
});

test('newer direct-minus-predictor correction still leaves the history counterexample', () => {
  // Official7.9 directly sets a failed non-strict coordinate correction to
  // -predictor. That improves correction arithmetic, not this history ordering.
  const old = .1 * 2 ** -50, firstDifference = .3 * 2 ** -50;
  const predictor = old + firstDifference, corrected = -predictor;
  expect(predictor + corrected).toBe(0);
  expect(old + (firstDifference + corrected)).toBe(-2.46519032881566189e-32);
});
