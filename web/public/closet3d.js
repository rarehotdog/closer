// Closet in 3D (three.js, pinned 0.170.0, core build only). A white lacquer walk-in closet drawn in code:
// floor-to-ceiling cabinetry with champagne-brass rails and edges, glass-front side towers, warm LED strips,
// a marble floor and a low marble-topped island. The pieces from anatomy.js sit on four layers: outerwear
// rail, tops rail, bottoms shelf (folded), shoe shelf (backlit). A slider pulls the layers apart like an
// exploded diagram. Cards carry a price tag only when the closet ledger has a row for that piece; the tag
// shows that saved row as it is (amount in its own currency, platform, asking or traded, Sample). The
// view computes no numbers of its own. Every texture is drawn by code (CSP: no external images or fonts).
import * as THREE from './vendor/three.module.min.js';

const LAYER_Y = { outer: 2.35, top: 0.8, bottom: -0.75, shoes: -2.3 };
const CARD_W = 0.98;
const CARD_H = 1.22;
const WIDTH = 4.9;
// Exploded view: layers slide forward and apart while the cabinetry stays.
const SPREAD_Y = { outer: 0.95, top: 0.32, bottom: -0.32, shoes: -0.45 };
const REST = { x: 0.08, y: -0.3 };
const STATE_TAG = { LAUNDRY: 'In the laundry', REPAIR: 'At repair', STORED: 'Stored' };
const SERIF = '"Didot", "Bodoni 72", "Bodoni MT", ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif", Georgia, serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const AMBER = '#a8690f';

const SHAPES = {
  outer: [[100, 26], [156, 26], [202, 50], [236, 196], [206, 206], [186, 108], [186, 236], [70, 236], [70, 108], [50, 206], [20, 196], [54, 50]],
  top: [[96, 38], [160, 38], [216, 70], [196, 114], [176, 102], [176, 228], [80, 228], [80, 102], [60, 114], [40, 70]],
  bottom: [[76, 28], [180, 28], [192, 236], [146, 236], [128, 98], [110, 236], [64, 236]],
  shoes: [[34, 168], [116, 150], [164, 108], [212, 118], [226, 178], [224, 204], [34, 204]],
};

function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

// Light only since 11/5: the pages have no dark theme, so the stage is always the white closet.
function isDark() {
  return false;
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draws one card. With `photo` (the owner's own mask cut-out) the card shows the real garment; otherwise a code-drawn silhouette. */
function drawCard(c, cell, fill, name, photo) {
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#fbfaf7';
  g.fillRect(0, 0, 256, 320);
  g.strokeStyle = '#e4ded4';
  g.lineWidth = 2;
  g.strokeRect(9, 9, 238, 302);
  if (photo) {
    const pw = photo.width || 1;
    const ph = photo.height || 1;
    const k = Math.min(224 / pw, 224 / ph);
    const w = pw * k;
    const h = ph * k;
    g.imageSmoothingQuality = 'high';
    g.drawImage(photo, (256 - w) / 2, 14 + (224 - h) / 2, w, h);
  } else {
    const pts = SHAPES[cell.slot] || SHAPES.top;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.stroke();
  }
  g.textAlign = 'center';
  g.fillStyle = '#151413';
  if (name) {
    g.font = `400 34px ${SERIF}`;
    g.fillText(cell.itemId, 128, 276);
    g.font = `500 21px ${SANS}`;
    g.fillStyle = '#4a463f';
    g.fillText(name.length > 20 ? `${name.slice(0, 19)}…` : name, 128, 304);
  } else {
    // No name (phones): the ID alone, large enough to read on a card a few dozen pixels wide.
    g.font = `400 58px ${SERIF}`;
    g.fillText(cell.itemId, 128, 300);
  }
  if (cell.availability !== 'AVAILABLE') {
    g.fillStyle = 'rgba(251,250,247,0.6)';
    g.fillRect(0, 0, 256, 248);
    g.fillStyle = '#1d1b18';
    g.font = `600 20px ${SANS}`;
    g.fillText(STATE_TAG[cell.availability] || cell.availability, 128, 36);
  }
  // Amber outline: no confirmed wear in the review window, with enough days recorded (the review rule).
  if (cell.review === 'CANDIDATE') {
    g.lineWidth = 10;
    g.strokeStyle = AMBER;
    g.strokeRect(5, 5, 246, 310);
  }
}

function fitFont(g, text, maxW, size, min, weight, family) {
  let s = size;
  g.font = `${weight} ${s}px ${family}`;
  while (g.measureText(text).width > maxW && s > min) {
    s -= 2;
    g.font = `${weight} ${s}px ${family}`;
  }
}

/** A boutique swing tag for one ledger row, exactly as saved: amount in its own currency, platform, asking or traded, Sample. */
function drawTag(c, row, fmt) {
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 384);
  g.beginPath();
  g.moveTo(58, 6);
  g.lineTo(198, 6);
  g.lineTo(250, 58);
  g.lineTo(250, 378);
  g.lineTo(6, 378);
  g.lineTo(6, 58);
  g.closePath();
  g.fillStyle = '#fbf8f2';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = '#d8cfbf';
  g.stroke();
  const sample = row.source === 'sample';
  g.save();
  g.setLineDash(sample ? [10, 8] : []);
  g.lineWidth = 3;
  g.strokeStyle = '#8c8478';
  g.strokeRect(22, 92, 212, 270);
  g.restore();
  // punched eyelet with a brass ring
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(128, 46, 13, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = 'source-over';
  g.beginPath();
  g.arc(128, 46, 17, 0, Math.PI * 2);
  g.lineWidth = 6;
  g.strokeStyle = '#f37021';
  g.stroke();
  g.textAlign = 'center';
  const amount = fmt(row.amount, row.currency);
  fitFont(g, amount, 196, 62, 24, 400, SERIF);
  g.fillStyle = '#151413';
  g.fillText(amount, 128, 182);
  g.fillStyle = '#f37021';
  g.fillRect(100, 206, 56, 3);
  const platform = String(row.platformName || row.platform || '').split(' (')[0];
  fitFont(g, platform, 196, 32, 16, 600, SANS);
  g.fillStyle = '#2f2c28';
  g.fillText(platform, 128, 252);
  g.font = `400 28px ${SANS}`;
  g.fillStyle = '#5c574f';
  g.fillText(row.priceType === 'TRADE' ? 'traded' : 'asking', 128, 292);
  if (sample) {
    g.font = `700 22px ${SANS}`;
    if ('letterSpacing' in g) g.letterSpacing = '5px';
    g.fillStyle = '#8a5a12';
    g.fillText('SAMPLE', 131, 340);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
  }
}

function radialCanvas() {
  const c = canvasOf(128, 128);
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return c;
}

function fadeCanvas() { // opaque at the top, clear at the bottom
  const c = canvasOf(8, 128);
  const g = c.getContext('2d');
  const l = g.createLinearGradient(0, 0, 0, 128);
  l.addColorStop(0, 'rgba(255,255,255,1)');
  l.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = l;
  g.fillRect(0, 0, 8, 128);
  return c;
}

function glowCanvas() { // soft rounded halo
  const c = canvasOf(128, 160);
  const g = c.getContext('2d');
  for (let i = 0; i < 24; i++) {
    const k = i / 24;
    g.fillStyle = `rgba(255,255,255,${0.06 * (1 - k)})`;
    const m = 4 + k * 26;
    roundRect(g, m, m, 128 - 2 * m, 160 - 2 * m, 18);
    g.fill();
  }
  return c;
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Light marble with long diagonal veins (deterministic, seed 7). Powers by repeated squaring keep the pixel pass fast. */
function marbleCanvas(size, seed = 7) {
  const rand = mulberry32(seed);
  const N = 64;
  const lat = new Float32Array(N * N);
  for (let i = 0; i < lat.length; i++) lat[i] = rand();
  const at = (x, y) => lat[(y & 63) * N + (x & 63)];
  const sm = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = sm(x - xi);
    const v = sm(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const turb = (x, y, oct) => { let f = 0; let amp = 0.5; let fr = 1; for (let o = 0; o < oct; o++) { f += amp * Math.abs(2 * noise(x * fr, y * fr) - 1); fr *= 2.03; amp *= 0.5; } return f; };
  const fbm = (x, y, oct) => { let f = 0; let amp = 0.5; let fr = 1; for (let o = 0; o < oct; o++) { f += amp * noise(x * fr, y * fr); fr *= 2.03; amp *= 0.5; } return f; };
  const STEP = 4;
  const G = size / STEP + 1;
  const f1 = new Float32Array(G * G);
  const f2 = new Float32Array(G * G);
  const f3 = new Float32Array(G * G);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const u = ((gx * STEP) / size) * 2.5;
      const v = ((gy * STEP) / size) * 2.5;
      const j = gy * G + gx;
      f1[j] = turb(u, v, 5);
      f2[j] = turb(u + 11.3, v + 7.1, 4);
      f3[j] = fbm(u * 0.5 + 3.1, v * 0.5 + 1.7, 3);
    }
  }
  const c = canvasOf(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const c1 = Math.cos(0.75);
  const s1n = Math.sin(0.75);
  const c2 = Math.cos(1.25);
  const s2n = Math.sin(1.25);
  const base = [244, 241, 236];
  const vein = [146, 138, 126];
  for (let y = 0; y < size; y++) {
    const gy = Math.min(G - 2, (y / STEP) | 0);
    const ty = y / STEP - gy;
    for (let x = 0; x < size; x++) {
      const gx = Math.min(G - 2, (x / STEP) | 0);
      const tx = x / STEP - gx;
      const j = gy * G + gx;
      const bil = (f) => (f[j] * (1 - tx) + f[j + 1] * tx) * (1 - ty) + (f[j + G] * (1 - tx) + f[j + G + 1] * tx) * ty;
      const u = (x / size) * 2.5;
      const v = (y / size) * 2.5;
      const s1 = 1 - Math.abs(Math.sin((u * c1 + v * s1n) * 2.6 + bil(f1) * 2.6));
      const s2 = 1 - Math.abs(Math.sin((u * c2 + v * s2n) * 5.0 + bil(f2) * 3.8));
      const a2 = s1 * s1; const a4 = a2 * a2; const a8 = a4 * a4; const a16 = a8 * a8;
      const b2 = s2 * s2; const b4 = b2 * b2; const b8 = b4 * b4; const b16 = b8 * b8; const b32 = b16 * b16;
      const k = Math.min(1, 0.66 * a16 * a2 + 0.25 * b32 * b16);
      const cloud = (bil(f3) - 0.5) * 0.08;
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) d[i + ch] = base[ch] * (1 + cloud) * (1 - k) + vein[ch] * k;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#ded8ce'; // grout on two edges: with mirrored repeats it reads as slab joints
  g.fillRect(0, 0, size, 1);
  g.fillRect(0, 0, 1, size);
  return c;
}

/** A small procedural room of emissive panels, rendered once into a PMREM environment for soft reflections. */
function studioEnvironment() {
  const env = new THREE.Scene();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const add = (color, k, s, p, side = THREE.FrontSide) => {
    const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side }));
    m.scale.set(...s);
    m.position.set(...p);
    env.add(m);
  };
  add(0xf7f6f4, 0.6, [26, 14, 26], [0, 4, 0], THREE.BackSide); // room shell: soft fill from every side
  add(0xe2ded7, 0.4, [26, 0.1, 26], [0, -2.95, 0]); // darker floor: a horizon line in the lacquer
  add(0xfffaf3, 9, [12, 0.1, 1.6], [0, 10.9, -3]); // three ceiling light strips
  add(0xfffaf3, 7, [12, 0.1, 1.6], [0, 10.9, 1.5]);
  add(0xfffaf3, 5, [12, 0.1, 1.6], [0, 10.9, 6]);
  add(0xfffaf3, 4.5, [0.1, 5, 8], [-12.9, 4, 2]); // key softbox, left
  add(0xf1f4ff, 2.2, [0.1, 4, 6], [12.9, 3.5, 0]); // cool fill, right
  add(0xfffaf3, 3, [10, 3.5, 0.1], [0, 3, 12.9]); // broad panel behind the camera: long reflections on lacquer and glass
  return env;
}

/** Concatenates non-indexed copies of `geos` (position, normal, uv) into one geometry. */
function joinGeometries(geos) {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const total = flat.reduce((n, g) => n + g.attributes[name].count * size, 0);
    const arr = new Float32Array(total);
    let off = 0;
    for (const g of flat) { arr.set(g.attributes[name].array, off); off += g.attributes[name].count * size; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const g of flat) g.dispose();
  for (const g of geos) g.dispose();
  return out;
}

/** Bakes every mesh under `container` into one mesh per material (core three.js has no BufferGeometryUtils). */
function mergeByMaterial(container) {
  container.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(container.matrixWorld).invert();
  const buckets = new Map();
  container.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    const g = o.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push({ g, o });
  });
  for (const [mat, list] of buckets) {
    for (const { o } of list) { o.parent.remove(o); o.geometry.dispose(); }
    container.add(new THREE.Mesh(joinGeometries(list.map((x) => x.g)), mat));
  }
}

/** A thin brass hanger: hook over the rail, neck, and two shoulder curves along the card's top edge (card centre at y = 0). */
function hangerGeometry() {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const hook = new THREE.TorusGeometry(0.042, 0.0065, 6, 18, Math.PI * 1.3);
  hook.rotateZ(-Math.PI / 2);
  hook.translate(0, 0.787, 0);
  const neck = new THREE.TubeGeometry(new THREE.LineCurve3(V(0, 0.746, 0), V(0, 0.665, 0.078)), 2, 0.0062, 6, false);
  const arms = [-1, 1].map((s) => new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(V(0, 0.665, 0.078), V(s * 0.2, 0.668, 0.078), V(s * 0.42, 0.598, 0.078)), 12, 0.0068, 6, false));
  const bar = new THREE.TubeGeometry(new THREE.LineCurve3(V(-0.42, 0.598, 0.078), V(0.42, 0.598, 0.078)), 2, 0.005, 6, false);
  return joinGeometries([hook, neck, ...arms, bar]);
}

/**
 * Mounts the 3D closet into `host`. Returns null when the browser has no WebGL, so the caller can show the list instead.
 * @param {HTMLElement} host
 * @param {{layers: Array<{slot:string, items:Array<object>}>}} anatomy  result of buildAnatomy()
 * @param {{colorOf:(c:string)=>string, nameOf:(cell:object)=>string, onPick:(cell:object)=>void, imageOf?:(cell:object)=>Promise<CanvasImageSource|null>|null,
 *   tags?:Record<string,{amount:number,currency:string,platform:string,platformName:string,priceType:string,source:string}>|null,
 *   money?:(n:number,c:string)=>string, overlay?:HTMLElement|null, label?:string}} opts
 */
export function mountCloset3d(host, anatomy, opts) {
  if (!webglOk()) return null;
  const shooting = navigator.webdriver === true; // screenshots read the canvas back; phones keep the cheaper default
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: shooting });
  } catch {
    return null;
  }
  const fmt = opts.money || ((n, c) => (c === 'KRW' ? `₩${Math.round(n).toLocaleString('en-US')}` : `${c === 'EUR' ? '€' : '$'}${Number(n).toFixed(2)}`));
  const dark = isDark();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps whites white and garment colours true below its knee
  renderer.toneMappingExposure = dark ? 0.92 : 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const el = renderer.domElement;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', opts.label || 'Closet in 3D');
  host.prepend(el);

  const bag = { geo: new Set(), mat: new Set(), tex: new Set() };
  const keepGeo = (g) => (bag.geo.add(g), g);
  const keepMat = (m) => (bag.mat.add(m), m);
  const keepTex = (t) => (bag.tex.add(t), t);
  const texOf = (c, srgb = true) => { const t = keepTex(new THREE.CanvasTexture(c)); if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = studioEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envScene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  scene.environment = envRT.texture;
  scene.environmentIntensity = dark ? 0.85 : 1.1;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xece8e1, 0.4));
  const key = new THREE.DirectionalLight(0xfff6ec, 1.5); // no shadow map: contact shadows are soft planes
  key.position.set(-5.5, 8, 7);
  scene.add(key);

  const T = { radial: texOf(radialCanvas(), false), fade: texOf(fadeCanvas(), false), glow: texOf(glowCanvas(), false) };
  const M = {
    gloss: keepMat(new THREE.MeshPhysicalMaterial({ color: 0xfbfaf8, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.07 })),
    satin: keepMat(new THREE.MeshStandardMaterial({ color: 0xf5f4f1, roughness: 0.55, metalness: 0 })),
    wall: keepMat(new THREE.MeshStandardMaterial({ color: 0xf7f6f3, roughness: 0.7 })),
    reveal: keepMat(new THREE.MeshStandardMaterial({ color: 0xd9d3c9, roughness: 0.8 })),
    brass: keepMat(new THREE.MeshStandardMaterial({ color: 0xe5d1ad, metalness: 1, roughness: 0.28 })),
    brassP: keepMat(new THREE.MeshStandardMaterial({ color: 0xe5d1ad, metalness: 1, roughness: 0.16 })),
    glass: keepMat(new THREE.MeshPhysicalMaterial({ color: 0xf2f6f7, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.18, depthWrite: false, envMap: envRT.texture, envMapIntensity: 1.6 })),
    glassTop: keepMat(new THREE.MeshPhysicalMaterial({ color: 0xf2f6f7, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.28, depthWrite: false, envMap: envRT.texture, envMapIntensity: 1.4 })),
    glassEdge: keepMat(new THREE.MeshStandardMaterial({ color: 0xcfdcd6, roughness: 0.2, transparent: true, opacity: 0.75 })),
    led: keepMat(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff0dc, emissiveIntensity: 2.4, roughness: 1 })),
    floor: keepMat(new THREE.MeshStandardMaterial({ color: 0xf4f1ec, roughness: 0.16, metalness: 0 })),
    island: keepMat(new THREE.MeshPhysicalMaterial({ color: 0xf4f1ec, roughness: 0.12, clearcoat: 0.5, clearcoatRoughness: 0.06 })),
    wash: keepMat(new THREE.MeshBasicMaterial({ map: T.fade, color: 0xfff3e2, transparent: true, opacity: 0.26, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })),
    backShadow: keepMat(new THREE.MeshBasicMaterial({ map: T.radial, color: 0x1c1915, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false })),
    shoeGlow: keepMat(new THREE.MeshBasicMaterial({ map: T.radial, color: 0xffe9cf, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })),
    halo: keepMat(new THREE.MeshBasicMaterial({ map: T.glow, color: 0xf37021, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false })),
    thread: keepMat(new THREE.LineBasicMaterial({ color: 0xbfa36b })),
    ghost: keepMat(new THREE.LineDashedMaterial({ color: 0xc9c1b4, dashSize: 0.14, gapSize: 0.1, transparent: true, opacity: 0 })),
  };
  const shadowMats = new Map();
  const shadowMat = (opacity, map = T.radial) => {
    const k = `${opacity}|${map.id}`;
    if (!shadowMats.has(k)) shadowMats.set(k, keepMat(new THREE.MeshBasicMaterial({ map, color: 0x1c1915, transparent: true, opacity, depthWrite: false, toneMapped: false })));
    return shadowMats.get(k);
  };
  const box = (w, h, d, mat, x, y, z, parent) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); parent.add(m); return m; };
  const plane = (w, h, mat, x, y, z, parent, rotX = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.x = rotX; parent.add(m); return m; };
  const rail = (r, len, mat, x, y, z, parent) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 18), mat); m.rotation.z = Math.PI / 2; m.position.set(x, y, z); parent.add(m); return m; };

  const root = new THREE.Group();
  root.rotation.set(REST.x, REST.y, 0);
  scene.add(root);

  // ---------- room, carcass, glass towers, island (static: merged by material) ----------
  const room = new THREE.Group();
  root.add(room);
  plane(24, 16, M.floor, 0, -3.6, 7.2, room, -Math.PI / 2);
  plane(14, 7.6, M.wall, 0, 0.2, -0.8, room);
  for (const x of [-5.4, -4.75, 4.75, 5.4]) box(0.012, 7.2, 0.01, M.reveal, x, 0, -0.79, room); // wall panel reveals
  box(8.4, 0.3, 1.6, M.gloss, 0, 3.45, 0, room); // crown
  box(8.2, 0.012, 0.03, M.led, 0, 3.29, 0.74, room); // cove LED under the crown front
  box(WIDTH, 6.6, 0.04, M.satin, 0, 0, -0.75, room); // bay back panel
  for (const s of [-1, 1]) {
    box(0.3, 6.6, 1.5, M.gloss, s * 2.6, 0, 0, room); // pilasters
    box(0.012, 6.4, 0.03, M.led, s * 2.443, 0, 0.62, room); // vertical LED on the pilaster's inner face
    box(1.2, 6.6, 0.04, M.satin, s * 3.4, 0, -0.75, room); // tower back
    box(0.1, 6.6, 1.5, M.gloss, s * 4.0, 0, 0, room); // tower outer side
    box(0.012, 6.4, 0.03, M.led, s * 3.94, 0, 0.6, room);
    for (const y of [1.65, 0.11, -1.44, -2.99]) { // lit glass shelves, left empty: nothing here looks like a piece the closet does not have
      box(1.1, 0.025, 1.1, M.glassTop, s * 3.4, y, -0.15, room);
      box(1.1, 0.026, 0.004, M.glassEdge, s * 3.4, y, 0.402, room);
    }
    plane(1.16, 6.5, M.glass, s * 3.38, 0, 0.77, room); // glass door
    for (const [w, h, x, y] of [[1.2, 0.035, s * 3.38, 3.25], [1.2, 0.035, s * 3.38, -3.25], [0.035, 6.5, s * 2.8, 0], [0.035, 6.5, s * 3.96, 0]]) box(w, h, 0.03, M.brass, x, y, 0.78, room);
    box(0.022, 0.9, 0.03, M.brassP, s * 2.88, 0.2, 0.8, room); // pull
  }
  box(8.1, 0.3, 1.38, M.gloss, 0, -3.45, -0.06, room); // recessed plinth
  const plinthShadow = plane(8.6, 0.6, shadowMat(0.32, T.fade), 0, -3.598, 0.95, room, -Math.PI / 2);
  plinthShadow.rotation.z = Math.PI; // darkest at the cabinet
  const island = new THREE.Group(); // front-left: in the foreground on desktop, out of frame on phones
  island.position.set(-4.4, -3.6, 3.7);
  room.add(island);
  box(2.6, 1.66, 1.3, M.gloss, 0, 0.83, 0, island);
  box(2.72, 0.08, 1.42, M.island, 0, 1.7, 0, island);
  for (const y of [0.42, 0.98]) {
    box(2.56, 0.008, 0.005, M.reveal, 0, y + 0.28, 0.652, island);
    for (const x of [-0.65, 0.65]) box(0.42, 0.018, 0.022, M.brassP, x, y, 0.665, island);
  }
  plane(3.3, 2.0, shadowMat(0.42), 0, 0.002, 0, island, -Math.PI / 2);
  for (const y of [3.28, 1.63, 0.08, -1.47]) plane(4.8, 0.9, M.wash, 0, y - 0.45, -0.725, room); // light washes under the crown and each shelf's home
  // ghost slots: where each shelf sits when closed (shown in the exploded view)
  const ghostPts = [];
  for (const slot of ['outer', 'top', 'bottom', 'shoes']) {
    const y = LAYER_Y[slot] - 0.66;
    const a = [[-WIDTH / 2, -0.68], [WIDTH / 2, -0.68], [WIDTH / 2, 0.6], [-WIDTH / 2, 0.6]];
    for (let i = 0; i < 4; i++) { const p = a[i]; const q = a[(i + 1) % 4]; ghostPts.push(new THREE.Vector3(p[0], y, p[1]), new THREE.Vector3(q[0], y, q[1])); }
  }
  const ghost = new THREE.LineSegments(keepGeo(new THREE.BufferGeometry().setFromPoints(ghostPts)), M.ghost);
  ghost.computeLineDistances();
  ghost.visible = false;
  root.add(ghost);

  // ---------- layers: shelf, light and pieces (one group per layer; the group moves in the exploded view) ----------
  const cardGeo = keepGeo(new THREE.PlaneGeometry(CARD_W, CARD_H));
  const hangerGeo = keepGeo(hangerGeometry());
  const tagGeo = keepGeo(new THREE.PlaneGeometry(0.36, 0.54));
  const haloGeo = keepGeo(new THREE.PlaneGeometry(CARD_W * 1.34, CARD_H * 1.28));
  let disposed = false;
  let invalidate = () => {};
  const groups = [];
  const entries = [];
  const fitPts = [];
  anatomy.layers.forEach((layer, index) => {
    const slot = layer.slot;
    const g = new THREE.Group();
    g.userData = { slot, index, entries: [] };
    root.add(g);
    groups.push(g);
    const statics = new THREE.Group();
    g.add(statics);
    box(WIDTH, 0.06, 1.28, M.satin, 0, -0.69, -0.04, statics); // the layer's own shelf
    box(WIDTH, 0.014, 0.014, M.brass, 0, -0.662, 0.605, statics); // champagne-brass front edge
    if (slot !== 'shoes') box(4.8, 0.012, 0.03, M.led, 0, -0.725, 0.56, statics); // LED under the front lip lights the layer below
    const hanging = slot === 'outer' || slot === 'top';
    if (hanging) {
      rail(0.024, 4.84, M.brass, 0, 0.76, 0, statics);
      for (const s of [-1, 1]) {
        rail(0.05, 0.02, M.brass, s * 2.43, 0.76, 0, statics); // end flanges
        box(0.02, 0.02, 0.72, M.brass, s * 2.43, 0.76, -0.37, statics); // bracket back to the panel
      }
      for (const s of [-1, 1]) fitPts.push([g, new THREE.Vector3(s * WIDTH / 2, 0.8, 0)]);
    }
    if (slot === 'shoes') {
      box(4.84, 0.03, 0.02, M.brassP, 0, -0.645, 0.6, statics); // brass lip
      box(4.8, 0.01, 0.02, M.led, 0, -0.655, 0.57, statics); // uplight LED
    }
    for (const sx of [-1, 1]) for (const sz of [-0.68, 0.6]) fitPts.push([g, new THREE.Vector3(sx * WIDTH / 2, -0.66, sz)]);
    mergeByMaterial(statics);
    statics.traverse((o) => { if (o.isMesh) keepGeo(o.geometry); });

    const n = layer.items.length;
    const step = n > 1 ? Math.min(0.98, (WIDTH - CARD_W) / (n - 1)) : 0;
    layer.items.forEach((cell, i) => {
      const baseX = (i - (n - 1) / 2) * step;
      const holder = new THREE.Group();
      holder.position.x = baseX;
      g.add(holder);
      // Hanging pieces centre on the rail; folded bottoms stand on their block; shoes stand on the lit shelf.
      const cy = hanging ? 0 : slot === 'bottom' ? -0.55 + CARD_H / 2 : -0.656 + CARD_H / 2;
      const fill = opts.colorOf(cell.color);
      const mat = keepMat(new THREE.MeshBasicMaterial({ map: cardTexture(cell, fill, opts.nameOf(cell)), transparent: true, side: THREE.DoubleSide, toneMapped: false }));
      const mesh = new THREE.Mesh(cardGeo, mat);
      mesh.position.set(0, cy, 0.05 + i * 0.004);
      mesh.userData = { cell };
      holder.add(mesh);
      const entry = { cell, holder, mesh, baseX, cy, block: null, tag: null };
      if (hanging) {
        const hanger = new THREE.Mesh(hangerGeo, M.brassP);
        hanger.position.z = i * 0.004;
        holder.add(hanger);
        plane(1.05, 1.3, M.backShadow, 0.05, -0.08, -0.69, holder); // soft drop shadow on the back panel
      } else if (slot === 'bottom') { // one folded block per piece, in its own colour: never a pile
        const shape = new THREE.Shape();
        const w = 0.86;
        const hh = 0.11;
        const r = 0.035;
        shape.moveTo(-w / 2 + r, -hh / 2);
        shape.lineTo(w / 2 - r, -hh / 2);
        shape.quadraticCurveTo(w / 2, -hh / 2, w / 2, -hh / 2 + r);
        shape.lineTo(w / 2, hh / 2 - r);
        shape.quadraticCurveTo(w / 2, hh / 2, w / 2 - r, hh / 2);
        shape.lineTo(-w / 2 + r, hh / 2);
        shape.quadraticCurveTo(-w / 2, hh / 2, -w / 2, hh / 2 - r);
        shape.lineTo(-w / 2, -hh / 2 + r);
        shape.quadraticCurveTo(-w / 2, -hh / 2, -w / 2 + r, -hh / 2);
        const bm = keepMat(new THREE.MeshStandardMaterial({ color: new THREE.Color().setStyle(fill), roughness: 0.92, transparent: true }));
        entry.block = new THREE.Mesh(keepGeo(new THREE.ExtrudeGeometry(shape, { depth: 0.48, bevelEnabled: false, curveSegments: 3 })), bm);
        entry.block.position.set(0, -0.605, -0.2);
        holder.add(entry.block);
        plane(1.0, 0.62, shadowMat(0.25), 0, -0.658, 0.04, holder, -Math.PI / 2);
      } else { // shoes: contact shadow and an uplight glow on the back panel
        plane(0.92, 0.24, shadowMat(0.38), 0, -0.657, 0.1, holder, -Math.PI / 2);
        plane(1.1, 0.8, M.shoeGlow, 0, -0.2, -0.6, holder);
      }
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) fitPts.push([mesh, new THREE.Vector3((dx * CARD_W) / 2, (dy * CARD_H) / 2, 0)]);
      g.userData.entries.push(entry);
      entries.push(entry);
    });
  });
  mergeByMaterial(room);
  room.traverse((o) => { if (o.isMesh) keepGeo(o.geometry); });
  // per-piece meshes made by plane() use their own geometry
  for (const e of entries) e.holder.traverse((o) => { if (o.isMesh && o.geometry !== cardGeo && o.geometry !== hangerGeo) keepGeo(o.geometry); });

  function cardTexture(cell, fill, name) {
    const c = canvasOf(256, 320);
    drawCard(c, cell, fill, name, null);
    const t = texOf(c);
    t.anisotropy = 4;
    const pending = opts.imageOf ? opts.imageOf(cell) : null;
    if (pending && typeof pending.then === 'function') {
      pending.then((photo) => {
        if (!photo || disposed) return;
        drawCard(c, cell, fill, name, photo);
        t.needsUpdate = true;
        invalidate();
      }).catch(() => {});
    }
    return t;
  }

  // ---------- price tags: one per piece with a ledger row, hanging on a fine gold thread ----------
  function clearTags() {
    for (const e of entries) {
      if (!e.tag) continue;
      e.holder.remove(e.tag.group);
      e.tag.mat.map.dispose();
      e.tag.mat.dispose();
      e.tag.line.geometry.dispose();
      bag.tex.delete(e.tag.mat.map);
      bag.mat.delete(e.tag.mat);
      e.tag = null;
    }
  }
  function setTags(tags) {
    clearTags();
    for (const e of entries) {
      const row = tags && tags[e.cell.itemId];
      if (!row || typeof row.amount !== 'number') continue;
      const c = canvasOf(256, 384);
      drawTag(c, row, fmt);
      const t = texOf(c);
      t.anisotropy = 4;
      const mat = keepMat(new THREE.MeshBasicMaterial({ map: t, transparent: true, alphaTest: 0.04, toneMapped: false, side: THREE.DoubleSide }));
      const group = new THREE.Group(); // anchored at the piece's right shoulder; the tag hangs below the anchor
      group.position.set(CARD_W / 2 - 0.2, e.cy + CARD_H / 2 - 0.05, 0.1);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.07, -0.13, 0.004)]), M.thread);
      const tag = new THREE.Mesh(tagGeo, mat);
      tag.position.set(0.07, -0.13 - 0.27 + 0.065, 0.004); // eyelet (46 of 384 px from the top) under the thread's end
      tag.rotation.z = -0.07;
      group.add(line, tag);
      e.holder.add(group);
      e.tag = { group, mat, line, base: group.position.clone() };
    }
    paint();
    refit(false);
  }

  // ---------- selection halo ----------
  const halo = new THREE.Mesh(haloGeo, M.halo);
  halo.visible = false;

  // ---------- layout, isolation and selection ----------
  let explode = 0;
  let selected = null;
  let picked = new Set();
  function layout() {
    for (const g of groups) {
      const { slot, index } = g.userData;
      g.position.set(0, (LAYER_Y[slot] ?? 0) + explode * (SPREAD_Y[slot] ?? 0), explode * (1.7 - index * 0.6));
      for (const e of g.userData.entries) {
        e.holder.position.x = e.baseX * (1 + 0.3 * explode);
        e.holder.rotation.y = explode * 0.38;
      }
    }
    M.wash.opacity = 0.26 * (1 - explode);
    M.backShadow.opacity = 0.16 * (1 - explode);
    M.shoeGlow.opacity = 0.35 * (1 - explode);
    M.ghost.opacity = 0.6 * explode;
    ghost.visible = explode > 0.01;
  }
  // Isolation view: once an outfit is being picked, every other card fades back.
  function paint() {
    for (const e of entries) {
      const id = e.cell.itemId;
      const isSel = e === selected;
      const on = picked.size === 0 || picked.has(id) || isSel;
      const a = on ? 1 : 0.22;
      e.mesh.material.opacity = a;
      if (e.block) e.block.material.opacity = a;
      if (e.tag) {
        e.tag.mat.opacity = a;
        // The selected piece's tag swings out and grows so its amount can be read.
        e.tag.group.scale.setScalar(isSel ? 1.75 : 1);
        e.tag.group.position.set(e.tag.base.x + (isSel ? 0.24 : 0), e.tag.base.y, e.tag.base.z + (isSel ? 0.06 : 0));
      }
      const k = isSel ? 1.12 : picked.has(id) ? 1.06 : 1;
      e.holder.scale.setScalar(k);
      e.holder.position.z = isSel ? 0.06 : 0;
    }
    if (selected) {
      selected.holder.add(halo);
      halo.position.set(0.0, selected.cy - 0.03, 0.02);
      halo.visible = true;
    } else {
      if (halo.parent) halo.parent.remove(halo);
      halo.visible = false;
    }
    invalidate();
  }
  function select(entry) {
    selected = entry;
    paint();
  }

  // ---------- camera fit: the pieces fit the part of the stage the overlay leaves free ----------
  const size = { w: 1, h: 1 };
  let view = { d: 18, off: [0, 0] };
  function freeRect() {
    const W = size.w;
    const H = size.h;
    const ov = opts.overlay && host.contains(opts.overlay) ? opts.overlay.getBoundingClientRect() : null;
    if (ov && ov.width > 0 && ov.height > 0) {
      const hr = el.getBoundingClientRect();
      if (ov.width >= W * 0.6) { const y = Math.min(H * 0.45, ov.bottom - hr.top + 6); return { x: 12, y, w: W - 24, h: H - y - 12 }; }
      const x = Math.min(W * 0.5, ov.right - hr.left + 16);
      return { x, y: 18, w: W - x - 18, h: H - 36 };
    }
    return { x: 12, y: 14, w: W - 24, h: H - 28 };
  }
  function place(d, off) {
    camera.position.set(0, 0, d);
    camera.lookAt(0, 0, 0);
    if (off) camera.setViewOffset(size.w, size.h, off[0], off[1], size.w, size.h);
    else camera.clearViewOffset();
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
  }
  function computeFit() {
    const rect = freeRect();
    root.updateMatrixWorld(true);
    const world = fitPts.map(([o, v]) => v.clone().applyMatrix4(o.matrixWorld));
    const p = new THREE.Vector3();
    const bbox = () => {
      let x0 = 1e9; let y0 = 1e9; let x1 = -1e9; let y1 = -1e9;
      for (const v of world) {
        p.copy(v).project(camera);
        const x = ((p.x + 1) / 2) * size.w;
        const y = ((1 - p.y) / 2) * size.h;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { x0, y0, x1, y1 };
    };
    let lo = 1;
    let hi = 120;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      place(mid);
      const b = bbox();
      if (b.x1 - b.x0 <= rect.w && b.y1 - b.y0 <= rect.h) hi = mid; else lo = mid;
    }
    place(hi);
    const b = bbox();
    return { d: hi, off: [-(rect.x + rect.w / 2 - (b.x0 + b.x1) / 2), -(rect.y + rect.h / 2 - (b.y0 + b.y1) / 2)] };
  }
  let ease = null;
  let intro = null;
  function refit(animate) {
    const next = computeFit();
    if (animate && !intro) ease = { from: { d: view.d, off: view.off.slice() }, to: next, t0: performance.now(), dur: 200 };
    else { ease = null; view = next; }
    if (!intro) place(view.d, view.off);
    invalidate();
  }

  // ---------- intro dolly: once per session, skipped on reduced motion and in automated browsers ----------
  function wantIntro() {
    if (shooting) return false;
    try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch { /* no matchMedia */ }
    try {
      if (sessionStorage.getItem('closer.3d.intro')) return false;
      sessionStorage.setItem('closer.3d.intro', '1');
    } catch { /* storage blocked: still play it once for this mount */ }
    return true;
  }
  function skipIntro() {
    if (!intro) return;
    intro = null;
    root.rotation.y = REST.y;
    place(view.d, view.off);
    invalidate();
  }

  // ---------- render on demand ----------
  let frame = 0;
  let painted = false;
  const easeOut = (t) => 1 - (1 - t) ** 3;
  invalidate = () => { if (!frame && !disposed) frame = requestAnimationFrame(draw); };
  function draw(now) {
    frame = 0;
    if (disposed) return;
    let again = false;
    if (intro) {
      const k = easeOut(Math.min(1, (now - intro.t0) / intro.dur));
      root.rotation.y = -0.05 + (REST.y + 0.05) * k;
      place(view.d * (1 + 0.45 * (1 - k)), [view.off[0] * (0.5 + 0.5 * k), view.off[1] * (0.5 + 0.5 * k)]);
      if (k >= 1) intro = null; else again = true;
    } else if (ease) {
      const k = easeOut(Math.min(1, (now - ease.t0) / ease.dur));
      view = { d: ease.from.d + (ease.to.d - ease.from.d) * k, off: [0, 1].map((i) => ease.from.off[i] + (ease.to.off[i] - ease.from.off[i]) * k) };
      place(view.d, view.off);
      if (k >= 1) { view = ease.to; ease = null; } else again = true;
    }
    renderer.render(scene, camera);
    el.dataset.calls = String(renderer.info.render.calls);
    el.dataset.triangles = String(renderer.info.render.triangles);
    if (!painted) {
      painted = true;
      host.dataset.painted = '1';
      afterFirstFrame();
    }
    if (again) invalidate();
  }
  // The marble is drawn after the first frame; until then the floor is a flat warm white.
  function afterFirstFrame() {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 0));
    idle(() => {
      if (disposed) return;
      const marble = marbleCanvas(size.w >= 761 ? 512 : 256);
      const floorTex = texOf(marble);
      floorTex.wrapS = THREE.MirroredRepeatWrapping;
      floorTex.wrapT = THREE.RepeatWrapping;
      floorTex.repeat.set(8, 5);
      floorTex.anisotropy = 4;
      const islandTex = texOf(marble);
      islandTex.repeat.set(0.55, 0.3);
      islandTex.offset.set(0.2, 0.35);
      islandTex.rotation = 0.5;
      islandTex.center.set(0.5, 0.5);
      for (const [m, t] of [[M.floor, floorTex], [M.island, islandTex]]) { m.map = t; m.color.set(0xffffff); m.needsUpdate = true; }
      invalidate();
    });
  }

  function resize() {
    const w = Math.max(280, Math.round(host.clientWidth || 360));
    // Phones get a taller stage so the four layers and the cards stay readable.
    const h = Math.round(w < 480 ? Math.min(640, w * 1.45) : Math.min(600, Math.max(420, w * 0.52)));
    if (w === size.w && h === size.h) return;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    refit(false);
  }

  // ---------- pointer: drag to turn, tap to pick (cards only: glass and tags never block a tap) ----------
  el.style.touchAction = 'pan-y';
  const ray = new THREE.Raycaster();
  const cards = entries.map((e) => e.mesh);
  let down = null;
  const onDown = (e) => { skipIntro(); down = { x: e.clientX, ry: root.rotation.y, moved: false }; };
  const onMove = (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (Math.abs(dx) > 5) down.moved = true;
    if (down.moved) { root.rotation.y = Math.max(-1.1, Math.min(1.1, down.ry + dx * 0.006)); invalidate(); }
  };
  const onUp = (e) => {
    const was = down;
    down = null;
    if (!was) return;
    if (was.moved) { refit(true); return; }
    const r = el.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(cards, false)[0];
    if (hit) {
      select(entries.find((x) => x.mesh === hit.object) || null);
      opts.onPick(hit.object.userData.cell);
    }
  };
  const onCancel = () => { if (down && down.moved) refit(true); down = null; };
  const onKey = () => skipIntro();
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', onCancel);
  window.addEventListener('keydown', onKey);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(host);

  layout();
  resize();
  setTags(opts.tags || null);
  if (wantIntro()) {
    intro = { t0: performance.now(), dur: 1400 };
    root.rotation.y = -0.05;
  }
  invalidate();

  const api = {
    cardCount: cards.length,
    setExplode(v) {
      skipIntro();
      explode = Math.max(0, Math.min(1, Number(v) || 0));
      layout();
      refit(false);
    },
    /** Back to the opening view: closed layers, the resting turn. */
    reset() {
      skipIntro();
      root.rotation.set(REST.x, REST.y, 0);
      explode = 0;
      layout();
      refit(true);
    },
    select(itemId) { select(entries.find((e) => e.cell.itemId === itemId) || null); },
    setPicked(ids) { picked = new Set(ids); paint(); },
    /** Price tags from the closet ledger: { [itemId]: LedgerRow }. Pieces without a row get no tag. */
    setTags(tags) { setTags(tags || null); },
    /** Draw calls and triangles of the last frame (renderer.info). */
    info() { return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries }; },
    /** Where a piece's card centre is on the canvas, in CSS pixels (for scripted taps and screenshots). */
    where(itemId) {
      const e = entries.find((x) => x.cell.itemId === itemId);
      if (!e) return null;
      const v = new THREE.Vector3();
      e.mesh.getWorldPosition(v).project(camera);
      return { x: ((v.x + 1) / 2) * size.w, y: ((1 - v.y) / 2) * size.h };
    },
    state() { return { explode, selected: selected ? selected.cell.itemId : null, picked: [...picked], tags: entries.filter((e) => e.tag).map((e) => e.cell.itemId), intro: !!intro }; },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (ro) ro.disconnect();
      window.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onCancel);
      clearTags();
      scene.traverse((o) => { if (o.geometry) bag.geo.add(o.geometry); });
      for (const g of bag.geo) g.dispose();
      for (const m of bag.mat) m.dispose();
      for (const t of bag.tex) t.dispose();
      envRT.dispose();
      renderer.dispose();
      delete el.closet3d;
    },
  };
  el.closet3d = api; // handle for scripted checks: document.querySelector('.stage-luxe canvas').closet3d
  return api;
}
