/** Offline CTF dry-steam wall-source selection; not a core trajectory or runtime. */
import { createHash } from 'node:crypto'
import { fuelGeometry, parseFuelConstruction } from './reference-design-fuel-construction.ts'
import { fuelMaterialPython } from './reference-design-fuel-materials.ts'

export function drySteamConvection(re: number, pr: number, conductivity: number, diameter: number, deltaT: number) {
  if (![re, pr, conductivity, diameter, deltaT].every(Number.isFinite) || re < 0 || pr <= 0 || conductivity <= 0 || diameter <= 0)
    throw new Error('Invalid dry-steam transport input')
  const nuLaminar = 10
  const nuDB = .023 * re ** .8 * pr ** (deltaT >= 0 ? .4 : .3)
  const nuWH = .07907 * re ** .6774 * pr ** .333
  const h = Math.max(nuLaminar, nuDB, nuWH) * conductivity / diameter
  return { nuLaminar, nuDB, nuWH, h_W_m2K: h, heatFlux_W_m2: h * deltaT }
}

export function drySteamComparisonRejections(s: { liquidMass: number, vaporMass: number, superheated: boolean, re: number,
  pr: number, massFlux: number, mach: number, richardson: number, radiationFraction: number }) {
  if (!Object.values(s).every(v => typeof v === 'boolean' || Number.isFinite(v)) || s.liquidMass < 0 || s.vaporMass < 0)
    throw new Error('Invalid dry-steam state')
  return [
    s.liquidMass !== 0 ? 'Remaining liquid needs its own contact/transport owner' : '',
    s.vaporMass === 0 ? 'No steam inventory' : '',
    !s.superheated ? 'Condensation/saturation branch not selected' : '',
    s.massFlux <= 0 || s.re < 10000 || s.pr < .6 || s.pr > 160 ? 'Outside selected turbulent forward-flow comparison' : '',
    s.mach >= .3 ? 'Compressibility correction not selected' : '',
    s.richardson >= .1 ? 'Mixed/natural convection not selected' : '',
    s.radiationFraction > .05 ? 'Radiation omission exceeds declared comparison tolerance' : '',
  ].filter(Boolean)
}

async function pythonJson(python: string, source: string, input: unknown) {
  const child = Bun.spawn([python, '-c', source], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error)
  return JSON.parse(output)
}

const properties = String.raw`
import json,sys,platform,CoolProp
from CoolProp.CoolProp import PropsSI as P
d=json.load(sys.stdin);rows=[]
for p,tv,tw,G in d['cases']:
    tf=(tv+tw)/2; rho=P('D','P',p,'T',tv,'Water'); v=G/rho
    k=P('L','P',p,'T',tf,'Water'); mu=P('V','P',p,'T',tf,'Water'); cp=P('C','P',p,'T',tf,'Water')
    rows.append(dict(p_Pa=p,steam_K=tv,wall_K=tw,G_kg_m2s=G,film_K=tf,k=k,mu=mu,cp=cp,rho=rho,
        re=G*d['dh']/mu,pr=cp*mu/k,mach=v/P('A','P',p,'T',tv,'Water'),
        richardson=9.80665*P('ISOBARIC_EXPANSION_COEFFICIENT','P',p,'T',tf,'Water')*abs(tw-tv)*d['dh']/v**2,
        saturation_K=P('T','P',p,'Q',1,'Water'),
        radiationConductance_W_m2K=5.670374419e-8*(tw+tv)*(tw*tw+tv*tv)))
json.dump(dict(rows=rows,versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__)),sys.stdout,allow_nan=False)
`
const energySource = String.raw`
import json,sys,math,numpy as np
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
${fuelMaterialPython}
d=json.load(sys.stdin);out=[];g=d['geometry'];b=d['basis'];ro=b['rodOuterDiameter_m']/2
# Physical outer material shell, one rod and one metre. This is only the wall-source operator.
ri=ro-.1*b['cladThickness_m'];mc=b['cladDensity_kg_m3']*math.pi*(ro*ro-ri*ri)
V=g['flowArea_m2']/g['rods'];Aw=2*math.pi*ro
for r in d['rows']:
    if r['rejectionReasons']:continue
    p,tv,tw=r['p_Pa'],r['steam_K'],r['wall_K'];rho=r['rho'];mg=rho*V
    for dt in [1e-4,3e-4]:
        E=Aw*r['heatFlux_W_m2']*dt
        target=hc(tw)-E/mc
        tw1=brentq(lambda t:hc(t)-target,300,1000,xtol=1e-10)
        u0=P('U','P',p,'T',tv,'Water');u1=u0+E/mg
        tv1=P('T','D',rho,'U',u1,'Water');p1=P('P','D',rho,'U',u1,'Water')
        solidDelta=mc*(hc(tw1)-hc(tw));steamDelta=mg*(P('U','D',rho,'T',tv1,'Water')-u0)
        residual=solidDelta+steamDelta
        if abs(residual)>1e-7:raise ValueError('Conservative finite-energy source failed')
        if (tw1-tv1)*(tw-tv)<0:raise ValueError('Source substep crossed thermal equilibrium')
        out.append(dict(p_Pa=p,steamBefore_K=tv,wallBefore_K=tw,G_kg_m2s=r['G_kg_m2s'],dt_s=dt,
            exchanged_J=E,wallAfter_K=tw1,steamAfter_K=tv1,pressureAfter_Pa=p1,
            solidDelta_J=solidDelta,steamDelta_J=steamDelta,residual_J=residual,
            vaporMassBefore_kg=mg,vaporMassAfter_kg=mg,phaseMassTransfer_kg=0,boronTransfer_kg=0))
json.dump(dict(shellMass_kg=mc,steamVolume_m3=V,wallArea_m2=Aw,cases=out),sys.stdout,allow_nan=False)
`

if (import.meta.main) {
  const [fuelPath, python, receiptPath] = process.argv.slice(2)
  if (!fuelPath || !python || !receiptPath) throw new Error('Usage: dry-steam-wall.ts fuel-construction.md python receipt.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const names = ['reference-design-dry-steam-wall.ts', 'reference-design-fuel-construction.ts', 'reference-design-fuel-materials.ts']
  const identities = async () => Object.fromEntries(await Promise.all(names.map(async n => [n, hash(await Bun.file(new URL(n, import.meta.url)).text())])))
  const sources = await identities(), document = await Bun.file(fuelPath).text()
  const basis = parseFuelConstruction(document), geometry = fuelGeometry(basis)
  const cases = [400, 800].flatMap(G => [650, 750, 850].map(tw => [5e6, 650, tw, G]))
  cases.push([5e6, 750, 650, 800], [.2e6, 650, 750, 20], [5e6, 650, 750, 10])
  const raw = await pythonJson(python, properties, { cases, dh: geometry.hydraulicDiameter_m })
  const rows = raw.rows.map((r: Record<string, number>) => {
    const law = drySteamConvection(r.re!, r.pr!, r.k!, geometry.hydraulicDiameter_m, r.wall_K! - r.steam_K!)
    const radiationFraction = r.radiationConductance_W_m2K! / law.h_W_m2K
    const rejectionReasons = drySteamComparisonRejections({ liquidMass: 0, vaporMass: r.rho! * geometry.coreFlowVolume_m3,
      superheated: Math.min(r.wall_K!, r.steam_K!) > r.saturation_K!, re: r.re!, pr: r.pr!,
      massFlux: r.G_kg_m2s!, mach: r.mach!, richardson: r.richardson!, radiationFraction })
    return { ...r, ...law, radiationFraction, rejectionReasons }
  })
  const sourceCheck = await pythonJson(python, energySource, { rows, geometry, basis })
  if (JSON.stringify(sources) !== JSON.stringify(await identities()) || document !== await Bun.file(fuelPath).text())
    throw new Error('Source changed during calculation')
  const receipt = { sourceSha256: sources, fuelDocumentSha256: hash(document), geometry, cases, rows,
    sourceCheck, versions: raw.versions, forcedSteamConvectionSelected: true,
    wallSourceConservationChecked: true, completeCoreRecoveryQualified: false }
  await Bun.write(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ receiptPath, admitted: rows.filter((r: { rejectionReasons: string[] }) => !r.rejectionReasons.length).length,
    sourceCases: sourceCheck.cases.length, completeCoreRecoveryQualified: false }))
}
