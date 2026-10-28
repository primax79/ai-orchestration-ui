import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { BacklogManager } from './components/BacklogManager';
import { DecisionsTab } from './components/DecisionsTab';
import { InboxPanel } from './components/InboxPanel';
import { RunsTab } from './components/RunsTab';
import { TaskDetailModal } from './components/TaskDetailModal';
import { SkillInstaller } from './components/SkillInstaller';
import { EnvironmentDoctor } from './components/EnvironmentDoctor';
import { OrchestrationConfigurator } from './components/OrchestrationConfigurator';
import { UseCasesManager } from './components/UseCasesManager';
import { TriggersPage } from './components/TriggersPage';
import { EventStreamPanel } from './components/EventStreamPanel';
import { OrchestratorChatPanel } from './components/OrchestratorChatPanel';
import {
  UnregisteredWorkspaceBanner,
  WorkspaceDashboardStrip,
  registerProjectColorOrder,
} from './components/ProjectBadges';
import { api, ProjectContext } from './api';
import {
  WorkspaceInfo,
  TaskListResponse,
  EnvStatusResponse,
  OrchestrationConfigResponse,
  TaskItem,
  TaskState,
  Priority,
} from './types';

const SELECTED_PROJECT_KEY = 'ai-orch:selected-project';
const INCLUDE_CLOSED_KEY = 'ai-orch:common-include-closed';
const ACTIVE_STATES = ['open', 'in progress', 'waiting', 'blocked', 'paused', 'bounced', 'delivered'];
const CLOSED_COUNT_KEYS = ['verified', 'done', 'dropped'];

function readInitialProjectSelection(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const urlProj = params.get('project');
    if (urlProj && urlProj.trim()) {
      return urlProj === '__all__' ? null : urlProj.trim();
    }
    const stored = localStorage.getItem(SELECTED_PROJECT_KEY);
    if (stored && stored !== '__all__') {
      return stored.trim() || null;
    }
  } catch {
    // ignore
  }
  return null;
}

function persistProjectSelection(projectId: string | null): void {
  try {
    if (projectId) {
      localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
    } else {
      localStorage.setItem(SELECTED_PROJECT_KEY, '__all__');
    }
    const url = new URL(window.location.href);
    if (projectId) {
      url.searchParams.set('project', projectId);
    } else {
      url.searchParams.delete('project');
    }
    window.history.replaceState({}, '', url.toString());
  } catch {
    // ignore
  }
}

const PanelErrorBanner: React.FC<{ title: string; error: string; onRetry: () => void }> = ({
  title,
  error,
  onRetry,
}) => (
  <div
    style={{
      maxWidth: '1200px',
      margin: '1.5rem auto',
      padding: '1rem 1.25rem',
      borderRadius: '0.5rem',
      backgroundColor: '#451a1a',
      border: '1px solid #ef4444',
      color: '#fca5a5',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <AlertCircle size={20} color="#ef4444" />
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#f8fafc' }}>{title}</div>
        <div style={{ fontSize: '0.8rem', color: '#fca5a5', marginTop: '0.15rem' }}>{error}</div>
      </div>
    </div>
    <button
      onClick={onRetry}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0.4rem 0.8rem',
        borderRadius: '0.375rem',
        border: 'none',
        backgroundColor: '#ef4444',
        color: '#fff',
        fontWeight: 600,
        fontSize: '0.8rem',
        cursor: 'pointer',
      }}
    >
      <RefreshCw size={13} />
      <span>Retry</span>
    </button>
  </div>
);

const PanelLoading: React.FC<{ label: string }> = ({ label }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '4rem 1.5rem',
      gap: '0.75rem',
      color: '#94a3b8',
      fontSize: '0.9rem',
    }}
  >
    <Loader2 size={24} className="spin" color="#818cf8" />
    <span>Loading {label}...</span>
  </div>
);

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'backlog' | 'decisions' | 'inbox' | 'runs' | 'orchestrator' | 'use-cases' | 'triggers' | 'events' | 'installer' | 'doctor' | 'config'>('backlog');

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(() => {
    return readInitialProjectSelection();
  });

  const validatedInitialProjectRef = useRef(false);

  // Common view: closed tasks are loaded only on request
  const [includeClosed, setIncludeClosed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(INCLUDE_CLOSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const handleIncludeClosedChange = useCallback((next: boolean) => {
    setIncludeClosed(next);
    try {
      localStorage.setItem(INCLUDE_CLOSED_KEY, String(next));
    } catch {
      // ignore
    }
  }, []);

  const projectsList = workspace?.projects || [];
  const projectsCount = projectsList.length;
  const isMultiProject = projectsCount > 1;
  const isCommonView = isMultiProject && selectedProject === null;

  const fallbackProject = useMemo(() => {
    if (projectsList.length === 0) return null;
    return projectsList.find((p) => p.id === '_workspace')?.id || projectsList[0].id;
  }, [projectsList]);

  const effectiveProject = useMemo(() => {
    if (!workspace) return selectedProject;
    if (projectsCount === 1) return projectsList[0].id;
    return selectedProject;
  }, [workspace, projectsCount, projectsList, selectedProject]);

  const handleSelectProject = useCallback((projectId: string | null) => {
    setSelectedProject(projectId);
    persistProjectSelection(projectId);
  }, []);

  const [tasksData, setTasksData] = useState<TaskListResponse | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [openQuestionsCount, setOpenQuestionsCount] = useState<number>(0);
  const [questionsRefreshKey, setQuestionsRefreshKey] = useState<number>(0);

  const [inboxBadgeCount, setInboxBadgeCount] = useState<number>(0);
  const [inboxRefreshKey, setInboxRefreshKey] = useState<number>(0);

  const [activeRunsCount, setActiveRunsCount] = useState<number>(0);
  const [runsRefreshKey, setRunsRefreshKey] = useState<number>(0);
  const [modalTaskAndRun, setModalTaskAndRun] = useState<{ task: TaskItem; runId?: string } | null>(null);

  const [envStatus, setEnvStatus] = useState<EnvStatusResponse | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);

  const [configData, setConfigData] = useState<OrchestrationConfigResponse | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const [isWsConnected, setIsWsConnected] = useState(false);

  // Own action timestamps to prevent duplicate reload loops after mutating actions
  const ownActionTimestamps = useRef<{ [area: string]: number }>({});
  const recordOwnAction = (area: string) => {
    ownActionTimestamps.current[area] = Date.now();
  };

  const loadWorkspace = useCallback(async (): Promise<WorkspaceInfo | null> => {
    try {
      const ws = await api.getWorkspace();
      const projs = ws?.projects || [];
      if (projs.length > 0) {
        registerProjectColorOrder(projs.map((p) => p.id));
      }
      if (!validatedInitialProjectRef.current && projs.length > 0) {
        validatedInitialProjectRef.current = true;
        if (projs.length > 1) {
          setSelectedProject((prev) => {
            if (prev && !projs.some((p) => p.id === prev)) {
              persistProjectSelection(null);
              return null;
            }
            return prev;
          });
        }
      }
      setWorkspace(ws);
      return ws;
    } catch (e: any) {
      console.error('Workspace load error:', e);
      return null;
    }
  }, []);

  const loadTasks = useCallback(async () => {
    if (!workspace) return;
    setTasksLoading(true);
    setTasksError(null);
    try {
      if (isCommonView) {
        const agg = await api.getAllWorkspaceTasks(includeClosed ? undefined : { state: ACTIVE_STATES });
        const rawList = agg.tasks || agg.items || [];
        const normalized: TaskItem[] = rawList.map((r: any) => {
          const st = (r.state || r.canonical_state || 'open') as TaskState;
          const isClosed = st === 'done' || st === 'done with a caveat' || st === 'dropped';
          return {
            ...r,
            id: r.id,
            project: r.project,
            qualified_id: r.qualified_id || (r.project ? `${r.project}/${r.id}` : r.id),
            title: r.title || r.short || r.short_title || r.id,
            short_title: r.short_title || r.short || undefined,
            kind: r.kind || (String(r.id).startsWith('T') ? 'emergent' : 'initiative_task'),
            category: r.category || r.project || 'general',
            priority: (r.priority || 'P2') as Priority,
            state: st,
            executor: r.executor || 'self',
            is_done: isClosed,
          };
        });
        const data: TaskListResponse = {
          ok: true,
          tasks_dir: workspace?.workspace_path || '',
          emergent_tasks: normalized.filter((t) => t.kind === 'emergent' || String(t.id).startsWith('T')),
          initiatives: [],
          all_tasks: normalized,
          tree: {},
        };
        setTasksData(data);
        setModalTaskAndRun((prev) => {
          if (!prev) return null;
          const updated = normalized.find(
            (t: TaskItem) => t.id === prev.task.id && (!prev.task.project || t.project === prev.task.project)
          );
          return updated ? { ...prev, task: updated } : prev;
        });
      } else {
        const targetProj = effectiveProject || fallbackProject || undefined;
        const data = await api.getTasks(undefined, targetProj);
        const tagProj = targetProj;
        if (tagProj && data) {
          if (data.all_tasks) {
            data.all_tasks = data.all_tasks.map((t) => ({ ...t, project: t.project || tagProj }));
          }
          if (data.emergent_tasks) {
            data.emergent_tasks = data.emergent_tasks.map((t) => ({ ...t, project: t.project || tagProj }));
          }
          if (data.tree) {
            Object.values(data.tree).forEach((node) => {
              if (!node.project) node.project = tagProj;
            });
          }
        }
        setTasksData(data);
        if (data && data.all_tasks) {
          const allTasks = data.all_tasks;
          setModalTaskAndRun((prev) => {
            if (!prev) return null;
            const updated = allTasks.find((t: TaskItem) => t.id === prev.task.id);
            return updated ? { ...prev, task: updated } : prev;
          });
        }
      }
    } catch (e: any) {
      setTasksError(e.message || String(e));
    } finally {
      setTasksLoading(false);
    }
  }, [workspace, isCommonView, effectiveProject, fallbackProject, includeClosed]);

  const closedTasksCount = useMemo(
    () =>
      projectsList.reduce(
        (sum, p) => sum + CLOSED_COUNT_KEYS.reduce((s, k) => s + ((p.counts as Record<string, number> | undefined)?.[k] || 0), 0),
        0
      ),
    [projectsList]
  );

  const loadQuestionsCount = useCallback(async () => {
    if (!workspace) return;
    try {
      const targetProj = effectiveProject || fallbackProject;
      const res = isCommonView
        ? await api.getWorkspaceQuestions({ status: 'open' })
        : await api.getQuestions({ status: 'open' }, targetProj);
      if (res && res.questions) {
        setOpenQuestionsCount(res.questions.length);
      }
    } catch (e: any) {
      console.error('Failed to load open questions count:', e);
    }
  }, [workspace, isCommonView, effectiveProject, fallbackProject]);

  const loadActiveRunsCount = useCallback(async () => {
    if (!workspace) return;
    try {
      const targetProj = effectiveProject || fallbackProject;
      const res = isCommonView
        ? await api.getWorkspaceRuns({ active: true })
        : await api.listRuns({ active: true }, targetProj);
      if (res && res.runs) {
        setActiveRunsCount(res.runs.length);
      }
    } catch (e: any) {
      console.error('Failed to load active runs count:', e);
    }
  }, [workspace, isCommonView, effectiveProject, fallbackProject]);

  const loadInboxNotesCount = useCallback(async () => {
    if (!workspace) return;
    try {
      const targetProj = effectiveProject || fallbackProject;
      const res = isCommonView
        ? await api.getWorkspaceInbox()
        : await api.listInboxNotes(undefined, targetProj);
      if (res && res.notes) {
        const count = res.notes.filter(
          (n) => (n.status || 'draft').toLowerCase() === 'draft' || (n.status || '').toLowerCase() === 'ready'
        ).length;
        setInboxBadgeCount(count);
      }
    } catch (e: any) {
      console.error('Failed to load inbox notes count:', e);
    }
  }, [workspace, isCommonView, effectiveProject, fallbackProject]);

  const loadEnv = useCallback(async () => {
    if (!workspace) return;
    setEnvLoading(true);
    setEnvError(null);
    try {
      const targetProj = effectiveProject || fallbackProject;
      const data = await api.getEnvStatus(targetProj);
      setEnvStatus(data);
    } catch (e: any) {
      setEnvError(e.message || String(e));
    } finally {
      setEnvLoading(false);
    }
  }, [workspace, effectiveProject, fallbackProject]);

  const loadConfig = useCallback(async () => {
    if (!workspace) return;
    setConfigLoading(true);
    setConfigError(null);
    try {
      const targetProj = effectiveProject || fallbackProject;
      const data = await api.getConfig(targetProj);
      setConfigData(data);
    } catch (e: any) {
      setConfigError(e.message || String(e));
    } finally {
      setConfigLoading(false);
    }
  }, [workspace, effectiveProject, fallbackProject]);

  const refreshAll = useCallback(async () => {
    await loadWorkspace();
    loadTasks();
    loadQuestionsCount();
    setQuestionsRefreshKey((k) => k + 1);
    loadActiveRunsCount();
    setRunsRefreshKey((k) => k + 1);
    loadInboxNotesCount();
    setInboxRefreshKey((k) => k + 1);
    loadEnv();
    loadConfig();
  }, [loadWorkspace, loadTasks, loadQuestionsCount, loadActiveRunsCount, loadInboxNotesCount, loadEnv, loadConfig]);

  // Keep latest loaders in a ref for WebSocket debounced reload so WS effect only runs once on mount
  const reloadHandlersRef = useRef({
    loadWorkspace,
    loadTasks,
    loadQuestionsCount,
    loadActiveRunsCount,
    loadInboxNotesCount,
    loadEnv,
    loadConfig,
    refreshAll,
  });
  useEffect(() => {
    reloadHandlersRef.current = {
      loadWorkspace,
      loadTasks,
      loadQuestionsCount,
      loadActiveRunsCount,
      loadInboxNotesCount,
      loadEnv,
      loadConfig,
      refreshAll,
    };
  });

  // Debounced area reloading (300 ms)
  const pendingAreas = useRef<Set<string>>(new Set());
  const debounceTimer = useRef<any>(null);

  const triggerDebouncedReload = useCallback((areas: string[]) => {
    areas.forEach((a) => pendingAreas.current.add(a));
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      const toReload = new Set(pendingAreas.current);
      pendingAreas.current.clear();
      debounceTimer.current = null;
      const h = reloadHandlersRef.current;

      if (toReload.has('workspace')) {
        h.loadWorkspace();
      }
      if (toReload.has('tasks')) {
        h.loadTasks();
      }
      if (toReload.has('inbox') || toReload.has('tasks')) {
        h.loadInboxNotesCount();
        setInboxRefreshKey((k) => k + 1);
      }
      if (toReload.has('runs')) {
        h.loadActiveRunsCount();
        setRunsRefreshKey((k) => k + 1);
      }
      if (toReload.has('questions')) {
        h.loadQuestionsCount();
        setQuestionsRefreshKey((k) => k + 1);
      }
      if (toReload.has('config')) {
        h.loadConfig();
      }
      if (toReload.has('env')) {
        h.loadEnv();
      }
    }, 300);
  }, []);

  // Load workspace once on mount and connect WebSocket once
  useEffect(() => {
    loadWorkspace();

    const cleanupWs = api.connectWebSocket(
      (msg) => {
        if (msg.type === 'connected') {
          setIsWsConnected(true);
        } else if (msg.type === 'reconnected') {
          setIsWsConnected(true);
          reloadHandlersRef.current.refreshAll();
        } else if (msg.type === 'changed') {
          if (Array.isArray(msg.areas)) {
            triggerDebouncedReload(msg.areas);
          }
        } else if (
          msg.type === 'task_transitioned' ||
          msg.type === 'index_synced' ||
          msg.type === 'tasks_changed' ||
          msg.type === 'tasks_updated' ||
          msg.type === 'use_cases_changed'
        ) {
          triggerDebouncedReload(['tasks']);
        } else if (
          msg.type === 'question_asked' ||
          msg.type === 'question_answered' ||
          msg.type === 'question_withdrawn'
        ) {
          triggerDebouncedReload(['questions', 'tasks']);
        } else if (
          msg.type === 'skills_installed' ||
          msg.type === 'skill_removed' ||
          msg.type === 'conflicts_resolved' ||
          msg.type === 'mcp_registered' ||
          msg.type === 'repos_fetched'
        ) {
          triggerDebouncedReload(['env']);
        } else if (msg.type === 'config_updated' || msg.type === 'agents_md_applied') {
          triggerDebouncedReload(['config']);
        } else if (msg.type === 'inbox_updated') {
          triggerDebouncedReload(['inbox']);
        } else if (
          msg.type === 'run_cancelled' ||
          msg.type === 'task_delivered' ||
          msg.type === 'verdict_applied'
        ) {
          triggerDebouncedReload(['runs', 'tasks']);
        }
      },
      (status) => {
        setIsWsConnected(status === 'connected');
      }
    );

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      cleanupWs();
    };
  }, [loadWorkspace, triggerDebouncedReload]);

  // Load scoped/aggregate data when primitive project state changes
  const hasWorkspaceLoaded = workspace !== null;
  useEffect(() => {
    if (!hasWorkspaceLoaded) return;
    reloadHandlersRef.current.loadTasks();
    reloadHandlersRef.current.loadQuestionsCount();
    reloadHandlersRef.current.loadActiveRunsCount();
    reloadHandlersRef.current.loadInboxNotesCount();
    reloadHandlersRef.current.loadEnv();
    reloadHandlersRef.current.loadConfig();
  }, [hasWorkspaceLoaded, selectedProject, isCommonView, projectsCount]);

  // Toggling closed tasks reloads only the common-view task list
  const includeClosedMountedRef = useRef(false);
  useEffect(() => {
    if (!includeClosedMountedRef.current) {
      includeClosedMountedRef.current = true;
      return;
    }
    if (hasWorkspaceLoaded && isCommonView) {
      reloadHandlersRef.current.loadTasks();
    }
  }, [includeClosed]);

  const projectContextValue = useMemo(
    () => ({
      selectedProject: effectiveProject,
      fallbackProject,
      isCommonView,
      projects: projectsList,
    }),
    [effectiveProject, fallbackProject, isCommonView, projectsList]
  );

  return (
    <ProjectContext.Provider value={projectContextValue}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#0f172a' }}>
        <Navbar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          workspace={workspace}
          selectedProject={selectedProject}
          onSelectProject={handleSelectProject}
          onRefresh={refreshAll}
          isWsConnected={isWsConnected}
          openQuestionsCount={openQuestionsCount}
          activeRunsCount={activeRunsCount}
          inboxNotesCount={inboxBadgeCount}
        />

        {workspace && workspace.registered === false && workspace.projects && workspace.projects.length > 1 && (
          <UnregisteredWorkspaceBanner rootPath={workspace.root || workspace.workspace_path} />
        )}

        {activeTab === 'backlog' && isCommonView && workspace?.projects && (
          <WorkspaceDashboardStrip
            projects={workspace.projects}
            tasks={tasksData?.all_tasks || []}
            selectedProject={selectedProject}
            onSelectProject={handleSelectProject}
          />
        )}

        <main style={{ flex: 1 }}>
          {activeTab === 'backlog' && (
            <div>
              {tasksError && (
                <PanelErrorBanner
                  title="Failed to Load Task Backlog"
                  error={tasksError}
                  onRetry={() => loadTasks()}
                />
              )}
              {tasksLoading && !tasksData ? (
                <PanelLoading label="task backlog" />
              ) : (
                <BacklogManager
                  data={tasksData}
                  isCommonView={isCommonView}
                  projects={workspace?.projects || []}
                  selectedProject={selectedProject}
                  includeClosed={includeClosed}
                  closedCount={closedTasksCount}
                  onIncludeClosedChange={handleIncludeClosedChange}
                  onSelectCoordTarget={(proj, _tid) => {
                    handleSelectProject(proj);
                  }}
                  onRefresh={() => {
                    recordOwnAction('tasks');
                    recordOwnAction('questions');
                    recordOwnAction('runs');
                    loadWorkspace();
                    loadTasks();
                    loadQuestionsCount();
                    loadActiveRunsCount();
                  }}
                />
              )}
            </div>
          )}

          {activeTab === 'decisions' && (
            <div>
              <DecisionsTab
                key={`${questionsRefreshKey}-${selectedProject || 'all'}`}
                tasks={tasksData?.all_tasks || tasksData?.emergent_tasks || []}
                isCommonView={isCommonView}
                selectedProject={effectiveProject}
                onRefresh={() => {
                  recordOwnAction('questions');
                  recordOwnAction('tasks');
                  loadWorkspace();
                  loadQuestionsCount();
                  loadTasks();
                }}
              />
            </div>
          )}

          {activeTab === 'inbox' && (
            <div>
              <InboxPanel
                key={`${inboxRefreshKey}-${selectedProject || 'all'}`}
                refreshTrigger={inboxRefreshKey}
                isCommonView={isCommonView}
                projects={workspace?.projects || []}
                selectedProject={effectiveProject}
                onRefreshNotesCount={() => {
                  recordOwnAction('inbox');
                  loadWorkspace();
                  loadInboxNotesCount();
                }}
              />
            </div>
          )}

          {activeTab === 'runs' && (
            <div>
              <RunsTab
                key={`${runsRefreshKey}-${selectedProject || 'all'}`}
                tasks={tasksData?.all_tasks || tasksData?.emergent_tasks || []}
                refreshKey={runsRefreshKey}
                isCommonView={isCommonView}
                selectedProject={effectiveProject}
                onSelectRun={(task, runId) => {
                  setModalTaskAndRun({ task, runId });
                }}
              />
            </div>
          )}

          {activeTab === 'orchestrator' && (
            <OrchestratorChatPanel onNavigateTab={(tab) => setActiveTab(tab as any)} />
          )}

          {activeTab === 'use-cases' && (
            <div>
              <UseCasesManager
                onRefresh={loadTasks}
                tasks={tasksData?.all_tasks || tasksData?.emergent_tasks || []}
                onSelectTask={(taskId) => {
                  const all = tasksData?.all_tasks || tasksData?.emergent_tasks || [];
                  const found = all.find((t) => t.id === taskId);
                  if (found) {
                    setModalTaskAndRun({ task: found });
                  } else {
                    setModalTaskAndRun({
                      task: {
                        id: taskId,
                        title: `Task ${taskId}`,
                        kind: taskId.startsWith('T') ? 'emergent' : 'initiative_task',
                        category: 'general',
                        priority: 'P2',
                        state: 'open',
                        executor: 'self',
                      },
                    });
                  }
                }}
              />
            </div>
          )}

          {activeTab === 'triggers' && (
            <div>
              <TriggersPage onNavigateTab={(tab) => setActiveTab(tab as any)} />
            </div>
          )}

          {activeTab === 'events' && (
            <div>
              <EventStreamPanel onNavigateTab={(tab) => setActiveTab(tab as any)} />
            </div>
          )}

          {activeTab === 'installer' && (
            <div>
              <SkillInstaller
                onRefresh={() => {
                  recordOwnAction('env');
                  loadEnv();
                }}
              />
            </div>
          )}

          {activeTab === 'doctor' && (
            <div>
              {envError && (
                <PanelErrorBanner
                  title="Failed to Load Environment Doctor"
                  error={envError}
                  onRetry={loadEnv}
                />
              )}
              {envLoading && !envStatus ? (
                <PanelLoading label="environment health status" />
              ) : (
                <EnvironmentDoctor
                  status={envStatus}
                  onRefresh={() => {
                    recordOwnAction('env');
                    loadEnv();
                  }}
                />
              )}
            </div>
          )}

          {activeTab === 'config' && (
            <div>
              {configError && (
                <PanelErrorBanner
                  title="Failed to Load Orchestrator Configuration"
                  error={configError}
                  onRetry={loadConfig}
                />
              )}
              {configLoading && !configData ? (
                <PanelLoading label="orchestrator configuration" />
              ) : (
                <OrchestrationConfigurator
                  configData={configData}
                  onRefresh={() => {
                    recordOwnAction('config');
                    loadConfig();
                  }}
                  onNavigateToDecisions={() => setActiveTab('decisions')}
                />
              )}
            </div>
          )}
        </main>

        {/* Task Detail Modal when opened from RunsTab or other tabs */}
        {modalTaskAndRun && (
          <TaskDetailModal
            task={modalTaskAndRun.task}
            initialRunId={modalTaskAndRun.runId}
            onClose={() => {
              setModalTaskAndRun(null);
            }}
            onActionComplete={() => {
              recordOwnAction('tasks');
              recordOwnAction('runs');
              loadWorkspace();
              loadTasks();
              loadActiveRunsCount();
              setRunsRefreshKey((k) => k + 1);
            }}
            onNavigateToDecisions={() => {
              setModalTaskAndRun(null);
              setActiveTab('decisions');
            }}
          />
        )}
      </div>
    </ProjectContext.Provider>
  );
};
