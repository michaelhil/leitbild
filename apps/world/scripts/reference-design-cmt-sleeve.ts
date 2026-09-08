/** Provisional sleeve geometry and static hydraulic screen, not a thermal redistribution model. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { apertureDefinitions, parseApertureBasis } from './reference-design-cmt-inlet'

const finite = z.number().finite()
const positive = finite.positive()
const sleeveSchema = z.object({
  innerDiameter_m: positive, wall_m: positive, bottom_m: finite, top_m: finite,
  supportWidth_m: positive, supportHeight_m: positive, supportBottom_m: finite,
  darcyFactor: positive, roofTurnCoefficient: positive,
  entryCoefficient: positive, exitCoefficient: positive,
  availableHead_Pa: positive,
}).strict().superRefine((s, c) => {
  if (s.innerDiameter_m <= .41 || s.bottom_m >= 11.725 || s.bottom_m <= 6 ||
    s.top_m <= 11.975 || s.top_m >= 12 || s.supportBottom_m <= 11.925 + .06153846153846154 / 2 ||
    s.supportBottom_m + s.supportHeight_m >= 11.975) {
    c.addIssue({ code: 'custom', message: 'Sleeve or supports conflict with actual body, aperture or roof' })
  }
})

export function parseSleeveBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-sleeve\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-sleeve numeric block')
  return { ...parseApertureBasis(document), sleeve: sleeveSchema.parse(JSON.parse(blocks[0]![1]!)) }
}

export const sleeveCalculation = apertureDefinitions + String.raw`
s=b['sleeve'];D=s['innerDiameter_m'];wall=s['wall_m'];z0=s['bottom_m'];z1=s['top_m'];height=z1-z0
full=math.pi*D**2/4;annulus=math.pi*(D**2-.41**2)/4;feedAnnulus=math.pi*(D**2-.22**2)/4
supports=3*s['supportWidth_m']*(D-.41)/2;minAnnulus=annulus-supports
roofArea=math.pi*D*(12-z1);bottomArea=full
metal=math.pi*((D+2*wall)**2-D**2)/4*height+supports*s['supportHeight_m']
innerWater=full*(11.725-z0)+annulus*.25+feedAnnulus*(z1-11.975)-supports*s['supportHeight_m']
if min(roofArea,bottomArea,minAnnulus,innerWater,60-innerWater)<=0:raise ValueError('Nonpositive actual passage or inventory')
# The existing header owns the short .20 m feed inside this roof-side interval.
headerInsideSleeve=math.pi*.20**2/4*(z1-11.975)
feedMetalInsideSleeve=math.pi*(.22**2-.20**2)/4*(z1-11.975)
if headerInsideSleeve>=headerVolume:raise ValueError('Feed geometry exceeds retained header inventory')
if feedMetalInsideSleeve>=.02:raise ValueError('Feed metal exceeds existing hardware allocation')
ref=water(b['pressure_MPa']*1e6,563.15);allHoleArea=30*math.pi*radius**2
oldHoleLoss=25**2/(2*ref['rho']*(b['coefficient']*allHoleArea)**2)
feedK=(2000-oldHoleLoss)/25**2
if feedK<=0:raise ValueError('No positive unchanged feed resistance')

def path_terms(upper,outward,turn):
    # Static manifold screen: small distributed friction is lumped at the outlets.
    # Each term retains its own area. No extra impact loss is added to effective Cd.
    terminal=s['exitCoefficient'] if outward else s['entryCoefficient']
    if upper:
        return [('roof_turn',turn,roofArea),('roof_terminal',terminal,roofArea),
          ('upper_annular_friction',s['darcyFactor']*(11.975-11.85)/(D-.41),minAnnulus)]
    return [('bottom_terminal',terminal,bottomArea),
      ('lower_annular_friction',s['darcyFactor']*(11.85-11.725)/(D-.41),annulus),
      ('lower_open_friction',s['darcyFactor']*(11.725-z0)/D,full),
      ('area_step',((1-annulus/full)**2 if outward else s['entryCoefficient']),annulus)]

def outlet(ps,Ts,pr,Tr,upper,turn):
    z=z1 if upper else z0;p1=pressure(ps,Ts,z);p2=pressure(pr,Tr,z);dp=p1-p2
    donor=water(p1,Ts) if dp>=0 else water(p2,Tr)
    terms=path_terms(upper,dp>=0,turn);R=sum(k/(2*donor['rho']*a*a) for _,k,a in terms)
    m=math.copysign(math.sqrt(abs(dp)/R),dp)
    return dict(flow_kg_s=m,pressureDifference_Pa=dp,donorDensity_kg_m3=donor['rho'],
      losses=[dict(name=name,coefficient=k,area_m2=a,velocity_m_s=m/(donor['rho']*a),
        loss_Pa=k*m*m/(2*donor['rho']*a*a)) for name,k,a in terms],
      dissipatedPower_W=m*dp/donor['rho'])

def stationary(name,Tp,Ts,Tr,head,turn):
    pr=b['pressure_MPa']*1e6;upstream=pr+head
    def state(x,n=16):
        pp,ps=pr+np.asarray(x)*1000
        f=aperture_flux(pp,Tp,ps,Ts,Ts,11.85,b['coefficient'],n)
        a=outlet(ps,Ts,pr,Tr,True,turn);c=outlet(ps,Ts,pr,Tr,False,turn)
        rho=water(upstream,Tp)['rho'] if f['net']>=0 else water(pp,Tp)['rho']
        dpFeed=feedK*f['net']*abs(f['net'])*ref['rho']/rho
        residual=np.array([(f['net']-a['flow_kg_s']-c['flow_kg_s'])/25,(upstream-pp-dpFeed)/1000])
        return residual,dict(name=name,plenum_C=Tp-273.15,sleeve_C=Ts-273.15,resident_C=Tr-273.15,
          upstreamHead_Pa=head,roofTurnCoefficient=turn,plenumOffset_Pa=pp-pr,sleeveOffset_Pa=ps-pr,
          feedLoss_Pa=dpFeed,apertures=f,upper=a,lower=c)
    solution=root(lambda x:state(x)[0],[head/2000,0.],options=dict(xtol=1e-10))
    rr,result=state(solution.x)
    if not np.all(np.isfinite(solution.x)) or not np.all(np.isfinite(rr)) or max(abs(rr))>1e-7:
        raise ValueError(dict(case=name,residual=rr.tolist(),message=str(solution.message)))
    finer=state(solution.x,32)[1]['apertures']
    error=max(abs(finer[k]-result['apertures'][k]) for k in ['net','outflow','inflow'])
    if error>1e-6:raise ValueError('Aperture quadrature fails unchanged-state screen')
    if min(result['upper']['dissipatedPower_W'],result['lower']['dissipatedPower_W']) < -1e-9:
        raise ValueError('Negative outlet dissipation')
    result.update(scaledResidual=rr.tolist(),nfev=solution.nfev,quadratureFlowDifference_kg_s=error)
    return result

def bare_reference(case):
    # Same prescribed source/resident boundaries, with no sleeve thermal field.
    pr=b['pressure_MPa']*1e6;head=case['upstreamHead_Pa'];Tp=case['plenum_C']+273.15;Tr=case['resident_C']+273.15
    def state(offset,n=16):
        pp=pr+offset;f=aperture_flux(pp,Tp,pr,Tr,Tr,11.85,b['coefficient'],n)
        rho=water(pr+head,Tp)['rho'] if f['net']>=0 else water(pp,Tp)['rho']
        feed=feedK*f['net']*abs(f['net'])*ref['rho']/rho
        return head-offset-feed,f
    x=brentq(lambda x:state(x)[0],-10000.,10000.,xtol=1e-6)
    residual,f=state(x);f32=state(x,32)[1]
    error=max(abs(f[k]-f32[k]) for k in ['net','outflow','inflow'])
    if abs(residual)>1e-4 or error>1e-6:raise ValueError('Bare reference residual or quadrature failure')
    return dict(name=case['name'],plenumOffset_Pa=x,pressureResidual_Pa=residual,apertures=f,
      quadratureFlowDifference_kg_s=error,sleeveMinusBareNet_kg_s=case['apertures']['net']-f['net'])

cases=[stationary('matched',563.15,563.15,563.15,s['availableHead_Pa'],s['roofTurnCoefficient']),
  stationary('hot_passage_cold_resident',563.15,563.15,313.15,s['availableHead_Pa'],s['roofTurnCoefficient']),
  stationary('cold_passage_hot_resident',313.15,313.15,563.15,s['availableHead_Pa'],s['roofTurnCoefficient']),
  stationary('zero_head_hot_passage',563.15,563.15,313.15,0.,s['roofTurnCoefficient']),
  stationary('matched_reverse_head',563.15,563.15,563.15,-s['availableHead_Pa'],s['roofTurnCoefficient'])]
bare=[bare_reference(case) for case in cases]
routeSizing=[]
for upper in [True,False]:
    terms=path_terms(upper,True,s['roofTurnCoefficient']);extra=sum(k*25**2/(2*ref['rho']*a*a) for _,k,a in terms)
    routeSizing.append(dict(route='all_upper' if upper else 'all_lower',flow_kg_s=25,addedLoss_Pa=extra,
      totalFeedApertureAndRouteLoss_Pa=2000+extra,terms=[dict(name=n,area_m2=a,coefficient=k) for n,k,a in terms]))
sensitivities=[stationary('matched_turn_sensitivity',563.15,563.15,563.15,s['availableHead_Pa'],k) for k in [.5,2.]]
geometry=dict(sleeveFreeWater_m3=innerWater,remainingResidentFreeWater_m3=60-innerWater,
  addedMetal_m3=metal,newCombinedEnvelope_m3=60.07+metal,roofArea_m2=roofArea,bottomArea_m2=bottomArea,
  minimumAnnularArea_m2=minAnnulus,headerWaterInsideSleeve_m3=headerInsideSleeve,
  feedWaterDiameter_m=.20,feedOuterDiameter_m=.22,feedMetalFromExistingAllocation_m3=feedMetalInsideSleeve,
  annularRadialClearance_m=(D-.41)/2,clearanceInHoleDiameters=(D-.41)/(2*b['holeDiameter_m']),
  roofClearance_m=12-z1,topHoleRoofClearance_m=12-max(b['ringElevations_m'])-radius)
print(json.dumps(dict(scope='Static provisional sleeve feasibility; imposed thermal profiles, not finite receipt or hardware adoption',
  geometry=geometry,oldFeedReferenceLoss_Pa=2000-oldHoleLoss,oldApertureReferenceLoss_Pa=oldHoleLoss,
  routeSizing=routeSizing,cases=cases,bareReferences=bare,turnSensitivity=sensitivities,
  finiteThermalTransportImplemented=False,hardwareAdopted=False)))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: cmt-sleeve.ts owner.md python')
  const input = parseSleeveBasis(await Bun.file(owner).text())
  const child = Bun.spawn([python, '-c', sleeveCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit',
  })
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('Sleeve feasibility calculation failed')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)),
    calculationHash: hash(sleeveCalculation), sourceHash: hash(await Bun.file(import.meta.path).text()),
    ...JSON.parse(output) }, null, 2))
}
