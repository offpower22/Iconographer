/* Iconographer client. Handles capture, the analyze request, cropping each
   detected symbol out of the photo client-side, and rendering one card per
   symbol. Kept dependency-free so it ships as one small script. */

interface FigureNote {
  name: string;
  note: string;
}
interface SymbolMatch {
  id: string;
  name: string;
  category: string;
  meaning: string;
  figures: FigureNote[];
  matchedElement: string;
  location?: string;
  box?: [number, number, number, number] | null;
}
interface FigureSuggestion {
  name: string;
  supportingSymbols: string[];
  weight: number;
}
interface AnalyzeResponse {
  symbols: SymbolMatch[];
  unmatchedElements: string[];
  figureSuggestion: FigureSuggestion | null;
  message: string | null;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const screens = {
  scan: $('#scan-screen'),
  loading: $('#loading-screen'),
  result: $('#result-screen')
};

const fileInput = $<HTMLInputElement>('#file-input');
const scanBtn = $<HTMLButtonElement>('#scan-btn');
const libraryBtn = $<HTMLButtonElement>('#library-btn');
const againBtn = $<HTMLButtonElement>('#again-btn');
const offlineStrip = $('#offline-strip');

function showScreen(name: keyof typeof screens) {
  (Object.keys(screens) as (keyof typeof screens)[]).forEach((k) => {
    screens[k].hidden = k !== name;
  });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function updateOnlineStatus() {
  offlineStrip.hidden = navigator.onLine;
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// --- install hint -----------------------------------------------------------
// iOS gives no beforeinstallprompt event, so Add to Home Screen has to be
// taught rather than triggered. The whole trick to not being obnoxious is
// showing it *only* when it is actually actionable.

const INSTALL_DISMISSED_KEY = 'iconographer:install-hint-dismissed';

function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports itself as "Macintosh"; touch points disambiguate it.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Already installed — running from the Home Screen icon, not the browser. */
function isStandalone(): boolean {
  return (
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

/**
 * Third-party iOS browsers render with WebKit but only Safari exposes a real
 * Add to Home Screen, so the instructions have to differ there.
 */
function isIOSSafari(): boolean {
  return isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS|Mercury/i.test(navigator.userAgent);
}

/** localStorage throws in some private-browsing configurations. */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore — the hint simply reappears next visit */
  }
}

/** Should the hint be offered at all? */
function shouldOfferInstall(): boolean {
  return isIOS() && !isStandalone() && safeGet(INSTALL_DISMISSED_KEY) !== '1';
}

function setUpInstallHint(): void {
  const hint = document.querySelector<HTMLElement>('#install-hint');
  const body = document.querySelector<HTMLElement>('#install-body');
  const dismiss = document.querySelector<HTMLButtonElement>('#install-dismiss');
  if (!hint || !body || !dismiss) return;

  // Wire dismissal unconditionally — independent of whether we end up showing
  // the hint, so the behavior is identical however it became visible.
  dismiss.addEventListener('click', () => {
    hint.hidden = true;
    safeSet(INSTALL_DISMISSED_KEY, '1');
  });

  if (!shouldOfferInstall()) return;

  if (!isIOSSafari()) {
    // Telling someone in Chrome-for-iOS to tap Share would send them nowhere.
    body.innerHTML =
      'Open this page in <strong>Safari</strong> to add Iconographer to your Home Screen — ' +
      'it then opens full-screen, without the browser bar.';
  }

  hint.hidden = false;
}

setUpInstallHint();

// --- capture --------------------------------------------------------------

scanBtn.addEventListener('click', () => {
  fileInput.setAttribute('capture', 'environment');
  fileInput.click();
});
libraryBtn.addEventListener('click', () => {
  fileInput.removeAttribute('capture');
  fileInput.click();
});
againBtn.addEventListener('click', () => {
  fileInput.value = '';
  showScreen('scan');
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void analyze(file);
});

// --- analyze ----------------------------------------------------------------

let objectUrl: string | null = null;
let sourceImage: HTMLImageElement | null = null;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Longest edge sent to the server. Plenty for symbol detection. */
const UPLOAD_MAX_EDGE = 1600;

/**
 * Shrink the photo to a modest JPEG before uploading. This matters on a real
 * phone for three reasons:
 *   - a 12MP iPhone photo is often 3–5 MB, and Vercel's serverless request body
 *     limit is ~4.5 MB, so full-size uploads fail at the platform edge;
 *   - it normalizes iOS HEIC into JPEG, which the vision API always accepts;
 *   - it is dramatically faster on cellular.
 * Crops are unaffected — those are taken from the full-resolution image already
 * decoded in the page, and the boxes are normalized 0–1000.
 */
async function toUploadBlob(img: HTMLImageElement, original: File): Promise<Blob> {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) return original;

  const scale = Math.min(1, UPLOAD_MAX_EDGE / Math.max(w, h));
  // Already small and already a format the API takes — send as-is.
  if (scale === 1 && /^image\/(jpeg|png|webp)$/.test(original.type)) return original;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return original;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.85)
  );
  return blob ?? original;
}

async function analyze(file: File) {
  if (!navigator.onLine) {
    renderError(
      "You appear to be offline",
      "Identifying symbols needs a network connection so the image can be analyzed. Reconnect and try again — the app itself will keep working offline."
    );
    return;
  }

  showScreen('loading');

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  try {
    sourceImage = await loadImage(objectUrl);
  } catch {
    sourceImage = null;
  }

  const form = new FormData();
  if (sourceImage) {
    const upload = await toUploadBlob(sourceImage, file);
    form.append('image', upload, 'scan.jpg');
  } else {
    // Couldn't decode it locally; let the server judge the original.
    form.append('image', file);
  }

  // Keep the network step and the render step in separate try blocks. If they
  // share one, a bug in rendering gets reported to the user as a connection
  // failure and the real stack is swallowed.
  let data: AnalyzeResponse & { error?: string };
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: form });
    data = (await res.json()) as AnalyzeResponse & { error?: string };

    if (!res.ok) {
      renderError('Analysis failed', data.error || `The server returned an error (${res.status}).`);
      return;
    }
  } catch (err) {
    console.error('[iconographer] analyze request failed:', err);
    if (!navigator.onLine) {
      renderError('Connection lost', 'The network dropped while analyzing. Reconnect and try again.');
    } else {
      renderError('Could not reach the server', 'The analysis request did not complete. Please try again.');
    }
    return;
  }

  try {
    renderResult(data);
  } catch (err) {
    console.error('[iconographer] rendering the result failed:', err);
    renderError(
      'Could not display the result',
      'The analysis came back, but something went wrong showing it. Details are in the browser console.'
    );
  }
}

// --- cropping ---------------------------------------------------------------

const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d');

/**
 * Crop a padded region of the source image using a normalized [ymin,xmin,ymax,xmax]
 * box (0..1000, Gemini's convention) and return a data URL thumbnail.
 */
function cropToDataUrl(img: HTMLImageElement, box: [number, number, number, number]): string | null {
  if (!cropCtx) return null;
  const [yminN, xminN, ymaxN, xmaxN] = box;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H) return null;

  let x0 = (xminN / 1000) * W;
  let y0 = (yminN / 1000) * H;
  let x1 = (xmaxN / 1000) * W;
  let y1 = (ymaxN / 1000) * H;
  if (x1 <= x0 || y1 <= y0) return null;

  // Pad ~15% on each side so the symbol isn't cropped edge-to-edge.
  const padX = (x1 - x0) * 0.15;
  const padY = (y1 - y0) * 0.15;
  x0 = Math.max(0, x0 - padX);
  y0 = Math.max(0, y0 - padY);
  x1 = Math.min(W, x1 + padX);
  y1 = Math.min(H, y1 + padY);

  const cropW = x1 - x0;
  const cropH = y1 - y0;
  const maxDim = 360;
  const scale = Math.min(1, maxDim / Math.max(cropW, cropH));

  cropCanvas.width = Math.max(1, Math.round(cropW * scale));
  cropCanvas.height = Math.max(1, Math.round(cropH * scale));
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(img, x0, y0, cropW, cropH, 0, 0, cropCanvas.width, cropCanvas.height);

  try {
    return cropCanvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}

// --- rendering ----------------------------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderResult(data: AnalyzeResponse) {
  const root = $('#result-body');
  root.innerHTML = '';

  const frame = el('div', 'photo-frame');
  const img = document.createElement('img');
  img.src = objectUrl!;
  img.alt = 'The artwork you captured';
  frame.appendChild(img);
  root.appendChild(frame);

  const { symbols, unmatchedElements, figureSuggestion, message } = data;

  // Optional, secondary context — never the headline claim.
  if (figureSuggestion) {
    const pill = el('div', 'figure-pill');
    pill.appendChild(el('span', 'figure-pill-label', 'Possibly related to'));
    pill.appendChild(el('span', 'figure-pill-name', figureSuggestion.name));
    root.appendChild(pill);
  }

  if (symbols.length === 0) {
    const banner = el('div', 'banner banner-note');
    banner.appendChild(infoIcon());
    banner.appendChild(el('span', undefined, message || 'No recognized symbols yet.'));
    root.appendChild(banner);
  } else {
    const grid = el('div', 'symbol-grid');
    for (const s of symbols) {
      grid.appendChild(renderSymbolCard(s));
    }
    root.appendChild(grid);
  }

  if (unmatchedElements.length > 0) {
    const section = el('section', 'also-detected');
    section.appendChild(el('h3', undefined, 'Also detected (not in reference set)'));
    const list = el('ul', 'chips');
    for (const e of unmatchedElements) {
      list.appendChild(el('li', 'chip', e));
    }
    section.appendChild(list);
    root.appendChild(section);
  }

  showScreen('result');
}

function renderSymbolCard(s: SymbolMatch): HTMLElement {
  const card = el('article', 'symbol-card');

  const crop = s.box && sourceImage ? cropToDataUrl(sourceImage, s.box) : null;
  if (crop) {
    const thumbWrap = el('div', 'symbol-thumb');
    const thumb = document.createElement('img');
    thumb.src = crop;
    thumb.alt = s.name;
    thumbWrap.appendChild(thumb);
    card.appendChild(thumbWrap);
  }

  const body = el('div', 'symbol-body');
  body.appendChild(el('p', 'symbol-category', s.category));
  body.appendChild(el('h3', 'symbol-name', capitalize(s.name)));
  body.appendChild(el('p', 'symbol-meaning', s.meaning));

  if (s.figures.length > 0) {
    const ctx = el('div', 'symbol-context');
    for (const f of s.figures.slice(0, 3)) {
      const line = el('p', 'symbol-context-line');
      const strong = el('span', 'symbol-context-name', f.name);
      line.appendChild(strong);
      line.appendChild(document.createTextNode(' — ' + f.note));
      ctx.appendChild(line);
    }
    body.appendChild(ctx);
  }

  card.appendChild(body);
  return card;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderError(title: string, body: string) {
  const root = $('#result-body');
  root.innerHTML = '';

  if (objectUrl) {
    const frame = el('div', 'photo-frame');
    const img = document.createElement('img');
    img.src = objectUrl;
    img.alt = 'The artwork you captured';
    frame.appendChild(img);
    root.appendChild(frame);
  }

  const banner = el('div', 'banner banner-error');
  banner.appendChild(warnIcon());
  const wrap = el('div');
  wrap.appendChild(el('strong', undefined, title));
  wrap.appendChild(el('div', undefined, body));
  banner.appendChild(wrap);
  root.appendChild(banner);

  showScreen('result');
}

function infoIcon(): SVGElement {
  return svg('M12 8h.01M11 12h1v4h1');
}
function warnIcon(): SVGElement {
  return svg('M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z');
}
function svg(path: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  s.appendChild(p);
  return s;
}
