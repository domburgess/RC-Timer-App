import { describe, expect, it } from 'vitest';
import { unsupportedNumbers } from '../server/engine/compose';

const data = {
  geology: { oldestMa: 1200, youngestMa: 252.2, name: 'Unit' },
  elevation: { meters: 4321, feet: 14177 },
  nearby: [{ extract: 'Built in 1859 by the city council.' }],
  coast: { km: 1954 },
};

describe('grounding check', () => {
  it('accepts numbers present in the data, rounded or rescaled', () => {
    expect(unsupportedNumbers('The rock is 1.2 billion years old.', data)).toEqual([]);
    expect(unsupportedNumbers('Rock about 252 million years old, 4,300 m up.', data)).toEqual([]);
    expect(unsupportedNumbers('It was built in 1859.', data)).toEqual([]);
    expect(unsupportedNumbers('About 2,000 km from the sea.', data)).toEqual([]);
    expect(unsupportedNumbers('One of 3 towers.', data)).toEqual([]);
  });
  it('rejects invented numbers', () => {
    expect(unsupportedNumbers('It was built in 1742.', data)).toEqual([1742]);
    expect(unsupportedNumbers('Home to 85,000 people.', data)).toEqual([85000]);
  });
});
