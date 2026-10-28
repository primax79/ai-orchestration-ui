import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { CheckCheck, X, Loader2, AlertCircle, AlertTriangle } from 'lucide-react';
import { api, useProject } from '../api';
import { TaskItem, ValidateCloseTaskItem, shortTitle } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

export interface ValidateCloseDialogProps {
  isOpen: boolean;
  tasks: TaskItem[];
  project?: string | null;
  onClose: () => void;
  onSuccess: (indexInSync?: boolean) => void;
}

export const ValidateCloseDialog: React.FC<ValidateCloseDialogProps> = ({
  isOpen,
  tasks,
  project,
  onClose,
  onSuccess,
}) => {
  const defaultProject = useProject();
  const targetProject = project || tasks[0]?.project || defaultProject;

  const [note, setNote] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [previewTasks, setPreviewTasks] = useState<ValidateCloseTaskItem[]>([]);
  const [planHash, setPlanHash] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [staleWarning, setStaleWarning] = useState<string | null>(null);
  const [failingGuard, setFailingGuard] = useState<{
    message: string;
    useCases: string[];
    taskId?: string;
  } | null>(null);
  const [showOwnerApproveConfirm, setShowOwnerApproveConfirm] = useState(false);

  const taskIds = tasks.map((t) => t.id);

  const isUseCaseFailingError = (err: any): { isFailing: boolean; useCases: string[]; message: string; taskId?: string } => {
    const data = err?.data || err?.details || {};
    const msg = data?.error || data?.message || err?.message || String(err);
    const reason = data?.reason || data?.details?.reason;
    const ucIds: string[] =
      data?.use_case_ids ||
      data?.use_cases ||
      data?.details?.use_case_ids ||
      data?.details?.use_cases ||
      [];
    const parsedFromMsg = Array.from(String(msg).matchAll(/\bUC\d{3,}\b/g)).map((m) => m[0]);
    const finalUcIds = Array.from(new Set([...(Array.isArray(ucIds) ? ucIds : []), ...parsedFromMsg]));
    if (
      reason === 'use_case_failing' ||
      String(msg).toLowerCase().includes('use_case_failing') ||
      String(msg).toLowerCase().includes('use case(s) failing') ||
      ucIds.length > 0
    ) {
      return {
        isFailing: true,
        useCases: finalUcIds,
        message: msg,
        taskId: data?.task_id,
      };
    }
    return { isFailing: false, useCases: [], message: msg };
  };

  const fetchPreview = useCallback(async (ownerApproved = false) => {
    if (!isOpen || taskIds.length === 0) return;
    setLoadingPreview(true);
    setError(null);
    if (!ownerApproved) {
      setFailingGuard(null);
    }
    try {
      const res = await api.previewValidateClose(
        {
          task_ids: taskIds,
          note: note.trim() || undefined,
          owner_approved: ownerApproved || undefined,
        },
        targetProject
      );
      setPreviewTasks(res.tasks || []);
      setPlanHash(res.plan_hash || res.hash || '');
    } catch (err: any) {
      const guard = isUseCaseFailingError(err);
      if (guard.isFailing) {
        setFailingGuard({
          message: guard.message,
          useCases: guard.useCases,
          taskId: guard.taskId,
        });
      } else {
        setError(err?.message || String(err));
      }
    } finally {
      setLoadingPreview(false);
    }
  }, [isOpen, taskIds.join(','), targetProject]);

  useEffect(() => {
    if (isOpen) {
      setNote('');
      setError(null);
      setStaleWarning(null);
      setFailingGuard(null);
      setShowOwnerApproveConfirm(false);
      setPreviewTasks(
        tasks.map((t) => ({
          id: t.id,
          task_id: t.id,
          title: t.title,
          short_title: t.short_title || shortTitle(t),
          state: t.state,
          verify_by: t.verify_by || t['verify-by'] || null,
          verifier: 'owner',
        }))
      );
      setPlanHash('');
      fetchPreview(false);
    }
  }, [isOpen, tasks.map((t) => t.id).join(',')]);

  if (!isOpen) return null;

  const executeApply = async (ownerApproved = false) => {
    if (taskIds.length === 0 || applying) return;
    setApplying(true);
    setError(null);
    setStaleWarning(null);
    try {
      if (ownerApproved) {
        let lastInSync: boolean | undefined = undefined;
        for (const tid of taskIds) {
          const res = await api.transitionTask(
            tid,
            'done',
            'operator',
            'owner',
            note.trim() || undefined,
            undefined,
            true,
            targetProject
          );
          if (res && res.index_in_sync !== undefined) {
            lastInSync = res.index_in_sync;
          }
        }
        setShowOwnerApproveConfirm(false);
        onSuccess(lastInSync);
        onClose();
        return;
      }

      const res = await api.applyValidateClose(
        {
          task_ids: taskIds,
          note: note.trim() || undefined,
          expect_plan_hash: planHash || undefined,
        },
        targetProject
      );
      setShowOwnerApproveConfirm(false);
      onSuccess(res.index_in_sync);
      onClose();
    } catch (err: any) {
      const guard = isUseCaseFailingError(err);
      if (guard.isFailing) {
        setFailingGuard({
          message: guard.message,
          useCases: guard.useCases,
          taskId: guard.taskId,
        });
        return;
      }
      const status = err?.status;
      const msg = err?.message || String(err);
      const isStale =
        status === 409 ||
        msg.includes('409') ||
        msg.toLowerCase().includes('stale') ||
        msg.toLowerCase().includes('hash mismatch');
      if (isStale) {
        setStaleWarning('Task states or hashes changed since preview — refreshed preview below. Please review and confirm again.');
        await fetchPreview(ownerApproved);
      } else {
        setError(msg);
      }
    } finally {
      setApplying(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (taskIds.length === 0 || applying || loadingPreview) return;
    await executeApply(false);
  };

  const displayList: ValidateCloseTaskItem[] =
    previewTasks.length > 0
      ? previewTasks
      : tasks.map((t) => ({
          id: t.id,
          task_id: t.id,
          title: t.title,
          short_title: t.short_title || shortTitle(t),
          state: t.state,
          verify_by: t.verify_by || t['verify-by'] || null,
          verifier: 'owner',
        }));

  const dialog = (
    <div
      onClick={() => !applying && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2100,
        padding: '1.25rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.75rem',
          width: '100%',
          maxWidth: '640px',
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
            padding: '1rem 1.25rem',
            borderBottom: '1px solid #334155',
            backgroundColor: '#0f172a',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CheckCheck size={19} color="#10b981" />
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
              Validate &amp; Close ({displayList.length} task{displayList.length === 1 ? '' : 's'})
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              cursor: applying ? 'not-allowed' : 'pointer',
              padding: '0.2rem',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleConfirm} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '1.1rem 1.25rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.9rem',
            }}
          >
            <div style={{ fontSize: '0.82rem', color: '#cbd5e1', lineHeight: 1.45 }}>
              Transition {displayList.length === 1 ? 'this task' : `these ${displayList.length} tasks`} to{' '}
              <code style={{ backgroundColor: '#0f172a', padding: '0.1rem 0.35rem', borderRadius: '0.2rem', color: '#34d399' }}>
                done
              </code>{' '}
              with independent verifier{' '}
              <code style={{ backgroundColor: '#0f172a', padding: '0.1rem 0.35rem', borderRadius: '0.2rem', color: '#a5b4fc' }}>
                owner
              </code>
              .
            </div>

            {staleWarning && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.65rem 0.85rem',
                  borderRadius: '0.375rem',
                  backgroundColor: '#451a03',
                  border: '1px solid #f59e0b',
                  color: '#fef3c7',
                  fontSize: '0.8rem',
                }}
              >
                <AlertTriangle size={16} color="#f59e0b" style={{ flexShrink: 0 }} />
                <span>{staleWarning}</span>
              </div>
            )}

            {/* Closing Guard (409 use_case_failing) */}
            {failingGuard && (
              <div
                style={{
                  padding: '0.85rem 1rem',
                  borderRadius: '0.5rem',
                  backgroundColor: '#451a1a',
                  border: '1px solid #ef4444',
                  color: '#fca5a5',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.6rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <AlertCircle size={17} color="#ef4444" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#fecaca', marginBottom: '0.2rem' }}>
                      Closing Guard: Linked Use Case(s) Failing
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#fca5a5', lineHeight: 1.4 }}>
                      {failingGuard.message}
                    </div>
                    {failingGuard.useCases.length > 0 && (
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.45rem' }}>
                        {failingGuard.useCases.map((ucId) => (
                          <span
                            key={ucId}
                            style={{
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              fontFamily: 'monospace',
                              padding: '0.12rem 0.45rem',
                              borderRadius: '0.25rem',
                              backgroundColor: '#7f1d1d',
                              color: '#fecaca',
                              border: '1px solid #ef4444',
                            }}
                          >
                            {ucId} (failing)
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => setShowOwnerApproveConfirm(true)}
                    disabled={applying}
                    style={{
                      padding: '0.4rem 0.85rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #f59e0b',
                      backgroundColor: '#d97706',
                      color: '#fff',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: applying ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Close anyway (owner approved)
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.65rem 0.85rem',
                  borderRadius: '0.375rem',
                  backgroundColor: '#451a1a',
                  border: '1px solid #ef4444',
                  color: '#fca5a5',
                  fontSize: '0.8rem',
                }}
              >
                <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0 }} />
                <span>{error}</span>
              </div>
            )}

            {/* Affected tasks list */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: '#94a3b8',
                  textTransform: 'uppercase',
                  marginBottom: '0.4rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>Affected Tasks ({displayList.length})</span>
                {loadingPreview && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: '#818cf8', textTransform: 'none' }}>
                    <Loader2 size={12} className="spin" />
                    Checking preview…
                  </span>
                )}
              </div>

              <div
                style={{
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  backgroundColor: '#0f172a',
                  maxHeight: '240px',
                  overflowY: 'auto',
                }}
              >
                {displayList.map((item, idx) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.6rem',
                      padding: '0.5rem 0.75rem',
                      borderBottom: idx === displayList.length - 1 ? 'none' : '1px solid #1e293b',
                      fontSize: '0.8rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontWeight: 700,
                          color: '#818cf8',
                          flexShrink: 0,
                        }}
                      >
                        {item.id}
                      </span>
                      <span
                        style={{
                          color: '#f8fafc',
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={item.title}
                      >
                        {item.short_title || shortTitle(item)}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                      {item.verify_by && (
                        <span
                          style={{
                            fontSize: '0.68rem',
                            padding: '0.1rem 0.4rem',
                            borderRadius: '0.2rem',
                            backgroundColor: '#1e3a8a',
                            border: '1px solid #3b82f6',
                            color: '#bfdbfe',
                            fontFamily: 'monospace',
                          }}
                          title={`verify-by: ${item.verify_by}`}
                        >
                          verify-by: {item.verify_by}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: '0.7rem',
                          padding: '0.1rem 0.4rem',
                          borderRadius: '0.2rem',
                          backgroundColor: '#1e293b',
                          color: '#34d399',
                          fontFamily: 'monospace',
                        }}
                      >
                        {item.path ? item.path.join(' → ') : `${item.state} → done`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Optional validation note */}
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: '#94a3b8',
                  marginBottom: '0.35rem',
                }}
              >
                Validation Note (optional)
              </label>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Validated in live workspace by owner"
                disabled={applying}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #475569',
                  backgroundColor: '#0f172a',
                  color: '#f8fafc',
                  fontSize: '0.82rem',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.8rem 1.25rem',
              backgroundColor: '#0f172a',
              borderTop: '1px solid #334155',
            }}
          >
            <div style={{ fontSize: '0.72rem', color: '#64748b', fontFamily: 'monospace' }}>
              {planHash ? (
                <span>
                  Preview Hash: <strong style={{ color: '#94a3b8' }}>{planHash.slice(0, 12)}…</strong>
                </span>
              ) : (
                <span>Verifier: owner</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={applying}
                style={{
                  padding: '0.4rem 0.85rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #475569',
                  backgroundColor: 'transparent',
                  color: '#cbd5e1',
                  fontSize: '0.82rem',
                  fontWeight: 500,
                  cursor: applying ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={applying || loadingPreview || displayList.length === 0 || Boolean(error) || Boolean(failingGuard)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.95rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor:
                    applying || loadingPreview || displayList.length === 0 || Boolean(error) || Boolean(failingGuard)
                      ? '#334155'
                      : '#10b981',
                  color:
                    applying || loadingPreview || displayList.length === 0 || Boolean(error) || Boolean(failingGuard)
                      ? '#64748b'
                      : '#fff',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor:
                    applying || loadingPreview || displayList.length === 0 || Boolean(error) || Boolean(failingGuard)
                      ? 'not-allowed'
                      : 'pointer',
                }}
              >
                {applying ? <Loader2 size={15} className="spin" /> : <CheckCheck size={15} />}
                <span>{applying ? 'Validating & closing…' : 'Confirm'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Confirmation dialog for Close anyway (owner approved) */}
      {showOwnerApproveConfirm && failingGuard && (
        <ConfirmDialog
          isOpen={true}
          title="Close anyway (owner approved)?"
          summary={`The closing guard blocked this transition because linked approved use case(s) are failing${
            failingGuard.useCases.length > 0 ? ` (**${failingGuard.useCases.join(', ')}**)` : ''
          }:\n\n> ${failingGuard.message}\n\nConfirming will resend the transition with \`owner_approved: true\`.`}
          warnings={['Overriding the closing guard closes the task while linked use cases remain in a failing state.']}
          applyButtonText="Close anyway (owner approved)"
          danger={true}
          onApply={async () => {
            await executeApply(true);
          }}
          onCancel={() => setShowOwnerApproveConfirm(false)}
        />
      )}
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
};
