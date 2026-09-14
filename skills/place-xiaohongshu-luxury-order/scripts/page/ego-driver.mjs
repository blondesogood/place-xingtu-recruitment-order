import { waitForPage } from './proposal-form.mjs';
import { cartItems } from './cart.mjs';
import { canonicalFactDigest as digest } from '../lib/page-facts.mjs';
import { readDomScript,moneyMinor } from './dom-reader.mjs';

export function targetProbe({selector,label=null,scope=null,scroll=true}) {
  const visible=e=>{ if(!e?.getClientRects().length)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0'||p.getAttribute('aria-hidden')==='true')return false;}return true;};
  const roots=scope?[...document.querySelectorAll(scope)].filter(visible):[document];
  if(roots.length!==1)return {ok:false,reason:'CONTAINER_NOT_UNIQUE'};
  const targets=[...roots[0].querySelectorAll(selector)].filter(e=>visible(e)&&(!label||e.innerText.trim()===label));
  if(targets.length!==1)return {ok:false,reason:'TARGET_NOT_UNIQUE'};
  const e=targets[0];if(scroll)e.scrollIntoView({block:'center',inline:'center'});
  const r=e.getBoundingClientRect();
  const points=[[r.left+r.width/2,r.top+r.height/2],[r.left+Math.min(4,r.width/4),r.top+r.height/2],[r.right-Math.min(4,r.width/4),r.top+r.height/2]];
  let x=points[0][0],y=points[0][1],ok=false;
  if(visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&getComputedStyle(e).pointerEvents!=='none') {
    for(const point of points) { const hit=document.elementFromPoint(...point);if(point[0]>=0&&point[1]>=0&&point[0]<innerWidth&&point[1]<innerHeight&&hit&&(hit===e||e.contains(hit))){[x,y]=point;ok=true;break;} }
  }
  return {ok,x,y,reason:ok?null:'TARGET_OBSCURED',targetIdentity:{tag:e.tagName,label:e.innerText.trim(),id:e.id,scope,selector},origin:location.origin};
}
export function requestContainsFilter(request,value,origin) {
  if(typeof value!=='string'||!value||!['GET','POST'].includes(request.method))return false;
  const url=new URL(request.url);if(url.origin!==origin)return false;
  const matches=v=>v===value||(Array.isArray(v)?v.some(matches):v&&typeof v==='object'?Object.values(v).some(matches):false);
  if([...url.searchParams.values()].some(v=>{if(v===value)return true;try{return matches(JSON.parse(v));}catch{return false;}}))return true;
  if(!request.postData)return false;
  try{return matches(JSON.parse(request.postData));}catch{return [...new URLSearchParams(request.postData).values()].includes(value);}
}
// The placement UI uses an observed cross-origin API. Match the endpoint and
// named field, rather than accepting any request containing the order number.
export function internalOrderRequest(request,value,{allowEmpty=false}={}) {
  if(request.method!=='POST'||typeof value!=='string'||(!value&&!allowEmpty))return false;
  let url,body;try{url=new URL(request.url);body=JSON.parse(request.postData);}catch{return false;}
  return url.origin==='https://h5gate.aihuishou.com'&&
    url.pathname==='/placement-platform-service/api/orders/list'&&(body?.orderNo??'')===value;
}
export function externalOrderRequest(request,value,field,pageNum=1) {
  if(request.method!=='GET'||!['orderId','title'].includes(field)||!value)return false;
  const url=new URL(request.url),p=url.searchParams;
  return url.origin==='https://pgy.xiaohongshu.com'&&url.pathname==='/api/solar/order/task/query'&&p.get(field)===value&&
    p.get('pageNum')===String(pageNum)&&p.get('state')===''&&p.get('onlyTodo')==='false'&&
    ['kolUserId','reportBrandUserId','negotiationStatus','cooperationType','coPlatform','settlementRule',field==='title'?'orderId':'title'].every(k=>p.get(k)==='');
}
export function externalListResponse(body) {
  if(body.success!==true||!Array.isArray(body.data?.list))throw new Error('EXTERNAL_RESPONSE_UNOBSERVED');
  const items=body.data.list.flatMap(group=>{
    if(!Array.isArray(group.orderVos))throw new Error('EXTERNAL_RESPONSE_UNOBSERVED');
    return group.orderVos.map(order=>({externalOrderId:order.orderId,creatorExternalId:order.kolId,advertiserExternalId:order.brandId,
      contentType:order.contentType,serverStatus:order.orderStatus,serverState:order.state,submittedAt:order.createTime,
      cooperationTitle:group.title,publishDate:group.expectPublishTime,reportingBrandLabel:group.reportBrandUserName}));
  });
  if(items.some(i=>typeof i.externalOrderId!=='string'||!i.externalOrderId)||new Set(items.map(i=>i.externalOrderId)).size!==items.length)throw new Error('EXTERNAL_RESPONSE_UNOBSERVED');
  return {responseDigest:digest(body),items,groups:body.data.list.map(group=>group.taskNo),total:body.data.total,totalPage:body.data.totalPage,pageNum:body.data.pageNum};
}
function internalCreatorId(value) {
  if(typeof value==='string')return value.trim()?value:null;
  // JSON numbers beyond the safe integer range have already lost identity.
  return Number.isSafeInteger(value)&&value>0?String(value):null;
}
export function internalListResponse(body) {
  if(!Array.isArray(body.data?.list))throw new Error('INTERNAL_RESPONSE_UNOBSERVED');
  return {responseDigest:digest(body),items:body.data.list.map(row=>({internalRecordId:internalCreatorId(row.id),internalOrderId:row.orderNo,externalOrderId:row.externalOrderNo||null,
    amountMinor:moneyMinor(row.unitAmount),creatorInternalId:internalCreatorId(row.talentId),creatorExternalId:row.talentPlatformId})),total:body.data.total};
}
// These read endpoints and fields are used by the live internal order editor.
// Authentication stays inside the page; only business responses leave it.
export async function readInternalAccountResponses(recordId) {
  const token=localStorage.getItem('token'),user=JSON.parse(localStorage.getItem('user')||'null'),headers={};
  if(token)headers.Authorization='Bearer '+token;
  if(user?.currentRoleCode)headers['X-Current-Role']=user.currentRoleCode;
  const read=async path=>{
    const response=await fetch('https://h5gate.aihuishou.com/placement-platform-service/api'+path,
      {credentials:'include',headers,signal:AbortSignal.timeout(10000)});
    const body=await response.json();
    if(response.status===401||body.code===401)throw new Error('LOGIN_REQUIRED');
    if(response.status===403||body.code===403)throw new Error('ACCOUNT_ACCESS_REQUIRED');
    if(response.status!==200||body.code!==200)throw new Error('INTERNAL_ACCOUNT_RESPONSE_UNOBSERVED');
    return body.data;
  };
  return {order:await read('/external-orders/order/'+encodeURIComponent(recordId)),accounts:await read('/platform/redbook/advertisers')};
}
export function persistedInternalAccount({order,accounts},source,secret) {
  if(!source?.internalRecordId||source.internalOrderId!==secret.internalOrderId||source.externalOrderId!==secret.externalOrderId||
    !order||internalCreatorId(order.orderId)!==source.internalRecordId||order.orderNo!==secret.internalOrderId||
    order.externalOrderNo!==secret.externalOrderId||order.platformType!=='RED_BOOK'||
    order.talentPlatformId!==secret.creatorExternalId||source.creatorExternalId!==secret.creatorExternalId||
    internalCreatorId(order.talentId)!==source.creatorInternalId||!source.creatorInternalId||
    typeof order.platformAccountId!=='string'||!order.platformAccountId||!Array.isArray(accounts))throw new Error('INTERNAL_ACCOUNT_IDENTITY_MISMATCH');
  const matches=accounts.filter(a=>a.advertiserId===order.platformAccountId);
  if(matches.length!==1||matches[0].advertiserName!=='上海悦川')throw new Error('INTERNAL_ACCOUNT_IDENTITY_MISMATCH');
  return {kind:'PERSISTED_READBACK',accountLabel:'上海悦川',advertiserExternalId:order.platformAccountId,evidenceDigest:digest({source,order,account:matches[0]})};
}
export class EgoDriver {
  constructor(helpers,binding) {this.h=helpers;this.binding=binding;}
  async select(site) {
    const spaces=await this.h.listTaskSpaces();
    const space=spaces.find(s=>String(s.id)===String(this.binding.taskSpaceId));
    if(!space||space.ownership!=='agent')throw new Error('BROWSER_OWNERSHIP_LOST');
    await this.h.useOrCreateTaskSpace(Number(space.id));
    const id=this.binding[`${site}TabId`],tabs=await this.h.listTabs();
    const tab=tabs.find(t=>t.targetId===id);
    if(!tab||new URL(tab.url).origin!==this.binding[`${site}Origin`])throw new Error('BROWSER_CONTEXT_LOST');
    await this.h.switchTab(id);return tab;
  }
  async ensureBusinessRole() {
    await this.select('internal');
    const dom=await waitForPage(async()=>{
      const info=await this.h.pageInfo();
      if(/\/login(?:[/?]|$)/i.test(info.url??''))throw new Error('LOGIN_REQUIRED');
      const value=await this.read();return value.headerRole?value:null;
    },this.h,'INTERNAL_ROLE_UNOBSERVED');
    if(dom.headerRole==='商务')return;
    await this.physicalClick({selector:'button',label:'切换角色'});
    const available=await waitForPage(()=>this.h.js(`(()=>{const menus=[...document.querySelectorAll('[role="menu"]')].filter(e=>e.getClientRects().length);return menus.length?menus.flatMap(m=>[...m.querySelectorAll('[role="menuitem"]')].map(e=>e.innerText.trim())):null;})()`),this.h,'ROLE_MENU_UNOBSERVED');
    if(!available.includes('商务'))throw new Error('BUSINESS_ROLE_REQUIRED');
    await waitForPage(async()=>{try{await this.probe({selector:'[role="menuitem"]',label:'商务'});return true;}catch(error){if(['TARGET_NOT_UNIQUE','TARGET_OBSCURED'].includes(error.message))return false;throw error;}},this.h,'ROLE_MENU_UNOBSERVED');
    await this.physicalClick({selector:'[role="menuitem"]',label:'商务'});
    await this.h.wait(.5);
    await waitForPage(async()=>(await this.read()).headerRole==='商务',this.h,'BUSINESS_ROLE_UNCONFIRMED');
  }
  async readCart() {
    await this.select('external');
    const body=await this.h.js(`(async()=>{const r=await fetch('/api/solar/cart/items',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('CART_RESPONSE_UNOBSERVED');return r.json();})()`);
    const value=cartItems(body);return {value,evidenceDigest:digest(value)};
  }
  async read(options={}) {return this.h.js(readDomScript(options));}
  async readWritebackAccount(source,secret) {
    await this.select('internal');
    if(!/^[1-9]\d*$/.test(source?.internalRecordId??''))throw new Error('INTERNAL_ACCOUNT_IDENTITY_MISMATCH');
    const responses=await this.h.js(`(${readInternalAccountResponses.toString()})(${JSON.stringify(source.internalRecordId)})`);
    return persistedInternalAccount(responses,source,secret);
  }
  async probe(target,businessReadOptions=null) {
    const script=`(${targetProbe.toString()})(${JSON.stringify(target)})`;
    const p=await this.h.js(businessReadOptions?`(()=>{const businessDom=${readDomScript(businessReadOptions)};return {...${script},businessDom};})()`:script);
    if(!p.ok)throw new Error(p.reason);return p;
  }
  async physicalClick(target,beforeClick=async()=>{},businessReadOptions=null) {
    await this.probe(target); // Scroll first; measure again after the browser has rendered.
    const p=await this.probe({...target,scroll:false},businessReadOptions);
    await beforeClick(p); // Atomic claim; the very next browser operation is the physical click.
    await this.h.click({x:p.x,y:p.y});
    return this.read();
  }
  async captureResponse({trigger,match,project,budgetMs=30000}) {
    await this.h.cdp('Network.enable',{});await this.h.drainEvents();
    const requests=new Set(),responses=new Map(),finished=new Set();
    const start=Date.now();await trigger();
    while(Date.now()-start<budgetMs) {
      for(const e of await this.h.drainEvents()) {
        if(e.method==='Network.requestWillBeSent'&&match(e.params.request))requests.add(e.params.requestId);
        if(e.method==='Network.responseReceived'&&requests.has(e.params.requestId)&&e.params.response.status===200)responses.set(e.params.requestId,e.params.response);
        if(e.method==='Network.loadingFinished')finished.add(e.params.requestId);
      }
      for(const [requestId,response] of responses) {
        if(!finished.has(requestId))continue;
        const raw=await this.h.cdp('Network.getResponseBody',{requestId});
        const text=raw.base64Encoded?Buffer.from(raw.body,'base64').toString('utf8'):raw.body;
        const body=JSON.parse(text);const value=project(body);
        return {value,evidenceDigest:digest(value),freshness:{kind:'ACTUAL_RESPONSE',requestDigest:digest(requestId),path:new URL(response.url).pathname}};
      }
      await this.h.wait(0.1);
    }
    throw new Error('QUERY_TIMEOUT');
  }
  async followDetail(href,site='external') {
    const expected=new URL(href);
    if(expected.origin!==this.binding[`${site}Origin`])throw new Error('DETAIL_ORIGIN_MISMATCH');
    await this.select(site);await this.h.gotoAndWait(href,{timeout:20});
    const info=await this.h.pageInfo();if(new URL(info.url).href!==expected.href)throw new Error('DETAIL_IDENTITY_MISMATCH');
    return this.read({scopeSelector:'main'});
  }
  async settleNewTabs(before,expectedHref) {
    const fresh=(await this.h.listTabs()).filter(t=>!before.some(p=>p.targetId===t.targetId));
    for(const tab of fresh) {
      if(new URL(tab.url).href!==new URL(expectedHref).href)throw new Error('UNEXPECTED_NEW_TAB');
      await this.h.closeTab(tab.targetId);
    }
    return this.followDetail(expectedHref);
  }
  // No "two identical snapshots" heuristic: require the loading transition from this invocation.
  async query({site,filterSelector,filterValue,buttonLabel,orderId,scopeSelector=null,budgetMs=30000}) {
    await this.select(site);
    const started=Date.now();let refreshed=false;
    const marker=digest(`${started}:${Math.random()}`);
    await this.h.js(`(()=>{const state={marker:${JSON.stringify(marker)},started:performance.now(),loadingSeen:false,finished:false};globalThis.__xhsQueryObserver?.disconnect();const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';const check=()=>{const loading=[...document.querySelectorAll('[aria-busy="true"],.ant-spin-spinning,.el-loading-mask,.jxel-loading-mask')].some(visible);if(loading)state.loadingSeen=true;if(state.loadingSeen&&!loading)state.finished=true;};globalThis.__xhsQuery=state;globalThis.__xhsQueryObserver=new MutationObserver(check);globalThis.__xhsQueryObserver.observe(document.documentElement,{subtree:true,attributes:true,childList:true});return true;})()`);
    const origin=this.binding[`${site}Origin`];
    const internal=site==='internal'&&origin==='https://placement.aihuishou.com';
    const external=site==='external'&&origin==='https://pgy.xiaohongshu.com';
    const externalField=filterSelector==='input[placeholder="请输入订单号"]'?'orderId':filterSelector==='input[placeholder="请输入合作名称"]'?'title':null;
    if(!internal)await this.h.fillInput(filterSelector,filterValue);
    let response;
    for(let attempt=0;attempt<2;attempt++) {
      try {
        if(internal){
          const dom=await this.read();
          if(dom.filters.some(f=>f.placeholder==='搜索订单编号'&&f.value===filterValue)){
            // Let the debounced clear reach its own response before restoring
            // the same value; otherwise the UI may suppress both changes.
            await this.captureResponse({trigger:async()=>{await this.physicalClick({selector:'.ant-input-affix-wrapper:has(input[placeholder="搜索订单编号"]) button.ant-input-clear-icon'});
              await waitForPage(()=>this.h.js(`document.querySelector(${JSON.stringify(filterSelector)})?.value===''`),this.h,'INTERNAL_FILTER_NOT_CLEARED');},
              match:request=>internalOrderRequest(request,'',{allowEmpty:true}),
              project:()=>true,budgetMs:Math.max(1,Math.min(14000,budgetMs-(Date.now()-started)))});
            await this.h.js('(()=>{if(globalThis.__xhsQuery){globalThis.__xhsQuery.loadingSeen=false;globalThis.__xhsQuery.finished=false;}return true;})()');
          }
        }
        response=await this.captureResponse({
          trigger:async()=>{
            if(internal) {
              // Filling the filter triggers the actual query. The "刷新" button
              // reloads the route and must not be used as a query action.
              await this.h.fillInput(filterSelector,filterValue);
              await waitForPage(()=>this.h.js(`document.querySelector(${JSON.stringify(filterSelector)})?.value===${JSON.stringify(filterValue)}`),this.h,'INTERNAL_FILTER_NOT_APPLIED');
              await this.h.pressKey('Enter');
            } else await this.physicalClick({selector:'button,[role="button"]',label:buttonLabel});
          },
          match:request=>internal?internalOrderRequest(request,filterValue):external?externalOrderRequest(request,filterValue,externalField):requestContainsFilter(request,filterValue,origin),
          project:body=>external?externalListResponse(body):internal?internalListResponse(body):{responseDigest:digest(body)},budgetMs:Math.max(1,Math.min(14000,budgetMs-(Date.now()-started))),
        });
        break;
      } catch(error) {
        if(error.message!=='QUERY_TIMEOUT'||attempt===1)throw error;
        refreshed=true;
        await this.h.js('(()=>{if(globalThis.__xhsQuery){globalThis.__xhsQuery.loadingSeen=false;globalThis.__xhsQuery.finished=false;}return true;})()');
      }
    }
    while(Date.now()-started<budgetMs) {
      const cycle=await this.h.js('(()=>globalThis.__xhsQuery)()');
      const dom=await this.read({orderId,scopeSelector});
      const ids=dom.cards?.map(c=>c.attributes?.orderid).filter(Boolean)??[];
      const renderedResponse=external&&response&&ids.length===response.value.items.length&&
        new Set(ids).size===ids.length&&response.value.items.every(item=>dom.cards.some(card=>card.attributes?.orderid===item.externalOrderId&&
          card.attributes.kolid===item.creatorExternalId&&card.attributes.orderstatus===item.serverStatus&&card.groupTitle===item.cooperationTitle));
      const internalRows=response?.value.items?.filter(row=>row.internalOrderId===filterValue);
      const renderedInternal=internal&&internalRows?.length===1&&dom.tables?.length===1&&dom.tables[0]['订单编号']===filterValue&&
        moneyMinor(dom.tables[0]['单条下单金额'])===internalRows[0].amountMinor&&
        (['','-','空'].includes(dom.tables[0]['任务id']??'')?null:dom.tables[0]['任务id'])===internalRows[0].externalOrderId;
      if(response&&cycle?.marker===marker&&(cycle.finished||renderedResponse||renderedInternal)&&!dom.loading&&dom.filters.some(f=>f.value===filterValue))
        return {dom,server:external||internal?response.value:null,freshness:{kind:renderedResponse||renderedInternal?'ACTUAL_RESPONSE_AND_RENDERED_IDS':'ACTUAL_RESPONSE_AND_LOADING_CYCLE',queryDigest:marker,responseDigest:response.value.responseDigest,refreshed}};
      await this.h.wait(0.2);
    }
    throw new Error('QUERY_TIMEOUT');
  }
}
