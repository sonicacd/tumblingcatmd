export function visibleFindRange(snapshot, match) {
  if (!match) return null;
  let first = match.from;
  let last = match.to - 1;
  while (first <= last && !snapshot.spans[first]?.node) first += 1;
  while (last >= first && !snapshot.spans[last]?.node) last -= 1;
  if (first > last) {
    const separator = snapshot.spans[match.from];
    const node = separator?.afterNode || separator?.beforeNode;
    if (!node) return null;
    const range = node.ownerDocument.createRange();
    range.setStart(node, separator.afterNode ? 0 : node.length);
    range.collapse(true);
    return range;
  }
  const start = snapshot.spans[first];
  const end = snapshot.spans[last];
  const range = start.node.ownerDocument.createRange();
  range.setStart(start.node, start.from);
  range.setEnd(end.node, end.to);
  return range;
}

export function scrollFindRangeIntoView(range, scroller) {
  if (!range || !scroller) return;
  // Use the matched characters, including their wrapped line, as the target.
  const rect = [...range.getClientRects()].find((item) => item.height);
  if (!rect) return;
  const bounds = scroller.getBoundingClientRect();
  if (rect.top < bounds.top + 12 || rect.bottom > bounds.bottom - 12) {
    scroller.scrollTop += rect.top - bounds.top - (scroller.clientHeight - rect.height) / 2;
  }
  if (rect.left < bounds.left || rect.right > bounds.right) {
    scroller.scrollLeft += rect.left - bounds.left - scroller.clientWidth / 2;
  }
}

export function clearVisibleFindHighlights(root) {
  const registry = root.ownerDocument.defaultView.CSS?.highlights;
  registry?.delete('rollcat-find');
  registry?.delete('rollcat-find-active');
  // Older WebViews use marks in the disposable reader DOM only.
  root.querySelectorAll('mark[data-find-highlight]').forEach((mark) => {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent.normalize();
  });
}

export function setVisibleFindHighlights(root, snapshot, matches, activeIndex) {
  const view = root.ownerDocument.defaultView;
  const ranges = matches.map((match) => visibleFindRange(snapshot, match));
  if (view.CSS?.highlights && view.Highlight) {
    const all = new view.Highlight();
    ranges.forEach((range) => { if (range) all.add(range); });
    const active = new view.Highlight();
    if (ranges[activeIndex]) active.add(ranges[activeIndex]);
    active.priority = 1;
    view.CSS.highlights.set('rollcat-find', all);
    view.CSS.highlights.set('rollcat-find-active', active);
    return ranges[activeIndex] || null;
  }

  let activeMark = null;
  // Work backwards so splitting a Text node leaves earlier offsets intact.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    for (let end = match.to - 1; end >= match.from;) {
      const span = snapshot.spans[end];
      if (!span?.node) { end -= 1; continue; }
      let start = end;
      while (start > match.from && snapshot.spans[start - 1]?.node === span.node) start -= 1;
      const text = span.node;
      const from = snapshot.spans[start].from;
      if (span.to < text.length) text.splitText(span.to);
      const matchedText = from ? text.splitText(from) : text;
      const mark = root.ownerDocument.createElement('mark');
      mark.dataset.findHighlight = '';
      mark.className = index === activeIndex ? 'find-match find-match-active' : 'find-match';
      matchedText.replaceWith(mark);
      mark.append(matchedText);
      if (index === activeIndex) activeMark = mark;
      end = start - 1;
    }
  }
  if (!activeMark) return ranges[activeIndex] || null;
  const activeRange = root.ownerDocument.createRange();
  activeRange.selectNodeContents(activeMark);
  return activeRange;
}
