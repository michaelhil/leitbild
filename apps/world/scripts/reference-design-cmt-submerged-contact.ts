/** Offline constitutive/contact selection. No tank, source-path or escape-time solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis, tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'

const schema = z.object({ pressure_Pa: z.literal(5e6), contactVolume_m3: z.literal(.01),
  staticPressures_Pa: z.tuple([z.literal(1e6), z.literal(15e6)]),
  duration_s: z.literal(.1), initialVoids: z.tuple([z.literal(.1), z.literal(.4), z.literal(.9)]),
  subcoolings_K: z.tuple([z.literal(50), z.literal(2)]),
  sizeFactors: z.tuple([z.literal(.5), z.literal(1), z.literal(2)]),
  coldWitness: z.object({ pressure_Pa: z.literal(15202734.919352943), enthalpy_J_kg: z.literal(1286155.0442236066),
    elevation_m: z.literal(3), parentSha256: z.literal('ad606e4d156cb9b635bfbd3fbdeb8e6eaf21bd53e60b510ad57dcabe82136ca6') }).strict(),
  boronFraction: z.literal(.002), residualVaporFraction: z.literal(1e-6),
  coldHeaderPlanArea_m2: z.literal(4) }).strict()
export type SubmergedBasis = z.infer<typeof schema>
export function parseSubmergedBasis(doc: string) {
  const blocks = [...doc.matchAll(/^```reference-cmt-submerged\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-submerged block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function recipientConfinement(b: GeometryBasis, headerArea: number) {
  if (!(headerArea > 0 && Number.isFinite(headerArea))) throw new Error('Invalid header plan area')
  const g = tankGeometry(b), rb = b.bodyOuterDiameter_m / 2
  return [...b.ringElevations_m.map((z, i) => {
    const ro = Math.sqrt(g.shellR2(z)), area = g.area(z), perimeter = 2 * Math.PI * (ro + rb)
    return { name: `CMT.ring${i + 1}`, elevation_m: z, planArea_m2: area,
      solidPerimeter_m: perimeter, Dh_m: 4 * area / perimeter }
  }), { name: 'COLD.BAL', elevation_m: 3, planArea_m2: headerArea,
    solidPerimeter_m: 2 * Math.sqrt(Math.PI * headerArea), Dh_m: 2 * Math.sqrt(headerArea / Math.PI) }]
}
export const submergedCalculation = String.raw`
import json,sys,math,time,platform
import numpy as np
import CoolProp, CoolProp.CoolProp as C
import scipy
from scipy.integrate import solve_ivp
data=json.load(sys.stdin);b=data['basis'];p=b['pressure_Pa'];g=9.80665;start=time.monotonic()
def guard(ok,name):
    if not ok:raise ValueError(name)
def budget():guard(time.monotonic()-start<=90,'Frozen 90 s calculation budget')
Ts=C.PropsSI('T','P',p,'Q',0,'Water')
sat={q:{k:C.PropsSI(out,'P',p,'Q',q,'Water') for k,out in [('rho','Dmass'),('h','Hmass'),('u','Umass')]} for q in [0,1]}
sigma=C.PropsSI('surface_tension','P',p,'Q',0,'Water');dr=sat[0]['rho']-sat[1]['rho'];La=math.sqrt(sigma/(g*dr))
lf=C.AbstractState('HEOS','Water');lf.specify_phase(C.iphase_liquid)
vf=C.AbstractState('HEOS','Water');vf.specify_phase(C.iphase_gas)
def water(T,gas=False):
    st=vf if gas else lf;st.update(C.PT_INPUTS,p,T)
    return dict(T=T,rho=st.rhomass(),h=st.hmass(),u=st.umass(),cp=st.cpmass(),mu=st.viscosity(),k=st.conductivity())
v=water(Ts,True)
def closure(alpha,Dh,Tl,Tv,slip,factor=1.):
    budget();guard(0<=alpha<=1 and Dh>0 and factor>0 and all(math.isfinite(x) for x in [alpha,Dh,Tl,Tv,slip,factor]),'Constitutive arguments')
    guard(Dh>=1e-4/.9,'Confinement too small for selected size family')
    if alpha in [0,1]:return dict(area=0.,Hl=0.,Hv=0.,drag=0.,dragHeat=0.,d=0.,parts=[])
    l=water(Tl);vv=water(Tv,True)
    guard(l['rho']>vv['rho'] and Tl<=Ts+1e-8 and Tv>=Ts-1e-8,'Selected subcooled-liquid/saturated-or-superheated-vapor domain')
    d=min(max(2*La*factor,1e-4),.9*Dh);D=min(Dh,50*La);Cstar=4.5 if Dh<50*La else 16.
    speed=abs(slip);delta=l['rho']-vv['rho']
    # Low-throughflow DB threshold .3; not channel mass-flux interpolation in a radial recipient.
    a_ref=min(alpha,.5)
    a_db=6*a_ref/d if a_ref<=.3 else 6*.3/d*(1-a_ref)/.7
    a_lb=0. if a_ref<=.3 else Cstar/D*(a_ref-.3)/.7
    w=0. if alpha<=.5 else min((alpha-.5)/.25,1.)
    old_scale=1. if alpha<=.5 else 2*(1-alpha)
    ub_inf=math.sqrt(2)*(sigma*g*delta/l['rho']**2)**.25
    ub=ub_inf*(1-alpha)**1.39
    r=D/Dh;uc_inf=math.sqrt(2)/2*math.sqrt(g*delta*D/l['rho'])
    uc=uc_inf if r<.125 else 1.13*uc_inf*math.exp(-r) if r<.6 else .496*uc_inf/math.sqrt(r)
    ud_inf=.6*sigma**.316*(g*delta)**.228/(vv['rho']**.456*vv['mu']**.0879)
    ud=ud_inf*alpha**1.4
    Bf=(vv['h']-sat[1]['h'])/(sat[1]['h']-sat[0]['h'])
    guard(1+Bf>0,'Drop blowing factor domain')
    parts=[]
    for name,area,diam,terminal,carrier in [('DB',(1-w)*old_scale*a_db,d,ub,l),
        ('LB',(1-w)*old_scale*a_lb,D,uc,l),('drop',w*6*(1-alpha)/d,d,ud,vv)]:
        if area==0:continue
        Re=carrier['rho']*speed*diam/carrier['mu'];Reheat=carrier['rho']*min(speed,terminal)*diam/carrier['mu']
        Pr=carrier['cp']*carrier['mu']/carrier['k']
        if name=='drop':
            hl=2*math.pi**2*l['k']/diam;hv=vv['k']/diam*(2+.57*math.sqrt(Reheat)*Pr**(1/3))/(1+Bf)**.7
        else:hl=l['k']/diam*(2+.6*math.sqrt(Reheat)*Pr**(1/3));hv=1000.
        # Actual-slip ORIGINAL force, not RELAP channel profile drag. Analytic viscous zero limit.
        viscous=3*area*carrier['mu']/diam*(1+.15*Re**.687)*speed if Re<=1000 else .5*carrier['rho']*.44*(area/4)*speed**2
        Cd_terminal=4*delta*g*diam/(3*carrier['rho']*terminal**2)
        distorted=.5*carrier['rho']*Cd_terminal*(area/4)*speed**2
        magnitude=max(viscous,distorted);force=-math.copysign(magnitude,slip) if speed else 0.
        parts.append(dict(name=name,area=area,diameter_m=diam,Hl=hl*area,Hv=hv*area,
            terminal_m_s=terminal,carrierDensity_kg_m3=carrier['rho'],Re=Re,drag=force,dragHeat=-force*slip))
    return dict(area=sum(x['area'] for x in parts),Hl=sum(x['Hl'] for x in parts),Hv=sum(x['Hv'] for x in parts),
        drag=sum(x['drag'] for x in parts),dragHeat=sum(x['dragHeat'] for x in parts),d=d,parts=parts)
Dh=data['confinements'][0]['Dh_m']
constitutive=[]
for recipient in data['confinements']:
    for alpha in [0.,.1,.3,.4,.5,.625,.75,.9,1.]:
        for slip in [-1.,0.,1.]:
            c=closure(alpha,recipient['Dh_m'],Ts-50,Ts,slip)
            guard(all(math.isfinite(c[k]) and c[k]>=0 for k in ['area','Hl','Hv','dragHeat']),'Finite positive constituent')
            opposite=closure(alpha,recipient['Dh_m'],Ts-50,Ts,-slip)
            guard(c['drag']==-opposite['drag'] and c['dragHeat']==opposite['dragHeat'],'Actual reversed drag')
            ul=.2;uv=ul+slip;vaporWork=c['drag']*uv;liquidWork=-vaporWork
            kineticRate=c['drag']*(uv-ul);internalRate=-c['drag']*slip
            guard(abs(vaporWork+liquidWork)<1e-12 and abs(kineticRate+internalRate)<1e-10,'Reciprocal drag work and internal destination')
            constitutive.append(dict(recipient=recipient['name'],alpha=alpha,slip_m_s=slip,**c,
                vaporEnergyRate_W_m3=vaporWork,liquidEnergyRate_W_m3=liquidWork,
                totalKineticRate_W_m3=kineticRate,liquidInternalRate_W_m3=internalRate))
continuity=[]
for alpha in [.3,.5,.75]:
    lo=closure(alpha-1e-9,Dh,Ts-50,Ts,1);hi=closure(alpha+1e-9,Dh,Ts-50,Ts,1)
    errors={k:abs(hi[k]-lo[k])/max(abs(lo[k]),abs(hi[k]),1.) for k in ['area','Hl','Hv','drag','dragHeat']}
    guard(max(errors.values())<1e-6,'Undisclosed void-transition discontinuity')
    continuity.append(dict(alpha=alpha,relativeJumps=errors))
# C* is an explicitly retained source discontinuity; no smoothness assertion.
confinementJump=[dict(Dh_m=x,**closure(.4,x,Ts-50,Ts,1)) for x in [50*La*(1-1e-9),50*La*(1+1e-9)]]
heat=[]
for Tl,Tv in [(Ts-50,Ts),(Ts-2,Ts+20),(Ts,Ts+20)]:
    c=closure(.4,Dh,Tl,Tv,1);ql=c['Hl']*(Tl-Ts);qv=c['Hv']*(Tv-Ts)
    gamma=(ql+qv)/(sat[1]['h']-sat[0]['h'])
    liquidH=-gamma*sat[0]['h']-ql;vaporH=gamma*sat[1]['h']-qv
    guard(abs(liquidH+vaporH)<1e-7*max(1,abs(ql)+abs(qv)),'Two-sided Stefan energy')
    heat.append(dict(Tl_K=Tl,Tv_K=Tv,ql_W_m3=ql,qv_W_m3=qv,gamma_kg_m3s=gamma,
        liquidEnthalpyRate_W_m3=liquidH,vaporEnthalpyRate_W_m3=vaporH,residual_W_m3=liquidH+vaporH))
contacts=[]
for alpha in b['initialVoids']:
  for subcool in b['subcoolings_K']:
    for factor in b['sizeFactors']:
      T0=Ts-subcool;l0=water(T0);V0=b['contactVolume_m3'];ml0=(1-alpha)*V0*l0['rho'];mv0=alpha*V0*v['rho']
      total=ml0+mv0;H0=ml0*l0['h']+mv0*v['h'];B=b['boronFraction']*ml0
      def rhs(t,y):
        mv,T=y;ml=total-mv;l=water(T);Vl=ml/l['rho'];Vv=mv/v['rho'];V=Vl+Vv
        c=closure(Vv/V,Dh,T,Ts,0,factor);ql=c['Hl']*V*(T-Ts)
        gamma=ql/(sat[1]['h']-sat[0]['h'])
        # H_v'=h_g M_v': saturated gas follows its native enthalpy equation, no thermostat heat.
        return [gamma,-gamma*(v['h']-l['h'])/(ml*l['cp'])]
      def residual_gas(t,y):return y[0]-b['residualVaporFraction']*mv0
      residual_gas.terminal=True;residual_gas.direction=-1
      sol=solve_ivp(rhs,[0,b['duration_s']],[mv0,T0],rtol=1e-8,atol=[mv0*1e-10,1e-9],max_step=.001,events=residual_gas,dense_output=True)
      guard(sol.success,'Contact integrator status')
      history=[]
      for t in sorted(set([0.,float(sol.t[-1])]+[x for x in [.001,.01,.05,.1] if x<sol.t[-1]])):
        mv,T=map(float,sol.sol(t));ml=total-mv;l=water(T);Vl=ml/l['rho'];Vv=mv/v['rho'];V=Vl+Vv
        H=ml*l['h']+mv*v['h'];U=ml*l['u']+mv*v['u'];U0=ml0*l0['u']+mv0*v['u']
        residual=U-U0+p*(V-V0)
        guard(mv>0 and ml>=ml0 and T>=T0-1e-8 and T<=Ts+1e-8,'Finite retained source-off phases')
        guard(abs(H-H0)<.01 and abs(residual)<.01,'Isobaric native energy/piston work')
        history.append(dict(t_s=t,Ml_kg=ml,Mv_kg=mv,Tl_K=T,Tv_K=Ts,Vl_m3=Vl,Vv_m3=Vv,
            U_J=U,boron_kg=B,liquidBoronFraction=B/ml,remainingSteamFraction=mv/mv0,
            externalWorkByFluid_J=p*(V-V0),enthalpyResidual_J=H-H0,nativeEnergyWorkResidual_J=residual))
      contacts.append(dict(alpha0=alpha,subcooling0_K=subcool,sizeFactor=factor,initialMl_kg=ml0,initialMv_kg=mv0,
          initialU_J=ml0*l0['u']+mv0*v['u'],initialH_J=H0,initialVolume_m3=V0,initialBoron_kg=B,
          stoppedAtRetainedGas=bool(len(sol.t_events[0])),nfev=sol.nfev,history=history))
# Actual incoming momentum/total-H is retained independently of the source-off thermal subset.
receipts=[]
for speed in [-1.,1.]:
    M=.01;P=.003;m=.002;z=11.925;E=M*v['u']+P*P/(2*M)+M*g*z;Ht=v['h']+.5*speed**2+g*z
    M1=M+m;P1=P+m*speed;E1=E+m*Ht;K1=P1*P1/(2*M1)
    # Shared outgoing donor has the same signed increments, not an independent receiver energy.
    receipts.append(dict(donorVelocity_m_s=speed,receivedMass_kg=m,receivedMomentum_kg_m_s=m*speed,
        receivedTotalEnergy_J=m*Ht,finalVaporM_kg=M1,finalVaporP_kg_m_s=P1,
        finalVaporE_J=E1,finalVaporU_J=E1-K1-M1*g*z,liquidBoronChange_kg=0.,
        massPairResidual_kg=(M1-M)-m,momentumPairResidual_kg_m_s=(P1-P)-m*speed,
        energyPairResidual_J=(E1-E)-m*Ht))
guard(all(abs(x['massPairResidual_kg'])<1e-12 and abs(x['momentumPairResidual_kg_m_s'])<1e-12
    and abs(x['energyPairResidual_J'])<1e-8 for x in receipts),'Signed native receipt ledger')
contactSaturation=dict(p_Pa=p,T_K=Ts,sigma_N_m=sigma,La_m=La,liquid=sat[0],vapor=sat[1])
# Frozen high/low-pressure constitutive admission only; no additional contact histories.
pressureDomains=[]
for p in b['staticPressures_Pa']:
    Ts=C.PropsSI('T','P',p,'Q',0,'Water')
    sat={q:{k:C.PropsSI(out,'P',p,'Q',q,'Water') for k,out in [('rho','Dmass'),('h','Hmass'),('u','Umass')]} for q in [0,1]}
    sigma=C.PropsSI('surface_tension','P',p,'Q',0,'Water');La=math.sqrt(sigma/(g*(sat[0]['rho']-sat[1]['rho'])))
    Tl=Ts-2;Tv=Ts+20
    for alpha in b['initialVoids']:
        for slip in [0.,1.]:
            c=closure(alpha,Dh,Tl,Tv,slip)
            guard(all(math.isfinite(c[k]) and c[k]>=0 for k in ['area','Hl','Hv','dragHeat']),'Static pressure extension domain')
            pressureDomains.append(dict(p_Pa=p,Ts_K=Ts,Tl_K=Tl,Tv_K=Tv,alpha=alpha,slip_m_s=slip,**c))
    zero=closure(.4,Dh,Ts,Ts,0)
    # The old liquid-front comparison stopped at 290 C; it is not a source-temperature clamp.
    ql=zero['Hl']*(Ts-Ts);qv=zero['Hv']*(Ts-Ts)
    guard(ql+qv==0 and zero['drag']==0,'Zero thermal/slip driving limit')
    pressureDomains.append(dict(p_Pa=p,Ts_K=Ts,alpha=.4,zeroDrivePhaseRate_kg_m3s=(ql+qv)/(sat[1]['h']-sat[0]['h']),
        zeroDriveDrag_N_m3=zero['drag'],withinEarlierLiquidFrontComparison=bool(Ts<=563.15)))
# One actual frozen COLD source witness, not an arbitrary further pressure sweep.
cold=b['coldWitness'];p=cold['pressure_Pa'];Ts=C.PropsSI('T','P',p,'Q',0,'Water')
sat={q:{k:C.PropsSI(out,'P',p,'Q',q,'Water') for k,out in [('rho','Dmass'),('h','Hmass'),('u','Umass')]} for q in [0,1]}
sigma=C.PropsSI('surface_tension','P',p,'Q',0,'Water');La=math.sqrt(sigma/(g*(sat[0]['rho']-sat[1]['rho'])))
Tl=C.PropsSI('T','P',p,'Hmass',cold['enthalpy_J_kg'],'Water');l=water(Tl)
guard(C.PhaseSI('P',p,'Hmass',cold['enthalpy_J_kg'],'Water')=='liquid' and abs(l['h']-cold['enthalpy_J_kg'])<.1,'Actual COLD local-state witness')
cc=closure(.4,data['confinements'][-1]['Dh_m'],Tl,Ts+20,1)
guard(all(math.isfinite(cc[k]) and cc[k]>=0 for k in ['area','Hl','Hv','dragHeat']),'Actual COLD coefficient domain')
coldDomain=dict(**cold,Tl_K=Tl,Tv_K=Ts+20,Ts_K=Ts,forwardEnthalpyResidual_J_kg=l['h']-cold['enthalpy_J_kg'],
    forwardEnthalpyTolerance_J_kg=.1,alpha=.4,slip_m_s=1.,**cc)
json.dump(dict(saturation=contactSaturation,
    constitutive=constitutive,voidTransitions=continuity,confinementJump=confinementJump,
    twoSidedHeat=heat,sourceOffContacts=contacts,signedNativeReceipts=receipts,staticPressureDomains=pressureDomains,actualColdDomain=coldDomain,
    constitutiveContactAdmitted=True,tankPressureResponseQualified=False,capArrivalQualified=False,
    versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__)),sys.stdout,indent=2,allow_nan=False)
`
if (import.meta.main) {
  const [geometryPath, ownerPath, python, output] = process.argv.slice(2)
  if (!geometryPath || !ownerPath || !python || !output) throw new Error('Usage: submerged-contact.ts geometry.md transport.md python output.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const sourceHash = hash(await Bun.file(import.meta.path).text())
  const geometrySourcePath = new URL('./reference-design-cmt-geometry.ts', import.meta.url)
  const geometrySourceHash = hash(await Bun.file(geometrySourcePath).text())
  const geometry = parseGeometryBasis(await Bun.file(geometryPath).text())
  const basis = parseSubmergedBasis(await Bun.file(ownerPath).text())
  const confinements = recipientConfinement(geometry, basis.coldHeaderPlanArea_m2)
  const input = { geometry, basis, confinements }
  const child = Bun.spawn([python, '-c', submergedCalculation], { stdin: new Response(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(stderr)
  if (sourceHash !== hash(await Bun.file(import.meta.path).text()) || geometrySourceHash !== hash(await Bun.file(geometrySourcePath).text()))
    throw new Error('Source changed during calculation; receipt not published')
  await Bun.write(output, JSON.stringify({ sourceHash,
    calculationHash: hash(submergedCalculation), geometrySourceHash,
    inputHash: hash(JSON.stringify(input)), ...input, ...JSON.parse(stdout) }, null, 2) + '\n')
}
