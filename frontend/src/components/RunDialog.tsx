import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Play,
  Loader2,
  AlertTriangle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Terminal,
  Copy,
  Check,
  ShieldAlert,
} from 'lucide-react';
import {
  TaskItem,
  RunOptionsResponse,
  RunPreviewResponse,
  RunPreviewPayload,
} from '../types';
import { api } from '../api';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';

interface RunDialogProps {
  isOpen: boolean;
  task?: TaskItem;
  note?: { id: string; title: string; bundle_sha256?: string; [key: string]: any };
  onClose: () => void;
  onRunStarted: (runId: string) => void;
}

export const RunDialog: React.FC<RunDialogProps> = ({
  isOpen,
  task,
  note,
  onClose,
  onRunStarted,
}) => {
  const targetId = note?.id || task?.id || '';
  const targetTitle = note?.title || task?.title || '';
  const isNote = Boolean(note?.id);

  const [loadingOptions, setLoadingOptions] = useState(false);
  const [options, setOptions] = useState<RunOptionsResponse | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Form fields
  const [mode, setMode] = useState<string>('execute');
  const [tool, setTool] = useState<string>('kilo');
  const [profile, setProfile] = useState<string>('bulk-execution');
  const [model, setModel] = useState<string>('');
  const [variant, setVariant] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [isolation, setIsolation] = useState<string>('worktree');
  const [targetRun, setTargetRun] = useState<string>('none');
  const [instructions, setInstructions] = useState<string>('');
  const [allowSameTool, setAllowSameTool] = useState<boolean>(false);
  const [allowDirtyBase, setAllowDirtyBase] = useState<boolean>(false);

  // Preview state
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [preview, setPreview] = useState<RunPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [promptExpanded, setPromptExpanded] = useState<boolean>(false);
  const [copiedArgv, setCopiedArgv] = useState<boolean>(false);

  // Confirmation state
  const [isConfirmOpen, setIsConfirmOpen] = useState<boolean>(false);

  const debounceTimerRef = useRef<any>(null);

  // Load options when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    loadOptions();
  }, [isOpen, task?.id, note?.id]);

  const loadOptions = async () => {
    setLoadingOptions(true);
    setOptionsError(null);
    try {
      const res = await api.getRunOptions(isNote ? { note: note!.id } : { task: task!.id });
      setOptions(res);

      // Initialize form with defaults
      const defMode = res.default_mode || (res.allowed_modes && res.allowed_modes[0]) || 'execute';
      setMode(defMode);

      const modeDefaults = res.resolved_defaults?.[defMode];
      if (modeDefaults) {
        setTool(modeDefaults.tool || 'kilo');
        setProfile(modeDefaults.profile || 'bulk-execution');
        setModel(modeDefaults.model || '');
        setVariant(modeDefaults.variant || '');
        setEffort(modeDefaults.effort || '');
        if (modeDefaults.isolation) {
          setIsolation(modeDefaults.isolation);
        }
        if (modeDefaults.target_run) {
          setTargetRun(modeDefaults.target_run);
        }
      } else {
        // Fallback tool
        const availTools = Object.entries(res.tools || {}).filter(([_, st]) => st.available);
        if (availTools.length > 0) {
          setTool(availTools[0][0]);
        }
      }
    } catch (e: any) {
      setOptionsError(e?.data?.error || e?.message || String(e));
    } finally {
      setLoadingOptions(false);
    }
  };

  // When mode changes, apply mode defaults
  const handleModeChange = (newMode: string) => {
    setMode(newMode);
    if (options && options.resolved_defaults?.[newMode]) {
      const d = options.resolved_defaults[newMode];
      if (d.tool) setTool(d.tool);
      if (d.profile) setProfile(d.profile);
      setModel(d.model || '');
      setVariant(d.variant || '');
      setEffort(d.effort || '');
      if (d.isolation) setIsolation(d.isolation);
      if (d.target_run) setTargetRun(d.target_run);
    }
  };

  // When tool or profile changes, update model/variant/effort if available
  const handleToolChange = (newTool: string) => {
    setTool(newTool);
    if (options && options.models_per_profile?.[newTool]?.[profile]) {
      const p = options.models_per_profile[newTool][profile];
      setModel(p.model || '');
      setVariant(p.variant || '');
      setEffort(p.effort || '');
    }
  };

  const handleProfileChange = (newProfile: string) => {
    setProfile(newProfile);
    if (options && options.models_per_profile?.[tool]?.[newProfile]) {
      const p = options.models_per_profile[tool][newProfile];
      setModel(p.model || '');
      setVariant(p.variant || '');
      setEffort(p.effort || '');
    }
  };

  // Debounced preview execution
  const fetchPreview = useCallback(async (customPayload?: RunPreviewPayload): Promise<RunPreviewResponse> => {
    const payload: RunPreviewPayload = customPayload || {
      ...(isNote ? { note: note!.id } : { task: task?.id }),
      mode,
      tool,
      profile,
      model: model.trim() || undefined,
      variant: variant.trim() || undefined,
      effort: effort.trim() || undefined,
      isolation: mode === 'execute' ? isolation : undefined,
      target_run: mode === 'verify' && targetRun !== 'none' ? targetRun : undefined,
      instructions: instructions.trim() || undefined,
      allow_same_tool: allowSameTool || undefined,
      allow_dirty_base: allowDirtyBase || undefined,
    };

    return await api.previewRun(payload);
  }, [task?.id, note?.id, isNote, mode, tool, profile, model, variant, effort, isolation, targetRun, instructions, allowSameTool, allowDirtyBase]);

  useEffect(() => {
    if (!isOpen || !options) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    setPreviewLoading(true);
    setPreviewError(null);

    debounceTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetchPreview();
        setPreview(res);
        setPreviewError(null);
      } catch (err: any) {
        const msg = err?.data?.error || err?.message || String(err);
        setPreview(null);
        setPreviewError(msg);
      } finally {
        setPreviewLoading(false);
      }
    }, 250);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [isOpen, options, mode, tool, profile, model, variant, effort, isolation, targetRun, instructions, allowSameTool, allowDirtyBase, fetchPreview]);

  if (!isOpen) return null;

  const handleCopyArgv = () => {
    if (!preview?.argv_display) return;
    navigator.clipboard.writeText(preview.argv_display.join(' '));
    setCopiedArgv(true);
    setTimeout(() => setCopiedArgv(false), 2000);
  };

  const handleLaunchClick = () => {
    if (!preview || !preview.plan_hash) return;
    setIsConfirmOpen(true);
  };

  const handleApplyLaunch = async (hash?: string) => {
    const planHash = hash || preview?.plan_hash;
    if (!planHash) {
      throw new Error('No plan hash available for launch');
    }

    const payload = {
      ...(isNote ? { note: note!.id } : { task: task?.id }),
      mode,
      tool,
      profile,
      model: model.trim() || undefined,
      variant: variant.trim() || undefined,
      effort: effort.trim() || undefined,
      isolation: mode === 'execute' ? isolation : undefined,
      target_run: mode === 'verify' && targetRun !== 'none' ? targetRun : undefined,
      instructions: instructions.trim() || undefined,
      allow_same_tool: allowSameTool || undefined,
      allow_dirty_base: allowDirtyBase || undefined,
      expect_plan_hash: planHash,
    };

    try {
      const res = await api.startRun(payload);
      if (res && res.run_id) {
        setIsConfirmOpen(false);
        onRunStarted(res.run_id);
        onClose();
      }
    } catch (err: any) {
      const msg = err?.data?.error || err?.message || String(err);
      if (err.status === 409 || msg.includes('409') || msg.toLowerCase().includes('plan hash mismatch')) {
        throw new Error('Plan changed, re-preview required (409)');
      }
      if (
        msg.includes('Claude needs an allow-list') ||
        msg.includes('allowed_tools') ||
        msg.includes('Q001')
      ) {
        throw new Error('Claude needs an allow-list — see Q001');
      }
      throw err;
    }
  };

  const handleRefetchPreview = async (): Promise<ConfirmDialogPreviewData> => {
    const updated = await fetchPreview();
    setPreview(updated);
    return {
      summary: `Launch ${mode} run for ${targetId} with ${tool} (${profile})`,
      hash: updated.plan_hash,
      warnings: updated.warnings,
      diff: [
        `Command:\n${updated.argv_display.join(' ')}`,
        `Working directory: ${updated.cwd}`,
        updated.planned_worktree ? `Worktree: ${updated.planned_worktree}` : '',
        updated.planned_branch ? `Branch: ${updated.planned_branch}` : '',
      ].filter(Boolean).join('\n\n'),
    };
  };

  const isDangerousWarning = (w: string) => {
    const lower = w.toLowerCase();
    return (
      lower.includes('bypasspermissions') ||
      lower.includes('dangerously') ||
      lower.includes('bypass') ||
      lower.includes('danger')
    );
  };

  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 999,
          padding: '1.5rem',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          style={{
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            width: '100%',
            maxWidth: '780px',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid #334155',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <Play size={20} color="#818cf8" />
              <div>
                <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                  {isNote ? 'Triage Note: ' : 'Run Task: '}<span style={{ color: '#818cf8' }}>{targetId}</span>
                </h2>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                  {targetTitle}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '0.25rem',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={20} />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '1.25rem', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {loadingOptions ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3rem', gap: '0.5rem', color: '#94a3b8' }}>
                <Loader2 size={20} className="spin" />
                <span>Loading run options...</span>
              </div>
            ) : optionsError ? (
              <div
                style={{
                  padding: '1rem',
                  backgroundColor: '#451a1a',
                  border: '1px solid #ef4444',
                  borderRadius: '0.375rem',
                  color: '#fca5a5',
                  fontSize: '0.875rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
                  <AlertCircle size={16} />
                  <span>Failed to load run options</span>
                </div>
                <div style={{ marginTop: '0.4rem' }}>{optionsError}</div>
                <button
                  onClick={loadOptions}
                  style={{
                    marginTop: '0.75rem',
                    padding: '0.35rem 0.75rem',
                    backgroundColor: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '0.25rem',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : options ? (
              <>
                {/* Form Row 1: Mode & Tool */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                      Mode
                    </label>
                    <select
                      value={mode}
                      onChange={(e) => handleModeChange(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #334155',
                        backgroundColor: '#0f172a',
                        color: '#f8fafc',
                        fontSize: '0.875rem',
                      }}
                    >
                      {(options.allowed_modes || ['execute', 'orchestrate']).map((m) => (
                        <option key={m} value={m}>
                          {m.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                      Tool
                    </label>
                    <select
                      value={tool}
                      onChange={(e) => handleToolChange(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #334155',
                        backgroundColor: '#0f172a',
                        color: '#f8fafc',
                        fontSize: '0.875rem',
                      }}
                    >
                      {Object.entries(options.tools || {}).map(([tName, tStatus]) => {
                        const isAvail = tStatus.available;
                        const label = isAvail
                          ? `${tName}${tStatus.version ? ` (v${tStatus.version})` : ''}`
                          : `${tName} — disabled (${tStatus.reason || 'not available'})`;
                        return (
                          <option key={tName} value={tName} disabled={!isAvail}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </div>

                {/* Form Row 2: Profile & Model */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                      Profile
                    </label>
                    <select
                      value={profile}
                      onChange={(e) => handleProfileChange(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #334155',
                        backgroundColor: '#0f172a',
                        color: '#f8fafc',
                        fontSize: '0.875rem',
                      }}
                    >
                      <option value="deep-reasoning">deep-reasoning</option>
                      <option value="orchestration">orchestration</option>
                      <option value="bulk-execution">bulk-execution</option>
                      <option value="exploration">exploration</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                      Model
                    </label>
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="e.g. gpt-4o, claude-3-7-sonnet"
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #334155',
                        backgroundColor: '#0f172a',
                        color: '#f8fafc',
                        fontSize: '0.875rem',
                      }}
                    />
                  </div>
                </div>

                {/* Form Row 3: Variant/Effort and Mode-specific options */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                      Variant / Effort
                    </label>
                    <input
                      type="text"
                      value={effort || variant}
                      onChange={(e) => {
                        setEffort(e.target.value);
                        setVariant(e.target.value);
                      }}
                      placeholder="e.g. high, medium, low, default"
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #334155',
                        backgroundColor: '#0f172a',
                        color: '#f8fafc',
                        fontSize: '0.875rem',
                      }}
                    />
                  </div>

                  {mode === 'execute' && (
                    <div>
                      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                        Isolation
                      </label>
                      <select
                        value={isolation}
                        onChange={(e) => setIsolation(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.5rem 0.75rem',
                          borderRadius: '0.375rem',
                          border: '1px solid #334155',
                          backgroundColor: '#0f172a',
                          color: '#f8fafc',
                          fontSize: '0.875rem',
                        }}
                      >
                        <option value="worktree">Isolated Git Worktree (safe)</option>
                        <option value="none">In-place / None (workspace directory)</option>
                      </select>
                    </div>
                  )}

                  {mode === 'verify' && (
                    <div>
                      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                        Target Run to Verify
                      </label>
                      <select
                        value={targetRun}
                        onChange={(e) => setTargetRun(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.5rem 0.75rem',
                          borderRadius: '0.375rem',
                          border: '1px solid #334155',
                          backgroundColor: '#0f172a',
                          color: '#f8fafc',
                          fontSize: '0.875rem',
                        }}
                      >
                        <option value="none">none (verify HEAD/workspace)</option>
                        {(options.usable_verify_targets || []).map((vt) => (
                          <option key={vt.run_id} value={vt.run_id}>
                            {vt.run_id} ({vt.tool}, {vt.final_commit ? vt.final_commit.slice(0, 7) : 'commit'})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Optional Flags */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '-0.25rem' }}>
                  {mode === 'verify' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input
                        type="checkbox"
                        id="allowSameTool"
                        checked={allowSameTool}
                        onChange={(e) => setAllowSameTool(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <label htmlFor="allowSameTool" style={{ fontSize: '0.8rem', color: '#94a3b8', cursor: 'pointer' }}>
                        Allow same tool as executor (downgrades to independent-session)
                      </label>
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      id="allowDirtyBase"
                      checked={allowDirtyBase}
                      onChange={(e) => setAllowDirtyBase(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    <label htmlFor="allowDirtyBase" style={{ fontSize: '0.8rem', color: '#94a3b8', cursor: 'pointer' }}>
                      Allow dirty base repository
                    </label>
                  </div>
                </div>

                {/* Instructions */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
                    Additional Instructions <span style={{ fontWeight: 400, color: '#64748b' }}>(optional)</span>
                  </label>
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={2}
                    placeholder="Provide additional guidance or focus areas for the agent..."
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #334155',
                      backgroundColor: '#0f172a',
                      color: '#f8fafc',
                      fontSize: '0.875rem',
                      resize: 'vertical',
                    }}
                  />
                </div>

                {/* Live Preview Section */}
                <div
                  style={{
                    marginTop: '0.5rem',
                    border: '1px solid #334155',
                    borderRadius: '0.375rem',
                    backgroundColor: '#0f172a',
                    padding: '0.85rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: 600, color: '#cbd5e1' }}>
                      <Terminal size={15} color="#818cf8" />
                      <span>Live Launch Preview</span>
                    </div>
                    {previewLoading && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                        <Loader2 size={13} className="spin" />
                        <span>Updating preview...</span>
                      </div>
                    )}
                  </div>

                  {previewError && (
                    <div
                      style={{
                        padding: '0.65rem 0.85rem',
                        backgroundColor: '#451a1a',
                        border: '1px solid #ef4444',
                        borderRadius: '0.375rem',
                        color: '#fca5a5',
                        fontSize: '0.8rem',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
                        <AlertCircle size={15} />
                        <span>Preview Refused / Error</span>
                      </div>
                      <div style={{ marginTop: '0.25rem' }}>{previewError}</div>
                      {previewError.includes('Claude needs an allow-list') && (
                        <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: '#f87171' }}>
                          Notice: Headless Claude requires an explicit tool allow-list for safety. See Question Q001 in Decisions.
                        </div>
                      )}
                    </div>
                  )}

                  {preview && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                      {/* Warnings */}
                      {preview.warnings && preview.warnings.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                          {preview.warnings.map((w, idx) => {
                            const dangerous = isDangerousWarning(w);
                            return (
                              <div
                                key={idx}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.4rem',
                                  padding: '0.45rem 0.65rem',
                                  borderRadius: '0.25rem',
                                  backgroundColor: dangerous ? '#451a1a' : 'rgba(245, 158, 11, 0.1)',
                                  border: `1px solid ${dangerous ? '#ef4444' : '#f59e0b'}`,
                                  color: dangerous ? '#fca5a5' : '#fde68a',
                                  fontSize: '0.75rem',
                                  fontWeight: dangerous ? 600 : 400,
                                }}
                              >
                                {dangerous ? <ShieldAlert size={14} color="#ef4444" /> : <AlertTriangle size={14} color="#f59e0b" />}
                                <span>{w}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Command Line */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                          <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>COMMAND LINE</span>
                          <button
                            onClick={handleCopyArgv}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: copiedArgv ? '#10b981' : '#94a3b8',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.2rem',
                              fontSize: '0.7rem',
                            }}
                          >
                            {copiedArgv ? <Check size={12} /> : <Copy size={12} />}
                            <span>{copiedArgv ? 'Copied' : 'Copy'}</span>
                          </button>
                        </div>
                        <div
                          style={{
                            padding: '0.5rem 0.65rem',
                            backgroundColor: '#020617',
                            border: '1px solid #1e293b',
                            borderRadius: '0.25rem',
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            color: '#38bdf8',
                            overflowX: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {preview.argv_display.join(' ')}
                        </div>
                      </div>

                      {/* CWD and planned worktree */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.75rem' }}>
                        <div>
                          <span style={{ color: '#64748b' }}>Working Dir: </span>
                          <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{preview.cwd}</span>
                        </div>
                        {preview.planned_worktree && (
                          <div>
                            <span style={{ color: '#64748b' }}>Worktree: </span>
                            <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{preview.planned_worktree}</span>
                          </div>
                        )}
                        {preview.planned_branch && (
                          <div>
                            <span style={{ color: '#64748b' }}>Branch: </span>
                            <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{preview.planned_branch}</span>
                          </div>
                        )}
                        <div>
                          <span style={{ color: '#64748b' }}>Plan Hash: </span>
                          <span style={{ color: '#64748b', fontFamily: 'monospace' }}>{preview.plan_hash.slice(0, 16)}…</span>
                        </div>
                      </div>

                      {/* Prompt collapsible */}
                      <div style={{ marginTop: '0.25rem', borderTop: '1px solid #1e293b', paddingTop: '0.5rem' }}>
                        <button
                          onClick={() => setPromptExpanded(!promptExpanded)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#818cf8',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            padding: 0,
                          }}
                        >
                          {promptExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span>Task Prompt ({preview.prompt.length} chars)</span>
                        </button>
                        {promptExpanded && (
                          <div
                            style={{
                              marginTop: '0.4rem',
                              padding: '0.65rem',
                              backgroundColor: '#020617',
                              borderRadius: '0.25rem',
                              border: '1px solid #1e293b',
                              maxHeight: '180px',
                              overflowY: 'auto',
                              fontSize: '0.75rem',
                              fontFamily: 'monospace',
                              color: '#cbd5e1',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {preview.prompt}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '0.85rem 1.25rem',
              borderTop: '1px solid #334155',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: '#1e293b',
              borderRadius: '0 0 0.5rem 0.5rem',
            }}
          >
            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
              {preview?.plan_hash ? (
                <span>Ready to launch with plan hash <code style={{ color: '#94a3b8' }}>{preview.plan_hash.slice(0, 8)}</code></span>
              ) : (
                <span>Configure run parameters to preview</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={onClose}
                style={{
                  padding: '0.45rem 0.9rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #475569',
                  backgroundColor: 'transparent',
                  color: '#cbd5e1',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>

              <button
                onClick={handleLaunchClick}
                disabled={loadingOptions || previewLoading || !preview || !preview.plan_hash}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.45rem 1rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: loadingOptions || previewLoading || !preview || !preview.plan_hash ? '#475569' : '#4f46e5',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: loadingOptions || previewLoading || !preview || !preview.plan_hash ? 'not-allowed' : 'pointer',
                }}
              >
                {previewLoading ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
                <span>Launch Run</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog before starting run */}
      {isConfirmOpen && preview && (
        <ConfirmDialog
          isOpen={true}
          title={`Launch ${mode.toUpperCase()} Run for ${targetId}`}
          summary={`Starting ${tool} (${profile}) model: ${model || 'default'}${mode === 'execute' ? ` with ${isolation} isolation` : ''}`}
          hash={preview.plan_hash}
          warnings={preview.warnings}
          diff={[
            `Command:\n${preview.argv_display.join(' ')}`,
            `Working directory:\n${preview.cwd}`,
            preview.planned_worktree ? `Worktree: ${preview.planned_worktree}` : '',
            preview.planned_branch ? `Branch: ${preview.planned_branch}` : '',
          ].filter(Boolean).join('\n\n')}
          applyButtonText="Confirm & Launch Run"
          cancelButtonText="Cancel"
          onApply={handleApplyLaunch}
          onCancel={() => setIsConfirmOpen(false)}
          onRefetchPreview={handleRefetchPreview}
        />
      )}
    </>
  );
};
