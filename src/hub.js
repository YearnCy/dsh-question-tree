/**
 * Selection hub — the mechanism, without any consumer baked in.
 *
 * It owns exactly four things:
 *
 *   1. watching what is selected in the transcript (and nothing else)
 *   2. the floating action bar, whose entries come from `register(action)`
 *   3. the wire format of a quote, and the chip that renders it in the transcript
 *   4. inserting text or a reference chip into the composer
 *
 * Consumers (question-tree today, translation tomorrow) only register actions.
 * The service is published as `ctx.selectionActions`.
 */
window.__ModuleLoader__.load({
  id: '@local/selection-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ID = '@local/selection-hub';
    const SETTINGS_KEY = 'dsh.selection-hub.actions';
    const CHIP_STYLE = {
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

    /* ------------------------------------------------------------ text utils */

    function oneLine(text, max = 80) {
      const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
      const chars = Array.from(flat);
      return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
    }

    /** Strip markdown that would restructure the message it is inlined into. */
    function sanitize(text) {
      return String(text ?? '')
        .replace(/`/g, "'")
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /** The wire form of a quote. One format, matched by the transcript chip. */
    function formatQuote(text, max = 200) {
      return `「${oneLine(sanitize(text), max)}」`;
    }

    /** `「quote」—— question`; the question alone when it already holds the quote. */
    function formatMessage(quote, question) {
      const asked = String(question ?? '').trim();
      const quoted = sanitize(quote);
      if (quoted === '') return asked;
      if (asked.includes(quoted)) return asked;
      return `${formatQuote(quoted)}——${asked}`;
    }

    /* -------------------------------------------------------------- registry */

    const ACTIONS = [];

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        const parsed = raw == null ? null : JSON.parse(raw);
        return parsed != null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeSettings(value) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
      } catch {
        /* storage may be full or disabled */
      }
    }

    function isEnabled(id) {
      return readSettings()[id] !== false;
    }

    function register(action) {
      ACTIONS.push(action);
      return () => {
        const at = ACTIONS.indexOf(action);
        if (at >= 0) ACTIONS.splice(at, 1);
      };
    }

    function enabledActions() {
      const settings = readSettings();
      return ACTIONS.filter((action) => settings[action.id] !== false).sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      );
    }

    /* -------------------------------------------------------------- composer */

    /** sessionId → composer action facade, published by the bridge slot. */
    const INPUT = new Map();
    /** The on-screen session: the last composer that mounted a bridge. */
    let LAST_SESSION = null;
    /** sessionId → session-scope Cordis ctx, retained on demand. */
    const SCOPES = new Map();
    const RETAINED = [];

    async function scopeOf(ctx, sessionId) {
      const cached = SCOPES.get(sessionId);
      if (cached !== undefined) return cached;
      try {
        const ref = ctx.sessions.retain(sessionId, { source: 'selection-hub' });
        RETAINED.push(ref);
        if (ref && ref.ready && typeof ref.ready.then === 'function') await ref.ready;
        const scope = ref && ref.binding ? ref.binding.ctx : undefined;
        if (scope !== undefined) SCOPES.set(sessionId, scope);
        return scope;
      } catch {
        return undefined;
      }
    }

    /** Insert text at the caret without replacing the draft. */
    function insertText(sessionId, text) {
      const api = INPUT.get(sessionId);
      const insert = api == null ? null : (api.insertText ?? (api.input && api.input.insertText));
      const capture =
        api == null ? null : (api.captureInsertion ?? (api.input && api.input.captureInsertion));
      if (typeof insert !== 'function' || typeof capture !== 'function') return 'missing';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const outcome = insert.call(api, text, capture.call(api));
          if (outcome != null && typeof outcome.then === 'function') return 'sent';
          if (outcome !== false) return 'sent';
        } catch {
          break;
        }
      }
      return 'failed';
    }

    /** Type text into the composer and try to submit it. */
    function send(sessionId, text) {
      const api = INPUT.get(sessionId);
      if (api == null) return 'missing';
      const setDraft = api.setDraft ?? api.setText ?? (api.input && api.input.setDraft);
      try {
        if (typeof setDraft === 'function') setDraft.call(api, text);
      } catch {
        /* fall through */
      }
      const submit = api.submit ?? api.send ?? (api.input && api.input.submit);
      if (typeof submit === 'function') {
        try {
          submit.call(api);
          return 'sent';
        } catch {
          /* composer refused; the draft stays */
        }
      }
      return 'filled';
    }

    /**
     * Insert a real composer chip.
     *
     * A chip carries `source` as its serialization routing key; a source with no
     * codec makes the draft UNSUBMITTABLE. So this refuses unless the preflight
     * serialization resolves. Returns 'ok' or a reason code.
     */
    async function insertChip(ctx, sessionId, token) {
      try {
        const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
        if (triggers == null) return 'no-triggers';
        const api = INPUT.get(sessionId);
        if (api == null) return 'no-api';
        const capture = api.captureInsertion ?? (api.input && api.input.captureInsertion);
        if (typeof capture !== 'function') return 'no-capture';
        const scope = await scopeOf(ctx, sessionId);
        if (scope == null) return 'no-scope';

        let serialize = null;
        if (typeof triggers.serializeReference === 'function') {
          serialize = (source, ref) => triggers.serializeReference(source, ref);
        } else if (typeof triggers.sessionOf === 'function') {
          const controller = triggers.sessionOf(scope);
          if (controller == null || typeof controller.serializeReference !== 'function') {
            return 'no-serializer';
          }
          serialize = (source, ref) => controller.serializeReference(source, ref);
        } else {
          return 'no-serializer';
        }

        try {
          const serialized = await serialize('quote', token);
          if (serialized == null || String(serialized).trim() === '') return 'preflight-empty';
        } catch (error) {
          const message = error && error.message ? String(error.message) : 'rejected';
          return `preflight:${message.slice(0, 48)}`;
        }

        const span = capture.call(api);
        if (span == null) return 'no-span';
        const payload = {
          reference: {
            source: 'quote',
            label: token.trim(),
            ref: token,
            appearance: 'session',
            clipboardText: token,
          },
          span,
        };

        let outcome;
        if (typeof scope.bail === 'function') {
          outcome = scope.bail(scope, 'slash/input-insert-reference', payload);
        } else if (typeof scope.emit === 'function') {
          outcome = scope.emit('slash/input-insert-reference', payload);
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

    /**
     * Read the current selection, including the message it sits in.
     *
     * The anchor is what makes a consumer able to jump back later: `nodeKey`
     * identifies the rendered row, `turn` the turn it belongs to. Both are
     * UI-derived, so a consumer must treat a missing anchor as "cannot locate".
     */
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
      const row = element.closest('[data-chat-node-key], [data-chat-turn]');
      if (row === null) return null;
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      const nodeKey = row.getAttribute('data-chat-node-key');
      const turn = row.getAttribute('data-chat-turn');
      const anchor =
        nodeKey == null && turn == null ? null : { nodeKey: nodeKey ?? null, turn: turn ?? null };
      return { text, rect, anchor };
    }

    /**
     * Scroll the conversation to an element recorded by {@link readSelection}.
     *
     * @returns whether a matching row still exists.
     */
    function locate(anchor) {
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
      if (selector === null) return false;
      const target = document.querySelector(selector);
      if (target == null) return false;
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return true;
      } catch {
        return false;
      }
    }

    function clearSelection() {
      try {
        window.getSelection().removeAllRanges();
      } catch {
        /* ignore */
      }
    }

    /* ------------------------------------------------------------- components */

    function ActionBar({ ctx }) {
      const [chip, setChip] = React.useState(null);
      const [alt, setAlt] = React.useState(false);

      // Nothing is published while the pointer is down: a bar under the cursor
      // moves the selection, which republishes the bar, which moves it again.
      React.useEffect(() => {
        let timer = 0;
        let dragging = false;

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
              return previous;
            }
            return { text: next.text, rect: next.rect, anchor: next.anchor };
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

        const onDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('[data-selection-hub-bar]') !== null) return;
          dragging = true;
          cancel();
          setChip(null);
        };
        const onUp = () => {
          dragging = false;
          schedule(0);
        };
        const onSelection = () => schedule();
        const onScroll = () => schedule(0);

        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('selectionchange', onSelection);
        document.addEventListener('keyup', onScroll, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('pointerup', onUp, true);
          document.removeEventListener('selectionchange', onSelection);
          document.removeEventListener('keyup', onScroll, true);
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onScroll);
          cancel();
        };
      }, []);

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

      if (chip == null) return null;
      const sessionId = LAST_SESSION;
      if (sessionId == null) return null;
      const actions = enabledActions();
      if (actions.length === 0) return null;

      const top = Math.max(8, chip.rect.top - 40);
      const left = Math.min(Math.max(8, chip.rect.left), Math.max(8, window.innerWidth - 150));

      const run = (action, event) => {
        try {
          action.run({
            text: chip.text,
            altKey: event.altKey || alt,
            ctrlKey: event.ctrlKey === true,
            sessionId,
            anchor: chip.anchor,
            hub: API,
          });
        } finally {
          clearSelection();
          setChip(null);
        }
      };

      return h(
        'div',
        {
          'data-selection-hub-bar': true,
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
          const hint =
            typeof action.hint === 'function' ? action.hint({ text: chip.text, altKey: alt }) : '';
          return h(
            'button',
            {
              key: action.id,
              type: 'button',
              style: CHIP_STYLE,
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

    /** Captures the composer handle so any action can insert into it. */
    function ComposerBridge(props) {
      const sessionId = props.selectionHub ? props.selectionHub.sessionId : undefined;
      const api = props.inputActions ?? props.keyboard ?? null;
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || api == null) return undefined;
        INPUT.set(sessionId, api);
        LAST_SESSION = sessionId;
        return () => {
          if (INPUT.get(sessionId) === api) INPUT.delete(sessionId);
          if (LAST_SESSION === sessionId) LAST_SESSION = null;
        };
      }, [sessionId, api]);
      return null;
    }

    /** A sent quote renders as a chip; the matcher only accepts the wire shape. */
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
            cursor: 'default',
          },
        },
        `「${oneLine(quote, 24)}」`,
      );
    }

    const quoteRule = {
      id: 'quote',
      order: 10,
      match(text, from) {
        if (typeof text !== 'string' || from > 0) return undefined;
        if (!text.startsWith('「')) return undefined;
        // The quote may contain 「 or 」 itself: close at the last bracket that a
        // separator follows, not the first bracket seen.
        let end = -1;
        for (let index = text.length - 1; index > 0; index -= 1) {
          if (text[index] !== '」') continue;
          const next = text[index + 1];
          if (
            next === undefined ||
            next === ' ' ||
            next === '\n' ||
            next === '\t' ||
            text.startsWith('——', index + 1)
          ) {
            end = index;
            break;
          }
        }
        if (end <= 1) return undefined;
        const quote = text.slice(1, end);
        if (quote.length > 300) return undefined;
        return { id: 'quote', start: 0, end: end + 1, data: { quote } };
      },
    };

    /* ------------------------------------------------------------------- API */

    const API = {
      register,
      actions: () => ACTIONS.slice(),
      enabledActions,
      isEnabled,
      setEnabled(id, value) {
        const next = { ...readSettings() };
        next[id] = value !== false;
        writeSettings(next);
      },
      formatQuote,
      formatMessage,
      locate,
      insertText,
      send,
      insertChip: (ctx, sessionId, token) => insertChip(ctx, sessionId, token),
    };

    /* ----------------------------------------------------------------- apply */

    function apply(ctx) {
      ctx.effect(() => ctx.reflect.provide('selectionActions', API), 'selection-hub: service');

      // Built-in action: a quote can go straight into the composer, with no
      // consumer plugin involved. Chip first, plain text second, clipboard last.
      ctx.effect(
        () =>
          register({
            id: 'to-composer',
            order: 20,
            icon: '↧',
            label: () => '添加到对话',
            run: ({ text, sessionId }) => {
              if (sessionId == null) return false;
              const token = `${formatQuote(text)} `;
              insertChip(ctx, sessionId, token).then((outcome) => {
                if (outcome === 'ok') return;
                console.warn('[selection-hub] composer chip fell back:', outcome);
                if (insertText(sessionId, token) !== 'sent') {
                  try {
                    navigator.clipboard.writeText(token);
                  } catch {
                    /* ignore */
                  }
                }
              });
              return true;
            },
          }),
        'selection-hub: to-composer action',
      );

      // The composer chip's serialization routes through this codec. Without it,
      // a chip would make the draft unsubmittable.
      const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
      if (triggers != null && typeof triggers.registerSource === 'function') {
        ctx.effect(() => {
          try {
            const dispose = triggers.registerSource({
              name: 'quote',
              trigger: '@',
              codec: { serialize: (ref) => Promise.resolve(ref) },
            });
            return typeof dispose === 'function' ? dispose : () => {};
          } catch {
            return () => {};
          }
        }, 'selection-hub: quote source');
      }

      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: `${ID}/bar`, order: 900 }, () =>
              h(ActionBar, { ctx }),
            ),
          ),
        'selection-hub: action bar',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: `${ID}/bridge`,
                order: 5,
                inject: (sessionId) => ({ selectionHub: { sessionId } }),
              },
              ComposerBridge,
            ),
          ),
        'selection-hub: composer bridge',
      );

      ctx.effect(
        () => ctx.uiConversation.userText.register(quoteRule),
        'selection-hub: quote matcher',
      );
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.user.text.node', () =>
            ctx.slots.register(
              { name: 'conversation.user.text.node', key: 'quote', priority: 100 },
              QuoteChip,
            ),
          ),
        'selection-hub: quote chip',
      );

      ctx.effect(
        () => () => {
          for (const ref of RETAINED) {
            try {
              ref.release();
            } catch {
              /* ignore */
            }
          }
          RETAINED.length = 0;
          SCOPES.clear();
        },
        'selection-hub: retained scopes',
      );
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sessions', 'uiConversation'],
      apply,
    };
  },
});
