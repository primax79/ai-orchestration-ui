import React, { useState } from 'react';
import { Layers, Kanban, ListFilter, Copy, Check, FileCheck, ArrowRight, AlertTriangle, AlertCircle, Loader2 } from 'lucide-react';
import { TaskItem, TaskListResponse } from '../types';
import { TaskDetailModal } from './TaskDetailModal';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';
import { api } from '../api';

interface BacklogManagerProps {
  data: TaskListResponse | null;
  onRefresh: () => void;
}

export const BacklogManager: React.FC<BacklogManagerProps> = ({ data, onRefresh }) => {
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [syncingIndex, setSyncingIndex] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Index sync states
  const [indexOutOfSync, setIndexOutOfSync] = useState(false);
  const [syncConfirmData, setSyncConfirmData] = useState<(ConfirmDialogPreviewData & { title: string }) | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const tasks = data?.all_tasks || data?.emergent_tasks || [];
  const initiatives = data?.initiatives || [];

  // Compute stats
  const stats = {
    total: tasks.length,
    open: tasks.filter((t) => t.state === 'open').length,
    inProgress: tasks.filter((t) => t.state === 'in progress').length,
    waiting: tasks.filter((t) => t.state === 'waiting' || t.state === 'blocked').length,
    delivered: tasks.filter((t) => t.state === 'delivered').length,
    verified: tasks.filter((t) => t.state === 'verified').length,
    done: tasks.filter((t) => t.state === 'done' || t.state === 'done with a caveat').length,
  };

  const nextUpTasks = tasks.filter((t) => t.next_up === 'yes' && t.state !== 'done');

  const handleOpenSyncPreview = async () => {
    setSyncingIndex(true);
    setSyncError(null);
    try {
      const res = await api.previewSyncIndex();
      setSyncConfirmData({
        title: 'Synchronize 00-INDEX.md',
        summary: res.in_sync
          ? '`tasks/00-INDEX.md` is currently in sync with all task headers. Applying will ensure formatting is consistent.'
          : 'Task headers have changed. Synchronize `tasks/00-INDEX.md` tables with the current task state.',
        diff: res.diff || undefined,
        hash: res.hash,
        warnings: res.in_sync ? undefined : ['Syncing will update the generated sections in tasks/00-INDEX.md.'],
      });
    } catch (e: any) {
      setSyncError(`Failed to preview index sync: ${e.message}`);
    } finally {
      setSyncingIndex(false);
    }
  };

  const handleApplySync = async (hash?: string) => {
    if (!hash) {
      throw new Error('Hash is required to apply index synchronization');
    }
    await api.syncIndex(hash);
    setSyncConfirmData(null);
    setIndexOutOfSync(false);
    onRefresh();
  };

  const handleRefetchSyncPreview = async () => {
    const res = await api.previewSyncIndex();
    return {
      summary: res.in_sync
        ? '`tasks/00-INDEX.md` is currently in sync with all task headers.'
        : 'Task headers have changed. Synchronize `tasks/00-INDEX.md` tables with the current task state.',
      diff: res.diff || undefined,
      hash: res.hash,
      warnings: res.in_sync ? undefined : ['Syncing will update the generated sections in tasks/00-INDEX.md.'],
    };
  };

  const copyHandoff = (e: React.MouseEvent, text?: string, id?: string) => {
    e.stopPropagation();
    if (text && id) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const kanbanColumns: { title: string; states: string[]; color: string }[] = [
    { title: 'Open', states: ['open'], color: '#94a3b8' },
    { title: 'In Progress', states: ['in progress', 'bounced'], color: '#6366f1' },
    { title: 'Waiting / Blocked', states: ['waiting', 'blocked'], color: '#f59e0b' },
    { title: 'Delivered (Verify)', states: ['delivered'], color: '#0ea5e9' },
    { title: 'Verified', states: ['verified'], color: '#10b981' },
    { title: 'Done', states: ['done', 'done with a caveat'], color: '#475569' },
  ];

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Non-blocking index out of sync notice */}
      {indexOutOfSync && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.6rem 1rem',
          borderRadius: '0.375rem',
          backgroundColor: '#3b2505',
          border: '1px solid #f59e0b',
          color: '#fef3c7',
          fontSize: '0.85rem',
          marginBottom: '1rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertTriangle size={16} color="#f59e0b" />
            <span>Index out of sync — task state has advanced past 00-INDEX.md tables.</span>
          </div>
          <button
            onClick={handleOpenSyncPreview}
            disabled={syncingIndex}
            style={{
              padding: '0.25rem 0.75rem',
              borderRadius: '0.25rem',
              border: 'none',
              backgroundColor: '#f59e0b',
              color: '#000',
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: syncingIndex ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            {syncingIndex && <Loader2 size={13} className="spin" />}
            <span>Sync…</span>
          </button>
        </div>
      )}

      {/* Sync Error Banner */}
      {syncError && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.6rem 1rem',
          borderRadius: '0.375rem',
          backgroundColor: '#451a1a',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          fontSize: '0.85rem',
          marginBottom: '1rem',
        }}>
          <AlertCircle size={16} color="#ef4444" />
          <span>{syncError}</span>
        </div>
      )}

      {/* Top action & stat bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1.5rem',
      }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc' }}>Task Backlog & Pipeline</h1>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8', backgroundColor: '#1e293b', padding: '0.2rem 0.6rem', borderRadius: '1rem', border: '1px solid #334155' }}>
            {stats.total} total task(s)
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', backgroundColor: '#1e293b', padding: '0.2rem', borderRadius: '0.375rem', border: '1px solid #334155' }}>
            <button
              onClick={() => setViewMode('kanban')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.3rem 0.6rem',
                borderRadius: '0.25rem',
                border: 'none',
                backgroundColor: viewMode === 'kanban' ? '#4f46e5' : 'transparent',
                color: viewMode === 'kanban' ? '#fff' : '#94a3b8',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: 500,
              }}
            >
              <Kanban size={14} />
              <span>Kanban</span>
            </button>
            <button
              onClick={() => setViewMode('list')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.3rem 0.6rem',
                borderRadius: '0.25rem',
                border: 'none',
                backgroundColor: viewMode === 'list' ? '#4f46e5' : 'transparent',
                color: viewMode === 'list' ? '#fff' : '#94a3b8',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: 500,
              }}
            >
              <ListFilter size={14} />
              <span>Initiatives & List</span>
            </button>
          </div>

          <button
            onClick={handleOpenSyncPreview}
            disabled={syncingIndex}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.4rem 0.8rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#cbd5e1',
              cursor: syncingIndex ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              fontWeight: 500,
            }}
          >
            {syncingIndex ? <Loader2 size={14} className="spin" /> : <FileCheck size={14} color="#818cf8" />}
            <span>{syncingIndex ? 'Inspecting...' : 'Sync 00-INDEX.md'}</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gap: '0.75rem',
        marginBottom: '1.5rem',
      }}>
        {[
          { label: 'Open', count: stats.open, color: '#94a3b8' },
          { label: 'In Progress', count: stats.inProgress, color: '#6366f1' },
          { label: 'Waiting/Blocked', count: stats.waiting, color: '#f59e0b' },
          { label: 'Delivered', count: stats.delivered, color: '#0ea5e9' },
          { label: 'Verified', count: stats.verified, color: '#10b981' },
          { label: 'Done', count: stats.done, color: '#475569' },
        ].map((kpi) => (
          <div
            key={kpi.label}
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              padding: '0.75rem 1rem',
              borderTop: `3px solid ${kpi.color}`,
            }}
          >
            <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>{kpi.label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', marginTop: '0.2rem' }}>{kpi.count}</div>
          </div>
        ))}
      </div>

      {/* Next Up Focus Queue */}
      {nextUpTasks.length > 0 && (
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #4338ca',
          borderRadius: '0.5rem',
          padding: '1rem',
          marginBottom: '1.5rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', color: '#a5b4fc', fontSize: '0.85rem', fontWeight: 600 }}>
            <ArrowRight size={16} />
            <span>Next Up Focus Queue (Priority Execution)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
            {nextUpTasks.map((t) => (
              <div
                key={t.id}
                onClick={() => setSelectedTask(t)}
                style={{
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  padding: '0.75rem',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                    <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        padding: '0.1rem 0.3rem',
                        borderRadius: '0.2rem',
                        backgroundColor: t.priority === 'P0' ? '#ef4444' : t.priority === 'P1' ? '#f59e0b' : '#64748b',
                        color: '#fff',
                      }}>
                        {t.priority}
                      </span>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#818cf8' }}>{t.id}</span>
                    </div>
                    <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{t.category}</span>
                  </div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 500, color: '#f1f5f9', lineHeight: 1.3 }}>{t.title}</div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.4rem', borderTop: '1px solid #1e293b' }}>
                  <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Assigned: <strong style={{ color: '#cbd5e1' }}>{t.executor || 'self'}</strong></span>
                  <button
                    onClick={(e) => copyHandoff(e, t.handoff, t.id)}
                    title="Copy Handoff Prompt"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: copiedId === t.id ? '#10b981' : '#94a3b8',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.2rem',
                      fontSize: '0.7rem',
                    }}
                  >
                    {copiedId === t.id ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedId === t.id ? 'Copied' : 'Handoff'}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main View: Kanban vs List */}
      {viewMode === 'kanban' ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: '0.75rem',
          minHeight: '500px',
        }}>
          {kanbanColumns.map((col) => {
            const colTasks = tasks.filter((t) => col.states.includes(t.state));
            return (
              <div
                key={col.title}
                style={{
                  backgroundColor: '#1e293b',
                  borderRadius: '0.5rem',
                  border: '1px solid #334155',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {/* Column header */}
                <div style={{
                  padding: '0.6rem 0.8rem',
                  borderBottom: '1px solid #334155',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  backgroundColor: '#0f172a',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: col.color }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0' }}>{col.title}</span>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>{colTasks.length}</span>
                </div>

                {/* Cards list */}
                <div style={{ padding: '0.5rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {colTasks.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => setSelectedTask(t)}
                      style={{
                        backgroundColor: '#0f172a',
                        border: '1px solid #334155',
                        borderRadius: '0.375rem',
                        padding: '0.6rem',
                        cursor: 'pointer',
                        transition: 'border-color 0.15s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#6366f1')}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#334155')}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                        <span style={{
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          padding: '0.1rem 0.25rem',
                          borderRadius: '0.2rem',
                          backgroundColor: t.priority === 'P0' ? '#ef4444' : t.priority === 'P1' ? '#f59e0b' : '#64748b',
                          color: '#fff',
                        }}>
                          {t.priority}
                        </span>
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#818cf8' }}>{t.id}</span>
                      </div>
                      <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#f8fafc', lineHeight: 1.3, marginBottom: '0.4rem' }}>
                        {t.title}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: '#64748b' }}>
                        <span>{t.executor || 'self'}</span>
                        <span style={{ color: '#475569' }}>{t.category}</span>
                      </div>
                    </div>
                  ))}
                  {colTasks.length === 0 && (
                    <div style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center', padding: '1rem 0' }}>
                      No tasks
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* List & Initiatives View */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Initiatives Table */}
          {initiatives.length > 0 && (
            <div style={{ backgroundColor: '#1e293b', borderRadius: '0.5rem', border: '1px solid #334155', padding: '1rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Layers size={16} color="#818cf8" />
                <span>Planned Initiatives</span>
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '0.75rem' }}>
                {initiatives.map((init) => (
                  <div key={init.id} style={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', padding: '0.75rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#818cf8' }}>Initiative #{init.id}</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f1f5f9', marginTop: '0.2rem' }}>{init.title}</div>
                    <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.4rem' }}>{init.tasks_count} subtask(s) defined</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* All Tasks Table */}
          <div style={{ backgroundColor: '#1e293b', borderRadius: '0.5rem', border: '1px solid #334155', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ backgroundColor: '#0f172a', color: '#94a3b8', borderBottom: '1px solid #334155' }}>
                  <th style={{ padding: '0.6rem 0.8rem' }}>Priority</th>
                  <th style={{ padding: '0.6rem 0.8rem' }}>ID</th>
                  <th style={{ padding: '0.6rem 0.8rem' }}>Title</th>
                  <th style={{ padding: '0.6rem 0.8rem' }}>Category</th>
                  <th style={{ padding: '0.6rem 0.8rem' }}>State</th>
                  <th style={{ padding: '0.6rem 0.8rem' }}>Executor</th>
                  <th style={{ padding: '0.6rem 0.8rem' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setSelectedTask(t)}
                    style={{ borderBottom: '1px solid #334155', cursor: 'pointer' }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#243046')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '0.6rem 0.8rem' }}>
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        padding: '0.1rem 0.3rem',
                        borderRadius: '0.2rem',
                        backgroundColor: t.priority === 'P0' ? '#ef4444' : t.priority === 'P1' ? '#f59e0b' : '#64748b',
                        color: '#fff',
                      }}>
                        {t.priority}
                      </span>
                    </td>
                    <td style={{ padding: '0.6rem 0.8rem', fontWeight: 600, color: '#818cf8' }}>{t.id}</td>
                    <td style={{ padding: '0.6rem 0.8rem', color: '#f1f5f9', fontWeight: 500 }}>{t.title}</td>
                    <td style={{ padding: '0.6rem 0.8rem', color: '#94a3b8' }}>{t.category}</td>
                    <td style={{ padding: '0.6rem 0.8rem' }}>
                      <span style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem', borderRadius: '1rem', backgroundColor: '#334155', color: '#cbd5e1' }}>
                        {t.state}
                      </span>
                    </td>
                    <td style={{ padding: '0.6rem 0.8rem', color: '#cbd5e1' }}>{t.executor || 'self'}</td>
                    <td style={{ padding: '0.6rem 0.8rem' }}>
                      <button
                        onClick={(e) => copyHandoff(e, t.handoff, t.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: copiedId === t.id ? '#10b981' : '#94a3b8',
                          cursor: 'pointer',
                        }}
                      >
                        {copiedId === t.id ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onActionComplete={onRefresh}
          onIndexOutOfSync={() => setIndexOutOfSync(true)}
          onRequestSyncIndex={handleOpenSyncPreview}
        />
      )}

      {/* Confirm Dialog for Sync Index */}
      {syncConfirmData && (
        <ConfirmDialog
          isOpen={true}
          title={syncConfirmData.title}
          summary={syncConfirmData.summary}
          diff={syncConfirmData.diff}
          hash={syncConfirmData.hash}
          warnings={syncConfirmData.warnings}
          applyButtonText="Apply Synchronization"
          onApply={handleApplySync}
          onCancel={() => setSyncConfirmData(null)}
          onRefetchPreview={handleRefetchSyncPreview}
        />
      )}
    </div>
  );
};
