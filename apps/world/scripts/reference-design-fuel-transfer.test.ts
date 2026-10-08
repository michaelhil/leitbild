import {describe,it,expect} from 'bun:test'
import {occupiedRackClearance} from './reference-design-fuel-transfer'
import {parseTransferGates,transferGateMotor,gateColumnTraction,heldGateTravel,transferGateChecks,transferGateFixture,parseTransferAttachment,transferToolTorsion,transferToolHand,transferJointTrial,transferAxialTrial,transferJawMotion,transferBodyRotation,transferReconnectionCoordinates,parseManualBankServo,manualBankMeanRate} from './reference-design-fuel-transfer'
const record={width_m:.6,thickness_m:.02,steelDensity_kg_m3:7920,top_m:14,sills_m:[4,3.5],stroke_m:.6,
 speedScale_m_s:.05,motorForce_N:20000,motiveDuty_W:2000,driveEfficiency:.8,electronicsDuty_W:20,
 guideFriction_N:1000,pressureFrictionFactor:.1,brakeForce_N:20000,dragCoefficient:1.2,
 wetFilm_W_m2_K:250,gasFilm_W_m2_K:5,emissivity:.8,gravity_m_s2:9.80665}
const document='```reference-transfer-gates\n'+JSON.stringify(record)+'\n```',b=parseTransferGates(document)
describe('bounded actual horizontal transfer gate',()=>{
 it('strict owner input and exact native metal envelope',()=>{
  expect(()=>parseTransferGates(document+'\n'+document)).toThrow()
  expect(()=>parseTransferGates(document.replace('"width_m":0.6','"unused":1,"width_m":0.6'))).toThrow()
  const q=transferGateChecks(b,{liquidDensity_kg_m3:997.047636760,gasDensity_kg_m3:1.18,surface_m:14})
  expect(q.geometry.map(x=>x.mass_kg)).toEqual([950.4,997.92])
  expect(q.drive.length).toBe(7)
  expect(()=>transferGateFixture({})).toThrow()
 })
 it('pool plate retains its own dry phase patch at partial cover',()=>{
  const q=heldGateTravel(b,997.92,0,997.047636760,1.18,0,1,2000,10.5)
  const well=heldGateTravel(b,997.92,0,997.047636760,1.18,0,1,2000,10)
  if(q.blocked||well.blocked)throw Error('unexpected dry fixture blockage')
  expect(q.fluidHeat_J).toBeGreaterThan(well.fluidHeat_J)
  expect(Math.abs(q.mechanicalBalance_J)).toBeLessThan(1e-4)
  expect(()=>heldGateTravel(b,997.92,0,997.047636760,1.18,11,1,2000,10.5)).toThrow()
 })
 it('normal pressure traction is integrated, not a pressure clamp',()=>{
  const rho=997.047636760,F=gateColumnTraction(b,4,14,4,rho)
  expect(F).toBeCloseTo(.5*b.width_m*rho*b.gravity_m_s2*10**2,8)
  expect(gateColumnTraction(b,4,4,14,rho)).toBe(-F)
  expect(gateColumnTraction(b,4,14,14,rho)).toBe(0)
  expect(heldGateTravel(b,950.4,F,rho,1.18,10).blocked).toBe(true)
 })
 it('finite motion and healthy/failed brake preserve their actual energy',()=>{
  const q=heldGateTravel(b,950.4,0,997.047636760,1.18,10)
  if(q.blocked)throw Error('unexpected blocked fixture')
  expect(q.time_s).toBeGreaterThan(12)
  expect(Math.abs(q.mechanicalBalance_J)).toBeLessThan(1e-4)
  expect(q.stopped.travel_m).toBeGreaterThan(0)
  expect(q.failedBrake.travel_m).toBeGreaterThan(q.stopped.travel_m)
  expect(q.stopped.brakeHeat_J+q.stopped.guideHeat_J+q.stopped.fluidHeat_J).toBeCloseTo(q.kinetic_J,10)
  expect(heldGateTravel(b,950.4,0,997.047636760,1.18,10,1,0).blocked).toBe(true)
 })
 it('backdrive cap, limited power and negative-work receiver are explicit',()=>{
  const back=transferGateMotor(b,1,-.1,2000)
  expect(back.force_N).toBe(20000)
  expect(back.mechanical_W).toBe(-2000)
  expect(back.plateHeat_W).toBe(4000)
  const limited=transferGateMotor(b,1,.025,100)
  expect(limited.mechanical_W).toBe(80)
  expect(limited.plateHeat_W).toBe(20)
  expect(transferGateMotor(b,1,.025,0).force_N).toBe(0)
  expect(()=>transferGateMotor(b,1,.025,2001)).toThrow()
 })
})
const attachment={stubLength_m:.055,lugBottom_m:2.45,lugHeight_m:.01,lugInnerRadius_m:.006,lugOuterRadius_m:.008,
 lugWidth_m:.003,keyWidth_m:.0035,keyEnvelopeDiameter_m:.0165,hubBore_m:.0125,hubLandBottom_m:2.46,
 shoulderBottom_m:8.49,shoulderDiameter_m:.02,shoulderHeight_m:.01,jointCapacity_N:2000,toolLength_m:8,toolDiameter_m:.016,toolLower_m:8.1,
 shearModulus_Pa:77e9,torsionDamping_N_m_s:.5,handTorque_N_m:8,handRate_rad_s:.05,handPower_W:1,
 keyBaseTorque_N_m:.5,keyFriction:.2,keyRadius_m:.008,magneticTorqueRadius_m:.006,guideContactTorque_N_m:8,toolHead_kg:15,toolHeadWidth_m:.26,toolCentralClearance_m:.04,
 toolHeadHeight_m:.2,toolHeadBottomAboveFA_m:.1,jawStroke_m:.006,jawForce_N:2000,jawRate_m_s:.002,jawDuty_W:100,
 jawPairCapacity_N:10000,jawReleaseBase_N:50,jawReleaseFriction:.1,captureElectronics_W:20,hoistEfficiency:.8,hoistBrake_N:10000,
 padRadialInner_m:1.89,padRadialOuter_m:1.9,padArcWidth_m:.01,padHeight_m:.01,tipRadius_m:1.875},
 a=parseTransferAttachment('```reference-transfer-attachment\n'+JSON.stringify(attachment)+'\n```')
describe('actual separated stem, shaft and unilateral body joint',()=>{
 it('counts the retained spider above the seated assembly during overflight',()=>{
  const c={spiderBottom_m:2.4,spiderHeight_m:.1},h={poolFloor_m:-.75,seatedBottom_m:-2.25,transferBottom_m:4.25}
  expect(occupiedRackClearance(c,h,4.65)).toEqual({occupiedParcelTop_m:4,clearance_m:.25})
  expect(()=>occupiedRackClearance(c,{...h,poolFloor_m:-.74},4.65)).toThrow('clearance')
  expect(()=>occupiedRackClearance({...c,spiderHeight_m:.11},h,4.65)).toThrow('clearance')
  expect(()=>occupiedRackClearance(c,h,4.8)).toThrow('clearance')
 })
 it('reconnection preserves reference offset and distinguishes slipped travel from joint closure',()=>{
  const c={collarBottoms_m:[8.05,8.35],collarHeight_m:.1},q={referenceAtRequest_m:0,reference_m:0,stemDisplacement_m:-.04,
   bodyDisplacement_m:0,headDisplacement_m:0,requestedAdvance_m:.04},initial=transferReconnectionCoordinates(a,c,q)
  expect(initial.lugTop_m).toBeCloseTo(2.42,12)
  expect(initial.remainingStemRise_m).toBeCloseTo(.04,12)
  expect(initial.referenceTarget_m).toBe(.04)
  const completed=transferReconnectionCoordinates(a,c,{...q,reference_m:.04,stemDisplacement_m:0})
  expect(completed.remainingReferenceTravel_m).toBe(0)
  expect(completed.remainingStemRise_m).toBeCloseTo(0,12)
  expect(completed.diagnosedReferenceOffset_m).toBe(.04)
  expect('normalMappedReferenceTarget_m' in completed).toBe(false)
  const slipped=transferReconnectionCoordinates(a,c,{...q,reference_m:.04,stemDisplacement_m:-.01})
  expect(slipped.remainingReferenceTravel_m).toBe(0)
  expect(slipped.remainingStemRise_m).toBeCloseTo(.01,12)
  expect(slipped.diagnosedReferenceOffset_m).toBe(.05)
  const interrupted=transferReconnectionCoordinates(a,c,{...q,reference_m:.02,stemDisplacement_m:-.02})
  expect(interrupted.remainingReferenceTravel_m).toBe(.02)
  expect(interrupted.remainingStemRise_m).toBeCloseTo(.02,12)
  expect(transferReconnectionCoordinates(a,c,{...q,referenceAtRequest_m:.04,reference_m:.04}).referenceTarget_m).toBe(.08)
  expect(()=>transferReconnectionCoordinates(a,c,{...q,requestedAdvance_m:.041})).toThrow()
  expect(()=>transferReconnectionCoordinates(a,c,{...q,reference_m:Infinity})).toThrow()
  expect(()=>transferReconnectionCoordinates(a,c,{...q,referenceAtRequest_m:1e100,reference_m:1e100})).toThrow()
  expect(()=>transferReconnectionCoordinates(a,c,{...q,referenceAtRequest_m:Number.MAX_VALUE,requestedAdvance_m:Number.MAX_VALUE})).toThrow()
 })
 it('ordinary MANUAL uses only acquired mean error, not service reference or body truth',()=>{
  const b=parseManualBankServo('```reference-bank-manual-servo\n{"sample_s":0.1,"gain_s":0.1,"deadband_stroke":0.0001,"maximumRate_stroke_s":0.002}\n```')
  expect(manualBankMeanRate(b,.0001,0).requestedRate_stroke_s).toBe(0)
  expect(manualBankMeanRate(b,.00010001,0).requestedRate_stroke_s).toBeGreaterThan(0)
  expect(manualBankMeanRate(b,0,.0001).requestedRate_stroke_s).toBe(0)
  expect(manualBankMeanRate(b,.001,0).requestedRate_stroke_s).toBe(.0001)
  expect(manualBankMeanRate(b,.001,0).referenceIncrement_m).toBe(.00004)
  expect(manualBankMeanRate(b,1,0).requestedRate_stroke_s).toBe(.002)
  expect(manualBankMeanRate(b,0,1).requestedRate_stroke_s).toBe(-.002)
  expect(manualBankMeanRate(b,0,0).requestedRate_stroke_s).toBe(0)
  const requested=manualBankMeanRate(b,.001,0).referenceIncrement_m
  expect(.04+requested).toBeCloseTo(.04004,12)
  expect(.05+requested).toBeCloseTo(.05004,12)
  expect(manualBankMeanRate(b,.5,.6).requestedRate_stroke_s).toBe(-.002)
  expect(()=>manualBankMeanRate(b,.5,NaN)).toThrow()
  expect(()=>manualBankMeanRate(b,.5,-.01)).toThrow()
  expect(()=>parseManualBankServo('')).toThrow()
 })
 it('retains body angular free play and real stationary guide reaction',()=>{
  const q={inertia_kg_m2:.18,clearanceAngle_rad:.007015,angle_rad:0,omega_rad_s:.01,keyTorque_N_m:.5,guideTorque_N_m:0,guideOverlap:true,failedGuide:false}
  expect(transferBodyRotation(a,q).kinetic_J).toBeGreaterThan(0)
  expect(transferBodyRotation(a,q).acceleration_rad_s2).toBeGreaterThan(0)
  expect(()=>transferBodyRotation(a,{...q,guideTorque_N_m:-.5})).toThrow()
  const stopped=transferBodyRotation(a,{...q,angle_rad:q.clearanceAngle_rad,omega_rad_s:0,keyTorque_N_m:8,guideTorque_N_m:-8})
  expect(stopped.acceleration_rad_s2).toBe(0)
  expect(Math.abs(stopped.guideWork_W)).toBe(0)
  expect(transferBodyRotation(a,{...q,angle_rad:-q.clearanceAngle_rad,omega_rad_s:0,keyTorque_N_m:-8,guideTorque_N_m:8}).acceleration_rad_s2).toBe(0)
  expect(transferBodyRotation(a,{...q,failedGuide:true}).admitted).toBe(false)
  expect(()=>transferBodyRotation(a,{...q,angle_rad:q.clearanceAngle_rad,omega_rad_s:0,guideTorque_N_m:-9})).toThrow()
 })
 it('rotated lug corners, not midpoint/handle, determine key passage',()=>{
  const q={gap_m:0,force_N:0,torque_N_m:1,capacity_N:2000,omegaOutput_rad_s:.05,omegaStem_rad_s:.05,omegaBody_rad_s:.007,theta_rad:Math.PI/2,failedContact:false}
  expect(transferJointTrial(a,q).aligned).toBe(true)
  expect(transferJointTrial(a,{...q,theta_rad:3*Math.PI/2}).aligned).toBe(true)
  expect(transferJointTrial(a,{...q,theta_rad:Math.PI/2+.03}).aligned).toBe(true)
  expect(transferJointTrial(a,{...q,theta_rad:Math.PI/2+.0357}).aligned).toBe(false)
  expect(transferJointTrial(a,{...q,theta_rad:Math.PI/2+.03-(-.007015)}).aligned).toBe(false)
  expect(transferJointTrial(a,q).keyHeat_W).toBeCloseTo(.5*(.05-.007),12)
  expect(()=>transferJointTrial(a,{...q,force_N:10})).toThrow()
  expect(()=>transferJointTrial(a,{...q,theta_rad:0,force_N:2000,torque_N_m:1})).toThrow()
  expect(()=>transferJointTrial(a,{...q,capacity_N:0})).toThrow()
 })
 it('retained shaft strain and signed work survive blocked/reversed output',()=>{
  for(const [wh,wo] of [[.05,0],[0,.05],[-.05,.02]]){
   const q=transferToolTorsion(a,.13,0,wh!,wo!)
   expect(q.strain_J).toBeGreaterThan(0)
   expect(q.damping_W).toBeGreaterThanOrEqual(0)
   expect(q.handWork_W-q.outputWork_W).toBeCloseTo(q.strainRate_W+q.damping_W,12)
  }
  expect(transferToolHand(a,1,-.1,1).torque_N_m).toBe(8)
  expect(transferToolHand(a,1,-.1,1).toolHeat_W).toBe(1.8)
  expect(transferToolHand(a,1,.025,.01).mechanical_W).toBe(.01)
  expect(transferToolHand(a,1,.025,0).torque_N_m).toBe(0)
 })
 it('actual overdamped jaw motion is force/work/contact limited',()=>{
  const nominal=transferJawMotion(a,0,100,1,false),limited=transferJawMotion(a,10000,.01,1,false),blocked=transferJawMotion(a,10000,100,1,true)
  expect(nominal.speed_m_s).toBe(.00195)
  expect(limited.mechanical_W).toBeCloseTo(.008,12)
  expect(limited.toolHeat_W).toBeCloseTo(.01,12)
  expect(blocked.speed_m_s).toBe(0)
  expect(blocked.toolHeat_W).toBe(100)
  expect(transferJawMotion(a,20000,100,1,false).speed_m_s).toBe(0)
  expect(transferJawMotion(a,0,0,1,false).speed_m_s).toBe(0)
  expect(transferJawMotion(a,0,100,-1,false).speed_m_s).toBe(-nominal.speed_m_s)
 })
 it('raising, braking downward and separated/tripped body use real incidence',()=>{
  const q={bodyMass_kg:35,stemMass_kg:5.44,gap_m:0,jointForce_N:300,jointCapacity_N:2000,gripForce_N:355,
   bodyOtherForce_N:-300,stemOtherForce_N:-55,bodyVelocity_m_s:.008,stemVelocity_m_s:.008,jointFailed:false}
  for(const v of [.008,-.008,0]){
   const r=transferAxialTrial({...q,bodyVelocity_m_s:v,stemVelocity_m_s:v})
   expect(r.bodyAcceleration_m_s2).toBe(0)
   expect(r.stemAcceleration_m_s2).toBe(0)
   expect(Math.abs(r.energyDefect_W)).toBeLessThan(1e-12)
  }
  const failed=transferAxialTrial({...q,jointForce_N:0,gripForce_N:0,jointFailed:true})
  expect(failed.bodyAcceleration_m_s2).toBeLessThan(0)
  expect(failed.stemAcceleration_m_s2).toBeLessThan(0)
  expect(()=>transferAxialTrial({...q,jointForce_N:-10})).toThrow()
  expect(()=>transferAxialTrial({...q,stemVelocity_m_s:0})).toThrow()
  expect(()=>transferAxialTrial({...q,jointFailed:true})).toThrow()
 })
})
