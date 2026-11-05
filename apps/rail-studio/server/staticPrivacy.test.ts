// Real HTTP static-file checks use synthetic text fixtures, never an account database.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer as viteServer, type ViteDevServer } from 'vite';

process.env.CLOSER_NO_LISTEN = '1';
const appRoot = resolve(import.meta.dirname, '..');
const { createApp } = await import('../server.ts');
const MARKER = 'SYNTHETIC_PRIVATE_FIXTURE_4719';
const PUBLIC = 'public-asset-check';
const names = ['.data/marker.txt', '.env.local', 'closet.db', 'closet.db-wal', 'closet.sqlite-shm', 'closet.sqlite3-journal', 'UPPER.SQLITE'];
function put(root: string, name: string, content: string) { const file = join(root,name); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,content); }
async function get(port:number,path:string,method='GET'):Promise<{status:number;body:string}> {
  return new Promise((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port,path,method},res=>{
      let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode??0,body}));
    });req.on('error',reject);req.end();
  });
}
async function fixture(mode:'dev'|'production',run:(port:number,root:string)=>Promise<void>) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'closer-static-private-')));
  const previousCwd=process.cwd(), previousDb=process.env.CLOSER_ACCOUNT_DB;
  const assetRoot=mode==='production'?join(root,'dist'):root;
  for(const name of names)put(assetRoot,name,MARKER);
  for(const suffix of ['','-wal','-shm','-journal'])put(assetRoot,'custom-account'+suffix,MARKER);
  put(assetRoot,'public.txt',PUBLIC);
  put(join(root,'src/assets'), 'nested.sqlite', MARKER);
  put(assetRoot,'index.html','<!doctype html><title>Static fixture</title>');
  const databasePath=join(assetRoot,'custom-account');
  process.env.CLOSER_ACCOUNT_DB=databasePath;
  process.chdir(root);
  const app=createApp({dbPath:databasePath});
  const server=httpServer(app);
  let vite:ViteDevServer|undefined;
  try {
    if(mode==='dev') {
      vite=await viteServer({configFile:join(appRoot,'vite.config.ts'),root,cacheDir:join(root,'.vite'),logLevel:'silent',server:{middlewareMode:true,hmr:false,watch:null,fs:{allow:[root]}},appType:'custom'});
      app.use(vite.middlewares);
    } else {
      app.use(express.static(assetRoot));
      app.use('/src/assets',express.static(join(root,'src/assets'),{fallthrough:false}));
    }
    server.listen(0,'127.0.0.1');await once(server,'listening');
    await run((server.address() as AddressInfo).port,root);
  } finally {
    server.closeAllConnections();
    if(server.listening)await new Promise<void>(done=>server.close(()=>done()));
    await vite?.close();app.locals.closeAccounts();
    process.chdir(previousCwd);
    if(previousDb===undefined)delete process.env.CLOSER_ACCOUNT_DB;else process.env.CLOSER_ACCOUNT_DB=previousDb;
    rmSync(root,{recursive:true,force:true});
  }
}
for(const mode of ['dev','production'] as const) {
  test(`HTTP ${mode}: account files, sidecars, encoded paths and source-file URLs never expose fixture bytes`,()=>fixture(mode,async(port,root)=>{
    assert.deepEqual(await get(port,'/public.txt'),{status:200,body:PUBLIC});
    const assetRoot=mode==='production'?join(root,'dist'):root;
    const urls=[...names.map(name=>'/'+name),
      '/%2edata/marker.txt','/%252edata/marker.txt','/%25252edata/marker.txt',
      '/closet%2edb?raw=1','/closet%252edb?url','/%2eenv.local',
      '/src/assets/nested.sqlite',
      ...['','-wal','-shm','-journal'].map(suffix=>'/custom-account'+suffix),
      ...['closet.db','.data/marker.txt','custom-account','custom-account-wal'].map(name=>'/@fs/'+join(assetRoot,name)),
      '/@fs/'+encodeURIComponent(join(assetRoot,'custom-account')),
    ];
    for(const url of urls) {
      const response=await get(port,url);
      assert.ok([403,404].includes(response.status),`${mode} ${url}: expected refusal, got ${response.status}`);
      assert.equal(response.body.includes(MARKER),false,`${mode} ${url}: private bytes leaked`);
    }
    assert.ok([403,404].includes((await get(port,'/closet.db','HEAD')).status));
  }));
}

test('bare Vite also denies the configured account path and database extensions',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'closer-vite-private-')));
  const previousDb=process.env.CLOSER_ACCOUNT_DB;
  for(const name of ['closet.db','.data/marker.txt','custom-account','custom-account-wal'])put(root,name,MARKER);
  put(root,'public.txt',PUBLIC);
  process.env.CLOSER_ACCOUNT_DB=join(root,'custom-account');
  let vite:ViteDevServer|undefined;
  const app=express(),server=httpServer(app);
  try {
    vite=await viteServer({configFile:join(appRoot,'vite.config.ts'),root,cacheDir:join(root,'.vite'),logLevel:'silent',server:{middlewareMode:true,hmr:false,watch:null,fs:{allow:[root]}},appType:'custom'});
    app.use(vite.middlewares);server.listen(0,'127.0.0.1');await once(server,'listening');
    const port=(server.address() as AddressInfo).port;
    assert.equal((await get(port,'/public.txt')).body,PUBLIC);
    for(const name of ['closet.db','.data/marker.txt','custom-account','custom-account-wal']) {
      for(const url of ['/'+name,'/@fs/'+join(root,name)]) {
        const result=await get(port,url);assert.ok([403,404].includes(result.status),url);assert.equal(result.body.includes(MARKER),false);
      }
    }
  } finally {
    server.closeAllConnections();if(server.listening)await new Promise<void>(done=>server.close(()=>done()));await vite?.close();
    if(previousDb===undefined)delete process.env.CLOSER_ACCOUNT_DB;else process.env.CLOSER_ACCOUNT_DB=previousDb;
    rmSync(root,{recursive:true,force:true});
  }
});
