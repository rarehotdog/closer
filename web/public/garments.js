// TEMPORARY development stub for the rail scene (replaced by the procedural garment library).
export const GARMENT_TYPES_3D = ['jacket', 'coat', 'dress_shirt', 'knit', 'tee', 'track_jacket', 'blouse', 'training_top', 'trousers', 'jeans', 'chinos', 'joggers', 'skirt', 'shorts', 'derby', 'sneakers', 'running_shoes', 'loafers'];
const SHOES = new Set(['derby', 'sneakers', 'running_shoes', 'loafers']);
const BOTTOMS = new Set(['trousers', 'jeans', 'chinos', 'joggers', 'skirt', 'shorts']);
const LEN = { jacket: 0.74, coat: 1.05, dress_shirt: 0.78, knit: 0.66, tee: 0.7, track_jacket: 0.68, blouse: 0.66, training_top: 0.64, trousers: 1.02, jeans: 1.02, chinos: 1.02, joggers: 1.0, skirt: 0.62, shorts: 0.48 };

export function buildGarment(THREE, spec) {
  const group = new THREE.Group();
  const made = [];
  const keep = (x) => (made.push(x), x);
  const color = new THREE.Color(`rgb(${spec.rgb.join(',')})`);
  const cloth = keep(new THREE.MeshPhysicalMaterial({ color, roughness: 0.9, sheen: 1, sheenRoughness: 0.6, sheenColor: color.clone().lerp(new THREE.Color(1, 1, 1), 0.3) }));
  if (SHOES.has(spec.type)) {
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(keep(new THREE.BoxGeometry(0.1, 0.09, 0.28)), cloth);
      m.position.set(s * 0.065, 0.045, 0);
      group.add(m);
    }
    return { object: group, size: { w: 0.23, h: 0.09, d: 0.28 }, triangles: 24, dispose: () => made.forEach((x) => x.dispose()) };
  }
  const h = LEN[spec.type] || 0.7;
  const bottom = BOTTOMS.has(spec.type);
  const w = bottom ? 0.38 : 0.46;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2 + (bottom ? 0.02 : 0.03), -h);
  shape.lineTo(-w / 2 - (bottom ? 0.02 : 0.03), -h);
  shape.closePath();
  const body = new THREE.Mesh(keep(new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 4 })), cloth);
  body.position.set(0, -0.11, -0.03);
  group.add(body);
  const wood = keep(new THREE.MeshStandardMaterial({ color: 0xc9a77c, roughness: 0.55 }));
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.2 }));
  const bar = new THREE.Mesh(keep(new THREE.BoxGeometry(0.44, 0.02, 0.02)), wood);
  bar.position.set(0, -0.1, 0);
  group.add(bar);
  const hook = new THREE.Mesh(keep(new THREE.TorusGeometry(0.025, 0.003, 6, 16, Math.PI * 1.2)), metal);
  hook.position.set(0, -0.025, 0);
  group.add(hook);
  return { object: group, size: { w, h: h + 0.11, d: 0.14 }, triangles: 2000, dispose: () => made.forEach((x) => x.dispose()) };
}

export function disposeGarmentCache() {}
