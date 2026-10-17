import React, { useState, useEffect } from 'react';
import { FileText, FileDown, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { AttachmentDetail } from '../types';
import { api } from '../api';

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Classifies an attachment into image, text, or pdf.
 * Uses attachment_details when available.
 * Fallback for old engines without attachment_details:
 * names ending in png/jpg/jpeg/gif/webp as images, others as text.
 */
export function getAttachmentInfo(
  name: string,
  details?: AttachmentDetail[]
): { class: 'image' | 'text' | 'pdf'; size?: number } {
  if (details && details.length > 0) {
    const found = details.find((d) => d.name === name);
    if (found) {
      const cls = (found.class || '').toLowerCase();
      if (cls === 'image' || cls === 'text' || cls === 'pdf') {
        return { class: cls, size: found.size };
      }
    }
  }

  // Fallback for old engines without attachment_details:
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) {
    return { class: 'image' };
  }
  return { class: 'text' };
}

/**
 * Downloads a blob as a file via a temporary <a download> element, revoking afterwards.
 */
export async function downloadAttachmentBlob(
  fetchBlob: () => Promise<Blob>,
  filename: string
): Promise<void> {
  const blob = await fetchBlob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }
}

export type AttachmentContext =
  | { type: 'note'; id: string }
  | { type: 'task'; id: string };

export interface AttachmentItemProps {
  name: string;
  context: AttachmentContext;
  details?: AttachmentDetail[];
  thumbnailSize?: number;
  canRemove?: boolean;
  onRemove?: () => void;
  onBlobLoaded?: (name: string, blobUrl: string) => void;
  onOpenTextViewer?: (name: string, size?: number) => void;
  onDownloadPdf?: (name: string) => void;
}

export const AttachmentItem: React.FC<AttachmentItemProps> = ({
  name,
  context,
  details,
  thumbnailSize = 64,
  canRemove = false,
  onRemove,
  onBlobLoaded,
  onOpenTextViewer,
  onDownloadPdf,
}) => {
  const info = getAttachmentInfo(name, details);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(info.class === 'image');
  const [error, setError] = useState(false);

  // For images, load the thumbnail blob
  useEffect(() => {
    if (info.class !== 'image') return;
    if (!context.id || context.id === '-') return;

    let active = true;
    let url: string | null = null;
    setLoading(true);
    setError(false);

    const fetchPromise =
      context.type === 'note'
        ? api.getInboxAttachment(context.id, name)
        : api.getTaskAttachment(context.id, name);

    fetchPromise
      .then((blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setLoading(false);
        if (onBlobLoaded) {
          onBlobLoaded(name, url);
        }
      })
      .catch((err) => {
        if (!active) return;
        console.error(`Failed to load image attachment ${name}:`, err);
        setError(true);
        setLoading(false);
      });

    return () => {
      active = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [context.type, context.id, name, info.class]);

  // IMAGE: render thumbnail
  if (info.class === 'image') {
    return (
      <div
        style={{
          position: 'relative',
          width: thumbnailSize,
          height: thumbnailSize,
          borderRadius: '0.375rem',
          overflow: 'hidden',
          border: '1px solid #334155',
          backgroundColor: '#0f172a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        title={name}
      >
        {loading ? (
          <Loader2 size={16} className="spin" color="#818cf8" />
        ) : error || !blobUrl ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '2px',
              padding: '2px',
            }}
          >
            <ImageIcon size={16} color="#64748b" />
            <span
              style={{
                fontSize: '0.55rem',
                color: '#64748b',
                textAlign: 'center',
                wordBreak: 'break-all',
              }}
            >
              {name.slice(0, 8)}
            </span>
          </div>
        ) : (
          <img
            src={blobUrl}
            alt={name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}

        {canRemove && onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title={`Remove ${name}`}
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              backgroundColor: 'rgba(239, 68, 68, 0.85)',
              border: 'none',
              borderRadius: '50%',
              width: '18px',
              height: '18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <X size={11} />
          </button>
        )}
      </div>
    );
  }

  // TEXT: render chip (click opens text viewer)
  if (info.class === 'text') {
    const formattedSize = formatFileSize(info.size);
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpenTextViewer?.(name, info.size)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenTextViewer?.(name, info.size);
          }
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.45rem',
          padding: '0.4rem 0.65rem',
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          cursor: 'pointer',
          userSelect: 'none',
          transition: 'border-color 0.15s, background-color 0.15s',
          maxWidth: '320px',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = '#6366f1';
          e.currentTarget.style.backgroundColor = '#24334a';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = '#334155';
          e.currentTarget.style.backgroundColor = '#1e293b';
        }}
        title={`Click to view ${name}`}
      >
        <FileText size={16} color="#818cf8" style={{ flexShrink: 0 }} />
        <span
          style={{
            fontSize: '0.8rem',
            color: '#e2e8f0',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        {formattedSize && (
          <span style={{ fontSize: '0.7rem', color: '#94a3b8', flexShrink: 0 }}>
            ({formattedSize})
          </span>
        )}
        {canRemove && onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title={`Remove ${name}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2px',
              backgroundColor: 'transparent',
              border: 'none',
              borderRadius: '0.2rem',
              color: '#94a3b8',
              cursor: 'pointer',
              flexShrink: 0,
              marginLeft: '0.2rem',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
          >
            <X size={13} />
          </button>
        )}
      </div>
    );
  }

  // PDF: render chip (click downloads PDF)
  const formattedSize = formatFileSize(info.size);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onDownloadPdf?.(name)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDownloadPdf?.(name);
        }
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.45rem',
        padding: '0.4rem 0.65rem',
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.375rem',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'border-color 0.15s, background-color 0.15s',
        maxWidth: '320px',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#f43f5e';
        e.currentTarget.style.backgroundColor = '#2a1e28';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#334155';
        e.currentTarget.style.backgroundColor = '#1e293b';
      }}
      title={`Click to download ${name}`}
    >
      <FileDown size={16} color="#f43f5e" style={{ flexShrink: 0 }} />
      <span
        style={{
          fontSize: '0.8rem',
          color: '#e2e8f0',
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      {formattedSize && (
        <span style={{ fontSize: '0.7rem', color: '#94a3b8', flexShrink: 0 }}>
          ({formattedSize})
        </span>
      )}
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 600,
          padding: '0.1rem 0.35rem',
          borderRadius: '0.2rem',
          backgroundColor: 'rgba(244, 63, 94, 0.15)',
          color: '#fb7185',
          border: '1px solid rgba(244, 63, 94, 0.3)',
          flexShrink: 0,
        }}
      >
        PDF
      </span>
      {canRemove && onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title={`Remove ${name}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2px',
            backgroundColor: 'transparent',
            border: 'none',
            borderRadius: '0.2rem',
            color: '#94a3b8',
            cursor: 'pointer',
            flexShrink: 0,
            marginLeft: '0.2rem',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
};
