import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  X,
  CheckCircle,
  RotateCcw,
  Play,
  Pause,
  CheckCheck,
  Copy,
  Check,
  FileText,
  AlertTriangle,
  AlertCircle,
  Loader2,
  HelpCircle,
  Plus,
  Trash2,
  Send,
  Paperclip,
  Edit2,
} from 'lucide-react';
import { TaskItem, QuestionItem, AskQuestionPayload, RunRecord, TreeNode, StructurePlanItem, TaskState, shortTitle } from '../types';
import { api, taskStructureApi } from '../api';
import { SafeMarkdown } from './SafeMarkdown';
import { RunDialog } from './RunDialog';
import { TaskRunsPanel } from './TaskRunsPanel';
import { ConfirmDialog } from './ConfirmDialog';
import {
  AttachmentItem,
  getAttachmentInfo,
  downloadAttachmentBlob,
} from './AttachmentComponents';
import { TextViewerModal } from './TextViewerModal';
import { KindBadge } from './KindBadge';
import { LabelList } from './LabelChip';
import { LabelEditorModal } from './LabelEditorModal';
import { PromoteDialog } from './PromoteDialog';
import { ArrowUpRight } from 'lucide-react';

interface TaskDetailModalProps {
  task: TaskItem;
  tree?: Record<string, TreeNode>;
  onSelectTask?: (task: TaskItem) => void;
  initialRunId?: string;
  onClose: () => void;
  onActionComplete: () => void;
  onIndexOutOfSync?: () => void;
  onRequestSyncIndex?: () => void;
  onNavigateToDecisions?: (questionId: string) => void;
}

type TaskDocView = 'structured' | 'raw';
const TASK_DOC_VIEW_KEY = 'ai-orch:task-doc-view';

// Header fields shown elsewhere in the modal (title bar, state footer, handoff box).
const HIDDEN_HEADER_FIELDS = new Set(['id', 'title', 'state', 'handoff', 'priority']);

/** Split a task file into its `- key: value` header and the remaining body (H1 dropped). */
export function splitTaskDoc(content: string): { fields: Array<[string, string]>; body: string } {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#\s+/.test(lines[i])) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  const fields: Array<[string, string]> = [];
  while (i < lines.length) {
    const m = /^-\s+([a-z][a-z0-9-]*):\s?(.*)$/.exec(lines[i]);
    if (!m) break;
    fields.push([m[1], m[2].trim()]);
    i++;
  }
  if (fields.length === 0) {
    return { fields, body: content };
  }
  return { fields, body: lines.slice(i).join('\n').replace(/^\s+/, '') };
}

const getStoredDocView = (): TaskDocView => {
  try {
    return localStorage.getItem(TASK_DOC_VIEW_KEY) === 'raw' ? 'raw' : 'structured';
  } catch {
    return 'structured';
  }
};

export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  task,
  tree,
  onSelectTask,
  initialRunId,
  onClose,
  onActionComplete,
  onIndexOutOfSync,
  onRequestSyncIndex,
  onNavigateToDecisions,
}) => {
  const [currentTask, setCurrentTask] = useState<TaskItem>(task);
  const [taskRuns, setTaskRuns] = useState<RunRecord[]>([]);
  const [runsRefreshTrigger, setRunsRefreshTrigger] = useState<number>(0);
  const [activeRunId, setActiveRunId] = useState<string | undefined>(initialRunId);

  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [bounceReason, setBounceReason] = useState('');
  const [showBounceInput, setShowBounceInput] = useState(false);
  const [copiedHandoff, setCopiedHandoff] = useState(false);
  const [docView, setDocView] = useState<TaskDocView>(getStoredDocView);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [indexOutOfSync, setIndexOutOfSync] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);

  // Structure action dialog states
  const [showAddSubtaskModal, setShowAddSubtaskModal] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState('');
  const [subtaskShortTitle, setSubtaskShortTitle] = useState('');
  const [subtaskKind, setSubtaskKind] = useState('feature');
  const [subtaskLoading, setSubtaskLoading] = useState(false);
  const [subtaskError, setSubtaskError] = useState<string | null>(null);

  // Short title inline edit state
  const [isEditingShortTitle, setIsEditingShortTitle] = useState(false);
  const [editShortTitleValue, setEditShortTitleValue] = useState('');
  const [shortTitleLoading, setShortTitleLoading] = useState(false);
  const [shortTitleError, setShortTitleError] = useState<string | null>(null);

  const [structureConfirmData, setStructureConfirmData] = useState<{
    isOpen: boolean;
    title: string;
    summary?: string;
    plan?: StructurePlanItem[];
    planHash?: string;
    actionType: 'add-child' | 'expand' | 'collapse';
    extraPayload?: any;
  } | null>(null);

  const [showLabelEditor, setShowLabelEditor] = useState(false);
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);

  // Sync currentTask when incoming prop changes
  useEffect(() => {
    setCurrentTask(task);
  }, [task]);

  // Questions section state
  const [taskQuestions, setTaskQuestions] = useState<QuestionItem[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);

  // Ask question form state
  const [showAskForm, setShowAskForm] = useState(false);
  const [askQuestionText, setAskQuestionText] = useState('');
  const [askQuestionShortTitle, setAskQuestionShortTitle] = useState('');
  const [askContextText, setAskContextText] = useState('');
  const [askOptions, setAskOptions] = useState<Array<{ title: string; consequence: string }>>([
    { title: '', consequence: '' },
    { title: '', consequence: '' },
  ]);
  const [askRecommended, setAskRecommended] = useState<string>('-');
  const [askOpenAnswer, setAskOpenAnswer] = useState<boolean>(true);
  const [askSubmitting, setAskSubmitting] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  // Emergent tasks (T###) support attachments; plan tasks (NN.T, INIT-NN) do not.
  const isEmergentTask =
    currentTask.kind === 'emergent' ||
    (/^T\d{3,}$/.test(currentTask.id) &&
      !currentTask.id.includes('.') &&
      !currentTask.id.startsWith('INIT-') &&
      currentTask.kind !== 'initiative_task');

  const isContainer = Boolean(
    currentTask.is_container ||
    currentTask.node_type === 'container' ||
    currentTask.node_type === 'initiative' ||
    currentTask.is_leaf === false ||
    (tree && tree[currentTask.id]?.is_container)
  );

  const breadcrumbs = useMemo(() => {
    const list: Array<{ id: string; title: string; task?: TaskItem }> = [];
    if (!currentTask?.id) return list;

    if (tree && tree[currentTask.id]) {
      let cur: TreeNode | undefined = tree[currentTask.id];
      const visited = new Set<string>();
      while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        const nodeTask: TaskItem = {
          id: cur.id,
          title: cur.title,
          category: cur.category || (cur.id.startsWith('T') ? 'emergent' : 'initiative'),
          priority: cur.priority || 'P2',
          priority_source: cur.priority_source,
          priority_reason: cur.priority_reason,
          size: cur.size,
          size_source: cur.size_source,
          state: (cur.derived_state || cur.state) as TaskState,
          derived_state: cur.derived_state,
          executor: cur.executor || 'kilo',
          handoff: cur.handoff,
          file_path: cur.file_path,
          is_done: ['done', 'done with a caveat', 'dropped'].includes((cur.derived_state || cur.state) as string),
          bundle_sha256: cur.bundle_sha256,
          task_bundle_sha256: cur.task_hash,
          labels: cur.labels,
          label_sources: cur.label_sources,
          kind: cur.kind || (cur.id.startsWith('T') ? 'emergent' : 'initiative_task'),
          parent: cur.parent,
          depth: cur.depth,
          node_type: cur.node_type,
          is_leaf: cur.is_leaf,
          is_container: cur.is_container,
          children: cur.children,
          fields: cur.fields,
          leaves_done: cur.leaves_done,
          leaves_total: cur.leaves_total,
        };
        list.unshift({ id: cur.id, title: cur.title, task: nodeTask });
        if (cur.parent && tree[cur.parent]) {
          cur = tree[cur.parent];
        } else {
          break;
        }
      }
    } else {
      if (currentTask.id.includes('.')) {
        const parts = currentTask.id.split('.');
        for (let i = 1; i <= parts.length; i++) {
          const segId = parts.slice(0, i).join('.');
          list.push({ id: segId, title: segId === currentTask.id ? currentTask.title : segId });
        }
      } else {
        list.push({ id: currentTask.id, title: currentTask.title });
      }
    }
    return list;
  }, [currentTask, tree]);

  const inheritedItems = useMemo(() => {
    const items: Array<{ key: string; value: string; source: string }> = [];
    const nodeFromTree = tree ? tree[currentTask.id] : undefined;
    const fields = nodeFromTree?.fields || currentTask.fields;

    if (fields) {
      for (const [k, f] of Object.entries(fields)) {
        if (f && typeof f.source === 'string' && f.source.startsWith('inherited')) {
          const valStr = typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value ?? '-');
          items.push({ key: k, value: valStr, source: f.source });
        }
      }
    }

    if (currentTask.priority_source && currentTask.priority_source.startsWith('inherited')) {
      if (!items.some((i) => i.key.toLowerCase() === 'priority')) {
        items.push({ key: 'Priority', value: currentTask.priority, source: currentTask.priority_source });
      }
    }

    if (nodeFromTree?.label_sources) {
      for (const [lbl, src] of Object.entries(nodeFromTree.label_sources)) {
        if (src && src.startsWith('inherited')) {
          items.push({ key: `Label (${lbl})`, value: lbl, source: src });
        }
      }
    }

    return items;
  }, [currentTask, tree]);

  const handleOpenAddSubtask = () => {
    setShowAddSubtaskModal(true);
    setSubtaskTitle('');
    setSubtaskKind('feature');
    setSubtaskError(null);
  };

  const handleSaveShortTitle = async () => {
    const trimmed = editShortTitleValue.trim();
    setShortTitleLoading(true);
    setShortTitleError(null);
    try {
      const prevRes = await api.previewSetShortTitle(currentTask.id, {
        short_title: trimmed,
      });
      if (!prevRes.ok) {
        throw new Error(prevRes.error || 'Preview failed');
      }
      const planHash = prevRes.plan_hash || prevRes.hash || prevRes.task_hash || '';
      const applyRes = await api.setShortTitle(currentTask.id, {
        short_title: trimmed,
        expect_plan_hash: planHash,
      });
      if (!applyRes.ok) {
        throw new Error(applyRes.error || 'Failed to save short title');
      }
      setCurrentTask((prev) => ({
        ...prev,
        short_title: trimmed,
        short_title_source: 'field',
      }));
      setIsEditingShortTitle(false);
      onActionComplete();
    } catch (err: any) {
      setShortTitleError(err?.message || String(err));
    } finally {
      setShortTitleLoading(false);
    }
  };

  const handlePreviewAddSubtask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subtaskTitle.trim()) return;

    setSubtaskLoading(true);
    setSubtaskError(null);
    try {
      const res = await taskStructureApi.previewAddChild(currentTask.id, {
        title: subtaskTitle.trim(),
        kind: subtaskKind,
        short_title: subtaskShortTitle.trim() || undefined,
      });
      if (!res.ok) {
        throw new Error(res.error || 'Preview failed');
      }
      setStructureConfirmData({
        isOpen: true,
        title: `Confirm Add Subtask under ${currentTask.id}`,
        summary: res.summary || `Add subtask ${res.allocated_id || ''} under ${currentTask.id}`,
        plan: res.plan,
        planHash: res.plan_hash || res.hash,
        actionType: 'add-child',
        extraPayload: { title: subtaskTitle.trim(), kind: subtaskKind, short_title: subtaskShortTitle.trim() || undefined },
      });
      setShowAddSubtaskModal(false);
    } catch (err: any) {
      setSubtaskError(err?.message || String(err));
    } finally {
      setSubtaskLoading(false);
    }
  };

  const handlePreviewExpand = async () => {
    try {
      const res = await taskStructureApi.previewExpandTask(currentTask.id);
      if (!res.ok) {
        throw new Error(res.error || 'Preview failed');
      }
      setStructureConfirmData({
        isOpen: true,
        title: `Expand ${currentTask.id} to folder`,
        summary: res.summary || `Convert inline task ${currentTask.id} into a folder bundle`,
        plan: res.plan,
        planHash: res.plan_hash || res.hash,
        actionType: 'expand',
      });
    } catch (err: any) {
      alert(`Expand failed: ${err.message || String(err)}`);
    }
  };

  const handlePreviewCollapse = async () => {
    try {
      const res = await taskStructureApi.previewCollapseTask(currentTask.id);
      if (!res.ok) {
        throw new Error(res.error || 'Preview failed');
      }
      setStructureConfirmData({
        isOpen: true,
        title: `Collapse ${currentTask.id} to block`,
        summary: res.summary || `Collapse folder ${currentTask.id} back into a block`,
        plan: res.plan,
        planHash: res.plan_hash || res.hash,
        actionType: 'collapse',
      });
    } catch (err: any) {
      alert(`Collapse failed: ${err.message || String(err)}`);
    }
  };

  const handleApplyStructureConfirm = async (planHash?: string) => {
    if (!structureConfirmData) return;
    const { actionType, extraPayload } = structureConfirmData;
    const hash = planHash || structureConfirmData.planHash || '';

    if (actionType === 'add-child') {
      await taskStructureApi.addChild(currentTask.id, {
        title: extraPayload.title,
        kind: extraPayload.kind,
        short_title: extraPayload.short_title,
        expect_plan_hash: hash,
      });
    } else if (actionType === 'expand') {
      await taskStructureApi.expandTask(currentTask.id, { expect_plan_hash: hash });
    } else if (actionType === 'collapse') {
      await taskStructureApi.collapseTask(currentTask.id, { expect_plan_hash: hash });
    }

    setStructureConfirmData(null);
    await reloadTaskDetailAndState();
    onActionComplete();
  };

  const [taskBlobUrls, setTaskBlobUrls] = useState<Record<string, string>>({});
  const [viewingTextAttachment, setViewingTextAttachment] = useState<{ filename: string; size?: number } | null>(null);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingOverAttachments, setIsDraggingOverAttachments] = useState(false);
  const taskFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEmergentTask || !currentTask.attachments || currentTask.attachments.length === 0) {
      setTaskBlobUrls({});
      return;
    }

    let active = true;
    const urlsToRevoke: string[] = [];

    const loadImages = async () => {
      const urls: Record<string, string> = {};
      for (const name of currentTask.attachments || []) {
        const info = getAttachmentInfo(name, currentTask.attachment_details);
        if (info.class === 'image') {
          try {
            const blob = await api.getTaskAttachment(currentTask.id, name);
            if (!active) return;
            const url = URL.createObjectURL(blob);
            urlsToRevoke.push(url);
            urls[name] = url;
          } catch {
            // non-blocking
          }
        }
      }
      if (active) {
        setTaskBlobUrls(urls);
      }
    };

    loadImages();

    return () => {
      active = false;
      urlsToRevoke.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [currentTask.id, currentTask.bundle_sha256, isEmergentTask, currentTask.attachments]);

  const handleUploadTaskFile = async (file: File) => {
    if (!isEmergentTask) return;
    try {
      setIsUploadingAttachment(true);
      setAttachmentError(null);
      await api.uploadTaskAttachment(currentTask.id, file, file.name, currentTask.bundle_sha256);
      await reloadTaskDetailAndState();
      onActionComplete();
    } catch (err: any) {
      setAttachmentError(err?.message || String(err));
    } finally {
      setIsUploadingAttachment(false);
    }
  };

  const handleRemoveTaskAttachment = async (name: string) => {
    if (!isEmergentTask) return;
    if (!window.confirm(`Delete attachment "${name}"?`)) return;

    try {
      setIsUploadingAttachment(true);
      setAttachmentError(null);
      await api.deleteTaskAttachment(currentTask.id, name, currentTask.bundle_sha256);
      await reloadTaskDetailAndState();
      onActionComplete();
    } catch (err: any) {
      setAttachmentError(err?.message || String(err));
    } finally {
      setIsUploadingAttachment(false);
    }
  };

  const handleDownloadTaskPdf = (name: string) => {
    downloadAttachmentBlob(() => api.getTaskAttachment(currentTask.id, name), name).catch((err) => {
      setAttachmentError(`Failed to download ${name}: ${err?.message || err}`);
    });
  };

  const handleTaskAttachmentClick = (filename: string) => {
    const info = getAttachmentInfo(filename, currentTask.attachment_details);
    if (info.class === 'pdf') {
      handleDownloadTaskPdf(filename);
    } else if (info.class === 'text') {
      setViewingTextAttachment({ filename, size: info.size });
    } else if (info.class === 'image') {
      handleDownloadTaskPdf(filename);
    }
  };

  const reloadTaskDetailAndState = useCallback(async () => {
    try {
      const data = await api.getTaskDetail(task.id);
      setDetail(data);
    } catch (e: any) {
      setTransitionError(`Failed to load task specification: ${e.message}`);
    }

    try {
      const res = await api.getTasks();
      const all = res?.all_tasks || res?.emergent_tasks || [];
      const updated = all.find((t: TaskItem) => t.id === task.id);
      if (updated) {
        setCurrentTask(updated);
      }
    } catch {
      // non-blocking
    }
  }, [task.id]);

  const loadTaskRuns = useCallback(async () => {
    try {
      const res = await api.listRuns({ task: task.id });
      setTaskRuns(res.runs || []);
      return res.runs || [];
    } catch {
      return [];
    }
  }, [task.id]);

  useEffect(() => {
    reloadTaskDetailAndState();
    loadTaskRuns();
    loadQuestions();
  }, [task.id, reloadTaskDetailAndState, loadTaskRuns]);

  // WebSocket listener debounced 300ms on changed runs or tasks
  useEffect(() => {
    let timer: any = null;
    const unsub = api.subscribeWebSocket((msg) => {
      const isChangedAreas =
        msg.type === 'changed' &&
        Array.isArray(msg.areas) &&
        (msg.areas.includes('runs') || msg.areas.includes('tasks'));

      const isTaskRunEvent =
        msg.type === 'tasks_changed' ||
        msg.type === 'task_transitioned' ||
        msg.type === 'task_delivered' ||
        msg.type === 'run_cancelled' ||
        msg.type === 'verdict_applied';

      if (isChangedAreas || isTaskRunEvent) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          reloadTaskDetailAndState();
          loadTaskRuns();
          setRunsRefreshTrigger((k) => k + 1);
        }, 300);
      }
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [reloadTaskDetailAndState, loadTaskRuns]);

  const loadQuestions = async () => {
    setQuestionsLoading(true);
    try {
      const res = await api.getQuestions({ blocks: task.id });
      if (res && res.questions) {
        setTaskQuestions(res.questions);
      } else {
        setTaskQuestions([]);
      }
    } catch {
      // Non-blocking
    } finally {
      setQuestionsLoading(false);
    }
  };

  const handleAddOption = () => {
    setAskOptions((prev) => [...prev, { title: '', consequence: '' }]);
  };

  const handleRemoveOption = (index: number) => {
    setAskOptions((prev) => {
      const updated = prev.filter((_, idx) => idx !== index);
      const maxLetter = String.fromCharCode(65 + Math.max(0, updated.length - 1));
      if (askRecommended !== '-' && askRecommended > maxLetter) {
        setAskRecommended('-');
      }
      return updated;
    });
  };

  const handleOptionChange = (index: number, field: 'title' | 'consequence', value: string) => {
    setAskOptions((prev) =>
      prev.map((opt, idx) => (idx === index ? { ...opt, [field]: value } : opt))
    );
  };

  const handleAskSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAskError(null);

    const qText = askQuestionText.trim();
    if (!qText) {
      setAskError('Question text cannot be empty.');
      return;
    }
    if (qText.length > 160) {
      setAskError('Question cannot exceed 160 characters.');
      return;
    }
    if (!qText.endsWith('?')) {
      setAskError('Question must end with a question mark (?).');
      return;
    }

    if (!askOpenAnswer && askOptions.length < 2) {
      setAskError('At least 2 options are required when open-answer is disabled.');
      return;
    }

    const builtOptions: Array<{ label: string; title: string; consequence?: string }> = [];
    for (let i = 0; i < askOptions.length; i++) {
      const opt = askOptions[i];
      if (opt.title.trim()) {
        builtOptions.push({
          label: String.fromCharCode(65 + i),
          title: opt.title.trim(),
          consequence: opt.consequence.trim() || undefined,
        });
      } else if (!askOpenAnswer) {
        setAskError(`Option ${String.fromCharCode(65 + i)} must have a title.`);
        return;
      }
    }

    if (builtOptions.length === 0 && askRecommended !== '-') {
      setAskError('Recommended option must be "-" when no options are provided.');
      return;
    }

    setAskSubmitting(true);
    try {
      const payload: AskQuestionPayload = {
        question: qText,
        short_title: askQuestionShortTitle.trim() || undefined,
        context: askContextText.trim() || undefined,
        options: builtOptions.length > 0 ? builtOptions : undefined,
        recommended: askRecommended !== '-' ? askRecommended : undefined,
        open_answer: askOpenAnswer,
        blocks: [task.id],
        decider: 'owner',
        asked_by: 'owner',
      };
      await api.askQuestion(payload);
      setShowAskForm(false);
      setAskQuestionText('');
      setAskQuestionShortTitle('');
      setAskContextText('');
      setAskOptions([
        { title: '', consequence: '' },
        { title: '', consequence: '' },
      ]);
      setAskRecommended('-');
      setAskOpenAnswer(true);
      await loadQuestions();
      await reloadTaskDetailAndState();
      onActionComplete();
    } catch (err: any) {
      setAskError(err?.message || String(err));
    } finally {
      setAskSubmitting(false);
    }
  };

  const handleTransition = async (newState: string, verifier?: string, reason?: string) => {
    setLoading(true);
    setTransitionError(null);
    try {
      const res = await api.transitionTask(task.id, newState, 'operator', verifier, reason);
      if (res && res.index_in_sync === false) {
        setIndexOutOfSync(true);
        onIndexOutOfSync?.();
      }
      await reloadTaskDetailAndState();
      await loadTaskRuns();
      setRunsRefreshTrigger((k) => k + 1);
      onActionComplete();
      onClose();
    } catch (e: any) {
      setTransitionError(`Transition error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyHandoff = () => {
    if (currentTask.handoff) {
      navigator.clipboard.writeText(currentTask.handoff);
      setCopiedHandoff(true);
      setTimeout(() => setCopiedHandoff(false), 2000);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '2rem',
    }}>
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.75rem',
        width: '100%',
        maxWidth: '850px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid #334155',
        }}>
          <div>
            {/* Breadcrumbs */}
            {breadcrumbs.length > 1 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.75rem',
                  color: '#94a3b8',
                  marginBottom: '0.4rem',
                  flexWrap: 'wrap',
                }}
              >
                {breadcrumbs.map((bc: { id: string; title: string; task?: TaskItem }, idx: number) => {
                  const isCurrent = idx === breadcrumbs.length - 1;
                  return (
                    <React.Fragment key={bc.id}>
                      {idx > 0 && <span style={{ color: '#475569' }}>/</span>}
                      {isCurrent ? (
                        <span style={{ color: '#cbd5e1', fontWeight: 600 }}>{bc.id}</span>
                      ) : (
                        <button
                          onClick={() => {
                            if (bc.task) {
                              setCurrentTask(bc.task);
                            }
                            onSelectTask?.(bc.task || ({ id: bc.id, title: bc.title } as TaskItem));
                          }}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            color: '#818cf8',
                            cursor: 'pointer',
                            fontSize: '0.75rem',
                            textDecoration: 'underline',
                          }}
                          title={bc.title}
                        >
                          {bc.id}
                        </button>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
              <span style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '0.15rem 0.4rem',
                borderRadius: '0.25rem',
                backgroundColor: currentTask.priority === 'P0' ? '#ef4444' : currentTask.priority === 'P1' ? '#f59e0b' : '#64748b',
                color: '#fff',
              }}>
                {currentTask.priority}
              </span>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#818cf8' }}>{currentTask.id}</span>
              {!isEditingShortTitle ? (
                <span
                  style={{
                    fontSize: '0.8rem',
                    color: '#94a3b8',
                    fontWeight: 500,
                    cursor: 'pointer',
                    maxWidth: '240px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}
                  title={`${currentTask.title} (Click to edit short title)`}
                  onClick={() => {
                    setIsEditingShortTitle(true);
                    setEditShortTitleValue(currentTask.short_title || shortTitle(currentTask));
                    setShortTitleError(null);
                  }}
                >
                  <span>({shortTitle(currentTask)})</span>
                  <Edit2 size={11} style={{ opacity: 0.6 }} />
                </span>
              ) : (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={editShortTitleValue}
                    onChange={(e) => setEditShortTitleValue(e.target.value)}
                    placeholder="3-4 word short title"
                    autoFocus
                    disabled={shortTitleLoading}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.15rem 0.4rem',
                      borderRadius: '0.25rem',
                      border: shortTitleError ? '1px solid #ef4444' : '1px solid #4f46e5',
                      backgroundColor: '#0f172a',
                      color: '#f8fafc',
                      width: '160px',
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSaveShortTitle();
                      } else if (e.key === 'Escape') {
                        setIsEditingShortTitle(false);
                        setShortTitleError(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={shortTitleLoading}
                    onClick={handleSaveShortTitle}
                    style={{
                      padding: '0.15rem 0.45rem',
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      borderRadius: '0.25rem',
                      backgroundColor: '#4f46e5',
                      color: '#fff',
                      border: 'none',
                      cursor: shortTitleLoading ? 'not-allowed' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.2rem',
                    }}
                  >
                    {shortTitleLoading && <Loader2 size={11} className="spin" />}
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={shortTitleLoading}
                    onClick={() => {
                      setIsEditingShortTitle(false);
                      setShortTitleError(null);
                    }}
                    style={{
                      padding: '0.15rem 0.35rem',
                      fontSize: '0.7rem',
                      borderRadius: '0.25rem',
                      backgroundColor: '#334155',
                      color: '#cbd5e1',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  {shortTitleError && (
                    <span style={{ fontSize: '0.7rem', color: '#f87171' }} title={shortTitleError}>
                      {shortTitleError}
                    </span>
                  )}
                </div>
              )}
              {currentTask.category === 'micro' && (
                <span style={{
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  backgroundColor: '#27272a',
                  color: '#a1a1aa',
                  padding: '0.1rem 0.35rem',
                  borderRadius: '0.25rem',
                  textTransform: 'uppercase',
                }}>
                  micro
                </span>
              )}
              {currentTask.fields?.kind?.value ? (
                <KindBadge kind={String(currentTask.fields.kind.value)} size={12} showLabel={true} />
              ) : currentTask.kind && currentTask.kind !== 'emergent' && currentTask.kind !== 'initiative_task' ? (
                <KindBadge kind={currentTask.kind} size={12} showLabel={true} />
              ) : null}
              <span style={{
                fontSize: '0.75rem',
                padding: '0.15rem 0.5rem',
                borderRadius: '1rem',
                backgroundColor: '#334155',
                color: '#cbd5e1',
              }}>
                {currentTask.state}
              </span>

              {/* Promote button if microtask */}
              {currentTask.category === 'micro' && (
                <button
                  type="button"
                  onClick={() => setShowPromoteDialog(true)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.2rem 0.55rem',
                    borderRadius: '0.25rem',
                    backgroundColor: '#4f46e5',
                    color: '#fff',
                    border: 'none',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    marginLeft: 'auto',
                  }}
                >
                  <ArrowUpRight size={13} />
                  <span>Promote to Full Task</span>
                </button>
              )}
            </div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600, color: '#f8fafc' }}>{currentTask.title}</h2>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.25rem' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Non-blocking index out of sync notice */}
        {indexOutOfSync && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.6rem 1.5rem',
            backgroundColor: '#3b2505',
            borderBottom: '1px solid #f59e0b',
            color: '#fef3c7',
            fontSize: '0.85rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <AlertTriangle size={16} color="#f59e0b" />
              <span>Index out of sync</span>
            </div>
            {onRequestSyncIndex && (
              <button
                onClick={() => {
                  onRequestSyncIndex();
                  onClose();
                }}
                style={{
                  padding: '0.2rem 0.6rem',
                  borderRadius: '0.25rem',
                  border: 'none',
                  backgroundColor: '#f59e0b',
                  color: '#000',
                  fontWeight: 600,
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                Sync…
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem' }}>
          {/* Metadata pill bar */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem',
            padding: '1rem',
            backgroundColor: '#0f172a',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            marginBottom: '1.5rem',
            fontSize: '0.85rem',
          }}>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Assignee / Executor</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{currentTask.executor || 'self'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Role Profile</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{currentTask.profile || 'bulk-execution'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Verification Mode</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{currentTask.verification_mode || 'independent-session'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Category</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{currentTask.category}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Labels</span>
                <button
                  type="button"
                  onClick={() => setShowLabelEditor(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#818cf8',
                    cursor: 'pointer',
                    fontSize: '0.7rem',
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                >
                  Edit
                </button>
              </div>
              <div style={{ marginTop: '0.25rem' }}>
                {currentTask.labels && currentTask.labels.length > 0 ? (
                  <LabelList labels={currentTask.labels} maxVisible={5} size="sm" />
                ) : (
                  <span style={{ color: '#64748b', fontStyle: 'italic', fontSize: '0.8rem' }}>None</span>
                )}
              </div>
            </div>
          </div>

          {/* Handoff prompt box */}
          {currentTask.handoff && (
            <div style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              padding: '0.75rem 1rem',
              marginBottom: '1.5rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#818cf8', textTransform: 'uppercase' }}>Handoff Prompt</span>
                <button
                  onClick={copyHandoff}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    background: 'none',
                    border: 'none',
                    color: copiedHandoff ? '#10b981' : '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                  }}
                >
                  {copiedHandoff ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedHandoff ? 'Copied' : 'Copy Prompt'}</span>
                </button>
              </div>
              <code style={{ fontSize: '0.8rem', color: '#e2e8f0', fontFamily: 'monospace', display: 'block', wordBreak: 'break-all' }}>
                {currentTask.handoff}
              </code>
            </div>
          )}

          {/* Inheritance section when data exists */}
          {inheritedItems.length > 0 && (
            <div style={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              padding: '0.75rem 1rem',
              marginBottom: '1.5rem',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: '#818cf8',
                textTransform: 'uppercase',
                marginBottom: '0.5rem',
              }}>
                <span>Inheritance</span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '0.6rem',
                fontSize: '0.8rem',
              }}>
                {inheritedItems.map((item: { key: string; value: string; source: string }) => (
                  <div key={item.key} style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ color: '#64748b', fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: 600 }}>
                      {item.key}
                    </span>
                    <span style={{ color: '#e2e8f0', fontWeight: 500, wordBreak: 'break-word' }}>
                      {item.value}{' '}
                      <span style={{ color: '#818cf8', fontSize: '0.75rem' }}>({item.source})</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Task document: structured (fields + body) or raw (file source) */}
          {detail ? (() => {
            const { fields, body } = splitTaskDoc(String(detail.content || ''));
            const extraFields = fields.filter(([k]) => !HIDDEN_HEADER_FIELDS.has(k));
            const chooseView = (v: TaskDocView) => {
              setDocView(v);
              try {
                localStorage.setItem(TASK_DOC_VIEW_KEY, v);
              } catch {
                // Ignore storage errors
              }
            };
            return (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.8rem' }}>
                    <FileText size={14} />
                    <span>{detail.relative_path}</span>
                  </div>
                  <div style={{ display: 'flex', backgroundColor: '#1e293b', padding: '0.15rem', borderRadius: '0.3rem', border: '1px solid #334155' }}>
                    {(['structured', 'raw'] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => chooseView(v)}
                        style={{
                          padding: '0.2rem 0.6rem',
                          borderRadius: '0.2rem',
                          border: 'none',
                          backgroundColor: docView === v ? '#4f46e5' : 'transparent',
                          color: docView === v ? '#fff' : '#94a3b8',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                        }}
                      >
                        {v === 'structured' ? 'Structured' : 'Raw'}
                      </button>
                    ))}
                  </div>
                </div>
                {docView === 'raw' ? (
                  <pre style={{
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '0.5rem',
                    padding: '1rem',
                    fontSize: '0.8rem',
                    color: '#e2e8f0',
                    lineHeight: 1.5,
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    margin: 0,
                  }}>
                    {String(detail.content || '')}
                  </pre>
                ) : (
                  <>
                    {extraFields.length > 0 && (
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(110px, max-content) 1fr',
                        columnGap: '1rem',
                        rowGap: '0.35rem',
                        padding: '0.75rem 1rem',
                        backgroundColor: '#0f172a',
                        border: '1px solid #334155',
                        borderRadius: '0.5rem',
                        marginBottom: '0.75rem',
                        fontSize: '0.8rem',
                      }}>
                        {extraFields.map(([k, v]) => (
                          <React.Fragment key={k}>
                            <div style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '0.7rem', fontWeight: 600, paddingTop: '0.1rem' }}>{k}</div>
                            <div style={{ color: v === '-' ? '#475569' : '#e2e8f0', overflowWrap: 'anywhere' }}>{v || '-'}</div>
                          </React.Fragment>
                        ))}
                      </div>
                    )}
                    <div style={{
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '0.5rem',
                      padding: '1rem',
                      fontSize: '0.85rem',
                      color: '#cbd5e1',
                      lineHeight: 1.6,
                    }}>
                      <SafeMarkdown
                        content={body}
                        attachmentBlobUrls={taskBlobUrls}
                        onAttachmentClick={handleTaskAttachmentClick}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })() : (
            <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading task specification...</div>
          )}

          {/* Attachments Section for Emergent Tasks (T###) only */}
          {isEmergentTask && (
            <div
              style={{
                marginTop: '1.25rem',
                backgroundColor: '#0f172a',
                border: isDraggingOverAttachments ? '2px dashed #6366f1' : '1px solid #334155',
                borderRadius: '0.5rem',
                padding: '1rem 1.25rem',
                transition: 'border 0.15s, background-color 0.15s',
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOverAttachments(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOverAttachments(false);
              }}
              onDrop={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingOverAttachments(false);
                const files = e.dataTransfer.files;
                if (!files || files.length === 0) return;
                for (let i = 0; i < files.length; i++) {
                  await handleUploadTaskFile(files[i]);
                }
              }}
            >
              {/* Header */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: currentTask.attachments && currentTask.attachments.length > 0 ? '0.75rem' : '0.5rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Paperclip size={18} color="#818cf8" />
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                    Attachments ({currentTask.attachments?.length || 0})
                  </h3>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    ref={taskFileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      if (e.target.files) {
                        for (let i = 0; i < e.target.files.length; i++) {
                          await handleUploadTaskFile(e.target.files[i]);
                        }
                        e.target.value = '';
                      }
                    }}
                  />
                  <button
                    onClick={() => taskFileInputRef.current?.click()}
                    disabled={isUploadingAttachment}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.35rem 0.75rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #6366f1',
                      backgroundColor: 'rgba(99, 102, 241, 0.1)',
                      color: '#a5b4fc',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: isUploadingAttachment ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <Plus size={14} />
                    <span>Attach…</span>
                  </button>
                </div>
              </div>

              {/* Error Banner */}
              {attachmentError && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.6rem 0.8rem',
                    backgroundColor: '#451a1a',
                    border: '1px solid #7f1d1d',
                    borderRadius: '0.375rem',
                    color: '#f87171',
                    fontSize: '0.8rem',
                    marginBottom: '0.75rem',
                  }}
                >
                  <AlertCircle size={15} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{attachmentError}</span>
                  <button
                    onClick={() => setAttachmentError(null)}
                    style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', padding: 0 }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              {/* Uploading progress indicator */}
              {isUploadingAttachment && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    color: '#818cf8',
                    fontSize: '0.8rem',
                    marginBottom: '0.75rem',
                  }}
                >
                  <Loader2 size={16} className="spin" />
                  <span>Uploading attachment...</span>
                </div>
              )}

              {/* Attachments List or Empty Dropzone */}
              {currentTask.attachments && currentTask.attachments.length > 0 ? (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {currentTask.attachments.map((name) => (
                    <AttachmentItem
                      key={name}
                      name={name}
                      context={{ type: 'task', id: currentTask.id }}
                      details={currentTask.attachment_details}
                      thumbnailSize={64}
                      canRemove={true}
                      onRemove={() => handleRemoveTaskAttachment(name)}
                      onBlobLoaded={(attName, url) => {
                        setTaskBlobUrls((prev) => ({ ...prev, [attName]: url }));
                      }}
                      onOpenTextViewer={(attName, sz) => {
                        setViewingTextAttachment({ filename: attName, size: sz });
                      }}
                      onDownloadPdf={(attName) => {
                        handleDownloadTaskPdf(attName);
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    padding: '1.25rem',
                    textAlign: 'center',
                    border: '1px dashed #334155',
                    borderRadius: '0.375rem',
                    color: '#64748b',
                    fontSize: '0.8rem',
                  }}
                >
                  No attachments yet. Drop files here or click Attach… to upload.
                </div>
              )}
            </div>
          )}

          {/* Questions Section */}
          <div style={{
            marginTop: '1.5rem',
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '0.5rem',
            padding: '1rem 1.25rem',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <HelpCircle size={18} color="#818cf8" />
                <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                  Questions ({taskQuestions.length})
                </h3>
              </div>

              {!showAskForm && (
                <button
                  onClick={() => setShowAskForm(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.35rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #6366f1',
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    color: '#a5b4fc',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <Plus size={14} />
                  <span>Ask a question…</span>
                </button>
              )}
            </div>

            {/* Questions list */}
            {questionsLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.8rem', padding: '0.5rem 0' }}>
                <Loader2 size={14} className="spin" />
                <span>Loading questions...</span>
              </div>
            ) : taskQuestions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: showAskForm ? '1rem' : '0' }}>
                {taskQuestions.map((q) => {
                  const isAnswered = q.status === 'answered';
                  const isWithdrawn = q.status === 'withdrawn';
                  return (
                    <div
                      key={q.id}
                      style={{
                        padding: '0.6rem 0.75rem',
                        borderRadius: '0.375rem',
                        backgroundColor: '#1e293b',
                        border: '1px solid #334155',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.3rem',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#818cf8', fontFamily: 'monospace' }}>
                            {q.id}
                          </span>
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              padding: '0.1rem 0.35rem',
                              borderRadius: '0.25rem',
                              backgroundColor: isAnswered ? '#064e3b' : isWithdrawn ? '#451a1a' : '#3b2505',
                              color: isAnswered ? '#34d399' : isWithdrawn ? '#fca5a5' : '#f59e0b',
                            }}
                          >
                            {q.status}
                          </span>
                        </div>
                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                          {q.asked}
                        </span>
                      </div>

                      <div style={{ fontSize: '0.85rem', color: '#f8fafc', fontWeight: 500 }}>
                        {q.question}
                      </div>

                      {isAnswered && q.answer && (
                        <div style={{ fontSize: '0.75rem', color: '#34d399', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                          <Check size={12} />
                          <span>Choice: <strong>{q.answer.choice}</strong></span>
                          {q.answer.text && q.answer.text !== '-' && (
                            <span style={{ color: '#94a3b8' }}>— {q.answer.text.slice(0, 60)}...</span>
                          )}
                        </div>
                      )}

                      {isWithdrawn && q.answer && (
                        <div style={{ fontSize: '0.75rem', color: '#fca5a5' }}>
                          Withdrawn: {q.answer.text || 'No reason specified'}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : !showAskForm ? (
              <div style={{ fontSize: '0.8rem', color: '#64748b', fontStyle: 'italic', padding: '0.25rem 0' }}>
                No blocking questions on this task.
              </div>
            ) : null}

            {/* Ask a question form */}
            {showAskForm && (
              <form
                onSubmit={handleAskSubmit}
                style={{
                  marginTop: '0.75rem',
                  padding: '1rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #4f46e5',
                  borderRadius: '0.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.85rem',
                }}
              >
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#a5b4fc' }}>
                  Ask a Question for {task.id}
                </div>

                {/* Question Input with Live Validation */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>
                      Question (max 160 chars, must end with '?'):
                    </label>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        fontFamily: 'monospace',
                        color:
                          askQuestionText.length > 160
                            ? '#ef4444'
                            : askQuestionText.length > 0 && !askQuestionText.trim().endsWith('?')
                            ? '#f59e0b'
                            : '#94a3b8',
                      }}
                    >
                      {askQuestionText.length}/160
                    </span>
                  </div>

                  <input
                    type="text"
                    value={askQuestionText}
                    onChange={(e) => setAskQuestionText(e.target.value)}
                    placeholder="e.g. Which permission policy should headless Claude runs use by default?"
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      backgroundColor: '#0f172a',
                      border: `1px solid ${
                        askQuestionText.length > 160
                          ? '#ef4444'
                          : askQuestionText.length > 0 && !askQuestionText.trim().endsWith('?')
                          ? '#f59e0b'
                          : '#334155'
                      }`,
                      borderRadius: '0.375rem',
                      color: '#f8fafc',
                      fontSize: '0.85rem',
                      outline: 'none',
                    }}
                  />

                  {/* Live validation hints */}
                  <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem', fontSize: '0.75rem' }}>
                    {askQuestionText.length > 160 && (
                      <span style={{ color: '#ef4444' }}>Exceeds 160 characters limit</span>
                    )}
                    {askQuestionText.length > 0 && !askQuestionText.trim().endsWith('?') && (
                      <span style={{ color: '#f59e0b' }}>Must end with a question mark (?)</span>
                    )}
                    {askQuestionText.length > 0 &&
                      askQuestionText.length <= 160 &&
                      askQuestionText.trim().endsWith('?') && (
                        <span style={{ color: '#10b981' }}>✓ Valid question format</span>
                      )}
                  </div>
                </div>

                {/* Short Title (optional) */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                    Short Title (optional, 3-4 words)
                  </label>
                  <input
                    type="text"
                    value={askQuestionShortTitle}
                    onChange={(e) => setAskQuestionShortTitle(e.target.value)}
                    placeholder="e.g. Permission policy choice"
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '0.375rem',
                      color: '#f8fafc',
                      fontSize: '0.85rem',
                      outline: 'none',
                    }}
                  />
                </div>

                {/* Context Textarea */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                    Context & Background (Markdown supported):
                  </label>
                  <textarea
                    value={askContextText}
                    onChange={(e) => setAskContextText(e.target.value)}
                    placeholder="Explain the background, trade-offs, and consequences for each choice..."
                    rows={3}
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '0.375rem',
                      color: '#f8fafc',
                      fontSize: '0.85rem',
                      lineHeight: 1.4,
                      resize: 'vertical',
                    }}
                  />
                </div>

                {/* Dynamic Options */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>
                      Options ({askOptions.length}):
                    </label>
                    <button
                      type="button"
                      onClick={handleAddOption}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.2rem',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '0.25rem',
                        border: '1px solid #4f46e5',
                        backgroundColor: 'transparent',
                        color: '#a5b4fc',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                      }}
                    >
                      <Plus size={12} />
                      <span>Add Option</span>
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {askOptions.map((opt, idx) => {
                      const letter = String.fromCharCode(65 + idx);
                      return (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            gap: '0.5rem',
                            alignItems: 'center',
                            backgroundColor: '#0f172a',
                            padding: '0.4rem 0.6rem',
                            borderRadius: '0.375rem',
                            border: '1px solid #334155',
                          }}
                        >
                          <span style={{ fontWeight: 700, color: '#818cf8', width: '20px', textAlign: 'center', fontFamily: 'monospace' }}>
                            {letter}
                          </span>
                          <input
                            type="text"
                            value={opt.title}
                            onChange={(e) => handleOptionChange(idx, 'title', e.target.value)}
                            placeholder="Title (e.g. acceptEdits)"
                            style={{
                              flex: 1,
                              padding: '0.35rem 0.5rem',
                              backgroundColor: '#1e293b',
                              border: '1px solid #334155',
                              borderRadius: '0.25rem',
                              color: '#f8fafc',
                              fontSize: '0.8rem',
                            }}
                          />
                          <input
                            type="text"
                            value={opt.consequence}
                            onChange={(e) => handleOptionChange(idx, 'consequence', e.target.value)}
                            placeholder="Consequence / Trade-off (optional)"
                            style={{
                              flex: 1.5,
                              padding: '0.35rem 0.5rem',
                              backgroundColor: '#1e293b',
                              border: '1px solid #334155',
                              borderRadius: '0.25rem',
                              color: '#cbd5e1',
                              fontSize: '0.8rem',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveOption(idx)}
                            title="Remove Option"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#94a3b8',
                              cursor: 'pointer',
                              padding: '0.2rem',
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Recommended select & Open Answer toggle */}
                <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1' }}>
                      Recommended:
                    </label>
                    <select
                      value={askRecommended}
                      onChange={(e) => setAskRecommended(e.target.value)}
                      style={{
                        backgroundColor: '#0f172a',
                        border: '1px solid #334155',
                        borderRadius: '0.25rem',
                        color: '#cbd5e1',
                        padding: '0.3rem 0.6rem',
                        fontSize: '0.8rem',
                      }}
                    >
                      <option value="-">- (None)</option>
                      {askOptions.map((_, idx) => {
                        const letter = String.fromCharCode(65 + idx);
                        return (
                          <option key={letter} value={letter}>
                            Option {letter}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.8rem', color: '#cbd5e1' }}>
                    <input
                      type="checkbox"
                      checked={askOpenAnswer}
                      onChange={(e) => setAskOpenAnswer(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span>Allow free-text answer (open-answer: yes)</span>
                  </label>
                </div>

                {/* Form Error Banner */}
                {askError && (
                  <div
                    style={{
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.375rem',
                      backgroundColor: '#451a1a',
                      border: '1px solid #ef4444',
                      color: '#fca5a5',
                      fontSize: '0.8rem',
                    }}
                  >
                    {askError}
                  </div>
                )}

                {/* Form Buttons */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAskForm(false);
                      setAskError(null);
                    }}
                    disabled={askSubmitting}
                    style={{
                      padding: '0.4rem 0.8rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #475569',
                      backgroundColor: 'transparent',
                      color: '#cbd5e1',
                      fontSize: '0.8rem',
                      cursor: askSubmitting ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={
                      askSubmitting ||
                      !askQuestionText.trim() ||
                      askQuestionText.length > 160 ||
                      !askQuestionText.trim().endsWith('?')
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.4rem 0.9rem',
                      borderRadius: '0.375rem',
                      border: 'none',
                      backgroundColor: '#4f46e5',
                      color: '#fff',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor:
                        askSubmitting ||
                        !askQuestionText.trim() ||
                        askQuestionText.length > 160 ||
                        !askQuestionText.trim().endsWith('?')
                          ? 'not-allowed'
                          : 'pointer',
                    }}
                  >
                    {askSubmitting ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Send size={14} />
                    )}
                    <span>Submit Question</span>
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Bounce input box if active */}
          {showBounceInput && (
            <div style={{
              marginTop: '1rem',
              padding: '1rem',
              backgroundColor: '#451a1a',
              border: '1px solid #ef4444',
              borderRadius: '0.5rem',
            }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fca5a5', marginBottom: '0.5rem' }}>
                Reject / Bounce Task Back to Executor
              </div>
              <textarea
                value={bounceReason}
                onChange={(e) => setBounceReason(e.target.value)}
                placeholder="List failing criteria, reproduction commands, or B1..Bn findings..."
                rows={3}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #ef4444',
                  borderRadius: '0.375rem',
                  color: '#fff',
                  fontSize: '0.85rem',
                  marginBottom: '0.75rem',
                }}
              />
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowBounceInput(false)}
                  style={{
                    padding: '0.35rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: '1px solid #64748b',
                    backgroundColor: 'transparent',
                    color: '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleTransition('bounced', undefined, bounceReason)}
                  disabled={!bounceReason.trim() || loading}
                  style={{
                    padding: '0.35rem 0.75rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#ef4444',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Confirm Bounce
                </button>
              </div>
            </div>
          )}

          {/* Agent Runs Panel */}
          <TaskRunsPanel
            task={currentTask}
            initialRunId={activeRunId || initialRunId}
            refreshTrigger={runsRefreshTrigger}
            onRunsLoaded={(loadedRuns) => setTaskRuns(loadedRuns)}
            onRefreshTask={async () => {
              await reloadTaskDetailAndState();
              await loadTaskRuns();
              onActionComplete();
            }}
            onNavigateToDecisions={onNavigateToDecisions}
            onOpenRunDialog={() => setShowRunDialog(true)}
          />

          {/* Inline Transition Error */}
          {transitionError && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginTop: '1rem',
              padding: '0.75rem 1rem',
              borderRadius: '0.375rem',
              backgroundColor: '#451a1a',
              border: '1px solid #ef4444',
              color: '#fca5a5',
              fontSize: '0.85rem',
            }}>
              <AlertCircle size={16} color="#ef4444" />
              <span>{transitionError}</span>
            </div>
          )}
        </div>

        {/* Action Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1rem 1.5rem',
          backgroundColor: '#0f172a',
          borderTop: '1px solid #334155',
        }}>
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
            Current State: <strong style={{ color: '#cbd5e1' }}>{currentTask.state}</strong>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {isContainer ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                flexWrap: 'wrap',
                gap: '0.75rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '0.75rem',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '1rem',
                    backgroundColor: '#312e81',
                    color: '#c7d2fe',
                    border: '1px solid #6366f1',
                    fontWeight: 600,
                  }}>
                    Derived State: {currentTask.derived_state || currentTask.state}
                  </span>
                  <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                    Progress: <strong style={{ color: '#f1f5f9' }}>{currentTask.leaves_done ?? 0} / {currentTask.leaves_total ?? 0}</strong> leaves done
                  </span>
                  <span style={{ color: '#64748b', fontSize: '0.75rem' }}>
                    (Transitions apply to leaves only)
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    onClick={handleOpenAddSubtask}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.4rem 0.8rem',
                      borderRadius: '0.375rem',
                      border: 'none',
                      backgroundColor: '#6366f1',
                      color: '#fff',
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                    }}
                  >
                    <Plus size={14} />
                    <span>Add Subtask</span>
                  </button>

                  {currentTask.is_folder && !currentTask.id.startsWith('INIT-') && (
                    <button
                      onClick={handlePreviewCollapse}
                      style={{
                        padding: '0.4rem 0.8rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #475569',
                        backgroundColor: '#0f172a',
                        color: '#cbd5e1',
                        fontWeight: 500,
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                      }}
                    >
                      Collapse to Block
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Structure actions for open leaf: Add Subtask and Expand */}
                {currentTask.state === 'open' && (
                  <>
                    <button
                      onClick={handleOpenAddSubtask}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        padding: '0.4rem 0.75rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #475569',
                        backgroundColor: '#0f172a',
                        color: '#cbd5e1',
                        fontSize: '0.8rem',
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}
                      title="Add child subtask (converts leaf into container)"
                    >
                      <Plus size={14} />
                      <span>Add Subtask</span>
                    </button>

                    {!currentTask.is_folder && !currentTask.id.startsWith('INIT-') && (
                      <button
                        onClick={handlePreviewExpand}
                        style={{
                          padding: '0.4rem 0.75rem',
                          borderRadius: '0.375rem',
                          border: '1px solid #475569',
                          backgroundColor: '#0f172a',
                          color: '#cbd5e1',
                          fontSize: '0.8rem',
                          fontWeight: 500,
                          cursor: 'pointer',
                        }}
                        title="Expand inline task to folder bundle"
                      >
                        Expand to Folder
                      </button>
                    )}
                  </>
                )}

                {/* Optional agent run trigger when in flight */}
                {taskRuns.length > 0 &&
                  currentTask.state !== 'open' &&
                  currentTask.state !== 'done' &&
                  currentTask.state !== 'done with a caveat' &&
                  currentTask.state !== 'dropped' &&
                  currentTask.state !== 'verified' && (
                    <button
                      onClick={() => setShowRunDialog(true)}
                      disabled={loading}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #6366f1',
                        backgroundColor: 'rgba(99, 102, 241, 0.1)',
                        color: '#a5b4fc',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <Play size={14} />
                      <span>Run…</span>
                    </button>
                  )}

                {currentTask.state === 'open' && (
                  currentTask.kind === 'emergent' || currentTask.id.startsWith('T') ? (
                    <button
                      onClick={() => setShowRunDialog(true)}
                      disabled={loading}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '0.375rem',
                        border: 'none',
                        backgroundColor: '#4f46e5',
                        color: '#fff',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <Play size={15} />
                      <span>Run…</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleTransition('in progress')}
                      disabled={loading}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '0.375rem',
                        border: 'none',
                        backgroundColor: '#6366f1',
                        color: '#fff',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {loading ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
                      <span>Start Task (In Progress)</span>
                    </button>
                  )
                )}

                {/* Pause button when in progress */}
                {currentTask.state === 'in progress' && (
                  <button
                    onClick={() => handleTransition('paused')}
                    disabled={loading}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.4rem 0.8rem',
                      borderRadius: '0.375rem',
                      border: '1px solid #f59e0b',
                      backgroundColor: 'transparent',
                      color: '#f59e0b',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {loading ? <Loader2 size={15} className="spin" /> : <Pause size={15} />}
                    <span>Pause</span>
                  </button>
                )}

                {/* Resume button when paused */}
                {currentTask.state === 'paused' && (
                  <button
                    onClick={() => handleTransition('in progress')}
                    disabled={loading}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.4rem 0.8rem',
                      borderRadius: '0.375rem',
                      border: 'none',
                      backgroundColor: '#6366f1',
                      color: '#fff',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {loading ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
                    <span>Resume Task (In Progress)</span>
                  </button>
                )}

                {/* R6: Generic delivered transition is HIDDEN when task has runs */}
                {currentTask.state === 'in progress' && taskRuns.length === 0 && (
                  <button
                    onClick={() => handleTransition('delivered')}
                    disabled={loading}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.4rem 0.8rem',
                      borderRadius: '0.375rem',
                      border: 'none',
                      backgroundColor: '#0ea5e9',
                      color: '#fff',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {loading ? <Loader2 size={15} className="spin" /> : <CheckCircle size={15} />}
                    <span>Mark Delivered (Needs Verification)</span>
                  </button>
                )}

                {currentTask.state === 'delivered' && (
                  <>
                    <button
                      onClick={() => setShowBounceInput(true)}
                      disabled={loading}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '0.375rem',
                        border: '1px solid #ef4444',
                        backgroundColor: 'transparent',
                        color: '#f87171',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <RotateCcw size={15} />
                      <span>Bounce</span>
                    </button>

                    <button
                      onClick={() => handleTransition('verified', 'operator:owner', 'Verified by human operator in UI')}
                      disabled={loading}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '0.375rem',
                        border: 'none',
                        backgroundColor: '#10b981',
                        color: '#fff',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {loading ? <Loader2 size={15} className="spin" /> : <CheckCheck size={15} />}
                      <span>Approve (Verified)</span>
                    </button>
                  </>
                )}

                {currentTask.state === 'verified' && (
                  <button
                    onClick={() => handleTransition('done', undefined, 'Completed and integrated')}
                    disabled={loading}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.4rem 0.8rem',
                      borderRadius: '0.375rem',
                      border: 'none',
                      backgroundColor: '#10b981',
                      color: '#fff',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {loading ? <Loader2 size={15} className="spin" /> : <CheckCheck size={15} />}
                    <span>Close Task (Done)</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Run Dialog */}
      {showRunDialog && (
        <RunDialog
          isOpen={true}
          task={currentTask}
          onClose={() => setShowRunDialog(false)}
          onRunStarted={async (newRunId) => {
            setActiveRunId(newRunId);
            await loadTaskRuns();
            await reloadTaskDetailAndState();
            setRunsRefreshTrigger((k) => k + 1);
            onActionComplete();
          }}
        />
      )}

      {/* Text Viewer Modal */}
      {viewingTextAttachment && (
        <TextViewerModal
          filename={viewingTextAttachment.filename}
          size={viewingTextAttachment.size}
          fetchContent={() => api.getTaskAttachment(currentTask.id, viewingTextAttachment.filename)}
          onClose={() => setViewingTextAttachment(null)}
        />
      )}

      {/* Add Subtask Modal */}
      {showAddSubtaskModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: '1rem',
          }}
          onClick={() => setShowAddSubtaskModal(false)}
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
              Add Subtask under {currentTask.id}
            </h3>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '1rem' }}>
              Parent: <strong style={{ color: '#f1f5f9' }}>{currentTask.id} - {currentTask.title}</strong>
            </div>

            {subtaskError && (
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
                {subtaskError}
              </div>
            )}

            <form onSubmit={handlePreviewAddSubtask} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.25rem' }}>
                  Subtask Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Implement component hierarchy view"
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
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
                  value={subtaskShortTitle}
                  onChange={(e) => setSubtaskShortTitle(e.target.value)}
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
                  value={subtaskKind}
                  onChange={(e) => setSubtaskKind(e.target.value)}
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
                  onClick={() => setShowAddSubtaskModal(false)}
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
                  disabled={subtaskLoading || !subtaskTitle.trim()}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#6366f1',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.8rem',
                    cursor: subtaskLoading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  {subtaskLoading && <Loader2 size={13} className="spin" />}
                  <span>Preview & Confirm</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Structure Action Confirm Dialog */}
      {structureConfirmData && (
        <ConfirmDialog
          isOpen={structureConfirmData.isOpen}
          title={structureConfirmData.title}
          summary={structureConfirmData.summary}
          plan={structureConfirmData.plan}
          hash={structureConfirmData.planHash}
          applyButtonText="Confirm & Apply"
          cancelButtonText="Cancel"
          onApply={handleApplyStructureConfirm}
          onCancel={() => setStructureConfirmData(null)}
        />
      )}

      {/* Label Editor Modal */}
      {showLabelEditor && (
        <LabelEditorModal
          taskId={currentTask.id}
          initialLabels={currentTask.labels}
          taskHash={currentTask.task_bundle_sha256}
          isOpen={true}
          onClose={() => setShowLabelEditor(false)}
          onSuccess={(updatedLabels) => {
            setCurrentTask((prev) => ({ ...prev, labels: updatedLabels }));
            setShowLabelEditor(false);
            onActionComplete();
          }}
        />
      )}

      {/* Promote Microtask Dialog */}
      {showPromoteDialog && (
        <PromoteDialog
          taskId={currentTask.id}
          taskTitle={currentTask.title}
          taskHash={currentTask.task_bundle_sha256}
          isOpen={true}
          onClose={() => setShowPromoteDialog(false)}
          onSuccess={() => {
            setShowPromoteDialog(false);
            onActionComplete();
            onClose();
          }}
        />
      )}
    </div>
  );
};
