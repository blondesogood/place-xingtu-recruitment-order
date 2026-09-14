import { exactRow,fieldsByLabel,moneyMinor } from './dom-reader.mjs';
export function extractInternalFields(dom,orderId) {
  if (!dom || typeof dom!=='object') throw new Error('STRUCTURED_DOM_REQUIRED');
  const row=exactRow(dom,orderId);
  const account=typeof row['广告主账户']==='string'?row['广告主账户'].trim():'';
  const persistedAccount=account&&!['-','空'].includes(account)?account:null;
  return {businessLabel:row['植入业务'],internalStatus:row['状态'],existingExternalTaskId:!row['任务id']||['-','空'].includes(row['任务id'])?null:row['任务id'],
    internalRole:dom.headerRole,headerRole:dom.headerRole,platformLabel:row['平台'],contentType:row['内容形式']==='图文'?'IMAGE_TEXT':row['内容形式'],
    internalAmountMinor:moneyMinor(row['单条下单金额']),creatorInternalId:row['达人id'],
    creatorExternalId:row['平台达人ID']??(row['平台']==='小红书'?row['达人id']:fieldsByLabel(dom,'平台达人ID')),
    advertiserAccountLabel:persistedAccount,
    advertiserAccountSource:persistedAccount?'ORDER_ROW':null};
}
export function runInternal(input) {
  const fields=extractInternalFields(input.dom,input.internalOrderId);
  const factKind=({VERIFY_RESUME:'RESUME_FACTS',READ_INTERNAL_ORDER:'INTERNAL_SNAPSHOT',VERIFY_WRITEBACK:'WRITEBACK_FACTS',CONFIRM_WRITEBACK:'CLICK_READY',READ_WRITEBACK_OUTCOME:'WRITEBACK_OUTCOME'})[input.action];
  if (!factKind)throw new Error('PAGE_ACTION_INVALID');
  if(input.action==='READ_INTERNAL_ORDER'&&fields.existingExternalTaskId)throw new Error('EXISTING_TASK_ID_BLOCKS_CREATE');
  return {orderTag:input.orderTag,factKind,hasSecret:true,fields};
}
