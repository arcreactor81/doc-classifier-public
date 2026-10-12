/**
 * In-page DOM checks for the UI flow scripts (SPEC §10.2 Harness, WP-11a). Each helper takes a Playwright `page`
 * and runs inside it; none changes the page.
 *
 * - watchMutations: what changed under a root (script 6: "0 nodes removed under #app during unchanged polls").
 * - feedbackAdjacency: the §5.3 action contract for every `button[data-op]` (script 7).
 * - visibleText: rendered text, optionally without `[data-technical]` Details (script 9's jargon scan).
 * - noHorizontalOverflow: the page and the elements that stick out (script 12).
 * - focusedTestId: the `data-testid` nearest the focused element (focus rules, scripts 6 and 10).
 */

/**
 * Starts recording mutations under `root` (default `#app`). `take()` returns the records so far and clears them;
 * `stop()` disconnects and returns the rest. Each record names its target (`tag#id.class`, the nearest
 * `data-testid`, whether it is inside `[data-technical]`) so a script can allow, say, the "Checked" time only.
 * @param {import('@playwright/test').Page} page
 */
export async function watchMutations(page, { root = '#app', key = 'default' } = {}) {
  await page.evaluate(({ root, key }) => {
    const host = document.querySelector(root);
    if (!host) throw new Error(`watchMutations: no element matches ${root}`);
    const describe = node => {
      if (!node) return null;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element) return { node: node.nodeName };
      const classes = [...element.classList].slice(0, 3).map(name => `.${name}`).join('');
      return {
        node: node.nodeType === Node.ELEMENT_NODE ? node.nodeName.toLowerCase() : node.nodeName,
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes}`,
        testid: element.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        technical: Boolean(element.closest('[data-technical]'))
      };
    };
    const store = (window.__uiHarnessMutations ??= {});
    store[key]?.observer.disconnect();
    const records = [];
    const observer = new MutationObserver(list => {
      for (const m of list) records.push({
        type: m.type,
        target: describe(m.target),
        attributeName: m.attributeName,
        oldValue: m.oldValue,
        value: m.type === 'attributes' ? m.target.getAttribute(m.attributeName) : m.type === 'characterData' ? m.target.data : null,
        added: m.addedNodes.length,
        removed: m.removedNodes.length,
        addedNodes: [...m.addedNodes].slice(0, 5).map(describe),
        removedNodes: [...m.removedNodes].slice(0, 5).map(describe)
      });
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
    store[key] = { observer, records };
  }, { root, key });
  const read = clear => page.evaluate(({ key, clear }) => {
    const entry = window.__uiHarnessMutations?.[key];
    if (!entry) return [];
    entry.observer.takeRecords();
    const out = entry.records.splice(0, entry.records.length);
    if (clear === 'stop') entry.observer.disconnect();
    return out;
  }, { key, clear });
  return {
    take: () => read('take'),
    stop: () => read('stop'),
    /** Counts by kind: removed and added nodes, attribute changes, text changes. */
    summarize: records => ({
      removedNodes: records.reduce((n, r) => n + r.removed, 0),
      addedNodes: records.reduce((n, r) => n + r.added, 0),
      attributeChanges: records.filter(r => r.type === 'attributes').length,
      textChanges: records.filter(r => r.type === 'characterData').length
    })
  };
}

/**
 * The §5.3 DOM contract for every `button[data-op]` on the page: inside a `.action` whose last element child is
 * the `[data-feedback]` slot for the same id, the slot after the button in the document and (when rendered)
 * below it, at most one message per slot, `aria-describedby` pointing at the note and slot ids. Also returns the
 * number of `[data-primary]` elements and any alert or problem notice that is not inside an action.
 * @param {import('@playwright/test').Page} page
 */
export async function feedbackAdjacency(page, { root = 'body' } = {}) {
  return page.evaluate(({ root }) => {
    const host = document.querySelector(root);
    if (!host) throw new Error(`feedbackAdjacency: no element matches ${root}`);
    const visible = element => element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? element.offsetParent !== null;
    const buttons = [...host.querySelectorAll('button[data-op]')].map(button => {
      const id = button.getAttribute('data-op');
      const action = button.closest('.action');
      const last = action?.lastElementChild ?? null;
      const slot = last && last.matches('[data-feedback]') ? last : null;
      const b = button.getBoundingClientRect(), s = slot?.getBoundingClientRect();
      const rendered = Boolean(slot && s && (s.width > 0 || s.height > 0));
      const messages = slot ? [...slot.querySelectorAll('.feedback__status, .feedback__alert')].filter(el => el.textContent.trim()).length : 0;
      const describedBy = (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      return {
        id,
        label: button.textContent.trim(),
        visible: visible(button),
        disabled: button.disabled,
        primary: button.hasAttribute('data-primary'),
        inAction: Boolean(action),
        actionId: action?.getAttribute('data-action') ?? null,
        lastIsFeedback: Boolean(slot),
        slotMatches: slot?.getAttribute('data-feedback') === id,
        slotAfterButton: Boolean(slot && (button.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING)),
        slotBelowButton: rendered ? s.top >= b.bottom - 1 : null,
        messages,
        describedBy,
        describedByResolves: describedBy.every(ref => document.getElementById(ref)),
        ok: Boolean(action && slot && slot.getAttribute('data-feedback') === id && messages <= 1 &&
          (button.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING) && (!rendered || s.top >= b.bottom - 1))
      };
    });
    const main = host.querySelector('main') ?? host;
    const strayNotices = [...main.querySelectorAll('[role="alert"], .notice--problem, .notice--blocker')]
      .filter(element => !element.closest('.action') && element.textContent.trim())
      .map(element => ({ element: `${element.tagName.toLowerCase()}${element.className ? `.${[...element.classList].join('.')}` : ''}`,
        text: element.textContent.trim().slice(0, 120), atTopOfMain: main.firstElementChild?.contains(element) ?? false }));
    return {
      buttons,
      primaryCount: host.querySelectorAll('[data-primary]').length,
      strayNotices,
      ok: buttons.every(b => b.ok)
    };
  }, { root });
}

/**
 * The rendered text under `root` (default the whole body), one text run per line. With `excludeTechnical`
 * (default true) nothing inside `[data-technical]` is included. `includeAttributes` adds visible or announced
 * attribute text (placeholder, title, alt, aria-label, aria-description, aria-valuetext).
 * @param {import('@playwright/test').Page} page
 */
export async function visibleText(page, { excludeTechnical = true, root = 'body', includeAttributes = false } = {}) {
  return page.evaluate(({ excludeTechnical, root, includeAttributes }) => {
    const host = document.querySelector(root);
    if (!host) return '';
    const skip = element => Boolean(element.closest('script,style,noscript,template')) ||
      (excludeTechnical && Boolean(element.closest('[data-technical]'))) ||
      !(element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
    const lines = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.replace(/\s+/g, ' ').trim();
      if (text && node.parentElement && !skip(node.parentElement)) lines.push(text);
    }
    if (includeAttributes) {
      for (const element of host.querySelectorAll('[placeholder],[title],[alt],[aria-label],[aria-description],[aria-valuetext]')) {
        if (excludeTechnical && element.closest('[data-technical]')) continue;
        for (const name of ['placeholder', 'title', 'alt', 'aria-label', 'aria-description', 'aria-valuetext']) {
          const value = element.getAttribute(name)?.trim();
          if (value) lines.push(value);
        }
      }
    }
    return lines.join('\n');
  }, { excludeTechnical, root, includeAttributes });
}

/**
 * Whether the page scrolls sideways at the current viewport, and which elements stick out past its right edge
 * (at most 10, outermost first). Elements inside a horizontally scrolling container do not count.
 * @param {import('@playwright/test').Page} page
 */
export async function noHorizontalOverflow(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    const clipped = element => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) return true;
      }
      return false;
    };
    const offenders = [];
    for (const element of document.body?.querySelectorAll('*') ?? []) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= width + 1 || clipped(element)) continue;
      if (offenders.some(o => o.node.contains(element))) continue;
      offenders.push({ node: element, rect });
      if (offenders.length >= 10) break;
    }
    return {
      ok: scrollWidth <= width,
      scrollWidth,
      width,
      offenders: offenders.map(({ node, rect }) => ({
        element: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.classList.length ? `.${[...node.classList].slice(0, 3).join('.')}` : ''}`,
        testid: node.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        right: Math.round(rect.right), width: Math.round(rect.width)
      }))
    };
  });
}

/**
 * The `data-testid` of the focused element or its nearest ancestor with one; null when nothing (or only the body)
 * has focus. `focusedElement` gives the details.
 * @param {import('@playwright/test').Page} page
 */
export async function focusedTestId(page) {
  return (await focusedElement(page))?.testid ?? null;
}

export async function focusedElement(page) {
  return page.evaluate(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    if (!element || element === document.body || element === document.documentElement) return null;
    return {
      testid: element.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      op: element.getAttribute('data-op'),
      text: (element.textContent ?? '').trim().slice(0, 80)
    };
  });
}
