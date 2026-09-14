import test from 'node:test';
import assert from 'node:assert/strict';
import {submitWriteback,matchesWriteback} from './page/writeback-submit.mjs';
import {waitForAdvertiserOption} from './page/writeback-form.mjs';

test('advertiser option waits through dropdown animation without clicking',async()=>{
  let probes=0,waits=0;
  const target={selector:'[data-xhs-account-option="3"]'};
  await waitForAdvertiserOption({h:{wait:async()=>{waits++;}},probe:async value=>{
    assert.equal(value,target);probes++;
    if(probes===1)throw new Error('TARGET_NOT_UNIQUE');
    if(probes===2)throw new Error('TARGET_OBSCURED');
  }},target);
  assert.equal(probes,3);assert.equal(waits,2);
});

test('advertiser readiness does not hide unexpected probe failures',async()=>{
  await assert.rejects(waitForAdvertiserOption({h:{wait:async()=>assert.fail('unexpected wait')},probe:async()=>{throw new Error('BROWSER_OWNERSHIP_LOST');}},{}),/BROWSER_OWNERSHIP_LOST/);
});

const expected={internalRecordId:'123',externalOrderId:'456',advertiserId:'account'};
const request={method:'POST',url:'https://h5gate.aihuishou.com/placement-platform-service/api/external-orders?orderId=123',postData:JSON.stringify({externalOrderNo:'456',platformAccountId:'account'})};
function fixture({status=200,code=200,failed=false,missing=false,invalid=false,clickError=false,unfinished=false,malformed=false}={}){
  let clicked=false,polls=0,finished=false,clicks=0;
  const evidence=[];
  const driver={h:{
    cdp:async(method)=>method==='Network.getResponseBody'?{body:malformed?'invalid':JSON.stringify({code}),base64Encoded:false}:{},
    drainEvents:async()=>{
      if(!clicked||missing)return [];
      polls++;
      if(polls===1)return [{method:'Network.requestWillBeSent',params:{requestId:'r1',request}}];
      if(polls===2||unfinished)return [];
      finished=true;
      return failed?[{method:'Network.loadingFailed',params:{requestId:'r1',canceled:true}}]:[
        {method:'Network.responseReceived',params:{requestId:'r1',response:{status}}},
        {method:'Network.loadingFinished',params:{requestId:'r1'}}];
    },wait:async()=>new Promise(r=>setTimeout(r,1)),js:async()=>invalid,
  },physicalClick:async(target,claim)=>{await claim();clicked=true;clicks++;if(clickError)throw new Error('transport lost');}};
  return {driver,evidence,finished:()=>finished,clicks:()=>clicks};
}
test('writeback waits for the matching response before caller can navigate',async()=>{
  const f=fixture();let claimed=false;
  await submitWriteback(f.driver,expected,async()=>{claimed=true;},async e=>f.evidence.push(e));
  assert.equal(claimed,true);
  assert.equal(f.finished(),true,'returning here navigates away and cancels the pending save');
  assert.equal(f.clicks(),1);
  assert.equal(f.evidence.at(-1).status,'ACKNOWLEDGED');
});
for(const [name,options,reason] of [
  ['HTTP rejection',{status:403},'HTTP_REJECTED'],
  ['application rejection',{code:500},'APPLICATION_REJECTED'],
  ['network cancellation',{failed:true},'NETWORK_FAILED'],
  ['request absent',{missing:true},'REQUEST_UNOBSERVED'],
  ['frontend validation',{missing:true,invalid:true},'FORM_VALIDATION_FAILED'],
  ['response still in flight',{unfinished:true},'RESPONSE_TIMEOUT'],
  ['unreadable response',{malformed:true},'RESPONSE_UNREADABLE'],
])test(name+' keeps one click and specific evidence',async()=>{
  const f=fixture(options);
  await assert.rejects(submitWriteback(f.driver,expected,async()=>{},async e=>f.evidence.push(e),{budgetMs:options.missing||options.unfinished?30:1000}),new RegExp('WRITEBACK_'+reason));
  assert.equal(f.clicks(),1);assert.equal(f.evidence.at(-1).status,reason);
});
test('a post-claim click error still waits for save ACK',async()=>{
  const f=fixture({clickError:true});
  await submitWriteback(f.driver,expected,async()=>{},async e=>f.evidence.push(e));
  assert.equal(f.finished(),true);assert.equal(f.clicks(),1);
  assert.equal(f.evidence[0].status,'CLICK_RESULT_UNKNOWN');
  assert.equal(f.evidence.at(-1).status,'ACKNOWLEDGED');
});
test('request matching requires origin, path, record, task and advertiser',()=>{
  assert.equal(matchesWriteback(request,expected),true);
  for(const changed of [
    {...request,method:'GET'},
    {...request,url:request.url.replace('h5gate.aihuishou.com','example.com')},
    {...request,url:request.url.replace('123','999')},
    {...request,url:request.url.replace('external-orders','orders')},
    {...request,postData:JSON.stringify({externalOrderNo:'other',platformAccountId:'account'})},
    {...request,postData:JSON.stringify({externalOrderNo:'456',platformAccountId:'other'})},
    {...request,postData:'invalid'},
  ])assert.equal(matchesWriteback(changed,expected),false);
});
