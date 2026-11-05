import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GarmentPiece } from '../types/closet';
import {
  computeGarmentRotationHeat,
  countRotationTiers,
  formatCurrency,
  hasFactsMoved,
  RotationHeatTier,
} from '../utils/ledgerLogic';
import { TagKind, tagForm } from '../utils/tagForms';

export type SceneViewMode = 'rail' | 'vault';

interface BoutiqueRail3DProps {
  garments: GarmentPiece[];
  selectedId: string | null;
  onSelectGarment: (id: string | null) => void;
  viewMode: SceneViewMode;
  railOffset: number;
  onRailOffsetChange: (offset: number) => void;
  showHangTags: boolean;
  showRotationHeatmap?: boolean;
  /**
   * Called once when the stage cannot be drawn (no WebGL 2, a renderer error, a lost context), when
   * the viewer asks for reduced motion ('reduced-motion'), or with ?force2d=1 ('forced'). The parent
   * then shows the grid; nothing is drawn here on failure.
   */
  onRenderFallback?: (reason: string) => void;
}

// Each is consumed once per page load, so a later mount ("Try 3D again", or the dock's 3D Rail)
// really tries the 3D stage.
let forcedFallbackConsumed = false;
let reducedMotionFallbackConsumed = false;

type RailStage = 'loading' | 'ready' | 'fallback';

interface ProjectedTag {
  id: string;
  code: string;
  brand: string;
  name: string;
  priceText: string;
  platformText: string;
  tagKind: TagKind;
  wearText: string;
  hollow: boolean;
  x: number;
  y: number;
  visible: boolean;
  isSelected: boolean;
  isSample: boolean;
  factsMoved: boolean;
  decision?: 'keep' | 'sell';
  lockedForToday?: boolean;
  /** null when the piece has no wear log (never shown as 0 wears). */
  wearsLast60Days: number | null;
  heatTier: RotationHeatTier;
  heatScore: number;
  heatColorHex: string;
  heatLabel: string;
  heatShortLabel: string;
  tagBgHex: string;
  tagBorderHex: string;
  tagTextHex: string;
}

const STUDIO_CUTOUT_SOURCES: Record<string, string> = {
  overcoat: '/src/assets/images/garment_cashmere_coat_1793834295814.jpg',
  blazer: '/src/assets/images/garment_tailored_blazer_1793834302922.jpg',
  hoodie: '/src/assets/images/garment_heavy_hoodie_1793834297908.jpg',
  blouson: '/src/assets/images/garment_leather_blouson_1793834299409.jpg',
  knit: '/src/assets/images/garment_heavy_hoodie_1793834297908.jpg',
  tee: '/src/assets/images/garment_tailored_blazer_1793834302922.jpg',
};

const FRONT_CUTOUT_SOURCES: Record<string, string> = {
  overcoat: '/src/assets/images/front_cashmere_coat_1793835552741.jpg',
  blazer: '/src/assets/images/front_tailored_blazer_1793835553313.jpg',
  hoodie: '/src/assets/images/front_heavy_hoodie_1793835551654.jpg',
  blouson: '/src/assets/images/front_leather_blouson_1793835550605.jpg',
  knit: '/src/assets/images/front_heavy_hoodie_1793835551654.jpg',
  tee: '/src/assets/images/front_tailored_blazer_1793835553313.jpg',
};

/**
 * Generates a tileable procedural fabric weave bump & roughness texture
 */
function createFabricWeaveTexture(
  renderer: THREE.WebGLRenderer,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 128, 128);

  for (let y = 0; y < 128; y += 2) {
    for (let x = 0; x < 128; x += 2) {
      const v = (x + y) % 4 === 0 ? 150 : 110;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, y, 2, 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 12);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/**
 * Generates a procedural Calacatta Gold & Hermès warm veined marble texture
 */
function createCalacattaMarbleTexture(
  renderer: THREE.WebGLRenderer,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FAF8F5';
  ctx.fillRect(0, 0, 512, 512);

  const veins = [
    { color: 'rgba(180, 172, 162, 0.25)', width: 9 },
    { color: 'rgba(197, 165, 114, 0.22)', width: 3.5 },
    { color: 'rgba(243, 112, 33, 0.09)', width: 2 },
  ];

  veins.forEach((v, idx) => {
    ctx.strokeStyle = v.color;
    ctx.lineWidth = v.width;
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      let x = (i * 97 + idx * 43) % 512;
      let y = 0;
      ctx.moveTo(x, y);
      while (y < 512) {
        y += 42;
        x += Math.sin(y * 0.03 + i) * 28 + 12;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/**
 * A cut-out that already carries its own transparency (a SAM mask or a box crop from a photo scan):
 * fitted into the garment plane top-centre, never keyed, cropped or re-dyed.
 */
function createDirectCutoutTexture(img: HTMLImageElement, renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const w = 512;
  const h = 680;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const s = Math.min((w * 0.92) / iw, (h * 0.9) / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2, h * 0.08, dw, dh);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

/**
 * Converts a studio garment photograph on a white backdrop into a transparent background-knockout
 * CanvasTexture tinted/graded to match the exact garment dye color while preserving natural highlights,
 * shadows, and fabric fold grain.
 */
function createKnockoutGarmentTexture(
  img: HTMLImageElement,
  targetHex: string,
  preserveOriginalHue: boolean,
  renderer: THREE.WebGLRenderer,
): THREE.CanvasTexture {
  const w = 512;
  const h = 680;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Sample studio backdrop RGB at top-left, top-right, bottom-left, bottom-right corners
  const samplePixel = (x: number, y: number) => {
    const idx = (y * w + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]];
  };
  const bgTL = samplePixel(6, 6);
  const bgTR = samplePixel(w - 7, 6);
  const bgBL = samplePixel(6, h - 7);
  const bgBR = samplePixel(w - 7, h - 7);

  const targetColor = new THREE.Color(targetHex);
  const tr = targetColor.r * 255;
  const tg = targetColor.g * 255;
  const tb = targetColor.b * 255;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const px = (i / 4) % w;
    const py = Math.floor(i / 4 / w);
    const u = px / w;
    const v = py / h;

    // Mask out top hanger hook area (y < 12.5%) so our 3D metal hook & rail engage cleanly
    if (v < 0.125) {
      data[i + 3] = 0;
      continue;
    }

    // Bilinearly interpolate expected studio background color at (u, v)
    const bgR =
      (1 - u) * (1 - v) * bgTL[0] +
      u * (1 - v) * bgTR[0] +
      (1 - u) * v * bgBL[0] +
      u * v * bgBR[0];
    const bgG =
      (1 - u) * (1 - v) * bgTL[1] +
      u * (1 - v) * bgTR[1] +
      (1 - u) * v * bgBL[1] +
      u * v * bgBR[1];
    const bgB =
      (1 - u) * (1 - v) * bgTL[2] +
      u * (1 - v) * bgTR[2] +
      (1 - u) * v * bgBL[2] +
      u * v * bgBR[2];

    const distToBg = Math.hypot(r - bgR, g - bgG, b - bgB);
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    if (distToBg < 38 || (lum > 224 && sat < 0.12)) {
      data[i + 3] = 0;
      continue;
    } else if (distToBg < 54 && sat < 0.16) {
      const alpha = Math.max(0, Math.min(1, (distToBg - 38) / 16));
      data[i + 3] = Math.round(alpha * 255);
    }

    if (!preserveOriginalHue && data[i + 3] > 0) {
      // Preserve natural studio fold highlights & crease depth while grading to target dye
      const foldContrast = Math.pow(Math.max(0.08, lum / 155), 0.88);
      const spec = Math.max(0, (lum - 165) * 0.45);
      data[i] = Math.min(255, Math.round(tr * (0.28 + foldContrast * 0.95) + spec));
      data[i + 1] = Math.min(
        255,
        Math.round(tg * (0.28 + foldContrast * 0.95) + spec),
      );
      data[i + 2] = Math.min(
        255,
        Math.round(tb * (0.28 + foldContrast * 0.95) + spec),
      );
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a photorealistic 3D Boutique Rail Garment Group:
 * - Real 3D curved champagne-brass / chrome hanger hook engaging the 3D rail
 * - Volumetric 3D relief shell with sculpted vertical depth folds paired with studio cutout photography
 */
function buildBoutiqueGarmentGroup(
  garment: GarmentPiece,
  fabricBump: THREE.Texture,
  brassMat: THREE.MeshStandardMaterial,
  chromeMat: THREE.MeshStandardMaterial,
): {
  root: THREE.Group;
  applyCutoutTexture: (tex: THREE.CanvasTexture) => void;
  showPlainShell: () => void;
} {
  const root = new THREE.Group();
  root.userData = { garmentId: garment.id };

  // 1. 3D Metal Hanger Hook looping over the horizontal boutique rail at y = 1.65
  const hookCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.15, 0),
    new THREE.Vector3(0, 1.54, 0),
    new THREE.Vector3(0, 1.68, -0.05),
    new THREE.Vector3(0, 1.72, 0.01),
    new THREE.Vector3(0, 1.64, 0.06),
  ]);
  const hookGeo = new THREE.TubeGeometry(hookCurve, 22, 0.013, 10, false);
  const hookMesh = new THREE.Mesh(
    hookGeo,
    garment.hangerType === 'matte-black' ? chromeMat : brassMat,
  );
  hookMesh.userData = { garmentId: garment.id };
  root.add(hookMesh);

  // Machined brass neck fastener collar
  const neckCollar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.024, 0.045, 12),
    brassMat,
  );
  neckCollar.position.set(0, 1.32, 0);
  neckCollar.userData = { garmentId: garment.id };
  root.add(neckCollar);

  // 2. Volumetric 3D Curved Relief Garment Shell
  const shellW = 1.44;
  const shellH = garment.silhouette === 'overcoat' ? 2.62 : 2.38;
  const shellCenterY = garment.silhouette === 'overcoat' ? 0.14 : 0.24;

  const frontGeo = new THREE.PlaneGeometry(shellW, shellH, 28, 36);
  const pos = frontGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const normX = vx / (shellW * 0.5);
    const normY = vy / (shellH * 0.5);

    const barrelZ = Math.cos(normX * Math.PI * 0.48) * 0.14;
    const pleatZ =
      Math.sin(vx * 9.5) * 0.024 * (1 - Math.abs(normX) * 0.5) +
      Math.cos(vy * 3.8 + vx * 5.0) * 0.015;
    const shoulderArch = normY > 0.4 ? Math.cos(normX * 1.4) * 0.04 : 0;

    pos.setZ(i, barrelZ + pleatZ + shoulderArch);
  }
  frontGeo.computeVertexNormals();

  const fallbackColor = new THREE.Color(garment.colorHex);
  const shellMat = new THREE.MeshStandardMaterial({
    color: fallbackColor,
    roughness: 0.72,
    metalness: 0.04,
    bumpMap: fabricBump,
    bumpScale: 0.006,
    alphaTest: 0.22,
    transparent: true,
    side: THREE.DoubleSide,
  });

  const frontShell = new THREE.Mesh(frontGeo, shellMat);
  frontShell.position.set(0, shellCenterY, 0.02);
  frontShell.castShadow = true;
  frontShell.receiveShadow = true;
  frontShell.userData = { garmentId: garment.id };
  // The hook and collar hang on the rail at once; the piece itself appears when its cut-out arrives
  // (or as a plain shell in its recorded colour when the photo cannot be loaded).
  frontShell.visible = false;
  root.add(frontShell);

  // Invisible hit-box proxy for fast raycasting
  const hitProxy = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 2.4, 0.5),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hitProxy.position.set(0, 0.3, 0);
  hitProxy.layers.set(1);
  hitProxy.userData = { garmentId: garment.id };
  root.add(hitProxy);

  const applyCutoutTexture = (tex: THREE.CanvasTexture) => {
    shellMat.map = tex;
    shellMat.color.setHex(0xffffff);
    shellMat.needsUpdate = true;
    frontShell.visible = true;
  };

  const showPlainShell = () => {
    frontShell.visible = true;
  };

  return { root, applyCutoutTexture, showPlainShell };
}

export const BoutiqueRail3D: React.FC<BoutiqueRail3DProps> = ({
  garments,
  selectedId,
  onSelectGarment,
  viewMode,
  railOffset,
  onRailOffsetChange,
  showHangTags,
  showRotationHeatmap = true,
  onRenderFallback,
}) => {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const [projectedTags, setProjectedTags] = useState<ProjectedTag[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [railStage, setRailStage] = useState<RailStage>('loading');
  // Pieces whose cut-out (or plain shell) is on the rail, over the pieces on it.
  const [cutoutsReady, setCutoutsReady] = useState<{ ready: number; total: number }>({
    ready: 0,
    total: 0,
  });

  const onRenderFallbackRef = useRef(onRenderFallback);
  onRenderFallbackRef.current = onRenderFallback;

  const garmentsRef = useRef(garments);
  garmentsRef.current = garments;

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const railOffsetRef = useRef(railOffset);
  railOffsetRef.current = railOffset;

  const onSelectRef = useRef(onSelectGarment);
  onSelectRef.current = onSelectGarment;

  const onRailOffsetChangeRef = useRef(onRailOffsetChange);
  onRailOffsetChangeRef.current = onRailOffsetChange;

  const requestRenderRef = useRef<() => void>(() => {});
  const rebuildGarmentsRef = useRef<() => void>(() => {});

  // The skeleton gets its paint first: the renderer is built two frames after the mount, so the
  // WebGL set-up (one long task on the main thread) never blocks the stage's first frame.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => setArmed(true));
    });
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!armed) return;
    const mount = canvasMountRef.current;
    if (!mount) return;
    const container: HTMLDivElement = mount;

    // One fallback call per mount, delivered on the next tick so the parent swaps to the grid after
    // this mount has settled. The canvas joins the stage only after a frame has drawn, so a failure
    // never leaves a black canvas behind.
    let fallbackFired = false;
    let fallbackTimer = 0;
    const fallBack = (reason: string) => {
      if (fallbackFired) return;
      fallbackFired = true;
      setRailStage('fallback');
      fallbackTimer = window.setTimeout(() => onRenderFallbackRef.current?.(reason), 0);
    };
    const cancelFallback = () => window.clearTimeout(fallbackTimer);

    if (
      !forcedFallbackConsumed &&
      new URLSearchParams(window.location.search).get('force2d') === '1'
    ) {
      forcedFallbackConsumed = true;
      fallBack('forced');
      return cancelFallback;
    }
    if (
      !reducedMotionFallbackConsumed &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      reducedMotionFallbackConsumed = true;
      fallBack('reduced-motion');
      return cancelFallback;
    }

    const probeGl = document.createElement('canvas').getContext('webgl2');
    if (!probeGl) {
      fallBack('WebGL 2 unavailable');
      return cancelFallback;
    }
    const isSoftwareGl = (() => {
      const ext = probeGl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probeGl.RENDERER;
      const gpu = String(probeGl.getParameter(param));
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();
    probeGl.getExtension('WEBGL_lose_context')?.loseContext();

    const createRenderer = (): THREE.WebGLRenderer | null => {
      try {
        return new THREE.WebGLRenderer({
          antialias: !isSoftwareGl,
          powerPreference: 'high-performance',
        });
      } catch {
        return null;
      }
    };
    const createdRenderer = createRenderer();
    if (!createdRenderer) {
      fallBack('renderer error');
      return cancelFallback;
    }
    const renderer: THREE.WebGLRenderer = createdRenderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const initialW = container.clientWidth || window.innerWidth;
    const initialH = container.clientHeight || window.innerHeight;
    renderer.setSize(initialW, initialH);
    // The canvas is added to the stage by the first drawn frame (see requestRender).
    let canvasShown = false;
    let halted = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#FFFFFF');
    scene.fog = new THREE.Fog('#FFFFFF', 15, 34);

    const camera = new THREE.PerspectiveCamera(34, initialW / initialH, 0.1, 60);
    camera.position.set(0, 0.48, 8.2);
    camera.lookAt(0, 0.36, 0);

    // Studio Environment Reflection (RoomEnvironment)
    try {
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      scene.environment = pmremGenerator.fromScene(
        new RoomEnvironment(),
        0.04,
      ).texture;
      pmremGenerator.dispose();
    } catch {
      renderer.dispose();
      fallBack('renderer error');
      return cancelFallback;
    }

    // Balanced 3-Point Boutique Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xf3efea, 1.25);
    hemiLight.position.set(0, 8, 0);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfffaf4, 1.45);
    keyLight.position.set(4.0, 6.2, 6.5);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 22;
    keyLight.shadow.camera.left = -8;
    keyLight.shadow.camera.right = 8;
    keyLight.shadow.camera.top = 5;
    keyLight.shadow.camera.bottom = -5;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xf5f7fa, 0.7);
    rimLight.position.set(-5.0, 3.5, -4.0);
    scene.add(rimLight);

    const fabricBump = createFabricWeaveTexture(renderer);
    const marbleTex = createCalacattaMarbleTexture(renderer);

    const chromeMat = new THREE.MeshPhysicalMaterial({
      color: 0xd8dce0,
      metalness: 0.95,
      roughness: 0.15,
      anisotropy: 0.8,
      clearcoat: 0.5,
    });

    const darkSteelMat = new THREE.MeshStandardMaterial({
      color: 0x8d9399,
      metalness: 0.88,
      roughness: 0.26,
    });

    const brassMat = new THREE.MeshPhysicalMaterial({
      color: 0xc8a974,
      metalness: 0.92,
      roughness: 0.18,
      anisotropy: 0.7,
    });

    const walnutMat = new THREE.MeshStandardMaterial({
      color: 0x5c3c24,
      roughness: 0.42,
      metalness: 0.06,
      bumpMap: fabricBump,
      bumpScale: 0.005,
    });

    const hermesMat = new THREE.MeshStandardMaterial({
      color: 0xf37021,
      roughness: 0.32,
      metalness: 0.08,
    });

    const whiteLacquerMat = new THREE.MeshPhysicalMaterial({
      color: 0xfaf8f5,
      roughness: 0.22,
      metalness: 0.02,
      clearcoat: 0.55,
      clearcoatRoughness: 0.18,
    });

    const marbleMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: marbleTex,
      roughness: 0.18,
      metalness: 0.02,
      clearcoat: 0.7,
      clearcoatRoughness: 0.12,
    });

    // Boutique Horizontal Brushed-Steel Rail + Left/Right Architectural CNC Wall Brackets
    // Framed at x = ±4.35 so both brackets are clearly visible in viewport like the Velvetica photo!
    const railAssembly = new THREE.Group();
    const railSpan = 9.2;
    const railY = 1.65;

    const mainBar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.044, 0.044, railSpan, 28),
      chromeMat,
    );
    mainBar.rotation.z = Math.PI / 2;
    mainBar.position.set(0, railY, 0);
    mainBar.castShadow = !isSoftwareGl;
    railAssembly.add(mainBar);

    // Subtle upper shadow-highlight seam on the rail
    const lowerShadowBar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.016, railSpan, 16),
      darkSteelMat,
    );
    lowerShadowBar.rotation.z = Math.PI / 2;
    lowerShadowBar.position.set(0, railY - 0.032, -0.01);
    railAssembly.add(lowerShadowBar);

    // Left and Right Architectural Wall-Mount Brackets (matching Velvetica screenshot)
    [-4.35, 4.35].forEach((bx) => {
      const bracketGroup = new THREE.Group();
      bracketGroup.position.set(bx, railY, 0);

      // Machined square wall mount block
      const mountBlock = new THREE.Mesh(
        new THREE.BoxGeometry(0.36, 0.24, 0.24),
        darkSteelMat,
      );
      bracketGroup.add(mountBlock);

      // Inner brushed chrome socket sleeve
      const socketSleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(0.068, 0.068, 0.48, 20),
        chromeMat,
      );
      socketSleeve.rotation.z = Math.PI / 2;
      bracketGroup.add(socketSleeve);

      // Signature Hermès Orange precision accent ring
      const orangeRing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.071, 0.071, 0.032, 20),
        hermesMat,
      );
      orangeRing.rotation.z = Math.PI / 2;
      orangeRing.position.set(bx < 0 ? 0.19 : -0.19, 0, 0);
      bracketGroup.add(orangeRing);

      railAssembly.add(bracketGroup);
    });

    scene.add(railAssembly);

    // Beverly Hills Walk-In Vault Architectural Group (visible in 'vault' mode)
    const vaultGroup = new THREE.Group();

    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(28, 20),
      new THREE.MeshStandardMaterial({
        color: 0xf7f4ef,
        roughness: 0.45,
        metalness: 0.04,
      }),
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -1.75;
    floorMesh.receiveShadow = !isSoftwareGl;
    vaultGroup.add(floorMesh);

    const backWall = new THREE.Mesh(
      new THREE.BoxGeometry(16, 5.6, 0.35),
      whiteLacquerMat,
    );
    backWall.position.set(0, 0.85, -1.55);
    backWall.receiveShadow = !isSoftwareGl;
    vaultGroup.add(backWall);

    [-4.8, -1.6, 1.6, 4.8].forEach((px) => {
      const pilaster = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 5.4, 0.85),
        whiteLacquerMat,
      );
      pilaster.position.set(px, 0.85, -1.15);
      vaultGroup.add(pilaster);

      const brassTrim = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 5.4, 0.04),
        brassMat,
      );
      brassTrim.position.set(px, 0.85, -0.72);
      vaultGroup.add(brassTrim);
    });

    const upperShelf = new THREE.Mesh(
      new THREE.BoxGeometry(10.2, 0.08, 0.82),
      whiteLacquerMat,
    );
    upperShelf.position.set(0, 2.25, -1.12);
    vaultGroup.add(upperShelf);

    const ledStrip = new THREE.Mesh(
      new THREE.BoxGeometry(10.0, 0.02, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xffedd5 }),
    );
    ledStrip.position.set(0, 2.2, -0.78);
    vaultGroup.add(ledStrip);

    // Signature Hermès Orange Archive Boxes on the upper shelf
    [-3.2, 0.0, 3.2].forEach((boxX, idx) => {
      const boxGroup = new THREE.Group();
      boxGroup.position.set(boxX, 2.41, -1.08);
      boxGroup.rotation.y = idx % 2 === 0 ? 0.08 : -0.12;

      const boxBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.68, 0.24, 0.48),
        hermesMat,
      );
      boxGroup.add(boxBody);

      const boxLid = new THREE.Mesh(
        new THREE.BoxGeometry(0.71, 0.05, 0.51),
        hermesMat,
      );
      boxLid.position.y = 0.11;
      boxGroup.add(boxLid);

      const ribbon = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.26, 0.52),
        walnutMat,
      );
      boxGroup.add(ribbon);

      vaultGroup.add(boxGroup);
    });

    // Calacatta Gold Marble Center Plinth Island
    const islandGroup = new THREE.Group();
    islandGroup.position.set(0, -1.38, 1.45);

    const marblePlinth = new THREE.Mesh(
      new THREE.BoxGeometry(3.8, 0.72, 1.25),
      marbleMat,
    );
    marblePlinth.castShadow = !isSoftwareGl;
    marblePlinth.receiveShadow = !isSoftwareGl;
    islandGroup.add(marblePlinth);

    const brassBasePlinth = new THREE.Mesh(
      new THREE.BoxGeometry(3.68, 0.08, 1.15),
      brassMat,
    );
    brassBasePlinth.position.y = -0.39;
    islandGroup.add(brassBasePlinth);

    const valetTray = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.04, 0.36),
      hermesMat,
    );
    valetTray.position.set(0.95, 0.38, 0.1);
    islandGroup.add(valetTray);

    vaultGroup.add(islandGroup);
    vaultGroup.visible = viewModeRef.current === 'vault';
    scene.add(vaultGroup);

    // Soft radial contact shadow under the boutique rail
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 256;
    shadowCanvas.height = 64;
    const sCtx = shadowCanvas.getContext('2d')!;
    const grad = sCtx.createRadialGradient(128, 32, 8, 128, 32, 120);
    grad.addColorStop(0, 'rgba(20, 20, 19, 0.1)');
    grad.addColorStop(1, 'rgba(20, 20, 19, 0.0)');
    sCtx.fillStyle = grad;
    sCtx.fillRect(0, 0, 256, 64);
    const contactShadowTex = new THREE.CanvasTexture(shadowCanvas);
    const contactShadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(10.5, 2.2),
      new THREE.MeshBasicMaterial({
        map: contactShadowTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    contactShadowPlane.rotation.x = -Math.PI / 2;
    contactShadowPlane.position.set(0, -1.42, 0);
    scene.add(contactShadowPlane);

    const garmentsContainer = new THREE.Group();
    scene.add(garmentsContainer);

    // Cache loaded HTMLImageElements and processed cutout textures
    const imageCache = new Map<string, HTMLImageElement>();
    const cutoutTextureCache = new Map<string, THREE.CanvasTexture>();

    const loadCutoutTextureUrl = (
      srcUrl: string,
      g: GarmentPiece,
      applyCb: (tex: THREE.CanvasTexture) => void,
      onLoadFailed: () => void,
    ) => {
      const cacheKey = `${srcUrl}::${g.colorHex}::${g.code}`;

      if (cutoutTextureCache.has(cacheKey)) {
        applyCb(cutoutTextureCache.get(cacheKey)!);
        return;
      }

      const processImg = (img: HTMLImageElement) => {
        if (g.cutoutSource) {
          const tex = createDirectCutoutTexture(img, renderer);
          cutoutTextureCache.set(cacheKey, tex);
          applyCb(tex);
          requestRenderRef.current();
          return;
        }
        const preserveOriginal =
          g.code === 'J1' || g.code === 'J2' || g.code === 'J3' || g.code === 'J4';
        const tex = createKnockoutGarmentTexture(
          img,
          g.colorHex,
          preserveOriginal,
          renderer,
        );
        cutoutTextureCache.set(cacheKey, tex);
        applyCb(tex);
        requestRenderRef.current();
      };

      if (imageCache.has(srcUrl)) {
        processImg(imageCache.get(srcUrl)!);
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        imageCache.set(srcUrl, img);
        processImg(img);
      };
      img.onerror = () => onLoadFailed();
      img.src = srcUrl;
    };

    interface GarmentSimState {
      id: string;
      group: THREE.Group;
      baseX: number;
      currentX: number;
      currentZ: number;
      currentRotY: number;
      currentScaleX: number;
      swayAngleZ: number;
      swayVelZ: number;
      sideTex: THREE.CanvasTexture | null;
      frontTex: THREE.CanvasTexture | null;
      showingFront: boolean;
      /** True once the piece is on the rail: a cut-out arrived, or the plain shell was shown. */
      appeared: boolean;
      applyCutoutTexture: (tex: THREE.CanvasTexture) => void;
      showPlainShell: () => void;
    }

    let simItems: GarmentSimState[] = [];
    const markAppeared = (item: GarmentSimState) => {
      if (item.appeared) return;
      item.appeared = true;
      // Counted over the current build only: the rail is rebuilt when the list changes, and a
      // texture that arrives late for a piece of an earlier build is not in simItems any more.
      setCutoutsReady({
        ready: simItems.filter((s) => s.appeared).length,
        total: simItems.length,
      });
    };
    // Dense, tactile boutique rail spacing (0.56m between hangers)
    const spacing = 0.56;

    const rebuildGarmentMeshes = () => {
      while (garmentsContainer.children.length > 0) {
        garmentsContainer.remove(garmentsContainer.children[0]);
      }
      simItems = [];

      const list = garmentsRef.current;
      setCutoutsReady({ ready: 0, total: list.length });
      const totalWidth = (list.length - 1) * spacing;

      list.forEach((g, idx) => {
        const baseX = -totalWidth / 2 + idx * spacing;
        const { root, applyCutoutTexture, showPlainShell } = buildBoutiqueGarmentGroup(
          g,
          fabricBump,
          brassMat,
          chromeMat,
        );

        const isSel = selectedIdRef.current === g.id;
        const initialRotY = isSel ? 0.0 : -0.22;
        root.position.set(baseX - railOffsetRef.current, 0, (idx % 2) * 0.035);
        root.rotation.y = initialRotY;
        garmentsContainer.add(root);

        const simItem: GarmentSimState = {
          id: g.id,
          group: root,
          baseX,
          currentX: baseX - railOffsetRef.current,
          currentZ: isSel ? 1.28 : 0,
          currentRotY: initialRotY,
          currentScaleX: isSel ? 1.18 : 1.0,
          swayAngleZ: 0,
          swayVelZ: 0,
          sideTex: null,
          frontTex: null,
          showingFront: isSel,
          appeared: false,
          applyCutoutTexture: (tex) => {
            applyCutoutTexture(tex);
            markAppeared(simItem);
          },
          showPlainShell,
        };

        // When a photo cannot be loaded, the piece still hangs as a plain shell in its colour.
        const onPhotoFailed = () => {
          if (simItem.appeared) return;
          simItem.showPlainShell();
          markAppeared(simItem);
          requestRenderRef.current();
        };

        // Listed before its textures are requested, so a cached cut-out counts at once.
        simItems.push(simItem);

        const sideUrl =
          g.imageUrl ||
          STUDIO_CUTOUT_SOURCES[g.silhouette] ||
          STUDIO_CUTOUT_SOURCES.hoodie;
        const frontUrl =
          g.frontImageUrl ||
          FRONT_CUTOUT_SOURCES[g.silhouette] ||
          FRONT_CUTOUT_SOURCES.hoodie;

        loadCutoutTextureUrl(
          sideUrl,
          g,
          (tex) => {
            simItem.sideTex = tex;
            if (selectedIdRef.current !== g.id) {
              simItem.applyCutoutTexture(tex);
              simItem.showingFront = false;
            }
          },
          onPhotoFailed,
        );

        loadCutoutTextureUrl(
          frontUrl,
          g,
          (tex) => {
            simItem.frontTex = tex;
            if (selectedIdRef.current === g.id) {
              simItem.applyCutoutTexture(tex);
              simItem.showingFront = true;
            }
          },
          onPhotoFailed,
        );
      });
    };

    rebuildGarmentMeshes();

    if (!isSoftwareGl) {
      try {
        renderer.compile(scene, camera);
      } catch {
        renderer.dispose();
        fallBack('renderer error');
        return cancelFallback;
      }
    }

    const _projVec = new THREE.Vector3();
    const _camTargetPos = new THREE.Vector3(0, 0.48, 8.2);
    const _camLookAt = new THREE.Vector3(0, 0.36, 0);
    const _currentLookAt = new THREE.Vector3(0, 0.36, 0);

    // Hand-rifling (pointer proximity & sweep) state + inertial rail momentum
    let hoverWorldX: number | null = null;
    let railMomentumVel = 0;

    // Smooth quintic ease-out glide choreographer state
    const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
    let glideActive = false;
    let glideStartTime = 0;
    const glideDurationMs = 680;
    let glideFromOffset = railOffsetRef.current;
    let glideToOffset = railOffsetRef.current;
    let glideFromCamPos = new THREE.Vector3(0, 0.48, 8.2);
    let glideFromLookAt = new THREE.Vector3(0, 0.36, 0);
    let lastTrackedSelectedId: string | null = selectedIdRef.current;

    const triggerSelectionGlide = (newSelectedId: string | null) => {
      const list = garmentsRef.current;
      const idx = newSelectedId
        ? list.findIndex((g) => g.id === newSelectedId)
        : -1;

      glideFromOffset = railOffsetRef.current;
      if (idx !== -1) {
        const totalWidth = (list.length - 1) * spacing;
        glideToOffset = -totalWidth / 2 + idx * spacing;
      } else {
        glideToOffset = 0;
      }

      railMomentumVel = 0;
      glideFromCamPos.copy(camera.position);
      glideFromLookAt.copy(_currentLookAt);
      glideStartTime = performance.now();
      glideActive = true;

      // Impart a physical sway wave across hangers as the rail starts gliding
      const offsetDelta = glideToOffset - glideFromOffset;
      simItems.forEach((item, i) => {
        const isTarget = item.id === newSelectedId;
        const ripple = isTarget
          ? 0.28
          : Math.max(-0.18, Math.min(0.18, offsetDelta * 0.06 * ((i % 2) + 0.5)));
        item.swayVelZ += ripple;
      });
    };

    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let lastTime = performance.now();

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync
        ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
        : null;
      gl.flush();
      if (!sync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const poll = () => {
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    const updateProjectedHangTags = () => {
      const rect = renderer.domElement.getBoundingClientRect();
      const w = rect.width || initialW;
      const h = rect.height || initialH;
      const list = garmentsRef.current;

      const nextTags: ProjectedTag[] = simItems.map((item) => {
        const g = list.find((piece) => piece.id === item.id)!;
        const form = tagForm(g);
        const isSel = selectedIdRef.current === g.id;

        _projVec.set(
          item.group.position.x + 0.04,
          1.22,
          item.group.position.z + 0.2,
        );
        _projVec.project(camera);

        const screenX = ((_projVec.x + 1) / 2) * w;
        const screenY = ((-_projVec.y + 1) / 2) * h;
        const rightBound = selectedIdRef.current && w > 1024 ? w - 510 : w - 24;
        const visible =
          _projVec.z < 1 &&
          screenX > 24 &&
          screenX < rightBound &&
          screenY > 40;

        const heat = computeGarmentRotationHeat(g);

        return {
          id: g.id,
          code: g.code,
          brand: g.brand,
          name: g.name,
          priceText: form.priceText,
          platformText: form.platform ?? '',
          tagKind: form.kind,
          wearText: form.wearText,
          hollow: form.hollow,
          x: Math.round(screenX),
          y: Math.round(screenY),
          visible,
          isSelected: isSel,
          isSample: g.isSample,
          factsMoved: hasFactsMoved(g),
          decision: g.lastDecision?.choice,
          lockedForToday: g.lockedForToday,
          wearsLast60Days: heat.wearsLast60Days,
          heatTier: heat.tier,
          heatScore: heat.heatScore,
          heatColorHex: heat.heatColorHex,
          heatLabel: heat.label,
          heatShortLabel: heat.shortLabel,
          tagBgHex: heat.tagBgHex,
          tagBorderHex: heat.tagBorderHex,
          tagTextHex: heat.tagTextHex,
        };
      });

      setProjectedTags(nextTags);
    };

    const stepSimulation = (): boolean => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.008, (now - lastTime) / 1000));
      lastTime = now;

      if (selectedIdRef.current !== lastTrackedSelectedId) {
        lastTrackedSelectedId = selectedIdRef.current;
        triggerSelectionGlide(lastTrackedSelectedId);
      }

      let stillMoving = false;
      const isVault = viewModeRef.current === 'vault';
      vaultGroup.visible = isVault;
      contactShadowPlane.visible = !isVault;

      const targetBg = isVault ? 0xfaf8f5 : 0xffffff;
      (scene.background as THREE.Color).setHex(targetBg);

      const hasSelection = Boolean(selectedIdRef.current);
      // Shift camera slightly right when inspection drawer is open on desktop so the rail stays centered in the left canvas
      const drawerOffsetX = hasSelection ? 1.18 : 0;

      if (isVault) {
        _camTargetPos.set(drawerOffsetX, hasSelection ? 0.52 : 0.62, hasSelection ? 8.0 : 9.2);
        _camLookAt.set(drawerOffsetX, hasSelection ? 0.28 : 0.25, 0);
      } else {
        // Dolly camera gracefully closer when a garment is selected
        _camTargetPos.set(drawerOffsetX, hasSelection ? 0.38 : 0.45, hasSelection ? 6.95 : 7.85);
        _camLookAt.set(drawerOffsetX, hasSelection ? 0.32 : 0.34, 0);
      }

      if (glideActive) {
        const rawT = Math.min(1, (now - glideStartTime) / glideDurationMs);
        const easedT = easeOutQuint(rawT);

        // Smoothly interpolate rail offset along quintic ease-out curve
        const interpolatedOffset = THREE.MathUtils.lerp(
          glideFromOffset,
          glideToOffset,
          easedT,
        );
        railOffsetRef.current = interpolatedOffset;

        // Smoothly interpolate camera position and lookAt target along quintic ease-out curve
        camera.position.lerpVectors(glideFromCamPos, _camTargetPos, easedT);
        _currentLookAt.lerpVectors(glideFromLookAt, _camLookAt, easedT);
        camera.lookAt(_currentLookAt);

        if (rawT >= 1) {
          glideActive = false;
          onRailOffsetChangeRef.current(glideToOffset);
        } else {
          stillMoving = true;
        }
      } else {
        // Apply inertial rail momentum when user flicks/drags the rack
        if (Math.abs(railMomentumVel) > 0.008) {
          const nextOffset = THREE.MathUtils.clamp(
            railOffsetRef.current + railMomentumVel * dt,
            -2.6,
            2.6,
          );
          railOffsetRef.current = nextOffset;
          onRailOffsetChangeRef.current(nextOffset);
          railMomentumVel *= Math.exp(-5.5 * dt);
          stillMoving = true;
        } else {
          railMomentumVel = 0;
        }

        const camDist = camera.position.distanceTo(_camTargetPos);
        if (camDist > 0.004) {
          camera.position.x = THREE.MathUtils.damp(
            camera.position.x,
            _camTargetPos.x,
            7.5,
            dt,
          );
          camera.position.y = THREE.MathUtils.damp(
            camera.position.y,
            _camTargetPos.y,
            7.5,
            dt,
          );
          camera.position.z = THREE.MathUtils.damp(
            camera.position.z,
            _camTargetPos.z,
            7.5,
            dt,
          );
          _currentLookAt.lerp(_camLookAt, 0.18);
          camera.lookAt(_currentLookAt);
          stillMoving = true;
        }
      }

      const activeId = selectedIdRef.current;

      simItems.forEach((item, idx) => {
        const isSel = item.id === activeId;

        // Swap texture between 100% straight-on Front Shot (when selected) and Side Boutique Profile (when on rail)
        if (isSel && !item.showingFront && item.frontTex) {
          item.applyCutoutTexture(item.frontTex);
          item.showingFront = true;
        } else if (!isSel && item.showingFront && item.sideTex) {
          item.applyCutoutTexture(item.sideTex);
          item.showingFront = false;
        }

        const selItem = simItems.find((s) => s.id === activeId);
        let spreadOffset = 0;
        if (selItem && !isSel) {
          spreadOffset = item.baseX < selItem.baseX ? -0.82 : 0.82;
        }

        // Tactile Hand-Rifling (손으로 훑는 모션): garments part & lift around the pointer's world X
        let handPartX = 0;
        let handLiftZ = 0;
        let handTwistY = 0;
        if (hoverWorldX !== null && !isSel) {
          const nominalX = item.baseX - railOffsetRef.current + spreadOffset;
          const distFromHand = nominalX - hoverWorldX;
          const absDist = Math.abs(distFromHand);
          if (absDist < 0.95) {
            const influence = Math.pow(1 - absDist / 0.95, 2);
            // Garments on either side of the hand gently part outward so you can see the piece under your hand
            if (absDist > 0.04) {
              handPartX = Math.sign(distFromHand) * influence * 0.19;
            }
            // Garment directly under the hand comes slightly forward & turns toward the viewer
            handLiftZ = influence * 0.22;
            handTwistY = influence * 0.14;
          }
        }

        const targetX =
          item.baseX - railOffsetRef.current + spreadOffset + handPartX;
        const targetZ = isSel ? 1.28 : (idx % 2) * 0.03 + handLiftZ;
        // 0.0 rad = 100% straight-on front shot when selected; -0.22 rad when hanging on rail
        const targetRotY = isSel ? 0.0 : -0.22 + handTwistY;
        const targetScaleX = isSel ? 1.18 : 1.0;

        const prevX = item.currentX;
        item.currentX = THREE.MathUtils.damp(item.currentX, targetX, 10.5, dt);
        item.currentZ = THREE.MathUtils.damp(item.currentZ, targetZ, 9.5, dt);
        item.currentRotY = THREE.MathUtils.damp(
          item.currentRotY,
          targetRotY,
          9.5,
          dt,
        );
        item.currentScaleX = THREE.MathUtils.damp(
          item.currentScaleX,
          targetScaleX,
          8.5,
          dt,
        );

        const vx = (item.currentX - prevX) / dt;
        const targetSway = THREE.MathUtils.clamp(-vx * 0.042, -0.22, 0.22);
        const springForce = (targetSway - item.swayAngleZ) * 44;
        item.swayVelZ = (item.swayVelZ + springForce * dt) * Math.exp(-5.8 * dt);
        item.swayAngleZ += item.swayVelZ * dt;

        item.group.position.set(item.currentX, 0, item.currentZ);
        item.group.rotation.y = item.currentRotY;
        item.group.rotation.z = item.swayAngleZ;
        item.group.scale.set(item.currentScaleX, 1.0, 1.0);

        if (
          Math.abs(item.currentX - targetX) > 0.002 ||
          Math.abs(item.currentZ - targetZ) > 0.002 ||
          Math.abs(item.currentRotY - targetRotY) > 0.002 ||
          Math.abs(item.currentScaleX - targetScaleX) > 0.002 ||
          Math.abs(item.swayAngleZ) > 0.002 ||
          Math.abs(item.swayVelZ) > 0.002
        ) {
          stillMoving = true;
        }
      });

      return stillMoving;
    };

    function requestRender() {
      if (halted) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      lastTime = performance.now();
      frameId = requestAnimationFrame(() => {
        if (halted) return;
        renderDirty = false;
        const needsMoreFrames = stepSimulation();
        try {
          renderer.render(scene, camera);
        } catch {
          halted = true;
          renderBusy = false;
          fallBack('renderer error');
          return;
        }
        if (!canvasShown) {
          canvasShown = true;
          container.innerHTML = '';
          container.appendChild(renderer.domElement);
          setRailStage('ready');
        }
        updateProjectedHangTags();

        const done = () => {
          renderBusy = false;
          if (renderDirty || needsMoreFrames) {
            requestRender();
          }
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    }

    requestRenderRef.current = requestRender;
    rebuildGarmentsRef.current = () => {
      rebuildGarmentMeshes();
      requestRender();
    };

    requestRender();

    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(1);
    const pointer = new THREE.Vector2();
    const _planeIntersect = new THREE.Vector3();
    const _railPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    let isDragging = false;
    let dragStartX = 0;
    let lastPointerX = 0;
    let lastPointerTime = performance.now();
    let dragStartOffset = 0;
    let pointerMovedDist = 0;

    const getGarmentIdFromEvent = (
      clientX: number,
      clientY: number,
    ): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(garmentsContainer.children, true);
      if (hits.length > 0) {
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj) {
          if (obj.userData && obj.userData.garmentId) {
            return obj.userData.garmentId as string;
          }
          obj = obj.parent;
        }
      }
      return null;
    };

    const updateHandRiflingFromEvent = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const now = performance.now();
      const dtMs = Math.max(8, now - lastPointerTime);
      const pointerVelPx = (clientX - lastPointerX) / dtMs;
      lastPointerX = clientX;
      lastPointerTime = now;

      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.ray.intersectPlane(_railPlane, _planeIntersect)) {
        // Only apply hand-rifling when pointer is near the garment vertical band
        if (_planeIntersect.y > -1.35 && _planeIntersect.y < 1.85) {
          const prevHoverX = hoverWorldX;
          hoverWorldX = _planeIntersect.x;

          // Impart a soft fabric-brush sway impulse to hangers crossed by the pointer
          if (prevHoverX !== null && Math.abs(pointerVelPx) > 0.08) {
            simItems.forEach((item) => {
              const dist = Math.abs(item.currentX - hoverWorldX!);
              if (dist < 0.42) {
                item.swayVelZ += THREE.MathUtils.clamp(
                  -pointerVelPx * 0.085,
                  -0.24,
                  0.24,
                );
              }
            });
          }
          requestRender();
        } else if (hoverWorldX !== null) {
          hoverWorldX = null;
          requestRender();
        }
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      glideActive = false;
      railMomentumVel = 0;
      dragStartX = e.clientX;
      lastPointerX = e.clientX;
      lastPointerTime = performance.now();
      dragStartOffset = railOffsetRef.current;
      pointerMovedDist = 0;
    };

    let lastHoverCheck = 0;
    const onPointerMove = (e: PointerEvent) => {
      if (isDragging) {
        const now = performance.now();
        const dtSec = Math.max(0.008, (now - lastPointerTime) / 1000);
        const stepDx = e.clientX - lastPointerX;
        lastPointerX = e.clientX;
        lastPointerTime = now;

        const dx = e.clientX - dragStartX;
        pointerMovedDist = Math.max(pointerMovedDist, Math.abs(dx));
        const nextOffset = THREE.MathUtils.clamp(
          dragStartOffset - dx * 0.0075,
          -2.6,
          2.6,
        );
        railMomentumVel = THREE.MathUtils.clamp(
          (-stepDx * 0.0075) / dtSec,
          -3.5,
          3.5,
        );
        railOffsetRef.current = nextOffset;
        onRailOffsetChangeRef.current(nextOffset);
        updateHandRiflingFromEvent(e.clientX, e.clientY);
        requestRender();
        return;
      }

      updateHandRiflingFromEvent(e.clientX, e.clientY);

      const now = performance.now();
      if (now - lastHoverCheck < 50) return;
      lastHoverCheck = now;
      const tagEl =
        e.target instanceof Element
          ? e.target.closest('[data-hang-tag-id]')
          : null;
      const tagHitId = tagEl ? tagEl.getAttribute('data-hang-tag-id') : null;
      const hitId = tagHitId || getGarmentIdFromEvent(e.clientX, e.clientY);
      setHoveredId(hitId);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      if (pointerMovedDist < 7) {
        railMomentumVel = 0;
        const hitId = getGarmentIdFromEvent(e.clientX, e.clientY);
        if (hitId) {
          // Clicking an already-selected garment toggles back out to the full rail; clicking a new garment selects it
          const nextId = selectedIdRef.current === hitId ? null : hitId;
          onSelectRef.current(nextId);
          const sim = simItems.find((s) => s.id === hitId);
          if (sim) {
            sim.swayVelZ += 0.32;
          }
          requestRender();
        } else if (selectedIdRef.current !== null) {
          // Clicking anywhere outside the garment zooms smoothly back out to the full boutique rail!
          onSelectRef.current(null);
          requestRender();
        }
      } else {
        requestRender();
      }
    };

    const onPointerLeave = () => {
      if (hoverWorldX !== null) {
        hoverWorldX = null;
        requestRender();
      }
    };

    const onWheel = (e: WheelEvent) => {
      glideActive = false;
      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const nextOffset = THREE.MathUtils.clamp(
        railOffsetRef.current + delta * 0.0032,
        -2.6,
        2.6,
      );
      railOffsetRef.current = nextOffset;
      onRailOffsetChangeRef.current(nextOffset);
      requestRender();
    };

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    };

    const domElem = renderer.domElement;
    const onContextLost = () => {
      halted = true;
      fallBack('WebGL context lost');
    };
    domElem.addEventListener('webglcontextlost', onContextLost);
    domElem.addEventListener('pointerdown', onPointerDown);
    domElem.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    domElem.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', onResize);

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'SELECT'
      ) {
        return;
      }
      if (e.key === 'Escape' && selectedIdRef.current !== null) {
        onSelectRef.current(null);
        return;
      }
      const list = garmentsRef.current;
      if (list.length === 0) return;
      const curIdx = list.findIndex((g) => g.id === selectedIdRef.current);

      if (e.key === 'ArrowRight') {
        const nextIdx = curIdx < list.length - 1 ? curIdx + 1 : 0;
        onSelectRef.current(list[nextIdx].id);
      } else if (e.key === 'ArrowLeft') {
        const prevIdx = curIdx > 0 ? curIdx - 1 : list.length - 1;
        onSelectRef.current(list[prevIdx].id);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      halted = true;
      cancelFallback();
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      domElem.removeEventListener('webglcontextlost', onContextLost);
      domElem.removeEventListener('pointerdown', onPointerDown);
      domElem.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      domElem.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      renderer.dispose();
    };
  }, [armed]);

  useEffect(() => {
    rebuildGarmentsRef.current();
  }, [garments]);

  useEffect(() => {
    requestRenderRef.current();
  }, [selectedId, viewMode, railOffset]);

  const hoveredGarment = hoveredId
    ? garments.find((g) => g.id === hoveredId) ?? null
    : null;
  const hoveredTag = hoveredId
    ? projectedTags.find((t) => t.id === hoveredId) ?? null
    : null;

  // Counted over the non-sample pieces on the rail; pieces without a wear log are their own group.
  const tierCounts = countRotationTiers(garments);

  return (
    <div
      className="relative w-full h-full select-none overflow-hidden bg-white"
      data-testid="boutique-rail-viewport"
      data-view-mode={viewMode}
      data-rotation-heatmap={showRotationHeatmap ? 'on' : 'off'}
      data-rail-stage={railStage}
      data-cutouts-ready={`${cutoutsReady.ready}/${cutoutsReady.total}`}
    >
      <div
        ref={canvasMountRef}
        className={`w-full h-full ${hoveredId ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}`}
      />
      {/* Skeleton while the renderer builds its first frame: a rail bar and hooks, never a blank stage. */}
      {railStage !== 'ready' && (
        <div aria-hidden="true" data-testid="rail-skeleton" className="absolute inset-0 pointer-events-none">
          <div className="absolute left-0 right-0 rounded-full bg-[#D9D3C9]" style={{ top: '27%', height: 6 }} />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="absolute w-px bg-[#C9C2B6]" style={{ left: `${12 + i * 11}%`, top: '27.5%', height: 28 }} />
          ))}
        </div>
      )}

      {/* Rotation Heatmap Legend Plaque (Subtle Cool Blue -> Hot Orange Scale) */}
      {showRotationHeatmap && showHangTags && (
        <div
          data-testid="rotation-heatmap-legend"
          style={{
            right: selectedId ? '500px' : '24px',
          }}
          className="pointer-events-none hidden md:flex fixed top-[74px] z-20 bg-white/95 border border-[#E7E2DA] rounded-xl px-3.5 py-2 shadow-sm items-center gap-3 transition-all duration-200"
        >
          <div>
            <div className="text-[10px] font-semibold tracking-wider text-[#141413] uppercase">
              Rotation Heatmap · wears logged, 60d
            </div>
            <div
              className="text-[10px] text-[#8C857B] font-mono-num"
              data-testid="rotation-heatmap-counts"
            >
              {tierCounts.cool} Cold · {tierCounts.warm} Warm · {tierCounts.hot}{' '}
              Hot · {tierCounts.noLog} no log (of {tierCounts.total})
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono-num">
            <span className="px-1.5 py-0.5 rounded bg-[#EFF6FF] border border-[#60A5FA] text-[#1E3A8A] font-medium">
              Cold 0–2x
            </span>
            <div
              className="w-14 h-2 rounded-full border border-black/10"
              style={{
                background:
                  'linear-gradient(90deg, #3B82F6 0%, #F59E0B 50%, #F37021 100%)',
              }}
            />
            <span className="px-1.5 py-0.5 rounded bg-[#FFF3EB] border border-[#F37021] text-[#9A3412] font-medium">
              Hot 6+x
            </span>
          </div>
        </div>
      )}

      {showHangTags && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden z-10">
          {projectedTags.map((tag) => {
            if (!tag.visible) return null;
            const useHeatStyle =
              showRotationHeatmap && !tag.isSelected && !tag.isSample;
            const noPrice = tag.tagKind === 'no-price';
            const showWear = showRotationHeatmap && !tag.isSample;
            const secondaryText = tag.isSample
              ? 'Sample'
              : tag.decision === 'sell'
                ? 'Sell'
                : tag.decision === 'keep'
                  ? 'Keep'
                  : tag.platformText;

            return (
              <button
                key={tag.id}
                type="button"
                data-testid={`hang-tag-${tag.code}`}
                data-hang-tag-id={tag.id}
                data-rotation-heat={tag.heatTier}
                data-heatmap-active={showRotationHeatmap ? 'true' : 'false'}
                data-tag-kind={tag.tagKind}
                aria-pressed={tag.isSelected}
                data-wear-log={tag.hollow ? 'none' : 'verified'}
                onMouseEnter={() => setHoveredId(tag.id)}
                onMouseLeave={() =>
                  setHoveredId((prev) => (prev === tag.id ? null : prev))
                }
                onFocus={() => setHoveredId(tag.id)}
                onBlur={() =>
                  setHoveredId((prev) => (prev === tag.id ? null : prev))
                }
                onClick={() =>
                  onSelectGarment(tag.isSelected ? null : tag.id)
                }
                aria-label={`Inspect ${tag.code} ${tag.name} (${tag.priceText})`}
                style={{
                  transform: `translate3d(${tag.x}px, ${tag.y}px, 0) translate(-50%, -50%) rotate(-3deg)`,
                  ...(useHeatStyle
                    ? {
                        backgroundColor: tag.tagBgHex,
                        borderColor: tag.tagBorderHex,
                      }
                    : {}),
                }}
                className={`closer-hang-tag pointer-events-auto absolute top-0 left-0 transition-transform duration-150 px-2.5 py-1 rounded-md shadow-sm border text-left whitespace-nowrap overflow-hidden ${
                  tag.isSelected
                    ? `bg-[#F37021] text-white scale-110 z-20 shadow-md ${
                        noPrice ? 'border-dashed border-white/80' : 'border-[#F37021]'
                      }`
                    : tag.isSample
                      ? 'bg-[#FAF8F5] text-[#57534E] border-dashed border-[#C5A572] hover:border-[#F37021]'
                      : noPrice
                        ? 'bg-white text-[#57534E] border-dashed border-[#B8B2A7] hover:border-[#F37021]'
                        : 'bg-white text-[#141413] border-[#E7E2DA] hover:border-[#F37021]'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1">
                    {showWear && !tag.isSelected && (
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          tag.hollow ? 'border bg-transparent' : ''
                        }`}
                        style={
                          tag.hollow
                            ? { borderColor: tag.heatColorHex }
                            : { backgroundColor: tag.heatColorHex }
                        }
                        data-wear-dot={tag.hollow ? 'hollow' : 'solid'}
                        title={
                          tag.hollow
                            ? tag.wearText
                            : `${tag.heatLabel} (${tag.wearsLast60Days} logged)`
                        }
                      />
                    )}
                    <span
                      className={
                        noPrice
                          ? 'text-xs font-medium tracking-tight'
                          : 'text-xs font-semibold font-mono-num tracking-tight'
                      }
                      style={useHeatStyle ? { color: tag.tagTextHex } : undefined}
                    >
                      {tag.priceText}
                    </span>
                  </div>
                  {tag.factsMoved && !tag.isSelected && (
                    <span
                      className="text-[10px] font-semibold text-[#F37021]"
                      title="Latest recorded price differs from the price at the last decision"
                    >
                      · Δ
                    </span>
                  )}
                </div>
                <div
                  className={`text-[9px] leading-tight flex items-center gap-1 ${
                    tag.isSelected ? 'text-white/90' : 'text-[#8C857B]'
                  }`}
                  style={
                    useHeatStyle
                      ? { color: tag.tagTextHex, opacity: 0.85 }
                      : undefined
                  }
                >
                  <span>{tag.code}</span>
                  {secondaryText && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{secondaryText}</span>
                    </>
                  )}
                  {showWear && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span
                        className="font-mono-num font-semibold"
                        data-testid={`hang-tag-wear-${tag.code}`}
                      >
                        {tag.hollow || !tag.wearsLast60Days
                          ? tag.wearText
                          : `${tag.wearsLast60Days}x ${tag.heatShortLabel}`}
                      </span>
                    </>
                  )}
                </div>

                {/* Subtle Bottom Rotation Heat Bar on Hang-Tag */}
                {showRotationHeatmap &&
                  !tag.isSelected &&
                  !tag.isSample &&
                  tag.wearsLast60Days !== null && (
                  <div className="w-full h-0.5 bg-black/5 rounded-full mt-0.5 overflow-hidden">
                    <div
                      style={{
                        width: `${Math.max(18, Math.round(tag.heatScore * 100))}%`,
                        backgroundColor: tag.heatColorHex,
                      }}
                      className="h-full rounded-full"
                    />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 'Quick Look' Floating Hover Preview Card (Shows thumbnail, brand, price & stats on hover without opening inspector) */}
      {hoveredGarment && hoveredGarment.id !== selectedId && (
        <div
          data-testid="quick-look-hover-preview"
          style={{
            left: hoveredTag
              ? `${Math.max(150, Math.min(window.innerWidth - 180, hoveredTag.x))}px`
              : '50%',
            top: hoveredTag ? `${Math.max(82, hoveredTag.y - 98)}px` : '120px',
            transform: 'translate(-50%, -50%)',
          }}
          className="pointer-events-none fixed z-30 w-64 bg-white/98 border border-[#F37021]/60 rounded-xl shadow-xl p-2.5 flex items-center gap-2.5 transition-opacity duration-150"
        >
          <div className="w-14 h-16 rounded-lg bg-[#FAF8F5] border border-[#E7E2DA] overflow-hidden shrink-0 flex items-center justify-center">
            {hoveredGarment.frontImageUrl || hoveredGarment.imageUrl ? (
              <img
                src={hoveredGarment.frontImageUrl || hoveredGarment.imageUrl}
                alt={hoveredGarment.name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain p-0.5"
              />
            ) : (
              <span
                className="w-6 h-6 rounded-full border border-black/15"
                style={{ backgroundColor: hoveredGarment.colorHex }}
              />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-mono-num font-bold text-[#F37021] truncate">
                {[hoveredGarment.code, hoveredGarment.brand]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="text-[9px] font-mono-num px-1.5 py-0.5 rounded bg-[#FAF8F5] border border-[#E7E2DA] text-[#141413] shrink-0">
                {hoveredGarment.isSample
                  ? 'Sample'
                  : hoveredGarment.lastDecision?.choice === 'sell'
                    ? 'Sell'
                    : hoveredGarment.lastDecision?.choice === 'keep'
                      ? 'Keep'
                      : 'Undecided'}
              </span>
            </div>
            <div className="text-xs font-semibold text-[#141413] truncate mt-0.5">
              {hoveredGarment.name}
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-xs font-mono-num font-bold text-[#141413]">
                {hoveredTag && hoveredTag.tagKind === 'price'
                  ? hoveredTag.priceText
                  : hoveredGarment.purchasePrice
                    ? `Paid ${formatCurrency(
                        hoveredGarment.purchasePrice,
                        hoveredGarment.currency,
                      )}`
                    : 'No price on record'}
              </span>
              <span className="text-[10px] text-[#8C857B] font-mono-num">
                {(hoveredGarment.wearLogStatus ?? 'verified') === 'insufficient' ||
                hoveredGarment.isSample
                  ? '60d: no wear log'
                  : `60d: ${hoveredGarment.wearsLast60Days}x worn`}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
