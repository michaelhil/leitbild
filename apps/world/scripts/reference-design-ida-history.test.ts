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

test('the failed-mask correction preserves strict, non-strict and untouched full-vector coordinates', () => {
  const scale = 2 ** -50;
  const predictor = [.4 * scale, -.4 * scale, .4, -.4, 1.2, -.7, 1.3];
  const correction = [-.5 * scale, .5 * scale, -.5, .5, -.1, .1, -.2];
  const constraints = [1, -1, 2, -2, 2, -2, 0], weights = [1, 1, 10, 10, 10, 10, 10];
  const raw = predictor.map((value, i) => value + correction[i]!);
  const failed = raw.map((value, i) => constraints[i]! > 0 ? value < 0 || constraints[i] === 2 && value === 0
    : constraints[i]! < 0 ? value > 0 || constraints[i] === -2 && value === 0 : false);
  const corrected = correction.map((value, i) => {
    const mask = Number(failed[i]);
    const target = .1 * (Math.abs(constraints[i]!) > 1.5 ? constraints[i]! : 0) / weights[i]!;
    return ((value - mask * value) - mask * predictor[i]!) + mask * target;
  });
  const endpoint = predictor.map((value, i) => value + corrected[i]!);
  expect(failed).toEqual([true, true, true, true, false, false, false]);
  expect(endpoint[0]).toBe(0);expect(endpoint[1]).toBe(0);
  expect(endpoint[2]).toBeGreaterThan(0);expect(endpoint[3]).toBeLessThan(0);
  expect(endpoint[2]!).toBeCloseTo(.1 * 2 / 10, 14);
  expect(endpoint[3]!).toBeCloseTo(-.1 * 2 / 10, 14);
  expect(corrected.slice(4)).toEqual(correction.slice(4));
  expect(endpoint.slice(4)).toEqual(raw.slice(4));
});

// Constant-step divided-difference identities only, not an implementation of a
// time integrator or qualification of variable-step/sensitivity behavior.
function consistentEndpoint(phi: readonly number[], correction: number, step: number) {
  const predictor = phi.reduce((sum, value) => sum + value, 0);
  let harmonic = 0, derivativePredictor = 0;
  for (let j = 1; j < phi.length; ++j) {
    harmonic += 1 / (j * step);
    derivativePredictor += harmonic * phi[j]!;
  }
  const endpoint = predictor + correction;
  const derivative = derivativePredictor + harmonic * correction;
  const next = [...phi];
  next[next.length - 1]! += correction;
  for (let j = next.length - 2; j >= 0; --j) next[j]! += next[j + 1]!;
  const untouchedHigherColumns = next.slice(1);
  // Proposed dependency consistency operation: the FULL endpoint, not a
  // constrained component's clipped value, owns history column0.
  next[0] = endpoint;
  const historyDerivative = next.slice(1).reduce((sum, value, j) => sum + value / ((j + 1) * step), 0);
  return { endpoint, derivative, next, untouchedHigherColumns, historyDerivative };
}

function polynomial(coefficients: readonly number[], t: number) {
  return [...coefficients].reverse().reduce((value, coefficient) => value * t + coefficient, 0);
}
function backwardDifferences(coefficients: readonly number[], order: number, step: number) {
  let row = Array.from({ length: order + 1 }, (_, j) => polynomial(coefficients, -j * step));
  const phi: number[] = [];
  while (row.length) {phi.push(row[0]!);row = row.slice(0, -1).map((value, j) => value - row[j + 1]!);}
  return phi;
}

for (const order of [1, 2, 3, 4, 5]) {
  test(`order${order} whole-endpoint association preserves polynomial state and derivative`, () => {
    const step = .125, coefficients = Array.from({ length: order + 1 }, (_, j) => j ? 1 / (j + 1) : 2);
    const phi = backwardDifferences(coefficients, order, step);
    const row = consistentEndpoint(phi, 0, step);
    expect(row.endpoint).toBeCloseTo(polynomial(coefficients, step), 12);
    const derivativeCoefficients = coefficients.slice(1).map((value, j) => value * (j + 1));
    expect(row.historyDerivative).toBeCloseTo(polynomial(derivativeCoefficients, step), 12);
    expect(row.derivative).toBeCloseTo(row.historyDerivative, 12);
    expect(row.next.slice(1)).toEqual(row.untouchedHigherColumns);
  });
  test(`order${order} zero, mirrored bounds, nonzero correction and birth keep the same full pair`, () => {
    const step = .25, phi = Array.from({ length: order + 1 }, (_, j) => (.1 + j * .2) * 2 ** -50);
    const predictor = phi.reduce((sum, value) => sum + value, 0);
    for (const sign of [1, -1]) {
      const row = consistentEndpoint(phi.map(value => sign * value), -sign * predictor, step);
      expect(row.endpoint).toBe(0);
      expect(row.next[0]).toBe(row.endpoint);
      expect(row.historyDerivative).toBeCloseTo(row.derivative, 28);
      expect(row.next.slice(1)).toEqual(row.untouchedHigherColumns);
    }
    // Signed nonzero controls represent unconstrained coordinates, not permission
    // to admit a negative physical mixing stock.
    for (const correction of [-.025, .025]) {
      const row = consistentEndpoint(phi, correction, step);
      expect(row.next[0]).toBe(row.endpoint);
      expect(row.historyDerivative).toBeCloseTo(row.derivative, 12);
    }
    const born = consistentEndpoint(Array<number>(order + 1).fill(0), .01, step);
    expect(born.endpoint).toBe(.01);
    expect(born.next[0]).toBe(.01);
    expect(born.historyDerivative).toBeCloseTo(born.derivative, 12);
  });
}
