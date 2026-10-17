import React, { useState } from 'react';
import { Activity, CheckCircle2, AlertTriangle, XCircle, Terminal, HardDrive, Trash2, Wrench, Loader2, Info, FileCode } from 'lucide-react';
import { EnvStatusResponse, SkillEntry, StructuredConflict } from '../types';
import { api } from '../api';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';

interface EnvironmentDoctorProps {
  status: EnvStatusResponse | null;
  onRefresh: () => void;
}

const isFindingFixable = (sc: StructuredConflict): boolean => {
  if (sc.fixable !== undefined) {
    return sc.fixable;
  }
  // Missing fixable (older engine): treat as fixable (current behaviour)
  const entries = sc.entries || [];
  if (entries.length > 0) {
    return entries.some((e) => !e.origin?.startsWith('plugin:'));
  }
  return true;
};

export const EnvironmentDoctor: React.FC<EnvironmentDoctorProps> = ({ status, onRefresh }) => {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Confirm dialog state
  const [confirmData, setConfirmData] = useState<(ConfirmDialogPreviewData & {
    title: string;
    onApplyAction: (hash?: string) => Promise<void>;
    onRefetchAction: () => Promise<ConfirmDialogPreviewData>;
  }) | null>(null);

  if (!status) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading environment status...</div>;
  }

  const { clis, source_repos, environments, stray } = status;

  // Count fixable findings and advice findings
  let toFixCount = 0;
  let adviceCount = 0;

  Object.values(environments).forEach((scopes) => {
    Object.values(scopes).forEach((sinfo) => {
      if (sinfo.structured_conflicts && sinfo.structured_conflicts.length > 0) {
        sinfo.structured_conflicts.forEach((sc) => {
          if (isFindingFixable(sc)) {
            toFixCount++;
          } else {
            adviceCount++;
          }
        });
      } else if (sinfo.conflicts && sinfo.conflicts.length > 0) {
        toFixCount += sinfo.conflicts.length;
      }
    });
  });

  // Check if any environment has resolvable conflicts
  const hasResolvableConflicts = toFixCount > 0;

  const handleResolveConflictsPreview = async () => {
    setLoadingAction('resolve-conflicts');
    setErrorMessage(null);
    try {
      const res = await api.previewResolveConflicts();
      const planItems = res.plan || [];
      const hasExecutableActions = planItems.some(
        (item: any) => item.action && item.action.toLowerCase() !== 'advise'
      );
      setConfirmData({
        title: hasExecutableActions ? 'Auto-Resolve Trigger Conflicts' : 'Conflict Resolution Plan (Advice Only)',
        summary: hasExecutableActions
          ? 'Resolve trigger and duplicate skill name conflicts across assistant scopes.'
          : 'Preview conflict resolution plan across assistant scopes. All items are advice-only; no automated modifications will be applied.',
        plan: res.plan,
        warnings: res.warnings,
        hash: res.plan_hash,
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Plan hash is required to apply conflict resolution');
          await api.resolveConflicts(hash);
          setConfirmData(null);
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewResolveConflicts();
          setConfirmData((prev) =>
            prev
              ? {
                  ...prev,
                  plan: r.plan,
                  warnings: r.warnings,
                  hash: r.plan_hash,
                }
              : null
          );
          return {
            summary: hasExecutableActions
              ? 'Resolve trigger and duplicate skill name conflicts across assistant scopes.'
              : 'Preview conflict resolution plan across assistant scopes. All items are advice-only; no automated modifications will be applied.',
            plan: r.plan,
            warnings: r.warnings,
            hash: r.plan_hash,
          };
        },
      });
    } catch (e: any) {
      setErrorMessage(`Failed to preview conflict resolution: ${e.message}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleRemoveSkillPreview = async (assistant: string, scope: string, skill: string) => {
    setLoadingAction(`remove-${assistant}-${scope}-${skill}`);
    setErrorMessage(null);
    try {
      const res = await api.previewRemoveSkill(skill, assistant, scope as any);
      setConfirmData({
        title: `Remove Skill '${skill}'`,
        summary: `Remove skill **${skill}** from **${assistant}** (${scope} scope).`,
        plan: res.plan,
        warnings: res.warnings,
        hash: res.plan_hash,
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Plan hash is required to remove skill');
          await api.removeSkill(skill, assistant, scope as any, hash);
          setConfirmData(null);
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewRemoveSkill(skill, assistant, scope as any);
          return {
            summary: `Remove skill **${skill}** from **${assistant}** (${scope} scope).`,
            plan: r.plan,
            warnings: r.warnings,
            hash: r.plan_hash,
          };
        },
      });
    } catch (e: any) {
      setErrorMessage(`Failed to preview skill removal: ${e.message}`);
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc' }}>Environment Health & Drift Doctor</h1>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem' }}>
            Real-time diagnostic of CLI binaries, skill installations, drift detection, origins, and registered MCP servers across Kilo, Claude, and Codex.
          </p>

          {/* Summary counters: split into "to fix" (fixable) and "advice" */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.6rem' }}>
            <span style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>Findings:</span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '0.15rem 0.55rem',
                borderRadius: '0.25rem',
                backgroundColor: toFixCount > 0 ? '#451a1a' : '#1e293b',
                color: toFixCount > 0 ? '#fca5a5' : '#94a3b8',
                border: `1px solid ${toFixCount > 0 ? '#ef4444' : '#334155'}`,
              }}
            >
              {toFixCount > 0 ? <AlertTriangle size={13} color="#ef4444" /> : <CheckCircle2 size={13} color="#10b981" />}
              <span>{toFixCount} to fix</span>
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '0.15rem 0.55rem',
                borderRadius: '0.25rem',
                backgroundColor: adviceCount > 0 ? '#2d2006' : '#1e293b',
                color: adviceCount > 0 ? '#fde68a' : '#94a3b8',
                border: `1px solid ${adviceCount > 0 ? '#d97706' : '#334155'}`,
              }}
            >
              <Info size={13} color={adviceCount > 0 ? '#f59e0b' : '#64748b'} />
              <span>{adviceCount} advice</span>
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {hasResolvableConflicts ? (
            <button
              onClick={handleResolveConflictsPreview}
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
              <span>Auto-Resolve Conflicts…</span>
            </button>
          ) : adviceCount > 0 ? (
            <button
              onClick={handleResolveConflictsPreview}
              disabled={loadingAction !== null}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.9rem',
                borderRadius: '0.375rem',
                border: '1px solid #d97706',
                backgroundColor: '#2d2006',
                color: '#fde68a',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {loadingAction === 'resolve-conflicts' ? <Loader2 size={16} className="spin" /> : <Info size={16} color="#f59e0b" />}
              <span>View Resolution Plan…</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Error message banner */}
      {errorMessage && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.75rem 1rem',
          borderRadius: '0.375rem',
          marginBottom: '1.5rem',
          backgroundColor: '#451a1a',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          fontSize: '0.85rem',
        }}>
          <AlertTriangle size={16} color="#ef4444" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Stray Config Files Warning */}
      {stray && stray.length > 0 && (
        <div style={{
          backgroundColor: '#3b2505',
          border: '1px solid #f59e0b',
          borderRadius: '0.5rem',
          padding: '1rem',
          marginBottom: '1.5rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fef3c7', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.4rem' }}>
            <AlertTriangle size={17} color="#f59e0b" />
            <span>Stray Configuration Files Detected</span>
          </div>
          <p style={{ fontSize: '0.8rem', color: '#fde68a', margin: '0 0 0.5rem 0', lineHeight: 1.4 }}>
            These configuration files are located in assistant directories but are ignored by the assistant's runtime. They may lead to misleading status reports:
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', fontFamily: 'monospace', fontSize: '0.78rem', color: '#fef3c7' }}>
            {stray.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ul>
        </div>
      )}

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
              {Object.entries(scopes).map(([scope, sinfo]) => {
                // Collect skill entries
                const entries: SkillEntry[] = sinfo.skill_entries || Object.entries(sinfo.skills).map(([sname, sdata]) => ({
                  name: sname,
                  origin: 'standalone',
                  scope,
                  path: `${sinfo.skills_dir}/${sname}`,
                  enabled: true,
                  state: sdata.state,
                }));

                const structuredConflicts = sinfo.structured_conflicts || [];

                return (
                  <div key={scope} style={{ marginBottom: '1.5rem', borderBottom: '1px solid #334155', paddingBottom: '1.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f1f5f9', textTransform: 'uppercase' }}>Scope: {scope}</span>
                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>({entries.length} skill entry/entries)</span>
                      </div>
                    </div>

                    {/* Conflict & Advice Banners */}
                    {structuredConflicts.length > 0 ? (
                      structuredConflicts.map((sc, idx) => {
                        const isFixable = isFindingFixable(sc);

                        if (!isFixable) {
                          const adviceList =
                            sc.advice && sc.advice.length > 0
                              ? sc.advice
                              : [`${sc.kind}: ${sc.names.join(', ')} conflict across origins`];

                          return (
                            <div
                              key={idx}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.4rem',
                                padding: '0.65rem 0.9rem',
                                borderRadius: '0.375rem',
                                backgroundColor: '#2d2006',
                                border: '1px solid #d97706',
                                color: '#fef3c7',
                                fontSize: '0.8rem',
                                marginBottom: '0.75rem',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: '0.5rem',
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <Info size={15} color="#f59e0b" style={{ flexShrink: 0 }} />
                                  <span
                                    style={{
                                      fontSize: '0.65rem',
                                      fontWeight: 700,
                                      padding: '0.1rem 0.35rem',
                                      borderRadius: '0.2rem',
                                      backgroundColor: '#78350f',
                                      color: '#fde68a',
                                      textTransform: 'uppercase',
                                      letterSpacing: '0.03em',
                                    }}
                                  >
                                    Advice
                                  </span>
                                  <span style={{ fontWeight: 600, color: '#fef3c7' }}>
                                    <strong>{sc.kind}:</strong> {sc.names.join(', ')}
                                  </span>
                                </div>
                                <button
                                  onClick={handleResolveConflictsPreview}
                                  disabled={loadingAction !== null}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: '#fbbf24',
                                    textDecoration: 'underline',
                                    fontSize: '0.75rem',
                                    cursor: 'pointer',
                                    padding: 0,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  Show plan
                                </button>
                              </div>

                              <div style={{ fontSize: '0.75rem', color: '#fde68a', lineHeight: 1.4, paddingLeft: '1.4rem' }}>
                                {adviceList.map((adv, aIdx) => (
                                  <div key={aIdx}>{adv}</div>
                                ))}
                              </div>
                            </div>
                          );
                        }

                        // Resolvable conflict
                        return (
                          <div
                            key={idx}
                            style={{
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
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <AlertTriangle size={15} color="#ef4444" />
                              <span>
                                <strong>{sc.kind}:</strong> {sc.names.join(', ')} conflict across origins
                              </span>
                            </div>
                            <button
                              onClick={handleResolveConflictsPreview}
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
                              Resolve…
                            </button>
                          </div>
                        );
                      })
                    ) : (
                      /* Legacy text conflicts fallback */
                      sinfo.conflicts.map((c, idx) => (
                        <div
                          key={idx}
                          style={{
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
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <AlertTriangle size={15} color="#ef4444" />
                            <span>{c}</span>
                          </div>
                          <button
                            onClick={handleResolveConflictsPreview}
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
                            Resolve…
                          </button>
                        </div>
                      ))
                    )}

                    {/* Skills Table with Origin, Enabled, State */}
                    <div style={{ border: '1px solid #334155', borderRadius: '0.375rem', overflow: 'hidden', marginBottom: '1rem' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.78rem' }}>
                        <thead>
                          <tr style={{ backgroundColor: '#0f172a', color: '#94a3b8', borderBottom: '1px solid #334155' }}>
                            <th style={{ padding: '0.45rem 0.75rem' }}>Skill Name</th>
                            <th style={{ padding: '0.45rem 0.75rem' }}>Origin</th>
                            <th style={{ padding: '0.45rem 0.75rem', width: '90px' }}>Enabled</th>
                            <th style={{ padding: '0.45rem 0.75rem', width: '130px' }}>State</th>
                            <th style={{ padding: '0.45rem 0.75rem', width: '60px', textAlign: 'center' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map((entry, idx) => {
                            const isPlugin = entry.origin.startsWith('plugin:');
                            const isRemoving = loadingAction === `remove-${assistant}-${scope}-${entry.name}`;

                            return (
                              <tr
                                key={idx}
                                style={{
                                  borderBottom: idx === entries.length - 1 ? 'none' : '1px solid #334155',
                                  backgroundColor: idx % 2 === 0 ? '#1e293b' : '#182234',
                                }}
                              >
                                <td style={{ padding: '0.45rem 0.75rem', fontWeight: 600, color: '#f1f5f9' }}>
                                  {entry.name}
                                </td>
                                <td style={{ padding: '0.45rem 0.75rem', fontFamily: 'monospace', color: '#a5b4fc', fontSize: '0.75rem' }}>
                                  {entry.origin}
                                </td>
                                <td style={{ padding: '0.45rem 0.75rem' }}>
                                  <span style={{
                                    fontSize: '0.65rem',
                                    fontWeight: 700,
                                    padding: '0.1rem 0.35rem',
                                    borderRadius: '0.2rem',
                                    backgroundColor: entry.enabled ? '#064e3b' : '#334155',
                                    color: entry.enabled ? '#34d399' : '#94a3b8',
                                    textTransform: 'uppercase',
                                  }}>
                                    {entry.enabled ? 'Enabled' : 'Disabled'}
                                  </span>
                                </td>
                                <td style={{ padding: '0.45rem 0.75rem' }}>
                                  <span style={{
                                    fontSize: '0.65rem',
                                    fontWeight: 600,
                                    padding: '0.1rem 0.35rem',
                                    borderRadius: '0.2rem',
                                    backgroundColor:
                                      entry.state === 'up-to-date'
                                        ? '#064e3b'
                                        : entry.state === 'plugin'
                                        ? '#1e3a8a'
                                        : entry.state.startsWith('obsolete')
                                        ? '#7f1d1d'
                                        : '#451a03',
                                    color:
                                      entry.state === 'up-to-date'
                                        ? '#34d399'
                                        : entry.state === 'plugin'
                                        ? '#93c5fd'
                                        : entry.state.startsWith('obsolete')
                                        ? '#fca5a5'
                                        : '#fbbf24',
                                  }}>
                                    {entry.state}
                                  </span>
                                </td>
                                <td style={{ padding: '0.45rem 0.75rem', textAlign: 'center' }}>
                                  {!isPlugin ? (
                                    <button
                                      onClick={() => handleRemoveSkillPreview(assistant, scope, entry.name)}
                                      disabled={loadingAction !== null}
                                      title={`Remove ${entry.name} from ${assistant}`}
                                      style={{
                                        background: 'none',
                                        border: 'none',
                                        color: '#94a3b8',
                                        cursor: 'pointer',
                                        padding: '0.15rem',
                                      }}
                                      onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                                      onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
                                    >
                                      {isRemoving ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                                    </button>
                                  ) : (
                                    <span title="Installed via plugin; managed in settings.json" style={{ color: '#475569', fontSize: '0.7rem' }}>
                                      plugin
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          {entries.length === 0 && (
                            <tr>
                              <td colSpan={5} style={{ padding: '0.75rem', textAlign: 'center', color: '#64748b' }}>
                                No skills installed in this scope.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* MCP Servers with Provenance */}
                    <div>
                      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <FileCode size={14} color="#10b981" />
                        <span>Registered MCP Servers & Provenance</span>
                      </div>

                      {sinfo.mcp_servers && Object.keys(sinfo.mcp_servers).length > 0 ? (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.5rem' }}>
                          {Object.entries(sinfo.mcp_servers).map(([sname, sinfoObj]) => (
                            <div
                              key={sname}
                              style={{
                                backgroundColor: '#0f172a',
                                border: '1px solid #334155',
                                borderRadius: '0.375rem',
                                padding: '0.5rem 0.75rem',
                                fontSize: '0.75rem',
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                                <span style={{ fontWeight: 600, color: '#f8fafc' }}>{sname}</span>
                                <span style={{ fontSize: '0.65rem', color: '#10b981', fontWeight: 600, textTransform: 'uppercase' }}>Active</span>
                              </div>
                              <div style={{ color: '#94a3b8', fontSize: '0.7rem', wordBreak: 'break-all' }}>
                                Provenance: <span style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{sinfoObj.provenance}</span>
                              </div>
                              {sinfoObj.overrides && sinfoObj.overrides.length > 0 && (
                                <div style={{ color: '#f59e0b', fontSize: '0.68rem', marginTop: '0.15rem' }}>
                                  Overrides: {sinfoObj.overrides.join(', ')}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : sinfo.registered_mcps && sinfo.registered_mcps.length > 0 ? (
                        <div style={{ fontSize: '0.75rem', color: '#cbd5e1' }}>
                          {sinfo.registered_mcps.join(', ')}
                          {sinfo.mcp_config_path && (
                            <span style={{ color: '#64748b', marginLeft: '0.5rem' }}>
                              (Config: {sinfo.mcp_config_path})
                            </span>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                          No MCP servers registered in this scope.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Confirmation Modal */}
      {confirmData && (() => {
        const planItems = confirmData.plan || [];
        const hasExecutableActions = planItems.some(
          (item) => item.action && item.action.toLowerCase() !== 'advise'
        );
        const isApplyDisabled = !hasExecutableActions;
        const applyButtonText = isApplyDisabled
          ? 'Nothing to apply: advice only'
          : 'Confirm & Apply';

        return (
          <ConfirmDialog
            isOpen={true}
            title={confirmData.title}
            summary={confirmData.summary}
            plan={confirmData.plan}
            diff={confirmData.diff}
            warnings={confirmData.warnings}
            hash={confirmData.hash}
            applyButtonText={applyButtonText}
            isApplyDisabled={isApplyDisabled}
            onApply={confirmData.onApplyAction}
            onCancel={() => setConfirmData(null)}
            onRefetchPreview={confirmData.onRefetchAction}
          />
        );
      })()}
    </div>
  );
};
