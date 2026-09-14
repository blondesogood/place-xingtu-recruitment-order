import {matchesBusinessLabelRule} from './business-label.mjs';
import {spuSetEqualsRequired,normalizeBrandLabel} from './aliases.mjs';

export const PAID_STATUSES=new Set(['PAID','PAID_WAITING_NOTE','COMPLETED']);
export const CLOSED_STATUSES=new Set(['CLOSED','CANCELED','REJECTED','PLATFORM_CLOSED']);
export const terminalStatus=status=>PAID_STATUSES.has(status)||CLOSED_STATUSES.has(status);
export const COMPANY='上海悦川网络信息技术有限公司';
export const ACCOUNT='上海悦川';

export function scopeProblem(internal={}) {
  if(!matchesBusinessLabelRule(internal.businessLabel)||internal.contentType!=='IMAGE_TEXT'||internal.platformLabel!=='小红书')return 'INTERNAL_ORDER_INELIGIBLE';
  if(internal.internalRole!=='商务')return 'BUSINESS_ROLE_REQUIRED';
  if(!internal.creatorExternalId||!internal.creatorInternalId)return 'CREATOR_ID_UNOBSERVED';
  return null;
}

export function identityProblem(internal,external) {
  if(!external?.externalTaskId||external.creatorExternalId!==internal.creatorExternalId)return 'DETAIL_IDENTITY_MISMATCH';
  if(internal.externalTaskId&&external.externalTaskId!==internal.externalTaskId)return 'EXTERNAL_TASK_CONFLICT';
  if(external.advertiserCompanyLabel!==COMPANY)return 'ADVERTISER_IDENTITY_MISMATCH';
  if(internal.advertiserExternalId&&external.advertiserExternalId!==internal.advertiserExternalId)return 'ADVERTISER_IDENTITY_MISMATCH';
  return null;
}

export function paymentProblem(internal,external) {
  const problem=scopeProblem(internal)||identityProblem(internal,external);
  if(problem)return problem;
  if(internal.internalStatus!=='商务已下单'||!internal.externalTaskId||internal.advertiserAccountLabel!==ACCOUNT)return 'PAYMENT_INTERNAL_PRESTATE_MISMATCH';
  if(external.status!=='WAITING_PAYMENT')return 'PAYMENT_EXTERNAL_PRESTATE_MISMATCH';
  const minor=value=>/^\d+$/.test(String(value??''))?BigInt(value):null;
  const amount=minor(internal.amountMinor),cooperation=minor(external.cooperationAmountMinor),fee=minor(external.serviceFeeMinor),total=minor(external.totalAmountMinor);
  if(amount===null||amount%10n!==0n||cooperation!==amount||fee!==amount/10n||total!==amount+fee||!spuSetEqualsRequired(external.spuLabels))return 'PAYMENT_FACTS_MISMATCH';
  return null;
}

export function proposalProblem(form,contract) {
  if(form.advertiserAccountLabel!==ACCOUNT||form.advertiserCompanyLabel!==COMPANY||normalizeBrandLabel(form.reportingBrandLabel)!=='爱回收奢品回收')return 'PROPOSAL_IDENTITY_MISMATCH';
  if(form.cooperationTitle!==contract.cooperationTitle||form.dateValue!==contract.publishDate||form.templateLabel!=='奢侈品2'||form.negotiatedPrice!==true||form.retentionDays!==60||form.contentType!=='IMAGE_TEXT'||!spuSetEqualsRequired(form.spuLabels))return 'PROPOSAL_FORM_UNVERIFIED';
  return null;
}

export function errorCode(error) {return typeof error?.code==='string'?error.code:typeof error?.message==='string'?error.message:'TECHNICAL_FAILURE';}
export function errorStatus(code) {
  if(/LOGIN_REQUIRED|CAPTCHA_REQUIRED|PLATFORM_RISK_CONTROL|BUSINESS_ROLE_REQUIRED|ACCOUNT_ACCESS_REQUIRED/.test(code))return 'NEEDS_USER';
  if(/LOCK_BUSY|ACTION_RESULT_UNKNOWN|RECOVERY_RECORD_MISSING/.test(code))return 'RECONCILE_REQUIRED';
  return 'FAILED';
}
export function recoverable(code) {
  return /QUERY_TIMEOUT|UNOBSERVED|TARGET_OBSCURED|BROWSER_CONTEXT_LOST|CONTAINER_NOT_UNIQUE/.test(code)&&errorStatus(code)!=='NEEDS_USER';
}
