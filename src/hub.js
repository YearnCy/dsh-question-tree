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
    /**
     * The user-text rule id, and the keyed slot key that renders its nodes.
     *
     * It must NOT be `quote`: DSH 0.2.2 ships `@deepseek-ai/dsh-message-quotes`,
     * which registers a rule id `quote` and a `conversation.user.text.node` key
     * `quote` itself. `UserTextRegistry.register` throws on a duplicate id, so
     * sharing the name made that core bundle fail to activate and took the whole
     * web boot down with it.
     */
    const QUOTE_NODE_ID = 'selection-quote';
    /** Monotonic id, so each new selection mounts a fresh bar element. */
    let SELECTION_SEQ = 0;
    /** Last measured size of the host's pill, used to predict its seat. */
    let LAST_NATIVE_SIZE = null;
    /** The context this plugin was applied to, for capability questions. */
    let HUB_CTX = null;
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
          const serialized = await serialize(QUOTE_NODE_ID, token);
          if (serialized == null || String(serialized).trim() === '') return 'preflight-empty';
        } catch (error) {
          const message = error && error.message ? String(error.message) : 'rejected';
          return `preflight:${message.slice(0, 48)}`;
        }

        const span = capture.call(api);
        if (span == null) return 'no-span';
        const payload = {
          reference: {
            source: QUOTE_NODE_ID,
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
      // A step can be rendered more than once: its reasoning and its response
      // are separate wrappers with the same node key. `anchorKey` names the
      // exact wrapper that was selected, so a later jump can return to the
      // response instead of the (usually hidden) reasoning copy.
      const anchorKey = row.getAttribute('data-chat-anchor-key');
      const groupPart = row.getAttribute('data-chat-group-part');
      const anchor =
        nodeKey == null && turn == null
          ? null
          : {
              nodeKey: nodeKey ?? null,
              turn: turn ?? null,
              anchorKey: anchorKey ?? null,
              groupPart: groupPart ?? null,
            };
      // The live Range and row ride along: the bar re-measures the selection
      // every animation frame so it follows scrolling as tightly as the host's
      // own pill does, which keeps its own selection range for the same reason.
      return { text, rect, anchor, range, row };
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
        anchor.anchorKey != null
          ? `[data-chat-anchor-key="${escape(anchor.anchorKey)}"]`
          : anchor.nodeKey != null
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

    /**
     * The visible box the conversation is actually scrolled inside.
     *
     * The bar is `position: fixed`, while the host's pill lives inside the chat
     * column and is clipped by its scroller. Measuring that scroller is what
     * lets the bar disappear with the selection instead of parking on top of
     * the composer once the text has scrolled away.
     *
     * @param element - any node inside the conversation.
     * @returns the scroller's on-screen box, clipped to the viewport.
     */
    function chatViewport(element) {
      const view = {
        top: 0,
        left: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      };
      let node = element;
      while (node != null && node !== document.body) {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        const scrolls = /(auto|scroll|overlay)/.test(style.overflowY);
        if (scrolls && node.scrollHeight > node.clientHeight + 1) {
          const rect = node.getBoundingClientRect();
          return {
            top: Math.max(rect.top, view.top),
            left: Math.max(rect.left, view.left),
            right: Math.min(rect.right, view.right),
            bottom: Math.min(rect.bottom, view.bottom),
          };
        }
        node = node.parentElement;
      }
      return view;
    }

    /**
     * The host's own selection surface, when it is actually showing.
     *
     * DSH 0.2.2 renders it inside the chat column as
     * `[data-text-interaction-surface]`, placed above the selection and hidden
     * with `visibility` rather than unmounted, so both that attribute and the
     * computed style have to agree before it counts.
     */
    function nativeSurfaceRect() {
      if (typeof document === 'undefined') return null;
      const element = document.querySelector('[data-text-interaction-surface]');
      if (element === null) return null;
      if (element.getAttribute('aria-hidden') === 'true') return null;
      const view = element.ownerDocument.defaultView;
      if (view !== null && view.getComputedStyle(element).visibility === 'hidden') return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return rect;
    }

    /**
     * The host's surface size even while it is still hidden.
     *
     * The host renders the pill's content the moment a gesture starts and only
     * reveals it a frame later, so its box is already laid out — measuring it
     * lets the bar predict the very spot the pill will occupy and show itself
     * immediately, instead of waiting to copy a position that does not exist
     * yet.
     *
     * @returns the surface's box when it has content, otherwise null.
     */
    function nativeSurfaceSize() {
      if (typeof document === 'undefined') return null;
      const element = document.querySelector('[data-text-interaction-surface]');
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return rect;
    }

    /**
     * Where the host's pill will sit, copied from its own placement rules: the
     * first visible line of the selection, centred, above it when it fits.
     *
     * @param line - the selection line the pill anchors to.
     * @param size - the pill's measured size.
     * @param host - the conversation's visible box.
     * @returns the predicted box, in viewport coordinates.
     */
    function predictSeat(line, size, host) {
      const gap = 8;
      const left = Math.max(
        host.left,
        (Math.max(line.left, host.left) + Math.min(line.right, host.right) - size.width) / 2,
      );
      const above = line.top - gap - size.height;
      const top = above >= host.top ? above : line.bottom + gap;
      return { left, top, bottom: top + size.height };
    }

    /**
     * Whether the host has a handler registered for the selection gesture.
     *
     * The DOM cannot answer this reliably: the host's pill is rendered later
     * than our first frame, and a host may keep the surface mounted with no
     * content at all. Its interaction registry can, and it says exactly which
     * gesture ids are owned — `quote` is the core message-quotes plugin.
     *
     * @param ctx - the plugin context.
     * @returns whether the host owns the selection gesture right now.
     */
    function hostOwnsQuote(ctx) {
      try {
        const registry = ctx.uiConversation == null ? null : ctx.uiConversation.interactions;
        if (registry == null || typeof registry.getSnapshot !== 'function') return false;
        const ids = registry.getSnapshot();
        return Array.isArray(ids) && ids.includes('quote');
      } catch {
        return false;
      }
    }

    /**
     * Whether an action is already provided by the host itself.
     *
     * Only the composer one has a host counterpart: 0.2.2 owns selection
     * quoting end to end, so offering ours as well would be a duplicate entry
     * in the bar and a dead switch in the settings panel.
     *
     * @param id - the action id.
     * @returns whether the host owns this capability.
     */
    function isHostOwned(id) {
      return id === 'to-composer' && HUB_CTX != null && hostOwnsQuote(HUB_CTX);
    }

    /* ------------------------------------------------------------- components */

    function ActionBar({ ctx }) {
      const [chip, setChip] = React.useState(null);
      const [place, setPlace] = React.useState(null);
      const [alt, setAlt] = React.useState(false);
      const barRef = React.useRef(null);

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
              previous.range.startContainer === next.range.startContainer &&
              previous.range.startOffset === next.range.startOffset &&
              previous.range.endContainer === next.range.endContainer &&
              previous.range.endOffset === next.range.endOffset
            ) {
              return previous;
            }
            return {
              // A new selection gets a new element: reusing the old node makes
              // the browser paint the bar travelling from its previous spot,
              // which reads as an animation between two unrelated places.
              key: ++SELECTION_SEQ,
              text: next.text,
              anchor: next.anchor,
              range: next.range,
              row: next.row,
            };
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
        // Both triggers publish at once: the pointer is already up, and any
        // debounce here only delays the bar while the host's own pill is
        // drawn immediately.
        const onSelection = () => schedule(0);

        // Scrolling is not re-published: the placement loop measures the live
        // range every frame, which is far tighter than a debounce and is what
        // keeps this bar moving with the text the way the host's own pill does.
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('selectionchange', onSelection);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('pointerup', onUp, true);
          document.removeEventListener('selectionchange', onSelection);
          cancel();
        };
      }, []);

      // Glue the bar to the selection: every frame re-measures the live range
      // and the host's own pill, so scrolling tracks in the same frame instead
      // of arriving after it settles. The bar also disappears once its line
      // leaves the conversation's scroller, the way the host's pill is clipped
      // by it — a fixed-position element would otherwise park over the composer.
      React.useEffect(() => {
        if (chip == null || typeof window.requestAnimationFrame !== 'function') return undefined;
        // A host that owns this gesture (0.2.2) reveals its own pill a frame or
        // two after the selection settles. Waiting for that reveal copied the
        // pill's position but made the bar arrive late; instead the bar reads
        // the pill's already-laid-out box and predicts where it will land, so
        // both appear together. A host without such a surface (0.2.1) takes the
        // plain selection-relative path, exactly as before.
        let frame = 0;
        let frames = 0;
        const hasSurface = document.querySelector('[data-text-interaction-surface]') !== null;

        const measure = () => {
          frame = window.requestAnimationFrame(measure);
          frames += 1;
          const { range, row } = chip;
          if (range == null || row == null || !row.isConnected) {
            setPlace(null);
            return;
          }
          const host = chatViewport(row);
          const line =
            [...range.getClientRects()].find(
              (rect) => rect.bottom > host.top && rect.top < host.bottom,
            ) ?? null;
          if (line == null) {
            setPlace(null);
            return;
          }
          const native = nativeSurfaceRect();
          // The pill's real box once it is placed; its content box while it is
          // still hidden; the last size seen when this frame has neither yet.
          // The bar never waits for the pill: it is drawn on the first frame at
          // the spot the pill is about to occupy.
          const measured = native ?? nativeSurfaceSize();
          if (measured != null) LAST_NATIVE_SIZE = { width: measured.width, height: measured.height };
          const carrier = measured ?? LAST_NATIVE_SIZE ?? { width: 132, height: 32 };
          const seat = hasSurface ? (native ?? predictSeat(line, carrier, host)) : null;
          const ready = true;
          const bar = barRef.current;
          const width = bar == null ? 0 : bar.offsetWidth;
          const height = bar == null ? 28 : bar.offsetHeight;
          const baseLeft = seat == null ? line.left : seat.left;
          const left = Math.min(
            Math.max(host.left + 8, baseLeft),
            Math.max(host.left + 8, host.right - width - 8),
          );
          const above = (seat == null ? line.top : seat.top) - 6;
          const fits = above - height >= host.top;
          const top = fits ? above : (seat == null ? line.bottom : seat.bottom) + 8;
          setPlace((previous) =>
            previous !== null &&
            previous.key === chip.key &&
            previous.top === top &&
            previous.left === left &&
            previous.above === fits &&
            previous.native === (seat != null) &&
            previous.ready === ready
              ? previous
              : { key: chip.key, top, left, above: fits, native: seat != null, ready },
          );
        };

        frame = window.requestAnimationFrame(measure);
        return () => window.cancelAnimationFrame(frame);
      }, [chip]);

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

      // `place` outlives a single selection (it is measured per frame), so it
      // must not be painted for a NEW one: its coordinates belong to the old
      // selection, and drawing there for even one frame is the bar visibly
      // hopping from one line to the next. Until this selection has its own
      // measurement, nothing is drawn at all.
      if (chip == null || place == null || place.key !== chip.key) return null;
      const sessionId = LAST_SESSION;
      if (sessionId == null) return null;
      // The host draws its own 「引用文本」 pill for this gesture, so ours would
      // be a second button for the same thing: drop it. The registry is asked
      // rather than the DOM, because the pill appears a frame later and its
      // absence at that moment says nothing. Anywhere the host owns no such
      // handler — 0.2.1 and older, or a 0.2.2 with that core plugin off — the
      // button stays available.
      const owned = place.native || isHostOwned('to-composer');
      const actions = enabledActions().filter(
        (action) => !(owned && action.id === 'to-composer'),
      );
      if (actions.length === 0) return null;

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
          ref: barRef,
          key: chip.key,
          'data-selection-hub-bar': true,
          style: {
            position: 'fixed',
            top: place.top,
            left: place.left,
            // `above` anchors by the bar's bottom edge, so it clears the host's
            // pill without having to know either height in advance.
            transform: place.above ? 'translateY(-100%)' : 'none',
            // Never animate a position that is chosen per frame anyway: a host
            // rule that eases `all` would turn every re-measure into a glide.
            transition: 'none',
            // Laid out but not painted until the host's pill has taken its
            // place: this is what removes the jump, and it still measures the
            // bar's real size for the frame that reveals it.
            visibility: place.ready ? 'visible' : 'hidden',
            pointerEvents: place.ready ? 'auto' : 'none',
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
      id: QUOTE_NODE_ID,
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
        return { id: QUOTE_NODE_ID, start: 0, end: end + 1, data: { quote } };
      },
    };

    /* ------------------------------------------------------------------- API */

    const API = {
      register,
      actions: () => ACTIONS.slice(),
      /**
       * The actions this host can actually offer: the composer one is the
       * fallback for hosts without their own quoting gesture, so it is not
       * listed where the host already provides it.
       * @returns the offered actions.
       */
      available: () => ACTIONS.filter((action) => !isHostOwned(action.id)),
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
      HUB_CTX = ctx;
      ctx.effect(() => ctx.reflect.provide('selectionActions', API), 'selection-hub: service');

      // Built-in action: a quote can go straight into the composer, with no
      // consumer plugin involved. Chip first, plain text second, clipboard last.
      //
      // It is registered on EVERY host, including 0.2.2 where the core
      // `@deepseek-ai/dsh-message-quotes` owns the same gesture: whether the
      // host actually draws its own 「引用文本」 pill is a render-time fact, not
      // a boot-time one, and gating registration on the presence of the
      // interaction service would take the button away from a 0.2.2 user who
      // has that core plugin switched off. The bar hides it per frame instead,
      // whenever the host's surface is really on screen.
      ctx.effect(
        () =>
          register({
            id: 'to-composer',
            order: 20,
            icon: '↧',
            label: () => '添加到对话',
            run: ({ text, sessionId }) => {
              if (sessionId == null) return false;
              const api = INPUT.get(sessionId);
              if (api != null && typeof api.insertQuote === 'function') {
                try {
                  if (api.insertQuote(text)) return true;
                } catch {
                  /* fall through to the chip path */
                }
              }
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
              name: QUOTE_NODE_ID,
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

      // A duplicate rule id or slot key throws, and an exception thrown while
      // this entry activates fails the whole web boot. The quote chip is an
      // enhancement, not the feature: report it and keep the tree working.
      ctx.effect(() => {
        try {
          return ctx.uiConversation.userText.register(quoteRule);
        } catch (error) {
          console.warn('[selection-hub] quote rule skipped:', error);
          return () => {};
        }
      }, 'selection-hub: quote matcher');
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.user.text.node', () => {
            try {
              return ctx.slots.register(
                { name: 'conversation.user.text.node', key: QUOTE_NODE_ID, priority: 100 },
                QuoteChip,
              );
            } catch (error) {
              console.warn('[selection-hub] quote chip skipped:', error);
              return () => {};
            }
          }),
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
