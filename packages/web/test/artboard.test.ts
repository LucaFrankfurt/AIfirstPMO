/**
 * Editing an artboard by pointing at it, without a browser.
 *
 * Every visual edit on a canvas is a rewrite of the board's HTML source, and
 * these are the rewrites. What they must get right is the part a screenshot
 * cannot show: that the element the frame reported is the element that
 * changes, that a move takes its line along instead of leaving a hole, and that
 * nothing the editor needed to find things — the `data-k` numbers — is ever
 * written back into what is saved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { artboard } from '@kolibri/shared';

const BOARD = `<!doctype html>
<html>
<head>
  <title>Pipeline</title>
  <style>body { font: 14px system-ui; }</style>
</head>
<body>
  <h1 style="color: #111">Pipeline</h1>
  <p>Calls this week: <strong>42</strong></p>
  <table>
    <tr><th>Lead</th><th>Stage</th></tr>
    <tr><td>Acme</td><td>Demo</td></tr>
  </table>
  <script>document.title = '<p>not markup</p>';</script>
</body>
</html>`;

/** The number of the first element with this tag, the way the frame would report a click on it. */
const kOf = (source: string, tag: string, nth = 0): number =>
  artboard.parse(source).filter((element) => element.tag === tag)[nth].k;

describe('which elements a person may pick', () => {
  it('offers what the body draws and nothing from the head', () => {
    const picked = artboard.parse(BOARD).filter((element) => element.editable).map((element) => element.tag);
    assert.deepEqual(picked, ['h1', 'p', 'strong', 'table', 'tr', 'th', 'th', 'tr', 'td', 'td']);
  });

  it('does not read markup inside a script', () => {
    assert.equal(artboard.parse(BOARD).filter((element) => element.tag === 'p').length, 1);
  });

  it('offers a drawing whole, not the paths inside it', () => {
    const source = '<div><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/><circle r="2"/></svg></div>';
    const picked = artboard.parse(source).filter((element) => element.editable).map((element) => element.tag);
    assert.deepEqual(picked, ['div', 'svg']);
  });

  it('treats a fragment with no body as all body', () => {
    assert.deepEqual(artboard.parse('<section><h2>A</h2></section>').map((element) => element.editable), [true, true]);
  });

  it('closes what HTML closes for you', () => {
    const elements = artboard.parse('<ul><li>One<li>Two</ul><p>A<p>B');
    const items = elements.filter((element) => element.tag === 'li');
    assert.equal(items[0].parent, items[1].parent, 'the second item is a sibling, not a child');
    const paragraphs = elements.filter((element) => element.tag === 'p');
    assert.equal(paragraphs[1].parent, null);
  });
});

describe('the numbers the frame finds things by', () => {
  it('are written into every editable start tag', () => {
    const annotated = artboard.annotate(BOARD);
    assert.match(annotated, /<h1 style="color: #111" data-k="\d+">/);
    assert.doesNotMatch(annotated, /<title data-k/);
    assert.doesNotMatch(annotated, /<script data-k/);
  });

  it('land inside a self-closing tag rather than after it', () => {
    assert.equal(artboard.annotate('<div><img src="a.png"/></div>'), '<div data-k="0"><img src="a.png" data-k="1"/></div>');
  });

  it('never reach what is saved', () => {
    const k = kOf(BOARD, 'p');
    const fromFrame = 'Calls this week: <strong data-k="9">43</strong>';
    const next = artboard.setInner(BOARD, k, fromFrame);
    assert.match(next, /<p>Calls this week: <strong>43<\/strong><\/p>/);
    assert.doesNotMatch(next, /data-k/);
  });
});

describe('what the inspector reads', () => {
  it('describes an element by its style, its text and where it sits', () => {
    const info = artboard.describe(BOARD, kOf(BOARD, 'h1'))!;
    assert.equal(info.tag, 'h1');
    assert.equal(info.text, 'Pipeline');
    assert.deepEqual(info.style, { color: '#111' });
    assert.deepEqual(info.path.map((one) => one.tag), ['h1']);
  });

  it('has no text field for an element that holds markup', () => {
    assert.equal(artboard.describe(BOARD, kOf(BOARD, 'p'))!.text, null);
  });

  it('knows which row and column a cell is', () => {
    assert.deepEqual(artboard.describe(BOARD, kOf(BOARD, 'td', 1))!.cell, { table: kOf(BOARD, 'table'), row: 1, column: 1 });
  });

  it('refuses an element nobody can pick', () => {
    assert.equal(artboard.describe(BOARD, kOf(BOARD, 'title')), null);
  });
});

describe('changing one element', () => {
  it('sets a style property and keeps the others', () => {
    const next = artboard.setStyle(BOARD, kOf(BOARD, 'h1'), 'font-size', '32px');
    assert.match(next, /<h1 style="color: #111; font-size: 32px">/);
  });

  it('takes a property away, and an emptied style attribute with it', () => {
    const next = artboard.setStyle(BOARD, kOf(BOARD, 'h1'), 'color', '');
    assert.match(next, /<h1>Pipeline<\/h1>/);
  });

  it('adds a style attribute to an element that had none', () => {
    assert.match(artboard.setStyle(BOARD, kOf(BOARD, 'table'), 'width', '100%'), /<table style="width: 100%">/);
  });

  it('escapes text typed into a field', () => {
    assert.match(artboard.setText(BOARD, kOf(BOARD, 'h1'), 'A <b> & co'), /<h1 style="color: #111">A &lt;b&gt; &amp; co<\/h1>/);
  });

  it('escapes an attribute value', () => {
    assert.match(artboard.setAttribute(BOARD, kOf(BOARD, 'h1'), 'title', 'say "hi"'), /title="say &quot;hi&quot;"/);
  });

  it('refuses an element that is not there', () => {
    assert.throws(() => artboard.setText(BOARD, 999, 'x'));
  });
});

describe('moving, copying and removing', () => {
  it('moves an element above its neighbour, taking its line along', () => {
    const next = artboard.move(BOARD, kOf(BOARD, 'p'), kOf(BOARD, 'h1'), 'before').source;
    assert.match(next, /<body>\n {2}<p>Calls this week: <strong>42<\/strong><\/p>\n {2}<h1 style="color: #111">Pipeline<\/h1>\n {2}<table>/);
  });

  it('moves an element below a later one', () => {
    const next = artboard.move(BOARD, kOf(BOARD, 'h1'), kOf(BOARD, 'table'), 'after').source;
    assert.match(next, /<body>\n {2}<p>/);
    assert.match(next, /<\/table>\n {2}<h1 style="color: #111">Pipeline<\/h1>\n {2}<script>/);
  });

  it('keeps every character of what it moved', () => {
    const next = artboard.move(BOARD, kOf(BOARD, 'p'), kOf(BOARD, 'table'), 'after').source;
    assert.equal(next.length, BOARD.length);
  });

  it('refuses to move an element into itself', () => {
    assert.equal(artboard.move(BOARD, kOf(BOARD, 'table'), kOf(BOARD, 'td'), 'inside').source, BOARD);
  });

  it('copies an element onto the line below it', () => {
    const next = artboard.duplicate(BOARD, kOf(BOARD, 'h1')).source;
    assert.match(next, /<h1 style="color: #111">Pipeline<\/h1>\n {2}<h1 style="color: #111">Pipeline<\/h1>/);
  });

  it('removes an element and the line it stood on', () => {
    const next = artboard.remove(BOARD, kOf(BOARD, 'h1'));
    assert.match(next, /<body>\n {2}<p>/);
  });

  it('inserts into an element after its last child, at its indent', () => {
    const next = artboard.insert(BOARD, kOf(BOARD, 'table'), 'inside', '<tr><td>New</td></tr>').source;
    assert.match(next, /<tr><td>Acme<\/td><td>Demo<\/td><\/tr>\n {4}<tr><td>New<\/td><\/tr>\n {2}<\/table>/);
  });

  it('appends to the body after its last drawn element', () => {
    const next = artboard.append(BOARD, '<p>Footer</p>').source;
    assert.match(next, /<\/script>\n {2}<p>Footer<\/p>\n<\/body>/);
  });

  it('says where the thing it moved has gone, so it can stay selected', () => {
    const moved = artboard.move(BOARD, kOf(BOARD, 'h1'), kOf(BOARD, 'table'), 'after');
    assert.equal(artboard.describe(moved.source, moved.k!)!.text, 'Pipeline');
    const copied = artboard.duplicate(BOARD, kOf(BOARD, 'h1'));
    assert.equal(copied.k, kOf(BOARD, 'h1') + 1);
    const added = artboard.append(BOARD, '<p>Footer</p>');
    assert.equal(artboard.describe(added.source, added.k!)!.text, 'Footer');
  });

  it('finds the neighbours "move up" and "move down" mean', () => {
    assert.equal(artboard.sibling(BOARD, kOf(BOARD, 'p'), -1), kOf(BOARD, 'h1'));
    assert.equal(artboard.sibling(BOARD, kOf(BOARD, 'h1'), -1), null);
  });
});

describe('tables', () => {
  it('adds an empty row below, as body cells even under a header', () => {
    const next = artboard.addRow(BOARD, kOf(BOARD, 'th'), 'below');
    assert.match(next, /<tr><th>Lead<\/th><th>Stage<\/th><\/tr>\n {4}<tr><td><\/td><td><\/td><\/tr>\n {4}<tr><td>Acme/);
  });

  it('adds a column to every row', () => {
    const next = artboard.addColumn(BOARD, kOf(BOARD, 'td'), 'right');
    assert.match(next, /<tr><th>Lead<\/th><th><\/th><th>Stage<\/th><\/tr>/);
    assert.match(next, /<tr><td>Acme<\/td><td><\/td><td>Demo<\/td><\/tr>/);
  });

  it('removes a column from every row', () => {
    const next = artboard.removeColumn(BOARD, kOf(BOARD, 'td', 1));
    assert.match(next, /<tr><th>Lead<\/th><\/tr>/);
    assert.match(next, /<tr><td>Acme<\/td><\/tr>/);
  });

  it('removes a row, and keeps the last one', () => {
    const one = artboard.removeRow(BOARD, kOf(BOARD, 'td'));
    assert.doesNotMatch(one, /Acme/);
    assert.equal(artboard.removeRow(one, kOf(one, 'th')), one);
  });
});

describe('the words on a board', () => {
  it('are what a reader sees, without scripts, styles or the title', () => {
    assert.equal(artboard.text(BOARD), 'Pipeline Calls this week: 42 Lead Stage Acme Demo');
  });
});
