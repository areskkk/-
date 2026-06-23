import crypto from 'node:crypto';

const MAX_CHUNK_LENGTH = 700;
const MIN_CHUNK_LENGTH = 80;

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function cleanLine(line: string): string {
  return line
    .replace(/\t+/g, ' ')
    .replace(/[ \u3000]+/g, ' ')
    .replace(/[：]\s+/g, '：')
    .replace(/\s+[，。；：！？]/g, (match) => match.trim())
    .trim();
}

function isFormatNoise(line: string): boolean {
  if (/^[-_=]{3,}$/.test(line)) {
    return true;
  }
  if (/^第?\s*\d+\s*页$/.test(line)) {
    return true;
  }
  return false;
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line) || /^[一二三四五六七八九十0-9]+[、.．]\s*\S+/.test(line);
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MAX_CHUNK_LENGTH) {
    chunks.push(text.slice(index, index + MAX_CHUNK_LENGTH));
  }
  return chunks;
}

export function chunkPolicyContent(input: {
  policy_id: string;
  version: string;
  title: string;
  content: string | null;
  source_name: string | null;
  source_url: string | null;
  status: string;
}) {
  const lines = (input.content ?? input.title)
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => Boolean(line) && !isFormatNoise(line));

  const chunks: Array<{
    policy_id: string;
    version: string;
    title: string;
    section_path: string;
    chunk_order: number;
    content: string;
    content_hash: string;
    source_name: string | null;
    source_url: string | null;
    status: string;
    metadata: Record<string, unknown>;
  }> = [];
  let currentSection = '正文';
  let buffer: string[] = [];

  function flush(): void {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) {
      return;
    }

    for (const part of splitLongText(text)) {
      const content = part.trim();
      if (!content) {
        continue;
      }
      chunks.push({
        policy_id: input.policy_id,
        version: input.version,
        title: input.title,
        section_path: currentSection,
        chunk_order: chunks.length + 1,
        content,
        content_hash: contentHash(content),
        source_name: input.source_name,
        source_url: input.source_url,
        status: input.status,
        metadata: {
          chunk_type: currentSection === '标题' ? 'title' : 'section',
          policy_id: input.policy_id,
          version: input.version,
          title: input.title,
          section_path: currentSection,
          chunk_order: chunks.length + 1,
          source_name: input.source_name,
          source_url: input.source_url,
          status: input.status,
        },
      });
    }
  }

  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      currentSection = headingText(line);
      buffer.push(line);
      continue;
    }

    const pending = [...buffer, line].join('\n');
    if (pending.length > MAX_CHUNK_LENGTH && buffer.join('\n').length >= MIN_CHUNK_LENGTH) {
      flush();
    }
    buffer.push(line);
  }

  flush();

  if (chunks.length === 0) {
    const content = input.title;
    chunks.push({
      policy_id: input.policy_id,
      version: input.version,
      title: input.title,
      section_path: '标题',
      chunk_order: 1,
      content,
      content_hash: contentHash(content),
      source_name: input.source_name,
      source_url: input.source_url,
      status: input.status,
      metadata: {
        chunk_type: 'title',
        policy_id: input.policy_id,
        version: input.version,
        title: input.title,
        section_path: '标题',
        chunk_order: 1,
        source_name: input.source_name,
        source_url: input.source_url,
        status: input.status,
      },
    });
  }

  return chunks;
}
