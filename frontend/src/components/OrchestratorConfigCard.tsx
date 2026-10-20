import React, { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Play,
  Pause,
  RefreshCw,
  ArrowRightLeft,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Shield,
  Layers,
  X,
  FileCode,
} from 'lucide-react';
import {
  OrchestrationConfigResponse,
  OrchestratorStatus,
  OrchestratorReassignPreviewResponse,
} from '../types';
import { orchestratorConfigApi, useProject } from '../api';

interface OrchestratorConfigCardProps {
  configData: OrchestrationConfigResponse | null;
  onRefresh: () => void;
  onOpenSetupWizard?: () => void;
}

export const OrchestratorConfigCard: React.FC<OrchestratorConfigCardProps> = ({
  configData,
  onRefresh,
  onOpenSetupWizard,
}) => {
  const targetProject = useProject();
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Rotate confirmation dialog state
  const [showRotateConfirm, setShowRotateConfirm] = useState<boolean>(false);

  // Reassign dialog state
  const [showReassignModal, setShowReassignModal] = useState<boolean>(false);
  const [reassignTool, setReassignTool] = useState<string>('claude');
  const [reassignModel, setReassignModel] = useState<string>('');
  const [reassignScope, setReassignScope] = useState<'project' | 'global'>('project');
  const [reassignPreview, setReassignPreview] = useState<OrchestratorReassignPreviewResponse | null>(null);
  const [reassignLoading, setReassignLoading] = useState<boolean>(false);

  // Fetch orchestrator status
  const fetchStatus = useCallback(async () => {
    if (!targetProject) return;
    setLoadingStatus(true);
    setErrorMsg(null);
    try {
      const data = await orchestratorConfigApi.getOrchestratorStatus(targetProject);
      setStatus(data);
    } catch (err: any) {
      console.error('Failed to fetch orchestrator status:', err);
      setErrorMsg(err.message || 'Failed to fetch orchestrator status');
    } finally {
      setLoadingStatus(false);
    }
  }, [targetProject]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Handle Pause / Resume
  const handleTogglePause = async () => {
    if (!status) return;
    const isPaused = status.status === 'paused';
    setActionLoading(isPaused ? 'resume' : 'pause');
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      if (isPaused) {
        await orchestratorConfigApi.resumeOrchestrator(targetProject);
        setSuccessMsg('Orchestrator role resumed');
      } else {
        await orchestratorConfigApi.pauseOrchestrator(targetProject);
        setSuccessMsg('Orchestrator role paused');
      }
      await fetchStatus();
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || `Failed to ${isPaused ? 'resume' : 'pause'} orchestrator`);
    } finally {
      setActionLoading(null);
    }
  };

  // Handle Rotate
  const handleRotate = async () => {
    setActionLoading('rotate');
    setErrorMsg(null);
    setSuccessMsg(null);
    setShowRotateConfirm(false);
    try {
      const res = await orchestratorConfigApi.rotateOrchestrator({ reason: 'owner_request' }, targetProject);
      setSuccessMsg(`Orchestrator rotated to Generation ${res.generation || (status?.generation ? status.generation + 1 : '')}`);
      await fetchStatus();
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to rotate orchestrator');
    } finally {
      setActionLoading(null);
    }
  };

  // Open Reassign Dialog
  const handleOpenReassign = () => {
    const defaultTool = configData?.config?.routing?.default_orchestrator || status?.tool || 'claude';
    setReassignTool(defaultTool);
    const existingModel = configData?.config?.tools?.[defaultTool]?.profiles?.orchestration?.model || status?.model || '';
    setReassignModel(existingModel);
    setReassignScope(configData?.meta?.project_config_exists ? 'project' : 'global');
    setReassignPreview(null);
    setShowReassignModal(true);
  };

  // Preview Reassign Plan
  const handlePreviewReassign = async () => {
    setReassignLoading(true);
    setErrorMsg(null);
    try {
      const preview = await orchestratorConfigApi.previewOrchestratorReassign({
        tool: reassignTool,
        model: reassignModel.trim() || undefined,
        scope: reassignScope,
      }, targetProject);
      setReassignPreview(preview);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to preview reassignment');
    } finally {
      setReassignLoading(false);
    }
  };

  // Apply Reassign
  const handleApplyReassign = async () => {
    if (!reassignPreview?.plan_hash) return;
    setReassignLoading(true);
    setErrorMsg(null);
    try {
      const res = await orchestratorConfigApi.reassignOrchestrator({
        tool: reassignTool,
        model: reassignModel.trim() || undefined,
        scope: reassignScope,
        expect_hash: reassignPreview.plan_hash,
      }, targetProject);
      setShowReassignModal(false);
      setSuccessMsg(`Orchestrator successfully reassigned to ${res.tool || reassignTool} (Generation ${res.generation || ''})`);
      await fetchStatus();
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to apply reassignment');
    } finally {
      setReassignLoading(false);
    }
  };

  // Provenance calculation
  const configuredDefault = configData?.config?.routing?.default_orchestrator || 'claude';
  const hasProjectConfig = !!configData?.meta?.project_config_exists;
  const provenanceLabel = hasProjectConfig ? 'Project Override' : 'Global Default';
  const provenancePath = hasProjectConfig
    ? configData?.meta?.project_config_path
    : configData?.meta?.global_config_path;

  // Context tokens & threshold
  const rotateThreshold = status?.rotate_after_tokens || 150000;
  const currentContextTokens =
    status?.last_usage?.estimated_context_tokens ||
    status?.last_usage?.input_tokens ||
    0;
  const contextPercent = Math.min(100, Math.round((currentContextTokens / rotateThreshold) * 100));

  const isPaused = status?.status === 'paused';
  const isRotating = status?.status === 'rotating';

  return (
    <div
      data-testid="orchestrator-config-card"
      style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              padding: '0.45rem',
              borderRadius: '0.375rem',
              backgroundColor: '#312e81',
              color: '#818cf8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Bot size={20} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                Orchestrator Role
              </h2>
              {/* Status Badge */}
              <span
                data-testid="orchestrator-status-badge"
                style={{
                  fontSize: '0.72rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '0.25rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  backgroundColor: isPaused
                    ? '#451a03'
                    : isRotating
                    ? '#1e1b4b'
                    : '#064e3b',
                  color: isPaused
                    ? '#fbbf24'
                    : isRotating
                    ? '#a5b4fc'
                    : '#34d399',
                  border: `1px solid ${
                    isPaused ? '#f59e0b' : isRotating ? '#6366f1' : '#10b981'
                  }`,
                }}
              >
                {status?.status || (loadingStatus ? 'Loading...' : 'Unknown')}
              </span>
            </div>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0.2rem 0 0 0' }}>
              Persistent headless role coordinating event queues, task routing, and succession.
            </p>
          </div>
        </div>

        {/* Global actions / refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {onOpenSetupWizard && (
            <button
              onClick={onOpenSetupWizard}
              data-testid="open-setup-wizard-btn"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.35rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#cbd5e1',
                fontSize: '0.78rem',
                cursor: 'pointer',
              }}
            >
              <Layers size={13} />
              <span>Setup Wizard</span>
            </button>
          )}

          <button
            onClick={fetchStatus}
            disabled={loadingStatus}
            title="Refresh Status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '0.35rem 0.65rem',
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#94a3b8',
              fontSize: '0.78rem',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={13} className={loadingStatus ? 'spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Notifications / Alerts */}
      {errorMsg && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.6rem 0.8rem',
          borderRadius: '0.375rem',
          backgroundColor: '#451a1a',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          fontSize: '0.82rem',
        }}>
          <AlertCircle size={15} color="#ef4444" />
          <span>{errorMsg}</span>
        </div>
      )}
      {successMsg && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.6rem 0.8rem',
          borderRadius: '0.375rem',
          backgroundColor: '#064e3b',
          border: '1px solid #10b981',
          color: '#a7f3d0',
          fontSize: '0.82rem',
        }}>
          <CheckCircle2 size={15} color="#10b981" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Grid: Holder Info & Provenance */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.85rem' }}>
        {/* Holder Card */}
        <div
          data-testid="orchestrator-holder-details"
          style={{
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '0.375rem',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Current Role Holder
            </span>
            <span
              data-testid="orchestrator-generation-badge"
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: '#818cf8',
                backgroundColor: '#1e1b4b',
                padding: '0.1rem 0.45rem',
                borderRadius: '0.25rem',
                border: '1px solid #4338ca',
              }}
            >
              Generation {status?.generation ?? 1}
            </span>
          </div>

          {/* Tool & Model */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
            <span
              data-testid="orchestrator-tool-name"
              style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f8fafc', textTransform: 'capitalize' }}
            >
              {status?.tool || 'claude'}
            </span>
            {status?.model && (
              <span
                data-testid="orchestrator-model-name"
                style={{ fontSize: '0.85rem', color: '#818cf8', fontFamily: 'monospace' }}
              >
                ({status.model})
              </span>
            )}
          </div>

          {/* Session IDs */}
          <div style={{ fontSize: '0.75rem', color: '#64748b', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <div>
              Session ID:{' '}
              <span
                data-testid="orchestrator-session-id"
                style={{ fontFamily: 'monospace', color: '#cbd5e1' }}
              >
                {status?.session_id ? status.session_id.slice(0, 18) + '...' : 'none'}
              </span>
            </div>
            {status?.provider_session_id && (
              <div>
                Provider Session:{' '}
                <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>
                  {status.provider_session_id.slice(0, 18)}...
                </span>
              </div>
            )}
            <div>
              Turns completed:{' '}
              <strong style={{ color: '#cbd5e1' }}>{status?.turns ?? 0}</strong>
            </div>
          </div>

          {/* Context Usage Bar */}
          <div style={{ marginTop: '0.3rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
              <span>Context Usage</span>
              <span data-testid="orchestrator-context-tokens">
                {currentContextTokens.toLocaleString()} / {rotateThreshold.toLocaleString()} tokens ({contextPercent}%)
              </span>
            </div>
            <div style={{ height: '6px', backgroundColor: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${contextPercent}%`,
                  backgroundColor: contextPercent > 80 ? '#ef4444' : contextPercent > 60 ? '#f59e0b' : '#6366f1',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        </div>

        {/* Provenance Card */}
        <div
          data-testid="orchestrator-provenance-details"
          style={{
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '0.375rem',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Configured Default & Provenance
            </span>
            <span
              data-testid="orchestrator-provenance-badge"
              style={{
                fontSize: '0.72rem',
                fontWeight: 600,
                color: hasProjectConfig ? '#34d399' : '#93c5fd',
                backgroundColor: hasProjectConfig ? '#064e3b' : '#1e3a8a',
                padding: '0.1rem 0.45rem',
                borderRadius: '0.25rem',
                border: `1px solid ${hasProjectConfig ? '#10b981' : '#3b82f6'}`,
              }}
            >
              {provenanceLabel}
            </span>
          </div>

          <div>
            <div style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
              Default Orchestrator:{' '}
              <strong style={{ color: '#f8fafc', textTransform: 'capitalize' }}>
                {configuredDefault}
              </strong>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              Source: {provenancePath || '(not configured)'}
            </div>
          </div>

          {/* Prominent Claude note required by spec */}
          <div
            data-testid="claude-default-note"
            style={{
              padding: '0.5rem 0.65rem',
              backgroundColor: '#1e1b4b',
              border: '1px solid #4338ca',
              borderRadius: '0.375rem',
              fontSize: '0.75rem',
              color: '#c7d2fe',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <Shield size={14} color="#818cf8" style={{ flexShrink: 0 }} />
            <span>
              <strong>Note:</strong> Claude is the global default orchestrator across workspaces.
            </span>
          </div>

          {status?.tool && status.tool !== configuredDefault && (
            <div style={{ fontSize: '0.74rem', color: '#fbbf24', fontStyle: 'italic' }}>
              * Role holder ({status.tool}) differs from configured routing default ({configuredDefault}) due to succession or manual rotation.
            </div>
          )}
        </div>
      </div>

      {/* Actions Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', paddingTop: '0.25rem' }}>
        {/* Pause / Resume Button */}
        <button
          onClick={handleTogglePause}
          disabled={actionLoading !== null}
          data-testid="orchestrator-pause-resume-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.45rem 0.9rem',
            backgroundColor: isPaused ? '#065f46' : '#854d0e',
            border: 'none',
            borderRadius: '0.375rem',
            color: '#fff',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {actionLoading === 'pause' || actionLoading === 'resume' ? (
            <Loader2 size={14} className="spin" />
          ) : isPaused ? (
            <Play size={14} />
          ) : (
            <Pause size={14} />
          )}
          <span>{isPaused ? 'Resume Orchestrator' : 'Pause Orchestrator'}</span>
        </button>

        {/* Rotate Button */}
        <button
          onClick={() => setShowRotateConfirm(true)}
          disabled={actionLoading !== null}
          data-testid="orchestrator-rotate-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.45rem 0.9rem',
            backgroundColor: '#334155',
            border: '1px solid #475569',
            borderRadius: '0.375rem',
            color: '#e2e8f0',
            fontSize: '0.82rem',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {actionLoading === 'rotate' ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>Rotate Session…</span>
        </button>

        {/* Reassign Button */}
        <button
          onClick={handleOpenReassign}
          disabled={actionLoading !== null}
          data-testid="orchestrator-reassign-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.45rem 0.95rem',
            backgroundColor: '#4f46e5',
            border: 'none',
            borderRadius: '0.375rem',
            color: '#fff',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <ArrowRightLeft size={14} />
          <span>Reassign…</span>
        </button>
      </div>

      {/* Confirmation Dialog for Rotate */}
      {showRotateConfirm && (
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
          padding: '1rem',
        }}>
          <div style={{
            backgroundColor: '#1e293b',
            border: '1px solid #475569',
            borderRadius: '0.5rem',
            width: '100%',
            maxWidth: '480px',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                Confirm Session Rotation
              </h3>
              <button
                onClick={() => setShowRotateConfirm(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: '0.85rem', color: '#cbd5e1', lineHeight: 1.5, margin: 0 }}>
              Rotate orchestrator role to <strong>Generation {(status?.generation || 1) + 1}</strong>?
              The active session will be retired, and a handoff turn will transition the event queue and role cursor safely.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                onClick={() => setShowRotateConfirm(false)}
                style={{
                  padding: '0.4rem 0.8rem',
                  backgroundColor: '#334155',
                  border: 'none',
                  borderRadius: '0.375rem',
                  color: '#cbd5e1',
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleRotate}
                data-testid="confirm-rotate-btn"
                style={{
                  padding: '0.4rem 0.9rem',
                  backgroundColor: '#4f46e5',
                  border: 'none',
                  borderRadius: '0.375rem',
                  color: '#fff',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Confirm Rotation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reassign Modal */}
      {showReassignModal && (
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
          padding: '1rem',
        }}>
          <div style={{
            backgroundColor: '#1e293b',
            border: '1px solid #475569',
            borderRadius: '0.5rem',
            width: '100%',
            maxWidth: '650px',
            maxHeight: '90vh',
            overflowY: 'auto',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}>
            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ArrowRightLeft size={18} color="#818cf8" />
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                  Reassign Orchestrator Role
                </h3>
              </div>
              <button
                onClick={() => setShowReassignModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: 0 }}>
              Reassign the orchestrator role via fenced succession. Preview the plan and config diff before applying with the plan hash.
            </p>

            {/* Tool & Model Selection Form */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {/* Tool Picker */}
              <div>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                  Target Orchestrator Tool
                </label>
                <select
                  data-testid="reassign-tool-select"
                  value={reassignTool}
                  onChange={(e) => {
                    const nextTool = e.target.value;
                    setReassignTool(nextTool);
                    // Propose default model for that tool
                    if (nextTool === 'claude') setReassignModel('sonnet');
                    else if (nextTool === 'kilo') setReassignModel('google/gemini-4-argon');
                    else if (nextTool === 'codex') setReassignModel('gpt-5-codex');
                    setReassignPreview(null);
                  }}
                  style={{
                    width: '100%',
                    padding: '0.45rem 0.6rem',
                    backgroundColor: '#0f172a',
                    border: '1px solid #475569',
                    borderRadius: '0.375rem',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                  }}
                >
                  <option value="claude">Claude Code (global default)</option>
                  <option value="kilo">Kilo CLI</option>
                  <option value="codex">Codex CLI</option>
                </select>
              </div>

              {/* Model Picker */}
              <div>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                  Model Override (optional)
                </label>
                <input
                  data-testid="reassign-model-input"
                  type="text"
                  placeholder={reassignTool === 'kilo' ? 'google/gemini-4-argon' : reassignTool === 'claude' ? 'sonnet' : 'gpt-5-codex'}
                  value={reassignModel}
                  onChange={(e) => {
                    setReassignModel(e.target.value);
                    setReassignPreview(null);
                  }}
                  style={{
                    width: '100%',
                    padding: '0.45rem 0.6rem',
                    backgroundColor: '#0f172a',
                    border: '1px solid #475569',
                    borderRadius: '0.375rem',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    fontFamily: 'monospace',
                  }}
                />
              </div>
            </div>

            {/* Scope Selection */}
            <div>
              <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                Configuration Scope
              </label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: '#e2e8f0', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="reassignScope"
                    value="project"
                    checked={reassignScope === 'project'}
                    onChange={() => {
                      setReassignScope('project');
                      setReassignPreview(null);
                    }}
                  />
                  <span>Project Scope (Repository override)</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: '#e2e8f0', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="reassignScope"
                    value="global"
                    checked={reassignScope === 'global'}
                    onChange={() => {
                      setReassignScope('global');
                      setReassignPreview(null);
                    }}
                  />
                  <span>Global Scope (Machine-wide)</span>
                </label>
              </div>
            </div>

            {/* Preview Button */}
            <div>
              <button
                onClick={handlePreviewReassign}
                disabled={reassignLoading}
                data-testid="reassign-preview-btn"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.45rem 0.9rem',
                  backgroundColor: '#312e81',
                  border: '1px solid #4338ca',
                  borderRadius: '0.375rem',
                  color: '#e0e7ff',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {reassignLoading ? <Loader2 size={14} className="spin" /> : <FileCode size={14} />}
                <span>Preview Reassign Plan</span>
              </button>
            </div>

            {/* Preview Output */}
            {reassignPreview && (
              <div
                data-testid="reassign-preview-container"
                style={{
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  padding: '0.85rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.6rem',
                }}
              >
                <div style={{ fontSize: '0.82rem', color: '#f8fafc' }}>
                  <strong>Plan:</strong>{' '}
                  <span data-testid="reassign-plan-text" style={{ color: '#818cf8' }}>
                    {reassignPreview.plan || `${reassignPreview.from_tool} → ${reassignPreview.to_tool}`}
                  </span>
                </div>

                <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                  Plan Hash:{' '}
                  <code data-testid="reassign-plan-hash" style={{ color: '#cbd5e1' }}>
                    {reassignPreview.plan_hash}
                  </code>
                </div>

                {reassignPreview.diff ? (
                  <div>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.2rem' }}>
                      Configuration Diff ({reassignPreview.path}):
                    </div>
                    <pre
                      data-testid="reassign-diff"
                      style={{
                        margin: 0,
                        padding: '0.6rem',
                        backgroundColor: '#020617',
                        border: '1px solid #1e293b',
                        borderRadius: '0.25rem',
                        color: '#a7f3d0',
                        fontSize: '0.72rem',
                        fontFamily: 'monospace',
                        overflowX: 'auto',
                        maxHeight: '180px',
                      }}
                    >
                      {reassignPreview.diff}
                    </pre>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                    (No config file changes required; succession only)
                  </div>
                )}
              </div>
            )}

            {/* Modal Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                onClick={() => setShowReassignModal(false)}
                style={{
                  padding: '0.45rem 0.9rem',
                  backgroundColor: '#334155',
                  border: 'none',
                  borderRadius: '0.375rem',
                  color: '#cbd5e1',
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>

              <button
                onClick={handleApplyReassign}
                disabled={!reassignPreview || reassignLoading}
                data-testid="reassign-apply-btn"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.45rem 1rem',
                  backgroundColor: !reassignPreview || reassignLoading ? '#312e81' : '#4f46e5',
                  border: 'none',
                  borderRadius: '0.375rem',
                  color: '#fff',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: !reassignPreview || reassignLoading ? 'not-allowed' : 'pointer',
                  opacity: !reassignPreview ? 0.6 : 1,
                }}
              >
                {reassignLoading && <Loader2 size={14} className="spin" />}
                <span>Apply Reassignment</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
