import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  RotateCcw,
  CheckCircle,
  AlertCircle,
  Loader2,
  Terminal,
  Trash2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  GitBranch,
  CheckCheck,
  Ban,
  FileText,
} from 'lucide-react';
import {
  TaskItem,
  RunRecord,
  RunLogEvent,
} from '../types';
import { api } from '../api';
import { SafeMarkdown } from './SafeMarkdown';
import { ConfirmDialog } from './ConfirmDialog';

interface TaskRunsPanelProps {
  task: TaskItem;
  initialRunId?: string;
  refreshTrigger?: number;
  onRunsLoaded?: (runs: RunRecord[]) => void;
  onRefreshTask?: () => void;
  onNavigateToDecisions?: (questionId: string) => void;
  onOpenRunDialog: () => void;
}

export const TaskRunsPanel: React.FC<TaskRunsPanelProps> = ({
  task,
  initialRunId,
  refreshTrigger,
  onRunsLoaded,
  onRefreshTask,
  onNavigateToDecisions,
  onOpenRunDialog,
}) => {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId || null);
  const [logs, setLogs] = useState<RunLogEvent[]>([]);
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  // ConfirmDialog states for all mutating actions
  const [cancelConfirm, setCancelConfirm] = useState<RunRecord | null>(null);
  const [deliverConfirm, setDeliverConfirm] = useState<RunRecord | null>(null);
  const [verdictConfirm, setVerdictConfirm] = useState<RunRecord | null>(null);
  const [continueConfirm, setContinueConfirm] = useState<RunRecord | null>(null);
  const [continueInstructions, setContinueInstructions] = useState<string>('');

  // Cleanup confirmation state (with dry-run preview)
  const [cleanupConfirm, setCleanupConfirm] = useState<{
    isOpen: boolean;
    runId: string;
    summary: string;
    diff: string;
    planHash?: string;
  } | null>(null);

  // Action feedback
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showFinalReport, setShowFinalReport] = useState<boolean>(false);

  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const pollIntervalRef = useRef<any>(null);
  const wsDebounceTimerRef = useRef<any>(null);

  // Incremental merge refs: keep next_offset per run, guard in-flight
  const nextOffsetsRef = useRef<Record<string, number>>({});
  const isFetchingLogsRef = useRef<boolean>(false);
  const prevRunIdRef = useRef<string | null>(null);

  const loadRuns = useCallback(async (selectId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listRuns({ task: task.id });
      const runList = res.runs || [];
      setRuns(runList);
      onRunsLoaded?.(runList);

      if (selectId) {
        setSelectedRunId(selectId);
      } else if (!selectedRunId && runList.length > 0) {
        // Prefer initialRunId, else first active run, else latest run
        const matched = initialRunId ? runList.find((r) => r.run_id === initialRunId) : null;
        if (matched) {
          setSelectedRunId(matched.run_id);
        } else {
          const active = runList.find((r) => r.status === 'running' || r.status === 'starting');
          setSelectedRunId(active ? active.run_id : runList[0].run_id);
        }
      }
    } catch (e: any) {
      setError(e?.data?.error || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [task.id, initialRunId, selectedRunId, onRunsLoaded]);

  useEffect(() => {
    loadRuns(initialRunId);
  }, [task.id, initialRunId, refreshTrigger, loadRuns]);

  // WebSocket debounced reload (300 ms) on changed runs or tasks
  useEffect(() => {
    const unsub = api.subscribeWebSocket((msg) => {
      const isChangedAreas =
        msg.type === 'changed' &&
        Array.isArray(msg.areas) &&
        (msg.areas.includes('runs') || msg.areas.includes('tasks'));

      const isRunEvent =
        msg.type === 'run_cancelled' ||
        msg.type === 'task_delivered' ||
        msg.type === 'verdict_applied' ||
        msg.type === 'tasks_changed' ||
        msg.type === 'task_transitioned';

      if (isChangedAreas || isRunEvent) {
        if (wsDebounceTimerRef.current) clearTimeout(wsDebounceTimerRef.current);
        wsDebounceTimerRef.current = setTimeout(() => {
          loadRuns();
        }, 300);
      }
    });

    return () => {
      if (wsDebounceTimerRef.current) clearTimeout(wsDebounceTimerRef.current);
      unsub();
    };
  }, [loadRuns]);

  const selectedRun = runs.find((r) => r.run_id === selectedRunId) || null;

  // Incremental log fetching with deduplication by offset
  const fetchLogs = useCallback(async (runId: string) => {
    if (isFetchingLogsRef.current) return;
    isFetchingLogsRef.current = true;

    const storedOffset = nextOffsetsRef.current[runId] || 0;
    try {
      const res = await api.getRunLogs(runId, { since_offset: storedOffset });
      if (!res || !res.ok) return;

      // Reset when first_available_offset > stored offset (log buffer wrapped)
      if (typeof res.first_available_offset === 'number' && res.first_available_offset > storedOffset) {
        nextOffsetsRef.current[runId] = res.next_offset || 0;
        const baseOffset = res.first_available_offset;
        const eventsWithOffset = (res.events || []).map((e, idx) => ({
          ...e,
          offset: typeof e.offset === 'number' ? e.offset : baseOffset + idx,
        }));
        setLogs(eventsWithOffset);
        return;
      }

      if (res.events && res.events.length > 0) {
        const baseOffset = storedOffset;
        const newEvents = res.events.map((e, idx) => ({
          ...e,
          offset: typeof e.offset === 'number' ? e.offset : baseOffset + idx,
        }));

        setLogs((prev) => {
          // React StrictMode double effects must not double-append (dedupe by offset)
          const seenOffsets = new Set<number>();
          for (const item of prev) {
            if (typeof item.offset === 'number') {
              seenOffsets.add(item.offset);
            }
          }
          const filteredNew = newEvents.filter((item) => {
            if (typeof item.offset === 'number') {
              if (seenOffsets.has(item.offset)) return false;
              seenOffsets.add(item.offset);
              return true;
            }
            return true;
          });

          if (filteredNew.length === 0) return prev;
          return [...prev, ...filteredNew];
        });
      }

      if (typeof res.next_offset === 'number') {
        nextOffsetsRef.current[runId] = Math.max(storedOffset, res.next_offset);
      }
    } catch {
      // non-blocking
    } finally {
      isFetchingLogsRef.current = false;
      setLogsLoading(false);
    }
  }, []);

  // Reset and fetch logs when selected run changes
  useEffect(() => {
    if (!selectedRunId) {
      setLogs([]);
      prevRunIdRef.current = null;
      return;
    }

    // Reset when run id changes
    if (prevRunIdRef.current !== selectedRunId) {
      setLogs([]);
      nextOffsetsRef.current[selectedRunId] = 0;
      prevRunIdRef.current = selectedRunId;
      setLogsLoading(true);
    }

    fetchLogs(selectedRunId);
  }, [selectedRunId, fetchLogs]);

  // Poll GET /api/runs/{id} every 2 s while any run of the open task is starting|running
  useEffect(() => {
    const hasActiveRun = runs.some((r) => r.status === 'running' || r.status === 'starting');
    if (!hasActiveRun) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    pollIntervalRef.current = setInterval(async () => {
      const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'starting');
      let statusChanged = false;

      for (const ar of activeRuns) {
        try {
          const updated = await api.getRun(ar.run_id);
          if (updated && updated.run) {
            setRuns((prev) => {
              const next = prev.map((item) => (item.run_id === updated.run.run_id ? updated.run : item));
              onRunsLoaded?.(next);
              return next;
            });
            if (updated.run.status !== 'running' && updated.run.status !== 'starting') {
              statusChanged = true;
            }
          }
        } catch {
          // non-blocking
        }
      }

      // Fetch logs for selected run if active
      if (selectedRunId) {
        const cur = runs.find((r) => r.run_id === selectedRunId);
        if (cur && (cur.status === 'running' || cur.status === 'starting')) {
          await fetchLogs(selectedRunId);
        }
      }

      if (statusChanged) {
        onRefreshTask?.();
      }
    }, 2000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [runs, selectedRunId, fetchLogs, onRefreshTask, onRunsLoaded]);

  // Autoscroll logs container
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Cleanup action
  const handleOpenCleanup = async (run: RunRecord) => {
    setActionLoading(`cleanup_prev_${run.run_id}`);
    setActionError(null);
    try {
      const prev = await api.cleanupRun(run.run_id, {
        dry_run: true,
        expect_plan_hash: run.plan_hash,
      });
      setCleanupConfirm({
        isOpen: true,
        runId: run.run_id,
        summary: `Remove worktree and branch for terminal run ${run.run_id}`,
        diff: [
          `Worktree path: ${prev.worktree_path || run.worktree_path || 'none'}`,
          `Branch: ${prev.branch || run.branch || 'none'}`,
        ].join('\n'),
        planHash: run.plan_hash,
      });
    } catch (e: any) {
      setActionError(e?.data?.error || e?.message || String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleApplyCleanup = async (hash?: string) => {
    if (!cleanupConfirm) return;
    try {
      await api.cleanupRun(cleanupConfirm.runId, {
        discard: true,
        expect_plan_hash: hash || cleanupConfirm.planHash,
      });
      setCleanupConfirm(null);
      await loadRuns(cleanupConfirm.runId);
      onRefreshTask?.();
    } catch (e: any) {
      throw e;
    }
  };

  const formatDuration = (started?: string, ended?: string | null) => {
    if (!started) return '-';
    const startMs = new Date(started).getTime();
    const endMs = ended ? new Date(ended).getTime() : Date.now();
    const diffSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'running':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', backgroundColor: '#0284c7', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '1rem' }}>
            <Loader2 size={11} className="spin" /> RUNNING
          </span>
        );
      case 'starting':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', backgroundColor: '#d97706', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '1rem' }}>
            <Loader2 size={11} className="spin" /> STARTING
          </span>
        );
      case 'succeeded':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', backgroundColor: '#10b981', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '1rem' }}>
            <CheckCheck size={12} /> SUCCEEDED
          </span>
        );
      case 'failed':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', backgroundColor: '#ef4444', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '1rem' }}>
            <AlertCircle size={12} /> FAILED
          </span>
        );
      case 'cancelled':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', backgroundColor: '#64748b', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '1rem' }}>
            <Ban size={12} /> CANCELLED
          </span>
        );
      case 'lost':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', backgroundColor: '#b91c1c', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '1rem' }}>
            <AlertCircle size={12} /> LOST
          </span>
        );
      default:
        return (
          <span style={{ backgroundColor: '#475569', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '1rem' }}>
            {status.toUpperCase()}
          </span>
        );
    }
  };

  return (
    <div style={{ marginTop: '1.25rem', borderTop: '1px solid #334155', paddingTop: '1.25rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Terminal size={18} color="#818cf8" />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
            Agent Runs ({runs.length})
          </h3>
        </div>

        <button
          onClick={onOpenRunDialog}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.35rem 0.75rem',
            borderRadius: '0.375rem',
            border: 'none',
            backgroundColor: '#4f46e5',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Play size={13} />
          <span>Run…</span>
        </button>
      </div>

      {actionError && (
        <div
          style={{
            padding: '0.65rem 0.85rem',
            backgroundColor: '#451a1a',
            border: '1px solid #ef4444',
            borderRadius: '0.375rem',
            color: '#fca5a5',
            fontSize: '0.8rem',
            marginBottom: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <AlertCircle size={15} color="#ef4444" />
          <span>{actionError}</span>
        </div>
      )}

      {loading && runs.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.85rem', padding: '1rem 0' }}>
          <Loader2 size={16} className="spin" />
          <span>Loading runs...</span>
        </div>
      ) : error ? (
        <div style={{ padding: '0.75rem', backgroundColor: '#451a1a', border: '1px solid #ef4444', borderRadius: '0.375rem', color: '#fca5a5', fontSize: '0.8rem' }}>
          {error}
        </div>
      ) : runs.length === 0 ? (
        <div style={{ padding: '1.5rem', textAlign: 'center', backgroundColor: '#0f172a', border: '1px dashed #334155', borderRadius: '0.375rem', color: '#64748b', fontSize: '0.85rem' }}>
          No agent runs recorded for this task yet. Click "Run…" to start an execution or verification run.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1rem', alignItems: 'start' }}>
          {/* Left column: Run List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '520px', overflowY: 'auto' }}>
            {runs.map((r) => {
              const isSelected = r.run_id === selectedRunId;
              return (
                <div
                  key={r.run_id}
                  onClick={() => setSelectedRunId(r.run_id)}
                  style={{
                    padding: '0.65rem 0.75rem',
                    borderRadius: '0.375rem',
                    backgroundColor: isSelected ? '#1e293b' : '#0f172a',
                    border: `1px solid ${isSelected ? '#818cf8' : '#334155'}`,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.35rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    {getStatusBadge(r.status)}
                    <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
                      {formatDuration(r.started_at, r.ended_at)}
                    </span>
                  </div>

                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: isSelected ? '#f8fafc' : '#cbd5e1' }}>
                    {r.tool} · {r.mode}
                  </div>

                  <div style={{ fontSize: '0.7rem', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.profile}{r.model ? ` · ${r.model}` : ''}
                  </div>

                  {r.commits_after_base !== undefined && r.commits_after_base !== null && r.commits_after_base > 0 && (
                    <div style={{ fontSize: '0.7rem', color: '#10b981', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                      <GitBranch size={11} />
                      <span>+{r.commits_after_base} commit{r.commits_after_base > 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right column: Selected Run Details & Live Logs */}
          {selectedRun ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {/* Selected Run Top Bar */}
              <div
                style={{
                  padding: '0.85rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.6rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {getStatusBadge(selectedRun.status)}
                    <span style={{ fontWeight: 600, color: '#f8fafc', fontSize: '0.85rem' }}>
                      {selectedRun.run_id}
                    </span>
                  </div>

                  {/* Actions Row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {/* Cancel for active runs */}
                    {(selectedRun.status === 'running' || selectedRun.status === 'starting') && (
                      <button
                        onClick={() => setCancelConfirm(selectedRun)}
                        disabled={actionLoading === `cancel_${selectedRun.run_id}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          padding: '0.3rem 0.6rem',
                          borderRadius: '0.25rem',
                          border: '1px solid #ef4444',
                          backgroundColor: 'transparent',
                          color: '#f87171',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        {actionLoading === `cancel_${selectedRun.run_id}` ? (
                          <Loader2 size={12} className="spin" />
                        ) : (
                          <Ban size={12} />
                        )}
                        <span>Cancel</span>
                      </button>
                    )}

                    {/* Continue for terminal execute runs with session */}
                    {selectedRun.status !== 'running' &&
                      selectedRun.status !== 'starting' &&
                      selectedRun.mode === 'execute' &&
                      selectedRun.session_id &&
                      selectedRun.worktree_path &&
                      selectedRun.worktree_removed !== true && (
                        <button
                          onClick={() => {
                            setContinueInstructions('');
                            setContinueConfirm(selectedRun);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.3rem 0.6rem',
                            borderRadius: '0.25rem',
                            border: '1px solid #6366f1',
                            backgroundColor: 'rgba(99, 102, 241, 0.1)',
                            color: '#a5b4fc',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          <RotateCcw size={12} />
                          <span>Continue…</span>
                        </button>
                      )}

                    {/* Mark Delivered (R6 Gate) */}
                    {selectedRun.mode === 'execute' &&
                      selectedRun.status === 'succeeded' &&
                      selectedRun.final_report &&
                      task.state !== 'delivered' &&
                      task.state !== 'verified' &&
                      task.state !== 'done' && (
                        <button
                          onClick={() => setDeliverConfirm(selectedRun)}
                          disabled={actionLoading === `deliver_${selectedRun.run_id}`}
                          title="Verify invariants and transition task to delivered"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.3rem 0.65rem',
                            borderRadius: '0.25rem',
                            border: 'none',
                            backgroundColor: '#0ea5e9',
                            color: '#fff',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {actionLoading === `deliver_${selectedRun.run_id}` ? (
                            <Loader2 size={12} className="spin" />
                          ) : (
                            <CheckCircle size={12} />
                          )}
                          <span>Mark Delivered</span>
                        </button>
                      )}

                    {/* Cleanup worktree */}
                    {selectedRun.status !== 'running' &&
                      selectedRun.status !== 'starting' &&
                      selectedRun.worktree_path &&
                      selectedRun.worktree_removed !== true && (
                        <button
                          onClick={() => handleOpenCleanup(selectedRun)}
                          disabled={actionLoading === `cleanup_prev_${selectedRun.run_id}`}
                          title="Clean up worktree and branch"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.3rem 0.5rem',
                            borderRadius: '0.25rem',
                            border: '1px solid #475569',
                            backgroundColor: 'transparent',
                            color: '#94a3b8',
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                          }}
                        >
                          {actionLoading === `cleanup_prev_${selectedRun.run_id}` ? (
                            <Loader2 size={12} className="spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                          <span>Cleanup</span>
                        </button>
                      )}
                  </div>
                </div>

                {/* Details Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.4rem', fontSize: '0.75rem' }}>
                  <div>
                    <span style={{ color: '#64748b' }}>Tool / Profile: </span>
                    <span style={{ color: '#cbd5e1' }}>{selectedRun.tool} ({selectedRun.profile})</span>
                  </div>
                  {selectedRun.model && (
                    <div>
                      <span style={{ color: '#64748b' }}>Model: </span>
                      <span style={{ color: '#cbd5e1' }}>{selectedRun.model}</span>
                    </div>
                  )}
                  <div>
                    <span style={{ color: '#64748b' }}>Mode: </span>
                    <span style={{ color: '#cbd5e1' }}>{selectedRun.mode}</span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Duration: </span>
                    <span style={{ color: '#cbd5e1' }}>{formatDuration(selectedRun.started_at, selectedRun.ended_at)}</span>
                  </div>
                  {selectedRun.branch && (
                    <div>
                      <span style={{ color: '#64748b' }}>Branch: </span>
                      <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{selectedRun.branch}</span>
                    </div>
                  )}
                  {selectedRun.commits_after_base !== undefined && selectedRun.commits_after_base !== null && (
                    <div>
                      <span style={{ color: '#64748b' }}>Commits after base: </span>
                      <span style={{ color: '#10b981', fontWeight: 600 }}>+{selectedRun.commits_after_base}</span>
                    </div>
                  )}
                  {selectedRun.final_commit && (
                    <div>
                      <span style={{ color: '#64748b' }}>Final commit: </span>
                      <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{selectedRun.final_commit.slice(0, 7)}</span>
                    </div>
                  )}
                </div>

                {/* Invariant or Transition Error */}
                {selectedRun.invariant_error && (
                  <div style={{ padding: '0.4rem 0.6rem', backgroundColor: '#451a1a', border: '1px solid #ef4444', borderRadius: '0.25rem', color: '#fca5a5', fontSize: '0.75rem' }}>
                    <strong>Invariant Error:</strong> {selectedRun.invariant_error}
                  </div>
                )}
                {selectedRun.task_transition_error && (
                  <div style={{ padding: '0.4rem 0.6rem', backgroundColor: '#451a1a', border: '1px solid #ef4444', borderRadius: '0.25rem', color: '#fca5a5', fontSize: '0.75rem' }}>
                    <strong>Transition Error:</strong> {selectedRun.task_transition_error}
                  </div>
                )}

                {/* Questions filed by run */}
                {selectedRun.questions && selectedRun.questions.length > 0 && (
                  <div style={{ padding: '0.5rem 0.75rem', backgroundColor: '#1e1b4b', border: '1px solid #6366f1', borderRadius: '0.25rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#c7d2fe', marginBottom: '0.35rem' }}>
                      Questions filed by this run:
                    </div>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      {selectedRun.questions.map((qid) => (
                        <button
                          key={qid}
                          onClick={() => onNavigateToDecisions?.(qid)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.25rem 0.5rem',
                            backgroundColor: '#4338ca',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '0.25rem',
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                          }}
                        >
                          <span>{qid}</span>
                          <ExternalLink size={11} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Verdict Box for Verify runs */}
                {selectedRun.mode === 'verify' && (
                  <div
                    style={{
                      padding: '0.65rem 0.85rem',
                      backgroundColor: selectedRun.verdict?.verdict === 'verified' ? 'rgba(16, 185, 129, 0.1)' : selectedRun.verdict?.verdict === 'bounced' ? 'rgba(239, 68, 68, 0.1)' : '#1e293b',
                      border: `1px solid ${selectedRun.verdict?.verdict === 'verified' ? '#10b981' : selectedRun.verdict?.verdict === 'bounced' ? '#ef4444' : '#334155'}`,
                      borderRadius: '0.375rem',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        {selectedRun.verdict?.verdict === 'verified' ? (
                          <CheckCheck size={18} color="#10b981" />
                        ) : selectedRun.verdict?.verdict === 'bounced' ? (
                          <RotateCcw size={18} color="#ef4444" />
                        ) : (
                          <AlertCircle size={18} color="#94a3b8" />
                        )}
                        <span style={{ fontWeight: 700, fontSize: '0.85rem', color: selectedRun.verdict?.verdict === 'verified' ? '#10b981' : selectedRun.verdict?.verdict === 'bounced' ? '#ef4444' : '#cbd5e1' }}>
                          VERDICT: {selectedRun.verdict?.verdict ? selectedRun.verdict.verdict.toUpperCase() : 'NO VERDICT'}
                        </span>
                      </div>

                      {selectedRun.verdict && task.state === 'delivered' && (
                        <button
                          onClick={() => setVerdictConfirm(selectedRun)}
                          disabled={actionLoading === `verdict_${selectedRun.run_id}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            padding: '0.35rem 0.75rem',
                            backgroundColor: selectedRun.verdict.verdict === 'verified' ? '#10b981' : '#ef4444',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '0.25rem',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {actionLoading === `verdict_${selectedRun.run_id}` ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <CheckCheck size={13} />
                          )}
                          <span>Apply Verdict</span>
                        </button>
                      )}
                    </div>

                    {/* Findings Table */}
                    {selectedRun.verdict?.findings && selectedRun.verdict.findings.length > 0 ? (
                      <div style={{ marginTop: '0.5rem' }}>
                        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.25rem' }}>
                          Findings:
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                          <thead>
                            <tr style={{ borderBottom: '1px solid #334155', color: '#64748b', textAlign: 'left' }}>
                              <th style={{ padding: '0.3rem' }}>Severity</th>
                              <th style={{ padding: '0.3rem' }}>ID</th>
                              <th style={{ padding: '0.3rem' }}>Text</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedRun.verdict.findings.map((f, fIdx) => {
                              const sevBg =
                                f.severity === 'blocker' ? '#ef4444' : f.severity === 'major' ? '#f97316' : '#eab308';
                              return (
                                <tr key={fIdx} style={{ borderBottom: '1px solid #1e293b' }}>
                                  <td style={{ padding: '0.3rem' }}>
                                    <span style={{ backgroundColor: sevBg, color: '#fff', padding: '0.15rem 0.4rem', borderRadius: '0.2rem', fontSize: '0.65rem', fontWeight: 700 }}>
                                      {f.severity.toUpperCase()}
                                    </span>
                                  </td>
                                  <td style={{ padding: '0.3rem', fontFamily: 'monospace', color: '#94a3b8' }}>{f.id}</td>
                                  <td style={{ padding: '0.3rem', color: '#cbd5e1' }}>{f.text}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : selectedRun.verdict ? (
                      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                        No defects found. All verification checks passed.
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        No structured verdict block was returned by this verify run.
                      </div>
                    )}
                  </div>
                )}

                {/* Final Report Collapsible */}
                {selectedRun.final_report && (
                  <div style={{ borderTop: '1px solid #1e293b', paddingTop: '0.5rem' }}>
                    <button
                      onClick={() => setShowFinalReport(!showFinalReport)}
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
                      {showFinalReport ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <FileText size={13} />
                      <span>Final Report</span>
                    </button>
                    {showFinalReport && (
                      <div
                        style={{
                          marginTop: '0.4rem',
                          padding: '0.75rem',
                          backgroundColor: '#020617',
                          borderRadius: '0.25rem',
                          border: '1px solid #334155',
                          fontSize: '0.8rem',
                          maxHeight: '260px',
                          overflowY: 'auto',
                        }}
                      >
                        <SafeMarkdown content={selectedRun.final_report} />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Live Log Tail */}
              <div
                style={{
                  backgroundColor: '#020617',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '0.5rem 0.75rem',
                    backgroundColor: '#0f172a',
                    borderBottom: '1px solid #1e293b',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: '#cbd5e1', fontWeight: 600 }}>
                    <Terminal size={14} color="#818cf8" />
                    <span>Run Output Logs ({logs.length} events)</span>
                    {(selectedRun.status === 'running' || selectedRun.status === 'starting') && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', color: '#0ea5e9', fontSize: '0.7rem' }}>
                        <Loader2 size={11} className="spin" /> streaming…
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', color: '#94a3b8', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={autoScroll}
                        onChange={(e) => setAutoScroll(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <span>Auto-scroll</span>
                    </label>
                  </div>
                </div>

                <div
                  ref={logContainerRef}
                  style={{
                    padding: '0.75rem',
                    height: '240px',
                    overflowY: 'auto',
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    color: '#e2e8f0',
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {logsLoading && logs.length === 0 ? (
                    <div style={{ color: '#64748b' }}>Loading logs...</div>
                  ) : logs.length === 0 ? (
                    <div style={{ color: '#64748b' }}>No output logs recorded for this run.</div>
                  ) : (
                    logs.map((evt, idx) => {
                      if (evt.text) {
                        return <div key={idx}>{evt.text}</div>;
                      }
                      if (evt.tool_call) {
                        const callStr = typeof evt.tool_call === 'object' ? JSON.stringify(evt.tool_call) : String(evt.tool_call);
                        return (
                          <div key={idx} style={{ color: '#818cf8' }}>
                            [TOOL] {callStr}
                          </div>
                        );
                      }
                      if (evt.error) {
                        const errStr = typeof evt.error === 'object' ? JSON.stringify(evt.error) : String(evt.error);
                        return (
                          <div key={idx} style={{ color: '#ef4444' }}>
                            [ERROR] {errStr}
                          </div>
                        );
                      }
                      return <div key={idx} style={{ color: '#94a3b8' }}>{JSON.stringify(evt.raw || evt)}</div>;
                    })
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Cancel Confirm Dialog */}
      {cancelConfirm && (
        <ConfirmDialog
          isOpen={true}
          title={`Cancel Run ${cancelConfirm.run_id}`}
          summary={[
            `### Cancel Run Summary`,
            `- **Run ID**: \`${cancelConfirm.run_id}\``,
            `- **Tool / Mode**: ${cancelConfirm.tool} · ${cancelConfirm.mode}`,
            `- **Current Status**: **${cancelConfirm.status.toUpperCase()}**`,
            ``,
            `#### Effect on Task State`,
            `Terminates the active agent process and transitions run status to **cancelled**.`,
            `Task **${task.id}** state remains **${task.state}**. The worktree and branch are retained for inspection or cleanup.`,
          ].join('\n')}
          applyButtonText="Confirm & Cancel Run"
          danger={true}
          onApply={async () => {
            setActionLoading(`cancel_${cancelConfirm.run_id}`);
            setActionError(null);
            try {
              await api.cancelRun(cancelConfirm.run_id);
              setCancelConfirm(null);
              await loadRuns(cancelConfirm.run_id);
              onRefreshTask?.();
            } catch (e: any) {
              setActionError(e?.data?.error || e?.message || String(e));
              throw e;
            } finally {
              setActionLoading(null);
            }
          }}
          onCancel={() => setCancelConfirm(null)}
        />
      )}

      {/* Mark Delivered Confirm Dialog */}
      {deliverConfirm && (
        <ConfirmDialog
          isOpen={true}
          title={`Mark Task Delivered via Run ${deliverConfirm.run_id}`}
          summary={[
            `### Mark Delivered Summary`,
            `- **Run ID**: \`${deliverConfirm.run_id}\``,
            `- **Tool / Mode**: ${deliverConfirm.tool} · ${deliverConfirm.mode}`,
            `- **Branch**: \`${deliverConfirm.branch || 'none'}\``,
            `- **Commits After Base**: **+${deliverConfirm.commits_after_base ?? 0}**`,
            `- **Final Commit**: \`${deliverConfirm.final_commit ? deliverConfirm.final_commit.slice(0, 7) : 'none'}\``,
            ``,
            `#### Effect on Task State`,
            `Verifies invariants and transitions task **${task.id}** from **${task.state}** to **delivered** (needs verification).`,
            `The worktree is retained for independent verification.`,
          ].join('\n')}
          applyButtonText="Confirm & Mark Delivered"
          danger={false}
          onApply={async () => {
            setActionLoading(`deliver_${deliverConfirm.run_id}`);
            setActionError(null);
            try {
              const bundleHash = task.bundle_sha256 || task.task_bundle_sha256;
              await api.markDeliveredRun(deliverConfirm.run_id, {
                expect_task_hash: bundleHash,
              });
              setDeliverConfirm(null);
              await loadRuns(deliverConfirm.run_id);
              onRefreshTask?.();
            } catch (e: any) {
              setActionError(e?.data?.error || e?.message || String(e));
              throw e;
            } finally {
              setActionLoading(null);
            }
          }}
          onCancel={() => setDeliverConfirm(null)}
        />
      )}

      {/* Apply Verdict Confirm Dialog */}
      {verdictConfirm && (
        <ConfirmDialog
          isOpen={true}
          title={`Apply Verification Verdict for ${verdictConfirm.run_id}`}
          summary={[
            `### Verification Verdict Summary`,
            `- **Run ID**: \`${verdictConfirm.run_id}\``,
            `- **Tool / Mode**: ${verdictConfirm.tool} · ${verdictConfirm.mode}`,
            `- **Verdict**: **${verdictConfirm.verdict?.verdict ? verdictConfirm.verdict.verdict.toUpperCase() : 'UNKNOWN'}**`,
            `- **Resulting Task State**: **${verdictConfirm.verdict?.verdict === 'verified' ? 'verified' : 'open'}**`,
            ``,
            `#### Findings (${verdictConfirm.verdict?.findings?.length || 0})`,
            verdictConfirm.verdict?.findings && verdictConfirm.verdict.findings.length > 0
              ? verdictConfirm.verdict.findings
                  .map((f) => `- **[${f.severity.toUpperCase()}]** \`${f.id}\`: ${f.text}`)
                  .join('\n')
              : `_No defects found. All verification checks passed successfully._`,
            ``,
            `#### Effect on Task State`,
            `Transitions task **${task.id}** from **${task.state}** to **${verdictConfirm.verdict?.verdict === 'verified' ? 'verified' : 'open'}**.`,
            verdictConfirm.verdict?.verdict === 'verified'
              ? `The task is approved and ready for closing (done).`
              : `The task is rejected and returned to open for executor rework.`,
          ].join('\n')}
          applyButtonText={
            verdictConfirm.verdict?.verdict === 'verified'
              ? 'Approve (Verified)'
              : 'Bounce Task (Open)'
          }
          danger={verdictConfirm.verdict?.verdict === 'bounced'}
          onApply={async () => {
            setActionLoading(`verdict_${verdictConfirm.run_id}`);
            setActionError(null);
            try {
              const bundleHash = task.bundle_sha256 || task.task_bundle_sha256;
              await api.applyVerdictRun(verdictConfirm.run_id, {
                expect_task_hash: bundleHash,
                panel_id: verdictConfirm.panel_id || undefined,
              });
              setVerdictConfirm(null);
              await loadRuns(verdictConfirm.run_id);
              onRefreshTask?.();
            } catch (e: any) {
              setActionError(e?.data?.error || e?.message || String(e));
              throw e;
            } finally {
              setActionLoading(null);
            }
          }}
          onCancel={() => setVerdictConfirm(null)}
        />
      )}

      {/* Continue Confirm Dialog */}
      {continueConfirm && (
        <ConfirmDialog
          isOpen={true}
          title={`Continue Run Session for ${continueConfirm.run_id}`}
          summary={[
            `### Continue Session Summary`,
            `- **Run ID**: \`${continueConfirm.run_id}\``,
            `- **Tool / Mode**: ${continueConfirm.tool} · ${continueConfirm.mode}`,
            `- **Session ID**: \`${continueConfirm.session_id || 'none'}\``,
            `- **Worktree**: \`${continueConfirm.worktree_path || 'none'}\``,
            ``,
            `#### Effect on Task State`,
            `Resumes the agent session in the existing worktree with new instructions. Task **${task.id}** state remains or transitions to **in progress**.`,
          ].join('\n')}
          hash={continueConfirm.plan_hash}
          applyButtonText="Confirm & Continue Run"
          danger={false}
          onApply={async (hash?: string) => {
            try {
              const res = await api.continueRun(continueConfirm.run_id, {
                instructions: continueInstructions.trim() || undefined,
                expect_plan_hash: hash || continueConfirm.plan_hash,
              });
              setContinueConfirm(null);
              setContinueInstructions('');
              if (res && res.run_id) {
                await loadRuns(res.run_id);
                onRefreshTask?.();
              }
            } catch (e: any) {
              throw e;
            }
          }}
          onCancel={() => {
            setContinueConfirm(null);
            setContinueInstructions('');
          }}
        >
          <div style={{ marginTop: '0.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.35rem' }}>
              Continuation Instructions (Optional)
            </label>
            <textarea
              value={continueInstructions}
              onChange={(e) => setContinueInstructions(e.target.value)}
              rows={3}
              placeholder="Explain what the agent should do next..."
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.5rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid #334155',
                backgroundColor: '#0f172a',
                color: '#f8fafc',
                fontSize: '0.85rem',
              }}
            />
          </div>
        </ConfirmDialog>
      )}

      {/* Cleanup Confirm Dialog */}
      {cleanupConfirm && (
        <ConfirmDialog
          isOpen={true}
          title={`Clean Up Worktree for ${cleanupConfirm.runId}`}
          summary={cleanupConfirm.summary}
          diff={cleanupConfirm.diff}
          hash={cleanupConfirm.planHash}
          applyButtonText="Discard and Clean Up"
          cancelButtonText="Cancel"
          onApply={handleApplyCleanup}
          onCancel={() => setCleanupConfirm(null)}
        />
      )}
    </div>
  );
};
