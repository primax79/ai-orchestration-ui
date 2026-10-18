import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Tag, Plus, X, Loader2, AlertCircle, Check } from 'lucide-react';
import { microtaskAndLabelsApi } from '../api';
import { LabelChip } from './LabelChip';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';

interface LabelEditorModalProps {
  taskId: string;
  initialLabels?: string[];
  taskHash?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (updatedLabels: string[]) => void;
}

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

export const LabelEditorModal: React.FC<LabelEditorModalProps> = ({
  taskId,
  initialLabels = [],
  taskHash,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [labels, setLabels] = useState<string[]>(initialLabels);
  const [inputVal, setInputVal] = useState('');
  const [availableLabels, setAvailableLabels] = useState<Array<{ label: string; count: number }>>([]);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmData, setConfirmData] = useState<(ConfirmDialogPreviewData & { title: string }) | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setLabels(initialLabels || []);
      setInputVal('');
      setError(null);
      setConfirmData(null);
      fetchAvailableLabels();
    }
  }, [isOpen, initialLabels]);

  const fetchAvailableLabels = async () => {
    setLoadingLabels(true);
    try {
      const res = await microtaskAndLabelsApi.getLabels();
      if (res && Array.isArray(res.labels)) {
        setAvailableLabels(res.labels);
      }
    } catch {
      // Ignore background label fetch errors
    } finally {
      setLoadingLabels(false);
    }
  };

  const handleAddLabel = (rawLabel: string) => {
    const trimmed = rawLabel.trim().toLowerCase();
    if (!trimmed) return;
    if (!LABEL_RE.test(trimmed)) {
      setError(`Invalid label "${trimmed}". Must be 1-24 alphanumeric lowercase characters or hyphens (^[a-z0-9][a-z0-9-]{0,23}$).`);
      return;
    }
    if (labels.includes(trimmed)) {
      setInputVal('');
      setError(null);
      return;
    }
    setLabels([...labels, trimmed]);
    setInputVal('');
    setError(null);
  };

  const handleRemoveLabel = (labelToRemove: string) => {
    setLabels(labels.filter((l) => l !== labelToRemove));
  };

  const autocompleteSuggestions = useMemo(() => {
    const q = inputVal.trim().toLowerCase();
    return availableLabels
      .filter((item) => !labels.includes(item.label) && (!q || item.label.includes(q)))
      .slice(0, 8);
  }, [availableLabels, labels, inputVal]);

  const handlePreview = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await microtaskAndLabelsApi.previewSetLabels(taskId, {
        to: labels,
        expect_task_hash: taskHash,
      });

      const hashToUse = res.task_hash || res.hash || taskHash;
      setConfirmData({
        title: `Edit Labels for ${taskId}`,
        summary: `Update labels for ${taskId} to: [${labels.join(', ')}]`,
        diff: res.diff,
        hash: hashToUse,
        warnings: undefined,
      });
    } catch (e: any) {
      setError(e.message || 'Failed to preview label changes');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApply = async (hash?: string) => {
    const hashToUse = hash || confirmData?.hash || taskHash;
    const res = await microtaskAndLabelsApi.setLabels(taskId, {
      to: labels,
      expect_task_hash: hashToUse,
    });
    setConfirmData(null);
    onSuccess(res.labels || labels);
    onClose();
  };

  if (!isOpen) return null;

  const content = (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(2px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          padding: '1rem',
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '0.5rem',
            width: '100%',
            maxWidth: '520px',
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.5)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid #1e293b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#1e293b',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Tag size={16} color="#818cf8" />
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#f8fafc' }}>
                Edit Labels — {taskId}
              </h3>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {error && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.6rem 0.8rem',
                  borderRadius: '0.375rem',
                  backgroundColor: '#451a1a',
                  border: '1px solid #ef4444',
                  color: '#fca5a5',
                  fontSize: '0.8rem',
                }}
              >
                <AlertCircle size={15} color="#ef4444" style={{ flexShrink: 0 }} />
                <span>{error}</span>
              </div>
            )}

            {/* Current Labels */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.4rem' }}>
                Current Labels ({labels.length})
              </label>
              <div
                style={{
                  minHeight: '44px',
                  padding: '0.4rem 0.6rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.35rem',
                  alignItems: 'center',
                }}
              >
                {labels.length > 0 ? (
                  labels.map((lbl) => (
                    <LabelChip
                      key={lbl}
                      label={lbl}
                      size="md"
                      onRemove={() => handleRemoveLabel(lbl)}
                    />
                  ))
                ) : (
                  <span style={{ fontSize: '0.8rem', color: '#64748b', fontStyle: 'italic' }}>
                    No labels assigned
                  </span>
                )}
              </div>
            </div>

            {/* Add Label Input */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.4rem' }}>
                Add Label
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  ref={inputRef}
                  type="text"
                  value={inputVal}
                  onChange={(e) => {
                    setInputVal(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddLabel(inputVal);
                    }
                  }}
                  placeholder="e.g. ui, security, regression..."
                  style={{
                    flex: 1,
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '0.375rem',
                    padding: '0.5rem 0.75rem',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={() => handleAddLabel(inputVal)}
                  disabled={!inputVal.trim()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.5rem 0.85rem',
                    backgroundColor: inputVal.trim() ? '#4f46e5' : '#334155',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '0.375rem',
                    fontWeight: 600,
                    fontSize: '0.85rem',
                    cursor: inputVal.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  <Plus size={14} />
                  <span>Add</span>
                </button>
              </div>
            </div>

            {/* Autocomplete Suggestions from tasks labels */}
            {autocompleteSuggestions.length > 0 && (
              <div>
                <span style={{ fontSize: '0.72rem', color: '#64748b', display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                  <span>Existing labels in repository:</span>
                  {loadingLabels && <Loader2 size={11} className="spin" />}
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                  {autocompleteSuggestions.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => handleAddLabel(item.label)}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                    >
                      <LabelChip label={`${item.label} (${item.count})`} size="xs" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '0.75rem 1.25rem',
              borderTop: '1px solid #1e293b',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.5rem',
              backgroundColor: '#0f172a',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                padding: '0.45rem 0.9rem',
                backgroundColor: 'transparent',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#94a3b8',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handlePreview}
              disabled={submitting}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 1rem',
                backgroundColor: '#4f46e5',
                border: 'none',
                borderRadius: '0.375rem',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
              <span>Preview Changes</span>
            </button>
          </div>
        </div>
      </div>

      {/* Confirm Dialog */}
      {confirmData && (
        <ConfirmDialog
          isOpen={true}
          title={confirmData.title}
          summary={confirmData.summary}
          diff={confirmData.diff}
          hash={confirmData.hash}
          warnings={confirmData.warnings}
          applyButtonText="Apply Labels"
          onApply={handleApply}
          onCancel={() => setConfirmData(null)}
        />
      )}
    </>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
};
