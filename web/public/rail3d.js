// The boutique rail in 3D (three.js 0.170.0, core build), extended with an optional Walk-In Vault
// for 3D Walk-Around camera presets, 360-degree orbit, tactile hand-rifling, and counted rotation highlights.
// In Front mode the stage stays a quiet white gallery wall; switching to Walk-Around, Left/Right Wing,
// Overhead, or 360-degree spin reveals the surrounding walk-in cabinetry, marble island, mirror, and bench.
// Every tag shows only facts from the closet ledger (price rows, confirmed wears, availability, Today pin).
import * as THREE from './vendor/three.module.min.js';
import { buildGarment, disposeGarmentCache } from './garments.js';
import { RAIL, railLayout, rotationHeatOf, tagOf, tagWords } from './rail.js';

const WALL_Z = -0.36;
const SHOE_Z = 0.42;
const HOOK_Y = RAIL.railY + 0.0125 + 0.0056;
const UNAVAILABLE = { LAUNDRY: 'Laundry', REPAIR: 'Repair', STORED: 'Stored' };
const RACK_TURN = -0.44;
const PART = 0.15;

export const CAMERA_PRESETS = {
  front: { az: 0, pol: 0, dist: 1.0 },
  walk: { az: -0.46, pol: 0.19, dist: 1.18 },
  left: { az: -0.74, pol: 0.15, dist: 1.16 },
  right: { az: 0.74, pol: 0.15, dist: 1.16 },
  overhead: { az: 0, pol: 0.52, dist: 1.28 },
};

function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Soft white photo studio rendered once into a PMREM environment. */
function studio() {
  const env = new THREE.Scene();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const add = (color, k, s, p, side = THREE.FrontSide) => {
    const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side }));
    m.scale.set(...s);
    m.position.set(...p);
    env.add(m);
  };
  add(0xf6f5f2, 0.75, [24, 12, 24], [0, 4, 0], THREE.BackSide);
  add(0xe4e0d9, 0.45, [24, 0.1, 24], [0, -1.95, 0]);
  add(0xfffbf5, 8, [10, 0.1, 2.4], [0, 9.9, 1]);
  add(0xfffbf5, 5, [0.1, 4, 7], [-11.9, 4, 3]);
  add(0xf3f5ff, 2, [0.1, 3, 6], [11.9, 3.5, 1]);
  add(0xfffbf5, 3.2, [12, 4, 0.1], [0, 3, 11.9]);
  return env;
}

/** Procedural Calacatta Gold veined marble texture (zero external image requests). */
function makeMarbleTex(renderer) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#faf8f4';
  ctx.fillRect(0, 0, 256, 256);
  const veins = [
    ['rgba(182, 174, 163, 0.24)', 5],
    ['rgba(197, 165, 114, 0.20)', 2.2],
    ['rgba(243, 112, 33, 0.08)', 1.2],
  ];
  veins.forEach(([col, lw], idx) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let x = (i * 53 + idx * 29) % 256;
      let y = 0;
      ctx.moveTo(x, y);
      while (y < 256) {
        y += 26;
        x += Math.sin(y * 0.05 + i) * 16 + 7;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** Procedural warm European oak parquet texture for the Walk-In Vault floor runner. */
function makeOakParquetTex(renderer) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ded0bc';
  ctx.fillRect(0, 0, 256, 256);
  const tones = ['#e3d6c3', '#d9cab4', '#d1bfa6', '#e7dccb'];
  const pw = 32;
  const ph = 10;
  for (let y = 0; y < 256; y += ph) {
    for (let x = 0; x < 256; x += pw) {
      const idx = ((x / pw) * 3 + y / ph) % tones.length;
      ctx.fillStyle = tones[Math.floor(idx)];
      ctx.fillRect(x, y, pw - 1, ph - 1);
      ctx.strokeStyle = 'rgba(110, 82, 52, 0.14)';
      ctx.lineWidth = 0.7;
      ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 5);
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** Builds the surrounding Walk-In Vault architecture (wings, marble island, mirror, bench, LEDs). */
function buildVaultGroup(half, G, Mt, Tex, renderer) {
  const vault = new THREE.Group();
  const marbleTex = Tex(makeMarbleTex(renderer));
  const oakTex = Tex(makeOakParquetTex(renderer));

  const lacquerMat = Mt(new THREE.MeshStandardMaterial({ color: 0xfbfaf7, roughness: 0.34, metalness: 0.04 }));
  const walnutMat = Mt(new THREE.MeshStandardMaterial({ color: 0x6b4e38, roughness: 0.58, metalness: 0.05 }));
  const brassMat = Mt(new THREE.MeshStandardMaterial({ color: 0xd4b27a, roughness: 0.24, metalness: 0.86 }));
  const saddleMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf37021, roughness: 0.48, metalness: 0.04 }));
  const creamBoxMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf2ece1, roughness: 0.65 }));
  const marbleMat = Mt(new THREE.MeshStandardMaterial({ map: marbleTex, roughness: 0.22, metalness: 0.04 }));
  const parquetMat = Mt(new THREE.MeshStandardMaterial({ map: oakTex, roughness: 0.62, metalness: 0.02 }));
  const mirrorMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.05, metalness: 0.94 }));
  const ledMat = Mt(new THREE.MeshBasicMaterial({ color: 0xffe5b8 }));

  const spanW = Math.max(4.4, half * 2 + 0.9);

  // Oak parquet floor zone under the walk-in room
  const runner = new THREE.Mesh(G(new THREE.PlaneGeometry(spanW + 3.2, 4.8)), parquetMat);
  runner.rotation.x = -Math.PI / 2;
  runner.position.set(0, 0.002, 1.35);
  runner.receiveShadow = true;
  vault.add(runner);

  // Back cabinetry top shelf + recessed warm LED strip above the main boutique rail
  const topShelf = new THREE.Mesh(G(new THREE.BoxGeometry(spanW, 0.038, 0.34)), lacquerMat);
  topShelf.position.set(0, RAIL.railY + 0.29, WALL_Z + 0.17);
  topShelf.castShadow = true;
  const topTrim = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 0.02, 0.014, 0.018)), brassMat);
  topTrim.position.set(0, RAIL.railY + 0.29, WALL_Z + 0.34);
  const topLed = new THREE.Mesh(G(new THREE.BoxGeometry(spanW - 0.16, 0.012, 0.03)), ledMat);
  topLed.position.set(0, RAIL.railY + 0.268, WALL_Z + 0.24);
  vault.add(topShelf, topTrim, topLed);

  // Tailored storage boxes along the upper shelf
  const nBoxes = Math.max(3, Math.min(6, Math.floor(spanW / 0.95)));
  for (let i = 0; i < nBoxes; i++) {
    const bx = -((nBoxes - 1) * 0.78) / 2 + i * 0.78;
    const isAccent = i % 3 === 1;
    const box = new THREE.Mesh(G(new THREE.BoxGeometry(0.38, 0.14, 0.26)), isAccent ? saddleMat : creamBoxMat);
    box.position.set(bx, RAIL.railY + 0.38, WALL_Z + 0.17);
    box.castShadow = true;
    const lid = new THREE.Mesh(G(new THREE.BoxGeometry(0.395, 0.024, 0.275)), isAccent ? lacquerMat : brassMat);
    lid.position.set(bx, RAIL.railY + 0.455, WALL_Z + 0.17);
    vault.add(box, lid);
  }

  // Calacatta Gold marble central island with saddle valet tray
  const islandZ = 1.62;
  const islandW = Math.min(1.85, Math.max(1.25, spanW * 0.34));
  const islandGroup = new THREE.Group();
  islandGroup.position.set(0, 0, islandZ);
  const islandBody = new THREE.Mesh(G(new THREE.BoxGeometry(islandW, 0.44, 0.66)), lacquerMat);
  islandBody.position.y = 0.22;
  islandBody.castShadow = true;
  islandBody.receiveShadow = true;
  const islandTop = new THREE.Mesh(G(new THREE.BoxGeometry(islandW + 0.06, 0.036, 0.72)), marbleMat);
  islandTop.position.y = 0.458;
  islandTop.castShadow = true;
  islandTop.receiveShadow = true;
  const islandPlinth = new THREE.Mesh(G(new THREE.BoxGeometry(islandW - 0.04, 0.028, 0.62)), brassMat);
  islandPlinth.position.y = 0.014;
  const valetTray = new THREE.Mesh(G(new THREE.BoxGeometry(0.36, 0.024, 0.24)), saddleMat);
  valetTray.position.set(-islandW * 0.22, 0.488, 0.02);
  const displayStand = new THREE.Mesh(G(new THREE.CylinderGeometry(0.045, 0.052, 0.065, 20)), brassMat);
  displayStand.position.set(islandW * 0.24, 0.508, -0.03);
  islandGroup.add(islandBody, islandTop, islandPlinth, valetTray, displayStand);
  vault.add(islandGroup);

  // Left & Right architectural Walk-In Wing Bays
  const wingX = half + 0.92;
  for (const side of [-1, 1]) {
    const isLeft = side < 0;
    const wing = new THREE.Group();
    wing.position.set(side * wingX, 0, 0.78);
    wing.rotation.y = isLeft ? Math.PI / 2.28 : -Math.PI / 2.28;

    const backPanel = new THREE.Mesh(G(new THREE.BoxGeometry(2.35, 2.46, 0.12)), lacquerMat);
    backPanel.position.set(0, 1.23, -0.08);
    backPanel.receiveShadow = true;
    const alcove = new THREE.Mesh(G(new THREE.BoxGeometry(1.92, 1.96, 0.16)), walnutMat);
    alcove.position.set(0, 1.12, 0.02);
    const frameTop = new THREE.Mesh(G(new THREE.BoxGeometry(2.0, 0.026, 0.22)), brassMat);
    frameTop.position.set(0, 2.11, 0.05);
    const wingLed = new THREE.Mesh(G(new THREE.BoxGeometry(1.84, 0.014, 0.04)), ledMat);
    wingLed.position.set(0, 2.06, 0.12);
    const wingRod = new THREE.Mesh(G(new THREE.CylinderGeometry(0.013, 0.013, 1.76, 20)), brassMat);
    wingRod.rotation.z = Math.PI / 2;
    wingRod.position.set(0, 1.66, 0.18);
    wing.add(backPanel, alcove, frameTop, wingLed, wingRod);

    const tones = isLeft ? [0x222936, 0xc8b396, 0x3b3835] : [0xdfd5c5, 0x2c3b33, 0x262524];
    [-0.52, 0, 0.52].forEach((gx, idx) => {
      const coatMat = Mt(new THREE.MeshStandardMaterial({ color: tones[idx], roughness: 0.78 }));
      const stem = new THREE.Mesh(G(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 8)), brassMat);
      stem.position.set(gx, 1.60, 0.18);
      const shoulder = new THREE.Mesh(G(new THREE.BoxGeometry(0.28, 0.84, 0.09)), coatMat);
      shoulder.position.set(gx, 1.14, 0.18);
      shoulder.rotation.y = isLeft ? 0.34 : -0.34;
      wing.add(stem, shoulder);
    });

    vault.add(wing);
  }

  // Left forefront beveled brass floor mirror
  const mirror = new THREE.Group();
  mirror.position.set(-(half + 0.52), 0, 1.98);
  mirror.rotation.y = 0.48;
  const mFrame = new THREE.Mesh(G(new THREE.BoxGeometry(0.68, 1.88, 0.04)), brassMat);
  mFrame.position.y = 0.94;
  mFrame.castShadow = true;
  const mGlass = new THREE.Mesh(G(new THREE.BoxGeometry(0.61, 1.80, 0.046)), mirrorMat);
  mGlass.position.y = 0.94;
  mirror.add(mFrame, mGlass);
  vault.add(mirror);

  // Right forefront alabaster & walnut valet bench
  const bench = new THREE.Group();
  bench.position.set(half + 0.52, 0, 1.98);
  bench.rotation.y = -0.44;
  const cushion = new THREE.Mesh(G(new THREE.BoxGeometry(0.86, 0.10, 0.36)), lacquerMat);
  cushion.position.y = 0.42;
  cushion.castShadow = true;
  const base = new THREE.Mesh(G(new THREE.BoxGeometry(0.82, 0.06, 0.33)), walnutMat);
  base.position.y = 0.34;
  for (const lx of [-0.34, 0.34]) {
    const leg = new THREE.Mesh(G(new THREE.BoxGeometry(0.035, 0.32, 0.28)), brassMat);
    leg.position.set(lx, 0.16, 0);
    bench.add(leg);
  }
  bench.add(cushion, base);
  vault.add(bench);

  // Overhead skylight brass coffer frame
  const coffer = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 1.8, 0.04, 2.8)), brassMat);
  coffer.position.set(0, 2.66, 0.72);
  vault.add(coffer);

  vault.visible = false;
  return vault;
}

/** Wooden hanger with a polished hook for a photo cut-out. Hook top at y = 0. */
function photoHanger(wood, metal, slot, planeW = 0.43) {
  const g = new THREE.Group();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.0028, 8, 20, Math.PI * 1.25), metal);
  hook.rotation.z = -Math.PI * 0.12;
  hook.position.set(0, -0.026, 0);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.055, 8), metal);
  stem.position.set(0, -0.072, 0);
  g.add(hook, stem);
  if (slot === 'bottom') {
    const bSpan = Math.min(0.34, Math.max(0.15, planeW * 0.88));
    const bar = new THREE.Mesh(new THREE.BoxGeometry(bSpan, 0.024, 0.018), wood);
    bar.position.set(0, -0.112, 0.004);
    g.add(bar);
    const cx = bSpan * 0.35;
    for (const sx of [-cx, cx]) {
      const clip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.036, 0.024), metal);
      clip.position.set(sx, -0.128, 0.008);
      g.add(clip);
    }
    return g;
  }
  const span = Math.min(0.215, Math.max(0.065, planeW * 0.46));
  const drop = span < 0.12 ? -0.125 : -0.15;
  const arm = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(V(-span, drop, 0), V(0, -0.075, 0), V(span, drop, 0)), 24, 0.011, 10, false), wood);
  g.add(arm);
  return g;
}

/**
 * Mounts the rail into `host`. Returns null without WebGL, so the caller can show the 2D grid instead.
 */
export function mountRail3d(host, pieces, opts = {}) {
  if (!webglOk()) return null;
  const shooting = navigator.webdriver === true;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: shooting });
  } catch {
    return null;
  }
  const phone = () => host.clientWidth < 640;
  const still = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const el = renderer.domElement;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', opts.label || 'Closet on a rail');
  host.prepend(el);
  const tagLayer = document.createElement('div');
  tagLayer.className = 'rail-tags';
  tagLayer.setAttribute('aria-hidden', 'true');
  host.append(tagLayer);

  const made = { geo: new Set(), mat: new Set(), tex: new Set() };
  const G = (g) => (made.geo.add(g), g);
  const Mt = (m) => (made.mat.add(m), m);
  const Tex = (t) => (made.tex.add(t), t);

  const scene = new THREE.Scene();
  const bgGallery = new THREE.Color(0xf4f2ee);
  const bgVault = new THREE.Color(0xf8f6f1);
  scene.background = bgGallery.clone();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = studio();
  const envRT = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envScene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.95;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe7e2da, 0.32));

  let heatMode = Boolean(opts.heatMode ?? opts.heat);
  let sortMode = opts.sort || 'rack';
  let pinnedIds = new Set(opts.pinned || []);
  const layout = railLayout(pieces, opts.tags || null, { sort: sortMode, withHeat: true });
  const half = layout.railLength / 2;
  const key = new THREE.DirectionalLight(0xfff6ec, 1.55);
  key.position.set(-1.4, 4.4, 3.6);
  key.target.position.set(0, 1.0, WALL_Z);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -half - 1.5, right: half + 1.5, top: 2.6, bottom: -2.4, near: 0.5, far: 14 });
  key.shadow.radius = 9;
  key.shadow.blurSamples = 8;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  scene.add(key, key.target);

  // Room: quiet white studio wall and floor
  const wallMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf6f5f2, roughness: 0.97 }));
  const floorMat = Mt(new THREE.MeshStandardMaterial({ color: 0xeeebe5, roughness: 0.82 }));
  const skirtMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf1efea, roughness: 0.6 }));
  const W = layout.railLength + 16;
  const wall = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 6)), wallMat);
  wall.position.set(0, 2.6, WALL_Z);
  wall.receiveShadow = true;
  const floor = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 12)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 4.6);
  floor.receiveShadow = true;
  const skirt = new THREE.Mesh(G(new THREE.BoxGeometry(W, 0.09, 0.016)), skirtMat);
  skirt.position.set(0, 0.045, WALL_Z + 0.008);
  skirt.receiveShadow = true;
  scene.add(wall, floor, skirt);

  // Surrounding 3D Walk-In Vault (shown automatically in Walk-Around / Wing / Overhead / Spin views)
  const vaultGroup = buildVaultGroup(half, G, Mt, Tex, renderer);
  scene.add(vaultGroup);

  // Main boutique rail: polished steel on two wall brackets
  const chrome = Mt(new THREE.MeshStandardMaterial({ color: 0xf2f2f4, metalness: 1, roughness: 0.13 }));
  const wood = Mt(new THREE.MeshStandardMaterial({ color: 0xcaa67a, roughness: 0.5 }));
  const spotlightRingMat = Mt(new THREE.MeshBasicMaterial({ color: 0xf37021, transparent: true, opacity: 0.34, side: THREE.DoubleSide }));
  const rail = new THREE.Mesh(G(new THREE.CylinderGeometry(0.0125, 0.0125, layout.railLength, 32)), chrome);
  rail.rotation.z = Math.PI / 2;
  rail.position.set(0, RAIL.railY, 0);
  rail.castShadow = true;
  scene.add(rail);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(G(new THREE.CylinderGeometry(0.0095, 0.0095, -WALL_Z, 20)), chrome);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(s * (half - 0.03), RAIL.railY, WALL_Z / 2);
    arm.castShadow = true;
    const flange = new THREE.Mesh(G(new THREE.CylinderGeometry(0.034, 0.034, 0.012, 32)), chrome);
    flange.rotation.x = Math.PI / 2;
    flange.position.set(s * (half - 0.03), RAIL.railY, WALL_Z + 0.006);
    const cap = new THREE.Mesh(G(new THREE.SphereGeometry(0.0165, 20, 12)), chrome);
    cap.position.set(s * half, RAIL.railY, 0);
    scene.add(arm, flange, cap);
  }

  // Pieces
  const byId = new Map(pieces.map((p) => [p.itemId, p]));
  const entries = [];
  let disposed = false;
  let selectedItemId = null;
  const quality = phone() ? 'low' : 'high';
  const rgbFor = (p) => {
    const rgb = Array.isArray(p.rgb) && p.rgb.length === 3 ? p.rgb : [190, 190, 190];
    if (p.availability && p.availability !== 'AVAILABLE') return rgb.map((v) => Math.round(v + (246 - v) * 0.55));
    return rgb;
  };
  const shadowsOn = (o) => o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });

  function buildTagNode(itemId, words, state, heat, spotlight, isPinned) {
    const showHeatBadge = heatMode && heat && (heat.tier === 'cold' || Boolean(words) || (sortMode === 'worn' && heat.tier === 'hot'));
    if (!words && !state && !showHeatBadge && !isPinned) return null;
    const t = document.createElement('button');
    t.type = 'button';
    t.dataset.itemId = itemId;
    const cls = ['rail-tag', 'is-interactive'];
    if (words && words.mark) cls.push('is-sample');
    if (state) cls.push('has-state');
    if (selectedItemId === itemId) cls.push('is-selected');
    if (isPinned) cls.push('is-pinned');
    if (spotlight) cls.push('is-spotlight');
    if (heatMode && heat) cls.push(`heat-${heat.tier}`);
    t.className = cls.join(' ');
    if (words) {
      const b = document.createElement('b');
      b.textContent = words.amount;
      t.append(b);
      if (words.mark) { const i = document.createElement('i'); i.textContent = words.mark; t.append(i); }
    }
    if (showHeatBadge) {
      const hb = document.createElement('em');
      hb.className = `rt-heat rt-${heat.tier}`;
      hb.textContent = heat.shortLabel;
      t.append(hb);
    }
    if (isPinned) {
      const pb = document.createElement('em');
      pb.className = 'rt-pin';
      pb.textContent = 'Today';
      t.append(pb);
    }
    if (state) {
      const s = document.createElement('span');
      s.textContent = state;
      t.append(s);
    }
    t.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const next = selectedItemId === itemId ? null : itemId;
      select(next);
      if (opts.onPick) opts.onPick(next);
    });
    t.addEventListener('pointerenter', (ev) => {
      if (opts.onHover) opts.onHover({ itemId, clientX: ev.clientX, clientY: ev.clientY });
    });
    t.addEventListener('pointermove', (ev) => {
      if (opts.onHover) opts.onHover({ itemId, clientX: ev.clientX, clientY: ev.clientY });
    });
    t.addEventListener('pointerleave', () => {
      if (opts.onHover) opts.onHover(null);
    });
    tagLayer.append(t);
    return t;
  }

  const syncTagStagger = () => {
    let prev = null;
    for (const e of entries) {
      if (e.tag) {
        e.tag.classList.remove('low');
        if (e.hanging && prev && prev.hanging && prev.tag && !prev.tag.classList.contains('low')) e.tag.classList.add('low');
      }
      prev = e;
    }
  };

  function refreshEntryTag(e) {
    const p = byId.get(e.itemId);
    if (!p) return;
    if (e.tag) { e.tag.remove(); e.tag = null; }
    const words = tagWords(e.slotTag, opts.money);
    const state = p.availability && p.availability !== 'AVAILABLE' ? UNAVAILABLE[p.availability] || 'Away' : '';
    const heat = rotationHeatOf(p);
    e.tag = buildTagNode(e.itemId, words, state, heat, e.spotlight, pinnedIds.has(e.itemId));
    if (e.ring) e.ring.visible = Boolean((heatMode && e.spotlight) || pinnedIds.has(e.itemId));
  }

  function place(slot, hanging) {
    const p = byId.get(slot.itemId);
    const holder = new THREE.Group();
    holder.position.set(slot.x, hanging ? HOOK_Y : 0, hanging ? 0 : SHOE_Z);
    if (hanging) holder.rotation.y = RACK_TURN;
    const swing = new THREE.Group();
    holder.add(swing);

    // Subtle floor spotlight halo under spotlighted or Today-pinned pieces
    const ring = new THREE.Mesh(G(new THREE.RingGeometry(0.15, 0.21, 28)), spotlightRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(slot.x, 0.005, hanging ? 0.04 : SHOE_Z);
    ring.visible = false;
    scene.add(ring);

    let g = null;
    try {
      g = buildGarment(THREE, { type: p.type, rgb: rgbFor(p), seed: hashOf(p.itemId), quality });
    } catch {
      g = null;
    }
    if (g) { shadowsOn(g.object); swing.add(g.object); }
    swing.traverse((o) => { o.userData.itemId = p.itemId; });
    scene.add(holder);
    const e = {
      itemId: p.itemId,
      hanging,
      holder,
      swing,
      ring,
      g,
      a: 0,
      v: 0,
      z: 0,
      zTo: 0,
      x0: slot.x,
      dx: 0,
      dxTo: 0,
      baseTurn: hanging ? RACK_TURN : 0,
      sidePhoto: false,
      turn: hanging ? RACK_TURN : 0,
      turnTo: hanging ? RACK_TURN : 0,
      slotTag: slot.tag,
      spotlight: Boolean(slot.spotlight),
      tag: null,
      anchor: hanging ? new THREE.Vector3(0, -0.095, 0.035) : new THREE.Vector3(0, 0.2, 0),
    };
    refreshEntryTag(e);
    if (p.photo && typeof p.photo.then === 'function') {
      p.photo.then((img) => {
        if (!img || disposed) return;
        const w0 = img.width || 1;
        const h0 = img.height || 1;
        const isSide = !!(img.dataset && img.dataset.side === '1');
        const tex = Tex(new THREE.CanvasTexture(img));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const mat = Mt(new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: isSide ? 0.18 : 0.35, roughness: 0.9, side: THREE.DoubleSide }));
        if (hanging && isSide) {
          const hgt = p.type === 'coat' ? 1.12 : p.type === 'shorts' ? 0.74 : p.slot === 'bottom' ? 0.98 : p.slot === 'outer' ? 0.96 : 0.91;
          const planeW = hgt * (w0 / h0);
          const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(planeW, hgt)), mat);
          cut.position.set(0, -hgt / 2 + 0.007, 0.014);
          cut.castShadow = true;
          cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.25 }));
          if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
          e.sidePhoto = true;
          e.baseTurn = 0;
          if (e.zTo === 0) { e.turn = 0; e.turnTo = 0; holder.rotation.y = 0; } else { e.turnTo = 0.06; }
          e.anchor.set(0.01, -0.155, 0.026);
          swing.add(cut);
        } else if (hanging) {
          const baseH = p.slot === 'bottom' ? 0.88 : (g && g.size ? g.size.h : 0.8) - 0.10;
          const hgt = Math.min(0.98, Math.max(0.46, baseH));
          const planeW = hgt * Math.max(0.28, w0 / h0);
          const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(planeW, hgt)), mat);
          cut.position.set(0, (p.slot === 'bottom' ? -0.13 : -0.14) - hgt / 2, 0.01);
          cut.castShadow = true;
          cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.35 }));
          if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
          const hanger = photoHanger(wood, chrome, p.slot, planeW);
          hanger.traverse((o) => { if (o.isMesh) { made.geo.add(o.geometry); o.castShadow = true; } });
          swing.add(hanger, cut);
        } else {
          const shoeW = 0.29;
          const shoeH = shoeW * (h0 / w0);
          const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(shoeW, shoeH)), mat);
          cut.position.set(0, shoeH * 0.48, 0.02);
          cut.rotation.x = -0.12;
          cut.castShadow = true;
          cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.3 }));
          if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
          swing.add(cut);
        }
        swing.traverse((o) => { o.userData.itemId = p.itemId; });
        renderer.shadowMap.needsUpdate = true;
        invalidate();
      }).catch(() => {});
    }
    entries.push(e);
    return e;
  }
  for (const s of layout.hanging) place(s, true);
  for (const s of layout.shoes) place(s, false);
  syncTagStagger();

  // Camera: supports both straight-on Front Rail sliding AND 3D spherical Walk-Around orbiting
  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 60);
  const initPreset = CAMERA_PRESETS[opts.preset] || CAMERA_PRESETS.front;
  const view = {
    x: null,
    xTo: null,
    vx: 0,
    max: 0,
    half: 0,
    d: 6,
    az: initPreset.az,
    azTo: initPreset.az,
    pol: initPreset.pol,
    polTo: initPreset.pol,
    distScale: initPreset.dist,
    distScaleTo: initPreset.dist,
    dragMode: opts.preset && opts.preset !== 'front' ? 'orbit' : 'slide',
    preset: opts.preset || 'front',
    turntable: false,
  };

  function isVaultActive() {
    return view.turntable || Math.abs(view.az) > 0.03 || Math.abs(view.azTo) > 0.03 || view.pol > 0.05 || view.polTo > 0.05;
  }

  function aim() {
    const vaultOn = isVaultActive();
    vaultGroup.visible = vaultOn;
    scene.background.copy(vaultOn ? bgVault : bgGallery);
    const focusX = vaultOn ? view.x * 0.35 : view.x;
    const dist = view.d * view.distScale;
    const cosP = Math.cos(view.pol);
    const horiz = dist * cosP;
    const cx = focusX + Math.sin(view.az) * horiz;
    const cy = 1.02 + Math.sin(view.pol) * dist * 0.72;
    const cz = Math.cos(view.az) * horiz;
    camera.position.set(cx, cy, cz);
    camera.lookAt(focusX, vaultOn ? 0.92 : 0.98, vaultOn ? 0.22 : 0);
  }

  function fit() {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, Math.round(opts.fill ? Math.max(320, host.clientHeight) : w < 640 ? Math.min(w * 1.25, window.innerHeight * 0.66) : Math.min(w * 0.46, 560)));
    renderer.setSize(w, h, false);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    camera.aspect = w / h;
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const th = tv * camera.aspect;
    const want = w < 640 ? Math.min(layout.railLength, RAIL.spacing * 2.75) : Math.min(layout.railLength + 0.2, RAIL.spacing * 9.5 + 0.2);
    view.d = Math.max(want / 2 / th, 1.08 / tv);
    view.half = view.d * th;
    view.max = Math.max(0, half - view.half + 0.15);
    if (view.x === null) view.x = sortMode === 'review' ? 0 : -view.max;
    view.x = Math.max(-view.max, Math.min(view.max, view.x));
    camera.updateProjectionMatrix();
    aim();
  }

  let raf = 0;
  let last = 0;
  function invalidate() { if (!raf && !disposed) raf = requestAnimationFrame(frame); }
  const v3 = new THREE.Vector3();
  function placeTags() {
    const w = el.clientWidth;
    const h = el.clientHeight;
    for (const e of entries) {
      if (!e.tag) continue;
      v3.copy(e.anchor);
      e.swing.localToWorld(v3);
      v3.project(camera);
      const x = (v3.x * 0.5 + 0.5) * w;
      const y = (-v3.y * 0.5 + 0.5) * h;
      const rightEdge = selectedItemId && w > 900 ? w - 384 : w + 40;
      const underPlaque = w > 900 && x < 286 && y < 285;
      const off = v3.z > 1 || x < -40 || x > rightEdge || y < 8 || y > h - 22 || underPlaque;
      e.tag.style.transform = `translate(calc(${(x + el.offsetLeft).toFixed(1)}px - 50%), ${(y + el.offsetTop).toFixed(1)}px)`;
      e.tag.style.visibility = off ? 'hidden' : 'visible';
    }
  }

  function frame(t) {
    raf = 0;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
    last = t;
    let moving = false;
    let stirred = false;
    for (const e of entries) {
      if (e.hanging) {
        const acc = -19 * e.a - 3 * e.v;
        e.v += acc * dt;
        e.a += e.v * dt;
        if (Math.abs(e.a) < 5e-4 && Math.abs(e.v) < 5e-4) { e.a = 0; e.v = 0; } else { moving = true; stirred = true; }
        e.swing.rotation.z = e.a;
        e.swing.rotation.x = -e.a * 0.35;
      }
      const ease = Math.min(1, dt * 9);
      const dz = e.zTo - e.z;
      if (Math.abs(dz) > 1e-4) { e.z += dz * ease; moving = true; stirred = true; } else e.z = e.zTo;
      const ddx = e.dxTo - e.dx;
      if (Math.abs(ddx) > 1e-4) { e.dx += ddx * ease; moving = true; stirred = true; } else e.dx = e.dxTo;
      const dt2 = e.turnTo - e.turn;
      if (Math.abs(dt2) > 1e-4) { e.turn += dt2 * ease; moving = true; stirred = true; } else e.turn = e.turnTo;
      e.holder.position.z = (e.hanging ? 0 : SHOE_Z) + e.z;
      e.holder.position.x = e.x0 + e.dx;
      if (e.ring) e.ring.position.x = e.x0 + e.dx;
      if (e.hanging) e.holder.rotation.y = e.turn;
    }

    let camChanged = false;
    if (view.turntable && !still && !down) {
      view.az = Math.sin(t * 0.00055) * 0.76;
      view.azTo = view.az;
      view.pol = 0.20 + Math.cos(t * 0.00038) * 0.07;
      view.polTo = view.pol;
      view.distScale = 1.18;
      view.distScaleTo = 1.18;
      camChanged = true;
      moving = true;
    } else {
      const camEase = Math.min(1, dt * 7.5);
      const dAz = view.azTo - view.az;
      if (Math.abs(dAz) > 4e-4) { view.az += dAz * camEase; camChanged = true; moving = true; } else if (view.az !== view.azTo) { view.az = view.azTo; camChanged = true; }
      const dPol = view.polTo - view.pol;
      if (Math.abs(dPol) > 4e-4) { view.pol += dPol * camEase; camChanged = true; moving = true; } else if (view.pol !== view.polTo) { view.pol = view.polTo; camChanged = true; }
      const dDist = view.distScaleTo - view.distScale;
      if (Math.abs(dDist) > 4e-4) { view.distScale += dDist * camEase; camChanged = true; moving = true; } else if (view.distScale !== view.distScaleTo) { view.distScale = view.distScaleTo; camChanged = true; }
    }

    if (view.xTo !== null) {
      const d = view.xTo - view.x;
      if (Math.abs(d) > 1e-3) { view.x += d * Math.min(1, dt * 7.5); camChanged = true; moving = true; } else { view.x = view.xTo; view.xTo = null; camChanged = true; }
    } else if (!down && Math.abs(view.vx) > 0.01 && view.max > 0) {
      view.x = Math.max(-view.max, Math.min(view.max, view.x + view.vx * dt));
      view.vx *= Math.pow(0.04, dt);
      if (Math.abs(view.x) >= view.max - 1e-4) view.vx = 0;
      camChanged = true;
      moving = true;
    } else {
      view.vx = 0;
    }

    if (camChanged) aim();
    if (stirred) renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    placeTags();
    if (moving) invalidate(); else last = 0;
  }
  const nudge = (e, k) => { if (e && e.hanging && !still) { e.v += k; invalidate(); } };

  // Pointer: slide or 360-degree orbit, hand-rifling across hangers, wheel zoom/slide, tap to pick
  el.style.touchAction = 'pan-y';
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const railPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const planePt = new THREE.Vector3();
  let lastBrushX = null;
  let lastBrushT = 0;

  function hit(cx, cy) {
    const r = el.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(entries.map((e) => e.swing), true);
    const id = hits.length ? hits[0].object.userData.itemId : null;
    return id ? entries.find((e) => e.itemId === id) : null;
  }

  function brushRifle(cx, cy) {
    if (still) return;
    const r = el.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(railPlane, planePt)) return;
    if (planePt.y < 0.55 || planePt.y > RAIL.railY + 0.1) { lastBrushX = null; return; }
    const now = performance.now();
    if (lastBrushX !== null && now - lastBrushT < 120) {
      const dxWorld = planePt.x - lastBrushX;
      if (Math.abs(dxWorld) > 0.008) {
        const kick = Math.max(-0.22, Math.min(0.22, -dxWorld * 1.35));
        for (const e of entries) {
          if (e.hanging && Math.abs(e.holder.position.x - planePt.x) < 0.26) nudge(e, kick);
        }
      }
    }
    lastBrushX = planePt.x;
    lastBrushT = now;
  }

  let down = null;
  let hovered = null;
  const onDown = (ev) => {
    view.xTo = null;
    view.vx = 0;
    if (view.turntable) { view.turntable = false; if (opts.onCameraChange) opts.onCameraChange(cameraState()); }
    down = {
      x: ev.clientX,
      y: ev.clientY,
      lastX: ev.clientX,
      lastT: performance.now(),
      vx: view.x,
      az0: view.azTo,
      pol0: view.polTo,
      orbit: view.dragMode === 'orbit' || ev.shiftKey || ev.button === 2,
      t: performance.now(),
      moved: false,
    };
  };
  const onMove = (ev) => {
    if (down) {
      const dx = ev.clientX - down.x;
      const dy = ev.clientY - down.y;
      if (Math.hypot(dx, dy) > 6) down.moved = true;
      if (!down.moved) return;
      if (down.orbit) {
        view.azTo = Math.max(-1.08, Math.min(1.08, down.az0 - dx * 0.0046));
        view.polTo = Math.max(-0.04, Math.min(0.62, down.pol0 + dy * 0.0036));
        view.az = view.azTo;
        view.pol = view.polTo;
        if (view.preset === 'front' && (Math.abs(view.az) > 0.05 || view.pol > 0.06)) {
          view.preset = 'walk';
          if (opts.onCameraChange) opts.onCameraChange(cameraState());
        }
        aim();
        invalidate();
      } else if (view.max > 0) {
        const now = performance.now();
        const dtS = Math.max(0.008, (now - down.lastT) / 1000);
        const worldPerPx = (view.half * 2) / Math.max(1, el.clientWidth);
        const stepDx = ev.clientX - down.lastX;
        down.lastX = ev.clientX;
        down.lastT = now;
        view.vx = Math.max(-3.2, Math.min(3.2, (-stepDx * worldPerPx) / dtS));
        view.x = Math.max(-view.max, Math.min(view.max, down.vx - dx * worldPerPx));
        brushRifle(ev.clientX, ev.clientY);
        aim();
        invalidate();
      }
      return;
    }
    if (ev.pointerType !== 'mouse') return;
    brushRifle(ev.clientX, ev.clientY);
    const e = hit(ev.clientX, ev.clientY);
    if (e !== hovered) {
      hovered = e;
      el.style.cursor = e ? 'pointer' : 'grab';
      nudge(e, 0.28);
    }
    if (opts.onHover) {
      opts.onHover(e ? { itemId: e.itemId, clientX: ev.clientX, clientY: ev.clientY } : null);
    }
  };
  const onUp = (ev) => {
    const d = down;
    down = null;
    if (!d) return;
    if (d.moved) { invalidate(); return; }
    if (performance.now() - d.t > 600) return;
    const e = hit(ev.clientX, ev.clientY);
    if (!e) {
      if (selectedItemId !== null) {
        select(null);
        if (opts.onPick) opts.onPick(null);
      }
      return;
    }
    const next = selectedItemId === e.itemId ? null : e.itemId;
    select(next);
    if (opts.onPick) opts.onPick(next);
  };
  const onLeave = () => {
    down = null;
    hovered = null;
    lastBrushX = null;
    if (opts.onHover) opts.onHover(null);
  };
  const onWheel = (ev) => {
    if (isVaultActive() || view.dragMode === 'orbit') {
      view.distScaleTo = Math.max(0.68, Math.min(1.48, view.distScaleTo + ev.deltaY * 0.0012));
      invalidate();
      return;
    }
    if (view.max <= 0) return;
    const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    if (Math.abs(delta) < 2) return;
    view.xTo = null;
    view.x = Math.max(-view.max, Math.min(view.max, view.x + delta * 0.0028));
    aim();
    invalidate();
  };
  const onContext = (ev) => { if (view.dragMode === 'orbit' || isVaultActive()) ev.preventDefault(); };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('pointercancel', onLeave);
  el.addEventListener('wheel', onWheel, { passive: true });
  el.addEventListener('contextmenu', onContext);

  function select(itemId) {
    selectedItemId = itemId || null;
    const hangingList = entries.filter((x) => x.hanging);
    const k = hangingList.findIndex((x) => x.itemId === selectedItemId);
    for (const e of entries) {
      const on = e.itemId === selectedItemId;
      if (e.tag) e.tag.classList.toggle('is-selected', on);
      e.zTo = on ? (e.hanging ? 0.22 : 0.09) : 0;
      if (!e.hanging) continue;
      e.turnTo = on ? (e.sidePhoto ? 0.06 : 0) : e.baseTurn;
      const i = hangingList.indexOf(e);
      e.dxTo = k < 0 || on ? 0 : Math.sign(i - k) * PART * (Math.abs(i - k) === 1 ? 1 : 0.45);
    }
    const e = entries.find((x) => x.itemId === selectedItemId);
    if (e) {
      if (view.max > 0) view.xTo = Math.max(-view.max, Math.min(view.max, e.holder.position.x));
      nudge(e, 0.55);
    }
    invalidate();
  }

  function updatePiece(itemId, next = {}) {
    const e = entries.find((x) => x.itemId === itemId);
    const p = byId.get(itemId);
    if (!e || !p) return;
    if (next.availability) p.availability = next.availability;
    if ('tagRow' in next) e.slotTag = tagOf(next.tagRow);
    refreshEntryTag(e);
    syncTagStagger();
    placeTags();
    invalidate();
  }

  function setPreset(name) {
    const pr = CAMERA_PRESETS[name] || CAMERA_PRESETS.front;
    view.turntable = false;
    view.preset = CAMERA_PRESETS[name] ? name : 'front';
    view.dragMode = view.preset === 'front' ? 'slide' : 'orbit';
    view.azTo = pr.az;
    view.polTo = pr.pol;
    view.distScaleTo = pr.dist;
    if (opts.onCameraChange) opts.onCameraChange(cameraState());
    invalidate();
  }

  function setDragMode(mode) {
    view.dragMode = mode === 'orbit' ? 'orbit' : 'slide';
    if (opts.onCameraChange) opts.onCameraChange(cameraState());
  }

  function setTurntable(on) {
    view.turntable = Boolean(on) && !still;
    if (view.turntable) {
      view.preset = 'walk';
      view.dragMode = 'orbit';
    }
    if (opts.onCameraChange) opts.onCameraChange(cameraState());
    invalidate();
  }

  function nudgeOrbit(dAz, dPol) {
    view.turntable = false;
    view.azTo = Math.max(-1.08, Math.min(1.08, view.azTo + dAz));
    view.polTo = Math.max(-0.04, Math.min(0.62, view.polTo + dPol));
    if (Math.abs(view.azTo) > 0.04 || view.polTo > 0.05) {
      view.preset = 'walk';
      view.dragMode = 'orbit';
    }
    if (opts.onCameraChange) opts.onCameraChange(cameraState());
    invalidate();
  }

  function setHeatMode(on) {
    heatMode = Boolean(on);
    for (const e of entries) refreshEntryTag(e);
    syncTagStagger();
    placeTags();
    invalidate();
  }

  function setPinned(ids) {
    pinnedIds = new Set(ids || []);
    for (const e of entries) refreshEntryTag(e);
    syncTagStagger();
    placeTags();
    invalidate();
  }

  function cameraState() {
    return { preset: view.preset, dragMode: view.dragMode, turntable: view.turntable, vault: isVaultActive() };
  }

  const ro = new ResizeObserver(() => { fit(); invalidate(); });
  ro.observe(host);
  fit();
  if (!still && !phone()) entries.forEach((e, i) => { if (e.hanging) e.a = (i % 2 ? -1 : 1) * (0.03 + (hashOf(e.itemId) % 7) / 400); });
  invalidate();

  return {
    select,
    updatePiece,
    setPreset,
    setDragMode,
    setTurntable,
    nudgeOrbit,
    setHeatMode,
    setPinned,
    cameraState,
    slide(dir) { if (view.max <= 0) return; view.vx = 0; view.xTo = Math.max(-view.max, Math.min(view.max, (view.xTo ?? view.x) + dir * view.half * 1.35)); invalidate(); },
    reset() {
      view.x = phone() ? -view.max : 0;
      view.xTo = null;
      view.vx = 0;
      setPreset('front');
      for (const e of entries) { e.zTo = 0; e.dxTo = 0; e.turnTo = e.hanging ? e.baseTurn : 0; }
      aim();
      invalidate();
    },
    state() {
      return {
        x: view.x,
        max: view.max,
        pieces: entries.length,
        tags: entries.filter((e) => e.tag).map((e) => e.itemId),
        selected: entries.filter((e) => e.zTo > 0).map((e) => e.itemId),
        preset: view.preset,
        vault: vaultGroup.visible,
        heatMode,
      };
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointercancel', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
      for (const e of entries) if (e.g) e.g.dispose();
      disposeGarmentCache();
      for (const g of made.geo) g.dispose();
      for (const m of made.mat) m.dispose();
      for (const t of made.tex) t.dispose();
      envRT.dispose();
      renderer.dispose();
      el.remove();
      tagLayer.remove();
    },
  };
}
