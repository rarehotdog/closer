import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountWardrobeStore, LedgerBridgeError } from './accountStore.ts';
import { kstDateOf } from '../../../shared/dates.ts';
import type { GarmentPiece } from '../src/types/closet.ts';

function piece(id='piece-custom-test'):GarmentPiece {
 return {id,code:'A1',name:'Owner jacket',brand:'Owner entered',category:'blazer',silhouette:'blazer',currency:'KRW',purchasePrice:null,isSample:false,colorHex:'#112233',secondaryColorHex:'#334455',fabricLabel:'Unknown',hangerType:'walnut-brass',wearsLast60Days:0,wearLogStatus:'insufficient',observations:[{id:'obs-same',date:kstDateOf(new Date()),platform:'KREAM',price:125000,currency:'KRW',kind:'listed'}],feeConfig:{platform:'KREAM',feeRatePct:5.5,shippingCost:3500,feeRateConfirmed:true,shippingConfirmed:true,confirmed:true}};
}
function fixture(run:(s:AccountWardrobeStore,path:string)=>void){const dir=mkdtempSync(join(tmpdir(),'rail-ledger-'));const path=join(dir,'db.sqlite');const s=new AccountWardrobeStore(path);try{run(s,path);}finally{s.close();rmSync(dir,{recursive:true,force:true});}}
function save(s:AccountWardrobeStore,ws:string,pieces:GarmentPiece[],id:string){const d=s.read(ws);return s.save(ws,d.revision,pieces,id,d.ledgerRevision)!;}

test('registration writes canonical items and evidence with scoped IDs; overlapping accounts cannot pool totals',()=>fixture(s=>{
 const a=save(s,'a',[piece()],'save-a-first');save(s,'b',[{...piece(),observations:[{...piece().observations[0],price:70000}]}],'save-b-first');
 const ar=s.report('a'),br=s.report('b');assert.equal(a.ledgerRevision,2);assert.equal(ar.revision,a.revision);assert.equal(ar.ledgerRevision,a.ledgerRevision);assert.equal(ar.state.items[0].origin,'manual');assert.equal(ar.state.items[0].formality,'unknown');assert.equal(ar.state.items[0].cutoutRef,null);
 assert.equal(ar.summary.byCurrency[0].owner.total,125000);assert.equal(br.summary.byCurrency[0].owner.total,70000);assert.notEqual(ar.summary.tags['piece-custom-test'].evidenceId,br.summary.tags['piece-custom-test'].evidenceId);assert.equal(ar.state.wearRows.length,0);
}));

test('identical request replays before revision checks; different payload cannot reuse the identifier',()=>fixture(s=>{
 const first=s.read('a');const saved=s.save('a',first.revision,[piece()],'same-request',first.ledgerRevision)!;
 assert.deepEqual(s.save('a',0,[piece()],'same-request',0),saved);
 assert.throws(()=>s.save('a',0,[{...piece(),name:'Different'}],'same-request',0),e=>e instanceof LedgerBridgeError&&e.code==='EVENT_CONFLICT');
 assert.equal(s.report('a').state.events.length,2);
 assert.equal(s.save('a',0,[],'stale-snapshot',saved.ledgerRevision),null);
}));

test('native ledger changes invalidate canonical CAS even when presentation revision is unchanged',()=>fixture(s=>{
 const saved=save(s,'a',[piece()],'first-save');
 const r=s.ledger.write({workspaceId:'a',expectedRevision:saved.ledgerRevision,events:[{eventId:'native-event',kind:'AVAILABILITY_CHANGED',actor:'human',occurredAt:kstDateOf(new Date()),correctsEventId:null,payload:{itemId:piece().id,state:'LAUNDRY'}}]},()=>({ok:true,mutations:[{op:'putAvailability',row:{itemId:piece().id,state:'LAUNDRY',since:kstDateOf(new Date())}}]}),new Date().toISOString());assert.equal(r.ok,true);
 assert.throws(()=>s.save('a',saved.revision,[{...piece(),name:'Changed'}],'native-stale',saved.ledgerRevision),e=>e instanceof LedgerBridgeError&&e.code==='LEDGER_CONFLICT');
 assert.equal(s.read('a').pieces[0].name,piece().name);
}));

test('projection failure rolls back event, canonical item, evidence, snapshot and revision together',()=>fixture((s,path)=>{
 const before=s.read('a');const conn=new DatabaseSync(path);
 try{conn.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON rail_studio_wardrobes BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
 assert.throws(()=>s.save('a',0,[piece()],'rollback-save',0),/test rollback/);
 assert.deepEqual(s.read('a'),before);assert.equal(s.report('a').state.events.length,0);assert.equal(s.extras.evidence('a').length,0);
 conn.exec('DROP TRIGGER fail_snapshot');assert.ok(s.save('a',0,[piece()],'rollback-save',0));}finally{conn.close();}
}));

test('remove and re-add preserve events and decision history; recorded wear prevents destructive removal',()=>fixture(s=>{
 save(s,'a',[piece()],'first-save');const p={...piece(),lastDecision:{id:'d-now',choice:'sell' as const,savedAt:kstDateOf(new Date()),snapshotPrice:125000,snapshotCurrency:'KRW' as const,snapshotPlatform:'KREAM' as const}};
 save(s,'a',[p],'decision-save');save(s,'a',[],'remove-save');assert.equal(s.report('a').summary.pieces,0);assert.equal(s.extras.decisions('a').length,1);assert.equal(s.report('a').state.events.filter(e=>e.kind==='ITEM_REMOVED').length,1);
 save(s,'a',[p],'restore-save');assert.equal(s.report('a').summary.pieces,1);assert.equal(s.extras.decisions('a').length,1);
 const current=s.read('a');s.ledger.write({workspaceId:'a',expectedRevision:current.ledgerRevision,events:[{eventId:'wear-record',kind:'WEAR_CONFIRMED',actor:'human',occurredAt:kstDateOf(new Date()),correctsEventId:null,payload:{itemIds:[p.id]}}]},()=>({ok:true,mutations:[{op:'insertWear',row:{eventId:'wear-record',planId:null,itemIds:[p.id],occurredAt:kstDateOf(new Date())}}]}),new Date().toISOString());
 assert.throws(()=>save(s,'a',[],'remove-with-wear'),e=>e instanceof LedgerBridgeError&&e.code==='ITEM_REFERENCED');assert.equal(s.report('a').state.wearRows.length,1);
}));

test('decision net is immutable, fees need explicit confirmation, and historical imports keep unknown fees',()=>fixture(s=>{
 save(s,'a',[piece()],'first-save');
 const decision={id:'decision-1',choice:'sell' as const,savedAt:kstDateOf(new Date()),snapshotPrice:125000,snapshotCurrency:'KRW' as const,snapshotPlatform:'KREAM' as const,feeSnapshot:piece().feeConfig};
 const p={...piece(),lastDecision:decision};save(s,'a',[p],'new-decision');assert.equal(s.extras.decisions('a')[0].sell.scenario?.net,114625);
 save(s,'a',[{...p,feeConfig:{...p.feeConfig,shippingCost:5000}}],'edit-fees');assert.equal(s.extras.decisions('a')[0].sell.scenario?.net,114625);
 assert.throws(()=>save(s,'a',[{...p,lastDecision:{...decision,snapshotPrice:200000}}],'edit-decision'),/DECISION_CONFLICT/);
 save(s,'b',[{...p,lastDecision:{...decision,feeSnapshot:undefined}}],'historical-import');assert.equal(s.extras.decisions('b')[0].sell.scenario?.net,null);
 save(s,'c',[piece()],'unknown-first');save(s,'c',[{...p,lastDecision:{...decision,feeSnapshot:{...p.feeConfig,feeRateConfirmed:false,confirmed:false}},feeConfig:{...p.feeConfig,feeRateConfirmed:false,confirmed:false}}],'unknown-fees');assert.equal(s.extras.decisions('c')[0].sell.scenario?.net,null);
}));

test('currency mismatch and reported wears stay explicit without invented conversions or wear rows',()=>fixture(s=>{
 const p={...piece(),wearsLast60Days:9,observations:[{...piece().observations[0],platform:'Vinted' as const,currency:'USD' as const}]};
 const saved=save(s,'a',[p],'currency-save');assert.equal(saved.ledgerStatus,'partial');assert.equal(saved.ledgerWarnings.length,2);assert.equal(saved.pieces[0].observations[0].currency,'USD');assert.equal(s.report('a').summary.withEvidence,0);assert.equal(s.report('a').state.wearRows.length,0);
}));

test('legacy snapshots migrate without revision loss and survive fresh connections with photos intact',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rail-migrate-')),path=join(dir,'db.sqlite'),db=new DatabaseSync(path);const p={...piece(),imageUrl:'data:image/png;base64,test-fixture-presentation-only'};
 db.exec('CREATE TABLE rail_studio_wardrobes (workspace_id TEXT PRIMARY KEY,revision INTEGER,pieces_json TEXT,updated_at TEXT)');db.prepare('INSERT INTO rail_studio_wardrobes VALUES (?,?,?,?)').run('a',7,JSON.stringify([p]),'2026-11-01T00:00:00Z');db.close();
 try {let s=new AccountWardrobeStore(path);const migrated=s.read('a');assert.equal(migrated.revision,7);assert.equal(migrated.updatedAt,'2026-11-01T00:00:00Z');assert.equal(migrated.pieces[0].imageUrl,p.imageUrl);assert.equal(s.report('a').summary.pieces,1);s.close();s=new AccountWardrobeStore(path);assert.deepEqual(s.read('a'),migrated);assert.equal(s.report('a').state.events.length,2);s.close();}finally{rmSync(dir,{recursive:true,force:true});}
});

test('trusted scan classifications retain all four original slots instead of UI silhouettes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rail-scan-mapping-')),path=join(dir,'db.sqlite');
 const trusted = new Map([
   ['c1',{type:'coat' as const,color:'navy' as const,formality:'mid' as const}],
   ['c2',{type:'dress_shirt' as const,color:'white' as const,formality:'high' as const}],
   ['c3',{type:'jeans' as const,color:'blue' as const,formality:'low' as const}],
   ['c4',{type:'sneakers' as const,color:'black' as const,formality:'low' as const}],
 ]);
 const s=new AccountWardrobeStore(path,(ws,p)=>ws==='a'&&p.scanReceiptId==='trusted-receipt'?trusted.get(p.scanCardId!)??null:null);
 try {
   const pieces=[...trusted.keys()].map((cardId,i)=>({...piece(`scan-piece-${i}`),scanMode:'live' as const,scanReceiptId:'trusted-receipt',scanCardId:cardId,category:'shirt' as const,silhouette:'tee' as const,colorHex:'#ffffff'}));
   save(s,'a',pieces,'four-card-save');
   const items=s.report('a').state.items;
   assert.deepEqual(items.map(i=>i.type),['coat','dress_shirt','jeans','sneakers']);
   assert.deepEqual(items.map(i=>i.slot),['outer','top','bottom','shoes']);
   assert.deepEqual(items.map(i=>i.formality),['mid','high','low','low']);
   assert.deepEqual(items.map(i=>i.color),['navy','white','blue','black']);
   // A client-only classification cannot substitute for the stored server result.
   save(s,'a',pieces.map(p=>({...p,category:'blazer' as const,type:'jacket'})),'forged-ui-type');
   assert.deepEqual(s.report('a').state.items.map(i=>i.type),['coat','dress_shirt','jeans','sneakers']);
 } finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('decision fee snapshots survive local-date differences and same-save registration; older unknown decisions remain unknown',()=>fixture(s=>{
 const oldDecision={id:'legacy-decision',choice:'sell' as const,savedAt:'2026-01-01',snapshotPrice:125000,snapshotCurrency:'KRW' as const,snapshotPlatform:'KREAM' as const};
 save(s,'a',[{...piece(),lastDecision:oldDecision}],'legacy-import');
 assert.equal(s.extras.decisions('a')[0].sell.scenario?.net,null);
 const newDecision={...oldDecision,id:'new-decision',feeSnapshot:piece().feeConfig};
 save(s,'a',[{...piece(),lastDecision:newDecision}],'new-snapshot');
 const snapshots=s.extras.decisions('a');
 assert.equal(snapshots[0].sell.scenario?.net,null);
 assert.equal(snapshots[1].sell.scenario?.net,114625);
 save(s,'a',[{...piece(),feeConfig:{...piece().feeConfig,shippingCost:9999},lastDecision:newDecision}],'later-current-fees');
 assert.equal(s.extras.decisions('a')[1].sell.scenario?.net,114625);
 save(s,'b',[{...piece(),lastDecision:newDecision}],'same-save-new-item');
 assert.equal(s.extras.decisions('b')[0].sell.scenario?.net,114625);
}));
