import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE, defaultCardSelection, cardsToPieces, receiptCards, modeLine, scanAttempted, samplePreviewOnly, cutoutSummary, type ScanOk } from './ScanPhotoModal.tsx';
import { validateWardrobe } from '../../server/wardrobeSchema.ts';
import { encodePng } from '../../server/closer/engine/png.ts';
import { GARMENT_TYPES } from '../../../../shared/wardrobe.ts';

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

test('scanned trousers and footwear keep their actual cutout and receipt in the new fixtures', () => {
  for (const [type, slot, silhouette, category] of [
    ['jeans', 'bottom', 'trousers', 'trousers'],
    ['sneakers', 'shoes', 'sneaker-box', 'footwear'],
    ['boots', 'shoes', 'sneaker-box', 'footwear'],
    ...Object.entries(GARMENT_TYPES).filter(([, slot]) => slot === 'shoes').map(([type]) => [type, 'shoes', 'sneaker-box', 'footwear']),
  ]) {
    const scan = result('receipt-fixtures');
    scan.cards[0] = { ...scan.cards[0], type, slot };
    const [piece] = cardsToPieces(receiptCards(scan), {}, 'live', [], 1234);
    assert.equal(piece.category, category);
    assert.equal(piece.silhouette, silhouette);
    assert.equal(piece.imageUrl, cutout);
    assert.equal(piece.scanReceiptId, 'receipt-fixtures');
    assert.deepEqual(validateWardrobe([piece]), [piece]);
  }
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


test('every canonical garment is selected for display and keeps its receipt through wardrobe conversion', () => {
  const scan = result('receipt-all-types');
  const template = scan.cards[0];
  scan.cards = Object.entries(GARMENT_TYPES).map(([type, slot], index) => ({
    ...template, cardId: index + 1, type, slot,
  }));
  const cards = receiptCards(scan);
  const selected = defaultCardSelection(cards);
  const pieces = cardsToPieces(cards.filter(card => selected[card.cardId]), {}, 'live', [], 1234);
  assert.equal(pieces.length, Object.keys(GARMENT_TYPES).length);
  for (const [index, card] of cards.entries()) {
    assert.ok(Object.hasOwn(SHAPE, card.type), `${card.type} needs an explicit fixture mapping`);
    assert.equal(selected[card.cardId], true, `${card.type} must be available by default`);
    assert.equal(pieces[index].scanCardId, String(card.cardId));
    assert.equal(pieces[index].scanReceiptId, 'receipt-all-types');
    assert.equal(pieces[index].imageUrl, cutout);
    if (card.slot === 'shoes') {
      assert.equal(pieces[index].silhouette, 'sneaker-box');
      assert.equal(pieces[index].category, 'footwear');
    }
    if (card.type === 'hoodie') {
      assert.equal(pieces[index].silhouette, 'hoodie');
      assert.equal(pieces[index].category, 'hoodie');
    }
  }
  assert.deepEqual(validateWardrobe(pieces), pieces);
});

test('new tile footwear starts selected without restoring previously deselected pieces', () => {
  const first = receiptCards(result('receipt-first'));
  const scan = result('receipt-shoes');
  scan.cards[0] = {...scan.cards[0], type: 'sneakers', slot: 'shoes'};
  const added = receiptCards(scan).map(card => ({...card, cardId: 8}));
  const selection: Record<number, boolean> = {...defaultCardSelection(first), 1: false, ...defaultCardSelection(added)};
  const cards = [...first, ...added];
  const pieces = cardsToPieces(cards.filter(card => selection[card.cardId]), {}, 'live', [], 1234);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].category, 'footwear');
  assert.equal(pieces[0].scanReceiptId, 'receipt-shoes');
  assert.equal(pieces[0].scanCardId, '1');
  selection[8] = false;
  assert.equal(cards.filter(card => selection[card.cardId]).length, 0);
});
