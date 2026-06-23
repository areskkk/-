export type PageQuery = {
  page?: number | string;
  page_size?: number | string;
};

export type PageResult<T> = {
  page: number;
  page_size: number;
  total: number;
  items: T[];
};

export type NormalizedPageQuery = {
  page: number;
  page_size: number;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePositiveInteger(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

export function normalizePageQuery(query: PageQuery): NormalizedPageQuery {
  const page = parsePositiveInteger(query.page) ?? DEFAULT_PAGE;
  const requestedPageSize =
    parsePositiveInteger(query.page_size) ?? DEFAULT_PAGE_SIZE;

  return {
    page,
    page_size: Math.min(requestedPageSize, MAX_PAGE_SIZE),
  };
}

export function pageResult<T>(
  items: T[],
  total: number,
  query: PageQuery = {},
): PageResult<T> {
  const normalized = normalizePageQuery(query);
  return {
    ...normalized,
    total,
    items,
  };
}
