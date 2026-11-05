'use strict';
// Closer UI — / (landing), /try, /app, /w/demo-rc1, /admin, /version, /today, /closet, /closet/3d, /discover. No framework, no build step.
// Status labels come from result objects: a save label only after the fresh read-back matches.

const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = String(v); // through the CSSOM: a style attribute would be refused by the page's Content-Security-Policy
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
// Owner sign-in: the admin token lives in this tab's sessionStorage only and goes out as a header.
function ownerToken() { try { return sessionStorage.getItem('closer.ownerToken') || ''; } catch { return ''; } }
function preferOwner() { try { return sessionStorage.getItem('closer.preferOwner') === '1'; } catch { return false; } }
function setPreferOwner(on) { try { if (on) sessionStorage.setItem('closer.preferOwner', '1'); else sessionStorage.removeItem('closer.preferOwner'); } catch {} }
function personalWsId() { try { return localStorage.getItem('closer.personalWs') || ''; } catch { return ''; } }
function setPersonalWsId(wsId) { try { if (wsId) localStorage.setItem('closer.personalWs', wsId); else localStorage.removeItem('closer.personalWs'); } catch {} }
let ACCT = { ok: true, signedIn: false };
function activePersonalWs() {
  if (ACCT && ACCT.signedIn && ACCT.workspaceId) return ACCT.workspaceId;
  return personalWsId();
}
function authHeaders(extra) { const t = ownerToken(); return Object.assign({}, extra || {}, t ? { 'x-admin-token': t } : {}); }
const getJson = async (url, headers) => (await fetch(url, { headers: authHeaders(headers) })).json();
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}) });
  return r.json();
}
function openAccountModal(claimWsId = null) {
  const existing = document.getElementById('acct-backdrop');
  if (existing) existing.remove();
  let mode = ACCT && ACCT.signedIn ? 'status' : 'register';
  let handleVal = '';
  let passVal = '';
  let busy = false;
  let errNode = null;
  const backdrop = h('div', {
    class: 'acct-backdrop',
    id: 'acct-backdrop',
    onclick: (ev) => { if (ev.target === backdrop) backdrop.remove(); },
  });
  const card = h('div', { class: 'acct-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Save & sign in' });
  backdrop.append(card);

  async function submitAuth(ev) {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    errNode = null;
    paint();
    const path = mode === 'register' ? '/api/account/register' : '/api/account/login';
    const payload = { handle: handleVal.trim(), password: passVal };
    if (mode === 'register' && claimWsId && claimWsId !== 'sample' && claimWsId !== 'owner' && claimWsId !== 'demo-rc1') {
      payload.claimWorkspaceId = claimWsId;
    }
    const r = await postJson(path, payload).catch(() => ({ ok: false, code: 'SAVE_UNCONFIRMED', detail: 'Could not reach the server' }));
    busy = false;
    if (!r || r.ok === false) {
      errNode = errChip(r || { code: 'META_REQUEST_REJECTED', detail: 'Check your handle and password' });
      paint();
      return;
    }
    const savedHandle = (r.account && r.account.handle) || r.handle;
    const savedWs = (r.account && r.account.workspaceId) || r.workspaceId;
    ACCT = { ok: true, signedIn: true, handle: savedHandle, workspaceId: savedWs };
    setPersonalWsId(savedWs);
    setPreferOwner(true);
    backdrop.remove();
    const u = new URL(location.href);
    if (u.pathname.startsWith('/closet') || u.pathname === '/today' || u.pathname === '/discover' || u.pathname === '/app') {
      u.searchParams.set('ws', savedWs);
      location.assign(u.pathname + u.search);
    } else {
      location.assign(`/closet/3d?ws=${encodeURIComponent(savedWs)}`);
    }
  }

  async function signOut() {
    if (busy) return;
    busy = true;
    paint();
    await postJson('/api/account/logout', {}).catch(() => {});
    ACCT = { ok: true, signedIn: false };
    setPersonalWsId('');
    setPreferOwner(false);
    backdrop.remove();
    const u = new URL(location.href);
    u.searchParams.delete('ws');
    location.assign(u.pathname + u.search);
  }

  function paint() {
    if (mode === 'status' && ACCT && ACCT.signedIn) {
      card.replaceChildren(
        h('div', { class: 'acct-hd' },
          h('strong', null, `Signed in as @${ACCT.handle}`),
          h('button', { type: 'button', class: 'pp-close', 'aria-label': 'Close', onclick: () => backdrop.remove() }, '×')),
        h('p', { class: 'muted', style: 'margin:0' }, `Saved wardrobe · ${ACCT.workspaceId}. Your pieces, prices, and outfit choices stay saved across reloads and sign-ins.`),
        h('div', { class: 'row', style: 'margin-top:12px;justify-content:space-between' },
          h('a', { class: 'btn small', href: `/closet/3d?ws=${encodeURIComponent(ACCT.workspaceId)}` }, 'Open my 3D rail'),
          h('button', { type: 'button', class: 'btn small ghost', id: 'acct-logout', disabled: busy ? true : null, onclick: signOut }, 'Sign out')));
      return;
    }
    const tabs = h('div', { class: 'seg acct-tabs', role: 'group', 'aria-label': 'Account action' },
      [['register', 'Create & save'], ['login', 'Sign in']].map(([m, lbl]) => h('button', {
        type: 'button',
        'aria-pressed': mode === m ? 'true' : 'false',
        onclick: () => { mode = m; errNode = null; paint(); },
      }, lbl)));
    const hInput = h('input', {
      type: 'text',
      id: 'acct-handle',
      class: 'scan-price',
      autocomplete: 'username',
      placeholder: 'Handle (2–24 lowercase letters, digits, _)',
      value: handleVal,
      oninput: (e) => { handleVal = e.target.value; },
    });
    const pInput = h('input', {
      type: 'password',
      id: 'acct-password',
      class: 'scan-price',
      autocomplete: mode === 'register' ? 'new-password' : 'current-password',
      placeholder: 'Password (8+ characters)',
      value: passVal,
      oninput: (e) => { passVal = e.target.value; },
    });
    card.replaceChildren(
      h('div', { class: 'acct-hd' },
        h('strong', null, mode === 'register' ? 'Save your closet to an account' : 'Sign in to your closet'),
        h('button', { type: 'button', class: 'pp-close', 'aria-label': 'Close', onclick: () => backdrop.remove() }, '×')),
      tabs,
      h('p', { class: 'muted', style: 'margin:0' }, mode === 'register'
        ? (claimWsId && claimWsId.startsWith('my-') ? `Claims your current wardrobe (${claimWsId}) so every piece and outfit stays saved.` : 'Creates a private wardrobe saved on this server.')
        : 'Re-open your saved pieces, confirmed wears, and outfit choices.'),
      h('form', { class: 'acct-form', onsubmit: submitAuth },
        hInput,
        pInput,
        errNode ? h('div', { class: 'flash' }, errNode) : null,
        h('button', { type: 'submit', class: 'btn small', id: 'acct-submit', disabled: busy ? true : null }, busy ? 'Saving…' : (mode === 'register' ? 'Create account & save' : 'Sign in'))));
  }

  paint();
  document.body.append(backdrop);
  const firstInput = card.querySelector('input');
  if (firstInput) firstInput.focus();
}
function accountHeaderBtn(claimWsId = null) {
  const signed = ACCT && ACCT.signedIn;
  return h('button', {
    type: 'button',
    class: `btn small ${signed ? 'ghost acct-btn is-signed' : 'ghost acct-btn'}`,
    id: 'account-btn',
    onclick: () => openAccountModal(claimWsId),
  }, signed ? `@${ACCT.handle} · Saved` : 'Save · Sign in');
}
function ownerBar() {
  const input = h('input', { type: 'password', id: 'owner-token', autocomplete: 'off', placeholder: 'Owner token (real mode)', class: 'tok' });
  const state = h('span', { class: 'muted' }, ownerToken() ? 'Signed in for this tab' : 'Not signed in');
  return h('div', { class: 'row ownerbar' }, input,
    h('button', { class: 'btn small ghost', type: 'button', onclick: () => { try { sessionStorage.setItem('closer.ownerToken', input.value.trim()); } catch {} location.reload(); } }, 'Sign in'),
    ownerToken() ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => { try { sessionStorage.removeItem('closer.ownerToken'); } catch {} location.reload(); } }, 'Sign out') : null,
    state);
}

/** Two copies from one canvas: JPEG (long side ≤ 1600) for the models, PNG (≤ 800) for pixel work. Drops EXIF. */
async function prepareUpload(file) {
  const bmp = await createImageBitmap(file);
  const draw = (max, type, q) => {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return { url: c.toDataURL(type, q), w: c.width, h: c.height };
  };
  const jpeg = draw(1600, 'image/jpeg', 0.9);
  const png = draw(800, 'image/png');
  return { jpeg, png };
}
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLOTS = ['outer', 'top', 'bottom', 'shoes'];
let META = null;
// UI-only wording for engine codes. The codes themselves are unchanged and stay visible, small, next to the words.
const STATE_LABEL = { DRAFT: 'Confirm the pieces', PROPOSED: 'Pick an option', LOCKED: 'Selected', WORN: 'Worn', HOLD: 'Needs your answer', NEEDS_REPLAN: 'Needs a re-plan', CANCELLED: 'Cancelled' };
const FORMALITY_LABEL = { high: 'dressy', mid: 'in between', low: 'casual' };
const CODE_LABEL = {
  SCOPE_DENIED: 'Not allowed on this page', READBACK_MISMATCH: 'Saved, but the read-back did not match. Reload and check.', META_DISABLED: 'Model calls are switched off right now',
  META_REQUEST_REJECTED: 'Pick one of the sentences', INVALID_TRANSITION: 'That step is not possible right now', NEEDS_CHECK: 'Fill every [check] / [확인] part first',
  ALREADY_WORN: 'Already recorded', UNSUPPORTED_IMAGE: 'Could not read that photo',
};
/** Plain words for an error code, with the code itself small after them. */
function errWords(code, detail) { return h('span', null, CODE_LABEL[code] || detail || code, ' ', h('span', { class: 'mono muted' }, code)); }
function errChip(r, cls = 'bad', at = null) { return h('span', { class: `chip ${cls}`, 'data-at': at }, errWords(r.code, r.detail)); }

// ---------- images, masks, cut-outs ----------
const imgCache = new Map();
function loadImage(url) {
  if (!imgCache.has(url)) {
    imgCache.set(url, new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }));
  }
  return imgCache.get(url);
}
function maskPath(mask) {
  const p = new Path2D();
  let pos = 0, cur = 0;
  for (const tok of mask.rle.split('.')) {
    const n = parseInt(tok, 36);
    if (cur === 1) {
      let s = pos;
      const e = pos + n;
      while (s < e) {
        const row = Math.floor(s / mask.w), col = s % mask.w;
        const len = Math.min(e - s, mask.w - col);
        p.rect(mask.x + col, mask.y + row, len, 1);
        s += len;
      }
    }
    pos += n;
    cur ^= 1;
  }
  return p;
}
function rgbOf(color) {
  const c = META.palette[color];
  return c ? `rgb(${c.join(',')})` : '#bbb';
}
const SILHOUETTES = {
  coat: ['M21,5 L12,11 L5,56 L13,58 L17,24 L15,75 L45,75 L43,24 L47,58 L55,56 L48,11 L39,5 Q30,10 21,5 Z', 'M23,6 L30,26 L37,6 M30,26 L30,75'],
  jacket: ['M20,6 L11,13 L6,52 L14,54 L18,24 L17,64 L43,64 L42,24 L46,54 L54,52 L49,13 L40,6 Q30,11 20,6 Z', 'M22,7 L30,28 L38,7 M30,28 L30,64'],
  zip: ['M21,7 L11,14 L6,52 L14,54 L18,24 L18,62 L42,62 L42,24 L46,54 L54,52 L49,14 L39,7 Q30,11 21,7 Z', 'M30,10 L30,62 M18,57 L42,57'],
  shirt: ['M22,7 L11,14 L6,50 L14,52 L18,23 L18,63 L42,63 L42,23 L46,52 L54,50 L49,14 L38,7 L34,13 L30,10 L26,13 Z', 'M30,11 L30,63'],
  knit: ['M21,8 L11,15 L6,51 L14,53 L18,24 L18,61 L42,61 L42,24 L46,53 L54,51 L49,15 L39,8 Q30,14 21,8 Z', 'M18,56 L42,56'],
  tee: ['M21,9 L9,17 L13,30 L19,25 L19,62 L41,62 L41,25 L47,30 L51,17 L39,9 Q30,15 21,9 Z', ''],
  shorts: ['M15,12 L45,12 L48,48 L33,48 L30,28 L27,48 L12,48 Z', 'M15,17 L45,17 M30,12 L30,28'],
  trousers: ['M16,6 L44,6 L47,74 L34,74 L30,26 L26,74 L13,74 Z', 'M16,11 L44,11 M30,6 L30,26'],
  shoes: ['M6,50 Q6,36 18,35 L25,40 Q29,43 29,50 L29,56 L6,56 Z M31,50 Q31,36 43,35 L50,40 Q54,43 54,50 L54,56 L31,56 Z', 'M6,53 L29,53 M31,53 L54,53'],
};
function kindShape(kind) {
  const s = String(kind || '').toLowerCase();
  if (!s) return null;
  if (/coat|trench|parka/.test(s)) return SILHOUETTES.coat;
  if (/track|hood|zip|cardigan/.test(s)) return SILHOUETTES.zip;
  if (/jacket|blazer|suit/.test(s)) return SILHOUETTES.jacket;
  if (/shirt|blouse|oxford/.test(s)) return SILHOUETTES.shirt;
  if (/knit|sweater|crew|pullover/.test(s)) return SILHOUETTES.knit;
  if (/tee|t-shirt|top|tank|polo/.test(s)) return SILHOUETTES.tee;
  if (/short/.test(s)) return SILHOUETTES.shorts;
  if (/shoe|derby|sneaker|loafer|boot|runner|flat|heel/.test(s)) return SILHOUETTES.shoes;
  if (/trouser|jean|chino|pant|denim|slack|skirt/.test(s)) return SILHOUETTES.trousers;
  return null;
}
function placeholder(color, kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 60 80');
  svg.setAttribute('width', '60');
  svg.setAttribute('height', '80');
  const c = META && META.palette && META.palette[color];
  const lum = c ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) : 180;
  const seam = lum < 92 ? 'rgba(255,255,255,0.34)' : 'rgba(21,20,19,0.28)';
  const shape = kindShape(kind);
  if (shape) {
    const body = document.createElementNS(ns, 'path');
    body.setAttribute('d', shape[0]);
    body.setAttribute('fill', rgbOf(color));
    body.setAttribute('stroke', 'rgba(21,20,19,0.32)');
    body.setAttribute('stroke-width', '1.4');
    body.setAttribute('stroke-linejoin', 'round');
    svg.append(body);
    if (shape[1]) {
      const detail = document.createElementNS(ns, 'path');
      detail.setAttribute('d', shape[1]);
      detail.setAttribute('fill', 'none');
      detail.setAttribute('stroke', seam);
      detail.setAttribute('stroke-width', '1.1');
      detail.setAttribute('stroke-linecap', 'round');
      svg.append(detail);
    }
    return svg;
  }
  const poly = document.createElementNS(ns, 'polygon');
  poly.setAttribute('points', '8,0 52,0 60,8 60,72 52,80 8,80 0,72 0,8');
  poly.setAttribute('fill', rgbOf(color));
  poly.setAttribute('stroke', 'rgba(0,0,0,0.25)');
  poly.setAttribute('stroke-width', '1.5');
  svg.append(poly);
  return svg;
}
function cutCanvas(cut) {
  const c = h('canvas', { width: cut.mask.w, height: cut.mask.h, 'data-cut': '1' });
  loadImage(cut.url).then((img) => {
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.translate(-cut.mask.x, -cut.mask.y);
    ctx.clip(maskPath(cut.mask));
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  });
  return c;
}
/** itemId → { url, mask } from the cards of confirmed photo operations (mask cut-outs of the owner's own photo). */
function cutMap(view) {
  const m = {};
  for (const op of view.operations) {
    if (op.kind !== 'photo' || !op.cardItemIds) continue;
    const photo = META.photos.find((p) => p.photoId === op.photoId);
    for (const c of op.cards) {
      const id = op.cardItemIds[String(c.cardId)];
      if (id && c.mask && photo && !m[id]) m[id] = { url: photo.url, mask: c.mask };
    }
  }
  return m;
}
function wsHref(path, wsId, extraParams = null) {
  const u = new URL(path, location.origin);
  if (wsId) u.searchParams.set('ws', wsId);
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
  }
  return u.pathname + u.search;
}
function thumb(item, cuts, opts = {}) {
  if (!item) return h('div', { class: 'muted' }, '—');
  return studioThumb(item, cuts, opts);
}

// ---------- chrome ----------
function chrome(extra) {
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('on', a.dataset.path === location.pathname || (a.dataset.path === '/closet' && location.pathname.startsWith('/closet')));
  const row = $('#chips');
  row.replaceChildren(...(extra || []));
}
/** One line from the server (mode and sample data); the spend caps fold away and show only to a signed-in owner. */
function showBanner(b, el = $('#banner')) {
  if (!b) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `banner ${b.kind}`;
  const caps = ownerToken() && (b.capLine || b.ifLive) ? h('details', null, h('summary', null, 'Spend caps'), b.capLine ? h('div', { class: 'sub' }, b.capLine) : null, b.ifLive ? h('div', { class: 'sub' }, b.ifLive) : null) : null;
  el.replaceChildren(...[h('strong', null, b.text), caps].filter(Boolean));
}
/** Proof of tooling from the server's own call records: the live chip strings as served (one per live 2xx call), and a grey chip per mock call read from its call line. */
function callChips(op) {
  const live = (op.liveChips || []).map((l) => h('span', { class: 'chip ok' }, l));
  const mock = (op.callLines || []).filter((l) => l.includes('(mock')).map((l) => { const p = l.split(' · '); return h('span', { class: 'chip' }, `Mock · ${p[1]} · ${p[3]}`); });
  return [...live, ...mock];
}
/** Spark 2's own contribution on an option: how many mask cut-outs it was sent and which IDs it named as a visual match (validated by code). */
function visualChip(o) {
  if (o.cutoutsSeen === undefined) return null;
  return h('span', { class: 'chip' }, `Spark 2: ${o.cutoutsSeen} cut-out${o.cutoutsSeen === 1 ? '' : 's'} seen · visual match: ${o.visualMatch && o.visualMatch.length ? o.visualMatch.join(', ') : 'none named'}`);
}

// ---------- save flow (§3-6 ⑤): write → fresh read → compare → label ----------
async function saveFlow(wsId, action, body, matches, okLabel) {
  let resp;
  const trail = [];
  try {
    resp = await postJson(`/api/ws/${wsId}/${action}`, body);
  } catch {
    trail.push('SAVE_UNCONFIRMED');
    const id = body.eventId || (body.eventIds && body.eventIds[0]);
    const r = await fetch(`/api/ws/${wsId}/event/${encodeURIComponent(id)}`);
    resp = r.ok ? await r.json() : await postJson(`/api/ws/${wsId}/${action}`, body); // same eventId, never a new one
  }
  if (!resp.ok) {
    return { ok: false, chip: resp.code === 'ALREADY_WORN' ? META.labels.alreadyRecorded : errWords(resp.code, resp.detail), cls: resp.code === 'ALREADY_WORN' ? 'warn' : 'bad', resp };
  }
  const view = await getJson(`/api/ws/${wsId}/view`);
  if (!matches(view)) return { ok: false, chip: errWords('READBACK_MISMATCH', ''), cls: 'bad', view };
  return { ok: true, chip: okLabel, cls: 'ok', view, resp, trail };
}
const sameOutfit = (a, b) => SLOTS.every((s) => (a[s] || null) === (b[s] || null));


/** Re-render without losing keyboard focus: remember the focused control and focus its twin afterwards. */
function keepFocus(root, paint) {
  const a = document.activeElement;
  const key = a && root.contains(a) ? (a.id ? `#${a.id}` : `${a.tagName}|${a.className}|${(a.textContent || '').trim()}`) : null;
  paint();
  if (!key) return;
  const twin = key.startsWith('#') ? root.querySelector(key) : [...root.querySelectorAll(a.tagName)].find((e) => `${e.tagName}|${e.className}|${(e.textContent || '').trim()}` === key);
  if (twin && typeof twin.focus === 'function') twin.focus({ preventScroll: true });
}

const EDITABLE_TYPES = ['coat', 'jacket', 'track_jacket', 'knit', 'dress_shirt', 'tee', 'blouse', 'training_top', 'trousers', 'jeans', 'chinos', 'skirt', 'shorts', 'derby', 'sneakers', 'loafers', 'running_shoes'];
const EDITABLE_COLORS = ['black', 'charcoal', 'gray', 'white', 'beige', 'brown', 'navy', 'blue', 'green', 'red', 'yellow', 'pink'];

// ---------- decision component (Try and App) ----------
function decisionUI(root, cfg) {
  const S = { wsId: cfg.wsId, view: null, photoId: 'p1', chipId: 'c1', sentence: '', flash: [], busy: false, painted: new Set(), answers: {}, typeEdits: {}, formalityEdits: {}, priceEdits: {}, unchecked: new Set(), ran: false };

  async function refresh() {
    if (S.wsId) S.view = await getJson(`/api/ws/${S.wsId}/view`);
    if (S.wsId && !cfg.visitor && !cfg.readOnly) {
      await listUploads();
      const firstMine = META.photos.find((p) => p.mine);
      if (firstMine && S.photoId === 'p1' && !S.ran) S.photoId = firstMine.photoId;
    }
    render();
  }
  /** Photos uploaded to this wardrobe earlier, fetched with the owner header, so each can be picked or deleted after a reload. */
  async function listUploads() {
    const own = await getJson(`/api/ws/${S.wsId}/photos`).catch(() => ({ photos: [] }));
    for (const p of own.photos || []) {
      if (META.photos.some((q) => q.photoId === p.photoId)) continue;
      const b = await fetch(`/api/ws/${S.wsId}/photo/${p.photoId}`, { headers: authHeaders() });
      if (b.ok) META.photos.unshift({ photoId: p.photoId, title: 'Your photo', url: URL.createObjectURL(await b.blob()), w: p.w, h: p.h, count: 0, mine: true });
    }
  }
  const flash = (r) => { S.flash = [r]; };
  /** Runs an action with the controls disabled, re-reads the view, and brings the result on screen (phones: the result renders below the fold). */
  const busy = async (fn, revealSel) => {
    S.busy = true; render();
    try { await fn(); } finally { S.busy = false; await refresh(); }
    const d = revealSel ? root.querySelector(revealSel) || root.querySelector('#decision') : null;
    if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function run(scan = false) {
    await busy(async () => {
      if (cfg.visitor) {
        const t = await postJson('/api/try/start', { photoId: S.photoId });
        S.wsId = t.workspaceId;
      }
      S.flash = [];
      S.answers = {};
      S.typeEdits = {};
      S.formalityEdits = {};
      S.priceEdits = {};
      S.unchecked = new Set();
      const own = !cfg.visitor && S.sentence.trim();
      const body = !cfg.visitor && scan
        ? { photoId: S.photoId, scan: true, ...(own ? { sentence: S.sentence.trim() } : {}) }
        : own ? { photoId: S.photoId, sentence: S.sentence.trim() } : { photoId: S.photoId, chipId: S.chipId };
      const op = await postJson(`/api/ws/${S.wsId}/photo`, body);
      if (op.ok === false) flash({ chip: errWords(op.code, op.detail), cls: 'bad' });
      S.ran = true;
    }, '#decision');
  }

  async function handleFileUpload(f) {
    if (!f) return;
    let uploadedId = null;
    await busy(async () => {
      try {
        const { jpeg, png } = await prepareUpload(f);
        const r = await postJson(`/api/ws/${S.wsId}/upload`, { jpegBase64: jpeg.url.split(',')[1], pngBase64: png.url.split(',')[1] });
        if (r.ok === false) { flash({ chip: errWords(r.code, r.detail), cls: 'bad' }); return; }
        META.photos.unshift({ photoId: r.photoId, title: 'Your closet photo', url: jpeg.url, w: r.w, h: r.h, count: 0, mine: true });
        S.photoId = r.photoId;
        uploadedId = r.photoId;
        flash({ chip: 'Photo uploaded (EXIF removed) · scanning visible pieces…', cls: 'ok' });
      } catch (err) { flash({ chip: errWords('UNSUPPORTED_IMAGE', err && err.message ? err.message : 'could not read the photo'), cls: 'bad' }); }
    });
    if (uploadedId) await run(true);
  }

  function inputs() {
    const minePhotos = META.photos.filter((p) => p.mine);
    const samplePhotos = META.photos.filter((p) => !p.mine);
    const activePhoto = META.photos.find((p) => p.photoId === S.photoId) || META.photos[0];
    const isMineSelected = !!(activePhoto && activePhoto.mine);
    const photoTile = (p) =>
      h('button', { class: 'photo-pick', type: 'button', 'aria-pressed': String(S.photoId === p.photoId), onclick: () => { S.photoId = p.photoId; render(); } },
        h('img', { src: p.url, alt: `${p.title}${p.mine ? ', your photo' : ', sample photo'}` }),
        h('div', { class: 'cap' }, `${p.title}`),
        p.mine ? h('span', { class: 'chip accent' }, 'Your photo') : null);
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic', capture: 'environment', id: 'upload-file', hidden: true, onchange: (e) => handleFileUpload(e.target.files && e.target.files[0]) });
    const dropzone = cfg.visitor ? null : h('div', {
      class: 'upload-drop',
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); },
      ondragleave: (e) => { e.currentTarget.classList.remove('drag'); },
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); handleFileUpload(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); },
    },
      fileInput,
      h('button', { class: 'btn', type: 'button', id: 'upload', disabled: S.busy || !S.wsId ? true : null, onclick: () => fileInput.click() }, '+ Upload closet or outfit photo'),
      isMineSelected ? h('button', { class: 'btn ghost small', type: 'button', id: 'photo-delete', disabled: S.busy ? true : null, onclick: () => busy(async () => {
        const photoId = S.photoId;
        const r = await postJson(`/api/ws/${S.wsId}/photodelete`, { photoId });
        if (!r.ok) { flash({ chip: 'Could not delete this photo', cls: 'bad' }); return; }
        META.photos.splice(META.photos.findIndex((p) => p.photoId === photoId), 1);
        S.photoId = META.photos.length ? META.photos[0].photoId : null;
        flash({ chip: 'Photo deleted from your server.', cls: 'ok' });
      }) }, 'Delete') : null,
      h('span', { class: 'muted' }, 'Drop JPEG/PNG here · EXIF stripped locally'));
    const sentences = h('div', { class: 'sentences' }, META.chips.map((c) =>
      h('button', { class: 'sentence', type: 'button', 'aria-pressed': String(S.chipId === c.chipId), onclick: () => { S.chipId = c.chipId; render(); } }, `“${c.text}”`)));
    const photoGrid = cfg.visitor
      ? h('div', { class: 'photos' }, META.photos.map(photoTile))
      : h('div', null,
        minePhotos.length ? h('div', { class: 'photos' }, minePhotos.map(photoTile)) : null,
        h('details', { class: 'sample-fold', open: minePhotos.length === 0 ? true : null },
          h('summary', null, minePhotos.length ? `Or test with ${samplePhotos.length} sample outfits` : 'Sample outfits'),
          h('div', { class: 'photos', style: 'margin-top:10px' }, samplePhotos.map(photoTile))));
    return h('div', { class: 'grid cols-2' },
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '1'), cfg.visitor ? 'Pick a sample outfit' : 'Your photo'),
        dropzone,
        photoGrid),
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '2'), cfg.visitor ? 'Pick a sentence' : isMineSelected ? 'Scan closet or fix outfit' : 'Pick a sentence'),
        !cfg.visitor && isMineSelected
          ? h('div', { class: 'scan-hero' },
            h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Detect up to 16 hanging & folded pieces at once, edit type/colour/price, and hang them on your 3D boutique rail.'),
            h('div', { class: 'row', style: 'margin-bottom:12px' },
              h('button', { class: 'btn', type: 'button', id: 'scan-closet', disabled: S.busy, onclick: () => run(true) }, S.busy ? 'Scanning…' : 'Scan whole closet (up to 16)'),
              h('button', { class: 'btn ghost', type: 'button', id: 'run', disabled: S.busy, onclick: () => run(false) }, 'Single outfit')),
            h('details', { class: 'sample-fold' },
              h('summary', null, 'Optional: outfit sentence'),
              sentences,
              h('textarea', { id: 'own-sentence', rows: '2', class: 'draft', maxlength: '200', placeholder: 'Or write your own: Keep this jacket. The rest feels too dressed-up.', oninput: (e) => { S.sentence = e.target.value; } }, S.sentence)))
          : [
            h('p', { class: 'muted' }, cfg.visitor ? 'Fixed sentences only. Free text and visitor photos are off on this page.' : 'Pick one, or write your own (your wardrobe only).'),
            sentences,
            cfg.visitor ? null : h('textarea', { id: 'own-sentence', rows: '2', class: 'draft', maxlength: '200', placeholder: 'Or write your own: Keep this jacket. The rest feels too dressed-up.', oninput: (e) => { S.sentence = e.target.value; } }, S.sentence),
            h('div', { class: 'spacer' }),
            h('div', { class: 'row' },
              h('button', { class: 'btn', type: 'button', id: 'run', disabled: S.busy, onclick: () => run(false) }, S.busy ? 'Working…' : 'Find the pieces'),
              cfg.visitor ? null : h('button', { class: 'btn ghost', type: 'button', id: 'scan-closet', disabled: S.busy, onclick: () => run(true) }, 'Scan whole closet (up to 16)'),
              cfg.visitor ? h('span', { class: 'muted' }, 'Each run uses a fresh copy of the sample wardrobe.') : null),
          ]));
  }

  function itemsById() {
    const m = {};
    for (const it of S.view.items) m[it.itemId] = it;
    return m;
  }

  function flatlay(outfit, changed, cuts, items) {
    return h('div', { class: 'flatlay' }, SLOTS.map((s) => {
      const id = outfit[s];
      const it = id ? items[id] : null;
      return h('div', { class: `cell${changed.includes(s) ? ' changed' : ''}${id ? '' : ' empty'}` },
        h('div', { class: 'cell-hd' },
          h('span', { class: 'cell-slot' }, s),
          changed.includes(s) ? h('span', { class: 'cell-pill' }, 'swap') : id && cuts && cuts[id] ? h('span', { class: 'cell-dot', title: 'Colour from your photo' }) : null),
        id ? thumb(it, cuts, { flatlay: true }) : h('span', { class: 'muted' }, '—'),
        h('div', { class: 'lbl' }, id ? `${id} · ${it ? itemName(it) : ''}` : `no ${s}`));
    }));
  }

  function stage(op) {
    const confirmed = Object.keys(op.cardItemIds || {}).length > 0;
    const canvas = h('canvas', { id: 'stage', 'data-painted': '0' });
    const photo = META.photos.find((p) => p.photoId === op.photoId);
    (async () => {
      if (!photo) return;
      const img = await loadImage(photo.url);
      canvas.width = photo.w;
      canvas.height = photo.h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.font = 'bold 26px system-ui, sans-serif';
      for (const c of op.cards) {
        const skipped = S.unchecked.has(c.cardId);
        const b = c.box;
        const bw = b.x2 - b.x1;
        ctx.lineWidth = skipped ? 4 : 5;
        ctx.setLineDash(c.offender || skipped ? [20, 14] : []);
        ctx.strokeStyle = skipped ? 'rgba(120,120,120,0.45)' : c.offender ? '#c0392b' : c.pinned ? '#2d4a7a' : '#f37021';
        ctx.strokeRect(b.x1, b.y1, bw, b.y2 - b.y1);
        ctx.setLineDash([]);
        const chosenType = S.typeEdits[c.cardId] || c.type;
        const tag = bw < 145
          ? `#${c.cardId}`
          : `#${c.cardId} ${chosenType.replace('_', ' ')}${c.pinned ? ' · keep' : ''}${c.offender ? ' · off' : ''}`;
        const w = Math.min(bw - 4, ctx.measureText(tag).width + 16);
        ctx.fillStyle = skipped ? 'rgba(90,90,90,0.5)' : c.offender ? '#c0392b' : c.pinned ? '#2d4a7a' : 'rgba(21,20,19,0.84)';
        ctx.fillRect(b.x1 + 2, b.y1 + 2, Math.max(38, w), 34);
        ctx.fillStyle = '#fff';
        ctx.fillText(tag, b.x1 + 9, b.y1 + 27);
      }
      const order = op.cards.filter((c) => c.mask && !S.unchecked.has(c.cardId)).sort((a, b) => a.arrival - b.arrival);
      const animate = !S.painted.has(op.operationId);
      S.painted.add(op.operationId);
      for (const c of order) {
        if (animate && op.cards.length <= 5) await sleep(220);
        const path = maskPath(c.mask);
        ctx.fillStyle = 'rgba(243, 112, 33, 0.14)';
        ctx.fill(path);
        ctx.save();
        ctx.clip(path);
        ctx.strokeStyle = 'rgba(243, 112, 33, 0.65)';
        ctx.lineWidth = 2.5;
        for (let k = -c.mask.h; k < c.mask.w; k += 32) {
          ctx.beginPath();
          ctx.moveTo(c.mask.x + k, c.mask.y + c.mask.h);
          ctx.lineTo(c.mask.x + k + c.mask.h, c.mask.y);
          ctx.stroke();
        }
        ctx.restore();
      }
      canvas.dataset.painted = '1';
    })();

    // Drag on photo to add a custom piece box before confirming (owner mode).
    if (!cfg.visitor && !cfg.readOnly && !confirmed && op.state === 'DRAFT' && photo) {
      let dragStart = null;
      const toPhotoPt = (ev) => {
        const r = canvas.getBoundingClientRect();
        return {
          x: Math.max(0, Math.min(1000, Math.round(((ev.clientX - r.left) / Math.max(1, r.width)) * 1000))),
          y: Math.max(0, Math.min(1000, Math.round(((ev.clientY - r.top) / Math.max(1, r.height)) * 1000))),
        };
      };
      canvas.style.cursor = 'crosshair';
      canvas.title = 'Drag on photo to add another piece';
      canvas.onpointerdown = (ev) => { dragStart = toPhotoPt(ev); };
      canvas.onpointerup = async (ev) => {
        if (!dragStart) return;
        const end = toPhotoPt(ev);
        const x1 = Math.min(dragStart.x, end.x), y1 = Math.min(dragStart.y, end.y);
        const x2 = Math.max(dragStart.x, end.x), y2 = Math.max(dragStart.y, end.y);
        dragStart = null;
        if (x2 - x1 < 45 || y2 - y1 < 45) return;
        await busy(async () => {
          const r = await postJson(`/api/ws/${S.wsId}/pixelbox`, { operationId: op.operationId, normBox: [x1, y1, x2, y2] });
          if (r.ok === false) flash({ chip: errWords(r.code, r.detail), cls: 'bad' });
          else flash({ chip: `Added piece #${r.cards.length} from drawn box`, cls: 'ok' });
        });
      };
    }
    return h('div', { class: 'stage' },
      canvas,
      !cfg.visitor && !confirmed && op.state === 'DRAFT'
        ? h('p', { class: 'muted stage-tip' }, 'Tip: drag a box on the photo to add any missed piece.')
        : null);
  }

  function cardsView(op) {
    const confirmed = Object.keys(op.cardItemIds || {}).length > 0;
    const photo = META.photos.find((p) => p.photoId === op.photoId);
    const editable = !cfg.visitor && !cfg.readOnly && !confirmed;
    return h('div', { class: 'cards scan-cards' }, op.cards.map((c) => {
      const q = !confirmed && c.question;
      const chosenColor = S.answers[c.cardId] || c.sparkColor;
      const chosenType = S.typeEdits[c.cardId] || c.type;
      const skipped = S.unchecked.has(c.cardId);
      const pe = S.priceEdits[c.cardId] || { amount: '', platform: 'KARROT' };
      const cutThumb = c.mask && photo
        ? h('div', { class: 'scan-cut' }, cutCanvas({ url: photo.url, mask: c.mask }))
        : h('div', { class: 'scan-cut' }, placeholder(chosenColor, chosenType));
      return h('div', { class: `card scan-card${c.offender ? ' offender' : ''}${c.pinned ? ' pinned' : ''}${skipped ? ' is-skipped' : ''}` },
        h('div', { class: 'scan-card-row' },
          cutThumb,
          h('div', { class: 'scan-card-body' },
            h('div', { class: 'hd' },
              h('label', { class: 'scan-check' },
                editable ? h('input', {
                  type: 'checkbox',
                  checked: skipped ? null : true,
                  onchange: (e) => {
                    if (e.target.checked) S.unchecked.delete(c.cardId);
                    else S.unchecked.add(c.cardId);
                    render();
                  },
                }) : null,
                h('span', null, `Piece #${c.cardId}${confirmed && op.cardItemIds[String(c.cardId)] ? ` → ${op.cardItemIds[String(c.cardId)]}` : ''}`)),
              h('span', { class: 'chip' }, c.slot)),
            editable ? h('div', { class: 'scan-edits' },
              h('select', {
                class: 'scan-sel',
                'aria-label': `Piece ${c.cardId} type`,
                onchange: (e) => { S.typeEdits[c.cardId] = e.target.value; render(); },
              }, EDITABLE_TYPES.map((t) => h('option', { value: t, selected: t === chosenType ? true : null }, TYPE_NAME[t] || t.replace('_', ' ')))),
              h('select', {
                class: 'scan-sel',
                'aria-label': `Piece ${c.cardId} colour`,
                onchange: (e) => { S.answers[c.cardId] = e.target.value; render(); },
              }, EDITABLE_COLORS.map((col) => h('option', { value: col, selected: col === chosenColor ? true : null }, col))),
              h('select', {
                class: 'scan-sel',
                'aria-label': `Piece ${c.cardId} formality`,
                onchange: (e) => { S.formalityEdits[c.cardId] = e.target.value; render(); },
              }, [['high', 'dressy'], ['mid', 'in between'], ['low', 'casual']].map(([fv, fl]) => h('option', { value: fv, selected: fv === (S.formalityEdits[c.cardId] || c.formality) ? true : null }, fl))),
              h('input', {
                type: 'number',
                min: '1',
                step: '1000',
                class: 'scan-price',
                placeholder: '₩ / $ price (opt)',
                value: pe.amount,
                oninput: (e) => { S.priceEdits[c.cardId] = { ...(S.priceEdits[c.cardId] || pe), amount: e.target.value }; },
              }),
              h('select', {
                class: 'scan-sel scan-plat',
                'aria-label': `Piece ${c.cardId} platform`,
                onchange: (e) => { S.priceEdits[c.cardId] = { ...(S.priceEdits[c.cardId] || pe), platform: e.target.value }; },
              }, PLATFORM_OPTIONS.slice(0, 8).map(([val, lbl]) => h('option', { value: val, selected: val === pe.platform ? true : null }, lbl.split(' (')[0]))))
              : h('div', { class: 'attrs' },
                h('span', null, chosenType.replace('_', ' ')),
                h('span', null, h('span', { class: 'swatch', style: `background:${rgbOf(chosenColor)}` }), `Colour: ${chosenColor}`),
                c.maskColor ? h('span', null, h('span', { class: 'swatch', style: `background:${rgbOf(c.maskColor)}` }), `Mask: ${c.maskColor}`) : null,
                h('span', null, FORMALITY_LABEL[c.formality] || c.formality),
                h('span', null, c.pinned ? h('span', { class: 'chip accent' }, 'keep') : null, c.offender ? h('span', { class: 'chip bad' }, 'feels off') : null)))),
        q ? h('div', { class: 'question' }, `? ${q.text}`, h('div', { class: 'row', style: 'margin-top:6px' }, q.choices.map((ch) =>
          h('button', { class: 'btn small ghost', type: 'button', 'aria-pressed': String(S.answers[c.cardId] === ch), onclick: () => { S.answers[c.cardId] = ch; render(); } }, ch)))) : null);
    }));
  }

  async function confirm(op) {
    await busy(async () => {
      const selectedCards = op.cards.filter((c) => !S.unchecked.has(c.cardId));
      if (!selectedCards.length) { flash({ chip: 'Select at least one piece to save.', cls: 'warn' }); return; }
      const eventIds = selectedCards.map(() => uuid());
      const cardIds = selectedCards.length === op.cards.length ? undefined : selectedCards.map((c) => c.cardId);
      const answers = {};
      for (const c of selectedCards) {
        const col = S.answers[c.cardId];
        const typ = S.typeEdits[c.cardId];
        const frm = S.formalityEdits[c.cardId];
        if (col || typ || frm) {
          answers[c.cardId] = {
            ...(col ? { color: col } : {}),
            ...(typ ? { type: typ } : {}),
            ...(frm ? { formality: frm } : {}),
          };
        }
      }
      const r = await saveFlow(S.wsId, 'confirm', { operationId: op.operationId, eventIds, ...(cardIds ? { cardIds } : {}), expectedRevision: S.view.revision, answers },
        (v) => selectedCards.every((c) => v.items.some((it) => it.cutoutRef === `${op.operationId}#${c.cardId}` && it.ownership === 'CONFIRMED')),
        `${selectedCards.length} pieces saved · checked against the server`);
      if (r.ok && !cfg.visitor) {
        setPreferOwner(true);
        const confirmedOp = (r.view && r.view.operations || []).find((o) => o.operationId === op.operationId);
        const mapIds = (confirmedOp && confirmedOp.cardItemIds) || {};
        let pricedCount = 0;
        const todayIso = new Date().toISOString().slice(0, 10);
        for (const c of selectedCards) {
          const pe = S.priceEdits[c.cardId];
          const itemId = mapIds[String(c.cardId)];
          const amt = pe && Number(pe.amount);
          if (itemId && amt > 0) {
            const plat = pe.platform || 'KARROT';
            const pr = await postJson(`/api/ws/${S.wsId}/evidence`, {
              itemId,
              platform: plat,
              currency: PLATFORM_CURRENCY[plat] || 'KRW',
              priceType: 'ASK',
              amount: amt,
              retrievedAt: todayIso,
              matchLevel: 'SAME_ITEM',
            });
            if (pr && pr.ok !== false) pricedCount++;
          }
        }
        if (pricedCount > 0) r.chip = `${selectedCards.length} pieces & ${pricedCount} price tag${pricedCount === 1 ? '' : 's'} saved to your 3D closet`;
      }
      flash(r);
    });
  }
  async function propose(op) {
    await busy(async () => {
      const r = await postJson(`/api/ws/${S.wsId}/propose`, { operationId: op.operationId });
      if (r.ok === false) flash({ chip: errWords(r.code, r.detail), cls: 'bad' });
      else S.flash = [];
    }, '#options');
  }
  async function pick(op, i) {
    await busy(async () => {
      const opt = op.options[i];
      const r = await saveFlow(S.wsId, 'lock', { operationId: op.operationId, optionIndex: i, eventId: uuid(), expectedRevision: S.view.revision },
        (v) => v.plans.some((p) => p.planId === op.planId && p.state === 'LOCKED' && sameOutfit(p.slots, opt.outfit)), META.labels.selectionSaved);
      flash(r);
    });
  }
  async function keep(op) {
    await busy(async () => {
      const r = await saveFlow(S.wsId, 'keep', { operationId: op.operationId, eventId: uuid(), expectedRevision: S.view.revision },
        (v) => v.plans.some((p) => p.planId === op.planId && p.state === 'LOCKED' && sameOutfit(p.slots, op.context.baseline)), META.labels.selectionSaved);
      flash(r);
    });
  }
  async function answerFormality(op, id, val) {
    await busy(async () => {
      await postJson(`/api/ws/${S.wsId}/answer`, { operationId: op.operationId, formality: { [id]: val } });
      await postJson(`/api/ws/${S.wsId}/propose`, { operationId: op.operationId });
    }, '#options');
  }
  async function setAvail(item, state) {
    await busy(async () => {
      const r = await saveFlow(S.wsId, 'availability', { itemId: item.itemId, state, eventId: uuid(), expectedRevision: S.view.revision },
        (v) => v.items.some((i) => i.itemId === item.itemId && i.availability === state), `${item.itemId} → ${state.toLowerCase()} · checked against the server`);
      flash(r);
    }, '#options');
  }
  async function wore(plan) {
    await busy(async () => {
      const eventId = uuid();
      const r = await saveFlow(S.wsId, 'wear', { planId: plan.planId, eventId, expectedRevision: S.view.revision },
        (v) => v.plans.some((p) => p.planId === plan.planId && p.state === 'WORN') && v.wearRows.some((w) => w.eventId === eventId), META.labels.wearSaved);
      flash(r);
    });
  }
  async function undo(wear) {
    await busy(async () => {
      const r = await saveFlow(S.wsId, 'undo', { wearEventId: wear.eventId, eventId: uuid(), expectedRevision: S.view.revision },
        (v) => !v.wearRows.some((w) => w.eventId === wear.eventId), 'Wear undone · checked against the server');
      flash(r);
    });
  }
  async function next(plan) {
    await busy(async () => {
      await postJson('/api/demo-clock', { days: 1 });
      const r = await postJson(`/api/ws/${S.wsId}/next`, { fromPlanId: plan.planId });
      const moved = r.ok !== false && r.occasionDate > plan.occasionDate;
      S.flash = r.ok === false ? [{ chip: errWords(r.code, r.detail), cls: 'bad' }]
        : [{ chip: moved ? `${META.labels.demoClockPlusOne} · plan for ${r.occasionDate}` : `Next plan for ${r.occasionDate} · the demo clock did not move`, cls: 'warn' }];
    }, '#decision');
  }

  function decisionPanel(op) {
    const cuts = cutMap(S.view);
    const items = itemsById();
    const stateCls = { PROPOSED: 'accent', LOCKED: 'ok', WORN: 'ok', HOLD: 'bad', NEEDS_REPLAN: 'warn', CANCELLED: 'bad', DRAFT: '' }[op.state] || '';
    const parts = [];
    parts.push(h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', { style: 'margin:0' }, op.kind === 'photo' ? 'Photo + sentence' : op.kind === 'replan' ? 'Button re-plan' : 'Next plan (no photo)'),
      h('span', { class: `chip ${stateCls}`, id: 'op-state', 'data-state': op.state }, STATE_LABEL[op.state] || op.state)));
    if (op.sentence) parts.push(h('p', { class: 'muted' }, `“${op.sentence}”`));
    const chips = [...callChips(op), ...op.labels.map((l) => h('span', { class: 'chip' }, l)), ...op.reasonCodes.map((c) => h('span', { class: 'chip bad' }, c))];
    if (chips.length) parts.push(h('div', { class: 'chip-row' }, chips));
    // The call lines prove the tooling; they sit below the photo, not above it.
    const callsBlock = op.callLines.length ? h('div', { class: 'calls-block' }, h('h3', null, `Model calls · ${op.callLines.length}`), h('ul', { class: 'calls', id: 'calls' }, op.callLines.map((l) => h('li', null, l))))
      : op.kind !== 'photo' ? h('ul', { class: 'calls' }, h('li', null, 'model calls: 0')) : null;

    if (op.kind === 'photo' && op.cards.length) {
      const activeCards = op.cards.filter((c) => !S.unchecked.has(c.cardId));
      const firstAddedId = op.cardItemIds ? Object.values(op.cardItemIds)[0] : null;
      const railHref = `/closet/3d?ws=${encodeURIComponent(S.wsId)}${firstAddedId ? `&item=${encodeURIComponent(firstAddedId)}` : ''}`;
      parts.push(h('div', { class: 'grid cols-2' }, stage(op), h('div', null, cardsView(op),
        !op.context ? h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn', id: 'confirm', type: 'button', disabled: S.busy || !activeCards.length || activeCards.some((c) => c.question && !S.answers[c.cardId]), onclick: () => confirm(op) }, `Confirm ${activeCards.length} cards`),
          h('span', { class: 'muted' }, 'Nothing is saved until you confirm.')) : null,
        op.context && op.state === 'DRAFT' ? h('div', { class: 'row post-confirm-bar', style: 'margin-top:12px' },
          op.scan ? null : h('button', { class: 'btn', id: 'propose', type: 'button', disabled: S.busy, onclick: () => propose(op) }, 'Suggest changes'),
          !cfg.visitor ? h('a', { class: op.scan ? 'btn' : 'btn ghost small', href: railHref, id: 'open-owner-rail' }, 'Open 3D boutique rail →') : null,
          !cfg.visitor ? h('a', { class: 'btn ghost small', href: `/closet?ws=${encodeURIComponent(S.wsId)}`, id: 'open-owner-closet' }, 'Ledger & prices') : null,
          !cfg.visitor ? h('a', { class: 'btn ghost small', href: `/today?ws=${encodeURIComponent(S.wsId)}`, id: 'open-owner-today' }, 'Wear today') : null,
          !cfg.visitor ? h('a', { class: 'btn ghost small', href: `/discover?ws=${encodeURIComponent(S.wsId)}`, id: 'open-owner-discover' }, 'Match looks') : null) : null)));
    }
    if (callsBlock) parts.push(callsBlock);
    if (op.questions.length && op.state !== 'DRAFT') {
      for (const q of op.questions) {
        parts.push(h('div', { class: 'question' }, `? ${q.text}`,
          q.attr === 'formality' ? h('div', { class: 'row', style: 'margin-top:6px' }, q.choices.map((ch) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => answerFormality(op, q.itemIds[0], ch) }, ch))) : null));
      }
    }
    if (op.state === 'HOLD' && op.context) parts.push(h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => keep(op) }, 'Keep as is')));
    if ((op.state === 'PROPOSED' || op.state === 'LOCKED') && op.options.length && op.context) {
      const plan = S.view.plans.find((p) => p.planId === op.planId);
      const base = op.kind === 'replan' && plan ? plan.slots : op.context.baseline;
      parts.push(h('div', { class: `options cols-${Math.min(3, 1 + op.options.length)}`, id: 'options' },
        h('div', { class: 'option base' }, h('h3', null, op.kind === 'replan' ? 'Locked before' : 'Now'), flatlay(base, [], cuts, items)),
        op.options.map((o, i) => h('div', { class: 'option' },
          h('h3', null, `${o.label}${o.source === 'code' && op.kind !== 'replan' ? ' · code' : ''}`),
          visualChip(o),
          flatlay(o.outfit, o.changedSlots, cuts, items),
          o.reasonLines.length ? h('ul', { class: 'reasons' }, o.reasonLines.map((l) => h('li', null, l))) : null,
          op.state === 'PROPOSED' ? h('button', { class: 'btn small', type: 'button', 'data-pick': String(i), disabled: S.busy, onclick: () => pick(op, i) }, 'Wear this') : null))));
      if (op.state === 'PROPOSED' && op.kind !== 'replan') parts.push(h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => keep(op) }, 'Keep it as it is')));
    }
    if (S.flash.length) parts.push(h('div', { class: 'chip-row flash', id: 'flash', role: 'status', 'aria-live': 'polite' }, S.flash.map((f) => h('span', { class: `chip ${f.cls}` }, f.chip))));
    return h('section', { class: 'panel', id: 'decision' }, parts);
  }

  function planPanel() {
    const plans = [...S.view.plans].sort((a, b) => b.baseRevision - a.baseRevision);
    if (!plans.length) return null;
    const p = plans[0];
    const cuts = cutMap(S.view);
    const items = itemsById();
    const wear = S.view.wearRows.find((w) => w.planId === p.planId);
    return h('section', { class: 'panel', id: 'plan' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, `Plan for ${p.occasionDate}`), h('span', { class: 'chip ok', 'data-state': p.state }, STATE_LABEL[p.state] || p.state)),
      h('div', { class: 'spacer' }),
      h('div', { style: 'max-width:340px' }, flatlay(p.slots, [], cuts, items)),
      h('div', { class: 'row', style: 'margin-top:12px' },
        p.state === 'LOCKED' || p.state === 'WORN' ? h('button', { class: 'btn', id: 'wore', type: 'button', disabled: S.busy, onclick: () => wore(p) }, 'I wore this') : null,
        p.state === 'WORN' && wear ? h('button', { class: 'btn ghost', type: 'button', onclick: () => undo(wear) }, 'Undo') : null,
        p.state === 'WORN' ? h('button', { class: 'btn ghost', id: 'next', type: 'button', onclick: () => next(p) }, 'Next plan') : null,
        h('span', { class: 'muted' }, p.state === 'WORN' ? `wear confirmed ${wear ? wear.occurredAt : ''}` : META.labels.wearNotConfirmed)));
  }

  function wardrobePanel() {
    const cuts = cutMap(S.view);
    return h('section', { class: 'panel', id: 'wardrobe' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, 'Wardrobe'), S.view.seededLabel ? h('span', { class: 'chip sample' }, S.view.seededLabel) : null),
      h('div', { class: 'spacer' }),
      h('div', { class: 'wardrobe' }, S.view.items.map((it) => h('div', { class: 'item' },
        h('div', { class: 'thumb' }, thumb(it, cuts)),
        h('div', { class: 'meta' },
          h('div', null, h('b', null, it.itemId), ` · ${it.type.replace('_', ' ')} · ${it.color} · ${FORMALITY_LABEL[it.formality] || it.formality}`),
          h('div', null, it.wearLabel),
          it.sample ? h('div', null, h('span', { class: 'chip sample' }, META.labels.sampleItem)) : null,
          h('div', { class: 'seg', role: 'group', 'aria-label': `${it.itemId} availability` }, ['AVAILABLE', 'LAUNDRY', 'REPAIR', 'STORED'].map((st) =>
            h('button', { type: 'button', 'data-item': it.itemId, 'data-state': st, 'aria-pressed': String(it.availability === st), disabled: S.busy || it.availability === st || cfg.readOnly, onclick: () => setAvail(it, st) }, st.toLowerCase()))))))));
  }

  function render() {
    const parts = [];
    if (!cfg.readOnly) parts.push(inputs());
    if (S.view) {
      showBanner(S.view.banner);
      const ops = S.view.operations.filter((o) => cfg.visitor ? true : true);
      if (ops.length && (S.ran || !cfg.visitor)) parts.push(decisionPanel(ops[0]));
      parts.push(planPanel());
      parts.push(wardrobePanel());
    }
    keepFocus(root, () => root.replaceChildren(...parts.filter(Boolean)));
  }
  return { refresh, render, state: S };
}

// ---------- screens ----------
/** '/': what Closer does, in one fold, with the three product screens one tap away. Numbers on this page come only from the same APIs the screens use. */
async function landingScreen(view) {
  chrome([]);
  const card = (href, title, line) => h('a', { class: 'card land', href }, h('div', { class: 'hd' }, title), h('p', { class: 'muted' }, line));
  const bn = h('div', { class: 'banner', id: 'banner-landing', hidden: true });
  const boardSlot = h('div', { id: 'asset-slot' });
  const railSlot = h('div', { class: 'stage rail-stage land-rail', id: 'land-rail' });
  view.append(
    h('h1', null, 'Keep the piece you love. Change only what feels off.'),
    h('p', { class: 'lede' }, 'One photo of today’s outfit. Closer turns it into your closet. Only confirmed wears count; it never posts or pays.'),
    h('ol', { class: 'flow-steps', 'aria-label': 'How it works' },
      [['Photo', 'One outfit, one sentence'], ['Cards', 'Spark finds, SAM cuts, you confirm'], ['Rail', 'Your pieces, prices seen'], ['Keep or let go', 'Counted facts, your call']]
        .map(([t, d], i) => h('li', null, h('span', { class: 'fs-n' }, String(i + 1)), h('b', null, t), h('span', { class: 'fs-d' }, d)))),
    h('div', { class: 'row', style: 'margin: 0 0 16px' }, h('a', { class: 'btn', href: '/try', id: 'start' }, 'Start with a photo'), h('a', { class: 'btn ghost', href: '/app', id: 'upload-link' }, 'Upload your photo'), h('a', { class: 'btn ghost', href: '/closet/3d', id: 'rail-link' }, 'Open my closet'), h('a', { class: 'muted', href: '/today', id: 'try-link' }, 'Today')),
    railSlot,
    boardSlot,
    h('div', { class: 'grid cols-3' },
      card('/today', 'Today', 'Keep one piece. Finish the outfit with what you own.'),
      card('/closet', 'My closet', 'Confirmed wears and the prices you saw, counted.'),
      card('/discover', 'Discover', 'Looks you want, counted against your closet.')),
    bn);
  // One sample closet for the rail and the board: both read the same workspace.
  const ws = closetWs();
  const [vb] = await Promise.all([getJson('/api/banner/visitor'), landingBoard(boardSlot, ws), landingRail(railSlot, ws)]);
  showBanner(vb, bn);
}

/** The sample closet's asset board on the landing page (the same closet /today and /closet open). */
async function landingBoard(slot, ws) {
  try {
    const { id } = await ws;
    const L = await getJson(`/api/ws/${id}/ledger`);
    slot.replaceChildren(...[assetBoard(L, { sampleCloset: true, foot: h('p', { class: 'asset-foot' }, h('a', { class: 'btn small ghost', href: '/closet', id: 'board-closet' }, 'Open My closet')) })].filter(Boolean));
  } catch {
    slot.replaceChildren();
  }
}

/** The same closet hung on the rail at the top of the page; a tap opens that piece's keep-or-let-go question. */
async function landingRail(slot, ws) {
  try {
    const { id, view: v } = await ws;
    const [L, mod] = await Promise.all([getJson(`/api/ws/${id}/ledger`), import('/static/rail3d.js')]);
    const seenType = {};
    const pieces = (v.items || []).map((it) => {
      const rgb = (META.palette && META.palette[it.color]) || null;
      const idx = seenType[it.type] || 0;
      seenType[it.type] = idx + 1;
      return { itemId: it.itemId, slot: it.slot, type: it.type, rgb, availability: it.availability || 'AVAILABLE', photo: boutiqueRailPhoto(it.type, rgb, idx, null) };
    });
    const rail = mod.mountRail3d(slot, pieces, { tags: L ? L.tags : null, money, onPick: (itemId) => { location.href = `/closet?decide=${encodeURIComponent(itemId)}`; }, label: `This closet on a rail: ${pieces.length} pieces. Tap one for its keep-or-let-go question.` });
    if (!rail) slot.remove();
  } catch {
    slot.remove();
  }
}

async function tryScreen(view) {
  chrome([h('span', { class: 'chip sample' }, 'Sample photos · drawn by code · demo')]);
  view.append(h('h1', null, 'Try it on three sample outfits'),
    h('p', { class: 'lede' }, 'Pick one outfit photo and one fixed sentence, or upload your own closet photo.'),
    h('div', { class: 'row', style: 'margin: 0 0 14px' },
      h('a', { class: 'btn small', href: '/app', id: 'open-app-upload' }, '+ Upload your own closet photo'),
      h('span', { class: 'muted' }, 'Below is a sandbox with three sample outfits.')));
  const root = h('div');
  view.append(root);
  const ui = decisionUI(root, { wsId: null, visitor: true });
  // Banner before the first run: describe a fresh visitor copy.
  const vb = await getJson('/api/banner/visitor');
  showBanner({ ...vb, ifLive: vb.ifLive || `If live: ${META.labels.replayAndLedger} (visitor cap $0 by default)` });
  ui.render();
}

async function appScreen(view) {
  chrome([]);
  const reqWs = new URLSearchParams(location.search).get('ws');
  let targetWs = reqWs && reqWs !== 'sample' ? reqWs : (activePersonalWs() || 'owner');
  let probe = await fetch(`/api/ws/${encodeURIComponent(targetWs)}/view`, { headers: authHeaders() });
  if (!probe.ok && targetWs !== 'owner') {
    targetWs = 'owner';
    probe = await fetch('/api/ws/owner/view', { headers: authHeaders() });
  }
  if (probe.status === 403 && !ownerToken()) {
    const created = await postJson('/api/closet/personal', {}).catch(() => null);
    if (created && created.workspaceId) {
      targetWs = created.workspaceId;
      setPersonalWsId(targetWs);
      probe = await fetch(`/api/ws/${encodeURIComponent(targetWs)}/view`, { headers: authHeaders() });
    }
  }
  const topRow = h('div', { class: 'app-hero-bar' },
    h('div', null,
      h('h1', { style: 'margin:0 0 4px' }, 'Your closet studio'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Upload one closet photo → correct type, colour, formality & price → hang on your 3D boutique rail.')),
    h('div', { class: 'row' },
      accountHeaderBtn(targetWs),
      h('a', { class: 'btn small ghost', href: `/closet/3d?ws=${encodeURIComponent(targetWs)}` }, '3D Boutique Rail →'),
      h('details', { class: 'owner-drawer' },
        h('summary', { class: 'btn small ghost' }, ownerToken() ? 'Owner · signed in' : 'Owner settings'),
        h('div', { class: 'owner-drawer-body' },
          ownerBar(),
          h('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' }, 'Photos stay on your server (EXIF stripped). Live mode sends store:false to muse-spark-1.3 & sam-3.1; local mode runs pixel segmentation on-device.')))));
  view.append(topRow);
  if (probe.status === 403) { view.append(ownerBar(), h('p', { class: 'question' }, 'This wardrobe is private. Sign in with your account or the owner token above.')); return; }
  const root = h('div');
  view.append(root);
  const ui = decisionUI(root, { wsId: targetWs, visitor: false });
  await ui.refresh();
}

async function demoScreen(view) {
  chrome([h('span', { class: 'chip sample' }, 'Sample wardrobe · recorded run · demo')]);
  const v = await getJson('/api/ws/demo-rc1/view');
  showBanner({ kind: 'mock', text: META.labels.readOnly, capLine: '', ifLive: '' });
  const out = h('div', { class: 'chip-row', id: 'write-result' });
  view.append(
    h('h1', null, 'Recorded run (read-only)'),
    h('p', { class: 'lede' }, META.labels.notRecordedYet),
    h('section', { class: 'panel' }, h('dl', { class: 'kv' },
      h('dt', null, 'stateHash'), h('dd', { class: 'mono', id: 'state-hash' }, v.stateHash),
      h('dt', null, 'ledger revision'), h('dd', null, String(v.revision)),
      h('dt', null, 'events'), h('dd', null, String(v.events.length))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', id: 'try-write', onclick: async () => {
        const r = await postJson('/api/ws/demo-rc1/availability', { itemId: 'B2', state: 'LAUNDRY', eventId: uuid(), expectedRevision: v.revision });
        out.replaceChildren(r.ok ? h('span', { class: 'chip ok' }, 'write accepted') : errChip(r));
      } }, 'Try a write'), out)));
  const root = h('div');
  view.append(root);
  const ui = decisionUI(root, { wsId: 'demo-rc1', visitor: false, readOnly: true });
  await ui.refresh();
  showBanner({ kind: 'mock', text: META.labels.readOnly, capLine: '', ifLive: '' });
}

async function adminScreen(view) {
  chrome();
  const r = await fetch('/api/admin', { headers: authHeaders() });
  if (r.status === 403) { view.append(h('h1', null, 'Admin'), ownerBar(), h('p', { class: 'lede' }, 'Admin token required. Sign in above (the token is on the server, see deploy/README.md).')); return; }
  const a = await r.json();
  const usd = (m) => `$${(m / 1e6).toFixed(4)}`;
  const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  showBanner(a.adminOpen ? { kind: 'mock', text: 'Admin is open because this is local mock mode. Real mode needs CLOSER_ADMIN_TOKEN.', capLine: '', ifLive: '' } : null);
  const toggle = async (on) => { await postJson('/api/admin/kill', { on }); location.reload(); };
  view.append(h('h1', null, 'Admin'),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'panel' }, h('h2', null, 'K1 · model kill switch (CLOSER_KILL)'),
        h('div', { class: 'row' }, h('span', { class: `chip ${a.killActive ? 'bad' : 'ok'}`, id: 'kill-state' }, a.killActive ? `on · ${mmss(a.killRemainingMs)} left` : 'off'),
          h('button', { class: 'btn small', type: 'button', id: 'kill-on', onclick: () => toggle(true) }, 'Turn on (10 min TTL)'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => toggle(false) }, 'Turn off')),
        h('p', { class: 'muted' }, 'While on: new photos and sentences return META_DISABLED. Button re-plans and read-back keep working.')),
      h('section', { class: 'panel' }, h('h2', null, 'Money caps'),
        h('table', { class: 't' }, h('tbody', null,
          h('tr', null, h('th', null, 'App total'), h('td', null, usd(a.flags.caps.appTotalMicroUsd)), h('td', null, `spent ${usd(a.spend.appTotal)}`)),
          h('tr', null, h('th', null, 'Visitor / day'), h('td', null, usd(a.visitorCapNow)), h('td', null, `spent ${usd(a.spend.visitorDay)}`)),
          h('tr', null, h('th', null, 'Session'), h('td', null, usd(a.flags.caps.sessionMicroUsd)), h('td', null, '')),
          h('tr', null, h('th', null, 'Date rule'), h('td', { colspan: '2' }, `visitor cap $0 from ${a.flags.caps.visitorZeroFrom}`)))),
        h('p', { class: 'muted' }, 'Provisional defaults (no answer to the decision card): total $20, visitor live calls off.'))),
    h('section', { class: 'panel' }, h('h2', null, `Call ledger (${a.mode} mode)`),
      h('div', { class: 'scroll-x' }, h('table', { class: 't', id: 'calls-table' },
        h('thead', null, h('tr', null, ['callId', 'model', 'http', 'ms', 'cost', 'est. live', 'source'].map((c) => h('th', null, c)))),
        h('tbody', null, a.calls.length ? a.calls.map((c) => h('tr', null, h('td', { class: 'mono' }, c.callId), h('td', null, c.model), h('td', null, String(c.http)), h('td', null, String(c.latencyMs)), h('td', null, usd(c.costMicroUsd)), h('td', null, usd(c.estLiveCostMicroUsd)), h('td', null, c.source)))
          : h('tr', null, h('td', { colspan: '7', class: 'muted' }, 'No calls yet.')))))));
}

async function versionScreen(view) {
  chrome([h('span', { class: 'chip accent' }, META.buildChip)]);
  const v = await getJson('/api/version');
  view.append(h('h1', null, 'Version'),
    h('section', { class: 'panel' }, h('dl', { class: 'kv' },
      h('dt', null, 'sha'), h('dd', { class: 'mono', id: 'sha' }, v.sha),
      h('dt', null, 'server started'), h('dd', null, v.builtAt),
      h('dt', null, 'mode'), h('dd', null, v.mode),
      h('dt', null, 'runtime'), h('dd', null, `Node.js ${v.node}`),
      h('dt', null, 'Live model calls so far'), h('dd', { id: 'live-calls' }, `${v.liveCalls} (live calls answered 2xx, counted on this server)`),
      h('dt', null, '/w/demo-rc1 stateHash'), h('dd', { class: 'mono' }, v.demoRc1StateHash))),
    h('section', { class: 'panel' }, h('h2', null, 'Verify it yourself'),
      h('ol', null,
        h('li', null, 'Open /w/demo-rc1 and /version in a private window; compare stateHash and sha.'),
        h('li', null, 'Compare git rev-parse HEAD of the code you have with the sha above: same release.'),
        h('li', null, 'Turn K1 on in /admin and check that a button re-plan still works.'),
        h('li', null, 'This page shows the mode and the number of live model calls recorded on this server; each live call also appears as a chip next to its result.'))),
    h('p', { class: 'muted' }, 'Owner pages: ', h('a', { href: '/app' }, 'My wardrobe'), ' · ', h('a', { href: '/admin' }, 'Admin'), ' · ', h('a', { href: '/w/demo-rc1' }, 'Read-only run')));
}


// ---------- features 11/2: Today (keep this one) · Closet (60-day review) · Discover (looks) ----------
const TYPE_NAME = { jacket: 'jacket', coat: 'coat', dress_shirt: 'dress shirt', knit: 'knit', tee: 'T-shirt', trousers: 'trousers', jeans: 'jeans', chinos: 'chinos', derby: 'derby shoes', sneakers: 'sneakers', track_jacket: 'track jacket', blouse: 'blouse', training_top: 'training top', skirt: 'skirt', joggers: 'joggers', shorts: 'shorts', running_shoes: 'running shoes', loafers: 'loafers' };
// Resale platforms: Korean first, then international. Currency per platform; prices are never converted or averaged.
const PLATFORM_OPTIONS = [['KARROT', 'Karrot (KRW)'], ['KREAM', 'KREAM (KRW)'], ['BUNJANG', 'Bunjang (KRW)'], ['MUSINSA_USED', 'Musinsa Used (KRW)'], ['POSHMARK', 'Poshmark (USD)'], ['EBAY', 'eBay.com (USD)'], ['GRAILED', 'Grailed (USD)'], ['DEPOP', 'Depop US (USD)'], ['STOCKX', 'StockX (USD)'], ['VINTED', 'Vinted (EUR)']];
const PLATFORM_CURRENCY = { KARROT: 'KRW', KREAM: 'KRW', BUNJANG: 'KRW', MUSINSA_USED: 'KRW', POSHMARK: 'USD', EBAY: 'USD', GRAILED: 'USD', DEPOP: 'USD', STOCKX: 'USD', VINTED: 'EUR' };
function money(n, c) { return c === 'KRW' ? `₩${Math.round(n).toLocaleString('en-US')}` : `${c === 'EUR' ? '€' : '$'}${Number(n).toFixed(2)}`; }
const itemName = (it) => (it ? `${it.color !== 'unknown' ? `${it.color} ` : ''}${TYPE_NAME[it.type] || it.type}` : '');
/** 2026-09-07 → 'Sep 7' (same date, friendlier; the ISO form stays in the data). */
function fmtDate(iso) { const d = /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(`${iso}T00:00:00`) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : String(iso); }

// ---------- price chart over time: one currency per chart, one line per platform, straight segments between seen prices ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) { if (c === null || c === undefined || c === false) continue; el.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  return el;
}
const dayOf = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;
const isoOfDay = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
/** Axis step: 1, 2 or 5 × a power of ten, never below the currency's smallest sensible step. */
function niceStep(x, cur) {
  const floor = cur === 'KRW' ? 1000 : 1;
  if (!(x > 0)) return cur === 'KRW' ? 10000 : 10;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / pow;
  return Math.max(floor, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow);
}
const PRICE_RANGES = [['30', '30d'], ['90', '90d'], ['all', 'All']];
let PC_SEQ = 0;
const MATCH_WORDS = { SAME_ITEM: 'same item', SIMILAR: 'similar item', UNVERIFIED: 'not sure' };
const priceWord = (p) => (p.priceType === 'ASK' ? 'asking' : 'traded');
/**
 * Prices over time, drawn the way a market draws its price: x = the date a price was seen, y = the amount in this
 * chart's currency. One line per platform through its seen points, straight segments only; sample rows dashed.
 * Nothing here is averaged, converted, smoothed or forecast. `series` are the /market series of ONE currency.
 * opts: { selectedPlatform, range ('30' | '90' | 'all'), selectedPoint (evidenceId), onPick(point, series), onRange(range), today }.
 */
function priceChart(series, cur, opts) {
  const o = opts || {};
  const range = o.range || 'all';
  const today = o.today || new Date().toISOString().slice(0, 10);
  const from = range === 'all' ? null : dayOf(today) - Number(range);
  const shown = series.map((s) => ({ ...s, points: s.points.filter((p) => from === null || dayOf(p.retrievedAt) >= from) })).filter((s) => s.points.length);
  const all = shown.flatMap((s) => s.points);
  const last = (s) => s.points[s.points.length - 1];
  const later = (a, b) => (a.retrievedAt > b.retrievedAt || (a.retrievedAt === b.retrievedAt && a.evidenceId > b.evidenceId));
  // The highlighted platform: the selected one when it has a point in range, else the platform seen most recently.
  const focus = shown.find((s) => s.platform === o.selectedPlatform) || shown.reduce((m, s) => (!m || later(last(s), last(m)) ? s : m), null);
  const H = 180, top = 12, bottom = 24, right = 10;

  const head = h('div', { class: 'pc-head' });
  if (!focus) head.append(h('div', { class: 'pc-big muted' }, 'No prices seen in this range'));
  else {
    const L = last(focus), F = focus.points[0];
    const d = L.amount - F.amount;
    // Native append() would print a null child as the text "null": drop it first.
    head.append(...[h('div', { class: 'pc-big' }, money(L.amount, cur)),
      h('div', { class: 'pc-sub' }, `${focus.name} · ${priceWord(L)} · ${fmtDate(L.retrievedAt)}`, L.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null),
      focus.points.length >= 2 ? h('div', { class: 'pc-diff muted' }, `${d > 0 ? `+${money(d, cur)}` : d < 0 ? `−${money(-d, cur)}` : 'No change'} since ${fmtDate(F.retrievedAt)} (${focus.points.length} seen on ${focus.name})`) : null].filter(Boolean));
  }
  head.append(h('div', { class: 'seg pc-range', role: 'group', 'aria-label': 'Range' }, PRICE_RANGES.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': range === v ? 'true' : 'false', onclick: () => { if (o.onRange) o.onRange(v); } }, l))),
    h('div', { class: 'muted pc-count' }, `${all.length} observation${all.length === 1 ? '' : 's'} in this range`));

  const draw = (W) => {
    const svg = svgEl('svg', { class: 'pc-svg', viewBox: `0 0 ${W} ${H}`, width: '100%', height: String(H), preserveAspectRatio: 'xMinYMin meet', role: 'img', 'aria-label': `${cur} prices seen over time, one line per platform` });
    const amounts = all.map((p) => p.amount);
    const lo0 = Math.min(...amounts), hi0 = Math.max(...amounts);
    const step = niceStep((hi0 - lo0) / 2, cur);
    let lo = Math.floor(lo0 / step) * step, hi = Math.ceil(hi0 / step) * step;
    if (hi === lo) { hi = lo + step; lo = Math.max(0, lo - step); }
    const ticks = [lo, (lo + hi) / 2, hi];
    const labels = ticks.map((v) => money(v, cur));
    // Wide: amounts in a left gutter. Narrow (a phone's half-width side): amounts sit inside the plot, just above their gridline.
    const narrow = W < 220;
    const gutter = narrow ? 0 : Math.min(84, 8 + Math.max(...labels.map((l) => l.length)) * 6.4);
    const x0 = narrow ? 4 : gutter + 6, x1 = W - right, y0 = top, y1 = H - bottom;
    const days = all.map((p) => dayOf(p.retrievedAt));
    const tEnd = Math.max(dayOf(today), ...days);
    let tStart = from === null ? Math.min(...days) : from;
    if (tEnd - tStart < 7) tStart = tEnd - 7;
    const X = (iso) => x0 + ((dayOf(iso) - tStart) / (tEnd - tStart)) * (x1 - x0);
    const Y = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
    ticks.forEach((v, i) => svg.append(
      svgEl('line', { class: 'pc-grid', x1: gutter, x2: x1, y1: Y(v), y2: Y(v) }),
      narrow ? svgEl('text', { class: 'pc-axis small', x: 2, y: Y(v) - 3 }, labels[i])
        : svgEl('text', { class: 'pc-axis', x: gutter - 4, y: Y(v) + 4, 'text-anchor': 'end' }, labels[i])));
    svg.append(svgEl('text', { class: 'pc-axis', x: x0, y: H - 6 }, fmtDate(isoOfDay(tStart))),
      svgEl('text', { class: 'pc-axis', x: x1, y: H - 6, 'text-anchor': 'end' }, fmtDate(isoOfDay(tEnd))));
    // Like an exchange chart: a soft area under the highlighted platform's line (its own seen points only, nothing filled in between days it was not seen).
    if (focus && focus.points.length >= 2) {
      const gid = `pcg${++PC_SEQ}`;
      svg.append(svgEl('defs', null, svgEl('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' },
        svgEl('stop', { class: 'pc-stop-top', offset: '0%' }), svgEl('stop', { class: 'pc-stop-bottom', offset: '100%' }))));
      const pts = focus.points.map((p) => `${X(p.retrievedAt).toFixed(1)},${Y(p.amount).toFixed(1)}`);
      const first = focus.points[0], lastP = focus.points[focus.points.length - 1];
      svg.append(svgEl('polygon', { class: 'pc-area', fill: `url(#${gid})`, points: [`${X(first.retrievedAt).toFixed(1)},${y1}`, ...pts, `${X(lastP.retrievedAt).toFixed(1)},${y1}`].join(' ') }));
    }
    // Faded platforms first, the highlighted one on top.
    for (const s of [...shown.filter((s) => s !== focus), focus]) {
      const cls = s === focus ? 'is-focus' : 'is-other';
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1], b = s.points[i];
        svg.append(svgEl('line', { class: `pc-seg ${cls}${a.source === 'sample' || b.source === 'sample' ? ' is-sample' : ''}`, x1: X(a.retrievedAt), y1: Y(a.amount), x2: X(b.retrievedAt), y2: Y(b.amount) }));
      }
      for (const p of s.points) {
        const picked = o.selectedPoint === p.evidenceId;
        const pick = () => { if (o.onPick) o.onPick(p, s); };
        svg.append(svgEl('g', { class: 'pc-pt', role: 'button', tabindex: '0', 'data-evidence': p.evidenceId, 'aria-pressed': picked ? 'true' : 'false',
          'aria-label': `${money(p.amount, cur)} ${priceWord(p)} on ${s.name}, ${p.retrievedAt}${p.source === 'sample' ? ', sample' : ''}`,
          onclick: pick, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
          svgEl('circle', { class: 'pc-hit', cx: X(p.retrievedAt), cy: Y(p.amount), r: 13 }),
          svgEl('circle', { class: `pc-dot ${cls} ${p.priceType === 'ASK' ? 'ask' : 'trade'}${p.source === 'sample' ? ' is-sample' : ''}${picked ? ' is-picked' : ''}`, cx: X(p.retrievedAt), cy: Y(p.amount), r: picked ? 6 : s === focus ? 4.5 : 3.5 })));
      }
    }
    // The latest price seen on the highlighted platform, marked like a market's last trade (a soft halo; still while reduced motion is on).
    if (focus) { const L = last(focus); svg.append(svgEl('circle', { class: 'pc-now', cx: X(L.retrievedAt), cy: Y(L.amount), r: 9, 'aria-hidden': 'true' })); }
    return svg;
  };

  const key = (s) => svgEl('svg', { class: 'pc-key-svg', viewBox: '0 0 26 12', width: '26', height: '12', 'aria-hidden': 'true' },
    svgEl('line', { class: `pc-seg ${s === focus ? 'is-focus' : 'is-other'}${s.points.some((p) => p.source === 'sample') ? ' is-sample' : ''}`, x1: 1, y1: 6, x2: 25, y2: 6 }));
  const legend = shown.length ? h('div', { class: 'pc-legend' },
    shown.map((s) => h('span', { class: `pc-key${s === focus ? ' is-focus' : ''}` }, key(s), s.name, s.points.some((p) => p.source === 'sample') ? h('span', { class: 'chip sample' }, 'Sample') : null)),
    h('span', { class: 'muted' }, 'filled = traded · hollow = asking · dashed = sample row')) : null;
  const picked = o.selectedPoint ? all.find((p) => p.evidenceId === o.selectedPoint) : null;
  const readout = picked ? h('p', { class: 'pc-readout', role: 'status' },
    `${money(picked.amount, cur)} · ${priceWord(picked)} · ${MATCH_WORDS[picked.matchLevel] || picked.matchLevel} · ${picked.retrievedAt}`,
    picked.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null,
    picked.url ? h('a', { href: picked.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the listing') : null) : null;

  const wrap = h('div', { class: 'pchart', 'data-cur': cur }, head, all.length ? draw(360) : null, legend, readout);
  // Redraw at the real width once laid out (and on a turn of the phone), so the text stays at its CSS size. Deferred a frame: a redraw inside the callback would re-trigger it.
  if (all.length && typeof ResizeObserver === 'function') {
    let width = 360;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (!(w > 40) || Math.abs(w - width) < 4) return;
      width = w;
      requestAnimationFrame(() => { const old = wrap.querySelector('svg.pc-svg'); if (old && document.contains(wrap)) old.replaceWith(draw(w)); });
    }).observe(wrap);
  }
  return wrap;
}

function closetSwitchChip(activeOwner, ownerCount, targetOwnerWs = null) {
  const target = targetOwnerWs || activePersonalWs() || 'owner';
  if (!ownerCount && !activeOwner && !(ACCT && ACCT.signedIn)) return null;
  const go = (wantOwner) => {
    setPreferOwner(wantOwner);
    const u = new URL(location.href);
    if (wantOwner) u.searchParams.set('ws', target);
    else u.searchParams.set('ws', 'sample');
    location.assign(u.pathname + u.search);
  };
  return h('div', { class: 'seg closet-switch', role: 'group', 'aria-label': 'Closet source' },
    h('button', { type: 'button', 'aria-pressed': activeOwner ? 'true' : 'false', onclick: () => go(true) }, `Your closet${ownerCount ? ` (${ownerCount})` : ''}`),
    h('button', { type: 'button', 'aria-pressed': !activeOwner ? 'true' : 'false', onclick: () => go(false) }, 'Sample demo'));
}

async function closetWs() {
  const params = new URLSearchParams(location.search);
  const rawWs = params.get('ws');
  if (rawWs === 'sample') setPreferOwner(false);
  const savedPersonal = activePersonalWs();
  const defaultPersonal = savedPersonal || 'owner';
  const wantOwner = rawWs && rawWs !== 'sample' ? rawWs : (location.pathname !== '/' && (preferOwner() || (ACCT && ACCT.signedIn)) ? defaultPersonal : null);
  let ownerCount = 0;
  let switchTarget = defaultPersonal;
  if (location.pathname !== '/') {
    try {
      const checkId = savedPersonal || 'owner';
      const or = await fetch(`/api/ws/${encodeURIComponent(checkId)}/view`, { headers: authHeaders() });
      if (or.ok) {
        const ov = await or.json();
        switchTarget = checkId;
        ownerCount = (ov.items || []).filter((i) => !i.sample).length;
        if (wantOwner === checkId && (rawWs === checkId || ownerCount > 0 || (ACCT && ACCT.signedIn && checkId === ACCT.workspaceId))) {
          const own = await getJson(`/api/ws/${encodeURIComponent(checkId)}/photos`).catch(() => ({ photos: [] }));
          for (const p of own.photos || []) {
            if (META.photos.some((q) => q.photoId === p.photoId)) continue;
            const b = await fetch(`/api/ws/${encodeURIComponent(checkId)}/photo/${p.photoId}`, { headers: authHeaders() });
            if (b.ok) META.photos.unshift({ photoId: p.photoId, title: 'Your photo', url: URL.createObjectURL(await b.blob()), w: p.w, h: p.h, count: 0, mine: true });
          }
          chrome([closetSwitchChip(true, ownerCount, checkId)].filter(Boolean));
          return { id: checkId, view: ov, owner: true };
        }
      }
    } catch {}
  }
  if (wantOwner) {
    const r = await fetch(`/api/ws/${encodeURIComponent(wantOwner)}/view`, { headers: authHeaders() });
    if (r.ok) {
      const ov = await r.json();
      const cnt = (ov.items || []).filter((i) => !i.sample).length;
      const own = await getJson(`/api/ws/${encodeURIComponent(wantOwner)}/photos`).catch(() => ({ photos: [] }));
      for (const p of own.photos || []) {
        if (META.photos.some((q) => q.photoId === p.photoId)) continue;
        const b = await fetch(`/api/ws/${encodeURIComponent(wantOwner)}/photo/${p.photoId}`, { headers: authHeaders() });
        if (b.ok) META.photos.unshift({ photoId: p.photoId, title: 'Your photo', url: URL.createObjectURL(await b.blob()), w: p.w, h: p.h, count: 0, mine: true });
      }
      chrome([closetSwitchChip(true, cnt, wantOwner)].filter(Boolean));
      return { id: wantOwner, view: ov, owner: true };
    }
  }
  if (location.pathname !== '/' && (ownerCount > 0 || (ACCT && ACCT.signedIn))) {
    chrome([...sampleChips(), closetSwitchChip(false, ownerCount, switchTarget)].filter(Boolean));
  }
  let id = null;
  try { id = localStorage.getItem('closer.closet'); } catch {}
  if (id) {
    const r = await fetch(`/api/ws/${id}/view`);
    if (r.ok) return { id, view: await r.json() };
  }
  const s = await postJson('/api/closet/start', {});
  try { localStorage.setItem('closer.closet', s.workspaceId); } catch {}
  return { id: s.workspaceId, view: await getJson(`/api/ws/${s.workspaceId}/view`), fresh: true };
}

// ---------- asset board: the closet ledger at a glance (GET /api/ws/:id/ledger, engine/ledger.ts) ----------
/**
 * The owner's assets as counted numbers. Per currency ONE big number: the owner's total when they
 * entered a price, otherwise the sample total with its Sample chip; under it the pieces it covers and
 * the rule. Owner and sample totals are never added, and currencies are never converted.
 * opts: { title, sampleCloset (adds the demo chip), foot (a node under the board's last line) }.
 */
function assetBoard(L, opts = {}) {
  if (!L || L.ok === false || !Array.isArray(L.byCurrency)) return null;
  const pcs = (n) => `${n} piece${n === 1 ? '' : 's'}`;
  const title = opts.title || 'Your closet at a glance';
  const W = L.wear || { windowDays: 60, recentWear: 0, candidates: 0, tooFewRecords: 0, exempt: 0 };
  const wear = h('div', { class: 'asset-wear', id: 'asset-wear' },
    h('div', { class: 'asset-stats' }, [[W.recentWear, 'worn at least once'], [W.candidates, 'no confirmed wear'], [W.tooFewRecords, 'too few records'], [W.exempt, 'left out for now']]
      .map(([n, label]) => h('div', { class: 'asset-stat' }, h('b', null, String(n)), h('span', null, label)))),
    h('p', { class: 'asset-caption' }, `Last ${W.windowDays} days · counted from confirmed wear records · days without a record are unknown`));
  const board = (...kids) => h('section', { class: 'asset-board', id: 'asset-board', 'aria-label': title },
    h('div', { class: 'asset-hd' }, h('span', { class: 'asset-eyebrow' }, title),
      opts.sampleCloset ? h('span', { class: 'chip sample' }, 'Sample closet · demo') : null,
      h('span', { class: 'asset-pieces' }, `${pcs(L.pieces)} confirmed`)),
    ...kids, wear, opts.foot || null);
  if (!L.withEvidence) {
    return board(h('p', { class: 'asset-empty', id: 'asset-empty' }, 'No prices yet. Add one you saw on any piece.'),
      h('p', { class: 'asset-rule' }, `${pcs(L.pieces)} in the closet; a piece without a price is not counted as zero.`));
  }
  const curs = L.byCurrency.map((c) => {
    const own = c.owner.pieces > 0;
    const big = own ? c.owner : c.sample;
    return h('div', { class: 'asset-cur', 'data-currency': c.currency },
      h('div', { class: 'asset-line' },
        h('span', { class: 'asset-num' }, money(big.total, c.currency)),
        h('span', { class: 'asset-code' }, c.currency),
        own ? null : h('span', { class: 'chip sample' }, 'Sample')),
      h('p', { class: 'asset-rule' }, `latest price seen on ${big.pieces} of ${pcs(L.pieces)} · ${big.trade} traded, ${big.ask} asking`),
      own && c.sample.pieces
        ? h('p', { class: 'asset-side' }, h('span', { class: 'chip sample' }, 'Sample'), `${money(c.sample.total, c.currency)} at sample prices on ${pcs(c.sample.pieces)} · kept apart, never added to yours`)
        : null);
  });
  const without = L.pieces - L.withEvidence;
  const evidence = h('div', { class: 'asset-ev', id: 'asset-evidence' },
    h('div', { class: 'asset-meter', role: 'img', 'aria-label': `${L.withEvidence} of ${pcs(L.pieces)} with a price, ${without} without` },
      h('span', { class: 'asset-meter-on', style: `flex-grow:${L.withEvidence}` }),
      h('span', { class: 'asset-meter-off', style: `flex-grow:${without}` })),
    h('p', { class: 'asset-rule' }, `${L.withEvidence} of ${pcs(L.pieces)} ${L.withEvidence === 1 ? 'has' : 'have'} a price; ${without} ${without === 1 ? 'is' : 'are'} not counted as zero`,
      L.sampleOnly ? ` · ${L.sampleOnly} only from sample rows` : null));
  const net = h('p', { class: 'asset-net', id: 'asset-net' }, h('span', { class: 'asset-k' }, 'Net'), (L.lines && L.lines.net) || '');
  return board(h('div', { class: 'asset-curs' }, curs),
    h('p', { class: 'asset-caption' }, 'Each currency stands alone · nothing converted · asking prices are not sales'),
    evidence, net);
}

/** One tab bar on every page (shown on phones, where the top nav is hidden). */
function tabbar() {
  const tabs = [['/try', 'Photo'], ['/closet', 'My closet'], ['/today', 'Today'], ['/discover', 'Discover']]; // the flow: one photo first
  const on = (href) => (href === '/closet' ? location.pathname.startsWith('/closet') : location.pathname === href);
  return h('nav', { class: 'tabbar', 'aria-label': 'Sections' }, tabs.map(([href, label]) => h('a', { href, class: on(href) ? 'on' : null, 'aria-current': on(href) ? 'page' : null }, label)));
}

/** One merged chip for the sample closet pages (the owner's real wardrobe shows none). */
function sampleChips() {
  return [h('span', { class: 'chip sample' }, 'Sample closet · synthetic wear history · demo')];
}

function tile(it, opts = {}) {
  const hasCut = !!(it && opts.cuts && opts.cuts[it.itemId]);
  return h('div', { class: `cell${opts.changed ? ' changed' : ''}${opts.empty ? ' empty' : ''}` },
    h('div', { class: 'cell-hd' },
      h('span', { class: 'cell-slot' }, opts.label || (it && it.slot) || ''),
      opts.badge ? h('span', { class: 'cell-pill' }, opts.badge) : hasCut ? h('span', { class: 'cell-dot', title: 'Colour from your photo' }) : null),
    it ? thumb(it, opts.cuts || null, { flatlay: true }) : h('span', { class: 'muted' }, '—'),
    h('span', { class: 'lbl' }, it ? `${it.itemId} · ${itemName(it)}` : `no ${opts.label || 'piece'}`));
}

async function todayScreen(view) {
  chrome(sampleChips());
  const { id, view: v, owner } = await closetWs();
  const wsParam = owner ? id : null;
  const params = new URLSearchParams(location.search);
  const known = new Set(v.items.map((i) => i.itemId));
  // ?lock=J1,B2 comes from Discover, My closet, the keep-or-let-go question and the 3D tray: only pieces of this closet count.
  const wanted = (params.get('lock') || '').split(',').filter((x) => known.has(x));
  const S = { locks: new Set(wanted), direction: 'none', rain: false, op: null, msg: null, saved: null, picked: null, gridOpen: false, view: v };
  const byId = () => Object.fromEntries(S.view.items.map((i) => [i.itemId, i]));
  const root = h('div');
  view.append(
    h('div', { class: 'rail-head' },
      h('div', null, h('h1', null, 'What do you want to wear today?')),
      h('div', { class: 'row' },
        h('a', { class: 'btn small ghost', href: wsHref('/closet/3d', wsParam) }, '3D Boutique Rail →'),
        h('a', { class: 'btn small ghost', href: wsHref('/discover', wsParam) }, 'Match looks'))),
    h('p', { class: 'lede' }, wanted.length ? `Keeping ${wanted.join(' + ')}; Closer completes the rest from available pieces.` : 'Anchor one or more pieces; Closer completes the outfit from your closet.'), root);

  /** Brings the answer on screen: the options, or the question Closer asks back. */
  function reveal() {
    const t = root.querySelector('.options, .question, .flash .chip.bad');
    const sec = t && t.closest('section.panel');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function run(keepMsg) {
    if (keepMsg !== true) S.msg = null;
    S.picked = null;
    S.gridOpen = false;
    S.op = await postJson(`/api/ws/${id}/anchor`, { anchorItemIds: [...S.locks], direction: S.direction, rainPct: S.rain ? 80 : null });
    render();
    reveal();
  }
  async function say(sentence) {
    S.msg = null;
    S.saved = null;
    S.picked = null;
    S.gridOpen = false;
    S.op = await postJson(`/api/ws/${id}/say`, { sentence });
    if (S.op && S.op.intent) {
      S.locks = new Set(S.op.intent.anchors);
      S.direction = S.op.intent.direction;
      S.rain = S.op.intent.rain;
    }
    render();
    reveal();
  }
  async function pick(i) {
    const before = S.view.revision;
    const r = await saveFlow(id, 'lock', { eventId: uuid(), expectedRevision: before, operationId: S.op.operationId, optionIndex: i },
      (vv) => vv.plans.some((p) => p.planId === S.op.planId && p.state === 'LOCKED' && sameOutfit(p.slots, S.op.options[i].outfit)), META.labels.selectionSaved);
    if (r.view) S.view = r.view;
    S.saved = r.ok ? S.op.options[i].outfit : null;
    S.picked = r.ok ? i : null;
    S.planId = r.ok ? S.op.planId : null;
    S.worn = false;
    S.msg = h('span', { class: `chip ${r.cls}` }, r.chip);
    render();
  }
  async function wore() {
    const planId = S.planId;
    const r = await saveFlow(id, 'wear', { eventId: uuid(), expectedRevision: S.view.revision, planId },
      (vv) => vv.wearRows.some((w) => w.planId === planId), META.labels.wearSaved);
    if (r.view) S.view = r.view;
    S.worn = r.ok;
    S.msg = h('span', { class: `chip ${r.cls}` }, r.chip);
    render();
  }
  async function notToday() {
    const planId = S.planId;
    const r = await saveFlow(id, 'unlock', { eventId: uuid(), expectedRevision: S.view.revision, planId },
      (vv) => vv.plans.some((p) => p.planId === planId && p.state === 'PROPOSED'), 'Kept as an idea · no wear recorded');
    if (r.view) S.view = r.view;
    if (r.ok) { S.saved = null; S.planId = null; }
    S.msg = h('span', { class: `chip ${r.cls}` }, r.chip);
    render();
  }
  async function laundry(itemId) {
    const r = await postJson(`/api/ws/${id}/availability`, { eventId: uuid(), expectedRevision: S.view.revision, itemId, state: 'LAUNDRY' });
    S.view = await getJson(`/api/ws/${id}/view`);
    if (!r.ok) { S.msg = errChip(r); render(); return; }
    S.msg = h('span', { class: 'chip warn' }, `${itemId} is in the laundry now. Your kept pieces stay; the rest is re-planned.`);
    S.saved = null;
    await run(true);
  }

  function render() {
    const items = byId();
    const cuts = cutMap(S.view);
    const grid = h('div', { class: 'wardrobe' }, S.view.items.map((it) => {
      const on = S.locks.has(it.itemId);
      const avail = it.availability;
      return h('button', { type: 'button', class: `item pickable${on ? ' locked' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => { on ? S.locks.delete(it.itemId) : S.locks.add(it.itemId); S.op = null; S.saved = null; render(); } },
        h('div', { class: 'thumb' }, thumb(it, cuts)),
        h('div', { class: 'meta' }, h('b', null, `${it.itemId} · ${itemName(it)}`), h('span', null, FORMALITY_LABEL[it.formality] || it.formality),
          avail !== 'AVAILABLE' ? h('span', { class: 'chip warn' }, avail.toLowerCase()) : null,
          on ? h('span', { class: 'chip accent' }, 'Keep this today') : null));
    }));
    const dir = h('div', { class: 'seg', role: 'group', 'aria-label': 'Direction' }, [['none', 'As it is'], ['less_formal', 'More relaxed'], ['more_formal', 'Dressier']].map(([k, l]) =>
      h('button', { type: 'button', 'aria-pressed': S.direction === k ? 'true' : 'false', onclick: () => { S.direction = k; render(); } }, l)));
    const rain = h('label', { class: 'row muted' }, h('input', { type: 'checkbox', id: 'rain', checked: S.rain ? true : null, onchange: (e) => { S.rain = e.target.checked; render(); } }), 'Rain likely today (you tell Closer; no weather service)');
    const box = h('textarea', { id: 'say', rows: '2', class: 'draft', 'aria-label': 'What you want to wear today', placeholder: 'Keep the navy jacket, make the rest more relaxed' });
    // Example sentences: English first on screen (order only; the server list is unchanged).
    const examples = [...(META.intentChips || [])].sort((a, b) => Number(/^[A-Za-z]/.test(b)) - Number(/^[A-Za-z]/.test(a)));
    const DIR_WORD = { less_formal: 'more relaxed', more_formal: 'dressier' };
    const SERVER_LABEL = { 'Sentence read by keyword rules (mock)': 'Mock mode: read with keyword rules, not the model', 'Reason by code': 'reasons written by code' };
    const labelLine = (op) => (op.labels || []).map((l) => SERVER_LABEL[l] || l).join(' · ');
    const sayPanel = h('section', { class: 'panel' }, h('h2', null, 'Tell Closer what you want today'),
      h('div', { class: 'chip-row' }, examples.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => say(c) }, c))),
      h('div', { class: 'say-bar' },
        box,
        h('button', { class: 'btn', type: 'button', id: 'say-go', onclick: () => box.value.trim() && say(box.value) }, 'Go')),
      S.op && S.op.intent ? h('div', { class: 'row' }, h('span', { class: 'chip accent' }, `Understood: keep ${S.op.intent.anchors.map((x) => `${x} · ${itemName(items[x])}`).join(' + ')}${DIR_WORD[S.op.intent.direction] ? ` · ${DIR_WORD[S.op.intent.direction]}` : ''}${S.op.intent.rain ? ' · rain' : ''}`)) : null,
      S.op && (S.op.callLines || []).length ? h('div', { class: 'chip-row', id: 'say-calls' }, callChips(S.op)) : null,
      S.op && (S.op.callLines || []).length ? h('ul', { class: 'calls' }, S.op.callLines.map((l) => h('li', null, l))) : null,
      S.op && (S.op.labels || []).length ? h('p', { class: 'muted' }, labelLine(S.op)) : null);
    // The answer comes right after the sentence panel; the 12-piece grid folds away once there is one (it reopens when you tap it or a piece).
    const flashAt = (where) => (S.msg && where === (S.picked !== null && S.saved ? 'option' : 'top') ? h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, S.msg) : null);
    const parts = [sayPanel];
    if (S.op) {
      const op = S.op;
      if (op.ok === false) parts.push(h('section', { class: 'panel' }, h('div', { class: 'flash' }, errChip(op))));
      else if (op.state === 'HOLD') {
        const q = op.questions[0];
        parts.push(h('section', { class: 'panel' }, h('h2', null, 'Closer needs you'), h('p', { class: 'question' }, q ? q.text : op.detail),
          // Every answer the server offers is a button that does what it says.
          h('div', { class: 'row' }, (q ? q.choices : []).map((c) => {
            const b = (label, fn) => h('button', { class: 'btn small ghost', type: 'button', onclick: fn }, label);
            if (c === 'discover') return h('a', { class: 'btn ghost', href: wsHref('/discover', wsParam) }, 'Open Discover');
            if (items[c]) return b(`${c} · ${itemName(items[c])}`, () => { S.locks = new Set([c]); run(); });
            if (c === 'relax') return b('Drop the direction', () => { S.direction = 'none'; run(); });
            if (c === 'keep' && S.rain) return b('Keep it anyway', () => { S.rain = false; run(); });
            if (c === 'switch') return b('Switch it', () => { for (const x of q.itemIds) S.locks.delete(x); S.op = null; S.gridOpen = true; render(); });
            if (c === 'skip') return b('Not now', () => { S.op = null; S.gridOpen = true; render(); });
            return c === 'keep' ? null : h('span', { class: 'chip' }, c);
          }).filter(Boolean)), flashAt('top')));
      } else {
        parts.push(h('section', { class: 'panel' }, h('h2', null, `${op.options.length === 1 ? 'One outfit' : 'Two outfits'} with what you kept`),
          flashAt('top'),
          h('div', { class: `options cols-${Math.min(3, op.options.length)}` }, op.options.map((o, i) => h('div', { class: `option${S.picked === i ? ' picked' : ''}` }, h('h3', null, o.label),
            h('div', { class: 'flatlay' }, SLOTS.map((s) => tile(items[o.outfit[s]], { label: s, empty: !o.outfit[s], badge: S.locks.has(o.outfit[s]) ? 'kept' : null, cuts }))),
            h('ul', { class: 'reasons' }, o.reasonLines.map((l) => h('li', null, l))),
            S.picked === i ? h('span', { class: 'chip ok' }, 'Your pick for today') : h('button', { class: 'btn', type: 'button', onclick: () => pick(i) }, 'Wear this'),
            S.picked === i ? flashAt('option') : null))),
          h('p', { class: 'muted' }, labelLine(op))));
      }
    } else if (S.msg) parts.push(flashAt('top'));
    if (S.saved && !S.worn) {
      const loose = SLOTS.map((s) => S.saved[s]).filter((x) => x && !S.locks.has(x));
      parts.push(h('section', { class: 'panel' }, h('h2', null, 'Did you wear it?'),
        h('p', { class: 'muted' }, 'Only what you confirm counts as a wear. The 60-day review in My closet reads these records.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', id: 'wore', onclick: wore }, 'I wore this'),
          h('button', { class: 'btn ghost', type: 'button', id: 'not-today', onclick: notToday }, 'Not today'))));
      parts.push(h('section', { class: 'panel' }, h('h2', null, 'Something changed?'),
        h('div', { class: 'row' }, loose.map((x) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => laundry(x) }, `${x} is in the laundry`)))));
    }
    if (S.worn) parts.push(h('section', { class: 'panel' }, h('h2', null, 'Recorded'), h('p', null, 'This outfit now counts as worn today.'), h('a', { class: 'btn ghost', href: wsHref('/closet', wsParam) }, 'See My closet')));
    parts.push(h('details', { class: 'panel', id: 'pieces', open: !S.op || S.gridOpen ? true : null, ontoggle: (e) => { S.gridOpen = e.target.open; } },
      h('summary', null, `Or tap what you want to keep (${S.view.items.length} pieces)`), grid,
      h('h2', { style: 'margin-top:14px' }, 'Anything else?'), h('div', { class: 'row' }, dir), rain, h('div', { class: 'spacer' }),
      h('div', { class: 'cta' }, h('button', { class: 'btn', type: 'button', id: 'complete', disabled: S.locks.size === 0 ? true : null, onclick: () => run() }, S.locks.size ? `Keep ${[...S.locks].join(' + ')} and complete the rest` : 'Tap a piece to keep first'))));
    keepFocus(root, () => root.replaceChildren(...parts.filter(Boolean)));
  }
  render();
  if (wanted.length) await run();
}

async function closetScreen(view) {
  chrome(sampleChips());
  const { id, view: v, owner } = await closetWs();
  const wsParam = owner ? id : null;
  const cuts = cutMap(v);
  const S = { window: 60, candFilter: 'all', selected: new Set(), ledger: null, review: null, open: null, market: null, draft: null, msg: null, coverage: null, chartRange: {}, chartPick: null, items: Object.fromEntries(v.items.map((i) => [i.itemId, i])) };
  const root = h('div');
  const boardSlot = h('div', { id: 'asset-slot' });
  view.append(
    h('div', { class: 'rail-head' },
      h('div', null, h('h1', null, 'My closet')),
      h('div', { class: 'row' },
        h('a', { class: 'btn small', href: '/app' }, '+ Add from a photo'),
        viewSwitch('tidy', wsParam))),
    h('p', { class: 'lede' }, 'Pieces with no confirmed wear in your chosen window · days without a record stay unknown.'),
    boardSlot, root);
  /** The asset board above the review window, read again after every load, saved price and saved position. */
  async function paintBoard() {
    let L = null;
    try { L = await getJson(`/api/ws/${id}/ledger`); } catch { L = null; }
    S.ledger = L;
    boardSlot.replaceChildren(...[assetBoard(L), h('p', { class: 'asset-after' }, h('a', { class: 'btn small ghost', href: wsHref('/closet/3d', wsParam), id: 'see-3d' }, 'See it in 3D'))].filter(Boolean));
  }

  async function load() { [S.review, S.coverage] = await Promise.all([getJson(`/api/ws/${id}/review?window=${S.window}`), getJson(`/api/ws/${id}/coverage`), paintBoard()]); render(); }
  /** 'Price evidence on N of M pieces', counted on the server from the rows that exist; sample-only pieces are named apart. */
  function coverageChips() {
    const c = S.coverage;
    if (!c || c.ok === false) return null;
    return [h('span', { class: 'chip', id: 'coverage' }, c.line), c.sampleOnly ? h('span', { class: 'chip sample' }, `Sample · ${c.sampleOnly} of them only from sample rows`) : null];
  }
  async function act(itemId, action) {
    const r = await postJson(`/api/ws/${id}/reviewchoice`, { itemId, action });
    S.msg = r.ok === false ? errChip(r) : null;
    if (action === 'restyle') { location.href = wsHref('/today', wsParam, { lock: itemId }); return; }
    S.open = { itemId, action };
    S.draft = null;
    if (action === 'sell_review') { S.market = await getJson(`/api/ws/${id}/market/${itemId}`); S.calc = null; }
    if (action === 'donate_review') S.draft = await postJson(`/api/ws/${id}/draft`, { itemId, kind: 'DONATE' });
    await load();
  }
  async function keep(itemId) {
    const after = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const r = await postJson(`/api/ws/${id}/exempt`, { itemId, reason: 'season', reviewAfter: after });
    S.msg = r.ok === false ? errChip(r) : h('span', { class: 'chip ok' }, `Kept for the season · next look on ${fmtDate(r.reviewAfter)}`);
    S.open = null;
    await load();
  }

  /** One price chart per currency with a seen price (KRW, USD, EUR apart; never converted). Picking a point writes its amount into the price field. */
  function sellCharts() {
    if (!S.market) return null;
    const M = S.market;
    const curs = ['KRW', 'USD', 'EUR'].filter((c) => (M.series || []).some((s) => s.currency === c && s.count));
    if (!curs.length) return h('p', { class: 'muted', id: 'no-prices' }, 'No prices seen yet. Add one you saw.');
    return h('div', { class: 'charts' }, curs.map((c) => priceChart(M.series.filter((s) => s.currency === c), c, {
      selectedPlatform: S.calc ? S.calc.platform : 'KARROT', range: S.chartRange[c] || 'all', selectedPoint: S.chartPick, today: M.today,
      onRange: (r) => { S.chartRange[c] = r; render(); },
      onPick: (p, s) => {
        if (!S.calc) S.calc = { platform: s.platform, price: '', fees: newFees(s.platform), result: null };
        // A price is written only into a field of its own currency: the platform switches when the currencies differ.
        if (PLATFORM_CURRENCY[S.calc.platform] !== c) { S.calc.platform = s.platform; S.calc.fees = newFees(s.platform); S.calc.result = null; }
        S.chartPick = p.evidenceId;
        S.calc.price = String(p.amount);
        render();
      },
    })));
  }

  /** Platforms with a saved price first; the empty ones fold into one line and a closed details, so the first input is not eight cards down. */
  function priceCards() {
    if (!S.market) return null;
    const fmt = (e) => money(e.amount, e.currency);
    const card = (c) => h('div', { class: 'card' },
      h('div', { class: 'hd' }, c.info.name, h('span', { class: 'chip' }, c.info.currency)),
      h('div', { class: 'muted' }, c.info.region),
      c.entries.length ? h('ul', { class: 'reasons' }, c.entries.map((e) => h('li', null, `${fmt(e)} · ${e.priceType === 'ASK' ? 'asking' : 'traded'} · ${e.matchLevel.toLowerCase().replace('_', ' ')} · ${e.retrievedAt}`, e.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null)))
        : h('p', { class: 'muted' }, c.emptyLine),
      h('ul', { class: 'reasons muted' }, c.info.notes.map((n) => h('li', null, n))),
      h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
        const price = S.calc && S.calc.platform === c.platform && S.calc.result && S.calc.result.ok !== false ? S.calc.result.price : null;
        S.draft = await postJson(`/api/ws/${id}/draft`, { itemId: S.open.itemId, kind: 'SELL', platform: c.platform, price });
        render();
      } }, `Draft a ${c.info.name} listing`));
    const withPrices = S.market.cards.filter((c) => c.entries.length);
    const rest = S.market.cards.filter((c) => !c.entries.length);
    return h('div', { id: 'price-cards' },
      withPrices.length ? h('div', { class: 'grid cols-3' }, withPrices.map(card)) : null,
      rest.length ? h('p', { class: 'muted' }, `No prices saved yet for ${rest.map((c) => c.info.name).join(', ')}. Add one above.`) : null,
      rest.length ? h('details', { class: 'sub' }, h('summary', null, 'Platform notes and listing drafts'), h('div', { class: 'grid cols-3', style: 'margin-top:10px' }, rest.map(card))) : null);
  }

  // Fee line names to start from. Values stay blank (unknown) until the owner checks the platform's own page.
  const FEE_START = {
    KREAM: [['Sales fee', 'rate'], ['Inspection and shipping', 'fixed']],
    KARROT: [['Delivery or meeting cost', 'fixed']],
    BUNJANG: [['Payment or platform fee', 'rate'], ['Shipping', 'fixed']],
    MUSINSA_USED: [['Sales fee', 'rate'], ['Shipping', 'fixed']],
    POSHMARK: [['Platform fee', 'rate'], ['Shipping to the buyer', 'fixed']],
    EBAY: [['Final value fee', 'rate'], ['Shipping to the buyer', 'fixed']],
    GRAILED: [['Platform fee', 'rate'], ['Payment processing', 'rate'], ['Shipping', 'fixed']],
    DEPOP: [['Platform fee', 'rate'], ['Payment processing', 'rate'], ['Shipping', 'fixed']],
    STOCKX: [['Transaction fee', 'rate'], ['Payment processing', 'rate'], ['Shipping to the buyer', 'fixed']],
    VINTED: [['Seller fee, if your country has one', 'rate'], ['Shipping', 'fixed']],
  };
  const platformName = (p) => (PLATFORM_OPTIONS.find(([v]) => v === p) || [p, p])[1].replace(/ \((KRW|USD|EUR)\)$/, '');
  function newFees(platform) { return FEE_START[platform].map(([label, kind]) => ({ label, kind, value: '' })); }
  /** Cost lines as typed: blank stays null (not checked); a rate is typed in % and sent as a share. */
  function feeLines(fees) { return fees.map((f) => ({ label: f.label, kind: f.kind, value: f.value === '' ? null : f.kind === 'rate' ? Number(f.value) / 100 : Number(f.value) })); }
  function feeRows(fees, cur, onChange, compact) {
    return h('div', { class: 'feegrid' }, fees.map((f, i) => h('div', { class: 'feerow' },
      h('input', { type: 'text', 'aria-label': `Cost ${i + 1} name`, value: f.label, maxlength: '40', oninput: (e) => { f.label = e.target.value; } }),
      h('select', { 'aria-label': `Cost ${i + 1} kind`, onchange: (e) => { f.kind = e.target.value; onChange(); } }, h('option', { value: 'rate', selected: f.kind === 'rate' ? true : null }, compact ? '%' : '% of price'), h('option', { value: 'fixed', selected: f.kind === 'fixed' ? true : null }, compact ? cur : `fixed ${cur}`)),
      h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', 'aria-label': `Cost ${i + 1} value`, placeholder: compact ? 'not checked' : 'blank = not checked', value: f.value, oninput: (e) => { f.value = e.target.value; }, onchange: onChange }),
      h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `Remove cost ${i + 1}`, title: 'Remove this line', onclick: () => { fees.splice(i, 1); onChange(); } }, compact ? '×' : 'Remove'))));
  }
  /** Rows of a net result: price, each cost, each unchecked line, the net or "unknown". */
  function netRows(R, cur, priceLabel, netLabel) {
    return h('dl', { class: 'kv' },
      h('dt', null, priceLabel), h('dd', null, money(R.price, cur)),
      ...R.deductions.flatMap((d) => [h('dt', null, d.label), h('dd', null, `− ${money(d.amount, cur)}`)]),
      ...R.unknown.flatMap((u) => [h('dt', null, u), h('dd', null, h('span', { class: 'chip warn' }, 'not checked'))]),
      h('dt', null, netLabel), h('dd', null, R.net === null ? h('span', { class: 'chip warn' }, 'unknown') : h('b', null, money(R.net, cur))));
  }

  function calcPanel() {
    if (!S.calc) S.calc = { platform: 'KARROT', price: '', fees: newFees('KARROT'), result: null };
    const C = S.calc;
    const cur = PLATFORM_CURRENCY[C.platform];
    const card = S.market ? S.market.cards.find((c) => c.platform === C.platform) : null;
    const plat = h('select', { id: 'calc-platform', 'aria-label': 'Platform', onchange: (e) => { C.platform = e.target.value; C.fees = newFees(C.platform); C.result = null; render(); } },
      PLATFORM_OPTIONS.map(([v, l]) => h('option', { value: v, selected: C.platform === v ? true : null }, l)));
    const price = h('input', { id: 'calc-price', type: 'number', min: '1', step: 'any', inputmode: 'decimal', placeholder: `Price you would ask (${cur})`, 'aria-label': 'Price', value: C.price, oninput: (e) => { C.price = e.target.value; } });
    const pick = card && card.entries.length ? h('div', { class: 'chip-row' }, h('span', { class: 'muted' }, 'Use a price you saw:'),
      card.entries.slice(0, 4).map((e) => h('button', { type: 'button', class: 'chip', onclick: () => { C.price = String(e.amount); render(); } }, `${money(e.amount, e.currency)} · ${e.priceType === 'ASK' ? 'asking' : 'traded'}${e.source === 'sample' ? ' · sample' : ''}`))) : null;
    const rows = feeRows(C.fees, cur, () => { C.result = null; render(); });
    const calc = async () => {
      C.result = await postJson('/api/net', { price: Number(C.price), platform: C.platform, fees: feeLines(C.fees) });
      render();
    };
    const R = C.result;
    const out = !R ? null : R.ok === false ? h('p', { class: 'question', role: 'status' }, R.detail)
      : h('div', { class: 'netbox', role: 'status' },
        netRows(R, cur, 'Price', 'You would receive'),
        h('p', { class: 'muted' }, R.line),
        R.net !== null ? h('p', { class: 'muted' }, `A draft for ${platformName(C.platform)} will use this price.`) : null);
    return h('div', { class: 'calc' }, h('h2', { style: 'margin-top:14px' }, 'What would I receive?'),
      h('p', { class: 'muted' }, 'Fill in the costs from the platform\'s own page. A blank line keeps the result unknown; type 0 only if you checked it is free. No lines at all also means unknown.'),
      h('div', { class: 'row' }, plat, price), pick, rows,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { C.fees.push({ label: 'Other cost', kind: 'fixed', value: '' }); render(); } }, 'Add a cost line'),
        h('button', { type: 'button', class: 'btn small', id: 'calc-go', onclick: calc }, 'Calculate')),
      out);
  }

  // ---- Keep or let go: one question per piece, two sides of counted facts, a position saved as a snapshot ----
  const CHOICE_LABEL = { KEEP: 'Keep', WEAR_ONCE: 'Try wearing it once', SELL_PREPARE: 'Prepare to sell', DEFER: 'Decide later' };
  async function openDecide(itemId) {
    // key: one idempotency key per panel open; the server stores a key once, so a tap that repeats a save cannot add a second row.
    S.decide = { itemId, horizon: 90, view: null, market: null, range: 'all', pick: null, platform: 'KARROT', price: '', fees: newFees('KARROT'), net: null, uses: [], useLabel: '', useOn: '', fresh: true, links: null, linksBusy: false, key: uuid(), last: null, saving: false };
    await loadDecide();
    const el = document.getElementById('decide');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  async function loadDecide() {
    const D = S.decide;
    if (!D) return;
    const [v, m] = await Promise.all([getJson(`/api/ws/${id}/decide/${D.itemId}?horizon=${D.horizon}`), getJson(`/api/ws/${id}/market/${D.itemId}`)]);
    if (!v || v.ok === false) { S.msg = v ? errChip(v) : h('span', { class: 'chip bad' }, 'Could not load'); S.decide = null; render(); return; }
    D.view = v;
    D.market = m && m.ok !== false ? m : null;
    const last = v.history[0] || null;
    if (D.fresh) {
      // Start from the owner's last position on this piece: their own named uses, platform, asking price and cost lines as typed.
      D.fresh = false;
      if (v.keep.namedUses.length) D.uses = v.keep.namedUses.map((u) => ({ label: u.label, on: u.on }));
      if (last && last.sell && PLATFORM_CURRENCY[last.sell.platform]) {
        D.platform = last.sell.platform;
        D.horizon = last.keep.horizonDays;
        if (last.sell.scenario) {
          D.price = String(last.sell.askPrice);
          D.fees = last.sell.scenario.costs.map((c) => ({ label: c.label, kind: c.kind, value: c.value === null ? '' : String(c.kind === 'rate' ? Math.round(c.value * 10000) / 100 : c.value) }));
        } else D.fees = newFees(D.platform);
        if (D.horizon !== v.keep.horizonDays) { await loadDecide(); return; }
        if (Number(D.price) > 0) { await recalc(); return; }
      }
    }
    render();
  }
  async function recalc() {
    const D = S.decide;
    if (!D) return;
    const p = Number(D.price);
    D.net = p > 0 ? await postJson('/api/net', { price: p, platform: D.platform, fees: feeLines(D.fees) }) : null;
    render();
  }
  // Muse Wonder (or Spark, by the server's flag) searches for listings of this piece on the chosen platform. Only the links
  // come back to the screen: the owner opens one, reads the price there and enters it as evidence. No model text is shown live.
  async function findLinks() {
    const D = S.decide;
    if (!D || D.linksBusy) return;
    const it = S.items[D.itemId];
    D.linksBusy = true;
    D.links = null;
    render();
    const r = await postJson(`/api/ws/${id}/wonder`, {
      prompt: `Find current resale listings for a ${itemName(it)} on ${platformName(D.platform)}. Reply with the listing links only.`,
      webSearch: PLATFORM_CURRENCY[D.platform] === 'KRW' ? { userLocation: { country: 'KR' } } : true,
      reasoning: 'low', maxOutputTokens: 600,
    });
    D.linksBusy = false;
    D.links = r.ok === false ? { error: r } : { items: r.links || [], mode: r.mode, text: r.mode === 'mock' ? r.result.text : null, chips: r.liveChips || [] };
    render();
  }
  function linksBox(D) {
    if (!D.links) return null;
    const L = D.links;
    if (L.error) return h('div', { class: 'linksbox' }, errChip(L.error));
    return h('div', { class: 'linksbox', role: 'status' },
      L.mode === 'mock' ? h('p', { class: 'muted' }, L.text) : h('p', { class: 'muted' }, L.items.length ? `${L.items.length} link${L.items.length === 1 ? '' : 's'} from the search. Open one, read the price there, and enter it as evidence yourself.` : 'The search returned no listing link. Nothing was invented in its place.'),
      L.items.length ? h('ul', { class: 'reasons' }, L.items.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.title || l.url), ` · ${l.platformName}`, l.cited ? h('span', { class: 'chip' }, 'cited') : null))) : null,
      L.chips.length ? h('div', { class: 'chip-row' }, L.chips.map((c) => h('span', { class: 'chip ok' }, c))) : null);
  }
  async function takePosition(choice) {
    const D = S.decide;
    if (!D || D.saving) return;
    const p = Number(D.price);
    const body = { itemId: D.itemId, choice, horizonDays: D.horizon, platform: D.platform, askPrice: p > 0 ? p : null, fees: feeLines(D.fees), namedUses: D.uses, note: null };
    // The same position tapped again (same choice and inputs) goes out under the key it was saved with, so the server answers
    // "already saved" instead of adding a row; anything different goes out under the fresh key drawn after the last save.
    const same = JSON.stringify(body);
    const key = D.last && D.last.same === same ? D.last.key : D.key;
    D.saving = true;
    render();
    let r;
    try {
      r = await postJson(`/api/ws/${id}/decide`, { ...body, clientKey: key });
    } catch {
      r = { ok: false, code: 'SAVE_UNCONFIRMED', detail: 'No reply from the server. Tap once more: the same key cannot save twice.' };
    }
    D.saving = false;
    if (r.ok === false) { S.msg = errChip(r); render(); return; }
    D.last = { same, key };
    D.key = uuid();
    if (choice === 'WEAR_ONCE') { location.href = wsHref('/today', wsParam, { lock: D.itemId }); return; }
    if (choice === 'SELL_PREPARE') {
      await act(D.itemId, 'sell_review');
      S.calc = { platform: D.platform, price: D.price, fees: D.fees.map((f) => ({ ...f })), result: D.net && D.net.ok !== false ? D.net : null };
    }
    S.msg = r.duplicate ? h('span', { class: 'chip' }, `Already saved · ${r.decision.decisionId}`) : h('span', { class: 'chip ok' }, `Saved and read back · ${CHOICE_LABEL[choice]} · ${r.decision.decisionId}`);
    paintBoard();
    await loadDecide();
  }
  function decidePanel() {
    const D = S.decide;
    if (!D || !D.view) return null;
    const V = D.view;
    const K = V.keep;
    const cur = PLATFORM_CURRENCY[D.platform];
    const it = S.items[D.itemId];
    const cut = cuts[D.itemId] || null;
    const tag = S.ledger && S.ledger.tags ? S.ledger.tags[D.itemId] : null;
    const hero = it ? h('div', { class: 'decide-hero' },
      h('div', { class: 'decide-frames' },
        cut ? h('div', { class: 'decide-frame' }, contextCutCanvas(cut), h('span', null, 'Your photo')) : null,
        h('div', { class: 'decide-frame' }, sampleMediaNode(it, 0, cut), h('span', null, 'Studio drape'))),
      h('div', { class: 'decide-meta' },
        h('div', { class: 'chip-row', style: 'margin:0' },
          h('span', { class: 'chip' }, `${it.slot} · ${FORMALITY_LABEL[it.formality] || it.formality}`),
          h('span', { class: `chip${it.availability === 'AVAILABLE' ? '' : ' warn'}` }, (it.availability || 'AVAILABLE').toLowerCase()),
          tag ? h('span', { class: 'chip accent' }, `${money(tag.amount, tag.currency)}${tag.source === 'sample' ? ' · sample' : ''}`) : null),
        h('div', { class: 'row' },
          h('a', { class: 'btn small ghost', href: wsHref('/today', wsParam, { lock: D.itemId }) }, 'Wear today →'),
          h('a', { class: 'btn small ghost', href: wsHref('/closet/3d', wsParam) }, 'View on 3D rail')))) : null;
    const hz = h('div', { class: 'seg', role: 'group', 'aria-label': 'Horizon' }, V.horizons.map((d) => h('button', { type: 'button', 'aria-pressed': D.horizon === d ? 'true' : 'false', onclick: () => { D.horizon = d; loadDecide(); } }, `${d} days`)));
    // Keep side: counts only. The outlook stays "not computed" because there is no counted basis for a forward number.
    const useForm = h('div', { class: 'row' },
      h('input', { id: 'dc-use', type: 'text', maxlength: '40', placeholder: 'e.g. wedding, trip', 'aria-label': 'Upcoming use', value: D.useLabel, oninput: (e) => { D.useLabel = e.target.value; } }),
      h('input', { id: 'dc-use-on', type: 'date', 'aria-label': 'Date, optional', value: D.useOn, min: V.today, oninput: (e) => { D.useOn = e.target.value; } }),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { const l = D.useLabel.trim(); if (!l || D.uses.length >= 5) return; D.uses.push({ label: l, on: D.useOn || null }); D.useLabel = ''; D.useOn = ''; render(); } }, 'Add'));
    const keep = h('div', { class: 'card side' },
      h('div', { class: 'hd' }, 'If I keep it'),
      h('ul', { class: 'reasons' },
        h('li', null, h('b', null, `${K.wearsCounted} confirmed wear${K.wearsCounted === 1 ? '' : 's'}`), ` in the last ${K.windowDays} days`),
        h('li', null, `Any wear recorded on ${K.recordedDays} of ${K.trackedDays} tracked days · ${K.unrecordedDays} days unknown`),
        h('li', null, K.lastConfirmedWear ? `Last confirmed wear ${K.lastConfirmedWear} · ${K.daysSinceLastWear} days ago` : 'No confirmed wear on record')),
      h('p', { class: 'lbl' }, `Upcoming uses I can name (${D.uses.length})`),
      D.uses.length ? h('div', { class: 'chip-row' }, D.uses.map((u, i) => h('button', { type: 'button', class: 'chip', title: 'Remove', onclick: () => { D.uses.splice(i, 1); render(); } }, `${u.label}${u.on ? ` · ${u.on}` : ''} ×`))) : null,
      D.uses.length < 5 ? useForm : null,
      h('div', { class: 'outlook' }, h('span', { class: 'chip warn' }, 'Wear outlook: not computed'), h('p', { class: 'muted' }, K.wearOutlook.line)),
      K.missing.length ? h('p', { class: 'muted' }, 'Still unknown: ', K.missing.join(' · ')) : null);
    // Sell side: an asking price the owner picks (assumed, not offered), prices seen on one platform, costs with their status, a conditional net.
    const ev = V.evidence.find((e) => e.platform === D.platform);
    const lo = Math.min(...[ev.owner.min, ev.sample.min].filter((x) => x !== null));
    const hi = Math.max(...[ev.owner.max, ev.sample.max].filter((x) => x !== null));
    const hasRange = Number.isFinite(lo) && Number.isFinite(hi);
    const step = cur === 'KRW' ? 1000 : 1;
    const rmin = hasRange ? Math.max(step, Math.floor((lo / 2) / step) * step) : 0;
    const rmax = hasRange ? Math.ceil((hi * 1.5) / step) * step : 0;
    const plat = h('select', { id: 'dc-platform', 'aria-label': 'Platform', onchange: (e) => { D.platform = e.target.value; D.fees = newFees(D.platform); D.price = ''; D.net = null; D.links = null; render(); } },
      PLATFORM_OPTIONS.map(([v, l]) => h('option', { value: v, selected: D.platform === v ? true : null }, l)));
    const num = h('input', { id: 'dc-price', type: 'number', min: '1', step: 'any', inputmode: 'decimal', placeholder: `Asking price to test (${cur})`, 'aria-label': 'Asking price', value: D.price, oninput: (e) => { D.price = e.target.value; if (range) range.value = e.target.value; }, onchange: recalc });
    const range = hasRange ? h('input', { id: 'dc-range', type: 'range', min: String(rmin), max: String(rmax), step: String(step), 'aria-label': 'Asking price slider', value: D.price || String(Math.round(lo / step) * step), oninput: (e) => { D.price = e.target.value; num.value = e.target.value; }, onchange: recalc }) : null;
    const seen = h('p', { class: 'muted' }, ev.line, hasRange ? ` Seen: ${lo === hi ? money(lo, cur) : `${money(lo, cur)}–${money(hi, cur)}`}. ` : ' ', ev.sample.count ? h('span', { class: 'chip sample' }, 'Sample') : null);
    // Prices over time in this platform's currency: its line highlighted, other platforms of the same currency faded. A tapped point fills the asking price.
    const curSeries = D.market ? (D.market.series || []).filter((s) => s.currency === cur && s.count) : [];
    const chart = curSeries.length ? priceChart(curSeries, cur, {
      selectedPlatform: D.platform, range: D.range, selectedPoint: D.pick, today: V.today,
      onRange: (r) => { D.range = r; render(); },
      onPick: (p) => { D.pick = p.evidenceId; D.price = String(p.amount); recalc(); },
    }) : null;
    const N = D.net && D.net.ok !== false ? D.net : null;
    const netbox = h('div', { class: 'netbox', role: 'status' },
      N ? netRows(N, cur, 'Asking price (assumed)', 'I would receive') : h('dl', { class: 'kv' }, h('dt', null, 'Asking price'), h('dd', null, h('span', { class: 'chip warn' }, 'not set')), h('dt', null, 'I would receive'), h('dd', null, h('span', { class: 'chip warn' }, 'unknown'))),
      h('p', { class: 'muted' }, N ? N.line : D.net && D.net.ok === false ? D.net.detail : 'Pick a price to test. The net stays unknown until every cost line is checked.'));
    const sell = h('div', { class: 'card side' },
      h('div', { class: 'hd' }, 'If I prepare to sell'),
      plat, seen,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small ghost', disabled: D.linksBusy ? true : null, onclick: findLinks }, D.linksBusy ? 'Asking the model…' : 'Find listings with Wonder')),
      linksBox(D),
      range, num,
      h('p', { class: 'lbl' }, 'Costs on this platform · blank = not checked, 0 = checked and free'),
      feeRows(D.fees, cur, recalc, true),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { D.fees.push({ label: 'Other cost', kind: 'fixed', value: '' }); render(); } }, 'Add a cost line'),
      netbox);
    // The four positions are off while a save is in flight, so a second tap cannot start a second save.
    const busy = D.saving ? true : null;
    const pos = h('div', { class: 'row actions', 'aria-busy': D.saving ? 'true' : null },
      h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => takePosition('KEEP') }, 'Keep'),
      h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => takePosition('WEAR_ONCE') }, 'Try wearing it once'),
      h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => takePosition('SELL_PREPARE') }, 'Prepare to sell'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: busy, onclick: () => takePosition('DEFER') }, 'Decide later'));
    const hist = V.history.length ? h('div', null, h('h3', null, `Positions taken (${V.history.length})`),
      h('ul', { class: 'reasons' }, V.history.map((d) => h('li', null,
        h('b', null, `${d.at.slice(0, 10)} · ${CHOICE_LABEL[d.choice] || d.choice}`),
        ` · ${d.keep.horizonDays} days · ${d.sell.askPrice !== null ? `${money(d.sell.askPrice, d.sell.currency)} on ${d.sell.evidence.name}` : 'no price tested'} · ${d.sell.scenario && d.sell.scenario.net !== null ? `net ${money(d.sell.scenario.net, d.sell.currency)}` : 'net unknown'}`,
        h('br'), h('span', { class: 'muted' }, d.outcome.line),
        // Counted facts that moved since this snapshot (its own horizon and platform); nothing is shown when none did.
        d.recheck && d.recheck.needed ? [h('br'), h('span', { class: 'chip warn', 'data-recheck': d.decisionId }, `Facts moved: ${d.recheck.changed.join(' · ')}`)] : null)))) : null;
    return h('section', { class: 'panel decide', id: 'decide' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, `Keep or let go? · ${D.itemId} · ${itemName(S.items[D.itemId])}`), h('button', { type: 'button', class: 'btn small ghost', onclick: () => { S.decide = null; render(); } }, 'Close')),
      hero,
      h('p', { class: 'ask' }, K.question), hz,
      // The market view of this piece, full width like an exchange chart: prices seen over time in the sell side's currency.
      chart ? h('div', { class: 'decide-chart' }, h('p', { class: 'lbl' }, `Prices seen over time · ${cur} · ${platformName(D.platform)} highlighted`), chart) : null,
      h('div', { class: 'grid cols-2 sides' }, keep, sell),
      pos, hist,
      h('p', { class: 'muted' }, V.note));
  }

  function evidenceForm() {
    const f = (id, el) => { el.id = id; return el; };
    const plat = f('ev-platform', h('select', { 'aria-label': 'Platform' }, PLATFORM_OPTIONS.map(([v, l]) => h('option', { value: v }, l))));
    const type = f('ev-type', h('select', { 'aria-label': 'Price type' }, h('option', { value: 'ASK' }, 'Asking price'), h('option', { value: 'TRADE' }, 'Traded price')));
    const match = f('ev-match', h('select', { 'aria-label': 'Match' }, h('option', { value: 'SIMILAR' }, 'Similar item'), h('option', { value: 'SAME_ITEM' }, 'Same item'), h('option', { value: 'UNVERIFIED' }, 'Not sure')));
    const amount = f('ev-amount', h('input', { type: 'number', min: '1', step: 'any', placeholder: 'Amount', 'aria-label': 'Amount' }));
    const link = f('ev-link', h('input', { type: 'url', placeholder: 'https:// link (optional)', 'aria-label': 'Link' }));
    const add = async () => {
      const cur = PLATFORM_CURRENCY[plat.value];
      const r = await postJson(`/api/ws/${id}/evidence`, { itemId: S.open.itemId, platform: plat.value, priceType: type.value, amount: Number(amount.value), currency: cur, url: link.value || null, retrievedAt: new Date().toISOString().slice(0, 10), matchLevel: match.value });
      S.msg = r.ok === false ? errChip(r, 'bad', 'evidence') : h('span', { class: 'chip ok', 'data-at': 'evidence' }, 'Price saved and read back');
      [S.market, S.coverage] = await Promise.all([getJson(`/api/ws/${id}/market/${S.open.itemId}`), getJson(`/api/ws/${id}/coverage`), paintBoard()]);
      if (S.decide && S.decide.itemId === S.open.itemId) S.decide.market = S.market;
      render();
    };
    // The result of "Save price" shows next to the button, not at the end of the page.
    return h('div', null, h('h2', { style: 'margin-top:14px' }, 'Add a price you saw'), h('div', { class: 'evform' }, plat, type, match, amount, link, h('button', { class: 'btn small', type: 'button', onclick: add }, 'Save price')),
      S.msg && S.msg.dataset.at === 'evidence' ? h('div', { class: 'flash', role: 'status' }, S.msg) : null);
  }

  function draftPanel() {
    const d = S.draft;
    if (!d) return null;
    if (d.ok === false) return errChip(d);
    const ta = h('textarea', { id: 'draft-body', rows: '7', class: 'draft' });
    ta.value = d.body;
    const move = async (to) => {
      const r = await postJson(`/api/ws/${id}/draftmove`, { draftId: d.draftId, to, body: ta.value });
      if (r.ok === false) S.msg = errChip(r, 'warn', 'draft');
      else { S.draft = r; S.msg = h('span', { class: 'chip ok', 'data-at': 'draft' }, r.state === 'REVIEWED' ? 'Reviewed and read back' : 'Marked done by you'); }
      render();
    };
    return h('section', { class: 'panel' }, h('h2', null, d.kind === 'SELL' ? `Listing draft · ${d.platform}` : 'Donation checklist'),
      h('div', { class: 'row' }, h('span', { class: 'chip' }, d.state.toLowerCase().replace(/_/g, ' ')), h('span', { class: 'muted' }, `Still to check: ${d.toCheck.join(', ')}`)),
      ta,
      h('div', { class: 'row' },
        d.state === 'DRAFT' ? h('button', { class: 'btn small', type: 'button', onclick: () => move('REVIEWED') }, 'I checked it') : null,
        d.state === 'REVIEWED' ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => move('OWNER_REPORTED_DONE') }, d.kind === 'SELL' ? 'I posted it myself' : 'I handed it over') : null,
        S.msg && S.msg.dataset.at === 'draft' ? S.msg : null),
      h('p', { class: 'muted' }, 'Copy the text into the platform yourself. Closer never posts, messages, books a pickup or records a sale.'));
  }

  function render() {
    const r = S.review;
    if (!r) { root.replaceChildren(h('p', { class: 'muted' }, 'Loading…')); return; }
    const win = h('div', { class: 'seg', role: 'group', 'aria-label': 'Window' }, [30, 60, 90].map((d) => h('button', { type: 'button', 'aria-pressed': S.window === d ? 'true' : 'false', onclick: () => { S.window = d; load(); } }, `${d} days`)));
    const allCands = r.rows.filter((x) => x.status === 'CANDIDATE');
    const tags = (S.ledger && S.ledger.tags) || {};
    const filterDefs = [
      ['all', `All (${allCands.length})`],
      ...(allCands.some((x) => x.seasonHint) ? [['season', 'Season hint']] : []),
      ...(allCands.some((x) => tags[x.itemId]) ? [['priced', 'With price']] : []),
      ...(allCands.some((x) => x.lastChoice) ? [['reviewed', 'Reviewed']] : []),
    ];
    const cands = allCands.filter((x) => {
      if (S.candFilter === 'season') return !!x.seasonHint;
      if (S.candFilter === 'priced') return !!tags[x.itemId];
      if (S.candFilter === 'reviewed') return !!x.lastChoice;
      return true;
    });
    const others = r.rows.filter((x) => x.status !== 'CANDIDATE');
    const actions = [['restyle', 'Wear it again'], ['keep', 'Keep it'], ['repair_check', 'Check repair'], ['sell_review', 'Look at selling'], ['donate_review', 'Look at donating']];
    const selIds = [...S.selected].filter((k) => S.items[k]);
    const ownerTotals = {};
    const sampleTotals = {};
    let selUnpriced = 0;
    for (const sid of selIds) {
      const tg = tags[sid];
      if (!tg) { selUnpriced++; continue; }
      const bucket = tg.source === 'sample' ? sampleTotals : ownerTotals;
      if (!bucket[tg.currency]) bucket[tg.currency] = { sum: 0, n: 0 };
      bucket[tg.currency].sum += tg.amount;
      bucket[tg.currency].n += 1;
    }
    const selBar = selIds.length ? h('div', { class: 'tidy-tally', role: 'status' },
      h('span', null, h('b', null, `${selIds.length} selected`), ' · latest seen prices: '),
      ...Object.entries(ownerTotals).map(([cur, v0]) => h('span', { class: 'chip accent' }, `${money(v0.sum, cur)} (${v0.n})`)),
      ...Object.entries(sampleTotals).map(([cur, v0]) => h('span', { class: 'chip sample' }, `${money(v0.sum, cur)} · sample (${v0.n})`)),
      selUnpriced ? h('span', { class: 'chip' }, `${selUnpriced} without price`) : null,
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { S.selected.clear(); render(); } }, 'Clear')) : null;

    const decideNode = decidePanel();
    const candSection = h('section', { class: 'panel tidy-queue' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
        h('h2', { style: 'margin:0' }, `To look at (${cands.length})`),
        filterDefs.length > 1 ? h('div', { class: 'dock-cats', role: 'group', 'aria-label': 'Filter candidates' }, filterDefs.map(([k, lbl]) =>
          h('button', { type: 'button', class: 'cat-pill', 'aria-pressed': S.candFilter === k ? 'true' : 'false', onclick: () => { S.candFilter = k; render(); } }, lbl))) : null),
      selBar,
      cands.length === 0 ? h('p', { class: 'muted' }, 'Nothing to look at in this view.') : null,
      h('div', { class: 'grid' }, cands.map((x) => {
        const it = S.items[x.itemId];
        const tg = tags[x.itemId];
        const activeDecide = !!(S.decide && S.decide.itemId === x.itemId);
        return h('div', { class: `item wide cand-card${(S.open && S.open.itemId === x.itemId) || activeDecide ? ' locked' : ''}` },
          h('div', { class: 'thumb' }, thumb(it, cuts)),
          h('div', { class: 'meta' },
            h('div', { class: 'cand-hd' },
              h('label', { class: 'cand-check' },
                h('input', {
                  type: 'checkbox',
                  checked: S.selected.has(x.itemId) ? true : null,
                  'aria-label': `Select ${x.itemId}`,
                  onchange: (ev) => {
                    if (ev.target.checked) S.selected.add(x.itemId);
                    else S.selected.delete(x.itemId);
                    render();
                  },
                }),
                h('b', null, `${x.itemId} · ${itemName(it)}`)),
              tg ? h('span', { class: 'cand-price' }, money(tg.amount, tg.currency), tg.source === 'sample' ? h('i', null, ' Sample') : null) : null),
            h('span', null, x.line),
            h('div', { class: 'row', style: 'margin-top:2px' },
              h('span', { class: 'muted' }, `Since ${fmtDate(x.trackedSince)} · ${x.unrecordedDays}d unknown`),
              x.seasonHint ? h('span', { class: 'chip warn' }, x.seasonHint) : null,
              x.lastChoice ? h('span', { class: 'chip' }, `Last: ${x.lastChoice.action.replace('_', ' ')}`) : null),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', type: 'button', onclick: () => openDecide(x.itemId) }, 'Keep or let go?'),
              actions.map(([a, l]) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => (a === 'keep' ? keep(x.itemId) : act(x.itemId, a)) }, l)))));
      })));

    const parts = [
      h('section', { class: 'panel' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, 'Review window'), win),
        h('p', { class: 'muted' }, r.note),
        h('div', { class: 'row' }, Object.entries(r.counts).map(([k, n]) => h('span', { class: 'chip' }, k === 'CANDIDATE' ? `No confirmed wear in ${S.window} days: ${n}` : k === 'RECENT_WEAR' ? `Worn recently: ${n}` : `${k.toLowerCase().replace(/_/g, ' ')}: ${n}`)), coverageChips())),
      decideNode ? h('div', { class: 'tidy-workspace has-decide' }, candSection, decideNode) : candSection,
    ];
    if (S.open && S.open.action === 'sell_review') parts.push(h('section', { class: 'panel', id: 'selling' }, h('h2', null, `Prices you saw for ${S.open.itemId}`), h('p', { class: 'muted' }, S.market ? S.market.note : ''), sellCharts(), evidenceForm(), calcPanel(), priceCards()));
    if (S.open && S.open.action === 'repair_check') parts.push(h('section', { class: 'panel' }, h('h2', null, `Repair check for ${S.open.itemId}`), h('p', { class: 'muted' }, 'Note what is wrong (fit, a broken zip, a stain) and ask a repair shop. Closer only keeps your note.')));
    parts.push(draftPanel());
    parts.push(h('details', { class: 'panel', open: allCands.length === 0 ? true : null }, h('summary', null, `Everything else (${others.length})`),
      h('table', { class: 't ledger-t' }, h('tbody', null, others.map((x) => {
        const it = S.items[x.itemId];
        const tg = tags[x.itemId];
        return h('tr', null,
          h('td', null, h('div', { class: 'ledger-piece' },
            h('div', { class: 'ledger-thumb' }, thumb(it, cuts)),
            h('div', null, h('b', { class: 'mono' }, x.itemId), h('div', { class: 'muted' }, itemName(it))))),
          h('td', null, h('span', { class: 'chip' }, x.status.toLowerCase().replace(/_/g, ' '))),
          h('td', null, x.line, tg ? h('div', { class: 'muted mono' }, `${money(tg.amount, tg.currency)}${tg.source === 'sample' ? ' · sample' : ''}`) : null),
          h('td', null, h('button', { class: 'btn small ghost', type: 'button', onclick: () => openDecide(x.itemId) }, 'Keep or let go?')));
      })))));
    if (S.msg && !S.msg.dataset.at) parts.push(h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, S.msg));
    keepFocus(root, () => root.replaceChildren(...parts.filter(Boolean)));
  }
  await load();
  const want = new URLSearchParams(location.search).get('decide');
  if (want && S.items[want]) await openDecide(want);
}

async function discoverScreen(view) {
  chrome(sampleChips());
  const { id, view: v, owner } = await closetWs();
  const wsParam = owner ? id : null;
  const cuts = cutMap(v);
  const items = Object.fromEntries(v.items.map((i) => [i.itemId, i]));
  const L = await getJson('/api/looks');
  const S = { cat: 'wedding_guest', look: null, match: null, matches: {}, stageMode: 'mine', altPicks: {}, col: null, msg: null, hidden: new Set() };
  const root = h('div');
  view.append(
    h('div', { class: 'rail-head' },
      h('div', null, h('h1', null, 'Discover looks')),
      h('div', { class: 'row' },
        h('a', { class: 'btn small ghost', href: wsHref('/closet/3d', wsParam) }, '3D Boutique Rail →'),
        h('a', { class: 'btn small ghost', href: wsHref('/today', wsParam) }, 'Wear today'))),
    h('p', { class: 'lede' }, 'Pick a target look · Closer counts piece-by-piece what your closet already covers.'), root);
  const lv = { SAME: ['ok', 'same'], SIMILAR: ['warn', 'similar'], NONE: ['bad', 'missing'] };
  const bx = { FILLED: ['filled', 'have it'], PARTIAL: ['partial', 'similar'], EMPTY: ['empty', 'missing'] };

  async function loadCollection() { S.col = await getJson(`/api/ws/${id}/collection`); }
  async function preloadMatches() {
    const res = await Promise.all((L.looks || []).map((l) => getJson(`/api/ws/${id}/look/${l.lookId}`).catch(() => null)));
    for (const m of res) {
      if (m && m.lookId) S.matches[m.lookId] = m;
    }
  }
  async function open(lookId) {
    S.look = lookId;
    S.altPicks = {};
    S.match = S.matches[lookId] || await getJson(`/api/ws/${id}/look/${lookId}`);
    if (S.match && S.match.lookId) S.matches[lookId] = S.match;
    render();
  }
  async function toggleTarget(lookId, on) {
    const r = await postJson(`/api/ws/${id}/target`, { lookId, on });
    S.msg = r.ok === false ? errChip(r) : null;
    await loadCollection();
    render();
  }
  function targetsPanel() {
    const c = S.col;
    if (!c) return null;
    if (c.targets.length === 0) {
      return h('section', { class: 'panel targets-slim' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('h2', { style: 'margin:0' }, 'My style targets'),
          h('span', { class: 'muted' }, 'Tap “Add as target” on any look to pin it to your item box.')));
    }
    const pctLabel = `${c.matched} of ${c.total} pieces · ${c.pct}%`;
    return h('section', { class: 'panel' }, h('h2', null, 'My style targets'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(c.pct), 'aria-label': pctLabel },
        h('div', { class: 'progress-fill', style: `width:${c.pct}%` })),
      h('p', null, h('b', null, pctLabel), ` · ${c.complete} of ${c.looks.length} target looks complete`),
      h('p', { class: 'muted' }, c.basis),
      h('h3', null, 'Item box'),
      h('div', { class: 'box' }, c.box.map((e) => {
        const matchedIt = e.itemId && items[e.itemId] ? items[e.itemId] : { type: e.type, color: e.color, slot: e.slot };
        return h('div', { class: `box-cell ${bx[e.state][0]}` },
          studioThumb(matchedIt, e.itemId ? cuts : null),
          h('b', null, e.label),
          h('span', { class: `chip ${e.state === 'FILLED' ? 'ok' : e.state === 'PARTIAL' ? 'warn' : 'bad'}` }, e.itemId ? `${bx[e.state][1]} · ${e.itemId}` : bx[e.state][1]),
          h('span', { class: 'muted' }, `in ${e.lookIds.length} look${e.lookIds.length === 1 ? '' : 's'}${e.state === 'EMPTY' && e.outfitsAdded !== null ? ` · +${e.outfitsAdded} outfits` : ''}`));
      })),
      c.nextUp.length ? h('p', { class: 'muted' }, `Next highest impact: ${c.nextUp.map((e) => `${e.label} (${e.lookIds.length} look${e.lookIds.length === 1 ? '' : 's'})`).join(', ')}.`) : null);
  }
  function render() {
    const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Occasion' }, L.categories.map((c) => h('button', { type: 'button', 'aria-pressed': S.cat === c.id ? 'true' : 'false', onclick: () => {
      S.cat = c.id;
      const first = L.looks.find((x) => x.category === c.id);
      if (first) open(first.lookId);
      else { S.look = null; S.match = null; render(); }
    } }, c.label)));
    const looks = L.looks.filter((l) => l.category === S.cat);
    const covOf = (lookId) => {
      const fromCol = S.col ? S.col.looks.find((x) => x.lookId === lookId) : null;
      if (fromCol) return fromCol.coverage;
      const pm = S.matches[lookId];
      if (!pm || !pm.pieces) return null;
      const total = pm.pieces.length;
      const matched = pm.reused || 0;
      return { matched, total, missing: total - matched, pct: total ? Math.round((100 * matched) / total) : 0 };
    };
    const isTarget = (lookId) => !!(S.col && S.col.targets.includes(lookId));
    const parts = [targetsPanel(), h('section', { class: 'panel' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, tabs, h('span', { class: 'muted' }, 'Tap a look to inspect your closet match')),
      h('div', { class: 'spacer' }),
      h('div', { class: 'look-cards' }, looks.map((l) => {
        const cov = covOf(l.lookId);
        const collageEntries = l.pieces.map((p) => ({ slot: p.slot, type: p.type, color: p.color, label: p.label }));
        return h('div', { class: `card look${S.look === l.lookId ? ' pinned' : ''}` },
          h('button', { type: 'button', class: 'look-select', onclick: () => open(l.lookId) },
            outfitCollageNode(collageEntries, { compact: true }),
            h('div', { class: 'hd' }, l.title),
            h('div', { class: 'muted' }, l.note),
            cov ? h('div', { class: 'look-meter' },
              h('div', { class: 'look-meter-top' },
                h('span', null, `${cov.matched}/${cov.total} in closet`),
                h('b', null, `${cov.pct}%`)),
              h('div', { class: 'progress', style: 'margin:4px 0 0' }, h('div', { class: 'progress-fill', style: `width:${cov.pct}%` }))) : null),
          h('div', { class: 'row actions' },
            h('button', { type: 'button', class: `btn small${isTarget(l.lookId) ? '' : ' ghost'}`, 'aria-pressed': isTarget(l.lookId) ? 'true' : 'false', onclick: () => toggleTarget(l.lookId, !isTarget(l.lookId)) }, isTarget(l.lookId) ? 'Target · remove' : 'Add as target')));
      })))];
    const m = S.match;
    if (m && m.ok !== false) {
      const gapBySlot = Object.fromEntries((m.gaps || []).map((g) => [g.piece.slot, g]));
      const activeIds = [];
      const stageEntries = m.pieces.map((p) => {
        const slot = p.piece.slot;
        const altId = S.altPicks[slot];
        const chosenId = p.itemId || altId || null;
        if (chosenId) activeIds.push(chosenId);
        if (S.stageMode === 'target') {
          return { slot, type: p.piece.type, color: p.piece.color, label: p.piece.label };
        }
        if (chosenId && items[chosenId]) {
          const it = items[chosenId];
          return { slot, type: it.type, color: it.color, cut: cuts[chosenId] || null, label: `${chosenId}` };
        }
        return { slot, type: p.piece.type, color: p.piece.color, missing: true, label: p.piece.label };
      });
      const activeCount = activeIds.length;
      const pct = m.pieces.length ? Math.round((100 * activeCount) / m.pieces.length) : 0;
      const stageToggle = h('div', { class: 'seg ibox-seg', role: 'group', 'aria-label': 'Preview mode' },
        [['mine', `Your closet (${activeCount}/${m.pieces.length})`], ['target', 'Target look']].map(([k, lbl]) =>
          h('button', { type: 'button', 'aria-pressed': S.stageMode === k ? 'true' : 'false', onclick: () => { S.stageMode = k; render(); } }, lbl)));

      parts.push(h('section', { class: 'panel ibox-panel', id: 'look-item-box' },
        h('div', { class: 'ibox' },
          h('div', { class: 'ibox-stage' },
            stageToggle,
            outfitCollageNode(stageEntries, { compact: false }),
            activeIds.length
              ? h('a', { class: 'btn ibox-cta', href: wsHref('/today', wsParam, { lock: activeIds.join(',') }), role: 'button' }, `Wear it with mine (${activeIds.join(' + ')})`)
              : h('p', { class: 'muted' }, 'No matching pieces in this closet yet.')),
          h('div', { class: 'ibox-body' },
            h('div', { class: 'row', style: 'justify-content:space-between' },
              h('h2', { style: 'margin:0' }, m.title),
              h('span', { class: `chip ${activeCount === m.pieces.length ? 'ok' : 'accent'}` }, `${activeCount} of ${m.pieces.length} · ${pct}%`)),
            h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: `width:${pct}%` })),
            h('p', { class: 'muted', style: 'margin:0 0 10px' }, m.basis),
            h('div', { class: 'ibox-rows' }, m.pieces.filter((p) => !S.hidden.has(p.piece.label)).map((p) => {
              const slot = p.piece.slot;
              const gap = gapBySlot[slot];
              const altId = S.altPicks[slot];
              const chosenId = p.itemId || altId || null;
              const chosenIt = chosenId ? items[chosenId] : null;
              const chipCls = p.itemId ? lv[p.level][0] : altId ? 'accent' : 'bad';
              const chipTxt = p.itemId ? lv[p.level][1] : altId ? `using ${altId}` : 'missing';
              return h('div', { class: `ibox-row${chosenIt ? '' : ' is-gap'}` },
                h('div', { class: 'ibox-pair' },
                  h('div', { class: 'ibox-thumb', title: `Target: ${p.piece.label}` }, studioThumb({ type: p.piece.type, color: p.piece.color, slot }, null)),
                  h('span', { class: 'ibox-arr', 'aria-hidden': 'true' }, '→'),
                  chosenIt
                    ? h('div', { class: 'ibox-thumb is-mine', title: `Yours: ${chosenId} · ${itemName(chosenIt)}` }, studioThumb(chosenIt, cuts))
                    : h('div', { class: 'ibox-thumb is-empty', title: 'Not in your closet' }, '?')),
                h('div', { class: 'ibox-info' },
                  h('div', { class: 'ibox-hd' },
                    h('b', null, p.piece.label),
                    h('span', { class: `chip ${chipCls}` }, chipTxt)),
                  h('div', { class: 'muted' }, chosenIt
                    ? `${chosenId} · ${itemName(chosenIt)} · ${altId ? 'swapped from your closet' : p.why}`
                    : `${p.why}${gap && gap.outfitsAdded > 0 ? ` · +${gap.outfitsAdded} complete outfits if filled` : ''}`),
                  !p.itemId && gap ? h('div', { class: 'row', style: 'margin-top:6px' },
                    gap.alternatives.map((aid) => h('button', {
                      type: 'button',
                      class: `btn small${altId === aid ? '' : ' ghost'}`,
                      'aria-pressed': altId === aid ? 'true' : 'false',
                      onclick: () => {
                        if (S.altPicks[slot] === aid) delete S.altPicks[slot];
                        else S.altPicks[slot] = aid;
                        S.stageMode = 'mine';
                        render();
                      },
                    }, `Use my ${aid}`)),
                    h('button', { type: 'button', class: 'btn small ghost', onclick: () => { S.hidden.add(p.piece.label); S.msg = h('span', { class: 'chip' }, 'Hidden for this visit · nothing saved'); render(); } }, 'Hide')) : null));
            })),
            h('details', { class: 'sub', style: 'margin-top:10px' },
              h('summary', null, 'Buy the whole look or check missing links'),
              h('ul', { class: 'reasons' }, m.fullLook.map((p) => h('li', null, `${p.label} · ${p.shop.url ? `${p.shop.match === 'SAME_ITEM' ? 'same item' : 'similar item'} · ${p.shop.price || 'price not checked'}` : 'no checked product link yet'}`))),
              h('p', { class: 'muted' }, 'Links open the shop. Closer does not fill a cart, pay, or check stock.'))))));
    }
    if (S.msg) parts.push(h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, S.msg));
    keepFocus(root, () => root.replaceChildren(...parts.filter(Boolean)));
  }
  await Promise.all([loadCollection(), preloadMatches()]);
  const firstLook = L.looks.find((x) => x.category === S.cat);
  if (firstLook) await open(firstLook.lookId);
  else render();
}

// The closet by layer in 3D. Same pieces and states as My closet (anatomy.js); the prices on it come from the closet ledger, as on My closet.
// A mask cut-out of a photo, drawn once the image has loaded.
async function cutCanvasReady(cut) {
  const img = await loadImage(cut.url);
  const c = document.createElement('canvas');
  c.width = cut.mask.w;
  c.height = cut.mask.h;
  const ctx = c.getContext('2d');
  ctx.translate(-cut.mask.x, -cut.mask.y);
  ctx.clip(maskPath(cut.mask));
  ctx.drawImage(img, 0, 0);
  return c;
}

/* luxe 3D: the closet ledger (GET /api/ws/:id/ledger) on the 3D stage. Price tags and the asset overlay show only
   what the ledger returns; no ledger (404 or offline) means no tags and no overlay. */
async function closetLedger(id) {
  const r = await fetch(`/api/ws/${encodeURIComponent(id)}/ledger`, { headers: authHeaders() }).catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}
// Over the stage's top-left: per currency, the owner's total (or the sample total with a Sample chip when the
// owner side is empty), its denominator, and the rule that currencies never mix. No evidence, no overlay.
function assetOverlay(L, overlayRows) {
  const picked = overlayRows(L);
  if (!picked.length) return null;
  const said = picked.map((r) => `${money(r.total, r.currency)}${r.sample ? ' (sample)' : ''}, ${[r.seen, ...r.kinds].join(' · ')}`);
  const rows = picked.map((r) => h('div', { class: 'ao-cur' },
    h('div', { class: 'ao-amount' }, h('span', { class: 'ao-num' }, money(r.total, r.currency)), r.sample ? h('span', { class: 'chip sample' }, 'Sample') : null),
    h('div', { class: 'ao-line' }, r.seen, r.kinds.map((k) => [' · ', h('span', { class: 'ao-kind' }, k)]))));
  const note = 'Each currency stands alone · nothing converted · asking prices are not sales';
  const el = h('div', { class: 'asset-overlay' },
    h('div', { class: 'ao-eyebrow' }, `This closet · ${L.pieces} pieces`),
    h('div', { class: 'ao-grid' }, rows),
    h('div', { class: 'ao-note' }, note));
  return { el, text: `${said.join('; ')}. ${note}.` };
}

/** Rail · Items · Ledger · Tidy up · Walk-in: switches views of the same closet, keeping ?ws= intact. */
function viewSwitch(mode, explicitWs) {
  const sp = new URLSearchParams(location.search);
  const curWs = explicitWs !== undefined ? explicitWs : sp.get('ws');
  const curItem = sp.get('item');
  const go = (k) => {
    if (k === mode) return;
    if (k === 'tidy') {
      location.assign(wsHref('/closet', curWs, curItem ? { decide: curItem } : null));
      return;
    }
    const extra = {};
    if (k !== 'rail') extra.view = k;
    if (curItem && (k === 'rail' || k === 'items')) extra.item = curItem;
    location.assign(wsHref('/closet/3d', curWs, Object.keys(extra).length ? extra : null));
  };
  return h('div', { class: 'seg view-seg', role: 'group', 'aria-label': 'View' },
    [['rail', 'Rail'], ['items', 'Items'], ['ledger', 'Ledger'], ['tidy', 'Tidy up'], ['layers', 'Walk-in']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': mode === k ? 'true' : 'false', onclick: () => go(k) }, l)));
}

/* The rail (11/5): every piece hung on one rail, shoes under it, a tag only where the ledger holds a price.
   Few words on screen: the count, one number per currency with its denominator, and the piece you tap. */
const SAMPLE_PHOTO = {
  coat: 'coat', jacket: 'jacket', track_jacket: 'blouson',
  training_top: 'hoodie', knit: 'knit', dress_shirt: 'shirt', blouse: 'shirt', tee: 'tee',
  trousers: 'trousers', skirt: 'trousers', jeans: 'jeans', chinos: 'chinos', joggers: 'chinos', shorts: 'chinos',
  derby: 'derby', loafers: 'derby', sneakers: 'sneakers', running_shoes: 'sneakers',
};
const SIDE_VARIANTS = {
  coat: ['coat', 'overcoat'],
  jacket: ['blazer', 'work', 'puffer'],
  track_jacket: ['blouson', 'puffer'],
  training_top: ['hoodie', 'crew'],
  knit: ['knit', 'cardigan', 'crew'],
  dress_shirt: ['shirt'],
  blouse: ['shirt', 'cardigan'],
  tee: ['tee', 'crew'],
  trousers: ['trousers', 'slacks'],
  skirt: ['slacks', 'trousers'],
  jeans: ['jeans'],
  chinos: ['chinos', 'trousers'],
  joggers: ['joggers'],
  shorts: ['chinos'],
};
const BOTTOM_SIDE_KEYS = new Set(['trousers', 'slacks', 'jeans', 'chinos', 'joggers']);

function pickSideVariant(type, seedIdx = 0, cut = null) {
  const list = SIDE_VARIANTS[type];
  if (!list || !list.length) return null;
  if (type === 'jacket' && cut && cut.mask && cut.mask.w / Math.max(1, cut.mask.h) > 0.29) return 'puffer';
  return list[Math.abs(seedIdx) % list.length];
}

/** Measures the actual garment RGB inside the owner's cut-out mask, respecting explicit palette overrides. */
const cutRgbCache = new Map();
async function measureCutRgb(cut, paletteRgb) {
  if (!cut || !cut.url || !cut.mask) return paletteRgb || null;
  const cacheKey = `${cut.url}|${cut.mask.x},${cut.mask.y},${cut.mask.w},${cut.mask.h}`;
  let measured = cutRgbCache.get(cacheKey);
  if (!measured) {
    try {
      const cv = await cutCanvasReady(cut);
      const x = cv.getContext('2d', { willReadFrequently: true });
      const d = x.getImageData(0, 0, cv.width, cv.height).data;
      const x0 = Math.floor(cv.width * 0.18), x1 = Math.ceil(cv.width * 0.82);
      const y0 = Math.floor(cv.height * 0.16), y1 = Math.ceil(cv.height * 0.84);
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let py = y0; py < y1; py += 2) {
        for (let px = x0; px < x1; px += 2) {
          const i = (py * cv.width + px) * 4;
          if (d[i + 3] > 210) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
        }
      }
      if (n >= 8) {
        measured = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
        cutRgbCache.set(cacheKey, measured);
      }
    } catch {}
  }
  if (!measured) return paletteRgb || null;
  if (!Array.isArray(paletteRgb) || paletteRgb.length !== 3) return measured;
  const dist = Math.hypot(measured[0] - paletteRgb[0], measured[1] - paletteRgb[1], measured[2] - paletteRgb[2]);
  if (dist > 115) return paletteRgb; // owner manually picked a distinct colour in the scan editor
  return [
    Math.round(measured[0] * 0.76 + paletteRgb[0] * 0.24),
    Math.round(measured[1] * 0.76 + paletteRgb[1] * 0.24),
    Math.round(measured[2] * 0.76 + paletteRgb[2] * 0.24),
  ];
}

/** Studio-framed crop of the owner's uploaded closet photo highlighting a single garment in context. */
function contextCutCanvas(cut) {
  const padX = Math.max(52, Math.round(cut.mask.w * 0.9));
  const padY = Math.max(28, Math.round(cut.mask.h * 0.09));
  const c = h('canvas', { width: cut.mask.w + padX * 2, height: cut.mask.h + padY * 2, 'data-cut': '1', class: 'pp-ctx-canvas' });
  loadImage(cut.url).then((img) => {
    const sx = Math.max(0, cut.mask.x - padX);
    const sy = Math.max(0, cut.mask.y - padY);
    const ex = Math.min(img.naturalWidth || img.width, cut.mask.x + cut.mask.w + padX);
    const ey = Math.min(img.naturalHeight || img.height, cut.mask.y + cut.mask.h + padY);
    const cw = Math.max(1, ex - sx), ch = Math.max(1, ey - sy);
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
    ctx.fillStyle = 'rgba(250, 249, 247, 0.68)';
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(-sx, -sy);
    const mp = maskPath(cut.mask);
    ctx.clip(mp);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    ctx.strokeStyle = 'rgba(243, 112, 33, 0.85)';
    ctx.lineWidth = Math.max(1.5, Math.round(cw / 140));
    ctx.strokeRect(cut.mask.x - sx + 1, cut.mask.y - sy + 1, Math.max(2, cut.mask.w - 2), Math.max(2, cut.mask.h - 2));
  }).catch(() => {});
  return c;
}

const RACK34_PHOTO = {
  coat: 'coat',
  jacket: 'blazer',
  track_jacket: 'blouson',
  training_top: 'hoodie',
};

function tintStudioCanvas(img, rgb, kind, isBottomSide) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  if (kind === 'rack34') c.dataset.rack34 = '1';
  else if (kind === 'full') c.dataset.studioFull = '1';
  else if (kind === 'side') c.dataset.side = '1';
  const isSide = kind === 'side';
  const isRack34 = kind === 'rack34';
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  if (!Array.isArray(rgb) || rgb.length !== 3) return c;
  const d = x.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  const W = c.width, H = c.height;
  const hookCutY = isSide ? Math.round(H * 0.106) : 0;
  const hangerCutY = isSide ? Math.round(H * (isBottomSide ? 0.305 : 0.215)) : isRack34 ? Math.round(H * 0.076) : Math.round(H * 0.125);
  const sampleStartY = isSide ? Math.round(H * 0.33) : isRack34 ? Math.round(H * 0.18) : Math.round(H * 0.13);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let py = sampleStartY; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      if (p[i + 3] > 205) { sr += p[i]; sg += p[i + 1]; sb += p[i + 2]; n++; }
    }
  }
  if (!n) return c;
  const mr = sr / n, mg = sg / n, mb = sb / n;
  const meanSrcLum = Math.max(10, 0.2126 * mr + 0.7152 * mg + 0.0722 * mb);
  const tgtLum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const peak = Math.max(rgb[0], rgb[1], rgb[2]);
  const lumDenom = Math.max(42, meanSrcLum);
  const baseR = tgtLum > 228 ? rgb[0] - 4 : rgb[0];
  const baseG = tgtLum > 228 ? rgb[1] - 4 : rgb[1];
  const baseB = tgtLum > 228 ? rgb[2] - 4 : rgb[2];
  const basePeak = Math.max(baseR, baseG, baseB);
  for (let py = 0; py < H; py++) {
    if (py < hookCutY) continue; // keep chrome hook untouched
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      if (!p[i + 3]) continue;
      const r = p[i], g = p[i + 1], b = p[i + 2];
      let w = 1;
      if (isSide && py < hangerCutY && Math.abs(px - W * 0.5) < W * 0.26) {
        const warmWood = r > 158 && g > 115 && b > 70 && (r - g) > 15 && (g - b) > 14;
        const steelHardware = Math.max(r, g, b) - Math.min(r, g, b) < 15 && r > 115;
        if (warmWood || steelHardware) continue;
        const dist = Math.hypot(r - mr, g - mg, b - mb);
        w = Math.max(0, Math.min(1, 1 - (dist - 85) / 55));
      } else if (isRack34 && py < hangerCutY && Math.abs(px - W * 0.5) < W * 0.13) {
        const warmWood = r > 118 && g > 76 && b > 38 && (r - g) > 14 && (g - b) > 12;
        if (warmWood) {
          w = Math.max(0, Math.min(1, (py - hangerCutY * 0.68) / (hangerCutY * 0.32)));
          if (w <= 0.02) continue;
        }
      } else if (!isSide && meanSrcLum < 95 && py < hangerCutY && Math.abs(px - W * 0.5) < W * 0.20) {
        const warmWood = r > 120 && g > 80 && b > 45 && (r - g) > 16 && (g - b) > 14;
        if (warmWood) continue;
      }
      if (w <= 0) continue;
      const srcLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const delta = (srcLum - meanSrcLum) / lumDenom;
      const s = Math.tanh(delta * 1.15);
      let tr, tg, tb;
      if (tgtLum < 56) {
        const sheen = s * 28;
        tr = Math.max(0, Math.min(248, baseR * 0.88 + sheen));
        tg = Math.max(0, Math.min(248, baseG * 0.88 + sheen));
        tb = Math.max(0, Math.min(248, baseB * 0.88 + sheen));
      } else if (peak > 195 || tgtLum > 175) {
        const lift = s >= 0 ? s * Math.max(6, 249 - basePeak) : s * 34;
        tr = Math.max(0, Math.min(250, baseR + lift));
        tg = Math.max(0, Math.min(250, baseG + lift));
        tb = Math.max(0, Math.min(250, baseB + lift));
      } else {
        const gain = 1 + s * 0.38;
        tr = Math.max(0, Math.min(250, baseR * gain));
        tg = Math.max(0, Math.min(250, baseG * gain));
        tb = Math.max(0, Math.min(250, baseB * gain));
      }
      p[i] = r + (tr - r) * w;
      p[i + 1] = g + (tg - g) * w;
      p[i + 2] = b + (tb - b) * w;
    }
  }
  x.putImageData(d, 0, 0);
  return c;
}

const studioCanvasCache = new Map();
function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  if (src.dataset) {
    if (src.dataset.side) c.dataset.side = src.dataset.side;
    if (src.dataset.rack34) c.dataset.rack34 = src.dataset.rack34;
    if (src.dataset.studioFull) c.dataset.studioFull = src.dataset.studioFull;
  }
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
async function cachedTintStudio(url, rgbOrPromise, kind, isBottomSide) {
  const rgb = await Promise.resolve(rgbOrPromise);
  const modeKey = kind || 'plain';
  const key = `${url}|${Array.isArray(rgb) ? rgb.join(',') : 'raw'}|${modeKey}|${isBottomSide ? 1 : 0}`;
  let baseP = studioCanvasCache.get(key);
  if (!baseP) {
    baseP = loadImage(url).then((img) => tintStudioCanvas(img, rgb, modeKey, isBottomSide));
    studioCanvasCache.set(key, baseP);
  }
  const base = await baseP;
  return base ? cloneCanvas(base) : null;
}

/** Volumetric 3/4 studio garment (or studio shoe pair) recoloured to `rgbOrPromise`. */
async function boutiqueRailPhoto(type, rgbOrPromise, _seedIdx = 0, _cut = null) {
  const r34 = RACK34_PHOTO[type];
  if (r34) {
    try {
      return await cachedTintStudio(`/static/photos/rack34-${r34}.png`, rgbOrPromise, 'rack34', false);
    } catch {}
  }
  const fullKey = SAMPLE_PHOTO[type];
  if (!fullKey) return null;
  const isShoe = type === 'derby' || type === 'loafers' || type === 'sneakers' || type === 'running_shoes';
  try {
    return await cachedTintStudio(`/static/photos/sample-${fullKey}.png`, rgbOrPromise, isShoe ? 'shoe' : 'full', false);
  } catch {
    return null;
  }
}

function sampleMediaNode(it, seedIdx = 0, cut = null) {
  const paletteRgb = (META && META.palette && META.palette[it.color]) || null;
  const rgbP = cut ? measureCutRgb(cut, paletteRgb) : paletteRgb;
  const p = boutiqueRailPhoto(it.type, rgbP, seedIdx, cut);
  if (!p) return placeholder(it.color, it.type || it.slot);
  const wrap = h('div', { class: 'pp-studio' }, placeholder(it.color, it.type || it.slot));
  p.then((cv) => { if (cv) wrap.replaceChildren(cv); });
  return wrap;
}
function samplePhoto(type, rgbOrPromise) {
  const key = SAMPLE_PHOTO[type];
  if (!key) return null;
  return cachedTintStudio(`/static/photos/sample-${key}.png`, rgbOrPromise, 'plain', false).catch(() => null);
}

/** Crisp front-draped studio garment thumbnail recoloured from the owner's cut-out RGB (or palette), with instant SVG fallback. */
function studioThumb(item, cuts = null, opts = {}) {
  if (!item) return h('span', { class: 'muted' }, '—');
  const cut = item.itemId && cuts ? cuts[item.itemId] : null;
  if (opts.preferCut && cut) return cutCanvas(cut);
  const paletteRgb = (META && META.palette && META.palette[item.color]) || null;
  const rgbP = cut ? measureCutRgb(cut, paletteRgb) : paletteRgb;
  const p = samplePhoto(item.type, rgbP);
  const fallback = placeholder(item.color, item.type || item.slot);
  if (!p) return cut ? cutCanvas(cut) : fallback;
  const wrap = h('span', { class: 'st-thumb', 'data-from-photo': cut ? '1' : null }, fallback);
  p.then((cv) => { if (cv) wrap.replaceChildren(cv); });
  return wrap;
}

/** Editorial studio lookbook collage for a 3–4 piece outfit (`entries`: `{ slot, type, color, cut?, missing?, label? }[]`). */
function outfitCollageNode(entries, opts = {}) {
  const W = opts.compact ? 300 : 380;
  const H = opts.compact ? 330 : 420;
  const c = h('canvas', { width: W, height: H, class: `look-collage${opts.compact ? ' is-compact' : ''}` });
  const ctx = c.getContext('2d');
  const paintBg = () => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#faf9f6');
    g.addColorStop(1, '#f0ede6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(21, 20, 19, 0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  };
  paintBg();
  const hasOuter = entries.some((e) => e.slot === 'outer');
  const layout = hasOuter
    ? { bottom: [0.38, 0.69, 0.43, 0.48], top: [0.34, 0.30, 0.42, 0.42], outer: [0.65, 0.34, 0.46, 0.50], shoes: [0.71, 0.80, 0.36, 0.22] }
    : { bottom: [0.42, 0.68, 0.47, 0.50], top: [0.46, 0.28, 0.48, 0.44], shoes: [0.73, 0.80, 0.36, 0.22] };
  const order = ['bottom', 'top', 'outer', 'shoes'];
  const sorted = [...entries].sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  Promise.all(sorted.map(async (e) => {
    const paletteRgb = (META && META.palette && META.palette[e.color]) || null;
    const rgbP = e.cut ? measureCutRgb(e.cut, paletteRgb) : paletteRgb;
    const cv = await samplePhoto(e.type, rgbP);
    return { e, cv };
  })).then((loaded) => {
    paintBg();
    for (const { e, cv } of loaded) {
      const box = layout[e.slot] || [0.5, 0.5, 0.4, 0.4];
      const cx = box[0] * W, cy = box[1] * H, mw = box[2] * W, mh = box[3] * H;
      if (cv) {
        const s = Math.min(mw / cv.width, mh / cv.height);
        const dw = cv.width * s, dh = cv.height * s;
        ctx.save();
        if (e.missing) {
          ctx.globalAlpha = 0.36;
          ctx.shadowColor = 'rgba(21, 20, 19, 0.16)';
          ctx.shadowBlur = opts.compact ? 6 : 9;
          ctx.shadowOffsetY = 2;
          ctx.drawImage(cv, cx - dw / 2, cy - dh / 2, dw, dh);
        } else {
          ctx.shadowColor = 'rgba(21, 20, 19, 0.14)';
          ctx.shadowBlur = opts.compact ? 10 : 15;
          ctx.shadowOffsetY = opts.compact ? 4 : 6;
          ctx.drawImage(cv, cx - dw / 2, cy - dh / 2, dw, dh);
        }
        ctx.restore();
      }
      if (e.missing) {
        const tag = '? missing';
        ctx.save();
        ctx.font = `600 ${opts.compact ? 11 : 12}px system-ui, -apple-system, sans-serif`;
        const tw = ctx.measureText(tag).width + 16;
        const th = opts.compact ? 22 : 24;
        ctx.fillStyle = 'rgba(255, 253, 249, 0.94)';
        ctx.strokeStyle = '#c88a1a';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(cx - tw / 2, cy - th / 2, tw, th);
        ctx.strokeRect(cx - tw / 2, cy - th / 2, tw, th);
        ctx.setLineDash([]);
        ctx.fillStyle = '#84540f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, cx, cy + 0.5);
        ctx.restore();
      } else if (!opts.compact && e.label && /^[A-Z]\d+$/.test(e.label)) {
        ctx.save();
        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(e.label).width + 18;
        const th = 20;
        const tx = cx + mw * 0.14 - tw / 2, ty = cy + mh * 0.24 - th / 2;
        ctx.fillStyle = 'rgba(255, 253, 249, 0.95)';
        ctx.strokeStyle = 'rgba(21, 20, 19, 0.16)';
        ctx.lineWidth = 1;
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeRect(tx, ty, tw, th);
        ctx.fillStyle = '#f37021';
        ctx.beginPath();
        ctx.arc(tx + 6, ty + th / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#151413';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(e.label, tx + 11, ty + th / 2 + 0.5);
        ctx.restore();
      }
    }
  });
  return c;
}

async function railView(view, ctx) {
  const { id, wsParam, v, A, byId, overlayRows, AVAILABILITY_LABEL, switcher } = ctx;
  let Lcur = ctx.L;
  let curRev = v.revision;
  const cells = A.layers.flatMap((l) => l.items);
  const hasCuts = Object.keys(ctx.cuts).length > 0;
  const initParams = new URLSearchParams(location.search);
  let drapeMode = initParams.get('drape') === 'cut' && hasCuts ? 'cut' : 'boutique';
  let catFilter = 'all';
  const explicitScene = initParams.get('scene');
  const explicitCam = initParams.get('cam');
  let vaultMode = explicitScene === 'rail' ? false : true;
  let camPreset = ['front', 'walk', 'left', 'right', 'overhead'].includes(explicitCam)
    ? explicitCam
    : (explicitScene === 'rail' ? 'front' : 'walk');
  let turntable = false;
  let heatMode = true;
  let showTags = true;
  let dockCollapsed = false;
  let sortMode = ['rack', 'review', 'worn', 'priced'].includes(initParams.get('sort')) ? initParams.get('sort') : 'rack';
  const pinnedBySlot = {};
  let rewearState = { anchorId: null, dir: 'none', rain: false, busy: false, op: null, locked: false, worn: false };
  let pulseItems = [];
  let pulseIdx = 0;
  let pulseDismissed = false;
  const marketCache = new Map();
  const decideCache = new Map();

  const [mod, railRuleMod] = await Promise.all([
    import('/static/rail3d.js').catch(() => null),
    import('/static/rail.js').catch(() => null),
  ]);
  const heatOf = railRuleMod && typeof railRuleMod.rotationHeatOf === 'function'
    ? railRuleMod.rotationHeatOf
    : (m) => ({ tier: (m && m.wearCount >= 3) ? 'hot' : (m && m.wearCount >= 1) ? 'warm' : (m && m.review === 'CANDIDATE') ? 'cold' : 'fresh', wears: (m && m.wearCount) || 0, shortLabel: `${(m && m.wearCount) || 0}x`, detailLabel: '' });

  function makePieces(mode) {
    const seenType = {};
    return cells.map((c) => {
      const paletteRgb = (META.palette && META.palette[c.color]) || null;
      const cut = ctx.cuts[c.itemId] || null;
      const isSamplePiece = !wsParam || !!(byId[c.itemId] && byId[c.itemId].sample);
      const idx = seenType[c.type] || 0;
      seenType[c.type] = idx + 1;
      let photo = null;
      if (cut && mode === 'cut') photo = cutCanvasReady(cut);
      else if (cut) photo = boutiqueRailPhoto(c.type, measureCutRgb(cut, paletteRgb), idx, cut);
      else if (isSamplePiece) photo = boutiqueRailPhoto(c.type, paletteRgb, idx, null);
      return {
        itemId: c.itemId,
        slot: c.slot,
        type: c.type,
        rgb: paletteRgb,
        availability: c.availability,
        wearCount: c.wearCount || 0,
        review: c.review || null,
        sample: isSamplePiece,
        photo,
      };
    });
  }

  const count = (slots) => cells.filter((c) => slots.includes(c.slot)).length;
  const counts = h('div', { class: 'rail-counts' },
    h('span', null, 'Tops & outerwear ', h('b', null, String(count(['outer', 'top'])))),
    h('span', null, 'Bottoms ', h('b', null, String(count(['bottom'])))),
    h('span', null, 'Shoes ', h('b', null, String(count(['shoes'])))));

  const SORT_MODES = [
    ['rack', 'Rack'],
    ['review', 'Review 0x'],
    ['worn', 'Worn'],
    ['priced', 'Priced'],
  ];

  const plaqueSlot = h('div', { class: 'rail-plaque-slot' });
  const heatmapCardSlot = h('div', { class: 'rail-heatmap-slot' });
  let heatDockBtn = null;
  let tagsDockBtn = null;

  function syncDockToggleButtons() {
    if (heatDockBtn) {
      heatDockBtn.setAttribute('aria-pressed', heatMode ? 'true' : 'false');
      heatDockBtn.textContent = heatMode ? 'Rotation Heatmap: ON' : 'Rotation Heatmap: OFF';
    }
    if (tagsDockBtn) {
      tagsDockBtn.setAttribute('aria-pressed', showTags ? 'true' : 'false');
      tagsDockBtn.textContent = showTags ? 'Asset Tags: ON' : 'Asset Tags: OFF';
    }
  }

  async function refreshPulse() {
    const res = await getJson(`/api/ws/${id}/pulse`).catch(() => null);
    if (res && Array.isArray(res.items)) {
      pulseItems = res.items;
      if (pulseIdx >= pulseItems.length) pulseIdx = 0;
      paintPlaque();
      if (current) show(current);
    }
  }

  function paintPlaque() {
    const rows = overlayRows(Lcur);
    const ledgerHref = wsHref('/closet/3d', wsParam, { view: 'ledger' });
    const reviewHref = wsHref('/closet', wsParam);
    const plaqueNode = h('div', { class: 'rail-plaque' },
      h('div', { class: 'rp-hd' },
        h('span', { class: 'rp-eyebrow' }, wsParam ? 'Your closet at a glance' : 'Sample closet at a glance'),
        h('span', { class: 'rp-links' },
          h('a', { href: ledgerHref }, 'Full Ledger'),
          h('a', { href: reviewHref }, 'Review'))),
      rows.length
        ? h('div', { class: 'rp-cols' }, rows.map((r) => h('div', { class: 'rp-col' },
          h('div', { class: 'rp-amt-row' },
            h('span', { class: 'rp-num' }, money(r.total, r.currency)),
            r.sample ? h('span', { class: 'chip sample' }, 'Sample') : null),
          h('span', { class: 'rp-of', title: r.seen }, `${r.pieces} of ${r.of} pieces`))))
        : h('div', { class: 'rp-empty' }, `${cells.length} pieces · no prices entered yet`));
    plaqueSlot.replaceChildren(plaqueNode);

    let hotCount = 0, warmCount = 0, coldCount = 0;
    for (const c of cells) {
      const t = heatOf(c).tier;
      if (t === 'hot') hotCount++;
      else if (t === 'warm') warmCount++;
      else if (t === 'cold') coldCount++;
    }

    const activePulse = pulseItems.length ? pulseItems[pulseIdx % pulseItems.length] : null;
    const pulseIt = activePulse ? byId[activePulse.itemId] : null;
    const pulseCell = activePulse ? cells.find((x) => x.itemId === activePulse.itemId) : null;
    let pulseCard = null;
    if (activePulse && pulseIt) {
      if (pulseDismissed) {
        pulseCard = h('button', {
          type: 'button',
          class: 'mpulse-reopen',
          id: 'mpulse-reopen',
          onclick: () => { pulseDismissed = false; paintPlaque(); },
        }, `Market Pulse (${pulseItems.length})`);
      } else {
        const pctTxt = activePulse.changePct !== null
          ? `${activePulse.changePct > 0 ? '+' : ''}${activePulse.changePct.toFixed(1)}%`
          : null;
        const platShort = String(activePulse.platformName || activePulse.platform).split(' (')[0];
        pulseCard = h('aside', { class: 'market-pulse-card', id: 'rail-market-pulse', 'aria-label': 'Market Pulse Observed Price' },
          h('div', { class: 'mp-hd' },
            h('div', { class: 'mp-eyebrow-wrap' },
              h('span', { class: 'mp-dot', 'aria-hidden': 'true' }),
              h('span', { class: 'mp-eyebrow' }, 'Market Pulse · Observed'),
              activePulse.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null),
            h('div', { class: 'mp-ctrl' },
              pulseItems.length > 1 ? h('button', {
                type: 'button',
                class: 'mp-next-btn',
                id: 'mp-next-btn',
                onclick: () => { pulseIdx = (pulseIdx + 1) % pulseItems.length; paintPlaque(); },
              }, `${(pulseIdx % pulseItems.length) + 1}/${pulseItems.length} Next`) : null,
              h('button', {
                type: 'button',
                class: 'mp-close-btn',
                'aria-label': 'Dismiss Market Pulse',
                onclick: () => { pulseDismissed = true; paintPlaque(); },
              }, '×'))),
          h('div', { class: 'mp-body' },
            h('div', { class: 'mp-thumb' }, studioThumb(pulseIt, ctx.cuts)),
            h('div', { class: 'mp-info' },
              h('div', { class: 'mp-name-row' },
                h('span', { class: 'mp-code mono' }, activePulse.itemId),
                h('b', { class: 'mp-name' }, itemName(pulseIt))),
              h('div', { class: 'mp-price-row' },
                h('span', { class: 'mp-price mono' }, money(activePulse.latestAmount, activePulse.currency)),
                pctTxt ? h('span', { class: `mp-delta mono ${activePulse.changePct >= 0 ? 'is-up' : 'is-down'}` },
                  `${pctTxt} vs 1st`) : null),
              h('div', { class: 'mp-sub' },
                `${platShort} · ${activePulse.priceType === 'TRADE' ? 'traded' : 'asking'} · ${activePulse.count} seen`))),
          h('div', { class: 'mp-ft' },
            h('span', { class: 'mp-wear-note' }, pulseCell ? `60d wears: ${pulseCell.wearCount || 0}x` : ''),
            h('button', {
              type: 'button',
              class: 'mp-inspect-btn',
              id: 'mp-inspect-btn',
              onclick: () => {
                inspectorTab = 'market';
                if (rail) rail.select(activePulse.itemId);
                show(activePulse.itemId);
              },
            }, 'Inspect Piece →')));
      }
    }

    const heatCard = cells.length ? h('div', { class: `rail-heatmap-card rail-sort-slim${heatMode ? '' : ' is-muted'}`, id: 'rail-pulse' },
      h('div', { class: 'rhc-scale', role: 'img', 'aria-label': `${coldCount} in 60-day review, ${warmCount} worn 1 to 2 times, ${hotCount} worn 3 or more times` },
        h('span', { class: 'rhc-badge is-cold' }, `0x (${coldCount})`),
        h('span', { class: 'rhc-grad', 'aria-hidden': 'true' }),
        h('span', { class: 'rhc-badge is-hot' }, `3+x (${hotCount})`)),
      h('div', { class: 'rpulse-sorts', role: 'group', 'aria-label': 'Rail order' },
        SORT_MODES.map(([k, lbl]) => h('button', {
          type: 'button',
          class: 'rpulse-pill',
          'data-sort': k,
          'aria-pressed': sortMode === k ? 'true' : 'false',
          onclick: () => {
            if (sortMode === k) return;
            sortMode = k;
            paintPlaque();
            mountStage();
          },
        }, lbl)))) : null;
    heatmapCardSlot.replaceChildren(...[pulseCard, heatCard].filter(Boolean));
    syncDockToggleButtons();
  }
  paintPlaque();
  refreshPulse();

  const host = h('div', { class: 'stage rail-stage' });
  const RANK0 = { outer: 0, top: 1, bottom: 2, shoes: 3 };
  const ordered = cells.map((c, i) => ({ c, i })).sort((x, y) => RANK0[x.c.slot] - RANK0[y.c.slot] || x.i - y.i).map((x) => x.c);
  function baseEditorialCopy() {
    if (vaultMode || turntable || camPreset !== 'front') return 'Walk-in vault · drag 360° · wheel zoom · WASD';
    if (!wsParam) return 'Hung like a boutique rail · sample pieces';
    if (hasCuts) return drapeMode === 'boutique' ? 'Hung like a boutique rail · colours from your photo' : 'Mask cut-outs from your photo';
    return 'Hung like a boutique rail';
  }
  const editorialSub = h('span', null, baseEditorialCopy());
  const editorial = h('div', { class: 'rail-editorial', 'aria-hidden': 'true' },
    h('span', null, wsParam ? 'Your archive' : 'Archive collection'), h('i', null, '|'), editorialSub);

  let sceneRailBtn = null;
  let sceneVaultBtn = null;
  function syncSceneButtons() {
    const inVault = vaultMode || turntable || camPreset !== 'front';
    if (sceneRailBtn) sceneRailBtn.setAttribute('aria-pressed', !inVault ? 'true' : 'false');
    if (sceneVaultBtn) sceneVaultBtn.setAttribute('aria-pressed', inVault ? 'true' : 'false');
  }

  const CAM_PRESETS = [
    ['front', 'Front', 'Front'],
    ['walk', '3D Walk-Around', '3D Walk'],
    ['left', 'Left Wing', 'Left'],
    ['right', 'Right Wing', 'Right'],
    ['overhead', 'Overhead', 'Top'],
  ];
  const camButtons = {};
  const spinBtn = h('button', {
    type: 'button',
    class: 'cam-pill cam-spin',
    id: 'cam-spin',
    'aria-pressed': 'false',
    onclick: () => {
      if (!rail) return;
      rail.setTurntable(!turntable);
    },
  }, '360° Spin');
  const camBar = h('div', { class: 'rail-cam-bar', id: 'rail-cam-bar', role: 'group', 'aria-label': '3D camera view' },
    ...CAM_PRESETS.map(([k, fullLbl, shortLbl]) => {
      const b = h('button', {
        type: 'button',
        class: 'cam-pill',
        'data-cam': k,
        'aria-pressed': camPreset === k && !turntable ? 'true' : 'false',
        onclick: () => {
          if (!rail) return;
          if (k !== 'front') vaultMode = true;
          rail.setPreset(k);
        },
      }, h('span', { class: 'cam-lbl-full' }, fullLbl), h('span', { class: 'cam-lbl-short' }, shortLbl));
      camButtons[k] = b;
      return b;
    }),
    spinBtn);

  function syncCamUi(st) {
    if (st) {
      camPreset = st.preset || 'front';
      turntable = Boolean(st.turntable);
      if (typeof st.vaultMode === 'boolean') vaultMode = st.vaultMode;
    }
    for (const [k, btn] of Object.entries(camButtons)) {
      btn.setAttribute('aria-pressed', !turntable && camPreset === k ? 'true' : 'false');
    }
    spinBtn.setAttribute('aria-pressed', turntable ? 'true' : 'false');
    syncSceneButtons();
    editorialSub.textContent = baseEditorialCopy();
  }

  const quickLook = h('div', { class: 'rail-quicklook', id: 'rail-quicklook', hidden: true, 'aria-hidden': 'true' });
  let quickLookItemId = null;
  function handleHover(info) {
    if (!info || !info.itemId || info.itemId === current || window.innerWidth <= 900) {
      quickLook.hidden = true;
      return;
    }
    const it = byId[info.itemId];
    const c = cells.find((x) => x.itemId === info.itemId);
    if (!it || !c) { quickLook.hidden = true; return; }
    if (quickLookItemId !== info.itemId) {
      quickLookItemId = info.itemId;
      const t = Lcur && Lcur.tags ? Lcur.tags[info.itemId] : null;
      const heat = heatOf(c);
      const isPinned = pinnedBySlot[c.slot] === info.itemId;
      quickLook.replaceChildren(
        h('div', { class: 'ql-thumb' }, studioThumb(it, ctx.cuts)),
        h('div', { class: 'ql-meta' },
          h('div', { class: 'ql-title' }, h('b', { class: 'mono' }, info.itemId), ' · ', itemName(it)),
          h('div', { class: 'ql-badges' },
            h('span', { class: `ql-heat ql-${heat.tier}` }, heat.shortLabel),
            isPinned ? h('span', { class: 'ql-pin' }, 'Today') : null,
            c.availability !== 'AVAILABLE' ? h('span', { class: 'ql-away' }, AVAILABILITY_LABEL[c.availability] || c.availability) : null),
          h('div', { class: 'ql-price' },
            t ? [h('b', { class: 'mono' }, money(t.amount, t.currency)), t.source === 'sample' ? ' · Sample' : ''] : 'No price recorded')));
    }
    const rect = body.getBoundingClientRect();
    const maxRight = body.classList.contains('open') ? rect.width - 392 : rect.width - 248;
    const qx = Math.max(14, Math.min(Math.max(14, maxRight), info.clientX - rect.left + 18));
    const qy = Math.max(66, Math.min(rect.height - 156, info.clientY - rect.top - 34));
    quickLook.style.transform = `translate3d(${qx.toFixed(0)}px, ${qy.toFixed(0)}px, 0)`;
    quickLook.hidden = false;
  }

  const pinnedIds = () => SLOTS.map((s) => pinnedBySlot[s]).filter(Boolean);
  const chipOf = {};
  function renderDockChipInner(b, c) {
    const t = Lcur && Lcur.tags ? Lcur.tags[c.itemId] : null;
    const rgb = META.palette && META.palette[c.color];
    const isPinned = pinnedBySlot[c.slot] === c.itemId;
    b.classList.toggle('is-pinned', isPinned);
    b.replaceChildren(...[
      h('span', { class: 'dot', style: rgb ? `background:rgb(${rgb.join(',')})` : null }),
      h('b', null, c.itemId),
      h('span', { class: 'nm' }, itemName(byId[c.itemId])),
      t ? h('span', { class: 'px' }, money(t.amount, t.currency)) : null,
      t && t.source === 'sample' ? h('span', { class: 'smp' }, 'Sample') : null,
      isPinned ? h('span', { class: 'pin-mark' }, 'Today') : null,
    ].filter(Boolean));
  }
  const strip = h('div', { class: 'dock-strip', 'aria-label': 'Pieces on the rail' }, ordered.map((c) => {
    const b = h('button', { type: 'button', class: 'dock-chip', 'data-slot': c.slot, onclick: () => { if (rail) rail.select(c.itemId); show(c.itemId); } });
    renderDockChipInner(b, c);
    chipOf[c.itemId] = b;
    return b;
  }));

  const comboBar = h('div', { class: 'rail-combo-bar', id: 'rail-combo-bar', hidden: true });
  function syncPins() {
    const ids = pinnedIds();
    quickLookItemId = null;
    if (rail) rail.setPinned(ids);
    for (const c of ordered) {
      if (chipOf[c.itemId]) renderDockChipInner(chipOf[c.itemId], c);
    }
    if (!ids.length) {
      comboBar.hidden = true;
      comboBar.replaceChildren();
      return;
    }
    comboBar.hidden = false;
    comboBar.replaceChildren(
      h('div', { class: 'rcb-left' },
        h('span', { class: 'rcb-eyebrow' }, `Today combo (${ids.length}/4)`),
        h('div', { class: 'rcb-chips' }, ids.map((pid) => {
          const pc = cells.find((x) => x.itemId === pid);
          return h('button', {
            type: 'button',
            class: 'rcb-chip',
            title: 'Remove from Today combo',
            onclick: () => {
              if (pc) delete pinnedBySlot[pc.slot];
              syncPins();
              if (current === pid) show(pid);
            },
          }, h('b', { class: 'mono' }, pid), ` ${itemName(byId[pid])} ×`);
        }))),
      h('div', { class: 'rcb-actions' },
        h('a', { class: 'btn small', id: 'rcb-go-today', href: wsHref('/today', wsParam, { lock: ids.join(',') }) }, 'Complete outfit →'),
        h('button', {
          type: 'button',
          class: 'btn small ghost',
          onclick: () => {
            for (const k of Object.keys(pinnedBySlot)) delete pinnedBySlot[k];
            syncPins();
            if (current) show(current);
          },
        }, 'Clear')));
  }

  const catPills = h('div', { class: 'dock-cats', role: 'group', 'aria-label': 'Category filter' },
    [['all', 'All'], ['pants-shoes', 'Pants & Glass Shoes'], ['outer', 'Outer'], ['top', 'Tops'], ['bottom', 'Bottoms'], ['shoes', 'Shoes']].map(([k, lbl]) =>
      h('button', {
        type: 'button',
        class: 'cat-pill',
        'aria-pressed': catFilter === k ? 'true' : 'false',
        onclick: () => {
          catFilter = k;
          for (const btn of catPills.querySelectorAll('button')) btn.setAttribute('aria-pressed', btn.textContent === lbl ? 'true' : 'false');
          let firstMatch = null;
          for (const c of ordered) {
            const match = k === 'all' || (k === 'pants-shoes' ? (c.slot === 'bottom' || c.slot === 'shoes') : c.slot === k);
            chipOf[c.itemId].hidden = !match;
            if (match && !firstMatch) firstMatch = c.itemId;
          }
          if (k !== 'all' && firstMatch && rail) rail.select(firstMatch);
          else if (k === 'all' && rail && !current) rail.reset();
        },
      }, lbl)));

  const prev = h('button', { type: 'button', class: 'pg', 'aria-label': 'Slide left' }, '‹');
  const next = h('button', { type: 'button', class: 'pg', 'aria-label': 'Slide right' }, '›');
  const sheet = h('aside', { class: 'piece-panel', id: 'piece', 'aria-live': 'polite', hidden: true });
  let rail = null;

  const drapeToggle = hasCuts ? h('div', { class: 'seg drape-seg', id: 'drape-toggle', role: 'group', 'aria-label': 'Garment drape' },
    [['boutique', 'Boutique'], ['cut', 'Photo cut']].map(([m, lbl]) => h('button', {
      type: 'button',
      'aria-pressed': drapeMode === m ? 'true' : 'false',
      onclick: () => {
        if (drapeMode === m) return;
        drapeMode = m;
        for (const btn of drapeToggle.querySelectorAll('button')) btn.setAttribute('aria-pressed', btn.textContent === lbl ? 'true' : 'false');
        editorialSub.textContent = baseEditorialCopy();
        mountStage();
      },
    }, lbl))) : null;

  heatDockBtn = h('button', {
    type: 'button',
    class: 'dock-toggle-pill',
    id: 'rail-heat-toggle',
    'aria-pressed': heatMode ? 'true' : 'false',
    onclick: () => {
      heatMode = !heatMode;
      if (rail) rail.setHeatMode(heatMode);
      paintPlaque();
    },
  }, 'Rotation Heatmap: ON');

  tagsDockBtn = h('button', {
    type: 'button',
    class: 'dock-toggle-pill',
    id: 'rail-tags-toggle',
    'aria-pressed': showTags ? 'true' : 'false',
    onclick: () => {
      showTags = !showTags;
      if (rail) rail.setShowTags(showTags);
      syncDockToggleButtons();
    },
  }, 'Asset Tags: ON');

  const dock = h('div', { class: 'rail-dock', id: 'rail-dock' },
    comboBar,
    strip,
    h('div', { class: 'dock-row' },
      h('div', { class: 'row dock-left' }, catPills, counts),
      h('div', { class: 'row pg-row' }, heatDockBtn, tagsDockBtn, drapeToggle, prev, next, switcher)));
  const dockCollapseBtn = h('button', {
    type: 'button',
    class: 'dock-collapse-pill',
    id: 'dock-collapse-btn',
    'aria-expanded': 'true',
    onclick: () => {
      dockCollapsed = !dockCollapsed;
      dock.hidden = dockCollapsed;
      dockCollapseBtn.setAttribute('aria-expanded', dockCollapsed ? 'false' : 'true');
      dockCollapseBtn.textContent = dockCollapsed ? '⌃ Show Controls' : '⌄ Hide Controls';
    },
  }, '⌄ Hide Controls');
  const dockWrap = h('div', { class: 'rail-dock-wrap' }, dockCollapseBtn, dock);

  sceneRailBtn = h('button', {
    type: 'button',
    id: 'scene-rail-btn',
    'aria-pressed': !(vaultMode || turntable || camPreset !== 'front') ? 'true' : 'false',
    onclick: () => {
      vaultMode = false;
      if (rail) {
        rail.setVaultMode(false);
        rail.setPreset('front');
      }
      syncSceneButtons();
    },
  }, 'Boutique Rail');
  sceneVaultBtn = h('button', {
    type: 'button',
    id: 'scene-vault-btn',
    'aria-pressed': (vaultMode || turntable || camPreset !== 'front') ? 'true' : 'false',
    onclick: () => {
      vaultMode = true;
      if (rail) {
        rail.setVaultMode(true);
        if (camPreset === 'front' && !turntable) rail.setPreset('walk');
      }
      syncSceneButtons();
    },
  }, 'Walk-In Vault');
  const sceneSeg = h('div', { class: 'seg scene-mode-seg', id: 'scene-mode-seg', role: 'group', 'aria-label': '3D Scene Architecture' },
    sceneRailBtn, sceneVaultBtn);

  const uploadHref = wsParam ? `/app?ws=${encodeURIComponent(wsParam)}` : '/app';
  const addPhoto = h('a', { class: 'rail-add-inline btn small', href: uploadHref, id: 'rail-add' }, h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Upload Photo & Hang');
  const headBar = h('div', { class: 'rail-head rail-head-slim rail-head-boutique' },
    h('div', { class: 'row rail-head-left' },
      h('h1', { class: 'caps-title' }, 'My closet'),
      sceneSeg),
    h('div', { class: 'row rail-head-actions' },
      accountHeaderBtn(wsParam || id),
      addPhoto));

  const body = h('div', { class: 'immersive' }, host, plaqueSlot, camBar, editorial, heatmapCardSlot, quickLook, dockWrap, sheet);
  const list = h('details', { class: 'panel', id: 'layer-list' }, h('summary', null, `List · ${A.counts.total}`),
    h('div', { class: 'chip-row' }, cells.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => { if (rail) rail.select(c.itemId); show(c.itemId); } }, `${c.itemId} · ${itemName(byId[c.itemId])}`))));
  view.append(headBar, body, h('p', { class: 'muted hint' }, 'Drag to slide · Walk-In Vault or Shift+drag to orbit 360° · tap any garment or upper price tag · WASD / ← →'), list);

  const RANK = { outer: 0, top: 1, bottom: 2, shoes: 3 };
  const order = cells.map((c, i) => ({ c, i })).sort((x, y) => RANK[x.c.slot] - RANK[y.c.slot] || x.i - y.i).map((x) => x.c.itemId);
  const LAYER_NAME = { outer: 'Outerwear', top: 'Tops', bottom: 'Bottoms', shoes: 'Shoes' };
  let current = null;
  let mediaTab = 'photo';
  let inspectorTab = 'market';
  let chartRange = 'all';
  let chartCur = null;
  let chartPlat = null;
  let chartPt = null;
  let priceFormOpen = false;
  let simAskByItem = {};
  let simPlatByItem = {};
  let simFeePct = '5';
  let simShip = '3500';
  let simFeeChecked = true;
  let netCache = new Map();

  function onPickFromStage(itemId) {
    if (!itemId) { close(); return; }
    show(itemId);
  }

  function mountStage() {
    const keepSpin = turntable;
    if (rail) { rail.dispose(); rail = null; }
    const rows = overlayRows(Lcur);
    const said = rows.map((r) => `${money(r.total, r.currency)}${r.sample ? ' (sample)' : ''}, latest price seen on ${r.pieces} of ${r.of} pieces`).join('; ');
    rail = mod ? mod.mountRail3d(host, makePieces(drapeMode), {
      fill: true,
      tags: Lcur ? Lcur.tags : null,
      money,
      sort: sortMode,
      preset: camPreset,
      vaultMode,
      heatMode,
      showTags,
      pinned: pinnedIds(),
      onPick: onPickFromStage,
      onHover: handleHover,
      onCameraChange: syncCamUi,
      label: `${A.counts.total} pieces on a rail.${said ? ` ${said}.` : ''}`,
    }) : null;
    if (rail && keepSpin) rail.setTurntable(true);
    if (rail && current) rail.select(current);
    if (rail && rewearState.op && rewearState.op.options && rewearState.op.options[0]) {
      const opt0 = rewearState.op.options[0];
      const oIds = SLOTS.map((s) => opt0.outfit[s]).filter(Boolean);
      rail.setOutfitHighlight(oIds, rewearState.anchorId);
    }
  }
  mountStage();
  if (!rail) {
    body.remove();
    const fallbackNotice = h('p', { class: 'chip warn', style: 'margin:0 0 12px' }, 'No WebGL on this device · showing the 2D studio grid instead.');
    const fallbackHost = h('div', { class: 'rail-fallback-grid' });
    view.insertBefore(fallbackNotice, list);
    view.insertBefore(fallbackHost, list);
    itemsGalleryView(fallbackHost, ctx);
    return;
  }
  prev.onclick = () => rail && rail.slide(-1);
  next.onclick = () => rail && rail.slide(1);

  function syncItemParam(val) {
    try {
      const u = new URL(location.href);
      if (val) u.searchParams.set('item', val);
      else u.searchParams.delete('item');
      history.replaceState(null, '', u.pathname + u.search);
    } catch {}
  }

  const step = (d) => { if (!current) return; const k = order.indexOf(current); const nextId = order[(k + d + order.length) % order.length]; if (rail) rail.select(nextId); show(nextId); };
  document.addEventListener('keydown', (e) => {
    if (!document.body.contains(body)) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight') { if (current) step(1); else if (rail) rail.slide(1); }
    else if (e.key === 'ArrowLeft') { if (current) step(-1); else if (rail) rail.slide(-1); }
    else if (e.key === 'a' || e.key === 'A') { if (rail) rail.nudgeOrbit(-0.14, 0); }
    else if (e.key === 'd' || e.key === 'D') { if (rail) rail.nudgeOrbit(0.14, 0); }
    else if (e.key === 'w' || e.key === 'W') { if (rail) rail.nudgeOrbit(0, 0.08); }
    else if (e.key === 's' || e.key === 'S') { if (rail) rail.nudgeOrbit(0, -0.08); }
    else if (e.key === 'Escape') {
      if (priceFormOpen && current) { priceFormOpen = false; show(current); }
      else if (current) close();
      else if (rail && (turntable || camPreset !== 'front')) rail.setPreset('front');
    }
  });

  function clearRewearHighlight() {
    rewearState = { anchorId: null, dir: 'none', rain: false, busy: false, op: null, locked: false, worn: false };
    if (rail) rail.setOutfitHighlight([], null);
  }

  function close() {
    current = null;
    priceFormOpen = false;
    clearRewearHighlight();
    sheet.hidden = true;
    sheet.classList.remove('is-expanded');
    body.classList.remove('open');
    syncItemParam(null);
    for (const b of Object.values(chipOf)) b.setAttribute('aria-current', 'false');
    if (rail) rail.select(null);
  }

  async function ensureMarketData(itemId) {
    if (marketCache.has(itemId)) return marketCache.get(itemId);
    marketCache.set(itemId, { loading: true });
    const data = await getJson(`/api/ws/${id}/market/${encodeURIComponent(itemId)}`).catch(() => null);
    marketCache.set(itemId, data || { error: true });
    if (current === itemId) show(itemId);
    return data;
  }

  async function ensureDecideData(itemId) {
    if (decideCache.has(itemId)) return decideCache.get(itemId);
    decideCache.set(itemId, { loading: true });
    const data = await getJson(`/api/ws/${id}/decide/${encodeURIComponent(itemId)}`).catch(() => null);
    decideCache.set(itemId, data || { error: true });
    if (current === itemId) show(itemId);
    return data;
  }

  async function refreshNetPreview(itemId, price, plat) {
    if (!(price > 0) || !plat) return;
    const fees = simFeeChecked
      ? [
        { label: 'Platform fee', kind: 'rate', value: Math.max(0, Number(simFeePct) || 0) / 100 },
        { label: 'Shipping', kind: 'fixed', value: Math.max(0, Number(simShip) || 0) },
      ]
      : [{ label: 'Platform fee', kind: 'rate', value: null }];
    const key = `${plat}:${price}:${simFeeChecked}:${simFeePct}:${simShip}`;
    if (netCache.has(key)) return netCache.get(key);
    netCache.set(key, { loading: true });
    const r = await postJson('/api/net', { price, platform: plat, fees }).catch(() => null);
    netCache.set(key, r || { error: true });
    if (current === itemId && inspectorTab === 'decide') show(itemId);
    return r;
  }

  async function suggestInlineOutfit(itemId) {
    if (rewearState.busy) return;
    rewearState.busy = true;
    rewearState.anchorId = itemId;
    rewearState.locked = false;
    rewearState.worn = false;
    show(itemId);
    const op = await postJson(`/api/ws/${id}/anchor`, {
      anchorItemIds: [itemId],
      direction: rewearState.dir,
      rainPct: rewearState.rain ? 80 : null,
    }).catch(() => ({ ok: false, detail: 'Could not reach outfit solver' }));
    rewearState.busy = false;
    rewearState.op = op;
    if (op && op.options && op.options[0] && rail) {
      const oIds = SLOTS.map((s) => op.options[0].outfit[s]).filter(Boolean);
      rail.setOutfitHighlight(oIds, itemId);
    }
    show(itemId);
  }

  function show(itemId, flashText = '') {
    const it = byId[itemId];
    const c = cells.find((x) => x.itemId === itemId);
    if (!it || !c) return;
    quickLook.hidden = true;
    if (current !== itemId) {
      priceFormOpen = false;
      chartCur = null;
      chartPlat = null;
      chartPt = null;
      if (rewearState.anchorId && rewearState.anchorId !== itemId) clearRewearHighlight();
    }
    current = itemId;
    syncItemParam(itemId);
    for (const [k, b] of Object.entries(chipOf)) b.setAttribute('aria-current', k === itemId ? 'true' : 'false');
    if (chipOf[itemId]) chipOf[itemId].scrollIntoView({ block: 'nearest', inline: 'center' });
    const t = Lcur && Lcur.tags ? Lcur.tags[itemId] : null;
    const pulseRow = pulseItems.find((p) => p.itemId === itemId) || null;
    const cut = ctx.cuts[itemId] || null;
    const heat = heatOf(c);
    const isPinned = pinnedBySlot[c.slot] === itemId;
    const writable = id !== 'demo-rc1';
    sheet.hidden = false;
    body.classList.add('open');

    if (!marketCache.has(itemId)) ensureMarketData(itemId);
    if (inspectorTab === 'decide' && !decideCache.has(itemId)) ensureDecideData(itemId);

    // 1. Compact Horizontal Identity Header + Hero Market Readout (Always visible at top)
    const thumbPreview = h('div', { class: 'pp-compact-thumb' },
      cut
        ? (mediaTab === 'studio' ? sampleMediaNode(it, order.indexOf(itemId), cut) : contextCutCanvas(cut))
        : (!wsParam || it.sample) ? sampleMediaNode(it, order.indexOf(itemId), null) : placeholder(it.color, it.type || c.slot));

    const miniPhotoSwitch = cut ? h('button', {
      type: 'button',
      class: 'pp-mini-drape',
      onclick: () => { mediaTab = mediaTab === 'photo' ? 'studio' : 'photo'; show(itemId); },
    }, mediaTab === 'photo' ? 'Drape' : 'Photo') : null;

    const identityCard = h('div', { class: 'pp-identity-row' },
      h('div', { class: 'pp-thumb-col' }, thumbPreview, miniPhotoSwitch),
      h('div', { class: 'pp-identity-meta' },
        h('div', { class: 'pp-id-hd' },
          h('span', { class: 'pp-code-pill mono' }, itemId),
          h('h2', { class: 'pp-title' }, itemName(it))),
        h('div', { class: 'chip-row pp-tight-chips' },
          h('span', { class: 'chip' }, LAYER_NAME[c.slot] || c.slot),
          h('span', { class: 'chip' }, c.slot === 'shoes' ? 'Glass Box' : c.slot === 'bottom' ? 'Clamp Bar' : 'Hanger'),
          h('span', { class: `chip ${heat.tier === 'hot' ? 'ok' : heat.tier === 'cold' ? 'warn' : ''}`.trim() }, heat.shortLabel),
          c.availability !== 'AVAILABLE' ? h('span', { class: 'chip warn' }, AVAILABILITY_LABEL[c.availability] || c.availability) : h('span', { class: 'chip' }, 'Available'),
          !wsParam || it.sample ? h('span', { class: 'chip sample' }, 'Sample') : null)));

    const heroDeltaPct = pulseRow && pulseRow.changePct !== null
      ? `${pulseRow.changePct > 0 ? '+' : ''}${pulseRow.changePct.toFixed(1)}%`
      : null;
    const heroDeltaAmt = pulseRow && pulseRow.count > 1 && pulseRow.changeAmt !== 0
      ? `${pulseRow.changeAmt > 0 ? '+' : '−'}${money(Math.abs(pulseRow.changeAmt), pulseRow.currency)}`
      : null;
    const heroPlat = t ? String(t.platformName || t.platform).split(' (')[0] : null;
    const marketHeroStrip = h('div', { class: 'pp-market-hero', id: 'pp-market-hero' },
      t ? [
        h('div', { class: 'pp-mh-left' },
          h('span', { class: 'pp-mh-eyebrow' }, 'Latest observed price'),
          h('div', { class: 'pp-mh-price-line' },
            h('b', { class: 'pp-mh-price mono' }, money(t.amount, t.currency)),
            t.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null),
          h('span', { class: 'pp-mh-sub' }, `${heroPlat} · ${t.priceType === 'TRADE' ? 'traded' : 'asking'} · ${fmtDate(t.retrievedAt)}`)),
        h('div', { class: 'pp-mh-right' },
          heroDeltaPct
            ? h('span', { class: `pp-mh-delta mono ${pulseRow.changePct >= 0 ? 'is-up' : 'is-down'}` }, `${heroDeltaPct}`)
            : h('span', { class: 'pp-mh-single' }, '1st comp'),
          heroDeltaAmt ? h('span', { class: 'pp-mh-delta-sub mono' }, `${heroDeltaAmt} vs 1st`) : null),
      ] : [
        h('div', { class: 'pp-mh-left' },
          h('span', { class: 'pp-mh-eyebrow' }, 'Observed market price'),
          h('span', { class: 'pp-mh-empty' }, 'No price logged yet · unpriced stays blank')),
        writable ? h('button', {
          type: 'button',
          class: 'btn small ghost',
          onclick: () => { inspectorTab = 'market'; priceFormOpen = true; show(itemId); },
        }, '+ Log price') : null,
      ]);

    // 2. Clean 3-Tab Information Architecture Bar
    const IA_TABS = [
      ['market', 'Market & Chart'],
      ['wear', 'Wear & Outfit'],
      ['decide', 'Keep vs Sell'],
    ];
    const iaTabBar = h('div', { class: 'pp-ia-tabs', role: 'tablist', 'aria-label': 'Piece details' },
      IA_TABS.map(([k, lbl]) => h('button', {
        type: 'button',
        role: 'tab',
        class: 'pp-ia-tab',
        'data-ia-tab': k,
        'aria-selected': inspectorTab === k ? 'true' : 'false',
        onclick: () => {
          inspectorTab = k;
          if (k === 'decide' && !decideCache.has(itemId)) ensureDecideData(itemId);
          show(itemId);
        },
      }, lbl)));

    // --- TAB 1: MARKET & CHART ---
    let tabContent = null;
    if (inspectorTab === 'market') {
      const mData = marketCache.get(itemId);
      const platSel = h('select', { id: 'pp-plat', class: 'scan-sel', 'aria-label': 'Platform' },
        PLATFORM_OPTIONS.map(([v0, l0]) => h('option', { value: v0, selected: (t && t.platform === v0) || (!t && v0 === 'KARROT') ? true : null }, l0)));
      const ptypeSel = h('select', { id: 'pp-ptype', class: 'scan-sel', 'aria-label': 'Price type' },
        h('option', { value: 'ASK' }, 'Asking'),
        h('option', { value: 'TRADE', selected: t && t.priceType === 'TRADE' ? true : null }, 'Traded'));
      const amtInput = h('input', { id: 'pp-amt', class: 'scan-price', type: 'number', min: '1', step: 'any', placeholder: 'Amount (e.g. 145000)', 'aria-label': 'Amount', value: t && t.source !== 'sample' ? String(t.amount) : '' });
      const inlinePriceForm = priceFormOpen && writable ? h('div', { class: 'pp-price-form', id: 'pp-price-form' },
        h('div', { class: 'pp-pf-grid' }, platSel, ptypeSel),
        h('div', { class: 'pp-pf-row' },
          amtInput,
          h('button', {
            type: 'button',
            class: 'btn small',
            id: 'pp-save-price',
            onclick: async () => {
              const amt = Number(amtInput.value);
              if (!(amt > 0)) { amtInput.focus(); return; }
              const plat = platSel.value;
              const cur = PLATFORM_CURRENCY[plat] || 'KRW';
              const pr = await postJson(`/api/ws/${id}/evidence`, {
                itemId,
                platform: plat,
                currency: cur,
                priceType: ptypeSel.value,
                amount: amt,
                retrievedAt: new Date().toISOString().slice(0, 10),
                matchLevel: 'SAME_ITEM',
              });
              if (pr && pr.ok !== false) {
                marketCache.delete(itemId);
                decideCache.delete(itemId);
                Lcur = await closetLedger(id);
                ctx.L = Lcur;
                quickLookItemId = null;
                await refreshPulse();
                paintPlaque();
                if (chipOf[itemId]) renderDockChipInner(chipOf[itemId], c);
                if (rail) rail.updatePiece(itemId, { tagRow: Lcur && Lcur.tags ? Lcur.tags[itemId] : null });
                priceFormOpen = false;
                show(itemId, 'Price saved to rail & chart');
              }
            },
          }, 'Save'))) : null;

      let chartBlock = null;
      let compsTable = null;
      if (!mData || mData.loading) {
        chartBlock = h('p', { class: 'muted', style: 'font-size:12.5px;margin:8px 0' }, 'Loading observed market trajectory…');
      } else if (Array.isArray(mData.series)) {
        const activeSeries = mData.series.filter((s) => s.count > 0);
        if (activeSeries.length) {
          const currencies = [...new Set(activeSeries.map((s) => s.currency))];
          const curToUse = chartCur && currencies.includes(chartCur) ? chartCur : currencies[0];
          const curSeries = activeSeries.filter((s) => s.currency === curToUse);
          const platToUse = chartPlat && curSeries.some((s) => s.platform === chartPlat) ? chartPlat : curSeries[0].platform;

          const curSwitch = currencies.length > 1 ? h('div', { class: 'pp-cur-pills', role: 'group', 'aria-label': 'Chart currency' },
            currencies.map((cc) => h('button', {
              type: 'button',
              class: 'rpulse-pill',
              'aria-pressed': curToUse === cc ? 'true' : 'false',
              onclick: () => { chartCur = cc; chartPlat = null; show(itemId); },
            }, `${cc} Comps`))) : null;

          const platSwitch = curSeries.length > 1 ? h('div', { class: 'pp-plat-pills', role: 'group', 'aria-label': 'Platform series' },
            curSeries.map((s) => h('button', {
              type: 'button',
              class: 'rpulse-pill',
              'aria-pressed': platToUse === s.platform ? 'true' : 'false',
              onclick: () => { chartPlat = s.platform; show(itemId); },
            }, `${String(s.name).split(' (')[0]} (${s.count})`))) : null;

          chartBlock = h('div', { class: 'pp-chart-card', id: 'pp-chart-card' },
            h('div', { class: 'pp-chart-top' }, curSwitch, platSwitch),
            priceChart(curSeries, curToUse, {
              selectedPlatform: platToUse,
              range: chartRange,
              selectedPoint: chartPt,
              today: mData.today,
              onRange: (rg) => { chartRange = rg; show(itemId); },
              onPick: (pt, ser) => { chartPt = pt.evidenceId; chartPlat = ser.platform; show(itemId); },
            }));

          compsTable = h('div', { class: 'pp-comps-list' },
            h('div', { class: 'pp-sec-hd' },
              h('span', { class: 'pp-sec-title' }, 'Observed by platform (never averaged)'),
              writable ? h('button', {
                type: 'button',
                class: 'pp-inline-link',
                id: 'pp-add-price-btn',
                onclick: () => { priceFormOpen = !priceFormOpen; show(itemId); },
              }, priceFormOpen ? 'Cancel' : '+ Log price') : null),
            inlinePriceForm,
            h('div', { class: 'pp-comp-rows' }, activeSeries.map((s) => {
              const latest = s.latest;
              const diff = s.count > 1 && s.first ? latest.amount - s.first.amount : 0;
              return h('button', {
                type: 'button',
                class: `pp-comp-row${platToUse === s.platform && curToUse === s.currency ? ' is-active' : ''}`,
                onclick: () => { chartCur = s.currency; chartPlat = s.platform; show(itemId); },
              },
              h('div', { class: 'pp-cr-left' },
                h('b', null, String(s.name).split(' (')[0]),
                h('span', { class: 'muted' }, `${s.count} seen · ${latest.priceType === 'TRADE' ? 'traded' : 'asking'}`)),
              h('div', { class: 'pp-cr-right' },
                h('b', { class: 'mono' }, money(latest.amount, s.currency)),
                s.count > 1 ? h('span', { class: 'pp-cr-diff mono' }, `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff), s.currency)}`) : h('span', { class: 'muted' }, fmtDate(latest.retrievedAt))));
            })));
        } else {
          chartBlock = h('div', { class: 'pp-empty-card' },
            h('p', { class: 'muted', style: 'margin:0 0 8px' }, 'No market observations saved yet. Add a listing or trade you saw.'),
            writable ? h('button', {
              type: 'button',
              class: 'btn small',
              id: 'pp-add-price-btn',
              onclick: () => { priceFormOpen = !priceFormOpen; show(itemId); },
            }, priceFormOpen ? 'Cancel' : '+ Add observed price') : null,
            inlinePriceForm);
        }
      }
      tabContent = h('div', { class: 'pp-tab-pane', 'data-pane': 'market' }, chartBlock, compsTable);
    } else if (inspectorTab === 'wear') {
      // --- TAB 2: WEAR & OUTFIT ---
      const availSeg = writable ? h('div', { class: 'seg pp-avail', role: 'group', 'aria-label': 'Availability' },
        [['AVAILABLE', 'Available'], ['LAUNDRY', 'Laundry'], ['STORED', 'Stored']].map(([st, lbl]) => h('button', {
          type: 'button',
          'aria-pressed': c.availability === st ? 'true' : 'false',
          onclick: async () => {
            if (c.availability === st) return;
            const r = await saveFlow(id, 'availability', { itemId, state: st, eventId: uuid(), expectedRevision: curRev },
              (vv) => vv.items.some((x) => x.itemId === itemId && x.availability === st), `${itemId} → ${lbl.toLowerCase()}`);
            if (r.view) curRev = r.view.revision;
            if (r.ok) {
              c.availability = st;
              it.availability = st;
              quickLookItemId = null;
              if (rail) rail.updatePiece(itemId, { availability: st, tagRow: Lcur && Lcur.tags ? Lcur.tags[itemId] : null });
              show(itemId, `Marked ${lbl.toLowerCase()}`);
            }
          },
        }, lbl))) : null;

      const activeOpt = rewearState.anchorId === itemId && rewearState.op && rewearState.op.options && rewearState.op.options[0]
        ? rewearState.op.options[0]
        : null;
      const rewearBox = writable && c.availability === 'AVAILABLE' ? h('div', { class: 'pp-rewear', id: 'pp-rewear' },
        h('div', { class: 'pp-rewear-hd' },
          h('b', null, 'Wear this piece again'),
          activeOpt ? h('button', { type: 'button', class: 'pp-inline-link', onclick: () => { clearRewearHighlight(); show(itemId); } }, 'Clear') : null),
        h('div', { class: 'pp-rewear-dirs', role: 'group', 'aria-label': 'Outfit direction' },
          [['none', 'As is'], ['less_formal', 'Relaxed'], ['more_formal', 'Dressier']].map(([dKey, dLbl]) => h('button', {
            type: 'button',
            class: 'rpulse-pill',
            'aria-pressed': rewearState.dir === dKey ? 'true' : 'false',
            onclick: () => {
              rewearState.dir = dKey;
              if (activeOpt) suggestInlineOutfit(itemId);
              else show(itemId);
            },
          }, dLbl)),
          h('button', {
            type: 'button',
            class: 'rpulse-pill',
            'aria-pressed': rewearState.rain ? 'true' : 'false',
            onclick: () => {
              rewearState.rain = !rewearState.rain;
              if (activeOpt) suggestInlineOutfit(itemId);
              else show(itemId);
            },
          }, 'Rain')),
        !activeOpt ? h('button', {
          type: 'button',
          class: 'btn small pp-rewear-btn',
          id: 'pp-suggest-outfit',
          disabled: rewearState.busy ? true : null,
          onclick: () => suggestInlineOutfit(itemId),
        }, rewearState.busy ? 'Matching your closet…' : 'Suggest outfit from my closet') : null,
        rewearState.anchorId === itemId && rewearState.op && rewearState.op.ok === false
          ? h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:12px' }, rewearState.op.detail || 'Not enough available pieces in other layers yet.')
          : null,
        activeOpt ? h('div', { class: 'pp-rewear-result' },
          h('div', { class: 'pp-rewear-slots' }, SLOTS.map((sl) => {
            const pid = activeOpt.outfit[sl];
            const pit = pid ? byId[pid] : null;
            const isKept = pid === itemId;
            return h('button', {
              type: 'button',
              class: `pp-rw-slot${isKept ? ' is-kept' : ''}`,
              disabled: !pid ? true : null,
              onclick: () => { if (pid && pid !== itemId) { if (rail) rail.select(pid); show(pid); } },
            },
            h('span', { class: 'pp-rw-role' }, isKept ? 'Kept' : sl),
            h('b', { class: 'mono' }, pid || '—'),
            h('span', { class: 'pp-rw-name' }, pit ? itemName(pit) : 'none'));
          })),
          activeOpt.reasons && activeOpt.reasons.length
            ? h('ul', { class: 'pp-rw-reasons' }, activeOpt.reasons.slice(0, 2).map((rs) => h('li', null, rs)))
            : null,
          h('div', { class: 'row pp-rw-actions' },
            !rewearState.locked ? h('button', {
              type: 'button',
              class: 'btn small',
              id: 'pp-save-outfit',
              onclick: async () => {
                const r = await saveFlow(
                  id,
                  'lock',
                  { eventId: uuid(), expectedRevision: curRev, operationId: rewearState.op.operationId, optionIndex: 0 },
                  (vv) => vv.plans.some((p) => p.planId === rewearState.op.planId && p.state === 'LOCKED' && sameOutfit(p.slots, activeOpt.outfit)),
                  META.labels.selectionSaved,
                );
                if (r.view) curRev = r.view.revision;
                if (r.ok) {
                  rewearState.locked = true;
                  show(itemId, 'Outfit saved to your closet');
                }
              },
            }, 'Save this outfit') : h('span', { class: 'chip ok' }, 'Outfit saved'),
            rewearState.locked && !rewearState.worn ? h('button', {
              type: 'button',
              class: 'btn small ghost',
              id: 'pp-wore-outfit',
              onclick: async () => {
                const planId = rewearState.op.planId;
                const r = await saveFlow(
                  id,
                  'wear',
                  { eventId: uuid(), expectedRevision: curRev, planId },
                  (vv) => vv.wearRows.some((w) => w.planId === planId),
                  META.labels.wearSaved,
                );
                if (r.view) curRev = r.view.revision;
                if (r.ok) {
                  rewearState.worn = true;
                  for (const sl of SLOTS) {
                    const pid = activeOpt.outfit[sl];
                    const cellHit = pid ? cells.find((x) => x.itemId === pid) : null;
                    if (cellHit) {
                      cellHit.wearCount = (cellHit.wearCount || 0) + 1;
                      cellHit.wearLabel = `${cellHit.wearCount} confirmed wear${cellHit.wearCount === 1 ? '' : 's'}`;
                      if (rail) rail.updatePiece(pid, { wearCount: cellHit.wearCount, tagRow: Lcur && Lcur.tags ? Lcur.tags[pid] : null });
                    }
                  }
                  decideCache.delete(itemId);
                  paintPlaque();
                  show(itemId, 'Confirmed wear logged');
                }
              },
            }, 'I wore this today') : null)) : null) : null;

      tabContent = h('div', { class: 'pp-tab-pane', 'data-pane': 'wear' },
        h('div', { class: 'pp-stat-card' },
          h('div', { class: 'pp-sec-hd' },
            h('span', { class: 'pp-sec-title' }, 'Counted 60-day wear record'),
            h('b', { class: 'mono' }, `${c.wearCount || 0}x`)),
          h('p', { class: 'muted', style: 'margin:4px 0 8px;font-size:12px' }, c.wearLabel || 'No confirmed wear yet · days without a record stay unknown.'),
          availSeg),
        rewearBox);
    } else {
      // --- TAB 3: KEEP VS SELL ---
      const dData = decideCache.get(itemId);
      const defaultPlat = simPlatByItem[itemId] || (t && t.platform) || 'KREAM';
      const defaultCur = PLATFORM_CURRENCY[defaultPlat] || 'KRW';
      const defaultAsk = simAskByItem[itemId] !== undefined
        ? simAskByItem[itemId]
        : (t && t.currency === defaultCur ? String(t.amount) : '');
      const askNum = Number(defaultAsk);
      const netKey = `${defaultPlat}:${askNum}:${simFeeChecked}:${simFeePct}:${simShip}`;
      if (askNum > 0 && !netCache.has(netKey)) refreshNetPreview(itemId, askNum, defaultPlat);
      const netRes = askNum > 0 ? netCache.get(netKey) : null;

      const keepInfo = dData && dData.keep ? dData.keep : null;
      const latestSaved = dData && Array.isArray(dData.history) && dData.history[0] ? dData.history[0] : null;

      const askPlatSel = h('select', {
        class: 'scan-sel',
        'aria-label': 'Target sell platform',
        onchange: (ev) => {
          simPlatByItem[itemId] = ev.target.value;
          show(itemId);
        },
      }, PLATFORM_OPTIONS.map(([v0, l0]) => h('option', { value: v0, selected: defaultPlat === v0 ? true : null }, l0)));

      const askInput = h('input', {
        type: 'number',
        min: '1',
        step: 'any',
        class: 'scan-price mono',
        placeholder: defaultCur === 'KRW' ? 'Ask (e.g. 160000)' : 'Ask (e.g. 110)',
        value: defaultAsk,
        onchange: (ev) => {
          simAskByItem[itemId] = ev.target.value;
          show(itemId);
        },
      });

      const feeCheck = h('label', { class: 'pp-fee-check' },
        h('input', {
          type: 'checkbox',
          checked: simFeeChecked ? true : null,
          onchange: (ev) => { simFeeChecked = ev.target.checked; show(itemId); },
        }),
        `Check fees (${simFeePct}% + ${defaultCur === 'KRW' ? `₩${Number(simShip).toLocaleString('en-US')}` : `$${simShip}`} ship)`);

      const saveChoiceBtn = (choiceCode, lbl, cls = 'btn small ghost') => writable ? h('button', {
        type: 'button',
        class: cls,
        onclick: async () => {
          const feesPayload = simFeeChecked
            ? [
              { label: 'Platform fee', kind: 'rate', value: Math.max(0, Number(simFeePct) || 0) / 100 },
              { label: 'Shipping', kind: 'fixed', value: Math.max(0, Number(simShip) || 0) },
            ]
            : [];
          const res = await postJson(`/api/ws/${id}/decide`, {
            itemId,
            choice: choiceCode,
            horizonDays: 90,
            platform: defaultPlat,
            askPrice: askNum > 0 ? askNum : null,
            fees: feesPayload,
          });
          if (res && res.decision) {
            decideCache.delete(itemId);
            Lcur = await closetLedger(id);
            ctx.L = Lcur;
            paintPlaque();
            show(itemId, `Saved position: ${lbl}`);
          }
        },
      }, lbl) : null;

      tabContent = h('div', { class: 'pp-tab-pane', 'data-pane': 'decide' },
        h('div', { class: 'pp-vs-grid' },
          h('div', { class: 'pp-vs-card is-keep' },
            h('span', { class: 'pp-vs-tag' }, 'Keep · Closet use'),
            h('b', { class: 'pp-vs-big mono' }, `${c.wearCount || 0} wears`),
            h('span', { class: 'muted', style: 'font-size:11.5px' }, keepInfo ? keepInfo.question : 'Counted in last 60 days'),
            h('span', { class: 'pp-vs-meta' }, c.review === 'CANDIDATE' ? '0 confirmed wears in 60d' : 'Active in wardrobe')),
          h('div', { class: 'pp-vs-card is-sell' },
            h('span', { class: 'pp-vs-tag is-accent' }, 'Sell · Net check'),
            h('b', { class: 'pp-vs-big mono' },
              netRes && typeof netRes.net === 'number'
                ? money(netRes.net, netRes.currency || defaultCur)
                : (askNum > 0 ? 'Unconfirmed' : 'Enter ask')),
            h('span', { class: 'muted', style: 'font-size:11.5px' },
              netRes && typeof netRes.net === 'number'
                ? `After ${simFeePct}% fee + ship`
                : 'Fees must be checked first'),
            h('span', { class: 'pp-vs-meta' }, t ? `Latest seen: ${money(t.amount, t.currency)}` : 'No comp yet'))),
        h('div', { class: 'pp-net-box' },
          h('span', { class: 'pp-sec-title' }, 'Test hypothetical ask & platform fees'),
          h('div', { class: 'pp-pf-grid', style: 'margin-top:6px' }, askPlatSel, askInput),
          feeCheck),
        writable ? h('div', { class: 'pp-decide-actions' },
          saveChoiceBtn('KEEP', 'Keep', 'btn small'),
          saveChoiceBtn('WEAR_ONCE', 'Wear once', 'btn small ghost'),
          saveChoiceBtn('SELL_PREPARE', 'Prepare to sell', 'btn small ghost')) : null,
        latestSaved ? h('p', { class: 'pp-saved-pos muted' },
          `Saved snapshot: ${latestSaved.choice} on ${String(latestSaved.at || '').slice(0, 10)}`) : null);
    }

    sheet.replaceChildren(
      h('button', {
        type: 'button',
        class: 'pp-sheet-handle',
        'aria-label': 'Expand or collapse inspector',
        onclick: () => sheet.classList.toggle('is-expanded'),
      }, h('span', null)),
      h('div', { class: 'pp-top' },
        h('button', { type: 'button', class: 'pg', 'aria-label': 'Previous piece', onclick: () => step(-1) }, '‹'),
        h('span', { class: 'pp-count' }, `${order.indexOf(itemId) + 1} / ${order.length}`),
        h('button', { type: 'button', class: 'pg', 'aria-label': 'Next piece', onclick: () => step(1) }, '›'),
        h('button', { type: 'button', class: 'pp-close', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: 'pp-body' },
        ...[
          identityCard,
          marketHeroStrip,
          flashText ? h('div', { class: 'flash', role: 'status', style: 'margin:6px 0' }, h('span', { class: 'chip ok' }, flashText)) : null,
          iaTabBar,
          tabContent,
        ].filter(Boolean)),
      h('div', { class: 'pp-foot-sticky' },
        inspectorTab !== 'wear' ? h('button', {
          type: 'button',
          class: 'btn small pp-primary-cta',
          onclick: () => { inspectorTab = 'wear'; suggestInlineOutfit(itemId); },
        }, 'Wear this piece again →') : h('a', { class: 'btn small pp-primary-cta', href: wsHref('/closet', wsParam, { decide: itemId }) }, 'Full Keep / Sell sheet →'),
        h('button', {
          type: 'button',
          class: `btn small${isPinned ? '' : ' ghost'}`,
          id: 'pp-pin-today',
          'aria-pressed': isPinned ? 'true' : 'false',
          onclick: () => {
            if (pinnedBySlot[c.slot] === itemId) {
              delete pinnedBySlot[c.slot];
              syncPins();
              show(itemId, `Removed ${itemId} from Today combo`);
            } else {
              pinnedBySlot[c.slot] = itemId;
              syncPins();
              show(itemId, `Pinned ${itemId} to Today combo`);
            }
          },
        }, isPinned ? `Pinned (${c.slot}) ✓` : '+ Pin combo'),
        h('a', { class: 'btn small ghost', href: wsHref('/closet', wsParam, { decide: itemId }) }, 'Review')));
  }

  const initialItem = initParams.get('item');
  if (initialItem && byId[initialItem]) {
    if (rail) rail.select(initialItem);
    show(initialItem);
  }
}

/** Boutique Items gallery (?view=items): filterable visual cards for every piece in the closet. */
function itemsGalleryView(view, ctx) {
  const { wsParam, A, byId, L, cuts, AVAILABILITY_LABEL, switcher } = ctx;
  const cells = A.layers.flatMap((l) => l.items);
  const LAYER_NAME = { outer: 'Outerwear', top: 'Tops', bottom: 'Bottoms', shoes: 'Shoes' };
  const hasCuts = Object.keys(cuts).length > 0;
  let cat = 'all';
  let q = '';
  let photoMode = 'boutique';
  const searchInput = h('input', {
    type: 'search',
    class: 'items-search',
    id: 'items-search',
    placeholder: 'Search colour, type, ID…',
    'aria-label': 'Search closet items',
    oninput: (e) => { q = e.target.value.trim().toLowerCase(); paint(); },
  });
  const gridHost = h('div', { class: 'boutique-grid', id: 'items-grid' });
  const catHost = h('div', { class: 'row items-toolbar-cats' });
  const modeSeg = hasCuts ? h('div', { class: 'seg drape-seg', role: 'group', 'aria-label': 'Card preview' },
    [['boutique', 'Boutique'], ['photo', 'Your photo']].map(([m, lbl]) => h('button', {
      type: 'button',
      'aria-pressed': photoMode === m ? 'true' : 'false',
      onclick: () => {
        photoMode = m;
        for (const btn of modeSeg.querySelectorAll('button')) btn.setAttribute('aria-pressed', btn.textContent === lbl ? 'true' : 'false');
        paint();
      },
    }, lbl))) : null;

  function paint() {
    const countsBySlot = { all: cells.length, outer: 0, top: 0, bottom: 0, shoes: 0 };
    for (const c of cells) countsBySlot[c.slot] = (countsBySlot[c.slot] || 0) + 1;
    catHost.replaceChildren(...[['all', 'All'], ['outer', 'Outerwear'], ['top', 'Tops'], ['bottom', 'Bottoms'], ['shoes', 'Shoes']].map(([k, lbl]) =>
      h('button', {
        type: 'button',
        class: 'cat-pill',
        'aria-pressed': cat === k ? 'true' : 'false',
        onclick: () => { cat = k; paint(); },
      }, `${lbl} (${countsBySlot[k] || 0})`)));

    const filtered = cells.filter((c) => {
      if (cat !== 'all' && c.slot !== cat) return false;
      if (!q) return true;
      const it = byId[c.itemId];
      const hay = `${c.itemId} ${it ? itemName(it) : ''} ${c.slot} ${c.availability}`.toLowerCase();
      return hay.includes(q);
    });

    if (!filtered.length) {
      gridHost.replaceChildren(h('p', { class: 'muted' }, 'No pieces match that filter.'));
      return;
    }

    const seenType = {};
    gridHost.replaceChildren(...filtered.map((c) => {
      const it = byId[c.itemId];
      const t = L && L.tags ? L.tags[c.itemId] : null;
      const cut = cuts[c.itemId] || null;
      const idx = seenType[c.type] || 0;
      seenType[c.type] = idx + 1;
      const media = cut
        ? (photoMode === 'photo' ? contextCutCanvas(cut) : sampleMediaNode(it, idx, cut))
        : (!wsParam || (it && it.sample)) ? sampleMediaNode(it, idx, null) : placeholder(c.color, c.type || c.slot);
      return h('article', { class: 'boutique-card', 'data-item': c.itemId },
        h('div', { class: 'bc-stage' },
          t ? h('span', { class: 'bc-price' }, money(t.amount, t.currency), t.source === 'sample' ? h('i', null, ' · Sample') : null) : null,
          c.availability !== 'AVAILABLE' ? h('span', { class: 'bc-avail chip warn' }, AVAILABILITY_LABEL[c.availability] || c.availability) : null,
          media),
        h('div', { class: 'bc-body' },
          h('div', { class: 'bc-eyebrow' }, `${c.itemId} · ${LAYER_NAME[c.slot] || c.slot}`),
          h('h3', { class: 'bc-title' }, itemName(it)),
          h('p', { class: 'muted bc-wear' }, c.wearLabel || 'No confirmed wear yet'),
          h('div', { class: 'row bc-actions' },
            h('a', { class: 'btn small ghost', href: `/today?${wsParam ? `ws=${encodeURIComponent(wsParam)}&` : ''}lock=${c.itemId}` }, 'Wear today'),
            h('a', { class: 'btn small ghost', href: `/closet?${wsParam ? `ws=${encodeURIComponent(wsParam)}&` : ''}decide=${c.itemId}` }, 'Decide'))));
    }));
  }

  paint();
  view.append(
    h('div', { class: 'rail-head' },
      h('div', null, h('h1', { class: 'caps-title' }, 'My closet · Items')),
      h('div', { class: 'row' }, h('a', { class: 'btn small', href: '/app' }, '+ Add from a photo'), switcher)),
    L ? assetBoard(L, { sampleCloset: !wsParam }) : null,
    h('section', { class: 'panel' },
      h('div', { class: 'items-toolbar' }, catHost, h('div', { class: 'row' }, modeSeg, searchInput)),
      gridHost));
}

/** Tabular Closet Ledger (?view=ledger): counted wears and seen prices side-by-side, never averaged. */
function ledgerTableView(view, ctx) {
  const { wsParam, A, byId, L, cuts, AVAILABILITY_LABEL, switcher } = ctx;
  const cells = A.layers.flatMap((l) => l.items);
  const LAYER_NAME = { outer: 'Outerwear', top: 'Tops', bottom: 'Bottoms', shoes: 'Shoes' };
  const table = h('div', { class: 'scroll-x' },
    h('table', { class: 't ledger-t', id: 'closet-ledger-table' },
      h('thead', null, h('tr', null,
        ['Piece', 'Layer', 'Status', 'Confirmed wears', 'Latest price seen', 'Next step'].map((col) => h('th', null, col)))),
      h('tbody', null, cells.map((c) => {
        const it = byId[c.itemId];
        const t = L && L.tags ? L.tags[c.itemId] : null;
        return h('tr', { 'data-item': c.itemId },
          h('td', null,
            h('div', { class: 'ledger-piece' },
              h('div', { class: 'ledger-thumb' }, thumb(it, cuts)),
              h('div', null, h('b', null, `${c.itemId} · ${itemName(it)}`), h('div', { class: 'muted' }, FORMALITY_LABEL[it.formality] || it.formality)))),
          h('td', null, LAYER_NAME[c.slot] || c.slot),
          h('td', null, h('span', { class: `chip${c.availability === 'AVAILABLE' ? '' : ' warn'}` }, AVAILABILITY_LABEL[c.availability] || c.availability)),
          h('td', null, c.wearLabel || 'No confirmed wear yet'),
          h('td', null, t
            ? h('span', null, h('b', { class: 'mono' }, money(t.amount, t.currency)), ` · ${String(t.platformName || t.platform).split(' (')[0]} · ${t.priceType === 'TRADE' ? 'traded' : 'asking'} `, t.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null)
            : h('span', { class: 'muted' }, '— (not counted as zero)')),
          h('td', null,
            h('div', { class: 'row' },
              h('a', { class: 'btn small ghost', href: `/closet?${wsParam ? `ws=${encodeURIComponent(wsParam)}&` : ''}decide=${c.itemId}` }, 'Keep or let go?'),
              h('a', { class: 'btn small ghost', href: `/today?${wsParam ? `ws=${encodeURIComponent(wsParam)}&` : ''}lock=${c.itemId}` }, 'Wear today'))));
      }))));

  view.append(
    h('div', { class: 'rail-head' },
      h('div', null, h('h1', { class: 'caps-title' }, 'My closet · Ledger')),
      h('div', { class: 'row' }, h('a', { class: 'btn small', href: '/app' }, '+ Add from a photo'), switcher)),
    L ? assetBoard(L, { sampleCloset: !wsParam }) : null,
    h('section', { class: 'panel' }, table));
}

async function closet3dScreen(view) {
  // ?ws=owner / personal / account (or active session preference after scanning/signing in) opens the user's own wardrobe; otherwise sample closet.
  const rawWs = new URLSearchParams(location.search).get('ws');
  if (rawWs === 'sample') setPreferOwner(false);
  const savedPersonal = activePersonalWs();
  let wsParam = rawWs && rawWs !== 'sample'
    ? rawWs
    : ((ACCT && ACCT.signedIn && ACCT.workspaceId) ? ACCT.workspaceId : (preferOwner() ? (savedPersonal || 'owner') : null));
  let id;
  let v;
  let ownerCount = 0;
  const probeWs = savedPersonal || 'owner';
  try {
    const or = await fetch(`/api/ws/${encodeURIComponent(probeWs)}/view`, { headers: authHeaders() });
    if (or.ok) {
      const ov = await or.json();
      ownerCount = (ov.items || []).filter((i) => !i.sample).length;
      if (wsParam === probeWs && (rawWs === probeWs || ownerCount > 0 || (ACCT && ACCT.signedIn && probeWs === ACCT.workspaceId))) {
        id = probeWs;
        v = ov;
      } else if (!rawWs && wsParam === probeWs && ownerCount === 0 && !(ACCT && ACCT.signedIn)) {
        wsParam = null;
      }
    }
  } catch {}
  if (wsParam && !v) {
    chrome([]);
    const r = await fetch(`/api/ws/${encodeURIComponent(wsParam)}/view`, { headers: authHeaders() });
    if (!r.ok) { view.append(h('h1', null, 'Closet in 3D'), ownerBar(), h('p', { class: 'question' }, 'This wardrobe is private. Sign in above to open it.')); return; }
    id = wsParam;
    v = await r.json();
    ownerCount = (v.items || []).filter((i) => !i.sample).length;
    chrome([closetSwitchChip(true, ownerCount, wsParam)].filter(Boolean));
  } else if (wsParam && v) {
    chrome([closetSwitchChip(true, ownerCount, wsParam)].filter(Boolean));
  } else {
    chrome([...sampleChips(), closetSwitchChip(false, ownerCount, probeWs)].filter(Boolean));
    ({ id, view: v } = await closetWs());
  }
  // Photos this wardrobe was registered from: the public sample photos plus the owner's own uploads (fetched with the owner header).
  const photos = META.photos.slice();
  if (wsParam) {
    const own = await getJson(`/api/ws/${id}/photos`).catch(() => ({ photos: [] }));
    for (const p of own.photos || []) {
      const b = await fetch(`/api/ws/${id}/photo/${p.photoId}`, { headers: authHeaders() });
      if (b.ok) photos.push({ photoId: p.photoId, url: URL.createObjectURL(await b.blob()), mine: true });
    }
  }
  const cuts = {};
  for (const op of v.operations || []) {
    if (op.kind !== 'photo' || !op.cardItemIds) continue;
    const photo = photos.find((p) => p.photoId === op.photoId);
    for (const c of op.cards) {
      const itemId = op.cardItemIds[String(c.cardId)];
      if (itemId && c.mask && photo && !cuts[itemId]) cuts[itemId] = { url: photo.url, mask: c.mask, mine: !!photo.mine };
    }
  }
  const ledgerP = closetLedger(id);
  const review = await getJson(`/api/ws/${id}/review?window=60`);
  const L = await ledgerP;
  const { buildAnatomy, LAYER_LABEL, AVAILABILITY_LABEL, overlayRows } = await import('/static/anatomy.js');
  const three = await import('/static/closet3d.js').catch(() => null);
  const A = buildAnatomy(v.items, review.rows);
  const byId = Object.fromEntries(v.items.map((i) => [i.itemId, i]));
  const C = A.counts;
  // Four views of the same pieces: Rail (default), Items gallery (?view=items), Ledger (?view=ledger), and Walk-in 3D (?view=layers).
  const rawView = new URLSearchParams(location.search).get('view');
  const mode = rawView === 'layers' || rawView === 'items' || rawView === 'ledger' ? rawView : 'rail';
  const switcher = viewSwitch(mode, wsParam);
  const sharedCtx = { id, wsParam, v, review, A, byId, L, cuts, overlayRows, AVAILABILITY_LABEL, switcher };
  if (mode === 'rail') return railView(view, sharedCtx);
  if (mode === 'items') return itemsGalleryView(view, sharedCtx);
  if (mode === 'ledger') return ledgerTableView(view, sharedCtx);
  const overlay = assetOverlay(L, overlayRows);
  const host = h('div', { class: 'stage stage-luxe' }, overlay ? overlay.el : null);
  const panel = h('section', { class: 'panel', id: 'piece', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Tap a piece, or pick one from the list, to see what Closer records about it.'));
  const slider = h('input', { type: 'range', id: 'explode', min: '0', max: '100', value: '0', 'aria-label': 'Pull the layers apart' });
  const resetBtn = h('button', { type: 'button', class: 'btn small ghost', id: 'reset-view', onclick: () => { if (scene) scene.reset(); slider.value = '0'; } }, 'Reset view');
  const list = h('details', { class: 'panel', id: 'layer-list' }, h('summary', null, `List view · the same ${C.total} pieces`),
    A.layers.map((l) => [h('h3', null, `${l.label} · ${l.items.length}`),
      h('div', { class: 'chip-row' }, l.items.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => show(c.itemId) }, `${c.itemId} · ${itemName(byId[c.itemId])}${c.availability !== 'AVAILABLE' ? ` · ${AVAILABILITY_LABEL[c.availability] || c.availability}` : ''}`)))]));
  const avail = Object.entries(C.byAvailability).map(([k, n]) => h('span', { class: `chip${k === 'AVAILABLE' ? '' : ' warn'}` }, `${AVAILABILITY_LABEL[k] || k}: ${n}`));
  const nPhoto = Object.keys(cuts).length;
  const legend = h('section', { class: 'panel' },
    h('p', null, h('b', null, `${C.total} pieces`), ` · ${A.layers.map((l) => `${l.label.toLowerCase()} ${l.items.length}`).join(' · ')}`),
    h('div', { class: 'chip-row' }, avail, h('span', { class: 'chip legend-amber' }, `Amber outline: no confirmed wear in 60 days, enough days recorded: ${C.byReview.CANDIDATE || 0}`)),
    h('p', { class: 'muted' }, nPhoto
      ? `${nPhoto} of ${C.total} pieces show the photo they were registered from, cut out by its mask. The rest are drawn by code.`
      : 'Every card here is drawn by code. A piece registered from a photo shows that photo, cut out by its mask.'),
    h('p', { class: 'muted' }, wsParam ? 'Same pieces and states as My wardrobe (/app); this view computes nothing else.' : A.note),
    L && L.lines && L.withEvidence ? h('p', { class: 'muted' }, `${wsParam ? 'Prices here come from this wardrobe\'s ledger.' : 'Prices here come from the closet ledger, the same numbers My closet shows.'} ${L.lines.evidence} ${L.note}`) : null);
  // Outfit tray: pick any piece, one per layer; picking another piece on the same layer replaces it.
  const outfit = {};
  const tray = h('section', { class: 'panel', id: 'outfit', 'aria-live': 'polite' });
  function paintTray() {
    const ids = A.layers.map((l) => outfit[l.slot]).filter(Boolean);
    if (scene) scene.setPicked(ids);
    tray.replaceChildren(...[h('h2', null, 'Outfit you are putting together'),
      ids.length ? h('div', { class: 'chip-row' }, ids.map((x) => h('button', { type: 'button', class: 'chip accent', onclick: () => show(x) }, `${x} · ${itemName(byId[x])}`))) : h('p', { class: 'muted' }, 'Tap a piece, then "Add to outfit". Any piece, one per layer.'),
      ids.length ? h('div', { class: 'row' },
        h('a', { class: 'btn small', href: wsHref('/today', wsParam, { lock: ids.join(',') }) }, `Wear these today (${ids.join(' + ')})`),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { for (const k of Object.keys(outfit)) delete outfit[k]; paintTray(); } }, 'Clear')) : null].filter(Boolean));
  }
  view.append(h('div', { class: 'rail-head' }, h('h1', null, 'Closet in 3D'), switcher),
    h('p', { class: 'lede' }, 'Your closet by layer: outerwear rail, tops, bottoms, shoes. Drag sideways to turn it, slide to pull the layers apart, tap a piece.'),
    host, h('p', { class: 'muted hint' }, 'Drag sideways to turn · tap a piece for its record'),
    h('div', { class: 'row explode-row' }, h('label', { for: 'explode' }, 'Pull the layers apart'), slider, resetBtn), panel, tray, legend, list);
  // On a phone a card is about 45 px wide on screen, so only the ID is drawn on it; the tap panel carries the name.
  const phone = window.matchMedia('(max-width: 760px)').matches;
  const scene = three ? three.mountCloset3d(host, A, { colorOf: rgbOf, nameOf: (c) => (phone ? '' : itemName(byId[c.itemId])), onPick: (c) => show(c.itemId), imageOf: (c) => (cuts[c.itemId] ? cutCanvasReady(cuts[c.itemId]) : null),
    tags: L ? L.tags : null, money, overlay: overlay ? overlay.el : null, label: `Closet in 3D: ${C.total} pieces on four layers.${overlay ? ` ${overlay.text}` : ''}` }) : null;
  paintTray();
  if (!scene) { host.replaceWith(h('p', { class: 'chip warn' }, 'This browser has no WebGL, so the 3D view is off. The same pieces are in the list below.')); list.open = true; }
  slider.addEventListener('input', (e) => { if (scene) scene.setExplode(Number(e.target.value) / 100); });

  async function show(itemId) {
    if (scene) scene.select(itemId);
    const cell = A.layers.flatMap((l) => l.items).find((c) => c.itemId === itemId);
    const it = byId[itemId];
    if (!cell || !it) return;
    const inOutfit = outfit[cell.slot] === itemId;
    const facts = h('ul', { class: 'reasons' },
      h('li', null, `${LAYER_LABEL[cell.slot]} · ${FORMALITY_LABEL[it.formality] || it.formality}`),
      h('li', null, cuts[itemId] ? `Shown from ${cuts[itemId].mine ? 'your photo' : 'a sample photo'}, cut out by its mask` : 'Drawn by code: no photo registered for this piece'),
      h('li', null, AVAILABILITY_LABEL[cell.availability] || cell.availability),
      h('li', null, cell.wearLabel || 'no confirmed wear yet'),
      cell.lastWorn ? h('li', null, `Last confirmed wear: ${cell.lastWorn}`) : null,
      cell.reviewLine ? h('li', null, cell.reviewLine) : null);
    const evidence = h('div', null, h('p', { class: 'muted' }, 'Loading price evidence…'));
    panel.replaceChildren(h('h2', null, `${itemId} · ${itemName(it)}`), facts, h('h3', null, 'Price evidence'), evidence,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: `btn small${inOutfit ? ' ghost' : ''}`, onclick: () => { if (inOutfit) delete outfit[cell.slot]; else outfit[cell.slot] = itemId; paintTray(); show(itemId); } }, inOutfit ? 'Remove from outfit' : 'Add to outfit'),
        h('a', { class: 'btn small ghost', href: wsHref('/today', wsParam, { lock: itemId }) }, 'Wear it today'),
        h('a', { class: 'btn small ghost', href: wsHref('/closet', wsParam, { decide: itemId }) }, 'Keep or let go?'),
        h('a', { class: 'btn small ghost', href: wsHref('/closet', wsParam) }, 'Review in My closet')));
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const m = await getJson(`/api/ws/${id}/market/${itemId}`);
    const cards = (m && m.cards ? m.cards : []).filter((c) => c.entries.length);
    const fmt = (e) => money(e.amount, e.currency);
    evidence.replaceChildren(cards.length
      ? h('ul', { class: 'reasons' }, cards.flatMap((c) => c.entries.map((e) => h('li', null, `${c.info.name} · ${fmt(e)} · ${e.priceType === 'ASK' ? 'asking' : 'traded'} · ${e.retrievedAt}`, e.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null))))
      : h('p', { class: 'muted' }, 'No price evidence yet. Prices come only from what you enter, one platform at a time.'),
      h('p', { class: 'muted' }, `Per platform, never averaged. What you would receive stays unknown until every fee is checked${wsParam ? '' : ' in My closet'}.`));
  }
}

(async function main() {
  const [metaRes, acctRes] = await Promise.all([
    getJson('/api/photos'),
    getJson('/api/account').catch(() => ({ ok: true, signedIn: false })),
  ]);
  META = metaRes;
  if (acctRes && typeof acctRes === 'object') {
    ACCT = acctRes;
    if (ACCT.signedIn && ACCT.workspaceId) setPersonalWsId(ACCT.workspaceId);
  }
  document.body.append(tabbar());
  const view = $('#view');
  const p = location.pathname;
  if (p === '/') await landingScreen(view);
  else if (p === '/try') await tryScreen(view);
  else if (p === '/app') await appScreen(view);
  else if (p === '/w/demo-rc1') await demoScreen(view);
  else if (p === '/admin') await adminScreen(view);
  else if (p === '/version') await versionScreen(view);
  else if (p === '/today') await todayScreen(view);
  else if (p === '/closet') await closetScreen(view);
  else if (p === '/closet/3d') await closet3dScreen(view);
  else if (p === '/discover') await discoverScreen(view);
  // Value line first: the chip row and the banner sit under the h1 and lede; the build line is a footer.
  const anchor = view.querySelector('.lede') || view.querySelector('.rail-head') || view.querySelector('h1');
  if (anchor) anchor.after($('#chips'), $('#banner'));
  view.after(h('p', { class: 'muted build' }, META.buildChip));
  document.body.dataset.ready = '1';
})();
