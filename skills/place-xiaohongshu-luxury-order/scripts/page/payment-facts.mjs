import { fieldsByLabel, moneyMinor } from './dom-reader.mjs';
import { canonicalizeExternalStatus } from '../lib/aliases.mjs';

const required=value=>{if(value===null||value===undefined||value==='')throw new Error('OBSERVATION_UNOBSERVED');return value;};
export function submittedNotePaid(dom) {
  return dom.serverIsFresh===true&&dom.server?.orderStatus==='NOTE_TO_CONFIRM'&&dom.server?.state==='waitConfirm'&&
    (dom.taskStatusText??'').includes('合作人已提交合作笔记');
}
// A prior response supplies identity; live task text is also required for the submitted-note state.

export function detailIdentity(dom,secret,binding) {
  const id=required(dom.details?.['订单号']);
  if(dom.serverIsFresh!==true||id!==secret.externalOrderId||dom.server?.orderId!==id||dom.server?.kolId!==secret.creatorExternalId)throw new Error('DETAIL_IDENTITY_MISMATCH');
  const href=new URL(dom.href);
  if(href.origin!==binding.externalOrigin||!href.pathname.endsWith('/'+id))throw new Error('DETAIL_IDENTITY_MISMATCH');
  const accountId=secret.advertiserExternalId;
  if(accountId&&dom.server.brandId!==accountId)throw new Error('DETAIL_IDENTITY_MISMATCH');
  const subject=dom.details['合作主体']??fieldsByLabel(dom,'合作主体')??dom.advertiserCompany??
    (accountId&&dom.server.brandId===accountId?'上海悦川网络信息技术有限公司':null);
  if(dom.server?.orderStatus==='NOTE_TO_CONFIRM'&&!submittedNotePaid(dom))throw new Error('PAID_STATUS_UNCONFIRMED');
  if(subject!=='上海悦川网络信息技术有限公司')throw new Error('ADVERTISER_IDENTITY_MISMATCH');
  const statuses=(dom.scopeText??'').split('\n').map(v=>v.trim()).filter(v=>['待合作人接受','待支付订单','待合作人提交笔记','已完成','已取消','已关闭','合作已关闭'].includes(v));
  return {externalOrderId:id,creatorExternalId:required(dom.server.kolId),advertiserCompanyLabel:required(subject),advertiserExternalId:required(dom.server.brandId),
    externalStatus:submittedNotePaid(dom)?'PAID_WAITING_NOTE':required(canonicalizeExternalStatus(dom.details['状态']??fieldsByLabel(dom,'状态')??(new Set(statuses).size===1?statuses[0]:dom.taskStatusText)))};
}
// Only the fresh, same-order response may supply the paid-note SPUs when that
// page renders a count instead of the pre-payment product labels.
export function paidNoteSpus(dom) {
  if(!submittedNotePaid(dom))return [];
  const bound=dom.server?.noteBindSpuInfo,items=bound?.spuInfo;
  if(!Array.isArray(items)||!Number.isSafeInteger(bound.total)||bound.total!==items.length||
    items.some(item=>item?.bindStatus!==2||typeof item.spuName!=='string'||!item.spuName.trim()))return [];
  return items.map(item=>item.spuName);
}
export function detailPaymentFacts(dom,internalFields,secret,binding) {
  return {...detailIdentity(dom,secret,binding),businessLabel:internalFields.businessLabel,contentType:internalFields.contentType,
    internalStatus:internalFields.internalStatus,currentInternalAmountMinor:internalFields.internalAmountMinor,
    currentInternalTaskId:internalFields.existingExternalTaskId??null,
    currentCreatorInternalId:internalFields.creatorInternalId??null,currentCreatorExternalId:internalFields.creatorExternalId??null,
    cooperationAmountMinor:moneyMinor(dom.details['合作金额']),serviceFeeMinor:moneyMinor(dom.details['平台服务费']),
    totalAmountMinor:moneyMinor(dom.details['总计金额']),spuLabels:dom.spuLabels};
}
export function hasPaymentDialog(dom) {
  return dom.dialogs?.filter(d=>/确认支付订单金额后平台将扣除/.test(d.text)).length===1;
}

export function paymentDialogAmount(dom) {
  const dialogs=dom.dialogs?.filter(d=>d.text.includes('确认支付订单金额后平台将扣除'))??[];
  if(dialogs.length!==1)throw new Error('PAYMENT_DIALOG_UNOBSERVED');
  const matches=[...dialogs[0].text.matchAll(/确认支付订单金额后平台将扣除[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/g)];
  if(matches.length!==1)throw new Error('PAYMENT_DIALOG_AMOUNT_UNOBSERVED');
  return moneyMinor(matches[0][1]);
}
