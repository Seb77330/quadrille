// Feuillet — lecteur et éditeur PDF hors ligne.
// Affichage : pdf.js (Apache-2.0). Écriture : pdf-lib (MIT). Tout se passe dans le navigateur.
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, PDFName, PDFBool } = window.PDFLib;
const LIB = new URL("./vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf.worker.min.mjs";
const DOC_OPTS = { cMapUrl: LIB + "cmaps/", cMapPacked: true, standardFontDataUrl: LIB + "standard_fonts/", wasmUrl: LIB + "wasm/", iccUrl: LIB + "iccs/", isEvalSupported: false };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DPR = () => Math.min(window.devicePixelRatio || 1, 2.5);
const uid = () => Math.random().toString(36).slice(2, 10);
const norm = s => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
const rot360 = r => ((r % 360) + 360) % 360;

// ---------- Typographie française ----------
const SHORT = "à|a|au|aux|ce|ces|de|des|du|en|et|il|je|la|le|les|leur|ma|mes|mon|ne|ni|on|ou|où|par|pas|peu|pour|qu|que|qui|sa|sans|se|ses|si|son|sous|sur|ta|tes|ton|tu|un|une|vers|y|avec|dans|chez|ton|lui|elle|nous|vous|très|plus|est|c’est";
const RX_SHORT = new RegExp(`(^|[\\s\\u00A0(«])(${SHORT}) `, "giu");
export function fr(s) {
  if (!s) return s;
  s = s.replace(/'/g, "’")
    .replace(/\s*([?!;:»])(?=\s|$|[.,)])/g, " $1")
    .replace(/«\s*/g, "« ")
    .replace(/(\d)\s(?=[\d\p{L}%€])/gu, "$1 ")
    .replace(/\s(%|€)/g, " $1")
    .replace(/\s([–—])\s/g, " $1 ");
  let prev;
  do { prev = s; s = s.replace(RX_SHORT, "$1$2 "); } while (s !== prev);
  return s;
}
function typo(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest("script,style,svg,textarea,.textLayer") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let n; (n = w.nextNode());) if (/\S/.test(n.nodeValue)) n.nodeValue = fr(n.nodeValue);
  for (const el of root.querySelectorAll("[title],[placeholder]")) {
    if (el.title) el.title = fr(el.title);
    if (el.placeholder) el.placeholder = fr(el.placeholder);
  }
}

// ---------- État ----------
const S = {
  sources: new Map(),   // id -> {id, name, bytes, pdf, cache:[], text:[], fields:[], values:{}, changed:Set}
  pages: [],            // [{id, src, idx, rot, annots:[]}]
  scale: 1, fit: true, tool: "select", sel: null, cur: 0,
  name: "document.pdf", handle: null, dirty: false,
  images: new Map(),    // id -> {url, mime, el}
  undo: [], redo: [], query: "", pendingImg: null, gen: 0,
};

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = fr(msg); t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms);
}
async function busy(msg, fn) {
  $("#busyTxt").textContent = fr(msg); $("#busy").classList.add("show");
  await new Promise(r => setTimeout(r, 30));
  try { return await fn(); } finally { $("#busy").classList.remove("show"); }
}
function setDirty(v = true) { S.dirty = v; document.title = (v ? "• " : "") + S.name.replace(/\.pdf$/i, "") + " – Feuillet"; }

// ---------- Annuler / rétablir ----------
const snap = () => JSON.stringify(S.pages);
function pushUndo() { S.undo.push(snap()); if (S.undo.length > 80) S.undo.shift(); S.redo = []; updUndo(); setDirty(); }
function updUndo() { $("#bUndo").disabled = !S.undo.length; $("#bRedo").disabled = !S.redo.length; $("#bDel").disabled = !S.sel; }
function undo(redo = false) {
  const from = redo ? S.redo : S.undo, to = redo ? S.undo : S.redo;
  if (!from.length) return;
  const before = JSON.parse(snap()), structure = p => p.map(x => x.id + ":" + x.rot).join();
  to.push(snap()); S.pages = JSON.parse(from.pop()); S.sel = null; updUndo(); setDirty();
  if (structure(before) !== structure(S.pages)) rebuild(); else refreshAllInk();
}

// ---------- Chargement ----------
async function addPdfBytes(bytes, name) {
  const id = uid();
  const task = pdfjsLib.getDocument({ data: bytes.slice(), ...DOC_OPTS });
  task.onPassword = (cb, reason) => {
    const p = prompt(fr(reason === 2 ? "Mot de passe incorrect. Réessaie :" : `« ${name} » est protégé. Mot de passe :`));
    if (p === null) task.destroy(); else cb(p);
  };
  const pdf = await task.promise;
  const src = { id, name, bytes, pdf, cache: [], text: [], fields: [], values: {}, changed: new Set(), locked: false };
  S.sources.set(id, src);
  await readFields(src);
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) pages.push({ id: uid(), src: id, idx: i, rot: 0, annots: [] });
  return pages;
}

async function fileToPages(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) return addPdfBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  if (file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(file.name)) {
    return addPdfBytes(await imageToPdfBytes(file), file.name.replace(/\.[^.]+$/, "") + ".pdf");
  }
  throw new Error(`Format non pris en charge : ${file.name}`);
}

async function openFiles(files, { handle = null, append = false } = {}) {
  files = [...files]; if (!files.length) return;
  if (!append && S.dirty && S.pages.length && !confirm(fr("Les modifications non enregistrées seront perdues. Continuer ?"))) return;
  await busy(files.length > 1 ? "Ouverture des fichiers…" : "Ouverture…", async () => {
    const all = [];
    for (const f of files) {
      try { all.push(...await fileToPages(f)); }
      catch (e) { console.error(e); toast(e?.name === "PasswordException" ? "Fichier protégé non ouvert." : `Impossible d’ouvrir « ${f.name} ».`); }
    }
    if (!all.length) return;
    if (append && S.pages.length) {
      pushUndo(); S.pages.push(...all); rebuild(); toast(`${all.length} page${all.length > 1 ? "s" : ""} ajoutée${all.length > 1 ? "s" : ""}.`);
    } else {
      S.sources = new Map([...S.sources].filter(([id]) => all.some(p => p.src === id)));
      S.pages = all; S.undo = []; S.redo = []; S.sel = null; S.fit = true; S.cur = 0;
      const first = files[0];
      S.name = /\.pdf$/i.test(first.name) ? first.name : first.name.replace(/\.[^.]+$/, "") + ".pdf";
      S.handle = files.length === 1 && /\.pdf$/i.test(first.name) ? handle : null;
      setDirty(files.length > 1 || !/\.pdf$/i.test(first.name));
      document.body.classList.remove("nodoc"); $("#empty").hidden = true;
      updUndo(); await rebuild(); $("#viewer").scrollTop = 0;
    }
  });
}

async function pickOpen() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await showOpenFilePicker({ types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
      return openFiles([await h.getFile()], { handle: h });
    } catch (e) { if (e.name === "AbortError") return; }
  }
  $("#fOpen").click();
}

// ---------- Images ----------
function readAsDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); }); }
function loadImg(url) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
async function normImage(file) {
  let url = await readAsDataURL(file), mime = file.type;
  let el = await loadImg(url);
  const big = Math.max(el.naturalWidth, el.naturalHeight) > 3000;
  if (!/^image\/(png|jpeg)$/.test(mime) || big) {
    const k = big ? 3000 / Math.max(el.naturalWidth, el.naturalHeight) : 1;
    const c = document.createElement("canvas"); c.width = Math.round(el.naturalWidth * k); c.height = Math.round(el.naturalHeight * k);
    c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
    mime = mime === "image/jpeg" ? "image/jpeg" : "image/png";
    url = c.toDataURL(mime, 0.9); el = await loadImg(url);
  }
  return { url, mime, el };
}
const dataUrlBytes = url => Uint8Array.from(atob(url.split(",")[1]), c => c.charCodeAt(0));
async function imageToPdfBytes(file) {
  const im = await normImage(file);
  const doc = await PDFDocument.create();
  const img = im.mime === "image/jpeg" ? await doc.embedJpg(dataUrlBytes(im.url)) : await doc.embedPng(dataUrlBytes(im.url));
  const land = img.width > img.height, W = land ? 841.89 : 595.28, H = land ? 595.28 : 841.89, m = 24;
  const k = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height);
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: (W - img.width * k) / 2, y: (H - img.height * k) / 2, width: img.width * k, height: img.height * k });
  return doc.save();
}
function regImage(rec) { const id = uid(); S.images.set(id, rec); return id; }
function imgEl(id) { return S.images.get(id)?.el; }

// ---------- Formulaires (lecture avec pdf-lib) ----------
async function readFields(src) {
  try {
    const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) src.locked = true;
    const fields = doc.getForm().getFields(); if (!fields.length) return;
    const pages = doc.getPages(), owner = new Map();
    pages.forEach((pg, i) => { const an = pg.node.Annots(); if (an) for (let k = 0; k < an.size(); k++) { const d = doc.context.lookup(an.get(k)); if (d) owner.set(d, i); } });
    const L = window.PDFLib;
    for (const f of fields) {
      const type = f instanceof L.PDFTextField ? "text" : f instanceof L.PDFCheckBox ? "check" : f instanceof L.PDFRadioGroup ? "radio" : f instanceof L.PDFDropdown ? "select" : f instanceof L.PDFOptionList ? "list" : null;
      if (!type) continue;
      let opts = []; try { if (type !== "text" && type !== "check") opts = f.getOptions(); } catch {}
      const ws = f.acroField.getWidgets().map((w, wi) => {
        let page = owner.get(w.dict);
        if (page === undefined) { const P = w.P(); if (P) page = pages.findIndex(pg => pg.ref === P || String(pg.ref) === String(P)); }
        const r = w.getRectangle();
        let on = null; if (type === "radio") { on = opts[wi]; if (on == null) try { on = w.getOnValue()?.decodeText(); } catch {} }
        return { page, rect: [r.x, r.y, r.width, r.height], on };
      }).filter(w => w.page != null && w.page >= 0);
      let value = "";
      try { value = type === "text" ? (f.getText() ?? "") : type === "check" ? f.isChecked() : type === "radio" ? (f.getSelected() ?? "") : type === "select" ? (f.getSelected()[0] ?? "") : f.getSelected(); } catch {}
      let multi = false, max; if (type === "text") { try { multi = f.isMultiline(); max = f.getMaxLength(); } catch {} }
      let ro = false; try { ro = f.isReadOnly(); } catch {}
      src.fields.push({ name: f.getName(), type, opts, ws, ro, multi, max });
      src.values[f.getName()] = value;
    }
  } catch (e) { console.warn("Formulaire illisible", e); }
}

// ---------- Géométrie ----------
// Un élément = ancre (point PDF du coin haut-gauche à l’écran), rotation r (degrés), taille w×h en points.
function toPdf(o, lx, ly) { const t = o.r * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), u = lx, v = -ly; return [o.a[0] + u * c - v * s, o.a[1] + u * s + v * c]; }
function toLocal(o, px, py) { const t = -o.r * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), dx = px - o.a[0], dy = py - o.a[1]; return [dx * c - dy * s, -(dx * s + dy * c)]; }
function pageRot(p) { const src = S.sources.get(p.src); return rot360((src.cache[p.idx]?.__rot ?? 0) + p.rot); }
async function getPage(src, idx) {
  if (!src.cache[idx]) { const pp = await src.pdf.getPage(idx + 1); pp.__rot = pp.rotate; src.cache[idx] = pp; }
  return src.cache[idx];
}
function textSize(o) {
  const c = textSize.c ||= document.createElement("canvas").getContext("2d");
  c.font = `${o.fs}px Helvetica, Arial, sans-serif`;
  const lines = o.text.split("\n");
  o.w = Math.max(8, ...lines.map(l => c.measureText(l).width)) + 2; o.h = lines.length * o.fs * 1.2;
}

// ---------- Dessin des annotations ----------
function drawObj(ctx, o) {
  if (o.t === "ink") {
    ctx.save(); ctx.lineWidth = o.lw; ctx.strokeStyle = o.c; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); o.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    if (o.pts.length === 1) ctx.lineTo(o.pts[0][0] + .01, o.pts[0][1]);
    ctx.stroke(); ctx.restore(); return;
  }
  ctx.save(); ctx.translate(o.a[0], o.a[1]); ctx.rotate(o.r * Math.PI / 180); ctx.scale(1, -1);
  if (o.t === "hl") { ctx.globalAlpha = .4; ctx.fillStyle = o.c; ctx.fillRect(0, 0, o.w, o.h); }
  else if (o.t === "rect") { ctx.lineWidth = o.lw; ctx.strokeStyle = o.c; ctx.strokeRect(0, 0, o.w, o.h); }
  else if (o.t === "wo") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, o.w, o.h); }
  else if (o.t === "img") { const el = imgEl(o.img); if (el) ctx.drawImage(el, 0, 0, o.w, o.h); }
  else if (o.t === "txt") {
    ctx.fillStyle = o.c; ctx.font = `${o.fs}px Helvetica, Arial, sans-serif`; ctx.textBaseline = "alphabetic";
    o.text.split("\n").forEach((l, i) => ctx.fillText(l, 1, o.fs * .92 + i * o.fs * 1.2));
  }
  ctx.restore();
}
function bbox(o) {
  if (o.t !== "ink") return null;
  const xs = o.pts.map(p => p[0]), ys = o.pts.map(p => p[1]), m = o.lw / 2 + 2;
  return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
}
function drawSel(ctx, o, scale) {
  ctx.save(); ctx.strokeStyle = "#0d7a6f"; ctx.lineWidth = 1.5 / scale; ctx.setLineDash([5 / scale, 3 / scale]);
  if (o.t === "ink") { const b = bbox(o); ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); ctx.restore(); return; }
  ctx.translate(o.a[0], o.a[1]); ctx.rotate(o.r * Math.PI / 180); ctx.scale(1, -1);
  ctx.strokeRect(-2 / scale, -2 / scale, o.w + 4 / scale, o.h + 4 / scale);
  ctx.setLineDash([]); ctx.fillStyle = "#fff"; const hs = 9 / scale;
  ctx.fillRect(o.w - hs / 2, o.h - hs / 2, hs, hs); ctx.strokeRect(o.w - hs / 2, o.h - hs / 2, hs, hs);
  ctx.restore();
}
function paint(canvas, vp, list, { sel = null, layer = "all", dpr = DPR() } = {}) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.transform(...vp.transform);
  for (const o of list) {
    if (o.hidden) continue;
    if (layer === "hl" && o.t !== "hl") continue;
    if (layer === "ink" && o.t === "hl") continue;
    drawObj(ctx, o);
  }
  if (sel && layer !== "hl") drawSel(ctx, sel, vp.scale);
}

// ---------- Vue principale ----------
const viewer = $("#viewer"), pagesEl = $("#pages");
let io;
async function rebuild() {
  const gen = ++S.gen;
  if (!S.pages.length) { closeDoc(); return; }
  if (S.fit) await computeFit();
  const keep = S.cur;
  io?.disconnect();
  io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? renderPage(e.target) : unrenderPage(e.target)), { root: viewer, rootMargin: "800px 0px" });
  const frag = document.createDocumentFragment();
  for (const p of S.pages) {
    const src = S.sources.get(p.src), pp = await getPage(src, p.idx);
    if (gen !== S.gen) return;
    const vp = pp.getViewport({ scale: S.scale, rotation: pageRot(p) });
    const el = document.createElement("div"); el.className = "pg"; el.dataset.id = p.id;
    el.style.width = Math.floor(vp.width) + "px"; el.style.height = Math.floor(vp.height) + "px";
    el.style.setProperty("--total-scale-factor", S.scale); el.style.setProperty("--scale-factor", S.scale);
    el._vp = vp; el._p = p; frag.append(el);
  }
  pagesEl.replaceChildren(frag);
  $$(".pg", pagesEl).forEach(el => io.observe(el));
  $("#zoomv").textContent = fr(Math.round(S.scale * 100) + " %");
  buildThumbs();
  if (keep) scrollToPage(Math.min(keep, S.pages.length - 1), false);
  updPageInfo();
}
async function computeFit() {
  let w = 0; // la page la plus large tient dans la fenêtre
  for (const p of S.pages.slice(0, 200)) { const pp = await getPage(S.sources.get(p.src), p.idx); w = Math.max(w, pp.getViewport({ scale: 1, rotation: pageRot(p) }).width); }
  const avail = viewer.clientWidth - 48;
  S.scale = Math.max(.25, Math.min(2, avail / w));
}
function findPg(p) { return pagesEl.querySelector(`.pg[data-id="${p.id}"]`); }
function pageOf(el) { return S.pages.find(p => p.id === el.dataset.id); }

async function renderPage(el) {
  const p = pageOf(el); if (!p) return;
  if (el._done === S.gen) return; el._done = S.gen;
  const src = S.sources.get(p.src), pp = await getPage(src, p.idx), vp = el._vp, dpr = DPR();
  el.replaceChildren();
  const cv = document.createElement("canvas"); cv.className = "pdf";
  cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
  const hl = document.createElement("canvas"); hl.className = "hl"; hl.width = cv.width; hl.height = cv.height;
  const tl = document.createElement("div"); tl.className = "textLayer";
  const ink = document.createElement("canvas"); ink.className = "ink"; ink.width = cv.width; ink.height = cv.height;
  const forms = document.createElement("div"); forms.className = "forms";
  el.append(cv, hl, tl, ink, forms);
  el._task?.cancel();
  const task = pp.render({ canvasContext: cv.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    annotationMode: src.fields.length ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE });
  el._task = task;
  paintInk(el);
  buildForms(el, p, src);
  try { await task.promise; } catch (e) { if (e?.name !== "RenderingCancelledException") console.warn(e); return; }
  try {
    const t = new pdfjsLib.TextLayer({ textContentSource: pp.streamTextContent(), container: tl, viewport: vp });
    await t.render(); markHits(el);
  } catch (e) { console.warn(e); }
}
function unrenderPage(el) {
  if (el._done == null) return;
  el._task?.cancel(); el._done = null;
  if (el.contains(document.activeElement)) return;
  el.replaceChildren();
}
function paintInk(el) {
  const p = pageOf(el), hl = $("canvas.hl", el), ink = $("canvas.ink", el); if (!ink) return;
  const sel = S.sel && S.sel.page === p.id ? p.annots.find(o => o.id === S.sel.id) : null;
  paint(hl, el._vp, p.annots, { layer: "hl" });
  paint(ink, el._vp, p.annots, { layer: "ink", sel });
}
function refreshInk(p) { const el = findPg(p); if (el && el._done != null) paintInk(el); refreshThumb(p); }
function refreshAllInk() { S.pages.forEach(refreshInk); }

function buildForms(el, p, src) {
  const box = $(".forms", el); if (!src.fields.length) return;
  const vp = el._vp;
  for (const f of src.fields) for (const w of f.ws) {
    if (w.page !== p.idx) continue;
    const [x, y, W, H] = w.rect;
    const [x1, y1] = vp.convertToViewportPoint(x, y), [x2, y2] = vp.convertToViewportPoint(x + W, y + H);
    const L = Math.min(x1, x2), T = Math.min(y1, y2), Wd = Math.abs(x2 - x1), Hd = Math.abs(y2 - y1);
    let inp; const val = src.values[f.name];
    if (f.type === "text") {
      inp = document.createElement(f.multi ? "textarea" : "input"); if (!f.multi) inp.type = "text";
      inp.value = val ?? ""; if (f.max) inp.maxLength = f.max;
      inp.style.fontSize = Math.max(8, Math.min(f.multi ? 12 * S.scale : Hd * .62, 14 * S.scale)) + "px";
      inp.oninput = () => { setVal(src, f, inp.value); syncSame(src, f, inp); };
    } else if (f.type === "check") {
      inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!val;
      inp.onchange = () => { setVal(src, f, inp.checked); syncSame(src, f, inp); };
    } else if (f.type === "radio") {
      inp = document.createElement("input"); inp.type = "radio"; inp.name = src.id + ":" + f.name; inp.value = w.on ?? ""; inp.checked = val === w.on;
      inp.onchange = () => { if (inp.checked) setVal(src, f, w.on); };
    } else {
      inp = document.createElement("select"); if (f.type === "list") inp.multiple = true;
      if (f.type === "select") inp.append(new Option("", ""));
      for (const o of f.opts) { const op = new Option(o, o); op.selected = Array.isArray(val) ? val.includes(o) : val === o; inp.append(op); }
      inp.onchange = () => setVal(src, f, f.type === "list" ? [...inp.selectedOptions].map(o => o.value) : inp.value);
      inp.style.fontSize = Math.max(8, Math.min(Hd * .6, 13 * S.scale)) + "px";
    }
    inp.dataset.field = f.name; inp.disabled = f.ro; inp.title = f.name;
    Object.assign(inp.style, { left: L + "px", top: T + "px", width: Wd + "px", height: Hd + "px" });
    if (f.type === "check" || f.type === "radio") { const s = Math.min(Wd, Hd); Object.assign(inp.style, { width: s + "px", height: s + "px", left: L + (Wd - s) / 2 + "px", top: T + (Hd - s) / 2 + "px" }); }
    box.append(inp);
  }
}
function setVal(src, f, v) { src.values[f.name] = v; src.changed.add(f.name); setDirty(); }
function syncSame(src, f, from) {
  $$(".forms [data-field]").forEach(i => { if (i !== from && i.dataset.field === f.name && i.closest(".pg") && pageOf(i.closest(".pg"))?.src === src.id) { if (i.type === "checkbox") i.checked = from.checked; else i.value = from.value; } });
}

function closeDoc() {
  S.pages = []; S.sources.clear(); S.handle = null; S.undo = []; S.redo = []; S.sel = null; setDirty(false); document.title = "Feuillet";
  pagesEl.replaceChildren(); $("#thumbs").replaceChildren(); document.body.classList.add("nodoc"); $("#empty").hidden = false; updUndo();
}

// ---------- Navigation ----------
function scrollToPage(i, smooth = true) { const p = S.pages[i]; const el = p && findPg(p); if (el) viewer.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? "smooth" : "auto" }); S.cur = i; updPageInfo(); }
function updPageInfo() {
  $("#pagev").textContent = S.pages.length ? `${S.cur + 1} / ${S.pages.length}` : "";
  $$(".thumb").forEach((t, i) => t.classList.toggle("cur", i === S.cur));
}
viewer.addEventListener("scroll", () => {
  const mid = viewer.scrollTop + viewer.clientHeight / 3; let cur = 0;
  $$(".pg", pagesEl).forEach((el, i) => { if (el.offsetTop <= mid) cur = i; });
  if (cur !== S.cur) { S.cur = cur; updPageInfo(); $(".thumb.cur")?.scrollIntoView({ block: "nearest" }); }
}, { passive: true });
function zoom(f) { S.fit = false; S.scale = Math.max(.25, Math.min(5, f === "fit" ? S.scale : S.scale * f)); if (f === "fit") S.fit = true; rebuild(); }
window.addEventListener("resize", () => { if (S.fit && S.pages.length) { clearTimeout(zoom.t); zoom.t = setTimeout(rebuild, 200); } });
viewer.addEventListener("wheel", e => { if (e.ctrlKey && S.pages.length) { e.preventDefault(); clearTimeout(zoom.w); zoom.w = setTimeout(() => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15), 40); } }, { passive: false });

// ---------- Miniatures ----------
const thumbsEl = $("#thumbs"); let tio, dragId = null;
function buildThumbs() {
  tio?.disconnect();
  tio = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) renderThumb(e.target); }), { root: $("#side"), rootMargin: "400px 0px" });
  const frag = document.createDocumentFragment();
  S.pages.forEach((p, i) => {
    const t = document.createElement("div"); t.className = "thumb"; t.draggable = true; t.dataset.id = p.id; t.tabIndex = 0;
    t.innerHTML = `<canvas width="1" height="1"></canvas><div class="num"><input type="checkbox" title="${fr("Sélectionner pour extraire ou supprimer")}"> ${i + 1}</div>
      <div class="acts"><button data-a="rl" title="${fr("Pivoter à gauche")}"><svg viewBox="0 0 24 24"><use href="#i-rl"/></svg></button><button data-a="rr" title="${fr("Pivoter à droite")}"><svg viewBox="0 0 24 24"><use href="#i-rr"/></svg></button><button data-a="del" title="${fr("Supprimer la page")}"><svg viewBox="0 0 24 24"><use href="#i-trash"/></svg></button></div>`;
    frag.append(t);
  });
  thumbsEl.replaceChildren(frag);
  $$(".thumb", thumbsEl).forEach(t => tio.observe(t));
  updPageInfo();
}
async function renderThumb(t) {
  const p = S.pages.find(x => x.id === t.dataset.id); if (!p) return;
  const pp = await getPage(S.sources.get(p.src), p.idx);
  const base = pp.getViewport({ scale: 1, rotation: pageRot(p) });
  const vp = pp.getViewport({ scale: 130 / Math.max(base.width, base.height * .8), rotation: pageRot(p) });
  const cv = $("canvas", t), dpr = DPR();
  const off = document.createElement("canvas"); off.width = Math.floor(vp.width * dpr); off.height = Math.floor(vp.height * dpr);
  try { await pp.render({ canvasContext: off.getContext("2d"), viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise; } catch { return; }
  const an = document.createElement("canvas"); an.width = off.width; an.height = off.height; paint(an, vp, p.annots, { dpr });
  cv.width = off.width; cv.height = off.height; cv.style.width = Math.floor(vp.width) + "px"; cv.style.height = Math.floor(vp.height) + "px";
  const c = cv.getContext("2d"); c.drawImage(off, 0, 0); c.drawImage(an, 0, 0);
}
function refreshThumb(p) { clearTimeout(p.__tt); const t = thumbsEl.querySelector(`.thumb[data-id="${p.id}"]`); if (t) { refreshThumb.q ||= new Map(); clearTimeout(refreshThumb.q.get(p.id)); refreshThumb.q.set(p.id, setTimeout(() => renderThumb(t), 250)); } }
thumbsEl.addEventListener("click", e => {
  const t = e.target.closest(".thumb"); if (!t) return;
  const i = S.pages.findIndex(p => p.id === t.dataset.id);
  const a = e.target.closest("button")?.dataset.a;
  if (e.target.matches("input")) return;
  if (a === "rl" || a === "rr") { pushUndo(); S.pages[i].rot = rot360(S.pages[i].rot + (a === "rr" ? 90 : -90)); S.cur = i; rebuild(); }
  else if (a === "del") { if (S.pages.length === 1 && !confirm(fr("C’est la dernière page. Fermer le document ?"))) return; pushUndo(); S.pages.splice(i, 1); S.cur = Math.min(i, S.pages.length - 1); rebuild(); }
  else scrollToPage(i);
});
thumbsEl.addEventListener("dragstart", e => { const t = e.target.closest(".thumb"); dragId = t?.dataset.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
thumbsEl.addEventListener("dragover", e => {
  if (!dragId) return; e.preventDefault();
  const t = e.target.closest(".thumb"); $$(".thumb").forEach(x => x.classList.remove("drop-before", "drop-after"));
  if (t) { const r = t.getBoundingClientRect(); t.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after"); }
});
thumbsEl.addEventListener("dragend", () => { dragId = null; $$(".thumb").forEach(x => x.classList.remove("drop-before", "drop-after")); });
thumbsEl.addEventListener("drop", e => {
  if (!dragId) return; e.preventDefault(); e.stopPropagation();
  const t = e.target.closest(".thumb"); if (!t || t.dataset.id === dragId) return;
  const after = t.classList.contains("drop-after");
  pushUndo();
  const from = S.pages.findIndex(p => p.id === dragId), [pg] = S.pages.splice(from, 1);
  let to = S.pages.findIndex(p => p.id === t.dataset.id) + (after ? 1 : 0);
  S.pages.splice(to, 0, pg); S.cur = to; dragId = null; rebuild();
});
function checkedPages() { return $$(".thumb").filter(t => $("input", t).checked).map(t => S.pages.findIndex(p => p.id === t.dataset.id)); }

// ---------- Outils d’annotation ----------
const TOOLS = { select: "Épaisseur", hl: "Épaisseur", pen: "Épaisseur", text: "Taille", rect: "Épaisseur", wo: "Épaisseur" };
function setTool(t) {
  commitEdit();
  S.tool = t; S.pendingImg = t === "place" ? S.pendingImg : null;
  $$("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  document.body.classList.toggle("drawing", ["pen", "rect", "wo", "text", "place"].includes(t));
  document.body.classList.toggle("t-text", t === "text");
  document.body.classList.toggle("placing", t === "place");
  $("#sizeLbl").textContent = fr(TOOLS[t] || "Épaisseur");
  const sz = $("#size");
  if (t === "text") { sz.min = 6; sz.max = 48; sz.value = S.fs || 14; } else { sz.min = 1; sz.max = 20; sz.value = S.lw || 3; }
  if (t === "hl" && !S.hlColorSet) $("#color").value = "#ffd400";
  if (t !== "hl" && $("#color").value === "#ffd400" && !S.hlColorSet) $("#color").value = S.color || "#1d3fbf";
}
$$("[data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
$("#color").oninput = e => {
  if (S.tool === "hl") S.hlColorSet = true; else S.color = e.target.value;
  const o = selObj(); if (o && o.t !== "img" && o.t !== "wo") { pushUndo(); o.c = e.target.value; refreshInk(selPage()); }
};
$("#size").oninput = e => {
  const v = +e.target.value; if (S.tool === "text") S.fs = v; else S.lw = v;
  const o = selObj(); if (!o) return;
  if (o.t === "txt") { o.fs = v; textSize(o); } else if (o.lw != null) o.lw = v; else return;
  setDirty(); refreshInk(selPage());
};
const selPage = () => S.sel && S.pages.find(p => p.id === S.sel.page);
const selObj = () => { const p = selPage(); return p && p.annots.find(o => o.id === S.sel.id); };
function select(p, o) { const old = selPage(); S.sel = o ? { page: p.id, id: o.id } : null; if (old && old !== p) refreshInk(old); if (p) refreshInk(p); updUndo();
  if (o?.t === "txt") $("#size").value = o.fs; else if (o?.lw) $("#size").value = o.lw; }
function deleteSel() { const p = selPage(), o = selObj(); if (!o) return; pushUndo(); p.annots = p.annots.filter(x => x !== o); S.sel = null; refreshInk(p); updUndo(); }

function hit(p, x, y, scale) {
  const tol = 4 / scale;
  for (let i = p.annots.length - 1; i >= 0; i--) {
    const o = p.annots[i];
    if (o.t === "ink") {
      const d = o.lw / 2 + tol;
      for (let k = 0; k < o.pts.length; k++) {
        const [ax, ay] = o.pts[k], [bx, by] = o.pts[k + 1] || o.pts[k];
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= d) return { o, mode: "move" };
      }
      continue;
    }
    const [lx, ly] = toLocal(o, x, y), hs = 8 / scale;
    if (S.sel?.id === o.id && Math.abs(lx - o.w) < hs && Math.abs(ly - o.h) < hs) return { o, mode: "resize" };
    if (lx >= -tol && ly >= -tol && lx <= o.w + tol && ly <= o.h + tol) return { o, mode: "move" };
  }
  return null;
}

let drag = null;
pagesEl.addEventListener("pointerdown", e => {
  const el = e.target.closest(".pg"); if (!el || e.button !== 0) return;
  if (e.target.closest(".forms>*") || e.target.closest("textarea.edit")) return;
  const p = pageOf(el), vp = el._vp, r = el.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top, [px, py] = vp.convertToPdfPoint(sx, sy);
  const base = { el, p, vp, r, sx, sy, px, py, id: e.pointerId };
  commitEdit();
  const t = S.tool;
  if (t === "select" || t === "hl") {
    const h = hit(p, px, py, vp.scale);
    if (h) {
      e.preventDefault(); window.getSelection()?.removeAllRanges();
      select(p, h.o);
      drag = { ...base, kind: h.mode, o: h.o, start: JSON.stringify(h.o), moved: false };
      el.setPointerCapture(e.pointerId); return;
    }
    if (S.sel) select(null, null);
    if (t === "hl") drag = { ...base, kind: "hl" };
    return;
  }
  e.preventDefault(); el.setPointerCapture(e.pointerId);
  if (t === "pen") {
    const o = { id: uid(), t: "ink", pts: [[px, py]], c: $("#color").value, lw: +(S.lw || 3) };
    pushUndo(); p.annots.push(o); drag = { ...base, kind: "pen", o };
  } else if (t === "rect" || t === "wo") {
    const pv = document.createElement("div"); pv.className = "preview"; el.append(pv);
    drag = { ...base, kind: "box", pv };
  } else if (t === "text") {
    startEdit(el, p, null, sx, sy);
  } else if (t === "place" && S.pendingImg) {
    const im = S.images.get(S.pendingImg), ratio = im.el.naturalHeight / im.el.naturalWidth;
    const w = S.pendingKind === "sig" ? 160 : Math.min(240, im.el.naturalWidth * .75), h = w * ratio;
    const a = vp.convertToPdfPoint(sx - w * vp.scale / 2, sy - h * vp.scale / 2);
    const o = { id: uid(), t: "img", a, r: rot360(vp.rotation), w, h, img: S.pendingImg };
    pushUndo(); p.annots.push(o); setTool("select"); select(p, o);
  }
});
pagesEl.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  const { el, vp, r } = drag, sx = e.clientX - r.left, sy = e.clientY - r.top, [px, py] = vp.convertToPdfPoint(sx, sy);
  if (drag.kind === "pen") { drag.o.pts.push([px, py]); paintInk(el); return; }
  if (drag.kind === "box" || (drag.kind === "hl" && !hasSel(el))) {
    if (drag.kind === "hl" && !drag.pv && Math.hypot(sx - drag.sx, sy - drag.sy) > 6 && !window.getSelection()?.toString()) {
      drag.pv = document.createElement("div"); drag.pv.className = "preview"; el.append(drag.pv); e.preventDefault();
    }
    if (drag.pv) Object.assign(drag.pv.style, { left: Math.min(sx, drag.sx) + "px", top: Math.min(sy, drag.sy) + "px", width: Math.abs(sx - drag.sx) + "px", height: Math.abs(sy - drag.sy) + "px" });
    return;
  }
  if (drag.kind === "move" || drag.kind === "resize") {
    if (!drag.moved) { S.undo.push(snapWith(drag)); S.redo = []; setDirty(); drag.moved = true; updUndo(); }
    const o0 = JSON.parse(drag.start), o = drag.o;
    if (drag.kind === "move") {
      const dx = px - drag.px, dy = py - drag.py;
      if (o.t === "ink") o.pts = o0.pts.map(([x, y]) => [x + dx, y + dy]); else o.a = [o0.a[0] + dx, o0.a[1] + dy];
    } else {
      const [lx, ly] = toLocal(o0, px, py);
      if (o.t === "img") { const k = Math.max(10, lx) / o0.w; o.w = o0.w * k; o.h = o0.h * k; }
      else if (o.t === "txt") { o.fs = Math.max(4, o0.fs * Math.max(10, lx) / o0.w); textSize(o); }
      else { o.w = Math.max(4, lx); o.h = Math.max(4, ly); }
    }
    paintInk(el);
  }
});
function snapWith(d) { const cur = d.o, saved = JSON.parse(d.start), arr = JSON.parse(snap()); for (const p of arr) { const i = p.annots.findIndex(x => x.id === cur.id); if (i >= 0) p.annots[i] = saved; } return JSON.stringify(arr); }
function hasSel(el) { const s = window.getSelection(); return s && !s.isCollapsed && el.contains(s.anchorNode); }
pagesEl.addEventListener("pointerup", e => endDrag(e));
pagesEl.addEventListener("pointercancel", e => endDrag(e, true));
function endDrag(e, cancel) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null; d.pv?.remove();
  const { el, p, vp, r } = d, sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (cancel) return;
  if (d.kind === "pen") { refreshInk(p); return; }
  if (d.kind === "move" || d.kind === "resize") { if (d.moved) refreshThumb(p); return; }
  const R = rot360(vp.rotation), sc = vp.scale;
  const mk = (x0, y0, x1, y1, t, extra) => ({ id: uid(), t, a: vp.convertToPdfPoint(Math.min(x0, x1), Math.min(y0, y1)), r: R, w: Math.abs(x1 - x0) / sc, h: Math.abs(y1 - y0) / sc, ...extra });
  if (d.kind === "box") {
    if (Math.abs(sx - d.sx) < 4 || Math.abs(sy - d.sy) < 4) return;
    const o = d.el && S.tool === "wo" ? mk(d.sx, d.sy, sx, sy, "wo") : mk(d.sx, d.sy, sx, sy, "rect", { c: $("#color").value, lw: +(S.lw || 3) });
    pushUndo(); p.annots.push(o); refreshInk(p); return;
  }
  if (d.kind === "hl") {
    const c = $("#color").value, s = window.getSelection();
    if (s && !s.isCollapsed && el.contains(s.anchorNode)) {
      const rects = mergeRects([...s.getRangeAt(0).getClientRects()].filter(q => q.width > 1 && q.height > 1));
      if (!rects.length) return;
      pushUndo();
      for (const q of rects) p.annots.push(mk(q.left - r.left, q.top - r.top, q.right - r.left, q.bottom - r.top, "hl", { c }));
      s.removeAllRanges(); refreshInk(p); return;
    }
    if (Math.abs(sx - d.sx) > 6 && Math.abs(sy - d.sy) > 4) { pushUndo(); p.annots.push(mk(d.sx, d.sy, sx, sy, "hl", { c })); refreshInk(p); }
  }
}
function mergeRects(rs) {
  rs = rs.map(q => ({ left: q.left, top: q.top, right: q.right, bottom: q.bottom })).sort((a, b) => a.top - b.top || a.left - b.left);
  const out = [];
  for (const q of rs) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.top - q.top) < 3 && Math.abs(l.bottom - q.bottom) < 3 && q.left <= l.right + 4) { l.right = Math.max(l.right, q.right); l.left = Math.min(l.left, q.left); }
    else if (l && q.left >= l.left - 1 && q.right <= l.right + 1 && q.top >= l.top - 1 && q.bottom <= l.bottom + 1) continue;
    else out.push(q);
  }
  return out;
}

// Texte : édition dans une zone de saisie posée sur la page
let editing = null;
function startEdit(el, p, o, sx, sy) {
  const vp = el._vp, ta = document.createElement("textarea"); ta.className = "edit";
  const fs = o ? o.fs : +(S.fs || 14), color = o ? o.c : $("#color").value;
  if (o) { const [x, y] = vp.convertToViewportPoint(...o.a); sx = x; sy = y; ta.value = o.text; }
  Object.assign(ta.style, { left: sx + "px", top: sy + "px", fontSize: fs * vp.scale + "px", color });
  const fitTa = () => { ta.style.height = "auto"; ta.style.width = "auto"; ta.style.height = ta.scrollHeight + "px"; ta.style.width = Math.max(60, ta.scrollWidth + 8) + "px"; };
  ta.rows = 1; ta.oninput = fitTa; el.append(ta); fitTa(); ta.focus(); requestAnimationFrame(() => ta.focus()); setTimeout(() => { if (editing?.ta === ta) ta.focus(); }, 120);
  if (o) o.hidden = true;
  editing = { el, p, o, ta, sx, sy, fs, color, vp };
  ta.addEventListener("keydown", e => { if (e.key === "Escape") { ta.value = o ? o.text : ""; commitEdit(); } if (e.key === "Enter" && e.ctrlKey) commitEdit(); e.stopPropagation(); });
  ta.addEventListener("blur", () => setTimeout(() => { if (editing?.ta === ta && document.activeElement !== ta) commitEdit(); }, 150));
  if (o) { p.annots = p.annots; paintInk(el); }
}
function commitEdit() {
  if (!editing) return;
  const { p, o, ta, sx, sy, fs, color, vp } = editing; editing = null;
  const text = ta.value.replace(/\s+$/, ""); ta.remove();
  if (o) {
    delete o.hidden;
    if (!text) { pushUndo(); p.annots = p.annots.filter(x => x !== o); S.sel = null; }
    else if (text !== o.text) { pushUndo(); o.text = text; textSize(o); }
    refreshInk(p); updUndo(); return;
  }
  if (!text) return;
  const n = { id: uid(), t: "txt", a: vp.convertToPdfPoint(sx, sy), r: rot360(vp.rotation), text, fs, c: color };
  textSize(n); pushUndo(); p.annots.push(n); setTool("select"); select(p, n);
}
pagesEl.addEventListener("dblclick", e => {
  const el = e.target.closest(".pg"); if (!el || S.tool !== "select") return;
  const p = pageOf(el), vp = el._vp, r = el.getBoundingClientRect(), [px, py] = vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
  const h = hit(p, px, py, vp.scale); if (h?.o.t === "txt") { e.preventDefault(); startEdit(el, p, h.o); }
});

// ---------- Signature ----------
const pad = $("#sigPad"); let sigMode = "draw", sigStrokes = [], sigFileRec = null;
function sigResize() { const r = pad.getBoundingClientRect(); pad.width = r.width * 2; pad.height = r.height * 2; drawPad(); }
function drawPad() {
  const c = pad.getContext("2d"); c.setTransform(2, 0, 0, 2, 0, 0); c.clearRect(0, 0, pad.width, pad.height);
  c.strokeStyle = $("#sigColor").value; c.lineWidth = 2.6; c.lineCap = c.lineJoin = "round";
  for (const s of sigStrokes) { c.beginPath(); s.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); if (s.length === 1) c.lineTo(s[0][0] + .1, s[0][1]); c.stroke(); }
}
pad.addEventListener("pointerdown", e => { pad.setPointerCapture(e.pointerId); const r = pad.getBoundingClientRect(); sigStrokes.push([[e.clientX - r.left, e.clientY - r.top]]); drawPad(); });
pad.addEventListener("pointermove", e => { if (!pad.hasPointerCapture(e.pointerId)) return; const r = pad.getBoundingClientRect(); sigStrokes.at(-1).push([e.clientX - r.left, e.clientY - r.top]); drawPad(); });
$$("[data-st]").forEach(b => b.onclick = () => { sigMode = b.dataset.st; $$("[data-st]").forEach(x => x.classList.toggle("on", x === b)); $$("[data-sp]").forEach(x => x.hidden = x.dataset.sp !== sigMode); if (sigMode === "draw") sigResize(); if (sigMode === "type") $("#sigType").focus(); });
$("#sigColor").oninput = () => { drawPad(); $("#sigType").style.color = $("#sigColor").value; };
$("#sigClear").onclick = () => { sigStrokes = []; $("#sigType").value = ""; sigFileRec = null; drawPad(); };
$("#sigCancel").onclick = () => $("#dSign").close();
$("#sigFile").onclick = () => { $("#fImg").dataset.for = "sig"; $("#fImg").click(); };
function trimCanvas(c) {
  const ctx = c.getContext("2d"), { width: w, height: h } = c, d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) return null;
  const m = 6, o = document.createElement("canvas"); o.width = x1 - x0 + 2 * m; o.height = y1 - y0 + 2 * m;
  o.getContext("2d").drawImage(c, x0 - m, y0 - m, o.width, o.height, 0, 0, o.width, o.height); return o;
}
async function sigFromFile(file) {
  const im = await normImage(file), c = document.createElement("canvas"), k = Math.min(1, 900 / im.el.naturalWidth);
  c.width = im.el.naturalWidth * k; c.height = im.el.naturalHeight * k;
  const x = c.getContext("2d"); x.drawImage(im.el, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height); // fond clair -> transparent
  for (let i = 0; i < d.data.length; i += 4) { const l = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3; if (l > 200) d.data[i + 3] = 0; else if (l > 150) d.data[i + 3] = (200 - l) * 5; }
  x.putImageData(d, 0, 0); return trimCanvas(c);
}
function sigCanvas() {
  if (sigMode === "file") return sigFileRec;
  if (sigMode === "type") {
    const txt = $("#sigType").value.trim(); if (!txt) return null;
    const c = document.createElement("canvas"); c.width = 1400; c.height = 300; const x = c.getContext("2d");
    x.font = `150px "Segoe Script","Brush Script MT","Lucida Handwriting",cursive`; x.fillStyle = $("#sigColor").value; x.textBaseline = "middle"; x.fillText(txt, 20, 150, 1360);
    return trimCanvas(c);
  }
  if (!sigStrokes.length) return null; return trimCanvas(pad);
}
const SIG_KEY = "feuillet.signatures";
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } };
const saveSigs = a => { try { localStorage.setItem(SIG_KEY, JSON.stringify(a.slice(-6))); } catch {} };
function showSaved() {
  const a = loadSigs(), box = $("#sigSaved"); $("#sigSavedWrap").hidden = !a.length; box.replaceChildren();
  a.forEach((url, i) => {
    const b = document.createElement("button"); b.innerHTML = `<img alt="${fr("Signature enregistrée")}" src="${url}"><span class="x" title="${fr("Oublier cette signature")}">×</span>`;
    b.onclick = e => { if (e.target.classList.contains("x")) { const n = loadSigs(); n.splice(i, 1); saveSigs(n); showSaved(); return; } placeSig(url); };
    box.append(b);
  });
}
async function placeSig(url) { $("#dSign").close(); const el = await loadImg(url); S.pendingImg = regImage({ url, mime: "image/png", el }); S.pendingKind = "sig"; setTool("place"); toast("Clique sur la page à l’endroit de la signature."); }
$("#sigOk").onclick = () => {
  const c = sigCanvas(); if (!c) { toast("Signe d’abord dans le cadre."); return; }
  const url = c.toDataURL("image/png"), a = loadSigs(); if (!a.includes(url)) { a.push(url); saveSigs(a); }
  placeSig(url);
};
$("#bSign").onclick = () => { sigStrokes = []; sigFileRec = null; $("#dSign").showModal(); showSaved(); if (sigMode === "draw") requestAnimationFrame(sigResize); };
$("#bImg").onclick = () => { $("#fImg").dataset.for = "img"; $("#fImg").click(); };
$("#fImg").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    if ($("#fImg").dataset.for === "sig") { sigFileRec = await sigFromFile(f); if (sigFileRec) toast("Image prête, clique sur « Placer sur la page »."); return; }
    const rec = await normImage(f); S.pendingImg = regImage(rec); S.pendingKind = "img"; setTool("place"); toast("Clique sur la page pour placer l’image.");
  } catch { toast("Image illisible."); }
};

// ---------- Recherche ----------
async function pageText(p) {
  const src = S.sources.get(p.src);
  if (src.text[p.idx] == null) { const pp = await getPage(src, p.idx); const tc = await pp.getTextContent(); src.text[p.idx] = norm(tc.items.map(i => i.str).join(" ")); }
  return src.text[p.idx];
}
function markHits(el) { $$(".textLayer span", el).forEach(s => s.classList.toggle("hit", !!S.query && norm(s.textContent).includes(S.query))); }
async function search(dir = 1) {
  const q = norm($("#q").value.trim()); if (!q) { S.query = ""; $$(".pg").forEach(markHits); return; }
  const fresh = q !== S.query; S.query = q; $$(".pg").forEach(markHits);
  const n = S.pages.length, start = fresh ? S.cur : S.cur + dir;
  for (let k = 0; k < n; k++) {
    const i = ((start + k * dir) % n + n) % n;
    if ((await pageText(S.pages[i])).includes(q)) { scrollToPage(i); toast(`Trouvé page ${i + 1}.`, 1400); return; }
  }
  toast("Aucun résultat.");
}
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); search(e.shiftKey ? -1 : 1); } if (e.key === "Escape") { $("#q").value = ""; search(); $("#q").blur(); } });
$("#bNext").onclick = () => search(1); $("#bPrev").onclick = () => search(-1);

// ---------- Export (pdf-lib) ----------
const hex = c => rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);
function applyForm(doc, src, flatten) {
  const form = doc.getForm(); if (!src.fields.length) return;
  for (const name of src.changed) {
    const f = src.fields.find(x => x.name === name), v = src.values[name];
    try {
      const F = form.getField(name);
      if (f.type === "text") F.setText(v || undefined);
      else if (f.type === "check") v ? F.check() : F.uncheck();
      else if (f.type === "radio") { if (v) F.select(v); else F.clear(); }
      else if (f.type === "select") { if (v) F.select(v); else F.clear(); }
      else if (f.type === "list") { if (v?.length) F.select(v); else F.clear(); }
    } catch (e) { console.warn("Champ", name, e); }
  }
  try { form.updateFieldAppearances(); }
  catch (e) { console.warn(e); form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True); }
  if (flatten) { try { form.flatten({ updateFieldAppearances: false }); } catch (e) { console.warn("Aplatissement", e); } }
}
async function drawAnnots(doc, page, list, font, cache) {
  const safe = s => { s = s.replace(/[  ]/g, " "); let o = ""; for (const ch of s) { try { font.encodeText(ch); o += ch; } catch { o += "?"; } } return o; };
  for (const o of list) {
    if (o.t === "ink") {
      const d = o.pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${(-y).toFixed(2)}`).join(" ") + (o.pts.length === 1 ? ` L${(o.pts[0][0] + .01).toFixed(2)} ${(-o.pts[0][1]).toFixed(2)}` : "");
      page.drawSvgPath(d, { x: 0, y: 0, borderColor: hex(o.c), borderWidth: o.lw, borderLineCap: LineCapStyle.Round });
      continue;
    }
    const [qx, qy] = toPdf(o, 0, o.h), rot = degrees(o.r);
    if (o.t === "hl") page.drawRectangle({ x: qx, y: qy, width: o.w, height: o.h, rotate: rot, color: hex(o.c), opacity: .4, blendMode: BlendMode.Multiply });
    else if (o.t === "rect") { const [ix, iy] = toPdf(o, 0, o.h); page.drawRectangle({ x: ix, y: iy, width: o.w, height: o.h, rotate: rot, borderColor: hex(o.c), borderWidth: o.lw }); }
    else if (o.t === "wo") page.drawRectangle({ x: qx, y: qy, width: o.w, height: o.h, rotate: rot, color: rgb(1, 1, 1) });
    else if (o.t === "img") {
      const im = S.images.get(o.img); if (!im) continue;
      let e = cache.get(o.img); if (!e) { e = im.mime === "image/jpeg" ? await doc.embedJpg(dataUrlBytes(im.url)) : await doc.embedPng(dataUrlBytes(im.url)); cache.set(o.img, e); }
      page.drawImage(e, { x: qx, y: qy, width: o.w, height: o.h, rotate: rot });
    } else if (o.t === "txt") {
      o.text.split("\n").forEach((l, i) => { const [bx, by] = toPdf(o, 1, o.fs * .92 + i * o.fs * 1.2); page.drawText(safe(l), { x: bx, y: by, size: o.fs, font, color: hex(o.c), rotate: rot }); });
    }
  }
}
async function buildPdf({ pages = S.pages, flatten = false } = {}) {
  const ids = [...new Set(pages.map(p => p.src))], docs = new Map();
  for (const id of ids) {
    const src = S.sources.get(id);
    if (src.locked) throw new Error("locked");
    const d = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
    applyForm(d, src, flatten || ids.length > 1); docs.set(id, d);
  }
  let out, outPages;
  if (ids.length === 1) {
    out = docs.get(ids[0]); const all = out.getPages();
    const used = new Set(); outPages = pages.map(p => { if (used.has(p.idx)) return null; used.add(p.idx); return all[p.idx]; });
    if (outPages.includes(null)) { // page en double : on passe par une copie
      const n = await PDFDocument.create(); outPages = [];
      for (const p of pages) { const [c] = await n.copyPages(out, [p.idx]); outPages.push(n.addPage(c)); }
      out = n;
    } else {
      for (let i = all.length - 1; i >= 0; i--) out.removePage(i);
      outPages.forEach((pg, i) => out.insertPage(i, pg));
    }
  } else {
    out = await PDFDocument.create(); outPages = [];
    for (const p of pages) { const [c] = await out.copyPages(docs.get(p.src), [p.idx]); outPages.push(out.addPage(c)); }
  }
  const font = await out.embedFont(StandardFonts.Helvetica), cache = new Map();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], pg = outPages[i];
    if (p.rot) pg.setRotation(degrees(rot360(pg.getRotation().angle + p.rot)));
    if (p.annots.length) await drawAnnots(out, pg, p.annots, font, cache);
  }
  out.setProducer("Feuillet"); out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true, updateFieldAppearances: false });
}
async function exportOrWarn(opts) {
  try { return await buildPdf(opts); }
  catch (e) {
    console.error(e);
    if (e.message === "locked") {
      if (confirm(fr("Ce PDF est protégé par un mot de passe : il ne peut être enregistré que sous forme d’images (texte non sélectionnable). Continuer ?"))) return rasterize(null, 150, opts);
      return null;
    }
    toast("Échec de l’enregistrement. Ce PDF est peut-être abîmé."); return null;
  }
}

async function downloadBytes(bytes, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function saveAs(bytes, name) {
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
      const w = await h.createWritable(); await w.write(bytes); await w.close(); return h;
    } catch (e) { if (e.name === "AbortError") return false; console.warn(e); }
  }
  await downloadBytes(bytes, name); return true;
}
async function save(as = false) {
  if (!S.pages.length) return; commitEdit();
  const bytes = await busy("Enregistrement…", () => exportOrWarn()); if (!bytes) return;
  if (!as && S.handle?.createWritable) {
    try {
      if ((await S.handle.queryPermission?.({ mode: "readwrite" })) !== "granted") await S.handle.requestPermission?.({ mode: "readwrite" });
      const w = await S.handle.createWritable(); await w.write(bytes); await w.close(); setDirty(false); toast("Enregistré."); return;
    } catch (e) { console.warn(e); }
  }
  const h = await saveAs(bytes, as ? S.name.replace(/\.pdf$/i, "") + " (copie).pdf" : S.name);
  if (!h) return;
  if (!as) { if (h !== true) { S.handle = h; S.name = h.name; } setDirty(false); }
  toast(h === true ? "Fichier téléchargé dans Téléchargements." : "Enregistré.");
}

// ---------- Compression / impression (pages en images) ----------
async function rasterize(bytes, dpi, opts = {}) {
  let pdf;
  if (bytes) pdf = await pdfjsLib.getDocument({ data: bytes, ...DOC_OPTS }).promise;
  const out = await PDFDocument.create(), list = bytes ? null : (opts.pages || S.pages);
  const n = bytes ? pdf.numPages : list.length;
  for (let i = 0; i < n; i++) {
    let pp, rot = 0, annots = [];
    if (bytes) pp = await pdf.getPage(i + 1); else { const p = list[i]; pp = await getPage(S.sources.get(p.src), p.idx); rot = pageRot(p); annots = p.annots; }
    const base = pp.getViewport({ scale: 1, rotation: bytes ? pp.rotate : rot }), vp = pp.getViewport({ scale: dpi / 72, rotation: bytes ? pp.rotate : rot });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await pp.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    if (annots.length) { const a = document.createElement("canvas"); a.width = c.width; a.height = c.height; paint(a, vp, annots, { dpr: 1 }); ctx.drawImage(a, 0, 0); }
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", dpi >= 150 ? .8 : dpi >= 100 ? .7 : .6));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
  }
  out.setProducer("Feuillet");
  return out.save();
}
const fmt = b => fr(b > 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " Mo" : Math.max(1, Math.round(b / 1024)) + " ko");
async function compress() {
  const cur = await busy("Préparation…", () => exportOrWarn()); if (!cur) return;
  $("#cmpInfo").textContent = fr(`Taille actuelle : ${fmt(cur.length)}.`);
  const d = $("#dCompress"); d.showModal();
  $("#cmpCancel").onclick = () => d.close();
  $("#cmpGo").onclick = async () => {
    const dpi = +$("input[name=cmp]:checked").value; d.close();
    const out = dpi ? await busy("Compression… (quelques secondes par page)", () => rasterize(cur.slice(), dpi)) : cur;
    if (out.length >= cur.length && dpi) { toast(`Le fichier est déjà léger (${fmt(cur.length)}). Rien à gagner.`); return; }
    const ok = await saveAs(out, S.name.replace(/\.pdf$/i, "") + " (compressé).pdf");
    if (ok) toast(`${fmt(cur.length)} → ${fmt(out.length)} (−${Math.max(0, Math.round(100 - out.length / cur.length * 100))} %).`, 4000);
  };
}
async function printDoc() {
  if (!S.pages.length) return; commitEdit();
  const box = $("#print"); box.replaceChildren();
  await busy("Préparation de l’impression…", async () => {
    for (const p of S.pages) {
      const pp = await getPage(S.sources.get(p.src), p.idx), vp = pp.getViewport({ scale: 2, rotation: pageRot(p) });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await pp.render({ canvasContext: ctx, viewport: vp, intent: "print", annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      if (p.annots.length) { const a = document.createElement("canvas"); a.width = c.width; a.height = c.height; paint(a, vp, p.annots, { dpr: 1 }); ctx.drawImage(a, 0, 0); }
      drawFormValues(ctx, vp, p);
      const img = new Image(); img.src = c.toDataURL("image/jpeg", .92); box.append(img); await img.decode();
    }
  });
  window.print(); setTimeout(() => box.replaceChildren(), 1000);
}
function drawFormValues(ctx, vp, p) {
  const src = S.sources.get(p.src); if (!src.fields.length) return;
  ctx.save(); ctx.fillStyle = "#111";
  for (const f of src.fields) for (const w of f.ws) {
    if (w.page !== p.idx) continue; const v = src.values[f.name];
    const [x, y, W, H] = w.rect, [x1, y1] = vp.convertToViewportPoint(x, y), [x2, y2] = vp.convertToViewportPoint(x + W, y + H);
    const L = Math.min(x1, x2), T = Math.min(y1, y2), Wd = Math.abs(x2 - x1), Hd = Math.abs(y2 - y1);
    if (f.type === "check" ? v : f.type === "radio" ? v === w.on : false) { ctx.font = `${Hd * .9}px sans-serif`; ctx.fillText("✓", L + Wd * .15, T + Hd * .85); }
    else if (["text", "select"].includes(f.type) && v) { const fs = Math.min(Hd * .62, 12 * vp.scale); ctx.font = `${fs}px Helvetica, Arial`; String(v).split("\n").forEach((l, i) => ctx.fillText(l, L + 2, T + fs * (1.05 + i * 1.15), Wd - 4)); }
  }
  ctx.restore();
}

// ---------- Outils de pages ----------
function parseRange(s, n) {
  const out = [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?\s*[-–à]\s*(\d+)?$/) || part.match(/^(\d+)$/);
    if (!m) return null;
    let a, b; if (m.length === 2) a = b = +m[1]; else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    if (a < 1 || b > n || a > b) return null;
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out.length ? out : null;
}
$("#bMore").onclick = () => {
  const sel = checkedPages(); if (sel.length) $("#range").value = sel.map(i => i + 1).join(", ");
  $("#dMore").showModal();
};
$("#range").onfocus = () => { $("input[name=more][value=extract]").checked = true; };
$("#moreCancel").onclick = e => { e.preventDefault(); $("#dMore").close(); };
$("#moreGo").onclick = async e => {
  e.preventDefault(); const v = $("input[name=more]:checked").value, base = S.name.replace(/\.pdf$/i, "");
  if (v === "extract") {
    const idx = parseRange($("#range").value, S.pages.length);
    if (!idx) { toast(`Indique des pages entre 1 et ${S.pages.length}, par exemple 1-3, 5.`); return; }
    $("#dMore").close();
    const bytes = await busy("Extraction…", () => exportOrWarn({ pages: idx.map(i => S.pages[i]) })); if (bytes) saveAs(bytes, `${base} (pages ${$("#range").value.replace(/\s+/g, "")}).pdf`);
  } else if (v === "split") {
    $("#dMore").close();
    if (S.pages.length > 1 && !confirm(fr(`Créer ${S.pages.length} fichiers dans ton dossier Téléchargements ?`))) return;
    await busy("Séparation…", async () => {
      for (let i = 0; i < S.pages.length; i++) { const b = await exportOrWarn({ pages: [S.pages[i]] }); if (!b) return; await downloadBytes(b, `${base} - page ${i + 1}.pdf`); await new Promise(r => setTimeout(r, 250)); }
    });
    toast("Fichiers créés dans Téléchargements.");
  } else if (v === "compress") { $("#dMore").close(); compress(); }
  else if (v === "flatten") {
    $("#dMore").close();
    const bytes = await busy("Figer le formulaire…", () => exportOrWarn({ flatten: true })); if (bytes) saveAs(bytes, `${base} (figé).pdf`);
  } else if (v === "theme") {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next; try { localStorage.setItem("feuillet.theme", next); } catch {}
    $("#dMore").close();
  }
};
try { const t = localStorage.getItem("feuillet.theme"); if (t) document.documentElement.dataset.theme = t; } catch {}

// ---------- Boutons, fichiers, clavier ----------
$("#bOpen").onclick = $("#bOpen2").onclick = pickOpen;
$("#bAdd").onclick = $("#bAdd2").onclick = () => $("#fAdd").click();
$("#bImgs").onclick = () => $("#fAdd").click();
$("#fOpen").onchange = e => { openFiles(e.target.files); e.target.value = ""; };
$("#fAdd").onchange = e => { openFiles(e.target.files, { append: S.pages.length > 0 }); e.target.value = ""; };
$("#bSave").onclick = () => save(); $("#bSaveAs").onclick = () => save(true); $("#bPrint").onclick = printDoc;
$("#bZoomIn").onclick = () => zoom(1.2); $("#bZoomOut").onclick = () => zoom(1 / 1.2); $("#bFit").onclick = () => zoom("fit");
$("#bDel").onclick = deleteSel; $("#bUndo").onclick = () => undo(); $("#bRedo").onclick = () => undo(true);
$("#bSide").onclick = () => $("#side").classList.toggle("hidden");

const dropBox = $("#drop");
window.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); dropBox.classList.add("over"); } });
window.addEventListener("dragleave", e => { if (!e.relatedTarget) dropBox.classList.remove("over"); });
window.addEventListener("drop", e => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); dropBox.classList.remove("over"); openFiles(e.dataTransfer.files, { append: S.pages.length > 0 }); });

document.addEventListener("keydown", e => {
  const typing = e.target.closest("input,textarea,select,[contenteditable]");
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === "o") { e.preventDefault(); pickOpen(); return; }
  if (!S.pages.length) return;
  if (mod && k === "s") { e.preventDefault(); save(e.shiftKey); return; }
  if (mod && k === "p") { e.preventDefault(); printDoc(); return; }
  if (mod && k === "f") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
  if (typing) return;
  if (mod && k === "z") { e.preventDefault(); undo(e.shiftKey); return; }
  if (mod && k === "y") { e.preventDefault(); undo(true); return; }
  if (mod && (k === "+" || k === "=")) { e.preventDefault(); zoom(1.2); return; }
  if (mod && k === "-") { e.preventDefault(); zoom(1 / 1.2); return; }
  if (mod && k === "0") { e.preventDefault(); zoom("fit"); return; }
  if (mod) return;
  if ((k === "delete" || k === "backspace") && S.sel) { e.preventDefault(); deleteSel(); return; }
  if (k === "escape") { setTool("select"); if (S.sel) select(null, null); return; }
  const map = { v: "select", h: "hl", d: "pen", t: "text", r: "rect", b: "wo" };
  if (map[k]) setTool(map[k]);
  if (k === "s") $("#bSign").click();
  if (k === "i") $("#bImg").click();
  if (k === "pagedown" || k === "arrowright") { if (viewer.scrollHeight <= viewer.clientHeight + viewer.scrollTop + 2 || k === "arrowright") { e.preventDefault(); scrollToPage(Math.min(S.cur + 1, S.pages.length - 1)); } }
  if (k === "arrowleft") { e.preventDefault(); scrollToPage(Math.max(S.cur - 1, 0)); }
});
window.addEventListener("beforeunload", e => { if (S.dirty && S.pages.length) { e.preventDefault(); e.returnValue = ""; } });

// Ouvrir avec Feuillet (Windows : clic droit > Ouvrir avec)
if ("launchQueue" in window) launchQueue.setConsumer(async params => {
  if (!params.files?.length) return;
  const files = await Promise.all(params.files.map(h => h.getFile()));
  openFiles(files, { handle: params.files.length === 1 ? params.files[0] : null });
});
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

typo(document.body);
setTool("select");
window.Feuillet = { S, openFiles, buildPdf, rasterize, fr }; // pour les tests
