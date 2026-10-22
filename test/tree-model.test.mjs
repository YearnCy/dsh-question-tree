import test from 'node:test';
import assert from 'node:assert/strict';

import {
  oneLine,
  labelOf,
  createNode,
  addQuestion,
  removeQuestion,
  markQuestionSent,
  markAnswered,
  addNode,
  updateNode,
  removeNode,
  toggleStatus,
  findNode,
  flattenForest,
  connectorOf,
  summarize,
  parentFor,
  composeMessage,
  nearestQuote,
  migrateNodes,
  sanitizeQuote,
  addQuote,
} from '../src/tree-model.mjs';

test('oneLine collapses whitespace and truncates on code points', () => {
  assert.equal(oneLine('  a\n\n  b  '), 'a b');
  const long = oneLine('字'.repeat(50), 10);
  assert.equal(Array.from(long).length, 10);
  assert.ok(long.endsWith('…'));
});

test('addQuote grows the aimed node and keeps passages separate', () => {
  const nodes = [
    createNode({ quote: '甲', anchors: [{ turn: '1' }], createdAt: 1, id: 'n' }),
  ];
  const next = addQuote(nodes, 'n', ' 乙 ', { turn: '2' });
  assert.equal(next[0].quote, '甲 乙');
  assert.deepEqual(next[0].quotes, ['甲', '乙']);
  assert.equal(next[0].anchors.length, 2);
  assert.equal(nodes[0].quotes.length, 1, 'input is not mutated');
  assert.equal(addQuote(nodes, 'missing', 'x'), nodes);
  assert.equal(addQuote(nodes, 'n', '   '), nodes);
});

test('a node can quote several passages collected one by one', () => {
  const node = createNode({
    quotes: [' 甲 ', '', '乙'],
    anchors: [{ turn: '1' }, null, { turn: '2' }],
    createdAt: 1,
    id: 'm',
  });
  assert.equal(node.quote, '甲 乙');
  assert.deepEqual(node.quotes, ['甲', '乙']);
  assert.equal(node.anchors.length, 3, 'anchors stay index-aligned with passages');
  assert.equal(node.anchors[1], null);
  assert.equal(node.anchor.turn, '1', 'the jump target is the first passage');
});

test('a single quote still fills both fields', () => {
  const node = createNode({ quote: '甲', createdAt: 1, id: 's' });
  assert.equal(node.quote, '甲');
  assert.deepEqual(node.quotes, ['甲']);
  assert.deepEqual(node.anchors, []);
});

test('a node is a quote and starts unclear with no questions', () => {
  const node = createNode({ quote: '  向量检索  ', createdAt: 1000, id: 'q1' });
  assert.equal(node.quote, '向量检索');
  assert.equal(node.status, 1);
  assert.deepEqual(node.questions, []);
  assert.equal(labelOf(node), '向量检索');
});

test('addQuestion annotates the quote instead of adding a node', () => {
  const nodes = [createNode({ quote: 'a', createdAt: 1, id: 'a' })];
  const next = addQuestion(nodes, 'a', '  这是什么  ', 2);
  assert.equal(nodes[0].questions.length, 0);
  assert.equal(next.length, 1);
  assert.equal(next[0].questions.length, 1);
  assert.equal(next[0].questions[0].text, '这是什么');
  assert.equal(next[0].questions[0].sentAt, undefined);
  assert.equal(addQuestion(nodes, 'missing', 'x', 3), nodes);
});

test('removeQuestion removes one annotation and keeps the node', () => {
  let nodes = [createNode({ quote: 'a', createdAt: 1, id: 'a' })];
  nodes = addQuestion(nodes, 'a', 'q1', 2);
  nodes = addQuestion(nodes, 'a', 'q2', 3);
  assert.equal(nodes[0].questions.length, 2);
  const next = removeQuestion(nodes, nodes[0].questions[0].id);
  assert.equal(next.length, 1);
  assert.deepEqual(
    next[0].questions.map((question) => question.text),
    ['q2'],
  );
  assert.equal(removeQuestion(nodes, 'nope'), nodes);
});

test('markQuestionSent stamps only the addressed question', () => {
  let nodes = [createNode({ quote: 'a', createdAt: 1, id: 'a' })];
  nodes = addQuestion(nodes, 'a', 'q1', 2);
  nodes = addQuestion(nodes, 'a', 'q2', 3);
  const [first, second] = nodes[0].questions;
  const next = markQuestionSent(nodes, first.id, 500);
  assert.equal(next[0].questions[0].sentAt, 500);
  assert.equal(next[0].questions[1].sentAt, undefined);
  assert.equal(markQuestionSent(nodes, second.id, 600)[0].questions[1].sentAt, 600);
});

test('markAnswered ignores questions sent after the turn finished', () => {
  let nodes = [createNode({ quote: 'a', createdAt: 1, id: 'a' })];
  nodes = addQuestion(nodes, 'a', 'old', 2);
  nodes = addQuestion(nodes, 'a', 'new', 3);
  const [oldQuestion, newQuestion] = nodes[0].questions;
  nodes = markQuestionSent(nodes, oldQuestion.id, 100);
  nodes = markQuestionSent(nodes, newQuestion.id, 900);

  const { nodes: next, changed } = markAnswered(nodes, 500);
  assert.equal(changed, true);
  assert.equal(next[0].questions[0].answeredAt, 500);
  assert.equal(next[0].questions[1].answeredAt, undefined);
});

test('markAnswered is a no-op without work or without a valid time', () => {
  let nodes = [createNode({ quote: 'a', createdAt: 1, id: 'a' })];
  nodes = addQuestion(nodes, 'a', 'q', 2);
  const id = nodes[0].questions[0].id;
  const sent = markQuestionSent(nodes, id, 100);
  markAnswered(sent, 200);
  const answered = markAnswered(sent, 200).nodes;
  assert.equal(markAnswered(answered, 300).changed, false);
  assert.equal(markAnswered(sent, Number.NaN).changed, false);
  assert.equal(markAnswered([], 500).changed, false);
});

test('addNode and updateNode do not mutate the input', () => {
  const base = [createNode({ quote: 'a', createdAt: 1, id: 'a' })];
  const grown = addNode(base, createNode({ quote: 'b', createdAt: 2, id: 'b' }));
  assert.equal(base.length, 1);
  const patched = updateNode(grown, 'b', { quote: 'B' });
  assert.equal(grown[1].quote, 'b');
  assert.equal(patched[1].quote, 'B');
  assert.equal(updateNode(grown, 'nope', { quote: 'x' }), grown);
});

test('removeNode takes the whole subtree with it', () => {
  const nodes = [
    createNode({ quote: 'root', createdAt: 1, id: 'r' }),
    createNode({ quote: 'child', createdAt: 2, id: 'c', parentId: 'r' }),
    createNode({ quote: 'grand', createdAt: 3, id: 'g', parentId: 'c' }),
    createNode({ quote: 'other', createdAt: 4, id: 'o' }),
  ];
  assert.deepEqual(
    removeNode(nodes, 'c').map((node) => node.id),
    ['r', 'o'],
  );
  assert.equal(removeNode(nodes, 'missing').length, 4);
  assert.equal(findNode(nodes, 'g').quote, 'grand');
});

test('toggleStatus only flips understanding', () => {
  const nodes = [createNode({ quote: 'a', createdAt: 1, id: 'a' })];
  const flipped = toggleStatus(nodes, 'a');
  assert.equal(nodes[0].status, 1);
  assert.equal(flipped[0].status, 2);
  assert.equal(toggleStatus(flipped, 'a')[0].status, 1);
});

test('flattenForest is depth first, oldest sibling first, with connectors', () => {
  const nodes = [
    createNode({ quote: 'b', createdAt: 2, id: 'b', parentId: 'a' }),
    createNode({ quote: 'a', createdAt: 1, id: 'a' }),
    createNode({ quote: 'a1', createdAt: 3, id: 'a1', parentId: 'b' }),
    createNode({ quote: 'c', createdAt: 4, id: 'c' }),
  ];
  const rows = flattenForest(nodes);
  assert.deepEqual(
    rows.map((row) => row.node.id),
    ['a', 'b', 'a1', 'c'],
  );
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2, 0]);
  assert.deepEqual(rows.map((row) => connectorOf(row)), ['├─ ', '│  └─ ', '│     └─ ', '└─ ']);
});

test('flattenForest draws siblings with a tee and a closing elbow', () => {
  const nodes = [
    createNode({ quote: 'a', createdAt: 1, id: 'a' }),
    createNode({ quote: 'a1', createdAt: 2, id: 'a1', parentId: 'a' }),
    createNode({ quote: 'a2', createdAt: 3, id: 'a2', parentId: 'a' }),
    createNode({ quote: 'b', createdAt: 4, id: 'b' }),
  ];
  assert.deepEqual(
    flattenForest(nodes).map((row) => connectorOf(row)),
    ['├─ ', '│  ├─ ', '│  └─ ', '└─ '],
  );
});

test('an orphan node is promoted to a root', () => {
  const rows = flattenForest([createNode({ quote: 'lost', createdAt: 1, id: 'x', parentId: 'gone' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depth, 0);
});

test('summarize counts quotes, understanding, and question states', () => {
  let nodes = [
    createNode({ quote: 'a', createdAt: 1, id: 'a', status: 1 }),
    createNode({ quote: 'b', createdAt: 2, id: 'b', status: 2 }),
  ];
  nodes = addQuestion(nodes, 'a', 'q1', 3);
  nodes = addQuestion(nodes, 'a', 'q2', 4);
  const first = nodes[0].questions[0].id;
  nodes = markQuestionSent(nodes, first, 10);
  nodes = markAnswered(nodes, 20).nodes;

  assert.deepEqual(summarize(nodes), {
    total: 2,
    unclear: 1,
    clear: 1,
    questions: 2,
    waiting: 1,
    answered: 1,
  });
  assert.deepEqual(summarize([]), {
    total: 0,
    unclear: 0,
    clear: 0,
    questions: 0,
    waiting: 0,
    answered: 0,
  });
});

test('parentFor only honours an explicit selection, otherwise root', () => {
  const nodes = [
    createNode({ quote: 'old', createdAt: 1, id: 'old' }),
    createNode({ quote: 'new', createdAt: 2, id: 'new' }),
  ];
  assert.equal(parentFor(nodes, 'old'), 'old');
  assert.equal(parentFor(nodes, 'nope'), null);
  assert.equal(parentFor(nodes, null), null);
  assert.equal(parentFor([], 'old'), null);
});

test('two creations from one cursor stay siblings instead of nesting', () => {
  const base = [createNode({ quote: 'Q', createdAt: 1, id: 'q' })];
  const cursor = 'q';
  const first = createNode({ quote: 'A', createdAt: 2, id: 'a', parentId: parentFor(base, cursor) });
  const withFirst = addNode(base, first);
  const second = createNode({ quote: 'B', createdAt: 3, id: 'b', parentId: parentFor(withFirst, cursor) });
  const rows = flattenForest(addNode(withFirst, second));
  assert.deepEqual(rows.map((row) => row.node.id), ['q', 'a', 'b']);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 1]);
});

test('composeMessage neutralizes markdown that would restructure the message', () => {
  assert.equal(
    composeMessage('这是什么', '底层是 `insertAsyncText`，可能返回 Promise。'),
    "「底层是 'insertAsyncText'，可能返回 Promise。」——这是什么",
  );
  assert.equal(composeMessage('问题', '**加粗** 和 换行\n\n第二行'), '「加粗 和 换行 第二行」——问题');
});

test('sanitizeQuote keeps the words and drops the controls', () => {
  assert.equal(sanitizeQuote('  a`b`c  '), "a'b'c");
  assert.equal(sanitizeQuote(null), '');
  assert.equal(sanitizeQuote('x\n\ny'), 'x y');
});

test('composeMessage keeps several passages as separate units', () => {
  assert.equal(
    composeMessage('怎么理解', ['甲', '乙', '丙']),
    '「甲」「乙」「丙」——怎么理解',
  );
  assert.equal(composeMessage('', ['甲', '乙']), '「甲」「乙」');
  assert.equal(composeMessage('问题', []), '问题');
});

test('composeMessage carries the referent with the question', () => {
  assert.equal(
    composeMessage('这是什么', '节点出来了但输入框没聚焦'),
    '「节点出来了但输入框没聚焦」——这是什么',
  );
});

test('composeMessage does not repeat a quote the question already contains', () => {
  assert.equal(composeMessage('「近因偏差」指的是什么', '近因偏差'), '「近因偏差」指的是什么');
});

test('composeMessage degrades to whichever side exists', () => {
  assert.equal(composeMessage('只有问题', ''), '只有问题');
  assert.equal(composeMessage('', '只有引用'), '「只有引用」');
  assert.equal(composeMessage('   ', '  '), '');
});

test('composeMessage truncates a long quote', () => {
  const message = composeMessage('这是什么', '字'.repeat(400));
  assert.ok(message.includes('…」——这是什么'));
  assert.ok(message.length < 400);
});

test('nearestQuote returns the node its own quote', () => {
  const nodes = [createNode({ quote: '原文', createdAt: 1, id: 'q' })];
  assert.equal(nearestQuote(nodes, 'q'), '原文');
  assert.equal(nearestQuote(nodes, 'missing'), '');
});

test('migrateNodes turns old question nodes into annotations', () => {
  const stored = [
    { id: 'a', parentId: null, kind: 'quote', quote: '根引用', status: 1, createdAt: 1 },
    { id: 'q1', parentId: 'a', kind: 'question', text: '问一', createdAt: 2, sentAt: 10, answeredAt: 20 },
    { id: 'b', parentId: 'q1', kind: 'quote', quote: '子引用', status: 1, createdAt: 3 },
  ];
  const nodes = migrateNodes(stored);
  assert.equal(nodes.length, 2);
  const root = nodes.find((node) => node.id === 'a');
  const child = nodes.find((node) => node.id === 'b');
  assert.equal(root.questions.length, 1);
  assert.equal(root.questions[0].text, '问一');
  assert.equal(root.questions[0].answeredAt, 20);
  // The quote that used to hang under a question now hangs under that question's quote.
  assert.equal(child.parentId, 'a');
});

test('migrateNodes tolerates junk and leaves good records alone', () => {
  assert.deepEqual(migrateNodes(null), []);
  assert.deepEqual(migrateNodes('nope'), []);
  const nodes = migrateNodes([{ id: 'a', quote: 'x', createdAt: 1 }]);
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0].questions, []);
});
