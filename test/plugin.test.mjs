import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Wiring test for the standalone build: load the composed module the way the
 * Client loader does, then assert that ONE apply produces the whole product —
 * the selection service, the bar, the transcript chip, and the tree.
 */

let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def;
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
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn) => setTimeout(fn, 0),
  getSelection: () => null,
};

class Component {
  constructor(props) {
    this.props = props;
  }
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Component,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial ?? null }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

await import('../client.js');

test('the composed module registers under the package name', () => {
  assert.ok(definition, 'window.__ModuleLoader__.load was not called');
  assert.equal(definition.id, 'dsh-question-tree');
});

const mod = definition.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});

test('one plugin declares every service it needs', () => {
  assert.deepEqual(mod.inject, [
    'slots',
    'locale',
    'sidebarRightTabs',
    'sessions',
    'uiConversation',
  ]);
  assert.ok(!mod.inject.includes('selectionActions'), 'must not inject its own service');
});

/** One apply for the whole file: module state accumulates across applies. */
let APPLIED = null;

function applyToFakeContext() {
  if (APPLIED !== null) return APPLIED;
  const types = [];
  const slots = [];
  const rules = [];
  const provided = {};
  const sources = [];
  const views = [];
  const ctx = {
    effect: (run) => {
      run();
      return () => {};
    },
    get: (name) => (name === 'inputTriggers' ? { registerSource: (src) => (sources.push(src), () => {}) } : undefined),
    reflect: {
      provide: (name, value) => {
        provided[name] = value;
        return () => {};
      },
    },
    locale: { register: () => {}, bind: () => (key) => key },
    uiConversation: {
      userText: {
        register: (rule) => {
          rules.push(rule);
          return () => {};
        },
      },
      // Without this stub the view registrations below hit their try/catch and
      // a broken tab silently passes every test.
      views: {
        register: (definition) => {
          views.push(definition);
          return () => {};
        },
      },
    },
    sidebarRightTabs: {
      register: (declaration) => {
        types.push(declaration);
        return () => {};
      },
    },
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
  APPLIED = { types, slots, rules, provided, sources, views };
  return APPLIED;
}

test('one apply ships the whole product', () => {
  const { types, slots, rules, provided, sources } = applyToFakeContext();
  // The tab type and its body.
  assert.equal(types.length, 1);
  assert.equal(types[0].kind, 'question-tree');
  assert.equal(types[0].title(), '问题树');

  const names = slots.map((entry) => entry.options.name).sort();
  assert.deepEqual(names, [
    'conversation.composer.dock',
    'conversation.user.text.node',
    'conversation.view',
    'shell.overlay',
    'shell.overlay',
    'sidebar.right.pane.tab',
  ]);

  // Selection service + chip source with a codec (without it the draft cannot submit).
  assert.equal(typeof provided.selectionActions.register, 'function');
  assert.equal(provided.selectionActions.formatMessage('引用', '问题'), '「引用」——问题');
  assert.equal(sources.length, 1);
  // Not `quote`: DSH 0.2.2 registers `quote` itself (@deepseek-ai/dsh-message-quotes).
  assert.equal(sources[0].name, 'selection-quote');
  assert.equal(typeof sources[0].codec.serialize, 'function');

  // The transcript chip matcher.
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'selection-quote');
});

test('the tree registers as a conversation view and as a tab', () => {
  const { views, slots } = applyToFakeContext();
  assert.equal(views.length, 1, 'one view target is registered');
  assert.equal(views[0].target, 'question-tree');
  const tab = slots.find(
    (entry) => entry.options.name === 'conversation.view' && entry.options.id === 'question-tree',
  );
  assert.ok(tab, 'the view tab renders the panel');
  assert.equal(tab.component.name, 'Panel');
});

test('both actions appear on the bar built by this same plugin', () => {
  const { provided } = applyToFakeContext();
  const ids = provided.selectionActions.actions().map((action) => action.id);
  assert.deepEqual(ids, ['to-composer', 'question-tree']);
  const tree = provided.selectionActions.actions().find((action) => action.id === 'question-tree');
  assert.equal(tree.label(), '树形提问');
});

test('the panel still renders', () => {
  const { slots } = applyToFakeContext();
  const panel = slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab');
  const element = panel.component({ questionTree: { sessionId: 'session-1', t: (k) => k } });
  assert.equal(typeof element, 'object');
  assert.ok(element.type);
});

test('the tree action writes into the session the bar hands it', () => {
  // The bar knows which session the selection came from. Reading the session
  // from module state instead wrote nodes into whichever panel had mounted
  // last, which is how a selection in one conversation landed in another.
  const { provided } = applyToFakeContext();
  const action = provided.selectionActions.actions().find((item) => item.id === 'question-tree');
  assert.ok(action, 'the tree action is registered');
  window.localStorage.setItem('dsh.question-tree.v4.sess-a', '[]');
  window.localStorage.setItem('dsh.question-tree.v4.sess-b', '[]');

  action.run({ text: '只在 a 里出现的引文', altKey: false, ctrlKey: false, anchor: null, sessionId: 'sess-a' });

  const a = JSON.parse(window.localStorage.getItem('dsh.question-tree.v4.sess-a'));
  const b = JSON.parse(window.localStorage.getItem('dsh.question-tree.v4.sess-b'));
  assert.equal(a.length, 1, 'the node lands in the session the bar named');
  assert.equal(a[0].quote, '只在 a 里出现的引文');
  assert.equal(b.length, 0, 'the other session is untouched');
});

test('"add to composer" is offered on every host, so old DSH never loses it', () => {
  // 0.2.2's @deepseek-ai/dsh-message-quotes draws its own 「引用文本」 pill, and
  // the bar drops this button only while that pill is on screen. It must still
  // be REGISTERED everywhere: a host without the pill (0.2.1, or 0.2.2 with
  // that core plugin off) has no other way to put a quote in the composer.
  const api = applyToFakeContext().provided.selectionActions;
  const before = api.actions().map((action) => action.id);

  const ctx = {
    effect: (run) => {
      run();
      return () => {};
    },
    get: () => undefined,
    reflect: { provide: () => () => {} },
    locale: { register: () => {}, bind: () => (key) => key },
    uiConversation: {
      userText: { register: () => () => {} },
      interactions: { register: () => () => {} },
    },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (name, run) => (run(), () => {}), register: () => () => {} },
    sessions: {},
  };
  mod.apply(ctx);
  const added = api.actions().map((action) => action.id).slice(before.length);
  assert.deepEqual(added.sort(), ['question-tree', 'to-composer']);
});

test('DSH 0.2.2: the core quote plugin does not take the tree down with it', () => {
  // 0.2.2 ships @deepseek-ai/dsh-message-quotes, which owns the user-text rule
  // id `quote` and the `conversation.user.text.node` key `quote`. Both
  // registries throw on a duplicate, and an exception raised while an entry
  // activates fails the whole web boot (`web boot: 1 entry did not activate`).
  const types = [];
  const slots = [];
  const rules = [];
  const ctx = {
    effect: (run) => {
      run();
      return () => {};
    },
    get: () => undefined,
    reflect: { provide: () => () => {} },
    locale: { register: () => {}, bind: () => (key) => key },
    uiConversation: {
      userText: {
        register: (rule) => {
          if (rule.id === 'quote') throw new Error('user-text rule "quote" is already registered');
          rules.push(rule);
          return () => {};
        },
      },
    },
    sidebarRightTabs: {
      register: (declaration) => {
        types.push(declaration);
        return () => {};
      },
    },
    slots: {
      inject: (name, run) => {
        run();
        return () => {};
      },
      register: (options, component) => {
        if (options.name === 'conversation.user.text.node' && options.key === 'quote') {
          throw new Error('slot key "quote" is already registered');
        }
        slots.push({ options, component });
        return () => {};
      },
    },
    sessions: {},
  };

  assert.doesNotThrow(() => mod.apply(ctx), 'apply must survive a host-owned quote id');
  assert.equal(types.length, 1, 'the tree tab still registers');
  assert.deepEqual(
    rules.map((rule) => rule.id),
    ['selection-quote'],
  );
  assert.ok(
    slots.some((entry) => entry.options.name === 'conversation.user.text.node'),
    'the chip still registers under its own key',
  );
});
