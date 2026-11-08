import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A jump regression test with a DOM small enough to state the contract:
 * the conversation scrollport must move, and a nested process-group body must
 * move with it. The host used to give a quote a single scrollable ancestor;
 * newer hosts nest one, and picking the innermost box leaves the transcript
 * exactly where it was — the bug this test exists for.
 */

class Event {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles === true;
    this.target = null;
  }
}

class WheelEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.deltaY = init.deltaY ?? 0;
  }
}

function matches(element, selector) {
  if (selector === '*') return true;
  const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attribute !== null) {
    const value = element.attrs[attribute[1]];
    return value !== undefined && (attribute[2] === undefined || value === attribute[2]);
  }
  if (selector === 'button') return element.tag === 'BUTTON';
  return element.tag === selector.toUpperCase();
}

class Element {
  constructor(tag, attrs = {}, options = {}) {
    this.tag = tag.toUpperCase();
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
    this.overflowY = options.overflowY ?? 'visible';
    this.scrollHeight = options.scrollHeight ?? 0;
    this.clientHeight = options.clientHeight ?? 20;
    this.height = options.height ?? 20;
    this.layoutTop = options.layoutTop ?? 0;
    this.textContent = options.text ?? '';
    this.isConnected = true;
    this.scrollTop = 0;
    this.listeners = new Map();
  }

  get scrollTop() {
    return this._scrollTop;
  }

  set scrollTop(value) {
    const floor = Math.max(0, this.scrollHeight - this.clientHeight);
    this._scrollTop = Math.max(0, Math.min(floor, Number(value) || 0));
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  /** Pixels of ancestor scrolling that move this element's box. */
  scrolledAway() {
    let total = 0;
    for (let node = this.parentElement; node != null; node = node.parentElement) total += node._scrollTop;
    return total;
  }

  getBoundingClientRect() {
    const top = this.layoutTop - this.scrolledAway();
    return { top, left: 0, right: 200, bottom: top + this.height, width: 200, height: this.height };
  }

  closest(selector) {
    for (let node = this; node != null; node = node.parentElement) {
      if (matches(node, selector)) return node;
    }
    return null;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const nested = child.querySelector(selector);
      if (nested !== null) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  dispatchEvent(event) {
    event.target = this;
    for (let node = this; node != null; node = event.bubbles ? node.parentElement : null) {
      for (const listener of node.listeners.get(event.type) ?? []) listener.call(node, event);
      if (!event.bubbles) break;
    }
    return true;
  }
}

/* --------------------------------------------------------------- fixture */

const root = new Element('div', {}, { height: 900, layoutTop: 0 });
const scroller = root.append(
  new Element(
    'div',
    { 'data-conversation-scroll': '' },
    { overflowY: 'auto', scrollHeight: 5000, clientHeight: 800, height: 800, layoutTop: 0 },
  ),
);
scroller.scrollTop = 4000;

const chatRoot = scroller.append(
  new Element('div', { 'data-chat-following-tail': '' }, { height: 4000, layoutTop: 0 }),
);
// A step is mounted twice: the reasoning copy comes first in the DOM and also
// contains the first quote, so first-match selection would land there.
chatRoot.append(
  new Element(
    'div',
    {
      'data-chat-node-key': 'n1',
      'data-chat-turn': '2',
      'data-chat-group-part': 'reasoning',
    },
    { height: 120, layoutTop: 1500, text: '根因 目标文字' },
  ),
);
const group = chatRoot.append(
  new Element('div', { 'data-step-process': '', 'data-chat-group-key': 'g1' }, { height: 420, layoutTop: 1990 }),
);
const body = group.append(
  new Element(
    'div',
    { 'data-step-process-body': '' },
    { overflowY: 'auto', scrollHeight: 1000, clientHeight: 400, height: 400, layoutTop: 2000 },
  ),
);
const row = body.append(
  new Element(
    'div',
    {
      'data-chat-node-key': 'n1',
      'data-chat-turn': '2',
      'data-chat-group-part': 'response',
    },
    { height: 100, layoutTop: 2500, text: '前文 目标文字 中间 另一段 后文' },
  ),
);
const quote = row.append(new Element('span', {}, { height: 20, layoutTop: 2510, text: '目标文字' }));
const otherQuote = row.append(new Element('span', {}, { height: 20, layoutTop: 2800, text: '另一段' }));

/* A host that follows the tail until a sampled scroll says otherwise. */
let followingTail = true;
let pending = false;
let observedTop = scroller.scrollTop;
let wheelCount = 0;
scroller.addEventListener('wheel', () => {
  wheelCount += 1;
});
scroller.addEventListener('scroll', () => {
  if (scroller.scrollTop !== observedTop) pending = true;
});
scroller.addEventListener('scrollend', () => {
  if (!pending) return;
  pending = false;
  followingTail = false;
  observedTop = scroller.scrollTop;
});

const document = {
  querySelector(selector) {
    if (selector === '[data-chat-node-key="n1"]' || selector === '[data-chat-turn="2"]') return row;
    if (selector === '[data-chat-following-tail]') return chatRoot;
    return root.querySelector(selector);
  },
  querySelectorAll(selector) {
    return root.querySelectorAll(selector);
  },
};

globalThis.document = document;
globalThis.CSS = { escape: (value) => String(value) };
globalThis.Event = Event;
globalThis.WheelEvent = WheelEvent;

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__definition = definition;
    },
  },
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
  },
  getSelection: () => null,
  addEventListener() {},
  removeEventListener() {},
  getComputedStyle: (element) => ({ overflowY: element.overflowY }),
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  innerWidth: 1200,
  innerHeight: 900,
};

class Component {
  constructor(props) {
    this.props = props;
  }
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  Component,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

await import('../client.js');
const definition = globalThis.__definition;
const mod = definition.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});

const slots = [];
const ctx = {
  effect: (run) => {
    run();
    return () => {};
  },
  get: () => undefined,
  reflect: { provide: () => () => {} },
  locale: { register: () => {}, bind: () => (key) => key },
  uiConversation: { userText: { register: () => () => {} } },
  sidebarRightTabs: { register: () => () => {} },
  slots: {
    inject: (name, run) => {
      run();
      return () => {};
    },
    register: (options, component) => {
      slots.push({ options, component });
      return () => {};
    },
  },
  sessions: {},
};
mod.apply(ctx);

function find(element, predicate) {
  if (element == null || typeof element !== 'object') return null;
  if (predicate(element)) return element;
  for (const child of element.props?.children ?? []) {
    const found = find(child, predicate);
    if (found !== null) return found;
  }
  return null;
}

test('a jump moves the conversation viewport, not only the nested group body', async () => {
  window.localStorage.store.set(
    'dsh.question-tree.v4.session-1',
    JSON.stringify([
      {
        id: 'n1',
        parentId: null,
        quote: '目标文字',
        quotes: ['目标文字'],
        status: 1,
        createdAt: 1,
        anchor: { nodeKey: 'n1', turn: '2' },
        anchors: [{ nodeKey: 'n1', turn: '2' }],
        questions: [],
      },
      {
        id: 'n2',
        parentId: 'n1',
        quote: '另一段',
        quotes: ['另一段'],
        status: 1,
        createdAt: 2,
        anchor: { nodeKey: 'n1', turn: '2' },
        anchors: [{ nodeKey: 'n1', turn: '2' }],
        questions: [],
      },
    ]),
  );

  const panel = slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component;
  const treeElement = find(
    panel({ questionTree: { sessionId: 'session-1', t: (key) => key } }),
    (element) => typeof element.type === 'function' && element.props?.questionTree != null,
  );
  assert.ok(treeElement, 'the panel did not reach its tree body');
  const rendered = treeElement.type(treeElement.props);
  const rowFor = (id) =>
    find(
      rendered,
      (element) => typeof element.props?.onLocate === 'function' && element.props?.row?.node?.id === id,
    );
  const firstRow = rowFor('n1');
  const secondRow = rowFor('n2');
  assert.ok(firstRow, 'the first node row was not rendered');
  assert.ok(secondRow, 'the second node row was not rendered');

  firstRow.props.onLocate('n1');

  // The synthetic reader sample must release the tail immediately; otherwise a
  // later resize re-pins the transcript before the jump is accepted.
  assert.equal(followingTail, false, 'the transcript still follows its tail');
  assert.ok(wheelCount > 0, 'no wheel gesture was offered to the host');
  assert.ok(scroller.scrollTop < 3000, 'the conversation viewport did not move');
  assert.ok(body.scrollTop > 0, 'the nested process body did not move');

  // Both boxes now show the first quoted line at the top: body-relative and
  // viewport-relative. The group header may sit just above the viewport.
  const bodyFrame = body.getBoundingClientRect();
  const quoteFrame = quote.getBoundingClientRect();
  assert.ok(
    Math.abs(quoteFrame.top - bodyFrame.top - 8) <= 1,
    `quote is ${quoteFrame.top - bodyFrame.top}px below the body top, expected 8px`,
  );
  assert.ok(
    Math.abs(quoteFrame.top - 8) <= 1,
    `quote is ${quoteFrame.top}px below the viewport top, expected 8px`,
  );
  const firstTop = scroller.scrollTop;

  // A second node quoting another passage of the SAME message must land on
  // that passage, not on the group header or the first landing. This is the
  // case that looked like "only the first root can jump".
  secondRow.props.onLocate('n2');
  assert.equal(followingTail, false, 'the second jump re-acquired the tail');
  assert.ok(
    scroller.scrollTop > firstTop + 50,
    `second jump stayed at ${scroller.scrollTop}, first landing was ${firstTop}`,
  );
  assert.ok(
    Math.abs(otherQuote.getBoundingClientRect().top - 8) <= 1,
    `second quote is ${otherQuote.getBoundingClientRect().top}px below the viewport top, expected 8px`,
  );

  // Let the bounded re-assertion passes run; they must not undo the landing.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(Math.abs(otherQuote.getBoundingClientRect().top - 8) <= 1);
  assert.ok(scroller.scrollTop > firstTop + 50);
});
