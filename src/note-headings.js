export function collectNoteHeadings(doc) {
  const headings = [];
  doc.descendants((node, pos) => {
    const foldedHeading = node.type.name === "summary" && Number(node.attrs.level) >= 1 && Number(node.attrs.level) <= 6;
    if (node.type.name !== "heading" && !foldedHeading) return;
    const $pos = doc.resolve(pos);
    const details = foldedHeading
      ? $pos.parent
      : $pos.parent.type.name === "summary" && $pos.depth > 0
        ? $pos.node($pos.depth - 1)
        : null;
    let foldable = foldedHeading && details?.type.name === "details" && details.childCount > 1;
    if (!foldable && node.type.name === "heading") {
      const index = $pos.index();
      for (let i = index + 1; i < $pos.parent.childCount; i++) {
        const sibling = $pos.parent.child(i);
        if (sibling.type.name === "heading" && sibling.attrs.level <= node.attrs.level) break;
        foldable = true;
        break;
      }
    }
    headings.push({
      text: node.textContent,
      level: foldedHeading ? Number(node.attrs.level) : node.attrs.level,
      pos,
      collapsed: Boolean(details?.type.name === "details" && !details.attrs.open),
      foldable,
    });
  });
  return headings;
}

export function setHeadingSectionCollapsed(tr, pos, collapsed) {
  const heading = tr.doc.nodeAt(pos);
  const foldedHeading = heading?.type.name === "summary" && Number(heading.attrs.level) >= 1 && Number(heading.attrs.level) <= 6;
  if (heading?.type.name !== "heading" && !foldedHeading) return false;
  const $pos = tr.doc.resolve(pos);
  const parent = $pos.parent;

  if (foldedHeading) {
    const detailsDepth = $pos.depth;
    const details = parent;
    if (details.type.name === "details") {
      if (Boolean(!details.attrs.open) === collapsed) return false;
      tr.setNodeMarkup($pos.before(detailsDepth), undefined, {
        ...details.attrs,
        open: !collapsed,
      });
      return true;
    }
  }
  if (!collapsed) return false;

  const index = $pos.index();
  const section = [];
  let end = pos + heading.nodeSize;
  for (let i = index + 1; i < parent.childCount; i++) {
    const sibling = parent.child(i);
    if (sibling.type.name === "heading" && sibling.attrs.level <= heading.attrs.level) break;
    section.push(sibling);
    end += sibling.nodeSize;
  }
  const summary = tr.doc.type.schema.nodes.summary.create(
    { level: heading.attrs.level },
    heading.content,
  );
  if (!summary) return false;
  const body = section.length ? section : [tr.doc.type.schema.nodes.paragraph.create()];
  const details = tr.doc.type.schema.nodes.details.create({ open: false }, [summary, ...body]);
  if (!details) return false;
  tr.replaceWith(pos, end, details);
  return true;
}
