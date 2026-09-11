/** Offline CMT response-bandwidth discriminator; not an installed hydraulic or acoustic solver. */
import { createHash } from 'node:crypto'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'
import { parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { parseShearBasis } from './reference-design-cmt-shear.ts'

export function bandwidthInput(geometryDocument: string, receivingDocument: string) {
  const b = parseGeometryBasis(geometryDocument), g = tankGeometry(b), a = parseAcousticBasis(geometryDocument)
  const shear = parseShearBasis(receivingDocument)
  if (shear.pressure_MPa !== a.pressure_MPa || shear.holeDiameter_m !== b.holeDiameter_m ||
    shear.coefficient !== a.holeDischargeCoefficient) throw new Error('CMT physical owners disagree')
  return { pressure_MPa: a.pressure_MPa, temperatures_C: [a.temperature_C, a.impedanceReferenceTemperature_C],
    barrelLength_m: b.top_m - b.bottomDatum_m - g.R, barrelArea_m2: Math.PI * g.R ** 2,
    tankHeight_m: b.top_m - g.mouth, tankVolume_m3: b.freeWater_m3,
    internalBAL_m3: g.inventories.internalBAL_m3, externalBAL_m3: g.inventories.externalBAL_m3,
    dviVolume_m3: a.dviVolume_m3, feedArea_m2: Math.PI * b.feedInnerDiameter_m ** 2 / 4,
    mouthArea_m2: Math.PI * b.mouthDiameter_m ** 2 / 4,
    apertureArea_m2: b.ringElevations_m.length * b.holesPerRing * Math.PI * b.holeDiameter_m ** 2 / 4,
    holeDiameter_m: b.holeDiameter_m, upperHoleRoofGap_m: g.roof(b.bodyOuterDiameter_m / 2) - b.ringElevations_m[0]! - b.holeDiameter_m / 2,
    referenceFlow_kg_s: a.referenceFlow_kg_s, apertureCd: a.holeDischargeCoefficient,
    jetVelocityCoefficient: shear.shear.velocityCoefficient,
    // Declared harmonic experiments, not a claim that real actuator motions are band-limited.
    frequencies_Hz: [.25, 1, 10, 50, 100] }
}

export const bandwidthCalculation = String.raw`
import json,sys,math
import numpy as np
import scipy
from scipy.linalg import expm
import CoolProp
import CoolProp.CoolProp as CP
b=json.load(sys.stdin);checks=0
def check(ok,label):
    global checks
    checks+=1
    if not ok:raise ValueError(label)
L=b['barrelLength_m'];A=b['barrelArea_m2'];V=A*L;p=b['pressure_MPa']*1e6;m=b['referenceFlow_kg_s'];rows=[]
check(L>0 and A>0 and b['upperHoleRoofGap_m']>0,'Actual positive geometry')
for T_C in b['temperatures_C']:
    w=CP.AbstractState('HEOS','Water');w.update(CP.PT_INPUTS,p,T_C+273.15)
    check(w.phase()==CP.iphase_liquid,'Single-phase liquid reference')
    rho=w.rhomass();c=w.speed_sound();Z=rho*c/A;I=rho*L/A;C=V/(rho*c*c)
    check(abs(w.first_partial_deriv(CP.iP,CP.iDmass,CP.iSmass)/(c*c)-1)<1e-12,'EOS isentropic sound derivative')
    freq=[]
    for f in [1e-6]+b['frequencies_Hz']:
        omega=2*math.pi*f;x=omega*L/(2*c)
        check(abs(math.sin(x))>1e-14 and abs(math.cos(x))>1e-14,'Harmonic point is not a transmission pole')
        differential=x/math.tan(x);common=math.tan(x)/x
        # Independent transfer propagation in impedance-scaled coordinates [p, Z*q].
        F=expm(np.array([[0,-1j*omega*L/c],[-1j*omega*L/c,0]]))
        check(abs(np.linalg.det(F)-1)<1e-12,'Reciprocal lossless transfer determinant')
        q0_diff=(-.5-F[0,0]*.5)/F[0,1]/Z
        q0_common=(1-F[0,0])/F[0,1]/Z
        qL_common=(F[1,0]+F[1,1]*Z*q0_common)/Z
        matrixDiff=q0_diff/(1/(1j*omega*I));matrixCommon=(q0_common-qL_common)/(1j*omega*C)
        check(abs(matrixDiff-differential)<1e-10,'Differential inertia/transfer-matrix agreement')
        # At the DC-limit probe subtracting nearly equal endpoint pressures loses digits.
        if f>=.25:check(abs(matrixCommon-common)<1e-10,'Common storage/transfer-matrix agreement')
        if f==1e-6:
            check(abs(differential-1)<1e-12 and abs(common-1)<1e-12,'Low-frequency limit');continue
        commonPoles=[(2*k+1)*c/(2*L) for k in range(4)]
        differentialPoles=[k*c/L for k in range(1,5)]
        freq.append(dict(frequency_Hz=f,halfLengthPhase_rad=x,differentialFlowRatio=differential,
          commonStorageFlowRatio=common,relativeInertiaError=abs(differential-1),relativeStorageError=abs(common-1),
          nearestCommonPoleDistance_Hz=min(abs(f-pole) for pole in commonPoles),
          nearestDifferentialPoleDistance_Hz=min(abs(f-pole) for pole in differentialPoles)))
    speed={name:m/(rho*b[key]) for name,key in [('feed','feedArea_m2'),('mouth','mouthArea_m2'),('apertureMean','apertureArea_m2'),('barrelMean','barrelArea_m2')]}
    dp=m*m/(2*rho*(b['apertureCd']*b['apertureArea_m2'])**2)
    jet=b['jetVelocityCoefficient']*math.sqrt(2*dp/rho)
    check(jet>speed['apertureMean'] and jet/c<.01,'Distinct contracted exit and low nominal Mach')
    rows.append(dict(temperature_C=T_C,density_kg_m3=rho,soundSpeed_m_s=c,barrelOneWayAcoustic_s=L/c,
      tankHeightOneWayScale_s=b['tankHeight_m']/c,barrelInertance_Pa_s2_m3=I,
      isentropicVolumeCompliance_m3_Pa={name:b[key]/(rho*c*c) for name,key in [('tank','tankVolume_m3'),('internalBAL','internalBAL_m3'),('externalBAL','externalBAL_m3'),('DVI','dviVolume_m3')]},
      nominalVelocity_m_s=speed,jetSpeed_m_s=jet,jetMach=jet/c,apertureLoss_Pa=dp,
      holeDiameterJetAdvectionScale_s=b['holeDiameter_m']/jet,roofGapJetKinematicScale_s=b['upperHoleRoofGap_m']/jet,
      tankNominalGrossThroughput_s=rho*b['tankVolume_m3']/m,
      internalBalNominalThroughput_s=rho*b['internalBAL_m3']/m,externalBalNominalThroughput_s=rho*b['externalBAL_m3']/m,
      dviNominalThroughput_s=rho*b['dviVolume_m3']/m,
      rigidLiquidAbruptMouthStopScale_Pa=rho*c*speed['mouth'],firstCommonTransmissionPole_Hz=c/(2*L),frequencies=freq))
reducedGravity=9.80665*abs(rows[0]['density_kg_m3']-rows[1]['density_kg_m3'])/rows[0]['density_kg_m3']
check(reducedGravity>0,'Finite thermal density contrast')
print(json.dumps(dict(input=b,versions=dict(CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__),
  scope='Uniform rigid liquid constant-area barrel harmonic discriminator; not installed CMT validation',
  results=rows,coldRelativeDensityContrast=reducedGravity/9.80665,reducedGravity_m_s2=reducedGravity,
  buoyancyDimensionalScales_s={name:math.sqrt(b[key]/reducedGravity) for name,key in [('holeDiameter','holeDiameter_m'),('roofGap','upperHoleRoofGap_m'),('height','tankHeight_m')]},
  checks=checks,verificationChecksPassed=True,operationalFilteringQualified=False,pressureIntegrityQualified=False),allow_nan=False))
`

if (import.meta.main) {
  const [geometry, receiving, python] = process.argv.slice(2)
  if (!geometry || !receiving || !python || process.argv.length !== 5) throw new Error('Usage: reference-design-cmt-bandwidth.ts geometry.md receiving.md python')
  const input = bandwidthInput(await Bun.file(geometry).text(), await Bun.file(receiving).text())
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(bandwidthCalculation), inputHash: hash(JSON.stringify(input)) }
  const child = Bun.spawn([python, '-c', bandwidthCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT bandwidth discriminator failed')
  console.log(JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
}
