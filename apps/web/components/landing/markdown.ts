/**
 * A small markdown parser for the documents in docs/ that the site renders (the whitepaper). It covers
 * the subset those files use: headings, paragraphs, block quotes, rules, bullet lists and pipe tables,
 * with **bold**, _italic_, `code` and [links](url) inline. Anything else is kept as plain text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'h'; level: number; text: string; id: string }
  | { t: 'p'; c: Inline[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'hr' }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'table'; head: Inline[][] | null; rows: Inline[][][] };

/** "4. Fees" → "fees", "6. Buyback, burn and season prizes" → "buyback-burn-and-season-prizes". */
export function slug(text: string): string {
  return text
    .replace(/^\d+\.\s*/, '')
    .toLowerCase()
    .replace(/\$/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Heading text without its section number ("4. Fees" → "Fees"). */
export function headingLabel(text: string): string {
  return text.replace(/^\d+\.\s*/, '');
}

const INLINE = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|((?<![\w])_(.+?)_(?![\w]))/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ t: 'text', v: rest });
      break;
    }
    if (m.index > 0) out.push({ t: 'text', v: rest.slice(0, m.index) });
    if (m[1]) out.push({ t: 'strong', c: parseInline(m[2] ?? '') });
    else if (m[3]) out.push({ t: 'code', v: m[4] ?? '' });
    else if (m[5]) out.push({ t: 'link', href: m[7] ?? '', c: parseInline(m[6] ?? '') });
    else out.push({ t: 'em', c: parseInline(m[9] ?? '') });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isRow = (l: string) => l.trim().startsWith('|');
const isDivider = (l: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(l.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  const L = (k: number) => lines[k] ?? '';
  let i = 0;
  while (i < lines.length) {
    const line = L(i);
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ t: 'h', level: (h[1] ?? '').length, text: h[2] ?? '', id: slug(h[2] ?? '') });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && L(i).trim().startsWith('>')) buf.push(L(i++).trim().replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseInline(buf.join(' ')) });
      continue;
    }
    if (isRow(trimmed) && i + 1 < lines.length && isDivider(L(i + 1))) {
      const headCells = cells(trimmed);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && isRow(L(i))) rows.push(cells(L(i++)).map(parseInline));
      const emptyHead = headCells.every((c) => !c);
      blocks.push({ t: 'table', head: emptyHead ? null : headCells.map(parseInline), rows });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^[-*]\s+/.test(L(i).trim())) {
        let item = L(i++).trim().replace(/^[-*]\s+/, '');
        // Continuation lines of the same item (indented, not a new bullet).
        while (i < lines.length && /^\s{2,}\S/.test(L(i)) && !/^\s*[-*]\s+/.test(L(i))) item += ' ' + L(i++).trim();
        items.push(parseInline(item));
      }
      blocks.push({ t: 'ul', items });
      continue;
    }
    // Paragraph: consecutive lines that don't start another block, joined with a space.
    const buf: string[] = [];
    while (i < lines.length) {
      const l = L(i).trim();
      if (!l || /^(#{1,6}\s|>|[-*]\s|\||-{3,}$)/.test(l)) break;
      buf.push(l);
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(buf.join(' ')) });
  }
  return blocks;
}

/** Plain text of inline content (for matching and labels). */
export function plain(c: Inline[]): string {
  return c.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : plain(n.c))).join('');
}
