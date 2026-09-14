import { parseAdvertiserSelection } from '../lib/aliases.mjs';
import { waitForPage } from './proposal-form.mjs';
import { createHash } from 'node:crypto';

const sha=value=>createHash('sha256').update(String(value)).digest('hex');

export async function waitForAdvertiserOption(driver,target) {
  await waitForPage(async()=>{
    try{await driver.probe(target);return true;}
    catch(error){if(['TARGET_NOT_UNIQUE','TARGET_OBSCURED'].includes(error.message))return false;throw error;}
  },driver.h,'ADVERTISER_OPTION_UNAVAILABLE');
}

// Select only the current visible dialog containing the actual task-ID input.
export function locateWritebackDialog() {
  const visible=e=>{if(!e?.getClientRects().length)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.visibility==='hidden'||s.display==='none'||p.getAttribute('aria-hidden')==='true')return false;}return true;};
  document.querySelectorAll('[data-xhs-writeback-dialog]').forEach(e=>e.removeAttribute('data-xhs-writeback-dialog'));
  document.querySelectorAll('[data-xhs-writeback-input]').forEach(e=>e.removeAttribute('data-xhs-writeback-input'));
  const inputs=[...document.querySelectorAll('input[placeholder="请输入外部订单编号"],input[placeholder="请输入在平台实际下单的订单编号"]')].filter(visible);
  if(inputs.length!==1)return {ok:false};
  const root=inputs[0].closest('[role="dialog"],.ant-modal');if(!root||!visible(root))return {ok:false};
  root.setAttribute('data-xhs-writeback-dialog','1');
  const selects=[...root.querySelectorAll('.ant-select')].filter(visible);
  const account=selects.filter(e=>/广告主|账户/.test(e.closest('.ant-form-item')?.innerText??e.innerText));
  const control=account.length===1?account[0]:selects.length===1?selects[0]:null;
  if(!control)return {ok:false};control.setAttribute('data-xhs-advertiser-control','1');
  inputs[0].setAttribute('data-xhs-writeback-input','1');
  const selected=control.querySelector('.ant-select-content-has-value,.ant-select-selection-item,.ant-select-content-value');
  return {ok:true,value:inputs[0].value,selected:selected?.innerText.trim()??null,owner:root.getAttribute('data-xhs-writeback-owner')};
}
export async function prepareWritebackForm(driver,secret) {
  const owner=sha(secret.internalOrderId);
  let form=await driver.h.js(`(${locateWritebackDialog.toString()})()`);
  if(form.ok&&form.owner!==owner)throw new Error('WRITEBACK_FORM_IDENTITY_MISMATCH');
  if(!form.ok) {
    const located=await driver.h.js(`(()=>{const id=${JSON.stringify(secret.internalOrderId)};const rows=[...document.querySelectorAll('tbody>tr')].filter(r=>[...r.children].some(c=>c.tagName==='TD'&&c.innerText.trim()===id));if(rows.length!==1)return false;const buttons=[...rows[0].querySelectorAll('button,a,[role="button"]')].filter(e=>e.getClientRects().length&&['下单','商务下单','确认下单','填写任务ID'].includes(e.innerText.trim()));if(buttons.length!==1)return false;buttons[0].setAttribute('data-xhs-open-writeback','1');return true;})()`);
    if(!located)throw new Error('WRITEBACK_ENTRY_UNOBSERVED');
    await driver.physicalClick({selector:'[data-xhs-open-writeback="1"]'});
    form=await waitForPage(async()=>{const value=await driver.h.js(`(${locateWritebackDialog.toString()})()`);return value.ok?value:null;},driver.h,'WRITEBACK_DIALOG_UNOBSERVED');
    await driver.h.js(`(()=>{const root=document.querySelector('[data-xhs-writeback-dialog="1"]');if(!root)throw new Error('WRITEBACK_DIALOG_UNOBSERVED');root.setAttribute('data-xhs-writeback-owner',${JSON.stringify(owner)});return true;})()`);
  }
  if(!form.ok)throw new Error('WRITEBACK_DIALOG_UNOBSERVED');
  const taskSelector='[data-xhs-writeback-dialog="1"] [data-xhs-writeback-input="1"]';
  if(form.value&&form.value!==secret.externalOrderId)throw new Error('WRITEBACK_FORM_IDENTITY_MISMATCH');
  if(form.value!==secret.externalOrderId)await driver.h.fillInput(taskSelector,secret.externalOrderId);
  if(!parseAdvertiserSelection(form.selected)) {
    const target={selector:'[data-xhs-advertiser-control="1"]'};
    await waitForPage(async()=>{
      const ready=await driver.h.js(`(()=>{const e=document.querySelector('[data-xhs-advertiser-control="1"]');return Boolean(e&&!e.classList.contains('ant-select-loading'));})()`);
      if(!ready)return false;
      try{await driver.probe(target);return true;}
      catch(error){if(['TARGET_OBSCURED','TARGET_NOT_UNIQUE'].includes(error.message))return false;throw error;}
    },driver.h,'ADVERTISER_CONTROL_UNOBSERVED');
    await driver.physicalClick(target);
    const choices=await waitForPage(async()=>{const values=await driver.h.js(`(()=>{return [...document.querySelectorAll('[role="option"],.ant-select-item-option')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map((e,i)=>{e.setAttribute('data-xhs-account-option',String(i));return {label:e.getAttribute('title')||e.innerText.trim(),selector:'[data-xhs-account-option="'+i+'"]'};});})()`);return values.length?values:null;},driver.h,'ADVERTISER_OPTION_NOT_UNIQUE');
    const matching=choices.filter(c=>parseAdvertiserSelection(c.label));
    if(matching.length!==1)throw new Error('ADVERTISER_OPTION_NOT_UNIQUE');
    const option={selector:matching[0].selector};
    await waitForAdvertiserOption(driver,option);
    await driver.physicalClick(option);
  }
  form=await waitForPage(async()=>{const value=await driver.h.js(`(${locateWritebackDialog.toString()})()`);return value.ok&&value.value===secret.externalOrderId&&parseAdvertiserSelection(value.selected)?value:null;},driver.h,'WRITEBACK_FORM_UNVERIFIED');
  if(!form.ok||form.owner!==owner||form.value!==secret.externalOrderId||!parseAdvertiserSelection(form.selected))throw new Error('WRITEBACK_FORM_UNVERIFIED');
  const submit=await driver.h.js(`(()=>{document.querySelectorAll('[data-xhs-writeback-submit]').forEach(e=>e.removeAttribute('data-xhs-writeback-submit'));const root=document.querySelector('[data-xhs-writeback-dialog="1"]');const buttons=[...root.querySelectorAll('button')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&['确认下单','确定'].includes(e.innerText.trim()));if(buttons.length!==1)return false;buttons[0].setAttribute('data-xhs-writeback-submit','1');return true;})()`);
  if(!submit)throw new Error('WRITEBACK_SUBMIT_UNOBSERVED');
  return {...form,account:parseAdvertiserSelection(form.selected)};
}
