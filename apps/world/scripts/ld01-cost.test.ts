import {expect,test} from 'bun:test'
import {gate,judge,kindOf,phaseOf} from './ld01-cost'

const G=14.32e9
/** 0.1 s frames from 0 to 20 s; 0.05 quiet, 2.0 over [5, 6) s; event at 5 s. */
function receipt(){
 const frames:[number,number][]=[]
 let i=0
 for(let k=0;k<=200;k++){
  const t=k/10
  if(k>0)i+=(t>5+1e-9&&t<=6+1e-9?2.0:0.05)*G*0.1
  frames.push([t,i])
 }
 const paths=['step[1]','step[1]>jacobian','step[1]>jacobian>nuclear','step[1]>klu-setup','pieces>x']
 const profile={paths,read_instructions:0,frames:frames.map(([t,ins])=>[t,0,[[0,ins*0.4],[0,ins*0.2],[0,ins*0.1],[0,ins*0.2],[0,ins]]])}
 return {case:'CX',timeline:{zero_s:5,last_seat_s:0.95},run:{ou_frame_instructions:frames,perf_profile:profile,
  instants:[{class:'R',t_s:5},{class:'R',t_s:16}]}}
}

test('the judge reads the worst window, steady, restarts and the breakdown',()=>{
 const j=judge(receipt())
 expect(j.worst_0_5_s.rate).toBeCloseTo(2.0,9)
 expect(j.worst_0_5_s.from_after_event_s).toBeGreaterThanOrEqual(0)
 expect(j.steady_last_10_s).toBeCloseTo(0.05,9)
 expect(j.pre_event).toBeCloseTo(0.05,9)
 expect(j.restarts_per_s_after_10_s).toBeCloseTo(1/5,9)
 expect(j.seat_window.to_after_event_s).toBeCloseTo(1,9)
 expect(j.budget).toEqual({dedicated:false,prod:false})
 const b=j.breakdown.worst_0_5_s
 expect(b.by_kind['IDA internals']).toBeCloseTo(0.4,3)
 expect(b.by_kind['Jacobian assembly']).toBeCloseTo(0.2,3)
 expect(b.by_kind['nuclear rows']).toBeCloseTo(0.1,3)
 expect(b.by_kind['KLU factor']).toBeCloseTo(0.2,3)
 expect(b.by_kind['other (unscoped)']).toBeCloseTo(0.1,3)
})

test('paths map to kinds and phases',()=>{
 expect(kindOf('apply>ic>residual>nuclear')).toBe('nuclear rows')
 expect(kindOf('pieces>base: nuclear partials')).toBeNull()
 expect(phaseOf('apply>reinit')).toBe('event handling (incl. reinit, IC)')
 expect(phaseOf('step[6-20]>klu-solve')).toBe('steps [6-20] after segment start')
})

test('the gate takes medians and decides within 2 % only on 3 runs a side',()=>{
 const one=receipt()
 const g=gate([one],[one])
 expect(g.worst_0_5_s.verdict).toBe('undecided: 3 runs each needed within 2 %')
 const g3=gate([one,one,one],[one,one,one])
 expect(g3.worst_0_5_s.verdict).toBe('keeps')
 expect(g3.resolution).toBe(0.01)
})
