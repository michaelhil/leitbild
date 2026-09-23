/** Offline secondary receiving/work selection; no cycle trajectory or live model. */
import { createHash } from 'node:crypto'
import { runCycle } from './reference-design-cycle'

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import minimize_scalar
cycle=json.loads(sys.argv[1]);checks=[]
def check(name,value,bound):
    if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
    checks.append(dict(name=name,value=value,bound=bound))
def state(p,x,V):
    rho=P('D','P',p,'Q',x,'Water');u=P('U','P',p,'Q',x,'Water')
    return dict(p=p,quality=x,V=V,M=rho*V,U=rho*V*u,h=P('H','P',p,'Q',x,'Water'),s=P('S','P',p,'Q',x,'Water'))
def recovered(M,U,V):
    rho=M/V;u=U/M
    p=P('P','D',rho,'U',u,'Water');T=P('T','D',rho,'U',u,'Water')
    if p<=0 or T<=0:raise ValueError('Nonphysical finite receiver')
    return dict(M=M,U=U,V=V,p=p,T=T,quality=P('Q','D',rho,'U',u,'Water'))
def nozzle(p,h,s,back):
    if back==p:return dict(flux=0.,criticalPressure=p)
    if back>p:raise ValueError('Caller must choose actual higher-pressure donor')
    def flux(trial):
        if trial==p:return 0.
        ht=P('H','P',trial,'S',s,'Water');work=h-ht
        if work < -1e-5:raise ValueError('Negative native nozzle work')
        return P('D','P',trial,'S',s,'Water')*math.sqrt(2*max(0.,work))
    opt=minimize_scalar(lambda q:-flux(q),bounds=(back,p),method='bounded')
    if not opt.success:raise ValueError('Nozzle search failed')
    g,pc=max([(flux(back),back),(flux(opt.x),opt.x),(0.,p)])
    return dict(flux=g,criticalPressure=pc)
def parcel(name,left,right,forward,eta):
    donor,receiver=(left,right) if forward else (right,left)
    if donor['p']<=receiver['p']:raise ValueError('Fixture does not have actual driving pressure')
    his=P('H','P',receiver['p'],'S',donor['s'],'Water')
    hout=donor['h']-eta*(donor['h']-his) if forward else donor['h']
    amount=1.;work=amount*(donor['h']-hout)
    source=recovered(donor['M']-amount,donor['U']-amount*donor['h'],donor['V'])
    destination=recovered(receiver['M']+amount,receiver['U']+amount*hout,receiver['V'])
    check(name+' finite total mass',source['M']+destination['M']-donor['M']-receiver['M'],1e-9)
    check(name+' fluid plus extracted work',source['U']+destination['U']+work-donor['U']-receiver['U'],1e-4)
    receivedS=P('S','P',receiver['p'],'H',hout,'Water');ds=receivedS-donor['s']
    if ds < -1e-7:raise ValueError((name,'Transferred purewater entropy decreases',ds))
    if not forward:check(name+' no reverse interval shaft work',work,0.)
    if destination['p']==receiver['p']:raise ValueError('Finite receiver was reset to original pressure')
    return dict(name=name,forward=forward,amount_kg=amount,eta=eta if forward else None,donor=donor,receiver=receiver,receivedEnthalpy=hout,receivedFaceQuality=P('Q','P',receiver['p'],'H',hout,'Water'),specificEntropyIncrease=ds,intervalFluidWork_J=work,sourceAfter=source,receiverAfter=destination,capacityPerEffectiveArea=nozzle(donor['p'],donor['h'],donor['s'],receiver['p']))
eta=cycle['basis']['HPTurbineEfficiency']
rows=[parcel('wet forward HP',state(5.96e6,.8,10),state(4e6,.9,20),True,eta),
      parcel('liquid forward limit',state(5.96e6,0,10),state(4e6,.9,20),True,eta),
      parcel('passive reversed HP',state(.5e6,.9,10),state(.8e6,.2,20),False,eta)]
# A sizing loss only: initial finite SEP and RH retain equal0.8MPa and zero flow.
psep=cycle['basis']['separatorPressure_MPaAbs']*1e6;rhSizingPressure=.995*psep
steamH=P('H','P',psep,'Q',1,'Water');steamS=P('S','P',psep,'Q',1,'Water')
totalSteam=cycle['flows']['SG_total_kg_s'];lpFraction=cycle['flows']['LP_inlet_fraction'];m=totalSteam*lpFraction
sized=nozzle(psep,steamH,steamS,rhSizingPressure);area=m/sized['flux']
check('sized SEP to RH capacity',area*sized['flux']-m,1e-9)
check('equal prepared pressure gives zero flow',area*nozzle(psep,steamH,steamS,psep)['flux'],0.)
reheatFraction=(1-cycle['flows']['reheat_fraction']-cycle['flows']['high_heater_fraction'])*cycle['quality']['HP_separator_inlet']-cycle['flows']['separator_heater_fraction']
check('H3 extraction excluded from RH process flow',reheatFraction-lpFraction,1e-12)
print(json.dumps(dict(scope='Purewater fixed-property-packet transactions and SEP/RH passive-link sizing; no coupled flow, NC, turbine-damage or rotor-torque calibration.',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),fixtures=rows,sepRh=dict(referenceFlow_kg_s=m,LPfraction=lpFraction,SGtotal_kg_s=totalSteam,sourcePressure=psep,sizingReceiverPressure=rhSizingPressure,initialReceiverPressure=psep,CdA_m2=area,nozzle=sized,H3fraction=cycle['flows']['separator_heater_fraction'],initialFlow_kg_s=0.),checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const [cycleOwner, python] = process.argv.slice(2)
  if (!cycleOwner || !python) throw new Error('Usage: <cycle basis document> <research python>')
  const paths = [cycleOwner, new URL('./reference-design-cycle.ts', import.meta.url).pathname, import.meta.path]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const cycle = await runCycle(before[0]!, python)
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(cycle)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw new Error(err)
  for (let i = 0; i < paths.length; i++) if (await Bun.file(paths[i]!).text() !== before[i]) throw new Error('Source changed during calculation')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ sources: paths.map((path, i) => ({ path, sha256: hash(before[i]!) })), cycle: { inputSha256: cycle.inputSha256, calculationSha256: cycle.calculationSha256, dependencies: cycle.dependencies }, calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2))
}
