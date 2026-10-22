/**
 * The question tree's data model.
 *
 * The tree contains **only quotes**. A question is not a node: it is an
 * annotation attached to the quote it was asked about. That is what keeps the
 * picture readable — edges mean「this quote came out of that one」and nothing
 * else, while「what did I ask here」lives inside the node.
 *
 * Node shape:
 *   { id, parentId, quote, status, createdAt, questions }
 *   questions: [{ id, text, createdAt, sentAt, answeredAt }]
 *
 *   quote      the selected text, verbatim
 *   status     1 = unclear, 2 = understood
 *   sentAt     when that question went to the conversation
 *   answeredAt when a finished turn landed after it
 */

const STATUS_UNCLEAR = 1;
const STATUS_CLEAR = 2;

/**
 * Reduce arbitrary text to one readable line.
 *
 * @param text - source text.
 * @param max - maximum code points.
 * @returns collapsed, truncated text.
 */
export function oneLine(text, max = 80) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** The text a node shows. */
export function labelOf(node) {
  return node == null ? '' : String(node.quote ?? '');
}

/**
 * Create a quote node.
 *
 * @param input - `{ quote, quotes, parentId, createdAt, id, anchor, anchors }`.
 * @returns a new node.
 */
export function createNode(input) {
  const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
  // A node can quote several passages: a selection is lost as soon as the next
  // one starts, so Ctrl+click accumulates them and they are committed together.
  const passages = Array.isArray(input.quotes)
    ? input.quotes.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
    : [];
  const quote =
    passages.length > 0 ? passages.join(' ') : String(input.quote ?? '').trim();
  // Anchors stay index-aligned with the passages: entry i belongs to passage i
  // (null when that selection could not be traced to a row). Cycling through
  // them depends on that alignment, so nulls are kept, not filtered.
  const anchors = Array.isArray(input.anchors)
    ? input.anchors.map((item) => item ?? null)
    : input.anchor == null
      ? []
      : [input.anchor];
  return {
    id: input.id ?? `n${createdAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    parentId: input.parentId ?? null,
    quote,
    quotes: passages.length > 0 ? passages : quote === '' ? [] : [quote],
    status: input.status === STATUS_CLEAR ? STATUS_CLEAR : STATUS_UNCLEAR,
    createdAt,
    // Which rendered message(s) the text came from, so a click can scroll back.
    // UI-derived: absent for older nodes, or when a selection could not be
    // traced to a row.
    anchor: anchors[0] ?? null,
    anchors,
    questions: Array.isArray(input.questions) ? input.questions.slice() : [],
  };
}

/**
 * Attach a question to a quote node.
 *
 * @param nodes - forest.
 * @param quoteId - the node it was asked about.
 * @param text - exactly what the user typed.
 * @returns a new array; a missing quote returns the input.
 */
export function addQuestion(nodes, quoteId, text, createdAt) {
  const at = Number.isFinite(createdAt) ? createdAt : Date.now();
  let touched = false;
  const next = (nodes ?? []).map((node) => {
    if (node.id !== quoteId) return node;
    touched = true;
    const question = {
      id: `q${at.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      text: String(text ?? '').trim(),
      createdAt: at,
    };
    return { ...node, questions: [...(node.questions ?? []), question] };
  });
  return touched ? next : (nodes ?? []);
}

/**
 * Append another passage to an existing node.
 *
 * Ctrl+click grows the node it is aimed at instead of opening a second node:
 * the added passage is visible in the list immediately, whereas a pending
 * collection only appears after a later commit.
 *
 * @param nodes - forest.
 * @param id - node to grow.
 * @param quote - the new passage.
 * @param anchor - where it was selected, when known.
 * @returns a new array; unchanged when the passage is empty or the node is gone.
 */
export function addQuote(nodes, id, quote, anchor) {
  const text = sanitizeQuote(quote);
  if (text === '') return nodes ?? [];
  let touched = false;
  const next = (nodes ?? []).map((node) => {
    if (node.id !== id) return node;
    touched = true;
    const quotes = [...(node.quotes ?? []), text];
    const anchors = [...(node.anchors ?? []), anchor ?? null];
    return {
      ...node,
      quotes,
      quote: quotes.join(' '),
      anchors,
      anchor: anchors[0] ?? node.anchor ?? null,
    };
  });
  return touched ? next : (nodes ?? []);
}

/**
 * Remove one question from wherever it lives.
 *
 * @returns a new array.
 */
export function removeQuestion(nodes, questionId) {
  let touched = false;
  const next = (nodes ?? []).map((node) => {
    const questions = node.questions ?? [];
    if (!questions.some((question) => question.id === questionId)) return node;
    touched = true;
    return { ...node, questions: questions.filter((question) => question.id !== questionId) };
  });
  return touched ? next : (nodes ?? []);
}

/**
 * Mark a question as sent.
 *
 * @returns a new array.
 */
export function markQuestionSent(nodes, questionId, sentAt) {
  const at = Number.isFinite(sentAt) ? sentAt : Date.now();
  let touched = false;
  const next = (nodes ?? []).map((node) => {
    const questions = node.questions ?? [];
    if (!questions.some((question) => question.id === questionId)) return node;
    touched = true;
    return {
      ...node,
      questions: questions.map((question) =>
        question.id === questionId ? { ...question, sentAt: at } : question,
      ),
    };
  });
  return touched ? next : (nodes ?? []);
}

/**
 * Mark every sent-but-unanswered question older than `time` as answered.
 *
 * A turn that finished before a question was sent cannot answer it, so the
 * comparison is on time, not on count.
 *
 * @returns `{ nodes, changed }`; unchanged nodes keep their reference.
 */
export function markAnswered(nodes, time) {
  const at = Number(time);
  if (!Number.isFinite(at) || at <= 0) return { nodes: nodes ?? [], changed: false };
  let changed = false;
  const next = (nodes ?? []).map((node) => {
    const questions = node.questions ?? [];
    if (questions.length === 0) return node;
    let touched = false;
    const updated = questions.map((question) => {
      if (!Number.isFinite(question.sentAt) || question.answeredAt != null) return question;
      if (question.sentAt > at) return question;
      touched = true;
      return { ...question, answeredAt: at };
    });
    if (!touched) return node;
    changed = true;
    return { ...node, questions: updated };
  });
  return { nodes: changed ? next : (nodes ?? []), changed };
}

/**
 * Add a node to the forest.
 *
 * @returns a new array.
 */
export function addNode(nodes, node) {
  return [...(nodes ?? []), node];
}

/**
 * Replace one node by id.
 *
 * @returns a new array; a missing id returns the same nodes.
 */
export function updateNode(nodes, id, patch) {
  let touched = false;
  const next = (nodes ?? []).map((node) => {
    if (node.id !== id) return node;
    touched = true;
    return { ...node, ...patch };
  });
  return touched ? next : (nodes ?? []);
}

/**
 * Remove a node and everything under it.
 *
 * @returns a new array.
 */
export function removeNode(nodes, id) {
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes ?? []) {
      if (node.parentId != null && doomed.has(node.parentId) && !doomed.has(node.id)) {
        doomed.add(node.id);
        grew = true;
      }
    }
  }
  return (nodes ?? []).filter((node) => !doomed.has(node.id));
}

/**
 * Flip a node's understanding status.
 *
 * @returns a new array with that node toggled.
 */
export function toggleStatus(nodes, id) {
  return (nodes ?? []).map((node) =>
    node.id === id
      ? { ...node, status: node.status === STATUS_CLEAR ? STATUS_UNCLEAR : STATUS_CLEAR }
      : node,
  );
}

/** Find a node by id. */
export function findNode(nodes, id) {
  return (nodes ?? []).find((node) => node.id === id);
}

/**
 * Flatten the forest into display rows, depth first, oldest sibling first.
 *
 * @returns `[{ node, depth, last, ancestorLast }]`.
 */
export function flattenForest(nodes) {
  const list = nodes ?? [];
  const byParent = new Map();
  const known = new Set(list.map((node) => node.id));
  for (const node of list) {
    const parentId = node.parentId != null && known.has(node.parentId) ? node.parentId : null;
    const bucket = byParent.get(parentId);
    if (bucket === undefined) byParent.set(parentId, [node]);
    else bucket.push(node);
  }
  const rows = [];
  const walk = (parentId, depth, ancestorLast) => {
    const children = (byParent.get(parentId) ?? [])
      .slice()
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
    children.forEach((node, index) => {
      const last = index === children.length - 1;
      rows.push({ node, depth, last, ancestorLast });
      walk(node.id, depth + 1, [...ancestorLast, last]);
    });
  };
  walk(null, 0, []);
  return rows;
}

/** Draw the connector prefix for one row (kept for the future minimap). */
export function connectorOf(row) {
  const parts = [];
  for (let index = 0; index < row.depth; index += 1) {
    parts.push(row.ancestorLast[index] ? '   ' : '│  ');
  }
  parts.push(row.last ? '└─ ' : '├─ ');
  return parts.join('');
}

/**
 * Counts for the header.
 *
 * @returns `{ total, unclear, clear, questions, waiting, answered }`.
 */
export function summarize(nodes) {
  const list = nodes ?? [];
  const questions = list.flatMap((node) => node.questions ?? []);
  const clear = list.filter((node) => node.status === STATUS_CLEAR).length;
  return {
    total: list.length,
    unclear: list.length - clear,
    clear,
    questions: questions.length,
    waiting: questions.filter((question) => question.answeredAt == null).length,
    answered: questions.filter((question) => question.answeredAt != null).length,
  };
}

/**
 * Choose the parent for a selection made now.
 *
 * Only an explicit selection names a parent. Creating a node does not move the
 * cursor, otherwise two sibling selections would nest.
 *
 * @returns a node id, or null for a root.
 */
export function parentFor(nodes, selectedId) {
  const list = nodes ?? [];
  if (selectedId == null) return null;
  return list.some((node) => node.id === selectedId) ? selectedId : null;
}

/**
 * Neutralize markdown control characters inside a quote.
 *
 * The quote is inserted into a markdown-ish composer and later rendered as
 * markdown, so a backtick from the source text would turn the whole draft into
 * a code block and cost the quote its rendering. The node keeps the original
 * text; only the wire copy is normalized.
 *
 * @param text - selected text.
 * @returns text safe to inline into a message.
 */
export function sanitizeQuote(text) {
  return String(text ?? '')
    .replace(/`/g, "'")
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose the message that actually leaves the plugin.
 *
 * The referent has to travel with the question: a message of only「这是什么」
 * gives the model nothing to resolve「这」against.
 *
 * @returns the message to send.
 */
export function composeMessage(question, quote, max = 200) {
  const asked = String(question ?? '').trim();
  // A node may hold several passages, and they stay separate units: gluing them
  // into one string would read as a single continuous excerpt.
  const passages = (Array.isArray(quote) ? quote : [quote])
    .map((item) => sanitizeQuote(item))
    .filter((item) => item !== '');
  if (passages.length === 0) return asked;
  const rendered = passages.map((item) => `「${oneLine(item, max)}」`).join('');
  if (asked === '') return rendered;
  if (asked.includes(passages[0])) return asked;
  return `${rendered}——${asked}`;
}

/**
 * The quote a node descends from, so a question can carry its referent.
 *
 * @returns the nearest ancestor quote (or the node's own), or ''.
 */
export function nearestQuote(nodes, id) {
  const node = findNode(nodes, id);
  return node == null ? '' : String(node.quote ?? '');
}

/**
 * Convert stored records to the current shape.
 *
 * v3 kept questions as nodes. They become annotations on their owning quote,
 * and quote children of a question are re-parented to that quote, so an old
 * tree keeps its shape after the change.
 *
 * @param stored - whatever was in storage.
 * @returns quote nodes with attached questions.
 */
export function migrateNodes(stored) {
  const list = Array.isArray(stored) ? stored.filter((node) => node != null && typeof node.id === 'string') : [];
  const byId = new Map(list.map((node) => [node.id, node]));
  const quotes = list
    .filter((node) => node.kind !== 'question')
    .map((node) => ({
      ...node,
      parentId: node.parentId ?? null,
      questions: Array.isArray(node.questions) ? node.questions.slice() : [],
    }));
  const quoteById = new Map(quotes.map((node) => [node.id, node]));

  const quoteAncestorOf = (id) => {
    let current = id == null ? undefined : byId.get(id);
    const seen = new Set();
    while (current != null && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.kind !== 'question') return current.id;
      current = current.parentId == null ? undefined : byId.get(current.parentId);
    }
    return null;
  };

  for (const node of list) {
    if (node.kind !== 'question') continue;
    const ownerId = quoteAncestorOf(node.parentId);
    const owner = ownerId == null ? undefined : quoteById.get(ownerId);
    if (owner === undefined) continue;
    owner.questions.push({
      id: node.id,
      text: String(node.text ?? ''),
      createdAt: Number(node.createdAt ?? 0),
      ...(node.sentAt === undefined ? {} : { sentAt: node.sentAt }),
      ...(node.answeredAt === undefined ? {} : { answeredAt: node.answeredAt }),
    });
  }

  for (const node of quotes) {
    if (node.parentId == null || quoteById.has(node.parentId)) continue;
    const ownerId = quoteAncestorOf(node.parentId);
    node.parentId = ownerId != null && quoteById.has(ownerId) ? ownerId : null;
  }

  return quotes;
}
