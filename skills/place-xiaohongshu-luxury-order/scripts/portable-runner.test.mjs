import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {OperationStore,batchRefForTask} from './lib/operation-store.mjs';
import {runStandard} from './standard-runner.mjs';
import {paymentProblem} from './lib/order-policy.mjs';
import {paymentDialogAmount,detailIdentity} from './page/payment-facts.mjs';
import {openProposalCart} from './page/cart.mjs';

test('proposal navigation waits for asynchronously rendered members',async()=>{
  let loaded=false,waits=0;
  const value=[{memberKey:'test-member'}];
  const driver={
    readCart:async()=>({value}),select:async()=>{},physicalClick:async()=>{},
    captureResponse:async({trigger})=>{await trigger();return {value};},
    read:async()=>({buttons:['下一步，发布合作'],cartRows:loaded?[{creatorName:'test'}]:[]}),
    h:{gotoAndWait:async()=>{},pageInfo:async()=>({url:'https://pgy.xiaohongshu.com/solar/transaction/proposal'}),wait:async()=>{waits++;loaded=true;}},
  };
  await openProposalCart(driver,{externalOrigin:'https://pgy.xiaohongshu.com'},{expectedMemberKeys:['test-member']});
  assert.equal(waits,1);
  assert.equal(loaded,true);
});

// Technical regressions, not production findings or business acceptance.
const freshDir=t=>{const dir=mkdtempSync(join(tmpdir(),'xhs-regression-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const internal={businessLabel:'奢品回收',contentType:'IMAGE_TEXT',platformLabel:'小红书',internalRole:'商务',internalStatus:'待商务下单',creatorInternalId:'TEST-I',creatorExternalId:'TEST-C',externalTaskId:null,amountMinor:'70000'};
const newOrder=id=>({orderId:id,internal:{...internal},external:{matches:[]}});
const payable=id=>({orderId:id,internal:{...internal,internalStatus:'商务已下单',externalTaskId:'EXT-'+id,advertiserAccountLabel:'上海悦川',advertiserExternalId:'ACCOUNT'},external:{matches:[{externalTaskId:'EXT-'+id,creatorExternalId:'TEST-C',advertiserCompanyLabel:'上海悦川网络信息技术有限公司',advertiserExternalId:'ACCOUNT',status:'WAITING_PAYMENT',cooperationAmountMinor:'70000',serviceFeeMinor:'7000',totalAmountMinor:'77000',spuLabels:['爱回收app','爱回收奢品回收']}]}});
const adapterFor=orders=>({commitProtocol:'BEFORE_FINAL_CLICK',inspectOrder:async({orderId})=>structuredClone(orders.find(o=>o.orderId===orderId))});
const register=(dir,orderIds)=>new OperationStore(dir).bind({taskId:'test-task',operation:'ORDER',orderIds});

test('original batch is fixed; payment subsets stay inside its authorization',async t=>{
 const dir=freshDir(t),store=new OperationStore(dir),batch=await register(dir,['A','B']);
 await assert.rejects(()=>store.bind({taskId:'test-task',operation:'ORDER',orderIds:['A']}),/CONVERSATION_BATCH_MISMATCH/);
 assert.deepEqual((await store.bind({batchRef:batch.batchRef,operation:'PAYMENT',orderIds:['B']})).selectedOrderIds,['B']);
 await assert.rejects(()=>store.bind({batchRef:batch.batchRef,operation:'PAYMENT',orderIds:['C']}),/ORDER_OUTSIDE_AUTHORIZED_BATCH/);
});
test('payment cannot authorize an unregistered order list',async t=>{
 const r=await runStandard({operation:'PAYMENT',taskId:'missing',orderIds:['A'],stateDir:freshDir(t)},adapterFor([payable('A')]));assert.equal(r.reason,'RECOVERY_RECORD_MISSING');
});
test('bad first order does not stop later preview',async t=>{
 const orders=[newOrder('A'),newOrder('B')];orders[0].internal.contentType='VIDEO';orders[0].internal.externalTaskId='OTHER-PLATFORM-ID';const adapter=adapterFor(orders),acted=[];
 adapter.createOrder=async({orderId})=>{acted.push(orderId);return {outcome:'PREVIEW_READY'};};
 const r=await runStandard({operation:'ORDER',taskId:'test-task',orderIds:['A','B'],stateDir:freshDir(t),preview:true},adapter);
 assert.deepEqual(r.orders.map(o=>o.status),['SKIPPED','PREVIEW_READY']);assert.deepEqual(acted,['B']);
});
test('unknown create stays fenced and does not block later orders',async t=>{
 const dir=freshDir(t),store=new OperationStore(dir),batch=await register(dir,['A','B']);store.claim(store.order('A'),batch,'CREATE',null);
 const adapter=adapterFor([newOrder('A'),newOrder('B')]),acted=[];adapter.createOrder=async({orderId})=>{acted.push(orderId);return {outcome:'PREVIEW_READY'};};
 const r=await runStandard({operation:'ORDER',taskId:'test-task',orderIds:['A','B'],stateDir:dir,preview:true},adapter);
 assert.deepEqual(r.orders.map(o=>o.status),['RECONCILE_REQUIRED','PREVIEW_READY']);assert.deepEqual(acted,['B']);
});
test('create then writeback automatically follows persistent readback',async t=>{
 const orders=[newOrder('A')],adapter=adapterFor(orders),calls=[];
 adapter.createOrder=async({beforeCommit})=>{await beforeCommit();calls.push('CREATE');orders[0].external.matches=payable('A').external.matches;return {outcome:'UNKNOWN'};};
 adapter.writebackOrder=async({beforeCommit})=>{await beforeCommit();calls.push('WRITEBACK');orders[0].internal={...payable('A').internal};return {outcome:'UNKNOWN'};};
 const r=await runStandard({operation:'ORDER',taskId:'test-task',orderIds:['A'],stateDir:freshDir(t)},adapter);
 assert.deepEqual(calls,['CREATE','WRITEBACK']);assert.equal(r.orders[0].status,'READY_FOR_PAYMENT');assert.equal(r.paymentComplete,false);
});
test('writeback rejection evidence survives restart without another save',async t=>{
 const dir=freshDir(t),order=newOrder('A');order.external.matches=payable('A').external.matches;
 const adapter=adapterFor([order]);let saves=0;
 adapter.writebackOrder=async({beforeCommit,onEvidence})=>{await beforeCommit();saves++;await onEvidence({status:'APPLICATION_REJECTED',httpStatus:200,applicationCode:500});throw new Error('WRITEBACK_APPLICATION_REJECTED');};
 const input={operation:'ORDER',taskId:'test-task',orderIds:['A'],stateDir:dir};
 await runStandard(input,adapter);
 const persisted=new OperationStore(dir).order('A');
 assert.equal(persisted.pendingAction.action,'WRITEBACK');
 assert.equal(persisted.lastActionEvidence.attemptId,persisted.pendingAction.attemptId);
 const second=await runStandard(input,adapter);
 assert.equal(saves,1);assert.equal(second.orders[0].reason,'WRITEBACK_APPLICATION_REJECTED');
 assert.equal(second.orders[0].lastActionEvidence.status,'APPLICATION_REJECTED');
});
test('a save ACK alone never clears the WRITEBACK fence',async t=>{
 const dir=freshDir(t),order=newOrder('A');order.external.matches=payable('A').external.matches;
 const adapter=adapterFor([order]);let saves=0;
 adapter.writebackOrder=async({beforeCommit,onEvidence})=>{await beforeCommit();saves++;await onEvidence({status:'ACKNOWLEDGED',httpStatus:200,applicationCode:200});return {outcome:'UNKNOWN'};};
 const input={operation:'ORDER',taskId:'test-task',orderIds:['A'],stateDir:dir};
 assert.equal((await runStandard(input,adapter)).orders[0].status,'RECONCILE_REQUIRED');
 order.internal={...payable('A').internal};
 assert.equal((await runStandard(input,adapter)).orders[0].status,'READY_FOR_PAYMENT');
 assert.equal(saves,1);assert.equal(new OperationStore(dir).order('A').pendingAction,null);
});
test('explicit recovery archives one exact old WRITEBACK and cannot replay a new attempt',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A']),store=new OperationStore(dir);
 let r={...store.order('A'),externalTaskId:'EXT-A'};r=store.claim(r,batch,'WRITEBACK','EXT-A');
 const approval={orderId:'A',attemptId:r.pendingAction.attemptId,externalTaskId:'EXT-A',authorizationId:'user-recovery-1',reason:'Explicit retry authorization'};
 const order=newOrder('A');order.external.matches=payable('A').external.matches;const adapter=adapterFor([order]);let saves=0;
 adapter.writebackOrder=async({beforeCommit})=>{await beforeCommit();saves++;return {outcome:'UNKNOWN'};};
 const input={operation:'ORDER',taskId:'test-task',orderIds:['A'],stateDir:dir,writebackRecovery:approval};
 await runStandard(input,adapter);await runStandard(input,adapter);
 const after=store.order('A');assert.equal(saves,1);assert.equal(after.writebackRecoveryHistory[0].previousAttempt.attemptId,approval.attemptId);
 assert.notEqual(after.pendingAction.attemptId,approval.attemptId);
});
test('writeback recovery cannot authorize PAY',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A']),store=new OperationStore(dir);
 const r=store.claim({...store.order('A'),externalTaskId:'EXT-A'},batch,'PAY','EXT-A');
 const adapter=adapterFor([payable('A')]);adapter.payOrder=adapter.writebackOrder=async()=>assert.fail('must not dispatch');
 const approval={orderId:'A',attemptId:r.pendingAction.attemptId,externalTaskId:'EXT-A',authorizationId:'user-recovery-1',reason:'Explicit retry authorization'};
 const result=await runStandard({operation:'ORDER',taskId:'test-task',orderIds:['A'],stateDir:dir,writebackRecovery:approval},adapter);
 assert.equal(result.orders[0].status,'RECONCILE_REQUIRED');assert.equal(store.order('A').pendingAction.action,'PAY');
 assert.equal((await runStandard({operation:'PAYMENT',batchRef:batch.batchRef,orderIds:['A'],stateDir:dir,writebackRecovery:approval},adapter)).reason,'WRITEBACK_RECOVERY_INVALID');
});
test('writeback recovery rejects a different mapping or a different batch',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A']),store=new OperationStore(dir);
 const r=store.claim({...store.order('A'),externalTaskId:'EXT-A'},batch,'WRITEBACK','EXT-A');
 const order=newOrder('A');order.external.matches=payable('A').external.matches;
 const adapter=adapterFor([order]);adapter.writebackOrder=async()=>assert.fail('must not dispatch');
 const approval={orderId:'A',attemptId:r.pendingAction.attemptId,externalTaskId:'WRONG',authorizationId:'user-recovery-1',reason:'Explicit retry authorization'};
 for(const [taskId,externalTaskId] of [['test-task','WRONG'],['another-task','EXT-A']]){
  const result=await runStandard({operation:'ORDER',taskId,orderIds:['A'],stateDir:dir,writebackRecovery:{...approval,externalTaskId}},adapter);
  assert.equal(result.orders[0].status,'RECONCILE_REQUIRED');assert.equal(result.orders[0].reason,'WRITEBACK_RECOVERY_IDENTITY_MISMATCH');
  assert.equal(store.order('A').pendingAction.attemptId,r.pendingAction.attemptId);
  assert.equal(store.order('A').writebackRecoveryHistory,undefined);
 }
});
test('payment has no user-event gate; a post-click error survives the next call',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A']),adapter=adapterFor([payable('A')]);let pays=0;
 adapter.payOrder=async({beforeCommit})=>{await beforeCommit();pays++;throw new Error('READ_FAILED_AFTER_CLICK');};
 const input={operation:'PAYMENT',batchRef:batch.batchRef,stateDir:dir};const a=await runStandard(input,adapter),b=await runStandard({...input,userEvent:null},adapter);
 assert.equal(a.orders[0].status,'RECONCILE_REQUIRED');assert.equal(b.orders[0].status,'RECONCILE_REQUIRED');assert.equal(pays,1);
});
test('payment never creates or writes back an unmapped order',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A']),adapter=adapterFor([newOrder('A')]);adapter.createOrder=adapter.writebackOrder=async()=>assert.fail('wrong capability');
 assert.equal((await runStandard({operation:'PAYMENT',batchRef:batch.batchRef,stateDir:dir},adapter)).orders[0].reason,'PAYMENT_MAPPING_MISSING');
});
test('pending acceptance does not block a payable peer',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A','B']),orders=[payable('A'),payable('B')];orders[0].external.matches[0].status='PENDING';
 const adapter=adapterFor(orders);adapter.payOrder=async()=>({outcome:'PREVIEW_READY'});
 assert.deepEqual((await runStandard({operation:'PAYMENT',batchRef:batch.batchRef,stateDir:dir,preview:true},adapter)).orders.map(o=>o.status),['WAITING_ACCEPTANCE','PREVIEW_READY']);
});
test('payment validates scope, identity, internal status, fee and SPUs',()=>{
 for(const mutate of [o=>o.internal.internalRole='采购',o=>o.internal.internalStatus='已取消',o=>o.external.matches[0].creatorExternalId='OTHER',o=>o.external.matches[0].advertiserExternalId='OTHER',o=>o.external.matches[0].advertiserCompanyLabel='OTHER',o=>o.external.matches[0].serviceFeeMinor='1',o=>o.external.matches[0].spuLabels=['爱回收app']]){const o=payable('A');mutate(o);assert.ok(paymentProblem(o.internal,o.external.matches[0]));}
 const o=payable('A');assert.equal(paymentProblem(o.internal,o.external.matches[0]),null);
});
test('observed payment-dialog wording yields displayed total',()=>{
 assert.equal(paymentDialogAmount({dialogs:[{text:'支付确认内容\n确认支付订单金额后平台将扣除¥ 770。\n取消\n确定'}]}),'77000');
 assert.throws(()=>paymentDialogAmount({dialogs:[{text:'确认支付订单金额后平台将扣除'}]}),/AMOUNT_UNOBSERVED/);
});
test('detail identity rejects a creator mismatch',()=>{
 const dom={href:'https://pgy.xiaohongshu.com/detail/EXT',details:{订单号:'EXT',合作主体:'上海悦川网络信息技术有限公司'},serverIsFresh:true,server:{orderId:'EXT',kolId:'OTHER',brandId:'ACCOUNT'}};
 assert.throws(()=>detailIdentity(dom,{externalOrderId:'EXT',creatorExternalId:'EXPECTED'},{externalOrigin:'https://pgy.xiaohongshu.com'}),/DETAIL_IDENTITY_MISMATCH/);
});
test('actual process death preserves the fence and permits dead-PID lock recovery',async t=>{
 const dir=freshDir(t);await register(dir,['A']);const script=`import {OperationStore} from ${JSON.stringify(new URL('./lib/operation-store.mjs',import.meta.url).href)};const s=new OperationStore(${JSON.stringify(dir)});await s.locked('order:A',async()=>{s.claim(s.order('A'),s.batch(${JSON.stringify(batchRefForTask('test-task'))}),'PAY','EXT-A');process.exit(7)});`;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8'});assert.equal(child.status,7,child.stderr);
 const store=new OperationStore(dir);await store.locked('order:A',async()=>assert.equal(store.order('A').pendingAction.action,'PAY'));
});
test('another live process cannot acquire the same order lock',async t=>{
 const dir=freshDir(t),store=new OperationStore(dir);await store.locked('order:A',async()=>{
 const script=`import {OperationStore} from ${JSON.stringify(new URL('./lib/operation-store.mjs',import.meta.url).href)};try{await new OperationStore(${JSON.stringify(dir)}).locked('order:A',async()=>{});process.exit(2)}catch(e){process.stdout.write(e.message)}`;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8'});assert.equal(child.status,0);assert.equal(child.stdout,'ORDER_LOCK_BUSY');});
});
test('missing existing recovery record cannot be bypassed with a new batch',async t=>{
 const dir=freshDir(t);await register(dir,['A']);unlinkSync(join(dir,'orders',createHash('sha256').update('A').digest('hex')+'.json'));
 const adapter=adapterFor([newOrder('A')]);adapter.createOrder=async()=>assert.fail('lost record');
 assert.equal((await runStandard({operation:'ORDER',taskId:'another-task',orderIds:['A'],stateDir:dir},adapter)).orders[0].reason,'RECOVERY_RECORD_MISSING');
});
test('preview registration cannot later authorize live actions',async t=>{
 const store=new OperationStore(freshDir(t)),batch=await store.bind({operation:'ORDER',taskId:'test-task',orderIds:['A'],preview:true});
 await assert.rejects(()=>store.bind({operation:'PAYMENT',batchRef:batch.batchRef}),/PREVIEW_BATCH_IS_READ_ONLY/);
});

test('an already paid but unmapped cooperation still needs ORDER writeback',async t=>{
 const dir=freshDir(t),order=payable('A');order.internal={...internal};order.external.matches[0].status='PAID';
 const adapter=adapterFor([order]);let writes=0;adapter.writebackOrder=async()=>{writes++;return {outcome:'PREVIEW_READY'};};
 const r=await runStandard({operation:'ORDER',taskId:'test-task',orderIds:['A'],stateDir:dir,preview:true},adapter);
 assert.equal(r.orders[0].action,'WRITEBACK');assert.equal(writes,1);
});
test('fresh paid result clears PAY fence and never pays again',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A']),store=new OperationStore(dir),order=payable('A');
 store.claim(store.order('A'),batch,'PAY','EXT-A');order.external.matches[0].status='PAID_WAITING_NOTE';
 const adapter=adapterFor([order]);adapter.payOrder=async()=>assert.fail('already paid');
 const r=await runStandard({operation:'PAYMENT',batchRef:batch.batchRef,stateDir:dir},adapter);
 assert.equal(r.orders[0].status,'PAID');assert.equal(store.order('A').pendingAction,null);
});

test('an error after payment automatically reconciles its persisted result',async t=>{
 const dir=freshDir(t),batch=await register(dir,['A']),orders=[payable('A')],adapter=adapterFor(orders);let clicks=0;
 adapter.payOrder=async({beforeCommit})=>{await beforeCommit();clicks++;orders[0].external.matches[0].status='PAID_WAITING_NOTE';throw new Error('READ_FAILED_AFTER_CLICK');};
 const r=await runStandard({operation:'PAYMENT',batchRef:batch.batchRef,stateDir:dir},adapter);
 assert.equal(r.orders[0].status,'PAID');assert.equal(clicks,1);assert.equal(new OperationStore(dir).order('A').pendingAction,null);
});
