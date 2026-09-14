import { extractProposalFields } from './proposal.mjs';
import { spuSetEqualsRequired } from '../lib/aliases.mjs';

const requiredSpus=['爱回收app','爱回收奢品回收'];
export async function waitForPage(check,{wait},code,budgetMs=15000) {
  const start=Date.now();
  while(Date.now()-start<budgetMs){const value=await check();if(value)return value;await wait(0.1);}
  throw new Error(code);
}
// Mark an observed, unique leaf label. All physical actions still use the
// driver's scroll, visibility and hit checks after marking.
export async function labelTarget(driver,selector,label,attribute='data-xhs-form-choice',promote=true) {
  const found=await driver.h.js(`(()=>{document.querySelectorAll('[${attribute}]').forEach(e=>e.removeAttribute('${attribute}'));const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&e.innerText.trim()===${JSON.stringify(label)});const leaves=nodes.filter(e=>!nodes.some(n=>n!==e&&e.contains(n)));if(leaves.length!==1)return false;const target=${promote?'leaves[0].closest(\'.d-option\')??leaves[0]':'leaves[0]'};target.setAttribute('${attribute}','1');return true;})()`);
  if(!found)throw new Error('FORM_OPTION_NOT_UNIQUE');
  return {selector:`[${attribute}="1"]`,scroll:false};
}
async function selectSpu(driver,label){
  const visible=await driver.h.js(`(()=>[...document.querySelectorAll('.d-option-content')].some(e=>e.getClientRects().length&&[...e.querySelectorAll('span')].some(s=>s.innerText.trim()===${JSON.stringify(label)})))()`);
  if(!visible){await driver.physicalClick({selector:'.spu-selector .d-select'});await waitForPage(()=>driver.h.js(`(()=>[...document.querySelectorAll('.d-option-content')].some(e=>e.getClientRects().length&&[...e.querySelectorAll('span')].some(s=>s.innerText.trim()===${JSON.stringify(label)})))()`),driver.h,'SPU_OPTION_UNOBSERVED');}
  const marked=await driver.h.js(`(()=>{document.querySelectorAll('[data-xhs-spu-checkbox]').forEach(e=>e.removeAttribute('data-xhs-spu-checkbox'));const content=[...document.querySelectorAll('.d-option-content')].filter(e=>e.getClientRects().length&&[...e.querySelectorAll('span')].some(s=>s.innerText.trim()===${JSON.stringify(label)}));if(content.length!==1)return false;const item=content[0].parentElement,row=item.style.gridRowStart,parent=item.parentElement;const prefix=[...parent.children].find(e=>e.style.gridRowStart===row&&e.style.gridColumnStart==='1'&&e.style.gridColumnEnd==='2');const target=prefix?.querySelector('.d-checkbox-simulator'),scroller=content[0].closest('.d-dropdown-content');if(!target||!scroller)return false;scroller.scrollTop=item.offsetTop-scroller.clientHeight/2;target.setAttribute('data-xhs-spu-checkbox','1');return true;})()`);
  if(!marked)throw new Error('SPU_OPTION_UNOBSERVED');
  const target={selector:'[data-xhs-spu-checkbox="1"]',scroll:false};
  await waitForPage(async()=>{
    try{await driver.probe(target);return true;}
    catch(error){if(['TARGET_NOT_UNIQUE','TARGET_OBSCURED'].includes(error.message))return false;throw error;}
  },driver.h,'SPU_TARGET_UNAVAILABLE');
  await driver.physicalClick(target);
  await waitForPage(async()=>extractProposalFields(await driver.read()).spuLabels.includes(label),driver.h,'SPU_SELECTION_UNVERIFIED');
}
export async function dismissProposalHints(driver) {
  const dom=await driver.read();
  const promotion=dom.dialogs.filter(d=>d.text.includes('确定勾选')&&d.text.includes('广告审核')&&d.buttons.includes('我知道了'));
  if(promotion.length===1){
    const marked=await driver.h.js(`(()=>{document.querySelectorAll('[data-xhs-hint-close]').forEach(e=>e.removeAttribute('data-xhs-hint-close'));const roots=[...document.querySelectorAll('.d-modal')].filter(e=>e.getClientRects().length&&e.innerText.includes('确定勾选')&&e.innerText.includes('广告审核'));const buttons=roots.length===1?[...roots[0].querySelectorAll('button')].filter(e=>e.getClientRects().length&&e.innerText.trim()==='我知道了'):[];if(buttons.length!==1)return false;buttons[0].setAttribute('data-xhs-hint-close','1');return true;})()`);
    if(!marked)throw new Error('PROMOTION_OVERLAY');
    await driver.h.click('[data-xhs-hint-close="1"]',{label:'关闭投广提示'});
    await waitForPage(async()=>!(await driver.read()).dialogs.some(d=>d.text.includes('确定勾选')),driver.h,'PROMOTION_OVERLAY');
  }
  const negotiation=(await driver.read()).dialogs.filter(d=>d.text.includes('协商价格确认')&&d.text.includes('修改价格需要博主填写金额')&&d.buttons.includes('确认'));
  if(negotiation.length===1){
    const marked=await driver.h.js(`(()=>{document.querySelectorAll('[data-xhs-negotiation-confirm]').forEach(e=>e.removeAttribute('data-xhs-negotiation-confirm'));const roots=[...document.querySelectorAll('.d-modal')].filter(e=>e.getClientRects().length&&e.innerText.includes('协商价格确认'));const buttons=roots.length===1?[...roots[0].querySelectorAll('button')].filter(e=>e.getClientRects().length&&e.innerText.trim()==='确认'):[];if(buttons.length!==1)return false;buttons[0].setAttribute('data-xhs-negotiation-confirm','1');return true;})()`);
    if(!marked)throw new Error('NEGOTIATION_DIALOG_UNCONFIRMED');
    await driver.h.click('[data-xhs-negotiation-confirm="1"]',{label:'确认协商价格'});
    await waitForPage(async()=>!(await driver.read()).dialogs.some(d=>d.text.includes('协商价格确认')),driver.h,'NEGOTIATION_DIALOG_UNCONFIRMED');
  }
  const skip=(await driver.read()).buttons.includes('跳过');
  if(skip){
    // An old onboarding popover may remain laid out behind another control.
    // Skipping it is optional; an obscured hint grants no click authority.
    try{await driver.physicalClick({selector:'.comp-recommendation-popover-tip button',label:'跳过'});}
    catch(error){if(error.message!=='TARGET_OBSCURED')throw error;}
  }
}
async function fillProposalForm(driver,contract) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(contract?.publishDate??''))throw new Error('PUBLISH_DATE_UNOBSERVED');
  await driver.h.wait(.5);
  await dismissProposalHints(driver);
  let fields=extractProposalFields(await driver.read());
  if(fields.templateLabel!=='奢侈品2'){
    const open=await driver.h.js(`(()=>[...document.querySelectorAll('.d-option span')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&e.innerText.trim()==='奢侈品2'))()`);
    if(!open){
      const marked=await driver.h.js(`(()=>{const controls=[...document.querySelectorAll('.d-select')].filter(e=>e.getClientRects().length&&e.querySelector('.d-select-prefix')?.innerText.trim()==='常用模版');if(controls.length!==1)return false;controls[0].setAttribute('data-xhs-template-control','1');return true;})()`);
      if(!marked)throw new Error('TEMPLATE_CONTROL_UNOBSERVED');
      await driver.physicalClick({selector:'[data-xhs-template-control="1"]'});
    }
    await waitForPage(()=>driver.h.js(`(()=>[...document.querySelectorAll('.d-option')].some(e=>e.getClientRects().length&&e.innerText.trim()==='奢侈品2'))()`),driver.h,'TEMPLATE_OPTION_UNOBSERVED');
    await driver.h.click((await labelTarget(driver,'.d-option span','奢侈品2')).selector,{label:'选择奢侈品2模板'});
    await waitForPage(async()=>extractProposalFields(await driver.read()).templateLabel==='奢侈品2',driver.h,'TEMPLATE_UNVERIFIED');
    await dismissProposalHints(driver);
  }
  if(contract.cooperationTitle&&fields.cooperationTitle!==contract.cooperationTitle) {
    const selector='textarea[placeholder="请简要描述，格式可参考：品牌+产品+图文/视频，合作名称用于博主绑定订单，请谨慎填写"]';
    await driver.h.fillInput(selector,contract.cooperationTitle);
  }
  await driver.h.wait(.5);
  await dismissProposalHints(driver);
  if(extractProposalFields(await driver.read()).dateValue!==contract.publishDate){
    await driver.physicalClick({selector:'.d-datepicker'});
    await driver.h.fillInput('.d-datepicker-content input',contract.publishDate);
    await driver.h.pressKey('Enter');
  }
  if(fields.retentionDays!==60)await driver.physicalClick({selector:'.expected-time-button-group button',label:'60天'});
  fields=extractProposalFields(await driver.read());
  if(!fields.negotiatedPrice){
    await driver.physicalClick({selector:'.d-radio',label:'开启'});
    await waitForPage(async()=>(await driver.read()).dialogs.some(d=>d.text.includes('协商价格确认')),driver.h,'NEGOTIATION_DIALOG_UNCONFIRMED');
    await dismissProposalHints(driver);
  }
  fields=extractProposalFields(await driver.read());
  if(fields.spuLabels.some(s=>!requiredSpus.includes(s))||new Set(fields.spuLabels).size!==fields.spuLabels.length)throw new Error('SPU_MISMATCH');
  const missing=requiredSpus.filter(s=>!fields.spuLabels.includes(s));
  if(missing.length){
    for(const label of missing)await selectSpu(driver,label);
    await driver.h.pressKey('Escape');
  }
  const dom=await driver.read();fields=extractProposalFields(dom);
  if(fields.templateLabel!=='奢侈品2'||!fields.negotiatedPrice||fields.retentionDays!==60||fields.dateValue!==contract.publishDate||
    !spuSetEqualsRequired(fields.spuLabels)||!fields.cooperationTitle||
    (contract.cooperationTitle&&fields.cooperationTitle!==contract.cooperationTitle))throw new Error('PROPOSAL_FORM_UNVERIFIED');
  return dom;
}
export async function prepareProposalForm(driver,contract) {
  for(let attempt=0;attempt<3;attempt++){
    try{return await fillProposalForm(driver,contract);}
    catch(error){
      if(error.message!=='TARGET_OBSCURED'||attempt===2)throw error;
      // Template application can render the observed advertising hint late.
      // Recover this reversible form in place; do not checkout the cart again.
      await dismissProposalHints(driver);
      await driver.h.wait(.2);
    }
  }
}

export async function prepareSubmissionDialog(driver) {
  // The footer opens a preview. Only the separate modal button may consume
  // SUBMIT_BATCH authority (the header has a third button with the same label).
  await driver.h.js(`(()=>{const body=document.querySelector('.solar_body');if(!body)return false;body.scrollTop=body.scrollHeight;return true;})()`);
  await driver.h.wait(.2);
  const target=await labelTarget(driver,'button:not(.shop-cart button):not(.d-modal button)','发起合作','data-xhs-open-submit-preview');
  await driver.physicalClick(target);
  await waitForPage(async()=>(await driver.read()).dialogs.some(d=>d.buttons.includes('发起合作')),driver.h,'SUBMIT_DIALOG_UNOBSERVED');
  const marked=await driver.h.js(`(()=>{document.querySelectorAll('[data-xhs-submit-dialog]').forEach(e=>e.removeAttribute('data-xhs-submit-dialog'));const roots=[...document.querySelectorAll('.d-modal')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&[...e.querySelectorAll('button')].some(b=>b.innerText.trim()==='发起合作'));if(roots.length!==1)return false;roots[0].setAttribute('data-xhs-submit-dialog','1');return true;})()`);
  if(!marked)throw new Error('SUBMIT_DIALOG_UNOBSERVED');
}
