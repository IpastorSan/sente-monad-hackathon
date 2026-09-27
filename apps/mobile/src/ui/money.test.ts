/** The one signed-money formatter (SEN-136). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { signedFigure } from './money.ts';

const text = (value: string | number, places = 2, trim = false): string | undefined =>
  signedFigure(value, places, { trim })?.text;

test('signs and tones from the rounded figure, so zero is never −0', () => {
  assert.deepEqual(signedFigure('-0.001', 2), {
    sign: '',
    plain: '0.00',
    magnitude: '0.00',
    text: '0.00',
    tone: null,
  });
  assert.equal(text('-0'), '0.00');
  assert.equal(text('-0.0000001', 6, true), '0');
  assert.equal(text('0', 6, true), '0');
  assert.equal(signedFigure('-0.004', 2)?.tone, null);
  assert.equal(signedFigure('-0.005', 2)?.tone, 'down');
});

test('rounds half away from zero on the digits, not through a float', () => {
  assert.equal(text('-2.675'), '−2.68');
  assert.equal(text('2.675'), '+2.68');
  assert.equal(text('2.674999'), '+2.67');
  assert.equal(text('-0.005'), '−0.01');
  assert.equal(text('9.995'), '+10.00');
  assert.equal(text(-2.675), '−2.68', 'a number is read as the decimal it prints as');
});

test('reads exponent form, from a venue or from String(number)', () => {
  assert.equal(text('1e-7'), '0.00');
  assert.equal(text(1e-7, 7), '+0.0000001');
  assert.equal(text('1.5e3'), '+1,500.00');
  assert.equal(text('-4.4E-3'), '0.00');
  assert.equal(text('5e-3'), '+0.01');
  assert.equal(text(1e21, 0), '+1,000,000,000,000,000,000,000');
});

test('keeps every digit of an 18+ digit figure', () => {
  assert.equal(text('123456789012345678.905'), '+123,456,789,012,345,678.91');
  assert.equal(
    text('-1000000000000000000000000.000000000000000001', 18),
    '−1,000,000,000,000,000,000,000,000.000000000000000001',
  );
  assert.equal(text('999999999999999999.999'), '+1,000,000,000,000,000,000.00');
});

test('trim drops trailing zeros; plain is ungrouped for BigNumber', () => {
  assert.equal(text('12.40', 6, true), '+12.4');
  assert.equal(text('1234.5', 6, true), '+1,234.5');
  assert.equal(signedFigure('-1234.5', 2)?.plain, '1234.50');
  assert.equal(signedFigure('-1234.5', 2)?.magnitude, '1,234.50');
});

test('accepts the signs our own labels print, and whitespace', () => {
  assert.equal(text('−3.1'), '−3.10');
  assert.equal(text('+3.1'), '+3.10');
  assert.equal(text(' .5 '), '+0.50');
  assert.equal(text('5.'), '+5.00');
});

test('refuses what is not a finite number', () => {
  for (const bad of ['', '-', '.', 'nonsense', '1,000', '0x10', '1e', '1e99999', 'NaN']) {
    assert.equal(signedFigure(bad, 2), null, bad);
  }
  assert.equal(signedFigure(Number.NaN, 2), null);
  assert.equal(signedFigure(Number.POSITIVE_INFINITY, 2), null);
  assert.equal(signedFigure(null, 2), null);
  assert.equal(signedFigure(undefined, 2), null);
});
