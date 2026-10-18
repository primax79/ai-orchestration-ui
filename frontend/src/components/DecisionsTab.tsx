import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  HelpCircle,
  CheckCircle2,
  AlertCircle,
  Clock,
  User,
  Layers,
  ChevronDown,
  ChevronRight,
  Send,
  RotateCcw,
  Search,
  Filter,
  Loader2,
  FileText,
  Check,
  Play,
  X,
} from 'lucide-react';
import { QuestionItem, TaskItem, AnswerAndResumePreviewResponse, shortTitle } from '../types';
import { api } from '../api';
import { SafeMarkdown } from './SafeMarkdown';
import { ConfirmDialog } from './ConfirmDialog';

interface DecisionsTabProps {
  tasks?: TaskItem[];
  onRefresh?: () => void;
}

function formatAge(dateStr: string): string {
  if (!dateStr || dateStr === '-') return '';
  try {
    const askedDate = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - askedDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return 'today';
    if (diffDays === 1) return '1 day ago';
    return `${diffDays} days ago`;
  } catch {
    return dateStr;
  }
}

export function getBlockedTasks(q: QuestionItem): Array<{ taskId: string; priorState: string }> {
  if (q.blocks_parsed && q.blocks_parsed.length > 0) {
    return q.blocks_parsed.map(([taskId, state]) => ({
      taskId,
      priorState: state || 'open',
    }));
  }
  if (!q.blocks || q.blocks.trim() === '-') {
    return [];
  }
  const results: Array<{ taskId: string; priorState: string }> = [];
  const parts = q.blocks.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '-') continue;
    const match = trimmed.match(/^([^\s(]+)(?:\s*\(([^)]+)\))?/);
    if (match) {
      results.push({
        taskId: match[1],
        priorState: match[2] || 'open',
      });
    }
  }
  return results;
}

export function questionBlocksTask(q: QuestionItem, taskId: string): boolean {
  if (q.blocks_parsed && q.blocks_parsed.length > 0) {
    return q.blocks_parsed.some(([tid]) => tid === taskId);
  }
  if (!q.blocks || q.blocks.trim() === '-') {
    return false;
  }
  const parts = q.blocks.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '-') continue;
    const match = trimmed.match(/^([^\s(]+)/);
    if (match && match[1] === taskId) {
      return true;
    }
  }
  return false;
}

export function computeEffects(currentQ: QuestionItem, allQuestions: QuestionItem[]): string[] {
  const blockedTasks = getBlockedTasks(currentQ);
  if (blockedTasks.length === 0) {
    return ['No tasks blocked'];
  }

  return blockedTasks.map(({ taskId, priorState }) => {
    const otherOpen = allQuestions.filter(
      (q) => q.status === 'open' && q.id !== currentQ.id && questionBlocksTask(q, taskId)
    );
    if (otherOpen.length > 0) {
      const qIds = otherOpen.map((q) => q.id).join(', ');
      return `${taskId}: stays waiting (${qIds} still open)`;
    }

    let targetState = priorState;
    if (targetState === 'waiting') {
      for (const q of allQuestions) {
        if (q.id !== currentQ.id && questionBlocksTask(q, taskId)) {
          const bt = getBlockedTasks(q).find((b) => b.taskId === taskId);
          if (bt && bt.priorState && bt.priorState !== 'waiting') {
            targetState = bt.priorState;
            break;
          }
        }
      }
      if (targetState === 'waiting') {
        targetState = 'open';
      }
    }

    return `${taskId} → ${targetState}`;
  });
}

export function buildAnswerSummary(
  q: QuestionItem,
  choice: string,
  text: string | undefined,
  allQuestions: QuestionItem[]
): string {
  let choiceDisplay = choice;
  if (choice === 'open') {
    choiceDisplay = 'Open answer';
  } else if (q.options) {
    const opt = q.options.find((o) => o.label === choice);
    if (opt) {
      choiceDisplay = `${opt.label} — ${opt.title}${opt.consequence ? `: ${opt.consequence}` : ''}`;
    }
  }

  const effects = computeEffects(q, allQuestions);
  const effectsText = effects.map((e) => `- ${e}`).join('\n');

  let summary = `### Question\n**${q.id}**: ${q.question}\n\n### Chosen Option\n${choiceDisplay}`;

  if (text && text.trim()) {
    summary += `\n\n### Free Text\n${text.trim()}`;
  }

  summary += `\n\n### Effect\n${effectsText}`;

  return summary;
}

export function buildWithdrawSummary(
  q: QuestionItem,
  reason: string,
  allQuestions: QuestionItem[]
): string {
  const effects = computeEffects(q, allQuestions);
  const effectsText = effects.map((e) => `- ${e}`).join('\n');

  let summary = `### Question\n**${q.id}**: ${q.question}`;

  if (reason && reason.trim()) {
    summary += `\n\n### Reason\n${reason.trim()}`;
  }

  summary += `\n\n### Effect\n${effectsText}`;

  return summary;
}

export function buildAnswerAndResumeSummary(
  q: QuestionItem,
  choice: string,
  text: string | undefined,
  preview: AnswerAndResumePreviewResponse,
  allQuestions: QuestionItem[]
): string {
  let choiceDisplay = choice;
  if (choice === 'open') {
    choiceDisplay = 'Open answer';
  } else if (q.options) {
    const opt = q.options.find((o) => o.label === choice);
    if (opt) {
      choiceDisplay = `${opt.label} — ${opt.title}${opt.consequence ? `: ${opt.consequence}` : ''}`;
    }
  }

  const effects = computeEffects(q, allQuestions);
  const effectsText = effects.map((e) => `- ${e}`).join('\n');

  let summary = `### Question\n**${q.id}**: ${q.question}\n\n### Chosen Option\n${choiceDisplay}`;

  if (text && text.trim()) {
    summary += `\n\n### Free Text\n${text.trim()}`;
  }

  summary += `\n\n### Target Run to Continue\n\`${preview.run_id || q.origin_run || '-'}\``;

  if (preview.prompt) {
    summary += `\n\n### Continuation Prompt\n\`\`\`text\n${preview.prompt}\n\`\`\``;
  }

  if (preview.plan_hash) {
    summary += `\n\n### Plan Hash\n\`${preview.plan_hash}\``;
  }

  summary += `\n\n### Effect\n${effectsText}\n- Origin run session will be resumed with continuation instructions`;

  return summary;
}

export const DecisionsTab: React.FC<DecisionsTabProps> = ({ tasks = [], onRefresh }) => {
  const [subTab, setSubTab] = useState<'open' | 'awaiting' | 'history'>('open');
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-card state
  const [expandedContext, setExpandedContext] = useState<Record<string, boolean>>({});
  const [selectedChoices, setSelectedChoices] = useState<Record<string, string>>({});
  const [answerTexts, setAnswerTexts] = useState<Record<string, string>>({});

  // History filters
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<'all' | 'answered' | 'withdrawn'>('all');

  // Confirmation modal for answering
  const [confirmingAnswer, setConfirmingAnswer] = useState<{
    question: QuestionItem;
    choice: string;
    choiceTitle: string;
    text?: string;
  } | null>(null);

  // Apply decision modal
  const [applyingQuestion, setApplyingQuestion] = useState<{
    question: QuestionItem;
    ref: string;
    by: string;
    note: string;
    loading?: boolean;
    error?: string;
  } | null>(null);

  // Confirmation modal for answer & resume run
  const [confirmingAnswerAndResume, setConfirmingAnswerAndResume] = useState<{
    question: QuestionItem;
    choice: string;
    choiceTitle: string;
    text?: string;
    preview: AnswerAndResumePreviewResponse;
  } | null>(null);
  const [resumeLoading, setResumeLoading] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // Withdraw modal / prompt
  const [withdrawingQuestion, setWithdrawingQuestion] = useState<{
    question: QuestionItem;
    reason: string;
    error?: string;
    submitting?: boolean;
  } | null>(null);

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getQuestions({ status: 'all' });
      if (res && res.questions) {
        setQuestions(res.questions);
      } else {
        setQuestions([]);
      }
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions]);

  const taskMap = useMemo(() => {
    const map = new Map<string, TaskItem>();
    tasks.forEach((t) => map.set(t.id, t));
    return map;
  }, [tasks]);

  const renderBlockedTasks = useCallback((blocksStr?: string) => {
    if (!blocksStr || blocksStr.trim() === '-' || blocksStr.trim() === '') {
      return <span>-</span>;
    }
    const parts = blocksStr.split(',').map((s) => s.trim()).filter(Boolean);
    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
        {parts.map((part, idx) => {
          const task = taskMap.get(part);
          return (
            <span
              key={`${part}-${idx}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                backgroundColor: '#0f172a',
                padding: '0.15rem 0.45rem',
                borderRadius: '0.25rem',
                border: '1px solid #334155',
                fontFamily: 'monospace',
                color: '#fca5a5',
              }}
            >
              <span>{part}</span>
              {task && (
                <span
                  style={{
                    color: '#94a3b8',
                    fontWeight: 500,
                    maxWidth: '140px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'sans-serif',
                  }}
                  title={task.title}
                >
                  ({shortTitle(task)})
                </span>
              )}
            </span>
          );
        })}
      </span>
    );
  }, [taskMap]);

  const openQuestions = useMemo(() => {
    return questions.filter((q) => q.status === 'open');
  }, [questions]);

  // Spec §3: "Answered, awaiting application"
  const awaitingQuestions = useMemo(() => {
    return questions.filter((q) => q.status === 'answered' && !q.applied);
  }, [questions]);

  const historyQuestions = useMemo(() => {
    return questions.filter((q) => q.status === 'answered' || q.status === 'withdrawn');
  }, [questions]);

  // Group open questions by blocked task, oldest first
  const groupedOpenQuestions = useMemo(() => {
    // Sort oldest first: earliest asked date, then earliest Q id
    const sorted = [...openQuestions].sort((a, b) => {
      if (a.asked && b.asked && a.asked !== b.asked) {
        return a.asked.localeCompare(b.asked);
      }
      return a.id.localeCompare(b.id);
    });

    const groups: { key: string; label: string; task?: TaskItem; questions: QuestionItem[] }[] = [];
    const groupMap = new Map<string, QuestionItem[]>();

    for (const q of sorted) {
      let groupKey = 'No task';
      if (q.blocks_parsed && q.blocks_parsed.length > 0) {
        groupKey = q.blocks_parsed.map(([tid]) => tid).join(', ');
      } else if (q.blocks && q.blocks.trim() !== '-') {
        const matches = q.blocks.match(/T\d{3,}/g);
        if (matches && matches.length > 0) {
          groupKey = matches.join(', ');
        }
      }

      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
      }
      groupMap.get(groupKey)!.push(q);
    }

    // Sort group keys: specific tasks first (T001, T002), 'No task' last
    const sortedKeys = Array.from(groupMap.keys()).sort((a, b) => {
      if (a === 'No task') return 1;
      if (b === 'No task') return -1;
      return a.localeCompare(b);
    });

    for (const key of sortedKeys) {
      const qs = groupMap.get(key) || [];
      const primaryTaskId = key.split(',')[0].trim();
      const task = taskMap.get(primaryTaskId);
      let label = key === 'No task' ? 'No task (Unlinked decisions)' : `Task ${key}`;
      if (task) {
        label = `Task ${task.id} (${shortTitle(task)}): ${task.title}`;
      }
      groups.push({ key, label, task, questions: qs });
    }

    return groups;
  }, [openQuestions, taskMap]);

  // Filtered history questions
  const filteredHistory = useMemo(() => {
    let result = [...historyQuestions];

    // Status filter
    if (historyStatusFilter !== 'all') {
      result = result.filter((q) => q.status === historyStatusFilter);
    }

    // Search query
    if (historySearch.trim()) {
      const qLower = historySearch.toLowerCase();
      result = result.filter((q) => {
        return (
          q.id.toLowerCase().includes(qLower) ||
          q.question.toLowerCase().includes(qLower) ||
          (q.blocks && q.blocks.toLowerCase().includes(qLower)) ||
          (q.answer?.choice && q.answer.choice.toLowerCase().includes(qLower)) ||
          (q.answer?.text && q.answer.text.toLowerCase().includes(qLower))
        );
      });
    }

    // Newest first for history
    return result.sort((a, b) => {
      const dateA = a.answer?.answered || a.asked;
      const dateB = b.answer?.answered || b.asked;
      if (dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }
      return b.id.localeCompare(a.id);
    });
  }, [historyQuestions, historyStatusFilter, historySearch]);

  const toggleContext = (id: string) => {
    setExpandedContext((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSelectChoice = (questionId: string, choice: string) => {
    setSelectedChoices((prev) => ({ ...prev, [questionId]: choice }));
  };

  const handleTextChange = (questionId: string, text: string) => {
    setAnswerTexts((prev) => ({ ...prev, [questionId]: text }));
  };

  const handleOpenAnswerSubmit = (q: QuestionItem) => {
    const choice = selectedChoices[q.id];
    if (!choice) return;

    const text = answerTexts[q.id] || '';
    if (choice === 'open' && !text.trim()) {
      return;
    }

    let choiceTitle = choice;
    if (choice === 'open') {
      choiceTitle = 'Open answer';
    } else if (q.options) {
      const opt = q.options.find((o) => o.label === choice);
      if (opt) {
        choiceTitle = `${opt.label} — ${opt.title}${opt.consequence ? `: ${opt.consequence}` : ''}`;
      }
    }

    setConfirmingAnswer({
      question: q,
      choice,
      choiceTitle,
      text: text.trim() ? text : undefined,
    });
  };

  const executeAnswer = async () => {
    if (!confirmingAnswer) return;
    const { question, choice, text } = confirmingAnswer;

    await api.answerQuestion(question.id, {
      choice,
      text,
      by: 'owner',
    });

    setConfirmingAnswer(null);
    await loadQuestions();
    onRefresh?.();
  };

  const executeApply = async () => {
    if (!applyingQuestion) return;
    setApplyingQuestion((prev) => (prev ? { ...prev, loading: true, error: undefined } : null));
    try {
      const res = await api.applyQuestion(applyingQuestion.question.id, {
        ref: applyingQuestion.ref,
        by: applyingQuestion.by || 'owner',
        note: applyingQuestion.note,
      });
      if (res && res.ok) {
        setApplyingQuestion(null);
        await loadQuestions();
        onRefresh?.();
      } else {
        setApplyingQuestion((prev) =>
          prev ? { ...prev, loading: false, error: res?.error || 'Failed to apply decision' } : null
        );
      }
    } catch (e: any) {
      setApplyingQuestion((prev) =>
        prev ? { ...prev, loading: false, error: e.message || String(e) } : null
      );
    }
  };

  const handleAnswerAndResumeClick = async (q: QuestionItem) => {
    const choice = selectedChoices[q.id];
    if (!choice) return;

    const text = answerTexts[q.id] || '';
    if (choice === 'open' && !text.trim()) {
      return;
    }

    let choiceTitle = choice;
    if (choice === 'open') {
      choiceTitle = 'Open answer';
    } else if (q.options) {
      const opt = q.options.find((o) => o.label === choice);
      if (opt) {
        choiceTitle = `${opt.label} — ${opt.title}${opt.consequence ? `: ${opt.consequence}` : ''}`;
      }
    }

    setResumeLoading(q.id);
    setResumeError(null);
    try {
      const preview = await (api as any).previewAnswerAndResume(q.id, {
        choice,
        text: text.trim() ? text : undefined,
      });
      if (!preview.ok) {
        setResumeError(preview.error || 'Failed to preview run continuation');
        return;
      }
      setConfirmingAnswerAndResume({
        question: q,
        choice,
        choiceTitle,
        text: text.trim() ? text : undefined,
        preview,
      });
    } catch (err: any) {
      setResumeError(err.message || 'Error previewing run continuation');
    } finally {
      setResumeLoading(null);
    }
  };

  const executeAnswerAndResume = async () => {
    if (!confirmingAnswerAndResume) return;
    const { question, choice, text, preview } = confirmingAnswerAndResume;
    try {
      await (api as any).answerAndResume(question.id, {
        choice,
        text,
        expect_plan_hash: preview.plan_hash,
        by: 'owner',
      });
      setConfirmingAnswerAndResume(null);
      await loadQuestions();
      onRefresh?.();
    } catch (err: any) {
      setResumeError(err.message || 'Failed to answer and resume run');
    }
  };

  const executeWithdraw = async () => {
    if (!withdrawingQuestion || !withdrawingQuestion.reason.trim()) return;

    await api.withdrawQuestion(withdrawingQuestion.question.id, {
      reason: withdrawingQuestion.reason.trim(),
      by: 'owner',
    });
    setWithdrawingQuestion(null);
    await loadQuestions();
    onRefresh?.();
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      {/* Tab Header with Sub-tabs and live status */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          borderBottom: '1px solid #334155',
          paddingBottom: '1rem',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '1.4rem',
              fontWeight: 700,
              color: '#f8fafc',
              margin: '0 0 0.35rem 0',
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
            }}
          >
            <HelpCircle size={24} color="#818cf8" />
            <span>Decisions Waiting</span>
          </h1>
          <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8' }}>
            Review, answer, or withdraw blocking questions halting autonomous agent execution.
          </p>
        </div>

        {/* Sub-tab pills */}
        <div
          style={{
            display: 'flex',
            backgroundColor: '#1e293b',
            borderRadius: '0.5rem',
            padding: '0.25rem',
            border: '1px solid #334155',
          }}
        >
          <button
            onClick={() => setSubTab('open')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.4rem 0.9rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: subTab === 'open' ? '#4f46e5' : 'transparent',
              color: subTab === 'open' ? '#fff' : '#94a3b8',
              fontSize: '0.85rem',
              fontWeight: 600,
            }}
          >
            <span>Open Decisions</span>
            {openQuestions.length > 0 && (
              <span
                style={{
                  backgroundColor: subTab === 'open' ? '#ef4444' : '#334155',
                  color: '#fff',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  padding: '0.1rem 0.4rem',
                  borderRadius: '1rem',
                  lineHeight: 1,
                }}
              >
                {openQuestions.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setSubTab('awaiting')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.4rem 0.9rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: subTab === 'awaiting' ? '#4f46e5' : 'transparent',
              color: subTab === 'awaiting' ? '#fff' : '#94a3b8',
              fontSize: '0.85rem',
              fontWeight: 600,
            }}
          >
            <span>Awaiting Application</span>
            {awaitingQuestions.length > 0 && (
              <span
                style={{
                  backgroundColor: subTab === 'awaiting' ? '#f59e0b' : '#334155',
                  color: '#fff',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  padding: '0.1rem 0.4rem',
                  borderRadius: '1rem',
                  lineHeight: 1,
                }}
              >
                {awaitingQuestions.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setSubTab('history')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.4rem 0.9rem',
              borderRadius: '0.375rem',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: subTab === 'history' ? '#4f46e5' : 'transparent',
              color: subTab === 'history' ? '#fff' : '#94a3b8',
              fontSize: '0.85rem',
              fontWeight: 600,
            }}
          >
            <span>History</span>
            <span
              style={{
                backgroundColor: '#334155',
                color: '#cbd5e1',
                fontSize: '0.7rem',
                fontWeight: 600,
                padding: '0.1rem 0.4rem',
                borderRadius: '1rem',
                lineHeight: 1,
              }}
            >
              {historyQuestions.length}
            </span>
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div
          style={{
            padding: '1rem',
            borderRadius: '0.5rem',
            backgroundColor: '#451a1a',
            border: '1px solid #ef4444',
            color: '#fca5a5',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={18} color="#ef4444" />
            <span>{error}</span>
          </div>
          <button
            onClick={loadQuestions}
            style={{
              padding: '0.3rem 0.7rem',
              borderRadius: '0.25rem',
              border: 'none',
              backgroundColor: '#ef4444',
              color: '#fff',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Resume Error Banner */}
      {resumeError && (
        <div
          style={{
            padding: '0.75rem 1rem',
            borderRadius: '0.5rem',
            backgroundColor: '#451a1a',
            border: '1px solid #ef4444',
            color: '#fca5a5',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={18} color="#ef4444" />
            <span>{resumeError}</span>
          </div>
          <button
            onClick={() => setResumeError(null)}
            style={{
              padding: '0.2rem 0.5rem',
              borderRadius: '0.25rem',
              border: 'none',
              backgroundColor: '#ef4444',
              color: '#fff',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && questions.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.6rem',
            padding: '3rem',
            color: '#94a3b8',
          }}
        >
          <Loader2 size={22} className="spin" color="#818cf8" />
          <span>Loading questions...</span>
        </div>
      )}

      {/* OPEN QUESTIONS TAB */}
      {subTab === 'open' && !loading && (
        <div>
          {openQuestions.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '4rem 1.5rem',
                backgroundColor: '#1e293b',
                borderRadius: '0.75rem',
                border: '1px solid #334155',
                color: '#94a3b8',
              }}
            >
              <CheckCircle2 size={40} color="#10b981" style={{ margin: '0 auto 1rem' }} />
              <h3 style={{ fontSize: '1.15rem', color: '#f8fafc', margin: '0 0 0.5rem 0' }}>
                No Pending Decisions
              </h3>
              <p style={{ margin: 0, fontSize: '0.85rem' }}>
                There are currently no blocking questions waiting for owner decision. All tasks can proceed.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              {groupedOpenQuestions.map((group) => (
                <div key={group.key}>
                  {/* Group Header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      marginBottom: '0.85rem',
                      paddingBottom: '0.4rem',
                      borderBottom: '1px solid #334155',
                    }}
                  >
                    <Layers size={18} color="#818cf8" />
                    <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#f1f5f9', margin: 0 }}>
                      {group.label}
                    </h2>
                    {group.task && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '0.15rem 0.4rem',
                          borderRadius: '0.25rem',
                          backgroundColor:
                            group.task.priority === 'P0'
                              ? '#ef4444'
                              : group.task.priority === 'P1'
                              ? '#f59e0b'
                              : '#64748b',
                          color: '#fff',
                        }}
                      >
                        {group.task.priority}
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: '0.75rem',
                        color: '#94a3b8',
                        marginLeft: 'auto',
                      }}
                    >
                      {group.questions.length} question{group.questions.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  {/* Question Cards within group */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    {group.questions.map((q) => {
                      const isContextOpen = !!expandedContext[q.id];
                      const selectedChoice = selectedChoices[q.id];
                      const currentText = answerTexts[q.id] || '';
                      const isOpenAnswer = q.open_answer === 'yes';
                      const hasOriginRun = Boolean(q.origin_run && q.origin_run.trim() !== '-');
                      const canSubmit =
                        !!selectedChoice && (selectedChoice !== 'open' || currentText.trim().length > 0);

                      return (
                        <div
                          key={q.id}
                          style={{
                            backgroundColor: '#1e293b',
                            borderRadius: '0.75rem',
                            border: '1px solid #334155',
                            padding: '1.25rem 1.5rem',
                            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.2)',
                          }}
                        >
                          {/* Card Header: Key, Asked-By, Age, Blocks */}
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'flex-start',
                              marginBottom: '0.75rem',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <span
                          style={{
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            color: '#818cf8',
                            backgroundColor: '#0f172a',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '0.375rem',
                            border: '1px solid #334155',
                            fontFamily: 'monospace',
                          }}
                        >
                          {q.id}
                        </span>
                                <span
                                  style={{
                                    fontSize: '0.8rem',
                                    color: '#94a3b8',
                                    fontWeight: 500,
                                    maxWidth: '220px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                  title={q.question}
                                >
                                  ({shortTitle(q)})
                                </span>

                              <span
                                style={{
                                  fontSize: '0.75rem',
                                  padding: '0.15rem 0.45rem',
                                  borderRadius: '1rem',
                                  backgroundColor: '#3b2505',
                                  color: '#f59e0b',
                                  border: '1px solid #b45309',
                                  fontWeight: 600,
                                }}
                              >
                                Open
                              </span>

                              {hasOriginRun && (
                                <span
                                  style={{
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.45rem',
                                    borderRadius: '0.25rem',
                                    backgroundColor: '#1e1b4b',
                                    color: '#a5b4fc',
                                    border: '1px solid #4338ca',
                                    fontFamily: 'monospace',
                                  }}
                                  title={`Origin Run: ${q.origin_run}`}
                                >
                                  Run: {q.origin_run}
                                </span>
                              )}
                            </div>

                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '1rem',
                                fontSize: '0.8rem',
                                color: '#94a3b8',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                <User size={14} />
                                <span>{q.asked_by}</span>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                <Clock size={14} />
                                <span title={q.asked}>{formatAge(q.asked)}</span>
                              </div>
                            </div>
                          </div>

                          {/* Short Question Text */}
                          <h3
                            style={{
                              fontSize: '1.15rem',
                              fontWeight: 600,
                              color: '#f8fafc',
                              margin: '0 0 0.75rem 0',
                              lineHeight: 1.4,
                            }}
                          >
                            {q.question}
                          </h3>

                          {/* Blocked Tasks metadata row */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.5rem',
                              fontSize: '0.8rem',
                              color: '#cbd5e1',
                              marginBottom: '1rem',
                            }}
                          >
                            <span style={{ color: '#64748b', fontWeight: 600 }}>Blocked Tasks:</span>
                            {renderBlockedTasks(q.blocks)}
                          </div>

                          {/* Collapsible Context */}
                          {q.context && (
                            <div
                              style={{
                                marginBottom: '1.25rem',
                                backgroundColor: '#0f172a',
                                borderRadius: '0.5rem',
                                border: '1px solid #334155',
                                overflow: 'hidden',
                              }}
                            >
                              <button
                                onClick={() => toggleContext(q.id)}
                                style={{
                                  width: '100%',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  padding: '0.6rem 0.85rem',
                                  background: 'none',
                                  border: 'none',
                                  color: '#cbd5e1',
                                  fontSize: '0.8rem',
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <FileText size={15} color="#818cf8" />
                                  <span>Context & Background</span>
                                </div>
                                {isContextOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                              </button>

                              {isContextOpen && (
                                <div
                                  style={{
                                    padding: '0.85rem 1rem',
                                    borderTop: '1px solid #334155',
                                    fontSize: '0.85rem',
                                    color: '#cbd5e1',
                                    lineHeight: 1.6,
                                  }}
                                >
                                  <SafeMarkdown content={q.context} />
                                </div>
                              )}
                            </div>
                          )}

                          {/* Options Section */}
                          <div
                            style={{
                              backgroundColor: '#0f172a',
                              borderRadius: '0.5rem',
                              border: '1px solid #334155',
                              padding: '1rem',
                              marginBottom: '1.25rem',
                            }}
                          >
                            <div
                              style={{
                                fontSize: '0.8rem',
                                fontWeight: 700,
                                color: '#94a3b8',
                                textTransform: 'uppercase',
                                marginBottom: '0.75rem',
                              }}
                            >
                              Answer Options
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                              {q.options &&
                                q.options.map((opt) => {
                                  const isSelected = selectedChoice === opt.label;
                                  const isRecommended = q.recommended === opt.label;

                                  return (
                                    <label
                                      key={opt.label}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: '0.65rem',
                                        padding: '0.6rem 0.75rem',
                                        borderRadius: '0.375rem',
                                        backgroundColor: isSelected ? '#1e293b' : 'transparent',
                                        border: `1px solid ${isSelected ? '#6366f1' : '#334155'}`,
                                        cursor: 'pointer',
                                        transition: 'border-color 0.15s ease',
                                      }}
                                    >
                                      <input
                                        type="radio"
                                        name={`question-${q.id}`}
                                        value={opt.label}
                                        checked={isSelected}
                                        onChange={() => handleSelectChoice(q.id, opt.label)}
                                        style={{ marginTop: '0.2rem', cursor: 'pointer' }}
                                      />
                                      <div style={{ flex: 1, fontSize: '0.85rem', lineHeight: 1.4 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                                          <strong style={{ color: '#818cf8', fontFamily: 'monospace' }}>
                                            {opt.label}
                                          </strong>
                                          <span style={{ color: '#f8fafc', fontWeight: 600 }}>
                                            {opt.title}
                                          </span>
                                          {isRecommended && (
                                            <span
                                              style={{
                                                backgroundColor: '#064e3b',
                                                color: '#34d399',
                                                border: '1px solid #059669',
                                                fontSize: '0.7rem',
                                                fontWeight: 700,
                                                padding: '0.1rem 0.4rem',
                                                borderRadius: '0.25rem',
                                                marginLeft: '0.3rem',
                                              }}
                                            >
                                              Recommended
                                            </span>
                                          )}
                                        </div>
                                        {opt.consequence && (
                                          <div style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                                            {opt.consequence}
                                          </div>
                                        )}
                                      </div>
                                    </label>
                                  );
                                })}

                              {/* Open Answer Option when open-answer: yes */}
                              {isOpenAnswer && (
                                <label
                                  style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: '0.65rem',
                                    padding: '0.6rem 0.75rem',
                                    borderRadius: '0.375rem',
                                    backgroundColor: selectedChoice === 'open' ? '#1e293b' : 'transparent',
                                    border: `1px solid ${selectedChoice === 'open' ? '#6366f1' : '#334155'}`,
                                    cursor: 'pointer',
                                  }}
                                >
                                  <input
                                    type="radio"
                                    name={`question-${q.id}`}
                                    value="open"
                                    checked={selectedChoice === 'open'}
                                    onChange={() => handleSelectChoice(q.id, 'open')}
                                    style={{ marginTop: '0.2rem', cursor: 'pointer' }}
                                  />
                                  <div style={{ flex: 1, fontSize: '0.85rem' }}>
                                    <strong style={{ color: '#e2e8f0' }}>Other / open answer</strong>
                                    <div style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: '0.15rem' }}>
                                      Provide a custom answer or direction in the text box below.
                                    </div>
                                  </div>
                                </label>
                              )}
                            </div>

                            {/* Textarea for open-answer */}
                            {isOpenAnswer && (
                              <div style={{ marginTop: '1rem' }}>
                                <div
                                  style={{
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    color: selectedChoice === 'open' ? '#f59e0b' : '#64748b',
                                    marginBottom: '0.35rem',
                                  }}
                                >
                                  {selectedChoice === 'open'
                                    ? 'Open Answer Text (Required for "Other / open answer"):'
                                    : 'Optional Notes / Elaboration:'}
                                </div>
                                <textarea
                                  value={currentText}
                                  onChange={(e) => handleTextChange(q.id, e.target.value)}
                                  placeholder={
                                    selectedChoice === 'open'
                                      ? 'Type your custom decision or instruction here (required)...'
                                      : 'Add optional context, caveats, or elaboration for your choice...'
                                  }
                                  rows={3}
                                  style={{
                                    width: '100%',
                                    padding: '0.5rem 0.75rem',
                                    backgroundColor: '#1e293b',
                                    border: `1px solid ${
                                      selectedChoice === 'open' && !currentText.trim() ? '#b45309' : '#334155'
                                    }`,
                                    borderRadius: '0.375rem',
                                    color: '#f8fafc',
                                    fontSize: '0.85rem',
                                    lineHeight: 1.4,
                                    resize: 'vertical',
                                  }}
                                />
                              </div>
                            )}
                          </div>

                          {/* Card Actions Footer: Submit & Withdraw */}
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              paddingTop: '0.5rem',
                              borderTop: '1px solid #334155',
                            }}
                          >
                            <button
                              onClick={() => setWithdrawingQuestion({ question: q, reason: '' })}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                                padding: '0.4rem 0.8rem',
                                borderRadius: '0.375rem',
                                border: '1px solid #ef4444',
                                backgroundColor: 'transparent',
                                color: '#f87171',
                                fontSize: '0.8rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              <RotateCcw size={14} />
                              <span>Withdraw Question…</span>
                            </button>

                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                              {hasOriginRun && (
                                <button
                                  onClick={() => handleAnswerAndResumeClick(q)}
                                  disabled={!canSubmit || resumeLoading === q.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.4rem',
                                    padding: '0.45rem 1rem',
                                    borderRadius: '0.375rem',
                                    border: '1px solid #6366f1',
                                    backgroundColor: canSubmit && resumeLoading !== q.id ? '#312e81' : '#1e1b4b',
                                    color: canSubmit && resumeLoading !== q.id ? '#c7d2fe' : '#475569',
                                    fontSize: '0.85rem',
                                    fontWeight: 600,
                                    cursor: canSubmit && resumeLoading !== q.id ? 'pointer' : 'not-allowed',
                                    boxShadow: canSubmit ? '0 4px 6px -1px rgba(99, 102, 241, 0.25)' : 'none',
                                  }}
                                >
                                  {resumeLoading === q.id ? (
                                    <Loader2 size={14} className="spin" />
                                  ) : (
                                    <Play size={14} />
                                  )}
                                  <span>Answer and resume run</span>
                                </button>
                              )}

                              <button
                                onClick={() => handleOpenAnswerSubmit(q)}
                                disabled={!canSubmit}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.4rem',
                                  padding: '0.45rem 1rem',
                                  borderRadius: '0.375rem',
                                  border: 'none',
                                  backgroundColor: canSubmit ? '#4f46e5' : '#334155',
                                  color: canSubmit ? '#fff' : '#64748b',
                                  fontSize: '0.85rem',
                                  fontWeight: 600,
                                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                                  boxShadow: canSubmit ? '0 4px 6px -1px rgba(79, 70, 229, 0.3)' : 'none',
                                }}
                              >
                                <Send size={14} />
                                <span>Answer</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* AWAITING APPLICATION TAB (Spec 12 §3, E11) */}
      {subTab === 'awaiting' && !loading && (
        <div>
          <div
            style={{
              padding: '1rem',
              backgroundColor: '#1e293b',
              borderRadius: '0.5rem',
              border: '1px solid #334155',
              marginBottom: '1.5rem',
            }}
          >
            <h3 style={{ margin: '0 0 0.4rem 0', fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc' }}>
              Answered Decisions Awaiting Application (Spec §3, E11)
            </h3>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.5 }}>
              These questions have been answered by the decider, but the decision has not yet been applied into the codebase or task tree via <code>questions apply</code>. The owner sees when an answer has been acted upon, ensuring no decision is silently forgotten.
            </p>
          </div>

          {awaitingQuestions.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '3rem',
                backgroundColor: '#1e293b',
                borderRadius: '0.5rem',
                border: '1px dashed #334155',
                color: '#64748b',
              }}
            >
              <CheckCircle2 size={32} color="#10b981" style={{ marginBottom: '0.5rem' }} />
              <div style={{ fontSize: '0.95rem', color: '#e2e8f0', fontWeight: 600 }}>All decisions applied</div>
              <div style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                There are no answered questions pending application.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {awaitingQuestions.map((q) => {
                const blockedTaskId = q.blocks && q.blocks.trim() !== '-' ? q.blocks : null;

                return (
                  <div
                    key={q.id}
                    style={{
                      backgroundColor: '#1e293b',
                      borderRadius: '0.5rem',
                      border: '1px solid #f59e0b50',
                      padding: '1.25rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <span
                          style={{
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            color: '#818cf8',
                            backgroundColor: '#0f172a',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '0.375rem',
                            border: '1px solid #334155',
                            fontFamily: 'monospace',
                          }}
                        >
                          {q.id}
                        </span>
                        <span
                          style={{
                            fontSize: '0.8rem',
                            color: '#94a3b8',
                            fontWeight: 500,
                            maxWidth: '220px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={q.question}
                        >
                          ({shortTitle(q)})
                        </span>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.15rem 0.5rem',
                            borderRadius: '1rem',
                            backgroundColor: '#78350f40',
                            color: '#fbbf24',
                            border: '1px solid #f59e0b',
                            fontWeight: 600,
                          }}
                        >
                          Answered, awaiting application
                        </span>
                        {blockedTaskId && (
                          <span
                            style={{
                              fontSize: '0.75rem',
                              padding: '0.15rem 0.45rem',
                              borderRadius: '0.25rem',
                              backgroundColor: '#0f172a',
                              color: '#94a3b8',
                              border: '1px solid #334155',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.3rem',
                            }}
                          >
                            <span>Blocks:</span>
                            {renderBlockedTasks(blockedTaskId)}
                          </span>
                        )}
                      </div>

                      <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                        Asked by {q.asked_by} ({q.asked})
                      </div>
                    </div>

                    <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: '#f8fafc' }}>
                      {q.question}
                    </h3>

                    <div
                      style={{
                        backgroundColor: '#0f172a',
                        borderRadius: '0.375rem',
                        border: '1px solid #334155',
                        padding: '0.85rem 1rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.4rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                          Selected Choice: <strong style={{ color: '#34d399' }}>{q.answer?.choice || 'open'}</strong>
                        </div>
                        {q.answer?.by && (
                          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                            Answered by {q.answer.by} {q.answer.answered ? `(${q.answer.answered})` : ''}
                          </div>
                        )}
                      </div>

                      {q.answer?.text && (
                        <div
                          style={{
                            fontSize: '0.82rem',
                            color: '#cbd5e1',
                            whiteSpace: 'pre-wrap',
                            backgroundColor: '#1e293b40',
                            padding: '0.5rem',
                            borderRadius: '0.25rem',
                            border: '1px solid #1e293b',
                          }}
                        >
                          {q.answer.text}
                        </div>
                      )}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingTop: '0.5rem',
                        borderTop: '1px solid #334155',
                      }}
                    >
                      <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                        Record applying this answer to tasks/code (e.g. task ID, commit SHA, PR link).
                      </span>

                      <button
                        onClick={() =>
                          setApplyingQuestion({
                            question: q,
                            ref: blockedTaskId || '',
                            by: 'owner',
                            note: '',
                          })
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          backgroundColor: '#059669',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '0.375rem',
                          padding: '0.4rem 0.85rem',
                          fontSize: '0.8rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        <Check size={14} />
                        <span>Apply Decision</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* HISTORY TAB */}
      {subTab === 'history' && !loading && (
        <div>
          {/* History Filters bar */}
          <div
            style={{
              display: 'flex',
              gap: '1rem',
              alignItems: 'center',
              marginBottom: '1.5rem',
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                flex: 1,
                minWidth: '220px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                padding: '0.4rem 0.75rem',
              }}
            >
              <Search size={16} color="#94a3b8" />
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Search history by ID, question, choice, or text..."
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  width: '100%',
                  outline: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Filter size={15} color="#94a3b8" />
              <select
                value={historyStatusFilter}
                onChange={(e) => setHistoryStatusFilter(e.target.value as any)}
                style={{
                  backgroundColor: '#1e293b',
                  color: '#cbd5e1',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  padding: '0.4rem 0.75rem',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="all">All Statuses</option>
                <option value="answered">Answered Only</option>
                <option value="withdrawn">Withdrawn Only</option>
              </select>
            </div>
          </div>

          {filteredHistory.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '3rem',
                backgroundColor: '#1e293b',
                borderRadius: '0.75rem',
                border: '1px solid #334155',
                color: '#94a3b8',
              }}
            >
              No decision history matching criteria.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {filteredHistory.map((q) => {
                const isAnswered = q.status === 'answered';
                const isWithdrawn = q.status === 'withdrawn';
                const isContextOpen = !!expandedContext[q.id];

                return (
                  <div
                    key={q.id}
                    style={{
                      backgroundColor: '#1e293b',
                      borderRadius: '0.75rem',
                      border: '1px solid #334155',
                      padding: '1.25rem 1.5rem',
                    }}
                  >
                    {/* Header */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <span
                          style={{
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            color: '#818cf8',
                            backgroundColor: '#0f172a',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '0.375rem',
                            border: '1px solid #334155',
                            fontFamily: 'monospace',
                          }}
                        >
                          {q.id}
                        </span>

                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.15rem 0.45rem',
                            borderRadius: '1rem',
                            backgroundColor: isAnswered ? '#064e3b' : '#451a1a',
                            color: isAnswered ? '#34d399' : '#fca5a5',
                            border: `1px solid ${isAnswered ? '#059669' : '#b91c1c'}`,
                            fontWeight: 600,
                            textTransform: 'capitalize',
                          }}
                        >
                          {q.status}
                        </span>

                        {q.applied && (
                          <span
                            style={{
                              fontSize: '0.72rem',
                              padding: '0.15rem 0.5rem',
                              borderRadius: '1rem',
                              backgroundColor: '#1e1b4b',
                              color: '#a5b4fc',
                              border: '1px solid #4f46e5',
                              fontWeight: 600,
                            }}
                            title={
                              q.applied_record
                                ? `Applied by ${q.applied_record.by || 'owner'} at ${q.applied_record.at || '-'} (ref: ${q.applied_record.ref || '-'})`
                                : 'Applied'
                            }
                          >
                            ✓ Applied {q.applied_record?.ref ? `(${q.applied_record.ref})` : ''}
                          </span>
                        )}
                      </div>

                      <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                        Asked {q.asked} by {q.asked_by}
                      </div>
                    </div>

                    {/* Question Title */}
                    <h3
                      style={{
                        fontSize: '1.05rem',
                        fontWeight: 600,
                        color: '#f8fafc',
                        margin: '0 0 0.5rem 0',
                      }}
                    >
                      {q.question}
                    </h3>

                    {/* Blocked tasks */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.8rem',
                        color: '#94a3b8',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <span>Blocked Tasks:</span>
                      {renderBlockedTasks(q.blocks)}
                    </div>

                    {/* Collapsible Context */}
                    {q.context && (
                      <div
                        style={{
                          marginBottom: '1rem',
                          backgroundColor: '#0f172a',
                          borderRadius: '0.375rem',
                          border: '1px solid #334155',
                        }}
                      >
                        <button
                          onClick={() => toggleContext(q.id)}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0.5rem 0.75rem',
                            background: 'none',
                            border: 'none',
                            color: '#cbd5e1',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          <span>Context</span>
                          {isContextOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {isContextOpen && (
                          <div
                            style={{
                              padding: '0.75rem',
                              borderTop: '1px solid #334155',
                              fontSize: '0.82rem',
                              color: '#cbd5e1',
                            }}
                          >
                            <SafeMarkdown content={q.context} />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Answer / Outcome Box */}
                    <div
                      style={{
                        backgroundColor: '#0f172a',
                        borderRadius: '0.5rem',
                        border: `1px solid ${isAnswered ? '#065f46' : '#7f1d1d'}`,
                        padding: '1rem',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '0.5rem',
                          borderBottom: '1px solid #1e293b',
                          paddingBottom: '0.5rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          {isAnswered ? (
                            <Check size={16} color="#34d399" />
                          ) : (
                            <RotateCcw size={16} color="#f87171" />
                          )}
                          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f8fafc' }}>
                            {isAnswered ? 'Decision Answer' : 'Withdrawal Details'}
                          </span>
                        </div>

                        <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                          {q.answer?.answered_by && q.answer.answered_by !== '-'
                            ? `By ${q.answer.answered_by} on ${q.answer.answered}`
                            : `On ${q.answer?.answered || q.asked}`}
                        </div>
                      </div>

                      <div style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
                        {isAnswered && (
                          <div style={{ marginBottom: q.answer?.text ? '0.5rem' : '0' }}>
                            <span style={{ color: '#94a3b8' }}>Selected Choice: </span>
                            <span
                              style={{
                                fontWeight: 700,
                                color: '#38bdf8',
                                backgroundColor: '#1e293b',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '0.25rem',
                                border: '1px solid #334155',
                                fontFamily: 'monospace',
                              }}
                            >
                              {q.answer?.choice}
                            </span>
                          </div>
                        )}

                        {isWithdrawn && (
                          <div style={{ marginBottom: q.answer?.text ? '0.5rem' : '0' }}>
                            <span style={{ color: '#f87171', fontWeight: 600 }}>Reason: </span>
                          </div>
                        )}

                        {q.answer?.text && q.answer.text !== '-' && (
                          <div
                            style={{
                              backgroundColor: '#1e293b',
                              borderRadius: '0.375rem',
                              padding: '0.75rem',
                              border: '1px solid #334155',
                              marginTop: '0.4rem',
                            }}
                          >
                            <SafeMarkdown content={q.answer.text} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* CONFIRM DIALOG FOR ANSWERING */}
      {confirmingAnswer && (
        <ConfirmDialog
          isOpen={true}
          title={`Confirm Answer for ${confirmingAnswer.question.id}`}
          summary={buildAnswerSummary(
            confirmingAnswer.question,
            confirmingAnswer.choice,
            confirmingAnswer.text,
            questions
          )}
          applyButtonText="Confirm & Answer"
          cancelButtonText="Back"
          onApply={executeAnswer}
          onCancel={() => setConfirmingAnswer(null)}
        />
      )}

      {/* CONFIRM DIALOG FOR ANSWERING AND RESUMING RUN */}
      {confirmingAnswerAndResume && (
        <ConfirmDialog
          isOpen={true}
          title={`Confirm Answer & Resume Run for ${confirmingAnswerAndResume.question.id}`}
          summary={buildAnswerAndResumeSummary(
            confirmingAnswerAndResume.question,
            confirmingAnswerAndResume.choice,
            confirmingAnswerAndResume.text,
            confirmingAnswerAndResume.preview,
            questions
          )}
          applyButtonText="Confirm & Resume Run"
          cancelButtonText="Back"
          onApply={executeAnswerAndResume}
          onCancel={() => setConfirmingAnswerAndResume(null)}
        />
      )}

      {/* CONFIRM DIALOG FOR WITHDRAWING */}
      {withdrawingQuestion && (
        <ConfirmDialog
          isOpen={true}
          title={`Confirm Withdrawal for ${withdrawingQuestion.question.id}`}
          summary={buildWithdrawSummary(
            withdrawingQuestion.question,
            withdrawingQuestion.reason,
            questions
          )}
          applyButtonText="Confirm Withdraw"
          cancelButtonText="Cancel"
          danger={true}
          isApplyDisabled={!withdrawingQuestion.reason.trim()}
          onApply={executeWithdraw}
          onCancel={() => setWithdrawingQuestion(null)}
        >
          <div style={{ marginTop: '0.5rem' }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#fca5a5',
                marginBottom: '0.4rem',
              }}
            >
              Withdrawal Reason (Required):
            </label>
            <textarea
              value={withdrawingQuestion.reason}
              onChange={(e) =>
                setWithdrawingQuestion((prev) =>
                  prev ? { ...prev, reason: e.target.value } : null
                )
              }
              placeholder="Explain why this question is being withdrawn (e.g. requirement changed, obsolete, decided out-of-band)..."
              rows={3}
              style={{
                width: '100%',
                padding: '0.6rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #ef4444',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
                lineHeight: 1.4,
                resize: 'vertical',
                outline: 'none',
              }}
            />
          </div>
        </ConfirmDialog>
      )}

      {/* CONFIRM / APPLY DECISION MODAL */}
      {applyingQuestion && (
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
        >
          <div
            style={{
              backgroundColor: '#1e293b',
              borderRadius: '0.5rem',
              border: '1px solid #334155',
              padding: '1.5rem',
              maxWidth: '520px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle2 size={20} color="#10b981" />
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
                  Apply Decision: {applyingQuestion.question.id}
                </h3>
              </div>
              <button
                onClick={() => setApplyingQuestion(null)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8' }}>
              Record that the choice &ldquo;<strong>{applyingQuestion.question.answer?.choice}</strong>&rdquo; has been applied into the codebase or task tree. This writes to the application ledger and emits <code>question.applied</code>.
            </p>

            {applyingQuestion.error && (
              <div
                style={{
                  padding: '0.6rem 0.8rem',
                  backgroundColor: '#ef444415',
                  border: '1px solid #ef444450',
                  borderRadius: '0.375rem',
                  color: '#fca5a5',
                  fontSize: '0.8rem',
                }}
              >
                {applyingQuestion.error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                  Applied Reference (--ref)
                </label>
                <input
                  type="text"
                  placeholder="e.g. T002, commit SHA, PR link, or summary"
                  value={applyingQuestion.ref}
                  onChange={(e) =>
                    setApplyingQuestion((prev) => (prev ? { ...prev, ref: e.target.value } : null))
                  }
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '0.375rem',
                    padding: '0.45rem 0.75rem',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                  Applied By (--by)
                </label>
                <input
                  type="text"
                  value={applyingQuestion.by}
                  onChange={(e) =>
                    setApplyingQuestion((prev) => (prev ? { ...prev, by: e.target.value } : null))
                  }
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '0.375rem',
                    padding: '0.45rem 0.75rem',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                  Note / Explanation (--note, optional)
                </label>
                <input
                  type="text"
                  placeholder="Optional details about how the decision was carried out"
                  value={applyingQuestion.note}
                  onChange={(e) =>
                    setApplyingQuestion((prev) => (prev ? { ...prev, note: e.target.value } : null))
                  }
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '0.375rem',
                    padding: '0.45rem 0.75rem',
                    color: '#f8fafc',
                    fontSize: '0.85rem',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button
                onClick={() => setApplyingQuestion(null)}
                disabled={applyingQuestion.loading}
                style={{
                  padding: '0.45rem 0.9rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #334155',
                  backgroundColor: '#0f172a',
                  color: '#cbd5e1',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={executeApply}
                disabled={applyingQuestion.loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.45rem 1rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: '#059669',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: applyingQuestion.loading ? 'not-allowed' : 'pointer',
                }}
              >
                <Check size={14} />
                <span>{applyingQuestion.loading ? 'Applying...' : 'Record as Applied'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
