import { fieldsByLabel } from './dom-reader.mjs';
import { spuSetEqualsRequired } from '../lib/aliases.mjs';
export function extractProposalFields(dom) {
  if (!dom || typeof dom!=='object')throw new Error('STRUCTURED_DOM_REQUIRED');
  const value=label=>fieldsByLabel(dom,label);
  const spuField=Object.entries(dom.fields??{}).find(([label])=>label.replace(/\s/g,'')==='绑定SPU（可选）')?.[1];
  const spus=spuField?spuField.selected:value('SPU');
  const company=value('合作主体')??dom.advertiserCompany;
  const retention=value('期望保留时长')??value('笔记保留时长');
  return {advertiserAccountLabel:value('广告主账户')??(company==='上海悦川网络信息技术有限公司'?'上海悦川':null),advertiserCompanyLabel:company,templateLabel:value('常用模版')??value('常用模板')??value('合作模板'),
    negotiatedPrice:value('与博主协商价格')==='开启'||value('报价方式')==='协商价格',spuLabels:Array.isArray(spus)?spus:spus?[spus]:[],
    reportingBrandLabel:value('合作品牌')??value('报备品牌'),dateValue:value('期望发布时间')??value('发布时间'),retentionDays:typeof retention==='string'&&/^\d+天$/.test(retention)?Number(retention.slice(0,-1)):Number(retention),
    cooperationTitle:value('合作名称'),contentType:value('内容形式')==='图文'||(dom.cartRows?.length&&dom.cartRows.every(r=>r.contentType==='IMAGE_TEXT'))?'IMAGE_TEXT':null,
    promotionOverlay:dom.dialogs.some(d=>/投广|推广|广告/.test(d.text)&&/确定勾选|我知道了/.test(d.text)),
    members:dom.members??null};
}
export function runProposal(input) {
  const fields=extractProposalFields(input.dom);
  if(fields.promotionOverlay)throw new Error('PROMOTION_OVERLAY');
  if(['SUBMIT_BATCH','VERIFY_CART'].includes(input.action)&&!spuSetEqualsRequired(fields.spuLabels))throw new Error('SPU_MISMATCH');
  return {orderTag:input.orderTag??'batch',factKind:input.action==='ADD_CREATOR_TO_CART'?'CART_MEMBER_ADDED':'CART_VERIFIED',hasSecret:true,fields};
}
