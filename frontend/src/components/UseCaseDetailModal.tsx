import React, { useState, useEffect, useCallback } from 'react';
import { X, Play, Loader2, CheckCircle2, AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';
import {
  UseCaseItem,
  UseCaseApprovalResponse,
  buildApprovalSummary,
  TaskItem,
  shortTitle,
  getUseCaseStage,
  getUseCaseStageStyle,
  getUseCaseApprovalStyle,
} from '../types';
import { api, useProject } from '../api';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';

interface UseCaseDetailModalProps {
  useCase: UseCaseItem;
  tasks?: TaskItem[];
  onSelectTask?: (taskId: string) => void;
  onClose: () => void;
  onRefresh: () => void;
}

const getTaskStateColor = (state?: string) => {
  const st = (state || 'open').toLowerCase();
  if (st === 'done' || st === 'done with a caveat') return { bg: '#064e3b', text: '#6ee7b7', border: '#059669' };
  if (st === 'verified') return { bg: '#065f46', text: '#a7f3d0', border: '#10b981' };
  if (st === 'delivered') return { bg: '#0c4a6e', text: '#bae6fd', border: '#0284c7' };
  if (st === 'in progress') return { bg: '#312e81', text: '#c7d2fe', border: '#6366f1' };
  if (st === 'waiting') return { bg: '#831843', text: '#fbcfe8', border: '#db2777' };
  if (st === 'blocked' || st === 'bounced') return { bg: '#7f1d1d', text: '#fca5a5', border: '#ef4444' };
  if (st === 'paused') return { bg: '#78350f', text: '#fde68a', border: '#d97706' };
  if (st === 'dropped') return { bg: '#1e293b', text: '#94a3b8', border: '#475569' };
  return { bg: '#1e293b', text: '#cbd5e1', border: '#334155' };
};

export const UseCaseDetailModal: React.FC<UseCaseDetailModalProps> = ({
  useCase: initialUseCase,
  tasks = [],
  onSelectTask,
  onClose,
  onRefresh,
}) => {
  const targetProject = useProject();
  const [currentUc, setCurrentUc] = useState<UseCaseItem>(initialUseCase);
  const [validating, setValidating] = useState(false);
  const [valResult, setValResult] = useState<any>(null);
  const [notReadyConflict, setNotReadyConflict] = useState<{
    message: string;
    stage?: string;
    approval?: string;
    progress?: string;
  } | null>(null);
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalConfirmData, setApprovalConfirmData] = useState<{
    action: 'approve' | 'deprecate' | 'propose';
    title: string;
    preview: UseCaseApprovalResponse;
  } | null>(null);

  const reloadDetail = useCallback(async () => {
    try {
      const res = await api.getUseCase(initialUseCase.id, targetProject);
      if (res && res.use_case) {
        setCurrentUc(res.use_case);
      }
    } catch {
      // keep existing if reload fails
    }
  }, [initialUseCase.id, targetProject]);

  useEffect(() => {
    setCurrentUc(initialUseCase);
    reloadDetail();
  }, [initialUseCase, reloadDetail]);

  const handleValidate = async (force = false) => {
    setValidating(true);
    setValResult(null);
    if (!force) {
      setNotReadyConflict(null);
    }
    try {
      const res = await api.validateUseCase(currentUc.id, { timeout: 60, force: force || undefined }, targetProject);
      setValResult(res);
      setNotReadyConflict(null);
      setShowForceConfirm(false);
      await reloadDetail();
      onRefresh();
    } catch (e: any) {
      const status = e?.status;
      const errData = e?.data;
      const msg = errData?.error || errData?.message || e?.message || String(e);
      if (status === 409 || errData?.reason === 'not_ready' || String(msg).toLowerCase().includes('not ready')) {
        setNotReadyConflict({
          message: msg,
          stage: errData?.stage,
          approval: errData?.approval,
          progress: errData?.progress || (errData?.tasks_total !== undefined ? `${errData.tasks_done ?? 0}/${errData.tasks_total}` : undefined),
        });
      } else {
        alert(`Validation error: ${msg}`);
      }
    } finally {
      setValidating(false);
    }
  };

  const handleTriggerApproval = async (action: 'approve' | 'deprecate' | 'propose') => {
    setApproving(true);
    try {
      const res = await api.previewUseCaseApproval({ action, ids: [currentUc.id] }, targetProject);
      const actionLabels = {
        approve: 'Approve',
        deprecate: 'Deprecate',
        propose: 'Move Back to Proposed for',
      };
      setApprovalConfirmData({
        action,
        title: `${actionLabels[action]} Use Case ${currentUc.id}`,
        preview: res,
      });
    } catch (e: any) {
      alert(`Approval preview error: ${e?.message || e}`);
    } finally {
      setApproving(false);
    }
  };

  const handleApplyApproval = async (planHash?: string) => {
    if (!approvalConfirmData) return;
    const { action } = approvalConfirmData;
    await api.applyUseCaseApproval(
      {
        action,
        ids: [currentUc.id],
        expect_plan_hash: planHash,
      },
      targetProject
    );
    setApprovalConfirmData(null);
    await reloadDetail();
    onRefresh();
  };

  const handleRefetchApprovalPreview = async (): Promise<ConfirmDialogPreviewData> => {
    if (!approvalConfirmData) return {};
    const res = await api.previewUseCaseApproval(
      { action: approvalConfirmData.action, ids: [currentUc.id] },
      targetProject
    );
    setApprovalConfirmData((prev) => (prev ? { ...prev, preview: res } : null));
    return {
      summary: buildApprovalSummary(res),
      plan: res.plan,
      diff: res.diff,
      hash: res.plan_hash,
    };
  };

  const stage = getUseCaseStage(currentUc);
  const stageStyle = getUseCaseStageStyle(stage);
  const approval = currentUc.approval || 'proposed';
  const approvalStyle = getUseCaseApprovalStyle(approval);
  const isRevalidationPending = currentUc.revalidation === 'pending' || stage === 'ready (revalidation pending)';

  // Resolve linked tasks details
  const rawLinkedDetails =
    currentUc.linked_tasks_details && currentUc.linked_tasks_details.length > 0
      ? currentUc.linked_tasks_details
      : (currentUc.linked_tasks || []).map((tid) => {
          const found = tasks.find((t) => t.id === tid);
          return {
            id: tid,
            title: found?.title,
            short_title: found?.short_title,
            state: found?.state || 'open',
            canonical_state: found?.canonical_state || found?.state || 'open',
            dropped: (found?.state || '') === 'dropped',
          };
        });

  const nonDroppedLinked = rawLinkedDetails.filter(
    (t) => !t.dropped && (t.canonical_state || t.state) !== 'dropped'
  );
  const doneCount = nonDroppedLinked.filter((t) => {
    const st = (t.canonical_state || t.state || '').toLowerCase();
    return st === 'done' || st === 'done with a caveat' || st === 'verified';
  }).length;
  const totalLinked = nonDroppedLinked.length;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '2rem',
    }}>
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.75rem',
        width: '100%',
        maxWidth: '850px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid #334155',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '0.25rem', backgroundColor: '#4f46e5', color: '#fff' }}>
                {currentUc.id}
              </span>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 500 }} title={currentUc.title}>
                ({shortTitle(currentUc)})
              </span>
              {/* Stage Badge */}
              <span style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '0.15rem 0.55rem',
                borderRadius: '1rem',
                backgroundColor: stageStyle.bg,
                color: stageStyle.color,
                border: `1px solid ${stageStyle.border}`,
              }}>
                {stageStyle.label}
              </span>
              {/* Approval Badge (shown when not approved, or in detail header) */}
              {approval !== 'approved' ? (
                <span style={{
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  padding: '0.12rem 0.45rem',
                  borderRadius: '0.25rem',
                  backgroundColor: approvalStyle.bg,
                  color: approvalStyle.color,
                  border: `1px solid ${approvalStyle.border}`,
                  textTransform: 'uppercase',
                }}>
                  {approvalStyle.label}
                </span>
              ) : (
                <span style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  padding: '0.12rem 0.45rem',
                  borderRadius: '0.25rem',
                  backgroundColor: approvalStyle.bg,
                  color: approvalStyle.color,
                  border: `1px solid ${approvalStyle.border}`,
                  textTransform: 'uppercase',
                }}>
                  approved
                </span>
              )}
              {(currentUc.approved_by || (currentUc as any)['approved-by']) && (
                <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                  by <strong>{currentUc.approved_by || (currentUc as any)['approved-by']}</strong>
                  {(currentUc.approved || currentUc.approved_date) ? ` on ${currentUc.approved || currentUc.approved_date}` : ''}
                </span>
              )}
              {isRevalidationPending && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  padding: '0.12rem 0.45rem',
                  borderRadius: '0.25rem',
                  backgroundColor: '#451a03',
                  color: '#fde68a',
                  border: '1px solid #f59e0b',
                }}>
                  <RefreshCw size={11} />
                  <span>Revalidation pending</span>
                </span>
              )}
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Actor: <strong>{currentUc.actor}</strong></span>
            </div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600, color: '#f8fafc' }}>{currentUc.title}</h2>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.25rem' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Metadata Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '0.75rem',
            padding: '1rem',
            backgroundColor: '#0f172a',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            fontSize: '0.85rem',
          }}>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Stage</div>
              <div style={{ fontWeight: 600, color: stageStyle.color }}>{stage}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Approval</div>
              <div style={{ fontWeight: 600, color: approvalStyle.color }}>{approval}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Approved By</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>
                {currentUc.approved_by || (currentUc as any)['approved-by'] || '—'}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Approved Date</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>
                {currentUc.approved || currentUc.approved_date || '—'}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Priority</div>
              <div style={{ fontWeight: 600, color: '#f8fafc' }}>{currentUc.priority}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Tasks Progress</div>
              <div style={{ fontWeight: 600, color: totalLinked > 0 && doneCount === totalLinked ? '#34d399' : '#f1f5f9' }}>
                {doneCount}/{totalLinked} done
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Last Verdict</div>
              <div style={{
                fontWeight: 600,
                color: currentUc.last_verdict === 'pass'
                  ? '#10b981'
                  : currentUc.last_verdict === 'fail'
                  ? '#ef4444'
                  : currentUc.last_verdict === 'partial'
                  ? '#f59e0b'
                  : '#94a3b8',
              }}>
                {(currentUc.last_verdict || 'untested').toUpperCase()}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Revalidation</div>
              <div style={{
                fontWeight: 600,
                color: isRevalidationPending ? '#fbbf24' : '#94a3b8',
              }}>
                {isRevalidationPending ? 'Pending' : 'None'}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Last Tested</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{currentUc.last_tested || 'Never'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Verification Type</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{currentUc.verification_type}</div>
            </div>
          </div>

          {/* 409 Not Ready Conflict Banner */}
          {notReadyConflict && (
            <div style={{
              padding: '0.9rem 1rem',
              borderRadius: '0.5rem',
              backgroundColor: '#451a03',
              border: '1px solid #f59e0b',
              color: '#fef3c7',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', flex: 1, minWidth: '240px' }}>
                <AlertTriangle size={18} color="#f59e0b" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#fde68a', marginBottom: '0.2rem' }}>
                    Use Case Not Ready for Validation (409)
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#fef3c7', lineHeight: 1.4 }}>
                    {notReadyConflict.message}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowForceConfirm(true)}
                disabled={validating}
                style={{
                  padding: '0.4rem 0.85rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #f59e0b',
                  backgroundColor: '#d97706',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: validating ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Validate anyway
              </button>
            </div>
          )}

          {/* Linked Tasks with states and N/M done */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#818cf8', textTransform: 'uppercase', margin: 0 }}>
                Linked Implementation Tasks ({doneCount}/{totalLinked} done)
              </h3>
            </div>
            {rawLinkedDetails.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {rawLinkedDetails.map((t) => {
                  const stColor = getTaskStateColor(t.state || t.canonical_state);
                  return (
                    <div
                      key={t.id}
                      onClick={() => {
                        if (onSelectTask) {
                          onSelectTask(t.id);
                        }
                      }}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        backgroundColor: '#0f172a',
                        border: '1px solid #334155',
                        cursor: onSelectTask ? 'pointer' : 'default',
                        transition: 'border-color 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (onSelectTask) e.currentTarget.style.borderColor = '#6366f1';
                      }}
                      onMouseLeave={(e) => {
                        if (onSelectTask) e.currentTarget.style.borderColor = '#334155';
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                        <span style={{
                          fontFamily: 'monospace',
                          fontWeight: 700,
                          fontSize: '0.8rem',
                          color: '#818cf8',
                          textDecoration: onSelectTask ? 'underline' : 'none',
                        }}>
                          {t.id}
                        </span>
                        {t.title && (
                          <span style={{
                            fontSize: '0.82rem',
                            color: '#e2e8f0',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {t.title}
                          </span>
                        )}
                      </div>
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        padding: '0.12rem 0.45rem',
                        borderRadius: '0.25rem',
                        backgroundColor: stColor.bg,
                        color: stColor.text,
                        border: `1px solid ${stColor.border}`,
                        flexShrink: 0,
                      }}>
                        {t.state || t.canonical_state || 'open'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{
                padding: '0.75rem',
                borderRadius: '0.375rem',
                backgroundColor: '#0f172a',
                border: '1px dashed #334155',
                color: '#64748b',
                fontSize: '0.8rem',
                fontStyle: 'italic',
              }}>
                No tasks linked to this use case yet (0/0 done).
              </div>
            )}
          </div>

          {/* Live Validation Result */}
          {valResult && (
            <div style={{
              padding: '0.75rem 1rem',
              borderRadius: '0.375rem',
              backgroundColor: valResult.verdict === 'pass' ? '#064e3b' : '#451a1a',
              border: `1px solid ${valResult.verdict === 'pass' ? '#10b981' : '#ef4444'}`,
              color: '#f8fafc',
              fontSize: '0.85rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
                {valResult.verdict === 'pass' ? <CheckCircle2 size={16} color="#10b981" /> : <AlertTriangle size={16} color="#ef4444" />}
                <span>
                  AI Validation Result: {valResult.verdict?.toUpperCase()}
                  {valResult.forced ? ' (forced)' : ''}
                </span>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>{valResult.summary || valResult.message}</div>
            </div>
          )}

          {/* Description */}
          {currentUc.description && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
                Description & Business Value
              </h3>
              <div style={{ backgroundColor: '#0f172a', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #334155', fontSize: '0.85rem', color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>
                {currentUc.description}
              </div>
            </div>
          )}

          {/* Preconditions */}
          {currentUc.preconditions && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
                Preconditions
              </h3>
              <div style={{ backgroundColor: '#0f172a', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #334155', fontSize: '0.85rem', color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>
                {currentUc.preconditions}
              </div>
            </div>
          )}

          {/* Scenario Steps */}
          {currentUc.scenario && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
                Scenario / Interaction Steps
              </h3>
              <div style={{ backgroundColor: '#0f172a', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #334155', fontSize: '0.85rem', color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {currentUc.scenario}
              </div>
            </div>
          )}

          {/* Automated Verification Command */}
          {currentUc.verification_command && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
                Automated Verification Command
              </h3>
              <pre style={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                padding: '0.75rem',
                fontSize: '0.8rem',
                color: '#34d399',
                fontFamily: 'monospace',
                overflowX: 'auto',
              }}>
                {currentUc.verification_command}
              </pre>
            </div>
          )}

          {/* AI Validation Log */}
          {currentUc.validation_log && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
                AI Validation History
              </h3>
              <pre style={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                padding: '0.75rem',
                fontSize: '0.8rem',
                color: '#cbd5e1',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                maxHeight: '200px',
                overflowY: 'auto',
                lineHeight: 1.5,
              }}>
                {currentUc.validation_log}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1rem 1.5rem',
          backgroundColor: '#0f172a',
          borderTop: '1px solid #334155',
        }}>
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
            {currentUc.rel_path}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Approval state transition buttons */}
            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', marginRight: '0.5rem' }}>
              <button
                type="button"
                onClick={() => handleTriggerApproval('approve')}
                disabled={approving || approval === 'approved'}
                title={approval === 'approved' ? 'Already approved' : 'Approve this use case'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.45rem 0.75rem',
                  borderRadius: '0.375rem',
                  border: approval === 'approved' ? '1px solid #065f46' : '1px solid #059669',
                  backgroundColor: approval === 'approved' ? 'rgba(6, 78, 59, 0.4)' : '#065f46',
                  color: approval === 'approved' ? '#6ee7b7' : '#fff',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: (approving || approval === 'approved') ? 'not-allowed' : 'pointer',
                  opacity: (approving || approval === 'approved') ? 0.6 : 1,
                }}
              >
                <CheckCircle2 size={14} />
                <span>Approve</span>
              </button>

              <button
                type="button"
                onClick={() => handleTriggerApproval('deprecate')}
                disabled={approving || approval === 'deprecated'}
                title={approval === 'deprecated' ? 'Already deprecated' : 'Deprecate this use case'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.45rem 0.75rem',
                  borderRadius: '0.375rem',
                  border: approval === 'deprecated' ? '1px solid #7f1d1d' : '1px solid #dc2626',
                  backgroundColor: approval === 'deprecated' ? 'rgba(127, 29, 29, 0.4)' : '#7f1d1d',
                  color: approval === 'deprecated' ? '#fca5a5' : '#fff',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: (approving || approval === 'deprecated') ? 'not-allowed' : 'pointer',
                  opacity: (approving || approval === 'deprecated') ? 0.6 : 1,
                }}
              >
                <AlertTriangle size={14} />
                <span>Deprecate</span>
              </button>

              <button
                type="button"
                onClick={() => handleTriggerApproval('propose')}
                disabled={approving || approval === 'proposed'}
                title={approval === 'proposed' ? 'Already proposed' : 'Move back to proposed'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.45rem 0.75rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #475569',
                  backgroundColor: '#334155',
                  color: '#cbd5e1',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: (approving || approval === 'proposed') ? 'not-allowed' : 'pointer',
                  opacity: (approving || approval === 'proposed') ? 0.6 : 1,
                }}
              >
                <RotateCcw size={14} />
                <span>Back to proposed</span>
              </button>
            </div>

            {notReadyConflict && (
              <button
                type="button"
                onClick={() => setShowForceConfirm(true)}
                disabled={validating}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.45rem 0.9rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #f59e0b',
                  backgroundColor: '#d97706',
                  color: '#fff',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: validating ? 'not-allowed' : 'pointer',
                }}
              >
                <AlertTriangle size={15} />
                <span>Validate anyway</span>
              </button>
            )}
            <button
              onClick={() => handleValidate(false)}
              disabled={validating}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.45rem 0.9rem',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: '#4f46e5',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {validating ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
              <span>{validating ? 'Testing...' : 'Validate'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation dialog for Validate anyway (force) */}
      {showForceConfirm && notReadyConflict && (
        <ConfirmDialog
          isOpen={true}
          title={`Validate ${currentUc.id} anyway (force)?`}
          summary={`The engine reported that **${currentUc.id}** (${currentUc.title}) is not ready:\n\n> ${notReadyConflict.message}\n\nConfirming will run validation with \`force: true\` even though linked tasks or approval are not yet complete.`}
          warnings={['Forced validation runs the verification probe before all linked tasks are done or before approval.']}
          applyButtonText="Validate anyway (force)"
          danger={true}
          onApply={async () => {
            await handleValidate(true);
          }}
          onCancel={() => setShowForceConfirm(false)}
        />
      )}

      {/* Confirmation dialog for Approval change preview */}
      {approvalConfirmData && (
        <ConfirmDialog
          isOpen={true}
          title={approvalConfirmData.title}
          summary={buildApprovalSummary(approvalConfirmData.preview)}
          plan={approvalConfirmData.preview.plan}
          diff={approvalConfirmData.preview.diff}
          hash={approvalConfirmData.preview.plan_hash}
          applyButtonText={
            approvalConfirmData.action === 'approve'
              ? 'Approve'
              : approvalConfirmData.action === 'deprecate'
              ? 'Deprecate'
              : 'Back to proposed'
          }
          danger={approvalConfirmData.action === 'deprecate'}
          onApply={handleApplyApproval}
          onCancel={() => setApprovalConfirmData(null)}
          onRefetchPreview={handleRefetchApprovalPreview}
        />
      )}
    </div>
  );
};
