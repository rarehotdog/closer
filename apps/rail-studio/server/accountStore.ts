import { DatabaseSync } from 'node:sqlite';
import { SqliteLedger, stateHashOf } from '../../../store/ledger.ts';
import { ExtrasStore } from '../../../store/extras.ts';
import { FeatureService } from '../../../engine/features.ts';
import { kstDateOf } from '../../../shared/dates.ts';
import type { EventInput, Mutation } from '../../../shared/ledger.ts';
import type { GarmentPiece } from '../src/types/closet.ts';
import { canonicalItem, digest, scopedId, projectionWarnings, projectEvidence, projectDecisions, type ScanItemResolver } from './ledgerBridge.ts';

export interface WardrobeDocument {
  workspaceId: string; revision: number; pieces: GarmentPiece[]; updatedAt: string | null;
  ledgerRevision: number; ledgerStatus:'verified'|'partial'; ledgerWarnings:string[];
}
export class LedgerBridgeError extends Error {
  constructor(readonly code:string,message:string) {super(message);}
}
const flags={kill:{on:false,setAt:null,ttlMs:600000},caps:{appTotalMicroUsd:2000000,visitorDayMicroUsd:0,sessionMicroUsd:2000000,visitorZeroFrom:'22:00'}};
/** Canonical events and presentation/evidence projections commit on the ledger's one connection. */
export class AccountWardrobeStore {
  private readonly db: DatabaseSync;
  readonly ledger: SqliteLedger;
  readonly extras: ExtrasStore;
  readonly features: FeatureService;
  constructor(path: string, private readonly resolveScanItem?:ScanItemResolver) {
    if(path===':memory:') throw new Error('Use a temporary database file for the multi-reader account store');
    this.ledger=new SqliteLedger(path,flags); this.extras=new ExtrasStore(path);
    this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS rail_studio_wardrobes (
      workspace_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,pieces_json TEXT NOT NULL,updated_at TEXT NOT NULL,ledger_revision INTEGER);
      CREATE TABLE IF NOT EXISTS rail_wardrobe_requests (workspace_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(workspace_id,request_id));
      CREATE TABLE IF NOT EXISTS rail_decision_sources (workspace_id TEXT NOT NULL,client_key TEXT NOT NULL,source_hash TEXT NOT NULL,source_json TEXT NOT NULL,PRIMARY KEY(workspace_id,client_key));`);
    const columns=this.db.prepare('PRAGMA table_info(rail_studio_wardrobes)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='ledger_revision'))this.db.exec('ALTER TABLE rail_studio_wardrobes ADD COLUMN ledger_revision INTEGER');
    this.features=new FeatureService({ledger:this.ledger,extras:this.extras,today:()=>kstDateOf(new Date()),now:()=>new Date(),revision:'rail-ledger-bridge-v1'});
  }
  close() { this.db.close();this.extras.close();this.ledger.close(); }
  private raw(workspaceId:string) {
    return this.db.prepare('SELECT revision,pieces_json,updated_at,ledger_revision FROM rail_studio_wardrobes WHERE workspace_id=?').get(workspaceId) as {revision:number;pieces_json:string;updated_at:string;ledger_revision:number|null}|undefined;
  }
  private ensure(workspaceId:string) {
    if(!this.ledger.getWorkspace(workspaceId)) {
      try {this.ledger.createWorkspace({workspaceId,kind:'real',publicReadOnly:false,seedRef:'rail-account',createdOn:kstDateOf(new Date())},null);}
      catch(error){if(!this.ledger.getWorkspace(workspaceId))throw error;}
    }
    const row=this.raw(workspaceId);
    if(row && row.ledger_revision===null) {
      const result=this.commit(workspaceId,row.revision,JSON.parse(row.pieces_json),`migration-${row.revision}`,this.ledger.getWorkspace(workspaceId)!.ledgerRevision,true);
      if(!result)throw new LedgerBridgeError('REVISION_CONFLICT','The wardrobe changed during migration. Reload and try again.');
    }
  }
  read(workspaceId: string): WardrobeDocument {
    this.ensure(workspaceId);
    return this.document(workspaceId);
  }
  private document(workspaceId:string):WardrobeDocument {
    const row=this.raw(workspaceId), pieces:GarmentPiece[]=row?JSON.parse(row.pieces_json):[];
    const ledgerWarnings=projectionWarnings(pieces);
    return {workspaceId,revision:row?Number(row.revision):0,pieces,updatedAt:row?.updated_at??null,ledgerRevision:this.ledger.getWorkspace(workspaceId)!.ledgerRevision,ledgerStatus:ledgerWarnings.length?'partial':'verified',ledgerWarnings};
  }
  save(workspaceId:string,expectedRevision:number,pieces:GarmentPiece[],requestId:string,expectedLedgerRevision:number):WardrobeDocument|null {
    this.ensure(workspaceId);
    return this.commit(workspaceId,expectedRevision,pieces,requestId,expectedLedgerRevision,false);
  }
  private commit(ws:string,expectedRevision:number,pieces:GarmentPiece[],requestId:string,expectedLedgerRevision:number,migration:boolean):WardrobeDocument|null {
    const hash=digest({expectedRevision,expectedLedgerRevision,pieces,migration});
    const prior=this.db.prepare('SELECT payload_hash,response_json FROM rail_wardrobe_requests WHERE workspace_id=? AND request_id=?').get(ws,requestId) as {payload_hash:string;response_json:string}|undefined;
    if(prior){if(prior.payload_hash!==hash)throw new LedgerBridgeError('EVENT_CONFLICT','This save identifier was already used for different changes.');return JSON.parse(prior.response_json);}
    const before=this.raw(ws), previous:GarmentPiece[]=before?JSON.parse(before.pieces_json):[];
    if((before?.revision??0)!==expectedRevision)return null;
    const state=this.ledger.readState(ws), previousIds=new Set(previous.map(p=>p.id)), nextIds=new Set(pieces.map(p=>p.id));
    if(state.revision!==expectedLedgerRevision)throw new LedgerBridgeError('LEDGER_CONFLICT','The original ledger changed. Reload its latest version before saving.');
    const now=new Date(),today=kstDateOf(now),events:EventInput[]=[],mutations:Mutation[]=[];
    const event=(kind:EventInput['kind'],suffix:string,payload:unknown)=>events.push({eventId:scopedId('event',ws,requestId,suffix),kind,actor:'human',occurredAt:today,correctsEventId:null,payload});
    for(const p of pieces) {
      const existing=state.items.find(i=>i.itemId===p.id),old=previous.find(x=>x.id===p.id),mapped=canonicalItem(p,this.resolveScanItem?.(ws,p));
      if(!existing){event('REGISTRATION_CONFIRMED',p.id,{item:mapped,source:'rail-studio',metadataHash:digest(p)});mutations.push({op:'putItem',item:mapped},{op:'putAvailability',row:{itemId:p.id,state:'AVAILABLE',since:today}});}
      else if(!previousIds.has(p.id)&&!migration)throw new LedgerBridgeError('ITEM_CONFLICT','This item already belongs to another ledger import.');
      else if(old && digest(canonicalItem(old,this.resolveScanItem?.(ws,old)))!==digest(mapped))mutations.push({op:'putItem',item:{...existing,slot:mapped.slot,type:mapped.type,color:mapped.color,formality:mapped.formality}});
    }
    for(const old of previous) if(!nextIds.has(old.id)&&state.items.some(i=>i.itemId===old.id)) {
      if(state.wearRows.some(w=>w.itemIds.includes(old.id))||state.plans.some(p=>Object.values(p.slots).includes(old.id)||p.pinned.includes(old.id)))throw new LedgerBridgeError('ITEM_REFERENCED','This piece has saved wear or outfit history. Keep it in your wardrobe to preserve that history.');
      event('ITEM_REMOVED',old.id,{itemId:old.id,previousMetadataHash:digest(old)});mutations.push({op:'removeItem',itemId:old.id});
    }
    event('WARDROBE_UPDATED','snapshot',{source:'rail-studio',requestId,previousRevision:expectedRevision,snapshotHash:digest(pieces),migration});
    let saved:WardrobeDocument|undefined;
    const result=this.ledger.write({workspaceId:ws,expectedRevision:expectedLedgerRevision,events},()=>({ok:true,mutations}),now.toISOString(),(db,response)=>{
      const current=db.prepare('SELECT revision FROM rail_studio_wardrobes WHERE workspace_id=?').get(ws) as {revision:number}|undefined;
      if((current?.revision??0)!==expectedRevision)throw new LedgerBridgeError('REVISION_CONFLICT','This wardrobe changed in another window. Reload before saving.');
      projectEvidence(db,ws,pieces);
      projectDecisions(db,ws,pieces,previous,this.ledger.readState(ws,{fresh:false}),this.ledger.getWorkspace(ws)!.createdOn,now,migration);
      const revision=migration?expectedRevision:expectedRevision+1;
      const updatedAt=migration?(before?.updated_at??now.toISOString()):now.toISOString();
      db.prepare(`INSERT INTO rail_studio_wardrobes (workspace_id,revision,pieces_json,updated_at,ledger_revision) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,pieces_json=excluded.pieces_json,updated_at=excluded.updated_at,ledger_revision=excluded.ledger_revision`).run(ws,revision,JSON.stringify(pieces),updatedAt,response.ledgerRevision);
      const ledgerWarnings=projectionWarnings(pieces);
      saved={workspaceId:ws,revision,pieces,updatedAt,ledgerRevision:response.ledgerRevision,ledgerStatus:ledgerWarnings.length?'partial':'verified',ledgerWarnings};
      db.prepare('INSERT INTO rail_wardrobe_requests VALUES (?,?,?,?)').run(ws,requestId,hash,JSON.stringify(saved));
    });
    if(!result.ok)throw new LedgerBridgeError(result.code,result.detail);
    if(!saved){const replay=this.db.prepare('SELECT payload_hash,response_json FROM rail_wardrobe_requests WHERE workspace_id=? AND request_id=?').get(ws,requestId) as {payload_hash:string;response_json:string}|undefined;if(replay?.payload_hash===hash)return JSON.parse(replay.response_json);throw new Error('READBACK_MISMATCH');}
    const back=this.document(ws);
    if(back.revision!==saved.revision||digest(back.pieces)!==digest(pieces)||back.ledgerRevision!==result.ledgerRevision)throw new Error('READBACK_MISMATCH');
    return back;
  }
  report(workspaceId:string) {
    const document=this.read(workspaceId),state=this.ledger.readState(workspaceId);
    return {workspaceId,revision:document.revision,ledgerRevision:state.revision,ledgerStatus:document.ledgerStatus,ledgerWarnings:document.ledgerWarnings,stateHash:stateHashOf(state),state,summary:this.features.closetLedger(workspaceId),market:state.items.map(i=>this.features.market(workspaceId,i.itemId)),decisions:this.extras.decisions(workspaceId),calls:this.ledger.callsForWorkspace(workspaceId)};
  }
}
