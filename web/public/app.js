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
function authHeaders(extra) { const t = ownerToken(); return Object.assign({}, extra || {}, t ? { 'x-admin-token': t } : {}); }
const getJson = async (url, headers) => (await fetch(url, { headers: authHeaders(headers) })).json();
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}) });
  return r.json();
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
function placeholder(color) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 60 80');
  svg.setAttribute('width', '60');
  svg.setAttribute('height', '80');
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
function thumb(item, cuts) {
  if (!item) return h('div', { class: 'muted' }, '—');
  return cuts[item.itemId] ? cutCanvas(cuts[item.itemId]) : placeholder(item.color);
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

// ---------- decision component (Try and App) ----------
function decisionUI(root, cfg) {
  const S = { wsId: cfg.wsId, view: null, photoId: 'p1', chipId: 'c1', sentence: '', flash: [], busy: false, painted: new Set(), answers: {}, ran: false };

  async function refresh() {
    if (S.wsId) S.view = await getJson(`/api/ws/${S.wsId}/view`);
    if (S.wsId && !cfg.visitor && !cfg.readOnly) await listUploads();
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

  async function run() {
    await busy(async () => {
      if (cfg.visitor) {
        const t = await postJson('/api/try/start', { photoId: S.photoId });
        S.wsId = t.workspaceId;
      }
      S.flash = [];
      S.answers = {};
      const own = !cfg.visitor && S.sentence.trim();
      const op = await postJson(`/api/ws/${S.wsId}/photo`, own ? { photoId: S.photoId, sentence: S.sentence.trim() } : { photoId: S.photoId, chipId: S.chipId });
      if (op.ok === false) flash({ chip: errWords(op.code, op.detail), cls: 'bad' });
      S.ran = true;
    }, '#decision');
  }

  function inputs() {
    const photos = h('div', { class: 'photos' }, META.photos.map((p) =>
      h('button', { class: 'photo-pick', type: 'button', 'aria-pressed': String(S.photoId === p.photoId), onclick: () => { S.photoId = p.photoId; render(); } },
        h('img', { src: p.url, alt: `${p.title}${p.mine ? ', your photo' : ', sample photo'}` }),
        h('div', { class: 'cap' }, `${p.title}`),
        p.mine ? h('span', { class: 'chip accent' }, 'Your photo') : null)));
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic', capture: 'environment', id: 'upload-file', hidden: true, onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await busy(async () => {
        try {
          const { jpeg, png } = await prepareUpload(f);
          const r = await postJson(`/api/ws/${S.wsId}/upload`, { jpegBase64: jpeg.url.split(',')[1], pngBase64: png.url.split(',')[1] });
          if (r.ok === false) { flash({ chip: errWords(r.code, r.detail), cls: 'bad' }); return; }
          META.photos.unshift({ photoId: r.photoId, title: 'Your photo', url: jpeg.url, w: r.w, h: r.h, count: 0, mine: true });
          S.photoId = r.photoId;
          flash({ chip: 'Photo saved on your server (EXIF removed). Delete it any time.', cls: 'ok' });
        } catch (err) { flash({ chip: errWords('UNSUPPORTED_IMAGE', err && err.message ? err.message : 'could not read the photo'), cls: 'bad' }); }
      });
    } });
    const sentences = h('div', { class: 'sentences' }, META.chips.map((c) =>
      h('button', { class: 'sentence', type: 'button', 'aria-pressed': String(S.chipId === c.chipId), onclick: () => { S.chipId = c.chipId; render(); } }, `“${c.text}”`)));
    return h('div', { class: 'grid cols-2' },
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '1'), cfg.visitor ? 'Pick a sample outfit' : 'Outfit photo'),
        cfg.visitor ? null : h('div', { class: 'row', style: 'margin-bottom:10px' }, fileInput,
          h('button', { class: 'btn ghost small', type: 'button', id: 'upload', disabled: S.busy || !S.wsId ? true : null, onclick: () => fileInput.click() }, 'Upload or take a photo'),
          (META.photos.find((p) => p.photoId === S.photoId) || {}).mine ? h('button', { class: 'btn ghost small', type: 'button', id: 'photo-delete', disabled: S.busy ? true : null, onclick: () => busy(async () => {
            const photoId = S.photoId;
            const r = await postJson(`/api/ws/${S.wsId}/photodelete`, { photoId });
            if (!r.ok) { flash({ chip: 'Could not delete this photo', cls: 'bad' }); return; }
            META.photos.splice(META.photos.findIndex((p) => p.photoId === photoId), 1);
            S.photoId = META.photos.length ? META.photos[0].photoId : null;
            flash({ chip: 'Photo deleted from your server: JPEG, pixel copy and metadata.', cls: 'ok' });
          }) }, 'Delete this photo') : null,
          h('span', { class: 'muted' }, 'Reading your own photo needs real mode (a Meta key on the server). Mock mode reads the sample photos only.')),
        photos),
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '2'), 'Pick a sentence'),
        h('p', { class: 'muted' }, cfg.visitor ? 'Fixed sentences only. Free text and visitor photos are off on this page.' : 'Pick one, or write your own (your wardrobe only).'),
        sentences,
        cfg.visitor ? null : h('textarea', { id: 'own-sentence', rows: '2', class: 'draft', maxlength: '200', placeholder: 'Or write your own: Keep this jacket. The rest feels too dressed-up.', oninput: (e) => { S.sentence = e.target.value; } }, S.sentence),
        h('div', { class: 'spacer' }),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', id: 'run', disabled: S.busy, onclick: run }, S.busy ? 'Working…' : 'Find the pieces'),
          cfg.visitor ? h('span', { class: 'muted' }, 'Each run uses a fresh copy of the sample wardrobe.') : null)));
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
        id ? thumb(it, cuts) : null,
        h('div', { class: 'lbl' }, id ? `${id} · ${it ? it.type.replace('_', ' ') : ''}` : `no ${s}`));
    }));
  }

  function stage(op) {
    const canvas = h('canvas', { id: 'stage', 'data-painted': '0' });
    const photo = META.photos.find((p) => p.photoId === op.photoId);
    (async () => {
      const img = await loadImage(photo.url);
      canvas.width = photo.w;
      canvas.height = photo.h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.font = 'bold 44px system-ui, sans-serif';
      for (const c of op.cards) {
        const b = c.box;
        ctx.lineWidth = 7;
        ctx.setLineDash(c.offender ? [26, 16] : []);
        ctx.strokeStyle = c.offender ? '#c0392b' : c.pinned ? '#2d4a7a' : 'rgba(0,0,0,0.45)';
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        ctx.setLineDash([]);
        const tag = `${c.cardId}${c.pinned ? ' · keep' : ''}${c.offender ? ' · feels off' : ''}`;
        const w = ctx.measureText(tag).width + 24;
        ctx.fillStyle = c.offender ? '#c0392b' : c.pinned ? '#2d4a7a' : 'rgba(0,0,0,0.6)';
        ctx.fillRect(b.x1, Math.max(0, b.y1 - 58), w, 56);
        ctx.fillStyle = '#fff';
        ctx.fillText(tag, b.x1 + 12, Math.max(44, b.y1 - 14));
      }
      const order = op.cards.filter((c) => c.mask).sort((a, b) => a.arrival - b.arrival);
      const animate = !S.painted.has(op.operationId);
      S.painted.add(op.operationId);
      for (const c of order) {
        if (animate) await sleep(380);
        const path = maskPath(c.mask);
        ctx.fillStyle = 'rgba(255, 200, 60, 0.22)';
        ctx.fill(path);
        ctx.save();
        ctx.clip(path);
        ctx.strokeStyle = 'rgba(255, 170, 0, 0.9)';
        ctx.lineWidth = 3;
        for (let k = -c.mask.h; k < c.mask.w; k += 28) {
          ctx.beginPath();
          ctx.moveTo(c.mask.x + k, c.mask.y + c.mask.h);
          ctx.lineTo(c.mask.x + k + c.mask.h, c.mask.y);
          ctx.stroke();
        }
        ctx.restore();
      }
      canvas.dataset.painted = '1';
    })();
    return h('div', { class: 'stage' }, canvas);
  }

  function cardsView(op) {
    const confirmed = Object.keys(op.cardItemIds || {}).length > 0;
    return h('div', { class: 'cards' }, op.cards.map((c) => {
      const q = !confirmed && c.question;
      const chosen = S.answers[c.cardId];
      return h('div', { class: `card${c.offender ? ' offender' : ''}${c.pinned ? ' pinned' : ''}` },
        h('div', { class: 'hd' }, h('span', null, `Card ${c.cardId}${confirmed ? ` → ${op.cardItemIds[String(c.cardId)]}` : ''}`), h('span', { class: 'chip' }, c.slot)),
        h('div', { class: 'attrs' },
          h('span', null, c.type.replace('_', ' ')),
          h('span', null, h('span', { class: 'swatch', style: `background:${rgbOf(c.sparkColor)}` }), `Model says: ${c.sparkColor}`),
          c.maskColor ? h('span', null, h('span', { class: 'swatch', style: `background:${rgbOf(c.maskColor)}` }), `Mask pixels say: ${c.maskColor}`) : h('span', { class: 'muted' }, 'no mask'),
          h('span', null, FORMALITY_LABEL[c.formality] || c.formality),
          h('span', null, c.pinned ? h('span', { class: 'chip accent' }, 'keep') : null, c.offender ? h('span', { class: 'chip bad' }, 'feels off') : null)),
        q ? h('div', { class: 'question' }, `? ${q.text}`, h('div', { class: 'row', style: 'margin-top:6px' }, q.choices.map((ch) =>
          h('button', { class: 'btn small ghost', type: 'button', 'aria-pressed': String(chosen === ch), onclick: () => { S.answers[c.cardId] = ch; render(); } }, ch)))) : null);
    }));
  }

  async function confirm(op) {
    await busy(async () => {
      const eventIds = op.cards.map(() => uuid());
      const answers = {};
      for (const [k, v] of Object.entries(S.answers)) answers[k] = { color: v };
      const r = await saveFlow(S.wsId, 'confirm', { operationId: op.operationId, eventIds, expectedRevision: S.view.revision, answers },
        (v) => op.cards.every((c) => v.items.some((it) => it.cutoutRef === `${op.operationId}#${c.cardId}` && it.ownership === 'CONFIRMED')),
        `${op.cards.length} pieces saved · checked against the server`);
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
      S.flash = r.ok === false ? [{ chip: errWords(r.code, r.detail), cls: 'bad' }] : [{ chip: META.labels.demoClockPlusOne, cls: 'warn' }];
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
      parts.push(h('div', { class: 'grid cols-2' }, stage(op), h('div', null, cardsView(op),
        !op.context ? h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn', id: 'confirm', type: 'button', disabled: S.busy || op.cards.some((c) => c.question && !S.answers[c.cardId]), onclick: () => confirm(op) }, `Confirm ${op.cards.length} cards`),
          h('span', { class: 'muted' }, 'Nothing is saved until you confirm.')) : null,
        op.context && op.state === 'DRAFT' ? h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', id: 'propose', type: 'button', disabled: S.busy, onclick: () => propose(op) }, 'Suggest changes')) : null)));
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
      parts.push(h('div', { class: 'options', id: 'options' },
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
        p.state === 'WORN' ? h('button', { class: 'btn ghost', id: 'next', type: 'button', onclick: () => next(p) }, `Next plan · ${META.labels.demoClockPlusOne}`) : null,
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
    h('p', { class: 'lede' }, 'Today’s outfit from clothes you own. Only confirmed wears count. Closer never posts or pays.'),
    h('div', { class: 'row', style: 'margin: 0 0 16px' }, h('a', { class: 'btn', href: '/today', id: 'start' }, 'Start with today'), h('a', { class: 'muted', href: '/try', id: 'try-link' }, 'Try three sample photos')),
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
    const pieces = (v.items || []).map((it) => ({ itemId: it.itemId, slot: it.slot, type: it.type, rgb: (META.palette && META.palette[it.color]) || null, availability: it.availability || 'AVAILABLE', photo: null }));
    const rail = mod.mountRail3d(slot, pieces, { tags: L ? L.tags : null, money, onPick: (itemId) => { location.href = `/closet?decide=${encodeURIComponent(itemId)}`; }, label: `This closet on a rail: ${pieces.length} pieces. Tap one for its keep-or-let-go question.` });
    if (!rail) slot.remove();
  } catch {
    slot.remove();
  }
}

async function tryScreen(view) {
  chrome([h('span', { class: 'chip sample' }, 'Sample photos · drawn by code · demo')]);
  view.append(h('h1', null, 'Try it on three sample outfits'),
    h('p', { class: 'lede' }, 'Pick one outfit photo and one fixed sentence. Closer keeps the piece you want, changes only what feels off, and saves nothing until you confirm.'));
  const root = h('div');
  view.append(root);
  const ui = decisionUI(root, { wsId: null, visitor: true });
  // Banner before the first run: describe a fresh visitor copy.
  const vb = await getJson('/api/banner/visitor');
  showBanner({ ...vb, ifLive: vb.ifLive || `If live: ${META.labels.replayAndLedger} (visitor cap $0 by default)` });
  ui.render();
}

async function appScreen(view) {
  chrome([h('span', { class: 'chip sample' }, 'Sample photos · drawn by code')]);
  view.append(h('h1', null, 'My wardrobe'), ownerBar(), h('p', { class: 'lede' }, 'Owner view of the same loop. In real mode, sign in with the owner token first. Photos are stored only on your server. A reading sends the photo to the Meta Model API (to muse-spark-1.3, to sam-3.1, and mask cut-outs of it to the edit step), each request with store:false; Closer keeps no copy elsewhere. Delete any photo at any time.'));
  const probe = await fetch('/api/ws/owner/view', { headers: authHeaders() });
  if (probe.status === 403) { view.append(h('p', { class: 'question' }, 'This wardrobe is private. Sign in with the owner token above.')); return; }
  const root = h('div');
  view.append(h('p', null, h('a', { class: 'btn small ghost', href: '/closet/3d?ws=owner' }, 'See my wardrobe in 3D')), root);
  const ui = decisionUI(root, { wsId: 'owner', visitor: false });
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
      h('dt', null, 'built at'), h('dd', null, v.builtAt),
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

async function closetWs() {
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
  const tabs = [['/today', 'Today'], ['/closet', 'My closet'], ['/discover', 'Discover'], ['/try', 'Photo']];
  const on = (href) => (href === '/closet' ? location.pathname.startsWith('/closet') : location.pathname === href);
  return h('nav', { class: 'tabbar', 'aria-label': 'Sections' }, tabs.map(([href, label]) => h('a', { href, class: on(href) ? 'on' : null, 'aria-current': on(href) ? 'page' : null }, label)));
}

/** One merged chip for the sample closet pages (the owner's real wardrobe shows none). */
function sampleChips() {
  return [h('span', { class: 'chip sample' }, 'Sample closet · synthetic wear history · demo')];
}

function tile(it, opts = {}) {
  return h('div', { class: `cell${opts.changed ? ' changed' : ''}${opts.empty ? ' empty' : ''}` }, it ? placeholder(it.color) : h('span', { class: 'muted' }, '—'), h('span', { class: 'lbl' }, it ? `${it.itemId} · ${itemName(it)}` : opts.label || 'none'), opts.badge ? h('span', { class: 'chip accent' }, opts.badge) : null);
}

async function todayScreen(view) {
  chrome(sampleChips());
  const { id, view: v } = await closetWs();
  const params = new URLSearchParams(location.search);
  const known = new Set(v.items.map((i) => i.itemId));
  // ?lock=J1,B2 comes from Discover, My closet, the keep-or-let-go question and the 3D tray: only pieces of this closet count.
  const wanted = (params.get('lock') || '').split(',').filter((x) => known.has(x));
  const S = { locks: new Set(wanted), direction: 'none', rain: false, op: null, msg: null, saved: null, picked: null, gridOpen: false, view: v };
  const byId = () => Object.fromEntries(S.view.items.map((i) => [i.itemId, i]));
  const root = h('div');
  view.append(h('h1', null, 'What do you want to wear today?'),
    h('p', { class: 'lede' }, wanted.length ? `Keeping ${wanted.join(' + ')}, as you picked; Closer completes the rest from what you own and have available.` : 'Keep the piece you want; Closer completes the rest from what you own and have available.'), root);

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
    const grid = h('div', { class: 'wardrobe' }, S.view.items.map((it) => {
      const on = S.locks.has(it.itemId);
      const avail = it.availability;
      return h('button', { type: 'button', class: `item pickable${on ? ' locked' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => { on ? S.locks.delete(it.itemId) : S.locks.add(it.itemId); S.op = null; S.saved = null; render(); } },
        h('div', { class: 'thumb' }, placeholder(it.color)),
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
      h('p', { class: 'muted' }, 'Examples in English or Korean. Tap one to try it:'),
      h('div', { class: 'chip-row' }, examples.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => say(c) }, c))),
      box, h('button', { class: 'btn small', type: 'button', id: 'say-go', onclick: () => box.value.trim() && say(box.value) }, 'Go'),
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
          h('div', { class: 'row' }, (q ? q.choices : []).map((c) => c === 'discover' ? h('a', { class: 'btn ghost', href: '/discover' }, 'Open Discover')
            : items[c] ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => { S.locks = new Set([c]); run(); } }, `${c} · ${itemName(items[c])}`)
            : h('span', { class: 'chip' }, c))), flashAt('top')));
      } else {
        parts.push(h('section', { class: 'panel' }, h('h2', null, `${op.options.length === 1 ? 'One outfit' : 'Two outfits'} with what you kept`),
          flashAt('top'),
          h('div', { class: 'options' }, op.options.map((o, i) => h('div', { class: `option${S.picked === i ? ' picked' : ''}` }, h('h3', null, o.label),
            h('div', { class: 'flatlay' }, SLOTS.map((s) => tile(items[o.outfit[s]], { label: s, empty: !o.outfit[s], badge: S.locks.has(o.outfit[s]) ? 'kept' : null }))),
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
    if (S.worn) parts.push(h('section', { class: 'panel' }, h('h2', null, 'Recorded'), h('p', null, 'This outfit now counts as worn today.'), h('a', { class: 'btn ghost', href: '/closet' }, 'See My closet')));
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
  const { id, view: v } = await closetWs();
  const S = { window: 60, review: null, open: null, market: null, draft: null, msg: null, coverage: null, chartRange: {}, chartPick: null, items: Object.fromEntries(v.items.map((i) => [i.itemId, i])) };
  const root = h('div');
  const boardSlot = h('div', { id: 'asset-slot' });
  view.append(h('h1', null, 'My closet'),
    h('p', { class: 'lede' }, 'Pieces with no confirmed wear in the window you choose; days without a record count as unknown.'),
    boardSlot, root);
  /** The asset board above the review window, read again after every load, saved price and saved position. */
  async function paintBoard() {
    let L = null;
    try { L = await getJson(`/api/ws/${id}/ledger`); } catch { L = null; }
    boardSlot.replaceChildren(...[assetBoard(L), h('p', { class: 'asset-after' }, h('a', { class: 'btn small ghost', href: '/closet/3d', id: 'see-3d' }, 'See it in 3D'))].filter(Boolean));
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
    if (action === 'restyle') { location.href = `/today?lock=${itemId}`; return; }
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
    if (choice === 'WEAR_ONCE') { location.href = `/today?lock=${D.itemId}`; return; }
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
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, `Keep or let go? · ${D.itemId} · ${itemName(S.items[D.itemId])}`), h('button', { type: 'button', class: 'btn small ghost', onclick: () => { S.decide = null; render(); } }, 'Close')),
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
    const cands = r.rows.filter((x) => x.status === 'CANDIDATE');
    const others = r.rows.filter((x) => x.status !== 'CANDIDATE');
    const actions = [['restyle', 'Wear it again'], ['keep', 'Keep it'], ['repair_check', 'Check repair'], ['sell_review', 'Look at selling'], ['donate_review', 'Look at donating']];
    const parts = [
      h('section', { class: 'panel' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Review window'), win),
        h('p', { class: 'muted' }, r.note),
        h('div', { class: 'row' }, Object.entries(r.counts).map(([k, n]) => h('span', { class: 'chip' }, k === 'CANDIDATE' ? `No confirmed wear in ${S.window} days: ${n}` : k === 'RECENT_WEAR' ? `Worn recently: ${n}` : `${k.toLowerCase().replace(/_/g, ' ')}: ${n}`)), coverageChips())),
      h('section', { class: 'panel' }, h('h2', null, `To look at (${cands.length})`),
        cands.length === 0 ? h('p', { class: 'muted' }, 'Nothing to look at in this window.') : null,
        h('div', { class: 'grid' }, cands.map((x) => h('div', { class: `item wide${S.open && S.open.itemId === x.itemId ? ' locked' : ''}` },
          h('div', { class: 'thumb' }, placeholder(S.items[x.itemId] ? S.items[x.itemId].color : 'unknown')),
          h('div', { class: 'meta' }, h('b', null, `${x.itemId} · ${itemName(S.items[x.itemId])}`), h('span', null, x.line),
            h('span', { class: 'muted' }, `Tracked since ${fmtDate(x.trackedSince)} · ${x.unrecordedDays} days without any record`),
            x.seasonHint ? h('span', { class: 'chip warn' }, x.seasonHint) : null,
            x.lastChoice ? h('span', { class: 'chip' }, `Last choice: ${x.lastChoice.action.replace('_', ' ')}`) : null,
            h('div', { class: 'row' },
              h('button', { class: 'btn small', type: 'button', onclick: () => openDecide(x.itemId) }, 'Keep or let go?'),
              actions.map(([a, l]) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => (a === 'keep' ? keep(x.itemId) : act(x.itemId, a)) }, l)))))))),
    ];
    parts.push(decidePanel());
    if (S.open && S.open.action === 'sell_review') parts.push(h('section', { class: 'panel', id: 'selling' }, h('h2', null, `Prices you saw for ${S.open.itemId}`), h('p', { class: 'muted' }, S.market ? S.market.note : ''), sellCharts(), evidenceForm(), calcPanel(), priceCards()));
    if (S.open && S.open.action === 'repair_check') parts.push(h('section', { class: 'panel' }, h('h2', null, `Repair check for ${S.open.itemId}`), h('p', { class: 'muted' }, 'Note what is wrong (fit, a broken zip, a stain) and ask a repair shop. Closer only keeps your note.')));
    parts.push(draftPanel());
    parts.push(h('details', { class: 'panel' }, h('summary', null, `Everything else (${others.length})`),
      h('table', { class: 't' }, h('tbody', null, others.map((x) => h('tr', null, h('td', { class: 'mono' }, x.itemId), h('td', null, x.status.toLowerCase().replace('_', ' ')), h('td', null, x.line),
        h('td', null, h('button', { class: 'btn small ghost', type: 'button', onclick: () => openDecide(x.itemId) }, 'Keep or let go?'))))))));
    if (S.msg && !S.msg.dataset.at) parts.push(h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, S.msg));
    keepFocus(root, () => root.replaceChildren(...parts.filter(Boolean)));
  }
  await load();
  const want = new URLSearchParams(location.search).get('decide');
  if (want && S.items[want]) await openDecide(want);
}

async function discoverScreen(view) {
  chrome(sampleChips());
  const { id, view: v } = await closetWs();
  const items = Object.fromEntries(v.items.map((i) => [i.itemId, i]));
  const L = await getJson('/api/looks');
  const S = { cat: 'wedding_guest', look: null, match: null, col: null, msg: null, hidden: new Set() };
  const root = h('div');
  view.append(h('h1', null, 'Discover looks'),
    h('p', { class: 'lede' }, 'Pick the looks you want; Closer counts how much of them your closet already covers.'), root);
  const lv = { SAME: ['ok', 'same'], SIMILAR: ['warn', 'similar'], NONE: ['bad', 'missing'] };
  const bx = { FILLED: ['filled', 'have it'], PARTIAL: ['partial', 'similar'], EMPTY: ['empty', 'missing'] };

  async function loadCollection() { S.col = await getJson(`/api/ws/${id}/collection`); }
  async function open(lookId) {
    S.look = lookId;
    S.match = await getJson(`/api/ws/${id}/look/${lookId}`);
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
      return h('section', { class: 'panel' }, h('h2', null, 'My style targets'),
        h('p', { class: 'muted' }, 'No targets yet. Tap "Add as target" on a look below. The match is a count on your closet, piece by piece; nothing is estimated.'));
    }
    const pctLabel = `${c.matched} of ${c.total} pieces · ${c.pct}%`;
    return h('section', { class: 'panel' }, h('h2', null, 'My style targets'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(c.pct), 'aria-label': pctLabel },
        h('div', { class: 'progress-fill', style: `width:${c.pct}%` })),
      h('p', null, h('b', null, pctLabel), ` · ${c.complete} of ${c.looks.length} target looks complete`),
      h('p', { class: 'muted' }, c.basis),
      h('h3', null, 'Item box'),
      h('div', { class: 'box' }, c.box.map((e) => h('div', { class: `box-cell ${bx[e.state][0]}` },
        placeholder(e.color), h('b', null, e.label),
        h('span', { class: `chip ${e.state === 'FILLED' ? 'ok' : e.state === 'PARTIAL' ? 'warn' : 'bad'}` }, e.itemId ? `${bx[e.state][1]} · ${e.itemId}` : bx[e.state][1]),
        h('span', { class: 'muted' }, `in ${e.lookIds.length} target look${e.lookIds.length === 1 ? '' : 's'}${e.state === 'EMPTY' && e.outfitsAdded !== null ? ` · adds ${e.outfitsAdded} complete outfits` : ''}`)))),
      c.nextUp.length ? h('p', { class: 'muted' }, `Fills the most target looks next: ${c.nextUp.map((e) => `${e.label} (${e.lookIds.length} look${e.lookIds.length === 1 ? '' : 's'})`).join(', ')}. Use a similar piece you own, or register a new one from a photo; the count moves only when the closet does.`) : null);
  }
  function render() {
    const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Occasion' }, L.categories.map((c) => h('button', { type: 'button', 'aria-pressed': S.cat === c.id ? 'true' : 'false', onclick: () => { S.cat = c.id; S.match = null; render(); } }, c.label)));
    const looks = L.looks.filter((l) => l.category === S.cat);
    const covOf = (lookId) => (S.col ? S.col.looks.find((x) => x.lookId === lookId) : null);
    const isTarget = (lookId) => !!(S.col && S.col.targets.includes(lookId));
    const parts = [targetsPanel(), h('section', { class: 'panel' }, h('div', { class: 'row' }, tabs), h('div', { class: 'spacer' }),
      h('div', { class: 'cards' }, looks.map((l) => {
        const cov = covOf(l.lookId);
        return h('div', { class: `card look${S.look === l.lookId ? ' pinned' : ''}` },
          h('button', { type: 'button', class: 'look-select', onclick: () => open(l.lookId) },
            h('div', { class: 'row' }, l.pieces.map((p) => placeholder(p.color))),
            h('div', { class: 'hd' }, l.title), h('div', { class: 'muted' }, `${l.credit} · ${l.note}`)),
          h('div', { class: 'row actions' },
            cov ? h('span', { class: `chip ${cov.coverage.missing === 0 ? 'ok' : 'accent'}` }, `${cov.coverage.matched}/${cov.coverage.total} · ${cov.coverage.pct}%`) : null,
            h('button', { type: 'button', class: `btn small${isTarget(l.lookId) ? '' : ' ghost'}`, 'aria-pressed': isTarget(l.lookId) ? 'true' : 'false', onclick: () => toggleTarget(l.lookId, !isTarget(l.lookId)) }, isTarget(l.lookId) ? 'Target · remove' : 'Add as target')));
      })))];
    const m = S.match;
    if (m && m.ok !== false) {
      const own = Object.values(m.ownOutfit);
      const pct = m.pieces.length ? Math.round((100 * m.reused) / m.pieces.length) : 0;
      parts.push(h('section', { class: 'panel' }, h('h2', null, `${m.title}: ${m.reused} of ${m.pieces.length} from your closet (${pct}%)`),
        h('table', { class: 't look' }, h('tbody', null, m.pieces.map((p) => h('tr', null,
          h('td', null, p.piece.label), h('td', null, h('span', { class: `chip ${lv[p.level][0]}` }, lv[p.level][1])),
          h('td', null, p.itemId ? `${p.itemId} · ${itemName(items[p.itemId])}` : '—'), h('td', { class: 'muted' }, p.why))))),
        h('div', { class: 'spacer' }),
        own.length ? h('a', { class: 'btn', href: `/today?lock=${own.join(',')}`, role: 'button' }, `Wear it with mine (${own.join(' + ')})`) : null));
      const gaps = m.gaps.filter((g) => !S.hidden.has(g.piece.label));
      if (gaps.length) parts.push(h('section', { class: 'panel' }, h('h2', null, 'Pieces you do not have'),
        h('div', { class: 'grid' }, gaps.map((g) => h('div', { class: 'card' },
          h('div', { class: 'hd' }, g.piece.label, placeholder(g.piece.color)),
          h('p', null, g.outfitsAdded > 0 ? `Adding it gives ${g.outfitsAdded} more complete outfits from this closet.` : 'It adds no new complete outfits to this closet.'),
          h('p', { class: 'muted' }, m.basis),
          h('div', { class: 'row' },
            g.alternatives.length ? h('a', { class: 'btn small ghost', href: `/today?lock=${[...own, g.alternatives[0]].join(',')}` }, `Use my ${g.alternatives[0]}`) : null,
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => { S.hidden.add(g.piece.label); S.msg = h('span', { class: 'chip' }, 'Hidden for this visit · nothing saved'); render(); } }, 'Hide for now'),
            h('button', { class: 'btn small', type: 'button', disabled: g.piece.shop.url ? null : true }, g.piece.shop.url ? 'Open product page' : 'No checked product link yet')))))));
      parts.push(h('details', { class: 'panel' }, h('summary', null, 'Buy the whole look instead'),
        h('ul', { class: 'reasons' }, m.fullLook.map((p) => h('li', null, `${p.label} · ${p.shop.url ? `${p.shop.match === 'SAME_ITEM' ? 'same item' : 'similar item'} · ${p.shop.price || 'price not checked'}` : 'no checked product link yet'}`))),
        h('p', { class: 'muted' }, 'Links open the shop. Closer does not fill a cart, pay, or check stock.')));
    }
    if (S.msg) parts.push(h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, S.msg));
    keepFocus(root, () => root.replaceChildren(...parts.filter(Boolean)));
  }
  await loadCollection();
  render();
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

/** Rail · Layers: a reload with or without ?view=layers, keeping ?ws= as it is. */
function viewSwitch(mode) {
  const go = (k) => {
    if (k === mode) return;
    const u = new URL(location.href);
    if (k === 'layers') u.searchParams.set('view', 'layers');
    else u.searchParams.delete('view');
    location.assign(u.pathname + u.search);
  };
  return h('div', { class: 'seg view-seg', role: 'group', 'aria-label': 'View' },
    [['rail', 'Rail'], ['layers', 'Layers']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': mode === k ? 'true' : 'false', onclick: () => go(k) }, l)));
}

/* The rail (11/5): every piece hung on one rail, shoes under it, a tag only where the ledger holds a price.
   Few words on screen: the count, one number per currency with its denominator, and the piece you tap. */
async function railView(view, ctx) {
  const { wsParam, A, byId, L, cuts, overlayRows, AVAILABILITY_LABEL, switcher } = ctx;
  const cells = A.layers.flatMap((l) => l.items);
  const pieces = cells.map((c) => ({ itemId: c.itemId, slot: c.slot, type: c.type, rgb: (META.palette && META.palette[c.color]) || null, availability: c.availability, photo: cuts[c.itemId] ? cutCanvasReady(cuts[c.itemId]) : null }));
  const rows = overlayRows(L);
  const hud = h('div', { class: 'rail-hud' },
    h('div', { class: 'rail-count' }, `${A.counts.total} pieces`),
    rows.length ? h('div', { class: 'rail-sum' }, rows.map((r) => h('div', { class: 'rail-cur' },
      h('span', { class: 'rail-num' }, money(r.total, r.currency)),
      h('span', { class: 'rail-of', title: r.seen }, `${r.pieces}/${r.of}`),
      r.sample ? h('span', { class: 'chip sample' }, 'Sample') : null))) : null);
  const host = h('div', { class: 'stage rail-stage' });
  const sheet = h('section', { class: 'panel rail-sheet', id: 'piece', 'aria-live': 'polite', hidden: true });
  const list = h('details', { class: 'panel', id: 'layer-list' }, h('summary', null, `List · ${A.counts.total}`),
    h('div', { class: 'chip-row' }, cells.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => { if (rail) rail.select(c.itemId); show(c.itemId); } }, `${c.itemId} · ${itemName(byId[c.itemId])}`))));
  view.append(h('div', { class: 'rail-head' }, h('h1', null, 'Closet in 3D'), switcher), hud, host, h('p', { class: 'muted hint' }, 'Drag to slide · tap a piece'), sheet, list);
  const said = rows.map((r) => `${money(r.total, r.currency)}${r.sample ? ' (sample)' : ''}, latest price seen on ${r.pieces} of ${r.of} pieces`).join('; ');
  const mod = await import('/static/rail3d.js').catch(() => null);
  const rail = mod ? mod.mountRail3d(host, pieces, { tags: L ? L.tags : null, money, onPick: show, label: `${A.counts.total} pieces on a rail.${said ? ` ${said}.` : ''}` }) : null;
  if (!rail) { host.replaceWith(h('p', { class: 'chip warn' }, 'No WebGL here, so the 3D view is off. The same pieces are in the list below.')); list.open = true; }

  function show(itemId) {
    const it = byId[itemId];
    const c = cells.find((x) => x.itemId === itemId);
    if (!it || !c) return;
    const t = L && L.tags ? L.tags[itemId] : null;
    sheet.hidden = false;
    sheet.replaceChildren(
      h('div', { class: 'rail-sheet-hd' }, h('b', null, `${itemId} · ${itemName(it)}`), c.availability !== 'AVAILABLE' ? h('span', { class: 'chip warn' }, AVAILABILITY_LABEL[c.availability] || c.availability) : null),
      t ? h('p', { class: 'rail-sheet-price' }, h('span', { class: 'rail-sheet-num' }, money(t.amount, t.currency)), ` ${String(t.platformName || t.platform).split(' (')[0]} · ${t.priceType === 'TRADE' ? 'traded' : 'asking'} `, t.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null)
        : h('p', { class: 'muted' }, 'No price yet'),
      h('p', { class: 'muted' }, c.wearLabel || 'No confirmed wear yet'),
      h('div', { class: 'row' },
        wsParam ? null : h('a', { class: 'btn small', href: `/closet?decide=${itemId}` }, 'Keep or let go?'),
        wsParam ? null : h('a', { class: 'btn small ghost', href: `/today?lock=${itemId}` }, 'Wear today'),
        h('a', { class: 'btn small ghost', href: `/closet/3d?${wsParam ? `ws=${encodeURIComponent(wsParam)}&` : ''}view=layers` }, 'Layers')));
    sheet.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

async function closet3dScreen(view) {
  // ?ws=owner opens the owner's own wardrobe (owner token required); otherwise this browser's sample closet.
  const wsParam = new URLSearchParams(location.search).get('ws');
  let id;
  let v;
  if (wsParam) {
    chrome([]);
    const r = await fetch(`/api/ws/${encodeURIComponent(wsParam)}/view`, { headers: authHeaders() });
    if (!r.ok) { view.append(h('h1', null, 'Closet in 3D'), ownerBar(), h('p', { class: 'question' }, 'This wardrobe is private. Sign in with the owner token above.')); return; }
    id = wsParam;
    v = await r.json();
  } else {
    chrome(sampleChips());
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
  // Two views of the same pieces: the rail (default) and the layers with the exploded view (?view=layers).
  const mode = new URLSearchParams(location.search).get('view') === 'layers' ? 'layers' : 'rail';
  const switcher = viewSwitch(mode);
  if (mode === 'rail') return railView(view, { wsParam, A, byId, L, cuts, overlayRows, AVAILABILITY_LABEL, switcher });
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
    h('p', { class: 'muted' }, A.note),
    L && L.lines && L.withEvidence ? h('p', { class: 'muted' }, `Prices here come from the closet ledger, the same numbers My closet shows. ${L.lines.evidence} ${L.note}`) : null);
  // Outfit tray: pick any piece, one per layer; picking another piece on the same layer replaces it.
  const outfit = {};
  const tray = h('section', { class: 'panel', id: 'outfit', 'aria-live': 'polite' });
  function paintTray() {
    const ids = A.layers.map((l) => outfit[l.slot]).filter(Boolean);
    if (scene) scene.setPicked(ids);
    tray.replaceChildren(...[h('h2', null, 'Outfit you are putting together'),
      ids.length ? h('div', { class: 'chip-row' }, ids.map((x) => h('button', { type: 'button', class: 'chip accent', onclick: () => show(x) }, `${x} · ${itemName(byId[x])}`))) : h('p', { class: 'muted' }, 'Tap a piece, then "Add to outfit". Any piece, one per layer.'),
      ids.length ? h('div', { class: 'row' },
        wsParam ? h('span', { class: 'muted' }, `Picked: ${ids.join(' + ')}. Use them as locks on My wardrobe.`) : h('a', { class: 'btn small', href: `/today?lock=${ids.join(',')}` }, `Wear these today (${ids.join(' + ')})`),
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
        wsParam ? null : h('a', { class: 'btn small ghost', href: `/today?lock=${itemId}` }, 'Wear it today'),
        wsParam ? null : h('a', { class: 'btn small ghost', href: `/closet?decide=${itemId}` }, 'Keep or let go?'),
        wsParam ? null : h('a', { class: 'btn small ghost', href: '/closet' }, 'Review in My closet')));
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const m = await getJson(`/api/ws/${id}/market/${itemId}`);
    const cards = (m && m.cards ? m.cards : []).filter((c) => c.entries.length);
    const fmt = (e) => money(e.amount, e.currency);
    evidence.replaceChildren(cards.length
      ? h('ul', { class: 'reasons' }, cards.flatMap((c) => c.entries.map((e) => h('li', null, `${c.info.name} · ${fmt(e)} · ${e.priceType === 'ASK' ? 'asking' : 'traded'} · ${e.retrievedAt}`, e.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null))))
      : h('p', { class: 'muted' }, 'No price evidence yet. Prices come only from what you enter, one platform at a time.'),
      h('p', { class: 'muted' }, 'Per platform, never averaged. What you would receive stays unknown until every fee is checked in My closet.'));
  }
}

(async function main() {
  META = await getJson('/api/photos');
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
