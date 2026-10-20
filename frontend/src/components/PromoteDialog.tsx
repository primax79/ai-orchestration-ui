import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X, Loader2, AlertCircle } from 'lucide-react';
import { microtaskAndLabelsApi, useProject } from '../api';
import { ConfirmDialog } from './ConfirmDialog';

interface PromoteDialogProps {
  taskId: string;
  project?: string | null;
  taskTitle?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  taskHash?: string;
}

const COMMON_CATEGORIES = [
  'maintenance',
  'bugfix',
  'feature',
  'docs',
  'methodology',
  'tooling',
  'platform',
];

export const PromoteDialog: React.FC<PromoteDialogProps> = ({
  taskId,
  project,
  taskTitle,
  isOpen,
  onClose,
  onSuccess,
  taskHash,
}) => {
  const defaultProject = useProject();
  const targetProject = project || defaultProject;
  const [category, setCategory] = useState('maintenance');
  const [customCategory, setCustomCategory] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    isOpen: boolean;
    title: string;
    summary?: string;
    diff?: string;
    hash?: string;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCategory('maintenance');
      setCustomCategory('');
      setIsCustom(false);
      setError(null);
      setPreviewData(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const targetCategory = (isCustom ? customCategory.trim() : category.trim()) || 'maintenance';

  const handlePreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetCategory) {
      setError('Please choose or enter a target category');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await microtaskAndLabelsApi.previewPromoteMicrotask(taskId, {
        category: targetCategory,
        expect_task_hash: taskHash,
      }, targetProject);

      setPreviewData({
        isOpen: true,
        title: `Promote ${taskId} to Full Task`,
        summary: `Promote microtask ${taskId} into category "${targetCategory}". The task keeps its ID and existing links, and gains Goal, Steps, and Verification sections.`,
        diff: res.diff,
        hash: res.hash || res.task_hash || taskHash,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to preview promotion');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApply = async (hash?: string) => {
    const hashToUse = hash || previewData?.hash || taskHash;
    await microtaskAndLabelsApi.promoteMicrotask(taskId, {
      category: targetCategory,
      expect_task_hash: hashToUse,
    }, targetProject);
    setPreviewData(null);
    onSuccess();
    onClose();
  };

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
            maxWidth: '500px',
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
              <ArrowUpRight size={18} color="#818cf8" />
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#f8fafc' }}>
                Promote Microtask to Full Task
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
          <form onSubmit={handlePreview} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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

            {/* Task Info */}
            <div
              style={{
                padding: '0.6rem 0.75rem',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
              }}
            >
              <div style={{ fontSize: '0.75rem', color: '#818cf8', fontWeight: 700, fontFamily: 'monospace' }}>
                {taskId}
              </div>
              <div style={{ fontSize: '0.85rem', color: '#f8fafc', fontWeight: 500, marginTop: '0.15rem' }}>
                {taskTitle || 'Microtask'}
              </div>
            </div>

            {/* Explanation */}
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.4 }}>
              Promoting moves this microtask out of <code style={{ color: '#a5b4fc' }}>tasks/micro/</code> into a target category folder, adding standard emergent task sections (Goal, Steps, Verification) while keeping its ID, links, and history.
            </div>

            {/* Category Selection */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.4rem' }}>
                Target Category
              </label>

              {!isCustom ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    style={{
                      width: '100%',
                      backgroundColor: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: '0.375rem',
                      padding: '0.5rem 0.75rem',
                      color: '#f8fafc',
                      fontSize: '0.85rem',
                      outline: 'none',
                    }}
                  >
                    {COMMON_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setIsCustom(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#818cf8',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      textAlign: 'left',
                      padding: 0,
                    }}
                  >
                    + Enter custom category folder
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <input
                    type="text"
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    placeholder="e.g. backend, ui, integrations..."
                    autoFocus
                    style={{
                      width: '100%',
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
                    onClick={() => setIsCustom(false)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#818cf8',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      textAlign: 'left',
                      padding: 0,
                    }}
                  >
                    ← Choose from standard categories
                  </button>
                </div>
              )}
            </div>

            {/* Footer Buttons */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '0.5rem',
                marginTop: '0.5rem',
                paddingTop: '0.75rem',
                borderTop: '1px solid #1e293b',
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
                type="submit"
                disabled={submitting}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
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
                {submitting ? <Loader2 size={14} className="spin" /> : <ArrowUpRight size={14} />}
                <span>Preview Promote</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Confirm Dialog */}
      {previewData && (
        <ConfirmDialog
          isOpen={true}
          title={previewData.title}
          summary={previewData.summary}
          diff={previewData.diff}
          hash={previewData.hash}
          applyButtonText="Confirm & Promote"
          onApply={handleApply}
          onCancel={() => setPreviewData(null)}
        />
      )}
    </>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
};
