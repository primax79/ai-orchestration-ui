import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  GanttChart,
  RefreshCw,
  Eye,
  EyeOff,
  Flame,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import {
  TaskGraphResponse,
  TaskGraphNode,
  TaskSize,
  SharedFilterState,
} from '../types';
import { api, timelineApi } from '../api';
import { TimelineCard } from './TimelineCard';
import { TimelineArrows, ArrowPosition } from './TimelineArrows';
import { TimelineReadyQueue } from './TimelineReadyQueue';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';
import { SharedFilterBar, getStoredSharedFilters, matchTaskFilters } from './SharedFilterBar';
import { MicrotaskQuickAdd } from './MicrotaskQuickAdd';

interface TimelineViewProps {
  onSelectTask?: (task: any) => void;
  onRefresh?: () => void;
}

const TIMELINE_SHOW_DONE_KEY = 'ai-orch:timeline-show-done';

const getStoredShowDone = (): boolean => {
  try {
    return localStorage.getItem(TIMELINE_SHOW_DONE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const TimelineView: React.FC<TimelineViewProps> = ({ onSelectTask, onRefresh }) => {
  const [graph, setGraph] = useState<TaskGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState<boolean>(getStoredShowDone);
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [filterChainOnly, setFilterChainOnly] = useState(false);
  const [highlightHeaviestChain, setHighlightHeaviestChain] = useState(true);
  const [sharedFilters, setSharedFilters] = useState<SharedFilterState>(getStoredSharedFilters);

  // Confirm dialog state for priority, size, deps
  const [confirmDialogState, setConfirmDialogState] = useState<{
    isOpen: boolean;
    title: string;
    summary?: string;
    diff?: string;
    hash?: string;
    onApply: (hash?: string) => Promise<void>;
    onRefetch?: () => Promise<ConfirmDialogPreviewData>;
  } | null>(null);

  // SVG arrows state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState<ArrowPosition[]>([]);
  const [containerDimensions, setContainerDimensions] = useState({ width: 0, height: 0 });

  const fetchGraph = useCallback(async () => {
    try {
      setError(null);
      const res = await timelineApi.getTasksGraph();
      setGraph(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to load task graph');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  // Live WebSocket updates
  useEffect(() => {
    const unsub = api.subscribeWebSocket((msg: any) => {
      if (
        (msg.type === 'changed' && msg.areas?.includes('tasks')) ||
        msg.type === 'task_transitioned' ||
        msg.type === 'index_synced' ||
        msg.type === 'reconnected'
      ) {
        fetchGraph();
      }
    });
    return () => {
      unsub();
    };
  }, [fetchGraph]);

  const handleToggleShowDone = () => {
    const next = !showDone;
    setShowDone(next);
    try {
      localStorage.setItem(TIMELINE_SHOW_DONE_KEY, String(next));
    } catch {}
  };

  // Group list for filter dropdown
  const availableGroups = useMemo(() => {
    if (!graph?.nodes) return [];
    const set = new Set<string>();
    graph.nodes.forEach((n) => {
      if (n.group) set.add(n.group);
    });
    return Array.from(set).sort();
  }, [graph]);

  // Nodes map by ID
  const nodesById = useMemo<Record<string, TaskGraphNode>>(() => {
    if (!graph?.nodes) return {};
    const map: Record<string, TaskGraphNode> = {};
    graph.nodes.forEach((n) => {
      map[n.id] = n;
    });
    return map;
  }, [graph]);

  // Compute selected task's full dependency chain (ancestors and descendants)
  const selectedChainIds = useMemo(() => {
    if (!selectedTaskId || !graph?.edges) return new Set<string>();
    const chain = new Set<string>([selectedTaskId]);

    // Ancestors (tasks that selectedTaskId depends on directly or transitively)
    const queueUp = [selectedTaskId];
    while (queueUp.length > 0) {
      const curr = queueUp.shift()!;
      for (const e of graph.edges) {
        if (e.to === curr && !chain.has(e.from)) {
          chain.add(e.from);
          queueUp.push(e.from);
        }
      }
    }

    // Descendants (tasks that depend on selectedTaskId directly or transitively)
    const queueDown = [selectedTaskId];
    while (queueDown.length > 0) {
      const curr = queueDown.shift()!;
      for (const e of graph.edges) {
        if (e.from === curr && !chain.has(e.to)) {
          chain.add(e.to);
          queueDown.push(e.to);
        }
      }
    }

    return chain;
  }, [selectedTaskId, graph?.edges]);

  // Filtered visible nodes
  const visibleNodes = useMemo(() => {
    if (!graph?.nodes) return [];
    return graph.nodes.filter((node) => {
      const isClosed = node.state === 'done' || node.state === 'done with a caveat' || node.state === 'dropped';
      if (!showDone && isClosed) return false;
      if (groupFilter !== 'all' && node.group !== groupFilter) return false;
      if (filterChainOnly && selectedTaskId && !selectedChainIds.has(node.id)) return false;
      if (!matchTaskFilters(node, sharedFilters)) return false;
      return true;
    });
  }, [graph?.nodes, showDone, groupFilter, filterChainOnly, selectedTaskId, selectedChainIds, sharedFilters]);

  // Determine columns
  const columnsData = useMemo(() => {
    // Determine max column index
    let maxCol = 0;
    visibleNodes.forEach((n) => {
      if (typeof n.column === 'number' && n.column > maxCol) {
        maxCol = n.column;
      }
    });

    // Column structure
    const cols: Array<{
      colIndex: number | 'done';
      title: string;
      nodes: TaskGraphNode[];
      totalsText: string;
    }> = [];

    // Optional Done column on the far left
    if (showDone) {
      const doneNodes = visibleNodes.filter(
        (n) => n.state === 'done' || n.state === 'done with a caveat' || n.state === 'dropped'
      );
      cols.push({
        colIndex: 'done',
        title: 'Done',
        nodes: doneNodes,
        totalsText: `${doneNodes.length} tasks`,
      });
    }

    // Numerical columns 0 .. maxCol
    for (let c = 0; c <= maxCol; c++) {
      const colNodes = visibleNodes.filter((n) => {
        const isClosed = n.state === 'done' || n.state === 'done with a caveat' || n.state === 'dropped';
        return !isClosed && n.column === c;
      });

      // Sort by priority (P0 first, then P1, P2, P3, then ID)
      const pOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      colNodes.sort((a, b) => {
        const pa = pOrder[a.priority] ?? 99;
        const pb = pOrder[b.priority] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.id.localeCompare(b.id);
      });

      // Calculate size totals for this column
      const sizeCounts: Record<string, number> = {};
      colNodes.forEach((n) => {
        const s = n.size || 'M';
        sizeCounts[s] = (sizeCounts[s] || 0) + 1;
      });
      const totalsList = Object.entries(sizeCounts)
        .sort()
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');

      cols.push({
        colIndex: c,
        title: c === 0 ? 'Ready (0)' : `Step ${c}`,
        nodes: colNodes,
        totalsText: `${colNodes.length} tasks${totalsList ? ` · ${totalsList}` : ''}`,
      });
    }

    return cols;
  }, [visibleNodes, showDone]);

  // Recalculate SVG Arrow positions when DOM updates
  const updateArrowPositions = useCallback(() => {
    if (!scrollContainerRef.current || !graph?.edges) return;
    const container = scrollContainerRef.current;
    const containerRect = container.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;

    const newWidth = Math.max(container.scrollWidth, container.clientWidth);
    const newHeight = Math.max(container.scrollHeight, container.clientHeight);
    setContainerDimensions({ width: newWidth, height: newHeight });

    const heaviestChainSet = new Set(graph.heaviest_chain || []);
    const visibleIds = new Set(visibleNodes.map((n) => n.id));

    const positions: ArrowPosition[] = [];

    for (const edge of graph.edges) {
      if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) continue;

      const fromEl = document.getElementById(`timeline-card-${edge.from}`);
      const toEl = document.getElementById(`timeline-card-${edge.to}`);
      if (!fromEl || !toEl) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      const x1 = fromRect.right - containerRect.left + scrollLeft;
      const y1 = fromRect.top + fromRect.height / 2 - containerRect.top + scrollTop;
      const x2 = toRect.left - containerRect.left + scrollLeft;
      const y2 = toRect.top + toRect.height / 2 - containerRect.top + scrollTop;

      // Check if both nodes are consecutive in the heaviest chain
      const isHeavy =
        highlightHeaviestChain &&
        heaviestChainSet.has(edge.from) &&
        heaviestChainSet.has(edge.to);

      positions.push({
        from: edge.from,
        to: edge.to,
        x1,
        y1,
        x2,
        y2,
        isHeavy,
      });
    }

    setArrows(positions);
  }, [graph?.edges, graph?.heaviest_chain, visibleNodes, highlightHeaviestChain]);

  // Recalculate on render, resize, or scroll
  useEffect(() => {
    const timeout = setTimeout(updateArrowPositions, 50);
    window.addEventListener('resize', updateArrowPositions);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('resize', updateArrowPositions);
    };
  }, [updateArrowPositions, columnsData]);

  // Priority edit handler
  const handleRequestSetPriority = async (taskId: string, priority: 'P0' | 'P1' | 'P2' | 'P3', reason?: string) => {
    const prev = await timelineApi.previewSetPriority(taskId, { priority, reason });
    setConfirmDialogState({
      isOpen: true,
      title: `Set Priority on ${taskId} to ${priority}`,
      summary: `Update priority for task ${taskId} to ${priority}${reason ? ` (${reason})` : ''}.`,
      diff: prev.diff,
      hash: prev.hash || prev.task_hash,
      onApply: async (h) => {
        await timelineApi.setPriority(taskId, { priority, reason, expect_task_hash: h });
        setConfirmDialogState(null);
        await fetchGraph();
        onRefresh?.();
      },
      onRefetch: async () => {
        const p = await timelineApi.previewSetPriority(taskId, { priority, reason });
        return { diff: p.diff, hash: p.hash || p.task_hash };
      },
    });
  };

  // Size edit handler
  const handleRequestSetSize = async (taskId: string, size: TaskSize) => {
    const prev = await timelineApi.previewSetSize(taskId, { size });
    setConfirmDialogState({
      isOpen: true,
      title: `Set Size on ${taskId} to ${size}`,
      summary: `Update size for task ${taskId} to ${size}.`,
      diff: prev.diff,
      hash: prev.hash || prev.task_hash,
      onApply: async (h) => {
        await timelineApi.setSize(taskId, { size, expect_task_hash: h });
        setConfirmDialogState(null);
        await fetchGraph();
        onRefresh?.();
      },
      onRefetch: async () => {
        const p = await timelineApi.previewSetSize(taskId, { size });
        return { diff: p.diff, hash: p.hash || p.task_hash };
      },
    });
  };

  // Add dependency handler
  const handleRequestAddDep = async (taskId: string, depId: string) => {
    const prev = await timelineApi.previewSetDeps(taskId, { add: [depId] });
    setConfirmDialogState({
      isOpen: true,
      title: `Add Dependency: ${depId} → ${taskId}`,
      summary: `Task ${taskId} will now depend on ${depId}. If ${depId} is open, ${taskId} will move to a later column.`,
      diff: prev.diff,
      hash: prev.hash || prev.task_hash,
      onApply: async (h) => {
        await timelineApi.setDeps(taskId, { add: [depId], expect_task_hash: h });
        setConfirmDialogState(null);
        await fetchGraph();
        onRefresh?.();
      },
      onRefetch: async () => {
        const p = await timelineApi.previewSetDeps(taskId, { add: [depId] });
        return { diff: p.diff, hash: p.hash || p.task_hash };
      },
    });
  };

  // Remove dependency handler
  const handleRequestRemoveDep = async (taskId: string, depId: string) => {
    const prev = await timelineApi.previewSetDeps(taskId, { remove: [depId] });
    setConfirmDialogState({
      isOpen: true,
      title: `Remove Dependency: ${depId} → ${taskId}`,
      summary: `Remove the dependency of task ${taskId} on ${depId}.`,
      diff: prev.diff,
      hash: prev.hash || prev.task_hash,
      onApply: async (h) => {
        await timelineApi.setDeps(taskId, { remove: [depId], expect_task_hash: h });
        setConfirmDialogState(null);
        await fetchGraph();
        onRefresh?.();
      },
      onRefetch: async () => {
        const p = await timelineApi.previewSetDeps(taskId, { remove: [depId] });
        return { diff: p.diff, hash: p.hash || p.task_hash };
      },
    });
  };

  const handleCardClick = (node: TaskGraphNode) => {
    setSelectedTaskId((prev) => (prev === node.id ? null : node.id));
    if (onSelectTask) {
      // Pass standard task item structure so BacklogManager can open TaskDetailModal
      onSelectTask({
        id: node.id,
        title: node.title,
        state: node.state,
        priority: node.priority,
        size: node.size,
        executor: node.executor,
        kind: node.kind,
        group: node.group,
        depends_on: node.depends_on,
      });
    }
  };

  const handleFocusCard = (taskId: string) => {
    setSelectedTaskId(taskId);
    const cardEl = document.getElementById(`timeline-card-${taskId}`);
    if (cardEl && scrollContainerRef.current) {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 180px)',
        minHeight: '600px',
        backgroundColor: '#0b1329',
        borderRadius: '0.5rem',
        border: '1px solid #1e293b',
        overflow: 'hidden',
      }}
    >
      {/* Top Toolbar / Filter Bar */}
      <div
        style={{
          padding: '0.75rem 1rem',
          backgroundColor: '#0f172a',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        {/* Left Controls: Title, Totals, Heaviest Chain Indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <GanttChart size={20} color="#38bdf8" />
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
              Timeline & Dependencies
            </h2>
          </div>

          {/* Overall Totals */}
          {graph?.totals?.overall && (
            <div
              style={{
                fontSize: '0.75rem',
                color: '#cbd5e1',
                backgroundColor: '#1e293b',
                padding: '0.2rem 0.5rem',
                borderRadius: '0.25rem',
                border: '1px solid #334155',
              }}
            >
              <strong style={{ color: '#38bdf8' }}>Open Totals:</strong> {graph.totals.overall}
            </div>
          )}

          {/* Heaviest Chain Badge */}
          {graph?.heaviest_chain && graph.heaviest_chain.length > 0 && (
            <button
              type="button"
              onClick={() => setHighlightHeaviestChain((v) => !v)}
              title="Click to toggle heaviest chain highlight"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: highlightHeaviestChain ? '#f59e0b' : '#94a3b8',
                backgroundColor: highlightHeaviestChain ? 'rgba(245, 158, 11, 0.12)' : '#1e293b',
                border: highlightHeaviestChain ? '1px solid #f59e0b' : '1px solid #334155',
                borderRadius: '0.25rem',
                padding: '0.2rem 0.5rem',
                cursor: 'pointer',
              }}
            >
              <Flame size={14} color="#f59e0b" />
              <span>
                Heaviest Chain: {graph.heaviest_chain.length} tasks (wt: {graph.heaviest_chain_weight})
              </span>
            </button>
          )}
        </div>

        {/* Right Controls: Filters, Show Done, Search, Refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <MicrotaskQuickAdd onCreated={() => { fetchGraph(); onRefresh?.(); }} />

          {/* Group / Initiative Filter */}
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            style={{
              fontSize: '0.75rem',
              padding: '0.25rem 0.5rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.25rem',
              color: '#f8fafc',
              cursor: 'pointer',
            }}
          >
            <option value="all">All Groups</option>
            {availableGroups.map((g) => (
              <option key={g} value={g}>
                Group: {g}
              </option>
            ))}
          </select>

          {/* Chain Only Toggle */}
          {selectedTaskId && (
            <button
              type="button"
              onClick={() => setFilterChainOnly((v) => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                fontSize: '0.75rem',
                padding: '0.25rem 0.5rem',
                backgroundColor: filterChainOnly ? '#0284c7' : '#1e293b',
                border: filterChainOnly ? '1px solid #38bdf8' : '1px solid #334155',
                color: filterChainOnly ? '#fff' : '#cbd5e1',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              <span>Chain of {selectedTaskId}</span>
            </button>
          )}

          {/* Show Done Toggle */}
          <button
            type="button"
            onClick={handleToggleShowDone}
            title={showDone ? 'Hide Done Tasks' : 'Show Done Tasks in Left Column'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              fontSize: '0.75rem',
              padding: '0.25rem 0.5rem',
              backgroundColor: showDone ? '#1e293b' : 'transparent',
              border: '1px solid #334155',
              borderRadius: '0.25rem',
              color: showDone ? '#38bdf8' : '#94a3b8',
              cursor: 'pointer',
            }}
          >
            {showDone ? <Eye size={14} /> : <EyeOff size={14} />}
            <span>Show Done</span>
          </button>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={fetchGraph}
            title="Refresh Timeline Graph"
            disabled={loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '0.25rem 0.5rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.25rem',
              color: '#94a3b8',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Shared Filter Bar */}
      <div style={{ padding: '0.5rem 1rem 0' }}>
        <SharedFilterBar
          filters={sharedFilters}
          onChange={setSharedFilters}
          style={{ marginBottom: 0 }}
        />
      </div>

      {/* Main Workspace Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {loading && !graph ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              color: '#94a3b8',
            }}
          >
            <Loader2 size={32} className="animate-spin" color="#38bdf8" />
            <span>Computing dependency graph & columns...</span>
          </div>
        ) : error ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
              color: '#ef4444',
              padding: '2rem',
            }}
          >
            <AlertCircle size={36} />
            <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>{error}</span>
            <button
              type="button"
              onClick={fetchGraph}
              style={{
                padding: '0.4rem 0.8rem',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                color: '#fff',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* Scrollable Columns Container */}
            <div
              ref={scrollContainerRef}
              onScroll={updateArrowPositions}
              style={{
                flex: 1,
                overflowX: 'auto',
                overflowY: 'auto',
                position: 'relative',
                display: 'flex',
                gap: '1.25rem',
                padding: '1.25rem',
                minWidth: 0,
              }}
            >
              {/* SVG Connector Arrows Overlay */}
              <TimelineArrows
                arrows={arrows}
                width={containerDimensions.width}
                height={containerDimensions.height}
                onRemoveArrow={(from, to) => handleRequestRemoveDep(to, from)}
              />

              {/* Columns */}
              {columnsData.map((col) => (
                <div
                  key={String(col.colIndex)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                    flexShrink: 0,
                    minWidth: '220px',
                    position: 'relative',
                    zIndex: 10,
                  }}
                >
                  {/* Column Header */}
                  <div
                    style={{
                      padding: '0.5rem 0.75rem',
                      backgroundColor: col.colIndex === 0 ? '#0c4a6e' : '#1e293b',
                      border: col.colIndex === 0 ? '1px solid #0284c7' : '1px solid #334155',
                      borderRadius: '0.375rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.15rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f8fafc' }}>
                        {col.title}
                      </span>
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          backgroundColor: '#0f172a',
                          padding: '0.05rem 0.4rem',
                          borderRadius: '999px',
                          color: '#38bdf8',
                        }}
                      >
                        {col.nodes.length}
                      </span>
                    </div>
                    <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                      {col.totalsText}
                    </span>
                  </div>

                  {/* Cards stack in column */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                      flex: 1,
                    }}
                  >
                    {col.nodes.length === 0 ? (
                      <div
                        style={{
                          padding: '1.5rem 0.5rem',
                          textAlign: 'center',
                          color: '#475569',
                          fontSize: '0.75rem',
                          fontStyle: 'italic',
                          border: '1px dashed #334155',
                          borderRadius: '0.375rem',
                        }}
                      >
                        No tasks in this step
                      </div>
                    ) : (
                      col.nodes.map((node) => {
                        const isHeavy =
                          highlightHeaviestChain &&
                          (graph?.heaviest_chain || []).includes(node.id);
                        const isSelected = selectedTaskId === node.id;

                        return (
                          <TimelineCard
                            key={node.id}
                            node={node}
                            allNodes={graph?.nodes || []}
                            allEdges={graph?.edges || []}
                            isHeaviestChain={isHeavy}
                            isSelected={isSelected}
                            onSelectTask={handleCardClick}
                            onRequestSetPriority={handleRequestSetPriority}
                            onRequestSetSize={handleRequestSetSize}
                            onRequestAddDep={handleRequestAddDep}
                            onRequestRemoveDep={handleRequestRemoveDep}
                            onRefresh={fetchGraph}
                          />
                        );
                      })
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Ready Queue Panel on Right */}
            <TimelineReadyQueue
              readyQueueIds={graph?.ready_queue || []}
              nodesById={nodesById}
              heaviestChainIds={graph?.heaviest_chain || []}
              onSelectTask={handleCardClick}
              onFocusCard={handleFocusCard}
              onRefresh={fetchGraph}
            />
          </>
        )}
      </div>

      {/* Confirm Dialog for Priority / Size / Dependency Mutations */}
      {confirmDialogState && (
        <ConfirmDialog
          isOpen={confirmDialogState.isOpen}
          title={confirmDialogState.title}
          summary={confirmDialogState.summary}
          diff={confirmDialogState.diff}
          hash={confirmDialogState.hash}
          onApply={confirmDialogState.onApply}
          onCancel={() => setConfirmDialogState(null)}
          onRefetchPreview={confirmDialogState.onRefetch}
        />
      )}
    </div>
  );
};
