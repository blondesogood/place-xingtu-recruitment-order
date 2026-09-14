// Local-only browser regression fixture; never connects to a business platform.
const http=require('node:http');
const state={received:0,committed:0,aborted:0};
const server=http.createServer((req,res)=>{
  if(req.url==='/state'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(state));}
  if(req.method==='POST'&&req.url==='/placement-platform-service/api/external-orders?orderId=123'){
    state.received++;let done=false;
    const timer=setTimeout(()=>{done=true;state.committed++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200}));},500);
    res.on('close',()=>{if(!done){clearTimeout(timer);state.aborted++;}});return;
  }
  res.setHeader('Content-Type','text/html');
  res.end(`<div data-xhs-writeback-dialog="1"><button data-xhs-writeback-submit="1" onclick="fetch('/placement-platform-service/api/external-orders?orderId=123',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({externalOrderNo:'456',platformAccountId:'account'})})">Save fixture</button></div>`);
});
server.listen(18864,'127.0.0.1',()=>console.log('writeback fixture ready on 127.0.0.1:18864'));
