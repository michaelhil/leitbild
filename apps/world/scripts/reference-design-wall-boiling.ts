/** Offline wall-flux/phase-source comparison. No runtime imports or plant admission. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
const positive=z.number().finite().positive()
const schema=z.object({design:z.literal('LD-01-wall-boiling-comparison'),
  hydraulicDiameter_m:positive,area_m2:positive,contactAngle_deg:positive.max(180),
  surfaceFactor:positive,vaporVolumeFraction:z.number().finite().min(0).max(.5),
  pressures_MPa:z.array(positive.min(1).max(16)).min(1),
  liquidMassFlux_kg_m2s:positive,subcooling_K:z.array(z.number().finite().min(0).max(50)).min(1),
  superheats_K:z.array(z.number().finite().min(0).max(30)).min(1),
}).strict()
export function parseWallBoilingStudy(document:string) {
  const blocks=[...document.matchAll(/^```reference-wall-boiling\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected exactly one reference-wall-boiling JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
const calculation=String.raw`
import sys,json,math,platform
import iapws
from iapws import IAPWS97 as W
from scipy.optimize import brentq
b=json.load(sys.stdin); checks=[]
def check(name,actual,expected,atol=1e-8,rtol=1e-10):
    if not math.isfinite(actual) or abs(actual-expected)>max(atol,rtol*abs(expected)):
        raise ValueError(f'{name}: {actual} != {expected}')
    checks.append(dict(name=name,actual=actual,expected=expected))
check('abundant-liquid dryout ramp is inactive',min(416.7*(1-b['vaporVolumeFraction']-.0001),1.),1.)
def pressure_factor(p,ctf=True):
    r=p/22.064
    return 1.73*r**.27+6.1*r*r+.68*r*r/(1-r*r if ctf else 1-r)
def pool(p,superheat,ctf=True):
    if superheat<=0:return 0.
    n=.9-.3*(p/22.064)**.15
    return (5600*pressure_factor(p,ctf)*b['surfaceFactor']*superheat/20000**n)**(1/(1-n))
def wall(p,sub,superheat):
    f=W(P=p,x=0); v=W(P=p,x=1); ts=f.T
    l=W(P=p,T=ts-sub) if sub>0 else f
    dh=b['hydraulicDiameter_m']; G=b['liquidMassFlux_kg_m2s']
    re=G*dh/l.mu; pr=l.cp*1000*l.mu/l.k
    if re<10000 or not .6<=pr<=160:raise ValueError('Outside selected turbulent convection comparison')
    hfc=.023*re**.8*pr**.4*l.k/dh
    phi=math.radians(b['contactAngle_deg']); F=1-math.exp(-phi**3-.5*phi)
    hfg=(v.h-f.h)*1000
    d0=2*hfc*f.sigma*ts/(F*F*v.rho*hfg*f.k)
    donb=.5*(d0+math.sqrt(d0*d0+4*d0*sub)); tonb=ts+donb
    tw=ts+superheat; qfc=hfc*(tw-l.T)
    qtotal=qfc; qb=0.
    if tw>tonb:
        d=pool(p,superheat)-pool(p,donb)
        qtotal=math.cbrt(qfc**3+d**3)
        # Algebraically qtotal-qfc without cancellation near ONB.
        qb=d**3/(qtotal*qtotal+qtotal*qfc+qfc*qfc)
    pe=G*dh*f.cp*1000/l.k
    gamma=0.; hcr=None; raw=None; eps=1.
    if qb>0:
        drop=qb*dh*f.cp*1000/(l.k*.0065*max(70000,pe))
        hcr=f.h*1000-drop
        if pe>=70000:
            check('high-Pe detachment dimensional reduction',drop,qb/(G*.0065))
        raw=(l.h*1000-hcr)/drop
        eps=hfg/(hfg+(f.h-l.h)*1000*f.rho/v.rho)
        gamma=min(1.,max(0.,raw))*eps
    qlatent=gamma*qb; qsensible=qtotal-qlatent
    area=b['area_m2']; rate=area*qlatent/hfg
    sourceLiquid=area*qtotal-rate*v.h*1000
    sourceVapor=rate*v.h*1000; sourceSolid=-area*qtotal
    check('wall mass',-rate+rate,0.)
    check('wall energy',sourceLiquid+sourceVapor+sourceSolid,0.,atol=1e-7)
    check('liquid source representation',sourceLiquid,area*qsensible-rate*f.h*1000,atol=1e-7)
    if not 0<=gamma<=1:raise ValueError('Invalid wall-generation fraction')
    # Independent solution of published implicit ONB equation, not validation data.
    implicit=brentq(lambda d:d*d-d0*(d+sub),max(1e-12,d0*.1),max(1.,10*(d0+sub)))
    check('ONB explicit/implicit',donb,implicit)
    cavity0=math.sqrt(8*f.sigma*ts*f.k/(v.rho*hfg*hfc*(tonb-l.T)))
    cavity=cavity0*F
    check('ONB primitive cavity/Young-Laplace equations',donb,4*f.sigma*ts/(cavity*v.rho*hfg))
    hnb=5600*pressure_factor(p)*b['surfaceFactor']*(pool(p,10)/20000)**(.9-.3*(p/22.064)**.15)
    check('Gorenflo original HTC vs flux inversion',hnb*10,pool(p,10))
    if sub==0:
        # Fixed-p saturated patch ONLY: constrain both retained phase enthalpies.
        # Bulk demand follows the remaining sensible source, not a general source law.
        bulk=area*qsensible/hfg; total=rate+bulk
        check('saturated liquid phase residual',sourceLiquid-bulk*v.h*1000,-total*f.h*1000,atol=1e-7)
        check('saturated vapor phase residual',sourceVapor+bulk*v.h*1000,total*v.h*1000,atol=1e-7)
        check('saturated total latent demand',total*hfg,area*qtotal,atol=1e-7)
    return dict(p_MPa=p,subcooling_K=sub,wallSuperheat_K=superheat,Re=re,Pr=pr,Pe=pe,
        bulkCp_J_kgK=l.cp*1000,saturatedCp_J_kgK=f.cp*1000,
        bulkConductivity_W_mK=l.k,saturatedConductivity_W_mK=f.k,
        Tsat_C=ts-273.15,Tonb_C=tonb-273.15,hFC_W_m2K=hfc,
        total_W_m2=qtotal,convection_W_m2=qfc,boilingIncrement_W_m2=qb,
        criticalEnthalpy_J_kg=hcr,rawGenerationFraction=raw,pumpingFactor=eps,
        generationFraction=gamma,wallVapor_kg_s=rate,
        liquidEnergy_W=sourceLiquid,vaporEnergy_W=sourceVapor,solidEnergy_W=sourceSolid)
rows=[wall(p,s,t) for p in b['pressures_MPa'] for s in b['subcooling_K'] for t in b['superheats_K']]
onset=[]
for p in b['pressures_MPa']:
    r=wall(p,20,0); d=r['Tonb_C']-r['Tsat_C']
    below=wall(p,20,d-1e-6); at=wall(p,20,d); above=wall(p,20,d+1e-6)
    check('ONB zero boiling increment',at['boilingIncrement_W_m2'],0.,atol=1e-8)
    check('ONB continuous heat',above['total_W_m2']-below['total_W_m2'],2e-6*r['hFC_W_m2K'],atol=1e-5)
    onset.append(dict(p_MPa=p,superheat_K=d,heatJumpAcross2MicroK_W_m2=above['total_W_m2']-below['total_W_m2']))
# SI versus Btu/(h ft²) transcription of the same dimensional law.
fluxUnit=1055.05585262/(3600*.3048**2); hUnit=fluxUnit*1.8
for p in b['pressures_MPa']:
    qSI=pool(p,10); n=.9-.3*(p/22.064)**.15
    qIP=((5600/hUnit)*pressure_factor(p)*b['surfaceFactor']*18/(20000/fluxUnit)**n)**(1/(1-n))
    check('SI/IP Gorenflo heat flux',qIP*fluxUnit,qSI)
check('Saha-Zuber branch junction',.0065*70000,455.)
variants=[dict(p_MPa=p,CTFfactor=pressure_factor(p),INLfactor=pressure_factor(p,False),
    poolFluxDifference_percent=100*(pool(p,10,False)/pool(p,10)-1)) for p in b['pressures_MPa']]
print(json.dumps(dict(scope='local wall-law algebra and fixed-pressure phase-source checks; no CHF or coupled-void qualification',
    packages=dict(python=platform.python_version(),iapws=iapws.__version__),
    rows=rows,onset=onset,pressureVariants=variants,checks=checks,
    empiricalLDQualification=False,bulkPhaseClosureImplemented=False,postCHFImplemented=False),allow_nan=False,indent=2))
`
if(import.meta.main) {
  const [path,python,...extra]=process.argv.slice(2)
  if(!path||!python||extra.length)throw Error('Usage: bun reference-design-wall-boiling.ts <phase-dependent-heat-transfer.md> <isolated-python>')
  const input=parseWallBoilingStudy(await Bun.file(path).text())
  const child=Bun.spawn([python,'-c',calculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(exit!==0)throw Error(stderr||`Wall boiling comparison failed: ${exit}`)
  console.log(JSON.stringify({inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationSha256:createHash('sha256').update(calculation).digest('hex'),...JSON.parse(stdout)},null,2))
}
