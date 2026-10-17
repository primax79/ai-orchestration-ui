import React from 'react';
import { Layers, HelpCircle, DownloadCloud, Activity, Settings, RefreshCw, FolderGit2, Terminal } from 'lucide-react';
import { WorkspaceInfo } from '../types';

interface NavbarProps {
  activeTab: 'backlog' | 'decisions' | 'runs' | 'installer' | 'doctor' | 'config';
  setActiveTab: (tab: 'backlog' | 'decisions' | 'runs' | 'installer' | 'doctor' | 'config') => void;
  workspace: WorkspaceInfo | null;
  onRefresh: () => void;
  isWsConnected: boolean;
  openQuestionsCount?: number;
  activeRunsCount?: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  workspace,
  onRefresh,
  isWsConnected,
  openQuestionsCount = 0,
  activeRunsCount = 0,
}) => {
  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0.75rem 1.5rem',
      backgroundColor: '#1e293b',
      borderBottom: '1px solid #334155',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, fontSize: '1.1rem', color: '#818cf8' }}>
          <Layers size={22} />
          <span>ai-orchestration</span>
        </div>

        <nav style={{ display: 'flex', gap: '0.25rem', marginLeft: '1.5rem' }}>
          <button
            onClick={() => setActiveTab('backlog')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeTab === 'backlog' ? '#4f46e5' : 'transparent',
              color: activeTab === 'backlog' ? '#fff' : '#94a3b8',
              fontWeight: 500,
            }}
          >
            <Layers size={16} />
            <span>Backlog & Tasks</span>
          </button>

          <button
            onClick={() => setActiveTab('decisions')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeTab === 'decisions' ? '#4f46e5' : 'transparent',
              color: activeTab === 'decisions' ? '#fff' : '#94a3b8',
              fontWeight: 500,
            }}
          >
            <HelpCircle size={16} />
            <span>Decisions</span>
            {openQuestionsCount > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: '#ef4444',
                  color: '#fff',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  minWidth: '1.15rem',
                  height: '1.15rem',
                  padding: '0 0.3rem',
                  borderRadius: '1rem',
                  lineHeight: 1,
                  marginLeft: '0.15rem',
                }}
              >
                {openQuestionsCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('runs')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeTab === 'runs' ? '#4f46e5' : 'transparent',
              color: activeTab === 'runs' ? '#fff' : '#94a3b8',
              fontWeight: 500,
            }}
          >
            <Terminal size={16} />
            <span>Runs</span>
            {activeRunsCount > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: '#0ea5e9',
                  color: '#fff',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  minWidth: '1.15rem',
                  height: '1.15rem',
                  padding: '0 0.3rem',
                  borderRadius: '1rem',
                  lineHeight: 1,
                  marginLeft: '0.15rem',
                }}
              >
                {activeRunsCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('installer')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeTab === 'installer' ? '#4f46e5' : 'transparent',
              color: activeTab === 'installer' ? '#fff' : '#94a3b8',
              fontWeight: 500,
            }}
          >
            <DownloadCloud size={16} />
            <span>Install Skills & MCP</span>
          </button>

          <button
            onClick={() => setActiveTab('doctor')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeTab === 'doctor' ? '#4f46e5' : 'transparent',
              color: activeTab === 'doctor' ? '#fff' : '#94a3b8',
              fontWeight: 500,
            }}
          >
            <Activity size={16} />
            <span>Environment Doctor</span>
          </button>

          <button
            onClick={() => setActiveTab('config')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeTab === 'config' ? '#4f46e5' : 'transparent',
              color: activeTab === 'config' ? '#fff' : '#94a3b8',
              fontWeight: 500,
            }}
          >
            <Settings size={16} />
            <span>Orchestrator Config</span>
          </button>
        </nav>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.85rem' }}>
        {workspace && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.3rem 0.6rem',
            backgroundColor: '#0f172a',
            borderRadius: '0.375rem',
            border: '1px solid #334155',
            color: '#cbd5e1',
          }}>
            <FolderGit2 size={14} color="#818cf8" />
            <span style={{ fontWeight: 600 }}>{workspace.workspace_name}</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: isWsConnected ? '#10b981' : '#ef4444',
            display: 'inline-block',
          }} />
          <span style={{
            fontSize: '0.75rem',
            color: isWsConnected ? '#94a3b8' : '#fca5a5',
            fontWeight: isWsConnected ? 400 : 600,
          }}>
            {isWsConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>

        <button
          onClick={onRefresh}
          title="Refresh state"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'none',
            border: '1px solid #334155',
            color: '#94a3b8',
            borderRadius: '0.375rem',
            padding: '0.35rem',
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={15} />
        </button>
      </div>
    </header>
  );
};
