import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,hostname} from 'node:os';
import {spawnSync} from 'node:child_process';

const sha=value=>createHash('sha256').update(value).digest('hex');
const held=new Set();
const fail=code=>{throw new Error(code);};
export const defaultStateDir=()=>process.env.XHS_STATE_DIR||join(homedir(),'.local','state','xhs-luxury-order');
export const batchRefForTask=taskId=>sha(taskId).slice(0,24);

function read(path) {
  try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;fail('RECOVERY_RECORD_CORRUPT');}
}
function atomicWrite(path,value) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  let fd;
  try{
    fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temporary,path);
    const parent=openSync(resolve(path,'..'),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

export class OperationStore {
  constructor(directory=defaultStateDir()) {
    this.directory=resolve(directory);
    for(const name of ['batches','orders','locks'])mkdirSync(join(this.directory,name),{recursive:true,mode:0o700});
  }
  // macOS lockf locks the inherited open file description. This process
  // keeps the FD open; even a crash releases the kernel lock automatically.
  async locked(key,work) {
    const file=join(this.directory,'locks',sha(key)+'.lock');
    if(held.has(file))fail('ORDER_LOCK_BUSY');
    if(process.platform!=='darwin')fail('UNSUPPORTED_LOCK_HOST');
    const fd=openSync(file,'a+',0o600);
    try{
      const result=spawnSync('/usr/bin/lockf',['-s','-t','0','3'],{stdio:['ignore','pipe','pipe',fd]});
      if(result.error)fail('LOCK_RUNTIME_UNAVAILABLE');
      if(result.status!==0)fail(result.status===75?'ORDER_LOCK_BUSY':'LOCK_RUNTIME_UNAVAILABLE');
      held.add(file);
      try{return await work();}finally{held.delete(file);}
    }finally{closeSync(fd);}
  }
  batch(ref) {
    if(!/^[a-f0-9]{24}$/.test(ref??''))fail('BATCH_REFERENCE_INVALID');
    const data=read(join(this.directory,'batches',ref+'.json'));
    if(data&&(data.schemaVersion!==2||data.batchRef!==ref||!Array.isArray(data.orderIds)))fail('RECOVERY_RECORD_CORRUPT');
    return data;
  }
  async bind(input) {
    const ref=input.batchRef??(input.taskId?batchRefForTask(input.taskId):null);
    if(!/^[a-f0-9]{24}$/.test(ref??''))fail('BATCH_REFERENCE_INVALID');
    return this.locked('batch:'+ref,async()=>{
      let batch=this.batch(ref);
      if(!batch){
        if(input.operation!=='ORDER'||input.batchRef)fail('RECOVERY_RECORD_MISSING');
        if(input.conversationState&&input.conversationState.schemaVersion!==1)fail('RECOVERY_RECORD_MISSING');
        batch={schemaVersion:2,batchRef:ref,taskId:input.taskId,orderIds:input.orderIds,preview:input.preview===true,createdAt:new Date().toISOString()};
        for(const orderId of batch.orderIds){
          await this.locked('order:'+orderId,async()=>{
            const file=join(this.directory,'orders',sha(orderId)+'.json');
            if(!read(file)){
              const recoveryRequired=Boolean(input.conversationState)||this.listBatches().some(prior=>prior.orderIds.includes(orderId));
              atomicWrite(file,{schemaVersion:2,orderId,externalTaskId:null,pendingAction:input.conversationState?.pendingAction?.orderId===orderId?input.conversationState.pendingAction:null,recoveryRequired});
            }
          });
        }
        atomicWrite(join(this.directory,'batches',ref+'.json'),batch);
      }
      if(input.operation==='ORDER'&&(input.taskId!==batch.taskId||!sameSet(input.orderIds,batch.orderIds)))fail('CONVERSATION_BATCH_MISMATCH');
      if(input.preview!==true&&batch.preview)fail('PREVIEW_BATCH_IS_READ_ONLY');
      const selected=input.orderIds??batch.orderIds;
      if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!batch.orderIds.includes(id)))fail('ORDER_OUTSIDE_AUTHORIZED_BATCH');
      if(input.conversationState?.schemaVersion===2&&input.conversationState.batchRef!==ref)fail('CONVERSATION_BATCH_MISMATCH');
      return {...batch,selectedOrderIds:selected};
    });
  }
  order(orderId) {
    const data=read(join(this.directory,'orders',sha(orderId)+'.json'));
    if(data&&(data.schemaVersion!==2||data.orderId!==orderId))fail('RECOVERY_RECORD_CORRUPT');
    return data??{schemaVersion:2,orderId,externalTaskId:null,pendingAction:null,recoveryRequired:true};
  }
  saveOrder(record) {
    atomicWrite(join(this.directory,'orders',sha(record.orderId)+'.json'),{...record,updatedAt:new Date().toISOString()});
  }
  claim(record,batch,action,externalTaskId) {
    if(record.pendingAction)fail('ACTION_RESULT_UNKNOWN');
    const next={...record,lastError:null,lastActionEvidence:null,pendingAction:{action,externalTaskId:externalTaskId??null,batchRef:batch.batchRef,attemptId:randomUUID(),host:hostname(),startedAt:new Date().toISOString()}};
    this.saveOrder(next);return next;
  }
  listBatches() {
    return readdirSync(join(this.directory,'batches')).filter(name=>/^[a-f0-9]{24}\.json$/.test(name)).map(name=>this.batch(name.slice(0,-5))).filter(batch=>!batch.preview);
  }
}
function sameSet(a,b){return Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&a.every(id=>b.includes(id));}
