import { isPositiveDecimal, maxDecimal, mulDecimal } from './decimal';

describe('decimal helpers', () => {
  it.each([
    ['10', '3.5', '35'],
    ['0.5', '0.02', '0.01'],
    ['100', '0.01', '1'],
    ['0', '5', '0'],
    ['0.001', '60000', '60'],
    ['1.25', '1.25', '1.5625'],
  ])('%s x %s = %s', (a, b, product) => {
    expect(mulDecimal(a, b)).toBe(product);
  });

  it('refuses anything that is not a plain decimal', () => {
    expect(() => mulDecimal('1e3', '1')).toThrow(RangeError);
    expect(() => mulDecimal('-1', '1')).toThrow(RangeError);
  });

  it('compares exactly', () => {
    expect(maxDecimal('250.5', '250.50000000000000001')).toBe('250.50000000000000001');
    expect(isPositiveDecimal('0.000')).toBe(false);
    expect(isPositiveDecimal('0.001')).toBe(true);
    expect(isPositiveDecimal(1)).toBe(false);
  });
});
