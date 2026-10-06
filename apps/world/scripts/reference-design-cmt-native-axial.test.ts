import { expect, test } from 'bun:test';
import { nativeAxialCandidate, ownedAxialLayout } from './reference-design-cmt-native-axial';

const receiving = [...Array<boolean>(13).fill(true), ...Array<boolean>(8).fill(false)];
const fields = ['M', 'P', 'E', 'B', 'Q', 'PP', 'TT'] as const;

test('native CMT layout includes exactly owned coordinates, with no absent BAL Q slots', () => {
  const layout = ownedAxialLayout(receiving);
  expect(layout.coordinateCount).toBe(139);
  expect(layout.coordinates.length).toBe(139);
  expect(layout.coordinates.filter(c => c.field === 'Q').length).toBe(13);
  expect(layout.coordinates.filter(c => c.field === 'PP' || c.field === 'TT').length).toBe(42);
  for (let cell = 0; cell < receiving.length; ++cell) {
    expect(layout.indices[cell]![4] === null).toBe(!receiving[cell]);
    for (const [field, index] of layout.indices[cell]!.entries()) {
      if (index !== null) expect(layout.coordinates[index]).toEqual({ cell, field: fields[field]! });
    }
  }
  expect(layout.coordinates.map((_, index) => index)).toEqual(
    layout.indices.flat().filter((index): index is number => index !== null));
});

test('ownership is derived per cell, not from a fixed receiving-prefix or hidden placeholder', () => {
  const layout = ownedAxialLayout([false, true, false, true]);
  expect(layout.coordinateCount).toBe(26);
  expect(layout.indices.map(row => row[4])).toEqual([null, 10, null, 23]);
  expect(ownedAxialLayout([]).coordinateCount).toBe(0);
});

test('exact coordinate projection preserves native residuals and separate observer rates', () => {
  const layout = ownedAxialLayout(receiving);
  // This is an index/rate transformation test, not an IF97 or trajectory test.
  // The appended24 rows identify OBSERVER rates, not IDAS state/residual coordinates.
  // Absent BAL Q rows are deleted, never mapped to0.
  const oldState = Array.from({ length: 171 }, (_, j) => 1000 + j * .125);
  const oldDerivative = oldState.map((_, j) => 200 + j * .25);
  const oldRates = oldState.map((_, j) => 50 - j * .5);
  const oldResidual = oldDerivative.map((value, j) => value - oldRates[j]!);
  const oldRow = layout.coordinates.map(c => c.cell * 7 + fields.indexOf(c.field));
  const project = (values: readonly number[]) => [...oldRow.map(j => values[j]!), ...values.slice(147)];
  const state = project(oldState), derivative = project(oldDerivative), rates = project(oldRates);
  const residual = derivative.map((value, j) => value - rates[j]!);
  expect(state.length).toBe(163);
  expect(residual).toEqual(project(oldResidual));
  expect(state.slice(139)).toEqual(oldState.slice(147));
  expect(new Set(oldRow).size).toBe(139);
  const deleted = Array.from({ length: 147 }, (_, j) => j).filter(j => !oldRow.includes(j));
  expect(deleted).toEqual(Array.from({ length: 8 }, (_, i) => (13 + i) * 7 + 4));
});

test('removing unowned rows cannot erase or alter the actually rejected CMT Q value', () => {
  const layout = ownedAxialLayout(receiving);
  const rejectedQ = -1.02475231600036849e-122;
  const old = Array<number>(171).fill(0);
  old[4] = rejectedQ;
  const projected = layout.coordinates.map(c => old[c.cell * 7 + fields.indexOf(c.field)]!);
  expect(projected[layout.indices[0]![4]!]).toBe(rejectedQ);
  expect(projected[layout.indices[0]![4]!]! >= 0).toBe(false);
});

const geometry = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12, bodyBottom_m: 11.725,
  bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .2, mouthDiameter_m: .2,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.85, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75, probeRadialInset_m: .15, probeAzimuth_deg: 18 };
const path = { headerElevation_m: 3, bore_m: .2, roughness_m: .000045,
  balanceReferenceFlow_kg_s: 25, balanceReferenceLoss_Pa: 2000, Cd: .62, Cv: .98,
  hotDensity_kg_m3: 745.7158573797482, hotViscosity_Pa_s: .00009238956797398296,
  coldDensity_kg_m3: 998.7373535000849, coldViscosity_Pa_s: .0006547658656041072,
  dviNeckLength_m: 1, dviNeckBore_m: .2, dviReferenceFlow_kg_s: 100, dviReferenceLoss_Pa: 10000 };
const document = '```reference-cmt-geometry\n' + JSON.stringify(geometry) + '\n```\n'
  + '```reference-cmt-balance-path\n' + JSON.stringify(path) + '\n```';

test('generated conservative residual addresses owned fields and leaves observation rates outside its equations', () => {
  const { geometry: fixture, cpp } = nativeAxialCandidate(document);
  expect(fixture.cells.length).toBe(21);
  expect(cpp).toContain('PHYSICAL=139,D=PHYSICAL,OBSERVERS=3*RM,SAMPLE=D+OBSERVERS');
  expect(cpp).toContain('if(j!=Q||c.tank)r[ix(i,j)]=dy[ix(i,j)]-f[ix(i,j)];');
  expect(cpp).toContain('r[ix(i,PP)]=(rm*Et-Mt*re)/det;r[ix(i,TT)]=(Mp*re-rm*Ep)/det;');
  expect(cpp).not.toContain('for(int j=PHYSICAL;j<D;++j)r[j]=dy[j]-f[j];');
  expect(cpp).toContain('std::array<double,D> conservative_residual(const double*y,const double*dy)');
  expect(cpp).not.toContain('N_Vector');
  expect(cpp).not.toContain('IDASolve');
  expect(cpp).toContain('Attempt to address an unowned native coordinate');
  expect(cpp).not.toContain('i*S');
  expect(cpp).not.toContain('unownedBalQ');
  expect(cpp).not.toContain('r[ix(i,Q)]=x[Q]');
});

test('stopped whole-vector integrator is absent rather than hidden behind a compatibility mode', () => {
  const { cpp } = nativeAxialCandidate(document);
  expect(cpp).not.toContain('IDAGetDky');
  expect(cpp).not.toContain('advance(1)');
  expect(cpp).not.toContain('first-step');
  expect(cpp).not.toContain('std::max(x[Q],0');
  expect(cpp).not.toContain('std::abs(x[Q])');
});

test('signed Q is an explicit numerical trial continuation, not an accepted stock waiver', () => {
  const { cpp } = nativeAxialCandidate(document);
  expect(cpp).toContain('(!c.tank||std::isfinite(x[Q]))');
  expect(cpp).toContain('k[i]=c.tank?x[Q]/x[M]:0');
  expect(cpp).toContain('mixing_batch(mixingInput.data(),mixingOutput.data(),mixingIndex)');
  expect(cpp).toContain('sourceQ+=node.weight*r[7]');
  expect(cpp).not.toContain('if(c.tank&&k[i]>0)');
  expect(cpp).not.toContain('const double G=-kt*(dr-dp/(state[i].w*state[i].w))*dp');
  expect(cpp).toContain('Invalid mixing input/role was accepted');
});

test('finite mixing mode consumes the actual residual without advancing a field', () => {
  const { cpp } = nativeAxialCandidate(document);
  const mode = cpp.indexOf('argc==3&&std::string(argv[2])=="--mixing-qualification"');
  expect(mode).toBeGreaterThan(0);
  expect(mode).toBeLessThan(cpp.indexOf('local_gates();', mode));
  expect(cpp).toContain('const auto actual=rates(originalState.data())');
  expect(cpp).toContain('Actual zero-origin radial receipts were suppressed');
  expect(cpp).toContain('node.radius,holeD,std::min(holeD,.7*c.Dh/4)');
  expect(cpp).toContain('sizeof(RustMixingInput)==88&&sizeof(RustMixingOutput)==776');
  expect(cpp).not.toContain('std::min(holeD,.7*node.radius)');
});

test('buoyancy pressure and density gradients share actual smooth neighbors or the declared isothermal local trace', () => {
  const { cpp } = nativeAxialCandidate(document);
  expect(cpp).toContain('(y[ix(b,PP)]-y[ix(a,PP)])/distance*vertical');
  expect(cpp).toContain('(state[b].rho-state[a].rho)/distance*vertical');
  expect(cpp).toContain('if(a==b)return local_reconstructed_gradients');
  expect(cpp).toContain('s.rho*s.kappa*vertical');
  expect(cpp).not.toContain('const double dp=-state[i].rho*gravity');
});
