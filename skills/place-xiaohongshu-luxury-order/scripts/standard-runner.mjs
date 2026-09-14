import {OperationStore,batchRefForTask} from './lib/operation-store.mjs';
import {PAID_STATUSES,CLOSED_STATUSES,terminalStatus,scopeProblem,identityProblem,paymentProblem,errorCode,errorStatus,recoverable} from './lib/order-policy.mjs';

function checkedInput(input={}) {
  const operation=input.operation??'ORDER';
  if(!['ORDER','PAYMENT'].includes(operation))throw new Error('OPERATION_INVALID');
  if(input.orderIds!==undefined&&(!Array.isArray(input.orderIds)||!input.orderIds.length||input.orderIds.length>20||input.orderIds.some(id=>typeof id!=='string'||!id.trim()||id!==id.trim())||new Set(input.orderIds).size!==input.orderIds.length))throw new Error('ORDER_SET_INVALID');
  if(operation==='ORDER'&&(!input.orderIds||typeof input.taskId!=='string'||!input.taskId))throw new Error('ORDER_SET_INVALID');
  const prior=input.conversationState;
  if(prior?.schemaVersion===1&&(prior.taskId!==input.taskId||!Array.isArray(prior.orderIds)||prior.orderIds.length!==input.orderIds?.length||!prior.orderIds.every(id=>input.orderIds.includes(id))))throw new Error('CONVERSATION_BATCH_MISMATCH');
  if(prior&&![1,2].includes(prior.schemaVersion))throw new Error('STATE_VERSION_UNSUPPORTED');
  return {...input,operation,batchRef:input.batchRef??(prior?.schemaVersion===2?prior.batchRef:undefined)};
}
export function bindConversationBatch(input={}) {
  const value=checkedInput(input);
  return {schemaVersion:2,batchRef:value.batchRef??batchRefForTask(value.taskId),taskId:value.taskId,orderIds:value.orderIds};
}

function matchingExternal(order) {
  const matches=order.external?.matches;
  if(!Array.isArray(matches))throw new Error('EXTERNAL_QUERY_INCOMPLETE');
  if(matches.length>1)throw new Error('EXTERNAL_MATCH_AMBIGUOUS');
  const external=matches[0]??null;
  if(order.internal?.externalTaskId&&external?.externalTaskId!==order.internal.externalTaskId)throw new Error('EXTERNAL_TASK_NOT_FOUND');
  return external;
}
function view(order,record,status,reason=null) {
  return {orderId:order.orderId,externalTaskId:order.internal?.externalTaskId??record.externalTaskId??null,status,...(reason?{reason}:{}),...(record.pendingAction?{pendingAction:record.pendingAction.action}:{}),...(record.lastActionEvidence?{lastActionEvidence:record.lastActionEvidence}:{})};
}

function reconcile(record,order,external) {
  const pending=record.pendingAction;
  if(!pending)return record;
  // Clear a fence only from the exact action's positive persistent result.
  const resolved=pending.action==='CREATE'?Boolean(external):
    pending.action==='WRITEBACK'?order.internal?.externalTaskId===pending.externalTaskId&&order.internal?.internalStatus==='商务已下单'&&order.internal?.advertiserAccountLabel==='上海悦川':
    pending.action==='PAY'?external?.externalTaskId===pending.externalTaskId&&terminalStatus(external.status):false;
  if(!resolved)return record;
  return {...record,pendingAction:null,recoveryRequired:false,externalTaskId:external?.externalTaskId??record.externalTaskId};
}

function decide(input,order,record,external) {
  const internal=order.internal;
  const scoped=scopeProblem(internal);if(scoped)return {status:record.pendingAction?'RECONCILE_REQUIRED':scoped==='INTERNAL_ORDER_INELIGIBLE'?'SKIPPED':errorStatus(scoped),reason:scoped};
  if(external){
    const identity=identityProblem(internal,external);if(identity)return {status:'FAILED',reason:identity};
    if(CLOSED_STATUSES.has(external.status))return {status:'CLOSED'};
  }
  if(record.pendingAction||record.recoveryRequired)return {status:'RECONCILE_REQUIRED',reason:record.pendingAction?(record.lastError??'ACTION_RESULT_UNKNOWN'):'RECOVERY_RECORD_MISSING'};
  if(external&&PAID_STATUSES.has(external.status)&&internal.externalTaskId)return {status:external.status==='COMPLETED'?'COMPLETED':'PAID'};
  if(input.operation==='PAYMENT'){
    if(!internal.externalTaskId)return {status:'FAILED',reason:'PAYMENT_MAPPING_MISSING'};
    if(external?.status==='PENDING')return {status:'WAITING_ACCEPTANCE'};
    if(external?.status!=='WAITING_PAYMENT')return {status:'FAILED',reason:'EXTERNAL_STATUS_UNOBSERVED'};
    const problem=paymentProblem(internal,external);return problem?{status:errorStatus(problem),reason:problem}:{action:'PAY'};
  }
  if(!internal.externalTaskId){
    if(internal.internalStatus!=='待商务下单')return {status:'SKIPPED',reason:'CREATE_INTERNAL_PRESTATE_MISMATCH'};
    return {action:external?'WRITEBACK':'CREATE'};
  }
  if(internal.internalStatus!=='商务已下单'||internal.advertiserAccountLabel!=='上海悦川')return {status:'FAILED',reason:'WRITEBACK_NOT_CONFIRMED'};
  if(external?.status==='PENDING')return {status:'WAITING_ACCEPTANCE'};
  if(external?.status==='WAITING_PAYMENT')return {status:'READY_FOR_PAYMENT'};
  return {status:'FAILED',reason:'EXTERNAL_STATUS_UNOBSERVED'};
}

async function inspect(adapter,batch,orderId) {
  const order=await adapter.inspectOrder({taskId:batch.taskId,orderId});
  if(order?.orderId!==orderId||!order.internal)throw new Error('LIVE_ORDER_INCOMPLETE');
  return order;
}

async function runOrder(input,adapter,store,batch,orderId) {
  return store.locked('order:'+orderId,async()=>{
    let record=store.order(orderId),order={orderId},recoveries=0,postErrorRead=false;
    const actions=[];
    // ORDER needs at most CREATE then WRITEBACK; PAYMENT needs at most PAY.
    for(let step=0;step<8;step++){
      try{
        order=await inspect(adapter,batch,orderId);
        const external=scopeProblem(order.internal)?null:matchingExternal(order);
        if(external){const problem=identityProblem(order.internal,external);if(problem)throw new Error(problem);}
        record=reconcile(record,order,external);
        if(external)record={...record,externalTaskId:external.externalTaskId};
        store.saveOrder(record);
        const planned=decide(input,order,record,external);
        if(!planned.action)return {...view(order,record,planned.status,planned.reason),actions};
        const method={CREATE:'createOrder',WRITEBACK:'writebackOrder',PAY:'payOrder'}[planned.action];
        if(typeof adapter[method]!=='function')throw new Error('LIVE_ACTION_ADAPTER_REQUIRED');
        const outcome=await adapter[method]({orderId,externalTaskId:external?.externalTaskId??null,facts:order,preview:input.preview===true,
          beforeCommit:async()=>{record=store.claim(record,batch,planned.action,external?.externalTaskId);actions.push(planned.action);},
          onEvidence:async evidence=>{
            if(!record.pendingAction)throw new Error('COMMIT_PROTOCOL_VIOLATION');
            record={...record,lastActionEvidence:{...evidence,action:planned.action,attemptId:record.pendingAction.attemptId,observedAt:new Date().toISOString()}};
            store.saveOrder(record);
          }});
        if(outcome?.outcome==='PREVIEW_READY'){
          if(record.pendingAction)throw new Error('PREVIEW_COMMIT_PROTOCOL_VIOLATION');
          return {...view(order,record,'PREVIEW_READY'),action:planned.action,preview:outcome.facts,actions};
        }
        if(outcome?.outcome==='NOT_DISPATCHED'){
          if(record.pendingAction)throw new Error('COMMIT_PROTOCOL_VIOLATION');
          throw new Error(outcome.reason??'ACTION_NOT_DISPATCHED');
        }
        if(!record.pendingAction&&outcome?.outcome!=='ALREADY_DONE')throw new Error('COMMIT_PROTOCOL_VIOLATION');
        // A successful click is still unknown; the next iteration only reads.
      }catch(error){
        const code=errorCode(error);
        if(record.pendingAction){
          record={...record,lastError:code};store.saveOrder(record);
          if(!postErrorRead){postErrorRead=true;continue;} // Read once after an uncertain click; never redispatch.
          return {...view(order,record,'RECONCILE_REQUIRED',code),actions};
        }
        if(recoverable(code)&&recoveries<2&&typeof adapter.recover==='function'){
          recoveries++;
          try{await adapter.recover({orderId,reason:code});continue;}catch(recoveryError){const reason=errorCode(recoveryError);return {...view(order,record,errorStatus(reason),reason),actions};}
        }
        return {...view(order,record,errorStatus(code),code),actions};
      }
    }
    return {...view(order,record,record.pendingAction?'RECONCILE_REQUIRED':'FAILED','EXECUTION_LIMIT_REACHED'),actions};
  });
}

export async function runStandard(rawInput,adapter) {
  let input,batch,store;
  try{
    input=checkedInput(rawInput);
    if(adapter?.commitProtocol!=='BEFORE_FINAL_CLICK'||typeof adapter.inspectOrder!=='function')throw new Error('LIVE_ADAPTER_V2_REQUIRED');
    store=new OperationStore(input.stateDir);batch=await store.bind(input);
  }catch(error){return {decision:'FAILED',reason:errorCode(error),orders:[]};}
  const orders=[];
  // Sequential browser use; a single order's failure never aborts this list.
  for(const orderId of batch.selectedOrderIds){
    try{orders.push(await runOrder(input,adapter,store,batch,orderId));}
    catch(error){const reason=errorCode(error);orders.push({orderId,status:errorStatus(reason),reason,actions:[]});}
  }
  const counts=orders.reduce((result,order)=>(result[order.status]=(result[order.status]??0)+1,result),{});
  const waiting=orders.some(order=>['WAITING_ACCEPTANCE','READY_FOR_PAYMENT'].includes(order.status));
  const unresolved=orders.some(order=>['FAILED','NEEDS_USER','RECONCILE_REQUIRED'].includes(order.status));
  return {decision:unresolved?'PARTIAL':waiting?'WAITING':'COMPLETE',operation:input.operation,batchRef:batch.batchRef,
    conversationState:{schemaVersion:2,batchRef:batch.batchRef,taskId:batch.taskId,orderIds:batch.orderIds},orders,counts,
    phaseComplete:!unresolved&&orders.every(order=>order.status!=='PREVIEW_READY'),
    paymentComplete:orders.every(order=>['PAID','COMPLETED'].includes(order.status))};
}
export function listAuthorizedBatches({stateDir}={}) {return new OperationStore(stateDir).listBatches();}
export function isExternalTerminal(status){return terminalStatus(status);}
