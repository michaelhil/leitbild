/** Offline finite-secondary preparation; not a connected station or plant runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseBalanceBasis } from './reference-design-balance'

const positive = z.number().finite().positive()
const pair = z.object({ A: positive, B: positive }).strict()
const parentSchema = z.object({
  accepted: z.literal(true),
  input: z.object({ primarySeed: z.object({ sgSizing: z.object({ secondaryConductance_W_K: positive }) }) }),
  lastEvaluableState: z.object({ primary: z.object({
    SGWallEnergyAboveZeroC_J: pair, SGHeat_W: pair, secondaryTemperature_K: positive,
  }) }),
})
export const parseSgPreparationParent = (input: unknown) => {
  const parsed = parentSchema.parse(input)
  return { ...parsed.lastEvaluableState.primary, secondaryConductance_W_K: parsed.input.primarySeed.sgSizing.secondaryConductance_W_K }
}

export const sgPreparationPython = String.raw`
import sys,json,math,platform
import CoolProp
from CoolProp.CoolProp import PropsSI as P
d=json.load(sys.stdin);b=d['basis'];parent=d['parent'];checks=[]
def check(name,a,e,atol=1e-6,rtol=1e-9):
    if not math.isfinite(a) or abs(a-e)>max(atol,rtol*abs(e)):raise ValueError(f'{name}: {a} != {e}')
    checks.append(dict(name=name,actual=a,expected=e))
p=b['secondaryPressure_MPaAbs']*1e6;V=b['secondaryVolume_m3'];Vl=b['secondaryLiquidVolume_m3'];Vv=V-Vl
ts=P('T','P',p,'Q',0,'Water');rl=P('D','P',p,'Q',0,'Water');rv=P('D','P',p,'Q',1,'Water')
uf=P('U','P',p,'Q',0,'Water');ug=P('U','P',p,'Q',1,'Water')
ml=Vl*rl;mv=Vv*rv;M=ml+mv;U=ml*uf+mv*ug;C=b['wallCapacity_MJ_K']*1e6
def recover(energy):
    state=CoolProp.AbstractState('HEOS','Water')
    state.update(CoolProp.DmassUmass_INPUTS,M/V,energy/M)
    if state.phase()!=CoolProp.iphase_twophase:raise ValueError('Preparation comparison left its two-phase domain')
    x=state.Q()
    if not 0<x<1:raise ValueError('Two finite secondary phases required')
    return dict(p_Pa=state.p(),T_K=state.T(),liquidMass_kg=M*(1-x),vaporMass_kg=M*x,
      recoveredEnergy_J=M*state.umass(),mass_kg=M,volume_m3=M/state.rhomass())
base=recover(U)
check('native pressure recovery',base['p_Pa'],p,atol=.01)
check('native temperature recovery',base['T_K'],ts,atol=1e-6)
check('native liquid recovery',base['liquidMass_kg'],ml,atol=1e-6)
check('native vapor recovery',base['vaporMass_kg'],mv,atol=1e-6)
check('native volume',base['volume_m3'],V,atol=1e-9)
check('native energy',base['recoveredEnergy_J'],U,atol=.01)
cases=[]
for side in ['A','B']:
    Ew=parent['SGWallEnergyAboveZeroC_J'][side];Tw=Ew/C+273.15
    # Recover the parent's fixed secondary conductance from its actual wall balance.
    # This is an audit identity, not fresh equipment sizing from a changed state.
    G=parent['SGHeat_W'][side]/(Tw-parent['secondaryTemperature_K'])
    for Q in [-1e6,0.,1e6]:
        out=recover(U+Q);Ew1=Ew-Q;Tw1=Ew1/C+273.15
        check('paired source/receiver heat',out['recoveredEnergy_J']-U+Ew1-Ew,0,atol=.02)
        check('fixed inventory',out['mass_kg'],M,atol=1e-9)
        check('fixed fluid volume',out['volume_m3'],V,atol=1e-9)
        if Q and (out['p_Pa']-p)*Q<=0:raise ValueError('Signed heat did not change pressure in the tested wet region')
        cases.append(dict(side=side,heatFromMetal_J=Q,wallBefore_K=Tw,wallAfter_K=Tw1,wallAfterEnergy_J=Ew1,**out))
    check('fixed converted conductance',G,parent['secondaryConductance_W_K'],atol=1.)
if parent['SGWallEnergyAboveZeroC_J']['A']==parent['SGWallEnergyAboveZeroC_J']['B']:raise ValueError('Expected actual asymmetric parent, not copied A wall')
json.dump(dict(propertyBasis='HEOS/IAPWS-95',versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__),
  initial=dict(pressure_Pa=p,temperature_K=ts,liquidVolume_m3=Vl,vaporVolume_m3=Vv,liquidMass_kg=ml,vaporMass_kg=mv,
    totalMass_kg=M,internalEnergy_J=U,beta=b['submergedVaporVolume_m3']/Vv,
    apparentLevel_m=(Vl+b['submergedVaporVolume_m3'])/b['equivalentLevelArea_m2']),
  parentSecondaryTemperature_K=parent['secondaryTemperature_K'],
  initialExtraSecondaryHeat_W=parent['secondaryConductance_W_K']*(parent['secondaryTemperature_K']-ts),
  cases=cases,checks=checks,wholeStationInitialized=False),sys.stdout,allow_nan=False)
`

if (import.meta.main) {
  const [basisPath, parentPath, python, receiptPath] = process.argv.slice(2)
  if (!basisPath || !parentPath || !python || !receiptPath) throw Error('Usage: sg-preparation.ts numerical-basis.md primary-pzr-normal.json python receipt.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const names = ['reference-design-sg-preparation.ts', 'reference-design-balance.ts']
  const identities = async () => Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await Bun.file(new URL(name, import.meta.url)).text())])))
  const sources = await identities(), document = await Bun.file(basisPath).text(), parentText = await Bun.file(parentPath).text()
  const basis = parseBalanceBasis(document), parent = parseSgPreparationParent(JSON.parse(parentText))
  if (basis.steamGenerators !== 2) throw Error('This preparation is for the two installed LD-01 steam generators')
  const child = Bun.spawn([python, '-c', sgPreparationPython], { stdin: new Blob([JSON.stringify({ basis, parent })]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  if (JSON.stringify(sources) !== JSON.stringify(await identities()) || document !== await Bun.file(basisPath).text() || parentText !== await Bun.file(parentPath).text()) throw Error('Consumed source changed during calculation')
  const receipt = { sourceSha256: sources, basisSha256: hash(document), parentSha256: hash(parentText), ...JSON.parse(out) }
  await Bun.write(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ receiptPath, checks: receipt.checks.length, initial: receipt.initial, initialExtraSecondaryHeat_W: receipt.initialExtraSecondaryHeat_W }))
}
