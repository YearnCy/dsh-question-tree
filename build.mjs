/**
 * Build the client module.
 *
 * The sources live in this package (`src/`), so a clone of this repository
 * builds on its own. The Client loader gives a plugin ONE module and ONE apply,
 * so the selection hub and the tree are composed into a single module here.
 */
import { readFile, writeFile } from 'node:fs/promises';

const here = new URL('./', import.meta.url);
const read = (relative) => readFile(new URL(relative, here), 'utf8');

const hubSrc = await read('src/hub.js');
const treeSrc = await read('src/tree.js');
const modelSrc = await read('src/tree-model.mjs');

/** Every file here is a loader wrapper; the body is what we compose. */
function bodyOf(source, label) {
  const open = '  factory(require) {';
  const close = '\n  },\n});';
  const start = source.indexOf(open);
  const end = source.lastIndexOf(close);
  if (start < 0 || end < 0) throw new Error(`cannot extract the factory body of ${label}`);
  return source.slice(start + open.length, end);
}

const names = [...modelSrc.matchAll(/^export (?:function|const) (\w+)/gm)].map((match) => match[1]);
const modelBody = modelSrc.replace(/^export /gm, '');
const inlinedModel = [
  'const QTModel = (function () {',
  modelBody.trimEnd(),
  `return { ${names.join(', ')} };`,
  '})();',
].join('\n');

const hubBody = bodyOf(hubSrc, 'selection-hub').replace(
  '      apply,\n    };',
  '      apply,\n      api: API,\n    };',
);
if (!hubBody.includes('api: API')) throw new Error('hub body no longer ends with its return block');

let treeBody = bodyOf(treeSrc, 'question-tree');
if (!treeBody.includes('/*__MODEL__*/')) throw new Error('tree body lost its model marker');
treeBody = treeBody.replace('/*__MODEL__*/', () => inlinedModel);

const output = `/**
 * dsh-question-tree — standalone build.
 *
 * Composed by build.mjs from two sources:
 *   selection-hub                     selection, action bar, quote format,
 *                                     transcript chip, composer insertion
 *   question-tree/src/tree-ui.js      the tree itself
 *
 * One module, one apply: the tree receives the hub's service object directly,
 * never through ctx (a plugin cannot inject a service it provides itself).
 */
window.__ModuleLoader__.load({
  id: 'dsh-question-tree',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const Hub = (function () {
${hubBody}
    })();

    const Tree = (function () {
${treeBody}
    })();

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sessions', 'uiConversation'],
      apply(ctx) {
        Hub.apply(ctx);
        Tree.apply(ctx, Hub.api);
      },
    };
  },
});
`;

await writeFile(new URL('client.js', here), output);
console.log(`client.js written (${output.length} bytes)`);
