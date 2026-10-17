import React, { useState, useEffect, useMemo } from 'react';
import {
  FileCode,
  Check,
  Loader2,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  Compass,
  Globe,
  FolderGit2,
  CheckCircle2,
  Cpu,
  Eye,
} from 'lucide-react';
import { OrchestrationConfigResponse, VerificationMode, ConfigPreviewResponse } from '../types';
import { api } from '../api';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';

interface OrchestrationConfiguratorProps {
  configData: OrchestrationConfigResponse | null;
  onRefresh: () => void;
  onNavigateToDecisions?: () => void;
}

const PROFILES = [
  { id: 'deep-reasoning', label: 'Deep Reasoning', desc: 'High complexity / silent-failure risk' },
  { id: 'orchestration', label: 'Orchestration', desc: 'Planning, decomposition & verification' },
  { id: 'bulk-execution', label: 'Bulk Execution', desc: 'Standard implementation & tests' },
  { id: 'exploration', label: 'Exploration', desc: 'Fast discovery & read-only search' },
] as const;

const VERIFICATION_MODES: Array<{ id: VerificationMode; label: string; desc: string }> = [
  { id: 'cross-agent', label: 'Cross-Agent', desc: 'Independent verification by another agent (recommended)' },
  { id: 'independent-session', label: 'Independent Session', desc: 'Separate session of same or other agent' },
  { id: 'owner', label: 'Owner', desc: 'Manual human verification gate' },
  { id: 'panel', label: 'Panel', desc: 'Multi-agent review panel' },
  { id: 'self', label: 'Self', desc: 'Self-verified only (caveat)' },
];

const REASONING_OPTIONS = ['', 'low', 'medium', 'high', 'max'];

interface CellEditState {
  model: string;
  variant?: string;
  effort?: string;
}

export const OrchestrationConfigurator: React.FC<OrchestrationConfiguratorProps> = ({
  configData,
  onRefresh,
}) => {
  // Scope: 'global' vs 'project'
  const [selectedScope, setSelectedScope] = useState<'global' | 'project'>(() => {
    return configData?.meta?.project_config_exists ? 'project' : 'global';
  });

  // Routing state
  const [orchestrator, setOrchestrator] = useState<string>('kilo');
  const [executor, setExecutor] = useState<string>('kilo');
  const [defaultProfile, setDefaultProfile] = useState<string>('bulk-execution');
  const [verificationMode, setVerificationMode] = useState<VerificationMode>('cross-agent');

  // Matrix edits keyed by `${tool}:${profile}`
  const [matrixEdits, setMatrixEdits] = useState<Record<string, CellEditState>>({});

  // Loading & Action state
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // AGENTS.md routing warnings (T011)
  const [agentsMdWarnings, setAgentsMdWarnings] = useState<string[]>([]);

  // Confirm dialog state
  const [confirmData, setConfirmData] = useState<(ConfirmDialogPreviewData & {
    title: string;
    applyButtonText?: string;
    onApplyAction: (hash?: string) => Promise<void>;
    onRefetchAction: () => Promise<ConfirmDialogPreviewData>;
  }) | null>(null);

  // Sync state when configData arrives or refreshes
  useEffect(() => {
    if (!configData) return;
    const r = configData.config.routing || {};
    const v = configData.config.verification || {};

    setOrchestrator(r.default_orchestrator || 'kilo');
    setExecutor(r.default_executor || 'kilo');
    setDefaultProfile(r.default_profile || 'bulk-execution');
    setVerificationMode(v.default_mode || 'cross-agent');

    // Populate matrix edits from config
    const initialEdits: Record<string, CellEditState> = {};
    const tools = configData.config.tools || {};
    Object.keys(tools).forEach((toolKey) => {
      const toolProfiles = tools[toolKey]?.profiles || {};
      PROFILES.forEach((prof) => {
        const entry = toolProfiles[prof.id];
        const cellKey = `${toolKey}:${prof.id}`;
        initialEdits[cellKey] = {
          model: entry?.model || '',
          variant: entry?.variant || '',
          effort: entry?.effort || '',
        };
      });
    });
    setMatrixEdits(initialEdits);
  }, [configData]);

  // Prefetch AGENTS.md preview warnings on mount to display T011 warnings immediately
  useEffect(() => {
    let active = true;
    api.previewAgentsMd()
      .then((res) => {
        if (active && res.warnings && res.warnings.length > 0) {
          setAgentsMdWarnings(res.warnings);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!configData) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading configuration...</div>;
  }

  const { config, meta } = configData;
  const initialRouting = config.routing || {};
  const initialVerification = config.verification || {};
  const tools = config.tools || {};

  // Enabled tools
  const enabledTools = Object.entries(tools)
    .filter(([_, t]) => t.enabled !== false)
    .map(([name, t]) => ({ id: name, ...t }));

  const toolList = enabledTools.length > 0
    ? enabledTools
    : [
        { id: 'kilo', cli_command: 'kilo' },
        { id: 'claude', cli_command: 'claude' },
        { id: 'codex', cli_command: 'codex' },
      ];

  const formatToolName = (id: string) => {
    if (id === 'kilo') return 'Kilo Code';
    if (id === 'claude') return 'Claude Code';
    if (id === 'codex') return 'Codex CLI';
    return id.charAt(0).toUpperCase() + id.slice(1);
  };

  const isSingleFramework = orchestrator === executor;

  // Real target file path based on scope
  const targetFilePath = selectedScope === 'project'
    ? meta.project_config_path || '(Project-local configuration file)'
    : meta.global_config_path;

  // Check if routing is modified
  const isRoutingDirty =
    orchestrator !== (initialRouting.default_orchestrator || '') ||
    executor !== (initialRouting.default_executor || '') ||
    defaultProfile !== (initialRouting.default_profile || '') ||
    verificationMode !== (initialVerification.default_mode || '');

  const handleResetRouting = () => {
    setOrchestrator(initialRouting.default_orchestrator || 'kilo');
    setExecutor(initialRouting.default_executor || 'kilo');
    setDefaultProfile(initialRouting.default_profile || 'bulk-execution');
    setVerificationMode(initialVerification.default_mode || 'cross-agent');
  };

  // Check if a specific cell is dirty
  const isCellDirty = (tool: string, profile: string): boolean => {
    const key = `${tool}:${profile}`;
    const current = matrixEdits[key];
    if (!current) return false;
    const initial = tools[tool]?.profiles?.[profile];
    const initialModel = initial?.model || '';
    const initialVariant = initial?.variant || '';
    const initialEffort = initial?.effort || '';

    return (
      current.model !== initialModel ||
      (current.variant || '') !== initialVariant ||
      (current.effort || '') !== initialEffort
    );
  };

  // Collect all dirty cells
  const dirtyCells = useMemo(() => {
    const list: Array<{ tool: string; profile: string; cell: CellEditState }> = [];
    toolList.forEach((t) => {
      PROFILES.forEach((p) => {
        if (isCellDirty(t.id, p.id)) {
          const key = `${t.id}:${p.id}`;
          list.push({ tool: t.id, profile: p.id, cell: matrixEdits[key] });
        }
      });
    });
    return list;
  }, [matrixEdits, toolList, tools]);

  const handleResetMatrix = () => {
    const resetEdits: Record<string, CellEditState> = {};
    Object.keys(tools).forEach((toolKey) => {
      const toolProfiles = tools[toolKey]?.profiles || {};
      PROFILES.forEach((prof) => {
        const entry = toolProfiles[prof.id];
        const cellKey = `${toolKey}:${prof.id}`;
        resetEdits[cellKey] = {
          model: entry?.model || '',
          variant: entry?.variant || '',
          effort: entry?.effort || '',
        };
      });
    });
    setMatrixEdits(resetEdits);
  };

  // Claude Headless Tools policy check (R11)
  const claudeHeadless = tools.claude?.headless;
  const claudeAllowedTools: string[] | undefined = Array.isArray(claudeHeadless?.allowed_tools)
    ? claudeHeadless.allowed_tools
    : undefined;
  const isClaudeAllowedToolsConfigured = Boolean(claudeAllowedTools && claudeAllowedTools.length > 0);

  // -------------------------------------------------------------------------
  // Handlers: Routing Preview & Apply
  // -------------------------------------------------------------------------
  const handlePreviewRouting = async () => {
    setLoadingAction('routing');
    setStatusMsg(null);
    try {
      const res = await api.previewSetRouting(
        selectedScope,
        orchestrator,
        executor,
        defaultProfile,
        verificationMode
      );

      if (!res.changed && !res.diff) {
        setStatusMsg({
          type: 'info',
          text: `No routing changes detected against ${res.path}. Settings match target file.`,
        });
        return;
      }

      setConfirmData({
        title: `Apply Routing Changes (${selectedScope === 'project' ? 'Project-Local' : 'Global'})`,
        summary: `Update primary orchestrator (${orchestrator}), default executor (${executor}), profile (${defaultProfile}), and verification mode (${verificationMode}) in ${res.path}`,
        diff: res.diff,
        hash: res.hash,
        warnings: res.warnings,
        applyButtonText: 'Apply Routing',
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Hash is required to apply routing changes');
          await api.setRouting(
            hash,
            selectedScope,
            orchestrator,
            executor,
            defaultProfile,
            verificationMode
          );
          setConfirmData(null);
          setStatusMsg({
            type: 'success',
            text: `Routing configuration successfully applied to ${res.path}!`,
          });
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewSetRouting(
            selectedScope,
            orchestrator,
            executor,
            defaultProfile,
            verificationMode
          );
          return {
            summary: `Update routing in ${r.path}`,
            diff: r.diff,
            hash: r.hash,
            warnings: r.warnings,
          };
        },
      });
    } catch (err: any) {
      setStatusMsg({
        type: 'error',
        text: `Failed to preview routing changes: ${err.message || err}`,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  // -------------------------------------------------------------------------
  // Handlers: Single Cell Preview & Apply
  // -------------------------------------------------------------------------
  const handlePreviewSingleCell = async (tool: string, profile: string) => {
    const key = `${tool}:${profile}`;
    const cell = matrixEdits[key];
    if (!cell || !cell.model.trim()) {
      setStatusMsg({ type: 'error', text: 'Model identifier cannot be empty.' });
      return;
    }

    setLoadingAction(key);
    setStatusMsg(null);
    try {
      const res = await api.previewSetProfile(
        tool,
        profile,
        cell.model.trim(),
        cell.variant || undefined,
        cell.effort || undefined,
        'operator-stated',
        selectedScope
      );

      if (!res.changed && !res.diff) {
        setStatusMsg({
          type: 'info',
          text: `No profile changes detected for ${tool} [${profile}] in ${res.path}.`,
        });
        return;
      }

      setConfirmData({
        title: `Update ${formatToolName(tool)} / ${profile} (${selectedScope === 'project' ? 'Project-Local' : 'Global'})`,
        summary: `Set model to "${cell.model}"${cell.variant ? ` (variant: ${cell.variant})` : ''}${cell.effort ? ` (effort: ${cell.effort})` : ''} in ${res.path}`,
        diff: res.diff,
        hash: res.hash,
        warnings: res.warnings,
        applyButtonText: 'Apply Profile Change',
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Hash is required to apply profile change');
          await api.setProfile(
            tool,
            profile,
            cell.model.trim(),
            hash,
            cell.variant || undefined,
            cell.effort || undefined,
            'operator-stated',
            selectedScope
          );
          setConfirmData(null);
          setStatusMsg({
            type: 'success',
            text: `Successfully updated ${formatToolName(tool)} profile '${profile}'!`,
          });
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewSetProfile(
            tool,
            profile,
            cell.model.trim(),
            cell.variant || undefined,
            cell.effort || undefined,
            'operator-stated',
            selectedScope
          );
          return {
            summary: `Set model to "${cell.model}" in ${r.path}`,
            diff: r.diff,
            hash: r.hash,
            warnings: r.warnings,
          };
        },
      });
    } catch (err: any) {
      setStatusMsg({
        type: 'error',
        text: `Failed to preview profile change: ${err.message || err}`,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  // -------------------------------------------------------------------------
  // Handlers: Batch Matrix Preview & Apply
  // -------------------------------------------------------------------------
  const handlePreviewBatchMatrix = async () => {
    if (dirtyCells.length === 0) return;

    setLoadingAction('matrix_batch');
    setStatusMsg(null);
    try {
      const previews: Array<{
        tool: string;
        profile: string;
        cell: CellEditState;
        res: ConfigPreviewResponse;
      }> = [];

      for (const item of dirtyCells) {
        if (!item.cell.model.trim()) {
          throw new Error(`Model cannot be empty for ${item.tool} [${item.profile}]`);
        }
        const res = await api.previewSetProfile(
          item.tool,
          item.profile,
          item.cell.model.trim(),
          item.cell.variant || undefined,
          item.cell.effort || undefined,
          'operator-stated',
          selectedScope
        );
        previews.push({ tool: item.tool, profile: item.profile, cell: item.cell, res });
      }

      const changedPreviews = previews.filter((p) => p.res.changed && p.res.diff);
      if (changedPreviews.length === 0) {
        setStatusMsg({
          type: 'info',
          text: 'No changes detected across modified profile cells against the target file.',
        });
        return;
      }

      const mergedDiff = changedPreviews
        .map((p) => `# Tool: ${formatToolName(p.tool)} | Profile: ${p.profile} (${p.res.path})\n${p.res.diff}`)
        .join('\n\n');

      const targetPath = changedPreviews[0].res.path;
      const initialHash = changedPreviews[0].res.hash;

      setConfirmData({
        title: `Apply Model Matrix Changes (${changedPreviews.length} changes, ${selectedScope === 'project' ? 'Project-Local' : 'Global'})`,
        summary: `Update ${changedPreviews.length} role profile mapping(s) sequentially in ${targetPath}`,
        diff: mergedDiff,
        hash: initialHash,
        applyButtonText: `Apply ${changedPreviews.length} Changes`,
        onApplyAction: async () => {
          // Sequential apply with fresh hash per step, stop on first error
          for (let i = 0; i < changedPreviews.length; i++) {
            const item = changedPreviews[i];
            const freshPrev = await api.previewSetProfile(
              item.tool,
              item.profile,
              item.cell.model.trim(),
              item.cell.variant || undefined,
              item.cell.effort || undefined,
              'operator-stated',
              selectedScope
            );
            if (!freshPrev.hash) {
              throw new Error(`Failed to obtain hash for ${item.tool} [${item.profile}]`);
            }
            await api.setProfile(
              item.tool,
              item.profile,
              item.cell.model.trim(),
              freshPrev.hash,
              item.cell.variant || undefined,
              item.cell.effort || undefined,
              'operator-stated',
              selectedScope
            );
          }
          setConfirmData(null);
          setStatusMsg({
            type: 'success',
            text: `Successfully applied ${changedPreviews.length} profile mapping(s)!`,
          });
          onRefresh();
        },
        onRefetchAction: async () => {
          const freshPreviews = [];
          for (const item of changedPreviews) {
            const r = await api.previewSetProfile(
              item.tool,
              item.profile,
              item.cell.model.trim(),
              item.cell.variant || undefined,
              item.cell.effort || undefined,
              'operator-stated',
              selectedScope
            );
            freshPreviews.push({ tool: item.tool, profile: item.profile, res: r });
          }
          return {
            summary: `Update ${freshPreviews.length} role profile mapping(s) in ${freshPreviews[0].res.path}`,
            diff: freshPreviews.map((p) => `# Tool: ${formatToolName(p.tool)} | Profile: ${p.profile}\n${p.res.diff}`).join('\n\n'),
            hash: freshPreviews[0].res.hash,
          };
        },
      });
    } catch (err: any) {
      setStatusMsg({
        type: 'error',
        text: `Batch matrix preview failed: ${err.message || err}`,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  // -------------------------------------------------------------------------
  // Handlers: AGENTS.md Preview & Apply
  // -------------------------------------------------------------------------
  const handleOpenAgentsMdConfirm = async () => {
    setLoadingAction('agents_md');
    setStatusMsg(null);
    try {
      const res = await api.previewAgentsMd();
      if (res.warnings && res.warnings.length > 0) {
        setAgentsMdWarnings(res.warnings);
      }
      setConfirmData({
        title: 'Apply Orchestration Rules to AGENTS.md',
        summary: 'Synchronize active model matrix, cognitive profiles, and routing rules with workspace `AGENTS.md`.',
        diff: res.diff || undefined,
        hash: res.hash,
        warnings: res.warnings,
        applyButtonText: 'Apply to AGENTS.md',
        onApplyAction: async (hash?: string) => {
          if (!hash) throw new Error('Hash is required to apply changes to AGENTS.md');
          const hasNoProjectConfig = !meta.project_config_exists;
          await api.applyAgentsMd(hash, hasNoProjectConfig);
          setConfirmData(null);
          setStatusMsg({
            type: 'success',
            text: 'Successfully updated and formatted AGENTS.md!',
          });
          onRefresh();
        },
        onRefetchAction: async () => {
          const r = await api.previewAgentsMd();
          if (r.warnings) setAgentsMdWarnings(r.warnings);
          return {
            summary: 'Synchronize active model matrix, cognitive profiles, and routing rules with workspace `AGENTS.md`.',
            diff: r.diff || undefined,
            hash: r.hash,
            warnings: r.warnings,
          };
        },
      });
    } catch (e: any) {
      setStatusMsg({
        type: 'error',
        text: `Failed to generate AGENTS.md preview: ${e.message}`,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1150px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>Orchestrator & Model Configurator</h1>
            <span style={{
              fontSize: '0.75rem',
              padding: '0.15rem 0.5rem',
              borderRadius: '0.375rem',
              backgroundColor: isSingleFramework ? '#065f46' : '#3730a3',
              color: isSingleFramework ? '#a7f3d0' : '#c7d2fe',
              fontWeight: 600,
            }}>
              {isSingleFramework ? 'Topology A: Native' : 'Topology B: Multi-Framework MCP'}
            </span>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.3rem', margin: '0.3rem 0 0 0' }}>
            Configure routing, cognitive role profiles, and project isolation rules. All edits preview as unified diffs and apply safely via hashes.
          </p>
        </div>

        {/* Global Refresh Button */}
        <button
          onClick={onRefresh}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.4rem 0.8rem',
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '0.375rem',
            color: '#cbd5e1',
            fontSize: '0.8rem',
            cursor: 'pointer',
          }}
        >
          <RotateCcw size={14} />
          <span>Reload Config</span>
        </button>
      </div>

      {/* Status Alert Banner */}
      {statusMsg && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.75rem 1rem',
          borderRadius: '0.375rem',
          backgroundColor: statusMsg.type === 'success' ? '#064e3b' : statusMsg.type === 'error' ? '#451a1a' : '#1e3a8a',
          border: `1px solid ${statusMsg.type === 'success' ? '#10b981' : statusMsg.type === 'error' ? '#ef4444' : '#3b82f6'}`,
          color: '#f8fafc',
          fontSize: '0.85rem',
        }}>
          {statusMsg.type === 'success' ? (
            <CheckCircle2 size={16} color="#10b981" />
          ) : statusMsg.type === 'error' ? (
            <AlertCircle size={16} color="#ef4444" />
          ) : (
            <AlertCircle size={16} color="#60a5fa" />
          )}
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* Validation Errors from config show */}
      {configData.errors && configData.errors.length > 0 && (
        <div style={{
          backgroundColor: '#451a1a',
          border: '1px solid #ef4444',
          borderRadius: '0.5rem',
          padding: '1rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#fca5a5', fontWeight: 600, fontSize: '0.9rem' }}>
            <AlertCircle size={17} color="#ef4444" />
            <span>Configuration Validation Errors ({configData.errors.length})</span>
          </div>
          <ul style={{ margin: '0.5rem 0 0 1.3rem', padding: 0, color: '#fecaca', fontSize: '0.85rem' }}>
            {configData.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Validation Warnings from config show */}
      {configData.warnings && configData.warnings.length > 0 && (
        <div style={{
          backgroundColor: '#451a03',
          border: '1px solid #f59e0b',
          borderRadius: '0.5rem',
          padding: '1rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#fde68a', fontWeight: 600, fontSize: '0.9rem' }}>
            <AlertTriangle size={17} color="#f59e0b" />
            <span>Configuration Warnings ({configData.warnings.length})</span>
          </div>
          <ul style={{ margin: '0.5rem 0 0 1.3rem', padding: 0, color: '#fef3c7', fontSize: '0.85rem' }}>
            {configData.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Claude headless permission policy (R11). Since 07.12 (decision Q001 = A) an empty
          config is valid: runs use the built-in per-mode allow-list, never --dangerously-*. */}
      <div style={{
        backgroundColor: '#0f172a',
        border: '1px solid #334155',
        borderLeft: '4px solid #10b981',
        borderRadius: '0.5rem',
        padding: '0.85rem 1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
      }}>
        <CheckCircle2 size={17} color="#10b981" />
        <div>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e2e8f0' }}>
            Claude headless permissions:{' '}
            <span style={{ color: '#10b981', fontWeight: 500 }}>
              {isClaudeAllowedToolsConfigured ? 'custom allow-list' : 'built-in per-mode allow-list'}
            </span>
          </div>
          <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '0.15rem' }}>
            {isClaudeAllowedToolsConfigured ? (
              <span>Allowed tools: <code>{claudeAllowedTools?.join(', ')}</code></span>
            ) : (
              <span>
                Each run mode (execute, verify, orchestrate) gets its own default tool list (decision Q001). Set{' '}
                <code>allowed_tools</code> under <code>[tools.claude.headless]</code> only to override it.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Scope Selector Card */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        padding: '1.25rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Compass size={17} color="#818cf8" />
              <span>Target Configuration Scope</span>
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0.2rem 0 0 0' }}>
              Choose whether edits update global host defaults or project-local overrides for this repository.
            </p>
          </div>

          <div style={{
            fontSize: '0.78rem',
            padding: '0.25rem 0.6rem',
            borderRadius: '0.375rem',
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            color: '#cbd5e1',
          }}>
            Active File:{' '}
            <strong style={{ color: '#818cf8', fontFamily: 'monospace' }}>
              {targetFilePath}
            </strong>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
          {/* Global Option */}
          <div
            onClick={() => setSelectedScope('global')}
            style={{
              padding: '0.85rem 1rem',
              borderRadius: '0.375rem',
              border: `2px solid ${selectedScope === 'global' ? '#6366f1' : '#334155'}`,
              backgroundColor: selectedScope === 'global' ? '#1e1b4b' : '#0f172a',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.75rem',
              transition: 'border-color 0.15s, background-color 0.15s',
            }}
          >
            <Globe size={18} color={selectedScope === 'global' ? '#818cf8' : '#64748b'} style={{ marginTop: '0.15rem' }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, fontSize: '0.88rem', color: selectedScope === 'global' ? '#f8fafc' : '#cbd5e1' }}>
                  Global Scope
                </span>
                <span style={{
                  fontSize: '0.7rem',
                  padding: '0.1rem 0.4rem',
                  borderRadius: '0.25rem',
                  backgroundColor: meta.global_config_exists ? '#064e3b' : '#334155',
                  color: meta.global_config_exists ? '#34d399' : '#94a3b8',
                }}>
                  {meta.global_config_exists ? 'Configured' : 'Default'}
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.25rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {meta.global_config_path}
              </div>
            </div>
          </div>

          {/* Project-Local Option */}
          <div
            onClick={() => setSelectedScope('project')}
            style={{
              padding: '0.85rem 1rem',
              borderRadius: '0.375rem',
              border: `2px solid ${selectedScope === 'project' ? '#6366f1' : '#334155'}`,
              backgroundColor: selectedScope === 'project' ? '#1e1b4b' : '#0f172a',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.75rem',
              transition: 'border-color 0.15s, background-color 0.15s',
            }}
          >
            <FolderGit2 size={18} color={selectedScope === 'project' ? '#818cf8' : '#64748b'} style={{ marginTop: '0.15rem' }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, fontSize: '0.88rem', color: selectedScope === 'project' ? '#f8fafc' : '#cbd5e1' }}>
                  Project-Local Scope
                </span>
                <span style={{
                  fontSize: '0.7rem',
                  padding: '0.1rem 0.4rem',
                  borderRadius: '0.25rem',
                  backgroundColor: meta.project_config_exists ? '#064e3b' : '#451a03',
                  color: meta.project_config_exists ? '#34d399' : '#fbbf24',
                }}>
                  {meta.project_config_exists ? 'Active Override' : 'Inherits Global'}
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.25rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {meta.project_config_path || '(will be created on save)'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Routing Editor Section */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        padding: '1.25rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Compass size={17} color="#818cf8" />
              <span>Routing & Verification Policies</span>
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0.2rem 0 0 0' }}>
              Configure defaults for who orchestrates, who executes, and how deliverables are verified.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {isRoutingDirty && (
              <button
                onClick={handleResetRouting}
                style={{
                  padding: '0.4rem 0.75rem',
                  backgroundColor: '#334155',
                  border: 'none',
                  borderRadius: '0.375rem',
                  color: '#cbd5e1',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                }}
              >
                <RotateCcw size={13} />
                <span>Revert</span>
              </button>
            )}

            <button
              onClick={handlePreviewRouting}
              disabled={loadingAction === 'routing'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.9rem',
                backgroundColor: isRoutingDirty ? '#4f46e5' : '#312e81',
                border: isRoutingDirty ? 'none' : '1px solid #4338ca',
                borderRadius: '0.375rem',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: loadingAction === 'routing' ? 'not-allowed' : 'pointer',
              }}
            >
              {loadingAction === 'routing' ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Eye size={15} />
              )}
              <span>Preview & Apply Routing</span>
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
          {/* Primary Orchestrator */}
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
              Primary Orchestrator
            </label>
            <select
              value={orchestrator}
              onChange={(e) => setOrchestrator(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
              }}
            >
              {toolList.map((t) => (
                <option key={t.id} value={t.id}>
                  {formatToolName(t.id)} ({t.id})
                </option>
              ))}
            </select>
            <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.25rem' }}>
              Drives macro-planning and task specification in main session.
            </div>
          </div>

          {/* Default Executor */}
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
              Default Executor
            </label>
            <select
              value={executor}
              onChange={(e) => setExecutor(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
              }}
            >
              {toolList.map((t) => (
                <option key={t.id} value={t.id}>
                  {formatToolName(t.id)} ({t.id})
                </option>
              ))}
            </select>
            <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.25rem' }}>
              Executes implementation tasks in dedicated worktrees.
            </div>
          </div>

          {/* Default Cognitive Profile */}
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
              Default Cognitive Profile
            </label>
            <select
              value={defaultProfile}
              onChange={(e) => setDefaultProfile(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
              }}
            >
              {PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.id})
                </option>
              ))}
            </select>
            <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.25rem' }}>
              Default model tier applied when unspecified in task.
            </div>
          </div>

          {/* Default Verification Mode */}
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
              Default Verification Mode
            </label>
            <select
              value={verificationMode}
              onChange={(e) => setVerificationMode(e.target.value as VerificationMode)}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
              }}
            >
              {VERIFICATION_MODES.map((vm) => (
                <option key={vm.id} value={vm.id}>
                  {vm.label} — {vm.id}
                </option>
              ))}
            </select>
            <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.25rem' }}>
              Verification gate required before marking delivered tasks as verified.
            </div>
          </div>
        </div>
      </div>

      {/* Profile/Model Matrix Section */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        overflow: 'hidden',
      }}>
        {/* Matrix Header */}
        <div style={{
          padding: '1rem 1.25rem',
          backgroundColor: '#0f172a',
          borderBottom: '1px solid #334155',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Cpu size={17} color="#818cf8" />
              <span>Model Matrix by Cognitive Profile</span>
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0.2rem 0 0 0' }}>
              Map each abstract role profile to concrete model identifiers and reasoning variants/effort per tool.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {dirtyCells.length > 0 && (
              <>
                <span style={{
                  fontSize: '0.75rem',
                  padding: '0.2rem 0.5rem',
                  backgroundColor: '#78350f',
                  color: '#fef3c7',
                  borderRadius: '0.25rem',
                  fontWeight: 600,
                }}>
                  {dirtyCells.length} {dirtyCells.length === 1 ? 'cell modified' : 'cells modified'}
                </span>

                <button
                  onClick={handleResetMatrix}
                  style={{
                    padding: '0.35rem 0.7rem',
                    backgroundColor: '#334155',
                    border: 'none',
                    borderRadius: '0.375rem',
                    color: '#cbd5e1',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}
                >
                  <RotateCcw size={13} />
                  <span>Revert Matrix</span>
                </button>

                <button
                  onClick={handlePreviewBatchMatrix}
                  disabled={loadingAction === 'matrix_batch'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.35rem 0.8rem',
                    backgroundColor: '#4f46e5',
                    border: 'none',
                    borderRadius: '0.375rem',
                    color: '#fff',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    cursor: loadingAction === 'matrix_batch' ? 'not-allowed' : 'pointer',
                  }}
                >
                  {loadingAction === 'matrix_batch' ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Eye size={14} />
                  )}
                  <span>Preview & Apply All ({dirtyCells.length})</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Matrix Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ backgroundColor: '#0f172a', color: '#94a3b8', borderBottom: '1px solid #334155' }}>
                <th style={{ padding: '0.75rem 1rem', width: '220px', minWidth: '180px' }}>
                  Cognitive Profile
                </th>
                {toolList.map((t) => (
                  <th key={t.id} style={{ padding: '0.75rem 1rem', minWidth: '260px' }}>
                    <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{formatToolName(t.id)}</div>
                    <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 400 }}>
                      id: <code>{t.id}</code>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROFILES.map((prof) => (
                <tr key={prof.id} style={{ borderBottom: '1px solid #334155' }}>
                  {/* Profile info cell */}
                  <td style={{ padding: '0.85rem 1rem', verticalAlign: 'top', backgroundColor: '#0f172a50' }}>
                    <div style={{ fontWeight: 600, color: '#818cf8', fontSize: '0.9rem' }}>
                      {prof.label}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                      {prof.desc}
                    </div>
                    <code style={{ fontSize: '0.7rem', color: '#64748b', display: 'inline-block', marginTop: '0.35rem' }}>
                      {prof.id}
                    </code>
                  </td>

                  {/* Tool cells */}
                  {toolList.map((t) => {
                    const cellKey = `${t.id}:${prof.id}`;
                    const edit = matrixEdits[cellKey] || { model: '', variant: '', effort: '' };
                    const dirty = isCellDirty(t.id, prof.id);
                    const isLoadingThis = loadingAction === cellKey;
                    const isKiloTool = t.id === 'kilo';

                    return (
                      <td
                        key={t.id}
                        style={{
                          padding: '0.75rem 1rem',
                          verticalAlign: 'top',
                          backgroundColor: dirty ? '#78350f15' : 'transparent',
                          borderLeft: dirty ? '3px solid #f59e0b' : 'none',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          {/* Model input */}
                          <div>
                            <input
                              type="text"
                              value={edit.model}
                              placeholder="model identifier..."
                              onChange={(e) => {
                                const val = e.target.value;
                                setMatrixEdits((prev) => ({
                                  ...prev,
                                  [cellKey]: { ...prev[cellKey], model: val },
                                }));
                              }}
                              style={{
                                width: '100%',
                                padding: '0.4rem 0.6rem',
                                backgroundColor: '#0f172a',
                                border: `1px solid ${dirty ? '#f59e0b' : '#334155'}`,
                                borderRadius: '0.375rem',
                                color: '#f8fafc',
                                fontSize: '0.82rem',
                                fontFamily: 'monospace',
                                boxSizing: 'border-box',
                              }}
                            />
                          </div>

                          {/* Reasoning parameter select (variant for Kilo, effort for Claude/Codex) */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1 }}>
                              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                                {isKiloTool ? 'variant:' : 'effort:'}
                              </span>
                              <select
                                value={isKiloTool ? (edit.variant || '') : (edit.effort || '')}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setMatrixEdits((prev) => ({
                                    ...prev,
                                    [cellKey]: {
                                      ...prev[cellKey],
                                      variant: isKiloTool ? val : undefined,
                                      effort: !isKiloTool ? val : undefined,
                                    },
                                  }));
                                }}
                                style={{
                                  padding: '0.25rem 0.5rem',
                                  backgroundColor: '#0f172a',
                                  border: '1px solid #334155',
                                  borderRadius: '0.25rem',
                                  color: '#cbd5e1',
                                  fontSize: '0.75rem',
                                }}
                              >
                                {REASONING_OPTIONS.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt ? opt : '(none)'}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* Per-cell Preview & Apply action if dirty */}
                            {dirty && (
                              <button
                                onClick={() => handlePreviewSingleCell(t.id, prof.id)}
                                disabled={isLoadingThis}
                                title="Preview & apply changes to this profile"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  padding: '0.25rem 0.5rem',
                                  backgroundColor: '#4f46e5',
                                  border: 'none',
                                  borderRadius: '0.25rem',
                                  color: '#fff',
                                  fontSize: '0.72rem',
                                  fontWeight: 600,
                                  cursor: isLoadingThis ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {isLoadingThis ? <Loader2 size={12} className="spin" /> : <Eye size={12} />}
                                <span>Save</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* AGENTS.md Synchronization Card */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        padding: '1.25rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <FileCode size={17} color="#818cf8" />
              <span>AGENTS.md Orchestration Guidelines</span>
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0.2rem 0 0 0' }}>
              Synchronizes active model matrix, cognitive profiles, and routing rules deterministically into the workspace <code>AGENTS.md</code>.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleOpenAgentsMdConfirm}
              disabled={loadingAction === 'agents_md'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.8rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#e2e8f0',
                fontSize: '0.85rem',
                cursor: loadingAction === 'agents_md' ? 'not-allowed' : 'pointer',
                fontWeight: 500,
              }}
            >
              {loadingAction === 'agents_md' ? <Loader2 size={15} className="spin" /> : <FileCode size={15} color="#818cf8" />}
              <span>Preview AGENTS.md Diff</span>
            </button>

            <button
              onClick={handleOpenAgentsMdConfirm}
              disabled={loadingAction === 'agents_md'}
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
                cursor: loadingAction === 'agents_md' ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              <Check size={15} />
              <span>Apply to AGENTS.md…</span>
            </button>
          </div>
        </div>

        {/* AGENTS.md Routing & Topology Warnings (T011) */}
        {agentsMdWarnings.length > 0 && (
          <div style={{
            backgroundColor: '#0f172a',
            border: '1px solid #ca8a04',
            borderLeft: '4px solid #eab308',
            borderRadius: '0.375rem',
            padding: '0.75rem 1rem',
            marginTop: '0.5rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#fef08a', fontWeight: 600, fontSize: '0.82rem' }}>
              <AlertTriangle size={15} color="#eab308" />
              <span>Routing & Topology Warnings for AGENTS.md (T011):</span>
            </div>
            <ul style={{ margin: '0.35rem 0 0 1.25rem', padding: 0, fontSize: '0.78rem', color: '#fef9c3' }}>
              {agentsMdWarnings.map((w, idx) => (
                <li key={idx} style={{ marginTop: '0.15rem' }}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      {confirmData && (
        <ConfirmDialog
          isOpen={true}
          title={confirmData.title}
          summary={confirmData.summary}
          diff={confirmData.diff}
          warnings={confirmData.warnings}
          hash={confirmData.hash}
          applyButtonText={confirmData.applyButtonText || 'Apply'}
          onApply={confirmData.onApplyAction}
          onCancel={() => setConfirmData(null)}
          onRefetchPreview={confirmData.onRefetchAction}
        />
      )}
    </div>
  );
};
