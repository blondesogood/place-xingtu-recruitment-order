import { canonicalizeCandidateStatus } from '../lib/aliases.mjs';
import { moneyMinor } from './dom-reader.mjs';
import { detailIdentity } from './payment-facts.mjs';

export function platformDate(value,dateOnly=false) {
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>1e12){
    const date=new Date(value);return dateOnly?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date):date.toISOString();
  }
  if(typeof value!=='string')return null;
  if(dateOnly)return /^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(value)?value.slice(0,10):null;
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:$|[.+Z-])/.test(value)?value:null;
}
export function inSubmissionWindow(item,submission) {
  const start=Date.parse(submission.dispatchedAt),raw=item.submittedAt;
  // The live list truncates creation time to minutes. Use its full interval
  // only to prune history; final attribution requires precise detail evidence.
  const minute=typeof raw==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw);
  const value=minute?raw.replace(' ','T')+':00+08:00':platformDate(raw);
  const time=Date.parse(value&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)?value.replace(' ','T')+'+08:00':value);
  return !Number.isFinite(start)||!Number.isFinite(time)||(time+(minute?59999:0))>=start-5000&&time<=start+60000;
}
export function candidateFromDetail(dom,listItem,submission,secret,binding) {
  const identity=detailIdentity(dom,{...secret,externalOrderId:listItem.externalOrderId},binding);
  if(identity.creatorExternalId!==listItem.creatorExternalId||dom.server.brandId!==listItem.advertiserExternalId)throw new Error('DETAIL_IDENTITY_MISMATCH');
  if(!submission?.receiptId||submission.templateLabel!=='奢侈品2'||!submission.evidenceDigest)throw new Error('SUBMISSION_SOURCE_UNOBSERVED');
  const amount=dom.details['合作金额'],minor=moneyMinor(amount);
  const price=minor!==null?{kind:'OBSERVED_NUMERIC',minor}:
    ['价格待协商','待协商确认'].includes(String(amount??'').trim())?{kind:'NEGOTIATED_PENDING'}:{kind:'UNOBSERVED'};
  const submittedAt=platformDate(dom.details['合作发起时间']??dom.server.createTime??listItem.submittedAt);
  return {externalOrderId:identity.externalOrderId,creatorExternalId:identity.creatorExternalId,advertiserCompanyLabel:identity.advertiserCompanyLabel,
    contentType:dom.server.contentType===1?'IMAGE_TEXT':null,candidateStatus:identity.externalStatus,
    cooperationTitle:listItem.cooperationTitle,publishDate:platformDate(listItem.publishDate,true),reportingBrandLabel:listItem.reportingBrandLabel,
    // The platform list does not expose the template. Use only the actual
    // pre-submit page fact attached to the claimed receipt, never the default.
    templateLabel:submission.templateLabel,cooperationAmountMinor:minor??amount??null,price,attribution:submittedAt?{kind:'SUBMISSION_TIME',submittedAt}:null};
}
export function extractCandidates(dom) {
  if(!dom||typeof dom!=='object')throw new Error('STRUCTURED_DOM_REQUIRED');
  return (dom.cards??[]).map(card=>{
    const text=card.text;
    const value=label=>text.match(new RegExp(`(?:^|\\n)${label}[：:]?\\s*([^\\n]+)`))?.[1]?.trim()??null;
    const amount=value('合作金额'),numeric=moneyMinor(amount),submittedAt=value('提交时间')??value('创建时间');
    return {externalOrderId:card.attributes?.orderid??value('订单号')??value('合作ID'),creatorExternalId:card.attributes?.kolid??value('小红书ID')??value('博主ID'),
      contentType:value('内容形式')==='图文'?'IMAGE_TEXT':null,templateLabel:value('合作模板'),advertiserCompanyLabel:value('合作主体'),
      reportingBrandLabel:value('报备品牌'),candidateStatus:canonicalizeCandidateStatus(card.statusText??value('状态'))??'OTHER',
      publishDate:value('发布时间'),cooperationTitle:card.groupTitle??value('合作名称'),cooperationAmountMinor:numeric??amount,
      price:numeric?{kind:'OBSERVED_NUMERIC',minor:numeric}:amount==='价格待协商'?{kind:'NEGOTIATED_PENDING'}:{kind:'UNOBSERVED'},
      attribution:submittedAt?{kind:'SUBMISSION_TIME',submittedAt}:null};
  }).filter(c=>c.externalOrderId);
}
export function runExternal(input) {
  if(input.action==='NAVIGATE_FROZEN_DETAIL')return {orderTag:input.orderTag,factKind:'NAVIGATION',hasSecret:false,fields:{href:input.detailHref,verifyOrigin:true,gotoFrozenTab:true}};
  const candidates=extractCandidates(input.dom);
  return {orderTag:input.orderTag,factKind:input.action==='CHECK_CREATOR'?'CREATOR_STATUS':'CREATE_OUTCOME',hasSecret:true,fields:{candidates}};
}
