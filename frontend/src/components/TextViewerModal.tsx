import React, { useState, useEffect } from 'react';
import { X, FileText, Download, Loader2, AlertCircle } from 'lucide-react';
import { formatFileSize } from './AttachmentComponents';

export interface TextViewerModalProps {
  filename: string | null;
  size?: number;
  fetchContent: () => Promise<string | Blob>;
  onClose: () => void;
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MB

export const TextViewerModal: React.FC<TextViewerModalProps> = ({
  filename,
  size,
  fetchContent,
  onClose,
}) => {
  const [content, setContent] = useState<string | null>(null);
  const [rawBlob, setRawBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    if (!filename) return;

    let active = true;
    setLoading(true);
    setError(null);
    setContent(null);
    setIsTruncated(false);
    setRawBlob(null);

    fetchContent()
      .then(async (res) => {
        if (!active) return;
        let text = '';
        if (typeof res === 'string') {
          text = res;
          setRawBlob(new Blob([text], { type: 'text/plain; charset=utf-8' }));
        } else {
          setRawBlob(res);
          text = await res.text();
        }

        if (!active) return;
        if (text.length > MAX_PREVIEW_BYTES) {
          setContent(text.slice(0, MAX_PREVIEW_BYTES));
          setIsTruncated(true);
        } else {
          setContent(text);
          setIsTruncated(false);
        }
        setLoading(false);
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message || 'Failed to load attachment content');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [filename, fetchContent]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!filename) return null;

  const handleDownload = () => {
    if (!rawBlob && content === null) return;
    const blob = rawBlob || new Blob([content || ''], { type: 'text/plain; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2500,
        padding: '1.5rem',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '900px',
          maxHeight: '90vh',
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.6rem',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.85rem 1.25rem',
            borderBottom: '1px solid #334155',
            backgroundColor: '#0f172a',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', overflow: 'hidden' }}>
            <FileText size={18} color="#818cf8" style={{ flexShrink: 0 }} />
            <span
              style={{
                fontSize: '0.95rem',
                fontWeight: 600,
                color: '#f8fafc',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {filename}
            </span>
            {size !== undefined && (
              <span style={{ fontSize: '0.75rem', color: '#94a3b8', flexShrink: 0 }}>
                ({formatFileSize(size)})
              </span>
            )}
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 600,
                padding: '0.1rem 0.4rem',
                borderRadius: '0.25rem',
                backgroundColor: 'rgba(99, 102, 241, 0.15)',
                color: '#a5b4fc',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                flexShrink: 0,
                textTransform: 'uppercase',
              }}
            >
              Text Viewer
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
            <button
              onClick={handleDownload}
              disabled={loading || !!error}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.35rem 0.65rem',
                borderRadius: '0.375rem',
                border: '1px solid #334155',
                backgroundColor: '#1e293b',
                color: '#cbd5e1',
                fontSize: '0.75rem',
                fontWeight: 500,
                cursor: loading || !!error ? 'not-allowed' : 'pointer',
              }}
              title="Download file"
            >
              <Download size={14} />
              <span>Download</span>
            </button>
            <button
              onClick={onClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '28px',
                height: '28px',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: 'transparent',
                color: '#94a3b8',
                cursor: 'pointer',
              }}
              title="Close viewer"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Truncation Warning */}
        {isTruncated && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1.25rem',
              backgroundColor: '#451a03',
              borderBottom: '1px solid #78350f',
              color: '#fcd34d',
              fontSize: '0.78rem',
            }}
          >
            <AlertCircle size={15} style={{ flexShrink: 0 }} />
            <span>
              This file exceeds 2 MB. Showing the first 2 MB preview. Use <strong>Download</strong> to view the full file.
            </span>
          </div>
        )}

        {/* Body content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem', backgroundColor: '#090d16' }}>
          {loading ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '3rem',
                gap: '0.6rem',
                color: '#818cf8',
                fontSize: '0.85rem',
              }}
            >
              <Loader2 size={20} className="spin" />
              <span>Loading text content...</span>
            </div>
          ) : error ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '1.5rem',
                color: '#f87171',
                backgroundColor: '#451a1a',
                borderRadius: '0.375rem',
                border: '1px solid #7f1d1d',
                fontSize: '0.85rem',
              }}
            >
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
          ) : (
            <pre
              style={{
                margin: 0,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: '0.82rem',
                lineHeight: 1.5,
                color: '#e2e8f0',
                whiteSpace: 'pre',
                overflowX: 'auto',
                tabSize: 2,
              }}
            >
              {content || ''}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0.75rem 1.25rem',
            borderTop: '1px solid #334155',
            backgroundColor: '#0f172a',
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '0.4rem 1rem',
              borderRadius: '0.375rem',
              border: '1px solid #334155',
              backgroundColor: '#1e293b',
              color: '#e2e8f0',
              fontSize: '0.8rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
