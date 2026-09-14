import {createHash} from 'node:crypto';
import {EgoDriver} from './page/ego-driver.mjs';
import {extractInternalFields} from './page/internal.mjs';
import {openProposalCart,addImageTextCreator} from './page/cart.mjs';
import {prepareProposalForm,prepareSubmissionDialog,waitForPage} from './page/proposal-form.mjs';
import {extractProposalFields} from './page/proposal.mjs';
import {prepareWritebackForm} from './page/writeback-form.mjs';
import {submitWriteback} from './page/writeback-submit.mjs';
import {detailPaymentFacts,hasPaymentDialog,paidNoteSpus,paymentDialogAmount} from './page/payment-facts.mjs';
import {scopeProblem,identityProblem,paymentProblem,proposalProblem,terminalStatus} from './lib/order-policy.mjs';

const origins={internal:'https://placement.aihuishou.com',external:'https://pgy.xiaohongshu.com'};
const paths={internal:'/orders',external:'/solar/transaction_v2/brand/order-list/kol'};
const sha=value=>createHash('sha256').update(String(value)).digest('hex');
export const cooperationTitleForOrder=orderId=>`爱回收奢品-${sha(orderId).slice(0,12)}`;
const shanghaiPlus30=()=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).reduce((a,p)=>({...a,[p.type]:p.value}),{});
  const date=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)));date.setUTCDate(date.getUTCDate()+30);return date.toISOString().slice(0,10);
};
const check=problem=>{if(problem)throw new Error(problem);};

async function browserBinding(h,taskId){
  const name='xhs-luxury-'+sha(taskId).slice(0,12),spaces=await h.listTaskSpaces();
  const existing=spaces.find(s=>s.name===name);
  if(existing&&existing.ownership!=='agent')throw new Error('BROWSER_OWNERSHIP_LOST');
  const space=await h.useOrCreateTaskSpace(existing?Number(existing.id):name);
  const binding={taskSpaceId:String(space.id),internalOrigin:origins.internal,externalOrigin:origins.external};
  for(const site of ['internal','external']){
    const tabs=(await h.listTabs()).filter(t=>URL.canParse(t.url)&&new URL(t.url).origin===origins[site]);
    if(tabs.length>1)throw new Error('BROWSER_TAB_AMBIGUOUS');
    const tab=tabs[0]??await h.openOrReuseTab(origins[site]+paths[site],{wait:true,timeout:20});
    binding[site+'TabId']=tab.targetId;
  }
  return binding;
}

async function internalOrder(driver,orderId){
  await driver.select('internal');await driver.h.gotoAndWait(origins.internal+paths.internal,{timeout:20});
  await driver.ensureBusinessRole();
  await waitForPage(()=>driver.h.js(`Boolean(document.querySelector('input[placeholder="搜索订单编号"]'))`),driver.h,'INTERNAL_LIST_UNOBSERVED');
  const {dom,server}=await driver.query({site:'internal',filterSelector:'input[placeholder="搜索订单编号"]',filterValue:orderId,buttonLabel:'刷新',orderId});
  const fields=extractInternalFields(dom,orderId),source=server?.items.filter(v=>v.internalOrderId===orderId)??[];
  if(source.length!==1)throw new Error('INTERNAL_ORDER_NOT_UNIQUE');
  if(source[0].externalOrderId!==fields.existingExternalTaskId||source[0].amountMinor!==fields.internalAmountMinor)throw new Error('INTERNAL_ROW_RESPONSE_MISMATCH');
  let account=null;
  if(fields.existingExternalTaskId&&!scopeProblem({...fields,creatorInternalId:source[0].creatorInternalId,creatorExternalId:source[0].creatorExternalId}))account=await driver.readWritebackAccount(source[0],{internalOrderId:orderId,externalOrderId:fields.existingExternalTaskId,creatorExternalId:source[0].creatorExternalId});
  return {...fields,internalRecordId:source[0].internalRecordId,creatorInternalId:source[0].creatorInternalId,creatorExternalId:source[0].creatorExternalId,creatorProfileHref:dom.creatorLinks[0]??null,
    externalTaskId:fields.existingExternalTaskId,amountMinor:fields.internalAmountMinor,creatorName:dom.tables[0]?.['达人昵称']?.split('\n')[0]?.trim(),
    ...(account?{advertiserAccountLabel:account.accountLabel,advertiserExternalId:account.advertiserExternalId,advertiserAccountSource:account.kind}:{})};
}

async function externalList(driver,title){
  await driver.select('external');await driver.h.gotoAndWait(origins.external+paths.external,{timeout:20});
  const selector='input[placeholder="请输入合作名称"]';
  await waitForPage(()=>driver.h.js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),driver.h,'EXTERNAL_LIST_UNOBSERVED');
  const {server}=await driver.query({site:'external',filterSelector:selector,filterValue:title,buttonLabel:'查询'});
  if(!server||!Number.isInteger(server.totalPage)||server.totalPage>1)throw new Error('EXTERNAL_QUERY_INCOMPLETE');
  return server.items;
}

async function readExternalDetail(driver,binding,externalOrderId,internal,{expectedTitle=null,navigate=true}={}){
  await driver.select('external');
  if(navigate)await driver.h.gotoAndWait(origins.external+'/solar/transaction/order/detail/brand/'+encodeURIComponent(externalOrderId),{timeout:20});
  const info=await driver.h.pageInfo();
  if(/\/login(?:[/?]|$)/i.test(info.url??''))throw new Error('LOGIN_REQUIRED');
  if(!URL.canParse(info.url)||new URL(info.url).origin!==binding.externalOrigin||!new URL(info.url).pathname.endsWith('/'+externalOrderId))throw new Error('DETAIL_IDENTITY_MISMATCH');
  const server=await driver.h.js(`(async()=>{const r=await fetch('/api/solar/order/detail/'+${JSON.stringify(externalOrderId)},{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});if(r.status===401)throw new Error('LOGIN_REQUIRED');if(r.status===403)throw new Error('ACCOUNT_ACCESS_REQUIRED');const b=await r.json();if(!r.ok||b.success!==true||b.data?.orderId!==${JSON.stringify(externalOrderId)})throw new Error('DETAIL_RESPONSE_MISMATCH');return b.data;})()`);
  const dom=await waitForPage(async()=>{const value=await driver.read({scopeSelector:'.solar_body .body_wrapper'});return value.details?.['订单号']===externalOrderId&&(server.orderStatus!=='WAIT_BRAND_PAY'||value.spuLabels.length)?value:null;},driver.h,'DETAIL_DOM_UNCONFIRMED');
  if(expectedTitle&&!String(dom.scopeText??'').split('\n').map(v=>v.trim()).includes(expectedTitle))throw new Error('DETAIL_IDENTITY_MISMATCH');
  dom.server=server;dom.serverIsFresh=true;
  if(!dom.spuLabels.length)dom.spuLabels=paidNoteSpus(dom);
  const detail=detailPaymentFacts(dom,internal,{externalOrderId,creatorExternalId:internal.creatorExternalId,advertiserExternalId:internal.advertiserExternalId},binding);
  const expectedStatus={WAIT_BRAND_PAY:'WAITING_PAYMENT',ORDER_WAIT_SET_PRICE:'PENDING',NOTE_UNRELATED:'PAID_WAITING_NOTE',NOTE_TO_CONFIRM:'PAID_WAITING_NOTE'}[server.orderStatus];
  if(expectedStatus&&detail.externalStatus!==expectedStatus)throw new Error('EXTERNAL_STATUS_MISMATCH');
  return {...detail,externalTaskId:externalOrderId,status:detail.externalStatus};
}

export async function createLiveAdapter(helpers,{taskId}){
  const binding=await browserBinding(helpers,taskId),driver=new EgoDriver(helpers,binding);
  async function inspectOne(orderId){
    const internal=await internalOrder(driver,orderId);
    // An ineligible order needs no external navigation and must not block its peers.
    if(scopeProblem(internal))return {orderId,internal,external:{matches:[]}};
    let matches;
    if(internal.externalTaskId){
      matches=[await readExternalDetail(driver,binding,internal.externalTaskId,internal)];
    }else{
      const title=cooperationTitleForOrder(orderId),rows=(await externalList(driver,title)).filter(v=>v.cooperationTitle===title&&v.creatorExternalId===internal.creatorExternalId);
      if(rows.length>1)throw new Error('EXTERNAL_MATCH_AMBIGUOUS');
      matches=[];
      for(const row of rows)matches.push({...await readExternalDetail(driver,binding,row.externalOrderId,internal,{expectedTitle:title}),cooperationTitle:title});
    }
    return {orderId,internal,external:{matches}};
  }
  const finalCommit=(beforeCommit,preview)=>{
    if(preview||typeof beforeCommit!=='function')throw new Error('FINAL_CLICK_NOT_AUTHORIZED');
    return beforeCommit;
  };
  return {
    commitProtocol:'BEFORE_FINAL_CLICK',binding,
    async inspectOrder({orderId}){return inspectOne(orderId);},
    async inspectBatch(batch){
      const orders=[];for(const orderId of batch.orderIds){try{orders.push(await inspectOne(orderId));}catch(error){orders.push({orderId,error:error.message});}}return {orders};
    },
    async recover(){
      Object.assign(binding,await browserBinding(helpers,taskId));
      await driver.select('internal');await driver.h.gotoAndWait(origins.internal+paths.internal,{timeout:20});await driver.ensureBusinessRole();
    },
    async createOrder({orderId,facts,preview=false,beforeCommit}){
      check(scopeProblem(facts.internal));
      if(facts.internal.externalTaskId||facts.internal.internalStatus!=='待商务下单')throw new Error('CREATE_INTERNAL_PRESTATE_MISMATCH');
      let cart=await driver.readCart();
      if(!cart.value.length){
        const href=facts.internal.creatorProfileHref;if(!href||!URL.canParse(href)||new URL(href).origin!==binding.externalOrigin)throw new Error('CREATOR_ORIGIN_MISMATCH');
        await driver.h.gotoAndWait(href,{timeout:20});await addImageTextCreator(driver);cart=await driver.readCart();
      }
      const cartExact=value=>value.length===1&&value[0].creatorExternalId===facts.internal.creatorExternalId&&value[0].contentType==='IMAGE_TEXT';
      if(!cartExact(cart.value))throw new Error('CART_CONTAMINATED');
      cart=await openProposalCart(driver,binding,{expectedMemberKeys:cart.value.map(v=>v.memberKey)});
      const formMembers=async()=>{const dom=await driver.read();if(dom.cartRows.length!==1||dom.cartRows[0].creatorName!==facts.internal.creatorName||dom.cartRows[0].contentType!=='IMAGE_TEXT')throw new Error('PROPOSAL_MEMBER_MISMATCH');};
      await formMembers();
      const contract={publishDate:shanghaiPlus30(),cooperationTitle:cooperationTitleForOrder(orderId)};
      await prepareProposalForm(driver,contract);await prepareSubmissionDialog(driver);
      const current=await internalOrder(driver,orderId);check(scopeProblem(current));
      for(const key of ['businessLabel','contentType','creatorInternalId','creatorExternalId','externalTaskId','amountMinor','internalRole','internalStatus','platformLabel'])if(current[key]!==facts.internal[key])throw new Error('FINAL_BUSINESS_CHANGED');
      if(current.externalTaskId||current.internalStatus!=='待商务下单')throw new Error('CREATE_INTERNAL_PRESTATE_MISMATCH');
      await driver.select('external');
      const form=extractProposalFields(await driver.read());check(proposalProblem(form,contract));
      await formMembers();
      const finalCart=await driver.readCart();
      if(!cartExact(finalCart.value)||finalCart.value[0].memberKey!==cart.value[0].memberKey)throw new Error('CART_CONTAMINATED');
      if(preview)return {outcome:'PREVIEW_READY',facts:{...form,cartMembers:cart.value.length}};
      await driver.physicalClick({selector:'button',label:'发起合作',scope:'[data-xhs-submit-dialog="1"]'},finalCommit(beforeCommit,preview));
      return {outcome:'UNKNOWN'};
    },
    async writebackOrder({orderId,externalTaskId,facts,preview=false,beforeCommit,onEvidence}){
      const current=await internalOrder(driver,orderId);check(scopeProblem(current));
      if(current.externalTaskId){if(current.externalTaskId!==externalTaskId)throw new Error('EXTERNAL_TASK_CONFLICT');return {outcome:'ALREADY_DONE'};}
      if(current.internalStatus!=='待商务下单')throw new Error('WRITEBACK_INTERNAL_PRESTATE_MISMATCH');
      check(identityProblem(current,facts.external.matches[0]));
      // Re-read external ownership before opening the internal writeback dialog.
      const external=await readExternalDetail(driver,binding,externalTaskId,current,{expectedTitle:cooperationTitleForOrder(orderId)});check(identityProblem(current,external));
      const finalInternal=await internalOrder(driver,orderId);
      if(finalInternal.externalTaskId||finalInternal.creatorExternalId!==current.creatorExternalId||finalInternal.internalStatus!=='待商务下单')throw new Error('FINAL_BUSINESS_CHANGED');
      const form=await prepareWritebackForm(driver,{internalOrderId:orderId,externalOrderId:externalTaskId});
      if(preview)return {outcome:'PREVIEW_READY',facts:{externalTaskId,account:form.account.label}};
      return submitWriteback(driver,{internalRecordId:finalInternal.internalRecordId,externalOrderId:externalTaskId,advertiserId:form.account.externalId},finalCommit(beforeCommit,preview),onEvidence);
    },
    async payOrder({orderId,externalTaskId,preview=false,beforeCommit}){
      let internal=await internalOrder(driver,orderId);
      let external=await readExternalDetail(driver,binding,externalTaskId,internal);
      if(terminalStatus(external.status))return {outcome:'ALREADY_DONE'};
      check(paymentProblem(internal,external));
      await driver.physicalClick({selector:'button',label:'立即支付'});
      await waitForPage(async()=>hasPaymentDialog(await driver.read()),driver.h,'PAYMENT_DIALOG_UNOBSERVED');
      const marked=await driver.h.js(`(()=>{document.querySelectorAll('[data-xhs-payment-dialog]').forEach(e=>e.removeAttribute('data-xhs-payment-dialog'));const roots=[...document.querySelectorAll('.d-modal,[role="dialog"]')].filter(e=>e.getClientRects().length&&e.innerText.includes('确认支付订单金额后平台将扣除'));if(roots.length!==1)return false;roots[0].setAttribute('data-xhs-payment-dialog','1');return true;})()`);
      if(!marked)throw new Error('PAYMENT_DIALOG_UNOBSERVED');
      internal=await internalOrder(driver,orderId);
      external=await readExternalDetail(driver,binding,externalTaskId,internal,{navigate:false});check(paymentProblem(internal,external));
      const dialogAmount=paymentDialogAmount(await driver.read());
      if(dialogAmount!==external.totalAmountMinor)throw new Error('PAYMENT_DIALOG_AMOUNT_MISMATCH');
      if(preview)return {outcome:'PREVIEW_READY',facts:{externalTaskId,amountMinor:internal.amountMinor,serviceFeeMinor:external.serviceFeeMinor,totalAmountMinor:external.totalAmountMinor,dialogAmountMinor:dialogAmount,spuLabels:external.spuLabels}};
      await driver.physicalClick({selector:'button',label:'确定',scope:'[data-xhs-payment-dialog="1"]'},finalCommit(beforeCommit,preview));
      return {outcome:'UNKNOWN'};
    },
  };
}
