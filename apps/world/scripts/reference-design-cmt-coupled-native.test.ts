import { expect, test } from 'bun:test'
import { nativeCoupledDriver, qualifyCoupledCmt } from './reference-design-cmt-coupled-native'

test('bounded qualification refuses an invalid allowance before reading native inputs', async () => {
  for (const allowance of [0, -1, Infinity, NaN, 120_001]) {
    await expect(qualifyCoupledCmt('', '', '', '', allowance)).rejects.toThrow('Invalid remaining coupled allowance')
  }
})

// These are packaging/contract checks, not native trajectory evidence.
test('coupled harness preserves actual stage/history roles and exposes refused candidates separately', () => {
  expect(nativeCoupledDriver).toContain('const auto initial=original()')
  expect(nativeCoupledDriver).toContain('const auto chart=conservative_residual(x,N_VGetArrayPointer(dy))')
  expect(nativeCoupledDriver).toContain('stageDiagnostic.genuine=flag==IDA_SUCCESS')
  expect(nativeCoupledDriver).not.toContain('candidate_ok(defect<=1')
  expect(nativeCoupledDriver).toContain('stageDiagnostic.wrms=std::sqrt(squares/differentialCount)')
  expect(nativeCoupledDriver).toContain('hd[j]-N_VGetArrayPointer(dy)[j]')
  expect(nativeCoupledDriver).toContain('result.steps<=20000')
  expect(nativeCoupledDriver).toContain('refusedCandidate')
  expect(nativeCoupledDriver).toContain('grossMError+=std::abs(')
  expect(nativeCoupledDriver).toContain('qError+=std::abs(')
  expect(nativeCoupledDriver).not.toContain('std::max(x[ix(i,Q)],0')
})
