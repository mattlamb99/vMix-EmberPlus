'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseTally, parseActs, buildRouteCommand } = require('../parsers');

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim();

test('parseTally: real capture "TALLY OK 12"', () => {
  const result = parseTally(readFixture('tally.txt'));
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { input: 1, state: 1, program: true, preview: false });
  assert.deepEqual(result[1], { input: 2, state: 2, program: false, preview: true });
});

test('parseTally: maps 0/1/2 to off/program/preview', () => {
  const result = parseTally('TALLY OK 012');
  assert.deepEqual(result.map((r) => r.program), [false, true, false]);
  assert.deepEqual(result.map((r) => r.preview), [false, false, true]);
});

test('parseTally: caps at 32 inputs by default', () => {
  const result = parseTally('TALLY OK ' + '0'.repeat(40));
  assert.equal(result.length, 32);
  assert.equal(result[31].input, 32);
});

test('parseTally: honours a custom maxInputs', () => {
  assert.equal(parseTally('TALLY OK 1111', 2).length, 2);
});

test('parseTally: empty tally string yields no updates', () => {
  assert.deepEqual(parseTally('TALLY OK '), []);
});

test('parseTally: ignores non-TALLY and invalid input', () => {
  assert.deepEqual(parseTally('VERSION OK 28.0.0.43'), []);
  assert.deepEqual(parseTally('SUBSCRIBE OK TALLY Subscribed'), []);
  assert.deepEqual(parseTally(''), []);
  assert.deepEqual(parseTally(null), []);
  assert.deepEqual(parseTally(undefined), []);
});

test('parseActs: parses Recording / MultiCorder / Streaming', () => {
  assert.deepEqual(parseActs('ACTS OK Recording 1'), { category: 'Recording', active: true });
  assert.deepEqual(parseActs('ACTS OK MultiCorder 0'), { category: 'MultiCorder', active: false });
  assert.deepEqual(parseActs('ACTS OK Streaming 1'), { category: 'Streaming', active: true });
});

test('parseActs: any non-"1" value is inactive', () => {
  assert.equal(parseActs('ACTS OK Recording 0').active, false);
});

test('parseActs: returns null for malformed lines', () => {
  assert.equal(parseActs('ACTS OK'), null);
  assert.equal(parseActs('ACTS OK Recording'), null);
  assert.equal(parseActs('garbage'), null);
  assert.equal(parseActs(''), null);
  assert.equal(parseActs(null), null);
});

test('buildRouteCommand: input source to output target', () => {
  assert.equal(
    buildRouteCommand({ kind: 'input', inputNumber: 1 }, { kind: 'output', number: 2 }),
    'FUNCTION SetOutput2 Value=Input&Input=1'
  );
});

test('buildRouteCommand: named value source to output target', () => {
  assert.equal(
    buildRouteCommand({ kind: 'value', value: 'Output' }, { kind: 'output', number: 3 }),
    'FUNCTION SetOutput3 Value=Output'
  );
  assert.equal(
    buildRouteCommand({ kind: 'value', value: 'MultiView' }, { kind: 'output', number: 4 }),
    'FUNCTION SetOutput4 Value=MultiView'
  );
});

test('buildRouteCommand: null for non-routable target or bad input', () => {
  assert.equal(buildRouteCommand({ kind: 'input', inputNumber: 1 }, { kind: 'fullscreen', number: 1 }), null);
  assert.equal(buildRouteCommand({ kind: 'unknown' }, { kind: 'output', number: 2 }), null);
  assert.equal(buildRouteCommand(null, { kind: 'output', number: 2 }), null);
  assert.equal(buildRouteCommand({ kind: 'input', inputNumber: 1 }, null), null);
});
