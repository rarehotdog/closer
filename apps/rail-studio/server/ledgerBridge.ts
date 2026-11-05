import type { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../../../shared/canonical.ts';
import { kstDateOf } from '../../../shared/dates.ts';
import { GARMENT_TYPES, type Item, type GarmentType } from '../../../shared/wardrobe.ts';
import type { LedgerState } from '../../../shared/ledger.ts';
import { nearestColor, rgbToLab } from '../../../engine/color.ts';
import { PLATFORM_INFO, type Evidence, type Platform } from '../../../engine/market.ts';
import { basisOf, keepSideOf, sellSideOf, type DecisionSnapshot } from '../../../engine/decision.ts';
import { reviewWardrobe } from '../../../engine/review.ts';
import type { GarmentPiece, ResalePlatform } from '../src/types/closet.ts';

const platforms: Record<ResalePlatform, Platform> = {KREAM:'KREAM',Karrot:'KARROT',Bunjang:'BUNJANG','Musinsa Used':'MUSINSA_USED',Poshmark:'POSHMARK',eBay:'EBAY',Grailed:'GRAILED',Depop:'DEPOP',StockX:'STOCKX',Vinted:'VINTED'};
export const digest = (value: unknown) => sha256Hex(JSON.stringify(value));
export const scopedId = (kind: string, workspaceId: string, ...ids: string[]) => `rail-${kind}-${digest([workspaceId,...ids])}`;
export type TrustedScanItem = Pick<Item, 'type' | 'color' | 'formality'>;
export type ScanItemResolver = (workspaceId:string,piece:GarmentPiece)=>TrustedScanItem|null;
export function canonicalItem(piece: GarmentPiece, trusted:TrustedScanItem|null=null): Item {
  const type: GarmentType = trusted?.type ?? (piece.category === 'footwear' || piece.silhouette === 'sneaker-box' ? 'sneakers' : piece.category === 'trousers' || piece.silhouette === 'trousers' ? 'trousers' : piece.category === 'hoodie' ? 'hoodie'
    : piece.category === 'knitwear' ? 'knit' : piece.category === 'blazer' ? 'jacket'
    : piece.category === 'outerwear' ? piece.silhouette === 'overcoat' ? 'coat' : 'jacket'
    : piece.silhouette === 'tee' ? 'tee' : 'dress_shirt');
  const hex = piece.colorHex.slice(1);
  const color = nearestColor(rgbToLab([0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)) as [number,number,number]));
  return {itemId:piece.id,slot:GARMENT_TYPES[type],type,color:trusted?.color??color,formality:trusted?.formality??'unknown',ownership:'CONFIRMED',cutoutRef:null,
    origin:piece.scanMode ? 'photo' : 'manual',waterproof:null,sample:false};
}
export function projectionWarnings(pieces: GarmentPiece[]): string[] {
  const warnings: string[] = [];
  for (const p of pieces) {
    if (p.observations.some(o=>PLATFORM_INFO[platforms[o.platform]].currency!==o.currency)) warnings.push(`${p.code}: a price currency differs from the original ledger's platform currency. It is saved in your wardrobe but excluded from ledger totals.`);
    if (p.lastDecision && PLATFORM_INFO[platforms[p.lastDecision.snapshotPlatform]].currency !== p.lastDecision.snapshotCurrency) warnings.push(`${p.code}: the decision currency is unsupported for this platform in the original ledger. The original decision remains saved in your wardrobe.`);
    if (p.scanMode === 'live' && !(p as GarmentPiece & {scanReceiptId?:string}).scanReceiptId) warnings.push(`${p.code}: this older scan has no server receipt. Its live-model origin has not been verified.`);
    if (p.wearsLast60Days > 0 || p.wearLogStatus === 'verified') warnings.push(`${p.code}: reported wear totals are preserved as notes; only dated canonical wear events count in the ledger.`);
  }
  return warnings;
}
export function projectEvidence(db: DatabaseSync, ws: string, pieces: GarmentPiece[]) {
  // Replace only this surface's evidence. Original engine evidence remains independently owned.
  db.prepare("DELETE FROM evidence WHERE workspace_id=? AND evidence_id LIKE 'rail-evidence-%'").run(ws);
  for(const p of pieces) for(const o of p.observations) {
    const platform=platforms[o.platform]; if(PLATFORM_INFO[platform].currency!==o.currency) continue;
    const e: Evidence={evidenceId:scopedId('evidence',ws,p.id,o.id,digest(o)),itemId:p.id,platform,priceType:o.kind==='traded'?'TRADE':'ASK',amount:o.price,currency:o.currency,url:null,retrievedAt:o.date,size:null,condition:p.conditionGrade??null,matchLevel:'UNVERIFIED',source:o.isSample?'sample':'owner_entered'};
    db.prepare('INSERT INTO evidence VALUES (?,?,?)').run(e.evidenceId,ws,JSON.stringify(e));
  }
}
export function projectDecisions(db: DatabaseSync, ws: string, pieces: GarmentPiece[], previous: GarmentPiece[], state: LedgerState, createdOn: string, now: Date, migration=false) {
  const evidence=(db.prepare('SELECT body FROM evidence WHERE workspace_id=?').all(ws) as {body:string}[]).map(r=>JSON.parse(r.body) as Evidence);
  const registeredOn=new Map<string,string>();
  for(const e of state.events) if(e.kind==='REGISTRATION_CONFIRMED') {const id=(e.payload as {item?:Item})?.item?.itemId;if(id&&!registeredOn.has(id))registeredOn.set(id,e.occurredAt);}
  const today=kstDateOf(now);
  const reviews=reviewWardrobe({items:state.items,wearRows:state.wearRows,availability:new Map(state.availability.map(a=>[a.itemId,a.state])),registeredOn,workspaceCreatedOn:createdOn,exemptions:new Map(),today,windowDays:90});
  for(const p of pieces) {
    const d=p.lastDecision;if(!d)continue;
    const key=scopedId('decision',ws,p.id,d.id);
    const old=db.prepare('SELECT body FROM decisions WHERE workspace_id=? AND client_key=?').get(ws,key) as {body:string}|undefined;
    if(old) {
      const before=previous.find(x=>x.id===p.id)?.lastDecision;
      // A decision ID identifies immutable owner intent, including its chosen price/date.
      const source=db.prepare('SELECT source_hash FROM rail_decision_sources WHERE workspace_id=? AND client_key=?').get(ws,key) as {source_hash:string}|undefined;
      if(source && source.source_hash !== digest(d)) throw new Error('DECISION_CONFLICT');
      if(!source && before && digest(before)!==digest(d))throw new Error('DECISION_CONFLICT');
      continue;
    }
    const platform=platforms[d.snapshotPlatform];if(PLATFORM_INFO[platform].currency!==d.snapshotCurrency)continue;
    const item=state.items.find(i=>i.itemId===p.id)!, row=reviews.find(r=>r.itemId===p.id)!;
    const keep=keepSideOf(item,row,90,[],today);
    // The decision owns its cost inputs. Current garment settings and browser dates
    // cannot establish what the owner checked when an older decision was saved.
    const fees=d.feeSnapshot;
    const matchingFees=fees && platforms[fees.platform]===platform;
    const sell=sellSideOf(p.id,platform,d.snapshotPrice>0?d.snapshotPrice:null,[
      {label:'Platform fee',kind:'rate',value:matchingFees && fees.feeRateConfirmed===true ? fees.feeRatePct/100 : null},
      {label:'Shipping',kind:'fixed',value:matchingFees && fees.shippingConfirmed===true ? fees.shippingCost : null},
    ],evidence);
    const snapshot:DecisionSnapshot={schema:'closer.decision.1',decisionId:key,itemId:p.id,choice:d.choice==='keep'?'KEEP':'SELL_PREPARE',at:now.toISOString(),today,keep,sell,basis:basisOf(keep,sell),note:d.note??null,sourceRevision:'rail-ledger-bridge-v1'};
    db.prepare('INSERT INTO decisions (decision_id,workspace_id,item_id,at,body,client_key) VALUES (?,?,?,?,?,?)').run(key,ws,p.id,snapshot.at,JSON.stringify(snapshot),key);
    db.prepare('INSERT INTO rail_decision_sources VALUES (?,?,?,?)').run(ws,key,digest(d),JSON.stringify(d));
  }
}
