import React, { useState, useEffect } from 'react';
import { Target, Play, Plus, Loader2 } from 'lucide-react';
import { UseCaseItem, ValidationCampaignResult } from '../types';
import { UseCaseDetailModal } from './UseCaseDetailModal';
import { api } from '../api';

interface UseCasesManagerProps {
  onRefresh: () => void;
}

export const UseCasesManager: React.FC<UseCasesManagerProps> = ({ onRefresh }) => {
  const [useCases, setUseCases] = useState<UseCaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUc, setSelectedUc] = useState<UseCaseItem | null>(null);
  const [runningCampaign, setRunningCampaign] = useState(false);
  const [campaignReport, setCampaignReport] = useState<ValidationCampaignResult | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);

  // New Use Case form state
  const [newId, setNewId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newActor, setNewActor] = useState('End-User');
  const [newPriority, setNewPriority] = useState('P1');
  const [newLinkedTasks, setNewLinkedTasks] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newScenario, setNewScenario] = useState('');
  const [creating, setCreating] = useState(false);

  const loadUseCases = async () => {
    setLoading(true);
    try {
      const data = await api.getUseCases(statusFilter);
      setUseCases(data.use_cases || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUseCases();
  }, [statusFilter]);

  const handleQuickValidate = async (e: React.MouseEvent, ucId: string) => {
    e.stopPropagation();
    setValidatingId(ucId);
    try {
      await api.validateUseCase(ucId, { timeout: 60 });
      await loadUseCases();
      onRefresh();
    } catch (err: any) {
      alert(`Validation error: ${err.message}`);
    } finally {
      setValidatingId(null);
    }
  };

  const handleRunCampaign = async () => {
    setRunningCampaign(true);
    setCampaignReport(null);
    try {
      const res = await api.runValidationCampaign({ timeout: 60 });
      setCampaignReport(res);
      await loadUseCases();
      onRefresh();
    } catch (err: any) {
      alert(`Campaign error: ${err.message}`);
    } finally {
      setRunningCampaign(false);
    }
  };

  const handleCreateUseCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newId || !newTitle) {
      alert('ID and Title are required');
      return;
    }
    setCreating(true);
    try {
      await api.createUseCase({
        id: newId,
        title: newTitle,
        actor: newActor,
        priority: newPriority as any,
        linked_tasks: newLinkedTasks ? newLinkedTasks.split(',').map((t) => t.trim()).filter(Boolean) : [],
        verification_command: newCommand,
        description: newDesc,
        scenario: newScenario,
        status: 'active',
      });
      setShowCreateModal(false);
      setNewId('');
      setNewTitle('');
      await loadUseCases();
      onRefresh();
    } catch (err: any) {
      alert(`Create error: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  // Compute stats
  const total = useCases.length;
  const verified = useCases.filter((u) => u.status === 'verified').length;
  const failing = useCases.filter((u) => u.status === 'failing').length;
  const draft = useCases.filter((u) => u.status === 'draft' || !u.last_verdict).length;
  const readinessScore = total > 0 ? Math.round((verified / total) * 100) : 0;

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1300px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Target size={24} color="#818cf8" />
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc' }}>Use Cases & Autonomous AI Validation</h1>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem' }}>
            End-to-end user scenarios and automated product verification gates. Tasks implement Use Cases; AI tests them autonomously.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={() => setShowCreateModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.45rem 0.9rem',
              borderRadius: '0.375rem',
              border: '1px solid #334155',
              backgroundColor: '#1e293b',
              color: '#e2e8f0',
              fontSize: '0.85rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <Plus size={16} />
            <span>New Use Case</span>
          </button>

          <button
            onClick={handleRunCampaign}
            disabled={runningCampaign}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.9rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: '#4f46e5',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 4px 6px -1px rgba(79, 70, 229, 0.3)',
            }}
          >
            {runningCampaign ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
            <span>{runningCampaign ? 'Testing Product...' : 'Run Product Validation Campaign'}</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', padding: '1rem', borderTop: '3px solid #818cf8' }}>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Product Readiness Score</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#f8fafc', marginTop: '0.2rem' }}>{readinessScore}%</div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>{verified} of {total} verified pass</div>
        </div>

        <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', padding: '1rem', borderTop: '3px solid #10b981' }}>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Verified Use Cases</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#10b981', marginTop: '0.2rem' }}>{verified}</div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>100% compliant</div>
        </div>

        <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', padding: '1rem', borderTop: '3px solid #ef4444' }}>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Failing / Regressions</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: failing > 0 ? '#ef4444' : '#64748b', marginTop: '0.2rem' }}>{failing}</div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>Defects detected by AI</div>
        </div>

        <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', padding: '1rem', borderTop: '3px solid #64748b' }}>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Draft / Untested</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#f8fafc', marginTop: '0.2rem' }}>{draft}</div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>Pending validation run</div>
        </div>
      </div>

      {/* Campaign Result Banner */}
      {campaignReport && (
        <div style={{
          backgroundColor: '#0f172a',
          border: '1px solid #4f46e5',
          borderRadius: '0.5rem',
          padding: '1.25rem',
          marginBottom: '1.5rem',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc' }}>
              Product Validation Campaign Result ({campaignReport.timestamp})
            </h3>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#818cf8' }}>
              Readiness: {campaignReport.readiness_score}%
            </span>
          </div>
          <div style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '0.75rem' }}>
            Tested {campaignReport.total} Use Cases: <strong style={{ color: '#10b981' }}>{campaignReport.passed} Passed</strong>, <strong style={{ color: '#ef4444' }}>{campaignReport.failed} Failed</strong>, Regressions: <strong style={{ color: '#f59e0b' }}>{campaignReport.regressions_count}</strong>.
          </div>
          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Report written to: <code>{campaignReport.report_file}</code>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {['all', 'verified', 'failing', 'active', 'draft'].map((st) => (
          <button
            key={st}
            onClick={() => setStatusFilter(st)}
            style={{
              padding: '0.3rem 0.7rem',
              borderRadius: '0.25rem',
              border: 'none',
              backgroundColor: statusFilter === st ? '#4f46e5' : '#1e293b',
              color: statusFilter === st ? '#fff' : '#94a3b8',
              fontSize: '0.8rem',
              fontWeight: 500,
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {st}
          </button>
        ))}
      </div>

      {/* Use Cases Grid */}
      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>Loading use cases...</div>
      ) : useCases.length === 0 ? (
        <div style={{ backgroundColor: '#1e293b', borderRadius: '0.5rem', border: '1px solid #334155', padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>
          No use cases found in <code>tasks/use-cases/</code>. Click "New Use Case" to define your first user scenario!
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '1rem' }}>
          {useCases.map((uc) => {
            const isVal = validatingId === uc.id;
            const isPass = uc.last_verdict === 'pass';
            const isFail = uc.last_verdict === 'fail';

            return (
              <div
                key={uc.id}
                onClick={() => setSelectedUc(uc)}
                style={{
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '0.5rem',
                  padding: '1.25rem',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  transition: 'border-color 0.15s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#6366f1')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#334155')}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: '#4f46e5', color: '#fff' }}>
                        {uc.id}
                      </span>
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        padding: '0.1rem 0.4rem',
                        borderRadius: '0.2rem',
                        backgroundColor: isPass ? '#064e3b' : isFail ? '#451a1a' : '#334155',
                        color: isPass ? '#34d399' : isFail ? '#fca5a5' : '#94a3b8',
                      }}>
                        {uc.status.toUpperCase()}
                      </span>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Actor: <strong>{uc.actor}</strong></span>
                  </div>

                  <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', lineHeight: 1.3, marginBottom: '0.35rem' }}>
                    {uc.title}
                  </h3>

                  {uc.description && (
                    <p style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {uc.description}
                    </p>
                  )}
                </div>

                <div>
                  {/* Linked Tasks Pills */}
                  {uc.linked_tasks && uc.linked_tasks.length > 0 && (
                    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                      {uc.linked_tasks.map((tid) => (
                        <span key={tid} style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', borderRadius: '0.2rem', backgroundColor: '#0f172a', color: '#818cf8', border: '1px solid #334155' }}>
                          Task {tid}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Footer Bar */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: '0.6rem',
                    borderTop: '1px solid #334155',
                    fontSize: '0.75rem',
                  }}>
                    <span style={{ color: '#64748b' }}>
                      Tested: {uc.last_tested || 'Never'} {uc.last_verdict ? `(${uc.last_verdict})` : ''}
                    </span>

                    <button
                      onClick={(e) => handleQuickValidate(e, uc.id)}
                      disabled={isVal}
                      title="Validate this Use Case autonomously with AI"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        padding: '0.25rem 0.5rem',
                        borderRadius: '0.25rem',
                        border: 'none',
                        backgroundColor: '#4f46e5',
                        color: '#fff',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      {isVal ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                      <span>{isVal ? 'Testing...' : 'Validate with AI'}</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selectedUc && (
        <UseCaseDetailModal
          useCase={selectedUc}
          onClose={() => setSelectedUc(null)}
          onRefresh={loadUseCases}
        />
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '2rem',
        }}>
          <form
            onSubmit={handleCreateUseCase}
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              width: '100%',
              maxWidth: '600px',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc' }}>Create New Use Case</h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Use Case ID (UC###)
              </label>
              <input
                type="text"
                required
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="UC001"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Title
              </label>
              <input
                type="text"
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Car Search by Budget and Fuel"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                  Actor / Persona
                </label>
                <input
                  type="text"
                  value={newActor}
                  onChange={(e) => setNewActor(e.target.value)}
                  placeholder="End-User, Developer, Buyer"
                  style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem' }}
                />
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                  Priority
                </label>
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem' }}
                >
                  <option value="P0">P0 - Blocker</option>
                  <option value="P1">P1 - High</option>
                  <option value="P2">P2 - Medium</option>
                  <option value="P3">P3 - Low</option>
                </select>
              </div>
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Linked Tasks (comma-separated)
              </label>
              <input
                type="text"
                value={newLinkedTasks}
                onChange={(e) => setNewLinkedTasks(e.target.value)}
                placeholder="08.T1, 08.T3, T012"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Automated Verification Command
              </label>
              <input
                type="text"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                placeholder="curl -fsS http://localhost:8765/api/cars | jq -e 'length > 0'"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#34d399', fontFamily: 'monospace', fontSize: '0.8rem' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Description
              </label>
              <textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={2}
                placeholder="What user capability or business value does this deliver?"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Scenario Steps
              </label>
              <textarea
                value={newScenario}
                onChange={(e) => setNewScenario(e.target.value)}
                rows={3}
                placeholder="1. User initiates action...\n2. System responds with..."
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                style={{ padding: '0.4rem 0.8rem', borderRadius: '0.375rem', border: '1px solid #64748b', backgroundColor: 'transparent', color: '#cbd5e1', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                style={{ padding: '0.4rem 0.8rem', borderRadius: '0.375rem', border: 'none', backgroundColor: '#4f46e5', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
              >
                {creating ? 'Saving...' : 'Create Use Case'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
