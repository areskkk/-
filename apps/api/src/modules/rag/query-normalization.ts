const QUERY_STOP_WORDS = new Set([
  '我',
  '我们',
  '你',
  '你们',
  '他',
  '她',
  '它',
  '企业',
  '公司',
  '单位',
  '政策',
  '奖励',
  '补贴',
  '资助',
  '扶持',
  '申请',
  '申报',
  '条件',
  '可以',
  '什么',
  '哪些',
  '怎么',
  '如何',
  '是否',
  '能否',
  '能不能',
  '有关',
  '相关',
  '问题',
  '一下',
  '一个',
  '一种',
  '办理',
  '咨询',
  '需要',
  '要求',
  '吗',
  '呢',
  '啊',
  '呀',
  '后',
  '完成',
  '达到',
  '标准',
  '年度',
  '相关',
  '有关',
  '咨询',
  '查',
  '拿',
  '门店',
  '购置',
]);

const PHRASE_TERMS = [
  '数字化技改',
  '数字化改造',
  '绿色制造',
  '稳岗用工',
  '用工补贴',
  '出口奖励',
  '出口额',
  '纳税奖励',
  '纳税额',
  '申报条件',
  '税费减免',
  '门店装修',
  '直播电商',
  '新能源汽车',
  '购置补贴',
];

const NOISY_GRAMS = new Set([
  '完成',
  '达到',
  '标准',
  '奖励',
  '补贴',
  '政策',
  '申请',
  '申报',
  '条件',
  '什么',
  '哪些',
  '怎么',
  '如何',
  '有关',
  '相关',
  '问题',
  '企业',
  '公司',
  '可以',
  '能否',
  '是否',
  '年度',
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function addTerm(target: Set<string>, value: string): void {
  const normalized = normalizeWhitespace(
    value
      .trim()
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[，。！？；：（）【】《》“”‘’、,.!?;:()[\]{}"'`~|\\/_+=<>@#$%^&*-]+/g, ' '),
  );
  if (normalized.length <= 1 || QUERY_STOP_WORDS.has(normalized)) {
    return;
  }
  target.add(normalized);
}

function addPhraseTerms(target: Set<string>, normalizedQuery: string): void {
  for (const phrase of PHRASE_TERMS) {
    if (normalizedQuery.includes(phrase)) {
      addTerm(target, phrase);
    }
  }
}

function addAliasTerms(target: Set<string>, normalizedQuery: string): void {
  if (normalizedQuery.includes('外贸')) {
    addTerm(target, '出口');
    addTerm(target, '出口额');
  }

  if (normalizedQuery.includes('税收')) {
    addTerm(target, '纳税');
    addTerm(target, '纳税额');
  }

  if (normalizedQuery.includes('纳税')) {
    addTerm(target, '税收');
    addTerm(target, '纳税额');
  }

  if (normalizedQuery.includes('稳岗')) {
    addTerm(target, '用工');
    addTerm(target, '社保');
  }

  if (normalizedQuery.includes('社保')) {
    addTerm(target, '稳岗');
    addTerm(target, '用工');
  }

  if (normalizedQuery.includes('数字化技改')) {
    addTerm(target, '数字化');
    addTerm(target, '技改');
    addTerm(target, '数字化改造');
  }

  if (normalizedQuery.includes('数字化改造')) {
    addTerm(target, '数字化');
    addTerm(target, '改造');
  }

  if (normalizedQuery.includes('技改')) {
    addTerm(target, '改造');
  }

  if (
    normalizedQuery.includes('申请')
    || normalizedQuery.includes('申报')
    || normalizedQuery.includes('条件')
  ) {
    addTerm(target, '申报条件');
  }

  if (normalizedQuery.includes('制造') && normalizedQuery.includes('改造')) {
    addTerm(target, '技改');
    addTerm(target, '数字化');
  }
}

function addSegmentTerms(target: Set<string>, normalizedQuery: string): void {
  const segments = normalizedQuery.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  for (const segment of segments) {
    if (segment.length <= 6 || /^[a-z0-9]+$/i.test(segment)) {
      addTerm(target, segment);
    }
    if (/^[a-z0-9]+$/i.test(segment)) {
      continue;
    }

    const compact = segment.replace(/\s+/g, '');
    for (let size = 2; size <= 4; size += 1) {
      if (compact.length < size) {
        continue;
      }
      for (let index = 0; index <= compact.length - size; index += 1) {
        const gram = compact.slice(index, index + size);
        if (NOISY_GRAMS.has(gram)) {
          continue;
        }
        addTerm(target, gram);
      }
    }
  }
}

export function normalizeRagQuery(query: string): string {
  const normalized = query
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[，。！？；：（）【】《》“”‘’、,.!?;:()[\]{}"'`~|\\/_+=<>@#$%^&*-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized !== '') {
    return normalized;
  }

  return normalizeWhitespace(query.trim().normalize('NFKC'));
}

export function extractRagQueryTerms(query: string): string[] {
  const normalizedQuery = normalizeRagQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const terms = new Set<string>();
  addPhraseTerms(terms, normalizedQuery);
  addAliasTerms(terms, normalizedQuery);
  addSegmentTerms(terms, normalizedQuery);

  return [...terms].sort((left, right) => right.length - left.length);
}

export function normalizeForContains(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  return normalizeRagQuery(value);
}
