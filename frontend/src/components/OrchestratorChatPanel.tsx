import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Bot,
  Send,
  Play,
  Pause,
  RotateCw,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  AlertTriangle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Zap,
  CheckCircle2,
  Cpu,
  ArrowDown,
} from 'lucide-react';
import {
  OrchestratorStatus,
  OrchestratorTurn,
  ProposedAction,
} from '../types';
import { api, orchestratorChatApi, proposedActionsApi, useProject } from '../api';
import { SafeMarkdown } from './SafeMarkdown';
import { ConfirmDialog } from './ConfirmDialog';

interface OrchestratorChatPanelProps {
  onNavigateTab?: (tab: string) => void;
}

const sortTurnsChronologically = (list: OrchestratorTurn[]): OrchestratorTurn[] => {
  return [...list].sort((a, b) => {
    const timeA = (a.created_at || (a as any).queued_at || (a as any).started_at || (a as any).ended_at || '').trim();
    const timeB = (b.created_at || (b as any).queued_at || (b as any).started_at || (b as any).ended_at || '').trim();
    if (timeA && timeB && timeA !== timeB) {
      return timeA.localeCompare(timeB);
    }
    if (timeA && !timeB) return -1;
    if (!timeA && timeB) return 1;
    const seqA = typeof a.turn_seq === 'number' ? a.turn_seq : parseInt(String(a.turn_id).split('-')[0], 10) || 0;
    const seqB = typeof b.turn_seq === 'number' ? b.turn_seq : parseInt(String(b.turn_id).split('-')[0], 10) || 0;
    return seqA - seqB;
  });
};

export const OrchestratorChatPanel: React.FC<OrchestratorChatPanelProps> = ({ onNavigateTab: _onNavigateTab }) => {
  const targetProject = useProject();
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [turns, setTurns] = useState<OrchestratorTurn[]>([]);
  const [proposedActions, setProposedActions] = useState<ProposedAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [inputMessage, setInputMessage] = useState('');
  const [copiedSession, setCopiedSession] = useState(false);
  const [showProposedActions, setShowProposedActions] = useState(false);
  const [confirmProposal, setConfirmProposal] = useState<ProposedAction | null>(null);
  const [rejectProposal, setRejectProposal] = useState<ProposedAction | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [proposalActionStatus, setProposalActionStatus] = useState<Record<string, { loading?: boolean; error?: string; success?: string }>>({});
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [turnToCancel, setTurnToCancel] = useState<string | null>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load Status, Conversation & Proposed Actions
  const loadData = useCallback(async () => {
    if (!targetProject) return;
    try {
      const [stRes, convRes, propRes] = await Promise.all([
        orchestratorChatApi.getOrchestratorStatus(targetProject),
        orchestratorChatApi.getOrchestratorConversation({ limit: 100, order: 'asc' }, targetProject),
        api.getProposedActions(targetProject),
      ]);
      setStatus(stRes);
      setTurns(sortTurnsChronologically(convRes.turns || []));
      setProposedActions(propRes.proposed_actions || []);
    } catch {
      // Ignored on poll
    } finally {
      setLoading(false);
    }
  }, [targetProject]);

  useEffect(() => {
    loadData();
    // Subscribe to WebSocket updates
    const unsubscribe = api.subscribeWebSocket((msg: any) => {
      if (
        msg.type === 'turn_queued' ||
        msg.type === 'turn_started' ||
        msg.type === 'turn_finished' ||
        msg.type === 'turn_failed' ||
        msg.type === 'turn_cancelled' ||
        msg.type === 'orchestrator_paused' ||
        msg.type === 'orchestrator_resumed' ||
        msg.type === 'orchestrator_rotated'
      ) {
        loadData();
      } else if (msg.type === 'changed' && Array.isArray(msg.areas)) {
        if (msg.areas.some((a: string) => ['orchestrator', 'queue', 'events', 'triggers'].includes(a))) {
          loadData();
        }
      } else if (msg.type === 'event' && msg.event?.type) {
        if (msg.event.type.startsWith('turn.') || msg.event.type.startsWith('orchestrator.')) {
          loadData();
        }
      }
    });

    // Check if any turn is active/running for poll interval
    const hasActiveTurn = turns.some((t) => t.state === 'running' || t.state === 'queued');
    const interval = setInterval(loadData, hasActiveTurn ? 1500 : 4000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [loadData, turns]);

  // Auto-scroll to bottom if user has not scrolled up
  useEffect(() => {
    if (!userScrolledUp && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [turns, userScrolledUp]);

  const handleScroll = () => {
    if (!messageListRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messageListRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
    setUserScrolledUp(!isAtBottom);
  };

  const scrollToBottom = () => {
    setUserScrolledUp(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Handlers
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputMessage.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setInputMessage('');
    setUserScrolledUp(false);

    // Optimistically add queued turn
    const optimisticTurn: OrchestratorTurn = {
      turn_id: 'pending-' + Date.now(),
      turn_seq: (turns[turns.length - 1]?.turn_seq || 0) + 1,
      type: 'owner_chat',
      state: 'queued',
      message: trimmed,
      prompt_text: trimmed,
      created_at: new Date().toISOString(),
    };
    setTurns((prev) => sortTurnsChronologically([...prev, optimisticTurn]));

    try {
      await orchestratorChatApi.postOrchestratorChat(trimmed, undefined, targetProject);
      await loadData();
    } catch (err: any) {
      // Refresh to get real state
      await loadData();
    } finally {
      setSending(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handlePauseResume = async () => {
    if (actionLoading || !status) return;
    setActionLoading(true);
    try {
      if (status.status === 'paused') {
        await orchestratorChatApi.resumeOrchestrator(targetProject);
      } else {
        await orchestratorChatApi.pauseOrchestrator(targetProject);
      }
      await loadData();
    } catch {
      // Ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleRotateConfirm = async () => {
    setActionLoading(true);
    try {
      await orchestratorChatApi.rotateOrchestrator({ reason: 'owner_requested', no_handoff: false }, targetProject);
      await loadData();
    } catch {
      // Ignore
    } finally {
      setActionLoading(false);
      setRotateDialogOpen(false);
    }
  };

  const handleCancelTurn = async () => {
    if (!turnToCancel) return;
    setActionLoading(true);
    try {
      await orchestratorChatApi.cancelOrchestratorTurn(turnToCancel, targetProject);
      await loadData();
    } catch {
      // Ignore
    } finally {
      setActionLoading(false);
      setCancelDialogOpen(false);
      setTurnToCancel(null);
    }
  };

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
      }, targetProject);
      setProposalActionStatus((prev) => ({
        ...prev,
        [act.action_id]: {
          loading: false,
          success: res.message || 'Action confirmed and executed successfully',
        },
      }));
      setConfirmProposal(null);
      const propRes = await api.getProposedActions(targetProject);
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
      }, targetProject);
      setProposalActionStatus((prev) => ({
        ...prev,
        [act.action_id]: {
          loading: false,
          success: res.message || 'Action rejected',
        },
      }));
      setRejectProposal(null);
      setRejectReason('');
      const propRes = await api.getProposedActions(targetProject);
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

  const copySessionId = () => {
    if (status?.session_id) {
      navigator.clipboard.writeText(status.session_id);
      setCopiedSession(true);
      setTimeout(() => setCopiedSession(false), 2000);
    }
  };

  // Context tokens & threshold calculation
  const contextTokens = status?.last_usage?.estimated_context_tokens || 0;
  const rotateThreshold = status?.rotate_after_tokens || 150000;
  const contextPercent = Math.min(100, Math.round((contextTokens / rotateThreshold) * 100));

  let contextBarColor = '#22c55e'; // green
  if (contextPercent >= 85) {
    contextBarColor = '#ef4444'; // red
  } else if (contextPercent >= 60) {
    contextBarColor = '#f59e0b'; // amber
  }

  const pendingCount = useMemo(
    () => proposedActions.filter((a) => a.status === 'pending' || a.status === 'pending_confirmation').length,
    [proposedActions]
  );
  const sortedTurns = useMemo(() => sortTurnsChronologically(turns), [turns]);

  // Active running or queued turns
  const runningTurn = sortedTurns.find((t) => t.state === 'running');
  const queuedTurns = sortedTurns.filter((t) => t.state === 'queued' || t.state === 'claimed');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - var(--nav-h, 3.75rem))',
        backgroundColor: '#0f172a',
        color: '#f8fafc',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* 1. Orchestrator Status Header */}
      <header
        style={{
          padding: '0.75rem 1.25rem',
          backgroundColor: '#1e293b',
          borderBottom: '1px solid #334155',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div
              style={{
                width: '2rem',
                height: '2rem',
                borderRadius: '0.5rem',
                backgroundColor: '#312e81',
                color: '#818cf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid #4338ca',
              }}
            >
              <Bot size={18} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Orchestrator Role</span>
                {status && (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      padding: '0.12rem 0.5rem',
                      borderRadius: '9999px',
                      backgroundColor:
                        status.status === 'paused'
                          ? '#451a03'
                          : status.status === 'rotating'
                          ? '#3b0764'
                          : '#064e3b',
                      color:
                        status.status === 'paused'
                          ? '#f59e0b'
                          : status.status === 'rotating'
                          ? '#d8b4fe'
                          : '#10b981',
                      border: `1px solid ${
                        status.status === 'paused'
                          ? '#d97706'
                          : status.status === 'rotating'
                          ? '#a855f7'
                          : '#059669'
                      }`,
                      textTransform: 'uppercase',
                    }}
                  >
                    {status.status}
                  </span>
                )}
                {status?.generation !== undefined && (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      padding: '0.1rem 0.4rem',
                      borderRadius: '0.25rem',
                      backgroundColor: '#334155',
                      color: '#cbd5e1',
                    }}
                  >
                    Gen {status.generation}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'flex', gap: '0.75rem', marginTop: '0.15rem' }}>
                <span>
                  Tool: <strong style={{ color: '#e2e8f0' }}>{status?.tool || 'unknown'}</strong>
                  {status?.model ? ` (${status.model})` : ''}
                </span>
                {status?.session_id && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    Session:{' '}
                    <code style={{ fontSize: '0.7rem', color: '#cbd5e1' }}>
                      {status.session_id.slice(0, 8)}...
                    </code>
                    <button
                      onClick={copySessionId}
                      title="Copy full session UUID"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '1px',
                        cursor: 'pointer',
                        color: copiedSession ? '#10b981' : '#94a3b8',
                      }}
                    >
                      {copiedSession ? <Check size={11} /> : <Copy size={11} />}
                    </button>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Context Tokens Usage Bar */}
          <div
            style={{
              padding: '0.35rem 0.65rem',
              backgroundColor: '#0f172a',
              borderRadius: '0.375rem',
              border: '1px solid #334155',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.2rem',
              minWidth: '170px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#94a3b8' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <Cpu size={11} /> Context
              </span>
              <span>
                {contextTokens.toLocaleString()} / {rotateThreshold.toLocaleString()} ({contextPercent}%)
              </span>
            </div>
            <div
              style={{
                width: '100%',
                height: '5px',
                backgroundColor: '#334155',
                borderRadius: '9999px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${contextPercent}%`,
                  height: '100%',
                  backgroundColor: contextBarColor,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {proposedActions.length > 0 && (
            <button
              onClick={() => setShowProposedActions(!showProposedActions)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid #d97706',
                backgroundColor: '#451a03',
                color: '#fbbf24',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Zap size={14} />
              <span>Proposals ({pendingCount > 0 ? pendingCount : proposedActions.length})</span>
              {showProposedActions ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          )}

          {/* Pause / Resume button */}
          <button
            onClick={handlePauseResume}
            disabled={actionLoading || !status}
            title={status?.status === 'paused' ? 'Resume Orchestrator' : 'Pause Orchestrator'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.4rem 0.75rem',
              borderRadius: '0.375rem',
              border: status?.status === 'paused' ? '1px solid #059669' : '1px solid #475569',
              backgroundColor: status?.status === 'paused' ? '#065f46' : '#334155',
              color: '#f8fafc',
              fontSize: '0.8rem',
              fontWeight: 500,
              cursor: actionLoading ? 'not-allowed' : 'pointer',
              opacity: actionLoading ? 0.7 : 1,
            }}
          >
            {status?.status === 'paused' ? <Play size={14} color="#34d399" /> : <Pause size={14} />}
            <span>{status?.status === 'paused' ? 'Resume' : 'Pause'}</span>
          </button>

          {/* Rotate button */}
          <button
            onClick={() => setRotateDialogOpen(true)}
            disabled={actionLoading || !status || status.status === 'rotating'}
            title="Rotate to next generation with handoff prompt"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.4rem 0.75rem',
              borderRadius: '0.375rem',
              border: '1px solid #6366f1',
              backgroundColor: '#3730a3',
              color: '#e0e7ff',
              fontSize: '0.8rem',
              fontWeight: 500,
              cursor: actionLoading ? 'not-allowed' : 'pointer',
              opacity: actionLoading ? 0.7 : 1,
            }}
          >
            <RotateCw size={14} />
            <span>Rotate</span>
          </button>

          {/* Cancel active turn */}
          {runningTurn && (
            <button
              onClick={() => {
                setTurnToCancel(runningTurn.turn_id);
                setCancelDialogOpen(true);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid #dc2626',
                backgroundColor: '#7f1d1d',
                color: '#fca5a5',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <XCircle size={14} />
              <span>Cancel Turn</span>
            </button>
          )}

          {/* Refresh button */}
          <button
            onClick={loadData}
            title="Refresh"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '2rem',
              height: '2rem',
              borderRadius: '0.375rem',
              border: '1px solid #475569',
              backgroundColor: '#1e293b',
              color: '#cbd5e1',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {/* 2. Proposed Actions Drawer / Collapsible Banner */}
      {showProposedActions && proposedActions.length > 0 && (
        <div
          style={{
            backgroundColor: '#1e293b',
            borderBottom: '1px solid #334155',
            padding: '0.75rem 1.25rem',
            maxHeight: '260px',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Zap size={15} /> Proposed Actions from Reduced-Capability Turns (Spec E3)
            </span>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
              Requires owner review before execution
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {proposedActions.map((act) => {
              const isPending = act.status === 'pending' || act.status === 'pending_confirmation';
              const statusItem = proposalActionStatus[act.action_id];
              return (
                <div
                  key={act.action_id}
                  style={{
                    padding: '0.65rem 0.85rem',
                    backgroundColor: '#0f172a',
                    borderRadius: '0.375rem',
                    border: '1px solid #334155',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.4rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '1rem',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            padding: '0.1rem 0.35rem',
                            borderRadius: '0.25rem',
                            backgroundColor: '#3b82f6',
                            color: '#fff',
                            textTransform: 'uppercase',
                          }}
                        >
                          {act.type}
                        </span>
                        <strong style={{ fontSize: '0.82rem', color: '#f8fafc' }}>{act.rule || act.action_id}</strong>
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
                        <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
                          {new Date(act.created_at).toLocaleTimeString()}
                        </span>
                        {act.run_id && (
                          <span style={{ fontSize: '0.72rem', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            Run: <code style={{ color: '#38bdf8' }}>{act.run_id}</code>
                          </span>
                        )}
                      </div>
                      {act.reason && (
                        <div style={{ fontSize: '0.75rem', color: '#cbd5e1', marginBottom: '0.25rem' }}>
                          {act.status === 'rejected' ? <strong style={{ color: '#fca5a5' }}>Rejection reason: </strong> : null}
                          {act.reason}
                        </div>
                      )}
                      {act.command && (
                        <code style={{ fontSize: '0.72rem', color: '#818cf8', wordBreak: 'break-all', display: 'block' }}>
                          {Array.isArray(act.command) ? act.command.join(' ') : String(act.command)}
                        </code>
                      )}
                      {act.run_params && (
                        <pre style={{ fontSize: '0.7rem', color: '#cbd5e1', margin: '0.2rem 0 0 0', padding: '0.3rem', backgroundColor: '#1e293b', borderRadius: '4px', overflowX: 'auto' }}>
                          {JSON.stringify(act.run_params, null, 2)}
                        </pre>
                      )}
                    </div>

                    {/* Confirm/Reject Buttons or Status */}
                    <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0, alignItems: 'center' }}>
                      {isPending ? (
                        <>
                          <button
                            onClick={() => setConfirmProposal(act)}
                            disabled={statusItem?.loading}
                            title="Confirm proposed action"
                            style={{
                              padding: '0.35rem 0.65rem',
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
                              padding: '0.35rem 0.65rem',
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
                        </>
                      ) : (
                        <div style={{ fontSize: '0.75rem', color: act.status === 'confirmed' ? '#34d399' : '#f87171', fontWeight: 600 }}>
                          {act.status === 'confirmed' ? 'Confirmed' : 'Rejected'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Inline results / errors */}
                  {statusItem?.loading && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: '#38bdf8' }}>
                      <Loader2 size={12} className="animate-spin" /> Processing...
                    </div>
                  )}
                  {statusItem?.error && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: '#f87171' }}>
                      <AlertCircle size={12} /> {statusItem.error}
                    </div>
                  )}
                  {statusItem?.success && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: '#34d399' }}>
                      <CheckCircle2 size={12} /> {statusItem.success}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Messages List Area */}
      <div
        ref={messageListRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
          position: 'relative',
        }}
      >
        {sortedTurns.length === 0 ? (
          <div
            style={{
              margin: 'auto',
              textAlign: 'center',
              color: '#64748b',
              maxWidth: '420px',
              padding: '2rem 1rem',
            }}
          >
            <div
              style={{
                width: '3.5rem',
                height: '3.5rem',
                borderRadius: '1rem',
                backgroundColor: '#1e293b',
                color: '#818cf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 1rem',
              }}
            >
              <Bot size={28} />
            </div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.4rem' }}>
              Orchestrator Chat
            </h3>
            <p style={{ fontSize: '0.85rem', lineHeight: 1.5, margin: 0 }}>
              The orchestrator runs headlessly. Chatting enqueues a turn for the orchestrator role. The response is the turn's output.
            </p>
          </div>
        ) : (
          sortedTurns.map((turn, idx) => {
            const isOwner = turn.type === 'owner_chat';
            const isEventBatch = turn.type === 'event_batch';
            const isHandoff = turn.type === 'handoff';

            const isQueued = turn.state === 'queued' || turn.state === 'claimed';
            const isRunning = turn.state === 'running';
            const isFailed = turn.state === 'failed' || turn.state === 'dead';
            const isCancelled = turn.state === 'cancelled';

            // Find queue position if queued
            const queuePos = isQueued
              ? queuedTurns.findIndex((t) => t.turn_id === turn.turn_id) + 1
              : 0;

            return (
              <div key={turn.turn_id || idx} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {/* User Message (if owner_chat) */}
                {isOwner && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      alignItems: 'flex-start',
                      gap: '0.6rem',
                    }}
                  >
                    <div
                      style={{
                        maxWidth: '75%',
                        backgroundColor: '#312e81',
                        border: '1px solid #4338ca',
                        borderRadius: '0.75rem 0.75rem 0.15rem 0.75rem',
                        padding: '0.75rem 1rem',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '0.75rem',
                          marginBottom: '0.35rem',
                          fontSize: '0.7rem',
                          color: '#a5b4fc',
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>Owner</span>
                        <span>
                          {turn.created_at ? new Date(turn.created_at).toLocaleTimeString() : ''}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: '0.9rem',
                          lineHeight: 1.5,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: '#ffffff',
                        }}
                      >
                        {turn.message || turn.prompt_text || ''}
                      </div>

                      {/* State badge on User message if pending/queued */}
                      {isQueued && (
                        <div
                          style={{
                            marginTop: '0.5rem',
                            paddingTop: '0.4rem',
                            borderTop: '1px solid #4338ca',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            fontSize: '0.72rem',
                            color: '#fbbf24',
                          }}
                        >
                          <Clock size={12} />
                          <span>
                            Queued {queuePos > 0 ? `(#${queuePos} in queue)` : ''} — waiting for worker
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Event Batch or Handoff Banner */}
                {isEventBatch && (
                  <div
                    style={{
                      margin: '0.5rem auto',
                      padding: '0.4rem 0.85rem',
                      backgroundColor: '#1e293b',
                      borderRadius: '9999px',
                      border: '1px solid #334155',
                      fontSize: '0.75rem',
                      color: '#94a3b8',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                    }}
                  >
                    <Zap size={13} color="#f59e0b" />
                    <span>
                      Trigger Event Turn {turn.turn_id ? `#${turn.turn_id}` : ''}{' '}
                      {turn.events && turn.events.length > 0 ? `(${turn.events.length} events)` : ''}
                    </span>
                    {isQueued && <span style={{ color: '#fbbf24' }}>• Queued</span>}
                    {isRunning && <span style={{ color: '#60a5fa' }}>• Running</span>}
                  </div>
                )}

                {isHandoff && (
                  <div
                    style={{
                      margin: '0.5rem auto',
                      padding: '0.4rem 0.85rem',
                      backgroundColor: '#2e1065',
                      borderRadius: '9999px',
                      border: '1px solid #6b21a8',
                      fontSize: '0.75rem',
                      color: '#d8b4fe',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                    }}
                  >
                    <RotateCw size={13} color="#c084fc" />
                    <span>Handoff Turn {turn.turn_id ? `#${turn.turn_id}` : ''}</span>
                  </div>
                )}

                {/* Assistant Output Bubble (if turn has run, running, failed, or cancelled) */}
                {(!isQueued || !isOwner) && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-start',
                      alignItems: 'flex-start',
                      gap: '0.6rem',
                    }}
                  >
                    <div
                      style={{
                        width: '2rem',
                        height: '2rem',
                        borderRadius: '0.5rem',
                        backgroundColor: '#1e293b',
                        color: '#818cf8',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid #334155',
                        flexShrink: 0,
                        marginTop: '0.2rem',
                      }}
                    >
                      <Bot size={16} />
                    </div>

                    <div
                      style={{
                        maxWidth: '82%',
                        backgroundColor: '#1e293b',
                        border: isRunning
                          ? '1px solid #3b82f6'
                          : isFailed
                          ? '1px solid #ef4444'
                          : '1px solid #334155',
                        borderRadius: '0.15rem 0.75rem 0.75rem 0.75rem',
                        padding: '0.85rem 1.1rem',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                      }}
                    >
                      {/* Assistant Header */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '0.75rem',
                          marginBottom: '0.5rem',
                          fontSize: '0.72rem',
                          color: '#94a3b8',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ fontWeight: 600, color: '#f8fafc' }}>Orchestrator</span>
                          <span
                            style={{
                              fontSize: '0.68rem',
                              padding: '0.05rem 0.35rem',
                              borderRadius: '0.2rem',
                              backgroundColor: '#0f172a',
                              color: '#cbd5e1',
                            }}
                          >
                            Turn {turn.turn_id}
                          </span>
                          {turn.duration_seconds !== undefined && (
                            <span>• {turn.duration_seconds.toFixed(1)}s</span>
                          )}
                          {turn.usage?.input_tokens !== undefined && (
                            <span>
                              • {((turn.usage.input_tokens || 0) + (turn.usage.output_tokens || 0)).toLocaleString()} tokens
                            </span>
                          )}
                        </div>

                        {/* Status chip */}
                        <div>
                          {isRunning && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                color: '#60a5fa',
                                fontWeight: 600,
                              }}
                            >
                              <Loader2 size={12} className="spin" />
                              Running...
                            </span>
                          )}
                          {turn.state === 'done' && (
                            <span style={{ color: '#10b981', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                              <CheckCircle2 size={12} />
                              Completed
                            </span>
                          )}
                          {isCancelled && (
                            <span style={{ color: '#94a3b8' }}>Cancelled</span>
                          )}
                          {isFailed && (
                            <span style={{ color: '#f87171' }}>Failed</span>
                          )}
                        </div>
                      </div>

                      {/* Content or Streaming / Thinking */}
                      {isRunning && !turn.output && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            color: '#94a3b8',
                            fontSize: '0.85rem',
                            padding: '0.5rem 0',
                          }}
                        >
                          <Loader2 size={16} className="spin" color="#60a5fa" />
                          <span>Orchestrator is processing...</span>
                          <button
                            onClick={() => {
                              setTurnToCancel(turn.turn_id);
                              setCancelDialogOpen(true);
                            }}
                            style={{
                              marginLeft: 'auto',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '0.25rem',
                              border: '1px solid #dc2626',
                              backgroundColor: '#7f1d1d',
                              color: '#fca5a5',
                              fontSize: '0.72rem',
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {turn.output && (
                        <div style={{ fontSize: '0.9rem', lineHeight: 1.6, color: '#f8fafc' }}>
                          <SafeMarkdown content={turn.output} />
                        </div>
                      )}

                      {/* Error Banner if failed */}
                      {isFailed && turn.error && (
                        <div
                          style={{
                            marginTop: '0.5rem',
                            padding: '0.5rem 0.75rem',
                            backgroundColor: '#451a1a',
                            borderRadius: '0.375rem',
                            border: '1px solid #ef4444',
                            color: '#fca5a5',
                            fontSize: '0.78rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                          }}
                        >
                          <AlertTriangle size={14} color="#ef4444" style={{ flexShrink: 0 }} />
                          <span style={{ wordBreak: 'break-word' }}>{turn.error}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Floating Scroll to Bottom Button */}
      {userScrolledUp && (
        <button
          onClick={scrollToBottom}
          title="Scroll to latest messages"
          style={{
            position: 'absolute',
            bottom: '5.5rem',
            right: '2rem',
            padding: '0.4rem 0.75rem',
            borderRadius: '9999px',
            backgroundColor: '#1e293b',
            border: '1px solid #475569',
            color: '#f8fafc',
            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            fontSize: '0.75rem',
            cursor: 'pointer',
            zIndex: 10,
          }}
        >
          <ArrowDown size={14} />
          <span>New messages</span>
        </button>
      )}

      {/* 4. Chat Input Bar */}
      <footer
        style={{
          padding: '0.75rem 1.25rem',
          backgroundColor: '#1e293b',
          borderTop: '1px solid #334155',
          flexShrink: 0,
        }}
      >
        {status?.status === 'paused' && (
          <div
            style={{
              padding: '0.3rem 0.6rem',
              backgroundColor: '#451a03',
              borderRadius: '0.25rem',
              border: '1px solid #b45309',
              color: '#fef3c7',
              fontSize: '0.75rem',
              marginBottom: '0.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <Pause size={12} color="#fbbf24" />
            <span>Orchestrator is currently paused. New messages will queue until resumed.</span>
          </div>
        )}

        <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <textarea
              ref={textareaRef}
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              placeholder="Message the orchestrator... (Enter to send, Shift+Enter for newline)"
              rows={2}
              style={{
                width: '100%',
                padding: '0.65rem 0.85rem',
                backgroundColor: '#0f172a',
                border: '1px solid #475569',
                borderRadius: '0.5rem',
                color: '#f8fafc',
                fontSize: '0.9rem',
                resize: 'none',
                boxSizing: 'border-box',
                outline: 'none',
                lineHeight: 1.4,
              }}
            />
          </div>

          <button
            type="submit"
            disabled={!inputMessage.trim() || sending}
            style={{
              height: '2.75rem',
              padding: '0 1.25rem',
              borderRadius: '0.5rem',
              backgroundColor: !inputMessage.trim() || sending ? '#334155' : '#4f46e5',
              border: 'none',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              cursor: !inputMessage.trim() || sending ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.2s',
            }}
          >
            {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            <span>Send</span>
          </button>
        </form>
      </footer>

      {/* Rotate Confirmation Dialog */}
      {rotateDialogOpen && (
        <ConfirmDialog
          isOpen={rotateDialogOpen}
          title="Rotate Orchestrator Role"
          summary={`Rotate current orchestrator (generation ${status?.generation || 1}) to generation ${(status?.generation || 1) + 1}. Fenced succession will generate a handoff prompt and retire the current session.`}
          applyButtonText="Rotate Orchestrator"
          cancelButtonText="Cancel"
          onApply={handleRotateConfirm}
          onCancel={() => setRotateDialogOpen(false)}
        />
      )}

      {/* Cancel Turn Confirmation Dialog */}
      {cancelDialogOpen && (
        <ConfirmDialog
          isOpen={cancelDialogOpen}
          title="Cancel Turn"
          summary={`Are you sure you want to cancel turn ${turnToCancel}? If currently running, the process group will be interrupted.`}
          danger={true}
          applyButtonText="Cancel Turn"
          cancelButtonText="Keep Running"
          onApply={handleCancelTurn}
          onCancel={() => {
            setCancelDialogOpen(false);
            setTurnToCancel(null);
          }}
        />
      )}
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
