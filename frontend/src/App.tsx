import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { api } from './api';
import {
  WorkspaceInfo,
  TaskListResponse,
  EnvStatusResponse,
  OrchestrationConfigResponse,
  TaskItem,
} from './types';

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
  const [activeTab, setActiveTab] = useState<'backlog' | 'decisions' | 'inbox' | 'runs' | 'use-cases' | 'triggers' | 'events' | 'installer' | 'doctor' | 'config'>('backlog');

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);

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

  const loadWorkspace = useCallback(async () => {
    try {
      const ws = await api.getWorkspace();
      setWorkspace(ws);
    } catch (e: any) {
      console.error('Workspace load error:', e);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const data = await api.getTasks();
      setTasksData(data);
      if (data && data.all_tasks) {
        const allTasks = data.all_tasks;
        setModalTaskAndRun((prev) => {
          if (!prev) return null;
          const updated = allTasks.find((t: TaskItem) => t.id === prev.task.id);
          return updated ? { ...prev, task: updated } : prev;
        });
      }
    } catch (e: any) {
      setTasksError(e.message || String(e));
    } finally {
      setTasksLoading(false);
    }
  }, []);

  const loadQuestionsCount = useCallback(async () => {
    try {
      const res = await api.getQuestions({ status: 'open' });
      if (res && res.questions) {
        setOpenQuestionsCount(res.questions.length);
      }
    } catch (e: any) {
      console.error('Failed to load open questions count:', e);
    }
  }, []);

  const loadActiveRunsCount = useCallback(async () => {
    try {
      const res = await api.listRuns({ active: true });
      if (res && res.runs) {
        setActiveRunsCount(res.runs.length);
      }
    } catch (e: any) {
      console.error('Failed to load active runs count:', e);
    }
  }, []);

  const loadInboxNotesCount = useCallback(async () => {
    try {
      const res = await api.listInboxNotes();
      if (res && res.notes) {
        const count = res.notes.filter(
          (n) => (n.status || 'draft').toLowerCase() === 'draft' || (n.status || '').toLowerCase() === 'ready'
        ).length;
        setInboxBadgeCount(count);
      }
    } catch (e: any) {
      console.error('Failed to load inbox notes count:', e);
    }
  }, []);

  const loadEnv = useCallback(async () => {
    setEnvLoading(true);
    setEnvError(null);
    try {
      const data = await api.getEnvStatus();
      setEnvStatus(data);
    } catch (e: any) {
      setEnvError(e.message || String(e));
    } finally {
      setEnvLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const data = await api.getConfig();
      setConfigData(data);
    } catch (e: any) {
      setConfigError(e.message || String(e));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadAll = useCallback(() => {
    loadWorkspace();
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

      if (toReload.has('tasks')) {
        loadTasks();
      }
      if (toReload.has('inbox') || toReload.has('tasks')) {
        loadInboxNotesCount();
        setInboxRefreshKey((k) => k + 1);
      }
      if (toReload.has('runs')) {
        loadActiveRunsCount();
        setRunsRefreshKey((k) => k + 1);
      }
      if (toReload.has('questions')) {
        loadQuestionsCount();
        setQuestionsRefreshKey((k) => k + 1);
      }
      if (toReload.has('config')) {
        loadConfig();
      }
      if (toReload.has('env')) {
        loadEnv();
      }
    }, 300);
  }, [loadTasks, loadInboxNotesCount, loadActiveRunsCount, loadQuestionsCount, loadConfig, loadEnv]);

  useEffect(() => {
    loadAll();

    // Connect WebSocket with status listener and exponential backoff
    const cleanupWs = api.connectWebSocket(
      (msg) => {
        if (msg.type === 'connected') {
          setIsWsConnected(true);
        } else if (msg.type === 'reconnected') {
          setIsWsConnected(true);
          loadAll();
        } else if (msg.type === 'changed') {
          if (Array.isArray(msg.areas)) {
            triggerDebouncedReload(msg.areas);
          }
        } else if (msg.type === 'task_transitioned' || msg.type === 'index_synced' || msg.type === 'tasks_changed') {
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
  }, [loadAll, triggerDebouncedReload]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#0f172a' }}>
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        workspace={workspace}
        onRefresh={loadAll}
        isWsConnected={isWsConnected}
        openQuestionsCount={openQuestionsCount}
        activeRunsCount={activeRunsCount}
        inboxNotesCount={inboxBadgeCount}
      />

      <main style={{ flex: 1 }}>
        {activeTab === 'backlog' && (
          <div>
            {tasksError && (
              <PanelErrorBanner
                title="Failed to Load Task Backlog"
                error={tasksError}
                onRetry={loadTasks}
              />
            )}
            {tasksLoading && !tasksData ? (
              <PanelLoading label="task backlog" />
            ) : (
              <BacklogManager
                data={tasksData}
                onRefresh={() => {
                  recordOwnAction('tasks');
                  recordOwnAction('questions');
                  recordOwnAction('runs');
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
              key={questionsRefreshKey}
              tasks={tasksData?.all_tasks || tasksData?.emergent_tasks || []}
              onRefresh={() => {
                recordOwnAction('questions');
                recordOwnAction('tasks');
                loadQuestionsCount();
                loadTasks();
              }}
            />
          </div>
        )}

        {activeTab === 'inbox' && (
          <div>
            <InboxPanel
              key={inboxRefreshKey}
              refreshTrigger={inboxRefreshKey}
              onRefreshNotesCount={() => {
                recordOwnAction('inbox');
                loadInboxNotesCount();
              }}
            />
          </div>
        )}

        {activeTab === 'runs' && (
          <div>
            <RunsTab
              key={runsRefreshKey}
              tasks={tasksData?.all_tasks || tasksData?.emergent_tasks || []}
              refreshKey={runsRefreshKey}
              onSelectRun={(task, runId) => {
                setModalTaskAndRun({ task, runId });
              }}
            />
          </div>
        )}

        {activeTab === 'use-cases' && (
          <div>
            <UseCasesManager onRefresh={loadTasks} />
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
          onClose={() => setModalTaskAndRun(null)}
          onActionComplete={() => {
            recordOwnAction('tasks');
            recordOwnAction('runs');
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
  );
};
