import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Filter,
  Search,
  RefreshCw,
  Loader2,
  AlertCircle,
  ExternalLink,
  GitBranch,
  Terminal,
  CheckCheck,
  Ban,
} from 'lucide-react';
import { TaskItem, RunRecord, shortTitle } from '../types';
import { api, setCurrentProject } from '../api';
import { ProjectChip } from './ProjectBadges';

interface RunsTabProps {
  onSelectRun: (task: TaskItem, runId: string) => void;
  tasks?: TaskItem[];
  refreshKey?: number;
  isCommonView?: boolean;
}

export const RunsTab: React.FC<RunsTabProps> = ({
  onSelectRun,
  tasks = [],
  refreshKey = 0,
  isCommonView = false,
}) => {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [toolFilter, setToolFilter] = useState<string>('all');
  const [modeFilter, setModeFilter] = useState<string>('all');

  const loadAllRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = isCommonView ? await api.getWorkspaceRuns() : await api.listRuns();
      setRuns(res.runs || []);
    } catch (e: any) {
      setError(e?.data?.error || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [isCommonView]);

  useEffect(() => {
    loadAllRuns();
  }, [loadAllRuns, refreshKey]);

  // Poll active runs every 2s while any run is starting or running
  useEffect(() => {
    const hasActiveRun = runs.some((r) => r.status === 'running' || r.status === 'starting');
    if (!hasActiveRun) return;

    const interval = setInterval(async () => {
      const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'starting');
      for (const ar of activeRuns) {
        try {
          const updated = await api.getRun(ar.run_id, ar.project);
          if (updated && updated.run) {
            setRuns((prev) =>
              prev.map((item) => (item.run_id === updated.run.run_id ? { ...updated.run, project: ar.project || updated.run.project } : item))
            );
          }
        } catch {
          // non-blocking
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [runs]);

  // WebSocket live reload debounced 300ms on changed runs or tasks
  useEffect(() => {
    let timer: any = null;
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
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          loadAllRuns();
        }, 300);
      }
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [loadAllRuns]);

  // Map task IDs to TaskItem objects
  const taskMap = useMemo(() => {
    const map = new Map<string, TaskItem>();
    tasks.forEach((t) => {
      map.set(t.id, t);
      if (t.project) {
        map.set(`${t.project}/${t.id}`, t);
      }
    });
    return map;
  }, [tasks]);

  const handleRowClick = async (run: RunRecord) => {
    if (run.project) {
      setCurrentProject(run.project);
    }
    let targetTask = (run.project && taskMap.get(`${run.project}/${run.task_id}`)) || taskMap.get(run.task_id);
    if (!targetTask) {
      // Try to construct a minimal TaskItem if not in the cached list
      targetTask = {
        kind: 'emergent',
        id: run.task_id,
        project: run.project,
        title: `Task ${run.task_id}`,
        category: 'task',
        priority: 'P1',
        state: 'in progress',
        executor: run.tool,
        bundle_sha256: run.task_bundle_sha256 || undefined,
      };
    }
    onSelectRun(targetTask, run.run_id);
  };

  const filteredRuns = useMemo(() => {
    return runs.filter((r) => {
      // Search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const t = taskMap.get(r.task_id);
        const matchesRunId = r.run_id.toLowerCase().includes(q);
        const matchesTaskId = r.task_id.toLowerCase().includes(q);
        const matchesTitle = t ? t.title.toLowerCase().includes(q) : false;
        const matchesTool = r.tool.toLowerCase().includes(q);
        const matchesBranch = r.branch ? r.branch.toLowerCase().includes(q) : false;
        if (!matchesRunId && !matchesTaskId && !matchesTitle && !matchesTool && !matchesBranch) {
          return false;
        }
      }

      // Status
      if (statusFilter === 'active') {
        if (r.status !== 'running' && r.status !== 'starting') return false;
      } else if (statusFilter !== 'all') {
        if (r.status !== statusFilter) return false;
      }

      // Tool
      if (toolFilter !== 'all') {
        if (r.tool !== toolFilter) return false;
      }

      // Mode
      if (modeFilter !== 'all') {
        if (r.mode !== modeFilter) return false;
      }

      return true;
    });
  }, [runs, searchQuery, statusFilter, toolFilter, modeFilter, taskMap]);

  const activeCount = useMemo(() => {
    return runs.filter((r) => r.status === 'running' || r.status === 'starting').length;
  }, [runs]);

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

  const formatStartedTime = (started?: string) => {
    if (!started) return '-';
    try {
      const d = new Date(started);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return started;
    }
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
    <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '1.5rem' }}>
      {/* Top Banner / Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1.25rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Terminal size={24} color="#818cf8" />
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
              Agent Runs
            </h1>
          </div>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
            ({runs.length} total · <strong style={{ color: activeCount > 0 ? '#38bdf8' : '#94a3b8' }}>{activeCount} active</strong>)
          </span>
        </div>

        <button
          onClick={loadAllRuns}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.45rem 0.9rem',
            borderRadius: '0.375rem',
            border: '1px solid #334155',
            backgroundColor: '#1e293b',
            color: '#cbd5e1',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Filter Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.75rem',
          padding: '0.85rem 1.25rem',
          backgroundColor: '#1e293b',
          borderRadius: '0.5rem',
          border: '1px solid #334155',
          marginBottom: '1.25rem',
        }}
      >
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1, minWidth: '220px' }}>
          <Search size={16} color="#64748b" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search runs by task, title, tool, or run ID..."
            style={{
              width: '100%',
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#f8fafc',
              padding: '0.4rem 0.75rem',
              fontSize: '0.85rem',
            }}
          />
        </div>

        {/* Status Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Filter size={15} color="#64748b" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#f8fafc',
              padding: '0.4rem 0.65rem',
              fontSize: '0.85rem',
            }}
          >
            <option value="all">All Statuses</option>
            <option value="active">Active Only</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="lost">Lost</option>
          </select>
        </div>

        {/* Tool Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <select
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#f8fafc',
              padding: '0.4rem 0.65rem',
              fontSize: '0.85rem',
            }}
          >
            <option value="all">All Tools</option>
            <option value="kilo">kilo</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </div>

        {/* Mode Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <select
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value)}
            style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#f8fafc',
              padding: '0.4rem 0.65rem',
              fontSize: '0.85rem',
            }}
          >
            <option value="all">All Modes</option>
            <option value="execute">EXECUTE</option>
            <option value="verify">VERIFY</option>
            <option value="orchestrate">ORCHESTRATE</option>
          </select>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div
          style={{
            padding: '1rem',
            backgroundColor: '#451a1a',
            border: '1px solid #ef4444',
            borderRadius: '0.5rem',
            color: '#fca5a5',
            fontSize: '0.9rem',
            marginBottom: '1.25rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
            <AlertCircle size={18} />
            <span>Failed to load runs</span>
          </div>
          <div style={{ marginTop: '0.4rem' }}>{error}</div>
        </div>
      )}

      {/* Runs Table */}
      {loading && runs.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4rem',
            color: '#94a3b8',
            gap: '0.75rem',
          }}
        >
          <Loader2 size={24} className="spin" color="#818cf8" />
          <span>Loading agent runs...</span>
        </div>
      ) : filteredRuns.length === 0 ? (
        <div
          style={{
            padding: '3rem 1.5rem',
            textAlign: 'center',
            backgroundColor: '#1e293b',
            border: '1px dashed #334155',
            borderRadius: '0.5rem',
            color: '#94a3b8',
          }}
        >
          {runs.length === 0
            ? 'No agent runs in this workspace yet. Open a task to start a run.'
            : 'No runs match the selected filters.'}
        </div>
      ) : (
        <div
          style={{
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr
                style={{
                  backgroundColor: '#0f172a',
                  borderBottom: '1px solid #334155',
                  color: '#94a3b8',
                  textAlign: 'left',
                }}
              >
                <th style={{ padding: '0.75rem 1rem' }}>Status</th>
                <th style={{ padding: '0.75rem 1rem' }}>Task</th>
                <th style={{ padding: '0.75rem 1rem' }}>Run ID</th>
                <th style={{ padding: '0.75rem 1rem' }}>Mode</th>
                <th style={{ padding: '0.75rem 1rem' }}>Tool & Model</th>
                <th style={{ padding: '0.75rem 1rem' }}>Started / Duration</th>
                <th style={{ padding: '0.75rem 1rem' }}>Worktree / Commits</th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.map((r) => {
                const taskItem = (r.project && taskMap.get(`${r.project}/${r.task_id}`)) || taskMap.get(r.task_id);
                return (
                  <tr
                    key={`${r.project || ''}-${r.run_id}`}
                    onClick={() => handleRowClick(r)}
                    style={{
                      borderBottom: '1px solid #334155',
                      cursor: 'pointer',
                      transition: 'background-color 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = '#273549';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                    }}
                  >
                    {/* Status */}
                    <td style={{ padding: '0.75rem 1rem', whiteSpace: 'nowrap' }}>
                      {getStatusBadge(r.status)}
                    </td>

                    {/* Task */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {isCommonView && r.project && (
                          <ProjectChip project={r.project} size="xs" />
                        )}
                        <span style={{ fontWeight: 700, color: '#818cf8' }}>
                          {isCommonView && r.project ? `${r.project}/${r.task_id}` : r.task_id}
                        </span>
                        {taskItem && (
                          <span
                            style={{
                              color: '#94a3b8',
                              fontSize: '0.85rem',
                              fontWeight: 500,
                              maxWidth: '240px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={taskItem.title}
                          >
                            ({shortTitle(taskItem)})
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Run ID */}
                    <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#94a3b8', fontSize: '0.8rem' }}>
                      {r.run_id}
                    </td>

                    {/* Mode */}
                    <td style={{ padding: '0.75rem 1rem', whiteSpace: 'nowrap' }}>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          padding: '0.15rem 0.45rem',
                          borderRadius: '0.25rem',
                          backgroundColor: r.mode === 'verify' ? '#312e81' : r.mode === 'orchestrate' ? '#14532d' : '#0369a1',
                          color: '#fff',
                        }}
                      >
                        {r.mode.toUpperCase()}
                      </span>
                    </td>

                    {/* Tool & Model */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ fontWeight: 600, color: '#f8fafc' }}>{r.tool}</div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {r.profile}{r.model ? ` · ${r.model}` : ''}
                      </div>
                    </td>

                    {/* Started / Duration */}
                    <td style={{ padding: '0.75rem 1rem', whiteSpace: 'nowrap' }}>
                      <div style={{ color: '#cbd5e1' }}>{formatDuration(r.started_at, r.ended_at)}</div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {formatStartedTime(r.started_at)}
                      </div>
                    </td>

                    {/* Worktree / Commits */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {r.branch ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: '#cbd5e1', fontFamily: 'monospace' }}>
                          <GitBranch size={12} color="#818cf8" />
                          <span>{r.branch}</span>
                        </div>
                      ) : (
                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>-</span>
                      )}
                      {r.commits_after_base !== undefined && r.commits_after_base !== null && r.commits_after_base > 0 && (
                        <div style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: 600, marginTop: '0.15rem' }}>
                          +{r.commits_after_base} commit{r.commits_after_base > 1 ? 's' : ''}
                        </div>
                      )}
                    </td>

                    {/* Action */}
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRowClick(r);
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          padding: '0.3rem 0.65rem',
                          backgroundColor: '#334155',
                          border: 'none',
                          borderRadius: '0.25rem',
                          color: '#f8fafc',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        <span>Inspect</span>
                        <ExternalLink size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
