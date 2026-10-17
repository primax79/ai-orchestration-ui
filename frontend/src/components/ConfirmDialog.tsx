import React, { useState, useEffect } from 'react';
import { AlertTriangle, AlertCircle, CheckCircle2, X, Loader2 } from 'lucide-react';
import { SafeMarkdown } from './SafeMarkdown';

export interface PlanItem {
  action?: string;
  path?: string;
  reason?: string;
  state?: string;
  current_state?: string;
  before_sha256?: string | null;
  after_sha256?: string | null;
  [key: string]: any;
}

export interface ConfirmDialogPreviewData {
  summary?: string;
  plan?: PlanItem[];
  diff?: string;
  warnings?: string[];
  hash?: string;
}

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  summary?: string;
  plan?: PlanItem[];
  diff?: string;
  warnings?: string[];
  hash?: string;
  applyButtonText?: string;
  cancelButtonText?: string;
  onApply: (hash?: string) => Promise<void>;
  onCancel: () => void;
  onRefetchPreview?: () => Promise<ConfirmDialogPreviewData>;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  summary: initialSummary,
  plan: initialPlan,
  diff: initialDiff,
  warnings: initialWarnings,
  hash: initialHash,
  applyButtonText = 'Apply',
  cancelButtonText = 'Cancel',
  onApply,
  onCancel,
  onRefetchPreview,
}) => {
  const [summary, setSummary] = useState<string | undefined>(initialSummary);
  const [plan, setPlan] = useState<PlanItem[] | undefined>(initialPlan);
  const [diff, setDiff] = useState<string | undefined>(initialDiff);
  const [warnings, setWarnings] = useState<string[] | undefined>(initialWarnings);
  const [hash, setHash] = useState<string | undefined>(initialHash);

  const [isApplying, setIsApplying] = useState(false);
  const [isRefetching, setIsRefetching] = useState(false);
  const [staleError, setStaleError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  // Sync state when props change
  useEffect(() => {
    setSummary(initialSummary);
    setPlan(initialPlan);
    setDiff(initialDiff);
    setWarnings(initialWarnings);
    setHash(initialHash);
    setStaleError(null);
    setInlineError(null);
  }, [initialSummary, initialPlan, initialDiff, initialWarnings, initialHash, isOpen]);

  if (!isOpen) return null;

  const handleApply = async () => {
    setStaleError(null);
    setInlineError(null);
    setIsApplying(true);

    try {
      await onApply(hash);
    } catch (err: any) {
      const status = err?.status;
      const msg = err?.message || String(err);
      const isStale =
        status === 409 ||
        msg.includes('409') ||
        msg.toLowerCase().includes('hash mismatch') ||
        msg.toLowerCase().includes('stale') ||
        msg.toLowerCase().includes('situation changed');

      if (isStale) {
        setStaleError('The situation changed since the preview — review again');
        if (onRefetchPreview) {
          setIsRefetching(true);
          try {
            const updated = await onRefetchPreview();
            if (updated.summary !== undefined) setSummary(updated.summary);
            if (updated.plan !== undefined) setPlan(updated.plan);
            if (updated.diff !== undefined) setDiff(updated.diff);
            if (updated.warnings !== undefined) setWarnings(updated.warnings);
            if (updated.hash !== undefined) setHash(updated.hash);
          } catch (refetchErr: any) {
            setInlineError(`Failed to refresh preview: ${refetchErr?.message || refetchErr}`);
          } finally {
            setIsRefetching(false);
          }
        }
      } else {
        setInlineError(msg);
      }
    } finally {
      setIsApplying(false);
    }
  };

  const renderActionBadge = (action?: string) => {
    if (!action) return null;
    const a = action.toLowerCase();
    let bg = '#334155';
    let text = '#cbd5e1';

    if (a === 'advise') {
      bg = '#1e3a8a';
      text = '#93c5fd';
    } else if (a === 'install' || a === 'create' || a === 'add') {
      bg = '#064e3b';
      text = '#34d399';
    } else if (a === 'replace' || a === 'overwrite' || a === 'modify') {
      bg = '#451a03';
      text = '#fbbf24';
    } else if (a === 'trash' || a === 'delete' || a === 'remove') {
      bg = '#451a1a';
      text = '#fca5a5';
    }

    return (
      <span
        style={{
          fontSize: '0.7rem',
          fontWeight: 700,
          padding: '0.15rem 0.4rem',
          borderRadius: '0.2rem',
          backgroundColor: bg,
          color: text,
          textTransform: 'uppercase',
          letterSpacing: '0.025em',
        }}
      >
        {action}
      </span>
    );
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
        zIndex: 2000,
        padding: '1.5rem',
      }}
    >
      <div
        style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.75rem',
          width: '100%',
          maxWidth: '920px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.5rem',
            borderBottom: '1px solid #334155',
            backgroundColor: '#0f172a',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={20} color="#818cf8" />
            <h2 style={{ fontSize: '1.15rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
              {title}
            </h2>
          </div>
          <button
            onClick={onCancel}
            disabled={isApplying}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              cursor: isApplying ? 'not-allowed' : 'pointer',
              padding: '0.25rem',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Summary */}
          {summary && (
            <div style={{ fontSize: '0.85rem', color: '#cbd5e1', lineHeight: 1.5 }}>
              <SafeMarkdown content={summary} />
            </div>
          )}

          {/* Stale (409) Error Banner */}
          {staleError && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.75rem 1rem',
                borderRadius: '0.375rem',
                backgroundColor: '#451a03',
                border: '1px solid #f59e0b',
                color: '#fef3c7',
                fontSize: '0.85rem',
                fontWeight: 500,
              }}
            >
              <AlertTriangle size={18} color="#f59e0b" />
              <div style={{ flex: 1 }}>
                <span>{staleError}</span>
                {isRefetching && (
                  <span style={{ marginLeft: '0.5rem', color: '#fbbf24', fontSize: '0.8rem' }}>
                    (Refreshing preview...)
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Inline (400/500) Error Banner */}
          {inlineError && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.75rem 1rem',
                borderRadius: '0.375rem',
                backgroundColor: '#451a1a',
                border: '1px solid #ef4444',
                color: '#fca5a5',
                fontSize: '0.85rem',
              }}
            >
              <AlertCircle size={18} color="#ef4444" />
              <span>{inlineError}</span>
            </div>
          )}

          {/* Warnings List */}
          {warnings && warnings.length > 0 && (
            <div
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '0.375rem',
                backgroundColor: '#3b2505',
                border: '1px solid #b45309',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.4rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#fbbf24', fontSize: '0.8rem', fontWeight: 600 }}>
                <AlertTriangle size={15} />
                <span>Warnings & Caveats</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8rem', color: '#fef3c7' }}>
                {warnings.map((w, idx) => (
                  <li key={idx} style={{ margin: '0.15rem 0' }}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Plan Table View */}
          {plan && plan.length > 0 && (
            <div>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Proposed Plan ({plan.length} item{plan.length === 1 ? '' : 's'})
              </div>
              <div style={{ border: '1px solid #334155', borderRadius: '0.375rem', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#0f172a', color: '#94a3b8', borderBottom: '1px solid #334155' }}>
                      <th style={{ padding: '0.5rem 0.75rem', width: '90px' }}>Action</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>Path</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>Reason / Note</th>
                      <th style={{ padding: '0.5rem 0.75rem', width: '100px' }}>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.map((item, idx) => (
                      <tr
                        key={idx}
                        style={{
                          borderBottom: idx === plan.length - 1 ? 'none' : '1px solid #334155',
                          backgroundColor: idx % 2 === 0 ? '#1e293b' : '#182234',
                        }}
                      >
                        <td style={{ padding: '0.5rem 0.75rem', verticalAlign: 'top' }}>
                          {renderActionBadge(item.action)}
                        </td>
                        <td style={{ padding: '0.5rem 0.75rem', verticalAlign: 'top', fontFamily: 'monospace', color: '#e2e8f0', wordBreak: 'break-all' }}>
                          {item.path}
                        </td>
                        <td style={{ padding: '0.5rem 0.75rem', verticalAlign: 'top', color: '#cbd5e1' }}>
                          {item.reason || '—'}
                        </td>
                        <td style={{ padding: '0.5rem 0.75rem', verticalAlign: 'top', color: '#94a3b8' }}>
                          <span style={{ fontSize: '0.75rem', color: '#a5b4fc' }}>
                            {item.state || item.current_state || '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Unified Diff View */}
          {diff && (
            <div>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Unified Diff Preview
              </div>
              <pre
                style={{
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  padding: '0.75rem',
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  lineHeight: 1.45,
                  overflowX: 'auto',
                  maxHeight: '340px',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {diff.split('\n').map((line, idx) => {
                  let color = '#cbd5e1';
                  let bg = 'transparent';
                  if (line.startsWith('+') && !line.startsWith('+++')) {
                    color = '#34d399';
                    bg = 'rgba(6, 78, 59, 0.35)';
                  } else if (line.startsWith('-') && !line.startsWith('---')) {
                    color = '#fca5a5';
                    bg = 'rgba(69, 26, 26, 0.4)';
                  } else if (line.startsWith('@@')) {
                    color = '#38bdf8';
                    bg = 'rgba(15, 23, 42, 0.6)';
                  }
                  return (
                    <div key={idx} style={{ color, backgroundColor: bg, padding: '0 0.2rem' }}>
                      {line}
                    </div>
                  );
                })}
              </pre>
            </div>
          )}

          {/* Empty changes fallback */}
          {!plan?.length && !diff && (
            <div style={{ textAlign: 'center', padding: '1.5rem', color: '#94a3b8', fontSize: '0.85rem' }}>
              No modifications required.
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.85rem 1.5rem',
            backgroundColor: '#0f172a',
            borderTop: '1px solid #334155',
          }}
        >
          <div style={{ fontSize: '0.75rem', color: '#64748b', fontFamily: 'monospace' }}>
            {hash ? (
              <span>
                Plan/Index Hash: <strong style={{ color: '#94a3b8' }}>{hash.slice(0, 16)}...</strong>
              </span>
            ) : null}
          </div>

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              onClick={onCancel}
              disabled={isApplying}
              style={{
                padding: '0.45rem 0.9rem',
                borderRadius: '0.375rem',
                border: '1px solid #475569',
                backgroundColor: 'transparent',
                color: '#cbd5e1',
                fontSize: '0.85rem',
                fontWeight: 500,
                cursor: isApplying ? 'not-allowed' : 'pointer',
              }}
            >
              {cancelButtonText}
            </button>

            <button
              onClick={handleApply}
              disabled={isApplying || isRefetching}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 1rem',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: '#4f46e5',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: isApplying || isRefetching ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 6px -1px rgba(79, 70, 229, 0.3)',
              }}
            >
              {isApplying || isRefetching ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <CheckCircle2 size={16} />
              )}
              <span>{isApplying ? 'Applying...' : isRefetching ? 'Re-fetching...' : applyButtonText}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
