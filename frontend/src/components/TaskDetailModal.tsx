import React, { useState, useEffect } from 'react';
import { X, CheckCircle, RotateCcw, Play, CheckCheck, Copy, Check, FileText, AlertTriangle, AlertCircle, Loader2 } from 'lucide-react';
import { TaskItem } from '../types';
import { api } from '../api';
import { SafeMarkdown } from './SafeMarkdown';

interface TaskDetailModalProps {
  task: TaskItem;
  onClose: () => void;
  onActionComplete: () => void;
  onIndexOutOfSync?: () => void;
  onRequestSyncIndex?: () => void;
}

export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  task,
  onClose,
  onActionComplete,
  onIndexOutOfSync,
  onRequestSyncIndex,
}) => {
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [bounceReason, setBounceReason] = useState('');
  const [showBounceInput, setShowBounceInput] = useState(false);
  const [copiedHandoff, setCopiedHandoff] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [indexOutOfSync, setIndexOutOfSync] = useState(false);

  useEffect(() => {
    loadDetail();
  }, [task.id]);

  const loadDetail = async () => {
    try {
      const data = await api.getTaskDetail(task.id);
      setDetail(data);
    } catch (e: any) {
      setTransitionError(`Failed to load task specification: ${e.message}`);
    }
  };

  const handleTransition = async (newState: string, verifier?: string, reason?: string) => {
    setLoading(true);
    setTransitionError(null);
    try {
      const res = await api.transitionTask(task.id, newState, 'operator', verifier, reason);
      if (res && res.index_in_sync === false) {
        setIndexOutOfSync(true);
        onIndexOutOfSync?.();
      }
      onActionComplete();
      onClose();
    } catch (e: any) {
      setTransitionError(`Transition error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyHandoff = () => {
    if (task.handoff) {
      navigator.clipboard.writeText(task.handoff);
      setCopiedHandoff(true);
      setTimeout(() => setCopiedHandoff(false), 2000);
    }
  };

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
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <span style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '0.15rem 0.4rem',
                borderRadius: '0.25rem',
                backgroundColor: task.priority === 'P0' ? '#ef4444' : task.priority === 'P1' ? '#f59e0b' : '#64748b',
                color: '#fff',
              }}>
                {task.priority}
              </span>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#818cf8' }}>{task.id}</span>
              <span style={{
                fontSize: '0.75rem',
                padding: '0.15rem 0.5rem',
                borderRadius: '1rem',
                backgroundColor: '#334155',
                color: '#cbd5e1',
              }}>
                {task.state}
              </span>
            </div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600, color: '#f8fafc' }}>{task.title}</h2>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.25rem' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Non-blocking index out of sync notice */}
        {indexOutOfSync && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.6rem 1.5rem',
            backgroundColor: '#3b2505',
            borderBottom: '1px solid #f59e0b',
            color: '#fef3c7',
            fontSize: '0.85rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <AlertTriangle size={16} color="#f59e0b" />
              <span>Index out of sync</span>
            </div>
            {onRequestSyncIndex && (
              <button
                onClick={() => {
                  onRequestSyncIndex();
                  onClose();
                }}
                style={{
                  padding: '0.2rem 0.6rem',
                  borderRadius: '0.25rem',
                  border: 'none',
                  backgroundColor: '#f59e0b',
                  color: '#000',
                  fontWeight: 600,
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                Sync…
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem' }}>
          {/* Metadata pill bar */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem',
            padding: '1rem',
            backgroundColor: '#0f172a',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            marginBottom: '1.5rem',
            fontSize: '0.85rem',
          }}>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Assignee / Executor</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.executor || 'self'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Role Profile</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.profile || 'bulk-execution'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Verification Mode</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.verification_mode || 'independent-session'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Category</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.category}</div>
            </div>
          </div>

          {/* Handoff prompt box */}
          {task.handoff && (
            <div style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              padding: '0.75rem 1rem',
              marginBottom: '1.5rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#818cf8', textTransform: 'uppercase' }}>Handoff Prompt</span>
                <button
                  onClick={copyHandoff}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    background: 'none',
                    border: 'none',
                    color: copiedHandoff ? '#10b981' : '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                  }}
                >
                  {copiedHandoff ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedHandoff ? 'Copied' : 'Copy Prompt'}</span>
                </button>
              </div>
              <code style={{ fontSize: '0.8rem', color: '#e2e8f0', fontFamily: 'monospace', display: 'block', wordBreak: 'break-all' }}>
                {task.handoff}
              </code>
            </div>
          )}

          {/* Markdown Content */}
          {detail ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                <FileText size={14} />
                <span>{detail.relative_path}</span>
              </div>
              <div style={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.5rem',
                padding: '1rem',
                fontSize: '0.85rem',
                color: '#cbd5e1',
                lineHeight: 1.6,
              }}>
                <SafeMarkdown content={detail.content} />
              </div>
            </div>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading task specification...</div>
          )}

          {/* Bounce input box if active */}
          {showBounceInput && (
            <div style={{
              marginTop: '1rem',
              padding: '1rem',
              backgroundColor: '#451a1a',
              border: '1px solid #ef4444',
              borderRadius: '0.5rem',
            }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fca5a5', marginBottom: '0.5rem' }}>
                Reject / Bounce Task Back to Executor
              </div>
              <textarea
                value={bounceReason}
                onChange={(e) => setBounceReason(e.target.value)}
                placeholder="List failing criteria, reproduction commands, or B1..Bn findings..."
                rows={3}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #ef4444',
                  borderRadius: '0.375rem',
                  color: '#fff',
                  fontSize: '0.85rem',
                  marginBottom: '0.75rem',
                }}
              />
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowBounceInput(false)}
                  style={{
                    padding: '0.35rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #64748b',
                    backgroundColor: 'transparent',
                    color: '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleTransition('bounced', undefined, bounceReason)}
                  disabled={!bounceReason.trim() || loading}
                  style={{
                    padding: '0.35rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#ef4444',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Confirm Bounce
                </button>
              </div>
            </div>
          )}

          {/* Inline Transition Error */}
          {transitionError && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginTop: '1rem',
              padding: '0.75rem 1rem',
              borderRadius: '0.375rem',
              backgroundColor: '#451a1a',
              border: '1px solid #ef4444',
              color: '#fca5a5',
              fontSize: '0.85rem',
            }}>
              <AlertCircle size={16} color="#ef4444" />
              <span>{transitionError}</span>
            </div>
          )}
        </div>

        {/* Action Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1rem 1.5rem',
          backgroundColor: '#0f172a',
          borderTop: '1px solid #334155',
        }}>
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
            Current State: <strong style={{ color: '#cbd5e1' }}>{task.state}</strong>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {task.state === 'open' && (
              <button
                onClick={() => handleTransition('in progress')}
                disabled={loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.4rem 0.8rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: '#6366f1',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {loading ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
                <span>Start Task (In Progress)</span>
              </button>
            )}

            {task.state === 'in progress' && (
              <button
                onClick={() => handleTransition('delivered')}
                disabled={loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.4rem 0.8rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: '#0ea5e9',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {loading ? <Loader2 size={15} className="spin" /> : <CheckCircle size={15} />}
                <span>Mark Delivered (Needs Verification)</span>
              </button>
            )}

            {task.state === 'delivered' && (
              <>
                <button
                  onClick={() => setShowBounceInput(true)}
                  disabled={loading}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #ef4444',
                    backgroundColor: 'transparent',
                    color: '#f87171',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <RotateCcw size={15} />
                  <span>Bounce</span>
                </button>

                <button
                  onClick={() => handleTransition('verified', 'operator:owner', 'Verified by human operator in UI')}
                  disabled={loading}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#10b981',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {loading ? <Loader2 size={15} className="spin" /> : <CheckCheck size={15} />}
                  <span>Approve (Verified)</span>
                </button>
              </>
            )}

            {task.state === 'verified' && (
              <button
                onClick={() => handleTransition('done', undefined, 'Completed and integrated')}
                disabled={loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.4rem 0.8rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: '#10b981',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {loading ? <Loader2 size={15} className="spin" /> : <CheckCheck size={15} />}
                <span>Close Task (Done)</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
