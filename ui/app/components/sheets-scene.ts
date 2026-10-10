/**
 * The Home picture (the Sorting Room's `sheets()` scene, in three.js): a few hundred sheets of paper that follow the
 * four "How it works" chapters as the person scrolls. 0: loose sheets drifting (the pointer stirs them); 1: laid out in
 * a wall while a band reads across them, on this computer; 2: thin strips of text rising (only words travel); 3: a
 * stream through two rings, the confidence check and the reader, splitting into filed and needs review; 4: piles on
 * the floor, one per category plus "Needs review" and "Could not process". The labels are DOM (`.glabel`), placed
 * through custom properties each frame.
 *
 * It is decoration: `aria-hidden`, and the chapters beside it say everything it shows. It always moves, whatever the
 * system's motion setting (DECISIONS 155 addendum, 10 October 2026). The loop pauses while the picture is off screen
 * (one frame is drawn again when the scroll position or the size changes) and stops for good when the owner is
 * disposed. Only without WebGL is the frame still: a still arrangement of sheets and the four stage labels.
 */
import {
  CanvasTexture, CircleGeometry, Color, DoubleSide, Euler, Fog, GridHelper, InstancedMesh, Mesh, MeshBasicMaterial,
  Object3D, PerspectiveCamera, PlaneGeometry, Quaternion, Scene, TorusGeometry, Vector3, WebGLRenderer
} from 'three';
import { computed, effect, onCleanup, untrack, type Read } from '../../../core/ui/reactive.ts';
import { h } from '../view/dom.ts';

export interface SheetsLabels {
  check: string;
  reader: string;
  filed: string;
  review: string;
  failed: string;
}

export interface SheetsSpec {
  /** Where the reading is, 0–4 (a fraction between chapters while one scrolls into the next). */
  progress: Read<number>;
  labels: SheetsLabels;
  /** The category names for the piles (at most three are drawn); none: the category piles go unlabelled. */
  piles: Read<readonly string[]>;
  /** The caption shown at the start ("Move your pointer to stir"), and whether it is hidden now. */
  caption: string;
  captionHidden: Read<boolean>;
}

const COUNT = 400;
const MAX_PILES = 3;

/** A small seeded random source (mulberry32), so the arrangement is the same on every visit. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const ease = (k: number): number => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;

function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
}

/** The page texture: a heading, lines of text, and now and then a highlighted line. */
function pageTexture(): CanvasTexture {
  const tc = document.createElement('canvas');
  tc.width = 256; tc.height = 340;
  const g = tc.getContext('2d');
  if (g !== null) {
    g.fillStyle = '#F4EFE5'; g.fillRect(0, 0, 256, 340);
    g.fillStyle = '#26241F'; g.fillRect(22, 26, 150, 14); g.fillRect(22, 48, 96, 8);
    const LR = rng(5);
    for (let y = 78; y < 318; y += 13) {
      const w = 140 + LR() * 72;
      if (LR() < .12) { g.fillStyle = '#E6FF3B'; g.fillRect(18, y - 4, w * .7 + 8, 12); }
      g.fillStyle = 'rgba(38,36,31,.55)'; g.fillRect(22, y, (y > 300 ? w * .5 : w), 4);
    }
  }
  return new CanvasTexture(tc);
}

type Dot = 'hl' | 'paper' | 'pink' | 'grey';
const label = (text: Read<string> | string, dot: Dot, extra = ''): HTMLElement =>
  h('div', { class: `glabel${extra}`, vars: { '--o': 0 } }, h('i', { class: `glabel__dot glabel__dot--${dot}` }), text);

/** A sheet's fixed randoms, and where it ends up: which outcome, which pile, its place in that pile. */
interface Sheet { s1: number; s2: number; s3: number; s4: number; s5: number; s6: number; o: number; cat: number; si: number; idx: number }
interface Pose { x: number; y: number; z: number; rx: number; ry: number; rz: number; sc: number; sx: number; sy: number; c: number }
const pose = (): Pose => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sc: 1, sx: 1, sy: 1, c: 0 });

export function sheetsScene(spec: SheetsSpec): HTMLElement {
  const caption = h('div', { class: 'stage-cap', classes: { 'is-hidden': spec.captionHidden } },
    h('span', { class: 'stage-cap__hint' }, spec.caption));
  if (!webglAvailable()) return stillFallback(spec, caption);

  const cv = h('canvas', { attrs: { 'aria-hidden': 'true' } });
  const frame = h('div', { class: 'stage-frame sheets', attrs: { 'aria-hidden': 'true' } }, cv, caption);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  } catch {
    return stillFallback(spec, caption);
  }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  scene.fog = new Fog(0x161512, 9, 30);
  const camera = new PerspectiveCamera(45, 1, .1, 100);

  const tex = pageTexture();
  const sheetGeo = new PlaneGeometry(.62, .82), sheetMat = new MeshBasicMaterial({ map: tex, side: DoubleSide });
  const mesh = new InstancedMesh(sheetGeo, sheetMat, COUNT);
  scene.add(mesh);
  const ringMat = (c: number) => new MeshBasicMaterial({ color: c, transparent: true, opacity: 0 });
  const haloMat = (c: number) => new MeshBasicMaterial({ color: c, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
  const ringGeo = new TorusGeometry(1.25, .06, 20, 140), haloGeo = new CircleGeometry(1.2, 80);
  const ringA = new Mesh(ringGeo, ringMat(0xE6FF3B)), ringB = new Mesh(ringGeo, ringMat(0xF4EFE5));
  const haloA = new Mesh(haloGeo, haloMat(0xE6FF3B)), haloB = new Mesh(haloGeo, haloMat(0xF4EFE5));
  scene.add(ringA, ringB, haloA, haloB);
  const floor = new GridHelper(40, 40, 0x3A3832, 0x26241F);
  floor.position.y = -2.2; floor.material.transparent = true; floor.material.opacity = 0;
  scene.add(floor);

  // The four stage labels of chapter 3, and one label per pile for chapter 4.
  const L = spec.labels;
  const stageLabels = [label(L.check, 'hl'), label(L.reader, 'paper'), label(L.filed, 'paper'), label(L.review, 'pink')];
  const catLabels = Array.from({ length: MAX_PILES }, (_, i) => label(computed(() => spec.piles()[i] ?? ''), 'paper', ' pile-l'));
  const pileLabels = [...catLabels, label(L.review, 'pink', ' pile-l'), label(L.failed, 'grey', ' pile-l')];
  frame.append(...stageLabels, ...pileLabels);

  // The sheets: 60% filed, 33% needs review, the rest could not be processed.
  const R = rng(42), P: Sheet[] = [];
  for (let i = 0; i < COUNT; i++) {
    const r = R();
    P.push({ s1: R(), s2: R(), s3: R(), s4: R(), s5: R(), s6: R(), o: r < .6 ? 0 : r < .93 ? 1 : 2, cat: 0, si: 0, idx: i });
  }
  let cats = MAX_PILES;
  /** Deals the filed sheets onto `k` category piles (1–3) and numbers each sheet's place in its pile. */
  const deal = (k: number) => {
    cats = k;
    const stack = [0, 0, 0];
    let need = 0, failed = 0;
    for (const p of P) {
      p.cat = Math.min(k - 1, Math.floor(p.s6 * k));
      p.si = p.o === 0 ? stack[p.cat]++ : p.o === 1 ? need++ : failed++;
    }
  };
  deal(MAX_PILES);

  const PAPER = new Color(0xFFFFFF), PINK = new Color(0xFF7DBC), GREY = new Color(0x5A564E), HL = new Color(0xF4FF8A), DIM = new Color(0xBDB7AA);
  const col = (c: number): Color => c === 3 ? HL : c === 4 ? DIM : c === 5 ? HL : c === 11 ? PINK : c === 12 ? GREY : PAPER;

  let asp = 1, half = 5, uA = -1.6, uB = 1.2, wCols = 24, wRows = 17, wK = 1, tK = 1, tSp = 1.6;
  const place = (m: Object3D, u: number) => {
    const vert = asp < 1;
    m.position.set(vert ? 0 : u, vert ? -u : 0, 0);
    m.rotation.set(vert ? 1.05 : 0, vert ? 0 : 1.05, 0);
  };
  const pileOf = (p: Sheet): number => p.o === 0 ? p.cat : p.o === 1 ? cats : cats + 1;
  const pileX = (pile: number): number => (pile - (cats + 1) / 2) * tSp;

  /** Where sheet `p` is in figure `f` at time `t`. */
  function F(f: number, p: Sheet, t: number, o: Pose): void {
    o.sx = 1; o.sy = 1;
    if (f === 0) {
      const a = p.s1 * Math.PI * 2 + t * (.05 + p.s2 * .12), rad = 2.2 + p.s3 * 4.6;
      o.x = Math.cos(a) * rad; o.y = (p.s4 - .5) * 5.6 + Math.sin(t * .5 + p.s1 * 9) * .4; o.z = Math.sin(a) * rad * .7 - 2;
      o.rx = t * (.2 + p.s2 * .6) + p.s3 * 6; o.ry = t * (.15 + p.s4 * .5) + p.s1 * 6; o.rz = p.s5 * 6; o.sc = .85 + p.s5 * .35; o.c = 0;
    } else if (f === 1) {
      const cx = p.idx % wCols, cy = Math.floor(p.idx / wCols);
      o.x = (cx - (wCols - 1) / 2) * .7 * wK; o.y = ((wRows - 1) / 2 - cy) * .9 * wK; o.z = -3;
      const sweep = (wRows * .9 * wK) / 2 + 1.2, scan = ((t * .3) % 1) * sweep * 2 - sweep, d = (o.y - scan) / wK, k = Math.exp(-d * d * 1.4);
      o.z += k * 1.1; o.rx = -k * .5; o.ry = 0; o.rz = 0; o.sc = wK; o.c = k > .5 ? 3 : 0;
    } else if (f === 2) {
      const hgt = 15;
      o.x = (p.s1 - .5) * 6.5; o.y = ((p.s3 * hgt + t * 1.4) % hgt) - hgt / 2; o.z = (p.s4 - .5) * 4 - 1;
      o.rx = 0; o.ry = Math.sin(t + p.s5 * 6) * .25; o.rz = 0; o.sc = 1; o.sy = .07; o.sx = 1.4 + p.s2 * .9; o.c = 4;
    } else if (f === 3) {
      const len = half * 2.3, u = ((p.s1 * len + t * 1.1) % len) - len * 0.55;
      const ang = p.s2 * Math.PI * 2 + u * .9, rr = .12 + p.s3 * .62;
      let v = Math.sin(ang) * rr, z = Math.cos(ang) * rr * .8;
      if (u > uB) { const d = u - uB; const dir = p.o === 0 ? -1 : p.o === 1 ? 1 : 0; v += dir * d * .55; z -= p.o === 2 ? d * .9 : 0; }
      const vert = asp < 1;
      o.x = vert ? v : u; o.y = vert ? -u : v; o.z = z;
      o.rx = .12; o.ry = -.18; o.rz = Math.sin(ang) * .25;
      o.sc = .46 * (u > uB && p.o === 2 ? Math.max(.25, 1 - (u - uB) * .25) : 1);
      o.c = u > uB ? 10 + p.o : (u > uA ? 5 : 0);
    } else {
      o.x = pileX(pileOf(p)) + Math.sin(p.si * 1.7) * .03; o.y = -2.15 + p.si * .034; o.z = -.6;
      o.rx = -Math.PI / 2; o.ry = 0; o.rz = (p.s1 - .5) * .22; o.sc = tK; o.c = 10 + p.o;
    }
  }

  const cams = [
    { p: [0, .2, 11], l: [0, 0, -1] }, { p: [0, 0, 10.5], l: [0, 0, -3] }, { p: [0, -.5, 9.5], l: [0, 0, -1] },
    { p: [0, .35, 10], l: [0, 0, 0] }, { p: [0, 3.2, 10.5], l: [0, .45, 0] }
  ];
  const mouse = { x: 0, y: 0, on: false };
  const onMove = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { mouse.on = false; return; }
    mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1; mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1; mouse.on = true;
  };
  addEventListener('pointermove', onMove, { passive: true });

  const dummy = new Object3D(), qa = new Quaternion(), qb = new Quaternion(), ea = new Euler(), eb = new Euler();
  const A = pose(), B = pose(), c3 = new Color(), v3 = new Vector3(), cp = new Vector3(), cl = new Vector3(), lv = new Vector3();
  const at = (el: HTMLElement, x: number, y: number, o: number) => {
    el.style.setProperty('--x', `${x}px`); el.style.setProperty('--y', `${y}px`); el.style.setProperty('--o', String(o));
  };
  let W = 0, H = 0, sm = 0;
  const t0 = performance.now();

  function draw(now: number): void {
    const w = cv.clientWidth, hgt = cv.clientHeight;
    if (w === 0 || hgt === 0) return;
    if (w !== W || hgt !== H) {
      W = w; H = hgt; renderer.setSize(W, H, false);
      camera.aspect = W / H; camera.fov = W / H < .9 ? 62 : 45; camera.updateProjectionMatrix();
    }
    const t = (now - t0) / 1000;
    const tan = Math.tan(camera.fov * Math.PI / 360);
    asp = W / Math.max(1, H);
    const visH = tan * 10;
    half = .86 * (asp >= 1 ? visH * asp : visH); uA = -.42 * half; uB = .2 * half;
    wCols = Math.max(8, Math.round(Math.sqrt(COUNT * asp * 1.3))); wRows = Math.ceil(COUNT / wCols);
    { const h2 = 2 * tan * 13.5, w2 = h2 * asp; wK = Math.min(1.2, w2 * .84 / (wCols * .7), h2 * .8 / (wRows * .9)); }
    tSp = clamp((2 * tan * 11.5 * asp) * .84 / (cats + 2), .62, 2.1); tK = clamp(tSp / 1.25, .5, 1.1);
    const target = untrack(spec.progress);
    sm += (target - sm) * .08;
    const f = Math.min(3, Math.floor(sm)), k = sm - f, ke = ease(clamp(k, 0, 1)), ca = cams[f], cb = cams[f + 1];
    cp.set(ca.p[0] + (cb.p[0] - ca.p[0]) * ke, ca.p[1] + (cb.p[1] - ca.p[1]) * ke, ca.p[2] + (cb.p[2] - ca.p[2]) * ke);
    cl.set(ca.l[0] + (cb.l[0] - ca.l[0]) * ke, ca.l[1] + (cb.l[1] - ca.l[1]) * ke, ca.l[2] + (cb.l[2] - ca.l[2]) * ke);
    if (mouse.on) { cp.x += mouse.x * .4; cp.y += mouse.y * .25; }
    camera.position.copy(cp); camera.lookAt(cl); camera.updateMatrixWorld();
    v3.set(mouse.x, mouse.y, .5).unproject(camera).sub(camera.position).normalize();
    const dist = (-2 - camera.position.z) / v3.z, mx = camera.position.x + v3.x * dist, my = camera.position.y + v3.y * dist;
    const swirl = clamp(1 - sm, 0, 1) * (mouse.on ? 1 : 0);
    for (let i = 0; i < COUNT; i++) {
      const p = P[i]; F(f, p, t, A); F(f + 1, p, t, B);
      const ki = ease(clamp(k * 1.7 - p.s5 * .7, 0, 1));
      let x = A.x + (B.x - A.x) * ki, y = A.y + (B.y - A.y) * ki, z = A.z + (B.z - A.z) * ki;
      if (swirl) {
        const dx = x - mx, dy = y - my, fo = Math.exp(-(dx * dx + dy * dy) / 3) * 2 * swirl;
        x += (-dy * 1.2 + dx * .6) * fo; y += (dx * 1.2 + dy * .6) * fo; z += fo * 1.3;
      }
      ea.set(A.rx, A.ry, A.rz); eb.set(B.rx, B.ry, B.rz); qa.setFromEuler(ea); qb.setFromEuler(eb); qa.slerp(qb, ki);
      dummy.position.set(x, y, z); dummy.quaternion.copy(qa);
      const sc = A.sc + (B.sc - A.sc) * ki;
      dummy.scale.set(sc * (A.sx + (B.sx - A.sx) * ki), sc * (A.sy + (B.sy - A.sy) * ki), 1);
      dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
      c3.copy(col(A.c)).lerp(col(B.c), ki); mesh.setColorAt(i, c3);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const ro = clamp(1 - Math.abs(sm - 3) * 1.25, 0, 1);
    ringA.material.opacity = ro; ringB.material.opacity = ro * .95;
    haloA.material.opacity = ro * (.07 + Math.sin(t * 2.4) * .025); haloB.material.opacity = ro * (.05 + Math.sin(t * 2.4 + 1.5) * .02);
    place(ringA, uA); place(ringB, uB); place(haloA, uA); place(haloB, uB);
    // The pile labels (chapter 4): beneath each pile, staggered when they would touch.
    {
      const po = clamp((sm - 3.55) * 2.6, 0, 1);
      lv.set(tSp, 0, -.6).project(camera); const spx = Math.abs(lv.x) / 2 * W;
      lv.set(0, 0, -.6).project(camera); const gap = spx - Math.abs(lv.x) / 2 * W;
      const shown = pileLabels.filter((_, i) => i >= MAX_PILES || i < cats);
      const tight = shown.some(d => d.offsetWidth > gap * .96);
      pileLabels.forEach((d, i) => {
        const pile = i < MAX_PILES ? i : cats + (i - MAX_PILES);
        const visible = (i >= MAX_PILES || i < cats) && d.textContent !== '';
        lv.set(pileX(pile), -2.15 - .4, -.6).project(camera);
        const lw = d.offsetWidth / 2 + 6;
        at(d, clamp((lv.x + 1) / 2 * W, lw, W - lw), Math.min(H - 22, (1 - lv.y) / 2 * H + (tight && pile % 2 ? 34 : 0)), visible ? po : 0);
      });
    }
    // The stage labels (chapter 3): the two rings, then the two ways out.
    {
      const vert = asp < 1, off = 1.75, end = half * (vert ? .95 : .8), spread = (end - uB) * .55;
      const pts = vert
        ? [[uA, off], [uB, off], [end, -spread - .55], [end, spread + .55]]
        : [[uA, off * .95], [uB, -off * .95], [end, -spread - .7], [end, spread + .7]];
      pts.forEach(([u, v], i) => {
        lv.set(vert ? v : u, vert ? -u : v, 0).project(camera);
        const d = stageLabels[i], lw = d.offsetWidth / 2 + 10, lh = d.offsetHeight / 2 + 10;
        at(d, clamp((lv.x + 1) / 2 * W, lw, W - lw), clamp((1 - lv.y) / 2 * H, lh, H - lh), clamp((ro - .6) * 2.5, 0, 1));
      });
    }
    floor.material.opacity = clamp((sm - 3.2) * 1.2, 0, .9);
    renderer.render(scene, camera);
  }

  // The loop runs while the picture is on screen; off screen, one frame is drawn again on a change.
  let onScreen = true, looping = false;
  const still = () => { if (!looping) draw(performance.now()); };
  const sync = () => {
    const run = onScreen;
    if (run === looping) return;
    looping = run;
    renderer.setAnimationLoop(run ? draw : null);
    if (!run) still();
  };
  const seen = new IntersectionObserver(entries => {
    for (const entry of entries) onScreen = entry.isIntersecting;
    sync();
  });
  seen.observe(frame);
  const sized = new ResizeObserver(() => still());
  sized.observe(frame);
  sync();
  effect(() => { spec.progress(); untrack(still); });
  effect(() => {
    const k = clamp(spec.piles().length, 1, MAX_PILES);
    if (k !== untrack(() => cats)) untrack(() => { deal(k); still(); });
  });

  onCleanup(() => {
    renderer.setAnimationLoop(null);
    looping = false;
    seen.disconnect();
    sized.disconnect();
    removeEventListener('pointermove', onMove);
    sheetGeo.dispose(); sheetMat.dispose(); tex.dispose(); ringGeo.dispose(); haloGeo.dispose();
    for (const m of [ringA, ringB, haloA, haloB]) m.material.dispose();
    floor.geometry.dispose(); floor.material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  });
  return frame;
}

/** Without WebGL: a still pile of sheets and the four stages in order. */
function stillFallback(spec: SheetsSpec, caption: HTMLElement): HTMLElement {
  void caption;
  const L = spec.labels;
  return h('div', { class: 'stage-frame sheets sheets--still', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'sheets-still__stack' }, ...[-7, 5, -2, 8, -4].map(turn => h('i', { vars: { '--turn': `${turn}deg` } }))),
    h('div', { class: 'sheets-still__labels' },
      ...[[L.check, 'hl'], [L.reader, 'paper'], [L.filed, 'paper'], [L.review, 'pink']]
        .map(([text, dot]) => h('span', { class: 'glabel glabel--static' }, h('i', { class: `glabel__dot glabel__dot--${dot}` }), text))));
}
