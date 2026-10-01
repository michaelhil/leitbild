/** Arithmetic for an authored obtained-window policy; not a count generator or plant observer. */
import {z} from 'zod'

const schema=z.object({window_s:z.literal(60),alpha:z.literal(.01),theta:z.literal(.1),
 minimumExcessCount:z.literal(400),backgroundRange_s:z.tuple([z.literal(0),z.literal(2)]),
 deadtime_s:z.literal(1e-6),maximumOccupancy:z.literal(.1),sample_s:z.literal(.1),
 noiseBound_A:z.literal(1e-12),commissionOffsetBound_A:z.literal(1e-12),saturation_A:z.literal(.01)}).strict()
export type NuclearWindowPolicy=z.infer<typeof schema>
export function parseNuclearWindow(document:string):NuclearWindowPolicy{
 const blocks=[...document.matchAll(/^```reference-nuclear-observation-window\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one nuclear observation window policy')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function pulseWindowEvidence(policy:NuclearWindowPolicy,observed:{acceptedCounts:number,live_s:number,elapsed_s:number}){
 const {acceptedCounts:N,live_s:E,elapsed_s:T}=observed
 if(!Number.isSafeInteger(N)||N<0||!Number.isFinite(E)||!Number.isFinite(T)||T<=0||T>policy.window_s||E<=0||E>T)
  throw Error('Unusable obtained count/live-exposure window')
 const blocked_s=T-E,tau=policy.deadtime_s
 // At most one inherited block and one end-clipped block; allowance is IEEE arithmetic, not instrument accuracy.
 const roundoff_s=64*Number.EPSILON*Math.max(T,(N+1)*tau)
 if(blocked_s<Math.max(0,(N-1)*tau)-roundoff_s||blocked_s>Math.min(T,(N+1)*tau)+roundoff_s)
  throw Error('Count and live exposure have inconsistent deadtime incidence')
 const c=Math.log(2/policy.alpha),theta=policy.theta
 const compensatorLower=Math.max(0,(theta*N-c)/Math.expm1(theta))
 const compensatorUpper=(theta*N+c)/(-Math.expm1(-theta))
 const excessLower=Math.max(0,compensatorLower-policy.backgroundRange_s[1]*E)
 const excessUpper=Math.max(0,compensatorUpper-policy.backgroundRange_s[0]*E)
 const totalRateLower_s=compensatorLower/E,totalRateUpper_s=compensatorUpper/E
 const entireBandOccupancy=totalRateUpper_s*policy.deadtime_s
 return {compensatorLower,compensatorUpper,excessLower,excessUpper,totalRateLower_s,totalRateUpper_s,
  excessRateLower_s:excessLower/E,excessRateUpper_s:excessUpper/E,entireBandOccupancy,
  fullWindow:T===policy.window_s,
  windowPassesArithmetic:T===policy.window_s&&excessLower>0&&excessLower>=policy.minimumExcessCount&&entireBandOccupancy<policy.maximumOccupancy,
  meaning:'Compensator/live-exposure band only; not instantaneous rate, core fission, period or movement authority'}
}
export function chargeSampleInterval(policy:NuclearWindowPolicy,obtained_A:number){
 if(!Number.isFinite(obtained_A))throw Error('Nonfinite acquired current')
 const error_A=policy.noiseBound_A+policy.commissionOffsetBound_A
 const lower_A=obtained_A-error_A,upper_A=obtained_A+error_A
 return {lower_A,upper_A,unsaturated:Math.abs(lower_A)<policy.saturation_A&&Math.abs(upper_A)<policy.saturation_A,
  meaning:'Interval around obtained filtered common-charge signal; not expected-flux or fission uncertainty'}
}
