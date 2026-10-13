import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState as CodeMirrorState } from '@codemirror/state';
import { Schema } from 'prosemirror-model';
import { EditorState as ProseMirrorState, Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import {
  buildLargeDocumentFindDecorations,
  findHighlightPlugin,
  largeDocumentFindHighlights,
  setEditorFindHighlights,
  setLargeDocumentFindHighlights
} from '../src/find-highlights.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {}
  }
});

function editorFixture(kind) {
  const plugins = findHighlightPlugin({
    pmState: { Plugin },
    pmView: { Decoration, DecorationSet }
  });
  const plugin = plugins[kind][0]();
  const view = {
    state: ProseMirrorState.create({
      schema,
      doc: schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('cat and cat')])
      ]),
      plugins: [plugin]
    }),
    dispatch(transaction) {
      assert.equal(transaction.scrolledIntoView, false);
      this.state = this.state.apply(transaction);
    }
  };
  return { view, decorations: () => plugin.getState(view.state).find() };
}

for (const kind of ['markdownPlugins', 'wysiwygPlugins']) {
  test(`${kind} highlights all hits without moving selection or changing text`, () => {
    const { view, decorations } = editorFixture(kind);
    const selection = view.state.selection;
    const text = view.state.doc.textContent;
    const matches = [{ from: 1, to: 4 }, { from: 9, to: 12 }];

    setEditorFindHighlights(view, matches, 0);
    assert.deepEqual(decorations().map(({ from, to, type }) => ({
      from, to, className: type.attrs.class
    })), [
      { from: 1, to: 4, className: 'find-match find-match-active' },
      { from: 9, to: 12, className: 'find-match' }
    ]);
    assert.equal(view.state.selection.eq(selection), true);
    assert.equal(view.state.doc.textContent, text);

    setEditorFindHighlights(view, matches, 1);
    assert.equal(decorations()[1].type.attrs.class, 'find-match find-match-active');
    setEditorFindHighlights(view);
    assert.equal(decorations().length, 0);
  });
}

test('editor edits discard highlights from the previous document revision', () => {
  const { view, decorations } = editorFixture('wysiwygPlugins');
  setEditorFindHighlights(view, [{ from: 1, to: 4 }], 0);
  view.dispatch(view.state.tr.insertText('changed ', 1));
  assert.equal(decorations().length, 0);
});

test('unmapped editor hits are skipped without changing the active hit index', () => {
  const { view, decorations } = editorFixture('markdownPlugins');
  setEditorFindHighlights(view, [null, { from: 9, to: 12 }, { from: 1, to: 4 }], 1);
  assert.deepEqual(decorations().map(({ from, type }) => ({
    from, className: type.attrs.class
  })), [
    { from: 1, className: 'find-match' },
    { from: 9, className: 'find-match find-match-active' }
  ]);
});

function largeState(doc, matches, activeIndex = 0) {
  return CodeMirrorState.create({ doc, extensions: largeDocumentFindHighlights })
    .update({ effects: setLargeDocumentFindHighlights.of({ matches, activeIndex }) }).state;
}

function visibleDecorations(state, visibleRanges) {
  const results = [];
  buildLargeDocumentFindDecorations({ state, visibleRanges })
    .between(0, state.doc.length, (from, to, decoration) => {
      results.push({ from, to, className: decoration.spec.class });
    });
  return results;
}

test('large-document highlights follow the viewport and keep the active hit distinct', () => {
  const state = largeState('cat gap cat gap cat', [
    { from: 0, to: 3 }, { from: 8, to: 11 }, { from: 16, to: 19 }
  ], 1);
  assert.deepEqual(visibleDecorations(state, [{ from: 1, to: 10 }]), [
    { from: 1, to: 3, className: 'find-match' },
    { from: 8, to: 10, className: 'find-match find-match-active' }
  ]);
  assert.deepEqual(visibleDecorations(state, [{ from: 16, to: 19 }]), [
    { from: 16, to: 19, className: 'find-match' }
  ]);
});

test('large-document highlights handle disjoint visible ranges and boundary hits', () => {
  const state = largeState('abcdefghijklmnop', [{ from: 2, to: 12 }]);
  assert.deepEqual(visibleDecorations(state, [
    { from: 0, to: 2 }, { from: 4, to: 6 }, { from: 8, to: 14 }
  ]), [
    { from: 4, to: 6, className: 'find-match find-match-active' },
    { from: 8, to: 12, className: 'find-match find-match-active' }
  ]);
});

test('large-document tail search decorates only visible matches', () => {
  const matches = Array.from({ length: 50000 }, (_, index) => ({
    from: index * 4,
    to: index * 4 + 3
  }));
  const state = largeState('cat '.repeat(matches.length), matches, 49999);
  const results = visibleDecorations(state, [{ from: 199990, to: 200000 }]);
  assert.equal(results.length, 3);
  assert.ok(results.every(({ from, to }) => from >= 199990 && to <= 200000));
  assert.equal(results[2].className, 'find-match find-match-active');
});

test('large-document edits clear stale highlights, and a new query restores them', () => {
  let state = largeState('cat gap cat', [{ from: 0, to: 3 }, { from: 8, to: 11 }]);
  state = state.update({ changes: { from: 0, insert: 'x ' } }).state;
  assert.deepEqual(visibleDecorations(state, [{ from: 0, to: state.doc.length }]), []);
  state = state.update({
    effects: setLargeDocumentFindHighlights.of({
      matches: [{ from: 2, to: 5 }, { from: 10, to: 13 }], activeIndex: 0
    })
  }).state;
  assert.equal(visibleDecorations(state, [{ from: 0, to: state.doc.length }]).length, 2);
  state = state.update({
    effects: setLargeDocumentFindHighlights.of({ matches: [], activeIndex: -1 })
  }).state;
  assert.deepEqual(visibleDecorations(state, [{ from: 0, to: state.doc.length }]), []);
});
