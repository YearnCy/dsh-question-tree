/**
 * Browser half of the question tree.
 *
 * Flow:
 *
 *   select text in the transcript → 「树形提问」chip → quote node
 *   → its inline input opens → you type whatever you want → Enter
 *   → the typed question becomes a child node and goes to the conversation
 *
 * Nothing here composes the question for you. The only text that reaches the
 * model is the text you typed.
 */
window.__ModuleLoader__.load({
  id: '@local/question-tree',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /*__MODEL__*/

    const ID = '@local/question-tree';
    const VIEW_ID = 'question-tree';
    const KIND = 'question-tree';
    const NS = 'questionTree';
    const STORE_PREFIX = 'dsh.question-tree.v4.';
    const LEGACY_PREFIX = 'dsh.question-tree.v3.';

    const ZH = {
      'type.label': '问题树',
      'guide.title': '问题树',
      'guide.description': '划取对话里的一段文字，在它下面接着问',
      'chip.action': '树形提问',
      'chip.toComposer': '添加到对话',
      'actions.title': '划取动作',
      'actions.autoUnderstand': '回答后自动标记为“懂了”',
      'chip.hint': '挂在「{parent}」下；按住 Alt 变成根节点',
      'empty.title': '还没有节点',
      'empty.body': '在对话里划取一段文字，点浮出的「树形提问」，然后在节点下面提问。',
      'status.unclear': '还没懂（点一下变绿）',
      'status.clear': '懂了（点一下变红）',
      'action.ask': '在这个节点下面提问',
      'action.remove': '删除这个节点及其子节点',
      'ask.placeholder': '在这里提问，Enter 发送，Esc 取消',
      'view.list': '列表',
      'view.graph': '图',
      'view.listHint': '列表视图：一条一条往下排',
      'view.graphHint': '分支图视图：横向铺开，看清谁从谁长出来',
      'hint.graph': '这棵树已经分叉了，切到「图」能一眼看清分支',
      'hint.graphSwitch': '切到图',
      'hint.graphDismiss': '知道了',
      'ask.send': '发送',
      'ask.cancel': '取消',
      'state.waiting': '待回答',
      'state.answered': '已回答',
      'state.draft': '待发送',
      'flash.sent': '已发送',
      'flash.filled': '已填进输入框，按回车发送',
      'flash.copied': '已复制到剪贴板',
      'flash.toComposer': '已加入输入框',
      'flash.noAnchor': '这个节点没有记录来源位置',
      'flash.notLoaded': '目标消息还没加载，先点「加载更早」',
      'flash.failed': '发送失败：没有可用的输入框，已复制到剪贴板也失败了',
      'flash.noComposer': '没有输入框句柄，已复制到剪贴板',
      'root': '根',
    };

    const EN = {
      'type.label': 'Question tree',
      'guide.title': 'Question tree',
      'guide.description': 'Select a phrase, then ask under it',
      'chip.action': 'Ask in tree',
      'chip.toComposer': 'Add to composer',
      'actions.title': 'Selection actions',
      'actions.autoUnderstand': 'Mark understood once answered',
      'chip.hint': 'Under「{parent}」; hold Alt for a root node',
      'empty.title': 'No nodes yet',
      'empty.body': 'Select a phrase in the conversation, click「Ask in tree」, then ask under the node.',
      'status.unclear': 'Unclear (click to go green)',
      'status.clear': 'Understood (click to go red)',
      'action.ask': 'Ask under this node',
      'action.remove': 'Remove this node and its children',
      'ask.placeholder': 'Type your question, Enter to send, Esc to cancel',
      'view.list': 'List',
      'view.graph': 'Graph',
      'view.listHint': 'List view: one row after another',
      'view.graphHint': 'Branch graph: laid out sideways, so you see what grew from what',
      'hint.graph': 'This tree has branched — the graph view shows it at a glance',
      'hint.graphSwitch': 'Show graph',
      'hint.graphDismiss': 'Got it',
      'ask.send': 'Send',
      'ask.cancel': 'Cancel',
      'state.waiting': 'waiting',
      'state.answered': 'answered',
      'state.draft': 'not sent',
      'flash.sent': 'Sent',
      'flash.filled': 'Filled into the composer — press Enter there',
      'flash.copied': 'Copied to the clipboard',
      'flash.toComposer': 'Added to the composer',
      'flash.noAnchor': 'This node has no recorded source position',
      'flash.notLoaded': 'The target message is not loaded yet — click「load earlier」',
      'flash.failed': 'Could not send: no composer and the clipboard refused too',
      'flash.noComposer': 'No composer handle — copied instead',
      'root': 'root',
    };

    /* --------------------------------------------------------------- plumbing */

    const BUS = {
      version: 0,
      listeners: new Set(),
      bump() {
        BUS.version += 1;
        for (const listener of BUS.listeners) listener();
      },
      subscribe(listener) {
        BUS.listeners.add(listener);
        return () => {
          BUS.listeners.delete(listener);
        };
      },
      getSnapshot() {
        return BUS.version;
      },
    };

    const CURRENT = { sessionId: null, selectedId: null, openId: null, flash: '', view: 'list' };

    /**
     * Which passage a repeated double-click lands on, per node.
     *
     * Module-level on purpose: a click selects the node, which re-renders the
     * panel, so a cursor held in component state would reset before the second
     * click and the cycle would never advance.
     */
    const LOCATE_CURSOR = new Map();
    const INPUT = new Map();
    /** The hub service handed over at apply time; owns the composer paths. */
    let HUB = null;
    /** Context handed over at apply time, for panels rendered outside a slot. */
    let CTX = null;
    // A jump re-asserts its landing for a moment, so a new jump (the next
    // passage of the same node, or another node) must cancel the previous
    // loop; otherwise the two would scroll the transcript against each other.
    let LOCATE_CANCEL = null;
    /** Supersedes an older jump's paging loop; a new jump cancels the old one. */
    let LOCATE_GEN = 0;

    /**
     * ── selection hub ──────────────────────────────────────────────────────
     *
     * Selection is its own mechanism, not a part of the tree. It owns three
     * things and nothing more:
     *
     *   1. watching what is selected in the transcript
     *   2. the floating action bar, whose entries come from {@link SELECTION_ACTIONS}
     *   3. the canonical serialization of a quote, {@link formatQuote}, and the
     *      chip that renders it back in the transcript
     *
     * The tree is one action registered into it. A second action (「解释这段」
     * 「翻译这段」) needs no change here — only a `register`.
     */
    const SELECTION_ACTIONS = [];

    function registerSelectionAction(action) {
      SELECTION_ACTIONS.push(action);
      return () => {
        const index = SELECTION_ACTIONS.indexOf(action);
        if (index >= 0) SELECTION_ACTIONS.splice(index, 1);
      };
    }

    /** The wire form of a quote. One format, decided once, matched by the chip. */
    function formatQuote(text, max = 200) {
      return `「${QTModel.oneLine(QTModel.sanitizeQuote(text), max)}」`;
    }

    /** `「quote」—— question`; the question alone when it already contains the quote. */
    function formatMessage(quote, question) {
      return QTModel.composeMessage(question, quote);
    }

    function useVersion() {
      return React.useSyncExternalStore(BUS.subscribe, BUS.getSnapshot, BUS.getSnapshot);
    }

    function bindCopy(ctx, ns) {
      const fallback = (key, params) => {
        let value = ZH[key] ?? key;
        for (const [name, replacement] of Object.entries(params ?? {})) {
          value = value.split(`{${name}}`).join(String(replacement));
        }
        return value;
      };
      try {
        const bind = ctx.locale && ctx.locale.bind;
        if (typeof bind !== 'function') return fallback;
        const bound = ctx.locale.bind(ns);
        if (typeof bound !== 'function') return fallback;
        return (key, params) => {
          try {
            const value = bound(key, params);
            return typeof value === 'string' && value !== '' && value !== key
              ? value
              : fallback(key, params);
          } catch {
            return fallback(key, params);
          }
        };
      } catch {
        return fallback;
      }
    }

    let t0 = (key, params) => {
      let value = ZH[key] ?? key;
      for (const [name, replacement] of Object.entries(params ?? {})) {
        value = value.split(`{${name}}`).join(String(replacement));
      }
      return value;
    };

    /* ---------------------------------------------------------------- storage */

    /** Per-action on/off switches, the user-facing half of the selection hub. */
    const ACTION_SETTINGS_KEY = 'dsh.question-tree.actions';
    /** 「answered means understood」 — on unless the user turns it off. */
    const AUTO_UNDERSTAND_KEY = 'dsh.question-tree.autoUnderstand';
    /** Set once the graph view has actually been opened, so the dot stops. */
    const GRAPH_SEEN_KEY = 'dsh.question-tree.graphSeen';

    function readAutoUnderstand() {
      try {
        return window.localStorage.getItem(AUTO_UNDERSTAND_KEY) !== '0';
      } catch {
        return true;
      }
    }

    function readGraphSeen() {
      try {
        return window.localStorage.getItem(GRAPH_SEEN_KEY) === '1';
      } catch {
        return false;
      }
    }

    function writeGraphSeen() {
      try {
        window.localStorage.setItem(GRAPH_SEEN_KEY, '1');
      } catch {
        /* storage may be full or disabled */
      }
    }

    function writeAutoUnderstand(value) {
      try {
        window.localStorage.setItem(AUTO_UNDERSTAND_KEY, value ? '1' : '0');
      } catch {
        /* storage may be full or disabled */
      }
    }

    function readActionSettings() {
      try {
        const raw = window.localStorage.getItem(ACTION_SETTINGS_KEY);
        if (raw == null) return {};
        const parsed = JSON.parse(raw);
        return parsed != null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeActionSettings(value) {
      try {
        window.localStorage.setItem(ACTION_SETTINGS_KEY, JSON.stringify(value));
      } catch {
        /* storage may be full or disabled */
      }
    }

    /** An action is on unless the user switched it off; new actions default on. */
    function isActionEnabled(settings, id) {
      return (settings ?? {})[id] !== false;
    }

    function readNodes(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return [];
      try {
        const raw =
          window.localStorage.getItem(STORE_PREFIX + sessionId) ??
          window.localStorage.getItem(LEGACY_PREFIX + sessionId);
        if (raw == null) return [];
        return QTModel.migrateNodes(JSON.parse(raw));
      } catch {
        return [];
      }
    }

    function writeNodes(sessionId, nodes) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      try {
        window.localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify(nodes));
        return true;
      } catch {
        // Silently losing the write looks exactly like a dead click: the next
        // `BUS.bump()` re-reads storage and the node simply is not there.
        say('保存失败：本地存储已满或被禁用');
        return false;
      }
    }

    /**
     * The session the tree belongs to.
     *
     * A mounted panel reports it, but the panel is not always mounted — the
     * sidebar tab may be closed and the View tab may not have been opened yet.
     * The composer bridge always knows the on-screen session, so the tree keeps
     * working from the selection bar before any panel has ever rendered.
     */
    function sessionNow() {
      // The composer bridge follows the on-screen session, so it is the live
      // answer. `CURRENT.sessionId` is whatever panel mounted last, which can
      // lag behind after a surface unmounts — only trust it when nothing else
      // knows.
      const live = HUB != null && typeof HUB.session === 'function' ? HUB.session() : null;
      if (typeof live === 'string' && live !== '') return live;
      return CURRENT.sessionId;
    }

    function nodesNow() {
      return readNodes(sessionNow());
    }

    function commit(sessionId, nodes) {
      // Never infer this from module state: the panel knows which session it is
      // showing, and writing under another one corrupts that session's tree.
      writeNodes(sessionId, nodes);
      BUS.bump();
    }

    function say(message) {
      CURRENT.flash = message;
      BUS.bump();
      window.setTimeout(() => {
        if (CURRENT.flash === message) {
          CURRENT.flash = '';
          BUS.bump();
        }
      }, 1800);
    }

    /* ---------------------------------------------------------------- sending */

    /**
     * Session-scoped Cordis contexts, published by the panel's retain.
     *
     * The composer's reference-insertion listener lives on this scope, so the
     * chip experiment needs it. Absent → the action falls back to plain text.
     */
    const SESSION_SCOPES = new Map();

    async function copyToClipboard(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* fall through */
      }
      return false;
    }

    /**
     * Type the question into the composer and try to submit it.
     *
     * @returns 'sent' | 'filled' | 'copied'.
     */
    async function dispatch(sessionId, text) {
      // The hub knows every way into the composer (mounted bridge, the Host's
      // input resolver, clipboard). Its answer is authoritative when present;
      // the local path below is only for a split build without the hub.
      if (HUB != null && typeof HUB.dispatch === 'function') return HUB.dispatch(sessionId, text);
      const api = INPUT.get(sessionId);
      if (api == null) return (await copyToClipboard(text)) ? 'copied' : 'filled';
      const setDraft = api.setDraft ?? (api.input && api.input.setDraft) ?? api.setText;
      try {
        if (typeof setDraft === 'function') setDraft.call(api, text);
      } catch {
        /* fall through to the clipboard */
      }
      const submit = api.submit ?? api.send ?? (api.input && api.input.submit);
      if (typeof submit === 'function') {
        try {
          submit.call(api);
          return 'sent';
        } catch {
          /* composer refused; leave the draft in place */
        }
      }
      return 'filled';
    }

    /**
     * Insert the quote into the composer as plain text (insertion, never a
     * replacement), falling back to the clipboard.
     *
     * @returns 'sent' | 'copied' | 'failed' — the chip action reports the
     *   reason a chip was not used, so this must not flash a message itself.
     */
    function plainInsert(sessionId, token) {
      const api = INPUT.get(sessionId);
      const insert = api == null ? null : (api.insertText ?? (api.input && api.input.insertText));
      const capture =
        api == null ? null : (api.captureInsertion ?? (api.input && api.input.captureInsertion));
      if (typeof insert === 'function' && typeof capture === 'function') {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const outcome = insert.call(api, token, capture.call(api));
            if (outcome != null && typeof outcome.then === 'function') {
              outcome
                .then((ok) => {
                  if (ok === false) {
                    copyToClipboard(token).then((copied) =>
                      say(t0(copied ? 'flash.noComposer' : 'flash.copied')),
                    );
                  }
                })
                .catch(() => {});
              return 'sent';
            }
            if (outcome !== false) return 'sent';
          } catch {
            break;
          }
        }
      }
      return 'failed';
    }

    /**
     * Try to insert the quote as a real composer chip.
     *
     * A chip carries `source` as its serialization routing key, and a source
     * without a codec makes the draft UNSUBMITTABLE — `serializeReference`
     * rejects it. So this runs three guards and refuses on any of them.
     *
     * @returns 'ok', or a short reason code shown in the panel footer. The
     *   reason exists because the guards are unverified internals: without it
     *   a failure is indistinguishable from every other failure.
     */
    async function tryChipInsert(ctx, sessionId, token) {
      try {
        const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
        if (triggers == null) return 'no-triggers';
        const actx = SESSION_SCOPES.get(sessionId);
        if (actx == null) return 'no-scope';
        const api = INPUT.get(sessionId);
        if (api == null) return 'no-api';
        const capture = api.captureInsertion ?? (api.input && api.input.captureInsertion);
        if (typeof capture !== 'function') return 'no-capture';

        // Serialization lives on the per-session controller, not on the root
        // service: the root only registers sources and resolves controllers.
        let serialize = null;
        if (typeof triggers.serializeReference === 'function') {
          serialize = (source, ref) => triggers.serializeReference(source, ref);
        } else if (typeof triggers.sessionOf === 'function') {
          let controller;
          try {
            controller = triggers.sessionOf(actx);
          } catch (error) {
            const message = error && error.message ? String(error.message) : 'thrown';
            return `session-map:${message.slice(0, 40)}`;
          }
          if (controller == null || typeof controller.serializeReference !== 'function') {
            return 'no-serializer';
          }
          serialize = (source, ref) => controller.serializeReference(source, ref);
        } else {
          return 'no-serializer';
        }

        // Preflight: never create a chip that cannot serialize back to text.
        let serialized;
        try {
          serialized = await serialize('quote', token);
        } catch (error) {
          const message = error && error.message ? String(error.message) : 'rejected';
          return `preflight:${message.slice(0, 48)}`;
        }
        if (serialized == null || String(serialized).trim() === '') return 'preflight-empty';

        const span = capture.call(api);
        if (span == null) return 'no-span';
        const payload = {
          reference: {
            source: 'quote',
            // The label is both the visible text and the chip's tooltip, so it
            // carries the whole quote; the chip itself ellipsizes the display.
            label: token.trim(),
            ref: token,
            // A known kind gives the chip a real glyph. Unknown kinds render no
            // icon at all, and the transcript then marks the chip as unclassified.
            appearance: 'session',
            clipboardText: token,
          },
          span,
        };

        let outcome;
        if (typeof actx.bail === 'function') {
          outcome = actx.bail(actx, 'slash/input-insert-reference', payload);
        } else if (typeof actx.emit === 'function') {
          outcome = actx.emit('slash/input-insert-reference', payload);
        } else {
          return 'no-emit';
        }
        if (outcome != null && typeof outcome.then === 'function') outcome = await outcome;
        if (Array.isArray(outcome)) return outcome.some(Boolean) ? 'ok' : 'unhandled';
        return outcome === true || outcome === 1 ? 'ok' : 'unhandled';
      } catch (error) {
        const message = error && error.message ? String(error.message) : 'thrown';
        return `error:${message.slice(0, 48)}`;
      }
    }

    /* -------------------------------------------------------------- selection */

    function readSelection() {
      const selection = window.getSelection();
      if (selection == null || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (text === '' || text.length > 400) return null;
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const element = container.nodeType === 1 ? container : container.parentElement;
      if (element == null) return null;
      if (element.closest('[data-sidebar-right-session]') !== null) return null;
      if (element.closest('[contenteditable="true"]') !== null) return null;
      if (element.closest('[data-chat-flow], [data-chat-node-key], [data-chat-turn]') === null) {
        return null;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { text, rect };
    }

    function clearSelection() {
      try {
        window.getSelection().removeAllRanges();
      } catch {
        /* ignore */
      }
    }

    /* -------------------------------------------------------------- components */

    const CHIP_BUTTON = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l3, #4a5057)',
      background: 'var(--dsw-alias-bg-module-platform, #1f2429)',
      color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      boxShadow: 'var(--dsw-elevation-soft, 0 4px 14px rgba(0,0,0,.35))',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '20px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    function SelectionChip() {
      const [chip, setChip] = React.useState(null);
      const [alt, setAlt] = React.useState(false);

      // The chip must show what the click will actually do, so track Alt while
      // it is visible: holding it turns the target label into「根」.
      React.useEffect(() => {
        const down = (event) => {
          if (event.key === 'Alt') setAlt(true);
        };
        const up = (event) => {
          if (event.key === 'Alt') setAlt(false);
        };
        const blur = () => setAlt(false);
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        window.addEventListener('blur', blur);
        return () => {
          window.removeEventListener('keydown', down, true);
          window.removeEventListener('keyup', up, true);
          window.removeEventListener('blur', blur);
        };
      }, []);

      React.useEffect(() => {
        let timer = 0;
        let dragging = false;

        // Publishing the bar while the pointer is still down put it under the
        // cursor, which moved the selection, which republished the bar: a loop
        // that also dragged the selection across the message. So nothing is
        // published during a drag, and everything else is debounced.
        const publish = () => {
          timer = 0;
          if (dragging) return;
          const next = readSelection();
          setChip((previous) => {
            if (next == null) return null;
            if (
              previous !== null &&
              previous.text === next.text &&
              previous.rect.top === next.rect.top &&
              previous.rect.left === next.rect.left &&
              previous.rect.width === next.rect.width
            ) {
              return previous; // identity stable: no re-render, no selection churn
            }
            return { text: next.text, rect: next.rect };
          });
        };

        const schedule = (delay = 80) => {
          if (dragging) return;
          if (timer !== 0) window.clearTimeout(timer);
          timer = window.setTimeout(publish, delay);
        };

        const cancel = () => {
          if (timer !== 0) window.clearTimeout(timer);
          timer = 0;
        };

        const onPointerDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('[data-question-tree-chip]') !== null) {
            return; // a click on the bar itself is not a new selection
          }
          dragging = true;
          cancel();
          setChip(null);
        };

        const onPointerUp = () => {
          dragging = false;
          schedule(0);
        };

        const onSelectionChange = () => schedule();

        const onKeyUp = () => schedule(0);

        const onScroll = () => schedule(0);

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);

        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('pointerup', onPointerUp, true);
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('keyup', onKeyUp, true);
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onScroll);
          cancel();
        };
      }, []);

      if (chip == null) return null;
      if (sessionNow() == null) return null;

      const actionSettings = readActionSettings();
      const actions = SELECTION_ACTIONS.filter((item) => isActionEnabled(actionSettings, item.id)).sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      );
      if (actions.length === 0) return null;

      // Left-aligned with the selection start, not centered on it: a centered
      // bar lands under the cursor at drag end.
      const top = Math.max(8, chip.rect.top - 40);
      const left = Math.min(Math.max(8, chip.rect.left), Math.max(8, window.innerWidth - 150));

      const run = (action, event) => {
        action.run({ text: chip.text, altKey: event.altKey || alt });
        clearSelection();
        setChip(null);
      };

      return h(
        'div',
        {
          'data-question-tree-chip': true,
          style: {
            position: 'fixed',
            top,
            left,
            zIndex: 2147483000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 4,
          },
        },
        ...actions.map((action) => {
          const hint = typeof action.hint === 'function' ? action.hint({ text: chip.text, altKey: alt }) : '';
          return h(
            'button',
            {
              key: action.id,
              type: 'button',
              style: CHIP_BUTTON,
              title: hint === '' ? action.label() : hint,
              onMouseDown: (event) => event.preventDefault(),
              onClick: (event) => run(action, event),
            },
            h('span', { 'aria-hidden': true }, action.icon ?? '⑂'),
            h('span', null, action.label()),
            hint === ''
              ? null
              : h(
                  'span',
                  { style: { color: 'var(--dsw-alias-label-tertiary, #8a8f98)', fontSize: 11 } },
                  hint,
                ),
          );
        }),
      );
    }

    function ComposerBridge(props) {
      const info = props.questionTree ?? {};
      const api = props.inputActions ?? props.keyboard ?? null;
      React.useEffect(() => {
        const sessionId = info.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '' || api == null) return undefined;
        INPUT.set(sessionId, api);
        return () => {
          if (INPUT.get(sessionId) === api) INPUT.delete(sessionId);
        };
      }, [info.sessionId, api]);
      return null;
    }

    /**
     * A row action. Sized for a pointer, not for a text line: a 12px glyph with
     * 3px padding is a ~14px hit target, which is below what a mouse expects.
     */
    const rowAction = {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 14,
      lineHeight: '16px',
      width: 24,
      height: 24,
      minWidth: 24,
      padding: 0,
      borderRadius: 6,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    };

    const smallButton = rowAction;

    /** Row action with its own hover feedback (inline styles cannot do :hover). */
    function IconButton({ title, onClick, children, size }) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...rowAction,
            ...(size === undefined ? {} : { width: size, height: size, minWidth: size }),
            background: hover ? 'var(--dsw-alias-interactive-bg-hover, #333a41)' : 'transparent',
            color: hover
              ? 'var(--dsw-alias-label-primary, #e6e6e6)'
              : 'var(--dsw-alias-label-tertiary, #8a8f98)',
          },
        },
        children,
      );
    }

    /**
     * The inline ask box that opens under one node.
     *
     * The quote line above it is the referent. It is on by default because a
     * question like「这是什么」is unanswerable without it; one click turns it off
     * for questions that already name their subject.
     */
    function AskInput({ t, depth, quote, onSubmit, onCancel }) {
      const [value, setValue] = React.useState('');
      const ref = React.useRef(null);

      React.useEffect(() => {
        const element = ref.current;
        if (element != null && typeof element.focus === 'function') element.focus();
      }, []);

      const submit = () => {
        const text = value.trim();
        if (text === '') return;
        onSubmit(text, QTModel.composeMessage(text, quote));
      };

      const prefix = h('span', { style: { width: depth * 14 + 4, flexShrink: 0 } });

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 6px 4px 0' } },
        h(
          'div',
          { style: { display: 'flex', gap: 4 } },
          prefix,
          h('input', {
            ref,
            value,
            type: 'text',
            placeholder: t('ask.placeholder'),
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
              }
            },
            style: {
              flex: 1,
              minWidth: 0,
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
              background: 'var(--dsw-alias-bg-module-platform, #15181b)',
              color: 'var(--dsw-alias-label-primary, #e6e6e6)',
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              outline: 'none',
            },
          }),
          h('button', { type: 'button', style: smallButton, onClick: submit }, '↵'),
          h('button', { type: 'button', style: smallButton, onClick: onCancel }, '×'),
        ),
      );
    }

    /** One question, drawn as an attached box under its quote — never as a node. */
    function QuestionBox({ t, question, depth, onRemove }) {
      const state =
        question.answeredAt != null
          ? t('state.answered')
          : question.sentAt != null
            ? t('state.waiting')
            : t('state.draft');
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginLeft: 12 + depth * 14 + 14,
            marginBottom: 3,
            padding: '2px 7px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
            background: 'var(--dsw-alias-bg-module-platform, #1b1f23)',
            fontSize: 11,
            lineHeight: '17px',
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #8a8f98)', flexShrink: 0 } }, '?'),
        h(
          'span',
          {
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: question.text,
          },
          question.text,
        ),
        h('span', { style: { flexShrink: 0, fontSize: 9, opacity: 0.7 } }, state),
        h('button', { type: 'button', style: smallButton, onClick: () => onRemove(question.id) }, '×'),
      );
    }

    /**
     * Hover detail we control.
     *
     * The native `title` tooltip waits about a second before appearing and
     * cannot be configured, which is why reading a node's full text felt slow.
     * This draws the same text after a short delay, positioned under the row.
     */
    function Tip(props) {
      const [at, setAt] = React.useState(null);
      const timer = React.useRef(0);
      const cancel = () => {
        if (timer.current !== 0) {
          window.clearTimeout(timer.current);
          timer.current = 0;
        }
      };
      const enter = (event) => {
        const element = event.currentTarget;
        cancel();
        timer.current = window.setTimeout(() => {
          timer.current = 0;
          const rect = element.getBoundingClientRect();
          setAt({ x: rect.left, y: rect.bottom });
        }, 140);
      };
      const leave = () => {
        cancel();
        setAt(null);
      };
      const text = props.text ?? '';
      React.useEffect(() => cancel, []);
      return h(
        'span',
        {
          className: props.className,
          style: props.style,
          onMouseEnter: enter,
          onMouseLeave: leave,
          onDoubleClick: props.onDoubleClick,
          onClick: props.onClick,
        },
        props.children,
        at == null || text === ''
          ? null
          : h(
              'div',
              {
                'data-question-tree-tip': true,
                style: {
                  position: 'fixed',
                  left: Math.max(8, Math.min(at.x, window.innerWidth - 388)),
                  top: Math.min(at.y + 6, window.innerHeight - 80),
                  maxWidth: 380,
                  maxHeight: 260,
                  overflow: 'hidden',
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l3, #4a5057)',
                  // Stack the theme tint over a solid base: the token may be
                  // translucent, and the question below would read through it.
                  background:
                    'linear-gradient(var(--dsw-alias-bg-l3, #232a31), var(--dsw-alias-bg-l3, #232a31)), #232a31',
                  color: 'var(--dsw-alias-label-primary, #e6e6e6)',
                  boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
                  fontSize: 11,
                  lineHeight: '17px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  pointerEvents: 'none',
                  zIndex: 2147482600,
                },
              },
              text,
            ),
      );
    }

    function Row({ row, t, selected, onSelect, onLocate, onToggle, onAsk, onRemove }) {
      const [hover, setHover] = React.useState(false);
      const node = row.node;
      // Questions are annotations on a quote now, never nodes of their own.
      const question = false;
      const unclear = node.status !== 2;
      const badge = '';

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '3px 8px 3px 0',
            margin: '1px 0',
            borderRadius: 7,
            cursor: 'default',
            background: selected
              ? 'var(--dsw-alias-interactive-bg-hover, #2a2f35)'
              : hover
                ? 'color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, #2a2f35) 55%, transparent)'
                : 'transparent',
            boxShadow: selected
              ? 'inset 3px 0 0 var(--dsw-alias-state-business-primary, #3b6fd4)'
              : 'none',
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          // Click selects (it sets the parent cursor for the next selection);
          // double-click jumps to the source. Keeping them apart matters because
          // selecting a node is a frequent, non-navigating action.
          // A double-click arrives as click, click, dblclick: toggling on both
          // clicks left the double-clicked node NOT selected, so the next
          // selection nested under whatever was current before.
          onClick: (event) => {
            if (event != null && event.detail > 1) return;
            onSelect(node.id);
          },
          onDoubleClick: () => onLocate(node.id),
        },
        ...Array.from({ length: row.depth }, (_, level) =>
          h('span', {
            key: `guide-${level}`,
            style: {
              width: 14,
              flexShrink: 0,
              alignSelf: 'stretch',
              borderLeft: '1px solid var(--dsw-alias-border-l2, #2f343a)',
            },
          }),
        ),
        question
          ? h(
              'span',
              {
                style: {
                  width: 14,
                  height: 14,
                  minWidth: 14,
                  borderRadius: '50%',
                  border: '1px solid var(--dsw-alias-border-l3, #4a5057)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 9,
                  lineHeight: 1,
                  color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
                  flexShrink: 0,
                },
                title: badge,
              },
              '?',
            )
          : h('button', {
              type: 'button',
              title: t(unclear ? 'status.unclear' : 'status.clear'),
              'aria-label': t(unclear ? 'status.unclear' : 'status.clear'),
              onClick: (event) => {
                event.stopPropagation();
                onToggle(node.id);
              },
              style: {
                width: 9,
                height: 9,
                minWidth: 9,
                margin: '0 2px',
                padding: 0,
                borderRadius: '50%',
                cursor: 'pointer',
                flexShrink: 0,
                border: 'none',
                background: unclear
                  ? 'var(--dsw-alias-state-warning-primary, #c0392b)'
                  : 'var(--dsw-alias-state-success-primary, #2f9e5f)',
              },
            }),
        h(
          Tip,
          {
            style: {
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: '20px',
            },
            // Each passage keeps its own 「」 — the joined string would read as
            // one continuous excerpt.
            text: question
              ? QTModel.labelOf(node)
              : (Array.isArray(node.quotes) && node.quotes.length > 0 ? node.quotes : [node.quote])
                  .map((item) => `「${item}」`)
                  .join('\n'),
          },
          // The "already understood" dimming lives on an inner span: opacity on
          // the Tip wrapper would also fade the tooltip it renders, letting the
          // question underneath show through the card.
          h(
            'span',
            {
              style: {
                opacity: question || unclear ? 1 : 0.65,
                textDecoration: question ? 'none' : unclear ? 'none' : 'line-through',
              },
            },
            question ? QTModel.oneLine(node.text, 80) : displayQuote(node, 56),
          ),
        ),
        badge === ''
          ? null
          : h(
              'span',
              {
                style: {
                  flexShrink: 0,
                  fontSize: 10,
                  lineHeight: '18px',
                  padding: '0 5px',
                  borderRadius: 999,
                  color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
                  border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
                },
              },
              badge,
            ),
        h(
          'span',
          {
            style: {
              display: 'flex',
              gap: 4,
              flexShrink: 0,
              // Reserved even when hidden, so showing the actions cannot make
              // the row jump by a few pixels under the cursor.
              opacity: hover || selected ? 1 : 0,
              pointerEvents: hover || selected ? 'auto' : 'none',
            },
          },
          h(
            IconButton,
            {
              title: t('action.ask'),
              onClick: (event) => {
                event.stopPropagation();
                onAsk(node.id);
              },
            },
            '＋',
          ),
          h(
            IconButton,
            {
              title: t('action.remove'),
              onClick: (event) => {
                event.stopPropagation();
                onRemove(node.id);
              },
            },
            '×',
          ),
        ),
      );
    }

    /**
     * Horizontal-branch graph view.
     *
     * Deliberately CSS rather than SVG: text ellipsis, theme fonts, and scroll
     * all come for free, and there is no measuring to get wrong.
     */
    const GRAPH_CSS = `
.qt-g-forest{display:flex;flex-direction:column;gap:14px;padding:4px 6px 24px;width:max-content;min-width:100%}
.qt-g-branch{display:flex;align-items:center;flex:0 0 auto}
.qt-g-kids{display:flex;flex-direction:column;gap:8px;position:relative;padding-left:22px;margin-left:12px;flex:0 0 auto}
.qt-g-kids::before{content:'';position:absolute;left:0;top:14px;bottom:14px;border-left:1px solid var(--dsw-alias-border-l2,#2f343a)}
.qt-g-kid{position:relative;display:flex;align-items:center;flex:0 0 auto}
.qt-g-kid::before{content:'';position:absolute;left:-22px;top:50%;width:18px;border-top:1px solid var(--dsw-alias-border-l2,#2f343a)}
.qt-g-node{display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:168px;flex:0 0 168px;box-sizing:border-box;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#3a3f45);background:var(--dsw-alias-bg-module-platform,#1b1f23);cursor:default}
.qt-g-node:hover{background:color-mix(in srgb, var(--dsw-alias-interactive-bg-hover,#2a2f35) 55%, transparent)}
.qt-g-node[data-selected]{border-color:var(--dsw-alias-state-business-primary,#3b6fd4);background:var(--dsw-alias-interactive-bg-hover,#2a2f35);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#3b6fd4)}
.qt-g-ask{flex:0 0 100%;display:flex;align-items:center;gap:4px;margin-top:2px;padding-top:3px;border-top:1px solid var(--dsw-alias-border-l2,#2f343a);font-size:10px;line-height:14px}
.qt-g-ask-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
.qt-g-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
.qt-g-dot{width:8px;height:8px;min-width:8px;padding:0;border:none;border-radius:50%;cursor:pointer}
.qt-g-mark{font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary,#8a8f98);flex:0 0 auto}
.qt-g-badge{font-size:9px;line-height:1;opacity:.7;flex:0 0 auto}
.qt-g-quote{opacity:.85}
`;

    function graphBadge(t, node) {
      if (node.kind !== 'question') return '';
      if (node.answeredAt != null) return t('state.answered');
      if (node.sentAt != null) return t('state.waiting');
      return t('state.draft');
    }

    function GraphBranch({ node, childrenOf, t, selectedId, onSelect, onLocate, onToggle }) {
      const kids = childrenOf(node.id);
      const label = QTModel.labelOf(node);
      const question = false;
      const unclear = node.status !== 2;
      const badge = '';

      const card = h(
        'div',
        {
          className: 'qt-g-node',
          'data-selected': selectedId === node.id ? '1' : undefined,
          title: (Array.isArray(node.quotes) && node.quotes.length > 0 ? node.quotes : [label])
            .map((item) => `「${item}」`)
            .join(''),
          onClick: (event) => {
            if (event != null && event.detail > 1) return;
            onSelect(node.id);
          },
          onDoubleClick: () => onLocate(node.id),
        },
        question
          ? h('span', { className: 'qt-g-mark' }, '?')
          : h('button', {
              type: 'button',
              className: 'qt-g-dot',
              title: t(unclear ? 'status.unclear' : 'status.clear'),
              onClick: (event) => {
                event.stopPropagation();
                onToggle(node.id);
              },
              style: {
                background: unclear
                  ? 'var(--dsw-alias-state-warning-primary, #c0392b)'
                  : 'var(--dsw-alias-state-success-primary, #2f9e5f)',
              },
            }),
        h(
          'span',
          { className: 'qt-g-label qt-g-quote' },
          displayQuote(node, 22),
        ),
        ...(node.questions ?? []).map((item) =>
          h(
            'div',
            { className: 'qt-g-ask', key: item.id, title: item.text },
            h('span', { className: 'qt-g-mark' }, '?'),
            h('span', { className: 'qt-g-ask-label' }, QTModel.oneLine(item.text, 18)),
            h(
              'span',
              { className: 'qt-g-badge' },
              item.answeredAt != null
                ? t('state.answered')
                : item.sentAt != null
                  ? t('state.waiting')
                  : t('state.draft'),
            ),
          ),
        ),
      );

      if (kids.length === 0) return h('div', { className: 'qt-g-branch' }, card);

      return h(
        'div',
        { className: 'qt-g-branch' },
        card,
        h(
          'div',
          { className: 'qt-g-kids' },
          ...kids.map((kid) =>
            h(
              'div',
              { className: 'qt-g-kid', key: kid.id },
              h(GraphBranch, { node: kid, childrenOf, t, selectedId, onSelect, onLocate, onToggle }),
            ),
          ),
        ),
      );
    }

    function GraphView({ nodes, t, selectedId, onSelect, onLocate, onToggle }) {
      const byParent = new Map();
      const known = new Set(nodes.map((node) => node.id));
      for (const node of nodes) {
        const parentId = node.parentId != null && known.has(node.parentId) ? node.parentId : null;
        const bucket = byParent.get(parentId);
        if (bucket === undefined) byParent.set(parentId, [node]);
        else bucket.push(node);
      }
      const childrenOf = (id) =>
        (byParent.get(id) ?? []).slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      const roots = childrenOf(null);

      return h(
        'div',
        null,
        h('style', { dangerouslySetInnerHTML: { __html: GRAPH_CSS } }),
        h(
          'div',
          { className: 'qt-g-forest' },
          ...roots.map((root) =>
            h(GraphBranch, {
              key: root.id,
              node: root,
              childrenOf,
              t,
              selectedId,
              onSelect,
              onLocate,
              onToggle,
            }),
          ),
        ),
      );
    }

    /**
     * Render a sent quote as a chip.
     *
     * Matches `「…」——`, i.e. exactly the shape {@link formatMessage} produces,
     * so text the user typed by hand is left alone. `raw` always renders when
     * anything is missing: a chip that fails must never eat the text.
     */
    function QuoteChip(props) {
      const raw = typeof props.raw === 'string' ? props.raw : '';
      const node = props.node;
      const quote =
        node != null && node.data != null && typeof node.data.quote === 'string' ? node.data.quote : '';
      if (quote === '') return h('span', null, raw);
      return h(
        'span',
        {
          title: quote,
          style: {
            display: 'inline',
            padding: '0 4px',
            borderRadius: 4,
            borderBottom: '1px dashed var(--dsw-alias-border-l4, #6b7178)',
            background: 'var(--dsw-alias-interactive-bg-hover, #262b31)',
            whiteSpace: 'nowrap',
            // NOT 'help': Windows draws that as an arrow with a question mark,
            // which reads as a broken-glyph badge rather than a cursor.
            cursor: 'default',
          },
        },
        `「${QTModel.oneLine(quote, 24)}」`,
      );
    }

    /**
     * The matcher for {@link QuoteChip}.
     *
     * Two paths produce a quote — the tree (`「q」—— question`) and the composer
     * action (`「q」 question`) — so the anchor is「starts the message」, not the
     * separator. Anchoring at offset 0 is what keeps hand-typed 「」 in the
     * middle of a sentence out of it.
     */
    const quoteChipRule = {
      id: 'quote',
      order: 10,
      match(text, from) {
        if (typeof text !== 'string' || from > 0) return undefined;
        if (!text.startsWith('「')) return undefined;
        // A node may quote several passages; the message carries them as one run
        // of adjacent 「…」 units, and the chip covers the whole run so the row
        // does not read as "chip, then loose text".
        let end = 0;
        while (text[end] === '「') {
          const close = pairEnd(text, end);
          if (close < 0) break;
          end = close + 1;
          while (text[end] === ' ' || text[end] === '\t') end += 1;
        }
        if (end <= 1) return undefined;
        const quote = text.slice(0, end).trim();
        if (quote.length > 600) return undefined;
        return { id: 'quote', start: 0, end, data: { quote } };
      },
    };

    /** Index of the bracket closing the one at `start`, honouring nesting. */
    function pairEnd(text, start) {
      let depth = 0;
      for (let index = start; index < text.length; index += 1) {
        if (text[index] === '「') depth += 1;
        else if (text[index] === '」') {
          depth -= 1;
          if (depth === 0) return index;
        }
      }
      return -1;
    }

    /** Whether an element currently scrolls vertically. */
    function scrollsVertically(element) {
      if (element == null) return false;
      const style = window.getComputedStyle(element);
      return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    }

    /**
     * The conversation viewport a jump has to move.
     *
     * Newer hosts wrap the transcript in `[data-conversation-scroll]`, and an
     * open process group nests its own capped, scrollable body inside it.
     * Walking up from the quoted text stops at that inner body and scrolls the
     * wrong box — the conversation itself never moves, so the jump looks dead
     * until the reader scrolls it by hand. Prefer the marked conversation
     * scrollport; older hosts scroll the chat root itself, so fall back to the
     * first ancestor that really contains turn rows.
     */
    function conversationScroller(element) {
      const marked = element.closest('[data-conversation-scroll]');
      // The marker is authoritative even when the transcript is currently
      // shorter than its frame: there is simply nothing to move in that case.
      if (marked != null) return marked;
      const candidates = [];
      for (let node = element.parentElement; node != null; node = node.parentElement) {
        if (scrollsVertically(node)) candidates.push(node);
      }
      const containing = candidates.filter((node) => node.querySelector('[data-chat-turn]') !== null);
      // Outermost, not innermost: a nested group body also contains turn rows,
      // but moving it alone is exactly the dead jump this function prevents.
      return containing[containing.length - 1] ?? candidates[candidates.length - 1] ?? null;
    }

    /** Scrollports between `element` and `stop`, innermost first. */
    function innerScrollers(element, stop) {
      const scrollers = [];
      for (let node = element.parentElement; node != null && node !== stop; node = node.parentElement) {
        if (scrollsVertically(node)) scrollers.push(node);
      }
      return scrollers;
    }

    /**
     * The smallest laid-out element that contains the quoted words.
     *
     * A message can keep a second, hidden copy of its text (a collapsed
     * reasoning body, a source block). Picking the smallest match outright can
     * land on that copy, which has no box and therefore cannot be scrolled to.
     * Prefer the smallest match that actually has a box; fall back to the
     * smallest hidden one so a later `beforematch` reveal can still use it.
     */
    function findFocus(target, needle) {
      if (needle === '') return target;
      let bestVisible = null;
      let bestVisibleLength = Number.POSITIVE_INFINITY;
      let bestHidden = null;
      let bestHiddenLength = Number.POSITIVE_INFINITY;
      for (const element of target.querySelectorAll('*')) {
        const text = String(element.textContent ?? '').replace(/\s+/g, '');
        if (!text.includes(needle)) continue;
        const length = text.length;
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (visible) {
          if (length < bestVisibleLength) {
            bestVisible = element;
            bestVisibleLength = length;
          }
        } else if (length < bestHiddenLength) {
          bestHidden = element;
          bestHiddenLength = length;
        }
      }
      return bestVisible ?? bestHidden ?? target;
    }

    /** Fold curly quotes so a rendered heading and the selected text compare equal. */
    function foldQuoteChar(character) {
      if (character === '“' || character === '”') return '"';
      if (character === '‘' || character === '’') return "'";
      return character;
    }

    /**
     * A Range over the quoted words themselves.
     *
     * The element heuristic above finds the smallest box that contains a
     * quote, but two quotes in the same long message often share one Markdown
     * container. Without a range, both land on the container's first line and
     * the later one looks like it did not move. Walking text nodes lets the
     * same jump land on the exact line, and also tolerates quotes split across
     * inline formatting.
     */
    function findTextRange(target, needle) {
      if (needle === '' || typeof document.createTreeWalker !== 'function') return null;
      try {
        const text = [];
        const map = [];
        const walker = document.createTreeWalker(target, 4 /* NodeFilter.SHOW_TEXT */);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const value = node.nodeValue ?? '';
          for (let offset = 0; offset < value.length; offset += 1) {
            const character = value[offset];
            if (/\s/.test(character)) continue;
            text.push(foldQuoteChar(character));
            map.push({ node, offset });
          }
        }
        let wanted = '';
        for (let offset = 0; offset < needle.length; offset += 1) {
          const character = needle[offset];
          if (/\s/.test(character)) continue;
          wanted += foldQuoteChar(character);
        }
        const whole = text.join('');
        const makeRange = (at) => {
          const start = map[at];
          const end = map[at + wanted.length - 1];
          if (start == null || end == null) return null;
          const range = document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset + 1);
          return range;
        };
        let first = null;
        for (let at = whole.indexOf(wanted); at >= 0; at = whole.indexOf(wanted, at + 1)) {
          const range = makeRange(at);
          if (range == null) continue;
          first ??= range;
          // A message can keep a hidden copy ahead of the visible reply; the
          // hidden range has no box, so prefer the first occurrence that does.
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return range;
        }
        return first;
      } catch {
        // Range measurement is an enhancement; an engine that refuses it still
        // gets the element-level jump.
        return null;
      }
    }

    /** The box to align: the quoted range when it has a real box. */
    function measureOf(range, focus) {
      if (range != null) {
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return range;
      }
      return focus;
    }

    /** Scroll every box that clips `focus`, then the conversation itself. */
    function revealFocus(scroller, focus, range, gap) {
      const measure = measureOf(range, focus);
      for (const box of innerScrollers(focus, scroller)) alignInScroller(box, measure, gap);
      alignInScroller(scroller, measure, gap);
    }

    /** Put the measured box `gap` pixels below the top edge of `scroller`. */
    function alignInScroller(scroller, measure, gap) {
      if (scroller == null || measure == null) return 0;
      const connected = measure.startContainer ? measure.startContainer.isConnected : measure.isConnected;
      if (connected === false) return 0;
      const rect = measure.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return 0;
      const frame = scroller.getBoundingClientRect();
      const delta = rect.top - frame.top - gap;
      if (delta !== 0) scroller.scrollTop += delta;
      return delta;
    }

    /**
     * Break the transcript's tail-follow before a programmatic scroll.
     *
     * The chat re-pins itself to the tail while it believes the user is not
     * driving. Older hosts flip that intent on a wheel gesture; newer ones stop
     * a running follow animation on it and then decide from the next sampled
     * reader position. A synthetic wheel is both gestures as far as their
     * listeners are concerned. The one-pixel nudge gives even an old listener
     * the scroll event it may be waiting for; the jump overwrites it at once.
     */
    function releaseTail(scroller) {
      if (scroller == null) return;
      try {
        scroller.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -120,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
      } catch {
        /* older engines: the nudge below still runs */
      }
      scroller.scrollTop -= 1;
    }

    /**
     * Make a host that samples reader movement acknowledge the new position
     * now. Its reader timer is half a second long, and a resize or content
     * commit in that window re-pins the tail before the jump is accepted; a
     * synthetic scroll followed by scrollend flushes the same sample at once.
     */
    function forceReaderSample(scroller) {
      if (scroller == null) return;
      try {
        scroller.dispatchEvent(new Event('scroll'));
        scroller.dispatchEvent(new Event('scrollend', { bubbles: true }));
      } catch {
        /* hosts without scrollend still sample on their own timer */
      }
    }

    /** The「load earlier」control, when the transcript is showing one. */
    function findLoadEarlier() {
      // Copy differs by locale and by build, so match the visible text of every
      // shipped translation rather than one exact string.
      const LABELS = ['加载更早', '载入更早', '更早的消息'];
      for (const button of document.querySelectorAll('button')) {
        if (button.disabled) continue;
        const text = String(button.textContent ?? '').replace(/\s+/g, '');
        if (LABELS.some((label) => text === label)) return button;
        if (/^(load|loading)(more|older|earlier)$/i.test(text)) return button;
        if (/^(以前を読み込む|cargarantes|cargaranteriores)$/i.test(text)) return button;
      }
      return null;
    }

    /** CSS-escape a value for an attribute selector. */
    function cssEscape(value) {
      return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(value)
        : String(value).replace(/["\\]/g, '\\$&');
    }

    /**
     * The rendered row a stored anchor names.
     *
     * A step can be mounted twice — its reasoning and its response are separate
     * wrappers with the same `data-chat-node-key`. Returning the first match
     * therefore sends a quote selected from the response to the reasoning copy,
     * where the text is either absent or on another line. Pick the row that
     * actually contains the quote, preferring a visible response wrapper.
     */
    function findAnchorTarget(anchor, needle) {
      if (anchor == null) return null;
      if (anchor.anchorKey != null) {
        const exact = document.querySelector(
          `[data-chat-anchor-key="${cssEscape(anchor.anchorKey)}"]`,
        );
        if (exact != null) return exact;
      }
      const selectors = [];
      if (anchor.nodeKey != null) {
        selectors.push(`[data-chat-node-key="${cssEscape(anchor.nodeKey)}"]`);
      }
      if (anchor.turn != null) {
        selectors.push(`[data-chat-turn="${cssEscape(String(anchor.turn))}"]`);
      }
      let best = null;
      let bestRank = -1;
      for (const selector of selectors) {
        for (const row of document.querySelectorAll(selector)) {
          const text = String(row.textContent ?? '').replace(/\s+/g, '');
          if (needle !== '' && !text.includes(needle)) continue;
          const rect = row.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          const part = row.getAttribute('data-chat-group-part');
          // The response wrapper is the canonical text; reasoning is a process
          // copy that is often hidden or scrolled elsewhere. Prefer response
          // first, then no group part, then reasoning; visibility breaks ties.
          const rank = (part === 'response' ? 20 : part == null ? 10 : 0) + (visible ? 5 : 0);
          if (rank > bestRank) {
            best = row;
            bestRank = rank;
          }
        }
      }
      if (best != null) return best;
      // Nothing contains the quote (empty selection or a re-rendered row):
      // keep the old first-match behavior, but still prefer the response copy.
      for (const selector of selectors) {
        for (const row of document.querySelectorAll(selector)) {
          if (row.getAttribute('data-chat-group-part') === 'response') return row;
          best ??= row;
        }
        if (best != null) return best;
      }
      return null;
    }

    /**
     * Scroll the conversation to the row a node was quoted from.
     *
     * Two steps, because one is not enough: the anchor identifies a rendered
     * row, and that row can be a whole turn (much taller than the viewport).
     * Centering such an element pushes the words themselves off-screen, which
     * reads as "jumped too far". So the row is narrowed to the smallest element
     * that actually contains the quoted text, and only that is centered.
     *
     * The anchor is UI-derived, so a miss is normal: nodes created before this
     * existed carry none, and a re-rendered transcript may have dropped the row.
     */
    function locateAnchor(anchor, quote) {
      if (anchor == null) return false;
      // A new jump supersedes the previous landing loop, including the next
      // passage of the same node when the reader double-clicks again quickly.
      if (typeof LOCATE_CANCEL === 'function') LOCATE_CANCEL();
      const needle = String(quote ?? '').replace(/\s+/g, '');
      let target = findAnchorTarget(anchor, needle);
      // Not in the DOM: either the row is inside an unloaded older page, or the
      // list is mid-render. The caller retries, then tells the user which it is.
      if (target == null) return 'missing';

      let focus = findFocus(target, needle);
      let range = findTextRange(target, needle);

      // A completed turn folds its process rows with `hidden="until-found"`.
      // The host reveals such a subtree when the browser's find-in-page says
      // `beforematch`; the same signal opens it for this jump. Without it the
      // row has no box to align and the jump silently lands nowhere. Nested
      // folds need one signal per layer.
      let folded = focus.closest('[hidden]');
      while (folded != null) {
        try {
          folded.dispatchEvent(new Event('beforematch', { bubbles: true }));
        } catch {
          /* older engines: the row simply stays folded */
        }
        const parent = folded.parentElement;
        folded = parent == null ? null : parent.closest('[hidden]');
      }

      try {
        // Align the quoted line to the top of the transcript with a small gap.
        // The conversation viewport is scrolled last; any inner scrollport
        // between the line and the transcript (an open process-group body, a
        // capped code block) is scrolled first so both land in one gesture.
        const TOP_GAP = 8;
        const scroller = conversationScroller(target);
        // No scrollport at all: the transcript fits its frame, so the row is
        // already where a jump would put it.
        if (scroller == null) return 'ok';

        releaseTail(scroller);
        const before = scroller.scrollTop;
        revealFocus(scroller, focus, range, TOP_GAP);
        // Only force a sample when the viewport actually moved: a synthetic
        // scroll on an unchanged scrollport would look like reader movement and
        // could make the host drop or restore the tail against our intention.
        const moved = Math.abs(scroller.scrollTop - before) > 0.5;
        if (moved) forceReaderSample(scroller);

        // History loading, folding, and font settling can all move the target
        // after the first write. Re-assert the landing for a short while, but
        // stop the moment the reader touches the transcript: a jump must never
        // fight the hand that takes over.
        let cancelled = false;
        const stop = () => {
          if (cancelled) return;
          cancelled = true;
          if (LOCATE_CANCEL === stop) LOCATE_CANCEL = null;
          try {
            scroller.removeEventListener('wheel', stop, true);
            scroller.removeEventListener('pointerdown', stop, true);
          } catch {
            /* ignore */
          }
        };
        LOCATE_CANCEL = stop;
        try {
          scroller.addEventListener('wheel', stop, true);
          scroller.addEventListener('pointerdown', stop, true);
        } catch {
          /* ignore */
        }
        const settle = (remaining) => {
          if (cancelled) return;
          // React may replace the folded row when `beforematch` opens it; follow
          // the anchor rather than a reference that just went stale.
          const current = findAnchorTarget(anchor, needle);
          if (current == null || !scroller.isConnected) {
            stop();
            return;
          }
          target = current;
          focus = findFocus(target, needle);
          range = findTextRange(target, needle);
          revealFocus(scroller, focus, range, TOP_GAP);
          if (remaining <= 0) {
            stop();
            return;
          }
          // A host still owning the tail needs another sample after its own
          // re-pin; the later passes are spaced past its reader timer.
          window.setTimeout(() => {
            if (cancelled) return;
            // Only a host that still advertises tail ownership needs the
            // nudge: asking an already-released host to sample again could
            // make it restore the tail the first sample had just dropped.
            if (
              remaining === 3 &&
              scroller.querySelector('[data-chat-following-tail]') !== null
            ) {
              forceReaderSample(scroller);
            }
            settle(remaining - 1);
          }, remaining > 3 ? 120 : 260);
        };
        window.setTimeout(() => settle(6), 140);
        return 'ok';
      } catch {
        return 'missing';
      }
    }

    /**
     * One line describing a node's passages.
     *
     * Several passages stay separate units in the row too — joined text would
     * read as a single excerpt, which is exactly what they are not.
     */
    function displayQuote(node, max) {
      const passages = Array.isArray(node.quotes) && node.quotes.length > 0 ? node.quotes : [node.quote];
      if (passages.length === 1) return `「${QTModel.oneLine(passages[0], max)}」`;
      if (passages.length === 2) {
        return passages.map((item) => `「${QTModel.oneLine(item, 14)}」`).join('');
      }
      const head = passages
        .slice(0, 2)
        .map((item) => `「${QTModel.oneLine(item, 14)}」`)
        .join('');
      return `${head} +${passages.length - 2}`;
    }

    // Chromium ignores most inline scrollbar styling, and an overlay scrollbar
    // on a dark panel reads as "there is nothing below" — which is exactly the
    // bug this fixes. A thin, always-visible bar makes the list obviously
    // scrollable.
    const SCROLL_CSS = `
.qt-scroll{scrollbar-gutter:stable}
.qt-scroll::-webkit-scrollbar{width:10px;height:10px}
.qt-scroll::-webkit-scrollbar-track{background:transparent}
.qt-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.28);border-radius:6px;border:2px solid transparent;background-clip:content-box}
.qt-scroll::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.5);background-clip:content-box}
.qt-scroll::-webkit-scrollbar-corner{background:transparent}
`;

    function TreePanel(props) {
      const info = props.questionTree ?? {};
      const t = info.t ?? t0;
      const sessionId = info.sessionId;
      const ctx = info.ctx;
      useVersion();
      const scrollRef = React.useRef(null);
      const panelAlive = React.useRef(true);

      // Wheel has to be bound natively: React's delegated listener is passive,
      // so a handler there cannot stop the page behind the popup from scrolling.
      // The graph additionally turns the wheel sideways, because its depth grows
      // to the right and a vertical wheel would never reach the deeper nodes.
      React.useEffect(() => {
        panelAlive.current = true;
        return () => {
          panelAlive.current = false;
          LOCATE_GEN += 1;
        };
      }, []);

      React.useEffect(() => {
        const element = scrollRef.current;
        if (element == null) return undefined;
        const onWheel = (event) => {
          // Only the graph can be wider than the panel: the list clips its rows
          // with `overflow-x: hidden`, where `scrollWidth > clientWidth` is
          // still true but there is nothing to scroll sideways. Mapping the
          // wheel there made the list move horizontally and never vertically.
          const horizontal =
            CURRENT.view === 'graph' && element.scrollWidth > element.clientWidth + 1;
          if (horizontal) {
            const step = event.deltaX !== 0 ? event.deltaX : event.deltaY;
            const before = element.scrollLeft;
            element.scrollLeft += step;
            const moved = element.scrollLeft !== before;
            // Only swallow the wheel when it actually scrolled something:
            // at either end the event must fall through, or the panel stops
            // scrolling in every direction.
            if (moved && !event.shiftKey) {
              event.preventDefault();
              return;
            }
          }
          const before = element.scrollTop;
          element.scrollTop += event.deltaY;
          if (element.scrollTop !== before) event.preventDefault();
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
      });

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        // Another surface may already be showing this same session; clearing
        // here would throw away its selected node and the question it is
        // typing. Only a real session change resets the cursor.
        const changed = CURRENT.sessionId !== sessionId;
        CURRENT.sessionId = sessionId;
        if (changed) {
          CURRENT.selectedId = null;
          CURRENT.openId = null;
        }
        BUS.bump();
        return () => {
          if (CURRENT.sessionId === sessionId) CURRENT.sessionId = null;
        };
      }, [sessionId]);

      // Watch finished turns so a sent question can flip to「已回答」. Failure
      // here only costs the badge; the tree keeps working.
      React.useEffect(() => {
        if (ctx == null || typeof sessionId !== 'string' || sessionId === '') return undefined;
        let reference = null;
        let unsubscribe = null;
        let disposed = false;
        const run = async () => {
          try {
            const retained = ctx.sessions.retain(sessionId, { source: 'question-tree-answers' });
            reference = retained;
            // Publish the session scope for the composer chip experiment; the
            // reference-insertion listener lives on it.
            const scoped = retained && retained.binding ? retained.binding.ctx : undefined;
            if (scoped) SESSION_SCOPES.set(sessionId, scoped);
            if (retained && typeof retained.ready === 'object' && retained.ready !== null) {
              await retained.ready;
            }
            if (disposed) {
              retained.release();
              return;
            }
            const source = retained.binding && retained.binding.eventSource;
            if (source == null || typeof source.getSnapshot !== 'function') return;
            const read = () => {
              try {
                const snapshot = source.getSnapshot();
                const entries = (snapshot && snapshot.entries) || [];
                let last = 0;
                for (const entry of entries) {
                  const event = entry && entry.event ? entry.event : entry;
                  if (event == null) continue;
                  if (event.type !== 'turn/end' && event.type !== 'assistant/message') continue;
                  const time = Number(event.time);
                  if (Number.isFinite(time) && time > last) last = time;
                }
                if (last <= 0) return;
                const nodes = readNodes(sessionId);
                const result = QTModel.markAnswered(nodes, last, {
                  understand: readAutoUnderstand(),
                });
                if (result.changed) {
                  writeNodes(sessionId, result.nodes);
                  BUS.bump();
                }
              } catch {
                /* keep the tree usable */
              }
            };
            unsubscribe = typeof source.subscribe === 'function' ? source.subscribe(read) : null;
            read();
          } catch {
            /* no event feed: badges stay at「待回答」 */
          }
        };
        run();
        return () => {
          disposed = true;
          SESSION_SCOPES.delete(sessionId);
          try {
            if (typeof unsubscribe === 'function') unsubscribe();
          } catch {
            /* ignore */
          }
          try {
            if (reference) reference.release();
          } catch {
            /* ignore */
          }
        };
      }, [ctx, sessionId]);

      if (typeof sessionId !== 'string' || sessionId === '') {
        return h('div', { style: emptyStyle }, 'no session');
      }

      const nodes = readNodes(sessionId);
      // Miss → page in older history and retry, immediately and automatically.
      // The loop is bounded twice: by `remaining`, and by the「load earlier」
      // control disappearing, so it can never spin on a transcript with no more
      // history to load.
      const locateNode = (id) => {
        const node = nodes.find((item) => item.id === id);
        if (node == null) return;
        const passages =
          Array.isArray(node.quotes) && node.quotes.length > 0 ? node.quotes : [node.quote];
        const anchors =
          Array.isArray(node.anchors) && node.anchors.length > 0
            ? node.anchors
            : node.anchor == null
              ? []
              : [node.anchor];
        const usable = [];
        for (let index = 0; index < anchors.length; index += 1) {
          if (anchors[index] != null) usable.push(index);
        }
        if (usable.length === 0) {
          say(t('flash.noAnchor'));
          return;
        }
        const cursor = LOCATE_CURSOR.get(id) ?? 0;
        const at = usable[cursor % usable.length];
        LOCATE_CURSOR.set(id, cursor + 1);
        const anchor = anchors[at];
        const quote = passages[at] ?? node.quote;

        // The quote may sit in an older page that this Session never loaded.
        // Ask the Host for one page per round — the conversation face pages any
        // session, the button only exists where the transcript happens to be
        // mounted — and report the miss when the pages run out.
        // A second double-click must win: without a generation, the older
        // loop resumes after its page lands, re-jumps to the passage the reader
        // did not pick and cancels the newer landing.
        const generation = ++LOCATE_GEN;
        const alive = () => generation === LOCATE_GEN && panelAlive.current !== false;
        const turnCount = () => document.querySelectorAll('[data-chat-turn]').length;
        const needle = String(quote ?? '').replace(/\s+/g, '');
        const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

        const attempt = async (remaining) => {
          if (!alive()) return;
          const outcome = locateAnchor(anchor, quote);
          if (!alive() || outcome === 'ok') return;
          if (outcome === 'no-anchor') {
            say(t('flash.noAnchor'));
            return;
          }
          if (remaining <= 0) {
            say(t('flash.notLoaded'));
            return;
          }

          const before = turnCount();
          let requested = false;
          try {
            requested =
              HUB != null && typeof HUB.loadOlder === 'function'
                ? await HUB.loadOlder(sessionId)
                : false;
          } catch {
            requested = false;
          }
          if (!alive()) return;
          if (!requested) {
            const button = findLoadEarlier();
            if (button != null) {
              button.click();
              requested = true;
            }
          }
          if (!requested) {
            say(t('flash.notLoaded'));
            return;
          }

          // The host's `loadOlder` resolves even when there is nothing left, so
          // progress has to be measured: no new turns and still no anchor means
          // this session has no older page, and paging 12 more times is waste.
          await wait(180);
          if (!alive()) return;
          if (turnCount() === before && findAnchorTarget(anchor, needle) == null) {
            say(t('flash.notLoaded'));
            return;
          }
          await wait(80);
          if (!alive()) return;
          await attempt(remaining - 1);
        };
        void attempt(12);
      };
      const rows = QTModel.flattenForest(nodes);
      const counts = QTModel.summarize(nodes);

      const pill = (text, color) =>
        h(
          'span',
          {
            style: {
              fontSize: 10,
              lineHeight: '16px',
              padding: '0 6px',
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
              color,
              whiteSpace: 'nowrap',
            },
          },
          text,
        );

      // The switcher used to be two 10px text buttons in the corner, which
      // nobody found. A segmented control reads as one obvious choice, and the
      // unseen view keeps a dot until it has been looked at once.
      const viewSwitch = h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            marginLeft: 6,
            padding: 2,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
            background: 'var(--dsw-alias-bg-l1, rgba(255,255,255,0.04))',
          },
        },
        ...[
          ['list', '☰', t('view.list'), t('view.listHint')],
          ['graph', '⑂', t('view.graph'), t('view.graphHint')],
        ].map(([value, icon, label, title]) => {
          const active = CURRENT.view === value;
          const unseen = value === 'graph' && !readGraphSeen() && active === false;
          return h(
            'button',
            {
              key: value,
              type: 'button',
              title,
              'aria-pressed': active,
              onClick: () => {
                CURRENT.view = value;
                if (value === 'graph') writeGraphSeen();
                BUS.bump();
              },
              style: {
                appearance: 'none',
                border: 'none',
                background: active
                  ? 'var(--dsw-alias-interactive-bg-active, #353b43)'
                  : 'transparent',
                color: active
                  ? 'var(--dsw-alias-label-primary, #f0f0f0)'
                  : 'var(--dsw-alias-label-secondary, #b3b8bf)',
                borderRadius: 6,
                padding: '1px 7px',
                font: 'inherit',
                fontSize: 11,
                lineHeight: '17px',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                position: 'relative',
              },
            },
            h('span', { 'aria-hidden': true, style: { fontSize: 11 } }, icon),
            h('span', null, label),
            unseen
              ? h('span', {
                  'aria-hidden': true,
                  style: {
                    position: 'absolute',
                    top: 1,
                    right: 1,
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: 'var(--dsw-alias-state-info-primary, #4c8dff)',
                  },
                })
              : null,
          );
        }),
      );

      const header = h(
        'div',
        {
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 6px', flexShrink: 0 },
        },
        h('span', { style: { fontSize: 12, fontWeight: 600 } }, t('type.label')),
        h('span', { style: { flex: 1 } }),
        pill(String(counts.total), 'var(--dsw-alias-label-tertiary, #8a8f98)'),
        counts.unclear === 0
          ? null
          : pill(`${counts.unclear} 未懂`, 'var(--dsw-alias-state-warning-primary, #c2700a)'),
        counts.waiting === 0
          ? null
          : pill(`${counts.waiting} 待答`, 'var(--dsw-alias-label-secondary, #b3b8bf)'),
        viewSwitch,
      );

      // A hint that only earns its place while it is true and unseen: as soon
      // as the tree actually branches, the graph view becomes worth finding.
      const childCount = new Map();
      for (const node of nodes) {
        if (node.parentId == null) continue;
        childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1);
      }
      const branching =
        [...childCount.values()].some((count) => count >= 2) ||
        nodes.filter((node) => node.parentId == null).length >= 2;
      const graphHint =
        branching && CURRENT.view === 'list' && !readGraphSeen()
          ? h(
              'div',
              {
                style: {
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  margin: '0 10px 6px',
                  padding: '5px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  lineHeight: '16px',
                  color: 'var(--dsw-alias-label-secondary, #b3b8bf)',
                  background: 'var(--dsw-alias-bg-l1, rgba(255,255,255,0.04))',
                  border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
                },
              },
              h('span', { style: { flex: 1 } }, t('hint.graph')),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    CURRENT.view = 'graph';
                    writeGraphSeen();
                    BUS.bump();
                  },
                  style: {
                    appearance: 'none',
                    border: '1px solid var(--dsw-alias-border-l3, #4a5057)',
                    background: 'var(--dsw-alias-interactive-bg-hover, #2a2f35)',
                    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
                    borderRadius: 5,
                    padding: '0 6px',
                    font: 'inherit',
                    fontSize: 11,
                    lineHeight: '16px',
                    cursor: 'pointer',
                  },
                },
                t('hint.graphSwitch'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: t('hint.graphDismiss'),
                  onClick: () => {
                    writeGraphSeen();
                    BUS.bump();
                  },
                  style: {
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 13,
                    lineHeight: '16px',
                    padding: '0 2px',
                  },
                },
                '×',
              ),
            )
          : null;

      const submitQuestion = (quoteId, text, message) => {
        const before = readNodes(sessionId);
        const after = QTModel.addQuestion(before, quoteId, text);
        if (after === before) return;
        const owner = after.find((node) => node.id === quoteId);
        const question =
          owner != null && owner.questions.length > 0
            ? owner.questions[owner.questions.length - 1]
            : null;
        CURRENT.openId = null;
        writeNodes(sessionId, after);
        BUS.bump();
        if (question == null) return;
        dispatch(sessionId, message).then((outcome) => {
          if (outcome === 'sent') {
            writeNodes(sessionId, QTModel.markQuestionSent(readNodes(sessionId), question.id));
            BUS.bump();
            say(t('flash.sent'));
          } else if (outcome === 'copied') {
            say(t('flash.copied'));
          } else if (outcome === 'failed') {
            say(t('flash.failed'));
          } else {
            say(t('flash.filled'));
          }
        });
      };

      const body = [];
      if (rows.length === 0) {
        body.push(
          h(
            'div',
            { key: 'empty', style: emptyStyle },
            h('div', { style: { fontWeight: 500, marginBottom: 4 } }, t('empty.title')),
            h('div', { style: { opacity: 0.75 } }, t('empty.body')),
          ),
        );
      }

      for (const row of rows) {
        body.push(
          h(Row, {
            key: row.node.id,
            row,
            t,
            selected: CURRENT.selectedId === row.node.id,
            onSelect: (id) => {
              // Click again to deselect: that is how a sibling gets created
              // once the fresh node auto-selects itself.
              CURRENT.selectedId = CURRENT.selectedId === id ? null : id;
              BUS.bump();
            },
            onLocate: (id) => locateNode(id),
            onToggle: (id) => commit(sessionId, QTModel.toggleStatus(readNodes(sessionId), id)),
            onAsk: (id) => {
              CURRENT.selectedId = id;
              CURRENT.openId = CURRENT.openId === id ? null : id;
              BUS.bump();
            },
            onRemove: (id) => {
              const next = QTModel.removeNode(readNodes(sessionId), id);
              if (CURRENT.selectedId === id) CURRENT.selectedId = null;
              if (CURRENT.openId === id) CURRENT.openId = null;
              writeNodes(sessionId, next);
              BUS.bump();
            },
          }),
        );
        for (const question of row.node.questions ?? []) {
          body.push(
            h(QuestionBox, {
              key: question.id,
              t,
              question,
              depth: row.depth,
              onRemove: (questionId) => {
                writeNodes(sessionId, QTModel.removeQuestion(readNodes(sessionId), questionId));
                BUS.bump();
              },
            }),
          );
        }
        if (CURRENT.openId === row.node.id) {
          body.push(
            h(AskInput, {
              key: `${row.node.id}/ask`,
              t,
              depth: row.depth + 1,
              quote: (QTModel.findNode(nodes, row.node.id) ?? {}).quotes ?? [],
              onSubmit: (text, message) => submitQuestion(row.node.id, text, message),
              onCancel: () => {
                CURRENT.openId = null;
                BUS.bump();
              },
            }),
          );
        }
      }

      const content =
        CURRENT.view === 'graph' && rows.length > 0
          ? h(GraphView, {
              nodes,
              t,
              selectedId: CURRENT.selectedId,
              onSelect: (id) => {
                CURRENT.selectedId = CURRENT.selectedId === id ? null : id;
                BUS.bump();
              },
              onLocate: (id) => locateNode(id),
              onToggle: (id) => commit(sessionId, QTModel.toggleStatus(readNodes(sessionId), id)),
            })
          : h('div', null, ...body);

      // The user-facing half of the selection hub: which actions the floating
      // bar offers. The tree owns no registry — it asks the hub handed to it at
      // apply time, or the injected service in the split build.
      const hub = info.hub ?? null;
      // Only what this host can actually offer: the composer action is the
      // fallback for hosts without their own quoting, so its switch would be
      // dead weight where the platform already provides 「引用文本」.
      const registered =
        hub == null ? [] : typeof hub.available === 'function' ? hub.available() : hub.actions();
      const actionEnabled = (id) => (hub == null ? true : hub.isEnabled(id));
      const autoUnderstand = readAutoUnderstand();
      const switchRow = (key, label, checked, onChange) =>
        h(
          'label',
          {
            key,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              lineHeight: '18px',
              cursor: 'pointer',
              opacity: checked ? 1 : 0.5,
            },
          },
          h('input', { type: 'checkbox', checked, onChange, style: { margin: 0 } }),
          label,
        );
      const actionSection =
        registered.length === 0
          ? null
          : h(
              'div',
              {
                style: {
                  flexShrink: 0,
                  borderTop: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
                  padding: '6px 10px 8px',
                },
              },
              h(
                'div',
                { style: { fontSize: 10, opacity: 0.65, marginBottom: 3 } },
                t('actions.title'),
              ),
              ...registered.map((action) =>
                switchRow(
                  action.id,
                  action.label(),
                  actionEnabled(action.id),
                  () => {
                    if (hub == null) return;
                    hub.setEnabled(action.id, !actionEnabled(action.id));
                    BUS.bump();
                  },
                ),
              ),
              switchRow(
                'auto-understand',
                t('actions.autoUnderstand'),
                autoUnderstand,
                () => {
                  writeAutoUnderstand(!autoUnderstand);
                  BUS.bump();
                },
              ),
            );

      return h(
        'div',
        // `minWidth: 0` + full width keep a long quote from widening the whole
        // panel: without it the header (counts, view switch) is pushed sideways
        // and only reachable by scrolling, which is what the sidebar version
        // never did.
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: '100%',
            minWidth: 0,
            minHeight: 0,
          },
        },
        h('style', { dangerouslySetInnerHTML: { __html: SCROLL_CSS } }),
        header,
        graphHint,
        h(
          'div',
          {
            ref: scrollRef,
            className: 'qt-scroll',
            style: {
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              overflowY: 'auto',
              // The branch graph grows to the right with depth, so it needs a
              // horizontal scrollport; the list keeps its rows on one width.
              overflowX: CURRENT.view === 'graph' ? 'auto' : 'hidden',
              // No standard `scrollbar-width` / `scrollbar-color` here: once
              // Chromium sees either of them it stops honouring the
              // `::-webkit-scrollbar` rules below, and the bar collapsed to an
              // invisible overlay thumb. The class owns the look instead.
              padding: '0 6px 16px',
            },
          },
          content,
        ),
        actionSection,
        CURRENT.flash === ''
          ? null
          : h(
              'div',
              {
                style: {
                  flexShrink: 0,
                  padding: '4px 10px',
                  fontSize: 11,
                  color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
                  borderTop: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
                },
              },
              CURRENT.flash,
            ),
      );
    }

    const emptyStyle = {
      padding: '14px 12px',
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
    };

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        const error = this.state.error;
        if (error != null) {
          const message = error && error.message ? error.message : String(error);
          return h(
            'div',
            { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #b3b8bf)' } },
            `问题树出错：${message}`,
          );
        }
        return this.props.children;
      }
    }

    function Panel(props) {
      return h(Boundary, null, h(TreePanel, props));
    }

    /**
     * Hover surface for the「问题树」tab.
     *
     * The tab itself is the shell's, and a page replaces the conversation —
     * which is the opposite of what a jump back to a quote needs. So hovering
     * the tab opens the same panel as a floating window over the transcript,
     * and the reader can keep clicking nodes while the conversation stays put.
     */
    const DOCK = { sessionId: null, rect: null, hover: false, timer: 0, pointer: null };

    /**
     * Whether the pointer still sits on the tab or on the panel.
     *
     * Closing on a bare `mouseleave` is what made the panel flash away: the
     * pointer leaves the tab before it reaches the panel, and a panel that has
     * not been painted yet sends no `mouseenter` to cancel the timer. Asking
     * the document where the pointer is settles it without guessing.
     */
    function pointerHoldsPanel() {
      const pointer = DOCK.pointer;
      if (pointer == null || typeof document.elementFromPoint !== 'function') return false;
      const element = document.elementFromPoint(pointer.x, pointer.y);
      if (element == null || typeof element.closest !== 'function') return false;
      return element.closest('[data-question-tree-hover], [data-question-tree-tab]') != null;
    }

    function dockCloseSoon() {
      if (DOCK.timer !== 0) window.clearTimeout(DOCK.timer);
      const check = () => {
        DOCK.timer = 0;
        if (pointerHoldsPanel()) {
          // Still inside: keep watching instead of closing under the pointer.
          DOCK.timer = window.setTimeout(check, 160);
          return;
        }
        DOCK.hover = false;
        BUS.bump();
      };
      DOCK.timer = window.setTimeout(check, 260);
    }

    /** Binds to the shell-rendered tab, which this plugin does not own. */
    function ViewTabHover() {
      React.useEffect(() => {
        const label = t0('type.label');
        let bound = null;
        const track = (event) => {
          DOCK.pointer = { x: event.clientX, y: event.clientY };
        };
        document.addEventListener('mousemove', track, true);
        const enter = () => {
          if (bound == null) return;
          const sessionId = CURRENT.sessionId ?? (HUB != null && HUB.session ? HUB.session() : null);
          if (typeof sessionId !== 'string' || sessionId === '') return;
          if (DOCK.timer !== 0) {
            window.clearTimeout(DOCK.timer);
            DOCK.timer = 0;
          }
          DOCK.sessionId = sessionId;
          DOCK.rect = bound.getBoundingClientRect();
          DOCK.hover = true;
          BUS.bump();
        };
        const leave = () => {
          // Without this the poll keeps asking `elementFromPoint` about a
          // pointer that no longer produces mousemove events (the user moved
          // into another window), and the card never closes.
          DOCK.pointer = null;
          dockCloseSoon();
        };
        const sync = () => {
          let next = null;
          for (const element of document.querySelectorAll('button, [role="tab"]')) {
            if (String(element.textContent ?? '').trim() === label) {
              next = element;
              break;
            }
          }
          if (next === bound) return;
          if (bound != null) {
            bound.removeEventListener('mouseenter', enter);
            bound.removeEventListener('mouseleave', leave);
          }
          bound = next;
          if (bound != null) {
            bound.setAttribute('data-question-tree-tab', '');
            bound.addEventListener('mouseenter', enter);
            bound.addEventListener('mouseleave', leave);
          }
        };
        sync();
        const observer = new MutationObserver(sync);
        try {
          observer.observe(document.body, { childList: true, subtree: true });
        } catch {
          /* older engines: the bind still works for the first render */
        }
        return () => {
          if (DOCK.timer !== 0) {
            window.clearTimeout(DOCK.timer);
            DOCK.timer = 0;
          }
          document.removeEventListener('mousemove', track, true);
          try {
            observer.disconnect();
          } catch {
            /* ignore */
          }
          if (bound != null) {
            bound.removeEventListener('mouseenter', enter);
            bound.removeEventListener('mouseleave', leave);
          }
        };
      }, []);
      return null;
    }

    function TreeHoverPanel() {
      useVersion();
      if (!DOCK.hover || DOCK.sessionId == null || DOCK.rect == null) return null;
      // The card must follow the session that is on screen right now: the id
      // captured on mouseenter goes stale the moment the reader switches, and
      // acting on it would write into the previous conversation.
      const live = HUB != null && typeof HUB.session === 'function' ? HUB.session() : null;
      const sessionId = typeof live === 'string' && live !== '' ? live : DOCK.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const width = Math.min(430, window.innerWidth - 24);
      const left = Math.min(Math.max(12, DOCK.rect.left - 4), window.innerWidth - width - 12);
      const top = Math.min(DOCK.rect.bottom + 8, Math.max(12, window.innerHeight - 200));
      // A definite height, not `max-height`: a flex column that only has a max
      // height never squeezes its children below their content, so the inner
      // scrollport had no range and the wheel had nothing to move.
      const cardHeight = Math.max(
        220,
        Math.min(Math.round(window.innerHeight * 0.62), window.innerHeight - top - 16, 680),
      );
      const keep = () => {
        if (DOCK.timer !== 0) {
          window.clearTimeout(DOCK.timer);
          DOCK.timer = 0;
        }
      };
      // An invisible strip spanning the gap: the pointer crosses it on its way
      // from the tab to the panel, and it counts as part of the panel.
      const bridge = h('div', {
        'data-question-tree-hover': true,
        'aria-hidden': true,
        onMouseEnter: keep,
        style: {
          position: 'fixed',
          left,
          top: DOCK.rect.bottom,
          width,
          height: Math.max(0, top - DOCK.rect.bottom),
          zIndex: 2147482399,
        },
      });
      return h(
        React.Fragment,
        null,
        bridge,
        h(
        'div',
        {
          'data-question-tree-hover': true,
          onMouseEnter: keep,
          onMouseLeave: dockCloseSoon,
          style: {
            position: 'fixed',
            left,
            top,
            width,
            height: cardHeight,
            zIndex: 2147482400,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l3, #4a5057)',
            background: 'var(--dsw-alias-bg-l2, #1b2026)',
            boxShadow: '0 14px 36px rgba(0,0,0,0.45)',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderBottom: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
              fontSize: 11,
              fontWeight: 600,
            },
          },
          h('span', { 'aria-hidden': true }, '⑂'),
          h('span', null, t0('type.label')),
        ),
        h(
          'div',
          {
            style: {
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: 'flex',
              overflow: 'hidden',
            },
          },
          h(Panel, {
            questionTree: { sessionId, t: t0, ctx: CTX, hub: HUB },
          }),
        ),
        ),
      );
    }

    function Chip() {
      return h(Boundary, null, h(SelectionChip));
    }

    function TreeIcon(props) {
      const size = (props && props.size) || 20;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M5 4v13a2 2 0 0 0 2 2h2' }),
        h('path', { d: 'M5 9h4' }),
        h('path', { d: 'M5 14h4' }),
        h('circle', { cx: '13', cy: '5', r: '1.6' }),
        h('circle', { cx: '13', cy: '9.5', r: '1.6' }),
        h('circle', { cx: '13', cy: '19', r: '1.6' }),
        h('path', { d: 'M13 6.6v1.3' }),
        h('path', { d: 'M13 11.1v6.3' }),
      );
    }

    /* ------------------------------------------------------------------ apply */

    function apply(ctx, providedHub) {
      HUB = providedHub ?? null;
      CTX = ctx ?? null;
      // The selection service arrives two ways: injected (split build), or
      // handed over by the hub composed into this same module (standalone
      // build, where a plugin cannot inject a service it provides itself).
      const selectionActions = providedHub ?? (ctx == null ? null : ctx.selectionActions);
      t0 = bindCopy(ctx, NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'question-tree: dictionaries');

      // The tree is one action on the selection hub. Watching the selection,
      // formatting the quote, and inserting into the composer all live in
      // @local/selection-hub; this plugin owns only the tree.
      ctx.effect(() => {
        if (selectionActions == null || typeof selectionActions.register !== 'function') {
          console.warn('[question-tree] no selection service; the tree action is disabled');
          return () => {};
        }
        try {
          return selectionActions.register({
            id: 'question-tree',
            order: 10,
            label: () => t0('chip.action'),
            hint: ({ altKey }) => {
              const forest = nodesNow();
              const parentId = altKey ? null : QTModel.parentFor(forest, CURRENT.selectedId);
              const parent = QTModel.findNode(forest, parentId);
              return parent == null
                ? `→ ${t0('root')}`
                : `→ ${QTModel.oneLine(QTModel.labelOf(parent), 12)}`;
            },
            run: ({ text, altKey, ctrlKey, anchor, sessionId: fromHub }) => {
              // The bar knows exactly which session the selection came from.
              const sessionId = fromHub ?? sessionNow();
              if (sessionId == null) return false;
              // Ctrl+click grows the node that is already selected, so the added
              // passage shows up in the list immediately. With nothing selected
              // there is nothing to grow, so it falls through to a new node.
              if (ctrlKey && CURRENT.selectedId != null) {
                const forest = readNodes(sessionId);
                const next = QTModel.addQuote(forest, CURRENT.selectedId, text, anchor);
                if (next === forest) return true;
                writeNodes(sessionId, next);
                const grown = QTModel.findNode(next, CURRENT.selectedId);
                say(`已追加 · 该节点共 ${grown ? (grown.quotes ?? []).length : 0} 段`);
                BUS.bump();
                return true;
              }
              const forest = readNodes(sessionId);
              const chosen = altKey ? null : QTModel.parentFor(forest, CURRENT.selectedId);
              const node = QTModel.createNode({ quotes: [text], anchors: [anchor ?? null], parentId: chosen });
              // Select it: the ask box opens on it, and Ctrl+click appends to the
              // selected node, so leaving it unselected contradicts both. Making
              // a sibling is one click away: click the node again to deselect.
              CURRENT.selectedId = node.id;
              CURRENT.openId = node.id;
              writeNodes(sessionId, QTModel.addNode(forest, node));
              BUS.bump();
              return true;
            },
          });
        } catch (error) {
          console.warn('[question-tree] tree action skipped:', error);
          return () => {};
        }
      }, 'question-tree: tree action');

      // The tree is a Conversation View: it shows up as its own tab next to
      // 对话 / 轨迹 / 工件, so the sidebar column stays free. The target is
      // registered first — a tab whose target is missing cannot be activated.
      ctx.effect(() => {
        try {
          const dispose = ctx.uiConversation.views.register({
            target: VIEW_ID,
            create: () => {
              // The tree owns its own store; the target only has to be a valid
              // incremental builder so the view can be activated.
              const empty = { nodes: [], timeline: null };
              return { empty, replace: () => empty, apply: () => empty };
            },
          });
          return typeof dispose === 'function' ? dispose : () => {};
        } catch (error) {
          console.warn('[question-tree] view target skipped:', error);
          return () => {};
        }
      }, 'question-tree: view target');

      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: `${ID}/hover`, order: 940 },
              () => h(React.Fragment, null, h(ViewTabHover), h(TreeHoverPanel)),
            ),
          ),
        'question-tree: tab hover',
      );

      ctx.effect(() => {
        try {
          return ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: VIEW_ID,
                order: 30,
                locale: NS,
                label: () => t0('type.label'),
                inject: (sessionId) => ({
                  questionTree: { sessionId, t: t0, ctx, hub: selectionActions },
                }),
              },
              Panel,
            ),
          );
        } catch (error) {
          console.warn('[question-tree] view tab skipped:', error);
          return () => {};
        }
      }, 'question-tree: view tab');

      ctx.effect(() => {
        try {
          return ctx.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            title: () => t0('type.label'),
            guide: [
              {
                id: 'question-tree',
                order: 30,
                title: () => t0('guide.title'),
                description: () => t0('guide.description'),
                icon: TreeIcon,
              },
            ],
          });
        } catch (error) {
          console.warn('[question-tree] sidebar tab skipped:', error);
          return () => {};
        }
      }, 'question-tree: tab type');

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: ID,
                locale: NS,
                inject: (sessionId) => ({
                  questionTree: { sessionId, t: t0, ctx, hub: selectionActions },
                }),
              },
              Panel,
            ),
          ),
        'question-tree: tab body',
      );
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sessions', 'uiConversation', 'selectionActions'],
      apply,
    };
  },
});
