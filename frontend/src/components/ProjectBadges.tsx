import React, { useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Check,
  HelpCircle,
  Inbox,
  GitBranch,
  Clock,
} from 'lucide-react';
import {
  TaskConditionItem,
  TaskCoordinateItem,
  WorkspaceProjectInfo,
  TaskItem,
  shortTitle,
} from '../types';

export const PROJECT_PALETTE: Array<{
  bg: string;
  text: string;
  border: string;
  dot: string;
}> = [
  // 0: Sky Blue
  { bg: 'rgba(14, 165, 233, 0.16)', text: '#38bdf8', border: 'rgba(14, 165, 233, 0.45)', dot: '#0ea5e9' },
  // 1: Emerald Green
  { bg: 'rgba(16, 185, 129, 0.16)', text: '#34d399', border: 'rgba(16, 185, 129, 0.45)', dot: '#10b981' },
  // 2: Amber Gold
  { bg: 'rgba(245, 158, 11, 0.16)', text: '#fbbf24', border: 'rgba(245, 158, 11, 0.45)', dot: '#f59e0b' },
  // 3: Violet Purple
  { bg: 'rgba(168, 85, 247, 0.16)', text: '#c084fc', border: 'rgba(168, 85, 247, 0.45)', dot: '#a855f7' },
  // 4: Rose Pink
  { bg: 'rgba(244, 63, 94, 0.16)', text: '#fb7185', border: 'rgba(244, 63, 94, 0.45)', dot: '#f43f5e' },
  // 5: Cyan Teal
  { bg: 'rgba(6, 182, 212, 0.16)', text: '#22d3ee', border: 'rgba(6, 182, 212, 0.45)', dot: '#06b6d4' },
  // 6: Orange Coral
  { bg: 'rgba(249, 115, 22, 0.16)', text: '#fb923c', border: 'rgba(249, 115, 22, 0.45)', dot: '#f97316' },
  // 7: Lime Green
  { bg: 'rgba(132, 204, 22, 0.16)', text: '#a3e635', border: 'rgba(132, 204, 22, 0.45)', dot: '#84cc16' },
  // 8: Indigo
  { bg: 'rgba(99, 102, 241, 0.16)', text: '#818cf8', border: 'rgba(99, 102, 241, 0.45)', dot: '#6366f1' },
  // 9: Fuchsia Magenta
  { bg: 'rgba(217, 70, 239, 0.16)', text: '#e879f9', border: 'rgba(217, 70, 239, 0.45)', dot: '#d946ef' },
];

const assignedProjectColors = new Map<string, number>();

export function registerProjectColorOrder(projectIds: string[]): void {
  projectIds.forEach((id, idx) => {
    if (id && !assignedProjectColors.has(id)) {
      assignedProjectColors.set(id, idx % PROJECT_PALETTE.length);
    }
  });
}

export function getProjectColor(projectId: string): {
  bg: string;
  text: string;
  border: string;
  dot: string;
} {
  if (!projectId) {
    return PROJECT_PALETTE[0];
  }
  const existing = assignedProjectColors.get(projectId);
  if (existing !== undefined) {
    return PROJECT_PALETTE[existing % PROJECT_PALETTE.length];
  }
  const nextIndex = assignedProjectColors.size % PROJECT_PALETTE.length;
  assignedProjectColors.set(projectId, nextIndex);
  return PROJECT_PALETTE[nextIndex];
}

export const ProjectChip: React.FC<{
  project: string;
  kind?: string;
  size?: 'xs' | 'sm' | 'md';
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}> = ({ project, kind, size = 'xs', onClick, style }) => {
  if (!project) return null;
  const colors = getProjectColor(project);
  const sizeStyles = {
    xs: { fontSize: '0.65rem', padding: '0.05rem 0.35rem', dotSize: 6 },
    sm: { fontSize: '0.72rem', padding: '0.1rem 0.45rem', dotSize: 7 },
    md: { fontSize: '0.78rem', padding: '0.15rem 0.55rem', dotSize: 8 },
  }[size];

  return (
    <span
      onClick={onClick}
      title={`Project: ${project}${kind ? ` (${kind})` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        borderRadius: '0.25rem',
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        fontSize: sizeStyles.fontSize,
        fontWeight: 700,
        padding: sizeStyles.padding,
        lineHeight: 1.2,
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        fontFamily: 'monospace',
        userSelect: 'none',
        ...style,
      }}
    >
      <span
        style={{
          width: sizeStyles.dotSize,
          height: sizeStyles.dotSize,
          borderRadius: '50%',
          backgroundColor: colors.dot,
          flexShrink: 0,
        }}
      />
      <span>{project}</span>
      {kind && kind !== 'project' && (
        <span
          style={{
            fontSize: '0.58rem',
            opacity: 0.85,
            fontWeight: 500,
            fontFamily: 'sans-serif',
          }}
        >
          ({kind})
        </span>
      )}
    </span>
  );
};

export function formatTaskIdentifier(
  task: { id: string; project?: string; qualified_id?: string; short_title?: string; short?: string; title?: string },
  isCommonView?: boolean
): string {
  const st = task.short_title || task.short || shortTitle(task);
  const baseId = isCommonView && task.project ? `${task.project}/${task.id}` : task.id;
  return st ? `${baseId} (${st})` : baseId;
}

export const ConditionalBadge: React.FC<{
  conditional?: boolean;
  conditions?: TaskConditionItem[];
  size?: 'xs' | 'sm';
  style?: React.CSSProperties;
}> = ({ conditional, conditions, size = 'xs', style }) => {
  if (!conditional) return null;

  const openConds = (conditions || []).filter((c) => c.status !== 'answered');
  const displayConds = openConds.length > 0 ? openConds : conditions || [];
  const hasStale = displayConds.some((c) => (c.age_days ?? 0) > 7);

  const labelParts = displayConds.map((c) => {
    const age = c.age_days ?? 0;
    const dec = c.decider || 'owner';
    return `${c.id} (${age} d, ${dec})`;
  });

  const text =
    labelParts.length > 0
      ? `conditional: ${labelParts.join(', ')}`
      : 'conditional';

  const bg = hasStale ? 'rgba(239, 68, 68, 0.18)' : 'rgba(245, 158, 11, 0.16)';
  const border = hasStale ? '#ef4444' : '#f59e0b';
  const color = hasStale ? '#fca5a5' : '#fde68a';

  return (
    <span
      title={
        hasStale
          ? `Conditional task with stale open condition (> 7 days): ${labelParts.join(', ')}`
          : `Conditional task awaiting decision: ${labelParts.join(', ')}`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: size === 'xs' ? '0.08rem 0.38rem' : '0.12rem 0.5rem',
        borderRadius: '0.25rem',
        backgroundColor: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: size === 'xs' ? '0.65rem' : '0.72rem',
        fontWeight: 700,
        lineHeight: 1.2,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <Clock size={size === 'xs' ? 10 : 12} color={hasStale ? '#f87171' : '#fbbf24'} />
      <span>{text}</span>
    </span>
  );
};

export function getPlacementWarnings(task: {
  placement_warning?: string;
  placement_warnings?: string[];
  warnings?: string[];
  [key: string]: any;
}): string[] {
  const list: string[] = [];
  if (task.placement_warning && typeof task.placement_warning === 'string') {
    list.push(task.placement_warning);
  }
  if (Array.isArray(task.placement_warnings)) {
    task.placement_warnings.forEach((w) => {
      if (w && typeof w === 'string') list.push(w);
    });
  }
  if (Array.isArray(task.warnings)) {
    task.warnings.forEach((w) => {
      if (w && typeof w === 'string') list.push(w);
    });
  }
  return Array.from(new Set(list));
}

export const PlacementWarningChip: React.FC<{
  warnings?: string[];
  size?: 'xs' | 'sm';
}> = ({ warnings, size = 'xs' }) => {
  if (!warnings || warnings.length === 0) return null;
  const fullText = warnings.join('; ');
  return (
    <span
      title={`Placement warning: ${fullText}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: size === 'xs' ? '0.08rem 0.38rem' : '0.12rem 0.45rem',
        borderRadius: '0.25rem',
        backgroundColor: 'rgba(245, 158, 11, 0.16)',
        border: '1px solid #d97706',
        color: '#fcd34d',
        fontSize: size === 'xs' ? '0.65rem' : '0.72rem',
        fontWeight: 600,
        flexShrink: 0,
        maxWidth: '280px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      <AlertTriangle size={size === 'xs' ? 10 : 12} color="#f59e0b" style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{warnings[0]}</span>
    </span>
  );
};

export function normalizeCoordinates(task?: {
  coordinates?: TaskCoordinateItem[];
  coordinates_refs?: string[];
  coordinates_raw?: string;
  [key: string]: any;
} | null): TaskCoordinateItem[] {
  if (!task) return [];
  if (Array.isArray(task.coordinates) && task.coordinates.length > 0) {
    return task.coordinates;
  }
  const refs: string[] = Array.isArray(task.coordinates_refs) && task.coordinates_refs.length > 0
    ? task.coordinates_refs
    : typeof task.coordinates_raw === 'string' && task.coordinates_raw !== '-'
    ? task.coordinates_raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  return refs
    .map((ref) => {
      const idx = ref.indexOf('/');
      if (idx > 0) {
        return {
          project: ref.slice(0, idx).trim(),
          id: ref.slice(idx + 1).trim(),
        };
      }
      return { project: '', id: ref.trim() };
    })
    .filter((c) => Boolean(c.id));
}

export const CoordinatesExpansionList: React.FC<{
  coordinates?: TaskCoordinateItem[];
  task?: { coordinates?: TaskCoordinateItem[]; coordinates_refs?: string[]; coordinates_raw?: string; [key: string]: any } | null;
  onSelectTarget?: (project: string, taskId: string) => void;
  compact?: boolean;
}> = ({ coordinates, task, onSelectTarget, compact = false }) => {
  const list = coordinates && coordinates.length > 0 ? coordinates : normalizeCoordinates(task);
  if (!list || list.length === 0) return null;

  const getStateBadgeColors = (st?: string) => {
    const s = (st || 'open').toLowerCase();
    if (s === 'done' || s === 'done with a caveat' || s === 'verified') {
      return { bg: '#064e3b', text: '#6ee7b7', border: '#059669' };
    }
    if (s === 'in progress') {
      return { bg: '#312e81', text: '#c7d2fe', border: '#6366f1' };
    }
    if (s === 'delivered') {
      return { bg: '#0c4a6e', text: '#bae6fd', border: '#0284c7' };
    }
    if (s === 'waiting' || s === 'blocked' || s === 'paused' || s === 'bounced') {
      return { bg: '#78350f', text: '#fde68a', border: '#d97706' };
    }
    return { bg: '#1e293b', text: '#cbd5e1', border: '#475569' };
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        marginTop: compact ? '0.3rem' : '0.4rem',
        padding: compact ? '0.3rem 0.45rem' : '0.4rem 0.6rem',
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        border: '1px solid #334155',
        borderRadius: '0.3rem',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: '#94a3b8',
          textTransform: 'uppercase',
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
        }}
      >
        <GitBranch size={10} color="#818cf8" />
        <span>Coordinates ({list.length})</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
        {list.map((c, idx) => {
          const stColors = getStateBadgeColors(c.state);
          const qid = c.project ? `${c.project}/${c.id}` : c.id;
          return (
            <div
              key={`${qid}-${idx}`}
              onClick={() => onSelectTarget?.(c.project, c.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.15rem 0.4rem',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.25rem',
                fontSize: '0.7rem',
                cursor: onSelectTarget ? 'pointer' : 'default',
              }}
            >
              {c.project && <ProjectChip project={c.project} size="xs" />}
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#e2e8f0' }}>
                {qid}
              </span>
              {c.short_title && (
                <span
                  style={{
                    color: '#94a3b8',
                    maxWidth: '160px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={c.short_title}
                >
                  ({c.short_title})
                </span>
              )}
              {c.state && (
                <span
                  style={{
                    fontSize: '0.62rem',
                    fontWeight: 600,
                    padding: '0.05rem 0.3rem',
                    borderRadius: '999px',
                    backgroundColor: stColors.bg,
                    color: stColors.text,
                    border: `1px solid ${stColors.border}`,
                  }}
                >
                  {c.state}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const UnregisteredWorkspaceBanner: React.FC<{
  rootPath: string;
}> = ({ rootPath }) => {
  const [copied, setCopied] = useState(false);
  const quotedPath = /\s/.test(rootPath) ? `"${rootPath.replace(/"/g, '\\"')}"` : rootPath;
  const cliCommand = `ai-orch projects discover ${quotedPath} --apply`;

  const handleCopy = () => {
    navigator.clipboard.writeText(cliCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        maxWidth: '1400px',
        margin: '0.85rem auto 0',
        padding: '0 1.5rem',
        boxSizing: 'border-box',
        width: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          padding: '0.65rem 1rem',
          backgroundColor: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid #d97706',
          borderRadius: '0.5rem',
          color: '#fef3c7',
          fontSize: '0.82rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexWrap: 'wrap' }}>
          <AlertTriangle size={16} color="#f59e0b" style={{ flexShrink: 0 }} />
          <span style={{ fontWeight: 600 }}>Projects discovered, not registered</span>
          <span style={{ color: '#cbd5e1' }}>— Register this workspace to persist project slugs:</span>
          <code
            style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              padding: '0.15rem 0.45rem',
              borderRadius: '0.25rem',
              color: '#fde68a',
              fontFamily: 'monospace',
              fontSize: '0.78rem',
            }}
          >
            {cliCommand}
          </code>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.3rem',
            padding: '0.3rem 0.65rem',
            borderRadius: '0.3rem',
            border: '1px solid #f59e0b',
            backgroundColor: copied ? '#065f46' : '#78350f',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {copied ? <Check size={13} color="#34d399" /> : <Copy size={13} />}
          <span>{copied ? 'Copied' : 'Copy Command'}</span>
        </button>
      </div>
    </div>
  );
};

export const WorkspaceDashboardStrip: React.FC<{
  projects: WorkspaceProjectInfo[];
  tasks?: TaskItem[];
  selectedProject: string | null;
  onSelectProject: (projectId: string | null) => void;
}> = ({ projects, tasks = [], selectedProject, onSelectProject }) => {
  if (!projects || projects.length <= 1) return null;
  registerProjectColorOrder(projects.map((p) => p.id));

  // Compute conditional task counts per project from tasks if present
  const conditionalByProject: Record<string, number> = {};
  tasks.forEach((t) => {
    if (t.conditional && t.project) {
      conditionalByProject[t.project] = (conditionalByProject[t.project] || 0) + 1;
    }
  });

  return (
    <div
      style={{
        maxWidth: '1400px',
        margin: '0.85rem auto 0',
        padding: '0 1.5rem',
        boxSizing: 'border-box',
        width: '100%',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '0.65rem',
        }}
      >
        {projects.map((proj) => {
          const colors = getProjectColor(proj.id);
          const counts = proj.counts || ({} as any);
          const openCount = counts.open ?? 0;
          const inProgCount = counts['in progress'] ?? 0;
          const waitingCount = (counts.waiting ?? 0) + (counts.blocked ?? 0);
          const deliveredCount = counts.delivered ?? 0;
          const verifiedCount = counts.verified ?? 0;
          const condCount =
            proj.conditional ??
            counts.conditional ??
            conditionalByProject[proj.id] ??
            0;
          const isSelected = selectedProject === proj.id;

          return (
            <div
              key={proj.id}
              onClick={() => onSelectProject(isSelected ? null : proj.id)}
              style={{
                backgroundColor: '#1e293b',
                border: `1px solid ${isSelected ? colors.dot : '#334155'}`,
                borderRadius: '0.5rem',
                padding: '0.65rem 0.85rem',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.45rem',
                transition: 'border-color 0.15s ease, transform 0.1s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = colors.dot;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = isSelected ? colors.dot : '#334155';
              }}
            >
              {/* Card Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                  <ProjectChip project={proj.id} kind={proj.kind} size="sm" />
                  {proj.kind === 'sub_workspace' && (
                    <span
                      style={{
                        fontSize: '0.62rem',
                        padding: '0.05rem 0.3rem',
                        borderRadius: '0.2rem',
                        backgroundColor: '#334155',
                        color: '#94a3b8',
                        fontWeight: 600,
                      }}
                    >
                      read-only
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.72rem' }}>
                  {(proj.open_questions ?? 0) > 0 && (
                    <span
                      title={`${proj.open_questions} open question(s)`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.2rem',
                        color: '#fca5a5',
                        fontWeight: 700,
                      }}
                    >
                      <HelpCircle size={12} color="#ef4444" />
                      {proj.open_questions}
                    </span>
                  )}
                  {(proj.inbox_notes ?? 0) > 0 && (
                    <span
                      title={`${proj.inbox_notes} open inbox note(s)`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.2rem',
                        color: '#93c5fd',
                        fontWeight: 700,
                      }}
                    >
                      <Inbox size={12} color="#38bdf8" />
                      {proj.inbox_notes}
                    </span>
                  )}
                </div>
              </div>

              {/* Counts row */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  fontSize: '0.72rem',
                  color: '#94a3b8',
                }}
              >
                <span>
                  Open: <strong style={{ color: '#e2e8f0' }}>{openCount}</strong>
                </span>
                <span>
                  In Prog: <strong style={{ color: '#818cf8' }}>{inProgCount}</strong>
                </span>
                <span>
                  Waiting: <strong style={{ color: '#fbbf24' }}>{waitingCount}</strong>
                </span>
                <span>
                  Delivered: <strong style={{ color: '#38bdf8' }}>{deliveredCount}</strong>
                </span>
                <span>
                  Verified: <strong style={{ color: '#34d399' }}>{verifiedCount}</strong>
                </span>
                {condCount > 0 && (
                  <span
                    style={{
                      backgroundColor: 'rgba(245, 158, 11, 0.18)',
                      border: '1px solid #f59e0b',
                      color: '#fde68a',
                      padding: '0.02rem 0.35rem',
                      borderRadius: '0.25rem',
                      fontWeight: 700,
                    }}
                  >
                    Conditional: {condCount}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
