import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dataFormatOf } from '../../src/format.mts';

test('a served data_format that is a whole number from 1 to 999 is the format', () => {
  for (const value of [1, 2, 3, 999]) {
    assert.equal(dataFormatOf(value), value);
  }
});

test('no data_format is format 1, the format of every build before the number was read', () => {
  assert.equal(dataFormatOf(undefined), 1);
});

test('a data_format that is not a whole number from 1 to 999 is format 1', () => {
  for (const value of [0, -1, -0, 1.5, '2', null, 1000, NaN, Infinity, true, [2], { format: 2 }]) {
    assert.equal(dataFormatOf(value), 1, String(value));
  }
});
