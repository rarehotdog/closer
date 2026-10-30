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
const getJson = async (url, headers) => (await fetch(url, { headers })).json();
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
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

// ---------- decision component (Try and App) ----------
function decisionUI(root, cfg) {
  const S = { wsId: cfg.wsId, view: null, photoId: 'p1', chipId: 'c1', flash: [], busy: false, painted: new Set(), answers: {}, ran: false };

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
      const op = await postJson(`/api/ws/${S.wsId}/photo`, { photoId: S.photoId, chipId: S.chipId });
      if (op.ok === false) flash({ chip: `${op.code} · ${op.detail}`, cls: 'bad' });
      S.ran = true;
    });
  }

  function inputs() {
    const photos = h('div', { class: 'photos' }, META.photos.map((p) =>
      h('button', { class: 'photo-pick', type: 'button', 'aria-pressed': String(S.photoId === p.photoId), onclick: () => { S.photoId = p.photoId; render(); } },
        h('img', { src: p.url, alt: `${p.title}, sample photo` }),
        h('div', { class: 'cap' }, `${p.title}`),
        h('span', { class: 'chip sample' }, META.labels.samplePhoto))));
    const sentences = h('div', { class: 'sentences' }, META.chips.map((c) =>
      h('button', { class: 'sentence', type: 'button', 'aria-pressed': String(S.chipId === c.chipId), onclick: () => { S.chipId = c.chipId; render(); } }, `“${c.text}”`)));
    return h('div', { class: 'grid cols-2' },
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '1'), cfg.visitor ? 'Pick a sample outfit' : 'Outfit photo'),
        cfg.visitor ? null : h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'btn ghost small', type: 'button', disabled: true }, 'Upload photo'), h('span', { class: 'muted' }, META.labels.uploadOff)),
        photos),
      h('section', { class: 'panel' }, h('h2', null, h('span', { class: 'step' }, '2'), 'Pick a sentence'),
        h('p', { class: 'muted' }, cfg.visitor ? 'Fixed sentences only. Free text and visitor photos are off on this page.' : 'Mock mode uses the same fixed sentences.'),
        sentences,
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
    if (S.flash.length) parts.push(h('div', { class: 'chip-row flash', id: 'flash' }, S.flash.map((f) => h('span', { class: `chip ${f.cls}` }, f.chip))));
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
    root.replaceChildren(...parts.filter(Boolean));
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
  const ownerView = await getJson('/api/ws/owner/view');
  showBanner({ ...ownerView.banner, ifLive: `If live: ${META.labels.replayAndLedger} (visitor cap $0 by default)` });
  ui.render();
}

async function appScreen(view) {
  chrome([h('span', { class: 'chip sample' }, META.labels.samplePhoto)]);
  view.append(h('h1', null, 'My wardrobe'), h('p', { class: 'lede' }, 'Owner view of the same loop. Photo upload needs admin sign-in; in mock mode the sample photos stand in.'));
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
  const r = await fetch('/api/admin');
  if (r.status === 403) { view.append(h('h1', null, 'Admin'), h('p', { class: 'lede' }, 'Admin token required.')); return; }
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
        h('li', null, 'Compare the first commit sha (git log --reverse | head -1) with the sha above.'),
        h('li', null, 'Turn K1 on in /admin and check that a button re-plan still works.'))));
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
  document.body.dataset.ready = '1';
})();
