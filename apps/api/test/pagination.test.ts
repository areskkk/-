import { describe, expect, it } from 'vitest';
import { normalizePageQuery, pageResult } from '../src/common/pagination/pagination.js';

describe('pagination', () => {
  it('uses stable default pagination', () => {
    expect(pageResult([], 0)).toEqual({
      page: 1,
      page_size: 20,
      total: 0,
      items: [],
    });
  });

  it('normalizes invalid values and caps page size', () => {
    expect(normalizePageQuery({ page: -1, page_size: 1000 })).toEqual({
      page: 1,
      page_size: 100,
    });
  });

  it('supports string query values from HTTP query strings', () => {
    expect(normalizePageQuery({ page: '1', page_size: '20' })).toEqual({
      page: 1,
      page_size: 20,
    });
  });

  it('falls back for invalid strings and caps string page size', () => {
    expect(normalizePageQuery({ page: 'abc', page_size: '1000' })).toEqual({
      page: 1,
      page_size: 100,
    });
  });
});
