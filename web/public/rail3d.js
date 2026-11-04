// The boutique rail in 3D (three.js 0.170.0, core build). A white studio wall, one long polished rail on
// wall brackets, every hanging piece on its own hanger, shoes in pairs on the floor under it, soft shadows
// on the wall. Garments are modelled by code (garments.js); a piece registered from a photo hangs as that
// photo, cut out by its mask. A tag hangs only where the closet ledger already holds a price row
// (rail.js): the view computes no number of its own. Drag sideways to slide along the rail, tap a piece.
import * as THREE from './vendor/three.module.min.js';
import { buildGarment, disposeGarmentCache } from './garments.js';
import { RAIL, railLayout, tagWords } from './rail.js';

const WALL_Z = -0.36;
const SHOE_Z = 0.42;
const HOOK_Y = RAIL.railY + 0.012; // the top of a hook rests on the top of the rail
const UNAVAILABLE = { LAUNDRY: 'Laundry', REPAIR: 'Repair', STORED: 'Stored' };
const RACK_TURN = -0.44; // pieces hang turned along the rail, like a shop rack; the one you tap turns to face you
const PART = 0.15; // how far the neighbours of the tapped piece make room

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

/** A soft white photo studio, rendered once into a PMREM environment: ceiling softboxes, a key from the left, a broad front panel. */
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

/** Wooden hanger with a polished hook for a photo cut-out (the code-made garments bring their own). Hook top at y = 0. */
function photoHanger(wood, metal) {
  const g = new THREE.Group();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.0028, 8, 20, Math.PI * 1.25), metal);
  hook.rotation.z = -Math.PI * 0.12;
  hook.position.set(0, -0.026, 0);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.05, 8), metal);
  stem.position.set(0, -0.07, 0);
  const arm = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(V(-0.215, -0.15, 0), V(0, -0.075, 0), V(0.215, -0.15, 0)), 24, 0.011, 10, false), wood);
  g.add(hook, stem, arm);
  return g;
}

/**
 * Mounts the rail into `host`. Returns null without WebGL, so the caller can show the list instead.
 * @param {HTMLElement} host
 * @param {Array<{itemId:string, slot:string, type:string, rgb:number[], availability:string, photo?:Promise<CanvasImageSource|null>|null}>} pieces
 * @param {{tags?:object|null, money:(n:number,c:string)=>string, onPick?:(itemId:string)=>void, label?:string}} opts
 */
export function mountRail3d(host, pieces, opts) {
  if (!webglOk()) return null;
  const shooting = navigator.webdriver === true; // screenshots read the canvas back
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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf4f2ee);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = studio();
  const envRT = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envScene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.95;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe7e2da, 0.32));

  const layout = railLayout(pieces, opts.tags || null);
  const half = layout.railLength / 2;
  const key = new THREE.DirectionalLight(0xfff6ec, 1.55);
  key.position.set(-1.4, 4.4, 3.6);
  key.target.position.set(0, 1.0, WALL_Z);
  key.castShadow = true;
  key.shadow.mapSize.set(phone() ? 1024 : 2048, phone() ? 1024 : 2048);
  Object.assign(key.shadow.camera, { left: -half - 1.2, right: half + 1.2, top: 2.4, bottom: -2.4, near: 0.5, far: 12 });
  key.shadow.radius = 9;
  key.shadow.blurSamples = 16;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  scene.add(key, key.target);

  // Room: a white wall with a low skirting board and a pale floor, both catching the garments' shadows.
  const wallMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf6f5f2, roughness: 0.97 }));
  const floorMat = Mt(new THREE.MeshStandardMaterial({ color: 0xeeebe5, roughness: 0.82 }));
  const skirtMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf1efea, roughness: 0.6 }));
  const W = layout.railLength + 14;
  const wall = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 6)), wallMat);
  wall.position.set(0, 2.6, WALL_Z);
  wall.receiveShadow = true;
  const floor = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 10)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 4.6);
  floor.receiveShadow = true;
  const skirt = new THREE.Mesh(G(new THREE.BoxGeometry(W, 0.09, 0.016)), skirtMat);
  skirt.position.set(0, 0.045, WALL_Z + 0.008);
  skirt.receiveShadow = true;
  scene.add(wall, floor, skirt);

  // The rail: polished steel on two wall brackets.
  const chrome = Mt(new THREE.MeshStandardMaterial({ color: 0xf2f2f4, metalness: 1, roughness: 0.13 }));
  const wood = Mt(new THREE.MeshStandardMaterial({ color: 0xcaa67a, roughness: 0.5 }));
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

  // Pieces.
  const byId = new Map(pieces.map((p) => [p.itemId, p]));
  const entries = [];
  let disposed = false;
  const quality = phone() ? 'low' : 'high';
  const rgbFor = (p) => {
    const rgb = Array.isArray(p.rgb) && p.rgb.length === 3 ? p.rgb : [190, 190, 190];
    if (p.availability && p.availability !== 'AVAILABLE') return rgb.map((v) => Math.round(v + (246 - v) * 0.55)); // washed out while away
    return rgb;
  };
  const shadowsOn = (o) => o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  const tagEl = (words, state) => {
    const t = document.createElement('div');
    t.className = 'rail-tag';
    if (words) {
      const b = document.createElement('b');
      b.textContent = words.amount;
      t.append(b);
      if (words.mark) { const i = document.createElement('i'); i.textContent = words.mark; t.append(i); }
    }
    if (state) { const s = document.createElement('span'); s.textContent = state; t.append(s); }
    tagLayer.append(t);
    return t;
  };
  function place(slot, hanging) {
    const p = byId.get(slot.itemId);
    const holder = new THREE.Group();
    holder.position.set(slot.x, hanging ? HOOK_Y : 0, hanging ? 0 : SHOE_Z);
    if (hanging) holder.rotation.y = RACK_TURN;
    const swing = new THREE.Group();
    holder.add(swing);
    let g = null;
    try {
      g = buildGarment(THREE, { type: p.type, rgb: rgbFor(p), seed: hashOf(p.itemId), quality });
    } catch {
      g = null;
    }
    if (g) { shadowsOn(g.object); swing.add(g.object); }
    swing.traverse((o) => { o.userData.itemId = p.itemId; });
    scene.add(holder);
    const words = tagWords(slot.tag, opts.money);
    const state = p.availability && p.availability !== 'AVAILABLE' ? UNAVAILABLE[p.availability] || 'Away' : '';
    const e = {
      itemId: p.itemId, hanging, holder, swing, g, a: 0, v: 0, z: 0, zTo: 0, x0: slot.x, dx: 0, dxTo: 0, turn: hanging ? RACK_TURN : 0, turnTo: hanging ? RACK_TURN : 0,
      tag: words || state ? tagEl(words, state) : null,
      // where the tag's string meets the piece: just right of the hanger's neck, or above a pair of shoes
      anchor: hanging ? new THREE.Vector3(0.05, -0.085, 0.03) : new THREE.Vector3(0, 0.2, 0),
    };
    if (hanging && p.photo && typeof p.photo.then === 'function') {
      p.photo.then((img) => {
        if (!img || disposed) return;
        const w0 = img.width || 1;
        const h0 = img.height || 1;
        const hgt = Math.min(0.95, Math.max(0.45, (g && g.size ? g.size.h : 0.8) - 0.12));
        const tex = new THREE.CanvasTexture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        made.tex.add(tex);
        const mat = Mt(new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.35, roughness: 0.92, side: THREE.DoubleSide }));
        const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(hgt * (w0 / h0), hgt)), mat);
        cut.position.set(0, -0.14 - hgt / 2, 0.01);
        cut.castShadow = true;
        cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.35 }));
        if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
        const hanger = photoHanger(wood, chrome);
        hanger.traverse((o) => { if (o.isMesh) { made.geo.add(o.geometry); o.castShadow = true; } });
        swing.add(hanger, cut);
        swing.traverse((o) => { o.userData.itemId = p.itemId; });
        invalidate();
      }).catch(() => {});
    }
    entries.push(e);
    return e;
  }
  for (const s of layout.hanging) place(s, true);
  for (const s of layout.shoes) place(s, false);

  // Camera: square-on to the rail like a store photograph. A phone sees about three hooks and slides along.
  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 60);
  const view = { x: null, max: 0, half: 0, d: 6 }; // x null until the first fit: a phone opens at the left end, where the rail starts
  function fit() {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, Math.round(w < 640 ? Math.min(w * 1.25, window.innerHeight * 0.66) : Math.min(w * 0.46, 560)));
    renderer.setSize(w, h, false);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    camera.aspect = w / h;
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const th = tv * camera.aspect;
    const want = w < 640 ? Math.min(layout.railLength, RAIL.spacing * 2.75) : layout.railLength + 0.2;
    view.d = Math.max(want / 2 / th, 1.08 / tv);
    view.half = view.d * th;
    view.max = Math.max(0, half - view.half + 0.15);
    if (view.x === null) view.x = -view.max;
    view.x = Math.max(-view.max, Math.min(view.max, view.x));
    camera.updateProjectionMatrix();
    aim();
  }
  function aim() {
    camera.position.set(view.x, 1.02, view.d);
    camera.lookAt(view.x, 0.98, 0);
  }

  // Swing: each hanging piece is a damped pendulum about its hook (about 0.7 Hz, like a coat on a rail).
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
      const off = x < -60 || x > w + 60;
      e.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      e.tag.style.visibility = off ? 'hidden' : 'visible';
    }
  }
  function frame(t) {
    raf = 0;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
    last = t;
    let moving = false;
    for (const e of entries) {
      if (e.hanging) {
        const acc = -19 * e.a - 1.5 * e.v;
        e.v += acc * dt;
        e.a += e.v * dt;
        if (Math.abs(e.a) < 1e-4 && Math.abs(e.v) < 1e-4) { e.a = 0; e.v = 0; } else moving = true;
        e.swing.rotation.z = e.a;
        e.swing.rotation.x = -e.a * 0.35;
      }
      const ease = Math.min(1, dt * 9);
      const dz = e.zTo - e.z;
      if (Math.abs(dz) > 1e-4) { e.z += dz * ease; moving = true; } else e.z = e.zTo;
      const ddx = e.dxTo - e.dx;
      if (Math.abs(ddx) > 1e-4) { e.dx += ddx * ease; moving = true; } else e.dx = e.dxTo;
      const dt2 = e.turnTo - e.turn;
      if (Math.abs(dt2) > 1e-4) { e.turn += dt2 * ease; moving = true; } else e.turn = e.turnTo;
      e.holder.position.z = (e.hanging ? 0 : SHOE_Z) + e.z;
      e.holder.position.x = e.x0 + e.dx;
      if (e.hanging) e.holder.rotation.y = e.turn;
    }
    renderer.render(scene, camera);
    placeTags();
    if (moving) invalidate(); else last = 0;
  }
  const nudge = (e, k) => { if (e && e.hanging && !still) { e.v += k; invalidate(); } };

  // Pointer: drag sideways to slide, tap to pick. Vertical swipes keep scrolling the page.
  el.style.touchAction = 'pan-y';
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function hit(cx, cy) {
    const r = el.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(entries.map((e) => e.swing), true);
    const id = hits.length ? hits[0].object.userData.itemId : null;
    return id ? entries.find((e) => e.itemId === id) : null;
  }
  let down = null;
  let hovered = null;
  const onDown = (ev) => { down = { x: ev.clientX, y: ev.clientY, vx: view.x, t: performance.now(), moved: false }; };
  const onMove = (ev) => {
    if (down) {
      const dx = ev.clientX - down.x;
      if (Math.abs(dx) > 6) down.moved = true;
      if (down.moved && view.max > 0) {
        view.x = Math.max(-view.max, Math.min(view.max, down.vx - dx * ((view.half * 2) / Math.max(1, el.clientWidth))));
        aim();
        invalidate();
      }
      return;
    }
    if (ev.pointerType !== 'mouse') return;
    const e = hit(ev.clientX, ev.clientY);
    if (e !== hovered) { hovered = e; el.style.cursor = e ? 'pointer' : 'grab'; nudge(e, 0.32); }
  };
  const onUp = (ev) => {
    const d = down;
    down = null;
    if (!d || d.moved || performance.now() - d.t > 600) return;
    const e = hit(ev.clientX, ev.clientY);
    if (!e) return;
    select(e.itemId);
    if (opts.onPick) opts.onPick(e.itemId);
  };
  const onLeave = () => { down = null; hovered = null; };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('pointercancel', onLeave);

  function select(itemId) {
    const hangingList = entries.filter((x) => x.hanging);
    const k = hangingList.findIndex((x) => x.itemId === itemId);
    for (const e of entries) {
      const on = e.itemId === itemId;
      e.zTo = on ? (e.hanging ? 0.16 : 0.08) : 0;
      if (!e.hanging) continue;
      e.turnTo = on ? 0 : RACK_TURN;
      const i = hangingList.indexOf(e);
      e.dxTo = k < 0 || on ? 0 : Math.sign(i - k) * PART * (Math.abs(i - k) === 1 ? 1 : 0.45);
    }
    const e = entries.find((x) => x.itemId === itemId);
    if (e && view.max > 0 && Math.abs(e.holder.position.x - view.x) > view.half * 0.7) {
      view.x = Math.max(-view.max, Math.min(view.max, e.holder.position.x));
      aim();
    }
    nudge(e, 0.55);
    invalidate();
  }

  const ro = new ResizeObserver(() => { fit(); invalidate(); });
  ro.observe(host);
  fit();
  // As if just hung: each piece settles from a small swing, one after another.
  if (!still) entries.forEach((e, i) => { if (e.hanging) e.a = (i % 2 ? -1 : 1) * (0.05 + (hashOf(e.itemId) % 7) / 250); });
  invalidate();

  return {
    select,
    reset() { view.x = 0; for (const e of entries) { e.zTo = 0; e.dxTo = 0; e.turnTo = e.hanging ? RACK_TURN : 0; } aim(); invalidate(); },
    state() { return { x: view.x, max: view.max, pieces: entries.length, tags: entries.filter((e) => e.tag).map((e) => e.itemId), selected: entries.filter((e) => e.zTo > 0).map((e) => e.itemId) }; },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointercancel', onLeave);
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
