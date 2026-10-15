import React, { useState } from 'react';
import { Settings, FileCode, Check } from 'lucide-react';
import { OrchestrationConfigResponse } from '../types';
import { api } from '../api';

interface OrchestrationConfiguratorProps {
  configData: OrchestrationConfigResponse | null;
  onRefresh: () => void;
}

export const OrchestrationConfigurator: React.FC<OrchestrationConfiguratorProps> = ({
  configData,
  onRefresh,
}) => {
  const [agentsMdModal, setAgentsMdModal] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  if (!configData) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading configuration...</div>;
  }

  const { config, meta } = configData;
  const routing = config.routing || {};
  const verification = config.verification || {};
  const tools = config.tools || {};

  const isSingleFramework = routing.default_orchestrator === routing.default_executor;

  const handlePreviewAgentsMd = async () => {
    try {
      const res = await api.renderAgentsMd();
      setAgentsMdModal(res.rendered_block || 'No block rendered');
    } catch (e: any) {
      alert(`Error rendering AGENTS.md: ${e.message}`);
    }
  };

  const handleApplyAgentsMd = async () => {
    setApplying(true);
    setStatusMsg(null);
    try {
      await api.applyAgentsMd();
      setStatusMsg('Successfully applied orchestration rules to AGENTS.md!');
      setAgentsMdModal(null);
      onRefresh();
    } catch (e: any) {
      setStatusMsg(`Error applying AGENTS.md: ${e.message}`);
    } finally {
      setApplying(false);
    }
  };

  const profiles = ['deep-reasoning', 'orchestration', 'bulk-execution', 'exploration'];

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc' }}>Orchestrator & Model Configurator</h1>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem' }}>
            Configure routing, cognitive role profiles, and project isolation rules. Renders deterministically to AGENTS.md.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={handlePreviewAgentsMd}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.4rem 0.8rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#e2e8f0',
              fontSize: '0.85rem',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            <FileCode size={15} color="#818cf8" />
            <span>Preview AGENTS.md</span>
          </button>

          <button
            onClick={handleApplyAgentsMd}
            disabled={applying}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.4rem 0.8rem',
              backgroundColor: '#4f46e5',
              border: 'none',
              borderRadius: '0.375rem',
              color: '#fff',
              fontSize: '0.85rem',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            <Check size={15} />
            <span>{applying ? 'Applying...' : 'Apply to AGENTS.md'}</span>
          </button>
        </div>
      </div>

      {statusMsg && (
        <div style={{
          padding: '0.75rem 1rem',
          borderRadius: '0.375rem',
          marginBottom: '1.5rem',
          backgroundColor: '#064e3b',
          border: '1px solid #10b981',
          color: '#f8fafc',
          fontSize: '0.85rem',
        }}>
          {statusMsg}
        </div>
      )}

      {/* Topology Banner */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        padding: '1.25rem',
        marginBottom: '1.5rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <span style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              padding: '0.2rem 0.5rem',
              borderRadius: '1rem',
              backgroundColor: isSingleFramework ? '#065f46' : '#3730a3',
              color: '#fff',
              textTransform: 'uppercase',
            }}>
              {isSingleFramework ? 'Topology A: Single-Framework Native' : 'Topology B: Multi-Framework MCP'}
            </span>
          </div>
          <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.4rem' }}>
            Primary Orchestrator: <strong style={{ color: '#f8fafc' }}>{routing.default_orchestrator}</strong> |
            Default Executor: <strong style={{ color: '#f8fafc' }}>{routing.default_executor}</strong> |
            Verification Mode: <strong style={{ color: '#f8fafc' }}>{verification.default_mode}</strong>
          </div>
        </div>

        <div style={{ fontSize: '0.75rem', color: '#64748b', textAlign: 'right' }}>
          <div>Global: {meta.global_config_exists ? 'Configured' : 'Default'}</div>
          <div>Project local: {meta.project_config_exists ? 'Override active' : 'Inheriting'}</div>
        </div>
      </div>

      {/* Model Matrix by Cognitive Profile */}
      <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '0.5rem', overflow: 'hidden', marginBottom: '1.5rem' }}>
        <div style={{
          padding: '0.75rem 1rem',
          backgroundColor: '#0f172a',
          borderBottom: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
        }}>
          <Settings size={16} color="#818cf8" />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc' }}>Model Matrix by Cognitive Profile</h3>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ backgroundColor: '#0f172a', color: '#94a3b8', borderBottom: '1px solid #334155' }}>
              <th style={{ padding: '0.6rem 1rem' }}>Cognitive Profile</th>
              <th style={{ padding: '0.6rem 1rem' }}>Kilo Code</th>
              <th style={{ padding: '0.6rem 1rem' }}>Claude Code</th>
              <th style={{ padding: '0.6rem 1rem' }}>Codex CLI</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((prof) => (
              <tr key={prof} style={{ borderBottom: '1px solid #334155' }}>
                <td style={{ padding: '0.6rem 1rem', fontWeight: 600, color: '#818cf8' }}>
                  {prof}
                </td>
                {['kilo', 'claude', 'codex'].map((tool) => {
                  const pentry = tools[tool]?.profiles?.[prof];
                  const model = pentry?.model || '—';
                  const varPart = pentry?.variant ? ` (${pentry.variant})` : pentry?.effort ? ` (${pentry.effort})` : '';
                  return (
                    <td key={tool} style={{ padding: '0.6rem 1rem', color: '#e2e8f0', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {model}{varPart}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Preview Modal */}
      {agentsMdModal && (
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
            borderRadius: '0.5rem',
            width: '100%',
            maxWidth: '900px',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            <div style={{ padding: '1rem', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc' }}>Generated AGENTS.md Orchestration Block</h3>
              <button
                onClick={() => setAgentsMdModal(null)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
              <pre style={{
                backgroundColor: '#0f172a',
                padding: '1rem',
                borderRadius: '0.375rem',
                color: '#cbd5e1',
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
              }}>
                {agentsMdModal}
              </pre>
            </div>
            <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #334155', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                onClick={() => setAgentsMdModal(null)}
                style={{ padding: '0.35rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #64748b', backgroundColor: 'transparent', color: '#cbd5e1', cursor: 'pointer' }}
              >
                Close
              </button>
              <button
                onClick={handleApplyAgentsMd}
                disabled={applying}
                style={{ padding: '0.35rem 0.75rem', borderRadius: '0.375rem', border: 'none', backgroundColor: '#4f46e5', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
              >
                Apply to AGENTS.md Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
