import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';

const editorHighlightMeta = 'rollcat-find-highlights';
const emptyHighlights = { matches: [], activeIndex: -1 };

function highlightClass(index, activeIndex) {
  return index === activeIndex ? 'find-match find-match-active' : 'find-match';
}

function normalizeHighlights(value, documentLength) {
  const source = value?.matches || [];
  const entries = [];
  let sorted = true;

  source.forEach((match, index) => {
    if (
      !match ||
      !Number.isInteger(match.from) ||
      !Number.isInteger(match.to) ||
      match.from < 0 ||
      match.to > documentLength ||
      match.from >= match.to
    ) {
      return;
    }

    if (entries.length && entries[entries.length - 1].from > match.from) {
      sorted = false;
    }
    entries.push({ from: match.from, to: match.to, active: index === value.activeIndex });
  });

  if (!sorted) {
    entries.sort((left, right) => left.from - right.from || left.to - right.to);
  }

  return {
    matches: entries,
    activeIndex: entries.findIndex((entry) => entry.active)
  };
}

export function findHighlightPlugin({ pmState, pmView }) {
  const { Plugin } = pmState;
  const { Decoration: EditorDecoration, DecorationSet } = pmView;
  const createPlugin = () => new Plugin({
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, previous) {
        const value = transaction.getMeta(editorHighlightMeta);

        if (value !== undefined) {
          const { matches, activeIndex } = normalizeHighlights(
            value,
            transaction.doc.content.size
          );
          return DecorationSet.create(transaction.doc, matches.map((match, index) => (
            EditorDecoration.inline(match.from, match.to, {
              class: highlightClass(index, activeIndex)
            })
          )));
        }

        // Search offsets belong to one document revision. The caller rebuilds
        // them after edits; do not leave a stale highlight over different text.
        return transaction.docChanged ? DecorationSet.empty : previous;
      }
    },
    props: {
      decorations(state) {
        return this.getState(state);
      }
    }
  });

  return { markdownPlugins: [createPlugin], wysiwygPlugins: [createPlugin] };
}

export function setEditorFindHighlights(view, matches = [], activeIndex = -1) {
  if (!view?.state?.tr) {
    return;
  }

  view.dispatch(view.state.tr.setMeta(editorHighlightMeta, { matches, activeIndex }));
}

export const setLargeDocumentFindHighlights = StateEffect.define();

const largeDocumentHighlightState = StateField.define({
  create: () => emptyHighlights,
  update(previous, transaction) {
    let value = transaction.docChanged ? emptyHighlights : previous;

    for (const effect of transaction.effects) {
      if (effect.is(setLargeDocumentFindHighlights)) {
        value = normalizeHighlights(effect.value, transaction.newDoc.length);
      }
    }

    return value;
  }
});

export function buildLargeDocumentFindDecorations(view) {
  const { matches, activeIndex } = view.state.field(largeDocumentHighlightState);
  const decorations = [];

  for (const visible of view.visibleRanges) {
    // Literal search results are sorted and do not overlap. Jump directly to
    // the first result intersecting this viewport, even near a large file's end.
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (matches[middle].to <= visible.from) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    for (let index = low; index < matches.length; index += 1) {
      const match = matches[index];
      if (match.from >= visible.to) {
        break;
      }

      const from = Math.max(match.from, visible.from);
      const to = Math.min(match.to, visible.to);
      if (from < to) {
        decorations.push(Decoration.mark({
          class: highlightClass(index, activeIndex)
        }).range(from, to));
      }
    }
  }

  return Decoration.set(decorations, true);
}

const largeDocumentHighlightView = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildLargeDocumentFindDecorations(view);
    }

    update(update) {
      if (
        update.viewportChanged ||
        update.docChanged ||
        update.startState.field(largeDocumentHighlightState) !==
          update.state.field(largeDocumentHighlightState)
      ) {
        this.decorations = buildLargeDocumentFindDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

export const largeDocumentFindHighlights = [
  largeDocumentHighlightState,
  largeDocumentHighlightView
];
