/** Offline full-shell reciprocal submerged contact, using the owned joined vessel. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'
import { parsePhaseStorageBasis } from './reference-design-pressurizer-phase-storage'
import { joinedDefinitions, parseJoinedPressurizer } from './reference-design-pressurizer-joined'

const schema=z.object({poolInitialSubcooling_K:z.number().positive().finite()}).strict()
export function parseSubmergedBasis(text:string){
  const blocks=[...text.matchAll(/^```reference-pressurizer-submerged\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-pressurizer-submerged block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export const submergedCalculation=joinedDefinitions+String.raw`
sub=b['submerged'];n=cfg['axialCells'];nr=cfg['radialCells'];dt=cfg['timeStep_s']
def mixed_contact_check():
    length=.1;solve,masses,_,_=make_wall(16,length);old=np.full(16,Tw0,dtype=float);ts=sat(p0)[0];bulk=sourceT-20.;fraction=.99
    def balance(surface):
        steel,q,res=solve(old,surface,.05)
        liquid=submerged_convection(p0,bulk,surface,Lsource)['flux']*C*length*fraction
        # A specified 10 µm conductive film is a local regression boundary, not initial vessel inventory.
        film=k*(ts-surface)/1e-5*C*length*(1-fraction)
        return q[0]-liquid-film,(steel,q,res,liquid,film)
    surface=contact_surface_root(lambda t:balance(t)[0],old,[bulk],ts)
    residual,(steel,q,res,liquid,film)=balance(surface)
    energy=float(sum(masses*steel_de(steel,old)));defect=energy-.05*(liquid+film)
    if not surface<Tw0 or not liquid<0<film or abs(residual)>1e-5 or abs(defect)>.05:raise ValueError('Mixed cold liquid/hot film contact failed')
    zero=submerged_convection(p0,bulk,bulk,Lsource)
    if zero['flux']!=0 or zero['Ra']!=0:raise ValueError('Zero submerged thermal drive failed')
    return dict(surface_K=surface,initialSteel_K=Tw0,liquidHeatIntoSteel_W=liquid,filmHeatIntoSteel_W=film,steelEnergyChange_J=energy,energyResidual_J=defect,zeroDrivePassed=True)
mixed=mixed_contact_check()
args=dict(submerged=True,subcooling=sub['poolInitialSubcooling_K'])
expectedSteel=7920*math.pi*(r['outerRadius_m']**2-r['innerRadius_m']**2)*height
caseSpecifications=[('base',n,nr,dt,args),('radial',n,2*nr,dt,args),('axial',2*n,nr,dt,args),('time',n,nr,dt/2,args),('liquid-bands',n,nr,dt,dict(args,bandCount=2*r['cellCount'])),
    ('no-contact',n,nr,dt,dict(subcooling=sub['poolInitialSubcooling_K'])),('warm-topology-challenge',n,nr,dt,dict(submerged=True)),('zero-drive',n,nr,dt,dict(args,zero=True))]
cases=[];caseFailures=[]
for label,nn,rr,step,options in caseSpecifications:
    result=None
    try:
        result=run(nn,rr,step,**options)
        if label!='warm-topology-challenge' and any(row['lowerQualityMax']!=0 for row in result['rows']):raise ValueError('Subcooled companion left single-phase admission')
        if options.get('submerged') and abs(result['initial']['retainedSteelMass_kg']-expectedSteel)>1e-9:raise ValueError('Full shell mass ownership failed')
    except ValueError as error:
        caseFailures.append(dict(case=label,error=str(error)))
    cases.append(result)
comparisons=[]
for label,case in zip(['radial','axial','time','liquid-bands'],cases[1:5]):
    if cases[0] is None or case is None:
        comparisons.append(dict(axis=label,passes=False,reason='Required case rejected'));continue
    a=cases[0]['rows'][-1];c=case['rows'][-1]
    metrics={key:abs(a[key]-c[key])/max(abs(c[key]),1e-12) for key in ['filmMass_kg','cumulativeReceipt_kg','wallEnergy_J']}
    metrics['submergedLiquidHeat']=abs(sum(row['submergedLiquidHeat_J'] for row in cases[0]['rows'])/sum(row['submergedLiquidHeat_J'] for row in case['rows'])-1)
    metrics['pressureResponse']=abs((a['pressureSurface_MPa']-p0)/(c['pressureSurface_MPa']-p0)-1)
    comparisons.append(dict(axis=label,relativeDifferences=metrics,passes=bool(max(metrics.values())<=.02)))
print(json.dumps(dict(scope='Full fixed shell with effective submerged convection; subcooled companion plus separately unqualified near-saturated wet-liquid challenge',
    mixedContactCheck=mixed,cases=cases,caseFailures=caseFailures,comparisons=comparisons,numericalScreenPassed=not caseFailures and all(v['passes'] for v in comparisons),nearSaturatedTopologyQualified=False,liveModelInstalled=False),allow_nan=False))
`
if(import.meta.main){
  const [source,owner,python,...extra]=Bun.argv.slice(2)
  if(!source||!owner||!python||extra.length)throw Error('Usage: pressurizer-submerged.ts source.md owner.md python')
  const doc=await Bun.file(owner).text(),joined=parseJoinedPressurizer(doc)
  const input={source:parsePressurizerBoundaries(await Bun.file(source).text()),pressure_MPa:parseSpatialBasis(doc).surfacePressure_MPa,phase:parsePhaseStorageBasis(doc),film:joined,joined,submerged:parseSubmergedBasis(doc)}
  const child=Bun.spawn([python,'-c',submergedCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(code)throw Error(err)
  console.log(JSON.stringify({input,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),calculationHash:createHash('sha256').update(submergedCalculation).digest('hex'),...JSON.parse(out)},null,2))
}
