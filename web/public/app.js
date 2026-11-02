'use strict';
// Closer UI — five screens (/, /app, /w/demo-rc1, /admin, /version). No framework, no build step.
// Status labels come from result objects: a save label only after the fresh read-back matches.

const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
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
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('on', a.dataset.path === location.pathname);
  const row = $('#chips');
  row.replaceChildren(h('span', { class: 'chip accent' }, META.buildChip), h('span', { class: 'chip warn' }, META.labels.demoScenario), ...(extra || []));
}
function showBanner(b) {
  const el = $('#banner');
  if (!b) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `banner ${b.kind}`;
  el.replaceChildren(...[h('strong', null, b.text), b.capLine ? h('div', { class: 'sub' }, b.capLine) : null, b.ifLive ? h('div', { class: 'sub' }, b.ifLive) : null].filter(Boolean));
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
    return { ok: false, chip: resp.code === 'ALREADY_WORN' ? META.labels.alreadyRecorded : `${resp.code}${resp.detail ? ` · ${resp.detail}` : ''}`, cls: resp.code === 'ALREADY_WORN' ? 'warn' : 'bad', resp };
  }
  const view = await getJson(`/api/ws/${wsId}/view`);
  if (!matches(view)) return { ok: false, chip: 'READBACK_MISMATCH', cls: 'bad', view };
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
    render();
  }
  const flash = (r) => { S.flash = [r]; };
  const busy = async (fn) => { S.busy = true; render(); try { await fn(); } finally { S.busy = false; await refresh(); } };

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
      if (op.ok === false) flash({ chip: `${op.code} · ${op.detail}`, cls: 'bad' });
      S.ran = true;
    });
  }

  function inputs() {
    const photos = h('div', { class: 'photos' }, META.photos.map((p) =>
      h('button', { class: 'photo-pick', type: 'button', 'aria-pressed': String(S.photoId === p.photoId), onclick: () => { S.photoId = p.photoId; render(); } },
        h('img', { src: p.url, alt: `${p.title}${p.mine ? ', your photo' : ', sample photo'}` }),
        h('div', { class: 'cap' }, `${p.title}`),
        p.mine ? h('span', { class: 'chip accent' }, 'Your photo') : h('span', { class: 'chip sample' }, META.labels.samplePhoto))));
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic', capture: 'environment', id: 'upload-file', hidden: true, onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await busy(async () => {
        try {
          const { jpeg, png } = await prepareUpload(f);
          const r = await postJson(`/api/ws/${S.wsId}/upload`, { jpegBase64: jpeg.url.split(',')[1], pngBase64: png.url.split(',')[1] });
          if (r.ok === false) { flash({ chip: `${r.code} · ${r.detail}`, cls: 'bad' }); return; }
          META.photos.unshift({ photoId: r.photoId, title: 'Your photo', url: jpeg.url, w: r.w, h: r.h, count: 0, mine: true });
          S.photoId = r.photoId;
          flash({ chip: 'Photo saved on your server (EXIF removed). Delete it any time.', cls: 'ok' });
        } catch (err) { flash({ chip: `UNSUPPORTED_IMAGE · ${err && err.message ? err.message : 'could not read the photo'}`, cls: 'bad' }); }
      });
    } });
    const sentences = h('div', { class: 'sentences' }, META.chips.map((c) =>
      h('button', { class: 'sentence', type: 'button', 'aria-pressed': String(S.chipId === c.chipId), onclick: () => { S.chipId = c.chipId; render(); } }, `“${c.text}”`)));
    return h('div', { class: 'grid cols-2' },
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '1'), cfg.visitor ? 'Pick a sample outfit' : 'Outfit photo'),
        cfg.visitor ? null : h('div', { class: 'row', style: 'margin-bottom:10px' }, fileInput,
          h('button', { class: 'btn ghost small', type: 'button', id: 'upload', disabled: S.busy || !S.wsId ? true : null, onclick: () => fileInput.click() }, 'Upload or take a photo'),
          h('span', { class: 'muted' }, 'Reading your own photo needs real mode (a Meta key on the server). Mock mode reads the sample photos only.')),
        photos),
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '2'), 'Pick a sentence'),
        h('p', { class: 'muted' }, cfg.visitor ? 'Fixed sentences only. Free text and visitor photos are off on this page.' : 'Pick one, or write your own (your wardrobe only).'),
        sentences,
        cfg.visitor ? null : h('textarea', { id: 'own-sentence', rows: '2', class: 'draft', maxlength: '200', placeholder: 'Or write your own: Keep this jacket. The rest feels too dressed-up.', oninput: (e) => { S.sentence = e.target.value; } }, S.sentence),
        h('div', { class: 'spacer' }),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', id: 'run', disabled: S.busy, onclick: run }, S.busy ? 'Working…' : 'Run'),
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
          h('span', null, h('span', { class: 'swatch', style: `background:${rgbOf(c.sparkColor)}` }), `Spark: ${c.sparkColor}`),
          c.maskColor ? h('span', null, h('span', { class: 'swatch', style: `background:${rgbOf(c.maskColor)}` }), `Mask pixels: ${c.maskColor}`) : h('span', { class: 'muted' }, 'no mask'),
          h('span', null, `formality: ${c.formality}`),
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
        `+${op.cards.length} items · read back ✓`);
      flash(r);
    });
  }
  async function propose(op) {
    await busy(async () => {
      const r = await postJson(`/api/ws/${S.wsId}/propose`, { operationId: op.operationId });
      if (r.ok === false) flash({ chip: `${r.code} · ${r.detail}`, cls: 'bad' });
      else S.flash = [];
    });
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
    });
  }
  async function setAvail(item, state) {
    await busy(async () => {
      const r = await saveFlow(S.wsId, 'availability', { itemId: item.itemId, state, eventId: uuid(), expectedRevision: S.view.revision },
        (v) => v.items.some((i) => i.itemId === item.itemId && i.availability === state), `${item.itemId} → ${state.toLowerCase()} · read back ✓`);
      flash(r);
    });
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
        (v) => !v.wearRows.some((w) => w.eventId === wear.eventId), 'Wear undone · read back ✓');
      flash(r);
    });
  }
  async function next(plan) {
    await busy(async () => {
      await postJson('/api/demo-clock', { days: 1 });
      const r = await postJson(`/api/ws/${S.wsId}/next`, { fromPlanId: plan.planId });
      S.flash = r.ok === false ? [{ chip: `${r.code} · ${r.detail}`, cls: 'bad' }] : [{ chip: META.labels.demoClockPlusOne, cls: 'warn' }];
    });
  }

  function decisionPanel(op) {
    const cuts = cutMap(S.view);
    const items = itemsById();
    const stateCls = { PROPOSED: 'accent', LOCKED: 'ok', WORN: 'ok', HOLD: 'bad', NEEDS_REPLAN: 'warn', CANCELLED: 'bad', DRAFT: '' }[op.state] || '';
    const parts = [];
    parts.push(h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', { style: 'margin:0' }, op.kind === 'photo' ? 'Photo + sentence' : op.kind === 'replan' ? 'Button re-plan' : 'Next plan (no photo)'),
      h('span', { class: `chip ${stateCls}`, id: 'op-state' }, op.state)));
    if (op.sentence) parts.push(h('p', { class: 'muted' }, `“${op.sentence}”`));
    if (op.callLines.length) parts.push(h('ul', { class: 'calls', id: 'calls' }, op.callLines.map((l) => h('li', null, l))));
    else if (op.kind !== 'photo') parts.push(h('ul', { class: 'calls' }, h('li', null, 'model calls: 0')));
    const chips = [...op.labels.map((l) => h('span', { class: 'chip' }, l)), ...op.reasonCodes.map((c) => h('span', { class: 'chip bad' }, c))];
    if (chips.length) parts.push(h('div', { class: 'chip-row' }, chips));

    if (op.kind === 'photo' && op.cards.length) {
      parts.push(h('div', { class: 'grid cols-2' }, stage(op), h('div', null, cardsView(op),
        !op.context ? h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn', id: 'confirm', type: 'button', disabled: S.busy || op.cards.some((c) => c.question && !S.answers[c.cardId]), onclick: () => confirm(op) }, `Confirm ${op.cards.length} cards`),
          h('span', { class: 'muted' }, 'Nothing is saved until you confirm.')) : null,
        op.context && op.state === 'DRAFT' ? h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', id: 'propose', type: 'button', disabled: S.busy, onclick: () => propose(op) }, 'Propose edits')) : null)));
    }
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
          flatlay(o.outfit, o.changedSlots, cuts, items),
          o.reasonLines.length ? h('ul', { class: 'reasons' }, o.reasonLines.map((l) => h('li', null, l))) : null,
          op.state === 'PROPOSED' ? h('button', { class: 'btn small', type: 'button', 'data-pick': String(i), disabled: S.busy, onclick: () => pick(op, i) }, 'Pick this') : null))));
      if (op.state === 'PROPOSED' && op.kind !== 'replan') parts.push(h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => keep(op) }, 'Keep as is (separate button)')));
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
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, `Plan for ${p.occasionDate}`), h('span', { class: 'chip ok' }, p.state)),
      h('div', { class: 'spacer' }),
      h('div', { style: 'max-width:340px' }, flatlay(p.slots, [], cuts, items)),
      h('div', { class: 'row', style: 'margin-top:12px' },
        p.state === 'LOCKED' || p.state === 'WORN' ? h('button', { class: 'btn', id: 'wore', type: 'button', disabled: S.busy, onclick: () => wore(p) }, 'Wore it') : null,
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
          h('div', null, h('b', null, it.itemId), ` · ${it.type.replace('_', ' ')} · ${it.color} · ${it.formality}`),
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
async function tryScreen(view) {
  chrome([h('span', { class: 'chip sample' }, META.labels.samplePhoto)]);
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
  chrome([h('span', { class: 'chip sample' }, META.labels.samplePhoto)]);
  view.append(h('h1', null, 'My wardrobe'), ownerBar(), h('p', { class: 'lede' }, 'Owner view of the same loop. In real mode, sign in with the owner token first. Photos you upload stay on your server.'));
  const probe = await fetch('/api/ws/owner/view', { headers: authHeaders() });
  if (probe.status === 403) { view.append(h('p', { class: 'question' }, 'This wardrobe is private. Sign in with the owner token above.')); return; }
  const root = h('div');
  view.append(root);
  const ui = decisionUI(root, { wsId: 'owner', visitor: false });
  await ui.refresh();
}

async function demoScreen(view) {
  chrome();
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
        out.replaceChildren(h('span', { class: `chip ${r.ok ? 'ok' : 'bad'}` }, r.ok ? 'write accepted' : `${r.code} · ${r.detail}`));
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
  chrome();
  const v = await getJson('/api/version');
  view.append(h('h1', null, 'Version'),
    h('section', { class: 'panel' }, h('dl', { class: 'kv' },
      h('dt', null, 'sha'), h('dd', { class: 'mono', id: 'sha' }, v.sha),
      h('dt', null, 'built at'), h('dd', null, v.builtAt),
      h('dt', null, 'mode'), h('dd', null, v.mode),
      h('dt', null, 'runtime'), h('dd', null, `Node.js ${v.node}`),
      h('dt', null, '/w/demo-rc1 stateHash'), h('dd', { class: 'mono' }, v.demoRc1StateHash))),
    h('section', { class: 'panel' }, h('h2', null, 'Verify it yourself'),
      h('ol', null,
        h('li', null, 'Open /w/demo-rc1 and /version in a private window; compare stateHash and sha.'),
        h('li', null, 'Compare git rev-parse HEAD of the code you have with the sha above: same release.'),
        h('li', null, 'Turn K1 on in /admin and check that a button re-plan still works.'))));
}


// ---------- features 11/2: Today (keep this one) · Closet (60-day review) · Discover (looks) ----------
const TYPE_NAME = { jacket: 'jacket', coat: 'coat', dress_shirt: 'dress shirt', knit: 'knit', tee: 'T-shirt', trousers: 'trousers', jeans: 'jeans', chinos: 'chinos', derby: 'derby shoes', sneakers: 'sneakers', track_jacket: 'track jacket', blouse: 'blouse', training_top: 'training top', skirt: 'skirt', joggers: 'joggers', shorts: 'shorts', running_shoes: 'running shoes', loafers: 'loafers' };
const itemName = (it) => (it ? `${it.color !== 'unknown' ? `${it.color} ` : ''}${TYPE_NAME[it.type] || it.type}` : '');

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

function tabbar() {
  const tabs = [['/today', 'Today'], ['/closet', 'My closet'], ['/discover', 'Discover']];
  return h('nav', { class: 'tabbar', 'aria-label': 'Sections' }, tabs.map(([href, label]) => h('a', { href, class: location.pathname === href ? 'on' : null, 'aria-current': location.pathname === href ? 'page' : null }, label)));
}

function sampleChips() {
  return [h('span', { class: 'chip sample' }, 'Sample closet'), h('span', { class: 'chip sample' }, 'Synthetic wear history')];
}

function tile(it, opts = {}) {
  return h('div', { class: `cell${opts.changed ? ' changed' : ''}${opts.empty ? ' empty' : ''}` }, it ? placeholder(it.color) : h('span', { class: 'muted' }, '—'), h('span', { class: 'lbl' }, it ? `${it.itemId} · ${itemName(it)}` : opts.label || 'none'), opts.badge ? h('span', { class: 'chip accent' }, opts.badge) : null);
}

async function todayScreen(view) {
  chrome(sampleChips());
  document.body.append(tabbar());
  const { id, view: v } = await closetWs();
  const params = new URLSearchParams(location.search);
  const S = { locks: new Set((params.get('lock') || '').split(',').filter(Boolean)), direction: 'none', rain: false, op: null, msg: null, saved: null, view: v };
  const byId = () => Object.fromEntries(S.view.items.map((i) => [i.itemId, i]));
  const root = h('div');
  view.append(h('h1', null, 'What do you want to wear today?'),
    h('p', { class: 'lede' }, 'Tap the piece you want. Closer keeps it and completes the rest from what you own and have available. Nothing is saved until you pick.'), root);

  async function run() {
    S.msg = null;
    S.op = await postJson(`/api/ws/${id}/anchor`, { anchorItemIds: [...S.locks], direction: S.direction, rainPct: S.rain ? 80 : null });
    render();
  }
  async function say(sentence) {
    S.msg = null;
    S.saved = null;
    S.op = await postJson(`/api/ws/${id}/say`, { sentence });
    if (S.op && S.op.intent) {
      S.locks = new Set(S.op.intent.anchors);
      S.direction = S.op.intent.direction;
      S.rain = S.op.intent.rain;
    }
    render();
  }
  async function pick(i) {
    const before = S.view.revision;
    const r = await saveFlow(id, 'lock', { eventId: uuid(), expectedRevision: before, operationId: S.op.operationId, optionIndex: i },
      (vv) => vv.plans.some((p) => p.planId === S.op.planId && p.state === 'LOCKED' && sameOutfit(p.slots, S.op.options[i].outfit)), 'Saved and read back');
    if (r.view) S.view = r.view;
    S.saved = r.ok ? S.op.options[i].outfit : null;
    S.planId = r.ok ? S.op.planId : null;
    S.worn = false;
    S.msg = h('span', { class: `chip ${r.cls}` }, r.chip);
    render();
  }
  async function wore() {
    const planId = S.planId;
    const r = await saveFlow(id, 'wear', { eventId: uuid(), expectedRevision: S.view.revision, planId },
      (vv) => vv.wearRows.some((w) => w.planId === planId), 'Wear recorded and read back');
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
    if (!r.ok) { S.msg = h('span', { class: 'chip bad' }, `${r.code} · ${r.detail}`); render(); return; }
    S.msg = h('span', { class: 'chip warn' }, `${itemId} is in the laundry now. Your kept pieces stay; the rest is re-planned.`);
    S.saved = null;
    await run();
  }

  function render() {
    const items = byId();
    const grid = h('div', { class: 'wardrobe' }, S.view.items.map((it) => {
      const on = S.locks.has(it.itemId);
      const avail = it.availability;
      return h('button', { type: 'button', class: `item pickable${on ? ' locked' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => { on ? S.locks.delete(it.itemId) : S.locks.add(it.itemId); S.op = null; S.saved = null; render(); } },
        h('div', { class: 'thumb' }, placeholder(it.color)),
        h('div', { class: 'meta' }, h('b', null, `${it.itemId} · ${itemName(it)}`), h('span', null, `${it.formality} formality`),
          avail !== 'AVAILABLE' ? h('span', { class: 'chip warn' }, avail.toLowerCase()) : null,
          on ? h('span', { class: 'chip accent' }, 'Keep this today') : null));
    }));
    const dir = h('div', { class: 'seg', role: 'group', 'aria-label': 'Direction' }, [['none', 'As it is'], ['less_formal', 'More relaxed'], ['more_formal', 'Dressier']].map(([k, l]) =>
      h('button', { type: 'button', 'aria-pressed': S.direction === k ? 'true' : 'false', onclick: () => { S.direction = k; render(); } }, l)));
    const rain = h('label', { class: 'row muted' }, h('input', { type: 'checkbox', id: 'rain', checked: S.rain ? true : null, onchange: (e) => { S.rain = e.target.checked; render(); } }), 'Rain likely today (you tell Closer; no weather service)');
    const box = h('textarea', { id: 'say', rows: '2', class: 'draft', placeholder: '오늘 이 네이비 재킷 입을 건데 좀 편하게 / Keep the navy jacket, more relaxed' });
    const sayPanel = h('section', { class: 'panel' }, h('h2', null, 'Say it'),
      h('div', { class: 'chip-row' }, (META.intentChips || []).map((c) => h('button', { type: 'button', class: 'chip', onclick: () => say(c) }, c))),
      box, h('button', { class: 'btn small', type: 'button', id: 'say-go', onclick: () => box.value.trim() && say(box.value) }, 'Read my sentence'),
      S.op && S.op.intent ? h('div', { class: 'row' }, h('span', { class: 'chip accent' }, `Understood: keep ${S.op.intent.anchors.join(' + ')}${S.op.intent.direction !== 'none' ? ` · ${S.op.intent.direction.replace('_', ' ')}` : ''}${S.op.intent.rain ? ' · rain' : ''}`)) : null,
      S.op && (S.op.labels || []).length ? h('p', { class: 'muted' }, S.op.labels.join(' · ')) : null);
    const parts = [
      sayPanel,
      h('section', { class: 'panel' }, h('h2', null, 'Or tap what you want to keep'), grid),
      h('section', { class: 'panel' }, h('h2', null, 'Anything else?'), h('div', { class: 'row' }, dir), rain, h('div', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', id: 'complete', disabled: S.locks.size === 0 ? true : null, onclick: run }, S.locks.size ? `Keep ${[...S.locks].join(' + ')} and complete the rest` : 'Tap a piece to keep first')),
    ];
    if (S.op) {
      const op = S.op;
      if (op.ok === false) parts.push(h('section', { class: 'panel' }, h('span', { class: 'chip bad' }, `${op.code} · ${op.detail}`)));
      else if (op.state === 'HOLD') {
        const q = op.questions[0];
        parts.push(h('section', { class: 'panel' }, h('h2', null, 'Closer needs you'), h('p', { class: 'question' }, q ? q.text : op.detail),
          h('div', { class: 'row' }, (q ? q.choices : []).map((c) => c === 'discover' ? h('a', { class: 'btn ghost', href: '/discover' }, 'Open Discover')
            : items[c] ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => { S.locks = new Set([c]); run(); } }, `${c} · ${itemName(items[c])}`)
            : h('span', { class: 'chip' }, c)))));
      } else {
        parts.push(h('section', { class: 'panel' }, h('h2', null, `${op.options.length === 1 ? 'One outfit' : 'Two outfits'} with what you kept`),
          h('div', { class: 'options' }, op.options.map((o, i) => h('div', { class: 'option' }, h('h3', null, o.label),
            h('div', { class: 'flatlay' }, SLOTS.map((s) => tile(items[o.outfit[s]], { label: s, empty: !o.outfit[s], badge: S.locks.has(o.outfit[s]) ? 'kept' : null }))),
            h('ul', { class: 'reasons' }, o.reasonLines.map((l) => h('li', null, l))),
            h('button', { class: 'btn', type: 'button', onclick: () => pick(i) }, 'Wear this')))),
          h('p', { class: 'muted' }, `${(op.labels || []).join(' · ')}`)));
      }
    }
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
    if (S.msg) parts.push(h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, S.msg));
    keepFocus(root, () => root.replaceChildren(...parts));
  }
  render();
}

async function closetScreen(view) {
  chrome(sampleChips());
  document.body.append(tabbar());
  const { id, view: v } = await closetWs();
  const S = { window: 60, review: null, open: null, market: null, draft: null, msg: null, items: Object.fromEntries(v.items.map((i) => [i.itemId, i])) };
  const root = h('div');
  view.append(h('h1', null, 'My closet'),
    h('p', { class: 'lede' }, 'Pieces with no confirmed wear in the window you choose. Days without any record count as unknown. You decide what happens next; Closer does not post, sell or donate anything.'), root);

  async function load() { S.review = await getJson(`/api/ws/${id}/review?window=${S.window}`); render(); }
  async function act(itemId, action) {
    const r = await postJson(`/api/ws/${id}/reviewchoice`, { itemId, action });
    S.msg = r.ok === false ? h('span', { class: 'chip bad' }, `${r.code} · ${r.detail}`) : null;
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
    S.msg = h('span', { class: `chip ${r.ok === false ? 'bad' : 'ok'}` }, r.ok === false ? `${r.code} · ${r.detail}` : `Kept for the season · next look on ${r.reviewAfter}`);
    S.open = null;
    await load();
  }

  function priceCards() {
    if (!S.market) return null;
    const fmt = (e) => e.currency === 'KRW' ? `₩${e.amount.toLocaleString('en-US')}` : `$${e.amount.toFixed(2)}`;
    return h('div', { class: 'grid cols-3' }, S.market.cards.map((c) => h('div', { class: 'card' },
      h('div', { class: 'hd' }, c.info.name, h('span', { class: 'chip' }, c.info.currency)),
      h('div', { class: 'muted' }, c.info.region),
      c.entries.length ? h('ul', { class: 'reasons' }, c.entries.map((e) => h('li', null, `${fmt(e)} · ${e.priceType === 'ASK' ? 'asking' : 'traded'} · ${e.matchLevel.toLowerCase().replace('_', ' ')} · ${e.retrievedAt}`, e.source === 'sample' ? h('span', { class: 'chip sample' }, 'Sample') : null)))
        : h('p', { class: 'muted' }, c.emptyLine),
      h('ul', { class: 'reasons muted' }, c.info.notes.map((n) => h('li', null, n))),
      h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
        const price = S.calc && S.calc.platform === c.platform && S.calc.result && S.calc.result.ok !== false ? S.calc.result.price : null;
        S.draft = await postJson(`/api/ws/${id}/draft`, { itemId: S.open.itemId, kind: 'SELL', platform: c.platform, price });
        render();
      } }, `Draft a ${c.info.name} listing`))));
  }

  // Fee line names to start from. Values stay blank (unknown) until the owner checks the platform's own page.
  const FEE_START = {
    KREAM: [['Sales fee', 'rate'], ['Inspection and shipping', 'fixed']],
    KARROT: [['Delivery or meeting cost', 'fixed']],
    POSHMARK: [['Platform fee', 'rate'], ['Shipping to the buyer', 'fixed']],
  };
  function calcPanel() {
    if (!S.calc) S.calc = { platform: 'KARROT', price: '', fees: FEE_START.KARROT.map(([label, kind]) => ({ label, kind, value: '' })), result: null };
    const C = S.calc;
    const cur = C.platform === 'POSHMARK' ? 'USD' : 'KRW';
    const card = S.market ? S.market.cards.find((c) => c.platform === C.platform) : null;
    const plat = h('select', { id: 'calc-platform', 'aria-label': 'Platform', onchange: (e) => { C.platform = e.target.value; C.fees = FEE_START[C.platform].map(([label, kind]) => ({ label, kind, value: '' })); C.result = null; render(); } },
      [['KARROT', 'Karrot (KRW)'], ['KREAM', 'KREAM (KRW)'], ['POSHMARK', 'Poshmark (USD)']].map(([v, l]) => h('option', { value: v, selected: C.platform === v ? true : null }, l)));
    const price = h('input', { id: 'calc-price', type: 'number', min: '1', step: 'any', inputmode: 'decimal', placeholder: `Price you would ask (${cur})`, 'aria-label': 'Price', value: C.price, oninput: (e) => { C.price = e.target.value; } });
    const pick = card && card.entries.length ? h('div', { class: 'chip-row' }, h('span', { class: 'muted' }, 'Use a price you saw:'),
      card.entries.slice(0, 4).map((e) => h('button', { type: 'button', class: 'chip', onclick: () => { C.price = String(e.amount); render(); } }, `${e.currency === 'KRW' ? '₩' + e.amount.toLocaleString('en-US') : '$' + e.amount} · ${e.priceType === 'ASK' ? 'asking' : 'traded'}${e.source === 'sample' ? ' · sample' : ''}`))) : null;
    const rows = h('div', { class: 'feegrid' }, C.fees.map((f, i) => h('div', { class: 'feerow' },
      h('input', { type: 'text', 'aria-label': `Fee ${i + 1} name`, value: f.label, maxlength: '40', oninput: (e) => { f.label = e.target.value; } }),
      h('select', { 'aria-label': `Fee ${i + 1} kind`, onchange: (e) => { f.kind = e.target.value; render(); } }, h('option', { value: 'rate', selected: f.kind === 'rate' ? true : null }, '% of price'), h('option', { value: 'fixed', selected: f.kind === 'fixed' ? true : null }, `fixed ${cur}`)),
      h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', 'aria-label': `Fee ${i + 1} value`, placeholder: 'blank = not checked', value: f.value, oninput: (e) => { f.value = e.target.value; } }),
      h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `Remove fee ${i + 1}`, onclick: () => { C.fees.splice(i, 1); C.result = null; render(); } }, 'Remove'))));
    const calc = async () => {
      const fees = C.fees.map((f) => ({ label: f.label, kind: f.kind, value: f.value === '' ? null : f.kind === 'rate' ? Number(f.value) / 100 : Number(f.value) }));
      C.result = await postJson('/api/net', { price: Number(C.price), platform: C.platform, fees });
      render();
    };
    const R = C.result;
    const money = (n) => (cur === 'KRW' ? `₩${Math.round(n).toLocaleString('en-US')}` : `$${Number(n).toFixed(2)}`);
    const out = !R ? null : R.ok === false ? h('p', { class: 'question', role: 'status' }, R.detail)
      : h('div', { class: 'netbox', role: 'status' },
        h('dl', { class: 'kv' },
          h('dt', null, 'Price'), h('dd', null, money(R.price)),
          ...R.deductions.flatMap((d) => [h('dt', null, d.label), h('dd', null, `− ${money(d.amount)}`)]),
          ...R.unknown.flatMap((u) => [h('dt', null, u), h('dd', null, h('span', { class: 'chip warn' }, 'not checked'))]),
          h('dt', null, 'You would receive'), h('dd', null, R.net === null ? h('span', { class: 'chip warn' }, 'unknown') : h('b', null, money(R.net)))),
        h('p', { class: 'muted' }, R.line),
        R.net !== null ? h('p', { class: 'muted' }, `A draft for ${C.platform === 'KARROT' ? 'Karrot' : C.platform === 'KREAM' ? 'KREAM' : 'Poshmark'} will use this price.`) : null);
    return h('div', { class: 'calc' }, h('h2', { style: 'margin-top:14px' }, 'What would I receive?'),
      h('p', { class: 'muted' }, 'Fill in the fees from the platform\'s own page. A blank fee keeps the result unknown; type 0 only if you checked it is free.'),
      h('div', { class: 'row' }, plat, price), pick, rows,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { C.fees.push({ label: 'Other cost', kind: 'fixed', value: '' }); render(); } }, 'Add a fee'),
        h('button', { type: 'button', class: 'btn small', id: 'calc-go', onclick: calc }, 'Calculate')),
      out);
  }

  function evidenceForm() {
    const f = (id, el) => { el.id = id; return el; };
    const plat = f('ev-platform', h('select', { 'aria-label': 'Platform' }, [['KARROT', 'Karrot (KRW)'], ['KREAM', 'KREAM (KRW)'], ['POSHMARK', 'Poshmark (USD)']].map(([v, l]) => h('option', { value: v }, l))));
    const type = f('ev-type', h('select', { 'aria-label': 'Price type' }, h('option', { value: 'ASK' }, 'Asking price'), h('option', { value: 'TRADE' }, 'Traded price')));
    const match = f('ev-match', h('select', { 'aria-label': 'Match' }, h('option', { value: 'SIMILAR' }, 'Similar item'), h('option', { value: 'SAME_ITEM' }, 'Same item'), h('option', { value: 'UNVERIFIED' }, 'Not sure')));
    const amount = f('ev-amount', h('input', { type: 'number', min: '1', step: 'any', placeholder: 'Amount', 'aria-label': 'Amount' }));
    const link = f('ev-link', h('input', { type: 'url', placeholder: 'https:// link (optional)', 'aria-label': 'Link' }));
    const add = async () => {
      const cur = plat.value === 'POSHMARK' ? 'USD' : 'KRW';
      const r = await postJson(`/api/ws/${id}/evidence`, { itemId: S.open.itemId, platform: plat.value, priceType: type.value, amount: Number(amount.value), currency: cur, url: link.value || null, retrievedAt: new Date().toISOString().slice(0, 10), matchLevel: match.value });
      S.msg = h('span', { class: `chip ${r.ok === false ? 'bad' : 'ok'}` }, r.ok === false ? `${r.code} · ${r.detail}` : 'Price saved and read back');
      S.market = await getJson(`/api/ws/${id}/market/${S.open.itemId}`);
      render();
    };
    return h('div', null, h('h2', { style: 'margin-top:14px' }, 'Add a price you saw'), h('div', { class: 'evform' }, plat, type, match, amount, link, h('button', { class: 'btn small', type: 'button', onclick: add }, 'Save price')));
  }

  function draftPanel() {
    const d = S.draft;
    if (!d) return null;
    if (d.ok === false) return h('span', { class: 'chip bad' }, `${d.code} · ${d.detail}`);
    const ta = h('textarea', { id: 'draft-body', rows: '7', class: 'draft' });
    ta.value = d.body;
    const move = async (to) => {
      const r = await postJson(`/api/ws/${id}/draftmove`, { draftId: d.draftId, to, body: ta.value });
      if (r.ok === false) S.msg = h('span', { class: 'chip warn' }, r.code === 'NEEDS_CHECK' ? 'Fill every [check] / [확인] part first' : `${r.code} · ${r.detail}`);
      else { S.draft = r; S.msg = h('span', { class: 'chip ok' }, r.state === 'REVIEWED' ? 'Reviewed and read back' : 'Marked done by you'); }
      render();
    };
    return h('section', { class: 'panel' }, h('h2', null, d.kind === 'SELL' ? `Listing draft · ${d.platform}` : 'Donation checklist'),
      h('div', { class: 'row' }, h('span', { class: 'chip' }, d.state.toLowerCase().replace(/_/g, ' ')), h('span', { class: 'muted' }, `Still to check: ${d.toCheck.join(', ')}`)),
      ta,
      h('div', { class: 'row' },
        d.state === 'DRAFT' ? h('button', { class: 'btn small', type: 'button', onclick: () => move('REVIEWED') }, 'I checked it') : null,
        d.state === 'REVIEWED' ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => move('OWNER_REPORTED_DONE') }, d.kind === 'SELL' ? 'I posted it myself' : 'I handed it over') : null),
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
        h('div', { class: 'row' }, Object.entries(r.counts).map(([k, n]) => h('span', { class: 'chip' }, `${k.toLowerCase().replace('_', ' ')} ${n}`)))),
      h('section', { class: 'panel' }, h('h2', null, `To look at (${cands.length})`),
        cands.length === 0 ? h('p', { class: 'muted' }, 'Nothing to look at in this window.') : null,
        h('div', { class: 'grid' }, cands.map((x) => h('div', { class: `item wide${S.open && S.open.itemId === x.itemId ? ' locked' : ''}` },
          h('div', { class: 'thumb' }, placeholder(S.items[x.itemId] ? S.items[x.itemId].color : 'unknown')),
          h('div', { class: 'meta' }, h('b', null, `${x.itemId} · ${itemName(S.items[x.itemId])}`), h('span', null, x.line),
            h('span', { class: 'muted' }, `Tracked since ${x.trackedSince} · ${x.unrecordedDays} days without any record · source: ${x.source}`),
            x.seasonHint ? h('span', { class: 'chip warn' }, x.seasonHint) : null,
            x.lastChoice ? h('span', { class: 'chip' }, `Last choice: ${x.lastChoice.action.replace('_', ' ')}`) : null,
            h('div', { class: 'row' }, actions.map(([a, l]) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => (a === 'keep' ? keep(x.itemId) : act(x.itemId, a)) }, l)))))))),
    ];
    if (S.open && S.open.action === 'sell_review') parts.push(h('section', { class: 'panel' }, h('h2', null, `Price evidence for ${S.open.itemId}`), h('p', { class: 'muted' }, S.market ? S.market.note : ''), priceCards(), evidenceForm(), calcPanel()));
    if (S.open && S.open.action === 'repair_check') parts.push(h('section', { class: 'panel' }, h('h2', null, `Repair check for ${S.open.itemId}`), h('p', { class: 'muted' }, 'Note what is wrong (fit, a broken zip, a stain) and ask a repair shop. Closer only keeps your note.')));
    parts.push(draftPanel());
    parts.push(h('details', { class: 'panel' }, h('summary', null, `Everything else (${others.length})`),
      h('table', { class: 't' }, h('tbody', null, others.map((x) => h('tr', null, h('td', { class: 'mono' }, x.itemId), h('td', null, x.status.toLowerCase().replace('_', ' ')), h('td', null, x.line)))))));
    if (S.msg) parts.push(h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, S.msg));
    keepFocus(root, () => root.replaceChildren(...parts.filter(Boolean)));
  }
  await load();
}

async function discoverScreen(view) {
  chrome(sampleChips());
  document.body.append(tabbar());
  const { id, view: v } = await closetWs();
  const items = Object.fromEntries(v.items.map((i) => [i.itemId, i]));
  const L = await getJson('/api/looks');
  const S = { cat: 'wedding_guest', look: null, match: null };
  const root = h('div');
  view.append(h('h1', null, 'Discover looks'),
    h('p', { class: 'lede' }, 'Sample looks drawn for the demo. Closer rebuilds a look with what you own first; only the pieces you lack become optional cards.'), root);
  const lv = { SAME: ['ok', 'same'], SIMILAR: ['warn', 'similar'], NONE: ['bad', 'missing'] };

  async function open(lookId) {
    S.look = lookId;
    S.match = await getJson(`/api/ws/${id}/look/${lookId}`);
    render();
  }
  function render() {
    const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Occasion' }, L.categories.map((c) => h('button', { type: 'button', 'aria-pressed': S.cat === c.id ? 'true' : 'false', onclick: () => { S.cat = c.id; S.match = null; render(); } }, c.label)));
    const looks = L.looks.filter((l) => l.category === S.cat);
    const parts = [h('section', { class: 'panel' }, h('div', { class: 'row' }, tabs), h('div', { class: 'spacer' }),
      h('div', { class: 'cards' }, looks.map((l) => h('button', { type: 'button', class: `card look${S.look === l.lookId ? ' pinned' : ''}`, onclick: () => open(l.lookId) },
        h('div', { class: 'row' }, l.pieces.map((p) => placeholder(p.color))),
        h('div', { class: 'hd' }, l.title), h('div', { class: 'muted' }, `${l.credit} · ${l.note}`)))))];
    const m = S.match;
    if (m && m.ok !== false) {
      const own = Object.values(m.ownOutfit);
      parts.push(h('section', { class: 'panel' }, h('h2', null, `${m.title}: ${m.reused} of ${m.pieces.length} from your closet`),
        h('table', { class: 't look' }, h('tbody', null, m.pieces.map((p) => h('tr', null,
          h('td', null, p.piece.label), h('td', null, h('span', { class: `chip ${lv[p.level][0]}` }, lv[p.level][1])),
          h('td', null, p.itemId ? `${p.itemId} · ${itemName(items[p.itemId])}` : '—'), h('td', { class: 'muted' }, p.why))))),
        h('div', { class: 'spacer' }),
        own.length ? h('a', { class: 'btn', href: `/today?lock=${own.join(',')}`, role: 'button' }, `Wear it with mine (${own.join(' + ')})`) : null));
      if (m.gaps.length) parts.push(h('section', { class: 'panel' }, h('h2', null, 'Pieces you do not have'),
        h('div', { class: 'grid' }, m.gaps.map((g) => h('div', { class: 'card' },
          h('div', { class: 'hd' }, g.piece.label, placeholder(g.piece.color)),
          h('p', null, g.outfitsAdded > 0 ? `Adding it gives ${g.outfitsAdded} more complete outfits from this closet.` : 'It adds no new complete outfits to this closet.'),
          h('p', { class: 'muted' }, m.basis),
          h('div', { class: 'row' },
            g.alternatives.length ? h('a', { class: 'btn small ghost', href: `/today?lock=${[...own, g.alternatives[0]].join(',')}` }, `Use my ${g.alternatives[0]}`) : null,
            h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => { e.target.textContent = 'Skipped'; } }, 'Skip it'),
            h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => { e.target.textContent = 'Saved for later'; } }, 'Later'),
            h('button', { class: 'btn small', type: 'button', disabled: g.piece.shop.url ? null : true }, g.piece.shop.url ? 'Open product page' : 'No checked product link yet')))))));
      parts.push(h('details', { class: 'panel' }, h('summary', null, 'Buy the whole look instead'),
        h('ul', { class: 'reasons' }, m.fullLook.map((p) => h('li', null, `${p.label} · ${p.shop.url ? `${p.shop.match === 'SAME_ITEM' ? 'same item' : 'similar item'} · ${p.shop.price || 'price not checked'}` : 'no checked product link yet'}`))),
        h('p', { class: 'muted' }, 'Links open the shop. Closer does not fill a cart, pay, or check stock.')));
    }
    keepFocus(root, () => root.replaceChildren(...parts));
  }
  render();
}

(async function main() {
  META = await getJson('/api/photos');
  const view = $('#view');
  const p = location.pathname;
  if (p === '/') await tryScreen(view);
  else if (p === '/app') await appScreen(view);
  else if (p === '/w/demo-rc1') await demoScreen(view);
  else if (p === '/admin') await adminScreen(view);
  else if (p === '/version') await versionScreen(view);
  else if (p === '/today') await todayScreen(view);
  else if (p === '/closet') await closetScreen(view);
  else if (p === '/discover') await discoverScreen(view);
  document.body.dataset.ready = '1';
})();
