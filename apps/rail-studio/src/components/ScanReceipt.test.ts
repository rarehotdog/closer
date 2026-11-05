import test from 'node:test';
import assert from 'node:assert/strict';
import { cardsToPieces, receiptCards, modeLine, scanAttempted, samplePreviewOnly, cutoutSummary, type ScanOk } from './ScanPhotoModal.tsx';
import { validateWardrobe } from '../../server/wardrobeSchema.ts';
import { encodePng } from '../../server/closer/engine/png.ts';

const cutout = `data:image/png;base64,${encodePng({w:2,h:2,data:new Uint8Array(16).fill(255)}).toString('base64')}`;
function result(receiptId: string | undefined): ScanOk {
  return {ok:true,receiptId,kind:'closet',mode:'live',direction:'none',moreNotListed:false,samMode:'mask',notes:[],calls:[],w:2,h:2,
    cards:[{cardId:1,slot:'top',type:'tee',sparkColor:'white',maskColor:'white',formality:'low',pinned:false,offender:null,colorChoices:null,cutout,cutoutKind:'mask',box:{x1:0,y1:0,x2:1,y2:1}}]};
}

test('tile renumbering preserves each scan receipt and original provider card identity', () => {
  const first = receiptCards(result('receipt-original'));
  const tile = receiptCards(result('receipt-tile')).map(card => ({...card,cardId:8}));
  const pieces = cardsToPieces([...first,...tile],{},'live',[],1234);
  assert.deepEqual(pieces.map(p => [p.scanReceiptId,p.scanCardId]), [['receipt-original','1'],['receipt-tile','1']]);
  assert.deepEqual(pieces.map(p => p.id), ['scan-1234-1','scan-1234-8']);
  assert.deepEqual(validateWardrobe(pieces),pieces);
  assert.ok(pieces.every(p => p.imageUrl === cutout && p.frontImageUrl === cutout));
});

test('a live answer without a bounded receipt is not available to hang', () => {
  assert.throws(() => receiptCards(result(undefined)), /scan receipt/);
  assert.throws(() => receiptCards(result('x'.repeat(129))), /scan receipt/);
  assert.throws(() => receiptCards(result('receipt/invalid')), /scan receipt/);
  assert.equal(receiptCards({...result(undefined),mode:'fake'}).length,1);
  assert.doesNotMatch(modeLine('live'), /\bLIVE\b/);
});

test('wardrobe schema preserves receipt pairs and rejects partial or non-live claims', () => {
  const [piece] = cardsToPieces(receiptCards(result('receipt-123')),{},'live',[],1234);
  assert.throws(() => validateWardrobe([{...piece,scanCardId:undefined}]));
  assert.throws(() => validateWardrobe([{...piece,scanReceiptId:'x'.repeat(129)}]));
  assert.throws(() => validateWardrobe([{...piece,scanCardId:'1/2'}]));
  assert.throws(() => validateWardrobe([{...piece,scanMode:undefined}]));
  const [fake] = cardsToPieces(receiptCards(result('receipt-123')),{},'fake',[],1234);
  assert.equal(fake.scanReceiptId,undefined);
  assert.equal(fake.scanCardId,undefined);
});

test('internal failures without call evidence stay unknown, while actual attempts take priority', () => {
  assert.equal(scanAttempted({ok:false,code:'INTERNAL',detail:'failed',mode:'live'}),null);
  assert.equal(scanAttempted({ok:false,code:'INTERNAL',detail:'failed',mode:'live',calls:[]}),null);
  assert.equal(scanAttempted({ok:false,code:'SESSION_REQUIRED',detail:'sign in',mode:'live'}),false);
  assert.equal(scanAttempted({ok:false,code:'CALL_CAP_REACHED',detail:'budget',mode:'live',calls:[{model:'sam-3.1',http:503,latencyMs:10,source:'live'}]}),true);
  assert.equal(scanAttempted({ok:false,code:'NETWORK',detail:'timed out',mode:'live'}),null);
});

test('private sample selection is preview-only before scan and before hang', () => {
  assert.equal(samplePreviewOnly(true,'account-a'),true);
  assert.equal(samplePreviewOnly(false,'account-a'),false);
  assert.equal(samplePreviewOnly(true,null),false);
});

test('multipart cut-out summary reports all retained cards including mixed crop fallback', () => {
  assert.equal(cutoutSummary([{cutoutKind:'mask'},{cutoutKind:'box_crop'},{cutoutKind:'mask'}]),'2 SAM masks · 1 box crop');
  assert.equal(cutoutSummary([{cutoutKind:'mask'}]),'1 SAM mask');
  assert.equal(cutoutSummary([{cutoutKind:'box_crop'}]),'1 box crop (no masks)');
  assert.equal(cutoutSummary([]),'No garment cut-outs');
});
