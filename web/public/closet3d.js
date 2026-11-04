// Closet in 3D (three.js, pinned 0.170.0). Draws the pieces from anatomy.js as cards on a wireframe
// closet: outerwear rail, tops shelf, bottoms shelf, shoe rack. A slider pulls the layers apart like an
// exploded diagram. It shows only what the closet already records; cards carry no prices or estimates.
import * as THREE from './vendor/three.module.min.js';

const LAYER_Y = { outer: 2.35, top: 0.8, bottom: -0.75, shoes: -2.3 };
const CARD_W = 0.98;
const CARD_H = 1.22;
const WIDTH = 4.9;
const STATE_TAG = { LAUNDRY: 'In the laundry', REPAIR: 'At repair', STORED: 'Stored' };

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

/** Draws one card. With `photo` (the owner's own mask cut-out) the card shows the real garment; otherwise a code-drawn silhouette. */
function drawCard(c, cell, fill, name, photo) {
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#fbfaf7';
  g.fillRect(0, 0, 256, 320);
  if (photo) {
    const pw = photo.width || 1;
    const ph = photo.height || 1;
    const k = Math.min(236 / pw, 236 / ph);
    const w = pw * k;
    const h = ph * k;
    g.imageSmoothingQuality = 'high';
    g.drawImage(photo, (256 - w) / 2, 8 + (236 - h) / 2, w, h);
  } else {
    const pts = SHAPES[cell.slot] || SHAPES.top;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.stroke();
  }
  g.textAlign = 'center';
  g.fillStyle = '#1d1b18';
  if (name) {
    g.font = '700 32px system-ui, -apple-system, sans-serif';
    g.fillText(cell.itemId, 128, 278);
    g.font = '600 22px system-ui, -apple-system, sans-serif';
    g.fillText(name.length > 20 ? `${name.slice(0, 19)}…` : name, 128, 306);
  } else {
    // No name (phones): the ID alone, large enough to read on a card a few dozen pixels wide.
    g.font = '700 56px system-ui, -apple-system, sans-serif';
    g.fillText(cell.itemId, 128, 300);
  }
  if (cell.availability !== 'AVAILABLE') {
    g.fillStyle = 'rgba(251,250,247,0.6)';
    g.fillRect(0, 0, 256, 248);
    g.fillStyle = '#1d1b18';
    g.font = '700 20px system-ui, -apple-system, sans-serif';
    g.fillText(STATE_TAG[cell.availability] || cell.availability, 128, 34);
  }
  g.lineWidth = cell.review === 'CANDIDATE' ? 10 : 2;
  g.strokeStyle = cell.review === 'CANDIDATE' ? '#c88a1a' : 'rgba(0,0,0,0.18)';
  g.strokeRect(5, 5, 246, 310);
}

function cardTexture(cell, fill, name, imageOf) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 320;
  drawCard(c, cell, fill, name, null);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const pending = imageOf ? imageOf(cell) : null;
  if (pending && typeof pending.then === 'function') {
    pending.then((photo) => { if (photo) { drawCard(c, cell, fill, name, photo); t.needsUpdate = true; } }).catch(() => {});
  }
  return t;
}

function lines(points, mat) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.LineSegments(geo, mat);
}

/**
 * Mounts the 3D closet into `host`. Returns null when the browser has no WebGL, so the caller can show the list instead.
 * @param {HTMLElement} host
 * @param {{layers: Array<{slot:string, items:Array<object>}>}} anatomy  result of buildAnatomy()
 * @param {{colorOf:(c:string)=>string, nameOf:(cell:object)=>string, onPick:(cell:object)=>void, imageOf?:(cell:object)=>Promise<CanvasImageSource|null>|null}} opts
 */
export function mountCloset3d(host, anatomy, opts) {
  if (!webglOk()) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  const root = new THREE.Group();
  root.rotation.set(0.1, -0.42, 0);
  scene.add(root);

  const frameMat = new THREE.LineBasicMaterial({ color: 0x8a8378, transparent: true, opacity: 0.85 });
  root.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(WIDTH + 0.6, 6.6, 1.5)), frameMat));
  const fixtureMat = new THREE.LineBasicMaterial({ color: 0x6f685e, transparent: true, opacity: 0.9 });

  const groups = [];
  const cards = [];
  anatomy.layers.forEach((layer, index) => {
    const g = new THREE.Group();
    g.userData = { baseY: LAYER_Y[layer.slot] ?? 0, index };
    const half = WIDTH / 2;
    if (layer.slot === 'outer') {
      g.add(lines([[-half, 0.76, 0], [half, 0.76, 0]], fixtureMat));
    } else {
      const y = -0.66;
      g.add(lines([[-half, y, -0.6], [half, y, -0.6], [half, y, -0.6], [half, y, 0.6], [half, y, 0.6], [-half, y, 0.6], [-half, y, 0.6], [-half, y, -0.6]], fixtureMat));
    }
    const n = layer.items.length;
    const step = n > 1 ? Math.min(0.98, (WIDTH - CARD_W) / (n - 1)) : 0;
    layer.items.forEach((cell, i) => {
      const mat = new THREE.MeshBasicMaterial({ map: cardTexture(cell, opts.colorOf(cell.color), opts.nameOf(cell), opts.imageOf), transparent: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), mat);
      const x = (i - (n - 1) / 2) * step;
      mesh.position.set(x, 0, 0.05 + i * 0.004);
      mesh.userData = { cell, baseX: x };
      if (layer.slot === 'outer') g.add(lines([[x, 0.76, 0], [x, 0.61, 0.05]], fixtureMat));
      g.add(mesh);
      cards.push(mesh);
    });
    root.add(g);
    groups.push(g);
  });

  let explode = 0;
  let selected = null;
  let picked = new Set();
  const vfov = (camera.fov * Math.PI) / 180;
  function layout() {
    for (const g of groups) {
      const { baseY, index } = g.userData;
      g.position.y = baseY * (1 + 0.42 * explode);
      g.position.z = explode * (1.7 - index * 0.6);
      for (const m of g.children) {
        if (!m.userData.cell) continue;
        m.position.x = m.userData.baseX * (1 + 0.3 * explode);
        m.rotation.y = explode * 0.38;
      }
    }
    frameMat.opacity = 0.85 - 0.7 * explode;
    const needH = 7.0 * (1 + 0.42 * explode);
    const needW = 6.2 * (1 + 0.3 * explode);
    const dH = needH / 2 / Math.tan(vfov / 2);
    const dW = needW / 2 / (Math.tan(vfov / 2) * camera.aspect);
    camera.position.set(0, 0.1, Math.max(dH, dW) * 1.05);
    camera.lookAt(0, 0, 0);
  }
  function resize() {
    const w = Math.max(280, host.clientWidth || 360);
    // Phones get a taller stage so the four layers and the cards stay readable.
    const h = Math.round(w < 480 ? Math.min(620, w * 1.45) : Math.min(540, Math.max(380, w * 1.2)));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  // Isolation view: once an outfit is being picked, every other card fades back.
  function paint() {
    for (const m of cards) {
      const id = m.userData.cell.itemId;
      const on = picked.size === 0 || picked.has(id) || m === selected;
      m.material.opacity = on ? 1 : 0.22;
      const k = m === selected ? 1.16 : picked.has(id) ? 1.1 : 1;
      m.scale.set(k, k, k);
    }
  }
  function select(mesh) {
    selected = mesh;
    paint();
  }

  const el = renderer.domElement;
  el.style.touchAction = 'pan-y';
  const ray = new THREE.Raycaster();
  let down = null;
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, ry: root.rotation.y, moved: false }; });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (Math.abs(dx) > 5) down.moved = true;
    if (down.moved) root.rotation.y = Math.max(-1.1, Math.min(1.1, down.ry + dx * 0.006));
  });
  el.addEventListener('pointerup', (e) => {
    const wasTap = down && !down.moved;
    down = null;
    if (!wasTap) return;
    const r = el.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(cards, false)[0];
    if (hit) {
      select(hit.object);
      opts.onPick(hit.object.userData.cell);
    }
  });
  el.addEventListener('pointercancel', () => { down = null; });
  el.addEventListener('pointerleave', () => { down = null; });

  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(host);
  resize();
  renderer.setAnimationLoop(() => {
    layout();
    renderer.render(scene, camera);
  });

  return {
    cardCount: cards.length,
    setExplode(v) { explode = Math.max(0, Math.min(1, v)); },
    /** Back to the opening view: the same turn and spread the page starts with. */
    reset() { root.rotation.set(0.1, -0.42, 0); explode = 0.35; },
    select(itemId) { select(cards.find((m) => m.userData.cell.itemId === itemId) || null); },
    setPicked(ids) { picked = new Set(ids); paint(); },
    dispose() { renderer.setAnimationLoop(null); renderer.dispose(); },
  };
}
