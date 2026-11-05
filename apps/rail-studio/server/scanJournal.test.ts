import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ScanJournal } from './scanJournal.ts';
import { scanPhoto } from './scan.ts';
import { createFakeMetaTransport, FAKE_SPARK_ANSWER } from './fakeMeta.ts';
import { SPARK_MODEL, SAM_MODEL } from './closer/adapters/responses.ts';
import { encodePng } from './closer/engine/png.ts';
import type { GarmentPiece } from '../src/types/closet.ts';

const req = {path:'/responses' as const,body:{model:SPARK_MODEL}};
function fixture(fn:(path:string)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'closer-meta-journal-'));
  return fn(join(dir,'test.sqlite')).finally(()=>rmSync(dir,{recursive:true,force:true}));
}

test('durable reservations reject simultaneous work across connections and survive restart',()=>fixture(async path=>{
  const a = new ScanJournal(path), b = new ScanJournal(path);
  let release!:()=>void; let entered!:()=>void;
  const started=new Promise<void>(r=>entered=r);
  const gate=new Promise<void>(r=>release=r);
  const first=a.transport('scan-a','acct-a',18_000,async()=>{entered();await gate;return {status:200,headers:{},json:{}};},Date.now()+10_000)(req);
  await started;
  assert.equal(b.status().reservedMicroUsd,18_000);
  let reached=false;
  const denied=await b.transport('scan-b','acct-b',18_000,async()=>{reached=true;return {status:200,headers:{},json:{}};},Date.now()+10_000)(req);
  assert.equal(denied.status,402);assert.equal(reached,false);
  b.close();const reopened=new ScanJournal(path);assert.equal(reopened.status().pendingAttempts,1);reopened.close();
  release();await first;
  assert.equal(a.status().reservedMicroUsd,0);assert.equal(a.status().estimatedCostMicroUsd,18_000);a.close();
  const after=new ScanJournal(path);try{assert.equal(after.status().successfulLiveCalls,1);assert.equal(after.status().estimatedCostMicroUsd,18_000);}finally{after.close();}
}));

test('provider errors and uncertain transport outcomes are recorded without secrets; local caps are not calls',()=>fixture(async path=>{
  const journal=new ScanJournal(path);
  try {
    await journal.transport('scan-401','acct-a',100_000,async()=>({status:401,headers:{},json:{error:{message:'must-not-be-stored'}}}),Date.now()+1000)(req);
    await journal.transport('scan-error','acct-a',100_000,async()=>{throw new Error('private-network-detail');},Date.now()+1000)(req);
    await journal.transport('scan-timeout','acct-a',100_000,async()=>{throw new DOMException('private-body','TimeoutError');},Date.now()+1000)(req);
    assert.deepEqual(journal.calls('scan-401','acct-a').map(c=>c.http),[401]);
    assert.deepEqual(journal.calls('scan-error','acct-a').map(c=>c.http),[0]);
    assert.deepEqual(journal.calls('scan-timeout','acct-a').map(c=>c.http),[504]);
    assert.deepEqual(journal.calls('scan-401','acct-b'),[]);
    assert.equal(journal.status().estimatedCostMicroUsd,54_000);
    let reached=false;
    const deadline=await journal.transport('scan-expired','acct-a',100_000,async()=>{reached=true;return {status:200,headers:{},json:null};},Date.now()-1)(req);
    assert.equal(deadline.status,504);assert.equal(reached,false);assert.deepEqual(journal.calls('scan-expired','acct-a'),[]);
    const db=new DatabaseSync(path);try{const rows=JSON.stringify(db.prepare('SELECT * FROM calls').all());assert.equal(rows.includes('private-'),false);assert.equal(rows.includes('must-not'),false);}finally{db.close();}
  } finally {journal.close();}
}));

test('the journal supplies an abort deadline to the actual HTTP attempt',()=>fixture(async path=>{
  const journal=new ScanJournal(path);
  try {
    const result=await journal.transport('scan-aborted','acct-a',18_000,async({signal})=>{
      assert.ok(signal);
      // Keep a short test timer alive; AbortSignal.timeout itself is unref'ed by Node.
      const hold=setTimeout(()=>{},100);
      try {await new Promise<void>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
      finally{clearTimeout(hold);}
      return {status:200,headers:{},json:null};
    },Date.now()+10)(req);
    assert.equal(result.status,504);assert.equal(journal.calls('scan-aborted','acct-a')[0].http,504);assert.equal(journal.status().estimatedCostMicroUsd,18_000);
  } finally {journal.close();}
}));

test('usage estimates release only known successful allocation and bound malicious Retry-After',()=>fixture(async path=>{
  const journal=new ScanJournal(path);
  try {
    const answer=await journal.transport('scan-usage','acct-a',18_000,async()=>({status:200,headers:{'retry-after':'9999999'},json:{usage:{input_tokens:100,output_tokens:200}}}),Date.now()+1000)(req);
    assert.equal(answer.headers['retry-after'],'2');assert.equal(journal.status().estimatedCostMicroUsd,975);
    assert.equal(journal.status().reservedMicroUsd,0);
    await journal.transport('scan-bad-usage','acct-a',100_000,async()=>({status:200,headers:{},json:{usage:{input_tokens:-9999,output_tokens:0}}}),Date.now()+1000)(req);
    assert.equal(journal.status().estimatedCostMicroUsd,18_975);
  } finally {journal.close();}
}));

test('server receipts bind account, original card, cutout pixels and mask provenance; legacy is never new proof',()=>fixture(async path=>{
  const journal=new ScanJournal(path);
  try {
    const dir=join(import.meta.dirname,'test','fixtures');
    const result=await scanPhoto({jpegBase64:readFileSync(join(dir,'outfit.jpg')).toString('base64'),pngBase64:readFileSync(join(dir,'outfit.png')).toString('base64'),sentence:''},{source:'live',transport:journal.transport('scan-proof','acct-a',100_000,createFakeMetaTransport(),Date.now()+10_000)});
    assert.equal(result.ok,true);if(!result.ok)return;
    assert.equal(journal.receipt('scan-proof','acct-a',result),'scan-proof');
    const card=result.cards[0];
    const p={id:'scan-piece',scanMode:'live',scanReceiptId:'scan-proof',scanCardId:String(card.cardId),imageUrl:card.cutout,frontImageUrl:card.cutout,cutoutSource:card.cutoutKind==='mask'?'sam-mask':'box-crop'} as GarmentPiece;
    assert.doesNotThrow(()=>journal.validatePieces('acct-a',[p],[]));
    assert.deepEqual(journal.resolveItem('acct-a',p),{type:card.type,color:card.maskColor??card.sparkColor,formality:card.formality});
    assert.throws(()=>journal.resolveItem('acct-b',p));
    assert.throws(()=>journal.validatePieces('acct-b',[p],[]));
    assert.throws(()=>journal.validatePieces('acct-a',[{...p,scanCardId:'99'}],[]));
    const different=`data:image/png;base64,${encodePng({w:2,h:2,data:new Uint8Array(16).fill(255)}).toString('base64')}`;
    assert.throws(()=>journal.validatePieces('acct-a',[{...p,imageUrl:different}],[]));
    assert.throws(()=>journal.validatePieces('acct-a',[{...p,cutoutSource:p.cutoutSource==='sam-mask'?'box-crop':'sam-mask'}],[]));
    assert.throws(()=>journal.validatePieces('acct-a',[p,{...p,id:'scan-duplicate'}],[]));
    const legacy={...p,scanReceiptId:undefined,scanCardId:undefined};
    assert.doesNotThrow(()=>journal.validatePieces('acct-a',[legacy],[legacy]));
    assert.throws(()=>journal.validatePieces('acct-a',[legacy],[]));
    assert.throws(()=>journal.validatePieces('acct-a',[{...legacy,imageUrl:different}],[legacy]));
    assert.equal(journal.status().scans,1);assert.equal(journal.status().successfulLiveCalls,2);
    assert.ok(journal.calls('scan-proof','acct-a').some(c=>c.model===SAM_MODEL));
  } finally {journal.close();}
}));


test('owner color choice is restricted to receipt alternatives and reaches the canonical item; old receipts keep their default',()=>fixture(async path=>{
  const journal=new ScanJournal(path);
  try {
    const fake=createFakeMetaTransport();
    const raw: import('./closer/adapters/transport.ts').Transport=async request=>{
      if(request.body.model!==SPARK_MODEL)return fake(request);
      const answer=structuredClone(FAKE_SPARK_ANSWER);answer.garments[0].color_family='black';
      return {status:200,headers:{},json:{output_text:JSON.stringify(answer)}};
    };
    const dir=join(import.meta.dirname,'test','fixtures');
    const result=await scanPhoto({jpegBase64:readFileSync(join(dir,'outfit.jpg')).toString('base64'),pngBase64:readFileSync(join(dir,'outfit.png')).toString('base64'),sentence:''},{source:'mock',transport:journal.transport('scan-colors','acct-a',100_000,raw,Date.now()+10_000)});
    assert.equal(result.ok,true);if(!result.ok)return;
    const card=result.cards[0];assert.deepEqual(card.colorChoices,['black','navy']);
    journal.receipt('scan-colors','acct-a',result);
    const piece={id:'scan-color-piece',scanMode:'live',scanReceiptId:'scan-colors',scanCardId:String(card.cardId),imageUrl:card.cutout,frontImageUrl:card.cutout,cutoutSource:'sam-mask'} as GarmentPiece;
    assert.equal(journal.resolveItem('acct-a',piece)?.color,'navy');
    assert.equal(journal.resolveItem('acct-a',{...piece,scanColor:'black'})?.color,'black');
    assert.equal(journal.resolveItem('acct-a',{...piece,scanColor:'navy'})?.color,'navy');
    assert.throws(()=>journal.validatePieces('acct-a',[{...piece,scanColor:'green'}],[]),/colors returned/);
    assert.throws(()=>journal.validatePieces('acct-a',[{...piece,scanColor:'ultraviolet'}],[]),/colors returned/);
    const db=new DatabaseSync(path);try{
      const row=db.prepare('SELECT cards_json FROM rail_scan_receipts WHERE receipt_id=?').get('scan-colors') as {cards_json:string};
      const cards=JSON.parse(row.cards_json) as {allowedColors?:string[]}[];cards.forEach(c=>delete c.allowedColors);
      db.prepare('UPDATE rail_scan_receipts SET cards_json=? WHERE receipt_id=?').run(JSON.stringify(cards),'scan-colors');
    }finally{db.close();}
    assert.equal(journal.resolveItem('acct-a',piece)?.color,'navy');
    assert.equal(journal.resolveItem('acct-a',{...piece,scanColor:'navy'})?.color,'navy');
    assert.throws(()=>journal.resolveItem('acct-a',{...piece,scanColor:'black'}),/colors returned/);
  }finally{journal.close();}
}));
