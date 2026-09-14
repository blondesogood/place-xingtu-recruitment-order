// Runs in the page. Return scoped business fields to the executor, never print this object.
export function readDom({ orderId = null, scopeSelector = null } = {}) {
  const visible = e => {
    if (!e || !e.getClientRects().length) return false;
    for (let p=e;p;p=p.parentElement) { const s=getComputedStyle(p); if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0'||p.getAttribute('aria-hidden')==='true') return false; }
    return true;
  };
  const text = e => e?.innerText?.trim() ?? '';
  const dialogs=[...document.querySelectorAll('[role="dialog"],.ant-modal,.el-dialog,.jxel-dialog,.d-modal')].filter(visible);
  const roots = scopeSelector ? [...document.querySelectorAll(scopeSelector)].filter(visible) : [];
  if (scopeSelector && roots.length!==1) return {error:'CONTAINER_NOT_UNIQUE'};
  const scope=roots[0]??document;
  const tables=[...scope.querySelectorAll('table')].filter(visible).map(table=>{
    const headers=[...table.querySelectorAll('thead th')].map(text);
    return [...table.querySelectorAll('tbody > tr')].filter(visible).map(row=>{
      const cells=[...row.children].filter(e=>e.tagName==='TD');
      return Object.fromEntries(headers.map((key,i)=>[key,text(cells[i])]));
    });
  }).flat().filter(row=>!orderId || row['订单编号']===orderId);
  const fields={};
  const detailLabels=['合作名称','合作人','合作类型','结算方式','合作发起时间','合作完成时间','订单号','合作金额','平台服务费','总计金额','报备品牌','合作主体','合作模板','发布时间','预计发布时间'];
  const details={};
  for(const e of scope.querySelectorAll('.solar_body span,.body_wrapper span')) {
    if(!visible(e)||e.children.length)continue;
    const label=text(e).replace(/[:：]$/,'');if(!detailLabels.includes(label))continue;
    const row=e.parentElement.parentElement;
    const values=[...row.children].filter(c=>!c.contains(e)).map(text).filter(Boolean);
    if(values.length)details[label]=values.join('\n');
  }
  const creatorLinks=[...scope.querySelectorAll('a[href]')].filter(a=>/blogger-detail|user\/profile/.test(a.href)).map(a=>a.href);
  const spuLabels=[...scope.querySelectorAll('.spu-detail-name')].filter(visible).map(text);
  for (const row of scope.querySelectorAll('.ant-form-item,.el-form-item,.jxel-form-item,.d-new-form-item,dl')) {
    if (!visible(row)) continue;
    const label=text(row.querySelector('label,dt,.ant-form-item-label,.el-form-item__label,:scope > .d-form-item__label')).replace(/[：:*\s]+$/,'');
    if (!label) continue;
    const inputs=[...row.querySelectorAll('input,textarea,select')].filter(e=>visible(e.closest('.d-radio,.d-checkbox')??e));
    const selected=[...row.querySelectorAll('.ant-select-selection-item,.ant-select-content-value,.ant-select-content-has-value,[role="option"][aria-selected="true"],.el-select__selected-item,.jxel-select__selected-item,.d-select-tags > .d-tag,.expected-time-button-group button.active')].filter(visible).map(text);
    if(label==='合作品牌'&&!selected.length)selected.push(...[...row.querySelectorAll('.d-form-item__wrapper > div > .d-space > span.d-text')].filter(visible).map(text));
    fields[label]={value:inputs.filter(e=>!['checkbox','radio','search'].includes(e.type)).map(e=>e.value),selected,
      checked:inputs.filter(e=>['radio','checkbox'].includes(e.type)&&e.checked).map(e=>text(e.closest('label,.d-radio,.d-checkbox'))||e.value)};
  }
  const templates=[...scope.querySelectorAll('.d-select')].filter(e=>visible(e)&&text(e.querySelector('.d-select-prefix'))==='常用模版');
  if(templates.length===1)fields['常用模版']={value:[],selected:[text(templates[0].querySelector('.d-select-content'))].filter(Boolean),checked:[]};
  const negotiation=[...scope.querySelectorAll('.d-radio-group')].filter(e=>visible(e)&&[...e.parentElement.children].some(n=>text(n)==='与博主协商价格'));
  if(negotiation.length===1)fields['与博主协商价格']={value:[],selected:[],checked:[...negotiation[0].querySelectorAll('input:checked')].map(e=>text(e.closest('.d-radio')))};
  const companies=[...document.querySelectorAll('.user-info-content-name')].filter(visible).map(text);
  const cartRows=[...scope.querySelectorAll('.cart-item')].filter(visible).map(e=>({creatorName:text(e.querySelector('.kol-name')),contentType:[...e.querySelectorAll('span')].some(n=>text(n)==='图文笔记')?'IMAGE_TEXT':null}));
  const cards=[...scope.querySelectorAll('.order-item-wrap')].filter(visible).flatMap(card=>{
    // A cooperation group can contain several order rows. These attributes are
    // rendered by the live list component; never infer IDs from nicknames.
    const members=[...card.querySelectorAll('[orderid][kolid]')].filter(visible);
    if(!members.length)return [{text:text(card),links:[...card.querySelectorAll('a[href]')].map(a=>({href:a.href,text:text(a)}))}];
    return members.map(member=>{
      const row=member.parentElement;
      const attrs=Object.fromEntries(['orderid','kolid','brandid','orderstatus','contenttype'].map(k=>[k,member.getAttribute(k)]));
      return {text:text(row),groupTitle:text(card.querySelector('h6')),attributes:attrs,
        statusText:text(row.querySelector('.status-wrap')),links:[...row.querySelectorAll('a[href]')].map(a=>({href:a.href,text:text(a)}))};
    });
  });
  const roleButton=[...document.querySelectorAll('button')].find(e=>visible(e)&&text(e)==='切换角色');
  let headerRole=null;
  for(let p=roleButton?.parentElement,n=0;p&&n<5;p=p.parentElement,n++){const r=p.getBoundingClientRect();if(r.top>120||r.height>150)break;const roles=[...new Set(text(p).match(/商务|采购/g)??[])];if(roles.length===1){headerRole=roles[0];break;}}
  const writebackRoots=[...document.querySelectorAll('[data-xhs-writeback-dialog="1"]')].filter(visible);
  const writebackForm=writebackRoots.length===1?{owner:writebackRoots[0].getAttribute('data-xhs-writeback-owner'),
    value:writebackRoots[0].querySelector('[data-xhs-writeback-input="1"]')?.value??null,
    selected:text(writebackRoots[0].querySelector('[data-xhs-advertiser-control="1"]'))}:null;
  return {origin:location.origin,href:location.href,headerRole,tables,fields,details,creatorLinks,spuLabels,cards,cartRows,writebackForm,advertiserCompany:companies.length===1?companies[0]:null,
    scopeText:scope===document ? null:text(scope),
    taskStatusText:text(scope.querySelector('.task-status-content'))||null,
    notices:[...document.querySelectorAll('.ant-message-notice-content,.ant-notification-notice-description')].filter(visible).map(text),
    dialogs:dialogs.map(e=>({text:text(e),buttons:[...e.querySelectorAll('button')].filter(visible).map(text)})),
    loading:[...document.querySelectorAll('[aria-busy="true"],.ant-spin-spinning,.el-loading-mask,.jxel-loading-mask')].some(visible),
    filters:[...document.querySelectorAll('input[placeholder]')].filter(visible).map(e=>({placeholder:e.placeholder,value:e.value})),
    buttons:[...scope.querySelectorAll('button,[role="button"]')].filter(visible).map(text)};
}

export function readDomScript(options) { return `(${readDom.toString()})(${JSON.stringify(options)})`; }

export function fieldsByLabel(dom,label) {
  const field=dom.fields?.[label];
  if (!field) return null;
  const values=[...field.value,...field.selected,...field.checked].filter(v=>v!=='' );
  return values.length===1?values[0]:values;
}
export function exactRow(dom,orderId) {
  const rows=dom.tables?.filter(row=>row['订单编号']===orderId)??[];
  if (rows.length!==1) throw new Error('ORDER_ROW_NOT_UNIQUE');
  return rows[0];
}
export function moneyMinor(value) {
  const m=String(value??'').replace(/[,￥¥元\s]/g,'').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  return m ? (BigInt(m[1])*100n+BigInt((m[2]??'').padEnd(2,'0'))).toString():null;
}
