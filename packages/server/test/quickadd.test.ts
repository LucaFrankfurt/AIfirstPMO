/**
 * Typing a whole task on one line.
 *
 * Two things are worth pinning down and they pull against each other: the
 * parser has to recognise enough to be worth using, and it must never eat a
 * word somebody meant to keep. Most of the tests below are the second kind.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQuickAdd, readQuickDate, readRepeat, type Vocabulary } from '@kolibri/shared';

/** A Wednesday, so "next friday" and "next monday" go opposite ways round. */
const TODAY = '2026-08-19';

const vocabulary: Vocabulary = {
  today: TODAY,
  meId: 'u-me',
  people: [
    { id: 'u-ada', name: 'Ada Lovelace' },
    { id: 'u-alan', name: 'Alan Turing' },
    { id: 'u-me', name: 'Grace Hopper' },
    // Two people whose first names collide, on purpose.
    { id: 'u-alex-1', name: 'Alex Stone' },
    { id: 'u-alex-2', name: 'Alex Rivers' },
  ],
  projects: [
    { id: 'p-web', key: 'WEB', name: 'Website' },
    { id: 'p-api', key: 'API', name: 'Public API' },
  ],
  labels: [
    { id: 'l-design', name: 'design' },
    { id: 'l-needs', name: 'needs research' },
  ],
};

const parse = (input: string) => parseQuickAdd(input, vocabulary);

describe('what a line can say', () => {
  it('reads all of it at once and leaves a clean title', () => {
    const out = parse('Redraw the empty state !high @ada #WEB *design due:friday');
    assert.equal(out.title, 'Redraw the empty state');
    assert.equal(out.priority, 'high');
    assert.deepEqual(out.assignees, ['u-ada']);
    assert.equal(out.projectId, 'p-web');
    assert.deepEqual(out.labels, ['l-design']);
    assert.equal(out.dueDate, '2026-08-21');   // the Friday after a Wednesday
    assert.equal(out.found.length, 5);
  });

  it('reads a token wherever it is, not only at the end', () => {
    const out = parse('!urgent Fix @alan the login loop #API');
    assert.equal(out.title, 'Fix the login loop');
    assert.equal(out.priority, 'urgent');
    assert.deepEqual(out.assignees, ['u-alan']);
    assert.equal(out.projectId, 'p-api');
  });

  it('takes a quoted name with a space in it', () => {
    const out = parse('Write it up @"Ada Lovelace" *"needs research"');
    assert.deepEqual(out.assignees, ['u-ada']);
    assert.deepEqual(out.labels, ['l-needs']);
    assert.equal(out.title, 'Write it up');
  });

  it('numbers priorities the way every tool that numbers them does', () => {
    assert.equal(parse('x !1').priority, 'urgent');
    assert.equal(parse('x !2').priority, 'high');
    assert.equal(parse('x !3').priority, 'medium');
    assert.equal(parse('x !4').priority, 'low');
  });

  it('knows @me', () => {
    assert.deepEqual(parse('Ring the bank @me').assignees, ['u-me']);
  });

  it('takes more than one assignee and more than one label', () => {
    const out = parse('Pair on it @ada @alan *design');
    assert.deepEqual(out.assignees, ['u-ada', 'u-alan']);
    assert.deepEqual(out.labels, ['l-design']);
  });

  it('finds a project by name as well as by key', () => {
    assert.equal(parse('x #"Public API"').projectId, 'p-api');
    assert.equal(parse('x #Website').projectId, 'p-web');
  });

  it('reads a repeat', () => {
    assert.equal(parse('Send the invoice every:monthly').recurrence, 'monthly');
    assert.equal(parse('Standup every:2w').recurrence, 'weekly:2');
    assert.equal(parse('Water them repeat:daily').recurrence, 'daily');
  });

  it('says what it took, so the interface can show it', () => {
    const out = parse('Ship it !urgent due:tomorrow');
    assert.deepEqual(out.found.map((entry) => entry.kind), ['priority', 'due']);
    assert.equal(out.found[0].token, '!urgent');
    assert.equal(out.found[1].label, '2026-08-20');
  });
});

describe('what it must not eat', () => {
  it('leaves a sigil it does not recognise exactly where it was typed', () => {
    // The whole reason the vocabulary is passed in rather than guessed at.
    const out = parse('This is !important and @nobody cares about #hashtags or *stars');
    assert.equal(out.title, 'This is !important and @nobody cares about #hashtags or *stars');
    assert.equal(out.priority, undefined);
    assert.deepEqual(out.assignees, []);
    assert.equal(out.projectId, undefined);
    assert.deepEqual(out.labels, []);
    assert.equal(out.found.length, 0);
  });

  it('does not read a date out of the middle of a sentence', () => {
    // The bug this design exists to avoid: "Meeting Monday" losing its Monday.
    const out = parse('Meeting Monday about tomorrow and next friday');
    assert.equal(out.title, 'Meeting Monday about tomorrow and next friday');
    assert.equal(out.dueDate, undefined);
  });

  it('refuses an ambiguous first name rather than picking one', () => {
    // Two people called Alex. Assigning to the wrong one quietly is worse than
    // assigning to nobody loudly.
    const out = parse('Ask about it @alex');
    assert.deepEqual(out.assignees, []);
    assert.equal(out.title, 'Ask about it @alex');
  });

  it('needs whitespace in front of a sigil, so an address survives', () => {
    const out = parse('Email ada@example.com about the C*n macro');
    assert.equal(out.title, 'Email ada@example.com about the C*n macro');
    assert.deepEqual(out.assignees, []);
  });

  it('leaves a date it cannot read in the title rather than dropping it', () => {
    const out = parse('Book it due:whenever');
    assert.equal(out.title, 'Book it due:whenever');
    assert.equal(out.dueDate, undefined);
  });

  it('does not invent fields nobody typed', () => {
    const out = parse('Just a task');
    assert.equal(out.title, 'Just a task');
    assert.equal(out.priority, undefined, 'so a form can keep its own default');
    assert.equal(out.dueDate, undefined);
    assert.equal(out.recurrence, undefined);
    assert.equal(out.projectId, undefined);
  });

  it('tidies the whitespace a removed token leaves behind', () => {
    assert.equal(parse('Ship   it !urgent   now').title, 'Ship it now');
    assert.equal(parse('!urgent Ship it').title, 'Ship it');
    assert.equal(parse('Ship it !urgent').title, 'Ship it');
  });

  it('survives a line that is only tokens', () => {
    const out = parse('!urgent @ada');
    assert.equal(out.title, '');
    assert.equal(out.priority, 'urgent');
  });
});

describe('the dates', () => {
  it('reads today, tomorrow and an ISO date', () => {
    assert.equal(readQuickDate('today', TODAY), TODAY);
    assert.equal(readQuickDate('tomorrow', TODAY), '2026-08-20');
    assert.equal(readQuickDate('2026-12-24', TODAY), '2026-12-24');
  });

  it('reads a weekday as the next one, never today', () => {
    // TODAY is a Wednesday.
    assert.equal(readQuickDate('friday', TODAY), '2026-08-21');
    assert.equal(readQuickDate('monday', TODAY), '2026-08-24');
    assert.equal(readQuickDate('wednesday', TODAY), '2026-08-26', 'the next one, not today');
  });

  it('reads a relative offset', () => {
    assert.equal(readQuickDate('+3d', TODAY), '2026-08-22');
    assert.equal(readQuickDate('+2w', TODAY), '2026-09-02');
    assert.equal(readQuickDate('+1m', TODAY), '2026-09-19');
  });

  it('keeps a month-end offset inside the month', () => {
    assert.equal(readQuickDate('+1m', '2026-01-31'), '2026-02-28');
  });

  it('speaks the other two languages', () => {
    assert.equal(readQuickDate('heute', TODAY), TODAY);
    assert.equal(readQuickDate('morgen', TODAY), '2026-08-20');
    assert.equal(readQuickDate('freitag', TODAY), '2026-08-21');
    assert.equal(readQuickDate('demain', TODAY), '2026-08-20');
    assert.equal(readQuickDate('vendredi', TODAY), '2026-08-21');
  });

  it('refuses what it cannot read rather than guessing', () => {
    for (const bad of ['', 'soon', 'next quarter', '2026-13-40', 'friday-ish', '+3x']) {
      assert.equal(readQuickDate(bad, TODAY), null, `${bad} should not read as a date`);
    }
  });
});

describe('the repeats', () => {
  it('reads the three the scheduler can honour', () => {
    assert.equal(readRepeat('daily'), 'daily');
    assert.equal(readRepeat('weekly'), 'weekly');
    assert.equal(readRepeat('monthly'), 'monthly');
    assert.equal(readRepeat('2w'), 'weekly:2');
    assert.equal(readRepeat('every 3 days'), 'daily:3');
    assert.equal(readRepeat('wöchentlich'), 'weekly');
    assert.equal(readRepeat('jeden Monat'), 'monthly');
    assert.equal(readRepeat('chaque semaine'), 'weekly');
  });

  it('refuses what it cannot express', () => {
    for (const bad of ['every 3rd friday', 'yearly', 'sometimes', '', '0w']) {
      assert.equal(readRepeat(bad), null, `${bad} should not read as a repeat`);
    }
  });
});
