/** Offline native wave/contact feasibility; no plant advancement or runtime. */
import { createHash } from 'node:crypto'

const calculation = String.raw`
import json,sys,math,scipy,CoolProp
import CoolProp.CoolProp as C
import numpy as np
from scipy.integrate import quad
from scipy.optimize import brentq,least_squares,minimize_scalar
baseline=json.loads(sys.argv[1]);A=baseline['inputs']['boreArea_m2'];CdA=baseline['calibration'][0]['CdA'];checks=[]
def check(name,value,bound):
    if not math.isfinite(value) or abs(value)>bound: raise ValueError((name,value,bound))
    checks.append(dict(name=name,value=value,bound=bound))
def ph(p,h):
    return dict(p=p,h=h,rho=C.PropsSI('D','P',p,'H',h,'Water'),s=C.PropsSI('S','P',p,'H',h,'Water'),T=C.PropsSI('T','P',p,'H',h,'Water'),quality=C.PropsSI('Q','P',p,'H',h,'Water'))
def pt(p,T,u=0):
    out=ph(p,C.PropsSI('H','P',p,'T',T,'Water'));out['u']=u
    out['c']=C.PropsSI('A','P',p,'T',T,'Water');return out
def acoustic(p,s):
    q=C.PropsSI('Q','P',p,'S',s,'Water')
    if 0<=q<=1: raise ValueError(('Two-phase wave outside this first feasibility comparison',p,q))
    return C.PropsSI('A','P',p,'S',s,'Water')
def trace_sound(trace):
    if not 0<=trace['quality']<=1:return acoustic(trace['p'],trace['s'])
    p=trace['p'];s=trace['s'];dp=p*1e-5
    drho=(C.PropsSI('D','P',p+dp,'S',s,'Water')-C.PropsSI('D','P',p-dp,'S',s,'Water'))/(2*dp)
    if drho<=0:raise ValueError('Nonpositive equilibrium trace sound speed')
    return math.sqrt(1/drho)
def wave(interior,p,side):
    # side=-1: wave into left interior; +1: wave into right interior.
    p0=interior['p'];h0=interior['h'];v0=1/interior['rho'];s0=interior['s']
    if abs(p-p0)<=4*max(math.ulp(p),math.ulp(p0)):
        return {**interior,'kind':'zero wave','speed':interior['u']+side*interior['c'],'headSpeed':interior['u']+side*interior['c']}
    if p<=p0:
        h=C.PropsSI('H','P',p,'S',s0,'Water');out=ph(p,h)
        integral=quad(lambda x:1/(C.PropsSI('D','P',x,'S',s0,'Water')*acoustic(x,s0)),p0,p,epsabs=1e-9,epsrel=1e-9)[0]
        out['u']=interior['u']+side*integral;out['kind']='rarefaction'
        out['speed']=out['u']+side*acoustic(p,s0)
        out['headSpeed']=interior['u']+side*interior['c']
    else:
        dp=p-p0
        def hugoniot(h): return h-h0-.5*dp*(v0+1/ph(p,h)['rho'])
        h=brentq(hugoniot,h0,h0+2*dp*v0+1,xtol=1e-7);out=ph(p,h)
        dv=v0-1/out['rho']
        if dv<=0: raise ValueError('Compression wave has nonpositive density response')
        out['u']=interior['u']+side*math.sqrt(dp*dv);out['kind']='shock'
        out['speed']=interior['u']+side*math.sqrt(dp/dv)/interior['rho']
        out['hugoniotResidual']=hugoniot(h)
        out['headSpeed']=out['speed']
    if 0<=out['quality']<=1:raise ValueError('Phase-changing outgoing wave outside selected comparison')
    return out
def nozzle(H,s,pback):
    p0=C.PropsSI('P','H',H,'S',s,'Water')
    if pback>=p0:return 0.,p0
    def flux(p):
        if p==p0:return 0.
        h=C.PropsSI('H','P',p,'S',s,'Water');work=H-h
        if work < -1e-5:raise ValueError(('Negative nozzle work',work))
        return C.PropsSI('D','P',p,'S',s,'Water')*math.sqrt(2*max(0,work))
    opt=minimize_scalar(lambda p:-flux(p),bounds=(pback,p0),method='bounded')
    if not opt.success:raise ValueError('Nozzle maximization failed')
    candidates=[(flux(pback),pback),(flux(opt.x),opt.x),(0.,p0)]
    return max(candidates)
def solve(left,right,a,guess,name):
    def evaluate(x):
        pL,pR=x*1e6;up=wave(left,pL,-1);cold=wave(right,pR,1)
        H=up['h']+.5*up['u']**2;incoming=ph(pR,H-.5*cold['u']**2);incoming['u']=cold['u']
        mL=A*up['rho']*up['u'];mR=A*incoming['rho']*incoming['u'];G,pcrit=nozzle(H,up['s'],pR)
        return dict(up=up,cold=cold,incoming=incoming,H=H,mL=mL,mR=mR,mNozzle=a*CdA*G,pcrit=pcrit)
    def residual(x):
        out=evaluate(x);return [(out['mL']-out['mR'])/1000,(out['mL']-out['mNozzle'])/1000]
    initial=np.array(guess)
    if max(abs(v) for v in residual(initial))<=1e-9:
        out=evaluate(initial);evaluations=1
    else:
        sol=least_squares(residual,guess,bounds=([.1,.1],[20,20]),xtol=1e-12,ftol=1e-12,gtol=1e-12,diff_step=1e-5,max_nfev=60)
        if not sol.success:raise ValueError((name,sol.message))
        out=evaluate(sol.x);evaluations=sol.nfev
    up=out['up'];cold=out['cold'];inc=out['incoming']
    check(name+' shared mass',out['mL']-out['mR'],1e-6)
    check(name+' nozzle mass',out['mL']-out['mNozzle'],1e-6)
    check(name+' shared totalH',inc['h']+.5*inc['u']**2-out['H'],1e-5)
    if not max(up['speed'],up['headSpeed'])<0<min(cold['speed'],cold['headSpeed']):raise ValueError((name,'Waves do not leave stationary boundary'))
    if inc['u']<0 or out['mL']<0:raise ValueError((name,'Wrong donor mapping'))
    if up['s']<left['s']-1e-7 or inc['s']<up['s']-1e-7 or cold['s']<right['s']-1e-7:raise ValueError((name,'Entropy decreases',up['s']-left['s'],inc['s']-up['s'],cold['s']-right['s']))
    out['incomingSoundSpeed']=trace_sound(inc)
    if inc['u']>=out['incomingSoundSpeed']:raise ValueError('Incoming trace is not subsonic')
    out['name']=name;out['opening']=a;out['evaluations']=evaluations
    out['momentumReaction_N']=A*(up['p']-inc['p'])+out['mL']*(up['u']-inc['u'])
    out['leftAcousticStrain']=(left['p']-up['p'])/(left['rho']*left['c']**2)
    out['rightAcousticStrain']=(inc['p']-right['p'])/(right['rho']*right['c']**2)
    out['linearLeftVelocity']=left['u']+(left['p']-up['p'])/(left['rho']*left['c'])
    out['linearRightVelocity']=right['u']+(inc['p']-right['p'])/(right['rho']*right['c'])
    return out
left=pt(15.2e6,563.15);right=pt(.3e6,313.15)
hot=solve(left,right,1,[10,9.9],'required hot admission')
cases=[hot]
for a,guess in [(.1,[14,3]),(.01,[15,.5]),(.001,[15.19,.32]),(.000001,[15.19999,.30001])]:
    cases.append(solve(left,right,a,guess,'hot opening '+str(a)))
cal=baseline['calibration'][0]
def calibration_interior(row):
    return {**row,'T':C.PropsSI('T','P',row['p'],'H',row['h'],'Water'),'quality':-1,'u':row['velocity'],'c':C.PropsSI('A','P',row['p'],'H',row['h'],'Water')}
normalLeft=calibration_interior(cal['upstream']);normalRight=calibration_interior(cal['downstream'])
normal=solve(normalLeft,normalRight,1,[normalLeft['p']/1e6,normalRight['p']/1e6],'normal reference');cases.append(normal)
check('normal unchanged reference flow',normal['mL']-baseline['inputs']['referenceFlow_kg_s'],1e-5)
reverse=solve(left,right,1,[10,9.9],'coordinate reflection of hot case; not independent reversed solve')
reverse['coordinateSign']=-1;reverse['signedMassFlow']=-reverse['mL'];reverse['signedEnergyFlow']=-reverse['mL']*reverse['H'];cases.append(reverse)
check('mirrored mass mapping',reverse['signedMassFlow']+hot['mL'],1e-8)
check('mirrored total energy mapping',reverse['signedEnergyFlow']+hot['mL']*hot['H'],1e-3)
closed=dict(leftReflectingPressure=left['p'],rightReflectingPressure=right['p'],massFlow=0,energyFlow=0,bodyForce=A*(left['p']-right['p']))
wallP=brentq(lambda p:wave(normalLeft,p,-1)['u'],normalLeft['p'],normalLeft['p']+2*normalLeft['rho']*normalLeft['c']*normalLeft['u'],xtol=1e-5)
movingWall=wave(normalLeft,wallP,-1)
check('moving liquid wall velocity',movingWall['u'],1e-7)
if movingWall['s']<normalLeft['s']-1e-7 or movingWall['speed']>=0:raise ValueError('Reflecting shock not admitted')
check('vanishing opening rate',cases[4]['mL']/cases[3]['mL']-.001,1e-5)
print(json.dumps(dict(scope='Held pure-water outgoing single-phase wave/contact feasibility; wet incoming HEM traces allowed, no trajectory or mixed-gas qualification',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),inputs=dict(left=left,right=right,area=A,CdA=CdA),cases=cases,closedResting=closed,movingReflectingFace=movingWall,checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const [ownerPath, python] = process.argv.slice(2)
  if (!ownerPath || !python) throw new Error('Usage: <shutdown-cooling.md> <research-python>')
  const baselinePath = new URL('./reference-design-rhr-common.ts', import.meta.url).pathname
  const [owner, source, baselineSource] = await Promise.all([Bun.file(ownerPath).text(), Bun.file(import.meta.path).text(), Bun.file(baselinePath).text()])
  async function run(command: string[]) {
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (status !== 0) throw new Error(err)
    return out
  }
  const baseline = await run([process.execPath, baselinePath, ownerPath, python])
  const out = await run([python, '-c', calculation, baseline])
  if (await Bun.file(ownerPath).text() !== owner || await Bun.file(import.meta.path).text() !== source || await Bun.file(baselinePath).text() !== baselineSource) throw new Error('Consumed source changed')
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  console.log(JSON.stringify({ ownerSha256: hash(owner), sourceSha256: hash(source), baselineSourceSha256: hash(baselineSource), calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2))
}
