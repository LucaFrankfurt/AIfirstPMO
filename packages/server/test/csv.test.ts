/**
 * Reading a CSV that came out of something else.
 *
 * Every case here is a shape a real export actually has. The interesting ones
 * are not "does it split on commas" but the four that turn an import into a
 * silent mess: a semicolon file from a German Excel, a quoted field with a
 * newline in it, a byte-order mark, and a row that is short because its last
 * columns were empty.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv, parseCsvRows, sniffDelimiter } from '@kolibri/shared';

describe('splitting the file', () => {
  it('keeps a quoted field together, commas and all', () => {
    const rows = parseCsvRows('a,"b,still b",c\n');
    assert.deepEqual(rows, [['a', 'b,still b', 'c']]);
  });

  it('keeps a newline inside a quoted field', () => {
    // A description written in a textarea is the usual source of these, and a
    // line-based parser turns one task into two broken ones.
    const rows = parseCsvRows('title,description\n"Fix it","line one\nline two"\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[1][1], 'line one\nline two');
  });

  it('reads a doubled quote as one quote', () => {
    assert.deepEqual(parseCsvRows('a,"say ""hi""",c'), [['a', 'say "hi"', 'c']]);
  });

  it('ends a record on CRLF and on a lone CR', () => {
    assert.deepEqual(parseCsvRows('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(parseCsvRows('a,b\rc,d'), [['a', 'b'], ['c', 'd']]);
  });

  it('does not invent a last empty record', () => {
    assert.equal(parseCsvRows('a,b\nc,d\n').length, 2);
    assert.equal(parseCsvRows('a,b\nc,d').length, 2);
  });
});

describe('guessing the delimiter', () => {
  it('picks the semicolon a German Excel writes', () => {
    // Without this the whole file parses as one enormous column, which is the
    // most common "your import is broken".
    const text = 'Titel;Beschreibung;Priorität\nAufgabe;Etwas, mit Komma;hoch\n';
    assert.equal(sniffDelimiter(text), ';');
    const table = parseCsv(text);
    assert.deepEqual(table.columns, ['Titel', 'Beschreibung', 'Priorität']);
    assert.equal(table.rows[0]['Beschreibung'], 'Etwas, mit Komma');
  });

  it('is not fooled by prose full of commas', () => {
    // Counting occurrences alone picks the comma here; consistency does not.
    const text = [
      'title\tdescription',
      'One\tfirst, second, third, fourth',
      'Two\ta, b, c',
    ].join('\n');
    assert.equal(sniffDelimiter(text), '\t');
  });

  it('falls back to a comma when there is nothing to go on', () => {
    assert.equal(sniffDelimiter('title\nOne\nTwo'), ',');
    assert.equal(sniffDelimiter(''), ',');
  });
});

describe('reading it as records', () => {
  it('drops the byte-order mark Excel writes and never mentions', () => {
    const table = parseCsv('﻿title,priority\nShip it,high\n');
    assert.deepEqual(table.columns, ['title', 'priority'], 'not "\\ufefftitle"');
    assert.equal(table.rows[0].title, 'Ship it');
  });

  it('pads a short row rather than refusing it', () => {
    // Trailing empty columns are routinely omitted by exporters.
    const table = parseCsv('title,assignee,due\nA task\n');
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0].assignee, '');
    assert.equal(table.rows[0].due, '');
  });

  it('keeps values a row has beyond its header', () => {
    const table = parseCsv('title\nA,extra\n');
    assert.equal(table.rows[0].column_2, 'extra', 'nothing is dropped silently');
  });

  it('gives duplicate headers distinct names', () => {
    const table = parseCsv('name,name\nleft,right\n');
    assert.deepEqual(table.columns, ['name', 'name_2']);
    assert.equal(table.rows[0].name_2, 'right');
  });

  it('names an unnamed column rather than keying on empty string', () => {
    const table = parseCsv('title,,priority\nA,B,C\n');
    assert.equal(table.columns[1], 'column_2');
    assert.equal(table.rows[0].column_2, 'B');
  });

  it('skips blank lines in the middle of a file', () => {
    const table = parseCsv('title\nA\n\nB\n');
    assert.deepEqual(table.rows.map((row) => row.title), ['A', 'B']);
  });

  it('returns nothing for an empty file rather than throwing', () => {
    assert.deepEqual(parseCsv(''), { columns: [], rows: [], delimiter: ',' });
  });
});
