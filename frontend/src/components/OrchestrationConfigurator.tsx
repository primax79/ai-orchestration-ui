import React, { useState } from 'react';
import { Settings, FileCode, Check, Loader2, AlertCircle } from 'lucide-react';
import { OrchestrationConfigResponse } from '../types';
import { api } from '../api';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';

interface OrchestrationConfiguratorProps {
  configData: OrchestrationConfigResponse | null;
  onRefresh: () => void;
}

export const OrchestrationConfigurator: React.FC<OrchestrationConfiguratorProps> = ({
  configData,
  onRefresh,
}) => {
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Confirm dialog state
  const [confirmData, setConfirmData] = useState<(ConfirmDialogPreviewData & {
    title: string;
    onApplyAction: (hash?: string) => Promise<void>;
    onRefetchAction: () => Promise<ConfirmDialogPreviewData>;
  }) | null>(null);

  if (!configData) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading configuration...</div>;
  }

  const { config, meta } = configData;
  const routing = config.routing || {};
  const verification = config.verification || {};
  const tools = config.tools || {};

  const isSingleFramework = routing.default_orchestrator === routing.default_executor;

  const handleOpenAgentsMdConfirm = async () => {
    setLoadingPreview(true);
    setStatusMsg(null);
    try {
      const res = await api.previewAgentsMd();
      setConfirmData({
        title: 'Apply Orchestration Rules to AGENTS.md',
        summary: 'Synchronize the active model matrix, cognitive profiles, and routing rules with the workspace `AGENTS.md`.',
        diff: res.diff || undefined,
        hash: res.hash,
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Hash is required to apply changes to AGENTS.md');
          await api.applyAgentsMd(hash);
          setConfirmData(null);
          setStatusMsg({
            type: 'success',
            text: 'Successfully updated and formatted AGENTS.md!',
          });
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewAgentsMd();
          return {
            summary: 'Synchronize the active model matrix, cognitive profiles, and routing rules with the workspace `AGENTS.md`.',
            diff: r.diff || undefined,
            hash: r.hash,
          };
        },
      });
    } catch (e: any) {
      setStatusMsg({
        type: 'error',
        text: `Failed to generate AGENTS.md preview: ${e.message}`,
      });
    } finally {
      setLoadingPreview(false);
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
            onClick={handleOpenAgentsMdConfirm}
            disabled={loadingPreview}
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
              cursor: loadingPreview ? 'not-allowed' : 'pointer',
              fontWeight: 500,
            }}
          >
            {loadingPreview ? <Loader2 size={15} className="spin" /> : <FileCode size={15} color="#818cf8" />}
            <span>Preview Diff</span>
          </button>

          <button
            onClick={handleOpenAgentsMdConfirm}
            disabled={loadingPreview}
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
              cursor: loadingPreview ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            <Check size={15} />
            <span>Apply to AGENTS.md…</span>
          </button>
        </div>
      </div>

      {statusMsg && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.75rem 1rem',
          borderRadius: '0.375rem',
          marginBottom: '1.5rem',
          backgroundColor: statusMsg.type === 'success' ? '#064e3b' : '#451a1a',
          border: `1px solid ${statusMsg.type === 'success' ? '#10b981' : '#ef4444'}`,
          color: '#f8fafc',
          fontSize: '0.85rem',
        }}>
          {statusMsg.type === 'success' ? <Check size={16} color="#10b981" /> : <AlertCircle size={16} color="#ef4444" />}
          <span>{statusMsg.text}</span>
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
            Primary Orchestrator: <strong style={{ color: '#f8fafc' }}>{routing.default_orchestrator || '—'}</strong> |
            Default Executor: <strong style={{ color: '#f8fafc' }}>{routing.default_executor || '—'}</strong> |
            Verification Mode: <strong style={{ color: '#f8fafc' }}>{verification.default_mode || '—'}</strong>
          </div>
        </div>

        <div style={{ fontSize: '0.75rem', color: '#64748b', textAlign: 'right' }}>
          <div>Global: {meta?.global_config_exists ? 'Configured' : 'Default'}</div>
          <div>Project local: {meta?.project_config_exists ? 'Override active' : 'Inheriting'}</div>
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

      {/* Confirmation Modal */}
      {confirmData && (
        <ConfirmDialog
          isOpen={true}
          title={confirmData.title}
          summary={confirmData.summary}
          diff={confirmData.diff}
          hash={confirmData.hash}
          applyButtonText="Apply to AGENTS.md"
          onApply={confirmData.onApplyAction}
          onCancel={() => setConfirmData(null)}
          onRefetchPreview={confirmData.onRefetchAction}
        />
      )}
    </div>
  );
};
