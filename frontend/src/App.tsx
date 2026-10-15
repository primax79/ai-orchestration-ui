import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { BacklogManager } from './components/BacklogManager';
import { SkillInstaller } from './components/SkillInstaller';
import { EnvironmentDoctor } from './components/EnvironmentDoctor';
import { OrchestrationConfigurator } from './components/OrchestrationConfigurator';
import { api } from './api';
import {
  WorkspaceInfo,
  TaskListResponse,
  EnvStatusResponse,
  OrchestrationConfigResponse,
} from './types';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'backlog' | 'installer' | 'doctor' | 'config'>('backlog');
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [tasksData, setTasksData] = useState<TaskListResponse | null>(null);
  const [envStatus, setEnvStatus] = useState<EnvStatusResponse | null>(null);
  const [configData, setConfigData] = useState<OrchestrationConfigResponse | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);

  const loadAllData = async () => {
    try {
      const [ws, tasks, env, cfg] = await Promise.allSettled([
        api.getWorkspace(),
        api.getTasks(),
        api.getEnvStatus(),
        api.getConfig(),
      ]);
      if (ws.status === 'fulfilled') setWorkspace(ws.value);
      if (tasks.status === 'fulfilled') setTasksData(tasks.value);
      if (env.status === 'fulfilled') setEnvStatus(env.value);
      if (cfg.status === 'fulfilled') setConfigData(cfg.value);
    } catch (e) {
      console.error('Error loading orchestration data:', e);
    }
  };

  useEffect(() => {
    loadAllData();

    // Connect WebSocket for live updates
    const cleanupWs = api.connectWebSocket((msg) => {
      if (msg.type === 'connected') {
        setIsWsConnected(true);
      } else {
        // Any change on disk triggers a refresh
        loadAllData();
      }
    });

    return () => cleanupWs();
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#0f172a' }}>
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        workspace={workspace}
        onRefresh={loadAllData}
        isWsConnected={isWsConnected}
      />

      <main style={{ flex: 1 }}>
        {activeTab === 'backlog' && (
          <BacklogManager data={tasksData} onRefresh={loadAllData} />
        )}
        {activeTab === 'installer' && (
          <SkillInstaller onRefresh={loadAllData} />
        )}
        {activeTab === 'doctor' && (
          <EnvironmentDoctor status={envStatus} onRefresh={loadAllData} />
        )}
        {activeTab === 'config' && (
          <OrchestrationConfigurator configData={configData} onRefresh={loadAllData} />
        )}
      </main>
    </div>
  );
};
