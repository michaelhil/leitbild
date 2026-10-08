/** Original finite LD-01 transfer-interface checks; no plant or procedure runtime. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {parseControlAbsorber,controlAbsorberGeometry,type ControlAbsorber} from './reference-design-control-absorber'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling,fuelHandlingChecks} from './reference-design-fuel-handling'

const positive=z.number().finite().positive(),finite=z.number().finite()
const gateSchema=z.object({width_m:positive,thickness_m:positive,steelDensity_kg_m3:positive,
 top_m:finite,sills_m:z.tuple([finite,finite]),stroke_m:positive,speedScale_m_s:positive,
 motorForce_N:positive,motiveDuty_W:positive,driveEfficiency:z.number().positive().max(1),
 electronicsDuty_W:positive,guideFriction_N:positive,pressureFrictionFactor:z.number().nonnegative(),
 brakeForce_N:positive,dragCoefficient:positive,wetFilm_W_m2_K:positive,gasFilm_W_m2_K:positive,
 emissivity:z.number().min(0).max(1),gravity_m_s2:positive}).strict()
export type TransferGates= z.infer<typeof gateSchema>
const attachmentSchema=z.object({stubLength_m:positive,lugBottom_m:finite,lugHeight_m:positive,lugInnerRadius_m:positive,lugOuterRadius_m:positive,
 lugWidth_m:positive,keyWidth_m:positive,keyEnvelopeDiameter_m:positive,hubBore_m:positive,hubLandBottom_m:finite,
 shoulderBottom_m:finite,shoulderDiameter_m:positive,shoulderHeight_m:positive,jointCapacity_N:positive,toolLength_m:positive,toolDiameter_m:positive,
 toolLower_m:finite,shearModulus_Pa:positive,torsionDamping_N_m_s:positive,handTorque_N_m:positive,
 handRate_rad_s:positive,handPower_W:positive,keyBaseTorque_N_m:positive,keyFriction:positive,keyRadius_m:positive,
 magneticTorqueRadius_m:positive,guideContactTorque_N_m:positive,toolHead_kg:positive,toolHeadWidth_m:positive,toolCentralClearance_m:positive,toolHeadHeight_m:positive,
 toolHeadBottomAboveFA_m:positive,jawStroke_m:positive,jawForce_N:positive,jawRate_m_s:positive,jawDuty_W:positive,
 jawPairCapacity_N:positive,jawReleaseBase_N:positive,jawReleaseFriction:positive,captureElectronics_W:positive,
 hoistEfficiency:positive.max(1),hoistBrake_N:positive,padRadialInner_m:positive,padRadialOuter_m:positive,
 padArcWidth_m:positive,padHeight_m:positive,tipRadius_m:positive}).strict()
export type TransferAttachment=z.infer<typeof attachmentSchema>
const manualServoSchema=z.object({sample_s:positive,gain_s:positive,deadband_stroke:positive,maximumRate_stroke_s:positive}).strict()
export type ManualBankServo=z.infer<typeof manualServoSchema>
export function parseManualBankServo(document:string):ManualBankServo{
 const blocks=[...document.matchAll(/^```reference-bank-manual-servo\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected exactly one reference-bank-manual-servo block')
 return manualServoSchema.parse(JSON.parse(blocks[0]![1]!))
}
/** Acquired-mean arithmetic only: context, acquisition and output invalidation are not simulated here. */
export function manualBankMeanRate(b:ManualBankServo,target:number,acquiredMean:number){
 if(![target,acquiredMean].every(Number.isFinite)||target<0||target>1||acquiredMean<0||acquiredMean>1)throw Error('Invalid usable manual bank input')
 const error=target-acquiredMean,rate=Math.abs(error)<=b.deadband_stroke?0:Math.max(-b.maximumRate_stroke_s,Math.min(b.maximumRate_stroke_s,b.gain_s*error))
 return {error_stroke:error,requestedRate_stroke_s:rate,referenceIncrement_m:4*rate*b.sample_s}
}
export function parseTransferAttachment(document:string):TransferAttachment{
 const blocks=[...document.matchAll(/^```reference-transfer-attachment\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected exactly one reference-transfer-attachment block')
 return attachmentSchema.parse(JSON.parse(blocks[0]![1]!))
}
/** Reconnection coordinate accounting only, not a movement or permission solver. */
export function transferReconnectionCoordinates(b:TransferAttachment,c:Pick<ControlAbsorber,'collarBottoms_m'|'collarHeight_m'>,
 q:{referenceAtRequest_m:number,reference_m:number,stemDisplacement_m:number,bodyDisplacement_m:number,
 headDisplacement_m:number,requestedAdvance_m:number}){
 if(!Object.values(q).every(Number.isFinite)||!c.collarBottoms_m.every(Number.isFinite)||!Number.isFinite(c.collarHeight_m))throw Error('Nonfinite reconnection coordinate')
 const collarTop=Math.max(...c.collarBottoms_m)+c.collarHeight_m,fall=b.shoulderBottom_m-collarTop,
  roundoff=32*Number.EPSILON*Math.max(1,Math.abs(b.shoulderBottom_m),Math.abs(collarTop))
 if(!(fall>0&&q.requestedAdvance_m>0)||q.requestedAdvance_m-fall>roundoff)throw Error('Reference request exceeds actual retained shoulder fall')
 const target=q.referenceAtRequest_m+q.requestedAdvance_m,lug=b.lugBottom_m+b.lugHeight_m+q.headDisplacement_m+q.stemDisplacement_m,
  land=b.hubLandBottom_m+q.bodyDisplacement_m,offset=q.reference_m-q.stemDisplacement_m
 if(![target,lug,land,offset].every(Number.isFinite)||target<=q.referenceAtRequest_m)throw Error('Unresolvable derived reconnection coordinate')
 return {shoulderFall_m:fall,referenceTarget_m:target,remainingReferenceTravel_m:target-q.reference_m,
  lugTop_m:lug,landBottom_m:land,remainingStemRise_m:land-lug,diagnosedReferenceOffset_m:offset}
}
/** Quasistatic shaft constitutive/work identity, not a handle-to-key pose command. */
export function transferToolTorsion(b:TransferAttachment,thetaHand:number,thetaOutput:number,omegaHand:number,omegaOutput:number){
 if(![thetaHand,thetaOutput,omegaHand,omegaOutput].every(Number.isFinite))throw Error('Invalid retained tool state')
 const J=Math.PI*b.toolDiameter_m**4/32,k=b.shearModulus_Pa*J/b.toolLength_m,delta=thetaHand-thetaOutput,domega=omegaHand-omegaOutput,
  torque=k*delta+b.torsionDamping_N_m_s*domega,strain=.5*k*delta**2,
  strainRate=k*delta*domega,damping=b.torsionDamping_N_m_s*domega**2
 return {polarMoment_m4:J,stiffness_N_m_rad:k,torque_N_m:torque,strain_J:strain,
  strainRate_W:strainRate,damping_W:damping,handWork_W:torque*omegaHand,outputWork_W:torque*omegaOutput}
}
export function transferToolHand(b:TransferAttachment,direction:-1|0|1,omega:number,power:number){
 if(!Number.isFinite(omega)||!Number.isFinite(power)||power<0||power>b.handPower_W||![-1,0,1].includes(direction))throw Error('Invalid actual hand support/request')
 if(direction===0||power===0)return {torque_N_m:0,mechanical_W:0,input_W:0,toolHeat_W:0}
 let torque=Math.max(-b.handTorque_N_m,Math.min(b.handTorque_N_m,b.handTorque_N_m*(direction-omega/b.handRate_rad_s)))
 if(torque*omega>power)torque=power/omega
 return {torque_N_m:torque,mechanical_W:torque*omega,input_W:power,toolHeat_W:power-torque*omega}
}
/** Instantaneous admitted axial incidence. Other forces are the actual gravity,
 * native pressure/drag and existing stops, not a replacement water model. */
export function transferAxialTrial(q:{bodyMass_kg:number,stemMass_kg:number,gap_m:number,jointForce_N:number,jointCapacity_N:number,
 gripForce_N:number,bodyOtherForce_N:number,stemOtherForce_N:number,bodyVelocity_m_s:number,stemVelocity_m_s:number,
 jointFailed:boolean}){
 if(!Object.values(q).filter(x=>typeof x==='number').every(Number.isFinite)||q.bodyMass_kg<=0||q.stemMass_kg<=0||q.gap_m<0||q.jointForce_N<0||q.jointCapacity_N<0||q.jointForce_N>q.jointCapacity_N)throw Error('Invalid separated body/stem state')
 if(q.jointFailed&&q.jointForce_N!==0)throw Error('Failed joint cannot transmit insertion/holding')
 if(q.gap_m*q.jointForce_N>1e-9||q.jointForce_N*Math.abs(q.bodyVelocity_m_s-q.stemVelocity_m_s)>1e-9)throw Error('Unpaid/penetrating unilateral contact trial')
 const bodyForce=q.bodyOtherForce_N+q.jointForce_N,stemForce=q.stemOtherForce_N+q.gripForce_N-q.jointForce_N,
  bodyWork=bodyForce*q.bodyVelocity_m_s,stemWork=stemForce*q.stemVelocity_m_s,
  externalWork=q.bodyOtherForce_N*q.bodyVelocity_m_s+(q.stemOtherForce_N+q.gripForce_N)*q.stemVelocity_m_s,
  contactWork=q.jointForce_N*(q.bodyVelocity_m_s-q.stemVelocity_m_s)
 return {bodyAcceleration_m_s2:bodyForce/q.bodyMass_kg,stemAcceleration_m_s2:stemForce/q.stemMass_kg,
  bodyWork_W:bodyWork,stemWork_W:stemWork,externalWork_W:externalWork,contactWork_W:contactWork,
  energyDefect_W:bodyWork+stemWork-externalWork-contactWork}
}
export function transferJawMotion(b:TransferAttachment,reaction:number,power:number,direction:-1|0|1,blocked:boolean){
 if(!Number.isFinite(reaction)||!Number.isFinite(power)||power<0||power>b.jawDuty_W||![-1,0,1].includes(direction))throw Error('Invalid actual jaw request/support')
 const R=b.jawReleaseBase_N+b.jawReleaseFriction*Math.abs(reaction),C=b.jawForce_N/b.jawRate_m_s,
  delivered=direction===0?0:power,
  speed=blocked||direction===0||power===0?0:Math.max(0,Math.min((b.jawForce_N-R)/C,2*b.hoistEfficiency*power/(R+Math.sqrt(R*R+4*C*b.hoistEfficiency*power)))),
  mechanical=(R+C*speed)*speed,resistanceHeat=R*speed,overdampedHeat=C*speed*speed,
  motorHeat=delivered-mechanical
 return {speed_m_s:direction*speed,delivered_W:delivered,mechanical_W:mechanical,resistanceHeat_W:resistanceHeat,
  overdampedHeat_W:overdampedHeat,motorHeat_W:motorHeat,toolHeat_W:motorHeat+resistanceHeat+overdampedHeat}
}
/** Actual small body rotation and guide free play; not a fixed-spider grant. */
export function transferBodyRotation(b:TransferAttachment,q:{inertia_kg_m2:number,clearanceAngle_rad:number,
 angle_rad:number,omega_rad_s:number,keyTorque_N_m:number,guideTorque_N_m:number,guideOverlap:boolean,failedGuide:boolean}){
 if(!Object.values(q).filter(x=>typeof x==='number').every(Number.isFinite)||q.inertia_kg_m2<=0||q.clearanceAngle_rad<=0)throw Error('Invalid retained body rotation')
 const admission=q.guideOverlap&&!q.failedGuide&&Math.abs(q.angle_rad)<=q.clearanceAngle_rad+1e-12,
  reaction=q.guideTorque_N_m
 if(Math.abs(reaction)>b.guideContactTorque_N_m||(!admission&&reaction!==0))throw Error('Unadmitted angular guide reaction')
 if(reaction!==0&&(Math.abs(Math.abs(q.angle_rad)-q.clearanceAngle_rad)>1e-12||q.angle_rad*reaction>=0||Math.abs(q.omega_rad_s)>1e-12))throw Error('No stationary angular reaction through free play/moving contact')
 return {admitted:admission,kinetic_J:.5*q.inertia_kg_m2*q.omega_rad_s**2,
  acceleration_rad_s2:(q.keyTorque_N_m+reaction)/q.inertia_kg_m2,
  keyWork_W:q.keyTorque_N_m*q.omega_rad_s,guideWork_W:reaction*q.omega_rad_s}
}
/** Validate actual stick/slip/paid load, never infer it from a disconnect request. */
export function transferJointTrial(b:TransferAttachment,q:{gap_m:number,force_N:number,torque_N_m:number,capacity_N:number,
 omegaOutput_rad_s:number,omegaStem_rad_s:number,omegaBody_rad_s:number,theta_rad:number,failedContact:boolean}){
 if(!Object.values(q).filter(x=>typeof x==='number').every(Number.isFinite)||q.gap_m<0||q.force_N<0||q.capacity_N<0)throw Error('Invalid uplift-only joint state')
 const angle=q.theta_rad-Math.PI/2,
  corners=[b.lugInnerRadius_m,b.lugOuterRadius_m].flatMap(x=>[-b.lugWidth_m/2,b.lugWidth_m/2].map(y=>({x:x*Math.cos(angle)-y*Math.sin(angle),y:x*Math.sin(angle)+y*Math.cos(angle)}))),
  aligned=corners.every(p=>Math.hypot(p.x,p.y)<=b.hubBore_m/2||(Math.abs(p.x)<=b.keyEnvelopeDiameter_m/2&&Math.abs(p.y)<=b.keyWidth_m/2)),
  force=q.failedContact||aligned?0:q.force_N,
  magneticDemand=Math.hypot(force,q.torque_N_m/b.magneticTorqueRadius_m),
  slipHeat=q.torque_N_m*(q.omegaOutput_rad_s-q.omegaStem_rad_s),keyResistance=b.keyBaseTorque_N_m+b.keyFriction*force*b.keyRadius_m,
  relativeOmega=q.omegaStem_rad_s-q.omegaBody_rad_s,keyHeat=keyResistance*Math.abs(relativeOmega)
 if((q.failedContact||aligned)&&q.force_N!==0)throw Error('No axial coupling through an open/failed key')
 if(q.gap_m*force>1e-9||magneticDemand>q.capacity_N+1e-9||slipHeat< -1e-10)throw Error('Unadmitted joint contact/capacity/work trial')
 return {aligned,axialForce_N:force,magneticDemand_N:magneticDemand,slipHeat_W:slipHeat,keyResistance_N_m:keyResistance,keyHeat_W:keyHeat,
  ordinaryRotationNotBlocked:Math.abs(q.torque_N_m)>=keyResistance}
}
export function occupiedRackClearance(c:Pick<ControlAbsorber,'spiderBottom_m'|'spiderHeight_m'>,
 h:Pick<ReturnType<typeof parseFuelHandling>,'poolFloor_m'|'seatedBottom_m'|'transferBottom_m'>,fullLength_m:number){
 const top=h.poolFloor_m+Math.max(fullLength_m,c.spiderBottom_m+c.spiderHeight_m-h.seatedBottom_m)
 const clearance=h.transferBottom_m-top
 if(!Number.isFinite(clearance)||clearance<.25)throw Error('complete occupied rack parcel clearance below selected 0.25 m')
 return {occupiedParcelTop_m:top,clearance_m:clearance}
}
export function transferAttachmentChecks(b:TransferAttachment,c:ControlAbsorber,f:ReturnType<typeof parseFuelConstruction>,h:ReturnType<typeof parseFuelHandling>){
 const geometry=controlAbsorberGeometry(c,f,h),fuel=fuelHandlingChecks(h,f),checks:{name:string,value?:number}[]=[],
  require=(name:string,ok:boolean,value?:number)=>{if(!ok)throw Error(name);checks.push({name,...(value===undefined?{}:{value})})},
  stemRadius=c.stemDiameter_m/2,rho=c.steelDensity_kg_m3,
  stubV=Math.PI*stemRadius**2*b.stubLength_m,lugV=2*b.lugWidth_m*(b.lugOuterRadius_m-stemRadius)*b.lugHeight_m,
  shoulderV=Math.PI*((b.shoulderDiameter_m/2)**2-stemRadius**2)*b.shoulderHeight_m,
  addedStemV=stubV+lugV+shoulderV,addedStemMass=addedStemV*rho*c.clusters,
  collarTop=Math.max(...c.collarBottoms_m)+c.collarHeight_m,fall=b.shoulderBottom_m-collarTop,
  foot=c.spiderBottom_m+c.spiderHeight_m-b.stubLength_m-fall,
  toolV=Math.PI*b.toolDiameter_m**2/4*b.toolLength_m,toolMass=toolV*rho,
  toolInertia=.5*toolMass*(b.toolDiameter_m/2)**2,
  attachedStemMass=geometry.moving.stem_kg+addedStemMass,
  shortCluster=(geometry.moving.total_kg-geometry.moving.stem_kg)/c.clusters,
  capturedMass=fuel.assembly.mass_kg+shortCluster+b.toolHead_kg,
  padV=.5*(b.padRadialOuter_m**2-b.padRadialInner_m**2)*(b.padArcWidth_m/((b.padRadialOuter_m+b.padRadialInner_m)/2))*b.padHeight_m,
  liftWeight=capturedMass*h.gravity_m_s2,
  torsion=transferToolTorsion(b,b.handTorque_N_m/(b.shearModulus_Pa*Math.PI*b.toolDiameter_m**4/32/b.toolLength_m),0,0,0),
  rodMass=(geometry.moving.b4c_kg+geometry.moving.bodySteel_kg)/geometry.rodlets,ro=c.bodyDiameter_m/2,ra=c.absorberDiameter_m/2,
  absorberMass=Math.PI*ra**2*c.activeLength_m*c.b4cDensity_kg_m3,
  shellMass=Math.PI*(ro**2-ra**2)*c.activeLength_m*c.steelDensity_kg_m3,
  endMass=Math.PI*ro**2*(c.bodyLength_m-c.activeLength_m)*c.steelDensity_kg_m3,
  rodOwnInertia=.5*absorberMass*ra**2+.5*shellMass*(ro**2+ra**2)+.5*endMass*ro**2,
  bodyRotaryInertia=geometry.bodySites.reduce((sum,p)=>sum+rodMass*(p.x_m**2+p.y_m**2)+rodOwnInertia,0)+.5*c.spiderMass_kg*c.spiderRadius_m**2,
  radialClearance=(h.guideInnerDiameter_m-c.bodyDiameter_m)/2,
  bodyClearanceAngle=Math.min(...geometry.bodySites.map(p=>2*Math.asin(radialClearance/(2*Math.hypot(p.x_m,p.y_m)))))
 require('actual positive lug support incidence',Math.abs(b.lugBottom_m+b.lugHeight_m-b.hubLandBottom_m)<1e-12)
 require('actual lug inner radius matches original stem',b.lugInnerRadius_m===stemRadius)
 require('key slots are not a full lug-passing circular bore',b.hubBore_m<c.stemDiameter_m+2*(b.lugOuterRadius_m-stemRadius)&&b.keyEnvelopeDiameter_m>2*b.lugOuterRadius_m)
 require('shoulder fits neck but not collar',b.shoulderDiameter_m<c.neckID_m&&b.shoulderDiameter_m>c.collarID_m)
 require('actual passive retention fall',fall>0&&Math.abs(fall-.04)<1e-12,fall)
 require('postfall stub clears actual FA top',foot>fuel.assembly.assemblyTop_m,foot-fuel.assembly.assemblyTop_m)
 require('added stem metal finite and separate',addedStemMass>0,addedStemMass)
 require('tool actual service reach',b.toolLower_m+b.toolLength_m<26&&b.toolLower_m===c.jackBottom_m)
 require('finite shaft rotary and elastic stocks',toolInertia>0&&torsion.strain_J>0,torsion.strain_J)
 require('manual force-speed work paid',b.handTorque_N_m*b.handRate_rad_s<=b.handPower_W)
 require('short FA cluster fits actual gate top',fuel.assembly.transferTop_m+c.spiderHeight_m<14)
 const rackClearance=occupiedRackClearance(c,h,fuel.assembly.fullLength_m)
 require('complete occupied rack parcel overflight',rackClearance.clearance_m>=.25,rackClearance.clearance_m)
 require('actual tool fits gate and rack interior',b.toolHeadWidth_m<.6&&b.toolHeadWidth_m<h.rackSleeveSide_m-2*(2*h.rackSkin_m+fuel.rack.matrixThickness_m))
 require('actual central source remains outside all tool contacts',b.toolCentralClearance_m>h.sourceThimbleDiameter_m&&b.toolCentralClearance_m<b.toolHeadWidth_m)
 require('actual lifted tool head fits gate top',fuel.assembly.transferTop_m+b.toolHeadBottomAboveFA_m+b.toolHeadHeight_m<14)
 require('dry captured gravity below finite hoist force',liftWeight<h.hoistForce_N,liftWeight)
 require('paid lifting work below finite supply',liftWeight*h.motionSpeed_m_s<=b.hoistEfficiency*h.hoistPower_W,liftWeight*h.motionSpeed_m_s)
 require('separate fitting capture capacity',fuel.assembly.mass_kg*h.gravity_m_s2<b.jawPairCapacity_N)
 require('separate spider capture capacity',shortCluster*h.gravity_m_s2<b.jawPairCapacity_N)
 require('paid jaw motion not unlimited force',b.jawForce_N*b.jawRate_m_s<=b.hoistEfficiency*b.jawDuty_W)
 require('real pad displacement and finite mass',Math.abs(padV-1e-6)<1e-15,padV*rho)
 require('fixed tips outside FA swept corner envelope',b.tipRadius_m-.0015>fuel.slotCornerRadius_m)
 require('mount reaches actual barrel bore',b.padRadialOuter_m===1.9&&b.tipRadius_m<b.padRadialInner_m)
 require('actual angular free play and existing finite inertia',bodyClearanceAngle>0&&bodyRotaryInertia>0,bodyClearanceAngle)
 const rotationBase={inertia_kg_m2:bodyRotaryInertia,clearanceAngle_rad:bodyClearanceAngle,
  angle_rad:0,omega_rad_s:.001,keyTorque_N_m:.5,guideTorque_N_m:0,guideOverlap:geometry.poses[0]!.guideWaterDisplacement_m3>0,failedGuide:false},
  rotations=[{name:'free play retains actual motion',result:transferBodyRotation(b,rotationBase)},
   {name:'achieved stationary guide contact',result:transferBodyRotation(b,{...rotationBase,angle_rad:bodyClearanceAngle,omega_rad_s:0,keyTorque_N_m:8,guideTorque_N_m:-8})},
   {name:'lost guide admission is not a safe fixed angle',result:transferBodyRotation(b,{...rotationBase,failedGuide:true})}]
 require('free body angular motion is not rigidly cancelled',rotations[0]!.result.kinetic_J>0&&rotations[0]!.result.acceleration_rad_s2>0)
 require('stationary actual guide reaction performs no work',rotations[1]!.result.guideWork_W===0&&rotations[1]!.result.acceleration_rad_s2===0)
 require('failed lateral support preserves unresolved angular motion',!rotations[2]!.result.admitted&&rotations[2]!.result.kinetic_J>0)
 for(const velocities of [[.05,0],[0,.05],[-.05,.02]]){
  const q=transferToolTorsion(b,.13,.01,velocities[0]!,velocities[1]!)
  require('signed shaft hand/output/strain/damping balance '+velocities,Math.abs(q.handWork_W-q.outputWork_W-q.strainRate_W-q.damping_W)<1e-12)
 }
 const joint={gap_m:0,force_N:500,torque_N_m:2,capacity_N:2000,omegaOutput_rad_s:.05,omegaStem_rad_s:.04,omegaBody_rad_s:.001,theta_rad:0,failedContact:false},
  trial=transferJointTrial(b,joint),opened=transferJointTrial(b,{...joint,force_N:0,theta_rad:Math.PI/2})
 require('loaded actual joint has positive slip/contact work',trial.slipHeat_W>0&&trial.ordinaryRotationNotBlocked)
 require('real aligned joint removes body lift authority',opened.aligned&&opened.axialForce_N===0)
 require('relative key friction has one positive physical recipient',Math.abs(trial.keyHeat_W-trial.keyResistance_N_m*.039)<1e-12)
 const bodyWeight=shortCluster*c.gravity_m_s2,stemMass=attachedStemMass/c.clusters,stemWeight=stemMass*c.gravity_m_s2,
  axialBase={bodyMass_kg:shortCluster,stemMass_kg:stemMass,gap_m:0,jointForce_N:bodyWeight,jointCapacity_N:b.jointCapacity_N,gripForce_N:bodyWeight+stemWeight,
   bodyOtherForce_N:-bodyWeight,stemOtherForce_N:-stemWeight,bodyVelocity_m_s:0,stemVelocity_m_s:0,jointFailed:false},
  axial=[...([['raise',.008],['governed lower',-.008],['hold',0]] as const).map(([name,v])=>({name,result:transferAxialTrial({...axialBase,bodyVelocity_m_s:v,stemVelocity_m_s:v})})),
   {name:'released grip, dry gravity limit',result:transferAxialTrial({...axialBase,jointForce_N:0,gripForce_N:0})},
   {name:'failed/open joint, retained stem grip',result:transferAxialTrial({...axialBase,jointForce_N:0,jointFailed:true})},
   {name:'declared upward fluid-force comparison, separated body',result:transferAxialTrial({...axialBase,gap_m:.01,jointForce_N:0,bodyOtherForce_N:100,bodyVelocity_m_s:.01})},
   {name:'supported actual obstruction with retained reaction',result:transferAxialTrial({...axialBase,jointForce_N:500,gripForce_N:500+stemWeight,bodyOtherForce_N:-500})}]
 require('actual gravity support below magnetic force budget',bodyWeight+stemWeight<c.forceLimitPerCluster_N,bodyWeight+stemWeight)
 for(const row of axial)require(row.name+': exact separated force/work incidence',Math.abs(row.result.energyDefect_W)<1e-12,row.result.energyDefect_W)
 require('trip gravity limit has actual acceleration, not scripted pose',axial[3]!.result.bodyAcceleration_m_s2<0)
 require('retained stem grip cannot insert a disconnected body',axial[4]!.result.bodyAcceleration_m_s2<0&&axial[4]!.result.stemAcceleration_m_s2>0)
 require('upward fluid force does not become negative joint insertion',axial[5]!.result.bodyAcceleration_m_s2>0&&axial[5]!.result.contactWork_W===0)
 const jaw=[{name:'normal closure',reaction_N:0,power_W:100,blocked:false},{name:'limited source',reaction_N:10000,power_W:.01,blocked:false},
  {name:'actual obstruction',reaction_N:10000,power_W:100,blocked:true},{name:'lost support',reaction_N:10000,power_W:0,blocked:false}],
  jaws=jaw.map(q=>({...q,result:transferJawMotion(b,q.reaction_N,q.power_W,1,q.blocked)}))
 for(const row of jaws)require(row.name+': paid finite jaw motion/loss',row.result.mechanical_W<=b.hoistEfficiency*row.result.delivered_W+1e-12&&Math.abs(row.result.toolHeat_W-row.result.delivered_W)<1e-12)
 const rq={referenceAtRequest_m:0,reference_m:0,stemDisplacement_m:-fall,bodyDisplacement_m:0,headDisplacement_m:0,requestedAdvance_m:fall},
  reconnection=[{name:'collar retained with unchanged reference',result:transferReconnectionCoordinates(b,c,rq)},
   {name:'no-slip reference advance closes geometric gap',result:transferReconnectionCoordinates(b,c,{...rq,reference_m:fall,stemDisplacement_m:0})},
   {name:'reference completed but one-centimetre slip remains',result:transferReconnectionCoordinates(b,c,{...rq,reference_m:fall,stemDisplacement_m:-.01})},
   {name:'interrupted half advance retains both positions',result:transferReconnectionCoordinates(b,c,{...rq,reference_m:fall/2,stemDisplacement_m:-fall/2})}]
 require('retained original reference does not lift fallen stem',Math.abs(reconnection[0]!.result.remainingStemRise_m-fall)<1e-12)
 require('below-land lug rotation does not require exact contact height',reconnection[0]!.result.lugTop_m<reconnection[0]!.result.landBottom_m)
 require('completed reference preserves diagnosed offset at actual gap closure',reconnection[1]!.result.remainingReferenceTravel_m===0&&Math.abs(reconnection[1]!.result.remainingStemRise_m)<1e-12&&reconnection[1]!.result.diagnosedReferenceOffset_m===fall)
 require('slip exhaustion cannot prove connected body',reconnection[2]!.result.remainingReferenceTravel_m===0&&reconnection[2]!.result.remainingStemRise_m>0)
 require('diagnosed offset is retained physical accounting, not a controller target',reconnection[2]!.result.diagnosedReferenceOffset_m>fall)
 require('interruption is not completed reference or stem motion',reconnection[3]!.result.remainingReferenceTravel_m>0&&reconnection[3]!.result.remainingStemRise_m>0)
 return {scope:'Actual original geometry, separate extensive masses, uplift-only contact and signed shaft/grip work trials; no achieved rotation, drop, assembled head lift or nuclear/handling permission',checks,
  geometry:{addedStemPerCluster_m3:addedStemV,addedStemMetal_kg:addedStemMass,headCapturedStem_kg:attachedStemMass,
   shortCluster_kg:shortCluster,hoistedMass_kg:capturedMass,dryLiftWeight_N:liftWeight,
   toolVolume_m3:toolV,toolMass_kg:toolMass,toolRotaryInertia_kg_m2:toolInertia,
   shoulderFall_m:fall,retainedStemFoot_m:foot,toolHeadTopAtTransfer_m:fuel.assembly.transferTop_m+b.toolHeadBottomAboveFA_m+b.toolHeadHeight_m,
   padEach_m3:padV,padEach_kg:padV*rho,bodyRotaryInertia_kg_m2:bodyRotaryInertia,bodyClearanceAngle_rad:bodyClearanceAngle},torsion,joint:trial,openJoint:opened,rotations,
   axialScope:'Actual dry mass/gravity and declared instantaneous forces/velocities, not a native water or attained travel comparison',axial,jaws,
   reconnectionScope:'Static retained coordinate comparisons only; not a command executor, achieved service trajectory, sensor or source/startup permission',reconnection}
}
export function parseTransferGates(document:string):TransferGates{
 const blocks=[...document.matchAll(/^```reference-transfer-gates\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected exactly one reference-transfer-gates block')
 const b=gateSchema.parse(JSON.parse(blocks[0]![1]!))
 if(b.sills_m.some(s=>s>=b.top_m)||b.stroke_m!==b.width_m)throw Error('Invalid gate extent/stroke')
 return b
}
export function transferGateMotor(b:TransferGates,direction:-1|0|1,velocity:number,power:number){
 if(!Number.isFinite(velocity)||!Number.isFinite(power)||power<0||power>b.motiveDuty_W)throw Error('Invalid actual gate drive input')
 if(![-1,0,1].includes(direction))throw Error('Invalid gate direction')
 if(direction===0||power===0)return {force_N:0,mechanical_W:0,electric_W:0,plateHeat_W:0}
 let force=Math.max(-b.motorForce_N,Math.min(b.motorForce_N,b.motorForce_N*(direction-velocity/b.speedScale_m_s)))
 if(force*velocity>b.driveEfficiency*power)force=b.driveEfficiency*power/velocity
 const mechanical=force*velocity
 return {force_N:force,mechanical_W:mechanical,electric_W:power,plateHeat_W:power-mechanical}
}
export function gateColumnTraction(b:TransferGates,sill:number,leftSurface:number,rightSurface:number,rho:number){
 if(![sill,leftSurface,rightSurface,rho].every(Number.isFinite)||rho<=0)throw Error('Invalid held gate column')
 const primitive=(h:number)=>{const top=Math.min(b.top_m,h);return top>sill?(h-sill)*(top-sill)-.5*(top-sill)**2:0}
 return b.width_m*rho*b.gravity_m_s2*(primitive(leftSurface)-primitive(rightSurface))
}
const integrate=(f:(x:number)=>number,a:number,b:number,tolerance:number):number=>{
 const middle=(a+b)/2,fa=f(a),fm=f(middle),fb=f(b),whole=(b-a)*(fa+4*fm+fb)/6
 const refine=(l:number,r:number,fl:number,fc:number,fr:number,old:number,tol:number,depth:number):number=>{
  const c=(l+r)/2,lc=(l+c)/2,rc=(c+r)/2,flc=f(lc),frc=f(rc),left=(c-l)*(fl+4*flc+fc)/6,right=(r-c)*(fc+4*frc+fr)/6
  if(depth===0)throw Error('Gate work quadrature unresolved')
  if(Math.abs(left+right-old)<=15*tol)return left+right+(left+right-old)/15
  return refine(l,c,fl,flc,fc,left,tol/2,depth-1)+refine(c,r,fc,frc,fr,right,tol/2,depth-1)
 }
 return refine(a,b,fa,fm,fb,whole,tolerance,24)
}
/** Exact Riccati held-column motion, not an evolving bay or gate-flow trajectory. */
export function heldGateTravel(b:TransferGates,mass:number,normalForce:number,rhoLiquid:number,rhoGas:number,
 wetHeight:number,frictionFactor=1,power=b.motiveDuty_W,totalHeight=b.top_m-b.sills_m[0]){
 if(![mass,normalForce,rhoLiquid,rhoGas,wetHeight,frictionFactor,power,totalHeight].every(Number.isFinite)||mass<=0||rhoLiquid<=0||rhoGas<=0||wetHeight<0||wetHeight>totalHeight||totalHeight<=0||frictionFactor<=0||power<0||power>b.motiveDuty_W)throw Error('Invalid held gate case')
 const friction=frictionFactor*(b.guideFriction_N+b.pressureFrictionFactor*Math.abs(normalForce))
 const C=.5*b.dragCoefficient*b.thickness_m*(rhoLiquid*wetHeight+rhoGas*(totalHeight-wetHeight))
 if(C<=0)throw Error('Invalid held fluid drag')
 if(power===0||friction>=b.motorForce_N)return {blocked:true as const,friction_N:friction,normalForce_N:normalForce,power_W:power}
 const A=b.motorForce_N-friction,B=b.motorForce_N/b.speedScale_m_s,root=Math.sqrt(B*B+4*A*C),lambda=root/mass,
  vp=2*A/(B+root),vn=(-B-root)/(2*C),ratio=vp/vn
 if(b.motorForce_N*b.speedScale_m_s/4>b.driveEfficiency*power)throw Error('Held analytic trajectory outside unchanged power-limited branch')
 const v=(t:number)=>{const r=ratio*Math.exp(-lambda*t);return (vp-r*vn)/(1-r)}
 const distance=(t:number)=>vp*t+(vp-vn)/lambda*Math.log((1-ratio*Math.exp(-lambda*t))/(1-ratio))
 let low=0,high=2*b.stroke_m/vp+1
 for(let i=0;i<70;i++){const mid=(low+high)/2;if(distance(mid)<b.stroke_m)low=mid;else high=mid}
 const time=(low+high)/2,velocity=v(time),I2=integrate(t=>v(t)**2,0,time,1e-13),I3=integrate(t=>v(t)**3,0,time,1e-13),
  motorWork=b.motorForce_N*b.stroke_m-B*I2,guideHeat=friction*b.stroke_m,fluidHeat=C*I3,
  kinetic=.5*mass*velocity**2,electric=power*time,actuatorHeat=electric-motorWork,
  balance=motorWork-guideHeat-fluidHeat-kinetic
 const stop=(brake:number)=>{
  const resistance=brake+friction,travel=mass*Math.log1p(C/resistance*velocity**2)/(2*C),
   duration=mass/Math.sqrt(resistance*C)*Math.atan(velocity*Math.sqrt(C/resistance)),
   brakeHeat=brake*travel,guideStopHeat=friction*travel,fluidStopHeat=kinetic-brakeHeat-guideStopHeat
  return {duration_s:duration,travel_m:travel,brakeHeat_J:brakeHeat,guideHeat_J:guideStopHeat,fluidHeat_J:fluidStopHeat,initialKinetic_J:kinetic}
 }
 return {blocked:false as const,friction_N:friction,normalForce_N:normalForce,power_W:power,time_s:time,
  speed_m_s:velocity,travel_m:distance(time),motorWork_J:motorWork,electric_J:electric,
  actuatorHeat_J:actuatorHeat,guideHeat_J:guideHeat,fluidHeat_J:fluidHeat,kinetic_J:kinetic,
  mechanicalBalance_J:balance,stopped:stop(b.brakeForce_N),failedBrake:stop(0)}
}
export function transferGateChecks(b:TransferGates,fixture:{liquidDensity_kg_m3:number,gasDensity_kg_m3:number,surface_m:number}){
 const {liquidDensity_kg_m3:rho,gasDensity_kg_m3:gas,surface_m:surface}=fixture
 if(![rho,gas,surface].every(Number.isFinite)||rho<=0||gas<=0)throw Error('Invalid consumed gate fixture')
 const checks:{name:string,value?:number}[]=[],rows:unknown[]=[]
 const require=(name:string,ok:boolean,value?:number)=>{if(!ok)throw Error(name);checks.push({name,...(value===undefined?{}:{value})})}
 const geometry=b.sills_m.map((sill,i)=>({name:i===0?'WELL':'POOL',sill_m:sill,height_m:b.top_m-sill,
  volume_m3:b.width_m*b.thickness_m*(b.top_m-sill),mass_kg:b.width_m*b.thickness_m*(b.top_m-sill)*b.steelDensity_kg_m3}))
 require('actual well floor retained',b.sills_m[0]===4)
 require('actual original aperture top retained',b.top_m===14)
 require('horizontal park clears full window',b.stroke_m===b.width_m)
 for(const gate of geometry){
  require(gate.name+' native metal is finite',gate.mass_kg>0,gate.mass_kg)
  const normal=gateColumnTraction(b,gate.sill_m,surface,gate.sill_m,rho)
  require(gate.name+' full versus dry head blocks ordinary opening',b.guideFriction_N+b.pressureFrictionFactor*normal>b.motorForce_N,normal)
  const held=heldGateTravel(b,gate.mass_kg,normal,rho,gas,Math.min(gate.height_m,Math.max(0,surface-gate.sill_m)),1,b.motiveDuty_W,gate.height_m)
  require(gate.name+' blocked case retains actual rest',held.blocked)
  rows.push({gate:gate.name,case:'full versus dry',result:held})
  for(const body of [.5,1,2])for(const friction of [.5,1,2]){
   const q=heldGateTravel(b,gate.mass_kg*body,0,rho,gas,Math.min(gate.height_m,Math.max(0,surface-gate.sill_m)),friction,b.motiveDuty_W,gate.height_m)
   if(q.blocked)throw Error('Unexpected matched-level blockage')
   require(gate.name+' matched travel finite '+body+'/'+friction,Number.isFinite(q.time_s)&&q.time_s>0&&q.speed_m_s<b.speedScale_m_s,q.time_s)
   require(gate.name+' simultaneous work balance '+body+'/'+friction,Math.abs(q.mechanicalBalance_J)<1e-4,q.mechanicalBalance_J)
   require(gate.name+' paid loss and reciprocal drag '+body+'/'+friction,q.actuatorHeat_J>=0&&q.guideHeat_J>=0&&q.fluidHeat_J>=0)
   require(gate.name+' finite brake stopping '+body+'/'+friction,q.stopped.travel_m>0&&q.stopped.duration_s>0&&q.stopped.fluidHeat_J>=-1e-10,q.stopped.travel_m)
   require(gate.name+' failed brake is not an ideal pin '+body+'/'+friction,q.failedBrake.travel_m>q.stopped.travel_m,q.failedBrake.travel_m)
   rows.push({gate:gate.name,case:'matched levels',bodyFactor:body,frictionFactor:friction,result:q})
  }
  const dead=heldGateTravel(b,gate.mass_kg,0,rho,gas,gate.height_m,1,0,gate.height_m)
  require(gate.name+' no supply supplies no new travel',dead.blocked)
 }
 const drive=[]
 const driveCases:readonly [string,-1|1,number,number][]=[['stall',1,0,2000],['nominal maximum positive work',1,.025,2000],
  ['limited supply',1,.025,100],['lost supply',1,.025,0],['backdrive',1,-.1,2000],['overspeed',1,.1,2000],['reverse request',-1,.025,2000]]
 for(const [name,d,v,power] of driveCases){
  const q=transferGateMotor(b,d,v,power)
  require(name+': actual force remains capped',Math.abs(q.force_N)<=b.motorForce_N)
  require(name+': actual paid positive work',q.mechanical_W<=b.driveEfficiency*q.electric_W+1e-10)
  require(name+': no unowned negative-work export',q.plateHeat_W>=0&&Math.abs(q.electric_W-q.mechanical_W-q.plateHeat_W)<1e-10)
  drive.push({name,direction:d,velocity_m_s:v,requestedPower_W:power,...q})
 }
 const reversed=transferGateMotor(b,1,.1,b.motiveDuty_W)
 require('backdriven motor work enters finite plate',reversed.mechanical_W<0&&reversed.plateHeat_W>b.motiveDuty_W)
 return {scope:'Held original hydrostatic columns and explicit plate Newton/work/stop checks; no evolving gate flow, parcel or source runtime',checks,geometry,rows,drive}
}
/** Consume only the accepted original column fixture; the remaining receipt is context. */
export function transferGateFixture(value:unknown){
 const identity=z.string().regex(/^[a-f0-9]{64}$/),full=z.object({sourceSHA256:identity,calculationSHA256:identity,consumedInputSHA256:identity,
  consumedInput:z.record(z.string(),z.unknown()),scope:z.string()}).parse(value)
 if(createHash('sha256').update(JSON.stringify(full.consumedInput)).digest('hex')!==full.consumedInputSHA256)throw Error('Head fixture input identity mismatch')
 if(full.scope!=='Held native inventory/head/load, matched wet pool-flow and conditional finite-cell enthalpy duty, saturation/material work limits; no head motion, pool endurance, achieved CCW state, source or procedure execution')throw Error('Unsupported head fixture scope')
 const h=z.object({head:z.object({faceWell_Pa:positive}),CNV:z.object({air_kg:positive,vapor_kg:z.number().finite().nonnegative()}),
  consumedInput:z.object({selection:z.object({cnvPressure_Pa:positive,cnvGasVolume_m3:positive}),
   handling:z.object({surface_m:finite}),control:z.object({headBottom_m:finite,gravity_m_s2:positive})})}).parse(value)
 const base=h.consumedInput,surface=base.handling.surface_m,datum=base.control.headBottom_m
 if(surface<=datum||h.head.faceWell_Pa<=base.selection.cnvPressure_Pa)throw Error('Invalid original column fixture')
 return {liquidDensity_kg_m3:(h.head.faceWell_Pa-base.selection.cnvPressure_Pa)/(base.control.gravity_m_s2*(surface-datum)),
  gasDensity_kg_m3:(h.CNV.air_kg+h.CNV.vapor_kg)/base.selection.cnvGasVolume_m3,surface_m:surface}
}
if(import.meta.main){
 const [ownerPath,headReceiptPath,outputPath,controlPath,fuelPath,handlingPath,...rest]=process.argv.slice(2)
 if(!ownerPath||!headReceiptPath||!outputPath||rest.length||([controlPath,fuelPath,handlingPath].some(Boolean)&&![controlPath,fuelPath,handlingPath].every(Boolean)))throw Error('Usage: bun reference-design-fuel-transfer.ts <fuel-transfer-grapple.md> <accepted-head-pool.json> <output.json> [<control-owner.md> <fuel-construction.md> <fuel-handling.md>]')
 const owner=await Bun.file(ownerPath).text(),reference=await Bun.file(headReceiptPath).text(),fixture=transferGateFixture(JSON.parse(reference))
 const selection=parseTransferGates(owner),consumed={selection,fixture},sha=(s:string)=>createHash('sha256').update(s).digest('hex'),
  result=transferGateChecks(selection,fixture),source=await Bun.file(import.meta.path).text(),receipt={sourceSHA256:sha(source),
   calculationSHA256:sha([gateColumnTraction,transferGateMotor,heldGateTravel,transferGateChecks,transferGateFixture,integrate].map(x=>x.toString()).join('\n')),
   consumedInputSHA256:sha(JSON.stringify(consumed)),consumedInput:consumed,
   contextSHA256:sha(owner),fixtureReceiptSHA256:sha(reference),...result}
 await Bun.write(outputPath,JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({checks:result.checks.length,calculationSHA256:receipt.calculationSHA256,consumedInputSHA256:receipt.consumedInputSHA256,outputPath}))
 if(controlPath&&fuelPath&&handlingPath){
  const documents=await Promise.all([controlPath,fuelPath,handlingPath].map(path=>Bun.file(path).text())),
   control=documents[0]!,fuel=documents[1]!,handling=documents[2]!,attachment=parseTransferAttachment(owner),
   physical={attachment,control:parseControlAbsorber(control),manualServo:parseManualBankServo(control),fuel:parseFuelConstruction(fuel),handling:parseFuelHandling(handling)},
   result=transferAttachmentChecks(attachment,physical.control,physical.fuel,physical.handling),
   sourceHashes=Object.fromEntries(await Promise.all([import.meta.path,import.meta.dir+'/reference-design-control-absorber.ts',import.meta.dir+'/reference-design-fuel-handling.ts',import.meta.dir+'/reference-design-fuel-construction.ts'].map(async path=>[path,sha(await Bun.file(path).text())]))),
   manualServoTrials=[0,.00005,.001,.5,-.001,-.5].map(error=>manualBankMeanRate(physical.manualServo,.5+error,.5)),
   attachmentReceipt={sourceSHA256:sha(source),calculationSHA256:sha([manualBankMeanRate,transferReconnectionCoordinates,transferToolTorsion,transferToolHand,transferAxialTrial,transferJawMotion,transferBodyRotation,transferJointTrial,transferAttachmentChecks,controlAbsorberGeometry,fuelHandlingChecks].map(x=>x.toString()).join('\n')),
    consumedInputSHA256:sha(JSON.stringify(physical)),consumedInput:physical,helperSourceSHA256:sourceHashes,
    ownerContextSHA256:Object.fromEntries([[ownerPath,sha(owner)],[controlPath,sha(control)],[fuelPath,sha(fuel)],[handlingPath,sha(handling)]]),...result,
    manualServoScope:'Static acquired-input arithmetic only; no actual acquisition, sampled servo trajectory, support/protection execution or source qualification',manualServoTrials},
   attachmentOutput=outputPath.replace(/\.json$/, '-attachment.json')
  if(attachmentOutput===outputPath)throw Error('Receipt output must end in .json')
  await Bun.write(attachmentOutput,JSON.stringify(attachmentReceipt,null,2)+'\n')
  console.log(JSON.stringify({attachmentReceipt:attachmentOutput,checks:result.checks.length,geometry:result.geometry}))
 }
}
