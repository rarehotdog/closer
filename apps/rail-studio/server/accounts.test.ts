import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createAccountRouter } from './accountRouter.ts';
import { validateWardrobe } from './wardrobeSchema.ts';
import { encodePng } from './closer/engine/png.ts';
import { ExtrasStore } from '../../../store/extras.ts';
import { hashSessionToken } from '../../../web/guard.ts';
import type { GarmentPiece } from '../src/types/closet.ts';

const PASSWORD = 'wardrobe-test-password';
function piece(id = 'piece-custom-test'): GarmentPiece {
  const photo = `data:image/png;base64,${encodePng({w:2,h:2,data:new Uint8Array(16).fill(255)}).toString('base64')}`;
  return {id,code:'A1',name:'My navy blazer',brand:'Entered by me',category:'blazer',silhouette:'blazer',currency:'KRW',purchasePrice:100000,isSample:false,colorHex:'#112233',secondaryColorHex:'#334455',fabricLabel:'Wool',hangerType:'walnut-brass',wearsLast60Days:0,wearLogStatus:'insufficient',lastWornDate:null,conditionGrade:'Good (A)',upcomingOccasions:['Dinner'],lockedForToday:true,occlusionStatus:'front_verified',imageUrl:photo,frontImageUrl:photo,observations:[{id:'obs-1',date:'2026-11-05',platform:'KREAM',price:50000,currency:'KRW',kind:'listed'}],feeConfig:{platform:'KREAM',feeRatePct:5.5,shippingCost:3000,feeRateConfirmed:true,shippingConfirmed:true,confirmed:true},lastDecision:{id:'d_test',choice:'keep',savedAt:'2026-11-05',snapshotPrice:50000,snapshotCurrency:'KRW',snapshotPlatform:'KREAM',note:'Keep this season'}};
}
async function start(db: string) {
  const api = createAccountRouter({dbPath:db}); const app = express(); app.use('/api/account',api.router);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  return {base,stop:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));api.close();}};
}
async function request(base:string,path:string,method='GET',body?:unknown,cookie?:string,origin:string|false=base) {
  const headers:Record<string,string>={};if(cookie) headers.Cookie=cookie;
  if(method!=='GET') {headers['Content-Type']='application/json';if(origin)headers.Origin=origin;}
  if(path==='/wardrobe'&&method==='PUT'&&body&&typeof body==='object'){
    const current=await fetch(base+'/api/account/wardrobe',{headers:cookie?{Cookie:cookie}:{}}).then(r=>r.json());
    body={expectedLedgerRevision:current.ledgerRevision??0,requestId:randomUUID(),...body};
  }
  const response=await fetch(base+'/api/account'+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]??'',headers:response.headers};
}
async function register(base:string,handle:string) {
  const r=await request(base,'/register','POST',{handle,password:PASSWORD});assert.equal(r.status,200);return r;
}
async function fixture(run:(base:string,db:string)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'closer-account-')); const db=join(dir,'state.sqlite');const service=await start(db);
  try {await run(service.base,db);} finally {await service.stop();rmSync(dir,{recursive:true,force:true});}
}

test('private wardrobe read-back preserves photos, decisions, prices and fees; accounts stay separate',()=>fixture(async(base)=>{
  const a=await register(base,'wardrobe-a');const b=await register(base,'wardrobe-b');
  assert.match(a.cookie,/^closer_rail_acct=/);assert.match(a.headers.get('set-cookie')??'',/HttpOnly/);assert.match(a.headers.get('set-cookie')??'',/SameSite=Strict/);
  assert.equal((await request(base,'/wardrobe')).status,401);
  const first=await request(base,'/wardrobe','GET',undefined,a.cookie);assert.deepEqual(first.body.pieces,[]);assert.equal(first.body.revision,0);
  const saved=await request(base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:0,pieces:[piece()]},a.cookie);
  assert.equal(saved.status,200);assert.equal(saved.body.revision,1);assert.deepEqual(saved.body.pieces,[piece()]);assert.ok(saved.body.updatedAt);
  assert.deepEqual((await request(base,'/wardrobe','GET',undefined,a.cookie)).body,saved.body);
  assert.deepEqual((await request(base,'/wardrobe','GET',undefined,b.cookie)).body.pieces,[]);
  assert.equal((await request(base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:0,pieces:[]},b.cookie)).status,403);
  assert.equal((await request(base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:0,pieces:[]},a.cookie)).status,409);
  assert.equal((await request(base,'/wardrobe','GET',undefined,a.cookie)).body.pieces.length,1);
  assert.equal(saved.headers.get('cache-control'),'no-store');
}));

test('origin and JSON guards block sibling-port writes, missing origins and guest claims',()=>fixture(async(base)=>{
  assert.equal((await request(base,'/register','POST',{handle:'origin-test',password:PASSWORD},undefined,'http://127.0.0.1:1')).status,403);
  assert.equal((await request(base,'/register','POST',{handle:'origin-test',password:PASSWORD},undefined,false)).status,403);
  assert.equal((await request(base,'/register','POST',{handle:'origin-test',password:PASSWORD,claimWorkspaceId:'my-other'})).status,400);
  const response=await fetch(base+'/api/account/register',{method:'POST',headers:{Origin:base,'Content-Type':'text/plain'},body:'{}'});assert.equal(response.status,415);
  assert.equal((await request(base,'/register','POST',[])).status,400);
  const a=await register(base,'origin-test');
  assert.equal((await request(base,'/logout','POST',{},a.cookie,'https://outside.example.com')).status,403);
  assert.equal((await request(base,'','GET',undefined,a.cookie)).body.signedIn,true);
}));

test('simultaneous duplicate registration creates one account and one session',()=>fixture(async(base,db)=>{
  const results=await Promise.all([1,2].map(()=>request(base,'/register','POST',{handle:'same-name',password:PASSWORD})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const read=new DatabaseSync(db);try {
    assert.equal((read.prepare('SELECT COUNT(*) AS n FROM accounts').get() as {n:number}).n,1);
    assert.equal((read.prepare('SELECT COUNT(*) AS n FROM account_sessions').get() as {n:number}).n,1);
    const row=read.prepare('SELECT password_hash,salt FROM accounts').get() as {password_hash:string,salt:string};assert.notEqual(row.password_hash,PASSWORD);assert.ok(row.salt);
  }finally{read.close();}
}));

test('logout revokes the stored session and sign-in restores the same private wardrobe',()=>fixture(async(base,db)=>{
  const a=await register(base,'persisted');await request(base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:0,pieces:[piece()]},a.cookie);
  assert.equal((await request(base,'/login','POST',{handle:'persisted',password:'wrong-password'})).status,401);
  assert.equal((await request(base,'/logout','POST',{},a.cookie)).status,200);
  assert.equal((await request(base,'/wardrobe','GET',undefined,a.cookie)).status,401);
  const signed=await request(base,'/login','POST',{handle:'persisted',password:PASSWORD});assert.equal(signed.status,200);assert.equal(signed.body.workspaceId,a.body.workspaceId);
  assert.equal((await request(base,'/wardrobe','GET',undefined,signed.cookie)).body.pieces[0].name,'My navy blazer');
  const read=new DatabaseSync(db);try{read.prepare('UPDATE account_sessions SET expires_at=0').run();}finally{read.close();}
  assert.equal((await request(base,'/wardrobe','GET',undefined,signed.cookie)).status,401);
}));

test('invalid or demo records never replace the last valid save',()=>fixture(async(base)=>{
  const a=await register(base,'valid-data');await request(base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:0,pieces:[piece()]},a.cookie);
  const bad=[{...piece(),id:'J1'},{...piece(),id:'piece-j1'},{...piece(),isSample:true},{...piece(),scanMode:'fake'},{...piece(),imageUrl:'https://outside.example.com/photo.jpg'},{...piece(),currency:'EUR'},{...piece(),wearsLast60Days:-1},{...piece(),observations:[{...piece().observations[0],isSample:true}]},{...piece(),feeConfig:{...piece().feeConfig,shippingConfirmed:false}},{...piece(),lastDecision:{...piece().lastDecision,savedAt:'2026-02-30'}},{...piece(),imageUrl:'data:image/svg+xml;base64,PHN2Zz4='}];
  for(const p of bad) assert.equal((await request(base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:1,pieces:[p]},a.cookie)).status,400);
  assert.equal((await request(base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:1,pieces:[piece(),piece()]},a.cookie)).status,400);
  const last=await request(base,'/wardrobe','GET',undefined,a.cookie);assert.equal(last.body.revision,1);assert.deepEqual(last.body.pieces,[piece()]);
}));

test('registration rolls back its account if first-session insertion fails',()=>{
  const dir=mkdtempSync(join(tmpdir(),'closer-atomic-'));const store=new ExtrasStore(join(dir,'test.sqlite'));
  try{assert.throws(()=>store.createAccountWithSession({accountId:'test',handle:'atomic-test',salt:'00',passwordHash:'00',workspaceId:'scope',createdAt:new Date().toISOString()},'hash',Number.NaN));assert.equal(store.accountByHandle('atomic-test'),null);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('JPEG photo storage strips image metadata and PNG validation bounds decompression',()=>{
  const jpeg=readFileSync(new URL('./test/fixtures/outfit.jpg',import.meta.url));
  const metadata=Buffer.from('Exif\0\0private-photo-location','latin1');const marker=Buffer.alloc(4);marker[0]=255;marker[1]=225;marker.writeUInt16BE(metadata.length+2,2);
  const withMetadata=Buffer.concat([jpeg.subarray(0,2),marker,metadata,jpeg.subarray(2)]);
  const saved=validateWardrobe([{...piece(),imageUrl:`data:image/jpeg;base64,${withMetadata.toString('base64')}`}]);assert.equal(Buffer.from(saved[0].imageUrl!.split(',')[1],'base64').includes(metadata),false);
  const invalid=Buffer.from(piece().imageUrl!.split(',')[1],'base64');invalid.writeUInt32BE(100000,16);
  assert.throws(()=>validateWardrobe([{...piece(),imageUrl:`data:image/png;base64,${invalid.toString('base64')}`}]));
});

async function childServer(db:string) {
  const moduleUrl=new URL('./accountRouter.ts',import.meta.url).href;
  const script=`import express from 'express';import {createAccountRouter} from ${JSON.stringify(moduleUrl)};const api=createAccountRouter({dbPath:process.env.TEST_DB});const app=express();app.use('/api/account',api.router);const server=app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{api.close();process.exit(0)});});`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,TEST_DB:db,MODEL_API_KEY:'',META_API_KEY:''},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stderr.on('data',b=>{errors+=b.toString();});
  const port=await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('child startup timeout '+errors));},15000);child.stdout.on('data',b=>{output+=b.toString();try{const p=JSON.parse(output.trim()).port;clearTimeout(timer);resolve(p);}catch{/* wait for the complete line */}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('child exited '+code+' '+errors));});});
  return {base:`http://127.0.0.1:${port}`,stop:async()=>{const exit=once(child,'exit');child.kill('SIGTERM');await exit;}};
}

test('an actual server process restart restores its session and saved photo and decision',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'closer-restart-')),db=join(dir,'wardrobe.sqlite');let child=await childServer(db);
  try {
    const a=await register(child.base,'restart-member');await request(child.base,'/wardrobe','PUT',{workspaceId:a.body.workspaceId,expectedRevision:0,pieces:[piece()]},a.cookie);
    await child.stop();child=await childServer(db);
    assert.equal((await request(child.base,'','GET',undefined,a.cookie)).body.signedIn,true);
    const restored=await request(child.base,'/wardrobe','GET',undefined,a.cookie);assert.equal(restored.body.revision,1);assert.deepEqual(restored.body.pieces,[piece()]);
    const rawToken=a.cookie.split('=')[1],read=new DatabaseSync(db);try {assert.ok(read.prepare('SELECT token_hash FROM account_sessions WHERE token_hash=?').get(hashSessionToken(rawToken)));assert.equal(read.prepare('SELECT token_hash FROM account_sessions WHERE token_hash=?').get(rawToken),undefined);}finally{read.close();}
  } finally {await child.stop();rmSync(dir,{recursive:true,force:true});}
});
