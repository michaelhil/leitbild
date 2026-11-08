import { z } from 'zod'
import { engineeringInputBasisSchema, embeddedViewEnvelopeSchema, type ActorContext, type EngineeringInputBasis, type WorkspaceId } from '@leitbild/contracts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { ExecutionStore } from '../core/executions/store.ts'
import type { Tool, ToolContext, ToolResult } from '../core/types/tool.ts'
import { engineeringMethodInputSchema, calculateEngineeringMethod, type EngineeringDatum } from '../core/calculations/engineering-methods.ts'
import { runEngineeringScript } from '../core/calculations/script-runner.ts'
import { createWorkspaceCapabilityTools } from '../tools/built-in/workspace-capability-tools.ts'
import { viewRefFor } from '../core/render-validators/view-fence.ts'
import { bindEngineeringInputs, engineeringBindingsSchema, engineeringFailure, qualifyEngineeringBasis, retainedEngineeringBasis } from './engineering-inputs.ts'

const common = {title:z.string().trim().min(1).max(160),bindings:engineeringBindingsSchema}
export const engineeringCalculateSchema = z.object({...common,calculation:engineeringMethodInputSchema}).strict()
export const engineeringRunSchema = z.object({...common,program:z.union([
  z.object({source:z.string().min(1).max(32_768)}).strict(),
  z.object({reuse:z.object({turnId:z.string().min(1),toolCallId:z.string().min(1)}).strict()}).strict(),
])}).strict()
export const engineeringRequestSchema = z.discriminatedUnion('operation',[
  z.object({operation:z.literal('calculate'),input:engineeringCalculateSchema,refresh:z.boolean().default(false)}).strict(),
  z.object({operation:z.literal('run'),input:engineeringRunSchema,refresh:z.boolean().default(false)}).strict(),
])
type Request = z.infer<typeof engineeringRequestSchema>
export interface EngineeringReceipt {
  readonly kind:'engineering-calculation'
  readonly title:string
  readonly mode:'reviewed-method'|'exploratory-script'
  readonly createdAt:string
  readonly inputs:readonly EngineeringDatum[]
  readonly sources:readonly EngineeringInputBasis[]
  readonly request:{readonly operation:Request['operation'];readonly input:Request['input']}
  readonly outcome:unknown
  readonly qualification:'research-only'
  readonly inputDigest:string
  readonly programSource?:string
}
const failureResult = (error:unknown): ToolResult => ({success:false,error:error instanceof Error ? error.message : String(error),data:{code:typeof error==='object' && error!==null && 'code' in error ? error.code : 'engineering_failed'}})

export const createEngineering = (deps:{workspaceId:WorkspaceId;hostBaseUrl:string;rooms:RoomDirectory;store:ExecutionStore;workspaceCall:Tool;growth:<T>(bytes:number,work:()=>Promise<T>)=>Promise<T>}) => {
  const roomFor = (context:ToolContext,person:boolean) => {
    if (context.comparison) return engineeringFailure('comparison_unsupported','Engineering execution is not admitted in comparison contexts')
    const room = context.roomId ? deps.rooms.getRoom(context.roomId) : undefined
    if (!room) return engineeringFailure('room_missing','The initiating Room is unavailable')
    if (!person && !room.getParticipantIds().includes(context.callerId)) return engineeringFailure('room_membership_required','The invoking Agent is not a participant in this Room')
    return room
  }
  const receiptAt = (roomId:string,turnId:string,callId:string):EngineeringReceipt => {
    const call = deps.store.getCall(roomId,turnId,callId)
    if (!call || !['engineering_calculate','engineering_run'].includes(call.tool) || !call.result?.success) return engineeringFailure('result_missing','No successful engineering execution is retained at this Room address')
    const data = call.result.data as {results?:Array<{key:string;success:boolean;data:EngineeringReceipt}>}|undefined
    const entry = data?.results?.[0]
    if (entry?.key!=='calculation' || !entry.success || entry.data.kind!=='engineering-calculation') return engineeringFailure('result_invalid','The retained execution has no engineering receipt')
    return entry.data
  }
  const execute = async (operation:Request['operation'],params:unknown,context:ToolContext,person=false,workspaceCall=deps.workspaceCall):Promise<ToolResult> => {
    try {
      const scopeRevision = roomFor(context,person).profile.scopeRevision
      if (!context.executionTurnId || !context.executionCallId) return engineeringFailure('execution_required','Engineering requires exact recorded execution identifiers')
      const input = operation==='calculate' ? engineeringCalculateSchema.parse(params) : engineeringRunSchema.parse(params)
      const bound = await bindEngineeringInputs({...deps,workspaceCall},context,input.bindings)
      let programSource:string|undefined
      let outcome:unknown
      if ('calculation' in input) outcome = calculateEngineeringMethod(input.calculation,bound.inputs)
      else {
        programSource = 'source' in input.program ? input.program.source : receiptAt(context.roomId!,input.program.reuse.turnId,input.program.reuse.toolCallId).programSource
        if (programSource===undefined) return engineeringFailure('program_missing','The selected execution does not retain a script')
        outcome = await runEngineeringScript({source:programSource,input:Object.fromEntries(bound.inputs.map(datum=>[datum.name,datum])),...(context.signal ? {signal:context.signal}:{})})
      }
      // A source or Room can change while the disposable process runs. Admission
      // does not grant a lease to publish derived evidence after revocation.
      for (const source of bound.sources) {
        const status = await qualifyEngineeringBasis(workspaceCall,context,source)
        if (!status.allowed) return engineeringFailure(status.code ?? 'source_refused',status.reason ?? 'Source changed before result publication')
      }
      if (roomFor(context,person).profile.scopeRevision !== scopeRevision) return engineeringFailure('room_scope_changed','Room Scope changed during calculation; reacquire permitted evidence')
      context.signal?.throwIfAborted()
      const receipt:EngineeringReceipt = {kind:'engineering-calculation',title:input.title,mode:operation==='calculate'?'reviewed-method':'exploratory-script',createdAt:new Date().toISOString(),...bound,request:{operation,input},outcome,qualification:'research-only',...(programSource===undefined?{}:{programSource})}
      const embeddedView = embeddedViewEnvelopeSchema.parse({moduleId:'agents',viewType:'engineering.result',title:input.title,height:650,
        subject:{workspaceId:deps.workspaceId,moduleId:'agents',type:'agents.room',id:context.roomId},
        state:JSON.stringify({roomId:context.roomId,turnId:context.executionTurnId,toolCallId:context.executionCallId})})
      return {success:true,data:{results:[{key:'calculation',success:true,data:receipt,embeddedView,viewRef:viewRefFor(context.executionCallId,'calculation')}]}}
    } catch (error) {return failureResult(error)}
  }
  const tools:Tool[] = [{
    name:'engineering_describe',contextEffect:'read',description:'Describe the bounded engineering research methods and script contract. Computation does not authorize live control or certify a plant model.',parameters:{type:'object',properties:{},additionalProperties:false},
    execute:async()=>({success:true,data:{methods:['sample_changes','reservoir_balance'],script:{language:'TypeScript',input:'input[name] is a named datum with value, quantity, unit, time, origin and quality. Final expression must be JSON. No imports, exports, I/O, host objects or credentials.',reuse:'program.reuse selects source from a previous engineering_run execution in this Room; every execution binds and qualifies its own inputs.'},observations:'Call world.engineering.inputs.capture on an admitted research Run through workspace_call. Bind the retained turnId, toolCallId, key and quantityId. Never label assumed values as observations.',qualification:'research-only',view:'End an answer with a leitbild-view block containing the returned viewRef.'}}),
  },{
    name:'engineering_calculate',contextEffect:'read',description:'Run reviewed sample_changes or signed reservoir_balance on named, unit-tagged inputs. Bind exact retained owner captures or explicit assumptions. Sources are requalified against this Room Scope; findings remain research evidence. Returns a retained receipt and operator viewRef.',parameters:z.toJSONSchema(engineeringCalculateSchema,{io:'input'}),execute:(params,context)=>execute('calculate',params,context),
  },{
    name:'engineering_run',contextEffect:'read',description:'Run a bounded exploratory TypeScript calculation on named retained observations and explicit assumptions. Use global input and a final JSON expression; no I/O/imports. Reuse previous source with program.reuse; new bindings are mandatory. Script output is untrusted numerical work, not model qualification. Returns a receipt and operator viewRef.',parameters:z.toJSONSchema(engineeringRunSchema,{io:'input'}),execute:(params,context)=>execute('run',params,context),
  }]
  const personCall = (actor:ActorContext) => {
    const tool = createWorkspaceCapabilityTools({workspaceId:deps.workspaceId,hostBaseUrl:deps.hostBaseUrl,getRoomScope:id=>deps.rooms.getRoom(id)?.profile.scope,actor}).find(tool=>tool.name==='workspace_call')
    if (!tool) throw new Error('Workspace invocation tool was not assembled')
    return tool
  }
  const personContext = (roomId:string,actor:ActorContext,signal?:AbortSignal):ToolContext => ({roomId,callerId:actor.id??'anonymous-operator',callerName:actor.displayName??'Operator',...(signal?{signal}:{})})
  return {tools,
    read:async(roomId:string,turnId:string,toolCallId:string,actor:ActorContext) => {
      const context=personContext(roomId,actor)
      const scopeRevision=roomFor(context,true).profile.scopeRevision
      const receipt=receiptAt(roomId,turnId,toolCallId)
      const broker=personCall(actor)
      const sourceStatus=await Promise.all(receipt.sources.map(source=>qualifyEngineeringBasis(broker,context,source)))
      const refused = sourceStatus.find(status=>!status.allowed)
      if (refused) return engineeringFailure(refused.code ?? 'source_refused',refused.reason ?? 'The retained result source is unavailable')
      if (roomFor(context,true).profile.scopeRevision !== scopeRevision) return engineeringFailure('room_scope_changed','Room Scope changed while opening the result')
      return {receipt,sourceStatus}
    },
    // Reserve the bounded request, output and up to 32 retained capture bundles
    // before writing an attempt. Runtime storage policy is shared with Agent turns.
    runForPerson:async(roomId:string,raw:unknown,actor:ActorContext,signal?:AbortSignal) => deps.growth(1024*1024,async()=>{
      const request=engineeringRequestSchema.parse(raw)
      const context=personContext(roomId,actor,signal)
      roomFor(context,true)
      const broker=personCall(actor)
      const turnId=crypto.randomUUID()
      deps.store.beginTurn({id:turnId,roomId,agentId:context.callerId,startedAt:Date.now()})
      let index=0
      const record=async(tool:string,args:Record<string,unknown>,invoke:(ctx:ToolContext)=>Promise<ToolResult>) => {
        const id=`call_1_${index++}`
        deps.store.recordAttempt(turnId,{id,tool,arguments:args,startedAt:Date.now()})
        const result=await invoke({...context,executionTurnId:turnId,executionCallId:id})
        deps.store.recordOutcome(turnId,id,result)
        return {id,result}
      }
      try {
        if (request.refresh) {
          const captures=new Map<string,{turnId:string;toolCallId:string;key:string}>()
          for (let i=0;i<request.input.bindings.length;i++) {
            const binding=request.input.bindings[i]!
            if (binding.kind==='assumption') continue
            const old=retainedEngineeringBasis(deps.store,roomId,binding,deps.workspaceId)
            const key=JSON.stringify([old.source,old.profile,old.subjectId])
            let ref=captures.get(key)
            if (!ref) {
              const args={calls:[{key:'basis',operationId:'world.engineering.inputs.capture',target:{kind:'resource',ref:old.source},input:{profile:old.profile,subjectId:old.subjectId}}]}
              const captured=await record('workspace_call',args,ctx=>broker.execute(args,ctx))
              ref={turnId,toolCallId:captured.id,key:'basis'}
              // Validate the actual retained outcome before admitting this new source.
              const fresh=retainedEngineeringBasis(deps.store,roomId,{...binding,...ref},deps.workspaceId)
              engineeringInputBasisSchema.parse(fresh)
              captures.set(key,ref)
            }
            request.input.bindings[i]={...binding,...ref}
          }
        }
        const result=await record(`engineering_${request.operation==='calculate'?'calculate':'run'}`,request.input,ctx=>execute(request.operation,request.input,ctx,true,broker))
        deps.store.finishTurn(turnId,result.result.success?'completed':'failed',result.result.error)
        if (!result.result.success) return engineeringFailure('execution_failed',result.result.error??'Calculation failed')
        return {turnId,toolCallId:result.id,receipt:receiptAt(roomId,turnId,result.id)}
      } catch(error) {deps.store.finishTurn(turnId,'failed',error instanceof Error?error.message:String(error));throw error}
    }),
  }
}
export type EngineeringService=ReturnType<typeof createEngineering>
