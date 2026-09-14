import { waitForPage } from './proposal-form.mjs';
export function cartItems(body) {
  if(body.success!==true||!Array.isArray(body.data))throw new Error('CART_RESPONSE_UNOBSERVED');
  const items=body.data.map(item=>{
    if(!Number.isSafeInteger(item.id)||typeof item.kolUserId!=='string'||!item.kolUserId)throw new Error('CART_IDENTITY_UNOBSERVED');
    return {memberKey:String(item.id),creatorExternalId:item.kolUserId,contentType:item.contentType===1?'IMAGE_TEXT':null};
  });
  if(new Set(items.map(i=>i.memberKey)).size!==items.length)throw new Error('CART_MEMBER_BINDING_AMBIGUOUS');
  return items;
}
export function addedCartMember(before,after,creatorExternalId) {
  if(before.some(item=>!after.some(current=>current.memberKey===item.memberKey&&current.creatorExternalId===item.creatorExternalId&&current.contentType===item.contentType)))throw new Error('CART_CONTAMINATED');
  const added=after.filter(item=>!before.some(old=>old.memberKey===item.memberKey));
  if(added.length!==1||added[0].creatorExternalId!==creatorExternalId||added[0].contentType!=='IMAGE_TEXT')throw new Error('CART_MEMBER_BINDING_AMBIGUOUS');
  return added[0];
}
// The visible next step reads the cart. This call never clicks the proposal's
// final "发起合作" button, including when the cart is empty.
export async function openProposalCart(driver,binding,{expectedMemberKeys=null}={}) {
  const before=await driver.readCart();
  if(!before.value.length)return before;
  if(!expectedMemberKeys||before.value.length!==expectedMemberKeys.length||before.value.some(item=>!expectedMemberKeys.includes(item.memberKey)))throw new Error('CART_CONTAMINATED');
  await driver.select('external');
  await driver.h.gotoAndWait(binding.externalOrigin+'/solar/transaction/create-task',{timeout:20});
  await waitForPage(async()=>(await driver.read()).buttons.includes('下一步，发布合作'),driver.h,'PROPOSAL_ENTRY_UNOBSERVED');
  const result=await driver.captureResponse({
    trigger:()=>driver.physicalClick({selector:'button',label:'下一步，发布合作'}),
    match:request=>request.method==='GET'&&new URL(request.url).origin===binding.externalOrigin&&new URL(request.url).pathname==='/api/solar/cart/items',project:cartItems,
  });
  if(result.value.length!==expectedMemberKeys.length||result.value.some(item=>!expectedMemberKeys.includes(item.memberKey)))throw new Error('CART_CONTAMINATED');
  if(result.value.length){
    await waitForPage(async()=>new URL((await driver.h.pageInfo()).url).pathname==='/solar/transaction/proposal',driver.h,'PROPOSAL_NAVIGATION_UNCONFIRMED');
    // Navigation completes before the asynchronously loaded proposal members.
    // The caller still checks the exact member identity and content type.
    await waitForPage(async()=>(await driver.read()).cartRows.length>0,driver.h,'PROPOSAL_MEMBERS_UNOBSERVED');
  }
  return result;
}
export async function addImageTextCreator(driver,beforeClick=async()=>{}) {
  const marked=await waitForPage(()=>driver.h.js(`(()=>{document.querySelectorAll('[data-xhs-add-image-text]').forEach(e=>e.removeAttribute('data-xhs-add-image-text'));const rows=[...document.querySelectorAll('.price-box')].filter(e=>e.getClientRects().length&&[...e.querySelectorAll('span')].some(s=>s.innerText.trim()==='图文笔记一口价'));const target=rows.length===1?rows[0].querySelector('.icon-cart'):null;if(!target?.getClientRects().length)return false;target.setAttribute('data-xhs-add-image-text','1');return true;})()`),driver.h,'CART_ADD_TARGET_UNOBSERVED');
  if(!marked)throw new Error('CART_ADD_TARGET_UNOBSERVED');
  await driver.physicalClick({selector:'[data-xhs-add-image-text="1"]'},beforeClick);
}
