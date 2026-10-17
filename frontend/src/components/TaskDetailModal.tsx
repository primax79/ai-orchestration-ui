import React, { useState, useEffect } from 'react';
import {
  X,
  CheckCircle,
  RotateCcw,
  Play,
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
} from 'lucide-react';
import { TaskItem, QuestionItem, AskQuestionPayload } from '../types';
import { api } from '../api';
import { SafeMarkdown } from './SafeMarkdown';

interface TaskDetailModalProps {
  task: TaskItem;
  onClose: () => void;
  onActionComplete: () => void;
  onIndexOutOfSync?: () => void;
  onRequestSyncIndex?: () => void;
}

export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  task,
  onClose,
  onActionComplete,
  onIndexOutOfSync,
  onRequestSyncIndex,
}) => {
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [bounceReason, setBounceReason] = useState('');
  const [showBounceInput, setShowBounceInput] = useState(false);
  const [copiedHandoff, setCopiedHandoff] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [indexOutOfSync, setIndexOutOfSync] = useState(false);

  // Questions section state
  const [taskQuestions, setTaskQuestions] = useState<QuestionItem[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);

  // Ask question form state
  const [showAskForm, setShowAskForm] = useState(false);
  const [askQuestionText, setAskQuestionText] = useState('');
  const [askContextText, setAskContextText] = useState('');
  const [askOptions, setAskOptions] = useState<Array<{ title: string; consequence: string }>>([
    { title: '', consequence: '' },
    { title: '', consequence: '' },
  ]);
  const [askRecommended, setAskRecommended] = useState<string>('-');
  const [askOpenAnswer, setAskOpenAnswer] = useState<boolean>(true);
  const [askSubmitting, setAskSubmitting] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    loadDetail();
    loadQuestions();
  }, [task.id]);

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
      setAskContextText('');
      setAskOptions([
        { title: '', consequence: '' },
        { title: '', consequence: '' },
      ]);
      setAskRecommended('-');
      setAskOpenAnswer(true);
      await loadQuestions();
      await loadDetail();
      onActionComplete();
    } catch (err: any) {
      setAskError(err?.message || String(err));
    } finally {
      setAskSubmitting(false);
    }
  };

  const loadDetail = async () => {
    try {
      const data = await api.getTaskDetail(task.id);
      setDetail(data);
    } catch (e: any) {
      setTransitionError(`Failed to load task specification: ${e.message}`);
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
      onActionComplete();
      onClose();
    } catch (e: any) {
      setTransitionError(`Transition error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyHandoff = () => {
    if (task.handoff) {
      navigator.clipboard.writeText(task.handoff);
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <span style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '0.15rem 0.4rem',
                borderRadius: '0.25rem',
                backgroundColor: task.priority === 'P0' ? '#ef4444' : task.priority === 'P1' ? '#f59e0b' : '#64748b',
                color: '#fff',
              }}>
                {task.priority}
              </span>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#818cf8' }}>{task.id}</span>
              <span style={{
                fontSize: '0.75rem',
                padding: '0.15rem 0.5rem',
                borderRadius: '1rem',
                backgroundColor: '#334155',
                color: '#cbd5e1',
              }}>
                {task.state}
              </span>
            </div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600, color: '#f8fafc' }}>{task.title}</h2>
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
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.executor || 'self'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Role Profile</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.profile || 'bulk-execution'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Verification Mode</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.verification_mode || 'independent-session'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Category</div>
              <div style={{ fontWeight: 500, color: '#f1f5f9' }}>{task.category}</div>
            </div>
          </div>

          {/* Handoff prompt box */}
          {task.handoff && (
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
                {task.handoff}
              </code>
            </div>
          )}

          {/* Markdown Content */}
          {detail ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                <FileText size={14} />
                <span>{detail.relative_path}</span>
              </div>
              <div style={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.5rem',
                padding: '1rem',
                fontSize: '0.85rem',
                color: '#cbd5e1',
                lineHeight: 1.6,
              }}>
                <SafeMarkdown content={detail.content} />
              </div>
            </div>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading task specification...</div>
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
            Current State: <strong style={{ color: '#cbd5e1' }}>{task.state}</strong>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {task.state === 'open' && (
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
            )}

            {task.state === 'in progress' && (
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

            {task.state === 'delivered' && (
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

            {task.state === 'verified' && (
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
          </div>
        </div>
      </div>
    </div>
  );
};
