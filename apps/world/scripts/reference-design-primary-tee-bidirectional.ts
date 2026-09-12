/** Offline matched effective-port admission, not a network flow solver or transient junction. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { primaryTeePython, sharpCombiningPolynomials } from './reference-design-primary-tee'
import { primaryTeeLiquidPython } from './reference-design-primary-tee-liquid'
import { parsePrimaryMechanics } from './reference-design-primary-mechanics'
import { parseSurgeRoute } from './reference-design-surge-route'

export function parseBidirectionalTee(text: string) {
  const blocks = [...text.matchAll(/^```reference-primary-bidirectional-tee\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-primary-bidirectional-tee block')
  return z.object({ model: z.literal('matched-oka1996-bassett2001'), branchAngle_deg: z.literal(90) }).strict().parse(JSON.parse(blocks[0]![1]!))
}

/** Bassett Eqs15/27 shape in selected volume-fraction extension; source q is mass fraction at constant density. */
export function dividingIncrements(areaRatio: number, fraction: number) {
  if (!Number.isFinite(areaRatio) || areaRatio < 1 || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    throw Error('Outside declared dividing geometry/fraction')
  return { through: fraction * fraction - .5 * fraction,
    branch: areaRatio ** 2 * fraction ** 2 - 2 * areaRatio * fraction * Math.cos(3 * Math.PI / 8) }
}

/** Caller supplies current upstream and common zero traces; each direction uses its actual donor. */
export const bidirectionalTeeDefinitions = String.raw`
def matched_tee(m2,Hbranch,multiplier=1.):
    m3=m1+m2
    if m3<=0:raise ValueError('Reversed/stopped main is outside this selected tee family')
    combining=m2>=0
    def evaluate(x):
        a=face(x[0]*1e7,x[1]*1e6,m3,Ah);b=face(x[2]*1e7,x[3]*1e6,abs(m2),Ap)
        if combining:
            f=(m2/b['rho'])/(m3/a['rho'])
            k13=poly['through'][0]+multiplier*sum(v*f**i for i,v in enumerate(poly['through']) if i)
            k23=poly['branch'][0]+multiplier*sum(v*f**i for i,v in enumerate(poly['branch']) if i)
            pressure=[before['p']+before['dynamic']-a['p']-a['dynamic']-k13*a['dynamic'],
                b['p']+b['dynamic']-a['p']-a['dynamic']-k23*a['dynamic']]
            energy=[(m1*before['H']+m2*Hbranch)/m3-a['H'],Hbranch-b['H']]
        else:
            f=(abs(m2)/b['rho'])/(m1/before['rho'])
            k13=divZero[0]+multiplier*(f*f-.5*f)
            k23=divZero[1]+multiplier*(areaRatio**2*f*f-2*areaRatio*f*math.cos(3*math.pi/8))
            pressure=[before['p']+before['dynamic']-a['p']-a['dynamic']-k13*before['dynamic'],
                before['p']+before['dynamic']-b['p']-b['dynamic']-k23*before['dynamic']]
            energy=[before['H']-a['H'],before['H']-b['H']]
        if not 0<=f<=1:raise ValueError('Outside selected volumetric fraction')
        return np.array(pressure+energy),a,b,f,[k13,k23]
    Hb=Hbranch if combining else before['H'];Ha=(m1*before['H']+m2*Hb)/m3 if combining else before['H']
    guess=np.array([after['p']/1e7,(Ha-g*zH-after['v']**2/2)/1e6,pZero/1e7,(Hb-g*zH)/1e6])
    solved=root(lambda x:evaluate(x)[0]/[1e5,1e5,1e6,1e6],guess,tol=1e-10)
    residual,a,b,f,coefficients=evaluate(solved.x)
    entropy=(m3*a['s']-m1*before['s']-m2*b['s'])/(m3 if combining else m1)
    energy=m1*before['H']+m2*b['H']-m3*a['H']
    V1=m1/before['rho'];V2=m2/b['rho'];V3=m3/a['rho']
    wall=[m3*a['v']-m1*before['v']-(before['p']-a['p'])*Ah,-abs(m2)*b['v']-b['p']*Ap]
    mechanical=V1*(before['p']+before['dynamic'])+V2*(b['p']+b['dynamic'])-V3*(a['p']+a['dynamic'])
    if combining:
        head=(V1*coefficients[0]+V2*coefficients[1])*a['dynamic']
        volumeWork=(V1+V2-V3)*(a['p']+a['dynamic'])
    else:
        head=(V3*coefficients[0]-V2*coefficients[1])*before['dynamic']
        volumeWork=(V1+V2-V3)*(before['p']+before['dynamic'])
    return dict(accepted=bool(max(abs(residual[:2]))<=1 and max(abs(residual[2:]))<=1e-5 and entropy>=-1e-7),
        solverSuccess=bool(solved.success),solverMessage=str(solved.message),residual=residual.tolist(),
        downstream=a,branch=b,volumetricFraction=f,coefficients=coefficients,
        throughVolumeFraction=V3/V1,complementThroughFraction=1-f if not combining else None,
        complementThroughDifference=V3/V1-(1-f) if not combining else None,
        energyResidual_W=energy,entropyGeneration_J_kgK=entropy,volumeContinuityDifference_m3_s=V1+V2-V3,
        stationaryWallReactionOnFluid_N=wall,mechanicalFluxDifference_W=mechanical,
        pathHeadPower_W=head,volumeWork_W=volumeWork,mechanicalAccountingResidual_W=mechanical-head-volumeWork,
        branchPressureFromCommonZero_Pa=b['p']-pZero,mainPressureFromCommonZero_Pa=a['p']-after['p'])
`

export const bidirectionalTeePython = String.raw`
import json,sys,math,time,platform,CoolProp,scipy
import CoolProp.CoolProp as CP
import numpy as np
from scipy.optimize import root
d=json.load(sys.stdin);started=time.perf_counter();g=9.80665;zH=d['elevation_m']
mainFluid=CP.AbstractState('HEOS','Water')
` + primaryTeeLiquidPython + String.raw`
before=d['base']['zeroFlow']['before'];after=d['base']['zeroFlow']['after'];pZero=d['base']['zeroFlow']['branchStaticPressure_Pa']
Ah=d['mainArea_m2'];Ap=d['branchArea_m2'];areaRatio=Ah/Ap;poly=d['polynomials'];m1=before['rho']*before['v']*Ah
divZero=[(before['p']+before['dynamic']-after['p']-after['dynamic'])/before['dynamic'],
    (before['p']+before['dynamic']-pZero)/before['dynamic']]
` + bidirectionalTeeDefinitions + String.raw`
donors={}
for item in d['base']['cases']:
    if item['downstreamMassFraction']==0 and item['coefficientMultiplier']==1 and item['accepted']:
        donors[item['donor']]=item['branch']['H']
rows=[]
for ratio in [-.01,-.001,-1e-6,0.,1e-6,.001,.01]:
    sources=donors.items() if ratio>=0 else [('actual incoming main',before['H'])]
    for name,H in sources:
        for factor in ([1.] if ratio==0 else [.5,1.,2.]):
            row=dict(signedBranchToMainInletMassRatio=ratio,branchMassFlow_kg_s=ratio*m1,donor=name,incrementMultiplier=factor)
            try:row.update(matched_tee(ratio*m1,H,factor))
            except (ValueError,RuntimeError) as error:row.update(accepted=False,failure=str(error))
            rows.append(row)
zeroRows=[x for x in rows if x['signedBranchToMainInletMassRatio']==0]
nearRows=[x for x in rows if 0<abs(x['signedBranchToMainInletMassRatio'])<=1e-6]
print(json.dumps(dict(scope='Matched effective-port all-liquid main-forward admission; prescribed flows, no delivery or time advancement',
    commonZeroDividingCoefficients=divZero,commonZeroSidePressure_Pa=pZero,cases=rows,
    zeroLimit=dict(zeroStatePass=all(x['accepted'] and abs(x['branchPressureFromCommonZero_Pa'])<=1 and abs(x['mainPressureFromCommonZero_Pa'])<=1 for x in zeroRows),
        nearZeroAdmissionPass=all(x['accepted'] for x in nearRows),
        maximumNearZeroSidePressureOffset_Pa=max(abs(x['branchPressureFromCommonZero_Pa']) for x in nearRows),
        meaning='Exact shared zero traces plus admitted finite one-sided samples; not equal slopes or a dynamic reversal test'),
    definitions=dict(dividingFraction='Selected outgoing branch volume flow / incoming main volume flow; source q is MASS fraction at equal density',
        dividingThroughShape='Uses complement 1-f; its difference from actual outgoing/incoming main volume flow is reported',
        combiningFraction='Incoming branch volume flow / outgoing main volume flow',
        sensitivity='Flow-dependent increments only, not calibrated uncertainty; exact zero traces fixed'),
    baseIdentity={k:d['base'][k] for k in ['sourceSha256','calculationSha256','inputSha256']},
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),
    wallSeconds=time.perf_counter()-started),allow_nan=False))
`

export async function runBidirectionalTee(wiki: string, python: string, basePath: string) {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const source = await Bun.file(import.meta.path).text(), baseText = await Bun.file(basePath).text(), base = JSON.parse(baseText)
  if (base.calculationSha256 !== hash(primaryTeePython) || !base.endpoint?.withinExistingPressureGate) throw Error('Base tee calculation/current nominal not admitted')
  const page = await Bun.file(join(wiki,'systems/primary-coolant/pressure-and-inventory.md')).text()
  const selection = parseBidirectionalTee(page)
  const geometry = parsePrimaryMechanics(await Bun.file(join(wiki,'systems/primary-coolant/mechanical-energy-and-geometry.md')).text())
  const route = parseSurgeRoute(await Bun.file(join(wiki,'systems/primary-coolant/surge-route.md')).text())
  const knownMain=base.cases.find((x:any)=>x.imposedMainMassFlow_kg_s>0)
  const knownBranch=base.cases.find((x:any)=>x.accepted&&x.imposedBranchMassFlow_kg_s>0)
  const mainArea=Math.PI*geometry.hotInsideDiameter_m**2/4,branchArea=Math.PI*route.internalDiameter_m**2/4
  const main=base.zeroFlow.before
  if (!knownMain || !knownBranch || Math.abs(mainArea-knownMain.imposedMainMassFlow_kg_s/(main.rho*main.v))>1e-10
    || Math.abs(branchArea-knownBranch.imposedBranchMassFlow_kg_s/(knownBranch.branch.rho*knownBranch.branch.v))>1e-10
    || Math.abs((main.H-main.h-main.v**2/2)/9.80665-route.sourceElevation_m)>1e-5) throw Error('Current tee geometry differs from retained input state')
  const input = { selection,base,mainArea_m2:Math.PI*geometry.hotInsideDiameter_m**2/4,
    branchArea_m2:Math.PI*route.internalDiameter_m**2/4,elevation_m:route.sourceElevation_m,
    polynomials:sharpCombiningPolynomials((geometry.hotInsideDiameter_m/route.internalDiameter_m)**2) }
  const identity = { sourceSha256:hash(source),calculationSha256:hash(bidirectionalTeePython),inputSha256:hash(JSON.stringify(input)),baseReceiptSha256:hash(baseText),
    operatingStateScope:'Frozen to the identified physical operating-point/tee receipt, not automatically requalified after upstream design changes',geometryMatchesReceipt:true }
  const p = Bun.spawn([python,'-c',bidirectionalTeePython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited])
  if (code !== 0) return {...identity,accepted:false,failure:err}
  return {...identity,...JSON.parse(out)}
}
if (import.meta.main) {
  const [wiki,python,base,...extra]=Bun.argv.slice(2)
  if (!wiki || !python || !base || extra.length) throw Error('Usage: primary-tee-bidirectional.ts <LD01-directory> <research-python> <retained-current-tee-receipt>')
  console.log(JSON.stringify(await runBidirectionalTee(wiki,python,base),null,2))
}
