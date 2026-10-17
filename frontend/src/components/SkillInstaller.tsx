import React, { useState } from 'react';
import { DownloadCloud, Server, Check, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../api';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';

interface SkillInstallerProps {
  onRefresh: () => void;
}

export const SkillInstaller: React.FC<SkillInstallerProps> = ({ onRefresh }) => {
  // No assistant preselected; scope radio has no default (must choose)
  const [selectedAssistants, setSelectedAssistants] = useState<string[]>([]);
  const [scope, setScope] = useState<'global' | 'project' | null>(null);
  const [useSymlink, setUseSymlink] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Confirm dialog state
  const [confirmData, setConfirmData] = useState<(ConfirmDialogPreviewData & {
    title: string;
    onApplyAction: (hash?: string) => Promise<void>;
    onRefetchAction: () => Promise<ConfirmDialogPreviewData>;
  }) | null>(null);

  const toggleAssistant = (a: string) => {
    setSelectedAssistants((prev) =>
      prev.includes(a) ? prev.filter((item) => item !== a) : [...prev, a]
    );
  };

  const canAct = selectedAssistants.length > 0 && scope !== null;

  const handleInstallSkills = async (repo: string) => {
    if (!canAct || !scope) return;
    setLoadingAction(`skills-${repo}`);
    setStatusMessage(null);

    try {
      const res = await api.previewInstallSkills(selectedAssistants, scope, repo, useSymlink);
      setConfirmData({
        title: `Install Skills (${repo})`,
        summary: `Install skills from **${repo}** into **${selectedAssistants.join(', ')}** (${scope} scope). Mode: ${useSymlink ? 'Symlink (dev)' : 'Copy (standalone)'}.`,
        plan: res.plan,
        warnings: res.warnings,
        hash: res.plan_hash,
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Plan hash is required for installation');
          const applyRes = await api.installSkills(selectedAssistants, scope, repo, useSymlink, hash);
          setConfirmData(null);
          setStatusMessage({
            type: 'success',
            text: `Successfully installed ${applyRes.installed_count ?? applyRes.plan?.length ?? ''} skill(s) from ${repo} into ${selectedAssistants.join(', ')} (${scope}).`,
          });
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewInstallSkills(selectedAssistants, scope, repo, useSymlink);
          return {
            summary: `Install skills from **${repo}** into **${selectedAssistants.join(', ')}** (${scope} scope). Mode: ${useSymlink ? 'Symlink (dev)' : 'Copy (standalone)'}.`,
            plan: r.plan,
            warnings: r.warnings,
            hash: r.plan_hash,
          };
        },
      });
    } catch (e: any) {
      setStatusMessage({ type: 'error', text: `Failed to generate install preview: ${e.message}` });
    } finally {
      setLoadingAction(null);
    }
  };

  const handleRegisterMcp = async (server: string) => {
    if (!canAct || !scope) return;
    setLoadingAction(`mcp-${server}`);
    setStatusMessage(null);

    try {
      const res = await api.previewRegisterMcp(server, selectedAssistants, scope, true);
      setConfirmData({
        title: `Register MCP Server (${server})`,
        summary: `Register MCP server **${server}** in configuration for **${selectedAssistants.join(', ')}** (${scope} scope). Python venv provisioning is enabled.`,
        plan: res.plan,
        warnings: res.warnings,
        hash: res.plan_hash,
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Plan hash is required for MCP registration');
          const applyRes = await api.registerMcp(server, selectedAssistants, scope, true, hash);
          setConfirmData(null);
          setStatusMessage({
            type: 'success',
            text: `Successfully registered MCP server '${server}' in ${applyRes.updated_configs?.length ?? 1} assistant config(s).`,
          });
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewRegisterMcp(server, selectedAssistants, scope, true);
          return {
            summary: `Register MCP server **${server}** in configuration for **${selectedAssistants.join(', ')}** (${scope} scope). Python venv provisioning is enabled.`,
            plan: r.plan,
            warnings: r.warnings,
            hash: r.plan_hash,
          };
        },
      });
    } catch (e: any) {
      setStatusMessage({ type: 'error', text: `Failed to generate MCP preview: ${e.message}` });
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc' }}>Install Skills & Register MCP Servers</h1>
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem' }}>
          Deploy orchestration skills and standalone MCP bindings across Kilo Code, Claude Code, and Codex CLI (Global or Project scope).
        </p>
      </div>

      {/* Target Options Bar */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginBottom: '1.5rem',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '2rem',
        alignItems: 'center',
      }}>
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '0.4rem' }}>
            Target Assistants <span style={{ color: selectedAssistants.length === 0 ? '#ef4444' : '#10b981' }}>*</span>
          </label>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {['kilo', 'claude', 'codex'].map((a) => (
              <label key={a} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: '#e2e8f0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedAssistants.includes(a)}
                  onChange={() => toggleAssistant(a)}
                />
                <span style={{ textTransform: 'capitalize' }}>{a}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '0.4rem' }}>
            Installation Scope <span style={{ color: scope === null ? '#ef4444' : '#10b981' }}>*</span>
          </label>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: '#e2e8f0', cursor: 'pointer' }}>
              <input
                type="radio"
                name="scope"
                value="global"
                checked={scope === 'global'}
                onChange={() => setScope('global')}
              />
              <span>Global (~/.kilo, ~/.claude, ~/.codex)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: '#e2e8f0', cursor: 'pointer' }}>
              <input
                type="radio"
                name="scope"
                value="project"
                checked={scope === 'project'}
                onChange={() => setScope('project')}
              />
              <span>Project Workspace</span>
            </label>
          </div>
        </div>

        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '0.4rem' }}>
            Mode
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: '#e2e8f0', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useSymlink}
              onChange={(e) => setUseSymlink(e.target.checked)}
            />
            <span>Symlink to local repo (dev mode)</span>
          </label>
        </div>
      </div>

      {/* Helper notice when choices are missing */}
      {!canAct && (
        <div style={{
          padding: '0.6rem 1rem',
          borderRadius: '0.375rem',
          marginBottom: '1.5rem',
          backgroundColor: '#1e293b',
          border: '1px dashed #475569',
          color: '#94a3b8',
          fontSize: '0.8rem',
        }}>
          Please select at least one <strong>Target Assistant</strong> and choose an <strong>Installation Scope</strong> (Global or Project) to enable installation and registration actions.
        </div>
      )}

      {/* Notification banner */}
      {statusMessage && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.75rem 1rem',
          borderRadius: '0.375rem',
          marginBottom: '1.5rem',
          backgroundColor: statusMessage.type === 'success' ? '#064e3b' : '#7f1d1d',
          border: `1px solid ${statusMessage.type === 'success' ? '#10b981' : '#ef4444'}`,
          color: '#f8fafc',
          fontSize: '0.85rem',
        }}>
          {statusMessage.type === 'success' ? <Check size={16} color="#10b981" /> : <AlertCircle size={16} color="#ef4444" />}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Repository Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem' }}>
        {/* ai-orchestration card */}
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <DownloadCloud size={20} color="#818cf8" />
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc' }}>ai-orchestration</h3>
            </div>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.4, marginBottom: '1rem' }}>
              Core execution-agnostic skills (architect-side, executor-side, shared): <code>orchestration-workflow</code>, <code>task-pipeline</code>, <code>task-spec-authoring</code>, <code>task-worktree-ops</code>, <code>conflict-resolver</code>, <code>orchestration-metrics</code>, <code>executor-contract</code>, <code>orchestration-setup</code>.
            </p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.75rem', borderTop: '1px solid #334155' }}>
            <button
              onClick={() => handleInstallSkills('ai-orchestration')}
              disabled={!canAct || loadingAction !== null}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.4rem 0.8rem',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: canAct ? '#4f46e5' : '#334155',
                color: canAct ? '#fff' : '#64748b',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: canAct ? 'pointer' : 'not-allowed',
              }}
            >
              {loadingAction === 'skills-ai-orchestration' ? <Loader2 size={15} className="spin" /> : <DownloadCloud size={15} />}
              <span>Install Core Skills (8)</span>
            </button>
          </div>
        </div>

        {/* kilo-mcp card */}
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <Server size={20} color="#10b981" />
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc' }}>kilo-mcp</h3>
            </div>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.4, marginBottom: '1rem' }}>
              Standalone MCP server for headless Kilo CLI runs (<code>kilo_implement</code>, <code>kilo_task_wait</code>, <code>kilo_rag_search</code>) + Kilo-bound skills (<code>kilo-mcp-orchestrator</code>, <code>kilo-mcp-metrics-analyst</code>, <code>kilo-mcp-orchestrator-agent</code>).
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', paddingTop: '0.75rem', borderTop: '1px solid #334155' }}>
            <button
              onClick={() => handleInstallSkills('kilo-mcp')}
              disabled={!canAct || loadingAction !== null}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.4rem 0.8rem',
                borderRadius: '0.375rem',
                border: '1px solid #334155',
                backgroundColor: canAct ? '#0f172a' : '#1e293b',
                color: canAct ? '#e2e8f0' : '#64748b',
                fontSize: '0.85rem',
                fontWeight: 500,
                cursor: canAct ? 'pointer' : 'not-allowed',
              }}
            >
              {loadingAction === 'skills-kilo-mcp' ? <Loader2 size={15} className="spin" /> : <DownloadCloud size={15} />}
              <span>Install Bound Skills</span>
            </button>

            <button
              onClick={() => handleRegisterMcp('kilo-mcp')}
              disabled={!canAct || loadingAction !== null}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.4rem 0.8rem',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: canAct ? '#10b981' : '#334155',
                color: canAct ? '#fff' : '#64748b',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: canAct ? 'pointer' : 'not-allowed',
              }}
            >
              {loadingAction === 'mcp-kilo-mcp' ? <Loader2 size={15} className="spin" /> : <Server size={15} />}
              <span>Provision & Register MCP</span>
            </button>
          </div>
        </div>

        {/* codex-mcp card */}
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <Server size={20} color="#0ea5e9" />
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc' }}>codex-mcp</h3>
            </div>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.4, marginBottom: '1rem' }}>
              Registers Codex CLI's native stdio MCP server (<code>codex mcp-server</code>) in Claude Code and Kilo Code configurations so they can delegate review and execution tasks to Codex.
            </p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.75rem', borderTop: '1px solid #334155' }}>
            <button
              onClick={() => handleRegisterMcp('codex-mcp')}
              disabled={!canAct || loadingAction !== null}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.4rem 0.8rem',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: canAct ? '#0ea5e9' : '#334155',
                color: canAct ? '#fff' : '#64748b',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: canAct ? 'pointer' : 'not-allowed',
              }}
            >
              {loadingAction === 'mcp-codex-mcp' ? <Loader2 size={15} className="spin" /> : <Server size={15} />}
              <span>Register Codex MCP</span>
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmData && (
        <ConfirmDialog
          isOpen={true}
          title={confirmData.title}
          summary={confirmData.summary}
          plan={confirmData.plan}
          diff={confirmData.diff}
          warnings={confirmData.warnings}
          hash={confirmData.hash}
          applyButtonText="Confirm & Apply"
          onApply={confirmData.onApplyAction}
          onCancel={() => setConfirmData(null)}
          onRefetchPreview={confirmData.onRefetchAction}
        />
      )}
    </div>
  );
};
