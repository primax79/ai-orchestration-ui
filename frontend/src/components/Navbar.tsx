import React, { useState, useEffect, useRef } from 'react';
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
  Bot,
} from 'lucide-react';
import { WorkspaceInfo } from '../types';
import { NotificationArea } from './NotificationArea';

interface NavbarProps {
  activeTab: 'backlog' | 'decisions' | 'inbox' | 'runs' | 'orchestrator' | 'use-cases' | 'triggers' | 'events' | 'installer' | 'doctor' | 'config';
  setActiveTab: (tab: 'backlog' | 'decisions' | 'inbox' | 'runs' | 'orchestrator' | 'use-cases' | 'triggers' | 'events' | 'installer' | 'doctor' | 'config') => void;
  workspace: WorkspaceInfo | null;
  selectedProject?: string | null;
  onSelectProject?: (projectId: string | null) => void;
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
  selectedProject = null,
  onSelectProject,
  onRefresh,
  isWsConnected,
  openQuestionsCount = 0,
  activeRunsCount = 0,
  inboxNotesCount = 0,
}) => {
  const [width, setWidth] = useState<number>(() => {
    return typeof window !== 'undefined' ? window.innerWidth : 1200;
  });
  const [showEmptyProjects, setShowEmptyProjects] = useState<boolean>(false);

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

  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = () =>
      document.documentElement.style.setProperty('--nav-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Row 1: logo + tabs (grouped) on the left, status controls (live, bell,
  // refresh) on the right. Tab labels are full, short or icon-only, whichever
  // fits; workspace/project controls join row 1 only when there is room,
  // otherwise they take a second row. Nothing is ever clipped or scrolled away.
  const row1Ref = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const projRef = useRef<HTMLDivElement | null>(null);
  const measureRefs = {
    full: useRef<HTMLDivElement | null>(null),
    short: useRef<HTMLDivElement | null>(null),
    icon: useRef<HTMLDivElement | null>(null),
  };
  const [labelMode, setLabelMode] = useState<'full' | 'short' | 'icon'>('icon');
  const [twoRows, setTwoRows] = useState(true);
  useEffect(() => {
    const GAP = 12;
    const measureNow = () => {
      const row = row1Ref.current;
      const st = statusRef.current;
      if (!row || !st) return;
      const avail = row.clientWidth - st.offsetWidth - GAP;
      const w = (k: 'full' | 'short' | 'icon') => measureRefs[k].current?.offsetWidth ?? Infinity;
      const mode = w('full') <= avail ? 'full' : w('short') <= avail ? 'short' : 'icon';
      setLabelMode(mode);
      const proj = projRef.current?.offsetWidth ?? 0;
      setTwoRows(proj > 0 && w(mode) + proj + GAP > avail);
    };
    measureNow();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measureNow);
    [row1Ref, statusRef, projRef, measureRefs.full, measureRefs.short, measureRefs.icon].forEach(
      (r) => r.current && ro.observe(r.current)
    );
    return () => ro.disconnect();
  });

  // Window-width hints only for spacing; tab labels follow the measured fit below.
  const medium = width < 1600;
  const compact = width < 1200;

  const tabs = [
    {
      key: 'backlog' as const,
      group: 'work',
      icon: <Layers size={16} />,
      label: 'Backlog & Tasks',
      shortLabel: 'Backlog',
    },
    {
      key: 'decisions' as const,
      group: 'work',
      icon: <HelpCircle size={16} />,
      label: 'Decisions',
      shortLabel: 'Decisions',
      badge: openQuestionsCount,
      badgeColor: '#ef4444',
    },
    {
      key: 'inbox' as const,
      group: 'work',
      icon: <Inbox size={16} />,
      label: 'Inbox',
      shortLabel: 'Inbox',
      badge: inboxNotesCount,
      badgeColor: '#ef4444',
    },
    {
      key: 'runs' as const,
      group: 'run',
      icon: <Terminal size={16} />,
      label: 'Runs',
      shortLabel: 'Runs',
      badge: activeRunsCount,
      badgeColor: '#0ea5e9',
    },
    {
      key: 'orchestrator' as const,
      group: 'run',
      icon: <Bot size={16} />,
      label: 'Orchestrator Chat',
      shortLabel: 'Chat',
    },
    {
      key: 'use-cases' as const,
      group: 'observe',
      icon: <CheckCircle2 size={16} />,
      label: 'Use Cases & Validation',
      shortLabel: 'Use Cases',
    },
    {
      key: 'triggers' as const,
      group: 'observe',
      icon: <Zap size={16} />,
      label: 'Triggers',
      shortLabel: 'Triggers',
    },
    {
      key: 'events' as const,
      group: 'observe',
      icon: <Radio size={16} />,
      label: 'Event Stream',
      shortLabel: 'Events',
    },
    {
      key: 'installer' as const,
      group: 'setup',
      icon: <DownloadCloud size={16} />,
      label: 'Install Skills & MCP',
      shortLabel: 'Install',
    },
    {
      key: 'doctor' as const,
      group: 'setup',
      icon: <Activity size={16} />,
      label: 'Environment Doctor',
      shortLabel: 'Doctor',
    },
    {
      key: 'config' as const,
      group: 'setup',
      icon: <Settings size={16} />,
      label: 'Orchestrator Config',
      shortLabel: 'Config',
    },
  ];

  const renderTabs = (mode: 'full' | 'short' | 'icon', measure = false) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: mode === 'icon' ? '0.5rem' : '1rem',
        flexWrap: 'nowrap',
        flex: measure ? '0 0 auto' : '0 1 auto',
        minWidth: 0,
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
        {mode !== 'icon' && <span style={{ whiteSpace: 'nowrap' }}>ai-orchestration</span>}
      </div>
      <nav
        aria-hidden={measure ? true : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
          marginLeft: mode === 'icon' ? '0.25rem' : '1rem',
          // Last resort on very narrow panels: icons wrap instead of being cut.
          flexWrap: measure ? 'nowrap' : 'wrap',
          rowGap: '0.25rem',
          flexShrink: measure ? 0 : 1,
          minWidth: 0,
        }}
      >
          {tabs.map((tab, idx) => {
            const isActive = activeTab === tab.key;
            const hasBadge = tab.badge !== undefined && tab.badge > 0;
            const newGroup = idx > 0 && tabs[idx - 1].group !== tab.group;
            return (
              <React.Fragment key={tab.key}>
              {newGroup && (
                <span
                  aria-hidden="true"
                  style={{
                    width: '1px',
                    height: '1.25rem',
                    backgroundColor: '#475569',
                    margin: '0 0.35rem',
                    flexShrink: 0,
                  }}
                />
              )}
              <button
                onClick={() => setActiveTab(tab.key)}
                tabIndex={measure ? -1 : undefined}
                title={tab.label}
                aria-label={tab.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: mode === 'icon' ? '0.4rem 0.6rem' : '0.4rem 0.8rem',
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
                {mode !== 'icon' && (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {mode === 'short' ? tab.shortLabel : tab.label}
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
                      marginLeft: mode === 'icon' ? '0.1rem' : '0.15rem',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
              </React.Fragment>
            );
          })}
      </nav>
    </div>
  );

  const renderProjectControls = () => (
    <div
      ref={projRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? '0.5rem' : '1rem',
        fontSize: '0.85rem',
        flex: '0 0 auto',
        maxWidth: '100%',
        whiteSpace: 'nowrap',
      }}
    >
        {workspace && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0, flexShrink: 1 }}>
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
                maxWidth: compact ? '120px' : medium ? '160px' : '220px',
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

            {workspace.projects && workspace.projects.length > 1 && onSelectProject && (() => {
              const getProjActiveCounts = (c?: Record<string, number | undefined>) => {
                const counts = c || {};
                const waiting = (counts.waiting || 0) + (counts.blocked || 0);
                const open = (counts.open || 0) + (counts.todo || 0) + (counts.bounced || 0);
                const progress = (counts['in progress'] || 0) + (counts.in_progress || 0) + (counts.delivered || 0) + (counts.verified || 0);
                const nonClosed = waiting + open + progress;
                return { waiting, open, progress, nonClosed };
              };
              const totals = workspace.projects.reduce(
                (acc, p) => {
                  const pc = getProjActiveCounts(p.counts);
                  acc.waiting += pc.waiting;
                  acc.open += pc.open;
                  acc.progress += pc.progress;
                  acc.nonClosed += pc.nonClosed;
                  return acc;
                },
                { waiting: 0, open: 0, progress: 0, nonClosed: 0 }
              );
              const sortedProjects = [...workspace.projects].sort((a, b) => {
                if (a.kind === '_workspace' && b.kind !== '_workspace') return -1;
                if (b.kind === '_workspace' && a.kind !== '_workspace') return 1;
                const ac = getProjActiveCounts(a.counts).nonClosed;
                const bc = getProjActiveCounts(b.counts).nonClosed;
                if (ac > 0 && bc === 0) return -1;
                if (bc > 0 && ac === 0) return 1;
                if (ac !== bc) return bc - ac;
                return a.id.localeCompare(b.id);
              });
              const isProjectEmpty = (p: (typeof workspace.projects)[number]) => {
                if (p.kind === '_workspace') return false;
                const pc = getProjActiveCounts(p.counts);
                return pc.nonClosed === 0;
              };
              const emptyProjectsCount = sortedProjects.filter((p) => isProjectEmpty(p)).length;
              const nonEmptyProjects = sortedProjects.filter(
                (p) => !isProjectEmpty(p) || p.id === selectedProject
              );
              const visibleProjects =
                showEmptyProjects || nonEmptyProjects.length === 0
                  ? sortedProjects
                  : nonEmptyProjects;
              const allCountLabel =
                !showEmptyProjects && emptyProjectsCount > 0 && visibleProjects.length < workspace.projects.length
                  ? `${visibleProjects.length}/${workspace.projects.length}`
                  : `${workspace.projects.length}`;
              return (
                <>
                  <select
                    aria-label="Project selector"
                    title="Switch project or view all projects"
                    value={selectedProject || '__all__'}
                    onChange={(e) => {
                      const val = e.target.value;
                      onSelectProject(val === '__all__' ? null : val);
                    }}
                    style={{
                      // Own chevron and reserved right padding: the native arrow overlapped long labels.
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      padding: '0.3rem 1.75rem 0.3rem 0.5rem',
                      backgroundColor: '#0f172a',
                      backgroundImage:
                        "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23c7d2fe' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 0.5rem center',
                      backgroundSize: '12px 12px',
                      border: '1px solid #4f46e5',
                      borderRadius: '0.375rem',
                      color: '#f8fafc',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      minWidth: 0,
                      flexShrink: 1,
                      maxWidth: compact ? '220px' : '360px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      outline: 'none',
                    }}
                  >
                    <option value="__all__">
                      All projects ({allCountLabel}) — {totals.nonClosed} (waiting: {totals.waiting}, open: {totals.open}, progress: {totals.progress})
                    </option>
                    {visibleProjects.map((p) => {
                      const pc = getProjActiveCounts(p.counts);
                      const subTag = p.kind === 'sub_workspace' ? ' [sub_workspace]' : '';
                      return (
                        <option key={p.id} value={p.id}>
                          {p.id}{subTag} — {pc.nonClosed} (waiting: {pc.waiting}, open: {pc.open}, progress: {pc.progress})
                        </option>
                      );
                    })}
                  </select>
                  {emptyProjectsCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowEmptyProjects((prev) => !prev)}
                      aria-label="Toggle empty projects"
                      title={
                        showEmptyProjects
                          ? `Hide ${emptyProjectsCount} project(s) with 0 active tasks`
                          : `Show ${emptyProjectsCount} project(s) with 0 active tasks`
                      }
                      style={{
                        padding: '0.25rem 0.45rem',
                        backgroundColor: showEmptyProjects ? '#312e81' : '#0f172a',
                        border: `1px solid ${showEmptyProjects ? '#6366f1' : '#334155'}`,
                        borderRadius: '0.375rem',
                        color: showEmptyProjects ? '#e0e7ff' : '#94a3b8',
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                    >
                      {showEmptyProjects ? `Hide empty (${emptyProjectsCount})` : `Show empty (+${emptyProjectsCount})`}
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        )}

    </div>
  );

  return (
    <header
      ref={headerRef}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: compact ? '0.5rem 0.75rem' : '0.75rem 1.5rem',
        backgroundColor: '#1e293b',
        borderBottom: '1px solid #334155',
        rowGap: '0.5rem',
        minHeight: '3.75rem',
        boxSizing: 'border-box',
      }}
    >
      {/* Hidden copies used only to measure each label mode's width. */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: 0, top: 0, width: 'max-content', visibility: 'hidden', pointerEvents: 'none', height: 0, overflow: 'hidden' }}
      >
        <div ref={measureRefs.full} style={{ display: 'flex', width: 'max-content' }}>{renderTabs('full', true)}</div>
        <div ref={measureRefs.short} style={{ display: 'flex', width: 'max-content' }}>{renderTabs('short', true)}</div>
        <div ref={measureRefs.icon} style={{ display: 'flex', width: 'max-content' }}>{renderTabs('icon', true)}</div>
      </div>
      <div
        ref={row1Ref}
        style={{ display: 'flex', alignItems: 'center', columnGap: '0.75rem', rowGap: '0.5rem', flexWrap: 'wrap', minWidth: 0 }}
      >
        {renderTabs(labelMode)}
        {!twoRows && <div style={{ marginLeft: 'auto', display: 'flex', minWidth: 0 }}>{renderProjectControls()}</div>}
        <div
          ref={statusRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: compact ? '0.5rem' : '0.75rem',
            fontSize: '0.85rem',
            flex: '0 0 auto',
            marginLeft: twoRows ? 'auto' : '0',
            paddingLeft: twoRows ? 0 : '0.75rem',
            borderLeft: twoRows ? 'none' : '1px solid #334155',
            whiteSpace: 'nowrap',
          }}
        >
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
      </div>
      {twoRows && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}>{renderProjectControls()}</div>
      )}
    </header>
  );
};
