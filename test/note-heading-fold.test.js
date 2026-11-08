import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { collectNoteHeadings, NoteDetails, NoteSummary, setHeadingSectionCollapsed } from '../src/note-details.js';

const schema = getSchema([StarterKit.configure({ codeBlock: false }), NoteDetails, NoteSummary]);
const heading = (level, title) => schema.nodes.heading.create({ level }, schema.text(title));

test('outline folding wraps a heading section, retains nested headings, and reopens the body', () => {
  let doc = schema.nodes.doc.create(null, [
    heading(1, 'Top'),
    schema.nodes.paragraph.create(null, schema.text('Top body')),
    heading(2, 'Nested'),
    schema.nodes.paragraph.create(null, schema.text('Nested body')),
    heading(1, 'Next'),
    schema.nodes.paragraph.create(null, schema.text('Next body')),
  ]);
  let tr = EditorState.create({ schema, doc }).tr;
  assert.equal(setHeadingSectionCollapsed(tr, 0, true), true);
  doc = tr.doc;
  assert.equal(doc.firstChild.type.name, 'details');
  assert.equal(doc.firstChild.firstChild.type.name, 'summary');
  assert.equal(doc.firstChild.firstChild.textContent, 'Top');
  assert.equal(doc.firstChild.firstChild.attrs.level, 1);
  assert.equal(collectNoteHeadings(doc)[0].collapsed, true);
  assert.equal(collectNoteHeadings(doc)[1].text, 'Nested');
  assert.equal(doc.child(1).firstChild.textContent, 'Next');

  tr = EditorState.create({ schema, doc }).tr;
  const folded = collectNoteHeadings(doc)[0];
  assert.equal(setHeadingSectionCollapsed(tr, folded.pos, false), true);
  assert.equal(collectNoteHeadings(tr.doc)[0].collapsed, false);
  assert.equal(tr.doc.firstChild.attrs.open, true);
});

test('nested headings can be folded independently and empty sections remain valid', () => {
  const doc = schema.nodes.doc.create(null, [heading(1, 'Top'), heading(2, 'Leaf')]);
  const tr = EditorState.create({ schema, doc }).tr;
  const leaf = collectNoteHeadings(doc)[1];
  assert.equal(setHeadingSectionCollapsed(tr, leaf.pos, true), true);
  assert.equal(tr.doc.firstChild.type.name, 'heading');
  assert.equal(tr.doc.child(1).type.name, 'details');
  assert.equal(tr.doc.child(1).childCount, 2);
  assert.equal(tr.doc.child(1).child(1).type.name, 'paragraph');
});

test('folded heading level survives HTML rendering for persistence and reload', () => {
  const rendered = NoteSummary.config.renderHTML({ HTMLAttributes: { 'data-note-heading-level': 2 } });
  assert.deepEqual(rendered.slice(0, 2), ['summary', { 'data-note-heading-level': 2 }]);
});
