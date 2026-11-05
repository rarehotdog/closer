// Real HTTP to this local app; the provider is an injected stand-in, never the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createFakeMetaTransport } from './fakeMeta.ts';
import { FAKE_SPARK_ANSWER } from './fakeMeta.ts';
import type { Transport } from './closer/adapters/transport.ts';

process.env.CLOSER_NO_LISTEN='1';
process.env.CLOSER_FORBID_REAL='1';
delete process.env.CLOSER_KILL;
delete process.env.CLOSER_SCAN_FAKE;
const {createApp}=await import('../server.ts');
const input={jpegBase64:readFileSync(join(import.meta.dirname,'test/fixtures/outfit.jpg')).toString('base64'),pngBase64:readFileSync(join(import.meta.dirname,'test/fixtures/outfit.png')).toString('base64'),sentence:''};
async function fixture(raw:Transport,run:(base:string,path:string)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'closer-meta-http-'));const path=join(dir,'test.sqlite');
  process.env.MODEL_API_KEY='test-placeholder-not-a-key';
  const app=createApp({dbPath:path},{transportFor:()=>raw});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{await run(base,path);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));app.locals.closeAccounts();delete process.env.MODEL_API_KEY;delete process.env.CLOSER_SCAN_BUDGET_USD;rmSync(dir,{recursive:true,force:true});}
}
async function post(base:string,path:string,body:unknown,cookie?:string,origin:string|false=base) {
  const headers:Record<string,string>={'Content-Type':'application/json'};if(origin)headers.Origin=origin;if(cookie)headers.Cookie=cookie;
  const res=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  return{status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]??''};
}
const register=(base:string,handle:string)=>post(base,'/api/account/register',{handle,password:'meta-route-test-password'});

test('live scans require matching origin and account before the provider can be reached',async()=>{
  let attempts=0;
  await fixture(async()=>{attempts++;throw new Error('should not reach');},async base=>{
    assert.equal((await post(base,'/api/scan',input,undefined,false)).status,403);
    assert.equal((await post(base,'/api/scan',input,undefined,'https://outside.example')).status,403);
    assert.equal((await post(base,'/api/scan',input)).status,401);
    const a=await register(base,'meta-account-a');assert.equal(a.status,200);
    assert.equal((await post(base,'/api/scan',{...input,workspaceId:'acct-other'},a.cookie)).status,409);
    assert.equal((await post(base,'/api/scan',{...input,workspaceId:a.body.workspaceId},a.cookie,'http://127.0.0.1:1')).status,403);
    assert.equal(attempts,0);
  });
});

function classifiedPhotoTransport(): Transport {
  const fake=createFakeMetaTransport();
  return async request=>{
    const response=await fake(request);
    if(request.body.model==='muse-spark-1.3'){
      const answer={...FAKE_SPARK_ANSWER,garments:[...FAKE_SPARK_ANSWER.garments,{box:[300,900,700,1000],type:'sneakers',color_family:'white',formality:'low'}]};
      return {...response,json:{output_text:JSON.stringify(answer)}};
    }
    return response;
  };
}

test('a successful live-mode pipeline records scoped calls and a receipt; another account cannot save it',()=>fixture(classifiedPhotoTransport(),async(base,path)=>{
  const a=await register(base,'meta-owner');const b=await register(base,'meta-other');
  const result=await post(base,'/api/scan',{...input,workspaceId:a.body.workspaceId},a.cookie);
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.mode,'live');assert.match(result.body.receiptId,/^scan-/);assert.equal(result.body.calls.length,2);
  const status=await(await fetch(base+'/api/scan/status')).json();assert.equal(status.successfulLiveCalls,2);assert.equal(status.scans,1);assert.equal(status.costBasis,'local-estimate');assert.equal(JSON.stringify(status).includes('test-placeholder'),false);
  const db=new DatabaseSync(path);try{
    const rows=db.prepare('SELECT workspace_id,http,source FROM calls').all();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.workspace_id===a.body.workspaceId&&r.http===200&&r.source==='live'));
    assert.equal((db.prepare('SELECT workspace_id FROM rail_scan_receipts').get() as {workspace_id:string}).workspace_id,a.body.workspaceId);
  }finally{db.close();}
  const card=result.body.cards.find((c:{type:string})=>c.type==='sneakers');assert.ok(card);
  const piece={id:'scan-route-piece',code:'A1',name:'My coat',brand:'Unknown',category:'outerwear',silhouette:'overcoat',currency:'USD',purchasePrice:null,isSample:false,colorHex:'#112233',secondaryColorHex:'#334455',fabricLabel:'Unknown',hangerType:'walnut-brass',wearsLast60Days:0,wearLogStatus:'insufficient',imageUrl:card.cutout,frontImageUrl:card.cutout,cutoutSource:card.cutoutKind==='mask'?'sam-mask':'box-crop',scanMode:'live',scanReceiptId:result.body.receiptId,scanCardId:String(card.cardId),observations:[],feeConfig:{platform:'eBay',feeRatePct:0,shippingCost:0,confirmed:false}};
  const latest=await(await fetch(base+'/api/account/wardrobe',{headers:{Cookie:b.cookie}})).json();
  const rejected=await fetch(base+'/api/account/wardrobe',{method:'PUT',headers:{Cookie:b.cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({workspaceId:b.body.workspaceId,expectedRevision:latest.revision,expectedLedgerRevision:latest.ledgerRevision,requestId:'request-other-scan',pieces:[piece]})});
  const rejectedBody=await rejected.json();assert.equal(rejected.status,400,JSON.stringify(rejectedBody));assert.equal(rejectedBody.code,'INVALID_WARDROBE');assert.match(rejectedBody.detail,/receipt/);
  const own=await(await fetch(base+'/api/account/wardrobe',{headers:{Cookie:a.cookie}})).json();
  const saved=await fetch(base+'/api/account/wardrobe',{method:'PUT',headers:{Cookie:a.cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({workspaceId:a.body.workspaceId,expectedRevision:own.revision,expectedLedgerRevision:own.ledgerRevision,requestId:'request-owner-scan',pieces:[piece]})});
  const savedBody=await saved.json();assert.equal(saved.status,200,JSON.stringify(savedBody));assert.equal(savedBody.pieces[0].scanReceiptId,result.body.receiptId);
  const ledger=await(await fetch(base+'/api/account/ledger',{headers:{Cookie:a.cookie}})).json();assert.equal(ledger.calls.length,2);assert.equal(ledger.state.items.length,1);assert.equal(ledger.state.items[0].type,'sneakers');assert.equal(ledger.state.items[0].slot,'shoes');assert.equal(ledger.state.items[0].formality,'low');assert.ok(ledger.state.events.some((e:{kind:string})=>e.kind==='REGISTRATION_CONFIRMED'));assert.equal(ledger.ledgerRevision,savedBody.ledgerRevision);
}));

test('failed calls remain in the canonical calls table and zero budget prevents a provider call',async()=>{
  let attempts=0;
  await fixture(async()=>{attempts++;return {status:401,headers:{},json:{error:{message:'private rejected value'}}};},async(base,path)=>{
    const a=await register(base,'meta-rejected');
    const failed=await post(base,'/api/scan',{...input,workspaceId:a.body.workspaceId},a.cookie);
    assert.equal(failed.status,502);assert.deepEqual(failed.body.calls.map((c:{http:number})=>c.http),[401]);assert.equal(attempts,1);
    const db=new DatabaseSync(path);try{assert.equal((db.prepare('SELECT http FROM calls').get() as {http:number}).http,401);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM rail_scan_receipts').get() as {n:number}).n,0);}finally{db.close();}
    process.env.CLOSER_SCAN_BUDGET_USD='0';
    const capped=await post(base,'/api/scan',{...input,workspaceId:a.body.workspaceId},a.cookie);
    assert.equal(capped.status,429);assert.equal(capped.body.code,'CALL_CAP_REACHED');assert.equal(attempts,1);
  });
});

test('a budget-limited SAM stage is labelled as a local box-crop fallback, never a provider mask',async()=>{
  let attempts=0;const fake=createFakeMetaTransport();
  await fixture(async request=>{attempts++;return fake(request);},async base=>{
    process.env.CLOSER_SCAN_BUDGET_USD='0.018';
    const a=await register(base,'meta-partial');
    const result=await post(base,'/api/scan',{...input,workspaceId:a.body.workspaceId},a.cookie);
    assert.equal(result.status,200);assert.equal(attempts,1);assert.equal(result.body.calls.length,1);
    assert.equal(result.body.samMode,'box_crop');assert.ok(result.body.cards.every((c:{cutoutKind:string})=>c.cutoutKind==='box_crop'));
    assert.ok(result.body.notes.some((n:string)=>n.includes('SAM was not called because the local scan budget')));
    assert.ok(result.body.receiptId);
  });
});
