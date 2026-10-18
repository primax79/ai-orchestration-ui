import React, { useState } from 'react';
import { X, Play, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { UseCaseItem, shortTitle } from '../types';
import { api } from '../api';

interface UseCaseDetailModalProps {
  useCase: UseCaseItem;
  onClose: () => void;
  onRefresh: () => void;
}

export const UseCaseDetailModal: React.FC<UseCaseDetailModalProps> = ({
  useCase,
  onClose,
  onRefresh,
}) => {
  const [validating, setValidating] = useState(false);
  const [valResult, setValResult] = useState<any>(null);

  const handleValidate = async () => {
    setValidating(true);
    setValResult(null);
    try {
      const res = await api.validateUseCase(useCase.id, { timeout: 60 });
      setValResult(res);
      onRefresh();
    } catch (e: any) {
      alert(`Validation error: ${e.message}`);
    } finally {
      setValidating(false);
    }
  };

  const isVerified = useCase.status === 'verified';
  const isFailing = useCase.status === 'failing';

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
              <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '0.25rem', backgroundColor: '#4f46e5', color: '#fff' }}>
                {useCase.id}
              </span>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 500 }} title={useCase.title}>
                ({shortTitle(useCase)})
              </span>
              <span style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '0.15rem 0.5rem',
                borderRadius: '1rem',
                backgroundColor: isVerified ? '#064e3b' : isFailing ? '#451a1a' : '#334155',
                color: isVerified ? '#34d399' : isFailing ? '#fca5a5' : '#cbd5e1',
              }}>
                {useCase.status.toUpperCase()}
              </span>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Actor: <strong>{useCase.actor}</strong></span>
            </div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600, color: '#f8fafc' }}>{useCase.title}</h2>
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
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem',
            padding: '1rem',
            backgroundColor: '#0f172a',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            fontSize: '0.85rem',
          }}>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Priority</div>
              <div style={{ fontWeight: 600, color: '#f8fafc' }}>{useCase.priority}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Verification Type</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{useCase.verification_type}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Last Tested</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{useCase.last_tested || 'Never'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Last Verdict</div>
              <div style={{
                fontWeight: 600,
                color: useCase.last_verdict === 'pass' ? '#10b981' : useCase.last_verdict === 'fail' ? '#ef4444' : '#94a3b8',
              }}>
                {(useCase.last_verdict || 'untested').toUpperCase()}
              </div>
            </div>
          </div>

          {/* Linked Tasks */}
          {useCase.linked_tasks && useCase.linked_tasks.length > 0 && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#818cf8', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                Linked Implementation Tasks
              </h3>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {useCase.linked_tasks.map((tid) => (
                  <span
                    key={tid}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.2rem 0.5rem',
                      borderRadius: '0.25rem',
                      backgroundColor: '#312e81',
                      color: '#c7d2fe',
                      fontWeight: 600,
                    }}
                  >
                    Task {tid}
                  </span>
                ))}
              </div>
            </div>
          )}

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
                <span>AI Validation Result: {valResult.verdict?.toUpperCase()}</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>{valResult.summary}</div>
            </div>
          )}

          {/* Preconditions */}
          {useCase.preconditions && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
                Preconditions
              </h3>
              <div style={{ backgroundColor: '#0f172a', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #334155', fontSize: '0.85rem', color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>
                {useCase.preconditions}
              </div>
            </div>
          )}

          {/* Scenario Steps */}
          {useCase.scenario && (
            <div>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
                Scenario / Interaction Steps
              </h3>
              <div style={{ backgroundColor: '#0f172a', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #334155', fontSize: '0.85rem', color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {useCase.scenario}
              </div>
            </div>
          )}

          {/* Automated Verification Command */}
          {useCase.verification_command && (
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
                {useCase.verification_command}
              </pre>
            </div>
          )}

          {/* AI Validation Log */}
          {useCase.validation_log && (
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
                {useCase.validation_log}
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
            {useCase.rel_path}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleValidate}
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
              <span>{validating ? 'Testing...' : 'Validate with AI'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
