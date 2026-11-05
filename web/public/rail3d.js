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
const RACK_TURN = -0.34;
const PART = 0.16;

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

/** Procedural Herringbone European Oak parquet texture for the Walk-In Vault floor. */
function makeOakParquetTex(renderer) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d7c3a8';
  ctx.fillRect(0, 0, 256, 256);
  const tones = ['#dfcdaF', '#d4be9f', '#caaF8d', '#e5d5bc', '#c4a884'];
  const step = 32;
  for (let row = -2; row < 12; row++) {
    for (let col = -2; col < 12; col++) {
      ctx.save();
      ctx.translate(col * step, row * step);
      ctx.rotate(((row + col) % 2 === 0 ? 1 : -1) * (Math.PI / 4));
      ctx.fillStyle = tones[Math.abs(row * 3 + col * 5) % tones.length];
      ctx.fillRect(-22, -7, 44, 14);
      ctx.strokeStyle = 'rgba(92, 60, 36, 0.22)';
      ctx.lineWidth = 0.9;
      ctx.strokeRect(-22, -7, 44, 14);
      ctx.strokeStyle = 'rgba(120, 82, 48, 0.10)';
      ctx.beginPath();
      ctx.moveTo(-18, -2);
      ctx.lineTo(18, -2);
      ctx.moveTo(-16, 3);
      ctx.lineTo(16, 3);
      ctx.stroke();
      ctx.restore();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 5);
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** Procedural woven cream bouclé rug texture for the Walk-In Vault center island zone. */
function makeBoucleTex(renderer) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f5f0e6';
  ctx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 4) {
    for (let x = 0; x < 128; x += 4) {
      const shade = ((x * 7 + y * 13) % 11) - 5;
      ctx.fillStyle = `rgb(${244 + shade}, ${239 + shade}, ${229 + shade})`;
      ctx.fillRect(x, y, 3, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 8);
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** Builds the Beverly Hills 3D Walk-In Vault (Smoked Walnut recessed bays, marble island + weekender bag, wings, mirror, bench). */
function buildVaultGroup(half, G, Mt, Tex, renderer) {
  const vault = new THREE.Group();
  const marbleTex = Tex(makeMarbleTex(renderer));
  const oakTex = Tex(makeOakParquetTex(renderer));
  const boucleTex = Tex(makeBoucleTex(renderer));

  const lacquerMat = Mt(new THREE.MeshStandardMaterial({ color: 0xfaf8f5, roughness: 0.32, metalness: 0.04 }));
  const walnutMat = Mt(new THREE.MeshStandardMaterial({ color: 0x5c3c24, roughness: 0.46, metalness: 0.06 }));
  const deepWalnutMat = Mt(new THREE.MeshStandardMaterial({ color: 0x462c19, roughness: 0.52, metalness: 0.05 }));
  const brassMat = Mt(new THREE.MeshStandardMaterial({ color: 0xc8a974, roughness: 0.24, metalness: 0.86 }));
  const saddleMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf37021, roughness: 0.44, metalness: 0.04 }));
  const cognacLeatherMat = Mt(new THREE.MeshStandardMaterial({ color: 0x9c4f22, roughness: 0.38, metalness: 0.06 }));
  const creamBoxMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf2ece1, roughness: 0.65 }));
  const marbleMat = Mt(new THREE.MeshStandardMaterial({ map: marbleTex, roughness: 0.20, metalness: 0.05 }));
  const parquetMat = Mt(new THREE.MeshStandardMaterial({ map: oakTex, roughness: 0.56, metalness: 0.03 }));
  const boucleMat = Mt(new THREE.MeshStandardMaterial({ map: boucleTex, roughness: 0.92, metalness: 0.0 }));
  const mirrorMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.05, metalness: 0.94 }));
  const ledMat = Mt(new THREE.MeshBasicMaterial({ color: 0xffe0a6 }));

  const spanW = Math.max(4.8, half * 2 + 0.96);

  // 1. Herringbone European Oak parquet floor + woven cream Bouclé rug with champagne-brass border
  const runner = new THREE.Mesh(G(new THREE.PlaneGeometry(spanW + 4.4, 5.8)), parquetMat);
  runner.rotation.x = -Math.PI / 2;
  runner.position.set(0, 0.002, 1.45);
  runner.receiveShadow = true;
  vault.add(runner);

  const rugW = Math.min(spanW - 0.3, 4.4);
  const rugD = 2.35;
  const rugBrassFrame = new THREE.Mesh(G(new THREE.PlaneGeometry(rugW + 0.09, rugD + 0.09)), brassMat);
  rugBrassFrame.rotation.x = -Math.PI / 2;
  rugBrassFrame.position.set(0, 0.004, 1.48);
  const rugBoucle = new THREE.Mesh(G(new THREE.PlaneGeometry(rugW, rugD)), boucleMat);
  rugBoucle.rotation.x = -Math.PI / 2;
  rugBoucle.position.set(0, 0.006, 1.48);
  rugBoucle.receiveShadow = true;
  vault.add(rugBrassFrame, rugBoucle);

  // 2. Architectural Back Wall: 3 Smoked American Walnut Recessed Bays + 4 White Lacquer & Brass Pilasters + Warm LED Cove Strips
  const backSurround = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 0.52, 2.66, 0.06)), lacquerMat);
  backSurround.position.set(0, 1.33, WALL_Z - 0.02);
  backSurround.receiveShadow = true;
  vault.add(backSurround);

  const nBays = 3;
  const pilasterW = 0.085;
  const bayW = (spanW - (nBays + 1) * pilasterW) / nBays;
  const bayH = RAIL.railY + 0.25;
  for (let i = 0; i < nBays; i++) {
    const bx = -spanW / 2 + pilasterW + bayW / 2 + i * (bayW + pilasterW);
    const walnutBay = new THREE.Mesh(G(new THREE.BoxGeometry(bayW + 0.01, bayH - 0.20, 0.026)), walnutMat);
    walnutBay.position.set(bx, 0.22 + (bayH - 0.20) / 2, WALL_Z + 0.016);
    walnutBay.receiveShadow = true;
    const bayLed = new THREE.Mesh(G(new THREE.BoxGeometry(bayW - 0.08, 0.015, 0.028)), ledMat);
    bayLed.position.set(bx, RAIL.railY + 0.245, WALL_Z + 0.09);
    vault.add(walnutBay, bayLed);
  }
  for (let i = 0; i <= nBays; i++) {
    const px = -spanW / 2 + pilasterW / 2 + i * (bayW + pilasterW);
    const pilaster = new THREE.Mesh(G(new THREE.BoxGeometry(pilasterW, 2.52, 0.24)), lacquerMat);
    pilaster.position.set(px, 1.26, WALL_Z + 0.10);
    pilaster.castShadow = true;
    pilaster.receiveShadow = true;
    const trim = new THREE.Mesh(G(new THREE.BoxGeometry(0.016, 2.48, 0.018)), brassMat);
    trim.position.set(px, 1.26, WALL_Z + 0.226);
    vault.add(pilaster, trim);
  }

  // Lower Smoked Walnut & Calacatta Gold Marble Credenza behind the floor shoe zone
  const credenzaBody = new THREE.Mesh(G(new THREE.BoxGeometry(spanW, 0.20, 0.26)), deepWalnutMat);
  credenzaBody.position.set(0, 0.10, WALL_Z + 0.13);
  credenzaBody.receiveShadow = true;
  const credenzaMarble = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 0.03, 0.028, 0.28)), marbleMat);
  credenzaMarble.position.set(0, 0.214, WALL_Z + 0.14);
  credenzaMarble.receiveShadow = true;
  const credenzaBrassLip = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 0.035, 0.012, 0.014)), brassMat);
  credenzaBrassLip.position.set(0, 0.214, WALL_Z + 0.284);
  vault.add(credenzaBody, credenzaMarble, credenzaBrassLip);

  // Upper shelf + warm LED strip + Hermès-orange archive boxes & folded cashmere stacks
  const topShelf = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 0.04, 0.038, 0.34)), lacquerMat);
  topShelf.position.set(0, RAIL.railY + 0.29, WALL_Z + 0.17);
  topShelf.castShadow = true;
  const topTrim = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 0.06, 0.014, 0.018)), brassMat);
  topTrim.position.set(0, RAIL.railY + 0.29, WALL_Z + 0.34);
  const topLed = new THREE.Mesh(G(new THREE.BoxGeometry(spanW - 0.16, 0.013, 0.032)), ledMat);
  topLed.position.set(0, RAIL.railY + 0.268, WALL_Z + 0.24);
  vault.add(topShelf, topTrim, topLed);

  const warmCoveLight = new THREE.PointLight(0xffe2ad, 0.46, 6.2, 1.4);
  warmCoveLight.position.set(0, RAIL.railY + 0.24, 0.55);
  vault.add(warmCoveLight);

  const nSlots = Math.max(4, Math.min(7, Math.floor(spanW / 0.78)));
  const knitColors = [0xe8dfd1, 0xc7ad8a, 0x3b3835];
  for (let i = 0; i < nSlots; i++) {
    const bx = -((nSlots - 1) * 0.72) / 2 + i * 0.72;
    if (i % 2 === 1) {
      for (let k = 0; k < 3; k++) {
        const km = Mt(new THREE.MeshStandardMaterial({ color: knitColors[k], roughness: 0.85 }));
        const fold = new THREE.Mesh(G(new THREE.BoxGeometry(0.32 - k * 0.012, 0.038, 0.23)), km);
        fold.position.set(bx, RAIL.railY + 0.33 + k * 0.04, WALL_Z + 0.18);
        fold.castShadow = true;
        vault.add(fold);
      }
    } else {
      const isOrange = i % 4 === 0;
      const box = new THREE.Mesh(G(new THREE.BoxGeometry(0.38, 0.14, 0.26)), isOrange ? saddleMat : creamBoxMat);
      box.position.set(bx, RAIL.railY + 0.38, WALL_Z + 0.18);
      box.castShadow = true;
      const lid = new THREE.Mesh(G(new THREE.BoxGeometry(0.396, 0.024, 0.276)), isOrange ? deepWalnutMat : brassMat);
      lid.position.set(bx, RAIL.railY + 0.456, WALL_Z + 0.18);
      const clasp = new THREE.Mesh(G(new THREE.BoxGeometry(0.04, 0.022, 0.012)), brassMat);
      clasp.position.set(bx, RAIL.railY + 0.42, WALL_Z + 0.314);
      vault.add(box, lid, clasp);
    }
  }

  // 3. Calacatta Gold Marble Center Island + Sculpted Cognac Leather Weekender Bag + Valet Tray + Watch Pillar
  const islandZ = 1.62;
  const islandW = Math.min(1.92, Math.max(1.32, spanW * 0.36));
  const islandGroup = new THREE.Group();
  islandGroup.position.set(0, 0, islandZ);
  const islandBody = new THREE.Mesh(G(new THREE.BoxGeometry(islandW, 0.44, 0.68)), walnutMat);
  islandBody.position.y = 0.22;
  islandBody.castShadow = true;
  islandBody.receiveShadow = true;
  const islandFrontPanel = new THREE.Mesh(G(new THREE.BoxGeometry(islandW - 0.10, 0.34, 0.70)), lacquerMat);
  islandFrontPanel.position.y = 0.22;
  const islandTop = new THREE.Mesh(G(new THREE.BoxGeometry(islandW + 0.07, 0.042, 0.74)), marbleMat);
  islandTop.position.y = 0.461;
  islandTop.castShadow = true;
  islandTop.receiveShadow = true;
  const islandPlinth = new THREE.Mesh(G(new THREE.BoxGeometry(islandW - 0.03, 0.03, 0.64)), brassMat);
  islandPlinth.position.y = 0.015;
  const valetTray = new THREE.Mesh(G(new THREE.BoxGeometry(0.34, 0.022, 0.23)), saddleMat);
  valetTray.position.set(-islandW * 0.27, 0.493, 0.04);
  const displayStand = new THREE.Mesh(G(new THREE.CylinderGeometry(0.042, 0.05, 0.075, 20)), brassMat);
  displayStand.position.set(islandW * 0.29, 0.518, -0.04);

  // Sculpted 3D Cognac Saddlery Weekender Duffle Bag atop the center island
  const bagGroup = new THREE.Group();
  bagGroup.position.set(0.03, 0.565, -0.01);
  bagGroup.rotation.y = -0.22;
  const bagBarrel = new THREE.Mesh(G(new THREE.CylinderGeometry(0.088, 0.094, 0.36, 20)), cognacLeatherMat);
  bagBarrel.rotation.z = Math.PI / 2;
  bagBarrel.castShadow = true;
  bagGroup.add(bagBarrel);
  for (const sx of [-0.18, 0.18]) {
    const cap = new THREE.Mesh(G(new THREE.SphereGeometry(0.088, 16, 12)), cognacLeatherMat);
    cap.scale.set(0.36, 1, 1);
    cap.position.x = sx;
    bagGroup.add(cap);
  }
  for (const sx of [-0.085, 0.085]) {
    const strap = new THREE.Mesh(G(new THREE.TorusGeometry(0.091, 0.008, 8, 20)), brassMat);
    strap.rotation.y = Math.PI / 2;
    strap.position.x = sx;
    bagGroup.add(strap);
  }
  for (const sz of [-0.036, 0.036]) {
    const handle = new THREE.Mesh(G(new THREE.TorusGeometry(0.058, 0.0085, 8, 18, Math.PI)), cognacLeatherMat);
    handle.position.set(0, 0.082, sz);
    bagGroup.add(handle);
  }

  islandGroup.add(islandBody, islandFrontPanel, islandTop, islandPlinth, valetTray, displayStand, bagGroup);
  vault.add(islandGroup);

  // 4. Left & Right Angled Walk-In Wing Bays (Surrounding Walk-In Closet Walls & Secondary Hanging Rails)
  const wingX = half + 0.90;
  for (const side of [-1, 1]) {
    const isLeft = side < 0;
    const wing = new THREE.Group();
    wing.position.set(side * wingX, 0, 0.80);
    wing.rotation.y = isLeft ? Math.PI / 2.25 : -Math.PI / 2.25;

    const backPanel = new THREE.Mesh(G(new THREE.BoxGeometry(2.42, 2.52, 0.12)), lacquerMat);
    backPanel.position.set(0, 1.26, -0.08);
    backPanel.receiveShadow = true;
    const alcove = new THREE.Mesh(G(new THREE.BoxGeometry(1.98, 2.02, 0.16)), walnutMat);
    alcove.position.set(0, 1.15, 0.02);
    const frameTop = new THREE.Mesh(G(new THREE.BoxGeometry(2.06, 0.028, 0.22)), brassMat);
    frameTop.position.set(0, 2.17, 0.05);
    const wingLed = new THREE.Mesh(G(new THREE.BoxGeometry(1.88, 0.015, 0.04)), ledMat);
    wingLed.position.set(0, 2.12, 0.12);
    const wingRod = new THREE.Mesh(G(new THREE.CylinderGeometry(0.013, 0.013, 1.82, 20)), brassMat);
    wingRod.rotation.z = Math.PI / 2;
    wingRod.position.set(0, 1.68, 0.18);
    const wingPlinth = new THREE.Mesh(G(new THREE.BoxGeometry(2.04, 0.16, 0.26)), deepWalnutMat);
    wingPlinth.position.set(0, 0.08, 0.08);
    wing.add(backPanel, alcove, frameTop, wingLed, wingRod, wingPlinth);

    const tones = isLeft ? [0x222936, 0xc8b396, 0x3b3835, 0x5c3c24] : [0xdfd5c5, 0x2c3b33, 0x262524, 0x8b6b4c];
    [-0.60, -0.20, 0.20, 0.60].forEach((gx, idx) => {
      const coatMat = Mt(new THREE.MeshStandardMaterial({ color: tones[idx], roughness: 0.78 }));
      const stem = new THREE.Mesh(G(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 8)), brassMat);
      stem.position.set(gx, 1.62, 0.18);
      const shoulder = new THREE.Mesh(G(new THREE.BoxGeometry(0.26, 0.88, 0.095)), coatMat);
      shoulder.position.set(gx, 1.14, 0.18);
      shoulder.rotation.y = isLeft ? 0.36 : -0.36;
      wing.add(stem, shoulder);
    });

    vault.add(wing);
  }

  // 5. Left forefront beveled brass floor mirror + Right forefront walnut & alabaster valet bench + Ceiling coffer
  const mirror = new THREE.Group();
  mirror.position.set(-(half + 0.54), 0, 2.02);
  mirror.rotation.y = 0.48;
  const mFrame = new THREE.Mesh(G(new THREE.BoxGeometry(0.70, 1.90, 0.042)), brassMat);
  mFrame.position.y = 0.95;
  mFrame.castShadow = true;
  const mGlass = new THREE.Mesh(G(new THREE.BoxGeometry(0.62, 1.82, 0.048)), mirrorMat);
  mGlass.position.y = 0.95;
  mirror.add(mFrame, mGlass);
  vault.add(mirror);

  const bench = new THREE.Group();
  bench.position.set(half + 0.54, 0, 2.02);
  bench.rotation.y = -0.44;
  const cushion = new THREE.Mesh(G(new THREE.BoxGeometry(0.88, 0.10, 0.38)), boucleMat);
  cushion.position.y = 0.42;
  cushion.castShadow = true;
  const base = new THREE.Mesh(G(new THREE.BoxGeometry(0.84, 0.065, 0.35)), walnutMat);
  base.position.y = 0.34;
  for (const lx of [-0.35, 0.35]) {
    const leg = new THREE.Mesh(G(new THREE.BoxGeometry(0.036, 0.32, 0.28)), brassMat);
    leg.position.set(lx, 0.16, 0);
    bench.add(leg);
  }
  bench.add(cushion, base);
  vault.add(bench);

  const cofferWalnut = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 2.1, 0.05, 3.0)), walnutMat);
  cofferWalnut.position.set(0, 2.70, 0.74);
  const coffer = new THREE.Mesh(G(new THREE.BoxGeometry(spanW + 1.86, 0.036, 2.76)), brassMat);
  coffer.position.set(0, 2.66, 0.74);
  vault.add(cofferWalnut, coffer);

  vault.visible = false;
  return vault;
}

/** Twin champagne-brass cords + hook looping over the horizontal steel rail (hang-tag sits on the cord above the hanger). */
function boutiqueCord(brassMat, dropLen = 0.165) {
  const g = new THREE.Group();
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.021, 0.0026, 8, 20, Math.PI * 1.25), brassMat);
  hook.rotation.z = -Math.PI * 0.12;
  hook.position.set(0, -0.006, 0);
  g.add(hook);
  for (const sx of [-0.0068, 0.0068]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.0021, 0.0021, dropLen, 8), brassMat);
    cord.position.set(sx, -dropLen / 2 - 0.006, 0);
    g.add(cord);
  }
  return g;
}

/** Savile Row dual-jaw walnut & merino-felt mechanical trouser clamp with eccentric brass cam-lock. */
function buildSavileTrouserClamp(wood, brassMat, spanW = 0.31) {
  const g = new THREE.Group();
  const bSpan = Math.min(0.35, Math.max(0.20, spanW));
  const feltMat = new THREE.MeshStandardMaterial({ color: 0xe6dfd3, roughness: 0.92, metalness: 0.01 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x2c2520, roughness: 0.88, metalness: 0.02 });
  const neckY = -0.150;
  for (const jawZ of [-0.013, 0.013]) {
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(bSpan, 0.028, 0.014), wood);
    jaw.position.set(0, neckY - 0.014, jawZ);
    g.add(jaw);
    const crown = new THREE.Mesh(new THREE.BoxGeometry(bSpan + 0.006, 0.007, 0.016), brassMat);
    crown.position.set(0, neckY + 0.003, jawZ);
    g.add(crown);
  }
  const liner = new THREE.Mesh(new THREE.BoxGeometry(bSpan - 0.01, 0.024, 0.011), feltMat);
  liner.position.set(0, neckY - 0.016, 0);
  g.add(liner);
  for (const endX of [-bSpan / 2, bSpan / 2]) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.032, 0.042), brassMat);
    cap.position.set(endX, neckY - 0.013, 0);
    g.add(cap);
  }
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.036, 0.044), brassMat);
  cam.position.set(0, neckY - 0.012, 0.004);
  g.add(cam);
  const cx = bSpan * 0.34;
  for (const sx of [-cx, cx]) {
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.021, 0.038, 0.034), brassMat);
    clip.position.set(sx, neckY - 0.030, 0.004);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.019, 0.014, 0.036), gripMat);
    pad.position.set(sx, neckY - 0.044, 0.004);
    g.add(clip, pad);
  }
  return g;
}

/** Optical glossy collector shoe vitrine with obsidian plinth, brass plaque, 3000K LED strip, and specular glass door. */
function makeGlossyVitrineDoorTex() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 192);
  g.addColorStop(0, 'rgba(235, 246, 255, 0.30)');
  g.addColorStop(0.5, 'rgba(255, 255, 255, 0.08)');
  g.addColorStop(1, 'rgba(220, 238, 255, 0.28)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 192);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(7, 7, 242, 178);
  ctx.strokeStyle = 'rgba(197, 165, 114, 0.62)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(12, 12, 232, 168);
  ctx.beginPath();
  ctx.moveTo(28, 182);
  ctx.lineTo(96, 10);
  ctx.lineTo(126, 10);
  ctx.lineTo(58, 182);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(138, 182);
  ctx.lineTo(202, 10);
  ctx.lineTo(216, 10);
  ctx.lineTo(152, 182);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildGlossyShoeVitrine(brassMat, doorTex) {
  const g = new THREE.Group();
  const w = 0.44;
  const h = 0.30;
  const d = 0.28;
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.28, metalness: 0.35 });
  const riserMat = new THREE.MeshStandardMaterial({ color: 0xf7f3ec, roughness: 0.75, metalness: 0.04 });
  const ledStripMat = new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xffe2a8, emissiveIntensity: 0.9, roughness: 0.2 });
  const glassWallMat = new THREE.MeshPhysicalMaterial({
    color: 0xf5faff,
    transparent: true,
    opacity: 0.24,
    roughness: 0.06,
    metalness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    depthWrite: false,
  });
  const doorMat = new THREE.MeshBasicMaterial({ map: doorTex, transparent: true, depthWrite: false });

  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.036, d + 0.02), plinthMat);
  plinth.position.set(0, 0.018, 0);
  const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.018, 0.008), brassMat);
  plaque.position.set(0, 0.019, d / 2 + 0.012);
  const riser = new THREE.Mesh(new THREE.BoxGeometry(w - 0.05, 0.022, d - 0.05), riserMat);
  riser.position.set(0, 0.046, -0.005);
  riser.rotation.x = 0.07;

  const boxShell = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glassWallMat);
  boxShell.position.set(0, 0.036 + h / 2, 0);
  const frontDoor = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.01, h - 0.01), doorMat);
  frontDoor.position.set(0, 0.036 + h / 2, d / 2 + 0.002);
  const topCrown = new THREE.Mesh(new THREE.BoxGeometry(w + 0.012, 0.014, d + 0.012), brassMat);
  topCrown.position.set(0, 0.036 + h + 0.006, 0);
  const ledStrip = new THREE.Mesh(new THREE.BoxGeometry(w - 0.06, 0.008, 0.028), ledStripMat);
  ledStrip.position.set(0, 0.036 + h - 0.008, 0.03);

  g.add(plinth, plaque, riser, boxShell, frontDoor, topCrown, ledStrip);
  return g;
}

/** Sculpted walnut hanger suspended on twin champagne-brass cords so the boutique hang-tag clears the garment collar. */
function photoHanger(wood, brassMat, slot, planeW = 0.43) {
  const g = boutiqueCord(brassMat, 0.156);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const neckY = -0.156;
  if (slot === 'bottom') {
    g.add(buildSavileTrouserClamp(wood, brassMat, planeW * 0.92));
    return g;
  }
  const span = Math.min(0.215, Math.max(0.075, planeW * 0.45));
  const drop = span < 0.12 ? neckY - 0.042 : neckY - 0.064;
  const arm = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(V(-span, drop, 0), V(0, neckY + 0.004, 0), V(span, drop, 0)), 24, 0.011, 10, false), wood);
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
  renderer.toneMappingExposure = 1.07;
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
  const bgGallery = new THREE.Color(0xffffff);
  const bgVault = new THREE.Color(0xf8f6f1);
  scene.background = bgGallery.clone();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = studio();
  const envRT = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envScene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.02;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xf2efe9, 0.42));

  let showTags = opts.showTags !== undefined ? Boolean(opts.showTags) : true;
  let heatMode = Boolean(opts.heatMode ?? opts.heat);
  let sortMode = opts.sort || 'rack';
  let pinnedIds = new Set(opts.pinned || []);
  let outfitHighlight = { ids: new Set(opts.outfitIds || []), anchorId: opts.outfitAnchor || null };
  const layout = railLayout(pieces, opts.tags || null, { sort: sortMode, withHeat: true });
  const half = layout.railLength / 2;
  const key = new THREE.DirectionalLight(0xfffaf3, 1.48);
  key.position.set(-1.3, 4.5, 3.8);
  key.target.position.set(0, 1.0, WALL_Z);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -half - 1.5, right: half + 1.5, top: 2.6, bottom: -2.4, near: 0.5, far: 14 });
  key.shadow.radius = 9;
  key.shadow.blurSamples = 8;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  scene.add(key, key.target);

  // Pure-white boutique gallery stage (with subtle floor contact shadow)
  const wallMat = Mt(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 }));
  const floorMat = Mt(new THREE.MeshStandardMaterial({ color: 0xfaf9f6, roughness: 0.86 }));
  const skirtMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf4f2ed, roughness: 0.65 }));
  const W = layout.railLength + 18;
  const wall = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 6.4)), wallMat);
  wall.position.set(0, 2.7, WALL_Z);
  wall.receiveShadow = true;
  const floor = new THREE.Mesh(G(new THREE.PlaneGeometry(W, 12)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 4.6);
  floor.receiveShadow = true;
  const skirt = new THREE.Mesh(G(new THREE.BoxGeometry(W, 0.08, 0.014)), skirtMat);
  skirt.position.set(0, 0.04, WALL_Z + 0.007);
  skirt.receiveShadow = true;
  scene.add(wall, floor, skirt);

  // Surrounding 3D Walk-In Vault (shown automatically in Walk-Around / Wing / Overhead / Spin views)
  const vaultGroup = buildVaultGroup(half, G, Mt, Tex, renderer);
  scene.add(vaultGroup);

  // Main boutique rail: brushed stainless steel + machined end-brackets + Hermès Orange precision rings + champagne brass cords
  const chrome = Mt(new THREE.MeshStandardMaterial({ color: 0xf0f0f2, metalness: 0.96, roughness: 0.16 }));
  const darkSteel = Mt(new THREE.MeshStandardMaterial({ color: 0x262523, metalness: 0.82, roughness: 0.28 }));
  const accentRingMat = Mt(new THREE.MeshStandardMaterial({ color: 0xf37021, metalness: 0.35, roughness: 0.32 }));
  const brassCordMat = Mt(new THREE.MeshStandardMaterial({ color: 0xc8a974, metalness: 0.88, roughness: 0.22 }));
  const wood = Mt(new THREE.MeshStandardMaterial({ color: 0xcaa67a, roughness: 0.5 }));
  const vitrineDoorTex = Tex(makeGlossyVitrineDoorTex());
  const spotlightRingMat = Mt(new THREE.MeshBasicMaterial({ color: 0xf37021, transparent: true, opacity: 0.34, side: THREE.DoubleSide }));
  const railSpan = Math.max(layout.railLength + 0.28, 5.2);
  const railHalf = railSpan / 2;
  const rail = new THREE.Mesh(G(new THREE.CylinderGeometry(0.0135, 0.0135, railSpan, 32)), chrome);
  rail.rotation.z = Math.PI / 2;
  rail.position.set(0, RAIL.railY, 0);
  rail.castShadow = true;
  scene.add(rail);
  for (const s of [-1, 1]) {
    const bx = s * (railHalf - 0.04);
    const arm = new THREE.Mesh(G(new THREE.CylinderGeometry(0.0095, 0.0095, -WALL_Z, 20)), chrome);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(bx, RAIL.railY, WALL_Z / 2);
    arm.castShadow = true;
    const block = new THREE.Mesh(G(new THREE.BoxGeometry(0.052, 0.052, 0.022)), darkSteel);
    block.position.set(bx, RAIL.railY, WALL_Z + 0.011);
    const sleeve = new THREE.Mesh(G(new THREE.CylinderGeometry(0.021, 0.021, 0.036, 24)), chrome);
    sleeve.rotation.z = Math.PI / 2;
    sleeve.position.set(bx, RAIL.railY, 0);
    const orangeRing = new THREE.Mesh(G(new THREE.CylinderGeometry(0.0225, 0.0225, 0.007, 24)), accentRingMat);
    orangeRing.rotation.z = Math.PI / 2;
    orangeRing.position.set(bx - s * 0.022, RAIL.railY, 0);
    const cap = new THREE.Mesh(G(new THREE.CylinderGeometry(0.017, 0.017, 0.014, 24)), darkSteel);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(s * railHalf, RAIL.railY, 0);
    scene.add(arm, block, sleeve, orangeRing, cap);
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

  function buildTagNode(itemId, hanging, p, words, state, heat, spotlight, isPinned, outfitRole) {
    const isSelected = selectedItemId === itemId;
    if (hanging) {
      if (!showTags && !isSelected && !outfitRole && !isPinned && !state) return null;
    } else if (!(showTags && words) && !isSelected && !outfitRole && !isPinned && !state) {
      return null;
    }
    const t = document.createElement('button');
    t.type = 'button';
    t.dataset.itemId = itemId;
    const cls = ['rail-tag', 'is-interactive', hanging ? 'is-hanging' : 'is-floor'];
    if (!words) cls.push('is-unpriced');
    else if (words.mark) cls.push('is-sample');
    if (state) cls.push('has-state');
    if (isSelected) cls.push('is-selected');
    if (isPinned) cls.push('is-pinned');
    if (outfitRole) cls.push('is-outfit', `is-outfit-${outfitRole}`);
    if (spotlight) cls.push('is-spotlight');
    if (heatMode && heat) cls.push(`heat-${heat.tier}`);
    t.className = cls.join(' ');

    const row1 = document.createElement('span');
    row1.className = 'rt-row1';
    const dot = document.createElement('span');
    const hollow = !isSelected && !outfitRole && !isPinned && (!heat || (heat.wears === 0 && heat.tier === 'fresh'));
    dot.className = hollow ? 'rt-dot is-hollow' : 'rt-dot';
    const amt = document.createElement('b');
    amt.className = words ? 'rt-amt' : 'rt-amt is-none';
    amt.textContent = words ? words.amount : 'No price';
    row1.append(dot, amt);

    const row2 = document.createElement('span');
    row2.className = 'rt-row2';
    const codeEl = document.createElement('span');
    codeEl.className = 'rt-code';
    codeEl.textContent = itemId;
    row2.append(codeEl);

    const metaParts = [];
    if (outfitRole) metaParts.push(outfitRole === 'kept' ? 'Kept' : 'Paired');
    else if (isPinned) metaParts.push('Today');
    else if (state) metaParts.push(state);
    else if (words && words.mark && (!heatMode || !heat || heat.tier === 'fresh')) metaParts.push('Sample');

    if (heatMode && heat) {
      const wearTxt = heat.tier === 'hot'
        ? `${heat.wears}x Active`
        : heat.tier === 'cold'
          ? '0x Review'
          : heat.wears > 0
            ? `${heat.wears}x Worn`
            : (words && words.mark) ? '' : 'No wear';
      if (wearTxt) metaParts.push(wearTxt);
    } else if (!metaParts.length && p && p.sample) {
      metaParts.push('Sample');
    }

    if (metaParts.length) {
      const metaEl = document.createElement('span');
      metaEl.className = 'rt-meta';
      metaEl.textContent = ` · ${metaParts.slice(0, 2).join(' · ')}`;
      row2.append(metaEl);
    }

    t.append(row1, row2);
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

  const syncTagStagger = () => {};

  function refreshEntryTag(e) {
    const p = byId.get(e.itemId);
    if (!p) return;
    if (e.tag) { e.tag.remove(); e.tag = null; }
    const words = tagWords(e.slotTag, opts.money);
    const state = p.availability && p.availability !== 'AVAILABLE' ? UNAVAILABLE[p.availability] || 'Away' : '';
    const heat = rotationHeatOf(p);
    const inOutfit = outfitHighlight.ids.has(e.itemId);
    const outfitRole = inOutfit ? (outfitHighlight.anchorId === e.itemId ? 'kept' : 'paired') : null;
    e.tag = buildTagNode(e.itemId, e.hanging, p, words, state, heat, e.spotlight, pinnedIds.has(e.itemId), outfitRole);
    if (e.ring) e.ring.visible = Boolean(inOutfit || (heatMode && e.spotlight) || pinnedIds.has(e.itemId));
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
      anchor: hanging ? new THREE.Vector3(0, -0.092, 0.034) : new THREE.Vector3(0, 0.22, 0),
    };
    refreshEntryTag(e);
    if (p.photo && typeof p.photo.then === 'function') {
      p.photo.then((img) => {
        if (!img || disposed) return;
        const w0 = img.width || 1;
        const h0 = img.height || 1;
        const isRack34 = !!(img.dataset && img.dataset.rack34 === '1');
        const isSide = !!(img.dataset && img.dataset.side === '1');
        const isStudioFull = !!(img.dataset && img.dataset.studioFull === '1');
        const tex = Tex(new THREE.CanvasTexture(img));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const mat = Mt(new THREE.MeshStandardMaterial({
          map: tex,
          transparent: true,
          alphaTest: isSide ? 0.18 : 0.24,
          roughness: 0.86,
          side: THREE.DoubleSide,
        }));
        if (hanging && isRack34) {
          const hgt = p.type === 'coat' ? 1.24 : p.slot === 'outer' ? 1.08 : 1.02;
          const planeW = hgt * (w0 / h0);
          const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(planeW, hgt)), mat);
          cut.position.set(0, -0.155 - hgt / 2, 0.014);
          cut.castShadow = true;
          cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.24 }));
          if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
          const cord = boutiqueCord(brassCordMat, 0.165);
          cord.traverse((o) => { if (o.isMesh) { made.geo.add(o.geometry); o.castShadow = true; } });
          e.sidePhoto = true;
          e.baseTurn = 0;
          if (e.zTo === 0) { e.turn = 0; e.turnTo = 0; holder.rotation.y = 0; } else { e.turnTo = 0.06; }
          e.anchor.set(0, -0.092, 0.034);
          swing.add(cord, cut);
        } else if (hanging && isSide) {
          const hgt = p.type === 'coat' ? 1.16 : p.type === 'shorts' ? 0.76 : p.slot === 'bottom' ? 1.02 : p.slot === 'outer' ? 1.0 : 0.94;
          const planeW = hgt * (w0 / h0);
          const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(planeW, hgt)), mat);
          cut.position.set(0, (p.slot === 'bottom' ? -0.188 : -0.155) - hgt / 2, 0.014);
          cut.castShadow = true;
          cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.25 }));
          if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
          const cord = p.slot === 'bottom' ? photoHanger(wood, brassCordMat, 'bottom', planeW) : boutiqueCord(brassCordMat, 0.165);
          cord.traverse((o) => { if (o.isMesh) { made.geo.add(o.geometry); if (o.material) made.mat.add(o.material); o.castShadow = true; } });
          e.sidePhoto = true;
          e.baseTurn = 0;
          if (e.zTo === 0) { e.turn = 0; e.turnTo = 0; holder.rotation.y = 0; } else { e.turnTo = 0.06; }
          e.anchor.set(0, -0.092, 0.034);
          swing.add(cord, cut);
        } else if (hanging) {
          const baseH = isStudioFull
            ? (p.slot === 'bottom' ? 1.04 : p.type === 'coat' ? 1.20 : p.slot === 'outer' ? 1.04 : 0.95)
            : (p.slot === 'bottom' ? 0.98 : p.type === 'coat' ? 1.14 : p.slot === 'outer' ? 0.98 : 0.90);
          const hgt = Math.min(1.22, Math.max(0.54, baseH));
          const planeW = hgt * Math.max(0.32, w0 / h0);
          const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(planeW, hgt)), mat);
          cut.position.set(0, (p.slot === 'bottom' ? -0.196 : -0.19) - hgt / 2, 0.012);
          cut.castShadow = true;
          cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.26 }));
          if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
          const hanger = photoHanger(wood, brassCordMat, p.slot, planeW);
          hanger.traverse((o) => { if (o.isMesh) { made.geo.add(o.geometry); if (o.material) made.mat.add(o.material); o.castShadow = true; } });
          if (isStudioFull) {
            e.sidePhoto = true;
            e.baseTurn = -0.06;
            if (e.zTo === 0) { e.turn = -0.06; e.turnTo = -0.06; holder.rotation.y = -0.06; }
          }
          e.anchor.set(0, -0.092, 0.034);
          swing.add(hanger, cut);
        } else {
          const shoeW = 0.33;
          const shoeH = shoeW * (h0 / w0);
          const cut = new THREE.Mesh(G(new THREE.PlaneGeometry(shoeW, shoeH)), mat);
          cut.position.set(0, 0.058 + shoeH * 0.48, 0.01);
          cut.rotation.x = -0.10;
          cut.castShadow = true;
          cut.customDepthMaterial = Mt(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.26 }));
          const vitrine = buildGlossyShoeVitrine(brassCordMat, vitrineDoorTex);
          vitrine.traverse((o) => { if (o.isMesh) { made.geo.add(o.geometry); if (o.material) made.mat.add(o.material); } });
          if (g) { swing.remove(g.object); g.dispose(); e.g = null; }
          e.anchor.set(0, 0.36, 0.14);
          swing.add(vitrine, cut);
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
  let vaultMode = Boolean(opts.vaultMode);
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

  function isOrbiting() {
    return view.turntable || Math.abs(view.az) > 0.03 || Math.abs(view.azTo) > 0.03 || view.pol > 0.05 || view.polTo > 0.05;
  }

  function isVaultActive() {
    return vaultMode || isOrbiting();
  }

  function aim() {
    const vaultOn = isVaultActive();
    const orbiting = isOrbiting();
    vaultGroup.visible = vaultOn;
    scene.background.copy(vaultOn ? bgVault : bgGallery);
    const focusX = orbiting ? view.x * 0.35 : view.x;
    const dist = view.d * view.distScale;
    const cosP = Math.cos(view.pol);
    const horiz = dist * cosP;
    const cx = focusX + Math.sin(view.az) * horiz;
    const cy = (orbiting ? 0.94 : 1.00) + Math.sin(view.pol) * dist * 0.72;
    const cz = Math.cos(view.az) * horiz;
    camera.position.set(cx, cy, cz);
    camera.lookAt(focusX, orbiting ? 0.90 : 1.00, orbiting ? 0.22 : 0);
  }

  function fit() {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, Math.round(opts.fill ? Math.max(320, host.clientHeight) : w < 640 ? Math.min(w * 1.25, window.innerHeight * 0.66) : Math.min(w * 0.48, 580)));
    renderer.setSize(w, h, false);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    camera.aspect = w / h;
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const th = tv * camera.aspect;
    const want = w < 640
      ? Math.min(layout.railLength, RAIL.spacing * 2.55)
      : Math.min(layout.railLength + 0.24, RAIL.spacing * 8.2 + 0.24);
    view.d = Math.max(want / 2 / th, 1.18 / tv);
    view.half = view.d * th;
    view.max = Math.max(0, half - view.half + 0.16);
    if (view.x === null) view.x = sortMode === 'review' ? 0 : -view.max * 0.25;
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
      const rightEdge = selectedItemId && w > 900 ? w - 428 : w + 36;
      const off = v3.z > 1 || x < -36 || x > rightEdge || y < 14 || y > h - 22;
      const tilt = e.hanging ? '-6deg' : '0deg';
      e.tag.style.transform = `translate3d(${(x + el.offsetLeft).toFixed(1)}px, ${(y + el.offsetTop).toFixed(1)}px, 0) translate(-50%, -50%) rotate(${tilt})`;
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

  function applyPoses() {
    const hangingList = entries.filter((x) => x.hanging);
    const k = hangingList.findIndex((x) => x.itemId === selectedItemId);
    const hasOutfit = outfitHighlight.ids.size > 0;
    for (const e of entries) {
      const on = e.itemId === selectedItemId;
      const inOutfit = outfitHighlight.ids.has(e.itemId);
      const isAnchor = outfitHighlight.anchorId === e.itemId;
      if (hasOutfit) {
        if (isAnchor || on) e.zTo = e.hanging ? 0.26 : 0.14;
        else if (inOutfit) e.zTo = e.hanging ? 0.17 : 0.1;
        else e.zTo = e.hanging ? -0.05 : -0.02;
      } else {
        e.zTo = on ? (e.hanging ? 0.24 : 0.1) : 0;
      }
      if (!e.hanging) continue;
      if (on || isAnchor) e.turnTo = e.sidePhoto ? 0.06 : 0;
      else if (inOutfit) e.turnTo = e.sidePhoto ? 0.04 : -0.1;
      else e.turnTo = e.baseTurn;
      const i = hangingList.indexOf(e);
      e.dxTo = k < 0 || on ? 0 : Math.sign(i - k) * PART * (Math.abs(i - k) === 1 ? 1 : 0.45);
    }
  }

  function select(itemId) {
    selectedItemId = itemId || null;
    for (const e of entries) refreshEntryTag(e);
    syncTagStagger();
    applyPoses();
    const e = entries.find((x) => x.itemId === selectedItemId);
    if (e) {
      if (view.max > 0) view.xTo = Math.max(-view.max, Math.min(view.max, e.holder.position.x));
      nudge(e, 0.55);
    }
    placeTags();
    invalidate();
  }

  function updatePiece(itemId, next = {}) {
    const e = entries.find((x) => x.itemId === itemId);
    const p = byId.get(itemId);
    if (!e || !p) return;
    if (next.availability) p.availability = next.availability;
    if (typeof next.wearCount === 'number') p.wearCount = next.wearCount;
    if ('tagRow' in next) e.slotTag = tagOf(next.tagRow);
    refreshEntryTag(e);
    syncTagStagger();
    placeTags();
    invalidate();
  }

  function setVaultMode(on) {
    vaultMode = Boolean(on);
    aim();
    if (opts.onCameraChange) opts.onCameraChange(cameraState());
    invalidate();
  }

  function setPreset(name) {
    const pr = CAMERA_PRESETS[name] || CAMERA_PRESETS.front;
    view.turntable = false;
    view.preset = CAMERA_PRESETS[name] ? name : 'front';
    view.dragMode = view.preset === 'front' ? 'slide' : 'orbit';
    if (view.preset !== 'front') vaultMode = true;
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

  function setShowTags(on) {
    showTags = Boolean(on);
    for (const e of entries) refreshEntryTag(e);
    syncTagStagger();
    placeTags();
    invalidate();
  }

  function setOutfitHighlight(ids, anchorId = null) {
    outfitHighlight = { ids: new Set(ids || []), anchorId: anchorId || null };
    for (const e of entries) {
      refreshEntryTag(e);
      if (outfitHighlight.ids.has(e.itemId)) nudge(e, 0.35);
    }
    syncTagStagger();
    applyPoses();
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
    return { preset: view.preset, dragMode: view.dragMode, turntable: view.turntable, vault: isVaultActive(), vaultMode };
  }

  const ro = new ResizeObserver(() => { fit(); invalidate(); });
  ro.observe(host);
  fit();
  if (outfitHighlight.ids.size > 0) applyPoses();
  if (!still && !phone()) entries.forEach((e, i) => { if (e.hanging) e.a = (i % 2 ? -1 : 1) * (0.03 + (hashOf(e.itemId) % 7) / 400); });
  invalidate();

  return {
    select,
    updatePiece,
    setVaultMode,
    setPreset,
    setDragMode,
    setTurntable,
    nudgeOrbit,
    setHeatMode,
    setShowTags,
    setOutfitHighlight,
    setPinned,
    cameraState,
    slide(dir) { if (view.max <= 0) return; view.vx = 0; view.xTo = Math.max(-view.max, Math.min(view.max, (view.xTo ?? view.x) + dir * view.half * 1.35)); invalidate(); },
    reset() {
      view.x = phone() ? -view.max : 0;
      view.xTo = null;
      view.vx = 0;
      setPreset('front');
      outfitHighlight = { ids: new Set(), anchorId: null };
      for (const e of entries) refreshEntryTag(e);
      syncTagStagger();
      applyPoses();
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
        outfit: [...outfitHighlight.ids],
        showTags,
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
