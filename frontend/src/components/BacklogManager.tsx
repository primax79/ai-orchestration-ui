import React, { useState, useEffect } from 'react';
import {
  Kanban,
  ListOrdered,
  FolderTree,
  GanttChart,
  Copy,
  Check,
  FileCheck,
  ArrowRight,
  AlertTriangle,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
} from 'lucide-react';
import { TaskItem, TaskListResponse, TaskState, SharedFilterState, WorkspaceProjectInfo } from '../types';
import { TaskDetailModal } from './TaskDetailModal';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';
import { TimelineView } from './TimelineView';
import { TaskTreeView } from './TaskTreeView';
import { KindBadge } from './KindBadge';
import { LabelList } from './LabelChip';
import { MicrotaskQuickAdd } from './MicrotaskQuickAdd';
import { SharedFilterBar, getStoredSharedFilters, matchTaskFilters } from './SharedFilterBar';
import {
  ProjectChip,
  ConditionalBadge,
  PlacementWarningChip,
  CoordinatesExpansionList,
  formatTaskIdentifier,
  getPlacementWarnings,
} from './ProjectBadges';
import { api, useProject } from '../api';

export type BacklogView = 'queue' | 'kanban' | 'tree' | 'timeline';

const BACKLOG_VIEW_KEY = 'ai-orch:backlog-view';
const KANBAN_SHOW_DONE_KEY = 'ai-orch:kanban-show-done';

const getStoredView = (): BacklogView => {
  try {
    const val = localStorage.getItem(BACKLOG_VIEW_KEY);
    if (val === 'queue' || val === 'kanban' || val === 'tree' || val === 'timeline') {
      return val;
    }
  } catch {
    // Ignore storage errors (private mode, sandboxed iframe, etc.)
  }
  return 'queue';
};

const TREE_STATES_KEY = 'ai-orch:tree-visible-states';
const ALL_STATES: TaskState[] = [
  'open', 'in progress', 'paused', 'bounced', 'waiting', 'blocked',
  'delivered', 'verified', 'done', 'done with a caveat', 'dropped',
];
const CLOSED_STATES: TaskState[] = ['done', 'done with a caveat', 'dropped'];
const DEFAULT_TREE_STATES = ALL_STATES.filter((st) => !CLOSED_STATES.includes(st));

const getStoredTreeStates = (): TaskState[] => {
  try {
    const raw = localStorage.getItem(TREE_STATES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((st): st is TaskState => ALL_STATES.includes(st));
      }
    }
  } catch {
    // Ignore storage/parse errors
  }
  return DEFAULT_TREE_STATES;
};

const getStoredShowDone = (): boolean => {
  try {
    return localStorage.getItem(KANBAN_SHOW_DONE_KEY) === 'true';
  } catch {
    // Ignore storage errors (private mode, sandboxed iframe, etc.)
    return false;
  }
};

interface BacklogManagerProps {
  data: TaskListResponse | null;
  onRefresh: () => void;
  isCommonView?: boolean;
  projects?: WorkspaceProjectInfo[];
  selectedProject?: string | null;
  onOpenTask?: (task: TaskItem) => void;
  onSelectCoordTarget?: (project: string, taskId: string) => void;
}

export const BacklogManager: React.FC<BacklogManagerProps> = ({
  data,
  onRefresh,
  isCommonView = false,
  projects = [],
  selectedProject = null,
  onOpenTask,
  onSelectCoordTarget,
}) => {
  const defaultProject = useProject();
  const effectiveProject = selectedProject || defaultProject;
  const [viewMode, setViewMode] = useState<BacklogView>(getStoredView);
  const [showDone, setShowDone] = useState<boolean>(getStoredShowDone);
  const [treeStates, setTreeStates] = useState<TaskState[]>(getStoredTreeStates);
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [syncingIndex, setSyncingIndex] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Index sync states
  const [indexOutOfSync, setIndexOutOfSync] = useState(false);
  const [syncConfirmData, setSyncConfirmData] = useState<(ConfirmDialogPreviewData & { title: string }) | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [sharedFilters, setSharedFilters] = useState<SharedFilterState>(getStoredSharedFilters);

  const tasks = data?.all_tasks || data?.emergent_tasks || [];

  const handleOpenTaskModal = (t: TaskItem) => {
    if (onOpenTask) {
      onOpenTask(t);
    }
    setSelectedTask(t);
  };

  useEffect(() => {
    if (selectedTask && data?.all_tasks) {
      const updated = data.all_tasks.find(
        (t) => t.id === selectedTask.id && (!selectedTask.project || t.project === selectedTask.project)
      );
      if (updated && updated.state !== selectedTask.state) {
        setSelectedTask(updated);
      }
    }
  }, [data, selectedTask]);

  const handleViewChange = (newView: BacklogView) => {
    setViewMode(newView);
    try {
      localStorage.setItem(BACKLOG_VIEW_KEY, newView);
    } catch {
      // Ignore storage errors
    }
  };

  const isClosedState = (state: string) => {
    return state === 'done' || state === 'done with a caveat' || state === 'dropped';
  };

  // Compute stats
  const stats = {
    total: tasks.length,
    open: tasks.filter((t) => t.state === 'open').length,
    inProgress: tasks.filter((t) => t.state === 'in progress').length,
    waiting: tasks.filter((t) => t.state === 'waiting' || t.state === 'blocked').length,
    delivered: tasks.filter((t) => t.state === 'delivered').length,
    verified: tasks.filter((t) => t.state === 'verified').length,
    done: tasks.filter((t) => isClosedState(t.state) || t.is_done).length,
    conditional: tasks.filter((t) => t.conditional).length,
  };

  // Filter tasks based on sharedFilters
  const filteredTasks = tasks.filter((t) => matchTaskFilters(t, sharedFilters));

  // Queue tasks: in project view emergent only with next_up === 'yes'; in common view, next_up === 'yes' if present, else all open/active tasks
  const queueTasks = (() => {
    const base = tasks.filter((t) => {
      if (isClosedState(t.state) || t.is_done) return false;
      if (!matchTaskFilters(t, sharedFilters)) return false;
      return true;
    });
    const nextUpCandidates = base.filter((t) => {
      if (!isCommonView && t.kind !== 'emergent' && t.category !== 'micro') return false;
      if (!isCommonView && /^\d+\.\d+/.test(t.id)) return false;
      if (t.next_up !== 'yes') return false;
      return true;
    });
    const listToSort = isCommonView && nextUpCandidates.length === 0 ? base : nextUpCandidates;
    return listToSort
      .sort((a, b) => {
        const pOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
        const pA = pOrder[a.priority] ?? 99;
        const pB = pOrder[b.priority] ?? 99;
        if (pA !== pB) return pA - pB;
        return (a.qualified_id || a.id).localeCompare(b.qualified_id || b.id);
      })
      .slice(0, isCommonView ? 100 : 5);
  })();

  const handleOpenSyncPreview = async () => {
    setSyncingIndex(true);
    setSyncError(null);
    try {
      const res = await api.previewSyncIndex(effectiveProject);
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
    await api.syncIndex(hash, effectiveProject);
    setSyncConfirmData(null);
    setIndexOutOfSync(false);
    onRefresh();
  };

  const handleRefetchSyncPreview = async () => {
    const res = await api.previewSyncIndex(effectiveProject);
    return {
      summary: res.in_sync
        ? '`tasks/00-INDEX.md` is currently in sync with all task headers.'
        : 'Task headers have changed. Synchronize `tasks/00-INDEX.md` tables with the current task state.',
      diff: res.diff || undefined,
      hash: res.hash,
      warnings: res.in_sync ? undefined : ['Syncing will update the generated sections in tasks/00-INDEX.md.'],
    };
  };

  const copyHandoff = (e: React.MouseEvent, text?: string, id?: string, title?: string) => {
    e.stopPropagation();
    if (id) {
      const content = text || `Execute task ${id}: ${title || ''}`;
      navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const updateTreeStates = (next: TaskState[]) => {
    setTreeStates(next);
    try {
      localStorage.setItem(TREE_STATES_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage errors
    }
  };

  const handleToggleShowDone = () => {
    setShowDone((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(KANBAN_SHOW_DONE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  // Kanban task partitions
  const deliveredCards = filteredTasks.filter((t) => t.state === 'delivered');
  const verifiedCards = filteredTasks.filter((t) => t.state === 'verified');
  const doneCards = filteredTasks.filter((t) => t.state === 'done' || t.state === 'done with a caveat');
  const droppedCards = filteredTasks.filter((t) => t.state === 'dropped');
  const closedCardsCount = doneCards.length + droppedCards.length;

  type KanbanColumnDef =
    | {
        id: string;
        title: string;
        color: string;
        states: string[];
        isSplit?: false;
      }
    | {
        id: string;
        title: string;
        color: string;
        isSplit: true;
      };

  const visibleColumns: KanbanColumnDef[] = [
    // Waiting first: tasks blocked on a decision are the ones that need the owner.
    { id: 'waiting_blocked', title: 'Waiting / Paused / Blocked', states: ['waiting', 'paused', 'blocked'], color: '#f59e0b' },
    { id: 'open', title: 'Open', states: ['open'], color: '#94a3b8' },
    { id: 'in_progress', title: 'In Progress', states: ['in progress', 'bounced'], color: '#6366f1' },
    { id: 'delivered_verified', title: 'Delivered / Verified', color: '#0ea5e9', isSplit: true },
  ];

  if (showDone) {
    visibleColumns.push({
      id: 'done',
      title: 'Done',
      states: ['done', 'done with a caveat'],
      color: '#475569',
    });
    if (droppedCards.length > 0) {
      visibleColumns.push({
        id: 'dropped',
        title: 'Dropped',
        states: ['dropped'],
        color: '#64748b',
      });
    }
  }

  const isSubWorkspaceReadOnly =
    !isCommonView &&
    selectedProject !== null &&
    projects.some((p) => p.id === selectedProject && p.kind === 'sub_workspace');

  const defaultCreateProject =
    sharedFilters.projects && sharedFilters.projects.length === 1
      ? sharedFilters.projects[0]
      : selectedProject;

  const availableLabels = Array.from(
    new Set(tasks.flatMap((t) => t.labels || []))
  );

  const renderCardListWithGrouping = (list: TaskItem[], renderFn: (t: TaskItem) => React.ReactNode) => {
    if (!isCommonView || !sharedFilters.groupByProject) {
      return list.map(renderFn);
    }
    const byProject: Record<string, TaskItem[]> = {};
    list.forEach((t) => {
      const p = t.project || '_workspace';
      if (!byProject[p]) byProject[p] = [];
      byProject[p].push(t);
    });
    return Object.keys(byProject)
      .sort()
      .map((projId) => (
        <div key={projId} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.15rem 0.25rem' }}>
            <ProjectChip project={projId} size="xs" />
            <span style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: 600 }}>
              ({byProject[projId].length})
            </span>
          </div>
          {byProject[projId].map(renderFn)}
        </div>
      ));
  };

  const renderKanbanCard = (t: TaskItem) => {
    const warnings = getPlacementWarnings(t);
    const idDisplay = isCommonView ? formatTaskIdentifier(t, true) : t.id;
    return (
      <div
        key={t.qualified_id || `${t.project || ''}-${t.id}`}
        onClick={() => handleOpenTaskModal(t)}
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem', gap: '0.3rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
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
            {isCommonView && t.project && (
              <ProjectChip project={t.project} size="xs" />
            )}
            {t.category === 'micro' && (
              <span style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                backgroundColor: '#27272a',
                color: '#a1a1aa',
                padding: '0.05rem 0.25rem',
                borderRadius: '0.2rem',
                textTransform: 'uppercase',
              }}>
                micro
              </span>
            )}
            {t.fields?.kind?.value ? (
              <KindBadge kind={String(t.fields.kind.value)} size={11} />
            ) : t.kind && t.kind !== 'emergent' && t.kind !== 'initiative_task' && t.kind !== 'initiative' ? (
              <KindBadge kind={t.kind} size={11} />
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden' }}>
            <span
              style={{
                fontSize: '0.7rem',
                fontWeight: 600,
                color: '#818cf8',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={idDisplay}
            >
              {idDisplay}
            </span>
          </div>
        </div>
        <div style={{
          fontSize: '0.8rem',
          fontWeight: 500,
          color: '#f8fafc',
          lineHeight: 1.3,
          marginBottom: '0.4rem',
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
        }}>
          {t.title}
        </div>
        {(t.conditional || warnings.length > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.4rem' }}>
            <ConditionalBadge conditional={t.conditional} conditions={t.conditions} size="xs" />
            <PlacementWarningChip warnings={warnings} size="xs" />
          </div>
        )}
        {t.labels && t.labels.length > 0 && (
          <div style={{ marginBottom: '0.4rem' }}>
            <LabelList labels={t.labels} maxVisible={3} size="xs" />
          </div>
        )}
        {t.project === '_workspace' && (t.coordinates?.length || (t as any).coordinates_refs?.length) ? (
          <div style={{ marginBottom: '0.4rem' }}>
            <CoordinatesExpansionList
              coordinates={t.coordinates}
              task={t}
              onSelectTarget={onSelectCoordTarget}
              compact={true}
            />
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: '#64748b' }}>
          <span>{t.executor || 'self'}</span>
          <span style={{ color: '#475569' }}>{t.category}</span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '1.25rem 1.5rem', maxWidth: '1400px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
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
        flexWrap: 'wrap',
        gap: '0.75rem',
        marginBottom: '1rem',
      }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc' }}>Task Backlog & Pipeline</h1>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8', backgroundColor: '#1e293b', padding: '0.2rem 0.6rem', borderRadius: '1rem', border: '1px solid #334155' }}>
            {stats.total} total task(s)
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* View switcher */}
          <div style={{ display: 'flex', backgroundColor: '#1e293b', padding: '0.2rem', borderRadius: '0.375rem', border: '1px solid #334155' }}>
            {[
              { id: 'queue' as const, label: 'Queue', icon: ListOrdered },
              { id: 'kanban' as const, label: 'Kanban', icon: Kanban },
              { id: 'tree' as const, label: 'Tree', icon: FolderTree },
              { id: 'timeline' as const, label: 'Timeline', icon: GanttChart },
            ].map((view) => {
              const Icon = view.icon;
              const isActive = viewMode === view.id;
              return (
                <button
                  key={view.id}
                  onClick={() => handleViewChange(view.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.3rem 0.65rem',
                    borderRadius: '0.25rem',
                    border: 'none',
                    backgroundColor: isActive ? '#4f46e5' : 'transparent',
                    color: isActive ? '#fff' : '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <Icon size={14} />
                  <span>{view.label}</span>
                </button>
              );
            })}
          </div>

          <MicrotaskQuickAdd
            onCreated={onRefresh}
            isCommonView={isCommonView}
            projects={projects}
            defaultProject={defaultCreateProject}
            disabled={isSubWorkspaceReadOnly}
          />

          {!isCommonView && (
            <button
              onClick={handleOpenSyncPreview}
              disabled={syncingIndex || isSubWorkspaceReadOnly}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.8rem',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#cbd5e1',
                cursor: syncingIndex || isSubWorkspaceReadOnly ? 'not-allowed' : 'pointer',
                fontSize: '0.85rem',
                fontWeight: 500,
              }}
            >
              {syncingIndex ? <Loader2 size={14} className="spin" /> : <FileCheck size={14} color="#818cf8" />}
              <span>{syncingIndex ? 'Inspecting...' : 'Sync 00-INDEX.md'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Compact KPI strip */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        padding: '0.4rem 0.75rem',
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.375rem',
        marginBottom: '1.25rem',
        flexWrap: 'wrap',
      }}>
        {[
          { label: 'Open', count: stats.open, color: '#94a3b8' },
          { label: 'In Progress', count: stats.inProgress, color: '#6366f1' },
          { label: 'Waiting/Blocked', count: stats.waiting, color: '#f59e0b' },
          { label: 'Delivered', count: stats.delivered, color: '#0ea5e9' },
          { label: 'Verified', count: stats.verified, color: '#10b981' },
          ...(stats.conditional > 0 ? [{ label: 'Conditional', count: stats.conditional, color: '#f59e0b' }] : []),
          { label: 'Done', count: stats.done, color: '#475569' },
        ].map((kpi, idx, arr) => (
          <React.Fragment key={kpi.label}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              fontSize: '0.8rem',
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: kpi.color, flexShrink: 0 }} />
              <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>{kpi.label}:</span>
              <strong style={{ color: '#f8fafc', fontWeight: 700, fontSize: '0.85rem' }}>{kpi.count}</strong>
            </div>
            {idx < arr.length - 1 && (
              <span style={{ color: '#334155', margin: '0 0.15rem' }}>•</span>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Shared Filter Bar across views */}
      <SharedFilterBar
        filters={sharedFilters}
        onChange={setSharedFilters}
        availableLabels={availableLabels}
        availableProjects={projects}
        showProjectControls={isCommonView}
        showGroupByLabel={viewMode === 'tree'}
      />

      {/* Main Backlog View */}
      {viewMode === 'queue' && (
        <div>
          <div style={{
            fontSize: '0.85rem',
            color: '#94a3b8',
            marginBottom: '0.75rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}>
            <ArrowRight size={14} color="#818cf8" style={{ flexShrink: 0 }} />
            <span>
              {isCommonView
                ? 'Active tasks across workspace projects (ordered by priority).'
                : 'What to start next: emergent tasks marked next-up (initiative tasks join once the timeline engine lands).'}
            </span>
          </div>

          {queueTasks.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {renderCardListWithGrouping(queueTasks, (t) => {
                const warnings = getPlacementWarnings(t);
                const idDisplay = isCommonView ? formatTaskIdentifier(t, true) : t.id;
                return (
                  <div
                    key={t.qualified_id || `${t.project || ''}-${t.id}`}
                    onClick={() => handleOpenTaskModal(t)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.35rem',
                      padding: '0.6rem 0.85rem',
                      backgroundColor: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: '0.375rem',
                      cursor: 'pointer',
                      transition: 'border-color 0.15s ease, background-color 0.15s ease',
                      boxSizing: 'border-box',
                      width: '100%',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = '#6366f1';
                      e.currentTarget.style.backgroundColor = '#243046';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = '#334155';
                      e.currentTarget.style.backgroundColor = '#1e293b';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', flexWrap: 'wrap' }}>
                      {/* Project Chip + ID + Short Title + Micro + Kind */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                        {isCommonView && t.project && (
                          <ProjectChip project={t.project} size="xs" />
                        )}
                        <span
                          style={{
                            fontSize: '0.8rem',
                            fontWeight: 700,
                            color: '#818cf8',
                            fontFamily: 'monospace',
                            minWidth: '42px',
                          }}
                        >
                          {idDisplay}
                        </span>
                        {t.category === 'micro' && (
                          <span
                            style={{
                              fontSize: '0.6rem',
                              fontWeight: 700,
                              backgroundColor: '#27272a',
                              color: '#a1a1aa',
                              padding: '0.05rem 0.25rem',
                              borderRadius: '0.2rem',
                              textTransform: 'uppercase',
                            }}
                          >
                            micro
                          </span>
                        )}
                        {t.fields?.kind?.value ? (
                          <KindBadge kind={String(t.fields.kind.value)} size={11} />
                        ) : t.kind && t.kind !== 'emergent' && t.kind !== 'initiative_task' && t.kind !== 'initiative' ? (
                          <KindBadge kind={t.kind} size={11} />
                        ) : null}
                      </div>

                      {/* Title */}
                      <span
                        style={{
                          fontSize: '0.85rem',
                          fontWeight: 500,
                          color: '#f8fafc',
                          flex: 1,
                          minWidth: '180px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={t.title}
                      >
                        {t.title}
                      </span>

                      <ConditionalBadge conditional={t.conditional} conditions={t.conditions} size="xs" />
                      <PlacementWarningChip warnings={warnings} size="xs" />

                      {/* Labels if present */}
                      {t.labels && t.labels.length > 0 && (
                        <LabelList labels={t.labels} maxVisible={2} size="xs" />
                      )}

                      {/* Priority chip */}
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '0.15rem 0.4rem',
                          borderRadius: '0.2rem',
                          backgroundColor:
                            t.priority === 'P0' ? '#ef4444' : t.priority === 'P1' ? '#f59e0b' : '#64748b',
                          color: '#fff',
                          flexShrink: 0,
                        }}
                      >
                        {t.priority}
                      </span>

                      {/* Size chip if present */}
                      {t.size && (
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            padding: '0.1rem 0.35rem',
                            borderRadius: '0.2rem',
                            backgroundColor: '#0f172a',
                            border: '1px solid #475569',
                            color: '#cbd5e1',
                            flexShrink: 0,
                          }}
                        >
                          {t.size}
                        </span>
                      )}

                      {/* Executor */}
                      <span
                        style={{
                          fontSize: '0.75rem',
                          color: '#94a3b8',
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                      >
                        <span style={{ color: '#64748b' }}>Assigned:</span>
                        <strong style={{ color: '#cbd5e1', fontWeight: 600 }}>{t.executor || 'self'}</strong>
                      </span>

                      {/* Handoff copy button */}
                      <button
                        onClick={(e) => copyHandoff(e, t.handoff, t.qualified_id || t.id, t.title)}
                        title="Copy Handoff Prompt"
                        style={{
                          background: '#0f172a',
                          border: '1px solid #334155',
                          borderRadius: '0.25rem',
                          padding: '0.25rem 0.5rem',
                          color: copiedId === (t.qualified_id || t.id) ? '#10b981' : '#cbd5e1',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          fontSize: '0.75rem',
                          flexShrink: 0,
                          fontWeight: 500,
                        }}
                      >
                        {copiedId === (t.qualified_id || t.id) ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
                        <span>{copiedId === (t.qualified_id || t.id) ? 'Copied' : 'Handoff'}</span>
                      </button>
                    </div>

                    {t.project === '_workspace' && (t.coordinates?.length || (t as any).coordinates_refs?.length) ? (
                      <CoordinatesExpansionList
                        coordinates={t.coordinates}
                        task={t}
                        onSelectTarget={onSelectCoordTarget}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{
              backgroundColor: '#1e293b',
              border: '1px dashed #334155',
              borderRadius: '0.5rem',
              padding: '3rem 1.5rem',
              textAlign: 'center',
              color: '#94a3b8',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.75rem',
            }}>
              <ListOrdered size={32} color="#64748b" />
              <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9' }}>
                No emergent tasks marked next-up
              </div>
              <div style={{ fontSize: '0.85rem', color: '#94a3b8', maxWidth: '480px', lineHeight: 1.4 }}>
                To queue a task here, set <code style={{ backgroundColor: '#0f172a', padding: '0.1rem 0.35rem', borderRadius: '0.2rem', color: '#a5b4fc', fontSize: '0.8rem' }}>**Next up:** yes</code> in its markdown header, or open the task details to flag it.
              </div>
            </div>
          )}
        </div>
      )}

      {viewMode === 'kanban' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%' }}>
          {/* Kanban toolbar */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.5rem',
          }}>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Kanban size={14} color="#818cf8" />
              <span>Workflow board ({visibleColumns.length} columns)</span>
            </div>

            <button
              onClick={handleToggleShowDone}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.3rem 0.65rem',
                backgroundColor: showDone ? '#334155' : '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: showDone ? '#f8fafc' : '#cbd5e1',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: 500,
                transition: 'all 0.15s ease',
              }}
            >
              {showDone ? <EyeOff size={14} color="#94a3b8" /> : <Eye size={14} color="#94a3b8" />}
              <span>{showDone ? `Hide done (${closedCardsCount})` : `Show done (${closedCardsCount})`}</span>
            </button>
          </div>

          {/* Kanban grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${visibleColumns.length}, minmax(0, 1fr))`,
            gap: '0.75rem',
            minHeight: '500px',
            width: '100%',
            boxSizing: 'border-box',
          }}>
            {visibleColumns.map((col) => {
              if (col.isSplit) {
                const totalSplitCount = deliveredCards.length + verifiedCards.length;
                return (
                  <div
                    key={col.id}
                    style={{
                      backgroundColor: '#1e293b',
                      borderRadius: '0.5rem',
                      border: '1px solid #334155',
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden',
                      minWidth: 0,
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
                      minWidth: 0,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: col.color, flexShrink: 0 }} />
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {col.title}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, flexShrink: 0, marginLeft: '0.25rem' }}>
                        {totalSplitCount}
                      </span>
                    </div>

                    {/* Split cards list */}
                    <div style={{ padding: '0.5rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                      {/* Delivered sub-section */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        <div style={{
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          color: '#94a3b8',
                          padding: '0.1rem 0.2rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          Delivered — needs verification ({deliveredCards.length})
                        </div>
                        {deliveredCards.length > 0 ? (
                          renderCardListWithGrouping(deliveredCards, renderKanbanCard)
                        ) : (
                          <div style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center', padding: '0.5rem 0', fontStyle: 'italic' }}>
                            No delivered tasks
                          </div>
                        )}
                      </div>

                      {/* Thin divider */}
                      <div style={{ height: '1px', backgroundColor: '#334155', margin: '0.6rem 0', flexShrink: 0 }} />

                      {/* Verified sub-section */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        <div style={{
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          color: '#94a3b8',
                          padding: '0.1rem 0.2rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          Verified — ready to close ({verifiedCards.length})
                        </div>
                        {verifiedCards.length > 0 ? (
                          renderCardListWithGrouping(verifiedCards, renderKanbanCard)
                        ) : (
                          <div style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center', padding: '0.5rem 0', fontStyle: 'italic' }}>
                            No verified tasks
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              const colTasks = filteredTasks.filter((t) => col.states.includes(t.state));
              return (
                <div
                  key={col.id}
                  style={{
                    backgroundColor: '#1e293b',
                    borderRadius: '0.5rem',
                    border: '1px solid #334155',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    minWidth: 0,
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
                    minWidth: 0,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: col.color, flexShrink: 0 }} />
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {col.title}
                      </span>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, flexShrink: 0, marginLeft: '0.25rem' }}>
                      {colTasks.length}
                    </span>
                  </div>

                  {/* Cards list */}
                  <div style={{ padding: '0.5rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {renderCardListWithGrouping(colTasks, renderKanbanCard)}
                    {colTasks.length === 0 && (
                      <div style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center', padding: '1rem 0', fontStyle: 'italic' }}>
                        No tasks
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tree: collapsible task tree at any depth */}
      {viewMode === 'tree' && (
        <TaskTreeView
          data={data}
          visibleStates={treeStates}
          onVisibleStatesChange={updateTreeStates}
          onSelectTask={handleOpenTaskModal}
          onRefresh={onRefresh}
          sharedFilters={sharedFilters}
          isCommonView={isCommonView}
          onSelectCoordTarget={onSelectCoordTarget}
        />
      )}

      {viewMode === 'timeline' && (
        <TimelineView
          onSelectTask={handleOpenTaskModal}
          onRefresh={onRefresh}
          isCommonView={isCommonView}
          projects={projects}
          tasks={tasks}
          sharedFilters={sharedFilters}
        />
      )}

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          tree={data?.tree}
          onSelectTask={handleOpenTaskModal}
          onSelectCoordTarget={onSelectCoordTarget}
          onClose={() => {
            setSelectedTask(null);
          }}
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
