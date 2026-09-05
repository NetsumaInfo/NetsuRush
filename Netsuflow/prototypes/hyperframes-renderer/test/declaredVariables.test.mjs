// The declaration is author-written text that becomes an Inspector control, so
// the failures worth testing are the ones that produce a control which looks
// fine and carries the wrong value.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  declaredVariables, decodeEntities, declaredSize, requestedSizes, parseColor,
} from '../server.mjs';

const wrap = (json) => `<html data-composition-variables='${json}'></html>`;

test('character references are decoded, as a browser would decode them', () => {
  // The shipped bug: the page rendered `what&#39;s` because the node handed
  // this exact string back as the variable's value.
  const [variable] = declaredVariables(wrap(
    '[{"id":"prompt","type":"string","default":"Hey what&#39;s up"}]',
  ));
  assert.equal(variable['default'], "Hey what's up");
});

test('non-ASCII references survive, including astral ones', () => {
  assert.equal(decodeEntities('&#8220;AI&#8221;'), '“AI”');
  assert.equal(decodeEntities('&#x1F947;'), '\u{1F947}');
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
});

test('an undecodable reference is left alone rather than losing the text', () => {
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;');
  assert.equal(decodeEntities('&notareference;'), '&notareference;');
});

test('the JSON parse comes first, so a quote reference cannot break the declaration', () => {
  // Decoding the attribute before parsing would turn these into bare quotes and
  // lose every variable in the declaration, not just this one. Parsing first
  // and decoding the values after survives it — and survives it better than a
  // browser, which decodes the attribute before its own JSON.parse.
  const declared = declaredVariables(wrap(
    '[{"id":"t","type":"string","default":"say &quot;hi&quot;"},{"id":"u","default":"x"}]',
  ));
  assert.equal(declared.length, 2);
  assert.equal(declared[0]['default'], 'say "hi"');
});

test('type spellings an authoring tool emits all resolve', () => {
  const declared = declaredVariables(wrap(JSON.stringify([
    { id: 'a', type: 'Text', default: 'x' },
    { id: 'b', type: 'integer', default: 4 },
    { id: 'c', type: 'colour', default: '#102030' },
    { id: 'd', type: 'toggle', default: true },
    { id: 'e', type: 'select', options: ['one', 'two'], default: 'two' },
  ])));
  assert.deepEqual(declared.map((v) => v.type), ['string', 'number', 'color', 'boolean', 'enum']);
});

test('a missing or unknown type is inferred from the default', () => {
  const declared = declaredVariables(wrap(JSON.stringify([
    { id: 'a', default: 12 },
    { id: 'b', default: '#abcdef' },
    { id: 'c', default: false },
    { id: 'd', default: 'plain' },
    { id: 'e', type: 'wat', default: 3.5 },
    { id: 'f', options: [{ value: 'x' }], default: 'x' },
  ])));
  assert.deepEqual(declared.map((v) => v.type),
    ['number', 'color', 'boolean', 'string', 'number', 'enum']);
});

test('a number with no bounds still gets a usable range', () => {
  const [variable] = declaredVariables(wrap('[{"id":"n","type":"number","default":40}]'));
  assert.ok(variable.min <= 40 && variable.max >= 40);
  assert.ok(variable.max > variable.min);
  assert.ok(variable.step > 0);
});

test('bounds that cannot make a range are repaired rather than emitted', () => {
  const [variable] = declaredVariables(wrap(
    '[{"id":"n","type":"number","default":1,"min":5,"max":5,"step":0}]',
  ));
  assert.ok(variable.max > variable.min);
  assert.ok(variable.step > 0);
});

test('every spelling of a colour an author writes is recognised', () => {
  // Recognising only #rrggbb was why a declared colour arrived as a text box.
  assert.deepEqual(parseColor('crimson'), { hex: '#dc143c', alpha: 1 });
  assert.deepEqual(parseColor('#5A67F2'), { hex: '#5a67f2', alpha: 1 });
  assert.deepEqual(parseColor('#abc'), { hex: '#aabbcc', alpha: 1 });
  assert.deepEqual(parseColor('rgb(90, 103, 242)'), { hex: '#5a67f2', alpha: 1 });
  assert.deepEqual(parseColor('rgb(90 103 242 / 50%)'), { hex: '#5a67f2', alpha: 0.5 });
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { hex: '#ff0000', alpha: 1 });
  assert.deepEqual(parseColor('transparent'), { hex: '#000000', alpha: 0 });
  assert.equal(parseColor('#f0'), null);
  assert.equal(parseColor('not a colour'), null);
  assert.equal(parseColor('rgb(90, 103)'), null);
});

test('alpha survives the hex forms that carry it', () => {
  assert.equal(parseColor('#5a67f280').alpha, 128 / 255);
  assert.equal(parseColor('#abc8').alpha, parseInt('88', 16) / 255);
});

test('a colour is typed as one even when the declaration does not say so', () => {
  const declared = declaredVariables(wrap(JSON.stringify([
    { id: 'a', default: 'rgb(1,2,3)' },
    { id: 'b', default: 'tomato' },
    { id: 'c', default: 'hsl(210 50% 40%)' },
  ])));
  assert.deepEqual(declared.map((v) => v.type), ['color', 'color', 'color']);
  assert.equal(declared[1]['default'], '#ff6347');
});

test('a colour keeps the spelling its author used', () => {
  // Sending #dc143c back would rewrite the composition's own `crimson`, which
  // is a change nobody made.
  const [variable] = declaredVariables(wrap('[{"id":"c","type":"color","default":"crimson"}]'));
  assert.equal(variable.original, 'crimson');
  assert.equal(variable['default'], '#dc143c');
});

test('an unrecognisable colour default falls back rather than reaching the control', () => {
  const [variable] = declaredVariables(wrap(
    '[{"id":"c","type":"color","default":"chartreuse-ish"}]',
  ));
  assert.equal(variable['default'], '#ffffff');
});

test('a suffixed default is a number, and the suffix survives in unit and shape', () => {
  const declared = declaredVariables(wrap(JSON.stringify([
    { id: 'pad', default: '16px' },
    { id: 'gap', type: 'number', default: '1.5em', min: '0em', max: '4em' },
    { id: 'load', default: '50%' },
    { id: 'speed', default: '2x' },
  ])));
  assert.deepEqual(declared.map((v) => v.type), ['number', 'number', 'number', 'number']);
  assert.deepEqual(declared.map((v) => v['default']), [16, 1.5, 50, 2]);
  assert.deepEqual(declared.map((v) => v.suffix), ['px', 'em', '%', 'x']);
  assert.deepEqual(declared.map((v) => v.unit), ['px', 'em', '%', 'x']);
  // The suffixed bounds parse the same way the default does.
  assert.equal(declared[1].min, 0);
  assert.equal(declared[1].max, 4);
});

test('a textual boolean becomes a checkbox, and a plain numeric string stays text', () => {
  const declared = declaredVariables(wrap(JSON.stringify([
    { id: 'on', default: 'true' },
    { id: 'off', default: 'false' },
    { id: 'zip', default: '75011' },
  ])));
  assert.deepEqual(declared.map((v) => v.type), ['boolean', 'boolean', 'string']);
  assert.equal(declared[0]['default'], true);
  assert.equal(declared[1]['default'], false);
});

test('long text is flagged for a control that can show it', () => {
  const long = 'x'.repeat(120);
  const declared = declaredVariables(wrap(JSON.stringify([
    { id: 'short', default: 'Use case' },
    { id: 'long', default: long },
    { id: 'lines', default: 'one\ntwo' },
  ])));
  assert.deepEqual(declared.map((v) => v.multiline), [false, true, true]);
});

test('an author grouping is carried through, from group or role', () => {
  const declared = declaredVariables(wrap(JSON.stringify([
    { id: 'a', group: 'Titres', default: 'x' },
    { id: 'b', role: 'content', default: 'y' },
    { id: 'c', default: 'z' },
  ])));
  assert.deepEqual(declared.map((v) => v.group), ['Titres', 'content', '']);
});

test('enum options accept both bare strings and labelled objects', () => {
  const [variable] = declaredVariables(wrap(JSON.stringify([
    { id: 'e', type: 'enum', options: ['a', { value: 'b', label: 'B&amp;B' }], default: 'b' },
  ])));
  assert.deepEqual(variable.options, [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'B&B' },
  ]);
});

test('malformed declarations degrade to no variables, never to a throw', () => {
  assert.deepEqual(declaredVariables('<html></html>'), []);
  assert.deepEqual(declaredVariables(wrap('not json')), []);
  assert.deepEqual(declaredVariables(wrap('{"id":"x"}')), []);
  assert.deepEqual(declaredVariables(wrap('[null,3,{"no":"id"}]')), []);
});

test('the authored size is read when declared', () => {
  assert.deepEqual(
    declaredSize('<div data-width="1080" data-height="1920"></div>'),
    { width: 1080, height: 1920 },
  );
  assert.equal(declaredSize('<div></div>'), null);
  assert.equal(declaredSize('<div data-width="0" data-height="0"></div>'), null);
});

test('a size is found in each of the three places a composition states one', () => {
  assert.deepEqual(
    requestedSizes('<meta name="viewport" content="width=1080, height=1920" />')
      .map((s) => [s.width, s.height]),
    [[1080, 1920]],
  );
  assert.deepEqual(
    requestedSizes('<body style="margin:0;width:1080px;height:1920px;overflow:hidden">')
      .map((s) => [s.width, s.height]),
    [[1080, 1920]],
  );
  assert.equal(requestedSizes('<body style="width:100%;height:100%">').length, 0);
});

test('the element attribute outranks the other two, and duplicates collapse', () => {
  // The real paste: a stage element, a viewport meta and a pinned body, all
  // saying 1080x1920. One offer, not three.
  const html = '<meta name="viewport" content="width=1080, height=1920" />' +
    '<body style="width:1080px;height:1920px">' +
    '<div data-width="1080" data-height="1920"></div>';
  assert.equal(requestedSizes(html).length, 1);

  // When they disagree, the attribute leads — it is what the layout keys off.
  const conflicting = '<meta name="viewport" content="width=1920, height=1080" />' +
    '<div data-width="1080" data-height="1920"></div>';
  const sizes = requestedSizes(conflicting);
  assert.deepEqual([sizes[0].width, sizes[0].height], [1080, 1920]);
  assert.deepEqual([sizes[1].width, sizes[1].height], [1920, 1080]);
  assert.deepEqual(declaredSize(conflicting), { width: 1080, height: 1920 });
});

test('an out-of-range size is not offered', () => {
  assert.equal(requestedSizes('<div data-width="4" data-height="4"></div>').length, 0);
  assert.equal(requestedSizes('<div data-width="99999" data-height="10"></div>').length, 0);
});
