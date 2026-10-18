import React, { useState, useEffect } from 'react';
import {
  Layers,
  HelpCircle,
  Inbox,
  DownloadCloud,
  Activity,
  Settings,
  RefreshCw,
  FolderGit2,
  Terminal,
  CheckCircle2,
  Zap,
  Radio,
} from 'lucide-react';
import { WorkspaceInfo } from '../types';
import { NotificationArea } from './NotificationArea';

interface NavbarProps {
  activeTab: 'backlog' | 'decisions' | 'inbox' | 'runs' | 'use-cases' | 'triggers' | 'events' | 'installer' | 'doctor' | 'config';
  setActiveTab: (tab: 'backlog' | 'decisions' | 'inbox' | 'runs' | 'use-cases' | 'triggers' | 'events' | 'installer' | 'doctor' | 'config') => void;
  workspace: WorkspaceInfo | null;
  onRefresh: () => void;
  isWsConnected: boolean;
  openQuestionsCount?: number;
  activeRunsCount?: number;
  inboxNotesCount?: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  workspace,
  onRefresh,
  isWsConnected,
  openQuestionsCount = 0,
  activeRunsCount = 0,
  inboxNotesCount = 0,
}) => {
  const [width, setWidth] = useState<number>(() => {
    return typeof window !== 'undefined' ? window.innerWidth : 1200;
  });

  useEffect(() => {
    const handleResize = () => {
      setWidth(window.innerWidth);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const isShort = width < 1600; // full labels need ~1580 px with the logo and workspace chip
  const isIconOnly = width < 1200; // short labels need ~1200 px

  const tabs = [
    {
      key: 'backlog' as const,
      icon: <Layers size={16} />,
      label: 'Backlog & Tasks',
      shortLabel: 'Backlog',
    },
    {
      key: 'decisions' as const,
      icon: <HelpCircle size={16} />,
      label: 'Decisions',
      shortLabel: 'Decisions',
      badge: openQuestionsCount,
      badgeColor: '#ef4444',
    },
    {
      key: 'inbox' as const,
      icon: <Inbox size={16} />,
      label: 'Inbox',
      shortLabel: 'Inbox',
      badge: inboxNotesCount,
      badgeColor: '#ef4444',
    },
    {
      key: 'runs' as const,
      icon: <Terminal size={16} />,
      label: 'Runs',
      shortLabel: 'Runs',
      badge: activeRunsCount,
      badgeColor: '#0ea5e9',
    },
    {
      key: 'use-cases' as const,
      icon: <CheckCircle2 size={16} />,
      label: 'Use Cases & Validation',
      shortLabel: 'Use Cases',
    },
    {
      key: 'triggers' as const,
      icon: <Zap size={16} />,
      label: 'Triggers',
      shortLabel: 'Triggers',
    },
    {
      key: 'events' as const,
      icon: <Radio size={16} />,
      label: 'Event Stream',
      shortLabel: 'Events',
    },
    {
      key: 'installer' as const,
      icon: <DownloadCloud size={16} />,
      label: 'Install Skills & MCP',
      shortLabel: 'Install',
    },
    {
      key: 'doctor' as const,
      icon: <Activity size={16} />,
      label: 'Environment Doctor',
      shortLabel: 'Doctor',
    },
    {
      key: 'config' as const,
      icon: <Settings size={16} />,
      label: 'Orchestrator Config',
      shortLabel: 'Config',
    },
  ];

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: isIconOnly ? '0.5rem 0.75rem' : '0.75rem 1.5rem',
        backgroundColor: '#1e293b',
        borderBottom: '1px solid #334155',
        flexWrap: 'nowrap',
        gap: '0.75rem',
        height: '3.75rem',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <style>{`
        .nav-tabs-scroll::-webkit-scrollbar {
          height: 3px;
        }
        .nav-tabs-scroll::-webkit-scrollbar-thumb {
          background: #475569;
          border-radius: 2px;
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isIconOnly ? '0.5rem' : '1rem',
          flexWrap: 'nowrap',
          minWidth: 0,
          flex: '1 1 auto',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontWeight: 700,
            fontSize: '1.1rem',
            color: '#818cf8',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <Layers size={22} style={{ flexShrink: 0 }} />
          <span style={{ whiteSpace: 'nowrap' }}>ai-orchestration</span>
        </div>

        <nav
          className="nav-tabs-scroll"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            marginLeft: isIconOnly ? '0.25rem' : '1rem',
            flexWrap: 'nowrap',
            overflowX: 'auto',
            overflowY: 'hidden',
            minWidth: 0,
            flexShrink: 1,
            scrollbarWidth: 'thin',
          }}
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            const hasBadge = tab.badge !== undefined && tab.badge > 0;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                title={tab.label}
                aria-label={tab.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: isIconOnly ? '0.4rem 0.6rem' : '0.4rem 0.8rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: isActive ? '#4f46e5' : 'transparent',
                  color: isActive ? '#fff' : '#94a3b8',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {tab.icon}
                {!isIconOnly && (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {isShort ? tab.shortLabel : tab.label}
                  </span>
                )}
                {hasBadge && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: tab.badgeColor || '#ef4444',
                      color: '#fff',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      minWidth: '1.15rem',
                      height: '1.15rem',
                      padding: '0 0.3rem',
                      borderRadius: '1rem',
                      lineHeight: 1,
                      marginLeft: isIconOnly ? '0.1rem' : '0.15rem',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isIconOnly ? '0.5rem' : '1rem',
          fontSize: '0.85rem',
          flexShrink: 0,
          minWidth: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {workspace && (
          <div
            title={workspace.workspace_name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.3rem 0.6rem',
              backgroundColor: '#0f172a',
              borderRadius: '0.375rem',
              border: '1px solid #334155',
              color: '#cbd5e1',
              maxWidth: isIconOnly ? '120px' : isShort ? '160px' : '220px',
              minWidth: 0,
              flexShrink: 1,
              whiteSpace: 'nowrap',
            }}
          >
            <FolderGit2 size={14} color="#818cf8" style={{ flexShrink: 0 }} />
            <span
              style={{
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {workspace.workspace_name}
            </span>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: isWsConnected ? '#10b981' : '#ef4444',
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: '0.75rem',
              color: isWsConnected ? '#94a3b8' : '#fca5a5',
              fontWeight: isWsConnected ? 400 : 600,
              whiteSpace: 'nowrap',
            }}
          >
            {isWsConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>

        <NotificationArea onNavigate={(t) => setActiveTab(t as any)} />

        <button
          onClick={onRefresh}
          title="Refresh state"
          aria-label="Refresh state"
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
            flexShrink: 0,
          }}
        >
          <RefreshCw size={15} />
        </button>
      </div>
    </header>
  );
};
