import React, { useState, useRef, useEffect } from 'react';
import {
  Flame,
  Plus,
  X,
  AlertTriangle,
  Link2,
  ChevronDown,
  ArrowUpRight,
} from 'lucide-react';
import { TaskGraphNode, TaskSize, shortTitle } from '../types';
import { KindBadge } from './KindBadge';
import { LabelList } from './LabelChip';
import { PromoteDialog } from './PromoteDialog';

interface TimelineCardProps {
  node: TaskGraphNode;
  allNodes: TaskGraphNode[];
  allEdges: Array<{ from: string; to: string }>;
  isHeaviestChain: boolean;
  isSelected: boolean;
  onSelectTask?: (task: TaskGraphNode) => void;
  onRequestSetPriority: (taskId: string, priority: 'P0' | 'P1' | 'P2' | 'P3', reason?: string) => Promise<void>;
  onRequestSetSize: (taskId: string, size: TaskSize) => Promise<void>;
  onRequestAddDep: (taskId: string, depId: string) => Promise<void>;
  onRequestRemoveDep: (taskId: string, depId: string) => Promise<void>;
  onRefresh?: () => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  P0: '#ef4444',
  P1: '#f59e0b',
  P2: '#3b82f6',
  P3: '#64748b',
};

const STATE_COLORS: Record<string, string> = {
  open: '#94a3b8',
  'in progress': '#6366f1',
  bounced: '#818cf8',
  waiting: '#f59e0b',
  blocked: '#f43f5e',
  paused: '#64748b',
  delivered: '#0ea5e9',
  verified: '#10b981',
  done: '#475569',
  'done with a caveat': '#64748b',
  dropped: '#475569',
};

const SIZE_WIDTHS: Record<TaskSize, number> = {
  XS: 140,
  S: 180,
  M: 230,
  L: 280,
  XL: 340,
};

// Deterministic initiative color generator
const getGroupColor = (group: string) => {
  const PRESET: Record<string, string> = {
    '01': '#6366f1',
    '06': '#10b981',
    '07': '#14b8a6',
    '08': '#84cc16',
    '09': '#a855f7',
    '10': '#ec4899',
    '11': '#f97316',
    '12': '#3b82f6',
    '13': '#06b6d4',
    '15': '#8b5cf6',
    'env-doctor': '#0284c7',
    'server-and-bindings': '#64748b',
    micro: '#71717a',
    methodology: '#d97706',
  };
  if (PRESET[group]) return PRESET[group];
  let hash = 0;
  for (let i = 0; i < group.length; i++) {
    hash = group.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 65%, 55%)`;
};

export const TimelineCard: React.FC<TimelineCardProps> = ({
  node,
  allNodes,
  allEdges,
  isHeaviestChain,
  isSelected,
  onSelectTask,
  onRequestSetPriority,
  onRequestSetSize,
  onRequestAddDep,
  onRequestRemoveDep,
  onRefresh,
}) => {
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);
  const [showSizeMenu, setShowSizeMenu] = useState(false);
  const [showDepPicker, setShowDepPicker] = useState(false);
  const [showPromote, setShowPromote] = useState(false);

  // Priority edit state
  const [selectedPriority, setSelectedPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>(node.priority);
  const [priorityReason, setPriorityReason] = useState('');
  const [isSubmittingPrio, setIsSubmittingPrio] = useState(false);

  // Size edit state
  const [isSubmittingSize, setIsSubmittingSize] = useState(false);

  // Dep picker search
  const [depSearch, setDepSearch] = useState('');
  const [candidateCycles, setCandidateCycles] = useState<Record<string, { hasCycle: boolean; message?: string }>>({});
  const [isAddingDep, setIsAddingDep] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const groupColor = getGroupColor(node.group);
  const size = node.size || 'M';
  const cardWidth = SIZE_WIDTHS[size] || 230;
  const isDefaultSize = node.size_source === 'default';
  const isMicro = size === 'XS' || node.group === 'micro' || node.node_type === 'microtask';

  // Compute in-memory graph reachable descendants to instantly flag cycles
  const downstreamDescendants = React.useMemo(() => {
    const set = new Set<string>();
    const queue = [node.id];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      // Find all edges where curr is the dependency (source) and target depends on curr
      for (const e of allEdges) {
        if (e.from === curr && !set.has(e.to)) {
          set.add(e.to);
          queue.push(e.to);
        }
      }
    }
    return set;
  }, [node.id, allEdges]);

  // When dep picker opens, check candidates
  useEffect(() => {
    if (!showDepPicker) return;
    const candidates = allNodes.filter(
      (n) => n.id !== node.id && !node.depends_on.includes(n.id) && n.state !== 'done' && n.state !== 'dropped'
    );

    // Initial pass using in-memory downstream reachability
    const map: Record<string, { hasCycle: boolean; message?: string }> = {};
    for (const c of candidates) {
      if (downstreamDescendants.has(c.id)) {
        map[c.id] = {
          hasCycle: true,
          message: `Cycle detected: ${node.id} is already a dependency of ${c.id}`,
        };
      }
    }
    setCandidateCycles(map);
  }, [showDepPicker, allNodes, node.id, node.depends_on, downstreamDescendants]);

  const handleApplyPriority = async () => {
    setIsSubmittingPrio(true);
    try {
      await onRequestSetPriority(node.id, selectedPriority, priorityReason.trim() || undefined);
      setShowPriorityMenu(false);
    } catch {
      // Handled in parent
    } finally {
      setIsSubmittingPrio(false);
    }
  };

  const handleApplySize = async (newSize: TaskSize) => {
    setIsSubmittingSize(true);
    try {
      await onRequestSetSize(node.id, newSize);
      setShowSizeMenu(false);
    } catch {
      // Handled in parent
    } finally {
      setIsSubmittingSize(false);
    }
  };

  const handleSelectCandidate = async (candId: string) => {
    setIsAddingDep(true);
    try {
      await onRequestAddDep(node.id, candId);
      setShowDepPicker(false);
    } catch (err: any) {
      // If cycle detected from server preview, record message
      setCandidateCycles((prev) => ({
        ...prev,
        [candId]: {
          hasCycle: true,
          message: err?.message || 'Cycle detected in dependencies',
        },
      }));
    } finally {
      setIsAddingDep(false);
    }
  };

  if (isMicro) {
    return (
      <>
        <div
          ref={cardRef}
          id={`timeline-card-${node.id}`}
          data-task-id={node.id}
          data-card-id={node.id}
          data-column={node.column}
          style={{
            width: `${Math.max(160, cardWidth)}px`,
            backgroundColor: isSelected ? '#1e1b4b' : '#0f172a',
            borderRadius: '9999px',
            border: isHeaviestChain
              ? '2px solid #f59e0b'
              : isSelected
              ? '2px solid #6366f1'
              : '1px solid #334155',
            boxShadow: isHeaviestChain ? '0 0 10px rgba(245, 158, 11, 0.3)' : '0 2px 4px rgba(0,0,0,0.2)',
            padding: '0.25rem 0.55rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            position: 'relative',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            boxSizing: 'border-box',
          }}
          onMouseEnter={(e) => {
            if (!isSelected) {
              e.currentTarget.style.borderColor = '#6366f1';
              e.currentTarget.style.backgroundColor = '#1e293b';
            }
          }}
          onMouseLeave={(e) => {
            if (!isSelected) {
              e.currentTarget.style.borderColor = '#334155';
              e.currentTarget.style.backgroundColor = '#0f172a';
            }
          }}
          onClick={() => onSelectTask?.(node)}
        >
          {node.kind && <KindBadge kind={node.kind} size={11} />}
          <span
            style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              color: '#a1a1aa',
              backgroundColor: '#27272a',
              padding: '0.05rem 0.25rem',
              borderRadius: '9999px',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}
          >
            micro
          </span>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#38bdf8', fontFamily: 'monospace', flexShrink: 0 }}>
            {node.id}
          </span>
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 500,
              color: '#f8fafc',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '85px',
              flex: 1,
            }}
            title={node.title}
          >
            {node.title}
          </span>
          <span
            style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              padding: '0.05rem 0.3rem',
              borderRadius: '9999px',
              backgroundColor: PRIORITY_COLORS[node.priority] || '#64748b',
              color: '#fff',
              flexShrink: 0,
            }}
          >
            {node.priority}
          </span>
          <span
            style={{
              fontSize: '0.62rem',
              fontWeight: 600,
              padding: '0.05rem 0.25rem',
              borderRadius: '9999px',
              backgroundColor: '#1e293b',
              border: '1px solid #475569',
              color: '#cbd5e1',
              flexShrink: 0,
            }}
          >
            XS
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowPromote(true);
            }}
            title="Promote to full task"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.15rem',
              padding: '0.1rem 0.3rem',
              borderRadius: '9999px',
              backgroundColor: 'rgba(99, 102, 241, 0.2)',
              border: '1px solid #4f46e5',
              color: '#c7d2fe',
              fontSize: '0.62rem',
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <ArrowUpRight size={10} />
            <span>Promote</span>
          </button>
        </div>

        {showPromote && (
          <PromoteDialog
            taskId={node.id}
            taskTitle={node.title}
            isOpen={true}
            onClose={() => setShowPromote(false)}
            onSuccess={() => {
              setShowPromote(false);
              onRefresh?.();
            }}
          />
        )}
      </>
    );
  }

  return (
    <div
      ref={cardRef}
      id={`timeline-card-${node.id}`}
      data-task-id={node.id}
      data-card-id={node.id}
      data-column={node.column}
      style={{
        width: `${cardWidth}px`,
        backgroundColor: '#1e293b',
        borderRadius: '0.375rem',
        borderLeft: `4px solid ${groupColor}`,
        borderTop: isHeaviestChain ? '2px solid #f59e0b' : isDefaultSize ? '1px dashed #475569' : '1px solid #334155',
        borderRight: isHeaviestChain ? '2px solid #f59e0b' : isDefaultSize ? '1px dashed #475569' : '1px solid #334155',
        borderBottom: isHeaviestChain ? '2px solid #f59e0b' : isDefaultSize ? '1px dashed #475569' : '1px solid #334155',
        boxShadow: isHeaviestChain
          ? '0 0 12px rgba(245, 158, 11, 0.25)'
          : isSelected
          ? '0 0 0 2px #38bdf8'
          : '0 2px 4px rgba(0,0,0,0.2)',
        padding: '0.625rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        position: 'relative',
        transition: 'all 0.15s ease',
      }}
    >
      {/* Top Meta Row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden' }}>
          {/* Initiative / Group Badge */}
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              color: groupColor,
              textTransform: 'uppercase',
              letterSpacing: '0.025em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '90px',
            }}
            title={`Group: ${node.group}`}
          >
            {node.group}
          </span>
          {node.kind && <KindBadge kind={node.kind} size={11} showLabel={false} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          {isHeaviestChain && (
            <span
              title="On Heaviest Chain"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.1rem 0.25rem',
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                borderRadius: '0.2rem',
                fontSize: '0.65rem',
                color: '#f59e0b',
                fontWeight: 600,
              }}
            >
              <Flame size={12} style={{ marginRight: '0.15rem' }} />
              Heavy
            </span>
          )}

          {/* State Chip */}
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 600,
              padding: '0.1rem 0.35rem',
              borderRadius: '0.2rem',
              backgroundColor: `${STATE_COLORS[node.state] || '#64748b'}22`,
              color: STATE_COLORS[node.state] || '#cbd5e1',
              border: `1px solid ${STATE_COLORS[node.state] || '#64748b'}66`,
            }}
          >
            {node.state}
          </span>
        </div>
      </div>

      {/* Second Row: ID, Priority, Size */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
        {/* Task ID clickable */}
        <button
          type="button"
          onClick={() => onSelectTask?.(node)}
          title="Open Task Details"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#38bdf8',
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
        >
          {node.id}
        </button>
        <span
          style={{
            fontSize: '0.75rem',
            color: '#94a3b8',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '140px',
          }}
          title={node.title}
        >
          ({shortTitle(node)})
        </span>

        {/* Priority Chip with Popover Trigger */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowPriorityMenu((v) => !v);
              setShowSizeMenu(false);
              setShowDepPicker(false);
            }}
            title={`Priority: ${node.priority} (${node.priority_source || 'own'}). Click to edit.`}
            style={{
              background: PRIORITY_COLORS[node.priority] || '#64748b',
              border: 'none',
              borderRadius: '0.2rem',
              color: '#fff',
              fontSize: '0.65rem',
              fontWeight: 700,
              padding: '0.15rem 0.35rem',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.15rem',
            }}
          >
            {node.priority}
            <ChevronDown size={10} />
          </button>

          {/* Priority Menu Popover */}
          {showPriorityMenu && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '0.25rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                padding: '0.5rem',
                zIndex: 40,
                width: '180px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}
            >
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.35rem' }}>
                Set Priority ({node.priority_source === 'own' ? 'own' : 'inherited'})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.25rem', marginBottom: '0.5rem' }}>
                {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setSelectedPriority(p)}
                    style={{
                      padding: '0.25rem',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      borderRadius: '0.2rem',
                      border: selectedPriority === p ? '1px solid #fff' : '1px solid transparent',
                      backgroundColor: PRIORITY_COLORS[p],
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <input
                type="text"
                placeholder="Reason (optional)"
                value={priorityReason}
                onChange={(e) => setPriorityReason(e.target.value)}
                style={{
                  width: '100%',
                  fontSize: '0.7rem',
                  padding: '0.25rem 0.35rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '0.2rem',
                  color: '#f8fafc',
                  marginBottom: '0.5rem',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.25rem' }}>
                <button
                  type="button"
                  onClick={() => setShowPriorityMenu(false)}
                  style={{
                    fontSize: '0.65rem',
                    padding: '0.2rem 0.4rem',
                    backgroundColor: 'transparent',
                    border: '1px solid #475569',
                    borderRadius: '0.2rem',
                    color: '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isSubmittingPrio}
                  onClick={handleApplyPriority}
                  style={{
                    fontSize: '0.65rem',
                    fontWeight: 600,
                    padding: '0.2rem 0.4rem',
                    backgroundColor: '#0284c7',
                    border: 'none',
                    borderRadius: '0.2rem',
                    color: '#fff',
                    cursor: 'pointer',
                  }}
                >
                  {isSubmittingPrio ? '...' : 'Preview'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Size Chip with Popover Trigger */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowSizeMenu((v) => !v);
              setShowPriorityMenu(false);
              setShowDepPicker(false);
            }}
            title={`Size: ${node.size || 'M'} (${node.size_source || 'default'}). Click to edit.`}
            style={{
              background: '#0f172a',
              border: isDefaultSize ? '1px dashed #64748b' : '1px solid #475569',
              borderRadius: '0.2rem',
              color: '#cbd5e1',
              fontSize: '0.65rem',
              fontWeight: 600,
              padding: '0.15rem 0.35rem',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.15rem',
            }}
          >
            {node.size || 'M'}
            <ChevronDown size={10} />
          </button>

          {/* Size Menu Popover */}
          {showSizeMenu && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '0.25rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                padding: '0.5rem',
                zIndex: 40,
                width: '160px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}
            >
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.35rem' }}>
                Set Size
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {(['XS', 'S', 'M', 'L', 'XL'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={isSubmittingSize}
                    onClick={() => handleApplySize(s)}
                    style={{
                      padding: '0.25rem 0.4rem',
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      borderRadius: '0.2rem',
                      border: node.size === s ? '1px solid #38bdf8' : '1px solid #334155',
                      backgroundColor: node.size === s ? '#1e293b' : 'transparent',
                      color: node.size === s ? '#38bdf8' : '#e2e8f0',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>{s}</span>
                    <span style={{ fontSize: '0.65rem', color: '#64748b' }}>
                      {s === 'XS' ? '0.5 w' : s === 'S' ? '1 w' : s === 'M' ? '2 w' : s === 'L' ? '3 w' : '4 w'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Task Title (Safe text rendering) */}
      <div
        onClick={() => onSelectTask?.(node)}
        title={node.title}
        style={{
          fontSize: '0.8rem',
          color: '#f8fafc',
          lineHeight: 1.35,
          cursor: 'pointer',
          wordBreak: 'break-word',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {node.title}
      </div>

      {/* Labels */}
      {node.labels && node.labels.length > 0 && (
        <LabelList labels={node.labels} maxVisible={3} size="xs" />
      )}

      {/* Dependencies Section */}
      <div
        style={{
          borderTop: '1px solid #334155',
          paddingTop: '0.35rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.3rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.65rem', color: '#64748b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
            <Link2 size={11} />
            Depends on:
          </span>

          {/* Add Dependency Trigger */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowDepPicker((v) => !v);
                setShowPriorityMenu(false);
                setShowSizeMenu(false);
              }}
              title="Add dependency"
              style={{
                background: 'transparent',
                border: '1px solid #475569',
                borderRadius: '0.2rem',
                color: '#38bdf8',
                fontSize: '0.65rem',
                fontWeight: 600,
                padding: '0.05rem 0.3rem',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.15rem',
              }}
            >
              <Plus size={10} />
              Add
            </button>

            {/* Dependency Picker Popover */}
            {showDepPicker && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: '0.25rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  padding: '0.5rem',
                  zIndex: 50,
                  width: '260px',
                  boxShadow: '0 6px 16px rgba(0,0,0,0.6)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#f1f5f9' }}>
                    Add Dependency
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowDepPicker(false)}
                    style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 0 }}
                  >
                    <X size={14} />
                  </button>
                </div>

                <input
                  type="text"
                  placeholder="Filter by ID or title..."
                  value={depSearch}
                  onChange={(e) => setDepSearch(e.target.value)}
                  style={{
                    width: '100%',
                    fontSize: '0.7rem',
                    padding: '0.25rem 0.35rem',
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '0.2rem',
                    color: '#f8fafc',
                    marginBottom: '0.5rem',
                    boxSizing: 'border-box',
                  }}
                />

                <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  {allNodes
                    .filter(
                      (cand) =>
                        cand.id !== node.id &&
                        !node.depends_on.includes(cand.id) &&
                        (cand.id.toLowerCase().includes(depSearch.toLowerCase()) ||
                          cand.title.toLowerCase().includes(depSearch.toLowerCase()))
                    )
                    .map((cand) => {
                      const cycleInfo = candidateCycles[cand.id];
                      const isDisabled = !!cycleInfo?.hasCycle || isAddingDep;

                      return (
                        <button
                          key={cand.id}
                          type="button"
                          disabled={isDisabled}
                          onClick={() => handleSelectCandidate(cand.id)}
                          title={
                            cycleInfo?.hasCycle
                              ? cycleInfo.message || 'Cannot add: would create a circular dependency cycle'
                              : `Add ${cand.id} as a dependency`
                          }
                          style={{
                            padding: '0.3rem 0.4rem',
                            fontSize: '0.7rem',
                            borderRadius: '0.25rem',
                            border: '1px solid #1e293b',
                            backgroundColor: isDisabled ? '#1c1917' : '#1e293b',
                            color: isDisabled ? '#78716c' : '#e2e8f0',
                            cursor: isDisabled ? 'not-allowed' : 'pointer',
                            textAlign: 'left',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.15rem',
                            opacity: isDisabled ? 0.6 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden' }}>
                              <span style={{ fontWeight: 700, color: isDisabled ? '#a8a29e' : '#38bdf8' }}>
                                {cand.id}
                              </span>
                              <span style={{ fontSize: '0.7rem', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                ({shortTitle(cand)})
                              </span>
                            </div>
                            {cycleInfo?.hasCycle && (
                              <span style={{ fontSize: '0.65rem', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
                                <AlertTriangle size={11} />
                                Cycle
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: '0.65rem',
                              color: isDisabled ? '#78716c' : '#94a3b8',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {cand.title}
                          </div>
                          {cycleInfo?.hasCycle && (
                            <div style={{ fontSize: '0.6rem', color: '#f87171', lineHeight: 1.2 }}>
                              {cycleInfo.message}
                            </div>
                          )}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Dependency Pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
          {node.depends_on && node.depends_on.length > 0 ? (
            node.depends_on.map((depId) => (
              <span
                key={depId}
                style={{
                  fontSize: '0.65rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.2rem',
                  padding: '0.05rem 0.25rem',
                  color: '#94a3b8',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.2rem',
                }}
              >
                <span>← {depId}</span>
                <button
                  type="button"
                  title={`Remove dependency on ${depId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestRemoveDep(node.id, depId);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = '#64748b')}
                >
                  <X size={10} />
                </button>
              </span>
            ))
          ) : (
            <span style={{ fontSize: '0.65rem', color: '#64748b', fontStyle: 'italic' }}>
              None (ready)
            </span>
          )}
        </div>

        {/* Blocked by indicator if any */}
        {node.blocked_by && node.blocked_by.length > 0 && (
          <div style={{ fontSize: '0.65rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
            <AlertTriangle size={10} />
            <span>Blocked by: {node.blocked_by.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
};
