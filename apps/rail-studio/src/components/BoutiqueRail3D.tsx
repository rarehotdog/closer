import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GarmentPiece } from '../types/closet';
import {
  Boutique3DDisplayVariant,
  resolve3DDisplayVariant,
  railPieceSpacing,
  computeGarmentRotationHeat,
  countRotationTiers,
  formatCurrency,
  hasFactsMoved,
  RotationHeatTier,
} from '../utils/ledgerLogic';
import { TagKind, tagForm } from '../utils/tagForms';

export type SceneViewMode = 'rail' | 'vault';
type CameraAnglePreset = 'front' | 'orbit3d' | 'leftWing' | 'rightWing' | 'overhead';
type DragInteractionMode = 'sweep' | 'orbit';

interface BoutiqueRail3DProps {
  garments: GarmentPiece[];
  selectedId: string | null;
  onSelectGarment: (id: string | null) => void;
  viewMode: SceneViewMode;
  onViewModeChange?: (mode: SceneViewMode) => void;
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
  displayVariant: Boutique3DDisplayVariant;
  displayFixtureBadge: string;
  displayFixtureTitle: string;
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
function createHerringboneOakTexture(
  renderer: THREE.WebGLRenderer,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#D6C0A3';
  ctx.fillRect(0, 0, 512, 512);

  const tones = ['#DCC8AC', '#D1B898', '#C6AB89', '#DFCBB2'];
  const plankW = 64;
  const plankH = 16;

  for (let y = 0; y < 512; y += plankH) {
    for (let x = 0; x < 512; x += plankW) {
      const idx = ((x / plankW) * 3 + y / plankH) % tones.length;
      ctx.fillStyle = tones[Math.floor(idx)];
      ctx.fillRect(x, y, plankW - 1, plankH - 1);

      // Subtle oak grain lines
      ctx.fillStyle = 'rgba(110, 78, 46, 0.08)';
      ctx.fillRect(x + 6, y + 4, plankW - 14, 1.5);
      ctx.fillRect(x + 12, y + 10, plankW - 22, 1);

      // Bevel seam
      ctx.strokeStyle = 'rgba(92, 64, 38, 0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, plankW - 1, plankH - 1);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 5);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}


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
 * Generates a high-resolution sartorial wool twill or Japanese selvedge denim weave texture
 * for 3D sculpted trousers with subtle vertical crease sheen and topstitched seam lines.
 */
function getTailoredTrouserTexture(
  primaryHex: string,
  secondaryHex: string,
  isDenim: boolean,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const baseColor = new THREE.Color(primaryHex);
  const secColor = new THREE.Color(secondaryHex || primaryHex);
  const br = Math.round(baseColor.r * 255);
  const bg = Math.round(baseColor.g * 255);
  const bb = Math.round(baseColor.b * 255);

  ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  ctx.fillRect(0, 0, 256, 512);

  // Diagonal twill weave micro-lines + vertical warp yarns
  for (let y = 0; y < 512; y += 3) {
    for (let x = 0; x < 256; x += 3) {
      const diag = (x + y) % 6 === 0;
      const delta = isDenim ? (diag ? 16 : -10) : diag ? 9 : -7;
      const r = Math.max(0, Math.min(255, br + delta));
      const g = Math.max(0, Math.min(255, bg + delta));
      const b = Math.max(0, Math.min(255, bb + delta));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }

  // Soft vertical cylindrical shading + razor-sharp central Savile Row knife-crease highlight
  const creaseGrad = ctx.createLinearGradient(0, 0, 256, 0);
  creaseGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.28)');
  creaseGrad.addColorStop(0.45, 'rgba(255, 255, 255, 0.03)');
  creaseGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.24)');
  creaseGrad.addColorStop(0.52, 'rgba(0, 0, 0, 0.16)');
  creaseGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.28)');
  ctx.fillStyle = creaseGrad;
  ctx.fillRect(0, 0, 256, 512);

  // Sartorial side outseam topstitching (gold contrast thread on raw denim, tonal silk pick-stitch on wool)
  ctx.strokeStyle = isDenim
    ? 'rgba(212, 155, 68, 0.65)'
    : `rgba(${Math.round(secColor.r * 255)},${Math.round(secColor.g * 255)},${Math.round(secColor.b * 255)}, 0.45)`;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(22, 0);
  ctx.lineTo(22, 512);
  ctx.moveTo(234, 0);
  ctx.lineTo(234, 512);
  ctx.stroke();
  ctx.setLineDash([]);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates an optical glossy collector glass door texture with studio softbox specular streaks,
 * beveled drop-front door border, and laser-etched UV-99 museum vitrine markings.
 */
function getGlossyGlassDoorTexture(): THREE.CanvasTexture {

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 384;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, 512, 384);

  // Subtle icy-clear optical acrylic tint around beveled perimeter
  const edgeGrad = ctx.createLinearGradient(0, 0, 512, 384);
  edgeGrad.addColorStop(0, 'rgba(235, 246, 255, 0.34)');
  edgeGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.10)');
  edgeGrad.addColorStop(1, 'rgba(220, 238, 255, 0.32)');
  ctx.fillStyle = edgeGrad;
  ctx.fillRect(0, 0, 512, 384);

  // Beveled drop-front acrylic door inner gasket frame
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 4;
  ctx.strokeRect(14, 14, 484, 356);

  ctx.strokeStyle = 'rgba(197, 165, 114, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(22, 22, 468, 340);

  // Multi-band diagonal studio softbox specular reflection streaks
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(56, 366);
  ctx.lineTo(190, 18);
  ctx.lineTo(246, 18);
  ctx.lineTo(112, 366);
  ctx.closePath();
  const streakGrad1 = ctx.createLinearGradient(56, 18, 246, 366);
  streakGrad1.addColorStop(0, 'rgba(255, 255, 255, 0.62)');
  streakGrad1.addColorStop(0.5, 'rgba(255, 255, 255, 0.35)');
  streakGrad1.addColorStop(1, 'rgba(255, 255, 255, 0.08)');
  ctx.fillStyle = streakGrad1;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(266, 366);
  ctx.lineTo(395, 18);
  ctx.lineTo(422, 18);
  ctx.lineTo(293, 366);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';
  ctx.fill();
  ctx.restore();

  // Laser-etched corner calibration reticles on the collector glass door
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 2;
  const cornerLen = 18;
  [
    [30, 30, 1, 1],
    [482, 30, -1, 1],
    [30, 354, 1, -1],
    [482, 354, -1, -1],
  ].forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * cornerLen);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * cornerLen, cy);
    ctx.stroke();
  });

  // Micro-etched collector authenticity stamp at bottom-right of glass door
  ctx.font = '700 11px monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.textAlign = 'right';
  ctx.fillText('ILLUSTRATIVE GLASS · DISPLAY FIXTURE', 468, 344);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates an engraved champagne-brass plaque texture for the Trouser Clamp & Glass Vitrine Plinth.
 */
function getEngravedBrassPlaqueTexture(
  titleText: string,
  subText: string,
): THREE.CanvasTexture {

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 256, 64);
  grad.addColorStop(0, '#DFC496');
  grad.addColorStop(0.5, '#C5A572');
  grad.addColorStop(1, '#A68550');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 64);

  ctx.strokeStyle = '#3D2E18';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, 248, 56);

  ctx.fillStyle = '#1E160C';
  ctx.font = '700 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(titleText.slice(0, 24), 128, 29);

  ctx.font = '600 11px sans-serif';
  ctx.fillStyle = '#3D2E18';
  ctx.fillText(subText.slice(0, 30), 128, 48);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a 12-Part Composite Sculpted 3D Limited-Edition Sneaker Mesh
 * for the Glossy Glass Box Display Variant.
 */
function buildSculptedLuxurySneakerMesh(
  garmentId: string,
  sneakerUpperMat: THREE.MeshStandardMaterial,
  sneakerAccentMat: THREE.MeshStandardMaterial,
  sailMidsoleMat: THREE.MeshStandardMaterial,
  gumOutsoleMat: THREE.MeshStandardMaterial,
  brassMat: THREE.MeshStandardMaterial,
  hermesTagMat: THREE.MeshStandardMaterial,
  isLeftShoe: boolean,
): THREE.Group {
  const shoe = new THREE.Group();

  // 1. Treaded Gum/Rubber Outsole with forefoot & heel pivot pods
  const outsole = new THREE.Mesh(
    new THREE.BoxGeometry(0.195, 0.028, 0.415),
    gumOutsoleMat,
  );
  outsole.position.set(0, 0.014, 0);
  outsole.userData = { garmentId };
  shoe.add(outsole);

  // 2. Sculpted Sail Cream Midsole with visible heel Air/cushion window
  const midsole = new THREE.Mesh(
    new THREE.BoxGeometry(0.202, 0.042, 0.422),
    sailMidsoleMat,
  );
  midsole.position.set(0, 0.048, 0);
  midsole.userData = { garmentId };
  shoe.add(midsole);

  const airWindow = new THREE.Mesh(
    new THREE.BoxGeometry(0.208, 0.018, 0.095),
    new THREE.MeshPhysicalMaterial({
      color: 0xdbeafe,
      transparent: true,
      opacity: 0.75,
      roughness: 0.05,
      clearcoat: 1.0,
    }),
  );
  airWindow.position.set(0, 0.046, -0.12);
  airWindow.userData = { garmentId };
  shoe.add(airWindow);

  // 3. Main Leather / Nubuck Quarter & Vamp Body
  const quarterBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.184, 0.112, 0.285),
    sneakerUpperMat,
  );
  quarterBody.position.set(0, 0.122, -0.025);
  quarterBody.castShadow = true;
  quarterBody.userData = { garmentId };
  shoe.add(quarterBody);

  // 4. Sculpted Rounded Perforated Toe-Box & Forefoot Mudguard
  const toeBox = new THREE.Mesh(
    new THREE.CylinderGeometry(0.088, 0.096, 0.078, 18),
    sailMidsoleMat,
  );
  toeBox.position.set(0, 0.102, 0.135);
  toeBox.scale.set(1.0, 1.0, 1.15);
  toeBox.userData = { garmentId };
  shoe.add(toeBox);

  const mudguardWrap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.095, 0.099, 0.048, 18, 1, false, -Math.PI * 0.65, Math.PI * 1.3),
    sneakerAccentMat,
  );
  mudguardWrap.position.set(0, 0.09, 0.142);
  mudguardWrap.scale.set(1.0, 1.0, 1.14);
  mudguardWrap.userData = { garmentId };
  shoe.add(mudguardWrap);

  // 5. Elevated Padded Ankle Collar & Sculpted Heel Counter
  const heelCounter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.086, 0.093, 0.165, 18),
    sneakerAccentMat,
  );
  heelCounter.position.set(0, 0.152, -0.125);
  heelCounter.userData = { garmentId };
  shoe.add(heelCounter);

  const ankleCollarRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.076, 0.018, 10, 18),
    sailMidsoleMat,
  );
  ankleCollarRim.rotation.x = Math.PI / 2 + 0.14;
  ankleCollarRim.position.set(0, 0.228, -0.118);
  ankleCollarRim.userData = { garmentId };
  shoe.add(ankleCollarRim);

  // 6. Embossed Collector Heel Pull-Tab
  const heelTab = new THREE.Mesh(
    new THREE.BoxGeometry(0.068, 0.065, 0.022),
    brassMat,
  );
  heelTab.position.set(0, 0.195, -0.21);
  heelTab.userData = { garmentId };
  shoe.add(heelTab);

  // 7. Gusseted Padded Tongue + 8. Woven Brand Tongue Patch
  const tongue = new THREE.Mesh(
    new THREE.BoxGeometry(0.114, 0.145, 0.034),
    sailMidsoleMat,
  );
  tongue.position.set(0, 0.192, 0.01);
  tongue.rotation.x = -0.32;
  tongue.userData = { garmentId };
  shoe.add(tongue);

  const tonguePatch = new THREE.Mesh(
    new THREE.BoxGeometry(0.064, 0.038, 0.038),
    hermesTagMat,
  );
  tonguePatch.position.set(0, 0.238, -0.008);
  tonguePatch.rotation.x = -0.32;
  tonguePatch.userData = { garmentId };
  shoe.add(tonguePatch);

  // 9. Angled Eyestay Panels + 10. Five Criss-Cross 3D Flat Shoelace Strands & Brass Aglets
  [-0.015, 0.015, 0.045, 0.075, 0.105].forEach((laceZ, lIdx) => {
    const laceBar = new THREE.Mesh(
      new THREE.BoxGeometry(0.132, 0.014, 0.018),
      sailMidsoleMat,
    );
    laceBar.position.set(0, 0.188 - lIdx * 0.014, laceZ);
    laceBar.rotation.z = lIdx % 2 === 0 ? 0.08 : -0.08;
    laceBar.userData = { garmentId };
    shoe.add(laceBar);

    [-0.068, 0.068].forEach((eyeX) => {
      const eyelet = new THREE.Mesh(
        new THREE.CylinderGeometry(0.009, 0.009, 0.016, 8),
        brassMat,
      );
      eyelet.rotation.z = Math.PI / 2;
      eyelet.position.set(eyeX, 0.184 - lIdx * 0.014, laceZ);
      eyelet.userData = { garmentId };
      shoe.add(eyelet);
    });
  });

  // 11. Signature Lateral & Medial Reverse Swoosh / Collector Overlay Panels
  const swooshCheck = new THREE.Mesh(
    new THREE.BoxGeometry(0.198, 0.036, 0.205),
    sneakerAccentMat,
  );
  swooshCheck.position.set(0, 0.126, 0.005);
  swooshCheck.rotation.x = -0.15;
  swooshCheck.userData = { garmentId };
  shoe.add(swooshCheck);

  const swooshTail = new THREE.Mesh(
    new THREE.BoxGeometry(0.202, 0.052, 0.048),
    sneakerAccentMat,
  );
  swooshTail.position.set(0, 0.144, 0.085);
  swooshTail.rotation.x = 0.42;
  swooshTail.userData = { garmentId };
  shoe.add(swooshTail);

  // 12. Internal Cedar/Brass Shoe Tree Knob & Hanging Deadstock Collector Authenticity Tag
  const shoeTreeKnob = new THREE.Mesh(
    new THREE.SphereGeometry(0.024, 12, 12),
    brassMat,
  );
  shoeTreeKnob.position.set(0, 0.255, -0.125);
  shoeTreeKnob.userData = { garmentId };
  shoe.add(shoeTreeKnob);

  if (!isLeftShoe) {
    const authenticityTag = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.075, 0.048),
      hermesTagMat,
    );
    authenticityTag.position.set(0.108, 0.135, 0.02);
    authenticityTag.rotation.z = -0.28;
    authenticityTag.userData = { garmentId };
    shoe.add(authenticityTag);
  }

  return shoe;
}

/**
 * Builds a photorealistic 3D Boutique Rail Garment Group:
 * - Real 3D curved champagne-brass / chrome hanger hook engaging the 3D rail
 * - Specialized 3D Luxury Boutique Trouser Clamp for 'trousers'
 * - Specialized 3D 2-Tier Glossy Glass Box Display Variant for 'footwear' / 'sneaker-box'
 * - Volumetric 3D relief shell with sculpted vertical depth folds paired with studio cutout photography
 */
/** Show the supplied photo on its fixture; a generic sculpt is only an illustrative fallback. */
function attachFixturePhoto(
  root: THREE.Group, garment: GarmentPiece, modeled: THREE.Object3D[],
  width: number, height: number, y: number, z: number,
) {
  const hasPhoto = Boolean(garment.frontImageUrl || garment.imageUrl);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, transparent: true, alphaTest: 0.08, side: THREE.DoubleSide,
    roughness: 0.72, depthWrite: true,
  });
  const photo = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  photo.position.set(0, y, z);
  photo.userData = { garmentId: garment.id, source: 'owner-photo' };
  photo.visible = false;
  root.add(photo);
  if (hasPhoto && !garment.isSample) modeled.forEach(object => { object.visible = false; });
  return {
    root,
    applyCutoutTexture: (texture: THREE.CanvasTexture) => {
      // Sample inventory intentionally demonstrates the modeled fixtures.
      if (garment.isSample) return;
      modeled.forEach(object => { object.visible = false; });
      const image = texture.image as { width?: number; height?: number };
      const aspect = (image.width || 1) / (image.height || 1);
      // Cutouts retain the source aspect ratio; the square scan canvas includes transparent padding.
      const fittedHeight = Math.min(height, width / aspect);
      photo.scale.set(fittedHeight * aspect / width, fittedHeight / height, 1);
      material.map = texture;
      material.needsUpdate = true;
      photo.visible = true;
    },
    showPlainShell: () => {
      // Do not invent a replacement product when an owner's photo fails to load.
      if (hasPhoto && !garment.isSample) return;
      modeled.forEach(object => { object.visible = true; });
    },
  };
}

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
  const displayVariantInfo = resolve3DDisplayVariant(garment);
  root.userData = { garmentId: garment.id, displayVariant: displayVariantInfo.variant };

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

  const hangerWoodMat = new THREE.MeshStandardMaterial({
    color: garment.hangerType === 'matte-black' ? 0x222326 : 0x5a3821,
    roughness: 0.34,
    metalness: 0.08,
  });

  // ============================================================================
  // VARIANT A: SPECIALIZED 3D LUXURY BOUTIQUE TROUSER CLAMP & TAILORED TROUSERS
  // ============================================================================
  if (displayVariantInfo.variant === 'trouser-clamp') {
    const clampRigGroup = new THREE.Group();
    clampRigGroup.name = 'LuxuryBoutiqueTrouserClamp';

    const merinoFeltMat = new THREE.MeshStandardMaterial({
      color: 0xe6dfd3,
      roughness: 0.92,
      metalness: 0.01,
    });
    const suedeGripPadMat = new THREE.MeshStandardMaterial({
      color: 0x2c2520,
      roughness: 0.88,
      metalness: 0.02,
    });

    // 1. Dual-Beam Contoured Walnut Clamp Press Jaws (Front & Rear Jaws sandwiching Merino Felt Liner)
    [-0.026, 0.026].forEach((jawZ) => {
      const walnutJaw = new THREE.Mesh(
        new THREE.BoxGeometry(0.74, 0.064, 0.032),
        hangerWoodMat,
      );
      walnutJaw.position.set(0, 1.24, jawZ);
      walnutJaw.castShadow = true;
      walnutJaw.userData = { garmentId: garment.id };
      clampRigGroup.add(walnutJaw);

      // Beveled Champagne-Brass Top Rail Crown on each jaw
      const brassJawCrown = new THREE.Mesh(
        new THREE.BoxGeometry(0.75, 0.015, 0.036),
        brassMat,
      );
      brassJawCrown.position.set(0, 1.278, jawZ);
      brassJawCrown.userData = { garmentId: garment.id };
      clampRigGroup.add(brassJawCrown);
    });

    // Plush Merino Felt Cushion Strip compressed between the dual walnut jaws
    const feltCushionLiner = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.056, 0.022),
      merinoFeltMat,
    );
    feltCushionLiner.position.set(0, 1.234, 0);
    feltCushionLiner.userData = { garmentId: garment.id };
    clampRigGroup.add(feltCushionLiner);

    // Left & Right Machined Brass Clamp End-Caps & Guide Pins
    [-0.372, 0.372].forEach((endX) => {
      const endCap = new THREE.Mesh(
        new THREE.BoxGeometry(0.024, 0.072, 0.092),
        brassMat,
      );
      endCap.position.set(endX, 1.242, 0);
      endCap.userData = { garmentId: garment.id };
      clampRigGroup.add(endCap);
    });

    // 2. Center Eccentric Brass Cam-Lock Lever & Savile Row Engraved Nameplate
    const camHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.115, 0.082, 0.098),
      brassMat,
    );
    camHousing.position.set(0, 1.252, 0);
    camHousing.userData = { garmentId: garment.id };
    clampRigGroup.add(camHousing);

    const clampNameplate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 0.044),
      new THREE.MeshBasicMaterial({
        map: getEngravedBrassPlaqueTexture(
          `${garment.code} · ${garment.brand}`,
          'SAVILE ROW CLAMP',
        ),
      }),
    );
    clampNameplate.position.set(0, 1.24, 0.051);
    clampNameplate.userData = { garmentId: garment.id };
    clampRigGroup.add(clampNameplate);

    // Pivoting Cam-Lock Tension Lever Arm & Knurled Brass Barrel
    const camLeverArm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.014, 0.13, 12),
      chromeMat,
    );
    camLeverArm.position.set(0.045, 1.31, 0.042);
    camLeverArm.rotation.z = -0.58;
    camLeverArm.userData = { garmentId: garment.id };
    clampRigGroup.add(camLeverArm);

    const camLeverKnob = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 12, 12),
      brassMat,
    );
    camLeverKnob.position.set(0.092, 1.35, 0.042);
    camLeverKnob.userData = { garmentId: garment.id };
    clampRigGroup.add(camLeverKnob);

    // 3. Dual Sliding Spring-Loaded Boutique Pinch Clamps (Left & Right Mechanical Clips)
    [-0.225, 0.225].forEach((clipX) => {
      const clipAssembly = new THREE.Group();
      clipAssembly.position.set(clipX, 1.21, 0);

      // Sliding Upper Carriage Bracket wrapping the clamp bar
      const slideCarriage = new THREE.Mesh(
        new THREE.BoxGeometry(0.082, 0.088, 0.098),
        chromeMat,
      );
      slideCarriage.position.set(0, 0.032, 0);
      slideCarriage.userData = { garmentId: garment.id };
      clipAssembly.add(slideCarriage);

      // Coiled Spring Barrel Axis
      const springBarrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 0.086, 14),
        brassMat,
      );
      springBarrel.rotation.z = Math.PI / 2;
      springBarrel.position.set(0, -0.012, 0.046);
      springBarrel.userData = { garmentId: garment.id };
      clipAssembly.add(springBarrel);

      // Articulated Front & Rear Pinch Jaws gripping the trouser waistband
      [-0.036, 0.036].forEach((jZ) => {
        const pinchJaw = new THREE.Mesh(
          new THREE.BoxGeometry(0.076, 0.105, 0.018),
          chromeMat,
        );
        pinchJaw.position.set(0, -0.055, jZ);
        pinchJaw.userData = { garmentId: garment.id };
        clipAssembly.add(pinchJaw);
      });

      // Suede Cushion Grip Pad at bottom of pinch jaw
      const suedePad = new THREE.Mesh(
        new THREE.BoxGeometry(0.078, 0.036, 0.092),
        suedeGripPadMat,
      );
      suedePad.position.set(0, -0.095, 0);
      suedePad.userData = { garmentId: garment.id };
      clipAssembly.add(suedePad);

      // Angled Thumb-Release Lever Tab on top of pinch clamp
      const thumbTab = new THREE.Mesh(
        new THREE.BoxGeometry(0.058, 0.048, 0.014),
        brassMat,
      );
      thumbTab.position.set(0, 0.068, 0.048);
      thumbTab.rotation.x = 0.38;
      thumbTab.userData = { garmentId: garment.id };
      clipAssembly.add(thumbTab);

      clampRigGroup.add(clipAssembly);
    });

    root.add(clampRigGroup);

    const fixtureChildren = new Set(root.children);
    // 4. Hyper-Sculpted 3D Tailored Pleated Trousers (Waistband, Belt, Double Pleats, Creased Wide Legs & Cuffs)
    const isDenim =
      garment.code === 'P2' ||
      garment.name.toLowerCase().includes('denim') ||
      garment.fabricLabel.toLowerCase().includes('selvedge');
    const trouserTex = getTailoredTrouserTexture(
      garment.colorHex,
      garment.secondaryColorHex || garment.colorHex,
      isDenim,
    );
    const trouserColor = new THREE.Color(garment.colorHex);
    const trouserMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: trouserTex,
      roughness: isDenim ? 0.74 : 0.62,
      metalness: 0.05,
      bumpMap: fabricBump,
      bumpScale: 0.009,
    });
    const creaseRidgeMat = new THREE.MeshStandardMaterial({
      color: trouserColor.clone().multiplyScalar(1.22),
      roughness: 0.46,
      metalness: 0.08,
    });
    const beltLeatherMat = new THREE.MeshStandardMaterial({
      color: isDenim ? 0x3b2314 : 0x1e1c1a,
      roughness: 0.38,
      metalness: 0.12,
    });

    // Tailored High-Waisted Waistband
    const waistband = new THREE.Mesh(
      new THREE.BoxGeometry(0.65, 0.135, 0.175),
      trouserMat,
    );
    waistband.position.set(0, 1.09, 0);
    waistband.castShadow = true;
    waistband.userData = { garmentId: garment.id };
    root.add(waistband);

    // Self-Fabric / Saddle Leather Belt + Sculpted Brass Frame Buckle & 6 Belt Loops
    const beltStrap = new THREE.Mesh(
      new THREE.BoxGeometry(0.662, 0.052, 0.184),
      beltLeatherMat,
    );
    beltStrap.position.set(0, 1.09, 0);
    beltStrap.userData = { garmentId: garment.id };
    root.add(beltStrap);

    const brassBeltBuckle = new THREE.Mesh(
      new THREE.BoxGeometry(0.078, 0.076, 0.194),
      brassMat,
    );
    brassBeltBuckle.position.set(0, 1.09, 0);
    brassBeltBuckle.userData = { garmentId: garment.id };
    root.add(brassBeltBuckle);

    [-0.27, -0.14, 0.14, 0.27].forEach((loopX) => {
      const beltLoop = new THREE.Mesh(
        new THREE.BoxGeometry(0.022, 0.142, 0.19),
        trouserMat,
      );
      beltLoop.position.set(loopX, 1.09, 0);
      beltLoop.userData = { garmentId: garment.id };
      root.add(beltLoop);
    });

    // Sculpted Left & Right Wide-Leg Pleated Trouser Columns with Natural Drape & Knife Crease
    [-0.162, 0.162].forEach((legX, legIdx) => {
      const legGroup = new THREE.Group();
      legGroup.position.set(legX, 0.04, legIdx === 0 ? 0.012 : -0.012);

      // Custom Vertex-Deformed Sartorial Trouser Leg Column
      const legGeo = new THREE.CylinderGeometry(0.136, 0.156, 2.04, 28, 24);
      const lPos = legGeo.attributes.position;
      for (let i = 0; i < lPos.count; i++) {
        const vx = lPos.getX(i);
        const vy = lPos.getY(i);
        const vz = lPos.getZ(i);
        // Flatten depth slightly while pinching front/rear into a crisp Savile Row pressed crease
        const frontBackFactor = Math.pow(Math.abs(vz) / 0.156, 1.35);
        const pleatFlare = vy > 0.35 ? Math.sin(vx * 24) * 0.008 : 0;
        const kneeDrapeZ = Math.sin((vy + 1.0) * 2.2) * 0.012;
        lPos.setX(i, vx * 1.08 + pleatFlare);
        lPos.setZ(
          i,
          vz * 0.72 + Math.sign(vz) * frontBackFactor * 0.028 + kneeDrapeZ,
        );
      }
      legGeo.computeVertexNormals();

      const legColumn = new THREE.Mesh(legGeo, trouserMat);
      legColumn.castShadow = true;
      legColumn.receiveShadow = true;
      legColumn.userData = { garmentId: garment.id };
      legGroup.add(legColumn);

      // Double Forward Savile Row Waist Pleat Folds at Top of Leg
      [-0.038, 0.032].forEach((pleatX, pIdx) => {
        const pleatFold = new THREE.Mesh(
          new THREE.BoxGeometry(0.026, 0.62 - pIdx * 0.12, 0.195),
          creaseRidgeMat,
        );
        pleatFold.position.set(pleatX, 0.66, 0.012);
        pleatFold.rotation.z = legIdx === 0 ? 0.03 : -0.03;
        pleatFold.userData = { garmentId: garment.id };
        legGroup.add(pleatFold);
      });

      // Full-Length Front & Back Pressed Knife-Edge Crease Ridges
      const frontCrease = new THREE.Mesh(
        new THREE.BoxGeometry(0.022, 2.02, 0.232),
        creaseRidgeMat,
      );
      frontCrease.position.set(0, 0, 0.008);
      frontCrease.userData = { garmentId: garment.id };
      legGroup.add(frontCrease);

      // Weighted 4.5cm Tailored Turn-Up Ankle Cuff
      const ankleCuff = new THREE.Mesh(
        new THREE.CylinderGeometry(0.162, 0.162, 0.11, 24),
        trouserMat,
      );
      ankleCuff.scale.set(1.09, 1, 0.76);
      ankleCuff.position.set(0, -0.96, 0.01);
      ankleCuff.userData = { garmentId: garment.id };
      legGroup.add(ankleCuff);

      // Raw Japanese Selvedge Denim Outseam Red/White ID Tick on Turn-Up Cuff (for Denim Trousers)
      if (isDenim) {
        const selvedgeTick = new THREE.Mesh(
          new THREE.BoxGeometry(0.024, 0.114, 0.042),
          new THREE.MeshBasicMaterial({ color: 0xfaf8f5 }),
        );
        selvedgeTick.position.set(
          legIdx === 0 ? -0.172 : 0.172,
          -0.96,
          0.01,
        );
        selvedgeTick.userData = { garmentId: garment.id };
        legGroup.add(selvedgeTick);

        const redLine = new THREE.Mesh(
          new THREE.BoxGeometry(0.028, 0.116, 0.012),
          new THREE.MeshBasicMaterial({ color: 0xd93829 }),
        );
        redLine.position.set(legIdx === 0 ? -0.173 : 0.173, -0.96, 0.01);
        redLine.userData = { garmentId: garment.id };
        legGroup.add(redLine);
      }

      root.add(legGroup);
    });

    const hitProxy = new THREE.Mesh(
      new THREE.BoxGeometry(0.84, 2.45, 0.52),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hitProxy.position.set(0, 0.25, 0);
    hitProxy.layers.set(1);
    hitProxy.userData = { garmentId: garment.id };
    root.add(hitProxy);

    const modeledGarment = root.children.filter(child => !fixtureChildren.has(child) && child !== hitProxy);
    return attachFixturePhoto(root, garment, modeledGarment, 0.72, 2.18, 0.04, 0.16);

  }

  // ============================================================================
  // VARIANT B: SPECIALIZED 3D 'GLOSSY GLASS BOX' DISPLAY VARIANT FOR FOOTWEAR
  // ============================================================================
  if (displayVariantInfo.variant === 'glossy-glass-box') {
    const modeledShoes: THREE.Object3D[] = [];
    const glassVaultRig = new THREE.Group();
    glassVaultRig.name = 'GlossyGlassSneakerBoxVariant';

    // 1. Machined Champagne-Brass Suspension Yoke & Dual Turnbuckle Cable Rods
    const topSuspensionYoke = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.048, 0.062),
      brassMat,
    );
    topSuspensionYoke.position.set(0, 1.26, 0);
    topSuspensionYoke.userData = { garmentId: garment.id };
    glassVaultRig.add(topSuspensionYoke);

    [-0.365, 0.365].forEach((rodX) => {
      const cableRod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.013, 0.013, 2.16, 14),
        brassMat,
      );
      cableRod.position.set(rodX, 0.19, 0);
      cableRod.userData = { garmentId: garment.id };
      glassVaultRig.add(cableRod);

      // Knurled Brass Turnbuckle Tensioners at Upper & Lower Case Mounts
      [1.21, 0.82, -0.08].forEach((tbY) => {
        const turnbuckle = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.022, 0.055, 12),
          chromeMat,
        );
        turnbuckle.position.set(rodX, tbY, 0);
        turnbuckle.userData = { garmentId: garment.id };
        glassVaultRig.add(turnbuckle);
      });
    });

    // Optical High-Gloss Acrylic/Glass Materials
    const glossyGlassEnclosureMat = new THREE.MeshPhysicalMaterial({
      color: 0xf2f8ff,
      transparent: true,
      opacity: 0.32,
      roughness: 0.02,
      metalness: 0.08,
      clearcoat: 1.0,
      clearcoatRoughness: 0.01,
      reflectivity: 1.0,
      depthWrite: false,
    });

    const frontDropDoorMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: getGlossyGlassDoorTexture(),
      transparent: true,
      opacity: 0.78,
      roughness: 0.02,
      metalness: 0.1,
      clearcoat: 1.0,
      clearcoatRoughness: 0.01,
      reflectivity: 1.0,
      depthWrite: false,
    });

    const primaryUpperColor = new THREE.Color(garment.colorHex);
    const accentColor = new THREE.Color(
      garment.secondaryColorHex || '#F37021',
    );
    const sneakerUpperMat = new THREE.MeshStandardMaterial({
      color: primaryUpperColor,
      roughness: 0.34,
      metalness: 0.06,
    });
    const sneakerAccentMat = new THREE.MeshStandardMaterial({
      color: accentColor,
      roughness: 0.28,
      metalness: 0.14,
    });
    const sailMidsoleMat = new THREE.MeshStandardMaterial({
      color: 0xf7f2e7,
      roughness: 0.42,
      metalness: 0.02,
    });
    const gumOutsoleMat = new THREE.MeshStandardMaterial({
      color: 0xb97e4a,
      roughness: 0.56,
      metalness: 0.03,
    });
    const obsidianPlinthMat = new THREE.MeshStandardMaterial({
      color: 0x161618,
      roughness: 0.18,
      metalness: 0.22,
    });
    const hermesTagMat = new THREE.MeshStandardMaterial({
      color: 0xf37021,
      roughness: 0.32,
      metalness: 0.08,
    });
    const ledGlowMat = new THREE.MeshBasicMaterial({ color: 0xfff3d1 });

    // 2. Build Two Stacked High-End Glossy Glass Collector Sneaker Boxes
    // Tier 0 (y = 0.54): Upper Hero Presentation Vitrine with Canted Levitation Riser
    // Tier 1 (y = -0.36): Lower Deadstock Archive Vitrine with Collector Box & Hygrometer
    [0.54, -0.36].forEach((caseY, tierIdx) => {
      const vitrine = new THREE.Group();
      vitrine.position.set(0, caseY, 0);

      // A. Obsidian Lacquer Collector Base Plinth + Recessed Gold LED Underglow
      const plinth = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 0.072, 0.54),
        obsidianPlinthMat,
      );
      plinth.position.set(0, -0.265, 0);
      plinth.userData = { garmentId: garment.id };
      vitrine.add(plinth);

      // Acrylic Mirror Reflector Deck on Top of Plinth
      const mirrorDeck = new THREE.Mesh(
        new THREE.BoxGeometry(0.76, 0.012, 0.48),
        chromeMat,
      );
      mirrorDeck.position.set(0, -0.224, 0);
      mirrorDeck.userData = { garmentId: garment.id };
      vitrine.add(mirrorDeck);

      // Engraved Champagne-Brass Collector Provenance Plaque on Front of Plinth
      const plaqueMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.054),
        new THREE.MeshBasicMaterial({
          map: getEngravedBrassPlaqueTexture(
            `${garment.code} · ${garment.brand}`,
            tierIdx === 0
              ? `${garment.code} · DISPLAY #01`
              : 'ILLUSTRATIVE DISPLAY',
          ),
        }),
      );
      plaqueMesh.position.set(0, -0.265, 0.273);
      plaqueMesh.userData = { garmentId: garment.id };
      vitrine.add(plaqueMesh);

      // B. Top Anodized Canopy Crown + Recessed 3000K Museum LED Light Strip
      const topCanopyRim = new THREE.Mesh(
        new THREE.BoxGeometry(0.81, 0.032, 0.53),
        obsidianPlinthMat,
      );
      topCanopyRim.position.set(0, 0.265, 0);
      topCanopyRim.userData = { garmentId: garment.id };
      vitrine.add(topCanopyRim);

      const ledCeilingStrip = new THREE.Mesh(
        new THREE.BoxGeometry(0.72, 0.018, 0.42),
        ledGlowMat,
      );
      ledCeilingStrip.position.set(0, 0.244, 0);
      ledCeilingStrip.userData = { garmentId: garment.id };
      vitrine.add(ledCeilingStrip);

      // C. Interior Collector Presentation Hardware + 12-Part Sculpted 3D Sneakers
      if (tierIdx === 0) {
        // Upper Hero Vitrine: Canted Clear-Acrylic & Brass Levitation Riser under Right Sneaker
        const riserPillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.028, 0.065, 14),
          brassMat,
        );
        riserPillar.position.set(0.16, -0.19, 0.0);
        riserPillar.userData = { garmentId: garment.id };
        vitrine.add(riserPillar);

        const riserPlatform = new THREE.Mesh(
          new THREE.BoxGeometry(0.22, 0.014, 0.38),
          glossyGlassEnclosureMat,
        );
        riserPlatform.position.set(0.16, -0.155, 0.0);
        riserPlatform.rotation.x = 0.14;
        riserPlatform.rotation.y = -0.28;
        riserPlatform.userData = { garmentId: garment.id };
        vitrine.add(riserPlatform);

        // Left Sneaker sitting flush on mirror deck
        const leftShoe = buildSculptedLuxurySneakerMesh(
          garment.id,
          sneakerUpperMat,
          sneakerAccentMat,
          sailMidsoleMat,
          gumOutsoleMat,
          brassMat,
          hermesTagMat,
          true,
        );
        leftShoe.position.set(-0.165, -0.218, 0.02);
        leftShoe.rotation.y = 0.32;
        vitrine.add(leftShoe);
        modeledShoes.push(leftShoe);

        // Right Hero Sneaker elevated on canted collector riser
        const rightShoe = buildSculptedLuxurySneakerMesh(
          garment.id,
          sneakerUpperMat,
          sneakerAccentMat,
          sailMidsoleMat,
          gumOutsoleMat,
          brassMat,
          hermesTagMat,
          false,
        );
        rightShoe.position.set(0.16, -0.145, 0.0);
        rightShoe.rotation.x = 0.14;
        rightShoe.rotation.y = -0.32;
        vitrine.add(rightShoe);
        modeledShoes.push(rightShoe);
      } else {
        // Lower Archive Vitrine: Miniature Collector Shoebox on Left + Deadstock Sneaker on Right + Brass Hygrometer
        const collectorShoeBox = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.14, 0.36),
          hermesTagMat,
        );
        collectorShoeBox.position.set(-0.18, -0.148, -0.02);
        collectorShoeBox.rotation.y = 0.18;
        collectorShoeBox.userData = { garmentId: garment.id };
        vitrine.add(collectorShoeBox);
        modeledShoes.push(collectorShoeBox);

        const boxLid = new THREE.Mesh(
          new THREE.BoxGeometry(0.292, 0.032, 0.372),
          obsidianPlinthMat,
        );
        boxLid.position.set(-0.18, -0.068, -0.02);
        boxLid.rotation.y = 0.18;
        boxLid.userData = { garmentId: garment.id };
        vitrine.add(boxLid);
        modeledShoes.push(boxLid);

        const archiveShoe = buildSculptedLuxurySneakerMesh(
          garment.id,
          sneakerUpperMat,
          sneakerAccentMat,
          sailMidsoleMat,
          gumOutsoleMat,
          brassMat,
          hermesTagMat,
          false,
        );
        archiveShoe.position.set(0.155, -0.218, 0.02);
        archiveShoe.rotation.y = -0.45;
        vitrine.add(archiveShoe);
        modeledShoes.push(archiveShoe);

        // Brass Humidity / Desiccator Gauge Disc inside lower corner
        const hygrometer = new THREE.Mesh(
          new THREE.CylinderGeometry(0.032, 0.032, 0.016, 16),
          brassMat,
        );
        hygrometer.rotation.x = Math.PI / 2;
        hygrometer.position.set(-0.31, 0.16, 0.22);
        hygrometer.userData = { garmentId: garment.id };
        vitrine.add(hygrometer);
      }

      // D. Crystal-Clear Glossy Glass Enclosure Box + Optical Drop-Front Door
      const glassBox = new THREE.Mesh(
        new THREE.BoxGeometry(0.78, 0.49, 0.5),
        glossyGlassEnclosureMat,
      );
      glassBox.position.set(0, 0.01, 0);
      glassBox.renderOrder = 2;
      glassBox.userData = { garmentId: garment.id };
      vitrine.add(glassBox);

      // Dedicated Front Drop-Front Optical Glass Door with Specular Softbox Streaks & Etching
      const frontDoorPane = new THREE.Mesh(
        new THREE.PlaneGeometry(0.76, 0.47),
        frontDropDoorMat,
      );
      frontDoorPane.position.set(0, 0.01, 0.254);
      frontDoorPane.renderOrder = 3;
      frontDoorPane.userData = { garmentId: garment.id };
      vitrine.add(frontDoorPane);

      // Top-Center Magnetic Chrome & Brass Drop-Front Door Clasp Handle
      const magneticClaspLatch = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.026, 0.024),
        brassMat,
      );
      magneticClaspLatch.position.set(0, 0.225, 0.262);
      magneticClaspLatch.userData = { garmentId: garment.id };
      vitrine.add(magneticClaspLatch);

      // 4 Vertical Champagne-Brass Corner Frame Pillars on the Glossy Glass Box
      [
        [-0.39, -0.25],
        [0.39, -0.25],
        [-0.39, 0.25],
        [0.39, 0.25],
      ].forEach(([cx, cz]) => {
        const cornerPost = new THREE.Mesh(
          new THREE.BoxGeometry(0.02, 0.52, 0.02),
          brassMat,
        );
        cornerPost.position.set(cx, 0.01, cz);
        cornerPost.userData = { garmentId: garment.id };
        vitrine.add(cornerPost);
      });

      glassVaultRig.add(vitrine);
    });

    root.add(glassVaultRig);

    const hitProxy = new THREE.Mesh(
      new THREE.BoxGeometry(0.88, 2.42, 0.6),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hitProxy.position.set(0, 0.25, 0);
    hitProxy.layers.set(1);
    hitProxy.userData = { garmentId: garment.id };
    root.add(hitProxy);

    return attachFixturePhoto(root, garment, modeledShoes, 0.68, 0.43, 0.55, 0.29);

  }

  // 1c. Standard Upper Garments: Sculpted 3D Sartorial Walnut & Brass Shoulder Hanger Wings
  const shoulderWingGeo = new THREE.CylinderGeometry(0.018, 0.028, 0.46, 12);
  const leftWingArm = new THREE.Mesh(shoulderWingGeo, hangerWoodMat);
  leftWingArm.position.set(-0.2, 1.23, 0);
  leftWingArm.rotation.z = -1.24;
  leftWingArm.userData = { garmentId: garment.id };
  root.add(leftWingArm);

  const rightWingArm = new THREE.Mesh(shoulderWingGeo, hangerWoodMat);
  rightWingArm.position.set(0.2, 1.23, 0);
  rightWingArm.rotation.z = 1.24;
  rightWingArm.userData = { garmentId: garment.id };
  root.add(rightWingArm);

  const hangerGusset = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.055, 0.036),
    brassMat,
  );
  hangerGusset.position.set(0, 1.29, 0);
  hangerGusset.userData = { garmentId: garment.id };
  root.add(hangerGusset);

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

  // A second relief layer gives the photographed piece depth from the room's side angles.
  const backShellMat = shellMat.clone();
  backShellMat.color.multiplyScalar(0.84);
  const backShell = new THREE.Mesh(frontGeo.clone(), backShellMat);
  backShell.position.set(0, shellCenterY, -0.05);
  backShell.userData = { garmentId: garment.id };
  backShell.visible = false;
  root.add(backShell);

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
    backShellMat.map = tex;
    backShellMat.color.setHex(0xe2ddd5);
    backShellMat.needsUpdate = true;
    backShell.visible = true;
  };

  const showPlainShell = () => {
    frontShell.visible = true;
    backShell.visible = true;
  };

  return { root, applyCutoutTexture, showPlainShell };
}

export const BoutiqueRail3D: React.FC<BoutiqueRail3DProps> = ({
  garments,
  selectedId,
  onSelectGarment,
  viewMode,
  onViewModeChange,
  railOffset,
  onRailOffsetChange,
  showHangTags,
  showRotationHeatmap = true,
  onRenderFallback,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const [cameraControlsBottom, setCameraControlsBottom] = useState<number | undefined>();
  const [projectedTags, setProjectedTags] = useState<ProjectedTag[]>([]);
  const [cameraPreset, setCameraPreset] = useState<CameraAnglePreset>(viewMode === 'vault' ? 'orbit3d' : 'front');
  const [dragMode, setDragMode] = useState<DragInteractionMode>(viewMode === 'vault' ? 'orbit' : 'sweep');
  const [autoOrbit, setAutoOrbit] = useState(false);
  const cameraPresetRef = useRef(cameraPreset);
  const dragModeRef = useRef(dragMode);
  const autoOrbitRef = useRef(autoOrbit);
  const onViewModeChangeRef = useRef(onViewModeChange);
  onViewModeChangeRef.current = onViewModeChange;
  const setCameraPresetOrbitRef = useRef<(preset: CameraAnglePreset) => void>(() => {});
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [railStage, setRailStage] = useState<RailStage>('loading');

  // Keep camera actions above the entire dock, including its collapse tab. Measuring the
  // real bounds also handles mobile wrapping and the collapsed dock without empty space.
  useEffect(() => {
    const viewport = viewportRef.current;
    const dock = document.querySelector<HTMLElement>('[data-testid="rail-control-dock"]');
    if (!viewport || !dock) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bottom = Math.max(16, Math.ceil(viewport.getBoundingClientRect().bottom - dock.getBoundingClientRect().top + 12));
        setCameraControlsBottom((previous) => previous === bottom ? previous : bottom);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(dock);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [railStage]);
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

    // Beverly Hills Walk-In Vault Architectural Group (visible in 'vault' / 3D Walk-Around mode)
    const vaultGroup = new THREE.Group();
    const oakFloorTex = createHerringboneOakTexture(renderer);

    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(28, 22),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: oakFloorTex,
        roughness: 0.38,
        metalness: 0.04,
      }),
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -1.75;
    floorMesh.receiveShadow = !isSoftwareGl;
    vaultGroup.add(floorMesh);

    // Woven Bouclé Gallery Area Rug with Champagne Brass Border Frame (offset +0.02m on Y to prevent Z-fighting)
    const rugBrassFrame = new THREE.Mesh(
      new THREE.BoxGeometry(8.6, 0.018, 4.4),
      brassMat,
    );
    rugBrassFrame.position.set(0, -1.735, 0.65);
    vaultGroup.add(rugBrassFrame);

    const rugBoucle = new THREE.Mesh(
      new THREE.BoxGeometry(8.42, 0.024, 4.22),
      new THREE.MeshStandardMaterial({
        color: 0xf3eee6,
        roughness: 0.88,
        metalness: 0.02,
        bumpMap: fabricBump,
        bumpScale: 0.012,
      }),
    );
    rugBoucle.position.set(0, -1.728, 0.65);
    rugBoucle.receiveShadow = !isSoftwareGl;
    vaultGroup.add(rugBoucle);

    const stoneWallMat = new THREE.MeshStandardMaterial({
      color: 0xebe4da,
      roughness: 0.55,
      metalness: 0.03,
    });

    const backWall = new THREE.Mesh(
      new THREE.BoxGeometry(16, 5.6, 0.35),
      stoneWallMat,
    );
    backWall.position.set(0, 0.85, -1.62);
    backWall.receiveShadow = !isSoftwareGl;
    vaultGroup.add(backWall);

    // 3 Recessed Smoked American Walnut Cabinetry Bays along the Back Wall
    [-3.2, 0, 3.2].forEach((bayX) => {
      const walnutBackPanel = new THREE.Mesh(
        new THREE.BoxGeometry(2.88, 4.95, 0.14),
        walnutMat,
      );
      walnutBackPanel.position.set(bayX, 0.72, -1.38);
      vaultGroup.add(walnutBackPanel);

      // Warm LED Cove Strip at top of each Walnut Bay
      const bayLed = new THREE.Mesh(
        new THREE.BoxGeometry(2.76, 0.035, 0.08),
        new THREE.MeshBasicMaterial({ color: 0xffe0a6 }),
      );
      bayLed.position.set(bayX, 3.12, -1.24);
      vaultGroup.add(bayLed);
    });

    [-4.8, -1.6, 1.6, 4.8].forEach((px) => {
      const pilaster = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 5.4, 0.88),
        whiteLacquerMat,
      );
      pilaster.position.set(px, 0.85, -1.15);
      vaultGroup.add(pilaster);

      const brassTrim = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 5.4, 0.06),
        brassMat,
      );
      brassTrim.position.set(px, 0.85, -0.7);
      vaultGroup.add(brassTrim);
    });

    const upperShelf = new THREE.Mesh(
      new THREE.BoxGeometry(10.2, 0.09, 0.86),
      walnutMat,
    );
    upperShelf.position.set(0, 2.25, -1.1);
    vaultGroup.add(upperShelf);

    const upperShelfBrassLip = new THREE.Mesh(
      new THREE.BoxGeometry(10.22, 0.03, 0.04),
      brassMat,
    );
    upperShelfBrassLip.position.set(0, 2.25, -0.66);
    vaultGroup.add(upperShelfBrassLip);

    const ledStrip = new THREE.Mesh(
      new THREE.BoxGeometry(10.0, 0.025, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xffe2ad }),
    );
    ledStrip.position.set(0, 2.19, -0.76);
    vaultGroup.add(ledStrip);

    // Lower Shoe & Leather Archive Shelf along the Back Wall
    const lowerCredenza = new THREE.Mesh(
      new THREE.BoxGeometry(10.2, 0.42, 0.88),
      walnutMat,
    );
    lowerCredenza.position.set(0, -1.48, -1.1);
    vaultGroup.add(lowerCredenza);

    const lowerCredenzaTop = new THREE.Mesh(
      new THREE.BoxGeometry(10.24, 0.05, 0.9),
      marbleMat,
    );
    lowerCredenzaTop.position.set(0, -1.25, -1.09);
    vaultGroup.add(lowerCredenzaTop);

    // 6-Bay Illuminated Glossy Glass Limited-Edition Sneaker & Boot Collector Vitrines on the Lower Credenza
    const leatherDarkMat = new THREE.MeshStandardMaterial({
      color: 0x2b1d16,
      roughness: 0.28,
      metalness: 0.08,
    });
    const leatherCognacMat = new THREE.MeshStandardMaterial({
      color: 0x8c4a27,
      roughness: 0.32,
      metalness: 0.08,
    });
    const collectorCreamMat = new THREE.MeshStandardMaterial({
      color: 0xf4efe6,
      roughness: 0.34,
      metalness: 0.05,
    });
    const vaultGlassCaseMat = new THREE.MeshPhysicalMaterial({
      color: 0xf2f8ff,
      transparent: true,
      opacity: 0.35,
      roughness: 0.03,
      metalness: 0.08,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      reflectivity: 0.98,
      depthWrite: false,
    });

    [-3.8, -2.3, -0.8, 0.8, 2.3, 3.8].forEach((shoeX, sIdx) => {
      const pairGroup = new THREE.Group();
      pairGroup.position.set(shoeX, -1.22, -0.94);

      const shoeMat =
        sIdx % 3 === 0
          ? collectorCreamMat
          : sIdx % 3 === 1
            ? leatherCognacMat
            : leatherDarkMat;

      // Collector Plinth & Internal LED Light Bar
      const vitrineBase = new THREE.Mesh(
        new THREE.BoxGeometry(0.66, 0.04, 0.44),
        walnutMat,
      );
      vitrineBase.position.set(0, 0.02, 0);
      pairGroup.add(vitrineBase);

      const vitrineLed = new THREE.Mesh(
        new THREE.BoxGeometry(0.58, 0.016, 0.34),
        new THREE.MeshBasicMaterial({ color: 0xfff0c4 }),
      );
      vitrineLed.position.set(0, 0.36, 0);
      pairGroup.add(vitrineLed);

      [-0.13, 0.13].forEach((offsetX, sideIdx) => {
        const midsole = new THREE.Mesh(
          new THREE.BoxGeometry(0.14, 0.03, 0.31),
          collectorCreamMat,
        );
        midsole.position.set(offsetX, 0.055, 0.02);
        pairGroup.add(midsole);

        const bootVamp = new THREE.Mesh(
          new THREE.BoxGeometry(0.13, 0.085, 0.27),
          shoeMat,
        );
        bootVamp.position.set(offsetX, 0.1, 0.02);
        pairGroup.add(bootVamp);

        const bootShaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.055, 0.064, 0.16, 12),
          sideIdx === 0 ? shoeMat : hermesMat,
        );
        bootShaft.position.set(offsetX, 0.15, -0.05);
        pairGroup.add(bootShaft);
      });

      // Glossy Glass Collector Box Enclosure around each Shoe Pair
      const glassCube = new THREE.Mesh(
        new THREE.BoxGeometry(0.64, 0.36, 0.42),
        vaultGlassCaseMat,
      );
      glassCube.position.set(0, 0.2, 0);
      pairGroup.add(glassCube);

      const topBrassFrame = new THREE.Mesh(
        new THREE.BoxGeometry(0.65, 0.018, 0.43),
        brassMat,
      );
      topBrassFrame.position.set(0, 0.38, 0);
      pairGroup.add(topBrassFrame);

      vaultGroup.add(pairGroup);
    });

    // Signature Hermès Orange Archive Boxes & Folded Cashmere Stacks on the upper shelf
    [-3.2, 0.0, 3.2].forEach((boxX, idx) => {
      const boxGroup = new THREE.Group();
      boxGroup.position.set(boxX, 2.42, -1.06);
      boxGroup.rotation.y = idx % 2 === 0 ? 0.08 : -0.12;

      const boxBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.72, 0.26, 0.5),
        hermesMat,
      );
      boxGroup.add(boxBody);

      const boxLid = new THREE.Mesh(
        new THREE.BoxGeometry(0.75, 0.055, 0.53),
        hermesMat,
      );
      boxLid.position.y = 0.12;
      boxGroup.add(boxLid);

      const ribbon = new THREE.Mesh(
        new THREE.BoxGeometry(0.045, 0.28, 0.54),
        walnutMat,
      );
      boxGroup.add(ribbon);

      vaultGroup.add(boxGroup);
    });

    // Multi-Layer Folded Cashmere Knit Stacks between the archive boxes
    [-1.6, 1.6].forEach((stackX) => {
      const stackColors = [0xc8ae8d, 0xdfd2bc, 0x2c3038];
      stackColors.forEach((colHex, layerIdx) => {
        const knitLayer = new THREE.Mesh(
          new THREE.BoxGeometry(0.56, 0.075, 0.42),
          new THREE.MeshStandardMaterial({
            color: colHex,
            roughness: 0.82,
            bumpMap: fabricBump,
            bumpScale: 0.008,
          }),
        );
        knitLayer.position.set(
          stackX,
          2.33 + layerIdx * 0.08,
          -1.06,
        );
        knitLayer.rotation.y = (layerIdx - 1) * 0.05;
        vaultGroup.add(knitLayer);
      });
    });

    // Calacatta Gold Marble Center Plinth Island + Sculpted 3D Luxury Props
    const islandGroup = new THREE.Group();
    islandGroup.position.set(0, -1.36, 1.55);

    const marblePlinth = new THREE.Mesh(
      new THREE.BoxGeometry(3.9, 0.74, 1.32),
      marbleMat,
    );
    marblePlinth.castShadow = !isSoftwareGl;
    marblePlinth.receiveShadow = !isSoftwareGl;
    islandGroup.add(marblePlinth);

    const brassBasePlinth = new THREE.Mesh(
      new THREE.BoxGeometry(3.76, 0.09, 1.2),
      brassMat,
    );
    brassBasePlinth.position.y = -0.39;
    islandGroup.add(brassBasePlinth);

    const brassTopInlay = new THREE.Mesh(
      new THREE.BoxGeometry(3.92, 0.025, 1.34),
      brassMat,
    );
    brassTopInlay.position.y = 0.22;
    islandGroup.add(brassTopInlay);

    // Composite 5-Part Sculpted Hermès Saddlery Leather Weekender Duffle on the Marble Island
    const bagGroup = new THREE.Group();
    bagGroup.position.set(-0.85, 0.54, 0.04);
    bagGroup.rotation.y = 0.24;
    const bagBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.34, 0.34),
      leatherCognacMat,
    );
    bagGroup.add(bagBody);
    const bagFlap = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.08, 0.36),
      leatherDarkMat,
    );
    bagFlap.position.y = 0.15;
    bagGroup.add(bagFlap);
    const bagClasp = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.09, 0.38),
      brassMat,
    );
    bagClasp.position.y = 0.08;
    bagGroup.add(bagClasp);
    [-0.14, 0.14].forEach((hx) => {
      const handleArch = new THREE.Mesh(
        new THREE.TorusGeometry(0.09, 0.016, 10, 20, Math.PI),
        leatherDarkMat,
      );
      handleArch.position.set(hx, 0.19, 0);
      bagGroup.add(handleArch);
    });
    islandGroup.add(bagGroup);

    // Valet Tray + Brass Chronograph Display Case on Island Right
    const valetTray = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.045, 0.42),
      hermesMat,
    );
    valetTray.position.set(0.95, 0.39, 0.08);
    islandGroup.add(valetTray);

    const watchPillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.09, 0.11, 16),
      brassMat,
    );
    watchPillar.position.set(0.85, 0.45, 0.08);
    islandGroup.add(watchPillar);

    vaultGroup.add(islandGroup);

    // Left & Right 3D Architectural Wing Bays (Surrounding Walk-In Closet Walls, Secondary Hanging Rails & Alcoves)
    const sideWings: THREE.Group[] = [];
    [-5.25, 5.25].forEach((wingX) => {
      const isLeft = wingX < 0;
      const wingGroup = new THREE.Group();
      wingGroup.position.set(wingX, 0.65, 0.65);
      wingGroup.rotation.y = isLeft ? Math.PI / 2.35 : -Math.PI / 2.35;

      const wingPanel = new THREE.Mesh(
        new THREE.BoxGeometry(4.6, 5.2, 0.28),
        stoneWallMat,
      );
      wingGroup.add(wingPanel);

      const walnutAlcove = new THREE.Mesh(
        new THREE.BoxGeometry(3.5, 3.8, 0.36),
        walnutMat,
      );
      walnutAlcove.position.set(0, 0.05, 0.08);
      wingGroup.add(walnutAlcove);

      const brassFrame = new THREE.Mesh(
        new THREE.BoxGeometry(3.64, 0.05, 0.42),
        brassMat,
      );
      brassFrame.position.set(0, 1.95, 0.12);
      wingGroup.add(brassFrame);

      const wingLed = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 0.03, 0.08),
        new THREE.MeshBasicMaterial({ color: 0xffe2ad }),
      );
      wingLed.position.set(0, 1.88, 0.28);
      wingGroup.add(wingLed);

      // Secondary 3D Brushed-Brass Wing Hanging Rail + Hanging 3D Archive Garments
      const wingRail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.032, 0.032, 3.2, 16),
        brassMat,
      );
      wingRail.rotation.z = Math.PI / 2;
      wingRail.position.set(0, 1.25, 0.38);
      wingGroup.add(wingRail);

      // Upper Wing Shelf + Hermès Boxes
      const wingUpperShelf = new THREE.Mesh(
        new THREE.BoxGeometry(3.45, 0.06, 0.44),
        whiteLacquerMat,
      );
      wingUpperShelf.position.set(0, 1.48, 0.24);
      wingGroup.add(wingUpperShelf);

      [-0.85, 0.85].forEach((sx) => {
        const stackBox = new THREE.Mesh(
          new THREE.BoxGeometry(0.68, 0.24, 0.42),
          isLeft ? hermesMat : leatherCognacMat,
        );
        stackBox.position.set(sx, 1.63, 0.28);
        wingGroup.add(stackBox);
      });

      sideWings.push(wingGroup);
      vaultGroup.add(wingGroup);
    });

    // Full-Length Beveled Brass Floor Mirror on Left Forefront
    const mirrorGroup = new THREE.Group();
    mirrorGroup.position.set(-4.15, 0.05, 1.72);
    mirrorGroup.rotation.y = 0.52;
    const mirrorFrame = new THREE.Mesh(
      new THREE.BoxGeometry(1.32, 3.3, 0.09),
      brassMat,
    );
    mirrorGroup.add(mirrorFrame);
    const mirrorGlass = new THREE.Mesh(
      new THREE.BoxGeometry(1.18, 3.16, 0.1),
      chromeMat,
    );
    mirrorGroup.add(mirrorGlass);
    vaultGroup.add(mirrorGroup);

    // Luxury Walnut & Alabaster Valet Bench on Right Forefront
    const benchGroup = new THREE.Group();
    benchGroup.position.set(3.95, -1.28, 1.72);
    benchGroup.rotation.y = -0.46;
    const benchCushion = new THREE.Mesh(
      new THREE.BoxGeometry(1.72, 0.2, 0.66),
      whiteLacquerMat,
    );
    benchCushion.position.y = 0.24;
    benchGroup.add(benchCushion);
    const benchBase = new THREE.Mesh(
      new THREE.BoxGeometry(1.62, 0.14, 0.58),
      walnutMat,
    );
    benchBase.position.y = 0.08;
    benchGroup.add(benchBase);
    [-0.68, 0.68].forEach((legX) => {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.36, 0.52),
        brassMat,
      );
      leg.position.set(legX, -0.14, 0);
      benchGroup.add(leg);
    });
    vaultGroup.add(benchGroup);

    // Overhead Recessed Ceiling Coffer & Brass Skylight Frame
    const ceilingCoffer = new THREE.Mesh(
      new THREE.BoxGeometry(12.4, 0.16, 5.8),
      walnutMat,
    );
    ceilingCoffer.position.set(0, 3.32, 0.2);
    vaultGroup.add(ceilingCoffer);

    const ceilingBrassFrame = new THREE.Mesh(
      new THREE.BoxGeometry(12.46, 0.05, 5.86),
      brassMat,
    );
    ceilingBrassFrame.position.set(0, 3.23, 0.2);
    vaultGroup.add(ceilingBrassFrame);

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
        if (halted) return;
        if (g.cutoutSource || srcUrl.startsWith('data:image/')) {
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
        if (halted) return;
        imageCache.set(srcUrl, img);
        processImg(img);
      };
      img.onerror = () => { if (!halted) onLoadFailed(); };
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
    // Wider gallery spacing for a focused collection of glass cases and trousers.

    const rebuildGarmentMeshes = () => {
      while (garmentsContainer.children.length > 0) {
        const prior = garmentsContainer.children[0];
        const materials = new Set<THREE.Material>();
        prior.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) return;
          node.geometry.dispose();
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            if (material !== brassMat && material !== chromeMat) materials.add(material);
          }
        });
        const cachedCutouts = new Set(cutoutTextureCache.values());
        const ownedTextures = new Set<THREE.Texture>();
        materials.forEach(material => {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture && value !== fabricBump && !cachedCutouts.has(value as THREE.CanvasTexture)) ownedTextures.add(value);
          }
          material.dispose();
        });
        ownedTextures.forEach(texture => texture.dispose());
        garmentsContainer.remove(prior);
      }
      simItems = [];

      const list = garmentsRef.current;
      setCutoutsReady({ ready: 0, total: list.length });
      const spacing = railPieceSpacing(list.length);
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

        if (resolve3DDisplayVariant(g).variant !== 'sartorial-hanger' && (g.isSample || !(g.imageUrl || g.frontImageUrl))) {
          onPhotoFailed();
          return;
        }
        const sideUrl =
          g.imageUrl ||
          g.frontImageUrl ||
          STUDIO_CUTOUT_SOURCES[g.silhouette] ||
          STUDIO_CUTOUT_SOURCES.hoodie;
        const frontUrl =
          g.frontImageUrl ||
          g.imageUrl ||
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

    let orbitAzimuth = viewModeRef.current === 'vault' ? -0.52 : 0;
    let orbitPolar = viewModeRef.current === 'vault' ? 0.24 : 0.04;
    let orbitDirection = 1;
    let orbitDistance = viewModeRef.current === 'vault' ? 8.95 : 7.85;
    const applyPreset = (preset: CameraAnglePreset, notify = true) => {
      const positions: Record<CameraAnglePreset, [number, number, number]> = {
        front: [0, 0.04, 7.85], orbit3d: [-0.52, 0.24, 8.95],
        leftWing: [-0.82, 0.18, 8.65], rightWing: [0.82, 0.18, 8.65], overhead: [0, 0.58, 9.6],
      };
      [orbitAzimuth, orbitPolar, orbitDistance] = positions[preset];
      cameraPresetRef.current = preset;
      dragModeRef.current = preset === 'front' ? 'sweep' : 'orbit';
      autoOrbitRef.current = false;
      setCameraPreset(preset);
      setDragMode(dragModeRef.current);
      setAutoOrbit(false);
      const mode = preset === 'front' ? 'rail' : 'vault';
      viewModeRef.current = mode;
      if (notify) onViewModeChangeRef.current?.(mode);
      glideFromOffset = railOffsetRef.current;
      glideToOffset = railOffsetRef.current;
      glideFromCamPos.copy(camera.position);
      glideFromLookAt.copy(_currentLookAt);
      glideStartTime = performance.now();
      glideActive = true;
      requestRender();
    };
    setCameraPresetOrbitRef.current = applyPreset;

    const triggerSelectionGlide = (newSelectedId: string | null) => {
      if (newSelectedId) {
        autoOrbitRef.current = false;
        setAutoOrbit(false);
      }
      const list = garmentsRef.current;
      const idx = newSelectedId
        ? list.findIndex((g) => g.id === newSelectedId)
        : -1;

      glideFromOffset = railOffsetRef.current;
      if (idx !== -1) {
        const spacing = railPieceSpacing(list.length);
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
        camera.updateMatrixWorld();
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
        const fixture = resolve3DDisplayVariant(g);

        return {
          displayVariant: fixture.variant,
          displayFixtureBadge: fixture.shortBadge,
          displayFixtureTitle: fixture.fixtureTitle,
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
      const hasSelection = Boolean(selectedIdRef.current);
      const isVault = viewModeRef.current === 'vault' || cameraPresetRef.current !== 'front';
      vaultGroup.visible = isVault;
      contactShadowPlane.visible = !isVault;
      (scene.background as THREE.Color).setHex(isVault ? 0xfaf8f5 : 0xffffff);
      const drawerOffsetX = hasSelection && container.clientWidth >= 768 ? 1.18 : 0;
      if (autoOrbitRef.current && document.querySelector('[role="dialog"]')) {
        autoOrbitRef.current = false;
        setAutoOrbit(false);
      }
      if (autoOrbitRef.current && !hasSelection) {
        orbitAzimuth += dt * 0.22 * orbitDirection;
        if (Math.abs(orbitAzimuth) >= 1.1) {
          orbitAzimuth = THREE.MathUtils.clamp(orbitAzimuth, -1.1, 1.1);
          orbitDirection *= -1;
        }
        stillMoving = true;
      }
      // A selected piece always faces the viewer; closing it restores the chosen room angle.
      if (isVault && !hasSelection) {
        const cosPitch = Math.cos(orbitPolar);
        _camTargetPos.set(Math.sin(orbitAzimuth) * cosPitch * orbitDistance,
          0.25 + Math.sin(orbitPolar) * orbitDistance,
          Math.cos(orbitAzimuth) * cosPitch * orbitDistance);
        _camLookAt.set(0, 0.25, 0);
      } else {
        _camTargetPos.set(drawerOffsetX, hasSelection ? 0.38 : 0.45, hasSelection ? 6.95 : 7.85);
        _camLookAt.set(drawerOffsetX, hasSelection ? 0.32 : 0.34, 0);
      }

      // Open the near wall and ceiling for architectural cut-away views instead of hiding the clothes.
      ceilingCoffer.visible = _camTargetPos.y < 3.0;
      ceilingBrassFrame.visible = ceilingCoffer.visible;
      sideWings.forEach((wing) => {
        wing.visible = !(Math.sign(wing.position.x) === Math.sign(_camTargetPos.x) && Math.abs(_camTargetPos.x) > 4.5);
      });

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
      stepSimulation();
      renderer.render(scene, camera);
      updateProjectedHangTags();
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
    let dragStartY = 0;
    let dragOrbit = false;
    let startAzimuth = 0;
    let startPolar = 0;
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
      dragOrbit = !selectedIdRef.current && (dragModeRef.current === 'orbit' || e.shiftKey || e.button === 2);
      dragStartY = e.clientY;
      startAzimuth = orbitAzimuth;
      startPolar = orbitPolar;
      if (dragOrbit) {
        autoOrbitRef.current = false;
        setAutoOrbit(false);
        if (cameraPresetRef.current === 'front') {
          cameraPresetRef.current = 'orbit3d';
          setCameraPreset('orbit3d');
          viewModeRef.current = 'vault';
          onViewModeChangeRef.current?.('vault');
        }
      }
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
        const dy = e.clientY - dragStartY;
        if (dragOrbit) {
          pointerMovedDist = Math.max(pointerMovedDist, Math.hypot(dx, dy));
          orbitAzimuth = THREE.MathUtils.clamp(startAzimuth - dx * 0.005, -1.25, 1.25);
          orbitPolar = THREE.MathUtils.clamp(startPolar + dy * 0.004, -0.08, 0.7);
          requestRender();
          return;
        }
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
      if (!selectedIdRef.current && (dragModeRef.current === 'orbit' || e.shiftKey)) {
        orbitDistance = THREE.MathUtils.clamp(orbitDistance + e.deltaY * 0.008, 5.2, 11.2);
        requestRender();
        return;
      }
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
        e.defaultPrevented || document.querySelector('[role="dialog"]') ||
        (document.activeElement instanceof HTMLElement && (document.activeElement.isContentEditable ||
          ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)))
      ) {
        return;
      }
      if (!selectedIdRef.current && cameraPresetRef.current !== 'front' && ['w','a','s','d'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        autoOrbitRef.current = false; setAutoOrbit(false); glideActive = false;
        if (e.key.toLowerCase() === 'a') orbitAzimuth = Math.max(-1.25, orbitAzimuth - 0.12);
        if (e.key.toLowerCase() === 'd') orbitAzimuth = Math.min(1.25, orbitAzimuth + 0.12);
        if (e.key.toLowerCase() === 'w') orbitDistance = Math.max(5.2, orbitDistance - 0.3);
        if (e.key.toLowerCase() === 's') orbitDistance = Math.min(11.2, orbitDistance + 0.3);
        requestRender(); return;
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
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>(cutoutTextureCache.values());
      scene.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        node.geometry.dispose();
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
      if (scene.environment) textures.add(scene.environment);
      textures.forEach((texture) => texture.dispose());
      materials.forEach((material) => material.dispose());
      imageCache.clear();
      cutoutTextureCache.clear();
      requestRenderRef.current = () => {};
      rebuildGarmentsRef.current = () => {};
      setCameraPresetOrbitRef.current = () => {};
      renderer.dispose();
    };
  }, [armed]);

  useEffect(() => {
    rebuildGarmentsRef.current();
  }, [garments]);

  useEffect(() => {
    requestRenderRef.current();
  }, [selectedId, viewMode, railOffset]);

  useEffect(() => {
    const target = viewMode === 'rail' ? 'front' : (cameraPresetRef.current === 'front' ? 'orbit3d' : cameraPresetRef.current);
    if (target !== cameraPresetRef.current) setCameraPresetOrbitRef.current(target);
  }, [viewMode, armed]);

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
      ref={viewportRef}
      className="relative w-full h-full select-none overflow-hidden bg-white"
      data-testid="boutique-rail-viewport"
      data-view-mode={viewMode}
      data-camera-preset={cameraPreset}
      data-auto-orbit={autoOrbit ? 'on' : 'off'}
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

      {!selectedId && railStage === 'ready' && (
        <div style={{ bottom: cameraControlsBottom }} className="absolute bottom-[260px] md:bottom-[220px] left-3 right-3 z-20 flex justify-center pointer-events-none">
          <div role="group" aria-label="3D camera controls" data-testid="rail-camera-controls" className="pointer-events-auto flex max-w-full overflow-x-auto items-center gap-1 rounded-xl border border-[#E7E2DA] bg-white/95 p-1.5 shadow-sm">
            {([['front','Front Rail'],['orbit3d','3D Walk-Around'],['leftWing','Left Wing'],['rightWing','Right Wing'],['overhead','Overhead']] as const).map(([preset,label]) => (
              <button key={preset} type="button" aria-pressed={cameraPreset === preset} onClick={() => setCameraPresetOrbitRef.current(preset)} className={`shrink-0 min-h-11 px-3 rounded-lg text-xs font-medium ${cameraPreset === preset ? 'bg-[#141413] text-white' : 'text-[#57534E] hover:bg-[#F5F2ED]'} focus-visible:outline-2 focus-visible:outline-[#C65E28]`}>{label}</button>
            ))}
            <button type="button" aria-pressed={dragMode === 'orbit'} onClick={() => { const next = dragModeRef.current === 'sweep' ? 'orbit' : 'sweep'; dragModeRef.current = next; setDragMode(next); }} className="shrink-0 min-h-11 px-3 rounded-lg text-xs border border-[#E7E2DA]">Drag: {dragMode === 'orbit' ? 'Orbit' : 'Sweep'}</button>
            <button type="button" aria-pressed={autoOrbit} onClick={() => { const next = !autoOrbitRef.current; if (next && cameraPresetRef.current === 'front') setCameraPresetOrbitRef.current('orbit3d'); autoOrbitRef.current = next; setAutoOrbit(next); requestRenderRef.current(); }} className={`shrink-0 min-h-11 px-3 rounded-lg text-xs ${autoOrbit ? 'bg-[#FFF3EB] text-[#9A3412]' : 'border border-[#E7E2DA]'}`}>Auto orbit</button>
          </div>
        </div>
      )}

      {/* Rotation Heatmap Legend Plaque (Subtle Cool Blue -> Hot Orange Scale) */}
      {showRotationHeatmap && showHangTags && !selectedId && (
        <div
          data-testid="rotation-heatmap-legend"
          style={{
            right: '24px',
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
                data-display-variant={tag.displayVariant}
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
                    ? `bg-[#FFF3EB] text-[#7C2D12] scale-110 z-20 shadow-md ${
                        noPrice ? 'border-dashed border-[#C65E28]' : 'border-[#C65E28]'
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
                    tag.isSelected ? 'text-[#7C2D12]' : 'text-[#8C857B]'
                  }`}
                  style={
                    useHeatStyle
                      ? { color: tag.tagTextHex, opacity: 0.85 }
                      : undefined
                  }
                >
                  <span>{tag.code}</span>
                  {tag.displayVariant !== 'sartorial-hanger' && (
                    <span title={tag.displayFixtureTitle} className="px-1 rounded bg-[#EEE5D7] text-[#685033] text-[8px]">{tag.displayFixtureBadge}</span>
                  )}
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
          className="pointer-events-none hidden md:flex fixed z-30 w-64 bg-white/98 border border-[#F37021]/60 rounded-xl shadow-xl p-2.5 items-center gap-2.5 transition-opacity duration-150"
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
            {resolve3DDisplayVariant(hoveredGarment).variant !== 'sartorial-hanger' && (
              <div className="text-[9px] text-[#8C857B]">
                {resolve3DDisplayVariant(hoveredGarment).shortBadge} · {hoveredGarment.isSample || !(hoveredGarment.imageUrl || hoveredGarment.frontImageUrl) ? 'Illustrative 3D model' : 'Your photo on a 3D fixture'}
              </div>
            )}
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
