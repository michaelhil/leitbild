/** LD-01 physical absorber geometry and exact laminar annulus limits.
 * Offline engineering only: no plant, command executor or fixed drop speed. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling} from './reference-design-fuel-handling'
import {logDarcyFactor} from './reference-design-surge-route'

const positive=z.number().finite().positive(),finite=z.number().finite()
const schema=z.object({clusters:z.literal(52),rodletsPerCluster:z.literal(24),bodyDiameter_m:positive,
 absorberDiameter_m:positive,activeLength_m:positive,bodyLength_m:positive,insertedBodyBottom_m:finite,
 insertedActiveBottom_m:finite,normalTravel_m:positive,parkTravel_m:positive,spiderMass_kg:positive,
 spiderBottom_m:finite,spiderHeight_m:positive,spiderRadius_m:positive,stemDiameter_m:positive,stemLength_m:positive,
 steelDensity_kg_m3:positive,b4cDensity_kg_m3:positive,headBottom_m:finite,headThickness_m:positive,
 headGrossArea_m2:positive,housingID_m:positive,housingOD_m:positive,housingTop_m:finite,
 housingCapHeight_m:positive,neckID_m:positive,neckOD_m:positive,neckTop_m:finite,
 neckCapHeight_m:positive,collarID_m:positive,collarOD_m:positive,collarHeight_m:positive,
 collarBottoms_m:z.array(finite).length(2),guideRoughness_m:positive,endLossEach:positive,
 ordinarySpeedLimit_m_s:positive,driveEfficiency:positive.max(1),deliveredMotiveLimit_W:positive,holdingDuty_W:positive,controllerDuty_W:positive,
 forceLimitPerCluster_N:positive,attachedJackMassPerCluster_kg:positive,jackID_m:positive,jackOD_m:positive,jackBottom_m:finite,
 gapStroke_m:positive,gapArmature_kg:positive,gapSpring_N_m:positive,gapDamping_N_s_m:positive,
 manualGapSpeed_m_s:positive,manualGapForce_N:positive,manualGapPower_W:positive,gravity_m_s2:positive}).strict()
export function parseControlAbsorber(document:string){
 const blocks=[...document.matchAll(/^```reference-control-absorber\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one reference-control-absorber block')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
export type ControlAbsorber=ReturnType<typeof parseControlAbsorber>
const overlap=(a:number,b:number,c:number,d:number)=>Math.max(0,Math.min(b,d)-Math.max(a,c))
/** Exact concentric Newtonian laminar solution, positive upward current/speed.
 * G is pressure gradient less hydrostatic gradient, Pa/m; no piston constraint. */
export function laminarAnnulus(q:{outerRadius_m:number,innerRadius_m:number,length_m:number,
 viscosity_Pa_s:number,gradient_Pa_m:number,bodySpeed_m_s:number}){
 const {outerRadius_m:ro,innerRadius_m:ri,length_m:L,viscosity_Pa_s:mu,gradient_Pa_m:G,bodySpeed_m_s:v}=q
 if(!Object.values(q).every(Number.isFinite)||!(ro>ri&&ri>0&&L>0&&mu>0))throw Error('Unadmitted annulus geometry/state')
 const log=Math.log(ro/ri),delta=ro*ro-ri*ri,
  pressureFactor=ro**4-ri**4-delta*delta/log,
  pressureCurrent=Math.PI*G*pressureFactor/(8*mu),
  wallCurrent=Math.PI*v*(delta/(2*log)-ri*ri),
  bodyForce=2*Math.PI*mu*L*(-v/log+G/(4*mu)*(-2*ri*ri+delta/log)),
  a=-G/(2*mu),b=-v/log+G*delta/(4*mu*log),
  dissipation=2*Math.PI*mu*L*(a*a*(ro**4-ri**4)/4+a*b*delta+b*b*log),
  current=pressureCurrent+wallCurrent,
  work=G*L*current-bodyForce*v
 if(!(pressureFactor>0&&dissipation>=-1e-12))throw Error('Annular limit loses positivity')
 return {current_m3_s:current,pressureCurrent_m3_s:pressureCurrent,wallCurrent_m3_s:wallCurrent,
  bodyViscousForce_N:bodyForce,dissipation_W:dissipation,pressureAndWallWork_W:work,
  conductance_m4_Pa_s:Math.PI*pressureFactor/(8*mu),area_m2:Math.PI*delta}
}
/** Authored symmetric hydraulic-diameter turbulent enhancement of the exact
 * laminar resistance. Both reciprocal forces scale together, preserving work.
 * This is an operational annulus reduction, not annular-turbulence calibration. */
export function annulusResistance(q:{outerRadius_m:number,innerRadius_m:number,length_m:number,
 viscosity_Pa_s:number,density_kg_m3:number,current_m3_s:number,bodySpeed_m_s:number,roughness_m:number}){
 const {outerRadius_m:ro,innerRadius_m:ri,length_m:L,viscosity_Pa_s:mu,density_kg_m3:rho,current_m3_s:Q,bodySpeed_m_s:v,roughness_m:rough}=q
 if(!Object.values(q).every(Number.isFinite)||rho<=0||rough<0)throw Error('Invalid annular material/current')
 const base=laminarAnnulus({outerRadius_m:ro,innerRadius_m:ri,length_m:L,viscosity_Pa_s:mu,gradient_Pa_m:0,bodySpeed_m_s:v}),
  G=(Q-base.wallCurrent_m3_s)/base.conductance_m4_Pa_s,
  exact=laminarAnnulus({outerRadius_m:ro,innerRadius_m:ri,length_m:L,viscosity_Pa_s:mu,gradient_Pa_m:G,bodySpeed_m_s:v}),
  dh=2*(ro-ri),u=Q/base.area_m2,Re=rho*dh*Math.sqrt((u*u+(u-v)**2)/2)/mu,
  shape=16*(ro*ro-ri*ri)*dh*dh/(ro**4-ri**4-(ro*ro-ri*ri)**2/Math.log(ro/ri)),
  enhancement=Re===0?1:Math.max(1,Math.exp(logDarcyFactor(Re,rough/dh))*Re/shape)
 return {gradient_Pa_m:enhancement*G,bodyViscousForce_N:enhancement*exact.bodyViscousForce_N,
  dissipation_W:enhancement*exact.dissipation_W,reynolds:Re,enhancement,
  work_W:enhancement*(G*L*Q-exact.bodyViscousForce_N*v),laminarShape:shape}
}
/** Held uniform-property force discriminator, NOT a native hydraulic drop.
 * Open-return and constrained-current boundaries bracket different mechanisms. */
export function absorberForceScreen(b:ControlAbsorber,h:ReturnType<typeof parseFuelHandling>,geometry:ReturnType<typeof controlAbsorberGeometry>,rho:number,mu:number){
 if(!Number.isFinite(rho)||rho<=0||!Number.isFinite(mu)||mu<=0)throw Error('Invalid force material')
 const ro=h.guideInnerDiameter_m/2,ri=b.bodyDiameter_m/2,area=Math.PI*ri*ri,
  mass=geometry.moving.total_kg,V=geometry.poses[0]!.totalMovingDisplacement_m3,
  weight=mass*b.gravity_m_s2,buoyancy=rho*V*b.gravity_m_s2,
  cases=[] as {boundary:string,length_m:number,ordinaryRequiredForce_N:number,ordinaryRequiredElectrical_W:number,upwardFluidForceAt2m_s_N:number,terminalBelow2m_s:number|null}[]
 for(const length of [b.bodyLength_m-b.normalTravel_m,b.bodyLength_m])for(const boundary of ['open-return-wall-driven','constrained-piston-current']){
  const force=(v:number)=>{
   const wall=laminarAnnulus({outerRadius_m:ro,innerRadius_m:ri,length_m:length,viscosity_Pa_s:mu,gradient_Pa_m:0,bodySpeed_m_s:v}),
    Q=boundary==='open-return-wall-driven'?wall.wallCurrent_m3_s:-area*v,
    r=annulusResistance({outerRadius_m:ro,innerRadius_m:ri,length_m:length,viscosity_Pa_s:mu,density_kg_m3:rho,current_m3_s:Q,bodySpeed_m_s:v,roughness_m:b.guideRoughness_m})
   return geometry.rodlets*(r.bodyViscousForce_N+area*r.gradient_Pa_m*length)
  }
  const required=weight-buoyancy-force(b.ordinarySpeedLimit_m_s)
  let terminal:number|null=null
  if(force(-2)+buoyancy>=weight){
   let lo=0,hi=2
   for(let i=0;i<70;i++){const v=(lo+hi)/2;if(force(-v)+buoyancy<weight)lo=v;else hi=v}
   terminal=(lo+hi)/2
  }
  cases.push({boundary,length_m:length,ordinaryRequiredForce_N:required,ordinaryRequiredElectrical_W:required*b.ordinarySpeedLimit_m_s/b.driveEfficiency,
   upwardFluidForceAt2m_s_N:force(-2),terminalBelow2m_s:terminal})
 }
 return {density_kg_m3:rho,viscosity_Pa_s:mu,weight_N:weight,uniformWaterBuoyancy_N:buoyancy,cases,
  scope:'Steady uniform-property moving-annulus force limits with two expressly different held return boundaries; not fluid history, transient drop time, dashpot/end-stop qualification or guaranteed force bounds.'}
}
/** Exact underdamped spring-armature first-entry and conservative energy split.
 * No body drop or contact lifetime prediction. */
export function gapReleaseLimit(q:Pick<ControlAbsorber,'gapArmature_kg'|'gapSpring_N_m'|'gapDamping_N_s_m'|'gapStroke_m'>){
 const mass=q.gapArmature_kg,k=q.gapSpring_N_m,damping=q.gapDamping_N_s_m,stroke=q.gapStroke_m,alpha=damping/(2*mass),omega=Math.sqrt(k/mass-alpha*alpha),
  time=(Math.PI-Math.atan(omega/alpha))/omega,
  velocity=stroke*Math.exp(-alpha*time)*(omega+alpha*alpha/omega)*Math.sin(omega*time),
  initial=.5*k*stroke*stroke,contactHeat=.5*mass*velocity*velocity
 return {gapFirstEntry_s:time,arrivalSpeed_m_s:velocity,initialSpring_J:initial,dampingHeat_J:initial-contactHeat,stopHeat_J:contactHeat,
  scope:'Unobstructed selected1kg gap armature only. Failed release/obstruction retains actual spring/contact energy; this is not a rod insertion time.'}
}
/** Passive finite-friction grip accounting, without a compliance energy stock. */
export function gripWork(q:{traction_N:number,referenceSpeed_m_s:number,bodySpeed_m_s:number,headSpeed_m_s:number,deliveredPower_W:number}){
 if(!Object.values(q).every(Number.isFinite)||q.deliveredPower_W<0)throw Error('Invalid grip work')
 const motive=q.traction_N*(q.referenceSpeed_m_s-q.headSpeed_m_s),head=q.traction_N*q.headSpeed_m_s,
  body=q.traction_N*q.bodySpeed_m_s,slip=q.traction_N*(q.referenceSpeed_m_s-q.bodySpeed_m_s),loss=q.deliveredPower_W-motive
 if(slip<0||loss<0)throw Error('Nonpassive or unpaid grip transaction')
 return {motiveMechanical_W:motive,headWork_W:head,bodyWork_W:body,slipHeat_W:slip,electricalLoss_W:loss,
  mechanicalDefect_W:motive+head-body-slip,totalDefect_W:q.deliveredPower_W+head-body-slip-loss}
}
/** Validate a simultaneous friction/power candidate, not select achieved speed.
 * Body velocity and required stick reaction come from the coupled Newton balance.
 * In particular, never choose slip traction and subsequently clip reference speed:
 * that can reverse slip and create a nonpassive transaction. */
export function gripCapacity(q:{gap_m:number,gapStroke_m:number,closedForce_N:number,requiredStickForce_N:number,
 bodyHeadRelativeSpeed_m_s:number,referenceHeadRelativeSpeed_m_s:number,deliveredPower_W:number,efficiency:number}){
 if(!Object.values(q).every(Number.isFinite)||q.gapStroke_m<=0||q.closedForce_N<=0||q.gap_m<0||q.gap_m>q.gapStroke_m||q.deliveredPower_W<0||q.efficiency<=0||q.efficiency>1)throw Error('Unadmitted grip capacity input')
 const cap=q.closedForce_N*(1-q.gap_m/q.gapStroke_m),slip=q.referenceHeadRelativeSpeed_m_s-q.bodyHeadRelativeSpeed_m_s,
  stick=slip===0
 if(stick&&Math.abs(q.requiredStickForce_N)>cap)throw Error('Overloaded stick candidate')
 const F=stick?q.requiredStickForce_N:cap*Math.sign(slip),power=F*q.referenceHeadRelativeSpeed_m_s
 if(power>q.efficiency*q.deliveredPower_W)throw Error('Unpaid motive candidate')
 return {traction_N:F,capacity_N:cap,stick,relativeSlipSpeed_m_s:slip,
  referenceHeadRelativeSpeed_m_s:q.referenceHeadRelativeSpeed_m_s,motiveWork_W:power,slipHeat_W:F*slip}
}
export function controlAbsorberGeometry(b:ControlAbsorber,f:ReturnType<typeof parseFuelConstruction>,h:ReturnType<typeof parseFuelHandling>){
 const checks:{name:string,value?:number}[]=[]
 const require=(name:string,ok:boolean,value?:number)=>{if(!ok)throw Error(name);checks.push({name,...(value===undefined?{}:{value})})}
 const sites:{x:number,y:number,x_m:number,y_m:number}[]=[],pitch=f.latticeSide*f.pitch_m
 for(let y=-8;y<=8;y++)for(let x=-8;x<=8;x++){
  const selected=(x%2===0&&y%2===0&&(x!==0||y!==0))||
   (Math.abs(x)===1&&Math.abs(y)===3)||(Math.abs(x)===3&&Math.abs(y)===1)
  if(x*x+y*y<=h.slotRadiusSquared&&selected)sites.push({x,y,x_m:x*pitch,y_m:y*pitch})
 }
 require('exact minority footprint, stationary source assembly excluded',sites.length===b.clusters&&!sites.some(s=>s.x===0&&s.y===0))
 const distance=Math.min(...sites.flatMap((s,i)=>sites.slice(i+1).map(t=>Math.hypot(s.x_m-t.x_m,s.y_m-t.y_m))))
 require('distinct housing envelopes do not overlap',distance>b.housingOD_m,distance)
 require('actual housing footprint fits head envelope',sites.every(s=>Math.hypot(s.x_m,s.y_m)+b.housingOD_m/2<Math.sqrt(b.headGrossArea_m2/Math.PI)))
 require('central source enclosure clears every housing',sites.every(s=>Math.hypot(s.x_m,s.y_m)>b.housingOD_m/2+h.sourceThimbleDiameter_m/2))
 const bodySites=[2,5,8,11,14].flatMap(y=>[2,5,8,11,14].filter(x=>x!==8||y!==8).map(x=>({x_m:(x-8)*f.pitch_m,y_m:(y-8)*f.pitch_m}))),
  bodyRadius=Math.max(...bodySites.map(p=>Math.hypot(p.x_m,p.y_m)+b.bodyDiameter_m/2))
 require('all24 actual body positions and frame clear wide housing',bodySites.length===b.rodletsPerCluster&&bodyRadius<=b.spiderRadius_m&&b.spiderRadius_m<b.housingID_m/2,bodyRadius)
 const guideSites=[2,5,8,11,14].flatMap(y=>[2,5,8,11,14].map(x=>({x_m:(x-8)*f.pitch_m,y_m:(y-8)*f.pitch_m}))),feet=[-.025,.025].flatMap(x=>[-.025,.025].map(y=>({x,y})))
 require('spider support feet clear every real guide opening',feet.every(p=>guideSites.every(g=>Math.hypot(p.x-g.x_m,p.y-g.y_m)>.005*Math.SQRT2+f.guideOuterDiameter_m/2)))
 require('body/core and guide geometry admitted',b.absorberDiameter_m<b.bodyDiameter_m&&b.bodyDiameter_m<h.guideInnerDiameter_m&&b.activeLength_m===f.activeLength_m)
 require('actual upper enclosure and collars admitted',b.neckID_m>b.collarOD_m&&b.collarOD_m>b.collarID_m&&b.collarID_m>b.stemDiameter_m&&b.housingID_m>b.neckOD_m&&b.housingOD_m>b.housingID_m)
 require('head wall starts after slab without annular overlap',b.housingTop_m>b.headBottom_m+b.headThickness_m)
 const N=b.clusters*b.rodletsPerCluster,bodyArea=Math.PI*b.bodyDiameter_m**2/4,
  absorberArea=Math.PI*b.absorberDiameter_m**2/4,stemArea=Math.PI*b.stemDiameter_m**2/4,
  absorberVolume=N*absorberArea*b.activeLength_m,
  shellVolume=N*(bodyArea-absorberArea)*b.activeLength_m,
  endVolume=N*bodyArea*(b.bodyLength_m-b.activeLength_m),
  bodySteel_kg=(shellVolume+endVolume)*b.steelDensity_kg_m3,
  b4c_kg=absorberVolume*b.b4cDensity_kg_m3,
  spiderVolume=b.clusters*b.spiderMass_kg/b.steelDensity_kg_m3,
  stemVolume=b.clusters*stemArea*b.stemLength_m,
  movingMass=b4c_kg+bodySteel_kg+b.clusters*b.spiderMass_kg+stemVolume*b.steelDensity_kg_m3,
  headHoles=b.clusters*Math.PI*b.housingID_m**2/4,
  headSlabVolume=(b.headGrossArea_m2-headHoles)*b.headThickness_m,
  wallVolume=b.clusters*Math.PI*(b.housingOD_m**2-b.housingID_m**2)/4*(b.housingTop_m-b.headBottom_m-b.headThickness_m),
  capBottom=b.housingTop_m,capTop=capBottom+b.housingCapHeight_m,
  mainCapVolume=b.clusters*Math.PI*(b.housingOD_m**2-b.neckID_m**2)/4*b.housingCapHeight_m,
  neckWallVolume=b.clusters*Math.PI*(b.neckOD_m**2-b.neckID_m**2)/4*(b.neckTop_m-capTop),
  neckCapVolume=b.clusters*Math.PI*b.neckOD_m**2/4*b.neckCapHeight_m,
  collarVolume=b.clusters*b.collarBottoms_m.length*Math.PI*(b.collarOD_m**2-b.collarID_m**2)/4*b.collarHeight_m,
  housingMetalVolume=wallVolume+mainCapVolume+neckWallVolume+neckCapVolume+collarVolume,
  jackMass=b.clusters*b.attachedJackMassPerCluster_kg,
  jackLength=b.attachedJackMassPerCluster_kg/(b.steelDensity_kg_m3*Math.PI*(b.jackOD_m**2-b.jackID_m**2)/4),
  attachedMass=(headSlabVolume+housingMetalVolume)*b.steelDensity_kg_m3+jackMass,
  grossMainWater=b.clusters*Math.PI*b.housingID_m**2/4*(b.housingTop_m-b.headBottom_m),
  grossNeckWater=b.clusters*Math.PI*b.neckID_m**2/4*(b.neckTop_m-capBottom)
 require('distinct finite positive materials',absorberVolume>0&&shellVolume>0&&endVolume>0&&headSlabVolume>0&&housingMetalVolume>0)
 require('external finite jack envelope clear of primary and below cap',b.jackOD_m>b.jackID_m&&b.jackID_m>=b.neckOD_m&&b.jackBottom_m>=capTop&&b.jackBottom_m+jackLength<b.neckTop_m)
 require('collars fit neck without overlap',b.collarBottoms_m.every((z,i)=>z>=capTop&&z+b.collarHeight_m<=b.neckTop_m&&b.collarBottoms_m.slice(i+1).every(t=>overlap(z,z+b.collarHeight_m,t,t+b.collarHeight_m)===0)))
 const bodyBottom=b.insertedBodyBottom_m,spiderTop=b.spiderBottom_m+b.spiderHeight_m,
  bodyTop=bodyBottom+b.bodyLength_m,faTop=h.seatedBottom_m+h.bottomFittingLength_m+f.activeLength_m+f.plenumLength_m+h.topFittingLength_m
 require('body/frame supported at actual FA top, lower mouth stays open',Math.abs(bodyTop-faTop)<1e-12&&Math.abs(b.spiderBottom_m-faTop)<1e-12)
 require('PARK physically clears whole FA',bodyBottom+b.parkTravel_m>faTop,bodyBottom+b.parkTravel_m-faTop)
 require('PARK stem remains inside capped pressure boundary',spiderTop+b.stemLength_m+b.parkTravel_m<b.neckTop_m,b.neckTop_m-spiderTop-b.stemLength_m-b.parkTravel_m)
 require('stem spans both collars at inserted and PARK poses',b.collarBottoms_m.every(z=>z>=spiderTop+b.parkTravel_m&&z+b.collarHeight_m<=spiderTop+b.stemLength_m))
 const poses=[0,b.normalTravel_m,b.parkTravel_m].map(y=>{
  const bottom=bodyBottom+y,top=bodyTop+y,spiderBottom=b.spiderBottom_m+y,stemBottom=spiderTop+y,stemTop=stemBottom+b.stemLength_m,
   inRange=(lo:number,hi:number)=>N*bodyArea*overlap(lo,hi,bottom,top)+spiderVolume/b.spiderHeight_m*overlap(lo,hi,spiderBottom,spiderBottom+b.spiderHeight_m)+b.clusters*stemArea*overlap(lo,hi,stemBottom,stemTop),
   activeDisplacement=inRange(-2,2),guideDisplacement=N*bodyArea*overlap(h.seatedBottom_m,faTop,bottom,top),
   mainDisplacement=inRange(b.headBottom_m,b.housingTop_m),neckDisplacement=inRange(capBottom,b.neckTop_m),
   bank=1-overlap(-2,2,b.insertedActiveBottom_m+y,b.insertedActiveBottom_m+b.activeLength_m+y)/b.activeLength_m
  return {travel_m:y,bodyBottom_m:bottom,bodyTop_m:top,spiderTop_m:stemBottom,stemTop_m:stemTop,
   absorberOnlyWithdrawnFraction:bank,activeWaterDisplacement_m3:activeDisplacement,
   guideWaterDisplacement_m3:guideDisplacement,lowerWaterDisplacement_m3:inRange(-4,-2),upperWaterDisplacement_m3:inRange(2,4),
   housingMainWater_m3:grossMainWater-mainDisplacement,housingNeckWater_m3:grossNeckWater-collarVolume-neckDisplacement,
   totalMovingDisplacement_m3:N*bodyArea*b.bodyLength_m+spiderVolume+stemVolume,
   movingGravityRelative_J:movingMass*b.gravity_m_s2*y}
 })
 require('inserted active displacement includes actual1248 bodies',Math.abs(poses[0]!.activeWaterDisplacement_m3-N*bodyArea*f.activeLength_m)<1e-12)
 require('normal withdrawn still overlaps FA and PARK does not',poses[1]!.guideWaterDisplacement_m3>0&&poses[2]!.guideWaterDisplacement_m3===0)
 require('every native head water region remains finite',poses.every(p=>p.housingMainWater_m3>0&&p.housingNeckWater_m3>0))
 const gravityPower=movingMass*b.gravity_m_s2*b.ordinarySpeedLimit_m_s,
  availableMechanical=b.deliveredMotiveLimit_W*b.driveEfficiency
 require('ordinary dry gravity duty fits paid motive cap',gravityPower<availableMechanical,gravityPower)
 require('ordinary dry gravity force fits finite jack authority',movingMass*b.gravity_m_s2<b.clusters*b.forceLimitPerCluster_N)
 require('manual spring closure fits actual force and power',b.manualGapForce_N>b.gapSpring_N_m*b.gapStroke_m+b.gapDamping_N_s_m*b.manualGapSpeed_m_s&&b.manualGapForce_N*b.manualGapSpeed_m_s<b.manualGapPower_W)
 require('gap armature is part of actual jack and underdamped fixture',b.gapArmature_kg<b.attachedJackMassPerCluster_kg&&b.gapDamping_N_s_m**2<4*b.gapArmature_kg*b.gapSpring_N_m)
 require('actual gravity store is not old50kJ effective store',Math.abs(poses[1]!.movingGravityRelative_J-50000)>1000)
 const annulus=laminarAnnulus({outerRadius_m:h.guideInnerDiameter_m/2,innerRadius_m:b.bodyDiameter_m/2,length_m:b.bodyLength_m,viscosity_Pa_s:.000855,gradient_Pa_m:100,bodySpeed_m_s:.008})
 require('laminar annulus reciprocal pressure/wall work',Math.abs(annulus.dissipation_W-annulus.pressureAndWallWork_W)<1e-10)
 const blockedClusterWorth=1/b.clusters // one remains inserted while51fullywithdrawn
 require('one failed cluster retains nonzero effective absorber overlap',blockedClusterWorth>0,blockedClusterWorth)
 return {checks,sites,bodySites,rodlets:N,moving:{b4c_kg,bodySteel_kg,spider_kg:b.clusters*b.spiderMass_kg,stem_kg:stemVolume*b.steelDensity_kg_m3,total_kg:movingMass},
  head:{holes_m2:headHoles,slab_kg:headSlabVolume*b.steelDensity_kg_m3,housingSteel_kg:housingMetalVolume*b.steelDensity_kg_m3,jacks_kg:jackMass,attachedTotal_kg:attachedMass,
   grossMainWater_m3:grossMainWater,grossNeckWater_m3:grossNeckWater,collarDisplacement_m3:collarVolume,insertedStemClearanceLift_m:spiderTop+b.stemLength_m-b.headBottom_m,top_m:b.neckTop_m+b.neckCapHeight_m,
   jackVolume_m3:jackMass/b.steelDensity_kg_m3,jackBottom_m:b.jackBottom_m,jackTop_m:b.jackBottom_m+jackLength},
  poses,annulus,blockedClusterWorth,scope:'Rigid physical envelope, extensive masses/displacement and exact laminar work limits. No installed drive, native hydraulic transient, drop-time, head-motion or criticality acceptance.'}
}
if(import.meta.main){
 const [directory,output,...rest]=Bun.argv.slice(2)
 if(!directory||!output||rest.length)throw Error('Usage: control-absorber <reactor directory> <receipt.json>')
 const names=['control-absorber-and-guide-water.md','fuel-construction.md','fuel-handling-and-pool.md'],docs=await Promise.all(names.map(n=>Bun.file(`${directory}/${n}`).text()))
 const input={control:parseControlAbsorber(docs[0]!),fuel:parseFuelConstruction(docs[1]!),handling:parseFuelHandling(docs[2]!)},result=controlAbsorberGeometry(input.control,input.fuel,input.handling),sha=(s:string)=>createHash('sha256').update(s).digest('hex')
 await Bun.write(output,JSON.stringify({calculationSHA256:sha(await Bun.file(import.meta.path).text()),inputSHA256:sha(JSON.stringify(input)),input,context:names.map((name,i)=>({name,sha256:sha(docs[i]!)})),result},null,2)+'\n')
 console.log(JSON.stringify({receipt:output,checks:result.checks.length,head:result.head,moving:result.moving,poses:result.poses},null,2))
}
