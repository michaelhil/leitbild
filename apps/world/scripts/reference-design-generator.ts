/** Offline balanced machine engineering. No model registration or live plant. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({ lineVoltage_V: positive, frequency_Hz: positive,
  polePairs: z.number().int().positive(), base_VA: positive, referenceShaft_W: positive,
  sizingConversion: z.number().finite().gt(0).lt(1), reactance_pu: positive,
  fieldCurrent_A: positive, fieldCopper_W: positive, inductanceMargin: z.number().finite().gt(1),
  fieldDump_Ohm: positive, shaftInertia_s: positive }).strict()
export function parseGenerator(document: string) {
  const blocks = [...document.matchAll(/^```reference-generator\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-generator block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export function generatorParameters(b: ReturnType<typeof parseGenerator>) {
  const electricalSpeed = 2 * Math.PI * b.frequency_Hz
  const speed = electricalSpeed / b.polePairs
  const gridPower = b.referenceShaft_W * b.sizingConversion
  const phaseCurrent = gridPower / (Math.sqrt(3) * b.lineVoltage_V)
  const phaseVoltage = b.lineVoltage_V / Math.sqrt(3)
  const resistance = (b.referenceShaft_W - gridPower) / (3 * phaseCurrent ** 2)
  const reactance = b.reactance_pu * b.lineVoltage_V ** 2 / b.base_VA
  const statorInductance = reactance / electricalSpeed
  const emf = Math.sqrt(3) * Math.hypot(phaseVoltage + resistance * phaseCurrent, reactance * phaseCurrent)
  const mutual = emf / (electricalSpeed * b.fieldCurrent_A)
  const fieldInductance = b.inductanceMargin * mutual ** 2 / statorInductance
  const fieldResistance = b.fieldCopper_W / b.fieldCurrent_A ** 2
  const delta = Math.atan2(reactance * phaseCurrent, phaseVoltage + resistance * phaseCurrent)
  const angle = delta - Math.PI / 2
  const dCurrent = -Math.sqrt(3) * phaseCurrent * Math.sin(delta)
  const qCurrent = -Math.sqrt(3) * phaseCurrent * Math.cos(delta)
  const field = b.fieldCurrent_A
  return { speed, gridPower, phaseCurrent, resistance, statorInductance, mutual, fieldInductance,
    fieldResistance, fieldTime_s: fieldInductance / fieldResistance,
    inertia: 2 * b.shaftInertia_s * b.base_VA / speed ** 2, angle,
    initialFlux: [statorInductance * dCurrent + mutual * field,
      statorInductance * qCurrent, mutual * dCurrent + fieldInductance * field] }
}

/** Preserve field linkage during the declared passive zero-duration arc limit. */
export function generatorArcEnergy(statorInductance: number, mutual: number, fieldInductance: number,
  dCurrent: number, qCurrent: number) {
  if (![statorInductance, mutual, fieldInductance, dCurrent, qCurrent].every(Number.isFinite)
    || statorInductance <= 0 || fieldInductance <= 0 || statorInductance * fieldInductance <= mutual ** 2)
    throw Error('Generator inductance matrix is not positive definite')
  return .5 * (statorInductance - mutual ** 2 / fieldInductance) * dCurrent ** 2 + .5 * statorInductance * qCurrent ** 2
}

export const generatorCalculation = String.raw`
import json,math,sys
import numpy as np,scipy
from scipy.integrate import solve_ivp
d=json.load(sys.stdin);b=d['basis'];a=d['parameters'];checks=[]
Ls=a['statorInductance'];M=a['mutual'];Lf=a['fieldInductance'];Rs=a['resistance'];Rf=a['fieldResistance'];J=a['inertia'];p=b['polePairs'];wg=2*math.pi*b['frequency_Hz'];V=b['lineVoltage_V'];vf0=Rf*b['fieldCurrent_A'];D=Ls*Lf-M*M
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
def currents(flux):
 ld,lq,lf=flux
 return np.array([(Lf*ld-M*lf)/D,lq/Ls,(Ls*lf-M*ld)/D])
def magnetic(flux):return .5*float(np.dot(flux,currents(flux)))
def law(flux,speed,angle,vf,connected):
 id,iq,ifield=currents(flux);ld,lq,lf=flux
 vd=V*math.cos(angle);vq=-V*math.sin(angle)
 if not connected:raise ValueError('Open circuit uses its actual constrained field owner, not connected voltage')
 derivative=np.array([vd-Rs*id+p*speed*lq,vq-Rs*iq-p*speed*ld,vf-Rf*ifield])
 torque=p*M*ifield*iq;export=-(vd*id+vq*iq);input=vf*ifield;copper=Rs*(id*id+iq*iq)+Rf*ifield*ifield
 defect=float(np.dot(currents(flux),derivative))+copper+torque*speed-(input-export)
 return derivative,torque,export,input,copper,defect
require('positive definite physical magnetic storage',D>0 and Rs>0 and Rf>0)
nom=np.array(a['initialFlux']);omega0=a['speed'];theta0=a['angle'];tau0=b['referenceShaft_W']/omega0
rates=law(nom,omega0,theta0,vf0,True)
require('nominal steady phasor recovered without speed constraint',max(abs(rates[0]))<1e-8 and abs(rates[2]-a['gridPower'])<1e-5 and abs(rates[1]+tau0)<1e-7,export_W=rates[2],mechanical_W=-rates[1]*omega0,magnetic_J=magnetic(nom))
for f in [0.,.5,1.,1.5]:
 for speed in [0.,-.1*omega0,.8*omega0,omega0,1.2*omega0]:
  for angle in [-math.pi,-.5,0.,.5,math.pi]:
   # Nonzero opposing stator currents challenge mutual storage/work as well.
   id=f*13000.;iq=-f*27000.;ifield=b['fieldCurrent_A']*f
   flux=np.array([Ls*id+M*ifield,Ls*iq,M*id+Lf*ifield])
   r=law(flux,speed,angle,vf0,True)
   require('local mechanical terminal field copper ledger',abs(r[5])<1e-5,fieldRatio=f,speed_rad_s=speed,angle_rad=angle,defect_W=r[5])
# A finite imposed shaft torque is an apparatus boundary, not an achieved turbine.
cases=[]
matched=V/(p*omega0*M);matchedflux=np.array([M*matched,0,Lf*matched]);matchedvf=Rf*matched
fixtures=[('held-nominal',nom,omega0,theta0,vf0,tau0,1.),('matched-no-load-close',matchedflux,omega0,-math.pi/2,matchedvf,0.,.25),('phase-error-close',matchedflux,omega0,0.,matchedvf,0.,.25),('slip-error-close',matchedflux,1.01*omega0,-math.pi/2,matchedvf,0.,.25),('unexcited-close',np.zeros(3),omega0,-math.pi/2,0.,0.,.25),('shaft-torque-lost',nom,omega0,theta0,vf0,0.,1.),('zero-speed-close',matchedflux,0.,-math.pi/2,matchedvf,0.,.05),('negative-speed-close',matchedflux,-.1*omega0,-math.pi/2,matchedvf,0.,.05),('connected-field-dump',nom,omega0,theta0,0.,tau0,1.)]
for name,flux,speed,angle,vf,tau,duration in fixtures:
 y0=np.r_[flux,speed,angle,0.,0.,0.,0.]
 def rhs(t,y):
  actualvf=-b['fieldDump_Ohm']*currents(y[:3])[2] if name=='connected-field-dump' else vf
  derivative,te,pe,pf,q,defect=law(y[:3],y[3],y[4],actualvf,True)
  if abs(defect)>1e-4:raise ValueError('Local generator work ownership failed')
  return np.r_[derivative,(tau+te)/J,p*y[3]-wg,tau*y[3],pf,pe,q]
 samples=np.linspace(0,duration,101);out=solve_ivp(rhs,(0,duration),y0,method='Radau',rtol=1e-9,atol=1e-9,max_step=.002,t_eval=samples)
 require(name+' finite dynamic advance',out.success)
 e0=magnetic(flux)+.5*J*speed*speed
 defects=[magnetic(y[:3])+.5*J*y[3]*y[3]-e0-y[5]-y[6]+y[7]+y[8] for y in out.y.T]
 require(name+' total energy ledger',max(abs(np.array(defects)))<1.,maxDefect_J=max(abs(np.array(defects))))
 if name=='matched-no-load-close':require('matching actual no-load field produces no false current',max(np.linalg.norm(currents(y[:3])[:2]) for y in out.y.T)<1e-5)
 final=out.y[:,-1];cur=currents(final[:3]);lf=final[2];newfield=lf/Lf;newflux=np.array([M*newfield,0,lf]);heat=magnetic(final[:3])-magnetic(newflux)
 independent=.5*(Ls-M*M/Lf)*cur[0]**2+.5*Ls*cur[1]**2
 require(name+' passive opening and retained field linkage',heat>=-1e-7 and abs(heat-independent)<1e-7,breakerHeat_J=heat,fieldBefore_A=cur[2],fieldAfter_A=newfield)
 require(name+' rotor is not captured or reset at opening',final[3]==float(final[3]) and newflux[2]==final[2])
 cases.append(dict(name=name,endSpeed_rpm=final[3]*60/(2*math.pi),endAngle_rad=final[4],maxCurrent_A=max(np.linalg.norm(currents(y[:3])[:2])/math.sqrt(3) for y in out.y.T),arcHeat_J=heat,fieldAfter_A=newfield,gridEnergy_J=final[7],maximumLedgerDefect_J=max(abs(np.array(defects)))))
# Open field loss: actual finite dump resistor, zero stator current, unchanged shaft.
lf=nom[2];if0=lf/Lf;rd=b['fieldDump_Ohm'];duration=20.;iend=if0*math.exp(-(Rf+rd)*duration/Lf);released=.5*Lf*(if0*if0-iend*iend)
require('field dump retains and dissipates actual linkage energy',abs(released-released*Rf/(Rf+rd)-released*rd/(Rf+rd))<1e-8 and abs(iend)<abs(if0),initialCurrent_A=if0,endCurrent_A=iend,fieldCopper_J=released*Rf/(Rf+rd),dumpHeat_J=released*rd/(Rf+rd))
print(json.dumps(dict(checks=checks,cases=cases,parameters=a,dependencies=dict(scipy=scipy.__version__),scope='Balanced loss-bearing machine and passive fast arc limit; not plant startup, damper/asymmetric fault waveform, breaker rating, or protection selectivity')))
`

if (import.meta.main) {
  const [owner, python, output, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || !output || extra.length) throw Error('Usage: generator <owner.md> <research-python> <receipt.json>')
  const content = await Bun.file(owner).text()
  const basis = parseGenerator(content), parameters = generatorParameters(basis)
  const input = JSON.stringify({ basis, parameters })
  const process = Bun.spawn([python, '-c', generatorCalculation], { stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (code !== 0) throw Error(`Generator calculation failed: ${stderr}`)
  if (await Bun.file(owner).text() !== content) throw Error('Generator input changed during calculation')
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const receipt = { ownerSha256: sha(content), sourceSha256: sha(await Bun.file(import.meta.path).text()),
    inputSha256: sha(input), calculationSha256: sha(generatorCalculation), input: JSON.parse(input), result: JSON.parse(stdout) }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, checks: receipt.result.checks.length, cases: receipt.result.cases, parameters }))
}
