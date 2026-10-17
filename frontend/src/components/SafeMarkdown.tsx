import React from 'react';

interface SafeMarkdownProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  attachmentBlobUrls?: Record<string, string>;
}

/**
 * Checks whether a URL is safe to render as a link href.
 * Only allows http:, https:, and relative URLs.
 */
export function isSafeUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('vbscript:') ||
    trimmed.startsWith('file:')
  ) {
    return false;
  }
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('#')
  );
}

/**
 * Parse inline Markdown (images, code, bold, italic, links) into React elements.
 * All raw text is emitted as React text children, completely escaping any HTML.
 */
function renderInline(text: string, attachmentBlobUrls?: Record<string, string>): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Tokenize regex for images (![alt](url)), `code`, **bold**, *italic*, [label](url)
  const regex = /(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('!')) {
      const imgMatch = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch) {
        const [, alt, url] = imgMatch;
        let resolvedUrl: string | null = null;
        if (url.startsWith('attachments/')) {
          const filename = url.slice('attachments/'.length);
          resolvedUrl = attachmentBlobUrls?.[filename] || null;
        } else if (isSafeUrl(url) || url.startsWith('blob:') || url.startsWith('data:image/')) {
          resolvedUrl = url;
        }

        if (resolvedUrl) {
          nodes.push(
            <img
              key={match.index}
              src={resolvedUrl}
              alt={alt || 'attachment'}
              style={{
                maxWidth: '100%',
                maxHeight: '400px',
                objectFit: 'contain',
                borderRadius: '0.375rem',
                border: '1px solid #334155',
                display: 'block',
                margin: '0.5rem 0',
              }}
            />
          );
        } else {
          nodes.push(
            <span
              key={match.index}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.2rem 0.5rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.25rem',
                fontSize: '0.8rem',
                color: '#94a3b8',
                margin: '0.25rem 0',
              }}
            >
              🖼️ {url}
            </span>
          );
        }
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={match.index}
          style={{
            backgroundColor: '#0f172a',
            padding: '0.1rem 0.3rem',
            borderRadius: '0.25rem',
            fontSize: '0.85em',
            fontFamily: 'monospace',
            color: '#a5b4fc',
            border: '1px solid #334155',
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={match.index} style={{ color: '#f8fafc' }}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const [, label, url] = linkMatch;
        if (isSafeUrl(url)) {
          nodes.push(
            <a
              key={match.index}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#818cf8', textDecoration: 'underline' }}
            >
              {label}
            </a>
          );
        } else {
          // Unsafe URL protocol (e.g. javascript:); render label safely as text
          nodes.push(<span key={match.index}>{label}</span>);
        }
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export const SafeMarkdown: React.FC<SafeMarkdownProps> = ({ content, style, attachmentBlobUrls }) => {
  if (!content) return null;

  const inline = (text: string) => renderInline(text, attachmentBlobUrls);

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let listItems: React.ReactNode[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const flushList = (key: string | number) => {
    if (listItems.length > 0 && listType) {
      if (listType === 'ul') {
        elements.push(
          <ul key={key} style={{ paddingLeft: '1.5rem', margin: '0.5rem 0', color: '#cbd5e1' }}>
            {listItems}
          </ul>
        );
      } else {
        elements.push(
          <ol key={key} style={{ paddingLeft: '1.5rem', margin: '0.5rem 0', color: '#cbd5e1' }}>
            {listItems}
          </ol>
        );
      }
      listItems = [];
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre
            key={`code-${i}`}
            style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.75rem',
              overflowX: 'auto',
              fontFamily: 'monospace',
              fontSize: '0.82rem',
              color: '#e2e8f0',
              lineHeight: 1.5,
              margin: '0.5rem 0',
            }}
          >
            <code>{codeBlockLines.join('\n')}</code>
          </pre>
        );
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        flushList(`flush-${i}`);
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Headings
    if (line.startsWith('# ')) {
      flushList(`flush-${i}`);
      elements.push(
        <h1 key={`h1-${i}`} style={{ fontSize: '1.3rem', fontWeight: 700, color: '#f8fafc', margin: '1rem 0 0.5rem' }}>
          {inline(line.slice(2))}
        </h1>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      flushList(`flush-${i}`);
      elements.push(
        <h2 key={`h2-${i}`} style={{ fontSize: '1.15rem', fontWeight: 600, color: '#f1f5f9', margin: '0.8rem 0 0.4rem' }}>
          {inline(line.slice(3))}
        </h2>
      );
      continue;
    }
    if (line.startsWith('### ')) {
      flushList(`flush-${i}`);
      elements.push(
        <h3 key={`h3-${i}`} style={{ fontSize: '1rem', fontWeight: 600, color: '#e2e8f0', margin: '0.6rem 0 0.3rem' }}>
          {inline(line.slice(4))}
        </h3>
      );
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList(`flush-${i}`);
      elements.push(
        <blockquote
          key={`quote-${i}`}
          style={{
            borderLeft: '3px solid #6366f1',
            paddingLeft: '0.75rem',
            margin: '0.5rem 0',
            color: '#94a3b8',
            fontStyle: 'italic',
          }}
        >
          {inline(line.slice(2))}
        </blockquote>
      );
      continue;
    }

    // Unordered list (- or *)
    const ulMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        flushList(`flush-${i}`);
        listType = 'ul';
      }
      listItems.push(
        <li key={`li-${i}`} style={{ margin: '0.2rem 0', lineHeight: 1.4 }}>
          {inline(ulMatch[2])}
        </li>
      );
      continue;
    }

    // Ordered list (1. 2. etc.)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (olMatch) {
      if (listType !== 'ol') {
        flushList(`flush-${i}`);
        listType = 'ol';
      }
      listItems.push(
        <li key={`li-${i}`} style={{ margin: '0.2rem 0', lineHeight: 1.4 }}>
          {inline(olMatch[2])}
        </li>
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      flushList(`flush-${i}`);
      continue;
    }

    // Paragraph
    flushList(`flush-${i}`);
    elements.push(
      <p key={`p-${i}`} style={{ margin: '0.4rem 0', lineHeight: 1.5, color: '#cbd5e1' }}>
        {inline(line)}
      </p>
    );
  }

  flushList('flush-end');

  if (inCodeBlock && codeBlockLines.length > 0) {
    elements.push(
      <pre
        key="code-end"
        style={{
          backgroundColor: '#0f172a',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          padding: '0.75rem',
          overflowX: 'auto',
          fontFamily: 'monospace',
          fontSize: '0.82rem',
          color: '#e2e8f0',
          lineHeight: 1.5,
          margin: '0.5rem 0',
        }}
      >
        <code>{codeBlockLines.join('\n')}</code>
      </pre>
    );
  }

  return <div style={{ fontSize: '0.85rem', ...style }}>{elements}</div>;
};
