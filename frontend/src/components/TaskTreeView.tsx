import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Layers,
  Folder,
  FileText,
  Plus,
  Maximize2,
  Minimize2,
  Copy,
  Check,
  RotateCcw,
  FolderPlus,
  Loader2,
  ArrowUpRight,
  Tag,
} from 'lucide-react';
import {
  TaskItem,
  TaskListResponse,
  TaskState,
  TreeNode,
  Priority,
  StructurePlanItem,
  SharedFilterState,
} from '../types';
import { taskStructureApi, useProject } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { KindBadge, KIND_CONFIGS } from './KindBadge';
import { LabelList } from './LabelChip';
import { PromoteDialog } from './PromoteDialog';
import { matchTaskFilters } from './SharedFilterBar';
import {
  ProjectChip,
  ConditionalBadge,
  PlacementWarningChip,
  CoordinatesExpansionList,
  formatTaskIdentifier,
  getPlacementWarnings,
} from './ProjectBadges';

const TREE_EXPANDED_KEY = 'ai-orch:tree-expanded-nodes';

const ALL_STATES: TaskState[] = [
  'open',
  'in progress',
  'paused',
  'bounced',
  'waiting',
  'blocked',
  'delivered',
  'verified',
  'done',
  'done with a caveat',
  'dropped',
];
const CLOSED_STATES: TaskState[] = ['done', 'done with a caveat', 'dropped'];
export const DEFAULT_TREE_STATES = ALL_STATES.filter(
  (st) => !CLOSED_STATES.includes(st) && st !== 'paused'
);

const getStoredExpanded = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(TREE_EXPANDED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch {
    // Ignore storage/parse errors
  }
  return {};
};

const storeExpanded = (expanded: Record<string, boolean>) => {
  try {
    localStorage.setItem(TREE_EXPANDED_KEY, JSON.stringify(expanded));
  } catch {
    // Ignore storage errors
  }
};

const getStateColor = (state: string): { bg: string; text: string; border: string } => {
  switch (state) {
    case 'done':
    case 'done with a caveat':
      return { bg: '#064e3b', text: '#6ee7b7', border: '#059669' };
    case 'in progress':
      return { bg: '#312e81', text: '#c7d2fe', border: '#6366f1' };
    case 'verified':
      return { bg: '#065f46', text: '#a7f3d0', border: '#10b981' };
    case 'delivered':
      return { bg: '#0c4a6e', text: '#bae6fd', border: '#0284c7' };
    case 'paused':
      return { bg: '#78350f', text: '#fde68a', border: '#d97706' };
    case 'waiting':
      return { bg: '#831843', text: '#fbcfe8', border: '#db2777' };
    case 'blocked':
    case 'bounced':
      return { bg: '#7f1d1d', text: '#fca5a5', border: '#ef4444' };
    case 'dropped':
      return { bg: '#1e293b', text: '#94a3b8', border: '#475569' };
    case 'open':
    default:
      return { bg: '#1e293b', text: '#cbd5e1', border: '#334155' };
  }
};

const getPriorityColor = (priority: Priority) => {
  switch (priority) {
    case 'P0':
      return { bg: '#ef4444', text: '#fff' };
    case 'P1':
      return { bg: '#f59e0b', text: '#fff' };
    case 'P2':
      return { bg: '#3b82f6', text: '#fff' };
    case 'P3':
    default:
      return { bg: '#64748b', text: '#fff' };
  }
};

interface TaskTreeViewProps {
  data: TaskListResponse | null;
  visibleStates: TaskState[];
  onVisibleStatesChange: (states: TaskState[]) => void;
  onSelectTask: (task: TaskItem) => void;
  onRefresh: () => void;
  sharedFilters?: SharedFilterState;
  isCommonView?: boolean;
  onSelectCoordTarget?: (project: string, taskId: string) => void;
}

export const TaskTreeView: React.FC<TaskTreeViewProps> = ({
  data,
  visibleStates,
  onVisibleStatesChange,
  onSelectTask,
  onRefresh,
  sharedFilters,
  isCommonView = false,
  onSelectCoordTarget,
}) => {
  const defaultProject = useProject();
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>(getStoredExpanded);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [promoteTargetTask, setPromoteTargetTask] = useState<{ id: string; title: string; project?: string } | null>(null);
  const [localGroupByLabel, setLocalGroupByLabel] = useState(false);
  const [expandedLabelGroups, setExpandedLabelGroups] = useState<Record<string, boolean>>({});

  const isGroupingByLabel = sharedFilters?.groupByLabel ?? localGroupByLabel;

  // Structure action dialog states
  const [addChildParent, setAddChildParent] = useState<TreeNode | null>(null);
  const [addChildTitle, setAddChildTitle] = useState('');
  const [addChildShortTitle, setAddChildShortTitle] = useState('');
  const [addChildKind, setAddChildKind] = useState('feature');
  const [addChildLoading, setAddChildLoading] = useState(false);
  const [addChildError, setAddChildError] = useState<string | null>(null);

  const [confirmDialogData, setConfirmDialogData] = useState<{
    isOpen: boolean;
    title: string;
    summary?: string;
    plan?: StructurePlanItem[];
    planHash?: string;
    actionType: 'add-child' | 'expand' | 'collapse' | 'reopen';
    nodeId: string;
    nodeProject?: string;
    extraPayload?: any;
  } | null>(null);

  const [reopenNode, setReopenNode] = useState<TreeNode | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);

  const rawTree = data?.tree;

  // Build a map of tree nodes
  const treeMap = useMemo<Record<string, TreeNode>>(() => {
    if (!isCommonView && rawTree && Object.keys(rawTree).length > 0) {
      return rawTree;
    }
    // Fallback if tree is not populated or in common view
    const map: Record<string, TreeNode> = {};
    const tasks = data?.all_tasks || data?.emergent_tasks || [];
    for (const t of tasks) {
      const nodeKey = isCommonView ? (t.qualified_id || `${t.project || ''}/${t.id}`) : t.id;
      map[nodeKey] = {
        id: t.id,
        project: t.project,
        qualified_id: t.qualified_id,
        title: t.title,
        short_title: t.short_title,
        parent: null,
        depth: 0,
        node_type: t.kind === 'initiative_task' ? 'leaf' : 'emergent_task',
        is_leaf: true,
        is_container: false,
        children: [],
        state: t.state,
        canonical_state: t.state,
        derived_state: null,
        leaves_done: CLOSED_STATES.includes(t.state) ? 1 : 0,
        leaves_total: 1,
        priority: t.priority,
        size: t.size || 'M',
        executor: t.executor,
        category: t.category || t.project || 'general',
        handoff: t.handoff,
        labels: t.labels,
        kind: t.kind,
        fields: t.fields,
        conditional: t.conditional,
        conditions: t.conditions,
        coordinates: t.coordinates,
        placement_warning: t.placement_warning,
        placement_warnings: t.placement_warnings,
        warnings: t.warnings,
        use_cases: t.use_cases,
      };
    }
    return map;
  }, [rawTree, data, isCommonView]);

  // Recursively determine if a node or any of its descendant leaves matches the visibleStates filter
  const isNodeVisible = useCallback(
    (nodeId: string): boolean => {
      const node = treeMap[nodeId];
      if (!node) return false;

      if (node.is_leaf) {
        if (!visibleStates.includes(node.state as TaskState)) return false;
        if (sharedFilters && !matchTaskFilters(node, { ...sharedFilters, groupByLabel: false })) return false;
        return true;
      }

      // Container: visible if any child is visible
      if (node.children && node.children.length > 0) {
        return node.children.some((childId) => isNodeVisible(childId));
      }

      // Empty container: visible if open is selected
      const effState = (node.derived_state || node.state || 'open') as TaskState;
      return visibleStates.includes(effState);
    },
    [treeMap, visibleStates]
  );

  // Group root nodes
  const { initiativeRoots, emergentCategories } = useMemo(() => {
    const initRoots: TreeNode[] = [];
    const emergentByCat: Record<string, TreeNode[]> = {};

    for (const node of Object.values(treeMap)) {
      if (node.parent === null) {
        if (isCommonView) {
          const cat = sharedFilters?.groupByProject
            ? (node.project || '_workspace')
            : (node.project || node.category || 'general');
          if (!emergentByCat[cat]) {
            emergentByCat[cat] = [];
          }
          emergentByCat[cat].push(node);
        } else if (node.node_type === 'initiative' || (!node.id.startsWith('T') && !node.id.includes('.'))) {
          initRoots.push(node);
        } else {
          const cat = node.category || 'general';
          if (!emergentByCat[cat]) {
            emergentByCat[cat] = [];
          }
          emergentByCat[cat].push(node);
        }
      }
    }

    // Sort initiatives numerically
    initRoots.sort((a, b) => {
      const numA = parseInt(a.id, 10) || 0;
      const numB = parseInt(b.id, 10) || 0;
      return numA - numB;
    });

    // Sort emergent nodes in each category
    for (const cat of Object.keys(emergentByCat)) {
      emergentByCat[cat].sort((a, b) => (a.qualified_id || a.id).localeCompare(b.qualified_id || b.id));
    }

    return { initiativeRoots: initRoots, emergentCategories: emergentByCat };
  }, [treeMap, isCommonView, sharedFilters?.groupByProject]);

  // Tasks grouped by label
  const tasksByLabel = useMemo(() => {
    const map: Record<string, TaskItem[]> = {};
    const all = data?.all_tasks || data?.emergent_tasks || [];
    all.forEach((task) => {
      if (sharedFilters && !matchTaskFilters(task, { ...sharedFilters, groupByLabel: false })) {
        return;
      }
      if (!visibleStates.includes(task.state as TaskState)) {
        return;
      }
      const labels = task.labels && task.labels.length > 0 ? task.labels : ['(no label)'];
      labels.forEach((lbl) => {
        if (!map[lbl]) map[lbl] = [];
        map[lbl].push(task);
      });
    });
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => a.id.localeCompare(b.id));
    }
    return map;
  }, [data, sharedFilters, visibleStates]);

  // Toggle node expansion
  const toggleExpand = useCallback((nodeId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedNodes((prev) => {
      const next = { ...prev, [nodeId]: !prev[nodeId] };
      storeExpanded(next);
      return next;
    });
  }, []);

  // Expand all / Collapse all
  const expandAll = useCallback(() => {
    const all: Record<string, boolean> = {};
    for (const id of Object.keys(treeMap)) {
      all[id] = true;
    }
    setExpandedNodes(all);
    storeExpanded(all);
  }, [treeMap]);

  const collapseAll = useCallback(() => {
    setExpandedNodes({});
    storeExpanded({});
  }, []);

  // Default expansion: if no stored state, expand open initiatives and containers with pending work
  useEffect(() => {
    const current = getStoredExpanded();
    if (Object.keys(current).length === 0 && Object.keys(treeMap).length > 0) {
      const initial: Record<string, boolean> = {};
      for (const node of Object.values(treeMap)) {
        if (node.is_container) {
          const derived = node.derived_state || node.state;
          if (!CLOSED_STATES.includes(derived as TaskState)) {
            initial[node.id] = true;
          }
        }
      }
      setExpandedNodes(initial);
      storeExpanded(initial);
    }
  }, [treeMap]);

  const copyHandoff = (e: React.MouseEvent, handoff?: string, id?: string, title?: string) => {
    e.stopPropagation();
    const textToCopy = handoff || `Work on task ${id}: ${title}`;
    navigator.clipboard.writeText(textToCopy);
    if (id) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  // -------------------------------------------------------------------------
  // Structure Actions
  // -------------------------------------------------------------------------

  const handleOpenAddChild = (node: TreeNode, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setAddChildParent(node);
    setAddChildTitle('');
    setAddChildShortTitle('');
    setAddChildKind('feature');
    setAddChildError(null);
  };

  const handlePreviewAddChild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addChildParent || !addChildTitle.trim()) return;

    const targetProj = addChildParent.project || defaultProject;
    setAddChildLoading(true);
    setAddChildError(null);
    try {
      const res = await taskStructureApi.previewAddChild(addChildParent.id, {
        title: addChildTitle.trim(),
        short_title: addChildShortTitle.trim() || undefined,
        kind: addChildKind,
      }, targetProj);

      if (!res.ok) {
        throw new Error(res.error || 'Preview failed');
      }

      setConfirmDialogData({
        isOpen: true,
        title: `Confirm Add Subtask under ${addChildParent.id}`,
        summary: res.summary || `Add subtask ${res.allocated_id || ''} under ${addChildParent.id}`,
        plan: res.plan,
        planHash: res.plan_hash || res.hash,
        actionType: 'add-child',
        nodeId: addChildParent.id,
        nodeProject: targetProj || undefined,
        extraPayload: {
          title: addChildTitle.trim(),
          short_title: addChildShortTitle.trim() || undefined,
          kind: addChildKind,
          allocatedId: res.allocated_id,
        },
      });
      setAddChildParent(null);
    } catch (err: any) {
      setAddChildError(err?.message || String(err));
    } finally {
      setAddChildLoading(false);
    }
  };

  const handlePreviewExpand = async (node: TreeNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const targetProj = node.project || defaultProject;
    try {
      const res = await taskStructureApi.previewExpandTask(node.id, targetProj);
      if (!res.ok) {
        throw new Error(res.error || 'Preview failed');
      }
      setConfirmDialogData({
        isOpen: true,
        title: `Expand ${node.id} to folder`,
        summary: res.summary || `Convert inline task ${node.id} into a folder bundle`,
        plan: res.plan,
        planHash: res.plan_hash || res.hash,
        actionType: 'expand',
        nodeId: node.id,
        nodeProject: targetProj || undefined,
      });
    } catch (err: any) {
      alert(`Expand failed: ${err.message || String(err)}`);
    }
  };

  const handlePreviewCollapse = async (node: TreeNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const targetProj = node.project || defaultProject;
    try {
      const res = await taskStructureApi.previewCollapseTask(node.id, targetProj);
      if (!res.ok) {
        throw new Error(res.error || 'Preview failed');
      }
      setConfirmDialogData({
        isOpen: true,
        title: `Collapse ${node.id} to block`,
        summary: res.summary || `Collapse folder ${node.id} back into a single block`,
        plan: res.plan,
        planHash: res.plan_hash || res.hash,
        actionType: 'collapse',
        nodeId: node.id,
        nodeProject: targetProj || undefined,
      });
    } catch (err: any) {
      alert(`Collapse failed: ${err.message || String(err)}`);
    }
  };

  const handleOpenReopen = (node: TreeNode, e: React.MouseEvent) => {
    e.stopPropagation();
    setReopenNode(node);
    setReopenReason('');
    setReopenError(null);
  };

  const handlePreviewReopen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reopenNode || !reopenReason.trim()) return;
    const targetProj = reopenNode.project || defaultProject;

    try {
      const res = await taskStructureApi.previewReopenTask(reopenNode.id, {
        reason: reopenReason.trim(),
      }, targetProj);
      if (!res.ok) {
        throw new Error(res.error || 'Preview failed');
      }
      setConfirmDialogData({
        isOpen: true,
        title: `Reopen Task ${reopenNode.id}`,
        summary: res.summary || `Reopen task ${reopenNode.id}: ${reopenReason.trim()}`,
        plan: res.plan,
        planHash: res.plan_hash || res.hash,
        actionType: 'reopen',
        nodeId: reopenNode.id,
        nodeProject: targetProj || undefined,
        extraPayload: { reason: reopenReason.trim() },
      });
      setReopenNode(null);
    } catch (err: any) {
      setReopenError(err?.message || String(err));
    }
  };

  const handleApplyConfirmDialog = async (planHash?: string) => {
    if (!confirmDialogData) return;
    const { actionType, nodeId, nodeProject, extraPayload } = confirmDialogData;
    const hash = planHash || confirmDialogData.planHash || '';
    const targetProj = nodeProject || defaultProject;

    if (actionType === 'add-child') {
      await taskStructureApi.addChild(nodeId, {
        title: extraPayload.title,
        short_title: extraPayload.short_title,
        kind: extraPayload.kind,
        expect_plan_hash: hash,
      }, targetProj);
      // Automatically expand parent so the new child is visible
      setExpandedNodes((prev) => {
        const next = { ...prev, [nodeId]: true };
        storeExpanded(next);
        return next;
      });
    } else if (actionType === 'expand') {
      await taskStructureApi.expandTask(nodeId, { expect_plan_hash: hash }, targetProj);
      setExpandedNodes((prev) => {
        const next = { ...prev, [nodeId]: true };
        storeExpanded(next);
        return next;
      });
    } else if (actionType === 'collapse') {
      await taskStructureApi.collapseTask(nodeId, { expect_plan_hash: hash }, targetProj);
    } else if (actionType === 'reopen') {
      await taskStructureApi.reopenTask(nodeId, {
        reason: extraPayload.reason,
        expect_plan_hash: hash,
      }, targetProj);
    }

    setConfirmDialogData(null);
    onRefresh();
  };

  // Convert a TreeNode to a TaskItem for modal display
  const handleSelectNode = (node: TreeNode) => {
    const taskItem: TaskItem = {
      id: node.id,
      project: node.project,
      qualified_id: node.qualified_id,
      title: node.title,
      short_title: node.short_title,
      category: node.category || (node.id.startsWith('T') ? 'emergent' : 'initiative'),
      priority: node.priority || 'P2',
      priority_reason: node.priority_reason,
      priority_source: node.priority_source,
      size: node.size,
      size_source: node.size_source,
      state: (node.derived_state || node.state) as TaskState,
      derived_state: node.derived_state,
      executor: node.executor || 'kilo',
      handoff: node.handoff,
      file_path: node.file_path,
      is_done: CLOSED_STATES.includes((node.derived_state || node.state) as TaskState),
      bundle_sha256: node.bundle_sha256,
      task_bundle_sha256: node.task_hash,
      labels: node.labels,
      label_sources: node.label_sources,
      kind: node.kind || (node.id.startsWith('T') ? 'emergent' : 'initiative_task'),
      parent: node.parent,
      depth: node.depth,
      node_type: node.node_type,
      is_leaf: node.is_leaf,
      is_container: node.is_container,
      children: node.children,
      fields: node.fields,
      leaves_done: node.leaves_done,
      leaves_total: node.leaves_total,
      conditional: node.conditional,
      conditions: node.conditions,
      coordinates: node.coordinates,
      placement_warning: node.placement_warning,
      placement_warnings: node.placement_warnings,
      warnings: node.warnings,
    };
    onSelectTask(taskItem);
  };

  // Render a node row recursively
  const renderNode = (nodeId: string, level: number = 0) => {
    const node = treeMap[nodeId];
    if (!node) return null;
    if (!isNodeVisible(nodeId)) return null;

    const isExpanded = !!expandedNodes[nodeId];
    const hasChildren = node.children && node.children.length > 0;
    const isContainer = node.is_container || hasChildren;
    const stateVal = (isContainer ? node.derived_state || node.state : node.state) || 'open';
    const stateColors = getStateColor(stateVal);
    const priorityColors = getPriorityColor(node.priority || 'P2');

    const doneCount = node.leaves_done ?? 0;
    const totalCount = node.leaves_total ?? (hasChildren ? node.children.length : 1);
    const progressPct = totalCount > 0 ? Math.min(100, Math.round((doneCount / totalCount) * 100)) : 0;

    const canAddChild = !isCommonView && (isContainer || (node.is_leaf && node.state === 'open'));
    const canExpand = !isCommonView && node.is_leaf && !node.is_folder && node.state === 'open' && !node.id.startsWith('INIT-');
    const canCollapse = !isCommonView && node.is_folder && hasChildren && node.children.every((cid) => treeMap[cid]?.is_leaf);
    const canReopen = node.is_leaf && CLOSED_STATES.includes(node.state as TaskState);
    const warnings = getPlacementWarnings(node);
    const idDisplay = isCommonView ? formatTaskIdentifier(node, true) : node.id;
    const effectiveKind =
      (node.fields?.kind?.value ? String(node.fields.kind.value) : undefined) ||
      (node.kind && node.kind !== 'emergent' && node.kind !== 'initiative_task' && node.kind !== 'initiative'
        ? node.kind
        : undefined) ||
      (node.category && KIND_CONFIGS[node.category.toLowerCase()]
        ? node.category.toLowerCase()
        : undefined) ||
      node.kind;

    return (
      <div key={nodeId} style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          onClick={() => handleSelectNode(node)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '0.55rem 0.75rem',
            paddingLeft: `${0.75 + level * 1.5}rem`,
            borderBottom: '1px solid #334155',
            backgroundColor: level % 2 === 0 ? '#1e293b' : '#1a2436',
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#27354f')}
          onMouseLeave={(e) =>
            (e.currentTarget.style.backgroundColor = level % 2 === 0 ? '#1e293b' : '#1a2436')
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%' }}>
          {/* Chevron for expandable containers */}
          {isContainer ? (
            <button
              onClick={(e) => toggleExpand(nodeId, e)}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '0.1rem',
                display: 'flex',
                alignItems: 'center',
              }}
              title={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : (
            <span style={{ width: '16px', display: 'flex', justifyContent: 'center' }}>
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: '#64748b',
                }}
              />
            </span>
          )}

          {/* Node Icon */}
          {node.node_type === 'initiative' ? (
            <Layers size={16} color="#818cf8" />
          ) : isContainer ? (
            <Folder size={15} color="#38bdf8" />
          ) : (
            <FileText size={15} color="#94a3b8" />
          )}

          {/* Priority (Leaves only, or container with priority) */}
          {!isContainer && (
            <span
              style={{
                fontSize: '0.68rem',
                fontWeight: 700,
                padding: '0.1rem 0.35rem',
                borderRadius: '0.2rem',
                backgroundColor: priorityColors.bg,
                color: priorityColors.text,
              }}
              title={`Priority: ${node.priority || 'P2'}${node.priority_source ? ` (${node.priority_source})` : ''}`}
            >
              {node.priority || 'P2'}
            </span>
          )}

          {/* Size (Leaves only) */}
          {!isContainer && node.size && (
            <span
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                padding: '0.1rem 0.35rem',
                borderRadius: '0.2rem',
                backgroundColor: '#334155',
                color: '#cbd5e1',
              }}
            >
              {node.size}
            </span>
          )}

          {/* Project chip in common view */}
          {isCommonView && node.project && (
            <ProjectChip project={node.project} size="xs" />
          )}

          {/* ID */}
          <span
            style={{
              fontSize: '0.85rem',
              fontWeight: 700,
              color: node.node_type === 'initiative' ? '#818cf8' : '#38bdf8',
              fontFamily: 'monospace',
              minWidth: '3.2rem',
            }}
          >
            {idDisplay}
          </span>

          {/* Microtag & KindBadge */}
          {node.category === 'micro' && (
            <span
              style={{
                fontSize: '0.62rem',
                fontWeight: 700,
                backgroundColor: '#27272a',
                color: '#a1a1aa',
                padding: '0.05rem 0.25rem',
                borderRadius: '0.2rem',
                textTransform: 'uppercase',
              }}
            >
              micro
            </span>
          )}
          <KindBadge kind={effectiveKind} size={11} showLabel={true} />

          {/* Title */}
          <span
            style={{
              fontSize: '0.88rem',
              fontWeight: isContainer ? 600 : 500,
              color: '#f8fafc',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={node.title}
          >
            {node.title}
          </span>

          <ConditionalBadge conditional={node.conditional} conditions={node.conditions} size="xs" />
          <PlacementWarningChip warnings={warnings} size="xs" />

          {/* Labels */}
          {node.labels && node.labels.length > 0 && (
            <LabelList labels={node.labels} maxVisible={2} size="xs" />
          )}

          {/* Progress bar for containers */}
          {isContainer && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                minWidth: '150px',
                maxWidth: '200px',
              }}
              title={`${doneCount} of ${totalCount} leaves done (${progressPct}%)`}
            >
              <div
                style={{
                  flex: 1,
                  height: '6px',
                  backgroundColor: '#0f172a',
                  borderRadius: '3px',
                  overflow: 'hidden',
                  border: '1px solid #334155',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${progressPct}%`,
                    backgroundColor: progressPct === 100 ? '#10b981' : '#6366f1',
                    borderRadius: '2px',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8', minWidth: '42px', textAlign: 'right' }}>
                {doneCount}/{totalCount}
              </span>
            </div>
          )}

          {/* State Badge */}
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 600,
              padding: '0.12rem 0.45rem',
              borderRadius: '1rem',
              backgroundColor: stateColors.bg,
              color: stateColors.text,
              border: `1px solid ${stateColors.border}`,
              whiteSpace: 'nowrap',
            }}
          >
            {stateVal}
          </span>

          {/* Executor */}
          {!isContainer && (
            <span
              style={{
                fontSize: '0.75rem',
                color: '#94a3b8',
                minWidth: '55px',
                textAlign: 'right',
              }}
            >
              {node.executor || 'kilo'}
            </span>
          )}

          {/* Actions */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              marginLeft: '0.4rem',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {canAddChild && (
              <button
                onClick={(e) => handleOpenAddChild(node, e)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.2rem',
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.4rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #475569',
                  backgroundColor: '#0f172a',
                  color: '#94a3b8',
                  cursor: 'pointer',
                }}
                title="Add child subtask"
              >
                <Plus size={12} />
                <span>Subtask</span>
              </button>
            )}

            {canExpand && (
              <button
                onClick={(e) => handlePreviewExpand(node, e)}
                style={{
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.4rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #475569',
                  backgroundColor: '#0f172a',
                  color: '#94a3b8',
                  cursor: 'pointer',
                }}
                title="Expand block into folder"
              >
                Expand
              </button>
            )}

            {canCollapse && (
              <button
                onClick={(e) => handlePreviewCollapse(node, e)}
                style={{
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.4rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #475569',
                  backgroundColor: '#0f172a',
                  color: '#94a3b8',
                  cursor: 'pointer',
                }}
                title="Collapse folder back into block"
              >
                Collapse
              </button>
            )}

            {node.category === 'micro' && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPromoteTargetTask({ id: node.id, title: node.title, project: node.project });
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.2rem',
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.4rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #4f46e5',
                  backgroundColor: 'rgba(99, 102, 241, 0.2)',
                  color: '#c7d2fe',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
                title="Promote microtask to full task"
              >
                <ArrowUpRight size={11} />
                <span>Promote</span>
              </button>
            )}

            {canReopen && (
              <button
                onClick={(e) => handleOpenReopen(node, e)}
                style={{
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.4rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #d97706',
                  backgroundColor: '#78350f',
                  color: '#fef3c7',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.2rem',
                }}
                title="Reopen task"
              >
                <RotateCcw size={11} />
                <span>Reopen</span>
              </button>
            )}

            {!isContainer && (
              <button
                onClick={(e) => copyHandoff(e, node.handoff, node.qualified_id || node.id, node.title)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: copiedId === (node.qualified_id || node.id) ? '#10b981' : '#64748b',
                  cursor: 'pointer',
                  padding: '0.15rem',
                  display: 'flex',
                  alignItems: 'center',
                }}
                title="Copy handoff command"
              >
                {copiedId === (node.qualified_id || node.id) ? <Check size={13} /> : <Copy size={13} />}
              </button>
            )}
          </div>
          </div>

          {isCommonView && node.project === '_workspace' && node.coordinates && node.coordinates.length > 0 && (
            <div style={{ marginTop: '0.35rem' }}>
              <CoordinatesExpansionList
                coordinates={node.coordinates}
                onSelectTarget={onSelectCoordTarget}
              />
            </div>
          )}
        </div>

        {/* Children (rendered if expanded) */}
        {isContainer && isExpanded && hasChildren && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {node.children.map((childId) => renderNode(childId, level + 1))}
          </div>
        )}
      </div>
    );
  };

  // Compute overall count of visible leaves
  const totalLeavesCount = useMemo(() => {
    let count = 0;
    for (const node of Object.values(treeMap)) {
      if (node.is_leaf) count++;
    }
    return count;
  }, [treeMap]);

  const visibleLeavesCount = useMemo(() => {
    let count = 0;
    for (const [nKey, node] of Object.entries(treeMap)) {
      if (node.is_leaf && isNodeVisible(nKey)) count++;
    }
    return count;
  }, [treeMap, isNodeVisible]);

  const toggleTreeState = (st: TaskState) => {
    if (visibleStates.includes(st)) {
      onVisibleStatesChange(visibleStates.filter((s) => s !== st));
    } else {
      onVisibleStatesChange([...visibleStates, st]);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Top Filter & Expansion Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          padding: '0.75rem 1rem',
        }}
      >
        {/* Visible states filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginRight: '0.25rem', fontWeight: 600 }}>
            Visible states:
          </span>
          {ALL_STATES.map((st) => {
            const count = Object.values(treeMap).filter((t) => t.is_leaf && t.state === st).length;
            const active = visibleStates.includes(st);
            return (
              <button
                key={st}
                onClick={() => toggleTreeState(st)}
                aria-pressed={active}
                style={{
                  fontSize: '0.72rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '1rem',
                  border: `1px solid ${active ? '#6366f1' : '#334155'}`,
                  backgroundColor: active ? '#312e81' : 'transparent',
                  color: active ? '#e0e7ff' : count > 0 ? '#94a3b8' : '#475569',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {st} ({count})
              </button>
            );
          })}

          <span style={{ color: '#334155', margin: '0 0.2rem' }}>|</span>

          {[
            { label: 'Not closed', states: DEFAULT_TREE_STATES },
            { label: 'All', states: ALL_STATES },
            { label: 'None', states: [] as TaskState[] },
          ].map((preset) => (
            <button
              key={preset.label}
              onClick={() => onVisibleStatesChange(preset.states)}
              style={{
                fontSize: '0.72rem',
                padding: '0.15rem 0.5rem',
                borderRadius: '0.25rem',
                border: '1px solid #334155',
                backgroundColor: '#0f172a',
                color: '#cbd5e1',
                cursor: 'pointer',
              }}
            >
              {preset.label}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setLocalGroupByLabel((v) => !v)}
            style={{
              fontSize: '0.72rem',
              padding: '0.15rem 0.5rem',
              borderRadius: '0.25rem',
              border: `1px solid ${isGroupingByLabel ? '#a855f7' : '#334155'}`,
              backgroundColor: isGroupingByLabel ? 'rgba(168, 85, 247, 0.2)' : '#0f172a',
              color: isGroupingByLabel ? '#f3e8ff' : '#cbd5e1',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              fontWeight: isGroupingByLabel ? 600 : 500,
            }}
            title="Group tasks by label headers"
          >
            <Tag size={12} color={isGroupingByLabel ? '#c084fc' : '#94a3b8'} />
            <span>Group by Label</span>
          </button>
        </div>

        {/* Global Expand/Collapse & Counts */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.35rem' }}>
            <button
              onClick={expandAll}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
                fontSize: '0.72rem',
                padding: '0.2rem 0.5rem',
                borderRadius: '0.25rem',
                border: '1px solid #334155',
                backgroundColor: '#0f172a',
                color: '#cbd5e1',
                cursor: 'pointer',
              }}
              title="Expand all containers"
            >
              <Maximize2 size={12} />
              <span>Expand All</span>
            </button>
            <button
              onClick={collapseAll}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
                fontSize: '0.72rem',
                padding: '0.2rem 0.5rem',
                borderRadius: '0.25rem',
                border: '1px solid #334155',
                backgroundColor: '#0f172a',
                color: '#cbd5e1',
                cursor: 'pointer',
              }}
              title="Collapse all containers"
            >
              <Minimize2 size={12} />
              <span>Collapse All</span>
            </button>
          </div>

          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Showing {visibleLeavesCount} of {totalLeavesCount} leaves
          </span>
        </div>
      </div>

      {/* Body: Group by Label or Standard Hierarchical View */}
      {isGroupingByLabel ? (
        <div
          style={{
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '0.6rem 0.85rem',
              backgroundColor: '#0f172a',
              borderBottom: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <Tag size={16} color="#c084fc" />
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f8fafc' }}>
              Tasks Grouped by Label ({Object.keys(tasksByLabel).length} labels)
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {Object.keys(tasksByLabel).length === 0 ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
                No tasks match current filters.
              </div>
            ) : (
              Object.keys(tasksByLabel)
                .sort()
                .map((labelName) => {
                  const groupTasks = tasksByLabel[labelName];
                  const isExpanded = expandedLabelGroups[labelName] !== false;

                  return (
                    <div key={labelName} style={{ borderBottom: '1px solid #334155' }}>
                      <div
                        onClick={() =>
                          setExpandedLabelGroups((prev) => ({
                            ...prev,
                            [labelName]: !isExpanded,
                          }))
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.55rem 0.85rem',
                          backgroundColor: '#0f172a',
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown size={15} color="#94a3b8" />
                        ) : (
                          <ChevronRight size={15} color="#94a3b8" />
                        )}
                        <Tag size={14} color="#818cf8" />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f8fafc' }}>
                          {labelName}
                        </span>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            backgroundColor: '#1e293b',
                            color: '#94a3b8',
                            padding: '0.05rem 0.4rem',
                            borderRadius: '999px',
                          }}
                        >
                          {groupTasks.length}
                        </span>
                      </div>

                      {isExpanded && (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          {groupTasks.map((t) => {
                            const isMicro = t.category === 'micro' || t.size === 'XS';
                            return (
                              <div
                                key={t.id}
                                onClick={() => onSelectTask(t)}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.6rem',
                                  padding: '0.5rem 0.85rem 0.5rem 2.25rem',
                                  borderTop: '1px solid #1e293b',
                                  backgroundColor: '#1e293b',
                                  cursor: 'pointer',
                                  transition: 'background-color 0.15s ease',
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.backgroundColor = '#27354f')
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.backgroundColor = '#1e293b')
                                }
                              >
                                <span
                                  style={{
                                    fontSize: '0.8rem',
                                    fontWeight: 700,
                                    color: '#38bdf8',
                                    fontFamily: 'monospace',
                                    minWidth: '3.5rem',
                                  }}
                                >
                                  {t.id}
                                </span>
                                {isMicro && (
                                  <span
                                    style={{
                                      fontSize: '0.6rem',
                                      fontWeight: 700,
                                      backgroundColor: '#27272a',
                                      color: '#a1a1aa',
                                      padding: '0.05rem 0.25rem',
                                      borderRadius: '0.2rem',
                                      textTransform: 'uppercase',
                                    }}
                                  >
                                    micro
                                  </span>
                                )}
                                {(() => {
                                  const effectiveKind =
                                    (t.fields?.kind?.value ? String(t.fields.kind.value) : undefined) ||
                                    (t.kind && t.kind !== 'emergent' && t.kind !== 'initiative_task' && t.kind !== 'initiative'
                                      ? t.kind
                                      : undefined) ||
                                    (t.category && KIND_CONFIGS[t.category.toLowerCase()]
                                      ? t.category.toLowerCase()
                                      : undefined) ||
                                    t.kind;
                                  return <KindBadge kind={effectiveKind} size={11} showLabel={true} />;
                                })()}
                                <span
                                  style={{
                                    fontSize: '0.85rem',
                                    color: '#f8fafc',
                                    flex: 1,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                  title={t.title}
                                >
                                  {t.title}
                                </span>
                                {t.labels && t.labels.length > 0 && (
                                  <LabelList labels={t.labels} maxVisible={2} size="xs" />
                                )}
                                <span
                                  style={{
                                    fontSize: '0.68rem',
                                    fontWeight: 700,
                                    padding: '0.1rem 0.35rem',
                                    borderRadius: '0.2rem',
                                    backgroundColor:
                                      t.priority === 'P0'
                                        ? '#ef4444'
                                        : t.priority === 'P1'
                                        ? '#f59e0b'
                                        : '#64748b',
                                    color: '#fff',
                                  }}
                                >
                                  {t.priority}
                                </span>
                                {t.size && (
                                  <span
                                    style={{
                                      fontSize: '0.68rem',
                                      fontWeight: 600,
                                      padding: '0.1rem 0.35rem',
                                      borderRadius: '0.2rem',
                                      backgroundColor: '#334155',
                                      color: '#cbd5e1',
                                    }}
                                  >
                                    {t.size}
                                  </span>
                                )}
                                <span
                                  style={{
                                    fontSize: '0.68rem',
                                    fontWeight: 600,
                                    padding: '0.1rem 0.35rem',
                                    borderRadius: '0.2rem',
                                    backgroundColor: '#0f172a',
                                    border: '1px solid #334155',
                                    color: '#94a3b8',
                                  }}
                                >
                                  {t.state}
                                </span>
                                {isMicro && (
                                  <button
                                    type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPromoteTargetTask({ id: t.id, title: t.title, project: t.project });
                      }}
                                    title="Promote microtask to full task"
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.15rem',
                                      padding: '0.15rem 0.35rem',
                                      borderRadius: '0.25rem',
                                      backgroundColor: 'rgba(99, 102, 241, 0.2)',
                                      border: '1px solid #4f46e5',
                                      color: '#c7d2fe',
                                      fontSize: '0.65rem',
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    <ArrowUpRight size={11} />
                                    <span>Promote</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Planned Initiatives Section */}
          {initiativeRoots.length > 0 && (
            <div
              style={{
                backgroundColor: '#1e293b',
                borderRadius: '0.5rem',
                border: '1px solid #334155',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '0.75rem 1rem',
                  backgroundColor: '#0f172a',
                  borderBottom: '1px solid #334155',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <Layers size={17} color="#818cf8" />
                <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                  Planned Initiatives
                </h3>
                <span style={{ fontSize: '0.75rem', color: '#64748b', marginLeft: 'auto' }}>
                  {initiativeRoots.filter((r) => isNodeVisible(r.id)).length} initiative(s) visible
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {initiativeRoots.map((init) => renderNode(init.id, 0))}
              </div>
            </div>
          )}

          {/* Emergent Tasks by Category */}
          {Object.keys(emergentCategories).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.25rem 0',
                }}
              >
                <FolderPlus size={18} color="#38bdf8" />
                <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                  Emergent Tasks & Microtasks
                </h3>
              </div>

              {Object.entries(emergentCategories).map(([category, nodes]) => {
                const getNodeKey = (n: TreeNode) => (isCommonView ? (n.qualified_id || `${n.project || ''}/${n.id}`) : n.id);
                const visibleCategoryNodes = nodes.filter((n) => isNodeVisible(getNodeKey(n)));
                if (visibleCategoryNodes.length === 0) return null;

                return (
                  <div
                    key={category}
                    style={{
                      backgroundColor: '#1e293b',
                      borderRadius: '0.5rem',
                      border: '1px solid #334155',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        padding: '0.6rem 1rem',
                        backgroundColor: '#0f172a',
                        borderBottom: '1px solid #334155',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      {isCommonView ? (
                        <ProjectChip project={category} size="sm" />
                      ) : (
                        <>
                          <Folder size={15} color="#cbd5e1" />
                          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#cbd5e1' }}>
                            {category}
                          </span>
                        </>
                      )}
                      <span style={{ fontSize: '0.72rem', color: '#64748b', marginLeft: 'auto' }}>
                        {visibleCategoryNodes.length} task(s)
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      {nodes.map((node) => renderNode(getNodeKey(node), 0))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Add Subtask Form Dialog */}
      {addChildParent && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          onClick={() => setAddChildParent(null)}
        >
          <div
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              maxWidth: '520px',
              width: '100%',
              padding: '1.25rem',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.5rem' }}>
              Add Subtask under {addChildParent.id}
            </h3>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '1rem' }}>
              Parent: <strong style={{ color: '#f1f5f9' }}>{addChildParent.id} - {addChildParent.title}</strong>
            </div>

            {addChildError && (
              <div
                style={{
                  backgroundColor: '#7f1d1d',
                  color: '#fecaca',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.375rem',
                  marginBottom: '1rem',
                  fontSize: '0.8rem',
                }}
              >
                {addChildError}
              </div>
            )}

            <form onSubmit={handlePreviewAddChild} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.25rem' }}>
                  Subtask Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Implement component hierarchy view"
                  value={addChildTitle}
                  onChange={(e) => setAddChildTitle(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #475569',
                    backgroundColor: '#0f172a',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    boxSizing: 'border-box',
                  }}
                  autoFocus
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.25rem' }}>
                  Short Title (optional, 3-4 words)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Implement hierarchy view"
                  value={addChildShortTitle}
                  onChange={(e) => setAddChildShortTitle(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #475569',
                    backgroundColor: '#0f172a',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.25rem' }}>
                  Kind
                </label>
                <select
                  value={addChildKind}
                  onChange={(e) => setAddChildKind(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #475569',
                    backgroundColor: '#0f172a',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="feature">feature</option>
                  <option value="fix">fix</option>
                  <option value="refactor">refactor</option>
                  <option value="test">test</option>
                  <option value="doc">doc</option>
                </select>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setAddChildParent(null)}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #475569',
                    backgroundColor: 'transparent',
                    color: '#cbd5e1',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addChildLoading || !addChildTitle.trim()}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#6366f1',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.8rem',
                    cursor: addChildLoading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  {addChildLoading && <Loader2 size={13} className="spin" />}
                  <span>Preview & Confirm</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reopen Prompt Dialog */}
      {reopenNode && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          onClick={() => setReopenNode(null)}
        >
          <div
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              maxWidth: '480px',
              width: '100%',
              padding: '1.25rem',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.5rem' }}>
              Reopen Task {reopenNode.id}
            </h3>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '1rem' }}>
              Task is currently closed. Provide a reason to reopen:
            </div>

            {reopenError && (
              <div
                style={{
                  backgroundColor: '#7f1d1d',
                  color: '#fecaca',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.375rem',
                  marginBottom: '1rem',
                  fontSize: '0.8rem',
                }}
              >
                {reopenError}
              </div>
            )}

            <form onSubmit={handlePreviewReopen} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.25rem' }}>
                  Reopen Reason *
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="Explain why this task is being reopened..."
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #475569',
                    backgroundColor: '#0f172a',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    boxSizing: 'border-box',
                  }}
                  autoFocus
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setReopenNode(null)}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #475569',
                    backgroundColor: 'transparent',
                    color: '#cbd5e1',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!reopenReason.trim()}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#d97706',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  Preview Reopen
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Dialog with Plan / Diff */}
      {confirmDialogData && (
        <ConfirmDialog
          isOpen={confirmDialogData.isOpen}
          title={confirmDialogData.title}
          summary={confirmDialogData.summary}
          plan={confirmDialogData.plan}
          hash={confirmDialogData.planHash}
          applyButtonText="Confirm & Apply"
          cancelButtonText="Cancel"
          onApply={handleApplyConfirmDialog}
          onCancel={() => setConfirmDialogData(null)}
        />
      )}

      {/* Promote Microtask Dialog */}
      {promoteTargetTask && (
        <PromoteDialog
          taskId={promoteTargetTask.id}
          project={promoteTargetTask.project || defaultProject}
          taskTitle={promoteTargetTask.title}
          isOpen={true}
          onClose={() => setPromoteTargetTask(null)}
          onSuccess={() => {
            setPromoteTargetTask(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
};
