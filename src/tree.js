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
      if (typeof sessionId !== 'string' || sessionId === '') return;
      try {
        window.localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify(nodes));
      } catch {
        /* storage may be full or disabled; the tree still works this session */
      }
    }

    function nodesNow() {
      return readNodes(CURRENT.sessionId);
    }    function commit(nodes) {
      writeNodes(CURRENT.sessionId, nodes);
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
      if (CURRENT.sessionId == null) return null;

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
          onClick: () => onSelect(node.id),
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
          'span',
          {
            style: {
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: '20px',
              opacity: question || unclear ? 1 : 0.65,
              textDecoration: question ? 'none' : unclear ? 'none' : 'line-through',
            },
            // Full text in the tooltip, and each passage keeps its own 「」 —
            // the joined string would read as one continuous excerpt.
            title: question
              ? QTModel.labelOf(node)
              : (Array.isArray(node.quotes) && node.quotes.length > 0 ? node.quotes : [node.quote])
                  .map((item) => `「${item}」`)
                  .join(''),
          },
          question ? QTModel.oneLine(node.text, 80) : displayQuote(node, 56),
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
.qt-g-forest{display:flex;flex-direction:column;gap:14px;padding:4px 6px 24px}
.qt-g-branch{display:flex;align-items:center}
.qt-g-kids{display:flex;flex-direction:column;gap:8px;position:relative;padding-left:22px;margin-left:12px}
.qt-g-kids::before{content:'';position:absolute;left:0;top:14px;bottom:14px;border-left:1px solid var(--dsw-alias-border-l2,#2f343a)}
.qt-g-kid{position:relative;display:flex;align-items:center}
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
          onClick: () => onSelect(node.id),
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

    /**
     * Break the transcript's tail-follow before a programmatic scroll.
     *
     * The chat re-pins itself to the tail while it believes the user is not
     * driving, and a one-pixel self-scroll is not a signal it accepts — only a
     * real wheel gesture flips it, which is why scrolling by hand used to be
     * required before an upward jump would stick. A synthetic wheel event is
     * that gesture as far as its listener is concerned.
     *
     * @returns the scroll container, for a direct-scroll fallback.
     */
    function releaseTail(element) {
      let node = element.parentElement;
      while (node != null) {
        const style = window.getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
          try {
            node.dispatchEvent(
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
          node.scrollTop -= 1;
          return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    /** The「load earlier」control, when the transcript is showing one. */
    function findLoadEarlier() {
      for (const button of document.querySelectorAll('button')) {
        const text = String(button.textContent ?? '').replace(/\s+/g, '');
        if (text === '加载更早' || /^loadealier$/i.test(text) || /^loadearlier$/i.test(text)) {
          return button;
        }
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
      const escape = (value) =>
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(value)
          : String(value).replace(/["\\]/g, '\\$&');
      const selector =
        anchor.nodeKey != null
          ? `[data-chat-node-key="${escape(anchor.nodeKey)}"]`
          : anchor.turn != null
            ? `[data-chat-turn="${escape(String(anchor.turn))}"]`
            : null;
      if (selector === null) return 'no-anchor';
      const target = document.querySelector(selector);
      // Not in the DOM: either the row is inside an unloaded older page, or the
      // list is mid-render. The caller retries, then tells the user which it is.
      if (target == null) return 'missing';

      const needle = String(quote ?? '').replace(/\s+/g, '');
      let focus = target;
      if (needle !== '') {
        let best = null;
        let bestLength = Number.POSITIVE_INFINITY;
        for (const element of target.querySelectorAll('*')) {
          const text = String(element.textContent ?? '').replace(/\s+/g, '');
          if (text.length >= bestLength || !text.includes(needle)) continue;
          best = element;
          bestLength = text.length;
        }
        if (best != null) focus = best;
      }

      try {
        // Align the row to the top of the transcript with a small gap, in ONE
        // write: asking the browser to align and then correcting by 8px is two
        // visible movements. Setting scrollTop by the measured error is one.
        // The re-assertions repeat the same single write, so a pass that already
        // measures as correct writes zero and nothing moves.
        const TOP_GAP = 8;
        const scroller = releaseTail(focus);
        const reveal = (remaining) => {
          if (!focus.isConnected || scroller == null) return;
          const rect = focus.getBoundingClientRect();
          const frame = scroller.getBoundingClientRect();
          const delta = rect.top - frame.top - TOP_GAP;
          if (delta !== 0) scroller.scrollTop += delta;
          if (remaining > 0) window.setTimeout(() => reveal(remaining - 1), 140);
        };
        reveal(2);
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

    function TreePanel(props) {
      const info = props.questionTree ?? {};
      const t = info.t ?? t0;
      const sessionId = info.sessionId;
      const ctx = info.ctx;
      useVersion();

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        CURRENT.sessionId = sessionId;
        CURRENT.selectedId = null;
        CURRENT.openId = null;
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
                const result = QTModel.markAnswered(nodes, last);
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

        const attempt = (remaining) => {
          const outcome = locateAnchor(anchor, quote);
          if (outcome === 'ok') return;
          if (outcome === 'no-anchor') {
            say(t('flash.noAnchor'));
            return;
          }
          if (remaining > 0) {
            const button = findLoadEarlier();
            if (button != null) button.click();
            window.setTimeout(() => attempt(remaining - 1), 220);
            return;
          }
          say(t('flash.notLoaded'));
        };
        attempt(6);
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
        h(
          'span',
          { style: { display: 'flex', gap: 2, marginLeft: 4 } },
          ...[
            ['list', t('view.list')],
            ['graph', t('view.graph')],
          ].map(([value, label]) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                onClick: () => {
                  CURRENT.view = value;
                  BUS.bump();
                },
                style: {
                  appearance: 'none',
                  border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
                  background:
                    CURRENT.view === value
                      ? 'var(--dsw-alias-interactive-bg-hover, #2a2f35)'
                      : 'transparent',
                  color:
                    CURRENT.view === value
                      ? 'var(--dsw-alias-label-primary, #e6e6e6)'
                      : 'var(--dsw-alias-label-tertiary, #8a8f98)',
                  borderRadius: 6,
                  padding: '0 6px',
                  font: 'inherit',
                  fontSize: 10,
                  lineHeight: '16px',
                  cursor: 'pointer',
                },
              },
              label,
            ),
          ),
        ),
      );

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
            onToggle: (id) => commit(QTModel.toggleStatus(readNodes(sessionId), id)),
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
              onToggle: (id) => commit(QTModel.toggleStatus(readNodes(sessionId), id)),
            })
          : h('div', null, ...body);

      // The user-facing half of the selection hub: which actions the floating
      // bar offers. The tree owns no registry — it asks the hub handed to it at
      // apply time, or the injected service in the split build.
      const hub = info.hub ?? null;
      const registered = hub == null ? [] : hub.actions();
      const actionEnabled = (id) => (hub == null ? true : hub.isEnabled(id));
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
                h(
                  'label',
                  {
                    key: action.id,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      lineHeight: '18px',
                      cursor: 'pointer',
                      opacity: actionEnabled(action.id) ? 1 : 0.5,
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: actionEnabled(action.id),
                    onChange: () => {
                      if (hub == null) return;
                      hub.setEnabled(action.id, !actionEnabled(action.id));
                      BUS.bump();
                    },
                    style: { margin: 0 },
                  }),
                  action.label(),
                ),
              ),
            );

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        header,
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '0 6px 16px' } },
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
      // The selection service arrives two ways: injected (split build), or
      // handed over by the hub composed into this same module (standalone
      // build, where a plugin cannot inject a service it provides itself).
      const selectionActions = providedHub ?? (ctx == null ? null : ctx.selectionActions);
      t0 = bindCopy(ctx, NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'question-tree: dictionaries');

      // The tree is one action on the selection hub. Watching the selection,
      // formatting the quote, and inserting into the composer all live in
      // @local/selection-hub; this plugin owns only the tree.
      ctx.effect(
        () =>
          selectionActions.register({
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
            run: ({ text, altKey, ctrlKey, anchor }) => {
              if (CURRENT.sessionId == null) return false;
              // Ctrl+click grows the node that is already selected, so the added
              // passage shows up in the list immediately. With nothing selected
              // there is nothing to grow, so it falls through to a new node.
              if (ctrlKey && CURRENT.selectedId != null) {
                const forest = nodesNow();
                const next = QTModel.addQuote(forest, CURRENT.selectedId, text, anchor);
                if (next === forest) return true;
                writeNodes(CURRENT.sessionId, next);
                const grown = QTModel.findNode(next, CURRENT.selectedId);
                say(`已追加 · 该节点共 ${grown ? (grown.quotes ?? []).length : 0} 段`);
                BUS.bump();
                return true;
              }
              const forest = nodesNow();
              const chosen = altKey ? null : QTModel.parentFor(forest, CURRENT.selectedId);
              const node = QTModel.createNode({ quotes: [text], anchors: [anchor ?? null], parentId: chosen });
              // Select it: the ask box opens on it, and Ctrl+click appends to the
              // selected node, so leaving it unselected contradicts both. Making
              // a sibling is one click away: click the node again to deselect.
              CURRENT.selectedId = node.id;
              CURRENT.openId = node.id;
              writeNodes(CURRENT.sessionId, QTModel.addNode(forest, node));
              BUS.bump();
              return true;
            },
          }),
        'question-tree: tree action',
      );

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
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
          }),
        'question-tree: tab type',
      );

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
