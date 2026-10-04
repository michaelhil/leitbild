import { expect, test } from 'bun:test'
import { parseWstPaths } from './reference-design-rhr-wst'

const basis = { trains: ['A','B'], length_m:12, diameter_m:.3, poolMouth_m:8.2, trainEnd_m:-2,
  referencePressure_Pa:1e6, referenceTemperature_K:423.15, referenceFlow_kg_s:150,
  selectorDrop_Pa:5000, fixedDrop_Pa:5000 }
const document = (b: unknown) => `\n\`\`\`reference-rhr-wst-paths\n${JSON.stringify(b)}\n\`\`\`\n`
test('explicit reservoir columns preserve developed geometry and replace RCS isolation losses', () => {
  const b = parseWstPaths(document(basis))
  expect(4*b.length_m*Math.PI*b.diameter_m**2/4).toBeCloseTo(3.3929200658769765,12)
  expect(2*(b.selectorDrop_Pa+b.fixedDrop_Pa)).toBe(20000)
})
test('impossible or ambiguous path inputs are rejected', () => {
  expect(() => parseWstPaths(document({ ...basis,length_m:5 }))).toThrow()
  expect(() => parseWstPaths(document({ ...basis,diameter_m:0 }))).toThrow()
  expect(() => parseWstPaths(document({ ...basis,trains:['A'] }))).toThrow()
  expect(() => parseWstPaths(document(basis)+document(basis))).toThrow()
})
