// Procedural garments for the 3D closet. Plain ES module: the three.js namespace is passed in (nothing is
// imported), so the same file also runs under Node for tests. Every piece is drawn in code: fabric shells
// lofted from rings with seeded drape, fabric normal maps painted on a canvas once per fabric and shared,
// a wooden or clip hanger, shoes as a pair. No external files, no timers, no per-frame work.
// Hanging pieces: origin = top of the hook, garment along -y, front +z. Shoes: pair on y = 0, toes +z.

export const GARMENT_TYPES_3D = ['jacket', 'coat', 'dress_shirt', 'knit', 'tee', 'track_jacket', 'blouse', 'training_top',
  'trousers', 'jeans', 'chinos', 'joggers', 'skirt', 'shorts', 'derby', 'sneakers', 'running_shoes', 'loafers'];

const CACHE = { three: null, tex: new Map(), mat: new Map() };

export function disposeGarmentCache() {
  for (const t of CACHE.tex.values()) if (t) t.dispose();
  for (const m of CACHE.mat.values()) m.dispose();
  CACHE.tex.clear();
  CACHE.mat.clear();
  CACHE.three = null;
}

// ---------- small maths ----------
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sgn = (v) => (v < 0 ? -1 : 1);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
/** Smooth seeded 2D value noise in [-1, 1]. */
function noise2(R) {
  const N = 32;
  const g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = R() * 2 - 1;
  return (x, y) => {
    const xi = Math.floor(x); const yi = Math.floor(y);
    let fx = x - xi; let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const i0 = ((xi % N) + N) % N; const j0 = ((yi % N) + N) % N; const i1 = (i0 + 1) % N; const j1 = (j0 + 1) % N;
    const a = g[j0 * N + i0]; const b = g[j0 * N + i1]; const c = g[j1 * N + i0]; const d = g[j1 * N + i1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
/** Cubic interpolation through [[d, v], ...] keys (flat ends). */
function prof(p, d) {
  const n = p.length;
  if (d <= p[0][0]) return p[0][1];
  if (d >= p[n - 1][0]) return p[n - 1][1];
  let k = 1;
  while (p[k][0] < d) k++;
  const x0 = p[k - 1][0]; const h = p[k][0] - x0; const t = (d - x0) / h;
  const m = (i) => (i <= 0 || i >= n - 1 ? 0 : (p[i + 1][1] - p[i - 1][1]) / (p[i + 1][0] - p[i - 1][0]));
  const t2 = t * t; const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p[k - 1][1] + (t3 - 2 * t2 + t) * m(k - 1) * h + (-2 * t3 + 3 * t2) * p[k][1] + (t3 - t2) * m(k) * h;
}

// ---------- geometry helpers ----------
/** Indexed grid: fn(i, j, o) writes o = [x, y, z, shade]. uv in metres (arc length). flip reverses the winding. */
function grid(T, nu, nv, fn, flip = false, uvk = 1) {
  const W = nu + 1; const n = W * (nv + 1);
  const pos = new Float32Array(n * 3); const col = new Float32Array(n * 3); const uv = new Float32Array(n * 2);
  const o = [0, 0, 0, 1];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      o[3] = 1;
      fn(i, j, o);
      const k = j * W + i;
      pos[k * 3] = o[0]; pos[k * 3 + 1] = o[1]; pos[k * 3 + 2] = o[2];
      col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = o[3];
    }
  }
  const dist = (a, b) => { const x = pos[a * 3] - pos[b * 3]; const y = pos[a * 3 + 1] - pos[b * 3 + 1]; const z = pos[a * 3 + 2] - pos[b * 3 + 2]; return Math.sqrt(x * x + y * y + z * z); };
  for (let j = 0; j <= nv; j++) { let s = 0; for (let i = 0; i <= nu; i++) { const k = j * W + i; if (i) s += dist(k, k - 1); uv[k * 2] = s * uvk; } }
  for (let i = 0; i <= nu; i++) { let s = 0; for (let j = 0; j <= nv; j++) { const k = j * W + i; if (j) s += dist(k, k - W); uv[k * 2 + 1] = s * uvk; } }
  const idx = new (n > 65535 ? Uint32Array : Uint16Array)(nu * nv * 6);
  let p = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * W + i; const b = a + 1; const c = a + W; const d = c + 1;
      if (flip) { idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d; } else { idx[p++] = a; idx[p++] = b; idx[p++] = c; idx[p++] = b; idx[p++] = d; idx[p++] = c; }
    }
  }
  const nor = new Float32Array(n * 3); // area-weighted vertex normals, straight on the typed arrays
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3; const b = idx[f + 1] * 3; const c = idx[f + 2] * 3;
    const ux = pos[b] - pos[a]; const uy = pos[b + 1] - pos[a + 1]; const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a]; const vy = pos[c + 1] - pos[a + 1]; const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz; nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz; nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
  }
  for (let k = 0; k < nor.length; k += 3) { const l = 1 / (Math.sqrt(nor[k] * nor[k] + nor[k + 1] * nor[k + 1] + nor[k + 2] * nor[k + 2]) || 1); nor[k] *= l; nor[k + 1] *= l; nor[k + 2] *= l; }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.BufferAttribute(nor, 3));
  g.setAttribute('uv', new T.BufferAttribute(uv, 2));
  g.setAttribute('color', new T.BufferAttribute(col, 3));
  g.setIndex(new T.BufferAttribute(idx, 1));
  const edge = [];
  for (let j = 0; j <= nv; j++) { edge.push(j * W, j * W + nu); if (j === 0 || j === nv) for (let i = 1; i < nu; i++) edge.push(j * W + i); }
  weld(g, edge);
  return g;
}
/** Averages normals of coincident vertices among `list` (seams and collapsed ends of lofted shells). */
function weld(g, list) {
  const p = g.attributes.position.array; const nr = g.attributes.normal.array; const m = new Map();
  for (const i of list) {
    const k = (Math.round(p[i * 3] * 2e3) * 8192 + Math.round(p[i * 3 + 1] * 2e3)) * 8192 + Math.round(p[i * 3 + 2] * 2e3);
    const l = m.get(k);
    if (l) l.push(i); else m.set(k, [i]);
  }
  for (const l of m.values()) {
    if (l.length < 2) continue;
    let x = 0; let y = 0; let z = 0;
    for (const i of l) { x += nr[i * 3]; y += nr[i * 3 + 1]; z += nr[i * 3 + 2]; }
    const s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    for (const i of l) { nr[i * 3] = x * s; nr[i * 3 + 1] = y * s; nr[i * 3 + 2] = z * s; }
  }
}
/** Tube along points with an elliptical, tapering section: r(t) -> [rx, rz]; ref = axis the section's second radius leans to. */
function tube(T, pts, nl, nr, r, opts = {}) {
  const curve = new T.CatmullRomCurve3(pts, !!opts.closed, 'centripetal');
  curve.arcLengthDivisions = 48;
  const ref = opts.ref || new T.Vector3(0, 0, 1);
  const t = new T.Vector3();
  const F = [];
  for (let j = 0; j <= nl; j++) { // one frame per ring
    const u = j / nl; const c = curve.getPointAt(u); curve.getTangentAt(u, t);
    const b = new T.Vector3().crossVectors(t, ref);
    if (b.lengthSq() < 1e-8) b.set(1, 0, 0);
    b.normalize();
    F.push([c, b, new T.Vector3().crossVectors(b, t).normalize()]);
  }
  const nz = opts.noise;
  return grid(T, nr, nl, (i, j, o) => {
    const u = j / nl; const [c, b, nn] = F[j];
    const a = (i / nr) * TAU;
    const [rx, rz, sh] = r(u, a);
    let k = 1;
    if (nz) k += nz(i / nr, u);
    o[0] = c.x + (b.x * Math.cos(a) * rx + nn.x * Math.sin(a) * rz) * k;
    o[1] = c.y + (b.y * Math.cos(a) * rx + nn.y * Math.sin(a) * rz) * k;
    o[2] = c.z + (b.z * Math.cos(a) * rx + nn.z * Math.sin(a) * rz) * k;
    o[3] = sh === undefined ? 1 : sh;
  }, !opts.outward);
}
/** Flat shape laid on a surface: z = zAt(x, y) + lift, with side walls `th` deep. */
function patch(T, pts, zAt, th = 0.003, shade = 1) {
  const v2 = pts.map(([x, y]) => new T.Vector2(x, y));
  if (T.ShapeUtils.isClockWise(v2)) v2.reverse();
  const top = new T.ShapeGeometry(new T.Shape(v2), 1);
  const p = top.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, zAt(p.getX(i), p.getY(i)));
  const n = v2.length; const wp = []; const wu = []; const wi = [];
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const q = v2[i % n];
    if (i) s += q.distanceTo(v2[i - 1]);
    const z = zAt(q.x, q.y);
    wp.push(q.x, q.y, z, q.x, q.y, z - th);
    wu.push(s, 0, s, th);
    if (i < n) { const a = i * 2; wi.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  }
  const wall = new T.BufferGeometry();
  wall.setAttribute('position', new T.Float32BufferAttribute(wp, 3));
  wall.setAttribute('uv', new T.Float32BufferAttribute(wu, 2));
  wall.setIndex(wi);
  const g = merge(T, [top, wall], [shade, shade * 0.72]);
  g.computeVertexNormals();
  return g;
}
/** Merges geometries (indexed or not) into one indexed geometry with position, normal, uv, color. */
function merge(T, geos, shades) {
  let nv = 0; let ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3); const nor = new Float32Array(nv * 3); const uv = new Float32Array(nv * 2); const col = new Float32Array(nv * 3);
  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
  let vo = 0; let io = 0;
  geos.forEach((g, gi) => {
    const n = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    if (g.attributes.color) col.set(g.attributes.color.array, vo * 3); else col.fill(shades ? shades[gi] : 1, vo * 3, (vo + n) * 3);
    if (g.index) { const a = g.index.array; for (let k = 0; k < a.length; k++) idx[io + k] = a[k] + vo; io += a.length; } else { for (let k = 0; k < n; k++) idx[io + k] = vo + k; io += n; }
    vo += n;
    g.dispose();
  });
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.BufferAttribute(nor, 3));
  out.setAttribute('uv', new T.BufferAttribute(uv, 2));
  out.setAttribute('color', new T.BufferAttribute(col, 3));
  out.setIndex(new T.BufferAttribute(idx, 1));
  return out;
}
const scaleUv = (g, k) => { const a = g.attributes.uv.array; for (let i = 0; i < a.length; i++) a[i] *= k; return g; };
const shadeAll = (g, k) => { const c = g.attributes.color; if (c) for (let i = 0; i < c.array.length; i++) c.array[i] *= k; return g; };
function disc(T, r, h, seg, x, y, z) { const g = new T.CylinderGeometry(r, r * 0.92, h, seg); g.rotateX(Math.PI / 2); g.translate(x, y, z + h / 2); return g; }

// ---------- textures (canvas, cached per fabric) ----------
const FAB = {
  wool: { rough: 0.88, sheen: 0.8, sr: 0.55, ns: 0.5, tile: 0.03, map: 'wool' },
  poplin: { rough: 0.74, sheen: 0.5, sr: 0.45, ns: 0.35, tile: 0.012, map: 'poplin' },
  rib: { rough: 0.93, sheen: 0.9, sr: 0.6, ns: 1.1, tile: 0.06, map: 'rib' },
  jersey: { rough: 0.9, sheen: 0.7, sr: 0.55, ns: 0.45, tile: 0.02, map: 'jersey' },
  fleece: { rough: 0.96, sheen: 1, sr: 0.75, ns: 0.6, tile: 0.05, map: 'fleece' },
  tricot: { rough: 0.6, sheen: 0.5, sr: 0.35, ns: 0.3, tile: 0.015, map: 'jersey' },
  silk: { rough: 0.48, sheen: 1, sr: 0.3, ns: 0.15, tile: 0.012, map: 'poplin' },
  twill: { rough: 0.86, sheen: 0.6, sr: 0.5, ns: 0.55, tile: 0.025, map: 'twill' },
  denim: { rough: 0.9, sheen: 0.45, sr: 0.6, ns: 0.9, tile: 0.03, map: 'denim', albedo: 'denimc' },
  mesh: { rough: 0.82, sheen: 0.5, sr: 0.5, ns: 0.9, tile: 0.012, map: 'mesh' },
  leather: { rough: 0.36, ns: 0.25, tile: 0.02, map: 'leather' },
};
function heightOf(key, S, R) {
  const h = new Float32Array(S * S);
  const n1 = noise2(R); const n2 = noise2(R);
  const P = (fx, fy, f) => n1(((fx * f) % f + f) % f, ((fy * f) % f + f) % f); // periodic-ish within the tile
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S; const v = y / S; let H = 0;
      if (key === 'rib' || key === 'jersey') {
        const nRib = key === 'rib' ? 8 : 12; const nRow = key === 'rib' ? 12 : 18;
        const r = (u * nRib) % 1; const col = 1 - Math.pow(Math.abs(2 * r - 1), key === 'rib' ? 1.6 : 2.4);
        H = col * (0.7 + 0.3 * Math.cos(TAU * (v * nRow + Math.abs(r - 0.5) * 0.9))) + 0.06 * n2(u * 32, v * 32);
      } else if (key === 'twill' || key === 'denim') {
        const f = key === 'denim' ? 16 : 20;
        H = 0.5 + 0.5 * Math.sin(TAU * (u * f + v * f * 2) / 2) + 0.12 * Math.sin(TAU * u * f * 2) + (key === 'denim' ? 0.25 * P(u, 0, 8) : 0) + 0.05 * n2(u * 32, v * 32);
      } else if (key === 'wool') {
        H = 0.35 * Math.sin(TAU * (u * 24 + v * 24)) + 0.5 * n2(u * 32, v * 32) + 0.3 * P(u, v, 8);
      } else if (key === 'poplin') {
        H = Math.sin(TAU * u * 24) * 0.5 + Math.sin(TAU * v * 32) * 0.35 + 0.15 * n2(u * 32, v * 32);
      } else if (key === 'fleece') {
        H = 0.6 * P(u, v, 8) + 0.4 * n2(u * 32, v * 32);
      } else if (key === 'mesh') {
        const a = Math.cos(TAU * u * 8) + Math.cos(TAU * (u * 4 + v * 8)) + Math.cos(TAU * (u * 4 - v * 8));
        H = sstep(-0.6, 1.2, a) + 0.08 * n2(u * 32, v * 32);
      } else if (key === 'leather') {
        H = Math.abs(n1(u * 16, v * 16)) * 0.6 + Math.abs(n2(u * 32, v * 32)) * 0.4;
      }
      h[y * S + x] = H;
    }
  }
  return h;
}
function canvasTex(T, S, paint) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  paint(img.data);
  g.putImageData(img, 0, 0);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function texture(T, key, tile) {
  const id = `${key}@${tile}`;
  if (CACHE.tex.has(id)) return CACHE.tex.get(id);
  let t = null;
  if (typeof document !== 'undefined') {
    try {
      const S = 64; const R = rng(hash(key));
      if (key === 'denimc' || key === 'woodc') {
        const n1 = noise2(R); const n2 = noise2(R);
        t = canvasTex(T, S, (d) => {
          for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            const u = x / S; const v = y / S; const i = (y * S + x) * 4; let r; let g; let b;
            if (key === 'denimc') {
              const tw = 0.5 + 0.5 * Math.sin(TAU * (u * 16 + v * 32) / 2);
              const slub = 0.5 + 0.5 * n1(((u * 8) % 8), v * 2);
              const k = 0.8 + 0.2 * tw * (0.6 + 0.4 * slub) + 0.04 * n2(u * 32, v * 32);
              r = g = b = k * 255;
            } else {
              const ring = 0.5 + 0.5 * Math.sin(TAU * (v * 6 + n1(u * 2, v * 4) * 0.9));
              const k = 0.88 + 0.1 * ring + 0.03 * n2(u * 32, v * 8);
              r = k * 255; g = k * 250; b = k * 244;
            }
            d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
          }
        });
        t.colorSpace = T.SRGBColorSpace;
      } else {
        const h = heightOf(key, S, R);
        const k = 2.2;
        t = canvasTex(T, S, (d) => {
          for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)];
            const dy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
            const nx = -dx * k; const ny = dy * k; const l = Math.hypot(nx, ny, 1); const i = (y * S + x) * 4;
            d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
          }
        });
      }
      t.repeat.set(1 / tile, 1 / tile);
    } catch { t = null; }
  }
  CACHE.tex.set(id, t);
  return t;
}

// ---------- materials ----------
// Inside faces (seen through necklines, cuffs, shoe openings) render darker: a cheap stand-in for occlusion.
function innerShade(sh) { sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n\tif (!gl_FrontFacing) diffuseColor.rgb *= 0.36;'); }
const innerKey = () => 'closer-garment-inner';
const srgb = (T, rgb, k = 1) => new T.Color().setRGB(clamp(rgb[0] * k / 255, 0, 1), clamp(rgb[1] * k / 255, 0, 1), clamp(rgb[2] * k / 255, 0, 1), T.SRGBColorSpace);
function fabricMat(T, rgb, key) {
  const f = FAB[key];
  const base = srgb(T, rgb);
  const lum = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
  // Dark cloth gets a lighter, same-hue sheen so navy reads navy; light cloth a soft white one.
  const sheen = lum < 0.2 ? base.clone().lerp(new T.Color(1, 1, 1), 0.18).multiplyScalar(1.6) : base.clone().lerp(new T.Color(1, 1, 1), 0.5).multiplyScalar(0.55);
  const m = new T.MeshPhysicalMaterial({ color: base, roughness: f.rough, metalness: 0, sheen: f.sheen, sheenRoughness: f.sr, sheenColor: sheen, vertexColors: true, side: T.DoubleSide });
  const n = texture(T, f.map, f.tile);
  if (n) { m.normalMap = n; m.normalScale.set(f.ns, f.ns); }
  if (f.albedo) { const a = texture(T, f.albedo, f.tile); if (a) m.map = a; }
  m.onBeforeCompile = innerShade;
  m.customProgramCacheKey = innerKey;
  return m;
}
function leatherMat(T, rgb, rough = 0.36, coat = 0.5) {
  const m = new T.MeshPhysicalMaterial({ color: srgb(T, rgb), roughness: rough, metalness: 0, clearcoat: coat, clearcoatRoughness: 0.28, vertexColors: true, side: T.DoubleSide });
  const n = texture(T, 'leather', 0.02);
  if (n) { m.normalMap = n; m.normalScale.set(0.25, 0.25); }
  m.onBeforeCompile = innerShade;
  m.customProgramCacheKey = innerKey;
  return m;
}
/** Shared materials (hangers, trims, soles): cached until disposeGarmentCache(). */
function shared(T, key) {
  if (CACHE.mat.has(key)) return CACHE.mat.get(key);
  const P = (o) => new T.MeshPhysicalMaterial({ vertexColors: true, ...o });
  const c = (rgb) => srgb(T, rgb);
  const m = {
    wood: () => { const w = P({ color: c([224, 184, 132]), roughness: 0.38, clearcoat: 0.55, clearcoatRoughness: 0.18 }); const t = texture(T, 'woodc', 0.12); if (t) w.map = t; return w; },
    chrome: () => P({ color: c([236, 236, 238]), metalness: 1, roughness: 0.13 }),
    clip: () => P({ color: c([210, 210, 214]), metalness: 1, roughness: 0.22 }),
    horn: () => P({ color: c([46, 32, 26]), roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    hornL: () => P({ color: c([120, 86, 58]), roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    pearl: () => P({ color: c([240, 238, 230]), roughness: 0.22, clearcoat: 0.7, clearcoatRoughness: 0.1 }),
    zip: () => P({ color: c([150, 150, 154]), metalness: 1, roughness: 0.3 }),
    stitch: () => P({ color: c([196, 142, 66]), roughness: 0.75, sheen: 0.6, sheenColor: c([230, 190, 120]) }),
    copper: () => P({ color: c([186, 122, 64]), metalness: 1, roughness: 0.35 }),
    rubberW: () => P({ color: c([240, 239, 234]), roughness: 0.62, side: T.DoubleSide }),
    rubberD: () => P({ color: c([34, 33, 32]), roughness: 0.7 }),
    soleL: () => P({ color: c([40, 30, 26]), roughness: 0.5, clearcoat: 0.3 }),
    stack: () => P({ color: c([96, 64, 42]), roughness: 0.55, clearcoat: 0.3 }),
    lining: () => P({ color: c([190, 168, 140]), roughness: 0.8 }),
    laceW: () => P({ color: c([246, 246, 244]), roughness: 0.85, sheen: 0.5, sheenColor: c([255, 255, 255]) }),
    laceB: () => P({ color: c([22, 22, 24]), roughness: 0.7, sheen: 0.5, sheenColor: c([90, 90, 96]) }),
  }[key]();
  CACHE.mat.set(key, m);
  return m;
}

// ---------- hangers ----------
const HY = -0.094; // top of the wooden bar at its centre
const woodTop = (x) => HY - 0.05 * Math.pow(Math.min(1, Math.abs(x) / 0.215), 1.6);
const gy = (x) => woodTop(x) + 0.007 - 2.5 * Math.max(0, Math.abs(x) - 0.205) ** 2; // garment shoulder line over the bar
function hook(T, q, base) {
  const R = 0.021; const w = 0.0028; const yc = -(R + w);
  const pts = [[base, 0], [-0.066, 0], [-0.05, -0.006], [-0.035, -0.016]];
  for (const a of [200, 160, 125, 90, 55, 20, -12, -38]) { const r = (a * Math.PI) / 180; pts.push([yc + R * Math.sin(r), R * Math.cos(r)]); }
  const g = new T.TubeGeometry(new T.CatmullRomCurve3(pts.map(([y, z]) => new T.Vector3(0, y, z)), false, 'centripetal'), q ? 32 : 16, w, q ? 6 : 5, false);
  const tip = new T.SphereGeometry(w * 1.25, q ? 8 : 5, q ? 6 : 4);
  const e = pts[pts.length - 1];
  tip.translate(0, e[0], e[1]);
  const nut = new T.CylinderGeometry(0.0055, 0.0065, 0.012, q ? 12 : 6);
  nut.translate(0, base + 0.004, 0);
  const out = merge(T, [g, tip, nut]);
  out.computeBoundingBox();
  out.translate(0, -out.boundingBox.max.y - 0.0003, 0);
  return out;
}
function woodHanger(T, q) {
  const n = q ? 28 : 12; const m = q ? 8 : 6;
  const body = grid(T, m, n, (i, j, o) => {
    const x = -0.215 + (0.43 * j) / n; const a = (i / m) * TAU;
    const hh = lerp(0.017, 0.012, Math.pow(Math.abs(x) / 0.215, 1.5)); const t = lerp(0.0075, 0.011, Math.abs(x) / 0.215);
    const yc = woodTop(x) - hh; const c = Math.cos(a); const s = Math.sin(a);
    o[0] = x + (Math.abs(x) > 0.205 ? sgn(x) * 0.003 * Math.max(0, c) : 0);
    o[1] = yc + sgn(s) * Math.pow(Math.abs(s), 0.6) * hh;
    o[2] = sgn(c) * Math.pow(Math.abs(c), 0.6) * t;
  }, true);
  const end = (s) => { const g = new T.SphereGeometry(1, q ? 10 : 6, q ? 6 : 4); g.scale(0.006, 0.009, 0.008); g.translate(s * 0.207, woodTop(0.207) - 0.011, 0); return g; };
  return { wood: merge(T, [body, end(1), end(-1)]), metal: hook(T, q, HY + 0.002) };
}
function clipHanger(T, q, waistY, xs, dz) {
  const yb = -0.098;
  const bar = new T.BoxGeometry(0.38, 0.026, 0.014, 1, 1, 1);
  bar.translate(0, yb, 0);
  const parts = [];
  for (const x of xs) {
    for (const s of [-1, 1]) { const jaw = new T.BoxGeometry(0.03, 0.04, 0.003); jaw.translate(x, waistY - 0.004, s * (dz + 0.003)); parts.push(jaw); }
    const spring = new T.CylinderGeometry(0.004, 0.004, 0.03, q ? 10 : 6); spring.rotateZ(Math.PI / 2); spring.translate(x, waistY + 0.022, 0); parts.push(spring);
    const arm = new T.BoxGeometry(0.006, yb - 0.013 - (waistY + 0.022), 0.006); arm.translate(x, (yb - 0.013 + waistY + 0.022) / 2, 0); parts.push(arm);
  }
  return { wood: merge(T, [bar]), metal: merge(T, [hook(T, q, yb + 0.012), ...parts]) };
}

// ---------- tops ----------
const TOPS = {
  jacket: { L: 0.74, fab: 'wool', n: 2.6, w: [[0, 0.222], [0.05, 0.24], [0.2, 0.256], [0.42, 0.24], [0.74, 0.258]], d: [[0, 0], [0.006, 0.03], [0.05, 0.056], [0.16, 0.07], [0.45, 0.066], [0.74, 0.056]], nw: 0.074, nf: 0.4, nb: 0.024, v: 1, fold: 0.005, cut: 0.06, sl: 'set', slen: 0.6, lapel: 1, btn: [0.4, 0.5], pockets: 0.53, btnMat: 'horn' },
  coat: { L: 1.05, fab: 'wool', n: 2.5, w: [[0, 0.226], [0.06, 0.248], [0.25, 0.264], [0.6, 0.272], [1.05, 0.31]], d: [[0, 0], [0.006, 0.035], [0.05, 0.06], [0.2, 0.078], [1.05, 0.07]], nw: 0.08, nf: 0.34, nb: 0.026, v: 1, fold: 0.01, sl: 'set', slen: 0.62, lapel: 1.18, btn: [0.34, 0.47, 0.6], pockets: 0.62, btnMat: 'horn' },
  dress_shirt: { L: 0.78, fab: 'poplin', n: 2, w: [[0, 0.212], [0.05, 0.236], [0.25, 0.248], [0.78, 0.254]], d: [[0, 0], [0.006, 0.016], [0.06, 0.03], [0.3, 0.034], [0.78, 0.028]], nw: 0.066, nf: 0.03, nb: 0.012, fold: 0.008, tail: 0.075, sl: 'cuff', slen: 0.62, collar: 'shirt', placket: 1, btnMat: 'pearl' },
  knit: { L: 0.66, fab: 'rib', n: 2, w: [[0, 0.205], [0.05, 0.228], [0.2, 0.242], [0.58, 0.24], [0.6, 0.222], [0.66, 0.218]], d: [[0, 0], [0.006, 0.018], [0.06, 0.036], [0.3, 0.04], [0.6, 0.036], [0.66, 0.03]], nw: 0.088, nf: 0.075, nb: 0.02, fold: 0.007, band: 0.06, sl: 'rib', slen: 0.6, neck: 0.013 },
  tee: { L: 0.7, fab: 'jersey', n: 2, w: [[0, 0.214], [0.05, 0.24], [0.2, 0.252], [0.7, 0.258]], d: [[0, 0], [0.006, 0.012], [0.06, 0.02], [0.7, 0.022]], nw: 0.078, nf: 0.072, nb: 0.018, fold: 0.009, sl: 'short', neck: 0.009 },
  track_jacket: { L: 0.68, fab: 'tricot', n: 2.2, w: [[0, 0.215], [0.05, 0.236], [0.2, 0.252], [0.6, 0.246], [0.62, 0.23], [0.68, 0.226]], d: [[0, 0], [0.006, 0.02], [0.06, 0.04], [0.3, 0.046], [0.62, 0.042], [0.68, 0.034]], nw: 0.07, nf: 0.03, nb: 0.012, fold: 0.007, band: 0.06, sl: 'rib', slen: 0.6, collar: 'stand', zip: 1 },
  blouse: { L: 0.66, fab: 'silk', n: 2, w: [[0, 0.205], [0.05, 0.23], [0.2, 0.25], [0.66, 0.288]], d: [[0, 0], [0.006, 0.015], [0.06, 0.026], [0.66, 0.032]], nw: 0.072, nf: 0.15, nb: 0.016, v: 1, fold: 0.013, tail: 0.03, sl: 'blouse', slen: 0.58, roll: 1, btn: [0.2, 0.27, 0.34], btnMat: 'pearl' },
  training_top: { L: 0.64, fab: 'jersey', n: 2, w: [[0, 0.205], [0.05, 0.226], [0.2, 0.24], [0.64, 0.244]], d: [[0, 0], [0.006, 0.016], [0.06, 0.03], [0.64, 0.03]], nw: 0.07, nf: 0.03, nb: 0.012, fold: 0.008, sl: 'long', slen: 0.6, collar: 'mock', zip: 0.2 },
};
const SLEEVES = {
  set: { r: [[0, 0.026, 0.02], [0.12, 0.052, 0.056], [0.5, 0.05, 0.054], [1, 0.044, 0.048]], x: [0.15, 0.214, 0.238, 0.25, 0.248], z: [0, 0.004, 0.012, 0.024, 0.036], fold: 0.0022 },
  cuff: { r: [[0, 0.024, 0.018], [0.12, 0.046, 0.05], [0.5, 0.043, 0.046], [0.87, 0.038, 0.04], [0.885, 0.043, 0.044], [1, 0.043, 0.044]], x: [0.15, 0.21, 0.232, 0.242, 0.24], z: [0, 0.004, 0.01, 0.02, 0.03], fold: 0.0025 },
  rib: { r: [[0, 0.024, 0.018], [0.12, 0.05, 0.052], [0.6, 0.048, 0.05], [0.88, 0.046, 0.048], [0.92, 0.034, 0.036], [1, 0.032, 0.034]], x: [0.15, 0.21, 0.234, 0.244, 0.24], z: [0, 0.004, 0.01, 0.02, 0.03], fold: 0.0025 },
  long: { r: [[0, 0.024, 0.018], [0.12, 0.046, 0.048], [0.9, 0.038, 0.04], [1, 0.036, 0.038]], x: [0.15, 0.208, 0.23, 0.24, 0.236], z: [0, 0.004, 0.01, 0.02, 0.03], fold: 0.0022 },
  blouse: { r: [[0, 0.024, 0.018], [0.12, 0.052, 0.054], [0.6, 0.06, 0.06], [0.86, 0.058, 0.058], [0.92, 0.032, 0.032], [1, 0.03, 0.03]], x: [0.15, 0.212, 0.244, 0.258, 0.254], z: [0, 0.004, 0.012, 0.024, 0.034], fold: 0.004 },
};
function buildTop(T, type, P, rgb, R, q, add) {
  const mat = fabricMat(T, rgb, P.fab);
  const nz = noise2(R);
  const ph = Array.from({ length: 8 }, () => R() * TAU);
  const W0 = P.w[0][1]; const yN = gy(0); const hem = yN - P.L; const yS = gy(W0);
  const topY = (x, front) => { const u = Math.abs(x) / P.nw; const b = u < 1 ? (P.v && front ? 1 - u : Math.pow(1 - u * u, 1.5)) : 0; return gy(x) - (front ? P.nf : P.nb) * b; };
  const hemY = (x, front) => hem + (P.tail || 0) * Math.pow(Math.min(1, Math.abs(x) / W0), 2.5) + (front && P.cut ? P.cut * Math.pow(Math.max(0, 1 - Math.abs(x) / 0.1), 1.5) : 0) + 0.004 * nz(x * 9, front ? 3 : 7);
  const Ls = yS - hem;
  const fold = (xn, dV, front) => {
    const A = P.fold * (0.25 + 0.75 * sstep(0.04, P.L * 0.8, dV));
    const o = front ? 0 : 4;
    const f = 0.45 * Math.sin(TAU * 1.3 * xn + ph[o] + dV * 2.1) + 0.3 * Math.sin(TAU * 2.4 * xn + ph[o + 1] - dV * 3.3) + 0.25 * Math.sin(TAU * 3.7 * xn + ph[o + 2] + dV * 1.3);
    return A * (0.65 * f + 0.55 * nz(xn * 2.6 + o * 5, dV * 5));
  };
  const surf = (x, y, front = true) => {
    const W = prof(P.w, clamp(yS - y, 0, P.L)); const sx = clamp(x / W, -1, 1);
    const sz = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(sx), P.n)), 1 / P.n);
    const dV = gy(x) - y;
    return (prof(P.d, dV) * sz + fold(sx, dV, front) * Math.pow(sz, 0.6)) * (front ? 1 : -1);
  };
  const nu = q ? 42 : 24; const nv = q ? 36 : 16;
  const rows = [0, 0.007 / Ls, 0.02 / Ls];
  for (let j = 3; j <= nv; j++) rows.push(lerp(0.04 / Ls, 1, (j - 3) / (nv - 3)));
  const Wr = rows.map((e) => prof(P.w, e * Ls));
  const C = [];
  for (let i = 0; i <= nu; i++) { // per column: section direction, neckline and hem heights
    const th = -Math.PI / 2 + (TAU * i) / nu; const c = Math.cos(th); const s = Math.sin(th);
    const sx = sgn(c) * Math.pow(Math.abs(c), 2 / P.n); const sz = sgn(s) * Math.pow(Math.abs(s), 2 / P.n);
    const front = s > 0; const xT = W0 * sx;
    C.push({ sx, sz, front, yT: topY(xT, front), yH: hemY(xT, front), sp: Math.pow(Math.abs(sz), 0.6), side: Math.pow(1 - Math.abs(sz), 3), s5: Math.pow(1 - Math.abs(sz), 5) });
  }
  const body = grid(T, nu, nv, (i, j, o) => {
    const { sx, sz, front, yT, yH, sp, side, s5 } = C[i]; const e = rows[j]; const W = Wr[j];
    const y = yT + (yH - yT) * e;
    const x0 = W * sx; const dV = gy(x0) - y; const D = prof(P.d, dV);
    const fd = fold(sx, dV, front) * sp;
    let nx = sx / W; let nzz = sz / Math.max(D, 0.004); const l = Math.sqrt(nx * nx + nzz * nzz) || 1; nx /= l; nzz /= l;
    o[0] = x0 + fd * nx + sgn(sx) * side * P.fold * 0.8 * nz(dV * 6 + (sx > 0 ? 3 : 11), 1.5);
    o[1] = y;
    o[2] = D * sz + fd * nzz;
    o[3] = (1 - 0.32 * clamp(-fd / (P.fold * 0.9), 0, 1)) * (1 - 0.3 * s5 * (e * Ls < (P.slen || 0.2) ? 1 : 0.4)) * (0.9 + 0.1 * sstep(0, 0.05, dV));
  });
  if (P.band) {
    const uv = body.attributes.uv.array; const p = body.attributes.position.array;
    for (let i = 0; i < p.length / 3; i++) if (p[i * 3 + 1] < hem + P.band) { uv[i * 2] *= 1.6; uv[i * 2 + 1] *= 1.6; }
  }
  add(mat, body);
  // sleeves
  const S = P.sl === 'short' ? null : SLEEVES[P.sl];
  for (const side of [-1, 1]) {
    let g;
    if (!S) {
      const pts = [[0.15, gy(0.15) - 0.03, 0], [0.214, gy(0.214) - 0.045, 0.002], [0.27, gy(0.214) - 0.115, 0.004], [0.304, gy(0.214) - 0.185, 0.006]].map(([x, y, z]) => new T.Vector3(side * x, y, z));
      g = tube(T, pts, q ? 14 : 6, q ? 20 : 10, (u) => [lerp(0.03, 0.071, sstep(0, 0.3, u)) - 0.004 * u, lerp(0.012, 0.024, sstep(0, 0.4, u)), 1 - 0.12 * Math.pow(Math.max(0, 1 - u * 3), 2)], { noise: (a, u) => 0.05 * u * nz(a * 5 + side * 7, u * 3) });
    } else {
      const yy = gy(0.214);
      const ys = [gy(0.15) - 0.035, yy - 0.06, yy - 0.2, yy - 0.42, yy - P.slen];
      const pts = ys.map((y, k) => new T.Vector3(side * S.x[k], y, S.z[k]));
      const len = P.slen;
      g = tube(T, pts, q ? 30 : 12, q ? 18 : 9, (u, a) => {
        const rx = prof(S.r.map((r) => [r[0], r[1]]), u); const rz = prof(S.r.map((r) => [r[0], r[2]]), u);
        return [rx, rz, (1 - 0.25 * Math.pow(Math.max(0, Math.cos(a)), 3) * sstep(0.05, 0.3, u)) * (0.92 + 0.08 * sstep(0, 0.1, u))];
      }, { noise: (a, u) => (S.fold / 0.05) * sstep(0.15, 0.6, u) * nz(a * 3 + side * 9, u * len * 6) });
      if (P.sl === 'rib') { const uv = g.attributes.uv.array; const p = g.attributes.position.array; const yc = ys[4] + 0.07; for (let i = 0; i < p.length / 3; i++) if (p[i * 3 + 1] < yc) { uv[i * 2] *= 1.6; uv[i * 2 + 1] *= 1.6; } }
    }
    add(mat, g);
  }
  // neckline trims
  const neckPts = (lift, inset, n) => {
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU; const front = Math.sin(a) > 0; const x = Math.cos(a) * P.nw * 0.98;
      const y = topY(x, front) + lift; const z = front ? surf(x, topY(x, true) + 0.004) : surf(x, topY(x, false) + 0.004, false);
      pts.push(new T.Vector3(x, y, z * (1 - inset)));
    }
    return pts;
  };
  if (P.neck) {
    const g = tube(T, neckPts(-P.neck * 0.45, 0.0, 20), q ? 48 : 20, q ? 8 : 5, () => [P.neck * 0.38, P.neck, 0.9], { closed: true, ref: new T.Vector3(0, 1, 0) });
    add(mat, scaleUv(g, 1.6));
  }
  if (P.roll) add(mat, tube(T, neckPts(-0.004, 0, 20), q ? 56 : 22, q ? 6 : 4, () => [0.005, 0.006, 0.95], { closed: true, ref: new T.Vector3(0, 1, 0) }));
  if (P.collar) {
    const shirt = P.collar === 'shirt'; const h = shirt ? 0.032 : P.collar === 'stand' ? 0.05 : 0.04;
    const gap = shirt ? 0.004 : 0.012; const nb = q ? 28 : 12;
    const base = (u) => { // u in [0,1] from the front-left opening, round the back, to the front-right
      const a = Math.PI / 2 + Math.asin(clamp(gap / P.nw, 0, 1)) + u * (TAU - 2 * Math.asin(clamp(gap / P.nw, 0, 1))) * 1;
      const x = Math.cos(a) * P.nw * 0.96; const front = Math.sin(a) > 0;
      const y = topY(x, front); const z = front ? surf(x, y + 0.003) : surf(x, y + 0.003, false);
      return [x, y, z];
    };
    const stand = grid(T, nb, q ? 4 : 2, (i, j, o) => {
      const [x, y, z] = base(i / nb); const v = j / (q ? 4 : 2);
      o[0] = x * (1 - 0.12 * v); o[1] = y - 0.004 + v * h; o[2] = z * (1 - 0.12 * v) - 0.003 * v; o[3] = 0.95;
    }, false);
    add(mat, stand);
    if (shirt) {
      const leaf = grid(T, nb, q ? 6 : 3, (i, j, o) => {
        const u = i / nb; const [x, y, z] = base(u); const v = j / (q ? 6 : 3);
        const fr = Math.pow(Math.abs(u - 0.5) * 2, 3); // 0 at the back, 1 at the front ends
        const drop = lerp(0.036, 0.075, fr); const out = lerp(1.2, 1.5, fr);
        o[0] = x * lerp(0.88, out, v) + sgn(x) * fr * 0.03 * v; o[1] = y - 0.004 + h * 0.86 - drop * v + 0.006 * Math.sin(v * Math.PI);
        o[2] = z * lerp(0.88, out * 0.95, v) + fr * 0.012 * v + 0.004 * Math.sin(v * Math.PI); o[3] = 0.86 + 0.14 * Math.min(1, v * 3);
      }, false);
      add(mat, leaf);
    }
  }
  // front details
  const btnMat = P.btnMat ? shared(T, P.btnMat) : null;
  if (P.lapel) {
    const k = P.lapel; const y0 = gy(0.06);
    const outline = [[0.058, y0 + 0.004], [0.1, y0 - 0.03], [0.116, y0 - 0.085 * k], [0.098, y0 - 0.094 * k], [0.142 * k, y0 - 0.112 * k], [0.12 * k, y0 - 0.2 * k], [0.065, y0 - P.nf * 0.78], [0.014, y0 - P.nf - 0.005], [0.004, y0 - P.nf + 0.01]];
    const roll = (y) => lerp(0.004, 0.072, clamp((y - (y0 - P.nf)) / P.nf, 0, 1));
    for (const s of [-1, 1]) {
      const pts = outline.map(([x, y]) => [s * x, y]);
      add(mat, patch(T, pts, (x, y) => surf(x, Math.min(y, y0 - 0.02)) + 0.004 + 0.008 * clamp(1 - (Math.abs(x) - roll(y)) / 0.06, 0, 1), 0.006, 0.97));
    }
    // collar round the back of the neck
    add(mat, tube(T, [-0.07, -0.05, 0, 0.05, 0.07].map((x) => new T.Vector3(x, topY(x, false) + 0.012, -0.012 - 0.012 * (1 - (x / 0.07) ** 2))), q ? 16 : 8, q ? 6 : 4, () => [0.006, 0.016, 0.9], { ref: new T.Vector3(0, 1, 0) }));
    // front edge below the button, curving away to the hem
    const yb = yN - P.nf - 0.005; const edge = [];
    for (let k2 = 0; k2 <= 8; k2++) { const t = k2 / 8; edge.push([0.004 + (P.cut ? 0.07 * t * t : 0), lerp(yb, hem + (P.cut || 0) * 0.55, t)]); }
    const strip = [...edge.map(([x, y]) => [x - 0.003, y]), ...edge.reverse().map(([x, y]) => [x + 0.004, y])];
    add(mat, patch(T, strip, (x, y) => surf(x, y) + 0.004, 0.006, 0.9));
  }
  if (P.btn) for (const d of P.btn) add(btnMat, disc(T, P.lapel ? 0.011 : 0.0055, 0.004, q ? 14 : 8, P.lapel ? 0.0 : 0.0, yN - d, surf(0, yN - d) + (P.lapel ? 0.004 : 0.003)));
  if (P.pockets) {
    for (const s of [-1, 1]) {
      const y = yN - P.pockets; const x0 = s * 0.075; const x1 = s * 0.225;
      add(mat, patch(T, [[x0, y], [x1, y - 0.006], [x1, y - 0.058], [x0, y - 0.052]], (x, yy) => surf(x, yy) + 0.004, 0.007, 0.96));
    }
    if (type === 'jacket') add(mat, patch(T, [[0.09, yN - 0.255], [0.19, yN - 0.245], [0.19, yN - 0.268], [0.09, yN - 0.278]], (x, yy) => surf(x, yy) + 0.003, 0.005, 0.96));
  }
  if (P.placket) {
    const top = yN - P.nf - 0.002;
    add(mat, patch(T, [[-0.017, top], [0.017, top], [0.017, hem + 0.002], [-0.017, hem + 0.002]], (x, y) => surf(x, y) + 0.0025, 0.004, 0.97));
    for (let k = 0; k < 7; k++) { const y = top - 0.06 - k * 0.095; if (y > hem + 0.04) add(btnMat, disc(T, 0.0055, 0.003, q ? 12 : 6, 0, y, surf(0, y) + 0.0025)); }
  }
  if (P.zip) {
    const top = yN - P.nf + (P.collar ? (P.collar === 'stand' ? 0.05 : 0.04) : 0); const bot = P.zip === 1 ? hem : yN - P.nf - P.zip;
    const zipMat = shared(T, 'zip');
    const zz = (x, y) => (y > yN - P.nf ? surf(0, yN - P.nf - 0.004) + 0.002 : surf(x, y)) + 0.008;
    add(zipMat, patch(T, [[-0.0035, top], [0.0035, top], [0.0035, bot], [-0.0035, bot]], zz, 0.004, 0.9));
    const pull = new T.BoxGeometry(0.011, 0.03, 0.003); pull.translate(0, top - 0.024, zz(0, top - 0.024) + 0.003);
    add(zipMat, pull);
    if (P.zip !== 1) add(mat, patch(T, [[-0.007, bot + 0.002], [0.007, bot + 0.002], [0.007, bot - 0.012], [-0.007, bot - 0.012]], (x, y) => surf(x, y) + 0.003, 0.004, 0.85));
  }
}

// ---------- bottoms ----------
const BOTTOMS = {
  trousers: { L: 0.892, rise: 0.27, fab: 'wool', w: [[0, 0.198], [0.12, 0.218], [0.27, 0.228]], leg: [[0, 0.114], [0.5, 0.1], [1, 0.094]], gap: 0.03, d: [[0, 0.012], [0.04, 0.016], [0.041, 0.013], [0.18, 0.042], [0.4, 0.045], [0.892, 0.036]], crease: 0.007, fold: 0.006, loops: 1, pocket: 'slant' },
  jeans: { L: 0.892, rise: 0.25, fab: 'denim', w: [[0, 0.198], [0.12, 0.216], [0.25, 0.226]], leg: [[0, 0.113], [0.5, 0.098], [1, 0.094]], gap: 0.028, d: [[0, 0.013], [0.04, 0.017], [0.041, 0.014], [0.18, 0.042], [0.4, 0.044], [0.892, 0.036]], fold: 0.007, loops: 1, pocket: 'scoop', stitch: 1, button: 'copper' },
  chinos: { L: 0.892, rise: 0.26, fab: 'twill', w: [[0, 0.198], [0.12, 0.217], [0.26, 0.226]], leg: [[0, 0.113], [0.5, 0.096], [1, 0.088]], gap: 0.03, d: [[0, 0.012], [0.04, 0.016], [0.041, 0.013], [0.18, 0.042], [0.4, 0.044], [0.892, 0.034]], fold: 0.008, loops: 1, pocket: 'slant', button: 'horn' },
  joggers: { L: 0.892, rise: 0.29, fab: 'fleece', w: [[0, 0.19], [0.05, 0.2], [0.14, 0.228], [0.29, 0.232]], leg: [[0, 0.116], [0.5, 0.1], [0.88, 0.078], [0.9, 0.062], [1, 0.058]], gap: 0.03, d: [[0, 0.016], [0.05, 0.02], [0.051, 0.016], [0.18, 0.045], [0.4, 0.048], [0.8, 0.04], [0.892, 0.03]], fold: 0.012, gather: 0.055, cuff: 0.09, cord: 1 },
  shorts: { L: 0.4, rise: 0.25, fab: 'twill', w: [[0, 0.198], [0.12, 0.218], [0.25, 0.228]], leg: [[0, 0.114], [1, 0.11]], gap: 0.03, d: [[0, 0.012], [0.04, 0.016], [0.041, 0.013], [0.18, 0.042], [0.4, 0.04]], fold: 0.006, loops: 1, pocket: 'slant', button: 'horn' },
  skirt: { L: 0.56, skirt: 1, fab: 'wool', w: [[0, 0.172], [0.04, 0.176], [0.2, 0.225], [0.56, 0.33]], d: [[0, 0.012], [0.035, 0.015], [0.036, 0.013], [0.2, 0.045], [0.56, 0.085]], fold: 0.02 },
};
const WAIST_Y = -0.128;
function buildBottom(T, type, P, rgb, R, q, add) {
  const mat = fabricMat(T, rgb, P.fab);
  const nz = noise2(R);
  const ph = Array.from({ length: 6 }, () => R() * TAU);
  const yW = WAIST_Y; const L = P.L;
  const nv = q ? (P.skirt ? 30 : 40) : (P.skirt ? 14 : 18);
  const rows = [0, 0.039 / L, 0.041 / L, 0.06 / L];
  for (let j = 4; j <= nv; j++) rows.push(lerp(0.08 / L, 1, (j - 4) / (nv - 4)));
  const foldAt = (xn, dd, front, k = 1) => {
    const A = P.fold * k * (0.3 + 0.7 * sstep(0.05, L, dd));
    const o = front ? 0 : 3;
    const g = P.gather && dd < P.gather ? 0.004 * Math.sin(xn * 90 + ph[5]) : 0;
    return A * (0.5 * Math.sin(TAU * 1.6 * xn + ph[o] + dd * 3) + 0.3 * Math.sin(TAU * 3.1 * xn + ph[o + 1] - dd * 5) + 0.6 * nz(xn * 3 + o * 7, dd * 6)) + g;
  };
  if (P.skirt) {
    const nu = q ? 60 : 26;
    add(mat, grid(T, nu, nv, (i, j, o) => {
      const th = -Math.PI / 2 + (TAU * i) / nu; const c = Math.cos(th); const s = Math.sin(th); const front = s > 0;
      const dd = rows[j] * L; const W = prof(P.w, dd); const D = prof(P.d, dd);
      const fd = foldAt(c, dd, front) * (0.4 + 0.6 * Math.abs(s)) + P.fold * 0.7 * sstep(0.1, L, dd) * Math.sin(th * 7 + ph[2] + nz(th, 2) * 2);
      let nx = c / W; let nzz = s / D; const l = Math.hypot(nx, nzz); nx /= l; nzz /= l;
      o[0] = W * c + fd * nx; o[2] = D * s + fd * nzz;
      o[1] = yW - dd + (j === nv ? 0.006 * nz(c * 6, front ? 1 : 5) : 0) + 0.012 * Math.pow(Math.abs(c), 3) * rows[j];
      o[3] = (1 - 0.35 * clamp(-fd / (P.fold * 1.2), 0, 1)) * (dd < 0.04 ? 0.97 : 1);
    }));
    addClips(T, q, add, 0.014);
    return;
  }
  const nu = q ? 24 : 14;
  const legAt = (dd, s) => {
    if (dd <= P.rise) { const Wh = prof(P.w, dd); return { xc: (s * Wh) / 2, W: Wh / 2, nIn: 7 }; }
    const t = (dd - P.rise) / (L - P.rise); const W = prof(P.leg, t);
    return { xc: s * (W + (P.gap / 2) * Math.pow(sstep(0, 1, t), 0.7)), W, nIn: lerp(7, 2.2, sstep(0, 0.15, t)) };
  };
  const surf = (x, y) => {
    const dd = yW - y; const s = sgn(x); const { xc, W, nIn } = legAt(dd, s); const sx = clamp((x - xc) / W, -1, 1);
    const n = sx * s < 0 ? nIn : 2.4; return prof(P.d, dd) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(sx), n)), 1 / n);
  };
  for (const s of [-1, 1]) {
    const LR = rows.map((e) => legAt(e * L, s));
    add(mat, grid(T, nu, nv, (i, j, o) => {
      const th = -Math.PI / 2 + (TAU * i) / nu; const c = Math.cos(th); const sn = Math.sin(th); const front = sn > 0;
      const dd = rows[j] * L; const { xc, W, nIn } = LR[j];
      const inner = c * s < 0; const n = inner ? nIn : 2.4;
      const sx = sgn(c) * Math.pow(Math.abs(c), 2 / n); const sz = sgn(sn) * Math.pow(Math.abs(sn), 2 / n);
      const D = prof(P.d, dd);
      let z = D * sz;
      if (P.crease && dd > 0.06) z += sgn(sz) * P.crease * Math.pow(Math.max(0, 1 - Math.abs(sx) / 0.3), 2) * sstep(0.06, P.rise, dd);
      const fd = foldAt(sx + s * 2, dd, front) * Math.pow(Math.abs(sz), 0.5);
      let x = xc + W * sx;
      const side = Math.pow(1 - Math.abs(sz), 3);
      x += sgn(sx) * side * P.fold * 0.8 * nz(dd * 7 + s * 5, 3.5);
      const brk = P.crease || P.cuff ? 0 : 0.004 * sstep(L - 0.2, L, dd) * Math.sin(dd * 60 + ph[2] + sx);
      o[0] = x; o[1] = yW - dd + (j === nv ? 0.004 * nz(sx * 4 + s * 9, 2) : 0);
      o[2] = z + (fd + brk) * sgn(sz);
      const crotch = inner && dd > P.rise - 0.05 ? 0.3 * Math.pow(1 - Math.abs(sz), 2) * (1 - sstep(P.rise, P.rise + 0.25, dd)) : 0;
      o[3] = (1 - 0.32 * clamp(-fd / (P.fold * 0.9), 0, 1)) * (1 - crotch) * (dd < 0.04 ? 0.98 : 1) * (inner && dd > P.rise ? 0.9 : 1);
    }));
  }
  const front = (x, y) => surf(x, y) + 0.003;
  if (P.loops) for (const x of [-0.17, -0.07, 0.07, 0.17]) add(mat, patch(T, [[x - 0.006, yW + 0.002], [x + 0.006, yW + 0.002], [x + 0.006, yW - 0.05], [x - 0.006, yW - 0.05]], (xx, y) => surf(xx, y) + 0.004, 0.005, 0.95));
  // fly and pockets
  const fly = []; for (let k = 0; k <= 10; k++) { const t = k / 10; fly.push([-0.032 + 0.03 * Math.pow(t, 3), yW - 0.045 - t * (P.rise - 0.1)]); }
  const line = (pts, wdt) => [...pts.map(([x, y]) => [x - wdt, y]), ...pts.slice().reverse().map(([x, y]) => [x + wdt, y])];
  const lineH = (pts, wdt) => [...pts.map(([x, y]) => [x, y + wdt]), ...pts.slice().reverse().map(([x, y]) => [x, y - wdt])];
  if (!P.gather) add(mat, patch(T, line(fly, 0.0022), front, 0.004, 0.75));
  for (const s of [-1, 1]) {
    if (P.pocket === 'slant') add(mat, patch(T, line([[s * 0.13, yW - 0.042], [s * 0.165, yW - 0.1], [s * 0.2, yW - 0.165]], 0.0025), front, 0.004, 0.7));
    if (P.pocket === 'scoop') { const pts = []; for (let k = 0; k <= 8; k++) { const a = (k / 8) * Math.PI / 2; pts.push([s * (0.215 - 0.1 * Math.cos(a)), yW - 0.042 - 0.075 * Math.sin(a)]); } add(mat, patch(T, lineH(pts, 0.0025), front, 0.004, 0.7)); }
  }
  if (P.stitch) {
    const st = shared(T, 'stitch');
    add(st, patch(T, line(fly.map(([x, y]) => [x + 0.008, y]), 0.0009), (x, y) => surf(x, y) + 0.0045, 0.001, 1));
    add(st, patch(T, lineH([[-0.2, yW - 0.006], [0.2, yW - 0.006]], 0.0008), (x, y) => surf(x, y) + 0.004, 0.001, 1));
    add(st, patch(T, lineH([[-0.2, yW - 0.036], [0.2, yW - 0.036]], 0.0008), (x, y) => surf(x, y) + 0.004, 0.001, 1));
    const cu = shared(T, 'copper');
    for (const s of [-1, 1]) add(cu, disc(T, 0.0035, 0.003, 8, s * 0.207, yW - 0.046, surf(s * 0.207, yW - 0.046) + 0.003));
  }
  if (P.button) add(shared(T, P.button), disc(T, P.button === 'copper' ? 0.008 : 0.007, 0.004, q ? 14 : 8, -0.012, yW - 0.02, surf(-0.012, yW - 0.02) + 0.004));
  if (P.cord) {
    const cm = shared(T, 'laceW');
    for (const s of [-1, 1]) {
      const z0 = surf(s * 0.012, yW - 0.03) + 0.006;
      const pts = [[s * 0.012, yW - 0.03, z0], [s * 0.02, yW - 0.09, z0 + 0.008], [s * 0.016, yW - 0.16, z0 + 0.012], [s * 0.024, yW - 0.22, z0 + 0.012]].map(([x, y, z]) => new T.Vector3(x, y, z));
      add(cm, tube(T, pts, q ? 16 : 6, q ? 6 : 4, () => [0.0028, 0.0028, 1], { ref: new T.Vector3(1, 0, 0) }));
      const tip = new T.CylinderGeometry(0.0036, 0.0036, 0.022, 8); tip.translate(s * 0.024, yW - 0.225, z0 + 0.012); add(shared(T, 'clip'), tip);
    }
  }
  addClips(T, q, add, 0.014);
}
function addClips(T, q, add, dz) {
  const h = clipHanger(T, q, WAIST_Y, [-0.15, 0.15], dz);
  add(shared(T, 'wood'), h.wood);
  add(shared(T, 'clip'), h.metal);
}

// ---------- shoes ----------
const SHOES = {
  derby: { leather: [0.36, 0.55], sole: 0.012, heel: 0.022, welt: 0.004, spring: 0.012, H: [[0, 0.075], [0.18, 0.062], [0.3, 0.07], [0.44, 0.086], [0.56, 0.076], [0.72, 0.06], [0.9, 0.044], [1, 0.036]], open: 0.3, throat: 0.45, laces: 5, k: 0.2, soleMat: 'soleL', lace: 'laceB' },
  loafers: { leather: [0.32, 0.6], sole: 0.011, heel: 0.02, welt: 0.003, spring: 0.01, H: [[0, 0.066], [0.2, 0.052], [0.42, 0.052], [0.5, 0.068], [0.7, 0.058], [0.9, 0.042], [1, 0.034]], open: 0.46, throat: 0.47, apron: 1, soleMat: 'soleL' },
  sneakers: { leather: [0.5, 0.15], sole: 0.03, heel: 0, welt: 0.003, spring: 0.012, H: [[0, 0.084], [0.18, 0.07], [0.32, 0.078], [0.47, 0.092], [0.6, 0.074], [0.78, 0.056], [0.95, 0.046], [1, 0.04]], open: 0.32, throat: 0.52, laces: 6, k: 0.24, soleMat: 'rubberW', lace: 'laceW', two: 0.82 },
  running_shoes: { fab: 'mesh', sole: 0.038, toeSole: 0.024, heel: 0, welt: 0.004, spring: 0.026, H: [[0, 0.09], [0.16, 0.076], [0.32, 0.084], [0.48, 0.096], [0.62, 0.078], [0.8, 0.058], [0.95, 0.048], [1, 0.042]], open: 0.3, throat: 0.52, laces: 6, k: 0.22, soleMat: 'rubberW', lace: 'laceW', two: 0.25 },
};
function buildShoe(T, P, rgb, R, q, add) {
  const L = 0.28; const Z = (t) => -L / 2 + t * L;
  const hw = (t) => prof([[0, 0.031], [0.3, 0.033], [0.6, 0.046], [0.75, 0.047], [1, 0.04]], t) * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, (0.12 - t) / 0.12), 2))) * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, (t - 0.8) / 0.2), 2)));
  const xc = (t) => 0.007 * sstep(0.45, 1, t);
  const lift = (t) => P.heel * (1 - sstep(0.24, 0.44, t));
  const soleH = (t) => (P.toeSole ? lerp(P.sole, P.toeSole, sstep(0.2, 0.9, t)) : P.sole);
  const soleTop = (t) => soleH(t) + lift(t);
  const H = (t) => prof(P.H, t) + (P.heel ? lift(t) * 0.5 : 0);
  const kOf = (t) => { if (t > P.throat + 0.03) return 0; const kOpen = P.apron ? 0.8 : 0.62; if (!P.laces) return kOpen * (1 - sstep(P.throat - 0.06, P.throat + 0.03, t)); return t < P.open ? kOpen : lerp(kOpen, P.k, sstep(P.open - 0.03, P.open + 0.03, t)) * (1 - sstep(P.throat - 0.02, P.throat + 0.03, t)); };
  const nH = q ? 26 : 14; const nM = q ? 10 : 6;
  const ts = []; for (let k = 0; k <= nH; k++) ts.push((1 - Math.cos((Math.PI * k) / nH)) / 2);
  const col = (i) => (i <= nH ? { t: ts[i], s: -1 } : { t: ts[2 * nH - i], s: 1 });
  const upperMat = P.fab ? fabricMat(T, rgb, P.fab) : leatherMat(T, rgb, P.leather[0], P.leather[1]);
  const upper = grid(T, 2 * nH, nM, (i, j, o) => {
    const { t, s } = col(i); const w = hw(t) * 1.0; const x0 = xc(t) + s * w; const z0 = Z(t); const y0 = soleTop(t) - 0.003;
    const k = kOf(t); const yt = H(t);
    const dz = -0.034 * Math.pow(sstep(0.7, 1, t), 1.2) + 0.012 * (1 - sstep(0, 0.14, t));
    const xt = xc(t) + s * w * k; const zt = z0 + dz;
    const qx = xc(t) + s * w * 1.05; const qy = lerp(y0, yt, 0.82); const qz = z0 + dz * 0.25;
    const v = j / nM; const a = (1 - v) * (1 - v); const b = 2 * (1 - v) * v; const c = v * v;
    o[0] = a * x0 + b * qx + c * xt; o[1] = a * y0 + b * qy + c * yt; o[2] = a * z0 + b * qz + c * zt;
    o[3] = 0.82 + 0.18 * sstep(0, 0.3, v);
  }, false);
  add(upperMat, upper);
  // sole: extruded footprint, a touch wider than the upper
  const outline = [];
  for (let k = 0; k < 2 * nH; k++) { const { t, s } = col(k); outline.push(new T.Vector2(xc(t) + s * (hw(t) + P.welt), -Z(t))); }
  const solid = (pts, h, bev) => { const g = new T.ExtrudeGeometry(new T.Shape(pts), { depth: h, bevelEnabled: bev > 0, bevelThickness: bev, bevelSize: bev, bevelSegments: 1, curveSegments: 4 }); g.rotateX(-Math.PI / 2); g.translate(0, bev, 0); return g; };
  const sole = solid(outline, Math.max(0.004, P.sole - 0.004), 0.002);
  { // shape the sole: heel lift through the shank, thinner toe for runners, darker outsole band
    const p = sole.attributes.position; const cc = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const t = clamp((p.getZ(i) + L / 2) / L, 0, 1); let y = p.getY(i);
      if (P.toeSole) y *= soleH(t) / P.sole;
      p.setY(i, y + lift(t));
      const band = P.two ? (y < P.sole * (P.two < 0.5 ? P.two * 1.2 : 0.22) ? (P.two < 0.5 ? 0.16 : 0.8) : 1) : 1;
      cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = band;
    }
    sole.setAttribute('color', new T.BufferAttribute(cc, 3));
    sole.computeVertexNormals();
  }
  add(shared(T, P.soleMat), sole);
  if (P.heel) {
    const hp = outline.filter((v) => -v.y < Z(0.25));
    hp.push(new T.Vector2(xc(0.25) + hw(0.25) + P.welt, -Z(0.25)));
    hp.unshift(new T.Vector2(xc(0.25) - hw(0.25) - P.welt, -Z(0.25)));
    const st = shared(T, 'stack');
    const g = solid(hp, P.heel - 0.002, 0.001);
    const cc = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < cc.length / 3; i++) { const y = g.attributes.position.getY(i); cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = y < 0.004 ? 0.35 : 0.85 + 0.15 * Math.sin(y * 900); }
    g.setAttribute('color', new T.BufferAttribute(cc, 3));
    add(st, g);
  }
  // insole seen through the opening
  const ins = new T.ShapeGeometry(new T.Shape(outline.map((v) => new T.Vector2(v.x * 0.9, v.y * 0.97))), 1);
  ins.rotateX(-Math.PI / 2);
  { const p = ins.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, soleTop(clamp((p.getZ(i) + L / 2) / L, 0, 1)) + 0.002); }
  add(shared(T, 'lining'), ins);
  // collar binding along the opening
  const rim = []; const tEnd = P.laces ? P.open : P.throat - 0.02;
  for (let k = 0; k <= 16; k++) { const u = k / 16; const t = u < 0.5 ? tEnd * (1 - u * 2) : tEnd * (u * 2 - 1); const s = u < 0.5 ? -1 : 1; const tt = Math.max(t, 0.002); rim.push(new T.Vector3(xc(tt) + s * hw(tt) * kOf(tt) * (t < 0.003 ? 0 : 1), H(tt) + 0.001, Z(tt) + 0.012 * (1 - sstep(0, 0.14, tt)))); }
  add(upperMat, tube(T, rim, q ? 40 : 14, q ? 6 : 4, () => [P.sole > 0.02 ? 0.006 : 0.003, P.sole > 0.02 ? 0.006 : 0.003, 0.9], { ref: new T.Vector3(0, 1, 0) }));
  if (P.laces) {
    // tongue under the laces
    const t0 = P.open - 0.07; const t1 = P.throat + 0.01;
    add(upperMat, grid(T, q ? 6 : 3, q ? 10 : 4, (i, j, o) => {
      const t = lerp(t0, t1, j / (q ? 10 : 4)); const x = (i / (q ? 6 : 3) - 0.5) * 2 * hw(t) * (P.k + 0.12);
      o[0] = xc(t) + x; o[1] = H(t) - 0.004 - 18 * x * x + (t < P.open ? 0.016 * (1 - t / P.open) + 0.006 : 0); o[2] = Z(t) + (t < P.open ? 0.008 : 0); o[3] = 0.9;
    }, true));
    const lm = shared(T, P.lace);
    for (let k = 0; k < P.laces; k++) {
      const t = lerp(P.open + 0.012, P.throat - 0.03, k / (P.laces - 1)); const w = hw(t) * (P.k + 0.08) * 2;
      const g = new T.CylinderGeometry(0.0024, 0.0024, w, q ? 8 : 5); g.rotateZ(Math.PI / 2); g.translate(xc(t), H(t) + 0.003, Z(t));
      add(lm, g);
    }
    const bow = tube(T, [[-0.012, 0.004, 0.004], [-0.022, 0.006, -0.012], [0, 0.004, -0.006], [0.02, 0.006, -0.014], [0.012, 0.004, 0.004]].map(([x, y, z]) => new T.Vector3(xc(P.open) + x, H(P.open) + y + 0.002, Z(P.open + 0.01) + z)), q ? 20 : 8, q ? 5 : 4, () => [0.0022, 0.0022, 1], { ref: new T.Vector3(0, 1, 0) });
    add(lm, bow);
  }
  if (P.apron) {
    const pts = [];
    for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; const t = 0.71 + 0.2 * Math.sin(a); const x = 0.68 * hw(t) * Math.cos(a); pts.push(new T.Vector3(xc(t) + x, H(t) - 40 * x * x * 0.55 + 0.0015, Z(t) - 0.034 * Math.pow(sstep(0.7, 1, t), 1.2) * 0.75)); }
    add(upperMat, tube(T, pts, q ? 48 : 16, q ? 5 : 4, () => [0.0026, 0.0026, 0.95], { closed: true, ref: new T.Vector3(0, 1, 0) }));
    const strap = [-1, -0.5, 0, 0.5, 1].map((u) => { const t = 0.5; const x = u * hw(t) * 0.95; return new T.Vector3(xc(t) + x, H(t) - Math.abs(u) ** 2 * 0.016 + 0.002, Z(t)); });
    add(upperMat, tube(T, strap, q ? 16 : 6, q ? 6 : 4, () => [0.012, 0.0025, 0.95], { ref: new T.Vector3(0, 0, 1) }));
  }
}

// ---------- entry ----------
/**
 * Builds one garment. Returns { object: THREE.Group, size: {w, h, d}, triangles, dispose }.
 * @param {any} THREE three.js namespace
 * @param {{type:string, rgb:number[], seed?:number, quality?:'high'|'low', hanger?:'wood'|'none'}} spec
 */
export function buildGarment(THREE, spec) {
  const T = THREE;
  if (CACHE.three !== T) { disposeGarmentCache(); CACHE.three = T; }
  const type = GARMENT_TYPES_3D.includes(spec.type) ? spec.type : 'tee';
  const rgb = (spec.rgb || [128, 128, 128]).map((v) => clamp(Number(v) || 0, 0, 255));
  const seed = Number.isInteger(spec.seed) ? spec.seed : hash(`${type}|${rgb.join(',')}`);
  const R = rng(seed);
  const q = spec.quality !== 'low';
  const buckets = new Map();
  const add = (m, g) => { if (!buckets.has(m)) buckets.set(m, []); buckets.get(m).push(g); };
  const owned = new Set();
  const group = new T.Group();
  group.name = `garment:${type}`;
  const meshesOf = (target, list) => {
    for (const [m, geos] of list) {
      const g = merge(T, geos);
      g.computeBoundingSphere();
      const mesh = new T.Mesh(g, m);
      target.add(mesh);
    }
  };
  if (TOPS[type]) {
    buildTop(T, type, TOPS[type], rgb, R, q, add);
    if (spec.hanger !== 'none') { const h = woodHanger(T, q); add(shared(T, 'wood'), h.wood); add(shared(T, 'chrome'), h.metal); }
    meshesOf(group, buckets);
  } else if (BOTTOMS[type]) {
    buildBottom(T, type, BOTTOMS[type], rgb, R, q, add);
    if (spec.hanger === 'none') { buckets.delete(shared(T, 'wood')); buckets.delete(shared(T, 'clip')); }
    meshesOf(group, buckets);
  } else {
    buildShoe(T, SHOES[type], rgb, R, q, add);
    const one = new T.Group();
    meshesOf(one, buckets);
    const right = one; right.position.set(-0.064, 0, -0.008); right.rotation.y = -0.05;
    const left = new T.Group();
    for (const m of one.children) left.add(new T.Mesh(m.geometry, m.material));
    left.scale.x = -1; left.position.set(0.064, 0, 0.008); left.rotation.y = 0.05;
    group.add(right, left);
  }
  let triangles = 0;
  group.traverse((o) => {
    if (!o.isMesh) return;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    if (!CACHE.mat.has(o.material.name) && ![...CACHE.mat.values()].includes(o.material)) owned.add(o.material);
  });
  group.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(group);
  const size = { w: box.max.x - box.min.x, h: box.max.y - box.min.y, d: box.max.z - box.min.z };
  group.userData.garment = { type, size };
  const dispose = () => {
    const geos = new Set();
    group.traverse((o) => { if (o.isMesh) geos.add(o.geometry); });
    for (const g of geos) g.dispose();
    for (const m of owned) m.dispose();
    owned.clear();
  };
  return { object: group, size, triangles, dispose };
}
