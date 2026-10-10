/* Light Architecture prototype behaviour. Static, no network. Every movement is started by an event:
   a click, a key, or one of the prototype simulators. Nothing here pretends progress on a timer. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const NS = 'http://www.w3.org/2000/svg';
  const root = document.documentElement;
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => root.dataset.motion === 'reduce' || (root.dataset.motion !== 'full' && mqReduce.matches);
  const EASE = {
    out: 'cubic-bezier(.16,1,.3,1)', soft: 'cubic-bezier(.22,1,.36,1)', inout: 'cubic-bezier(.65,0,.35,1)',
    in: 'cubic-bezier(.4,0,1,1)', trace: 'cubic-bezier(.45,.05,.2,1)', text: 'cubic-bezier(.2,.8,.2,1)',
    roll: 'cubic-bezier(.3,.7,.1,1)', leave: 'cubic-bezier(.2,.6,.4,1)',
  };
  const A = (el, frames, opts) => (!el || reduced()) ? null : el.animate(frames, Object.assign({ duration: 400, easing: EASE.out, fill: 'backwards' }, opts));
  const setText = (el, t) => { if (el && el.textContent !== String(t)) el.textContent = t; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------------ text reveal
     Text resolves in with a short fade and a slight rise. Only the stage heading, when a screen opens, carries a little
     blur. Text animates only when its meaning changes (a screen opens; a phase, state or failure changes). A number or
     a time changing inside a sentence is written in place, still: text that can already be read is never taken back
     to opacity 0. The count carries a changed number (digit roll). */
  const TEXT = {
    open: { dur: 300, rise: 8, blur: 0 },    // header sentences and pane first lines when a screen opens
    word: { dur: 320, rise: 10, blur: 4 },   // stage heading words when a screen opens
    change: { dur: 260, rise: 4, blur: 0 },  // a sentence or state word whose meaning changed
    fail: { dur: 180, rise: 3, blur: 0 },    // failure text: the fastest text on the page
  };
  const visible = e => e && e.getClientRects().length > 0;
  function reveal(el, delay = 0, kind = 'open') {
    const k = TEXT[kind];
    const from = { opacity: 0, transform: `translateY(${k.rise}px)` }, to = { opacity: 1, transform: 'none' };
    if (k.blur) { from.filter = `blur(${k.blur}px)`; to.filter = 'blur(0px)'; }
    return A(el, [from, to], { duration: k.dur, delay, easing: EASE.text });
  }
  // A heading resolves word by word (20 ms apart, at most 7 steps), so long headings are not slower to read.
  function splitWords(h) {
    if (!h) return [];
    if (h.querySelector('.w')) return $$('.w', h);
    const walk = node => {
      for (const n of [...node.childNodes]) {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const p of n.data.split(/(\s+)/)) { if (!p) continue; if (/^\s+$/.test(p)) frag.append(p); else { const s = document.createElement('span'); s.className = 'w'; s.textContent = p; frag.append(s); } }
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && !n.classList.contains('sr-only')) walk(n);
      }
    };
    walk(h); return $$('.w', h);
  }
  function revealWords(h, delay = 0, kind = 'word') { splitWords(h).forEach((w, i) => reveal(w, delay + Math.min(i, 7) * 20, kind)); }
  // Set a status sentence. `key` names its meaning. The sentence resolves in only when the meaning changed on an event;
  // the same meaning with a new number or time is written in place, with no animation.
  function setLive(el, t, animate, key = t, delay = 0, kind = 'change') {
    if (!el) return false; t = String(t);
    const k = String(key), had = el.dataset.k, meaning = had !== undefined && had !== k;
    el.dataset.k = k;
    if (el.textContent === t) return false;
    el.textContent = t;
    if (animate && meaning && t && visible(el)) reveal(el, delay, kind);
    return meaning;
  }
  function setLiveHTML(el, html, animate, key = html, delay = 0) {
    if (!el) return false;
    const k = String(key), had = el.dataset.k, meaning = had !== undefined && had !== k;
    el.dataset.k = k;
    if (el.innerHTML === html) return false;
    el.innerHTML = html;
    if (animate && meaning && html && visible(el)) reveal(el, delay, 'change');
    return meaning;
  }
  // A heading that changes on a phase change: only the words that changed resolve in ("Sending" → "Sorting");
  // "114 documents" stays still.
  function setHeading(el, t, animate) {
    if (!el) return; t = String(t);
    if (el.textContent === t) return;
    const before = el.textContent.split(/\s+/);
    el.textContent = t;
    if (!animate || !visible(el)) return;
    splitWords(el).forEach((w, i) => { if (w.textContent !== before[i]) reveal(w, Math.min(i, 7) * 20, 'change'); });
  }
  const hms = s => [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':');
  const hm = s => hms(s).slice(0, 5);
  const T0 = (h, m, s) => h * 3600 + m * 60 + s;
  const glyph = (id, cls = 'g') => `<svg class="${cls}" aria-hidden="true"><use href="#g-${id}"/></svg>`;

  /* ------------------------------------------------------------------ placeholder content */
  const CATS = [
    { id: 'procedures', name: 'Procedures', what: 'Step-by-step instructions for carrying out a task: how to submit, request, apply for or complete something, in order.',
      not: [['Material that mainly explains a topic without telling the reader what to do; that belongs in Explainers.', 'explainers'], ['Blank forms to fill in belong in Forms.', 'forms']],
      ex: ['Room booking steps', 'How to claim travel expenses', 'Printer setup guide'] },
    { id: 'explainers', name: 'Explainers', what: 'Material that explains a topic so the reader understands it: handouts, overviews and briefings meant to be read on their own.',
      not: [['Instructions the reader follows step by step belong in Procedures.', 'procedures'], ['Slides made for teaching a group in a session belong in Training.', 'training']],
      ex: ['Budget handout', 'How the rota works', 'Welcome pack'] },
    { id: 'reports', name: 'Reports', what: 'Records of what happened over a period: summaries, reviews, results and minutes.',
      not: [['Plans and proposals for what will happen next belong in Explainers.', 'explainers']], ex: ['Quarterly summary', 'Annual review', 'Minutes of a meeting'] },
    { id: 'forms', name: 'Forms', what: 'Blank or partly filled forms and templates that someone completes and returns.',
      not: [['Instructions about how to fill in a form belong in Procedures.', 'procedures']], ex: ['Leave request form', 'Registration form', 'Expenses form'] },
    { id: 'training', name: 'Training', what: 'Material made for teaching a group in a session: slide decks, exercises and trainer notes.',
      not: [['Stand-alone explanations meant to be read alone belong in Explainers.', 'explainers']], ex: ['Induction session slides', 'Workshop exercises', 'Trainer notes'] },
  ];
  const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
  const NEIGHBOUR = { procedures: 'explainers', explainers: 'procedures', reports: 'explainers', forms: 'procedures', training: 'explainers' };
  const REASON = {
    procedures: 'It lists the steps for completing a task, in order, with what to do at each step.',
    explainers: 'It explains a topic so the reader understands it, without asking them to do anything.',
    reports: 'It records what happened over a period, with results and a short summary.',
    forms: 'It is a form with fields to fill in and return.',
    training: 'It is a set of session slides with exercises for a group.',
  };
  const QUOTES = {
    procedures: ['Step 1: open the request form and fill in section A.', 'Step 2: send it to your line manager for approval.'],
    explainers: ['This handout explains how the budget is set each year.', 'You do not need to do anything after reading it.'],
    reports: ['Between April and June the team handled 1,240 requests.', 'Summary of results for the quarter.'],
    forms: ['Name: ________    Date: ________', 'Return this form to the office when complete.'],
    training: ['Exercise 2: in pairs, discuss the scenario on the next slide.', 'Session 3 of 6: working with the booking system.'],
  };

  function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const R = rng(20260925);

  const RAW = [
    ['Onboarding checklist', 'docx', 'procedures'], ['Quarterly summary Q2', 'pdf', 'reports'], ['Week 3 slides', 'pptx', 'training'], ['Leave request form', 'docx', 'forms'],
    ['Week 4 slides', 'pptx', 'procedures'], ['Budget handout', 'pdf', 'explainers'], ['Team plan 2026', 'docx', 'explainers'], ['Scanned letter', 'pdf', null],
    ['Room booking steps', 'docx', 'procedures'], ['Meeting notes March', 'docx', 'reports'], ['Annual review', 'pdf', 'reports'], ['Expenses form', 'pdf', 'forms'],
    ['Induction session slides', 'pptx', 'training'], ['Safety walkthrough', 'pptx', 'training'], ['Printer setup guide', 'pdf', 'procedures'], ['Travel claim form', 'docx', 'forms'],
    ['How the rota works', 'docx', 'explainers'], ['Monthly results May', 'pdf', 'reports'], ['Registration form', 'docx', 'forms'], ['Fire drill steps', 'pdf', 'procedures'],
    ['New starter overview', 'pptx', 'explainers'], ['Parking permit form', 'pdf', 'forms'], ['Minutes 14 June', 'docx', 'reports'], ['Visitor sign-in steps', 'docx', 'procedures'],
    ['Equipment loan form', 'docx', 'forms'], ['Welcome pack', 'pdf', 'explainers'], ['Customer survey summary', 'pdf', 'reports'], ['Password reset steps', 'pdf', 'procedures'],
    ['Course feedback form', 'docx', 'forms'], ['Workshop exercises', 'docx', 'training'], ['Trainer notes session 4', 'docx', 'training'], ['Annual plan overview', 'pptx', 'explainers'],
    ['Fax copy', 'pdf', null],
  ];
  for (const n of [1, 2, 5, 6, 7, 8, 9, 10, 11, 12]) RAW.push([`Week ${n} slides`, 'pptx', n === 5 || n === 6 ? 'procedures' : n % 3 === 0 ? 'explainers' : 'training']);
  for (let n = 1; n <= 6; n++) RAW.push([`Workshop ${n} slides`, 'pptx', 'training']);
  for (const t of ['the booking system', 'the new rota', 'team roles', 'the holiday policy', 'site parking', 'the budget cycle', 'the help desk', 'the records policy', 'meeting rooms', 'the intranet']) RAW.push([`Guide to ${t}`, R() < .5 ? 'docx' : 'pdf', 'explainers']);
  for (const t of ['Desk move', 'Key card', 'Software install', 'Laptop return', 'Room setup', 'Delivery booking', 'Mail sorting', 'Incident report', 'Stock check', 'Badge renewal']) RAW.push([`${t} steps`, 'docx', 'procedures']);
  for (const t of ['Overtime', 'Training request', 'Name change', 'Supplier', 'Asset return', 'Change request', 'Petty cash', 'Event booking']) RAW.push([`${t} form`, R() < .5 ? 'docx' : 'pdf', 'forms']);
  for (const m of ['January', 'February', 'April', 'July', 'September', 'October']) RAW.push([`Minutes ${m}`, 'docx', 'reports']);
  for (const m of ['June', 'July', 'August', 'September', 'October']) RAW.push([`Monthly results ${m}`, 'pdf', 'reports']);
  for (let n = 1; n <= 8; n++) RAW.push([`Newsletter issue ${n}`, 'pdf', 'explainers']);
  for (let n = 1; n <= 8; n++) RAW.push([`Weekly update ${n}`, 'docx', 'reports']);
  for (let n = 1; n <= 4; n++) RAW.push([`Quiz round ${n}`, 'docx', 'training']);
  for (const t of ['Opening', 'Closing', 'First aid', 'Travel', 'Audit', 'Year end']) RAW.push([`${t} checklist`, 'docx', 'procedures']);
  const TOTAL = RAW.length; // 114

  const DOCS = RAW.map(([name, ext, cat], i) => ({ id: 'd' + i, i, name, ext, cat }));
  const byName = Object.fromEntries(DOCS.map(d => [d.name, d]));
  const special = { 'Week 3 slides': ['disagree', true], 'Week 4 slides': ['two', false], 'Team plan 2026': ['low', false], 'Meeting notes March': ['none', true] };
  const kinds = ['disagree', 'low', 'two', 'disagree', 'low'];
  let picked = 0, firstLeft = 2;
  for (const d of DOCS) {
    if (!d.cat) { d.outcome = 'failed'; continue; }
    if (special[d.name]) { [d.kind, d.first] = special[d.name]; d.outcome = 'review'; continue; }
    d.outcome = 'filed';
  }
  const pool = DOCS.filter(d => d.outcome === 'filed' && !/^Week [56] /.test(d.name));
  while (picked < 25) {
    const d = pool[Math.floor(R() * pool.length)];
    if (d.outcome !== 'filed') continue;
    d.outcome = 'review'; d.kind = kinds[picked % kinds.length];
    if (d.kind === 'disagree' && firstLeft > 0) { d.first = true; firstLeft--; }
    picked++;
  }
  for (const d of DOCS) {
    const C = d.cat && CAT[d.cat].name, N = d.cat && CAT[NEIGHBOUR[d.cat]].name;
    if (d.outcome === 'failed') { d.where = 'Could not process'; d.why = d.name === 'Fax copy' ? 'This PDF is a scanned image with no text.' : 'This PDF is a scanned image with no text.'; continue; }
    if (d.outcome === 'filed') { d.pct = 90 + Math.floor(R() * 10); d.where = C; d.why = `Both systems chose ${C}; ${d.pct}% sure.`; d.choice = d.cat; d.readerYes = [d.cat]; continue; }
    d.where = 'Needs review';
    if (d.kind === 'disagree') { d.pct = 60 + Math.floor(R() * 28); d.choice = NEIGHBOUR[d.cat]; d.readerYes = [d.cat]; d.why = 'The two systems chose different categories.'; }
    if (d.kind === 'low') { d.pct = 70 + Math.floor(R() * 19); d.choice = d.cat; d.readerYes = [d.cat]; d.why = `Both chose ${C}, but only ${d.pct}% sure (90% needed).`; }
    if (d.kind === 'two') { d.pct = 82 + Math.floor(R() * 7); d.choice = d.cat; d.readerYes = [d.cat, NEIGHBOUR[d.cat]]; d.why = 'The reader said it fits two categories.'; }
    if (d.kind === 'none') { d.pct = 58; d.choice = 'none'; d.readerYes = []; d.why = 'No category fitted; it may need a new one.'; }
  }
  // the owner-visible example opened on Results
  Object.assign(byName['Week 3 slides'], { cat: 'procedures', choice: 'explainers', pct: 84, readerYes: ['procedures'], rich: true });
  Object.assign(byName['Team plan 2026'], { pct: 81, why: 'Both chose Explainers, but only 81% sure (90% needed).' });

  const F = DOCS.filter(d => d.outcome === 'filed'), RV = DOCS.filter(d => d.outcome === 'review'), X = DOCS.filter(d => d.outcome === 'failed');
  function interleave(groups) {
    const total = groups.reduce((a, g) => a + g.n, 0), taken = groups.map(() => 0), out = [];
    for (let k = 0; k < total; k++) {
      let best = -1, bestDef = -Infinity;
      groups.forEach((g, i) => { if (taken[i] >= g.n) return; const def = g.n * (k + 1) / total - taken[i]; if (def > bestDef) { bestDef = def; best = i; } });
      out.push(groups[best].items[groups[best].off + taken[best]]); taken[best]++;
    }
    return out;
  }
  const DECIDE = interleave([{ items: F, off: 0, n: 52 }, { items: RV, off: 0, n: 20 }, { items: X, off: 0, n: 1 }])
    .concat(interleave([{ items: F, off: 52, n: F.length - 52 }, { items: RV, off: 20, n: RV.length - 20 }, { items: X, off: 1, n: X.length - 1 }]));
  const DECIDE0 = DECIDE.slice();
  const countsAt = n => { const c = { filed: 0, review: 0, failed: 0 }; for (let k = 0; k < n; k++) c[DECIDE[k].outcome]++; return c; };
  const OUT_WORD = { filed: 'Filed', review: 'Needs review', failed: 'Could not process' };
  const OUT_GLYPH = { filed: 'check', review: 'person', failed: 'slash' };
  const pill = o => `<span class="pill pill--${o}">${glyph(OUT_GLYPH[o])}${OUT_WORD[o]}</span>`;

  /* ------------------------------------------------------------------ state */
  const S = {
    screen: 'home', spineCur: null,
    run: { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' },
    read: null, confirm: null, live: null, results: null, review: null,
    pending: null, lastChange: 0,
  };
  const fresh = {
    // clock: the (simulated) time of the last file read; each file takes about a second
    read(phase = 'reading', n = 38) { return { phase, n, health: 'ok', clock: T0(13, 52, 10) - (38 - n), failAt: null, waitWhy: null }; },
    confirm() { return { mode: null, limit: '', nolimit: false }; },
    live(phase) {
      DECIDE.splice(0, DECIDE.length, ...DECIDE0);
      // clock: time of the last change; checkedAt: time of the last successful status check; waitWhy: queue | quiet
      const base = { paused: false, buffered: 0, health: 'ok', docFail: null, checkedAt: null, waitWhy: null, waitSince: 0, waitMin: 0 };
      if (phase === 'sending') return { ...base, phase, sent: 57, decided: 0, clock: T0(14, 44, 10), lastRx: T0(14, 44, 10), act: actFromSent(57, T0(14, 44, 10)) };
      if (phase === 'stalled') return { ...base, phase, sent: 13, decided: 0, clock: T0(14, 2, 31), lastRx: T0(14, 2, 31), act: actFromSent(13, T0(14, 2, 31)) };
      if (phase === 'done') return { ...base, phase, sent: TOTAL, decided: TOTAL, clock: T0(14, 31, 52), lastRx: T0(13, 59, 20), sentAt: T0(13, 59, 20), act: actFromDecided(TOTAL, T0(14, 31, 52)) };
      return { ...base, phase: 'sorting', sent: TOTAL, decided: 73, clock: T0(14, 23, 4), lastRx: T0(13, 59, 20), sentAt: T0(13, 59, 20), act: actFromDecided(73, T0(14, 23, 4)) };
    },
    results() { return { show: 'all', q: '', open: byName['Week 3 slides'].id, limit: 25 }; },
    review() {
      return {
        ticks: { procedures: true, explainers: false, reports: true, forms: true, training: false, review: true, failed: false },
        newFolder: null, openEither: byName['Week 4 slides'].id, marks: { [byName['Week 4 slides'].id]: ['procedures', 'explainers'] }, saved: false, pendingSave: false,
      };
    },
  };
  function actFromDecided(n, clock) {
    const gaps = [0, 7, 15, 23, 34], out = [];
    for (let k = 0; k < 5 && n - 1 - k >= 0; k++) { const d = DECIDE[n - 1 - k]; out.push({ id: 'x' + (n - 1 - k), t: clock - gaps[k], doc: d, kind: 'decided' }); }
    return out;
  }
  function actFromSent(n, clock) {
    const out = [];
    for (let k = 0; k < 5 && n - 1 - k >= 0; k++) out.push({ id: 's' + (n - 1 - k), t: clock - k * 3, doc: DOCS[n - 1 - k], kind: 'sent' });
    return out;
  }
  S.read = fresh.read(); S.confirm = fresh.confirm(); S.live = fresh.live('sorting'); S.results = fresh.results(); S.review = fresh.review();

  // A run that has not been started yet. Once reading has begun the header no longer says "Not started yet": the light
  // beside the name says what is happening.
  const newRun = begun => ({ name: 'New run', when: begun ? '' : 'Not started yet', kind: 'This run' });
  // Each preset sets the scene, including how long ago the last new count arrived (S.lastChange), so that a recovery
  // from it reads truthfully: it was not a result.
  const ago = min => performance.now() - min * 60000;
  const PRESETS = {
    // Home stands for "the runs list just answered": a working run's card says Working (still, no pulse)
    home: () => { const L = S.live; if (S.run.name === 'Run 9' && (L.phase === 'sorting' || L.phase === 'sending') && L.health === 'ok' && !L.paused) Pulse.confirm(); return { screen: 'home' }; },
    // a preset that shows work in progress stands for "a status check just succeeded and saw progress"
    read: () => { S.run = newRun(true); S.read = fresh.read(); Pulse.confirm(); return { screen: 'read' }; },
    // reading stopped a little while ago: the last file was read 2 min before this view
    'read-failed': () => { S.run = newRun(true); S.read = fresh.read(); S.read.health = 'lost'; S.read.failAt = S.read.clock + 2; S.lastChange = ago(2); return { screen: 'read' }; },
    'read-choose': () => { S.run = newRun(false); S.read = fresh.read('choose', 0); return { screen: 'read' }; },
    'read-done': () => { S.run = newRun(true); S.read = fresh.read('done', TOTAL); return { screen: 'read' }; },
    confirm: () => { S.run = newRun(true); S.confirm = fresh.confirm(); syncConfirmInputs(); return { screen: 'confirm' }; },
    'confirm-ready': () => { S.run = newRun(true); S.confirm = { mode: 'interactive', limit: '5', nolimit: false }; syncConfirmInputs(); return { screen: 'confirm' }; },
    live: () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.live = fresh.live('sorting'); Pulse.confirm(); return { screen: 'live' }; },
    // queued, no change for 4 min
    'live-waiting': () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.live = fresh.live('sorting'); Object.assign(S.live, { health: 'waiting', waitWhy: 'queue', waitMin: 4, waitSince: performance.now(), checkedAt: S.live.clock + 246 }); S.lastChange = ago(4); return { screen: 'live' }; },
    // the page lost the service just after the last outcome, which arrived 2 min before this view
    'live-checkfail': () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.live = fresh.live('sorting'); S.live.health = 'checkfail'; S.live.failAt = S.live.clock + 11; S.lastChange = ago(2); return { screen: 'live' }; },
    'live-sending': () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.live = fresh.live('sending'); Pulse.confirm(); return { screen: 'live' }; },
    // sending stopped; the last document arrived 41 min before this view
    'live-stalled': () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.live = fresh.live('stalled'); S.live.quietMin = 41; S.lastChange = ago(41); return { screen: 'live' }; },
    'live-done': () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.live = fresh.live('done'); return { screen: 'live' }; },
    results: () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.results = fresh.results(); return { screen: 'results' }; },
    review: () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.review = fresh.review(); return { screen: 'review' }; },
    'review-answered': () => { S.run = { name: 'Run 9', when: '25 Sep · 13:58', kind: 'This run' }; S.review = fresh.review(); S.review.newFolder = 'new'; return { screen: 'review' }; },
  };

  /* ------------------------------------------------------------------ elements */
  const scr = Object.fromEntries($$('[data-screen]').map(el => [el.dataset.screen, el]));
  const ORDER = ['home', 'read', 'confirm', 'live', 'results', 'review'];
  const frame = $('.frame');
  const announcer = $('[data-announce]');
  let lastAnnounce = 0;
  const announce = (t, force) => { const now = performance.now(); if (!force && now - lastAnnounce < 2500) return; lastAnnounce = now; announcer.textContent = t; };

  /* ------------------------------------------------------------------ edge trace (panes)
     A band of light slides once along the pane's edge: one element moved by translateX, seen through a static ring mask
     just inside the border, so it runs along the top and bottom edges and lights each side as it passes. Transform and
     opacity only. If the pane's surface is growing at that moment (a failure block has just arrived), the ring grows
     with it on the same transform, so the light never runs ahead of the edge. */
  function trace(p, delay = 0, { dur = 900, fail = false } = {}) {
    if (reduced() || !p) return;
    let t = p.querySelector(':scope > .trace');
    if (!t) { t = document.createElement('span'); t.className = 'trace'; t.setAttribute('aria-hidden', 'true'); t.innerHTML = '<i></i>'; p.appendChild(t); }
    t.classList.toggle('is-fail', fail);
    t.getAnimations({ subtree: true }).forEach(a => a.cancel());
    // the band is 34% of the pane wide: from just off the left edge to just off the right edge
    A(t.firstChild, [{ transform: 'translateX(-100%)', opacity: 0 }, { opacity: 1, offset: .12 }, { opacity: 1, offset: .78 }, { transform: 'translateX(295%)', opacity: 0 }], { duration: dur, delay, easing: EASE.trace, fill: 'none' });
    const grow = p._grow && p._grow.playState === 'running' ? p._grow : null;
    if (grow) { const tm = grow.effect.getTiming(), g = t.animate(grow.effect.getKeyframes().map(k => ({ transform: k.transform, offset: k.offset })), { duration: tm.duration, easing: tm.easing }); g.currentTime = grow.currentTime; }
  }

  /* ------------------------------------------------------------------ digit roll (never a count-up: the true value arrives at once)
     Only the digits that changed move. Each sits in its own box, as wide as the wider of its old and new digit, and moves
     by exactly one line: the old digit leaves the top as the new one arrives from below, so the two never overlap. The
     window is the numeral band only (cap height to baseline, measured from the font in use), with a static soft edge
     just outside it: digits come out of and go into that edge instead of being cut, and a digit at rest is fully inside
     it, so nothing changes when the roll hands back to plain text. No blur on the thin numerals. 280 ms; when two
     digits change, the right-hand one leads by 24 ms, like a counter. */
  const ROLL = 280;
  const bands = new Map();
  let mctx = null;
  function numeralBand(el) {
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize);
    const lh = /px$/.test(cs.lineHeight) ? parseFloat(cs.lineHeight) : cs.lineHeight === 'normal' ? NaN : parseFloat(cs.lineHeight) * fs;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, key = font + '|' + lh;
    if (bands.has(key)) return bands.get(key);
    mctx ||= document.createElement('canvas').getContext('2d');
    mctx.font = font;
    const m = mctx.measureText('0123456789'), content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent, H = isNaN(lh) ? content : lh;
    const base = (H - content) / 2 + m.fontBoundingBoxAscent; // the baseline, measured from the top of the line box
    const top = base - m.actualBoundingBoxAscent, bottom = base + m.actualBoundingBoxDescent;
    const b = { H, base, top, bottom, fade: +((bottom - top) * .12).toFixed(1), ext: .25 * fs };
    bands.set(key, b); return b;
  }
  // The static window for one rolling digit, in the coordinates of its .dg__m box (which reaches .25em above and
  // below). Hard edges 12% of the band beyond cap height and baseline; inside them a steep fade (it is under 50% for
  // the outer three quarters), so a digit passing the edge dissolves close to the line instead of hanging beyond it.
  // The fade cannot sit inside the band: a digit at rest fills the band, so the top bar of a 7 or the base of a 2 would
  // be dimmed until the roll handed back to plain text, and then jump to full strength.
  function bandStyle(b) {
    const Hm = b.H + 2 * b.ext, t = Math.max(0, b.ext + b.top - b.fade), bt = Math.min(Hm, b.ext + b.bottom + b.fade), f = b.fade, px = v => v.toFixed(1) + 'px';
    const g = `linear-gradient(to bottom, transparent ${px(t)}, rgb(0 0 0 / .12) ${px(t + .45 * f)}, rgb(0 0 0 / .5) ${px(t + .75 * f)}, #000 ${px(t + f)}, #000 ${px(bt - f)}, rgb(0 0 0 / .5) ${px(bt - .75 * f)}, rgb(0 0 0 / .12) ${px(bt - .45 * f)}, transparent ${px(bt)})`;
    return `clip-path:inset(${px(t)} 0 ${px(Hm - bt)} 0);-webkit-mask-image:${g};mask-image:${g}`;
  }
  function setNum(el, value, animate) {
    if (!el) return;
    const v = String(value);
    if (el.dataset.v === v) return;
    const old = el.dataset.v ?? el.textContent;
    el.dataset.v = v;
    if (el._rolls) { el._rolls.forEach(a => a.cancel()); el._rolls = null; }
    if (!animate || reduced() || old === '' || !visible(el) || !/^\d+$/.test(v + old)) { el.textContent = v; return; }
    const up = Number(v) >= Number(old), w = Math.max(v.length, old.length), nv = v.padStart(w, ' '), ov = old.padStart(w, ' ');
    const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = v;
    const vis = document.createElement('span'); vis.setAttribute('aria-hidden', 'true');
    const win = bandStyle(numeralBand(el)), cols = [], cell = c => `<span>${c === ' ' ? ' ' : c}</span>`;
    for (let i = 0; i < w; i++) {
      const a = ov[i], b = nv[i];
      if (b === ' ') continue; // the number got shorter: that digit simply leaves
      if (a === b) { vis.append(b); continue; }
      const d = document.createElement('span'); d.className = 'dg';
      // the placeholder holds both digits in one grid cell, so the box is as wide as the wider of the two
      d.innerHTML = `<span class="dg__ph"><span>${a === ' ' ? '' : a}</span><span>${b}</span></span><span class="dg__m" style="${win}"><span class="dg__col">${up ? cell(a) + cell(b) : cell(b) + cell(a)}</span></span>`;
      vis.append(d); cols.push(d.querySelector('.dg__col'));
    }
    el.replaceChildren(sr, vis);
    const [from, to] = up ? ['translateY(0)', 'translateY(-50%)'] : ['translateY(-50%)', 'translateY(0)'];
    const rolls = cols.map((c, i) => A(c, [{ transform: from }, { transform: to }], { duration: ROLL, delay: (cols.length - 1 - i) * 24, easing: EASE.roll, fill: 'both' })).filter(Boolean);
    el._rolls = rolls;
    // when the roll ends, the count is plain text again, in exactly the same place
    Promise.all(rolls.map(a => a.finished)).then(() => { if (el._rolls === rolls) { el._rolls = null; el.textContent = v; } }, () => {});
  }

  /* ------------------------------------------------------------------ light bar (reading, sending) */
  // No tick ruler: one mark per document grew with the run and meant nothing at scale. The bar is the same few elements
  // for 10 documents or a million: rail, fill, head, flare.
  function makeBar(el) {
    const total = Number(el.getAttribute('aria-valuemax'));
    const fill = $('.lightbar__fill', el), hw = $('.lightbar__headwrap', el), flare = $('.lightbar__flare', el), rail = $('.lightbar__rail', el);
    // the tip that draws the rail when the bar is first built (a construction light, never a value)
    const draw = document.createElement('div'); draw.className = 'lightbar__draw'; draw.setAttribute('aria-hidden', 'true'); draw.innerHTML = '<i></i>';
    el.appendChild(draw);
    let p = 0;
    const tf = q => ({ fill: `scaleX(${q})`, hw: `translateX(${q * 100}%)` });
    const apply = q => { const t = tf(q); fill.style.transform = t.fill; hw.style.transform = t.hw; };
    const flash = delay => A(flare, [{ opacity: 0 }, { opacity: .9, offset: .3 }, { opacity: 0 }], { duration: 900, delay, easing: 'ease-out', fill: 'none' });
    return {
      el, shown: false,
      set(n, { animate = false, delay = 0, text = '' } = {}) {
        const q = Math.max(0, Math.min(1, n / total)), from = p; p = q; apply(q);
        el.setAttribute('aria-valuenow', n); if (text) el.setAttribute('aria-valuetext', text);
        if (!animate || q === from) return;
        const o = { duration: 760, delay, easing: EASE.soft }; const a = tf(from), b = tf(q);
        A(fill, [{ transform: a.fill }, { transform: b.fill }], o); A(hw, [{ transform: a.hw }, { transform: b.hw }], o);
        flash(delay);
      },
      // The rail draws itself the first time this bar is shown in a session (a construction light, never a value).
      // A bar that has already been built is simply there.
      powerUp(delay = 0) {
        if (this.shown) return; this.shown = true;
        A(rail, [{ transform: 'scaleX(0)', opacity: 0 }, { transform: 'scaleX(1)', opacity: 1 }], { duration: 620, delay, easing: EASE.inout });
        A(draw, [{ transform: 'translateX(0%)' }, { transform: 'translateX(100%)' }], { duration: 620, delay, easing: EASE.inout, fill: 'none' });
        A(draw.firstChild, [{ opacity: 0 }, { opacity: 1, offset: .1 }, { opacity: 1, offset: .8 }, { opacity: 0 }], { duration: 660, delay, fill: 'none' });
        A($('.lightbar__head', el), [{ opacity: 0, transform: 'scaleY(.2)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: delay + 420 });
      },
      relight(delay = 0) {
        A($('.lightbar__head', el), [{ opacity: .2, transform: 'scaleY(.4)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay });
        flash(delay);
      },
    };
  }
  const bars = { read: makeBar($('[data-bar="read"]')), send: makeBar($('[data-bar="send"]')) };

  /* ------------------------------------------------------------------ live indicator: the pulse
     The light pulses only while a status check has recently succeeded and seen work moving. Each such check
     renews a lease (three of the app's 5-second checks). If no check arrives before the lease ends, the pulse
     stops by itself and the words say so. The one timeout here withdraws a claim; it never makes one.
     All pulses share one start time, so the run header, the pane and the journey node beat together. */
  const QS = new URLSearchParams(location.search);
  const PERIOD = 1600;
  const LEASE = Number(QS.get('lease')) || 15000;
  // One beat: the ring leaves the light and fades (0-72% of the beat) while the glow swells and eases back.
  const ringFrames = end => [
    { transform: 'scale(1)', opacity: 0, easing: 'cubic-bezier(.2,.6,.3,1)' },
    { transform: 'scale(1)', opacity: 1, offset: .04, easing: 'cubic-bezier(.2,.6,.3,1)' },
    { transform: `scale(${end})`, opacity: 0, offset: .72 },
    { transform: `scale(${end})`, opacity: 0 }];
  const RING = ringFrames(3), NODE_RING = ringFrames(1.9);
  const HALO = [
    { opacity: .45, easing: 'cubic-bezier(.3,0,.2,1)' },
    { opacity: 1, offset: .14, easing: 'cubic-bezier(.4,0,.2,1)' },
    { opacity: .45, offset: .75 },
    { opacity: .45 }];
  // the compact journey segment on phones: its glow swells on the same beat
  const SEG = [
    { opacity: 0, easing: 'cubic-bezier(.3,0,.2,1)' },
    { opacity: 1, offset: .14, easing: 'cubic-bezier(.4,0,.2,1)' },
    { opacity: 0, offset: .75 },
    { opacity: 0 }];
  const Pulse = (() => {
    let leaseEnd = 0, expireT = 0, beat0 = null;
    const running = new Map(), settling = new Map();
    const fresh = () => performance.now() < leaseEnd;
    // .ind--still (the Home run card) is never a target: Home records a state, it does not pulse
    const targets = () => $$('.ind.is-live:not(.ind--still) .ind__ring, .ind.is-live:not(.ind--still) .ind__halo, .step.is-live .node__pulse, .segs i.is-live > b').filter(visible);
    const framesFor = e => e.classList.contains('node__pulse') ? NODE_RING : e.classList.contains('ind__halo') ? HALO : e.tagName === 'B' ? SEG : RING;
    const iters = () => Math.max(1, Math.ceil((leaseEnd - beat0) / PERIOD));
    function sync() {
      const want = (reduced() || !fresh()) ? [] : targets();
      // A light that has gone to "waiting" lets its ring finish the beat it is in (the slow settle). Anything
      // else that stops being live (paused, failed, done, stale, left the screen) stops at once.
      const toWaiting = e => !reduced() && (e.closest('.ind') ? e.closest('.ind').classList.contains('is-waiting') : visible(e) && $$('.ind.is-waiting').some(visible));
      for (const [e, a] of running) if (!want.includes(e)) { if (toWaiting(e) && !e.classList.contains('ind__halo') && e.tagName !== 'B') { settle(a); settling.set(e, a); } else a.cancel(); running.delete(e); }
      if (!want.length) return;
      if (beat0 == null) beat0 = document.timeline.currentTime;
      for (const e of want) {
        const a = running.get(e);
        if (a) { a.effect.updateTiming({ iterations: iters() }); continue; }
        if (settling.has(e)) { settling.get(e).cancel(); settling.delete(e); }
        const n = e.animate(framesFor(e), { duration: PERIOD, iterations: iters(), fill: 'none' });
        n.id = 'pulse'; n.startTime = beat0; running.set(e, n);
        n.finished.then(() => { if (running.get(e) === n) running.delete(e); }, () => {});
      }
    }
    // leaving "live": the ring finishes the beat it is in instead of vanishing mid-air
    function settle(a) { try { const it = Math.floor((a.currentTime || 0) / PERIOD) + 1; a.effect.updateTiming({ iterations: it }); } catch (e) { a.cancel(); } }
    // a status check succeeded and saw work moving
    function confirm() {
      if (!fresh()) beat0 = null;
      leaseEnd = performance.now() + LEASE;
      clearTimeout(expireT); expireT = setTimeout(expire, LEASE + 40);
    }
    function expire() { if (fresh()) return; beat0 = null; onLeaseEnd(); }
    function stop() { leaseEnd = 0; clearTimeout(expireT); beat0 = null; for (const a of [...running.values(), ...settling.values()]) a.cancel(); running.clear(); settling.clear(); }
    // the time left in the beat that is playing now (so the waiting ring can settle as the last ring leaves)
    function beatLeft() { if (beat0 == null) return 0; const t = (document.timeline.currentTime - beat0) % PERIOD; return Math.max(0, PERIOD * .72 - t); }
    // one red beat: a failure was just recorded (the only red motion; it never repeats)
    function beat(sel = '.ind.is-failed .ind__beat') {
      if (reduced()) return;
      $$(sel).filter(visible).concat($$('.step.is-current .node__beat, .step.is-failed .node__beat', spineList).filter(visible)).forEach(e =>
        A(e, [{ transform: 'scale(1)', opacity: .95 }, { transform: e.classList.contains('node__beat') ? 'scale(1.9)' : 'scale(3.2)', opacity: 0 }], { duration: 900, easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'none' }));
    }
    return { sync, confirm, stop, beat, fresh, beatLeft };
  })();
  // Paint one light and its words. st: live | waiting | stale | paused | failed | done | off.
  // `key` is the meaning of the row (by default its state). Words resolve in only when the meaning changed on an event:
  // a new time or count inside the same state is written in place, still.
  const ST = ['live', 'waiting', 'stale', 'paused', 'failed', 'done', 'off'];
  const liveOr = () => Pulse.fresh() ? 'live' : 'stale';
  function paintStatus(row, st, state, why, animate, key = st) {
    if (!row) return;
    const ind = $('.ind', row), prev = row.dataset.st, prevKey = row.dataset.key;
    row.dataset.st = st; row.dataset.key = key;
    ST.forEach(k => { ind.classList.toggle('is-' + k, k === st); row.classList.toggle('is-' + k, k === st); });
    const meaning = animate && prevKey !== undefined && prevKey !== key && visible(row);
    const sw = $('[data-status-state], [data-run-state-t]', row), rw = $('[data-status-why]', row);
    const kind = st === 'failed' ? 'fail' : 'change';
    const swNew = sw.textContent !== state, rwNew = !!rw && why != null && rw.textContent !== why;
    setText(sw, state); if (rw && why != null) setText(rw, why);
    if (meaning && swNew) reveal(sw, 0, kind);
    if (meaning && rwNew && why) reveal(rw, st === 'failed' ? 30 : 50, kind);
    // entering "waiting" is slow: the last ring leaves, the glow goes down, the dot draws in to 8 px and a still,
    // full-strength ring settles round it (transform and opacity only)
    if (meaning && prev === 'live' && st === 'waiting') {
      const settle = Math.min(900, Pulse.beatLeft());
      A($('.ind__halo', ind), [{ opacity: .55 }, { opacity: 0 }], { duration: 900, easing: EASE.inout });
      A($('.ind__dot', ind), [{ transform: 'scale(1)' }, { transform: 'scale(.6667)' }], { duration: 700, delay: settle, easing: EASE.out });
      A($('.ind__hold', ind), [{ opacity: 0, transform: 'scale(.6)' }, { opacity: getComputedStyle(root).getPropertyValue('--hold-a').trim() || 1, transform: 'scale(1)' }], { duration: 700, delay: settle, easing: EASE.out });
    }
  }
  // A sending or sorting run's state and word, as its run header shows them. The Home run card uses the same.
  function runLight(L) {
    const ph = L.phase, working = ph === 'sending' || ph === 'sorting';
    if (ph === 'stalled') return ['failed', 'Sending stopped'];
    if (ph === 'done') return ['done', 'Sorted'];
    if (ph === 'sorting' && L.health === 'checkfail') return ['failed', 'Can’t reach the service'];
    if (working && L.paused) return ['paused', 'Updates paused'];
    if (working && L.health === 'waiting') return ['waiting', 'Waiting'];
    if (Pulse.fresh()) return ['live', ph === 'sending' ? 'Sending' : 'Working'];
    return ['stale', `Not updated since ${hm(L.checkedAt ?? (ph === 'sending' ? L.lastRx : L.clock))}`];
  }
  // The run header light (spine run block; on phones, the compact run row). Same words as the pane.
  function paintRun(st, text, animate, key = st) {
    const row = $('[data-run-state]');
    row.hidden = st === 'off';
    if (st !== 'off') paintStatus(row, st, text, null, animate, key);
  }

  /* ------------------------------------------------------------------ simulated status checks (prototype only)
     In the app the page asks the service for the run's status every 5 s; each answer that shows the work moving renews
     the light's lease. The prototype stands those answers in with a labelled simulator in the control bar, on by default
     for the working screens, so the light shows the steady state it will have. Stop it to watch the honest lapse:
     15 s after the last answer the pulse ends and the words say "Not updated since …". A check changes nothing else:
     no text moves, because nothing's meaning changed. */
  const EVERY = Number(QS.get('every')) || 5000;
  // The quiet period: how long successful answers may show no new outcome before the light stops pulsing and says
  // Waiting. An interface setting for the owner to choose (prototype control: 90 s or 3 min), not a fitted constant.
  let QUIET = Number(QS.get('quiet')) || 180000;
  // How long ago something last changed, in words a person can use without a clock: "just now", then "N min ago".
  const agoWords = ms => ms < 60000 ? 'just now' : `${Math.floor(ms / 60000)} min ago`;
  // S.lastChange is the moment the last new count arrived (a file read, a document received, an outcome). Only readMore
  // and liveMore move it forward; a preset or a new run's start sets it as the scene's origin. A recovery never does.
  const sinceChange = () => performance.now() - S.lastChange;
  const quietMin = () => Math.max(1, Math.floor(sinceChange() / 60000));
  // The evidence under a working light: "last result just now" for the first minute after the last new count, then
  // "last result N min ago · updated just now" (the page is in touch, but nothing new has arrived).
  const evidence = noun => { const ms = sinceChange(); return ms < 60000 ? `last ${noun} just now` : `last ${noun} ${agoWords(ms)} · updated just now`; };
  // A recovery (Try again, Continue sending, Choose the folder again, an answer after a lapse) says only that the page
  // is back in touch: it calls Pulse.confirm() and nothing else. It is not a result, so it never moves S.lastChange. If
  // the last new count is already older than the quiet period, the light goes straight to Waiting (a waiting light is
  // never a pulse target, so the renewed lease makes nothing pulse).
  function resumeLight(H) {
    Pulse.confirm();
    if (sinceChange() >= QUIET) { Object.assign(H, { health: 'waiting', waitWhy: 'quiet', waitMin: quietMin(), waitSince: performance.now() }); return false; }
    H.health = 'ok'; H.waitWhy = null; return true;
  }
  const Checks = (() => {
    let on = QS.get('checks') !== 'off', t = 0;
    const arm = () => { clearInterval(t); t = on ? setInterval(tick, EVERY) : 0; };
    // on Home the same answer keeps the run card's state honest (the app's runs list asks for it too)
    function tick() { if (S.screen === 'read') readCheck(); else if (S.screen === 'live' || (S.screen === 'home' && S.run.name === 'Run 9')) liveCheck(); }
    return { get on() { return on; }, set(v) { on = !!v; arm(); syncProto(); }, arm, tick };
  })();

  /* ------------------------------------------------------------------ journey spine */
  const STEPS = [
    ['Choose folder', 'Your files', 'read'], ['Read files', 'Your files', 'read'], ['Confirm', 'Start', 'confirm'], ['Send', 'Start', 'live'], ['Sort', 'Sorting', 'live'],
    ['Results', 'Sorting', 'results'], ['Make folders', 'Your folders', 'results'], ['Review folders', 'Your folders', 'review'], ['Update categories', 'Improve', null], ['Compare', 'Improve', null],
  ].map(([label, ch, to], i) => ({ n: i + 1, label, ch, to }));
  const WHY_LATER = {
    2: 'Available once the folder is chosen.', 3: 'Available when every file has been read.', 4: 'Available after you start the run.', 5: 'Starts when all documents are sent.',
    6: 'Available when every document has an outcome.', 7: 'Available on the Results step.', 8: 'Available after the folders are made.', 9: 'Available after you save your review.', 10: 'Available after the categories are updated or kept.',
  };
  const spineList = $('[data-spine-list]'), rail = $('.spine__rail'), railFill = $('.spine__fill'), railHead = $('.spine__head'), segs = $('[data-segs]');
  (function buildSpine() {
    let html = '';
    for (let c = 0; c < 5; c++) {
      const a = STEPS[c * 2], b = STEPS[c * 2 + 1];
      html += `<li class="chapter"><span class="chapter__name" aria-hidden="true">${a.ch}</span><ol>` +
        [a, b].map(s => `<li class="step" data-step="${s.n}"><span class="step__in"><span class="node" aria-hidden="true"></span><span class="step__label">${s.label}<span class="sr-only" data-sr></span></span></span></li>`).join('') + '</ol></li>';
    }
    spineList.innerHTML = html;
    segs.innerHTML = STEPS.map(() => '<i><b></b></i>').join('');
  })();
  // failWord: what screen readers hear for a failed step, in the same words as the light
  function journey() {
    const L = S.live;
    switch (S.screen) {
      case 'read': return S.read.phase === 'choose' ? { cur: 1 } : S.read.phase === 'done' ? { cur: 3 } : { cur: 2, fail: S.read.health === 'lost', failWord: 'reading stopped; it needs you', live: S.read.health === 'ok' && Pulse.fresh() };
      case 'confirm': return { cur: 3 };
      case 'live': {
        const live = !L.paused && L.health === 'ok' && Pulse.fresh();
        return L.phase === 'stalled' ? { cur: 4, fail: true, failWord: 'sending stopped; it needs you' } : L.phase === 'sending' ? { cur: 4, live } : L.phase === 'done' ? { cur: 6 }
          : { cur: 5, fail: L.health === 'checkfail', failWord: 'can’t reach the service', live };
      }
      case 'results': return { cur: 6 };
      case 'review': return { cur: S.review.saved ? 9 : 8 };
      default: return null;
    }
  }
  function spineCenters() {
    const base = $('.spine').getBoundingClientRect();
    return $$('.node', spineList).map(n => { const r = n.getBoundingClientRect(); return r.top - base.top + r.height / 2; });
  }
  function setSpine({ animate = false, delay = 0 } = {}) {
    const j = journey();
    if (!j) { S.spineCur = null; Pulse.sync(); return; }
    const from = S.spineCur; S.spineCur = j.cur;
    $$('.step', spineList).forEach(li => {
      const n = Number(li.dataset.step), st = STEPS[n - 1];
      const status = n < j.cur ? 'done' : n === j.cur ? (j.fail ? 'failed' : 'current') : 'upcoming';
      li.className = 'step is-' + status + (status === 'current' && j.live ? ' is-live' : '');
      const sig = status + (status === 'failed' ? j.failWord : '');
      if (li.dataset.status === sig) return;
      li.dataset.status = sig;
      const inner = li.firstElementChild, link = status !== 'upcoming' && st.to;
      const el = document.createElement(link ? 'a' : 'span');
      el.className = 'step__in';
      if (link) { el.href = '#' + st.to; el.dataset.go = st.to; if (status === 'current' || status === 'failed') el.setAttribute('aria-current', 'step'); }
      else { el.setAttribute('aria-disabled', 'true'); el.title = WHY_LATER[n] || ''; }
      el.innerHTML = inner.innerHTML;
      el.querySelector('.node').innerHTML = (status === 'done' ? glyph('check') : status === 'upcoming' ? String(n) : '') + '<span class="node__pulse"></span><span class="node__beat"></span>';
      el.querySelector('[data-sr]').textContent = status === 'done' ? ' (done)' : status === 'failed' ? ` (${j.failWord})` : status === 'upcoming' ? ` (${WHY_LATER[n] || 'later'})` : ' (current step)';
      inner.replaceWith(el);
    });
    [...segs.children].forEach((s, i) => { s.className = (i + 1 < j.cur ? 'd' : i + 1 === j.cur ? (j.fail ? 'f' : 'c') : '') + (i + 1 === j.cur && j.live ? ' is-live' : ''); });
    // the compact line names the step only; the light beside the run name says its state, in the pane's words
    const st = STEPS[j.cur - 1];
    const cl = $('[data-spine-compact]'), ch = `<b>Step ${j.cur} of 10</b> · ${st.label}`;
    if (cl.innerHTML !== ch) cl.innerHTML = ch;
    Pulse.sync();
    // rail geometry (desktop only; the compact bar has no rail)
    const cs = spineCenters();
    if (!cs.length || cs[9] - cs[0] <= 0) return;
    const h = cs[9] - cs[0];
    rail.style.top = cs[0] + 'px'; rail.style.height = h + 'px';
    const p = (cs[j.cur - 1] - cs[0]) / h;
    railFill.style.transform = `scaleY(${p})`;
    if (animate && from != null && from !== j.cur && !reduced()) {
      const p0 = (cs[from - 1] - cs[0]) / h, dist = Math.abs(cs[j.cur - 1] - cs[from - 1]);
      const dur = Math.min(1100, 520 + dist * 2.2);
      A(railFill, [{ transform: `scaleY(${p0})` }, { transform: `scaleY(${p})` }], { duration: dur, delay, easing: EASE.inout });
      const y0 = cs[from - 1] - cs[0] - 40, y1 = cs[j.cur - 1] - cs[0] - 40;
      A(railHead, [{ transform: `translateY(${y0}px)`, opacity: 0 }, { opacity: 1, offset: .12 }, { transform: `translateY(${y1}px)`, opacity: 1, offset: .9 }, { transform: `translateY(${y1}px)`, opacity: 0 }], { duration: dur + 140, delay, easing: EASE.inout, fill: 'none' });
      const node = $(`.step[data-step="${j.cur}"] .node`, spineList);
      A(node, [{ transform: 'scale(.55)', opacity: .4 }, { transform: 'none', opacity: 1 }], { duration: 520, delay: delay + dur - 160, easing: EASE.out });
      const seg = segs.children[j.cur - 1];
      A(seg, [{ opacity: .2, transform: 'scaleX(.3)' }, { opacity: 1, transform: 'none' }], { duration: 600, delay: delay + 120, easing: EASE.out });
    }
  }

  /* ------------------------------------------------------------------ tabs */
  const tabsBar = $('.tabs__bar');
  function updateTabs(animate) {
    const key = S.screen === 'home' ? 'home' : 'runs';
    $$('.tab').forEach(t => t.toggleAttribute('aria-current', false));
    const tab = $(`.tab[data-tab="${key}"]`); tab.setAttribute('aria-current', 'page');
    const nav = $('.tabs').getBoundingClientRect(), r = tab.getBoundingClientRect();
    const x = r.left - nav.left + 14, w = Math.max(12, r.width - 28);
    const old = tabsBar.getBoundingClientRect();
    tabsBar.style.width = w + 'px'; tabsBar.style.transform = `translateX(${x}px)`;
    if (animate && old.width) {
      const ox = old.left - nav.left;
      A(tabsBar, [{ transform: `translateX(${ox}px) scaleX(${old.width / w})` }, { transform: `translateX(${x}px)` }], { duration: 520, easing: EASE.inout });
    }
  }

  /* ------------------------------------------------------------------ HOME: the journey loop */
  const arena = $('[data-arena]'), loop = $('#loop');
  const LOOP_START = 40;
  let arenaBuilt = false;
  // where Run 9 stands on the loop (0-based step), what its label says, and whether it has failed (paintHome sets it)
  let arenaRun = { k: 4, title: 'Run 9 · Sort', line: '73 of 114 have an outcome', failed: false };
  function buildArena() {
    const L = loop.getTotalLength(), step = L / 10, g = $('[data-arena-stations]'), k9 = arenaRun.k;
    const pt = s => loop.getPointAtLength(((s % L) + L) % L);
    const out = (p, d) => { const cx = Math.max(170, Math.min(470, p.x)), dx = p.x - cx, dy = p.y - 190, m = Math.hypot(dx, dy) || 1; return { x: p.x + dx / m * d, y: p.y + dy / m * d }; };
    let h = '';
    for (let i = 0; i < 10; i++) { const p = pt(LOOP_START + i * step); h += `<circle class="arena__station${i < k9 ? ' is-done' : ''}${i % 2 === 0 ? ' is-chapter' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === k9 ? 7 : 5}"/>`; }
    const chapters = ['Your files', 'Start', 'Sorting', 'Your folders', 'Improve'];
    chapters.forEach((c, k) => { const p = out(pt(LOOP_START + (2 * k + .5) * step), 52); h += `<circle class="anchor" data-tag="${c}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r=".6" fill="none"/>`; });
    const r9 = pt(LOOP_START + k9 * step), r8 = pt(LOOP_START + 7 * step);
    h += `<circle class="arena__run arena__run--quiet" cx="${r8.x.toFixed(1)}" cy="${r8.y.toFixed(1)}" r="7" data-run-anchor="8"/>`;
    h += `<circle class="arena__run${arenaRun.failed ? ' is-failed' : ''}" cx="${r9.x.toFixed(1)}" cy="${r9.y.toFixed(1)}" r="8" data-run-anchor="9"/>`;
    g.innerHTML = h;
    const a = LOOP_START / L * 1000, b = (LOOP_START + k9 * step) / L * 1000;
    $$('[data-arena-trail]').forEach(t => { t.style.strokeDasharray = `0 ${a.toFixed(1)} ${(b - a).toFixed(1)} ${(1000 - b).toFixed(1)}`; t.dataset.a = a; t.dataset.b = b; });
    arenaBuilt = true;
  }
  function layoutArena() {
    if (!arenaBuilt || scr.home.hidden) return;
    const base = arena.getBoundingClientRect(); if (!base.width) return;
    const labels = $('[data-arena-labels]');
    const pos = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2 - base.left, r.top + r.height / 2 - base.top]; };
    let h = '';
    $$('.anchor', arena).forEach(c => { const [x, y] = pos(c); h += `<span class="tag" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">${c.dataset.tag}</span>`; });
    const [x9, y9] = pos($('[data-run-anchor="9"]', arena)), [x8, y8] = pos($('[data-run-anchor="8"]', arena));
    h += `<span class="callout ${arenaRun.failed ? 'callout--failed' : 'callout--live'}" data-x="${x9.toFixed(1)}" style="left:${x9.toFixed(1)}px;top:${y9.toFixed(1)}px"><b>${arenaRun.title}</b>${arenaRun.line}</span>`;
    h += `<span class="callout" data-x="${x8.toFixed(1)}" style="left:${x8.toFixed(1)}px;top:${y8.toFixed(1)}px"><b>Run 8 · Review folders</b>Waiting for you</span>`;
    labels.innerHTML = h;
    // keep every label inside the arena; the stem still points at its marker
    $$('.tag, .callout', labels).forEach(el => {
      const w = el.offsetWidth, x = parseFloat(el.style.left), cx = Math.max(w / 2 + 6, Math.min(base.width - w / 2 - 6, x));
      el.style.left = cx + 'px'; el.style.setProperty('--stem', (x - cx) + 'px');
    });
    // a chapter name never hides under a run label
    const cr = $$('.callout', labels).map(c => c.getBoundingClientRect());
    $$('.tag', labels).forEach(t => { const r = t.getBoundingClientRect(); t.style.visibility = cr.some(c => !(r.right < c.left - 6 || r.left > c.right + 6 || r.bottom < c.top - 6 || r.top > c.bottom + 36)) ? 'hidden' : ''; });
  }
  // Home opens: the loop's stations resolve in order, the lit trail fades up, then the two runs and their labels.
  // Opacity and transform only (the trail is not drawn stroke by stroke).
  function arenaEnter(delay) {
    if (reduced()) return;
    $$('.arena__station', arena).forEach((c, i) => A(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 360, delay: delay + 80 + i * 40 }));
    $$('[data-arena-trail]').forEach(t => A(t, [{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: delay + 280, easing: EASE.text }));
    $$('.arena__run', arena).forEach((c, i) => A(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: delay + 700 + i * 100 }));
    $$('.callout', arena).forEach((c, i) => A(c, [{ opacity: 0, transform: 'translate(-50%, calc(-100% - 20px))' }, { opacity: 1, transform: 'translate(-50%, calc(-100% - 30px))' }], { duration: 480, delay: delay + 800 + i * 120, easing: EASE.text }));
    $$('.tag', arena).forEach((c, i) => A(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: delay + 200 + i * 60 }));
  }
  // Home's Run 9 card: the run's state in the words and marks of its own light (runLight), written in place and never
  // animated: a still dot, no pulse, red on failure, and no action (Try again or Continue sending live on the run).
  // Its sentence, step and place on the loop follow the run too, so Home never contradicts the run.
  const RUN9 = { phase: 'sorting', sent: TOTAL, decided: 73, health: 'ok', paused: false };
  let arenaKey = '4|false';
  function paintHome() {
    const mine = S.run.name === 'Run 9', L = mine ? S.live : RUN9;
    const [st, word] = mine ? runLight(L) : ['live', 'Working'];
    const row = $('[data-card-state]'), ind = $('.ind', row);
    ST.forEach(k => { row.classList.toggle('is-' + k, k === st); ind.classList.toggle('is-' + k, k === st); });
    setText($('[data-card-state-t]'), word);
    const sending = L.phase === 'sending' || L.phase === 'stalled', cur = sending ? 4 : L.phase === 'done' ? 6 : 5, failed = st === 'failed';
    const line = sending ? `${L.sent} of ${TOTAL} sent` : L.phase === 'done' ? 'Every document has an outcome' : `${L.decided} of ${TOTAL} have an outcome`;
    setText($('[data-card-now]'), sending ? `Sending: ${line}.` : L.phase === 'done' ? `Sorted. ${line}. Next: check the results.` : `Sorting: ${line}.`);
    setText($('[data-card-step]'), `Step ${cur} of 10 · ${STEPS[cur - 1].label}`);
    [...$('[data-card-mini]').children].forEach((i, n) => { i.className = n < cur - 1 ? 'd' : n === cur - 1 ? (failed ? 'f' : 'c') : ''; });
    arenaRun = { k: cur - 1, title: `Run 9 · ${STEPS[cur - 1].label}`, line, failed };
    if (arenaKey !== `${cur - 1}|${failed}`) { arenaKey = `${cur - 1}|${failed}`; buildArena(); }
    arena.setAttribute('aria-label', `The ten steps of a run, drawn as a loop. Run 9 is at step ${cur}, ${STEPS[cur - 1].label}${failed ? `: ${word}` : ''}. Run 8 is at step 8, Review folders.`);
    layoutArena();
  }

  /* ------------------------------------------------------------------ READ */
  function renderRead(anim = false) {
    const el = scr.read, R0 = S.read, n = R0.n;
    const failed = DOCS.slice(0, n).filter(d => d.outcome === 'failed').length;
    const lost = R0.phase === 'reading' && R0.health === 'lost', waiting = R0.phase === 'reading' && R0.health === 'waiting';
    const stale = R0.phase === 'reading' && R0.health === 'ok' && liveOr() === 'stale';
    el.dataset.phase = R0.phase;
    $('[data-read-choose]', el).hidden = R0.phase !== 'choose';
    $('[data-read-work]', el).hidden = R0.phase === 'choose';
    setLive($('[data-step-label]', el), R0.phase === 'choose' ? 'Step 1 of 10 · Choose folder' : R0.phase === 'done' ? 'Steps 1 and 2 done · Read files' : 'Step 2 of 10 · Read files', anim);
    // Now: what is happening and what it means for you. No count in it: the count below carries the number.
    // Not updated lately: the sentence says what that means, and claims nothing about work going on.
    const nowK = R0.phase === 'choose' ? 'choose' : R0.phase === 'done' ? 'done' : lost ? 'lost' : waiting ? 'waiting' : stale ? 'stale' : 'reading';
    setLive($('[data-read-now]', el), {
      choose: 'Choose the folder that holds the documents.',
      done: `Read ${TOTAL} files: ${TOTAL - failed} ready, ${failed} could not be read.`,
      lost: 'Reading can’t go on until this browser can see the folder again.',
      waiting: 'One large file is taking longer. Nothing is sent yet.',
      stale: 'The numbers below may be out of date.',
      reading: 'Reading the files here, on this computer. Nothing is sent until you start the run.',
    }[nowK], anim, nowK);
    wantNext(el, R0.phase !== 'reading' || lost, R0.phase === 'choose' ? 'Choose folder' : lost ? 'Choose the folder again' : 'Review and start',
      R0.phase === 'choose' ? '[data-choose-folder]' : lost ? '[data-fail-act]' : '[data-review-start]');
    setNum($('[data-read-n]', el), n, anim);
    setNum($('[data-read-failed]', el), failed, anim);
    // could not be read: red from the first one, neutral at 0 (the same rule as "Could not process" on the sorting screen)
    $('[data-read-lost]', el).classList.toggle('is-zero', failed === 0);
    bars.read.set(n, { animate: anim && !lost, text: `${n} of ${TOTAL} files read${lost ? '; reading stopped' : ''}` });
    bars.read.el.classList.toggle('is-done', R0.phase === 'done');
    bars.read.el.classList.toggle('is-stalled', lost);
    bars.read.el.classList.toggle('is-muted', stale);
    $('[data-read-pane]', el).classList.toggle('is-failed', lost);
    // the light, in the pane and in the run header, in the same words
    const row = $('[data-status]', el);
    if (R0.phase === 'done') { paintStatus(row, 'done', 'All read', `at ${hm(R0.clock)}`, anim); paintRun('done', 'All read', anim); }
    else if (lost) { paintStatus(row, 'failed', 'Reading stopped', `at ${hm(R0.failAt ?? R0.clock)}`, anim); paintRun('failed', 'Reading stopped', anim); }
    else if (waiting) {
      const why = R0.waitWhy === 'quiet' ? `no new file for ${quietMin()} min` : `‘${DOCS[n].name}’ is large · no new file for 40 s`;
      paintStatus(row, 'waiting', 'Waiting', why, anim, 'waiting|' + R0.waitWhy); paintRun('waiting', 'Waiting', anim);
    } else if (R0.phase === 'reading') {
      // the same evidence words as sorting: "last file just now", then "last file N min ago · updated just now"
      const lv = liveOr(), w = lv === 'live' ? 'Reading' : `Not updated since ${hm(R0.clock)}`;
      paintStatus(row, lv, w, lv === 'live' ? evidence('file') : 'reading may still be going on', anim); paintRun(lv, w, anim);
    } else paintRun('off');
    // the failure beneath the light: the cause and what is kept, then the one action
    const fb = $('[data-fail]', el); fb.hidden = !lost;
    if (lost) {
      setText($('[data-fail-t]', fb), `This browser lost permission to view ‘Archive 2026’. The ${n} files already read are kept.`);
      setText($('[data-fail-act]', fb), 'Choose the folder again');
      setText($('[data-fail-slot]', fb), `Reading picks up at file ${n + 1}. Nothing has been sent.`);
    }
    // the latest file is the first row of Just read (the foot no longer repeats it)
    $('[data-review-start]', el).hidden = R0.phase !== 'done';
    const slot = $('[data-read-slot]', el);
    slot.classList.toggle('is-done', R0.phase === 'done');
    setLiveHTML(slot, R0.phase === 'done' ? `${glyph('check')}<span>Next, you confirm exactly what will be sent.</span>` : lost ? '' : 'Nothing to do now. Keep this page open.', anim, nowK);
    // just-read list, keyed; the rows already there glide down together and the new one fades in
    const list = $('[data-read-list]', el), want = DOCS.slice(Math.max(0, n - 5), n).reverse();
    const have = new Map($$('li', list).map(li => [li.dataset.id, li]));
    const rows = want.map(d => {
      let li = have.get(d.id);
      if (!li) {
        li = document.createElement('li'); li.dataset.id = d.id;
        const ok = d.outcome !== 'failed';
        li.innerHTML = `<span class="doc"><span class="doc__name">${esc(d.name)}</span><span class="ext">${d.ext.toUpperCase()}</span></span>` +
          (ok ? `<span class="state">${glyph('check')}Read</span>` : `<span class="state state--no">${glyph('slash')}Could not read</span><span class="why" style="grid-column:1/-1">This PDF is a scanned image with no text. Nothing about its content will be sent.</span>`);
        li.dataset.fresh = '1';
      }
      return li;
    });
    listUpdate(list, rows, anim, 6);
    if (!n) list.innerHTML = '<li><span class="muted">No files read yet.</span></li>';
    syncNext(el);
    Pulse.sync();
  }
  const readFlip = () => flip(scr.read, () => renderRead(true));
  function readMore(k) {
    const R0 = S.read; if (R0.phase !== 'reading' || R0.health === 'lost') return;
    R0.n = Math.min(TOTAL, R0.n + k); R0.health = 'ok'; R0.waitWhy = null; R0.clock += k; S.lastChange = performance.now();
    const done = R0.n === TOTAL;
    if (done) { R0.phase = 'done'; Pulse.stop(); } else Pulse.confirm();
    readFlip(); setSpine({ animate: done, delay: 300 });
    announce(`${R0.n} of ${TOTAL} files read`, done);
    if (done) handoff($('[data-review-start]'), 420);
    syncProto();
  }
  function readStall() { const R0 = S.read; if (R0.phase !== 'reading' || R0.health !== 'ok') return; R0.health = 'waiting'; R0.waitWhy = 'large'; readFlip(); setSpine(); announce('Reading is waiting on a large file.', true); syncProto(); }
  // a simulated status check while reading: the reader says it is still at work
  function readCheck() {
    const R0 = S.read; if (R0.phase !== 'reading' || R0.health === 'lost') return;
    if (R0.health === 'ok') { if (performance.now() - S.lastChange >= QUIET) { R0.health = 'waiting'; R0.waitWhy = 'quiet'; } else Pulse.confirm(); }
    readFlip(); setSpine(); syncProto();
  }
  function readLost() {
    const R0 = S.read; if (R0.phase !== 'reading' || R0.health === 'lost') return;
    R0.health = 'lost'; R0.failAt = R0.clock + 2; Pulse.stop();
    readFlip(); setSpine({ animate: true });
    failMoment($('[data-read-pane]'));
    announce(`Reading stopped: this browser lost permission to view the folder. Choose the folder again to continue.`, true);
    syncProto();
  }
  // Choose the folder again: the folder can be seen again. That is not a file read, so the last change stays where it was.
  function readAgain() {
    const R0 = S.read; if (R0.phase !== 'reading' || R0.health !== 'lost') return;
    R0.clock = R0.failAt + 30; resumeLight(R0);
    readFlip(); setSpine({ animate: true });
    trace($('[data-read-pane]'), 40, { dur: 1000 });
    announce(`Reading continues from file ${R0.n + 1}.`, true);
    syncProto();
  }
  $('[data-fail-act]', scr.read).addEventListener('click', readAgain);

  /* ------------------------------------------------------------------ shared: failure moment, layout glide, Next */
  // The moment something fails: one red beat on every light, one red trace round the pane that holds it, and the
  // failure text resolves in beneath the light. Failure text is the fastest text on the page: the red rule draws down
  // from the top as the message arrives (both at 0 ms, 180-220 ms long), and the action follows 60 ms later. No blur.
  function failMoment(pane) {
    Pulse.beat();
    trace(pane, 0, { fail: true, dur: 900 });
    revealFail($('[data-fail]:not([hidden])', pane));
  }
  function revealFail(block, delay = 0) {
    if (!block || block.hidden || reduced()) return;
    A(block, [{ transform: 'scaleY(0)', opacity: .4 }, { transform: 'scaleY(1)', opacity: 1 }], { duration: 220, delay, easing: EASE.out, pseudoElement: '::before' });
    // a one-document notice resolves as one line (its glyph with it); a lasting failure as the message, then its action
    const parts = block.matches('.notice') ? [block] : [$('.fail__msg', block), $('.action', block)];
    parts.filter(Boolean).forEach((e, i) => reveal(e, delay + i * 60, 'fail'));
  }
  // Content below a block that appears or goes glides to its new place with a transform, so nothing jumps.
  // Elements marked data-flip are measured before and after the change; each moves by its own distance, less its
  // parent's, over 320 ms. A pane whose surface is its own layer (.surf) grows or shrinks with its content in the same
  // 320 ms: the layer is scaled from the old height to the new one, from the top, so its bottom edge travels with the
  // content below instead of that content sliding over it.
  const GLIDE = 320;
  function flip(scope, mutate) {
    if (reduced() || !scope || !visible(scope)) { mutate(); return; }
    const els = $$('[data-flip]', scope).filter(visible), surfs = $$('.surf', scope).filter(visible);
    const first = new Map(els.map(e => [e, e.getBoundingClientRect().top]));
    const h0 = new Map(surfs.map(e => [e, e.getBoundingClientRect().height]));
    els.forEach(e => { if (e._flip) { e._flip.cancel(); e._flip = null; } });
    surfs.forEach(e => { if (e._grow) { e._grow.cancel(); e._grow = null; } });
    mutate();
    const last = new Map();
    for (const e of first.keys()) if (visible(e)) last.set(e, e.getBoundingClientRect().top);
    for (const [e, top] of last) {
      const p = e.parentElement.closest('[data-flip]');
      const pd = p && last.has(p) ? first.get(p) - last.get(p) : 0;
      const d = first.get(e) - top - pd;
      if (Math.abs(d) >= 1) e._flip = A(e, [{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: GLIDE, easing: EASE.out });
    }
    for (const [e, h] of h0) {
      if (!visible(e)) continue;
      const h1 = e.getBoundingClientRect().height;
      if (h1 > 0 && Math.abs(h1 - h) >= 1) e._grow = A(e, [{ transform: `scaleY(${(h / h1).toFixed(4)})` }, { transform: 'none' }], { duration: GLIDE, easing: EASE.out, pseudoElement: '::after' });
    }
  }
  // A list that gains rows on top: the rows already there glide down together (one transform on the list, inside a
  // still clip) and each new row fades in; a row that drops off the bottom goes at once. One +1 is two animations.
  function listUpdate(list, rows, anim, rise = 8) {
    const motion = anim && !reduced() && visible(list);
    const keep = motion ? $$(':scope > li[data-id]', list).find(li => rows.includes(li)) : null;
    const y0 = keep ? keep.getBoundingClientRect().top : 0;
    if (list._glide) { list._glide.cancel(); list._glide = null; }
    list.replaceChildren(...rows);
    if (keep) { const d = y0 - keep.getBoundingClientRect().top; if (Math.abs(d) >= 1) list._glide = A(list, [{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 300, easing: EASE.out }); }
    rows.filter(li => li.dataset.fresh).forEach((li, i) => { if (motion) A(li, [{ opacity: 0, transform: keep ? 'none' : `translateY(-${rise}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, delay: i * 30, easing: EASE.text }); delete li.dataset.fresh; });
  }
  // Next in the Now line is a jump to the one action. It shows only when that action is out of sight when the page
  // is at the top; when the action is already on screen, Next would only say it twice.
  function wantNext(scope, want, label, target) {
    const next = $('[data-next]', scope); if (!next) return;
    next.dataset.want = want ? '1' : ''; next.dataset.target = target;
    const l = $('[data-next-label]', next); if (l) setText(l, label);
  }
  function syncNext(scope = scr[S.screen]) {
    const next = scope && $('[data-next]', scope); if (!next) return;
    const want = next.dataset.want !== '';
    next.hidden = true;
    if (!want || scope.hidden) return;
    const t = $(next.dataset.target || '[data-primary]', scope);
    const onScreen = !!t && !t.hidden && visible(t) && t.getBoundingClientRect().bottom + scrollY <= innerHeight - 16;
    next.hidden = onScreen;
  }

  /* ------------------------------------------------------------------ CONFIRM */
  const limitIn = $('[data-limit]');
  function syncConfirmInputs() {
    const c = S.confirm;
    $$('input[name="mode"]').forEach(r => { r.checked = r.value === c.mode; });
    limitIn.value = c.limit; $('[data-nolimit]').checked = c.nolimit;
  }
  const validLimit = v => /^\d{1,5}(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;
  function renderConfirm(flashKey) {
    const el = scr.confirm, c = S.confirm;
    setText($('[data-step-label]', el), 'Step 3 of 10 · Confirm');
    const ok = validLimit(c.limit);
    const err = c.limit.trim() && !ok ? 'Enter an amount in dollars, for example 5 or 2.50.' : '';
    $('[data-limit-err]', el).innerHTML = err ? `${glyph('alert')}<span>${err}</span>` : '';
    const mode = $('[data-sum-mode]', el), lim = $('[data-sum-limit]', el);
    setText(mode, c.mode ? 'Interactive' : 'Not chosen yet'); mode.classList.toggle('is-unset', !c.mode);
    setText(lim, c.nolimit ? 'No limit (you accepted this)' : ok ? `Stops at $${Number(c.limit).toFixed(2)}` : 'Not set'); lim.classList.toggle('is-unset', !(ok || c.nolimit));
    const reasons = [];
    if (!c.mode) reasons.push('Choose how to run this.');
    if (!ok && !c.nolimit) reasons.push('Set a spending limit, or choose No limit under More spending options.');
    const ul = $('[data-reasons]', el);
    const html = reasons.map(r => `<li>${r}</li>`).join('');
    if (ul.innerHTML !== html) ul.innerHTML = html;
    const btn = $('[data-start-run]', el);
    btn.disabled = reasons.length > 0;
    if (flashKey) { const row = $(`[data-sum="${flashKey}"]`, el); A(row, [{ opacity: 1 }, { opacity: 0 }], { duration: 900, pseudoElement: '::after', easing: 'ease-out', fill: 'none' }); }
  }
  $$('input[name="mode"]').forEach(r => {
    const choose = () => { if (r.disabled) return; const was = S.confirm.mode; S.confirm.mode = r.value; renderConfirm(was !== r.value ? 'mode' : null); if (was !== r.value) trace(r.closest('.radio-card'), 0); };
    r.addEventListener('click', choose); r.addEventListener('change', choose);
  });
  limitIn.addEventListener('input', () => { const was = validLimit(S.confirm.limit); S.confirm.limit = limitIn.value; renderConfirm(validLimit(S.confirm.limit) !== was || validLimit(S.confirm.limit) ? 'limit' : null); });
  $('[data-nolimit]').addEventListener('change', e => { S.confirm.nolimit = e.target.checked; renderConfirm('limit'); tickDraw(e.target); });

  /* ------------------------------------------------------------------ LIVE */
  const L$ = s => $(s, scr.live);
  function liveCounts() {
    const L = S.live, c = countsAt(L.decided);
    const sorting = L.phase === 'sorting' || L.phase === 'done';
    c.reading = L.phase === 'sorting' ? Math.min(19, TOTAL - L.decided) : 0;
    c.waiting = sorting ? TOTAL - L.decided - c.reading : L.sent;
    return c;
  }
  const spentOf = L => (L.phase === 'sending' || L.phase === 'stalled') ? 0 : L.decided * 0.00579;
  // The bar's geometry, in pixels of the bar's own width W: four segment widths, and four boundary wrappers each
  // translated by the segment before it (nested, so a boundary carries everything after it). One decided document
  // changes one width and one boundary.
  // - Every non-zero outcome is drawn at least MIN_SEG wide, so one failed document out of any number is still a red
  //   segment you can see (6 px of it shows between the cuts). The extra width comes out of the undecided rest, so no
  //   outcome segment ever shrinks while others arrive; only when there is no rest left (the end of a run) is it taken
  //   from the widest outcome.
  // - While the run is working, the leading edge stands in its own NOTCH after the last decided segment: 3 px of pane
  //   colour, the 4 px head, 3 px of pane colour. It never overlaps a segment. When the run is finished there is no
  //   head and no notch.
  // The element count is fixed (four segments, four cuts, one notch, one head): the same for 10 documents or a million.
  const MIN_SEG = 7, NOTCH = 10;
  function pipeGeom(c, W, notch) {
    const A0 = Math.max(0, W - notch), n = [c.filed, c.review, c.failed];
    const raw = n.map(k => k / TOTAL * A0), w = raw.map((r, i) => n[i] > 0 ? Math.max(MIN_SEG, r) : 0);
    const sum = a => a.reduce((s, v) => s + v, 0), rest = A0 - sum(raw), extra = sum(w) - sum(raw);
    if (extra > rest) { const k = w.indexOf(Math.max(...w)); w[k] = Math.max(MIN_SEG, w[k] - (extra - rest)); }
    const D = Math.min(A0, sum(w)), rd = Math.min(c.reading / TOTAL * A0, A0 - D);
    // the reading segment starts under the notch, so its first `notch` px are covered by it
    const ws = [w[0], w[1], w[2], notch + rd];
    return { W, notch, D, w: ws, at: [ws[0], ws[0] + ws[1], D, D + notch + rd], rd };
  }
  let pipeNow = null;
  function setPipe(c, animate, delay = 0) {
    const pipe = L$('[data-pipe]');
    pipe.setAttribute('aria-label', `Of ${TOTAL}: ${c.filed + c.review + c.failed} decided (${c.filed} filed, ${c.review} need review, ${c.failed} could not be processed), ${c.reading} being read, ${c.waiting} waiting their turn`);
    // layout width, unaffected by any transform in flight; 0 while the bar is not laid out (the next render draws it)
    const W = pipe.offsetWidth;
    if (!W) { pipeNow = null; return; }
    const headOn = S.live.phase === 'sorting';
    const g = pipeGeom(c, W, headOn ? NOTCH : 0), segEls = [0, 1, 2, 3].map(i => L$(`[data-seg="${i}"]`)), wEls = [1, 2, 3, 4].map(i => L$(`[data-w="${i}"]`)), hw = L$('.pipe__headwrap');
    const sT = w => `scaleX(${(w / W).toFixed(5)})`, wT = x => `translateX(${x.toFixed(2)}px)`;
    const old = pipeNow && pipeNow.W === W ? pipeNow : null; pipeNow = g;
    segEls.forEach((s, i) => { s.style.transform = sT(g.w[i]); });
    wEls.forEach((w, i) => { w.style.transform = wT(g.w[i]); $(':scope > .cut', w).classList.toggle('is-off', g.at[i] <= .5 || g.at[i] >= W - .5 || (i === 3 && g.rd <= 0)); });
    hw.style.transform = wT(g.D);
    if (!animate || !old || reduced()) return;
    const o = { duration: 760, delay, easing: EASE.soft };
    // only what changed moves: the segment that grew, the boundary after it (which carries the rest), and the head
    g.w.forEach((w, i) => { if (Math.abs(w - old.w[i]) < .01) return; A(segEls[i], [{ transform: sT(old.w[i]) }, { transform: sT(w) }], o); A(wEls[i], [{ transform: wT(old.w[i]) }, { transform: wT(w) }], o); });
    if (Math.abs(g.D - old.D) < .01) return;
    A(hw, [{ transform: wT(old.D) }, { transform: wT(g.D) }], o);
    // a flare 24 px wide at the decided edge, inside the bar: red when the document that landed could not be processed
    A(L$(S.live.docFailNow ? '.pipe__flare--fail' : '.pipe__flare:not(.pipe__flare--fail)'), [{ opacity: 0 }, { opacity: .9, offset: .3 }, { opacity: 0 }], { duration: 900, delay, easing: 'ease-out', fill: 'none' });
  }
  function renderLive(anim = false) {
    const el = scr.live, L = S.live, c = liveCounts(), ph = L.phase;
    el.dataset.phase = ph;
    const decided = c.filed + c.review + c.failed;
    const working = ph === 'sending' || ph === 'sorting';
    const checkfail = ph === 'sorting' && L.health === 'checkfail';
    const waiting = working && !L.paused && L.health === 'waiting';
    const paused = working && L.paused && !checkfail;
    const lv = liveOr();
    // not updated lately: no answer inside the lease, and nothing else (waiting, paused, failed) explains it
    const stale = working && !L.paused && L.health === 'ok' && lv === 'stale';
    // out of date on the stage: nothing below the light may still claim live activity
    const muted = ph === 'sorting' && (checkfail || paused || stale);
    const since = hm(L.checkedAt ?? L.clock);
    const waitMin = () => L.waitWhy === 'quiet' ? quietMin() : L.waitMin + Math.floor((performance.now() - L.waitSince) / 60000);
    setLive($('[data-step-label]', el), ph === 'stalled' || ph === 'sending' ? 'Step 4 of 10 · Send' : ph === 'done' ? 'Step 5 done · Sort' : 'Step 5 of 10 · Sort', anim);
    // the heading names the job; the light names its state. It changes only with the phase.
    setHeading(L$('[data-live-h1]'), ph === 'sending' || ph === 'stalled' ? `Sending ${TOTAL} documents` : ph === 'done' ? `Sorted ${TOTAL} documents` : `Sorting ${TOTAL} documents`, anim);
    // Now: what is happening and what it means for you. On a failure, or when the page has not been updated lately, it
    // gives only the consequence. No count in it: the count below carries the number, so the sentence stays still.
    const nowK = ph === 'stalled' ? 'stalled' : ph === 'sending' ? (waiting ? 'send-wait' : stale ? 'send-stale' : 'sending') : ph === 'done' ? 'done'
      : checkfail ? 'checkfail' : waiting ? 'sort-wait' : stale ? 'sort-stale' : 'sorting';
    setLive(L$('[data-live-now]'), {
      stalled: 'Sorting can’t start until every document is sent.',
      sending: `Sending the text of each document from this browser. Keep this page open until all ${TOTAL} are handed over.`,
      'send-wait': 'Keep this page open; sending carries on as soon as the service answers.',
      'send-stale': 'The numbers below may be out of date.',
      done: 'Every document has an outcome. Next, check the results, then make folders on this computer.',
      checkfail: 'The numbers below may be out of date.',
      'sort-wait': 'Outcomes appear here as soon as the service gets to them. Sorting carries on without this page.',
      'sort-stale': 'The numbers below may be out of date.',
      sorting: 'Both systems are reading the documents. You can close this page; sorting carries on without it.',
    }[nowK], anim, nowK);
    wantNext(el, ph === 'stalled' || ph === 'done' || checkfail, ph === 'stalled' ? 'Continue sending' : checkfail ? 'Try again' : 'See the results',
      ph === 'stalled' ? '[data-continue]' : checkfail ? '[data-sort] [data-fail-act]' : '[data-see-results]');
    // send block: a stage pane while sending; once sorting starts it is one fact in the facts row ("All 114 sent at
    // 13:59"), not a pane with a full bar of its own
    const sendOn = ph === 'sending' || ph === 'stalled';
    const send = L$('[data-send]');
    send.hidden = !sendOn; send.classList.toggle('is-failed', ph === 'stalled');
    L$('[data-chip-sent]').hidden = sendOn;
    const sRow = $('[data-status]', send);
    if (ph === 'stalled') paintStatus(sRow, 'failed', 'Sending stopped', `since ${hm(L.lastRx)}, ${L.quietMin ?? quietMin()} min ago`, anim);
    else if (paused) paintStatus(sRow, 'paused', 'Updates paused', 'sending carries on; turn Live updates on to see it', anim);
    else if (waiting) paintStatus(sRow, 'waiting', 'Waiting', L.waitWhy === 'quiet' ? `no new document for ${waitMin()} min` : 'for the service to confirm the last document', anim, 'waiting|' + L.waitWhy);
    else if (lv === 'live') paintStatus(sRow, 'live', 'Sending', evidence('received'), anim);
    else paintStatus(sRow, 'stale', `Not updated since ${hm(L.checkedAt ?? L.lastRx)}`, 'sending may still be going on', anim);
    // sending stopped: the cause and what is kept, then Continue sending; the rest is folded away
    const sfb = $('[data-fail]', send); sfb.hidden = ph !== 'stalled';
    L$('[data-stall-why]').hidden = ph !== 'stalled';
    if (ph === 'stalled') {
      setText($('[data-fail-t]', sfb), `The tab that was sending was closed or went to sleep. This browser kept the text of the other ${TOTAL - L.sent} documents; you don’t need the original folder.`);
      setText($('[data-fail-slot]', sfb), `This continues ${S.run.name}. It doesn’t start a new run or change your spending limit.`);
      setText(L$('[data-stall-more]'), `Only ${L.sent} of ${TOTAL} documents have reached the cloud, and nothing has been charged yet. Sending needs this page open; Continue sending picks up exactly where it stopped.`);
    }
    setNum(L$('[data-send-n]'), L.sent, anim);
    bars.send.set(L.sent, { animate: anim && ph === 'sending', text: `${L.sent} of ${TOTAL} sent${ph === 'stalled' ? '; sending stopped' : ''}` });
    bars.send.el.classList.toggle('is-stalled', ph === 'stalled');
    bars.send.el.classList.toggle('is-done', L.sent >= TOTAL);
    bars.send.el.classList.toggle('is-muted', ph === 'sending' && (paused || stale));
    setLive(L$('[data-send-slot]'), ph === 'sending' && L.resumedFrom != null ? `Continuing ${S.run.name} from ${L.resumedFrom} of ${TOTAL}.` : '', anim, 'resumed' + (ph === 'sending' ? L.resumedFrom : ''));
    if (L.sentAt) setText(L$('[data-sent-at]'), hm(L.sentAt));
    // sort block: one status line until sorting starts
    const sort = L$('[data-sort]');
    sort.classList.toggle('pane--stage', !sendOn); sort.classList.toggle('is-pending', sendOn); sort.classList.toggle('is-done', ph === 'done');
    sort.classList.toggle('is-failed', checkfail); sort.classList.toggle('is-muted', muted);
    const tRow = $('[data-status]', sort);
    // before sorting starts: one line, and it says that nothing has been charged, so no zero tallies are needed
    if (sendOn) paintStatus(tRow, 'off', 'Sorting', `starts once all ${TOTAL} are sent · nothing charged yet`, anim);
    else if (ph === 'done') paintStatus(tRow, 'done', 'Sorted', `at ${hm(L.clock)}`, anim);
    else if (checkfail) paintStatus(tRow, 'failed', 'Can’t reach the service', `since ${hm(L.failAt)}`, anim);
    else if (paused) paintStatus(tRow, 'paused', 'Updates paused', 'sorting carries on without them', anim);
    // "queued" only when the service says the work is queued; otherwise only how long nothing has changed
    else if (waiting) paintStatus(tRow, 'waiting', 'Waiting', L.waitWhy === 'queue' ? `queued at the AI service · no change for ${waitMin()} min` : `no change for ${waitMin()} min`, anim, 'waiting|' + L.waitWhy);
    // relative words, never a bare clock time: "just now" for the first minute, then "N min ago", and then also that
    // the page is still in touch (the pulse keeps going inside the quiet period only)
    else if (lv === 'live') paintStatus(tRow, 'live', 'Working', evidence('result'), anim);
    else paintStatus(tRow, 'stale', `Not updated since ${since}`, 'the run may still be working', anim);
    // can't reach the service: the cause and what is kept, then Try again
    const fb = $('[data-fail]', sort); fb.hidden = !checkfail;
    if (checkfail) {
      setText($('[data-fail-t]', fb), 'This page lost its connection to the service. The run itself may still be sorting; nothing is lost.');
      setText($('[data-fail-act]', fb), 'Try again'); setText($('[data-fail-slot]', fb), 'The page also keeps trying on its own.');
    }
    // the run header light, in the pane's words (the Home run card uses the same function)
    paintRun(...runLight(L), anim);
    // once the run is sorted the toggle no longer controls anything
    L$('[data-live-toggle]').hidden = ph === 'done';
    setNum(L$('[data-decided]'), decided, anim);
    // being read and waiting their turn: written in place in the legend (they are not outcomes, and never roll)
    setText(L$('[data-st-waiting]'), c.waiting); setText(L$('[data-st-reading]'), c.reading);
    L$('[data-legend-reading]').hidden = L$('[data-legend-waiting]').hidden = ph === 'done';
    setPipe(c, anim && !sendOn);
    // finished: See the results directly beneath the light
    L$('[data-sort-next]').hidden = ph !== 'done';
    // the pane's last line: the one-document notice (it stays until the next document fails or sorting ends), or the
    // paused note. It is not laid out at all when it has nothing to say, and "Nothing to do now" is not said: the Now
    // line above already says it.
    const slot = L$('[data-sort-slot]'), notice = L$('[data-doc-notice]');
    const df = ph === 'sorting' && !checkfail && !L.paused ? L.docFail : null;
    notice.hidden = !df;
    if (df) setText($('[data-doc-notice-t]', notice), `‘${df.name}’ could not be processed: it is a scanned image with no text. The others carry on.`);
    const slotK = sendOn ? 'send' : ph === 'done' ? 'done' : checkfail ? 'fail' : L.paused ? 'paused' : df ? 'notice' : 'idle';
    L$('[data-sort-foot]').hidden = slotK !== 'paused' && slotK !== 'notice';
    setLiveHTML(slot, {
      send: '', fail: '', notice: '', done: '', idle: '',
      paused: `Live updates are paused${L.buffered ? `. ${L.buffered} new ${L.buffered === 1 ? 'change is' : 'changes are'} waiting` : ''}; turn them back on to see them.`,
    }[slotK], anim, slotK);
    // tallies and spending: not shown until sorting starts (nothing is sorted or charged while sending)
    L$('[data-tallies]').hidden = sendOn; L$('[data-spend]').hidden = sendOn; L$('[data-live-foot]').classList.toggle('is-solo', sendOn);
    // the tallies roll their counts; they carry no meters (the sorting bar above shows the proportions)
    for (const k of ['filed', 'review', 'failed']) setNum(L$(`[data-t-${k}]`), c[k], anim);
    // red means that something failed: at 0 the "Could not process" tally and its key stay neutral
    L$('.tally--failed').classList.toggle('is-zero', c.failed === 0);
    L$('[data-legend-failed]').hidden = c.failed === 0;
    // spend
    const spent = spentOf(L);
    setText(L$('[data-spent]'), `$${spent.toFixed(2)}`);
    setText(L$('[data-chip-spend]'), `Spent $${spent.toFixed(2)} of $5.00`);
    setText(L$('[data-spent-note]'), sendOn ? 'No documents have been sorted yet, so nothing has been charged.' : ph === 'done' ? 'Every charge has been reported.' : '1 charge not reported yet.');
    // activity, keyed; the rows already there glide down together and the new one fades in
    const ol = L$('[data-activity]'), have = new Map($$('li', ol).map(li => [li.dataset.id, li]));
    const rows = L.act.map(a => {
      let li = have.get(a.id);
      if (!li) {
        li = document.createElement('li'); li.dataset.id = a.id;
        const d = a.doc;
        if (a.kind === 'decided' && d.outcome === 'failed') li.className = 'is-fail';
        li.innerHTML = `<time>${hms(a.t)}</time><span class="line">` + (a.kind === 'sent'
          ? `<span>Received</span> <span class="who">${esc(d.name)}</span>`
          : `<span class="who">${esc(d.name)}</span> ${pill(d.outcome)} <span>${d.outcome === 'filed' ? 'in ' + CAT[d.cat].name : d.outcome === 'review' ? 'comes to you' : 'scanned, no text'}</span>`) + '</span>';
        if (anim) li.dataset.fresh = '1';
      }
      return li;
    });
    listUpdate(ol, rows, anim);
    if (!rows.length) ol.innerHTML = '<li><span></span><span class="muted">Nothing recorded yet.</span></li>';
    syncNext(el);
    Pulse.sync();
  }
  const liveFlip = (anim = true) => flip(scr.live, () => renderLive(anim));
  // +n: an update that saw progress (a document sent, or decided). It renews the pulse lease.
  function liveMore(k) {
    const L = S.live;
    if (!(L.phase === 'sending' || L.phase === 'sorting') || L.health === 'checkfail') return;
    if (L.paused) { L.buffered += k; liveFlip(false); syncProto(); return; }
    L.health = 'ok'; L.waitWhy = null; L.docFailNow = false; S.lastChange = performance.now();
    if (L.phase === 'sending') {
      const before = L.sent; L.sent = Math.min(TOTAL, L.sent + k);
      for (let i = before; i < L.sent; i++) { L.clock += 3; L.lastRx = L.clock; L.act.unshift({ id: 's' + i, t: L.clock, doc: DOCS[i], kind: 'sent' }); }
      L.act = L.act.slice(0, 5); L.checkedAt = L.clock;
      Pulse.confirm();
      if (L.sent === TOTAL) {
        // all sent and handed over: step 4 turns done in place and sorting begins
        L.phase = 'sorting'; L.sentAt = L.clock; L.decided = 0; L.resumedFrom = null;
        liveFlip(); setSpine({ animate: true, delay: 200 });
        // the send pane goes; the finished send becomes one fact in the facts row
        A(L$('[data-chip-sent]'), [{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: EASE.text });
        A(L$('[data-sort-body]'), [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 120, easing: EASE.text });
        // the tallies and spending arrive with sorting (they were not shown while sending)
        A(L$('[data-tallies]'), [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 200, easing: EASE.text });
        A(L$('[data-spend]'), [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 240, easing: EASE.text });
        trace(L$('[data-sort]'), 160);
        announce(`All ${TOTAL} sent. Sorting has started.`, true);
      } else { liveFlip(); setSpine(); announce(`${L.sent} of ${TOTAL} sent`); }
    } else {
      const before = L.decided; L.decided = Math.min(TOTAL, L.decided + k);
      for (let i = before; i < L.decided; i++) { L.clock += 7; L.act.unshift({ id: 'x' + i, t: L.clock, doc: DECIDE[i], kind: 'decided' }); }
      L.act = L.act.slice(0, 5); L.checkedAt = L.clock;
      // a document that could not be processed: its notice replaces the pane's last line and stays there until the
      // next such document or the end of sorting
      const fails = DECIDE.slice(before, L.decided).filter(d => d.outcome === 'failed');
      if (fails.length) { L.docFail = fails[fails.length - 1]; L.docFailNow = true; }
      if (L.decided === TOTAL) {
        L.phase = 'done'; L.docFail = null; Pulse.stop();
        liveFlip(); setSpine({ animate: true, delay: 420 }); handoff(L$('[data-see-results]'), 560);
        const c = countsAt(TOTAL);
        announce(`Sorted ${TOTAL}: ${c.filed} filed, ${c.review} for your review, ${c.failed} could not be processed.`, true);
      } else {
        Pulse.confirm();
        liveFlip(); setSpine();
        if (L.docFailNow) docFailMoment();
        announce(L.docFailNow ? `${L.decided} of ${TOTAL} have an outcome. ${L.docFail.name} could not be processed.` : `${L.decided} of ${TOTAL} have an outcome`, L.docFailNow);
      }
    }
    syncProto();
  }
  // A document could not be processed. The run is still working, so this is a red moment, not a red state:
  // one red beat on the lights and the journey node, the bar's flare is the red one (setPipe), and the notice (red
  // rule) in the pane's last line. The lasting record is the red "Could not process" tally.
  function docFailMoment() {
    Pulse.beat('[data-sort] .ind__beat, [data-run-state] .ind__beat');
    revealFail(L$('[data-doc-notice]'));
  }
  function docFails() {
    const L = S.live; if (L.phase !== 'sorting' || L.health === 'checkfail' || L.paused) return;
    const j = DECIDE.findIndex((d, i) => i >= L.decided && d.outcome === 'failed'); if (j < 0) return;
    [DECIDE[L.decided], DECIDE[j]] = [DECIDE[j], DECIDE[L.decided]];
    liveMore(1);
  }
  // Stall: the service says the work is queued (sorting), or has not confirmed the last document (sending). The
  // light holds a steady glow with a still outer ring, and says why.
  function liveStall() {
    const L = S.live; if (!(L.phase === 'sending' || L.phase === 'sorting') || L.health !== 'ok' || L.paused) return;
    Object.assign(L, { health: 'waiting', waitWhy: L.phase === 'sorting' ? 'queue' : 'confirm', waitMin: 4, waitSince: performance.now() });
    liveFlip(); setSpine();
    announce(L.phase === 'sorting' ? 'Waiting: queued at the AI service. No change for 4 minutes.' : 'Waiting for the service to confirm the last document.', true);
    syncProto();
  }
  // A simulated status check: it succeeded. If nothing has changed for the quiet period the light says Waiting;
  // otherwise it renews the lease. Nothing else moves, because nothing's meaning changed.
  function liveCheck() {
    const L = S.live; if (!(L.phase === 'sending' || L.phase === 'sorting') || L.health === 'checkfail') return;
    L.checkedAt = Math.max(L.checkedAt ?? L.clock, L.clock) + 5;
    if (L.health === 'ok') resumeLight(L);
    if (S.screen === 'live') { liveFlip(); setSpine(); } else if (S.screen === 'home') paintHome();
    syncProto();
  }
  // Failure while sorting: this page could not reach the service.
  function checkFails() {
    const L = S.live; if (L.phase !== 'sorting' || L.health === 'checkfail') return;
    L.failAt = (L.checkedAt ?? L.clock + 6) + 5; L.health = 'checkfail'; L.paused = false; L.buffered = 0;
    L$('[data-live-toggle]').setAttribute('aria-pressed', 'true');
    Pulse.stop();
    liveFlip(); setSpine({ animate: true });
    failMoment(L$('[data-sort]'));
    announce(`Can’t reach the service since ${hm(L.failAt)}. Select Try again.`, true);
    syncProto();
  }
  // Try again succeeded: the page is back in touch. No outcome arrived with it, so the count, the last change and the
  // evidence words stay as they were ("last result 2 min ago · updated just now"), or the light says Waiting.
  function checkAgain() {
    const L = S.live; if (L.health !== 'checkfail') return;
    L.checkedAt = L.failAt + 24;
    const live = resumeLight(L);
    liveFlip(); setSpine({ animate: true });
    trace(L$('[data-sort]'), 40, { dur: 1000 });
    announce(live ? `Back in touch with the service. Last result ${agoWords(sinceChange())}.` : `Back in touch with the service. Waiting: no change for ${quietMin()} min.`, true);
    syncProto();
  }
  $('[data-fail-act]', scr.live).addEventListener('click', checkAgain);
  // Failure while sending: sending stopped and needs the person.
  function sendStops() {
    const L = S.live;
    if (L.phase !== 'sending') { S.live = fresh.live('sending'); S.live.sent = 13; S.live.clock = S.live.lastRx = T0(14, 2, 31); S.live.act = actFromSent(13, T0(14, 2, 31)); }
    // the stop is recognised after a quiet minute; the preset shows one found 41 minutes later. That silence is part of
    // the scene, so the last change is at least that old (this only ever moves it back, never forward).
    S.live.quietMin = L.phase === 'sending' ? 1 : 41;
    S.lastChange = Math.min(S.lastChange, performance.now() - S.live.quietMin * 60000);
    S.live.phase = 'stalled'; S.live.resumedFrom = null; S.live.health = 'ok'; S.live.paused = false; S.live.buffered = 0;
    L$('[data-live-toggle]').setAttribute('aria-pressed', 'true');
    Pulse.stop();
    liveFlip(); setSpine({ animate: true });
    // the bar goes still with a red leading edge; the pane is traced once in red; the cause and Continue sending resolve in
    failMoment(L$('[data-send]'));
    A(L$('[data-stall-why]'), [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 140, easing: EASE.text });
    announce(`Sending stopped at ${S.live.sent} of ${TOTAL}. Select Continue sending.`, true);
    syncProto();
  }
  // Continue sending: the service accepted the continuation. No document has arrived yet, so the last change stays
  // 41 min ago; past the quiet period the light says Waiting until the next document is received.
  function continueSending() {
    const L = S.live; if (L.phase !== 'stalled') return;
    L.phase = 'sending'; L.resumedFrom = L.sent; L.clock = L.lastRx + (L.quietMin ?? 41) * 60 + 9; L.checkedAt = L.clock;
    const live = resumeLight(L);
    liveFlip(); setSpine({ animate: true });
    if (live) bars.send.relight(0);
    trace(L$('[data-send]'), 40, { dur: 1000 });
    announce(`Sending continues from ${L.sent} of ${TOTAL}.${live ? '' : ` Waiting: no new document for ${quietMin()} min.`}`, true);
    syncProto();
  }
  L$('[data-continue]').addEventListener('click', continueSending);
  // The lease ended with no new answer: the pulse has already stopped by itself; now the words catch up.
  function onLeaseEnd() {
    if (S.screen === 'live') { liveFlip(); setSpine(); }
    else if (S.screen === 'read') { readFlip(); setSpine(); }
    else if (S.screen === 'home') paintHome();
    syncProto();
  }
  // Sheet: explains the consequence; the outcome is reported beneath the action that opened it.
  const sheet = $('#sheet-discard');
  $('[data-open-sheet="discard"]').addEventListener('click', () => {
    setText($('[data-sheet-n]', sheet), S.live.sent); $$('[data-rn]', sheet).forEach(s => setText(s, S.run.name));
    sheet.showModal();
    A(sheet, [{ opacity: 0, transform: 'translateY(14px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 460 });
    trace(sheet, 120);
  });
  const closeSheet = msg => {
    const done = () => { sheet.close(); if (msg) { const s = L$('[data-discard-slot]'); s.textContent = msg; } };
    const a = A(sheet, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.99)' }], { duration: 180, easing: EASE.in, fill: 'forwards' });
    if (a) a.finished.then(() => { done(); a.cancel(); }, done); else done();
  };
  $('[data-sheet-cancel]').addEventListener('click', () => closeSheet('Kept. Nothing was deleted.'));
  $('[data-sheet-confirm]').addEventListener('click', () => closeSheet('Discarding is not part of this prototype. Nothing was deleted.'));
  // Live updates: pausing also stops the pulse (WCAG 2.2.2); turning them back on applies the waiting changes at once.
  L$('[data-live-toggle]').addEventListener('click', e => {
    const L = S.live; L.paused = !L.paused; e.currentTarget.setAttribute('aria-pressed', String(!L.paused));
    if (!L.paused && L.buffered) { const k = L.buffered; L.buffered = 0; liveMore(k); } else { liveFlip(); setSpine(); syncProto(); }
  });
  // Run facts on phones: two facts and More
  $('[data-chips-more]').addEventListener('click', e => {
    const ul = $('[data-chips]'), open = !ul.classList.contains('is-open');
    ul.classList.toggle('is-open', open); e.currentTarget.setAttribute('aria-expanded', String(open)); e.currentTarget.textContent = open ? 'Less' : 'More';
  });

  /* ------------------------------------------------------------------ RESULTS */
  const SHOW = [
    { v: 'all', label: 'All', f: () => true },
    { v: 'filed', label: 'Filed', dot: 'filed', f: d => d.outcome === 'filed' },
    { v: 'review', label: 'Needs review', dot: 'review', f: d => d.outcome === 'review' },
    { v: 'failed', label: 'Could not process', dot: 'failed', f: d => d.outcome === 'failed' },
    { v: 'first', label: 'Review first', f: d => !!d.first },
  ];
  const showEl = $('[data-show]'), showBar = $('[data-show-bar]');
  SHOW.forEach(o => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'show__opt'; b.setAttribute('role', 'radio'); b.dataset.v = o.v;
    b.innerHTML = `${o.dot ? `<i style="background:var(--${o.dot}-bar)" aria-hidden="true"></i>` : ''}${o.label} <span class="n">${DOCS.filter(o.f).length}</span>`;
    showEl.appendChild(b);
  });
  function placeShowBar(animate) {
    const opt = $(`.show__opt[aria-checked="true"]`, showEl); if (!opt) return;
    const box = showEl.getBoundingClientRect(), r = opt.getBoundingClientRect(), old = showBar.getBoundingClientRect();
    const x = r.left - box.left, y = r.top - box.top;
    showBar.style.width = r.width + 'px'; showBar.style.height = r.height + 'px'; showBar.style.transform = `translate(${x}px, ${y}px)`;
    if (animate && old.width) A(showBar, [{ transform: `translate(${old.left - box.left}px, ${old.top - box.top}px) scaleX(${old.width / r.width})` }, { transform: `translate(${x}px, ${y}px)` }], { duration: 420, easing: EASE.inout });
  }
  function setShow(v, animate) {
    S.results.show = v; S.results.limit = 25;
    $$('.show__opt', showEl).forEach(b => { const on = b.dataset.v === v; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    placeShowBar(animate); renderResults(animate);
  }
  showEl.addEventListener('click', e => { const b = e.target.closest('.show__opt'); if (b && b.dataset.v !== S.results.show) setShow(b.dataset.v, true); });
  showEl.addEventListener('keydown', e => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault(); const i = SHOW.findIndex(o => o.v === S.results.show), j = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : SHOW.length - 1)) % SHOW.length;
    setShow(SHOW[j].v, true); $(`.show__opt[data-v="${SHOW[j].v}"]`, showEl).focus();
  });
  let qTimer = 0;
  $('[data-q]').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.results.q = e.target.value; S.results.limit = 25; renderResults(false); }, 80); });
  $('[data-more]').addEventListener('click', () => { S.results.limit += 25; renderResults(false, true); });

  function barsHTML(d) {
    const others = CATS.map(c => c.id).filter(id => id !== d.choice);
    let rest = 100 - d.pct; const dist = [[d.choice, d.pct]];
    const shares = d.rich ? { procedures: 12, training: 2, reports: 1, forms: 0 } : null;
    others.forEach((id, i) => { const v = shares ? (shares[id] ?? 0) : i === 0 ? Math.max(1, Math.round(rest * .7)) : Math.max(0, Math.round(rest * .3 / (others.length - 1))); dist.push([id, v]); });
    if (d.choice !== 'none') dist.push(['none', Math.max(0, 100 - dist.reduce((a, [, v]) => a + v, 0))]);
    const name = id => id === 'none' ? 'None of these' : CAT[id].name;
    return `<div class="bars">${dist.map(([id, v]) => `<div class="bar-row"><span${id === d.choice ? ' style="color:var(--ink);font-weight:600"' : ''}>${name(id)}</span><span class="bar"><i style="transform:scaleX(${v / 100})"></i><span class="bar__mark" style="left:90%" aria-hidden="true"></span></span><span class="v">${v}%</span></div>`).join('')}</div>
      <p class="bars__note"><i aria-hidden="true"></i>90% needed to file automatically</p>`;
  }
  function ynHTML(d) {
    const rows = CATS.map((c, i) => {
      const yes = c.id === d.choice || (d.readerYes || []).includes(c.id);
      const v = d.rich ? { explainers: 71, procedures: 58, training: 9, reports: 6, forms: 2 }[c.id] : yes ? 55 + ((i * 17 + d.i) % 40) : 2 + ((i * 7 + d.i) % 10);
      return `<div><span>${c.name}</span><b class="${yes ? '' : 'no'}">${yes ? 'Yes' : 'No'} · ${v}%</b></div>`;
    });
    return `<div class="yn">${rows.join('')}</div>`;
  }
  function defCard(id, by, mark) {
    const c = CAT[id];
    const nots = c.not.map(([t, n]) => n === mark ? `<dd class="nb">${esc(t)}<small>names ${CAT[n].name}</small></dd>` : `<dd>${esc(t)}</dd>`).join('');
    return `<article class="def"><p class="def__by">${by}</p><h4>${c.name}</h4><dl><dt>What belongs here</dt><dd>${esc(c.what)}</dd><dt>What doesn’t belong here</dt>${nots}</dl></article>`;
  }
  function evidenceHTML(d) {
    const first = d.first ? 'Review first: ' : '';
    if (d.outcome === 'failed') {
      return `<div class="evidence" role="region" aria-label="Evidence for ${esc(d.name)}"><div class="ev-lead"><p class="overline">Why it could not be processed</p><p>${esc(d.why)} Nothing about its content was sent, so neither system read it.</p></div>
        <p class="muted small">To include it, make a copy with a text layer (for example by exporting it again from the program that made it) and try it in a new run.</p></div>`;
    }
    const C = d.cat, ch = d.choice;
    const nm = id => id === 'none' ? 'None of these' : CAT[id].name;
    let lead, judged;
    if (d.outcome === 'filed') { lead = `Filed: both systems chose ${nm(C)}, and the certainty check was ${d.pct}% sure. At least 90% is needed to file automatically.`; judged = `<div class="ev-2" style="grid-template-columns:minmax(0,1fr)">${defCard(C, 'Both systems chose', null)}</div>`; }
    else if (d.kind === 'disagree') { lead = `${first}the certainty check chose ${nm(ch)}, ${d.pct}% sure, but the reader said only ${nm(C)} fits. When the two systems disagree, a person decides.`; judged = `<div class="ev-2">${defCard(ch, 'The certainty check chose', C)}${defCard(C, 'The reader chose', ch)}</div>`; }
    else if (d.kind === 'low') { lead = `${first}both systems chose ${nm(C)}, but the certainty check was only ${d.pct}% sure. At least 90% is needed to file automatically.`; judged = `<div class="ev-2">${defCard(C, 'Both systems chose', NEIGHBOUR[C])}${defCard(NEIGHBOUR[C], 'Closest alternative', C)}</div>`; }
    else if (d.kind === 'two') { lead = `${first}the reader said it fits both ${nm(C)} and ${nm(NEIGHBOUR[C])}. A document that fits two categories comes to you.`; judged = `<div class="ev-2">${defCard(C, 'The reader said it fits', NEIGHBOUR[C])}${defCard(NEIGHBOUR[C], 'and also', C)}</div>`; }
    else { lead = `${first}neither system found a category that fits well. It may need a new one.`; judged = `<div class="ev-2">${defCard('reports', 'Closest for the certainty check', null)}${defCard('explainers', 'Next closest', null)}</div>`; }
    const reader = d.readerYes || [];
    const quotes = (reader.length ? QUOTES[reader[0]] : ['Notes from the March meeting and a list of ideas for next year.']).map(q => `<p class="quote">${esc(q)}</p>`).join('');
    const reason = reader.length ? (d.rich ? 'The slides walk through the steps for making a request, in order, with the form to use at each step.' : REASON[reader[0]]) : 'It mixes a record of a meeting with plans for next year; none of the categories describes that.';
    const read = d.rich
      ? `<div class="read-slides"><div class="slide"><p class="slide__k">Slide 1 <span>Week 3: Making a request</span></p></div><div class="slide"><p class="slide__k">Slide 2 <span>Why requests need approval</span></p></div>
         <div class="slide"><p class="slide__k">Slide 3 <span>The steps</span></p><p><mark>Step 1: open the request form and fill in section A.</mark><br><mark>Step 2: send it to your line manager for approval.</mark><br>Step 3: keep the reply for your records.</p><div class="notes"><b>Speaker notes</b>Remind the group that approval usually takes two working days.</div></div>
         <div class="slide"><p class="slide__k">Slide 4 <span>Questions</span></p></div></div>`
      : `<div class="read-slides"><div class="slide"><p class="slide__k">Page 1</p><p>${(reader.length ? QUOTES[reader[0]] : ['Notes from the March meeting.']).map(q => `<mark>${esc(q)}</mark>`).join('<br>')}</p></div></div>`;
    return `<div class="evidence" role="region" aria-label="Evidence for ${esc(d.name)}">
      <div class="ev-lead"><p class="overline">${d.outcome === 'filed' ? 'Why it was filed' : 'Why it came to you'}</p><p>${lead.charAt(0).toUpperCase() + lead.slice(1)}</p></div>
      <div class="ev-block"><p class="ev-h">The two systems, side by side</p><div class="ev-2">
        <section class="sys sys--check" aria-label="Certainty check"><div class="sys__top"><p class="sys__name"><i aria-hidden="true"></i>Certainty check</p><p class="sys__sub">One choice among all categories</p></div>${barsHTML(d)}
          <p class="ev-h" style="margin:8px 0 0">Its separate yes or no for each category</p><p class="sys__sub" style="margin-top:-8px">Not combined with the percentages above.</p>${ynHTML(d)}</section>
        <section class="sys sys--reader" aria-label="Reader"><div class="sys__top"><p class="sys__name"><i aria-hidden="true"></i>Reader</p><p class="sys__sub">A yes or no for each category</p></div>
          <div class="yn">${CATS.map(c => `<div><span>${c.name}</span><b class="${reader.includes(c.id) ? '' : 'no'}">${reader.includes(c.id) ? 'Yes' : 'No'}</b></div>`).join('')}</div>
          <p class="ev-h" style="margin:6px 0 -4px">Its reason</p><p class="sys__reason">${esc(reason)}</p>
          <p class="ev-h" style="margin:6px 0 -4px">Exact quotes it relied on</p>${quotes}</section>
      </div></div>
      <div class="ev-block"><p class="ev-h">Judged against these categories</p>${judged}</div>
      <details class="disc"><summary>${glyph('chev')}What the systems read</summary><div><p class="small faint">Kept on this computer; shown from the text prepared here.</p>${read}</div></details>
      <details class="disc" data-technical><summary>${glyph('chev')}Details</summary><div><p class="small">Exact values to three decimal places and the recorded answers, for the person who looks after the app.</p></div></details>
    </div>`;
  }
  function renderResults(animate = false, keepScroll = false) {
    const el = scr.results, st = S.results;
    setText($('[data-step-label]', el), 'Step 6 of 10 · Results');
    const f = SHOW.find(o => o.v === st.show), q = st.q.trim().toLowerCase();
    const match = DOCS.filter(d => f.f(d) && (!q || `${d.name} ${d.where} ${d.why}`.toLowerCase().includes(q)));
    const shown = match.slice(0, st.limit);
    const tb = $('[data-tbody]', el);
    const rows = [];
    for (const d of shown) {
      const open = st.open === d.id;
      rows.push(`<tr class="row${open ? ' is-open' : ''}" data-id="${d.id}"><td class="c-doc"><span class="doc"><span class="doc__name">${esc(d.name)}</span><span class="ext">${d.ext.toUpperCase()}</span></span></td>
        <td class="c-out">${pill(d.outcome)}${d.first ? '<span class="first">Review first</span>' : ''}</td><td class="c-where${d.outcome === 'filed' ? '' : ' dup'}">${esc(d.where)}</td><td class="c-why" title="${esc(d.why)}">${esc(d.why)}</td>
        <td class="c-open"><button class="open-btn" type="button" aria-expanded="${open}" aria-controls="ev-${d.id}" data-open="${d.id}">${open ? 'Close' : 'Open'}<span class="sr-only"> evidence for ${esc(d.name)}</span></button></td></tr>`);
      if (open) rows.push(`<tr class="drawer" id="ev-${d.id}"><td colspan="5">${evidenceHTML(d)}</td></tr>`);
    }
    if (!shown.length) rows.push('<tr class="empty-row"><td colspan="5">No documents match. Clear the search to see them all.</td></tr>');
    const y = keepScroll ? scrollY : null;
    tb.innerHTML = rows.join('');
    if (y != null) scrollTo(0, y);
    setText($('[data-caption]', el), `${f.v === 'all' ? 'All documents' : f.label}${q ? ` matching “${st.q.trim()}”` : ''} · ${shown.length} of ${match.length} shown`);
    const more = $('[data-more]', el); more.hidden = shown.length >= match.length;
    setText(more, `Show ${Math.min(25, match.length - shown.length)} more`);
    setText($('[data-more-note]', el), shown.length >= match.length ? `All ${match.length} shown.` : `${match.length - shown.length} more not shown yet.`);
    if (animate) $$('tr.row', tb).slice(0, 12).forEach((r, i) => A(r, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: i * 22 }));
  }
  $('[data-tbody]').addEventListener('click', e => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    const id = b.dataset.open, opening = S.results.open !== id;
    S.results.open = opening ? id : null;
    const kb = e.detail === 0;
    renderResults(false, true);
    const nb = $(`[data-open="${id}"]`); nb && nb.focus({ preventScroll: true });
    if (opening) openEvidence(id, kb);
  });
  function openEvidence(id) {
    const drawer = $('#ev-' + id); if (!drawer || reduced()) return;
    const ev = $('.evidence', drawer);
    A(ev, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 520 });
    $$(':scope > *', ev).forEach((c, i) => A(c, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay: 80 + i * 70 }));
    $$('.sys', ev).forEach((s, i) => trace(s, 220 + i * 120));
    $$('.bar i', ev).forEach((b, i) => { const t = b.style.transform; A(b, [{ transform: 'scaleX(0)' }, { transform: t }], { duration: 700, delay: 320 + i * 40, easing: EASE.soft }); });
  }
  document.addEventListener('keydown', e => {
    if (e.key === '/' && S.screen === 'results' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('[data-q]').focus(); }
  });

  /* ------------------------------------------------------------------ REVIEW */
  const FOLDERS = [
    { g: 'Filed automatically', items: [
      { k: 'procedures', name: 'Procedures', n: 30, flag: '<b>10 moved out</b>, into Explainers' },
      { k: 'explainers', name: 'Explainers', n: 41, flag: '<b>10 moved in</b>; look at them before ticking' },
      { k: 'reports', name: 'Reports', n: 14 }, { k: 'forms', name: 'Forms', n: 12 },
      { k: 'training', name: 'Training', n: 7, flag: '<b>1 moved in</b> from Needs review' }] },
    { g: 'Came for your review', items: [
      { k: 'review', name: 'Needs review', n: 4, flag: '25 placed into other folders' },
      { k: 'failed', name: 'Could not process', n: 2 }] },
  ];
  const MOVED = [
    ['Week 3 slides', 'Needs review', 'Procedures'], ['Week 4 slides', 'Needs review', 'Explainers'], ['Week 5 slides', 'Procedures', 'Explainers'],
    ['Week 6 slides', 'Procedures', 'Explainers'], ['Team plan 2026', 'Needs review', 'Explainers'], ['Meeting notes March', 'Needs review', 'Handouts'],
  ];
  function renderReview(animate = false) {
    const el = scr.review, V = S.review;
    setText($('[data-step-label]', el), V.saved ? 'Step 8 done · Review folders' : 'Step 8 of 10 · Review folders');
    $$('[data-rn]').forEach(s => setText(s, S.run.name));
    // folders
    const box = $('[data-folders]', el);
    if (!box.dataset.built) {
      box.innerHTML = FOLDERS.map(gr => `<fieldset class="fgroup"><legend>${gr.g}</legend>${gr.items.map(f => `
        <label class="frow"><span class="tickbox"><input class="tick" type="checkbox" data-tick="${f.k}"><svg class="tick-g" viewBox="0 0 22 22" aria-hidden="true"><path d="M6 11.5l3.2 3.2L16 7.8"/></svg></span>
          <span><span class="frow__name">${f.name}</span>${f.flag ? `<span class="frow__flag">${f.flag}</span>` : ''}</span><span class="frow__n">${f.n} files</span></label>`).join('')}</fieldset>`).join('') +
        `<fieldset class="fgroup"><legend>New folders</legend><div class="frow frow--new">${glyph('folder', 'g folder-g')}<div><span class="frow__name">Handouts</span><span class="frow__flag">3 files. You made this folder. Is ‘Handouts’ a new category, or should these files be left out?</span>
          <div class="choice-row" role="radiogroup" aria-label="What is ‘Handouts’?"><button type="button" class="choice" role="radio" data-newfolder="new">A new category</button><button type="button" class="choice" role="radio" data-newfolder="ignore">Leave these files out</button></div></div></div></fieldset>`;
      box.dataset.built = '1';
      $$('[data-tick]', box).forEach(t => t.addEventListener('change', () => { S.review.ticks[t.dataset.tick] = t.checked; if (t.checked) tickDraw(t); renderReview(false); }));
      $$('[data-newfolder]', box).forEach(b => b.addEventListener('click', () => { const was = S.review.newFolder; S.review.newFolder = b.dataset.newfolder; renderReview(false); if (!was) A($('[data-save-review]'), [{ transform: 'scale(.97)', opacity: .6 }, { transform: 'none', opacity: 1 }], { duration: 420 }); }));
    }
    $$('[data-tick]', box).forEach(t => { t.checked = !!V.ticks[t.dataset.tick]; });
    $$('[data-newfolder]', box).forEach(b => b.setAttribute('aria-checked', String(V.newFolder === b.dataset.newfolder)));
    // moved documents with "either A or B"
    const ul = $('[data-moved]', el);
    ul.innerHTML = MOVED.map(([n, from, to]) => {
      const d = byName[n], mark = V.marks[d.id], open = V.openEither === d.id;
      const opts = sel => CATS.map(c => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${c.name}</option>`).join('');
      const a = mark ? mark[0] : 'procedures', b = mark ? mark[1] : 'explainers';
      return `<li data-id="${d.id}"><div class="mv"><div style="min-width:0"><span class="doc"><span class="doc__name">${esc(n)}</span><span class="ext">${d.ext.toUpperCase()}</span></span>
        <p class="mv__path">${esc(from)} ${glyph('arrow')} <b>${esc(to)}</b>${mark ? ` <span class="mark">Either ${CAT[mark[0]].name} or ${CAT[mark[1]].name}</span>` : ''}</p></div>
        <button class="btn btn--secondary btn--sm" type="button" aria-expanded="${open}" aria-controls="either-${d.id}" data-either="${d.id}">${mark ? 'Change' : 'Fits either…'}</button></div>
        ${open ? `<div class="either" id="either-${d.id}"><p class="either__q"><span>This document fits either</span><label class="sr-only" for="ea-${d.id}">First category</label><select class="sel" id="ea-${d.id}" data-ea>${opts(a)}</select><span>or</span><label class="sr-only" for="eb-${d.id}">Second category</label><select class="sel" id="eb-${d.id}" data-eb>${opts(b)}</select></p>
          <div class="action"><div class="action__row"><button class="btn btn--secondary btn--sm" type="button" data-mark="${d.id}">Mark as either</button>${mark ? `<button class="btn btn--quiet btn--sm" type="button" data-unmark="${d.id}">Remove the mark</button>` : ''}</div>
          <p class="slot${mark ? ' is-done' : ''}" data-mark-slot>${mark ? `${glyph('check')}<span>Marked as either ${CAT[mark[0]].name} or ${CAT[mark[1]].name}. Kept on this computer until you save your review.</span>` : ''}</p></div></div>` : ''}</li>`;
    }).join('') + '<li><button class="btn btn--quiet btn--sm" type="button" data-soon>Show 8 more</button></li>';
    // definitions (frozen)
    const defs = $('[data-defs]', el);
    if (!defs.dataset.built) {
      const conf = { procedures: '10 moved out → Explainers', explainers: '10 moved in from Procedures', training: '1 moved in from Needs review' };
      defs.innerHTML = CATS.map((c, i) => `<details class="acc"${i < 2 ? ' open' : ''}><summary>${c.name}<small>${c.id === 'procedures' ? '30 files' : c.id === 'explainers' ? '41 files' : ''}</small>${glyph('chev')}</summary>
        <article class="def"><dl><dt>What belongs here</dt><dd>${esc(c.what)}</dd><dt>What doesn’t belong here</dt>${c.not.map(([t, n]) => `<dd class="nb">${esc(t)}<small>names ${CAT[n].name}</small></dd>`).join('')}<dt>Examples</dt><dd>${c.ex.map(esc).join(' · ')}</dd></dl>
        ${conf[c.id] ? `<p class="def__conf">${glyph('arrow')}Your moves: ${conf[c.id]}</p>` : ''}<p class="def__folder">Folder name in your sorted copies: ${c.id}</p></article></details>`).join('');
      defs.dataset.built = '1';
    }
    // save
    const btn = $('[data-save-review]', el), slot = $('[data-save-slot]', el);
    if (V.saved) {
      btn.disabled = false; btn.innerHTML = `Next: what your review shows ${glyph('arrow')}`;
      slot.className = 'slot is-done'; slot.innerHTML = `${glyph('check')}<span>Saved at 15:10. Your answers stay linked to ${S.run.name}.</span>`;
    } else if (V.pendingSave) {
      btn.disabled = true;
      if (!slot.querySelector('.working')) { slot.className = 'slot'; slot.innerHTML = '<span class="working"><span class="working__bar" aria-hidden="true"><i></i></span><span data-work-t>Comparing your folders with the results…</span></span>'; }
    } else {
      btn.disabled = !V.newFolder; btn.innerHTML = `Save my review ${glyph('arrow')}`;
      slot.className = 'slot';
      const unticked = Object.values(V.ticks).filter(v => !v).length;
      slot.textContent = !V.newFolder ? 'Answer the question about ‘Handouts’ first.' : unticked ? `${unticked} folders are not ticked. They won’t be counted as right or wrong.` : 'Every folder is ticked.';
    }
    setText($('[data-review-now]', el), V.saved ? 'Your review is saved. Next, see what it shows about the categories.' : 'You moved 14 files. Tick each folder once you’ve looked through it.');
    setText($('[data-next-label]', el), V.saved ? 'What your review shows' : 'Save my review');
  }
  // the tick settles in: a small scale and a fade (transform and opacity only)
  function tickDraw(input) {
    const g = input.parentElement.querySelector('.tick-g'); if (!g || !input.checked) return;
    A(g, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE.out });
  }
  scr.review.addEventListener('click', e => {
    const V = S.review;
    const ei = e.target.closest('[data-either]');
    if (ei) { V.openEither = V.openEither === ei.dataset.either ? null : ei.dataset.either; renderReview(); const box = $('#either-' + ei.dataset.either); if (box) A(box, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 420 }); $(`[data-either="${ei.dataset.either}"]`).focus(); return; }
    const mk = e.target.closest('[data-mark]');
    if (mk) {
      const li = mk.closest('li'), a = $('[data-ea]', li).value, b = $('[data-eb]', li).value, slot = $('[data-mark-slot]', li);
      if (a === b) { slot.className = 'slot'; slot.innerHTML = `${glyph('alert')} Choose two different categories.`; return; }
      V.marks[mk.dataset.mark] = [a, b]; renderReview();
      const nli = $(`li[data-id="${mk.dataset.mark}"]`, scr.review);
      A($('.mark', nli), [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 420 });
      $('[data-mark]', nli)?.focus(); return;
    }
    const um = e.target.closest('[data-unmark]');
    if (um) { delete V.marks[um.dataset.unmark]; renderReview(); $('[data-mark]', $(`li[data-id="${um.dataset.unmark}"]`, scr.review))?.focus(); return; }
  });
  let workTimer = 0;
  $('[data-save-review]').addEventListener('click', () => {
    const V = S.review;
    if (V.saved) { flash('That step is not part of this prototype.'); return; }
    if (!V.newFolder || V.pendingSave) return;
    V.pendingSave = true; S.pending = 'review'; renderReview();
    // an honest indeterminate wait: a short sweep (at most about 5 s), then still with the elapsed time
    const bar = $('.working__bar i', scr.review);
    const a = A(bar, [{ transform: 'translateX(-100%)' }, { transform: 'translateX(250%)' }], { duration: 1500, iterations: 3, easing: EASE.inout, fill: 'none' });
    const start = performance.now();
    const still = () => { const w = $('.working', scr.review); if (!w) return; w.classList.add('is-still'); const s = Math.round((performance.now() - start) / 1000); setText($('[data-work-t]', scr.review), `Still working · started 15:09 · ${s} s`); };
    if (a) a.finished.then(still, () => {}); else still();
    clearInterval(workTimer); workTimer = setInterval(() => { if (!S.review.pendingSave) return clearInterval(workTimer); if ($('.working.is-still', scr.review)) still(); }, 1000);
    syncProto();
  });
  function resolvePending() {
    if (S.pending !== 'review') return false;
    S.pending = null; clearInterval(workTimer);
    const V = S.review; V.pendingSave = false; V.saved = true;
    renderReview(); setSpine({ animate: true, delay: 100 }); handoff($('[data-save-review]'), 200);
    announce('Review saved at 15:10.', true);
    syncProto();
    return true;
  }

  /* ------------------------------------------------------------------ shared: handoff (the slot turns into the next step) */
  function handoff(btn, delay = 0) {
    if (!btn || reduced()) return;
    A(btn, [{ opacity: 0, transform: 'translateY(8px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay, easing: EASE.out });
    ignite(btn, delay + 260);
  }
  function ignite(btn, delay = 0) {
    if (reduced() || !btn) return;
    const r = btn.getBoundingClientRect(); if (!r.width) return;
    const ring = document.createElement('div'); ring.className = 'ignite';
    Object.assign(ring.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    document.body.appendChild(ring);
    const a = A(ring, [{ opacity: 0, transform: 'scale(1)' }, { opacity: .9, transform: 'scale(1.02)', offset: .15 }, { opacity: 0, transform: 'scale(1.28, 1.6)' }], { duration: 760, delay, easing: 'ease-out', fill: 'both' });
    const done = () => ring.remove(); if (a) a.finished.then(done, done); else done();
  }
  let flashEl = null;
  function flash(t, anchor) {
    if (!flashEl) { flashEl = document.createElement('p'); flashEl.className = 'tip-note'; flashEl.setAttribute('role', 'status'); }
    const r = (anchor || document.activeElement || document.body).getBoundingClientRect();
    flashEl.textContent = t; document.body.appendChild(flashEl);
    Object.assign(flashEl.style, { position: 'fixed', left: Math.max(8, Math.min(innerWidth - 280, r.left)) + 'px', top: (r.bottom + 10) + 'px', zIndex: 50 });
    A(flashEl, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 240 });
    clearTimeout(flash.t); flash.t = setTimeout(() => flashEl.remove(), 2600);
  }

  /* ------------------------------------------------------------------ navigation and stage choreography */
  let finishT = null;
  function renderScreen(k, anim) {
    if (k !== 'read' && k !== 'live') paintRun('off');
    if (k === 'home') paintHome();
    else if (k === 'read') renderRead(anim); else if (k === 'confirm') renderConfirm(); else if (k === 'live') renderLive(anim);
    else if (k === 'results') { renderResults(anim); requestAnimationFrame(() => placeShowBar(false)); } else if (k === 'review') renderReview(anim);
    syncNext(scr[k]);
  }
  function renderShell() {
    setText($('[data-run-name]'), S.run.name); setText($('[data-run-when]'), S.run.when); setText($('[data-run-kind]'), S.run.kind);
  }
  // A screen opens. The heading text resolves in reading order: the overline, the heading word by word (the only text
  // with a little blur), then the Now sentence, Next and the run facts. The panes rise a little behind it, each with its
  // first line of text. Only the pane that holds the screen's one action has its edge traced, once; a screen with no
  // action on it has none. The header has settled by about 500 ms.
  function enter(el, { dir = 1, delay = 60 } = {}) {
    if (reduced()) return;
    const head = $('.stage-head, .hero__copy', el);
    let t = delay;
    if (head) {
      const ov = $(':scope > .overline', head);
      if (ov && visible(ov)) reveal(ov, t);
      const h = $('h1', head);
      // the sentence starts while the heading is still resolving, so the header reads as one gesture
      if (h) revealWords(h, t + 20);
      t += 90;
      $$('.now__k, .now__t, .next:not([hidden]), .chips, .toggle, :scope > .lede, :scope > .action, :scope > .promises', head).filter(visible).forEach((e, i) => reveal(e, t + i * 24));
    }
    const groups = $$('[data-enter]', el).filter(g => g !== head && visible(g)).slice(0, 8);
    const primary = $$('[data-primary]', el).find(b => !b.hidden && visible(b));
    const actionPane = primary && primary.closest('.pane');
    groups.forEach((g, i) => {
      const d = delay + 90 + i * 45;
      A(g, [{ opacity: 0, transform: `translate3d(${dir * 12}px, 10px, 0)` }, { opacity: 1, transform: 'none' }], { duration: 420, delay: d, easing: EASE.text });
      $$('.status, .count, :scope > .h2, :scope > h2, .section-head, .choose > .h2', g).filter(visible).slice(0, 2).forEach((e, k) => reveal(e, d + 60 + k * 30));
      if (actionPane && (g === actionPane || g.contains(actionPane))) trace(actionPane, d + 80, { dur: 720 });
    });
  }
  function go(to, { launch = false } = {}) {
    if (!scr[to]) to = 'home';
    if (finishT) finishT();
    const from = S.screen;
    if (from === to) { renderShell(); renderScreen(to, false); setSpine({ animate: true }); updateTabs(false); syncProto(); return; }
    const fromEl = scr[from], toEl = scr[to];
    const dir = ORDER.indexOf(to) >= ORDER.indexOf(from) ? 1 : -1;
    const motion = !reduced();
    S.screen = to;
    history.replaceState(null, '', '#' + to);
    let cleaned = false, out = null;
    const cleanup = () => { if (cleaned) return; cleaned = true; fromEl.hidden = true; fromEl.removeAttribute('style'); fromEl.classList.remove('is-leaving'); if (out) out.cancel(); finishT = null; Pulse.sync(); };
    if (motion) {
      const r = fromEl.getBoundingClientRect();
      Object.assign(fromEl.style, { position: 'fixed', top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', margin: '0', zIndex: '3' });
      fromEl.classList.add('is-leaving');
    } else fromEl.hidden = true;
    toEl.hidden = false;
    frame.dataset.shell = to === 'home' ? 'home' : 'run';
    renderShell();
    window.scrollTo(0, 0);
    renderScreen(to, false);
    setSpine({ animate: motion, delay: launch ? 180 : 60 });
    updateTabs(motion);
    if (to === 'home') layoutArena();
    if (motion) {
      if (from === 'home' || to === 'home') A($('.spine'), [{ opacity: 0, transform: 'translateX(-20px)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay: 120, easing: EASE.text });
      // the old stage is gone by 90 ms (140 ms on Start run), so two screens never read on top of each other
      out = fromEl.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate3d(${-20 * dir}px, 0, 0) scale(${launch ? .97 : .995})` }], { duration: launch ? 140 : 90, easing: EASE.leave, fill: 'forwards' });
      finishT = cleanup; out.finished.then(cleanup, cleanup);
      enter(toEl, { dir, delay: launch ? 120 : 60 });
      if (to === 'home') { arenaEnter(300); Amb.sweep(500); }
      // a bar draws itself only the first time it is shown (powerUp is a no-op once it has been built)
      if (to === 'live' && (S.live.phase === 'sending')) bars.send.powerUp(300);
      if (to === 'read' && S.read.phase === 'reading') bars.read.powerUp(360);
    }
    const h = toEl.querySelector('h1'); h && h.focus({ preventScroll: true });
    syncProto();
  }
  const WORKING = new Set(['read', 'live', 'live-sending', 'live-waiting', 'live-checkfail']);
  function applyPreset(name, { animate = true } = {}) {
    const p = PRESETS[name] || PRESETS.home;
    Pulse.stop();
    S.lastChange = performance.now();
    // the simulated status checks are on by default for the working screens (?checks=off starts them stopped)
    if (WORKING.has(name) && QS.get('checks') !== 'off' && !Checks.on) Checks.set(true);
    const { screen } = p();
    const tg = L$('[data-live-toggle]'); tg && tg.setAttribute('aria-pressed', String(!S.live.paused));
    if (!animate) { showNow(screen); return; }
    go(screen);
  }
  function showNow(screen) {
    for (const [k, el] of Object.entries(scr)) { el.hidden = k !== screen; el.removeAttribute('style'); el.classList.remove('is-leaving'); }
    S.screen = screen;
    frame.dataset.shell = screen === 'home' ? 'home' : 'run';
    renderShell(); renderScreen(screen, false); S.spineCur = null; setSpine(); updateTabs(false); layoutArena(); syncProto();
    // a bar that is on screen from the start is already built: it will not draw itself later
    Object.values(bars).forEach(b => { if (visible(b.el)) b.shown = true; });
  }

  /* ------------------------------------------------------------------ clicks that navigate */
  document.addEventListener('click', e => {
    const soon = e.target.closest('[data-soon]');
    if (soon) { e.preventDefault(); flash('Not part of this prototype.', soon); return; }
    const pre = e.target.closest('[data-preset]');
    if (pre) { e.preventDefault(); applyPreset(pre.dataset.preset); return; }
    const or = e.target.closest('[data-open-run]');
    if (or) { e.preventDefault(); const n = or.dataset.openRun; const when = { 9: '25 Sep · 13:58', 8: '23 Sep · 09:41', 7: '19 Sep · 16:05' }[n];
      // Run 9 opens in the state its card shows (a failure is dealt with there, on the run)
      if (n === '9') { if (S.run.name !== 'Run 9') PRESETS.live(); } else if (n === '8') { PRESETS.review(); } else { PRESETS.results(); }
      S.run = { name: 'Run ' + n, when, kind: 'This run' }; go(n === '9' ? 'live' : n === '8' ? 'review' : 'results'); return; }
    const nx = e.target.closest('[data-next]');
    if (nx) { e.preventDefault(); const t = $(nx.dataset.target || '[data-primary]', nx.closest('.screen')) || $('[data-primary]', nx.closest('.screen'));
      if (t && !t.hidden && !t.disabled) { t.focus(); t.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); }
      else { const r = $('[data-reasons], [data-slot]', nx.closest('.screen')); if (r) { r.setAttribute('tabindex', '-1'); r.focus(); } }
      return; }
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); const to = g.dataset.go; if (to === 'live' && S.screen !== 'live') { if (!S.live || S.run.kind !== 'This run') PRESETS.live(); } go(to); return; }
  });
  $('[data-start-new]').addEventListener('click', () => { S.run = newRun(false); S.read = fresh.read('choose', 0); go('read'); });
  $('[data-choose-folder]').addEventListener('click', () => {
    S.read = fresh.read('reading', 0);
    S.run = newRun(true); renderShell();
    S.lastChange = performance.now(); Pulse.confirm();
    renderRead(true); setSpine({ animate: true, delay: 60 });
    const work = $('[data-read-work]');
    A(work, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE.text });
    bars.read.powerUp(180);
    trace($('[data-read-pane]'), 60);
    $$('.status, .count, .loader__foot', work).forEach((e, i) => reveal(e, 100 + i * 50));
    syncProto();
  });
  $('[data-review-start]').addEventListener('click', () => { S.confirm = fresh.confirm(); syncConfirmInputs(); go('confirm'); });
  $('[data-start-run]').addEventListener('click', e => {
    const btn = e.currentTarget; if (btn.disabled) return;
    ignite(btn, 0);
    S.run = { name: 'Run 10', when: '25 Sep · 15:40', kind: 'This run' };
    S.live = { phase: 'sending', sent: 0, decided: 0, clock: T0(15, 40, 12), lastRx: T0(15, 40, 12), act: [], paused: false, buffered: 0, health: 'ok', docFail: null, checkedAt: null, waitWhy: null, waitSince: 0, waitMin: 0 };
    DECIDE.splice(0, DECIDE.length, ...DECIDE0);
    // the service answered Start run: that is the first confirmation, so the light is live from here
    S.lastChange = performance.now(); Pulse.confirm();
    if (QS.get('checks') !== 'off' && !Checks.on) Checks.set(true);
    L$('[data-live-toggle]').setAttribute('aria-pressed', 'true');
    go('live', { launch: true });
  });
  $('[data-see-results]').addEventListener('click', () => { S.results = fresh.results(); go('results'); });
  $('[data-make-folders]').addEventListener('click', () => { S.review = fresh.review(); go('review'); });

  /* ------------------------------------------------------------------ theme, motion, ambient */
  function setTheme(t) {
    root.dataset.theme = t; try { localStorage.setItem('la-theme', t); } catch (e) {}
    const tb = $('[data-theme-toggle]'); tb.setAttribute('aria-pressed', String(t === 'dark')); tb.setAttribute('aria-label', t === 'dark' ? 'Dark theme' : 'Light theme');
    syncProto();
  }
  function setMotion(m) {
    root.dataset.motion = m; try { localStorage.setItem('la-motion', m); } catch (e) {}
    motionChanged();
  }
  // Reduced motion switched on mid-session (the OS setting or the prototype toggle): the pulse stops at once and every
  // animation in flight jumps to its end state. Switched off: the pulse resumes if the lease is still fresh.
  function motionChanged() {
    Pulse.sync();
    if (reduced()) document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } });
    syncProto();
  }
  mqReduce.addEventListener('change', motionChanged);
  // outcome colours for the owner's comparison: current, proposed A (amber towards yellow, light fill red darker),
  // proposed B (red only: the light theme's "Could not process" fill takes the darker red; amber unchanged)
  function setAmber(v) {
    if (v === 'proposed' || v === 'red') root.dataset.amber = v; else delete root.dataset.amber;
    try { localStorage.setItem('la-amber', v); } catch (e) {}
    syncProto();
  }
  function setQuiet(ms) {
    QUIET = ms;
    // a light already waiting because of the old quiet period stays honest: the next answer re-decides it
    syncProto();
  }
  $('[data-theme-toggle]').addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  $$('[data-set-theme]').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.setTheme)));
  $$('[data-set-motion]').forEach(b => b.addEventListener('click', () => setMotion(b.dataset.setMotion)));
  $$('[data-set-checks]').forEach(b => b.addEventListener('click', () => Checks.set(b.dataset.setChecks === 'on')));
  $$('[data-set-amber]').forEach(b => b.addEventListener('click', () => setAmber(b.dataset.setAmber)));
  $$('[data-set-quiet]').forEach(b => b.addEventListener('click', () => setQuiet(Number(b.dataset.setQuiet))));

  // The one ambient light: when Home opens (an event), a single short light runs once along a line of the building's
  // lattice, on the side away from the text, and is gone. Transform and opacity only; no loop, no timer, nothing random.
  // Work screens have none. Off under reduced motion.
  const Amb = (() => {
    const el = $('.ambient > i');
    let last = null;
    function sweep(delay = 0) {
      if (reduced() || innerWidth <= 980) return null;
      if (last) last.cancel();
      last = A(el, [{ transform: 'translateX(-260px)', opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .8 }, { transform: `translateX(${innerWidth}px)`, opacity: 0 }], { duration: 2400, delay, easing: EASE.inout, fill: 'none' });
      return last;
    }
    return { sweep };
  })();

  /* ------------------------------------------------------------------ prototype control bar */
  const proto = $('#proto');
  function syncProto() {
    $$('[data-set-theme]').forEach(b => b.setAttribute('aria-pressed', String(root.dataset.theme === b.dataset.setTheme)));
    const m = reduced() ? 'reduce' : 'full';
    $$('[data-set-motion]').forEach(b => b.setAttribute('aria-pressed', String(m === b.dataset.setMotion)));
    $$('[data-set-checks]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.setChecks === 'on') === Checks.on)));
    $$('[data-set-amber]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setAmber === (root.dataset.amber || 'current'))));
    $$('[data-set-quiet]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.setQuiet) === QUIET)));
    const L = S.live, R0 = S.read, onLive = S.screen === 'live', onRead = S.screen === 'read' && R0.phase === 'reading';
    const cur = onLive ? (L.phase === 'sending' ? 'live-sending' : L.phase === 'stalled' ? 'live-stalled' : L.health === 'waiting' ? 'live-waiting' : L.health === 'checkfail' ? 'live-checkfail' : 'live') : S.screen;
    $$('[data-preset]').forEach(a => a.setAttribute('aria-current', String(a.dataset.preset === cur)));
    const one = $('[data-sim="one"]'), ten = $('[data-sim="ten"]'), stl = $('[data-sim="stall"]'), fl = $('[data-sim="fail"]'), df = $('[data-sim="docfail"]'), rc = $('[data-sim="recover"]'), nxt = $('[data-sim="next"]');
    // A label names what the button does on this screen and keeps its words while the button is disabled (a stop or a
    // failure), so the control bar never re-wraps at that moment: a shorter label would lift the whole page, light and all.
    const sendJob = onLive && (L.phase === 'sending' || L.phase === 'stalled'), sortJob = onLive && L.phase === 'sorting';
    const unit = onRead ? ['file read', 'files read'] : sendJob ? ['sent', 'sent'] : sortJob ? ['decided', 'decided'] : null;
    const more = (onRead && R0.health !== 'lost') || (onLive && L.phase === 'sending') || (sortJob && L.health !== 'checkfail');
    one.disabled = ten.disabled = !more;
    one.textContent = unit ? `+1 ${unit[0]}` : '+1'; ten.textContent = unit ? `+10 ${unit[1]}` : '+10';
    const working = (onRead && R0.health === 'ok') || (onLive && (L.phase === 'sending' || L.phase === 'sorting') && L.health === 'ok' && !L.paused);
    stl.disabled = !working;
    // Failure names the failure it will cause on this screen
    fl.textContent = onRead ? 'Fail: folder access lost' : sendJob ? 'Fail: sending stops' : sortJob ? 'Fail: can’t reach service' : 'Fail';
    fl.disabled = !((onRead && R0.health !== 'lost') || (onLive && (L.phase === 'sending' || (L.phase === 'sorting' && L.health !== 'checkfail'))));
    df.disabled = !(onLive && L.phase === 'sorting' && L.health !== 'checkfail' && !L.paused && DECIDE.some((d, i) => i >= L.decided && d.outcome === 'failed'));
    const canRecover = (onRead && (R0.health !== 'ok' || !Pulse.fresh())) || (onLive && (L.phase === 'stalled' || ((L.phase === 'sorting' || L.phase === 'sending') && !L.paused && (L.health !== 'ok' || !Pulse.fresh()))));
    rc.disabled = !canRecover;
    nxt.textContent = S.pending ? 'Reply arrives' : 'Next step';
    nxt.classList.toggle('is-waiting', !!S.pending);
  }
  function recover() {
    if (S.screen === 'read') { const R0 = S.read; if (R0.health === 'lost') readAgain(); else if (R0.phase === 'reading') readMore(1); return; }
    if (S.screen !== 'live') return;
    const L = S.live;
    if (L.phase === 'stalled') continueSending();
    else if (L.health === 'checkfail') checkAgain();
    else if (L.health === 'waiting') liveMore(1);
    else liveCheck(); // an answer arrives after the pulse lapsed: it renews the lease only (or says Waiting)
  }
  function sim(kind) {
    if (kind === 'one' || kind === 'ten') { const k = kind === 'one' ? 1 : 10; if (S.screen === 'read') readMore(k); else if (S.screen === 'live') liveMore(k); return; }
    if (kind === 'stall') { if (S.screen === 'read') readStall(); else if (S.screen === 'live') liveStall(); return; }
    if (kind === 'fail') { if (S.screen === 'read') readLost(); else if (S.screen === 'live') { if (S.live.phase === 'sorting') checkFails(); else if (S.live.phase === 'sending') sendStops(); } return; }
    if (kind === 'docfail') { if (S.screen === 'live') docFails(); return; }
    if (kind === 'recover') { recover(); return; }
    if (kind === 'next') {
      if (resolvePending()) return;
      switch (S.screen) {
        case 'home': $('[data-start-new]').click(); break;
        case 'read': if (S.read.phase === 'choose') $('[data-choose-folder]').click(); else if (S.read.health === 'lost') readAgain(); else if (S.read.phase === 'reading') readMore(TOTAL); else $('[data-review-start]').click(); break;
        case 'confirm': if ($('[data-start-run]').disabled) { S.confirm = { mode: 'interactive', limit: '5', nolimit: false }; syncConfirmInputs(); renderConfirm('limit'); } else $('[data-start-run]').click(); break;
        case 'live': if (S.live.phase === 'stalled') continueSending(); else if (S.live.health === 'checkfail') checkAgain(); else if (S.live.phase === 'sending' || S.live.phase === 'sorting') { if (S.live.paused) $('[data-live-toggle]').click(); liveMore(TOTAL); } else $('[data-see-results]').click(); break;
        case 'results': $('[data-make-folders]').click(); break;
        case 'review': if (S.review.saved) go('home'); else { if (!S.review.newFolder) { S.review.newFolder = 'new'; renderReview(); } $('[data-save-review]').click(); } break;
      }
    }
  }
  $$('[data-sim]').forEach(b => b.addEventListener('click', () => sim(b.dataset.sim)));
  addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PRESETS[h]) applyPreset(h); });

  /* ------------------------------------------------------------------ boot: final states, no entrance motion on load */
  buildArena();
  const q = new URLSearchParams(location.search);
  proto.open = q.get('proto') === 'open' || (q.get('proto') !== 'closed' && innerWidth > 760);
  const startHash = location.hash.slice(1);
  $$('.show__opt', showEl).forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === 'all')));
  Checks.arm();
  applyPreset(PRESETS[startHash] ? startHash : 'home', { animate: false });
  setTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
  requestAnimationFrame(() => { setSpine(); updateTabs(false); layoutArena(); placeShowBar(false); syncNext(); });
  let rz = 0;
  // the sorting bar is drawn in pixels of its own width (minimum segments, the notch), so it is redrawn at a new width
  const relayoutPipe = () => { if (S.screen === 'live') setPipe(liveCounts(), false); };
  addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { S.spineCur = null; setSpine(); updateTabs(false); layoutArena(); placeShowBar(false); relayoutPipe(); syncNext(); }); });
  const booted = () => requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-booting')));
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { S.spineCur = null; setSpine(); updateTabs(false); layoutArena(); placeShowBar(false); relayoutPipe(); syncNext(); booted(); });

  // For the evidence script and for anyone driving the prototype by hand.
  window.LA = {
    sim, preset: n => applyPreset(n), go, state: S, sweep: d => Amb.sweep(d),
    get pulseFresh() { return Pulse.fresh(); }, lease: LEASE, period: PERIOD,
    check: () => Checks.tick(), checks: on => Checks.set(on), get checksOn() { return Checks.on; }, amber: v => setAmber(v), quiet: ms => setQuiet(ms),
    band: sel => numeralBand(document.querySelector(sel)),
    lights: () => $$('[data-st]').filter(visible).map(r => ({ where: r.closest('[data-run-state]') ? 'run header' : r.closest('[data-sort]') ? 'sort pane' : r.closest('[data-send]') ? 'send pane' : 'read pane', st: r.dataset.st, text: [...r.children].filter(e => !e.classList.contains('ind')).map(e => e.textContent.trim()).filter(Boolean).join(' · ') })),
    freeze: () => { const a = document.getAnimations(); a.forEach(x => x.pause()); return a.length; },
    seek: t => { document.getAnimations().forEach(x => { try { x.currentTime = t; } catch (e) {} }); },
    resume: () => document.getAnimations().forEach(x => x.play()),
  };
})();
