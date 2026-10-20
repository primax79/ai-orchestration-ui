import React, { useState, useEffect } from 'react';
import {
  Search,
  Filter,
  X,
  Tag,
  ChevronDown,
  RotateCcw,
  FolderGit2,
} from 'lucide-react';
import { TaskKind, TaskState, SharedFilterState, LabelsResponse, LabelCountItem, WorkspaceProjectInfo } from '../types';
import { KindBadge, KIND_CONFIGS } from './KindBadge';
import { LabelChip } from './LabelChip';
import { ProjectChip } from './ProjectBadges';
import { microtaskAndLabelsApi, useProjectContext } from '../api';

const SHARED_FILTERS_KEY = 'ai-orch:shared-filters';

export const DEFAULT_SHARED_FILTERS: SharedFilterState = {
  search: '',
  kinds: [],
  labels: [],
  states: [],
  priority: 'all',
  groupByLabel: false,
  projects: [],
  groupByProject: false,
};

export const getStoredSharedFilters = (): SharedFilterState => {
  try {
    const raw = localStorage.getItem(SHARED_FILTERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          search: typeof parsed.search === 'string' ? parsed.search : '',
          kinds: Array.isArray(parsed.kinds) ? parsed.kinds : [],
          labels: Array.isArray(parsed.labels) ? parsed.labels : [],
          states: Array.isArray(parsed.states) ? parsed.states : [],
          priority: parsed.priority || 'all',
          groupByLabel: Boolean(parsed.groupByLabel),
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          groupByProject: Boolean(parsed.groupByProject),
        };
      }
    }
  } catch {
    // Ignore storage/parse errors
  }
  return DEFAULT_SHARED_FILTERS;
};

export const storeSharedFilters = (filters: SharedFilterState): void => {
  try {
    localStorage.setItem(SHARED_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // Ignore storage errors
  }
};

interface SharedFilterBarProps {
  filters: SharedFilterState;
  onChange: (nextFilters: SharedFilterState) => void;
  availableLabels?: string[];
  availableProjects?: WorkspaceProjectInfo[];
  showProjectControls?: boolean;
  showGroupByLabel?: boolean;
  style?: React.CSSProperties;
}

export const SharedFilterBar: React.FC<SharedFilterBarProps> = ({
  filters,
  onChange,
  availableLabels = [],
  availableProjects = [],
  showProjectControls = false,
  showGroupByLabel = false,
  style,
}) => {
  const { selectedProject, fallbackProject, isCommonView, projects: ctxProjects } = useProjectContext();
  const [showLabelDropdown, setShowLabelDropdown] = useState(false);
  const [showStateDropdown, setShowStateDropdown] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [fetchedLabels, setFetchedLabels] = useState<string[]>([]);

  const projsToQuery = availableProjects.length > 0 ? availableProjects : ctxProjects;
  const projectIdsKey = projsToQuery.map((p) => p.id).join(',');

  useEffect(() => {
    let isMounted = true;
    const isCommon = showProjectControls || isCommonView;
    if (isCommon && projsToQuery.length > 0) {
      Promise.all(
        projsToQuery.map((p) =>
          microtaskAndLabelsApi.getLabels(p.id).catch(() => ({ ok: false, labels: [] as LabelCountItem[] }))
        )
      )
        .then((results) => {
          if (!isMounted) return;
          const set = new Set<string>();
          results.forEach((res) => {
            if (res && Array.isArray(res.labels)) {
              res.labels.forEach((l: LabelCountItem) => set.add(l.label));
            }
          });
          setFetchedLabels(Array.from(set).sort());
        })
        .catch(() => {});
      return () => {
        isMounted = false;
      };
    }

    const targetProj = selectedProject || fallbackProject;
    if (!targetProj) {
      return () => {
        isMounted = false;
      };
    }
    microtaskAndLabelsApi
      .getLabels(targetProj)
      .then((res: LabelsResponse) => {
        if (isMounted && res && Array.isArray(res.labels)) {
          setFetchedLabels(res.labels.map((l: LabelCountItem) => l.label));
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [selectedProject, fallbackProject, isCommonView, showProjectControls, projectIdsKey]);

  const repoLabels = Array.from(new Set([...availableLabels, ...fetchedLabels])).sort();

  const updateFilters = (patch: Partial<SharedFilterState>) => {
    const next = { ...filters, ...patch };
    onChange(next);
    storeSharedFilters(next);
  };

  const handleClearFilters = () => {
    updateFilters({
      search: '',
      kinds: [],
      labels: [],
      states: [],
      priority: 'all',
      projects: [],
    });
  };

  const selectedProjects = filters.projects || [];

  const hasActiveFilters = Boolean(
    filters.search ||
    filters.kinds.length > 0 ||
    filters.labels.length > 0 ||
    filters.states.length > 0 ||
    (filters.priority && filters.priority !== 'all') ||
    (showProjectControls && selectedProjects.length > 0)
  );

  const toggleProject = (projId: string) => {
    const nextProjects = selectedProjects.includes(projId)
      ? selectedProjects.filter((p) => p !== projId)
      : [...selectedProjects, projId];
    updateFilters({ projects: nextProjects });
  };

  const toggleKind = (kind: TaskKind) => {
    const nextKinds = filters.kinds.includes(kind)
      ? filters.kinds.filter((k) => k !== kind)
      : [...filters.kinds, kind];
    updateFilters({ kinds: nextKinds });
  };

  const toggleLabel = (label: string) => {
    const nextLabels = filters.labels.includes(label)
      ? filters.labels.filter((l) => l !== label)
      : [...filters.labels, label];
    updateFilters({ labels: nextLabels });
  };

  const toggleState = (st: TaskState) => {
    const nextStates = filters.states.includes(st)
      ? filters.states.filter((s) => s !== st)
      : [...filters.states, st];
    updateFilters({ states: nextStates });
  };

  const ALL_KINDS: TaskKind[] = ['bug', 'feature', 'fix', 'chore', 'docs', 'investigation'];
  const POPULAR_STATES: TaskState[] = ['open', 'in progress', 'waiting', 'blocked', 'delivered', 'verified', 'done'];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        padding: '0.65rem 0.85rem',
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.375rem',
        marginBottom: '1rem',
        boxSizing: 'border-box',
        width: '100%',
        ...style,
      }}
    >
      {/* Top Filter Bar: Search, Kind Chips, Dropdowns, Clear */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}
      >
        {/* Left Side: Search + Kind Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', flex: 1, minWidth: '280px' }}>
          {/* Search Input */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.25rem 0.5rem',
              gap: '0.35rem',
              minWidth: '180px',
              maxWidth: '320px',
              flex: 1,
            }}
          >
            <Search size={14} color="#94a3b8" />
            <input
              type="text"
              value={filters.search}
              onChange={(e) => updateFilters({ search: e.target.value })}
              placeholder="Filter tasks (id, title, category)..."
              style={{
                background: 'none',
                border: 'none',
                outline: 'none',
                color: '#f8fafc',
                fontSize: '0.8rem',
                width: '100%',
              }}
            />
            {filters.search && (
              <button
                type="button"
                onClick={() => updateFilters({ search: '' })}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: '#94a3b8',
                  cursor: 'pointer',
                  display: 'flex',
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Kind Toggle Pills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, marginRight: '0.1rem' }}>
              Kind:
            </span>
            {ALL_KINDS.map((kind) => {
              const active = filters.kinds.includes(kind);
              const conf = KIND_CONFIGS[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleKind(kind)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.15rem 0.45rem',
                    borderRadius: '0.25rem',
                    border: `1px solid ${active ? conf.color : '#334155'}`,
                    backgroundColor: active ? conf.bg : '#0f172a',
                    color: active ? conf.color : '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '0.72rem',
                    fontWeight: active ? 700 : 500,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <KindBadge kind={kind} size={11} />
                  <span>{conf.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Side: Project Dropdown, Labels Dropdown, State Dropdown, Group toggles, Clear */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
          {/* Project Multi-Select Dropdown (Common View) */}
          {showProjectControls && availableProjects.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => {
                  setShowProjectDropdown((v) => !v);
                  setShowLabelDropdown(false);
                  setShowStateDropdown(false);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.25rem 0.55rem',
                  borderRadius: '0.375rem',
                  border: `1px solid ${selectedProjects.length > 0 ? '#10b981' : '#334155'}`,
                  backgroundColor: selectedProjects.length > 0 ? 'rgba(16, 185, 129, 0.15)' : '#0f172a',
                  color: selectedProjects.length > 0 ? '#6ee7b7' : '#cbd5e1',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                }}
              >
                <FolderGit2 size={13} color={selectedProjects.length > 0 ? '#10b981' : '#94a3b8'} />
                <span>Projects {selectedProjects.length > 0 ? `(${selectedProjects.length})` : ''}</span>
                <ChevronDown size={12} />
              </button>

              {showProjectDropdown && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: '0.35rem',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '0.375rem',
                    padding: '0.5rem',
                    zIndex: 50,
                    minWidth: '220px',
                    maxHeight: '260px',
                    overflowY: 'auto',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  }}
                >
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.4rem', borderBottom: '1px solid #1e293b', paddingBottom: '0.3rem' }}>
                    Filter by project
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {availableProjects.map((proj) => {
                      const selected = selectedProjects.includes(proj.id);
                      return (
                        <div
                          key={proj.id}
                          onClick={() => toggleProject(proj.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0.25rem 0.4rem',
                            borderRadius: '0.25rem',
                            backgroundColor: selected ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                            cursor: 'pointer',
                          }}
                        >
                          <ProjectChip project={proj.id} kind={proj.kind} size="xs" />
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => {}}
                            style={{ cursor: 'pointer' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Group by project toggle (Common View) */}
          {showProjectControls && (
            <button
              type="button"
              onClick={() => updateFilters({ groupByProject: !filters.groupByProject })}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.25rem 0.55rem',
                borderRadius: '0.375rem',
                border: `1px solid ${filters.groupByProject ? '#10b981' : '#334155'}`,
                backgroundColor: filters.groupByProject ? 'rgba(16, 185, 129, 0.2)' : '#0f172a',
                color: filters.groupByProject ? '#d1fae5' : '#cbd5e1',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
              title="Group tasks by project"
            >
              <FolderGit2 size={12} color={filters.groupByProject ? '#34d399' : '#94a3b8'} />
              <span>Group by Project</span>
            </button>
          )}

          {/* Labels Dropdown Trigger */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                setShowLabelDropdown((v) => !v);
                setShowStateDropdown(false);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.25rem 0.55rem',
                borderRadius: '0.375rem',
                border: `1px solid ${filters.labels.length > 0 ? '#818cf8' : '#334155'}`,
                backgroundColor: filters.labels.length > 0 ? 'rgba(129, 140, 248, 0.15)' : '#0f172a',
                color: filters.labels.length > 0 ? '#c7d2fe' : '#cbd5e1',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 500,
              }}
            >
              <Tag size={13} color={filters.labels.length > 0 ? '#818cf8' : '#94a3b8'} />
              <span>Labels {filters.labels.length > 0 ? `(${filters.labels.length})` : ''}</span>
              <ChevronDown size={12} />
            </button>

            {/* Labels Dropdown Menu */}
            {showLabelDropdown && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: '0.35rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  padding: '0.5rem',
                  zIndex: 50,
                  minWidth: '220px',
                  maxWidth: '300px',
                  maxHeight: '260px',
                  overflowY: 'auto',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
              >
                <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.4rem', borderBottom: '1px solid #1e293b', paddingBottom: '0.3rem' }}>
                  Filter by label
                </div>
                {repoLabels.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {repoLabels.map((lbl) => {
                      const selected = filters.labels.includes(lbl);
                      return (
                        <div
                          key={lbl}
                          onClick={() => toggleLabel(lbl)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0.25rem 0.4rem',
                            borderRadius: '0.25rem',
                            backgroundColor: selected ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                            cursor: 'pointer',
                          }}
                        >
                          <LabelChip label={lbl} size="xs" />
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => {}}
                            style={{ cursor: 'pointer' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.75rem', color: '#64748b', fontStyle: 'italic', padding: '0.5rem' }}>
                    No labels found
                  </div>
                )}
              </div>
            )}
          </div>

          {/* State Dropdown Trigger */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                setShowStateDropdown((v) => !v);
                setShowLabelDropdown(false);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.25rem 0.55rem',
                borderRadius: '0.375rem',
                border: `1px solid ${filters.states.length > 0 ? '#38bdf8' : '#334155'}`,
                backgroundColor: filters.states.length > 0 ? 'rgba(56, 189, 248, 0.15)' : '#0f172a',
                color: filters.states.length > 0 ? '#bae6fd' : '#cbd5e1',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 500,
              }}
            >
              <Filter size={13} color={filters.states.length > 0 ? '#38bdf8' : '#94a3b8'} />
              <span>State {filters.states.length > 0 ? `(${filters.states.length})` : ''}</span>
              <ChevronDown size={12} />
            </button>

            {/* State Dropdown Menu */}
            {showStateDropdown && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: '0.35rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  padding: '0.5rem',
                  zIndex: 50,
                  minWidth: '180px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
              >
                <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.4rem', borderBottom: '1px solid #1e293b', paddingBottom: '0.3rem' }}>
                  Filter by state
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  {POPULAR_STATES.map((st) => {
                    const selected = filters.states.includes(st);
                    return (
                      <div
                        key={st}
                        onClick={() => toggleState(st)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '0.25rem 0.4rem',
                          borderRadius: '0.25rem',
                          backgroundColor: selected ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                          color: '#e2e8f0',
                        }}
                      >
                        <span>{st}</span>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {}}
                          style={{ cursor: 'pointer' }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Group by label toggle (if supported by active view e.g. Tree) */}
          {showGroupByLabel && (
            <button
              type="button"
              onClick={() => updateFilters({ groupByLabel: !filters.groupByLabel })}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.25rem 0.55rem',
                borderRadius: '0.375rem',
                border: `1px solid ${filters.groupByLabel ? '#a855f7' : '#334155'}`,
                backgroundColor: filters.groupByLabel ? 'rgba(168, 85, 247, 0.2)' : '#0f172a',
                color: filters.groupByLabel ? '#f3e8ff' : '#cbd5e1',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
              title="Group tasks by their label headers"
            >
              <Tag size={12} color={filters.groupByLabel ? '#c084fc' : '#94a3b8'} />
              <span>Group by Label</span>
            </button>
          )}

          {/* Reset/Clear button */}
          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleClearFilters}
              title="Reset all filters"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                padding: '0.25rem 0.5rem',
                borderRadius: '0.375rem',
                border: '1px solid #475569',
                backgroundColor: 'transparent',
                color: '#94a3b8',
                cursor: 'pointer',
                fontSize: '0.75rem',
              }}
            >
              <RotateCcw size={12} />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Active Labels Strip (if any selected) */}
      {filters.labels.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', paddingTop: '0.25rem', borderTop: '1px solid #334155' }}>
          <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Filtering by labels:</span>
          {filters.labels.map((lbl) => (
            <LabelChip
              key={lbl}
              label={lbl}
              size="xs"
              onRemove={() => toggleLabel(lbl)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Helper matching function for TaskItem or TaskGraphNode
export function matchTaskFilters(
  task: {
    id: string;
    project?: string;
    qualified_id?: string;
    title: string;
    short_title?: string;
    kind?: string;
    labels?: string[];
    state?: string;
    priority?: string;
    category?: string;
    group?: string;
    executor?: string;
  },
  filters: SharedFilterState
): boolean {
  // Project filter
  if (filters.projects && filters.projects.length > 0 && task.project) {
    if (!filters.projects.includes(task.project)) {
      return false;
    }
  }

  // Text search
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const idMatch = task.id.toLowerCase().includes(q);
    const qidMatch = (task.qualified_id || '').toLowerCase().includes(q);
    const projMatch = (task.project || '').toLowerCase().includes(q);
    const titleMatch = task.title.toLowerCase().includes(q);
    const shortMatch = (task.short_title || '').toLowerCase().includes(q);
    const catMatch = (task.category || task.group || '').toLowerCase().includes(q);
    const execMatch = (task.executor || '').toLowerCase().includes(q);
    if (!idMatch && !qidMatch && !projMatch && !titleMatch && !shortMatch && !catMatch && !execMatch) {
      return false;
    }
  }

  // Kind filter: OR within kind filter
  if (filters.kinds.length > 0) {
    const taskKind = (task.kind || '').toLowerCase();
    if (!filters.kinds.includes(taskKind as TaskKind)) {
      return false;
    }
  }

  // Label filter: OR within label filter
  if (filters.labels.length > 0) {
    const taskLabels = (task.labels || []).map((l) => l.toLowerCase());
    const hasAny = filters.labels.some((l) => taskLabels.includes(l.toLowerCase()));
    if (!hasAny) {
      return false;
    }
  }

  // State filter: OR within state filter
  if (filters.states.length > 0) {
    const taskState = (task.state || '').toLowerCase();
    if (!filters.states.includes(taskState as TaskState)) {
      return false;
    }
  }

  // Priority filter
  if (filters.priority && filters.priority !== 'all') {
    if (task.priority !== filters.priority) {
      return false;
    }
  }

  return true;
}
