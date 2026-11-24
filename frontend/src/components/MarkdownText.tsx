import type { ReactNode } from 'react';

function safeHref(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function inline(text: string): ReactNode[] {
  const token = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^\s)]+(?:\s+"[^"]*")?\)|https?:\/\/[^\s<>]+)/g;
  const result: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > cursor) result.push(text.slice(cursor, index));
    const key = `${index}-${value}`;
    if (value.startsWith('`')) result.push(<code key={key}>{value.slice(1, -1)}</code>);
    else if (value.startsWith('**') || value.startsWith('__')) result.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    else if (value.startsWith('*') || value.startsWith('_')) result.push(<em key={key}>{value.slice(1, -1)}</em>);
    else if (/^https?:\/\//i.test(value)) {
      const url = value.replace(/[.,;:!?]+$/, '');
      const trailing = value.slice(url.length);
      const href = safeHref(url);
      result.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{url}</a> : value);
      if (trailing) result.push(trailing);
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^\s)]+)/);
      const href = link ? safeHref(link[2]!) : null;
      result.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{link![1]}</a> : value);
    }
    cursor = index + value.length;
  }
  if (cursor < text.length) result.push(text.slice(cursor));
  return result;
}

export default function MarkdownText({ children, className = '' }: { children: string; className?: string }) {
  const lines = children.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) code.push(lines[index++] ?? '');
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const Tag = `h${heading[1]!.length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={`heading-${index}`}>{inline(heading[2]!)}</Tag>);
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: ReactNode[] = [];
      while (index < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[index] ?? '')) {
        items.push(<li key={index}>{inline((lines[index] ?? '').replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ''))}</li>);
        index += 1;
      }
      blocks.push(ordered ? <ol key={`list-${index}`}>{items}</ol> : <ul key={`list-${index}`}>{items}</ul>);
      continue;
    }
    if (/^\s*&gt;|^\s*>/.test(line)) {
      const quote: ReactNode[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) quote.push(<p key={index}>{inline((lines[index++] ?? '').replace(/^\s*>\s?/, ''))}</p>);
      blocks.push(<blockquote key={`quote-${index}`}>{quote}</blockquote>);
      continue;
    }
    const paragraph: ReactNode[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() && !/^\s*(?:#{1,6}\s|```|[-*+]\s|\d+[.)]\s|>)/.test(lines[index] ?? '')) {
      if (paragraph.length) paragraph.push(<br key={`br-${index}`} />);
      paragraph.push(...inline((lines[index] ?? '').trim()));
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`}>{paragraph}</p>);
  }
  return <div className={`markdown-text ${className}`.trim()}>{blocks}</div>;
}
