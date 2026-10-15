import React, { useState } from 'react';
import { Activity, CheckCircle2, AlertTriangle, XCircle, Terminal, HardDrive, Trash2, Wrench, Loader2 } from 'lucide-react';
import { EnvStatusResponse } from '../types';
import { api } from '../api';

interface EnvironmentDoctorProps {
  status: EnvStatusResponse | null;
  onRefresh: () => void;
}

export const EnvironmentDoctor: React.FC<EnvironmentDoctorProps> = ({ status, onRefresh }) => {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  if (!status) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading environment status...</div>;
  }

  const { clis, source_repos, environments } = status;

  // Check if any environment has conflicts
  const hasConflicts = Object.values(environments).some((scopes) =>
    Object.values(scopes).some((sinfo) => sinfo.conflicts.length > 0)
  );

  const handleResolveConflicts = async () => {
    setLoadingAction('resolve-conflicts');
    try {
      await api.resolveConflicts();
      onRefresh();
    } catch (e: any) {
      alert(`Error resolving conflicts: ${e.message}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleRemoveSkill = async (assistant: string, scope: string, skill: string) => {
    if (!confirm(`Remove skill '${skill}' from ${assistant} (${scope})?`)) {
      return;
    }
    setLoadingAction(`remove-${assistant}-${scope}-${skill}`);
    try {
      await api.removeSkill(skill, assistant, scope as any);
      onRefresh();
    } catch (e: any) {
      alert(`Error removing skill: ${e.message}`);
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc' }}>Environment Health & Drift Doctor</h1>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem' }}>
            Real-time diagnostic of CLI binaries, skill installations, drift detection, and registered MCP servers across Kilo, Claude, and Codex.
          </p>
        </div>

        {hasConflicts && (
          <button
            onClick={handleResolveConflicts}
            disabled={loadingAction !== null}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.9rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: '#ef4444',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 4px 6px -1px rgba(239, 68, 68, 0.3)',
            }}
          >
            {loadingAction === 'resolve-conflicts' ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />}
            <span>Auto-Resolve All Trigger Conflicts</span>
          </button>
        )}
      </div>

      {/* CLIs & Repos Bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}>
        {/* CLI Binaries Status */}
        <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', color: '#cbd5e1', fontSize: '0.85rem', fontWeight: 600 }}>
            <Terminal size={16} color="#818cf8" />
            <span>Assistant CLI Binaries</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {Object.entries(clis).map(([tool, info]) => (
              <div key={tool} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  {info.installed ? <CheckCircle2 size={15} color="#10b981" /> : <XCircle size={15} color="#ef4444" />}
                  <span style={{ fontWeight: 600, color: '#f1f5f9', textTransform: 'capitalize' }}>{tool}</span>
                </div>
                <span style={{ color: info.installed ? '#94a3b8' : '#ef4444', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                  {info.installed ? info.version : 'Not found on PATH'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Source Repositories Status */}
        <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', color: '#cbd5e1', fontSize: '0.85rem', fontWeight: 600 }}>
            <HardDrive size={16} color="#10b981" />
            <span>Source Repositories</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {Object.entries(source_repos).map(([repo, info]) => (
              <div key={repo} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  {info.available ? <CheckCircle2 size={15} color="#10b981" /> : <XCircle size={15} color="#ef4444" />}
                  <span style={{ fontWeight: 600, color: '#f1f5f9' }}>{repo}</span>
                </div>
                <span style={{ color: info.available ? '#94a3b8' : '#ef4444', fontSize: '0.75rem' }}>
                  {info.available ? (info.has_venv ? 'Ready (.venv ok)' : 'Ready (no venv)') : 'Not found'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Environments Matrix */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {Object.entries(environments).map(([assistant, scopes]) => (
          <div key={assistant} style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', overflow: 'hidden' }}>
            <div style={{
              padding: '0.75rem 1rem',
              backgroundColor: '#0f172a',
              borderBottom: '1px solid #334155',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Activity size={18} color="#818cf8" />
                <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', textTransform: 'capitalize' }}>{assistant} Environment</h3>
              </div>
            </div>

            <div style={{ padding: '1rem' }}>
              {Object.entries(scopes).map(([scope, sinfo]) => (
                <div key={scope} style={{ marginBottom: '1.25rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', textTransform: 'uppercase' }}>Scope: {scope}</span>
                      <span style={{ fontSize: '0.75rem', color: '#64748b' }}>({sinfo.installed_count} skill(s))</span>
                    </div>
                    {sinfo.registered_mcps.length > 0 && (
                      <span style={{ fontSize: '0.75rem', color: '#10b981' }}>
                        MCP Servers: <strong>{sinfo.registered_mcps.join(', ')}</strong>
                      </span>
                    )}
                  </div>

                  {/* Conflict Banners */}
                  {sinfo.conflicts.map((c, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.6rem 0.8rem',
                      borderRadius: '0.375rem',
                      backgroundColor: '#451a1a',
                      border: '1px solid #ef4444',
                      color: '#fca5a5',
                      fontSize: '0.8rem',
                      marginBottom: '0.75rem',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <AlertTriangle size={15} color="#ef4444" />
                        <span>{c}</span>
                      </div>
                      <button
                        onClick={handleResolveConflicts}
                        disabled={loadingAction !== null}
                        style={{
                          padding: '0.2rem 0.6rem',
                          borderRadius: '0.25rem',
                          border: 'none',
                          backgroundColor: '#ef4444',
                          color: '#fff',
                          fontWeight: 600,
                          fontSize: '0.75rem',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Resolve
                      </button>
                    </div>
                  ))}

                  {/* Skills Grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.4rem' }}>
                    {Object.entries(sinfo.skills).map(([sname, sdata]) => {
                      const isRemoving = loadingAction === `remove-${assistant}-${scope}-${sname}`;
                      return (
                        <div
                          key={sname}
                          style={{
                            backgroundColor: '#0f172a',
                            border: '1px solid #334155',
                            borderRadius: '0.25rem',
                            padding: '0.4rem 0.6rem',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontSize: '0.75rem',
                          }}
                        >
                          <span style={{ color: '#e2e8f0', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }} title={sname}>
                            {sname}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{
                              fontSize: '0.65rem',
                              fontWeight: 600,
                              padding: '0.1rem 0.3rem',
                              borderRadius: '0.2rem',
                              backgroundColor: sdata.state === 'up-to-date' ? '#064e3b' : sdata.state.startsWith('obsolete') ? '#7f1d1d' : '#451a03',
                              color: sdata.state === 'up-to-date' ? '#34d399' : sdata.state.startsWith('obsolete') ? '#fca5a5' : '#fbbf24',
                              whiteSpace: 'nowrap',
                            }}>
                              {sdata.state}
                            </span>
                            <button
                              onClick={() => handleRemoveSkill(assistant, scope, sname)}
                              disabled={loadingAction !== null}
                              title={`Remove ${sname} from ${assistant}`}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#64748b',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '0.1rem',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                              onMouseLeave={(e) => (e.currentTarget.style.color = '#64748b')}
                            >
                              {isRemoving ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
