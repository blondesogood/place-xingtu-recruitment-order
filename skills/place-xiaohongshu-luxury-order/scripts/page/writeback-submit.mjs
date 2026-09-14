const endpoint='https://h5gate.aihuishou.com/placement-platform-service/api/external-orders';
export function matchesWriteback(request,expected){
  try{
    const url=new URL(request.url),body=JSON.parse(request.postData);
    return request.method==='POST'&&url.origin+url.pathname===endpoint&&
      url.searchParams.get('orderId')===expected.internalRecordId&&
      body.externalOrderNo===expected.externalOrderId&&body.platformAccountId===expected.advertiserId;
  }catch{return false;}
}

// Observe the exact save before clicking. Never navigate until it settles or
// the bounded observation fails; neither an ACK nor a rejection clears a fence.
export async function submitWriteback(driver, expected, beforeCommit, onEvidence=async()=>{}, {budgetMs=30000}={}) {
  if(!/^[1-9]\d*$/.test(expected?.internalRecordId??'')||!expected.externalOrderId||!expected.advertiserId)throw new Error('WRITEBACK_REQUEST_IDENTITY_MISSING');
  const emit=async(status,extra={})=>onEvidence({status,...extra});
  const fail=async(status,extra={})=>{await emit(status,extra);throw new Error('WRITEBACK_'+status);};
  await driver.h.cdp('Network.enable',{});await driver.h.drainEvents();
  let claimed=false;
  try{
    await driver.physicalClick({selector:'[data-xhs-writeback-submit="1"]',scope:'[data-xhs-writeback-dialog="1"]'},async()=>{await beforeCommit();claimed=true;});
  }catch(error){
    if(!claimed)throw error;
    await emit('CLICK_RESULT_UNKNOWN'); // Still wait: a transport error is not a failed save.
  }
  const started=Date.now();let requestId=null,httpStatus=null,finished=false;
  while(Date.now()-started<budgetMs){
    for(const event of await driver.h.drainEvents()){
      const p=event.params;
      if(event.method==='Network.requestWillBeSent'&&matchesWriteback(p.request,expected)){
        if(requestId&&requestId!==p.requestId)return fail('REQUEST_AMBIGUOUS');
        requestId=p.requestId;await emit('REQUEST_OBSERVED');
      }
      if(!requestId||p.requestId!==requestId)continue;
      if(event.method==='Network.loadingFailed')return fail('NETWORK_FAILED',{canceled:p.canceled===true});
      if(event.method==='Network.responseReceived')httpStatus=p.response.status;
      if(event.method==='Network.loadingFinished')finished=true;
    }
    if(finished&&httpStatus!==null){
      if(httpStatus!==200)return fail('HTTP_REJECTED',{httpStatus});
      let body;
      try{
        const raw=await driver.h.cdp('Network.getResponseBody',{requestId});
        body=JSON.parse(raw.base64Encoded?Buffer.from(raw.body,'base64').toString('utf8'):raw.body);
      }catch{return fail('RESPONSE_UNREADABLE',{httpStatus});}
      if(body?.code!==200)return fail('APPLICATION_REJECTED',{httpStatus,...(Number.isSafeInteger(body?.code)?{applicationCode:body.code}:{})});
      await emit('ACKNOWLEDGED',{httpStatus,applicationCode:200});
      return {outcome:'UNKNOWN'}; // The standard runner must still read persistence.
    }
    if(!requestId&&await driver.h.js(`(()=>{const root=document.querySelector('[data-xhs-writeback-dialog="1"]');return Boolean(root&&[...root.querySelectorAll('.ant-form-item-explain-error')].some(e=>e.getClientRects().length&&e.innerText.trim()));})()`))return fail('FORM_VALIDATION_FAILED');
    await driver.h.wait(.1);
  }
  return fail(requestId?'RESPONSE_TIMEOUT':'REQUEST_UNOBSERVED');
}
