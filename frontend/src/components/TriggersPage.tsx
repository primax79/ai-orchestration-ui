import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Zap,
  Shield,
  ShieldAlert,
  Play,
  Clock,
  ChevronDown,
  ChevronRight,
  Lock,
  Check,
  XCircle,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import {
  TriggersListResponse,
  TriggersStatusResponse,
  TriggerFiring,
  ProposedAction,
} from '../types';
import { api, proposedActionsApi } from '../api';
import { ConfirmDialog } from './ConfirmDialog';

interface TriggersPageProps {
  onNavigateTab?: (tab: string) => void;
}

export const TriggersPage: React.FC<TriggersPageProps> = ({ onNavigateTab: _onNavigateTab }) => {
  const [triggersData, setTriggersData] = useState<TriggersListResponse | null>(null);
  const [statusData, setStatusData] = useState<TriggersStatusResponse | null>(null);
  const [history, setHistory] = useState<TriggerFiring[]>([]);
  const [proposedActions, setProposedActions] = useState<ProposedAction[]>([]);
  const [, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [expandedFiringId, setExpandedFiringId] = useState<string | null>(null);
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null);
  const [confirmProposal, setConfirmProposal] = useState<ProposedAction | null>(null);
  const [rejectProposal, setRejectProposal] = useState<ProposedAction | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [proposalActionStatus, setProposalActionStatus] = useState<Record<string, { loading?: boolean; error?: string; success?: string }>>({});

  // Toggle Confirm Dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    diff?: string;
    expectHash?: string;
    targetPath?: string;
    pendingToggle?: {
      rule_name?: string;
      kill_switch?: boolean;
      enabled: boolean;
    };
  }>({
    open: false,
    title: '',
    description: '',
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [trigs, status, hist, props] = await Promise.all([
        api.getTriggers(),
        api.getTriggersStatus(),
        api.getTriggersHistory({ limit: 30 }),
        api.getProposedActions(),
      ]);
      setTriggersData(trigs);
      setStatusData(status);
      setHistory(hist.firings || []);
      setProposedActions(props.proposed_actions || []);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const handleConfirmProposal = async () => {
    if (!confirmProposal) return;
    const act = confirmProposal;
    setProposalActionStatus((prev) => ({
      ...prev,
      [act.action_id]: { loading: true },
    }));
    try {
      const res = await proposedActionsApi.confirmProposedAction(act.action_id, {
        expect_hash: act.action_hash,
      });
      setProposalActionStatus((prev) => ({
        ...prev,
        [act.action_id]: {
          loading: false,
          success: res.message || 'Action confirmed and executed successfully',
        },
      }));
      setConfirmProposal(null);
      const propRes = await api.getProposedActions();
      setProposedActions(propRes.proposed_actions || []);
    } catch (err: any) {
      setProposalActionStatus((prev) => ({
        ...prev,
        [act.action_id]: {
          loading: false,
          error: err.message || 'Failed to confirm action',
        },
      }));
      setConfirmProposal(null);
    }
  };

  const handleRejectProposal = async () => {
    if (!rejectProposal || !rejectReason.trim()) return;
    const act = rejectProposal;
    setProposalActionStatus((prev) => ({
      ...prev,
      [act.action_id]: { loading: true },
    }));
    try {
      const res = await proposedActionsApi.rejectProposedAction(act.action_id, {
        reason: rejectReason.trim(),
      });
      setProposalActionStatus((prev) => ({
        ...prev,
        [act.action_id]: {
          loading: false,
          success: res.message || 'Action rejected',
        },
      }));
      setRejectProposal(null);
      setRejectReason('');
      const propRes = await api.getProposedActions();
      setProposedActions(propRes.proposed_actions || []);
    } catch (err: any) {
      setProposalActionStatus((prev) => ({
        ...prev,
        [act.action_id]: {
          loading: false,
          error: err.message || 'Failed to reject action',
        },
      }));
      setRejectProposal(null);
    }
  };

  const pendingCount = useMemo(
    () => proposedActions.filter((a) => a.status === 'pending' || a.status === 'pending_confirmation').length,
    [proposedActions]
  );

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 6000);
    return () => clearInterval(interval);
  }, [loadAll]);

  // Handle toggling kill switch or a rule
  const initiateToggle = async (options: {
    rule_name?: string;
    kill_switch?: boolean;
    enabled: boolean;
  }) => {
    setActionLoading(true);
    try {
      const previewRes = await api.previewToggleTrigger(options);
      const isKillSwitch = options.kill_switch !== undefined;
      const targetName = isKillSwitch
        ? 'Global Triggers Kill Switch'
        : `Trigger Rule '${options.rule_name}'`;

      setConfirmDialog({
        open: true,
        title: `Confirm Toggle: ${targetName}`,
        description: `Are you sure you want to ${
          options.enabled ? 'enable' : 'disable'
        } ${targetName}? This modifies the configuration file.`,
        diff: previewRes.diff || 'No text diff available (already matches desired state).',
        expectHash: previewRes.hash,
        targetPath: previewRes.path,
        pendingToggle: options,
      });
    } catch (e: any) {
      alert(`Failed to preview toggle: ${e.message || String(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleApplyToggle = async () => {
    if (!confirmDialog.pendingToggle || !confirmDialog.expectHash) return;
    setActionLoading(true);
    try {
      await api.toggleTrigger({
        ...confirmDialog.pendingToggle,
        expect_hash: confirmDialog.expectHash,
      });
      setConfirmDialog((prev) => ({ ...prev, open: false }));
      await loadAll();
    } catch (e: any) {
      alert(`Failed to toggle: ${e.message || String(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRunOnce = async (dryRun = false) => {
    setActionLoading(true);
    try {
      const res = await api.runTriggersOnce({ dry_run: dryRun });
      alert(
        `Triggers run-once complete:\nStatus: ${res.status || 'ok'}\nEvents processed: ${
          res.events_processed ?? res.count ?? 0
        }`
      );
      await loadAll();
    } catch (e: any) {
      alert(`Run-once failed: ${e.message || String(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const isKillSwitchEnabled = triggersData?.meta?.kill_switch_enabled ?? true;

  const formatAge = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diffSec < 60) return `${diffSec}s ago`;
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return `${Math.floor(diffSec / 86400)}d ago`;
    } catch {
      return '';
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 3.75rem)',
        backgroundColor: '#0f172a',
        color: '#f8fafc',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: '1.5rem 2rem',
        gap: '1.5rem',
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Zap size={24} color="#f472b6" />
            <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>
              Triggers & Event Automations
            </h1>
          </div>
          <p style={{ margin: '0.3rem 0 0 0', color: '#94a3b8', fontSize: '0.85rem' }}>
            Event-driven triggers, reaction policies, reduced-capability guards (E3), and firing history.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={() => handleRunOnce(true)}
            disabled={actionLoading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#cbd5e1',
              padding: '0.45rem 0.8rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: actionLoading ? 'not-allowed' : 'pointer',
            }}
          >
            <Clock size={14} />
            <span>Dry-Run Check</span>
          </button>

          <button
            onClick={() => handleRunOnce(false)}
            disabled={actionLoading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              backgroundColor: '#4f46e5',
              border: 'none',
              borderRadius: '0.375rem',
              color: '#fff',
              padding: '0.45rem 0.9rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: actionLoading ? 'not-allowed' : 'pointer',
            }}
          >
            <Play size={14} />
            <span>Run Triggers Once</span>
          </button>
        </div>
      </div>

      {/* Metrics & Kill Switch Overview Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1rem',
        }}
      >
        {/* Global Kill Switch Card */}
        <div
          style={{
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            border: isKillSwitchEnabled ? '1px solid #334155' : '1px solid #ef4444',
            padding: '1.2rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {isKillSwitchEnabled ? (
                <Shield size={20} color="#10b981" />
              ) : (
                <ShieldAlert size={20} color="#ef4444" />
              )}
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Kill Switch</span>
            </div>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                color: isKillSwitchEnabled ? '#10b981' : '#ef4444',
                backgroundColor: isKillSwitchEnabled ? '#10b98115' : '#ef444415',
                border: isKillSwitchEnabled ? '1px solid #10b98140' : '1px solid #ef444440',
                padding: '0.15rem 0.5rem',
                borderRadius: '9999px',
              }}
            >
              {isKillSwitchEnabled ? 'Triggers Active' : 'Kill Switch Engaged'}
            </span>
          </div>

          <p style={{ margin: 0, fontSize: '0.78rem', color: '#94a3b8', lineHeight: 1.4 }}>
            {isKillSwitchEnabled
              ? 'Trigger rules are enabled and reacting to new events.'
              : 'All trigger execution is paused by the global kill switch.'}
          </p>

          <button
            onClick={() =>
              initiateToggle({
                kill_switch: true,
                enabled: !isKillSwitchEnabled,
              })
            }
            disabled={actionLoading}
            style={{
              padding: '0.4rem 0.75rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: isKillSwitchEnabled ? '#991b1b' : '#059669',
              color: '#fff',
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: actionLoading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
            }}
          >
            {isKillSwitchEnabled ? (
              <>
                <ShieldAlert size={14} />
                <span>Engage Kill Switch (Disable)</span>
              </>
            ) : (
              <>
                <Shield size={14} />
                <span>Disengage Kill Switch (Enable)</span>
              </>
            )}
          </button>
        </div>

        {/* Configured Rules */}
        <div
          style={{
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            padding: '1.2rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: 600 }}>
            Configured Rules
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#f8fafc', margin: '0.4rem 0' }}>
            {triggersData?.meta?.rule_count ?? 0}
          </div>
          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Active rules in orchestration.toml
          </div>
        </div>

        {/* Total Firings */}
        <div
          style={{
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            padding: '1.2rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: 600 }}>
            Total Firings
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#f8fafc', margin: '0.4rem 0' }}>
            {statusData?.total_firings ?? history.length}
          </div>
          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Processed event triggers
          </div>
        </div>

        {/* Engine Role & Cursor */}
        <div
          style={{
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            padding: '1.2rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: 600 }}>
            Engine Status
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#818cf8', margin: '0.4rem 0' }}>
            {statusData?.role || 'orchestrator'}
          </div>
          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Cursor: <strong style={{ color: '#cbd5e1' }}>#{statusData?.cursor ?? 0}</strong>
          </div>
        </div>
      </div>

      {/* Section 1: Trigger Rules */}
      <div
        style={{
          backgroundColor: '#1e293b',
          borderRadius: '0.5rem',
          border: '1px solid #334155',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid #334155',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
              Configured Trigger Rules
            </h3>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
              Rule definitions stay in configuration; toggling edits config through preview → confirm.
            </span>
          </div>
        </div>

        <div style={{ padding: '0.75rem' }}>
          {(!triggersData?.rules || triggersData.rules.length === 0) ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b', fontSize: '0.85rem' }}>
              No trigger rules configured in orchestration.toml.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {triggersData.rules.map((rule) => {
                const isEnabled = rule.enabled !== false;
                return (
                  <div
                    key={rule.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.75rem 1rem',
                      backgroundColor: '#131d31',
                      borderRadius: '0.375rem',
                      border: '1px solid #334155',
                      gap: '1rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1, minWidth: 0 }}>
                      <Zap size={16} color={isEnabled ? '#f472b6' : '#64748b'} style={{ flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#f8fafc' }}>
                            {rule.name}
                          </span>
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              color: isEnabled ? '#10b981' : '#94a3b8',
                              backgroundColor: isEnabled ? '#10b98115' : '#33415540',
                              border: isEnabled ? '1px solid #10b98130' : '1px solid #334155',
                              padding: '0.05rem 0.35rem',
                              borderRadius: '4px',
                            }}
                          >
                            {isEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            fontSize: '0.75rem',
                            color: '#94a3b8',
                            marginTop: '0.2rem',
                          }}
                        >
                          <span>
                            On: <strong style={{ color: '#818cf8' }}>{rule.on}</strong>
                          </span>
                          <span>•</span>
                          <span>
                            Action: <strong style={{ color: '#38bdf8' }}>{rule.action}</strong>
                          </span>
                          {rule.when && Object.keys(rule.when).length > 0 && (
                            <>
                              <span>•</span>
                              <span>
                                When:{' '}
                                <code style={{ color: '#cbd5e1', fontSize: '0.72rem' }}>
                                  {JSON.stringify(rule.when)}
                                </code>
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() =>
                        initiateToggle({
                          rule_name: rule.name,
                          enabled: !isEnabled,
                        })
                      }
                      disabled={actionLoading}
                      style={{
                        padding: '0.35rem 0.75rem',
                        borderRadius: '0.25rem',
                        border: '1px solid #334155',
                        backgroundColor: isEnabled ? '#1e293b' : '#312e81',
                        color: isEnabled ? '#94a3b8' : '#e0e7ff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        cursor: actionLoading ? 'not-allowed' : 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {isEnabled ? 'Turn Off' : 'Turn On'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Section 2: Proposed Actions (E3 Reduced-Capability Policy) */}
      <div
        style={{
          backgroundColor: '#1e293b',
          borderRadius: '0.5rem',
          border: '1px solid #334155',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid #334155',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Lock size={16} color="#fbbf24" />
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                Proposed Actions (E3 Reduced-Capability Policy)
              </h3>
            </div>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
              Mutating commands and agent launches triggered unattended are proposed with cryptographic hashes for review.
            </span>
          </div>
          <span
            style={{
              fontSize: '0.75rem',
              color: '#fbbf24',
              backgroundColor: '#fbbf2415',
              border: '1px solid #fbbf2430',
              padding: '0.15rem 0.5rem',
              borderRadius: '9999px',
              fontWeight: 600,
            }}
          >
            {pendingCount} Pending
          </span>
        </div>

        <div style={{ padding: '0.75rem' }}>
          {proposedActions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b', fontSize: '0.85rem' }}>
              No proposed actions awaiting confirmation.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {proposedActions.map((act) => {
                const isExpanded = expandedActionId === act.action_id;
                const isPending = act.status === 'pending' || act.status === 'pending_confirmation';
                const statusItem = proposalActionStatus[act.action_id];
                return (
                  <div
                    key={act.action_id}
                    style={{
                      borderRadius: '0.375rem',
                      border: '1px solid #334155',
                      backgroundColor: '#131d31',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      onClick={() => setExpandedActionId(isExpanded ? null : act.action_id)}
                      style={{
                        padding: '0.75rem 1rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: 'pointer',
                        backgroundColor: isExpanded ? '#1e293b' : 'transparent',
                        gap: '1rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                        {isExpanded ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
                        <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#f8fafc' }}>
                          {act.type}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                          Rule: <strong style={{ color: '#f472b6' }}>{act.rule}</strong>
                        </span>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            padding: '0.05rem 0.35rem',
                            borderRadius: '4px',
                            backgroundColor:
                              act.status === 'confirmed'
                                ? '#065f46'
                                : act.status === 'rejected'
                                ? '#4c0519'
                                : '#fbbf2415',
                            color:
                              act.status === 'confirmed'
                                ? '#34d399'
                                : act.status === 'rejected'
                                ? '#f43f5e'
                                : '#fbbf24',
                            border:
                              act.status === 'confirmed'
                                ? '1px solid #059669'
                                : act.status === 'rejected'
                                ? '1px solid #e11d48'
                                : '1px solid #fbbf2430',
                          }}
                        >
                          {act.status}
                        </span>
                        {act.run_id && (
                          <span style={{ fontSize: '0.72rem', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            Run: <code style={{ color: '#38bdf8' }}>{act.run_id}</code>
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                        {isPending ? (
                          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => setConfirmProposal(act)}
                              disabled={statusItem?.loading}
                              title="Confirm proposed action"
                              style={{
                                padding: '0.25rem 0.6rem',
                                borderRadius: '0.375rem',
                                border: '1px solid #059669',
                                backgroundColor: '#065f46',
                                color: '#34d399',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                cursor: statusItem?.loading ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                              }}
                            >
                              <Check size={13} />
                              Confirm
                            </button>
                            <button
                              onClick={() => {
                                setRejectProposal(act);
                                setRejectReason('');
                              }}
                              disabled={statusItem?.loading}
                              title="Reject proposed action"
                              style={{
                                padding: '0.25rem 0.6rem',
                                borderRadius: '0.375rem',
                                border: '1px solid #991b1b',
                                backgroundColor: '#450a0a',
                                color: '#f87171',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                cursor: statusItem?.loading ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                              }}
                            >
                              <XCircle size={13} />
                              Reject
                            </button>
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.75rem', color: act.status === 'confirmed' ? '#34d399' : '#f87171', fontWeight: 600 }}>
                            {act.status === 'confirmed' ? 'Confirmed' : 'Rejected'}
                          </div>
                        )}

                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                          {formatAge(act.created_at)}
                        </div>
                      </div>
                    </div>

                    {/* Inline results / errors */}
                    {statusItem?.loading && (
                      <div style={{ padding: '0.4rem 1rem', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: '#38bdf8', backgroundColor: '#0b1329', borderTop: '1px solid #1e293b' }}>
                        <Loader2 size={12} className="animate-spin" /> Processing...
                      </div>
                    )}
                    {statusItem?.error && (
                      <div style={{ padding: '0.4rem 1rem', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: '#f87171', backgroundColor: '#1c1017', borderTop: '1px solid #1e293b' }}>
                        <AlertCircle size={12} /> {statusItem.error}
                      </div>
                    )}
                    {statusItem?.success && (
                      <div style={{ padding: '0.4rem 1rem', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: '#34d399', backgroundColor: '#06281e', borderTop: '1px solid #1e293b' }}>
                        <CheckCircle2 size={12} /> {statusItem.success}
                      </div>
                    )}

                    {isExpanded && (
                      <div
                        style={{
                          padding: '1rem',
                          backgroundColor: '#0a0f1d',
                          borderTop: '1px solid #1e293b',
                          fontSize: '0.75rem',
                        }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' }}>
                          <div><strong>Action ID:</strong> {act.action_id}</div>
                          <div><strong>Created:</strong> {act.created_at}</div>
                          <div><strong>Hash:</strong> <code>{act.action_hash}</code></div>
                          {act.trigger_event && <div><strong>Trigger Event:</strong> {act.trigger_event}</div>}
                          {act.confirmed_at && <div><strong>Confirmed At:</strong> {act.confirmed_at} {act.confirmed_by ? `by ${act.confirmed_by}` : ''}</div>}
                          {act.rejected_at && <div><strong>Rejected At:</strong> {act.rejected_at} {act.rejected_by ? `by ${act.rejected_by}` : ''}</div>}
                          {act.run_id && (
                            <div>
                              <strong>Run ID:</strong> <code style={{ color: '#38bdf8' }}>{act.run_id}</code>
                            </div>
                          )}
                        </div>

                        {act.reason && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong>{act.status === 'rejected' ? 'Rejection Reason:' : 'Reason / Note:'}</strong>
                            <div style={{ color: act.status === 'rejected' ? '#fca5a5' : '#cbd5e1', marginTop: '0.2rem' }}>
                              {act.reason}
                            </div>
                          </div>
                        )}

                        {act.command && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong>Proposed Command:</strong>
                            <pre
                              style={{
                                margin: '0.2rem 0 0 0',
                                padding: '0.4rem',
                                backgroundColor: '#0f172a',
                                borderRadius: '0.25rem',
                                color: '#38bdf8',
                                overflowX: 'auto',
                              }}
                            >
                              {act.command.join(' ')}
                            </pre>
                          </div>
                        )}

                        {act.run_params && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong>Run Parameters:</strong>
                            <pre
                              style={{
                                margin: '0.2rem 0 0 0',
                                padding: '0.4rem',
                                backgroundColor: '#0f172a',
                                borderRadius: '0.25rem',
                                color: '#cbd5e1',
                                overflowX: 'auto',
                              }}
                            >
                              {JSON.stringify(act.run_params, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Section 3: Last Firings */}
      <div
        style={{
          backgroundColor: '#1e293b',
          borderRadius: '0.5rem',
          border: '1px solid #334155',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid #334155',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
              Trigger Firings History
            </h3>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
              Execution history of triggers matched against domain events.
            </span>
          </div>
        </div>

        <div style={{ padding: '0.75rem' }}>
          {history.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b', fontSize: '0.85rem' }}>
              No trigger firings recorded yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {history.map((firing) => {
                const isExpanded = expandedFiringId === firing.firing_id;
                const stateColor =
                  firing.state === 'fired'
                    ? '#10b981'
                    : firing.state === 'skipped'
                    ? '#94a3b8'
                    : firing.state === 'retry'
                    ? '#f59e0b'
                    : '#ef4444';

                return (
                  <div
                    key={firing.firing_id || `${firing.rule_name}-${firing.event_seq}`}
                    style={{
                      borderRadius: '0.375rem',
                      border: '1px solid #334155',
                      backgroundColor: '#131d31',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      onClick={() => setExpandedFiringId(isExpanded ? null : firing.firing_id)}
                      style={{
                        padding: '0.65rem 1rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: 'pointer',
                        backgroundColor: isExpanded ? '#1e293b' : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        {isExpanded ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            color: stateColor,
                            backgroundColor: `${stateColor}15`,
                            border: `1px solid ${stateColor}30`,
                            padding: '0.05rem 0.35rem',
                            borderRadius: '4px',
                            textTransform: 'uppercase',
                          }}
                        >
                          {firing.state}
                        </span>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#f8fafc' }}>
                          {firing.rule_name}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: '#818cf8', fontFamily: 'monospace' }}>
                          (Event #{firing.event_seq})
                        </span>
                      </div>

                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {formatAge(firing.updated_at)}
                      </div>
                    </div>

                    {isExpanded && (
                      <div
                        style={{
                          padding: '0.75rem 1rem',
                          backgroundColor: '#0a0f1d',
                          borderTop: '1px solid #1e293b',
                          fontSize: '0.75rem',
                        }}
                      >
                        <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.5rem', color: '#94a3b8' }}>
                          <span><strong>Firing ID:</strong> {firing.firing_id}</span>
                          <span><strong>Event ID:</strong> {firing.event_id}</span>
                          <span><strong>Timestamp:</strong> {firing.updated_at}</span>
                        </div>

                        {firing.result && (
                          <pre
                            style={{
                              margin: 0,
                              padding: '0.5rem',
                              backgroundColor: '#0f172a',
                              borderRadius: '0.25rem',
                              color: '#cbd5e1',
                              fontFamily: 'monospace',
                              fontSize: '0.75rem',
                              overflowX: 'auto',
                              maxHeight: '160px',
                            }}
                          >
                            {JSON.stringify(firing.result, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Confirm Dialog for Toggles */}
      <ConfirmDialog
        isOpen={confirmDialog.open}
        title={confirmDialog.title}
        summary={confirmDialog.description}
        diff={confirmDialog.diff}
        hash={confirmDialog.expectHash}
        applyButtonText="Apply Toggle"
        danger={false}
        isApplyDisabled={actionLoading}
        onApply={handleApplyToggle}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
      />

      {/* Confirm Proposal Dialog */}
      {confirmProposal && (
        <ConfirmDialog
          isOpen={Boolean(confirmProposal)}
          title={`Confirm Proposed Action: ${confirmProposal.action_id}`}
          summary={
            `Confirm and execute proposed action under trigger rules.\n\n` +
            `* **Type:** \`${confirmProposal.type}\`\n` +
            `* **Rule:** \`${confirmProposal.rule}\`\n` +
            `* **Action Hash:** \`${confirmProposal.action_hash}\`\n` +
            (confirmProposal.command
              ? `\n**Command:**\n\`\`\`bash\n${Array.isArray(confirmProposal.command) ? confirmProposal.command.join(' ') : String(confirmProposal.command)}\n\`\`\`\n`
              : '') +
            (confirmProposal.run_params
              ? `\n**Run Parameters:**\n\`\`\`json\n${JSON.stringify(confirmProposal.run_params, null, 2)}\n\`\`\`\n`
              : '')
          }
          applyButtonText="Confirm & Execute"
          cancelButtonText="Cancel"
          hash={confirmProposal.action_hash}
          onApply={handleConfirmProposal}
          onCancel={() => setConfirmProposal(null)}
        />
      )}

      {/* Reject Proposal Dialog */}
      {rejectProposal && (
        <ConfirmDialog
          isOpen={Boolean(rejectProposal)}
          title={`Reject Proposed Action: ${rejectProposal.action_id}`}
          summary={`Reject proposed **${rejectProposal.type}** action (rule: **${rejectProposal.rule}**). A reason is required.`}
          danger={true}
          applyButtonText="Reject Action"
          cancelButtonText="Cancel"
          isApplyDisabled={!rejectReason.trim() || rejectReason.length > 1000}
          onApply={handleRejectProposal}
          onCancel={() => {
            setRejectProposal(null);
            setRejectReason('');
          }}
        >
          <div style={{ marginTop: '0.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.35rem' }}>
              Reason for rejection <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Enter reason for rejecting this proposal..."
              rows={3}
              style={{
                width: '100%',
                backgroundColor: '#0f172a',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                padding: '0.5rem',
                fontSize: '0.8rem',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', fontSize: '0.7rem', color: '#64748b', marginTop: '0.2rem' }}>
              {rejectReason.length}/1000
            </div>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
};
