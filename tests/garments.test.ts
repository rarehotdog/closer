// Procedural garments for the 3D closet (web/public/garments.js) built under Node with the real three.js:
// every type at both qualities is a Group with finite positions, stays inside its triangle budget, has the
// stated size (hook to hem for hanging pieces, length for a pair of shoes) within 25%, hangs below the hook
// or stands on the floor, and disposes cleanly. No canvas here, so the module skips its textures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error three.js ships no type declarations in this repository
import * as THREE from 'three';
// @ts-expect-error plain browser module without type declarations; the same file the 3D closet imports
import { buildGarment, GARMENT_TYPES_3D, disposeGarmentCache } from '../web/public/garments.js';

const SHOES = new Set(['derby', 'sneakers', 'running_shoes', 'loafers']);
const BOTTOMS = new Set(['trousers', 'jeans', 'chinos', 'joggers', 'skirt', 'shorts']);
const HOOK = 0.09; // hook top to the garment's shoulder line on the wooden hanger
/** Stated scale: tops by shoulder-to-hem length plus the hook, bottoms hook to hem, shoes by length. */
const EXPECTED: Record<string, number> = {
  jacket: 0.74 + HOOK, coat: 1.05 + HOOK, dress_shirt: 0.78 + HOOK, tee: 0.7 + HOOK, knit: 0.66 + HOOK,
  track_jacket: 0.68 + HOOK, blouse: 0.66 + HOOK, training_top: 0.64 + HOOK,
  trousers: 1.02, jeans: 1.02, chinos: 1.02, joggers: 1.02, skirt: 0.62, shorts: 0.48,
  derby: 0.28, sneakers: 0.28, running_shoes: 0.28, loafers: 0.28,
};
const BUDGET = { high: { hang: 9000, shoes: 7000 }, low: { hang: 3500, shoes: 3000 } };

test('GA-01 the 18 wardrobe types are all buildable', () => {
  assert.equal(GARMENT_TYPES_3D.length, 18);
  assert.deepEqual([...GARMENT_TYPES_3D].sort(), Object.keys(EXPECTED).sort());
});

for (const quality of ['high', 'low'] as const) {
  test(`GA-02 every type at ${quality}: group, finite positions, budget, scale, placement, dispose`, () => {
    for (const type of GARMENT_TYPES_3D as string[]) {
      const g = buildGarment(THREE, { type, rgb: [120, 110, 100], seed: 7, quality });
      assert.ok(g.object instanceof THREE.Group, `${type}: object is a Group`);
      let meshes = 0;
      g.object.traverse((o: { isMesh?: boolean; geometry?: { attributes: { position: { array: ArrayLike<number> } } } }) => {
        if (!o.isMesh || !o.geometry) return;
        meshes++;
        const a = o.geometry.attributes.position.array;
        for (let i = 0; i < a.length; i++) assert.ok(Number.isFinite(a[i]), `${type}: finite position`);
      });
      assert.ok(meshes > 0, `${type}: has meshes`);
      const shoe = SHOES.has(type);
      const limit = shoe ? BUDGET[quality].shoes : BUDGET[quality].hang;
      assert.ok(g.triangles > 0 && g.triangles <= limit, `${type} ${quality}: ${g.triangles} triangles (limit ${limit})`);
      g.object.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g.object);
      const size = new THREE.Vector3();
      box.getSize(size);
      const measured = shoe ? size.z : size.y;
      const want = EXPECTED[type];
      assert.ok(Math.abs(measured - want) <= want * 0.25, `${type} ${quality}: ${measured.toFixed(3)} m vs ${want} m`);
      assert.ok(Math.abs(g.size.h - size.y) < 1e-6 && Math.abs(g.size.w - size.x) < 1e-6, `${type}: size matches the bounding box`);
      if (shoe) {
        assert.ok(box.min.y >= -0.001, `${type}: stands on the floor (min y ${box.min.y})`);
        assert.ok(size.x > 0.15 && size.x < 0.35, `${type}: a pair side by side (${size.x.toFixed(3)} m wide)`);
      } else {
        assert.ok(box.max.y <= 0, `${type}: hangs below the hook (max y ${box.max.y})`);
        const minW = BOTTOMS.has(type) ? 0.3 : 0.44 * 0.9;
        assert.ok(size.x >= minW && size.x <= 0.8, `${type}: ${size.x.toFixed(3)} m wide`);
      }
      assert.doesNotThrow(() => g.dispose(), `${type}: dispose`);
    }
  });
}

test('GA-03 the same seed gives the same garment; another seed changes the drape', () => {
  const pos = (seed: number) => {
    const g = buildGarment(THREE, { type: 'tee', rgb: [244, 243, 238], seed, quality: 'low' });
    const out: number[] = [];
    g.object.traverse((o: { isMesh?: boolean; geometry?: { attributes: { position: { array: ArrayLike<number> } } } }) => { if (o.isMesh && o.geometry) out.push(...Array.from(o.geometry.attributes.position.array)); });
    g.dispose();
    return out;
  };
  assert.deepEqual(pos(3), pos(3));
  assert.notDeepEqual(pos(3), pos(4));
  assert.doesNotThrow(() => disposeGarmentCache());
});

test('GA-04 the reported triangle count is the geometry it holds, and hanger "none" leaves the hanger out', () => {
  const count = (o: { traverse: (f: (x: { isMesh?: boolean; geometry?: { index: { count: number } | null; attributes: { position: { count: number } } } }) => void) => void }) => {
    let n = 0;
    o.traverse((x) => { if (x.isMesh && x.geometry) n += (x.geometry.index ? x.geometry.index.count : x.geometry.attributes.position.count) / 3; });
    return n;
  };
  for (const type of GARMENT_TYPES_3D as string[]) {
    const g = buildGarment(THREE, { type, rgb: [30, 40, 82], seed: 1, quality: 'high' });
    assert.equal(g.triangles, count(g.object), `${type}: triangles reported = triangles held`);
    if (!SHOES.has(type)) {
      const bare = buildGarment(THREE, { type, rgb: [30, 40, 82], seed: 1, quality: 'high', hanger: 'none' });
      assert.ok(bare.triangles < g.triangles, `${type}: without its hanger it holds fewer triangles (${bare.triangles} < ${g.triangles})`);
      bare.dispose();
    }
    g.dispose();
  }
});
