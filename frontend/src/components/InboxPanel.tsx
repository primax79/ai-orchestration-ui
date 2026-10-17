import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Inbox,
  Plus,
  Image as ImageIcon,
  Trash2,
  X,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  RotateCcw,
  RefreshCw,
  Loader2,
  Eye,
  Edit3,
  Paperclip,
  Calendar,
  Layers,
  ArrowRight,
  Upload,
  Play,
  Check,
  ExternalLink,
  Info,
  FileDown,
  FileText,
} from 'lucide-react';
import {
  InboxNoteItem,
  InboxNoteKind,
  InboxNoteStatus,
  InboxToTaskPayload,
  RunRecord,
  TriageProposal,
  AttachmentDetail,
} from '../types';
import { api, ApiError } from '../api';
import { SafeMarkdown } from './SafeMarkdown';
import { RunDialog } from './RunDialog';
import {
  AttachmentItem,
  getAttachmentInfo,
  downloadAttachmentBlob,
} from './AttachmentComponents';
import { TextViewerModal } from './TextViewerModal';

const ALL_STATUSES: InboxNoteStatus[] = ['draft', 'ready', 'processing', 'processed', 'discarded'];
const ALL_KINDS: Array<InboxNoteKind | 'all'> = ['all', 'note', 'bug', 'feature', 'idea', 'request', 'question'];
const DEFAULT_STATUS_FILTER: InboxNoteStatus[] = ['draft', 'ready'];

function formatRelativeAge(isoString?: string): string {
  if (!isoString || isoString === '-') return '—';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  } catch {
    return isoString;
  }
}

function getKindBadgeStyle(kind?: string) {
  const k = (kind || 'note').toLowerCase();
  if (k === 'bug') {
    return {
      bg: '#451a1a',
      color: '#fca5a5',
      border: '#7f1d1d',
    };
  }
  if (k === 'feature') {
    return {
      bg: '#312e81',
      color: '#c7d2fe',
      border: '#4338ca',
    };
  }
  return {
    bg: '#1e293b',
    color: '#cbd5e1',
    border: '#334155',
  };
}

function getStatusBadgeStyle(status?: string) {
  const s = (status || 'draft').toLowerCase();
  if (s === 'draft') {
    return { bg: '#334155', color: '#cbd5e1', border: '#475569' };
  }
  if (s === 'ready') {
    return { bg: '#064e3b', color: '#6ee7b7', border: '#047857' };
  }
  if (s === 'processing') {
    return { bg: '#1e3a8a', color: '#93c5fd', border: '#1d4ed8' };
  }
  if (s === 'processed') {
    return { bg: '#14532d', color: '#86efac', border: '#16a34a' };
  }
  if (s === 'discarded') {
    return { bg: '#451a1a', color: '#fca5a5', border: '#991b1b' };
  }
  return { bg: '#1e293b', color: '#94a3b8', border: '#334155' };
}

// ---------------------------------------------------------------------------
// Thumbnail Component (fetches attachment with token, turns into blob URL)
// ---------------------------------------------------------------------------

interface AttachmentThumbnailProps {
  noteId: string;
  name: string;
  size?: number;
  canRemove?: boolean;
  onRemove?: () => void;
  onBlobLoaded?: (name: string, blobUrl: string) => void;
  details?: AttachmentDetail[];
}

const AttachmentThumbnail: React.FC<AttachmentThumbnailProps> = ({
  noteId,
  name,
  size = 56,
  canRemove = false,
  onRemove,
  onBlobLoaded,
  details,
}) => {
  const info = getAttachmentInfo(name, details);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(info.class === 'image');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (info.class !== 'image') return;
    let active = true;
    let url: string | null = null;

    if (!noteId || noteId === '-') {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(false);

    api
      .getInboxAttachment(noteId, name)
      .then((blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setLoading(false);
        if (onBlobLoaded) {
          onBlobLoaded(name, url);
        }
      })
      .catch((e) => {
        if (!active) return;
        console.error(`Failed to load attachment ${name}:`, e);
        setError(true);
        setLoading(false);
      });

    return () => {
      active = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [noteId, name, info.class]);

  if (info.class === 'text') {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '0.375rem',
          border: '1px solid #334155',
          backgroundColor: '#0f172a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        title={name}
      >
        <FileText size={Math.max(14, Math.floor(size * 0.45))} color="#818cf8" />
      </div>
    );
  }

  if (info.class === 'pdf') {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '0.375rem',
          border: '1px solid #334155',
          backgroundColor: '#0f172a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        title={name}
      >
        <FileDown size={Math.max(14, Math.floor(size * 0.45))} color="#f43f5e" />
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '0.375rem',
        overflow: 'hidden',
        border: '1px solid #334155',
        backgroundColor: '#0f172a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
      title={name}
    >
      {loading ? (
        <Loader2 size={16} className="spin" color="#818cf8" />
      ) : error || !blobUrl ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', padding: '2px' }}>
          <ImageIcon size={16} color="#64748b" />
          <span style={{ fontSize: '0.55rem', color: '#64748b', textAlign: 'center', wordBreak: 'break-all' }}>
            {name.slice(0, 8)}
          </span>
        </div>
      ) : (
        <img
          src={blobUrl}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}

      {canRemove && onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title={`Remove ${name}`}
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            backgroundColor: 'rgba(239, 68, 68, 0.85)',
            border: 'none',
            borderRadius: '50%',
            width: '18px',
            height: '18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            color: '#fff',
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Convert to Task Dialog
// ---------------------------------------------------------------------------

interface ConvertToTaskDialogProps {
  note: InboxNoteItem;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (taskId: string) => void;
}

const ConvertToTaskDialog: React.FC<ConvertToTaskDialogProps> = ({
  note,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const getDefaultCategory = (kind: string) => {
    const k = kind.toLowerCase();
    if (k === 'bug') return 'bugfix';
    if (k === 'feature' || k === 'request') return 'feature';
    return 'general';
  };

  const [title, setTitle] = useState(note.title || '');
  const [category, setCategory] = useState(getDefaultCategory(note.kind || 'note'));
  const [priority, setPriority] = useState('P2');
  const [priorityReason, setPriorityReason] = useState('');
  const [executor, setExecutor] = useState('');
  const [nextUp, setNextUp] = useState('');
  const [dependsOn, setDependsOn] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle(note.title || '');
      setCategory(getDefaultCategory(note.kind || 'note'));
      setPriority('P2');
      setPriorityReason('');
      setExecutor('');
      setNextUp('');
      setDependsOn('');
      setError(null);
    }
  }, [isOpen, note]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!category.trim()) {
      setError('Category is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload: InboxToTaskPayload = {
      title: title.trim(),
      category: category.trim(),
      priority,
      priority_reason: priorityReason.trim() || undefined,
      executor: executor.trim() || undefined,
      next_up: nextUp.trim() || undefined,
      depends_on: dependsOn.trim() || undefined,
    };

    try {
      const res = await api.inboxToTask(note.id, payload);
      if (res && res.id) {
        onSuccess(res.id);
        onClose();
      } else {
        setError('Task created but no task ID returned');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2200,
        padding: '1rem',
      }}
    >
      <div
        style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          width: '100%',
          maxWidth: '540px',
          overflow: 'hidden',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
        }}
      >
        <div
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid #334155',
            backgroundColor: '#0f172a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f8fafc', fontWeight: 600 }}>
            <Layers size={18} color="#818cf8" />
            <span>Convert Note {note.id} to Task</span>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.2rem' }}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {error && (
            <div
              style={{
                padding: '0.6rem 0.8rem',
                backgroundColor: '#451a1a',
                border: '1px solid #ef4444',
                color: '#fca5a5',
                borderRadius: '0.375rem',
                fontSize: '0.8rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
              Task Title *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
                Category *
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. bugfix, feature, general"
                required
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              >
                <option value="P0">P0 (Urgent/Blocker)</option>
                <option value="P1">P1 (High)</option>
                <option value="P2">P2 (Normal)</option>
                <option value="P3">P3 (Low)</option>
              </select>
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
              Priority Reason (optional)
            </label>
            <input
              type="text"
              value={priorityReason}
              onChange={(e) => setPriorityReason(e.target.value)}
              placeholder="Why this priority was selected"
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
                Executor (optional)
              </label>
              <input
                type="text"
                value={executor}
                onChange={(e) => setExecutor(e.target.value)}
                placeholder="e.g. kilo, claude"
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
                Next Up (optional)
              </label>
              <input
                type="text"
                value={nextUp}
                onChange={(e) => setNextUp(e.target.value)}
                placeholder="Next step hint"
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.6rem',
              marginTop: '0.5rem',
              borderTop: '1px solid #334155',
              paddingTop: '1rem',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                padding: '0.45rem 0.9rem',
                backgroundColor: 'transparent',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#cbd5e1',
                fontSize: '0.85rem',
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 1rem',
                backgroundColor: '#4f46e5',
                border: 'none',
                borderRadius: '0.375rem',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
              <span>{submitting ? 'Creating...' : 'Create Task'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Note Editor Modal
// ---------------------------------------------------------------------------

interface NoteEditorModalProps {
  note: InboxNoteItem | null; // null means new note
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const NoteEditorModal: React.FC<NoteEditorModalProps> = ({
  note: initialNote,
  isOpen,
  onClose,
  onSaved,
}) => {
  const [noteId, setNoteId] = useState<string>(initialNote?.id || '');
  const [title, setTitle] = useState<string>(initialNote?.title || '');
  const [kind, setKind] = useState<string>(initialNote?.kind || 'note');
  const [about, setAbout] = useState<string>(initialNote?.about || '');
  const [body, setBody] = useState<string>(initialNote?.body || '');
  const [status, setStatus] = useState<string>(initialNote?.status || 'draft');
  const [attachments, setAttachments] = useState<string[]>(initialNote?.attachments || []);
  const [attachmentDetails, setAttachmentDetails] = useState<AttachmentDetail[]>(initialNote?.attachment_details || []);
  const [currentHash, setCurrentHash] = useState<string | undefined>(initialNote?.bundle_sha256);
  const [viewingTextAttachment, setViewingTextAttachment] = useState<{ filename: string; size?: number } | null>(null);

  const [isPreview, setIsPreview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [createdTasks, setCreatedTasks] = useState<string[]>([]);
  const [showConvertToTask, setShowConvertToTask] = useState(false);

  // Run and Triage Proposal states
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [triageRuns, setTriageRuns] = useState<RunRecord[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRunProposal, setSelectedRunProposal] = useState<{
    runId: string;
    proposal: TriageProposal | null;
    proposal_status: string | null;
    proposal_error?: string | null;
  } | null>(null);
  const [selectedTaskIndices, setSelectedTaskIndices] = useState<Set<number>>(new Set());
  const [isAcceptingTriage, setIsAcceptingTriage] = useState(false);
  const [triageActionError, setTriageActionError] = useState<string | null>(null);
  const [triageSuccessTasks, setTriageSuccessTasks] = useState<string[]>([]);

  // Dialogs for discard and mark processed
  const [showDiscardPrompt, setShowDiscardPrompt] = useState(false);
  const [discardReason, setDiscardReason] = useState('');
  const [showResolvePrompt, setShowResolvePrompt] = useState(false);
  const [resolveProduced, setResolveProduced] = useState('');

  // Map of filename -> blobUrl for rendering attachments in Markdown preview
  const [attachmentBlobUrls, setAttachmentBlobUrls] = useState<Record<string, string>>({});

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dirty tracking for autosave
  const lastSavedValues = useRef({ title, kind, about, body });
  const isDirty =
    title !== lastSavedValues.current.title ||
    kind !== lastSavedValues.current.kind ||
    about !== lastSavedValues.current.about ||
    body !== lastSavedValues.current.body;

  // Initialize or sync when initialNote changes
  useEffect(() => {
    if (initialNote) {
      setNoteId(initialNote.id);
      setTitle(initialNote.title || '');
      setKind(initialNote.kind || 'note');
      setAbout(initialNote.about === '-' ? '' : initialNote.about || '');
      setBody(initialNote.body || '');
      setStatus(initialNote.status || 'draft');
      setAttachments(initialNote.attachments || []);
      setAttachmentDetails(initialNote.attachment_details || []);
      setCurrentHash(initialNote.bundle_sha256);
      lastSavedValues.current = {
        title: initialNote.title || '',
        kind: initialNote.kind || 'note',
        about: initialNote.about === '-' ? '' : initialNote.about || '',
        body: initialNote.body || '',
      };
    } else {
      setNoteId('');
      setTitle('');
      setKind('note');
      setAbout('');
      setBody('');
      setStatus('draft');
      setAttachments([]);
      setAttachmentDetails([]);
      setCurrentHash(undefined);
      lastSavedValues.current = { title: '', kind: 'note', about: '', body: '' };
    }
    setInlineError(null);
    setConflictError(null);
    setCreatedTasks([]);
    setTriageSuccessTasks([]);
    setTriageActionError(null);
    setIsPreview(false);
  }, [initialNote, isOpen]);

  // Load triage runs and proposals
  const loadTriageRuns = useCallback(async () => {
    if (!noteId || !noteId.startsWith('N')) return;
    try {
      setLoadingRuns(true);
      const res = await api.listRuns({ note: noteId });
      const runs = (res.runs || []).filter((r) => r.mode === 'triage' || r.note_id === noteId);
      setTriageRuns(runs);

      const pendingRun = runs.find((r) => r.proposal_status === 'pending');
      const targetRun = pendingRun || runs.find((r) => r.proposal_status === 'invalid') || (runs.length > 0 ? runs[0] : null);

      if (targetRun) {
        if (targetRun.proposal_status === 'pending') {
          try {
            const propRes = await api.getTriageProposal(targetRun.run_id);
            setSelectedRunProposal({
              runId: targetRun.run_id,
              proposal: propRes.proposal,
              proposal_status: propRes.proposal_status,
              proposal_error: propRes.proposal_error,
            });
            if (propRes.proposal?.tasks) {
              setSelectedTaskIndices(new Set(propRes.proposal.tasks.map((_, i) => i)));
            }
          } catch (e: any) {
            setSelectedRunProposal({
              runId: targetRun.run_id,
              proposal: null,
              proposal_status: targetRun.proposal_status || null,
              proposal_error: e?.message || 'Failed to load proposal',
            });
          }
        } else {
          setSelectedRunProposal({
            runId: targetRun.run_id,
            proposal: null,
            proposal_status: targetRun.proposal_status || null,
            proposal_error: targetRun.proposal_error || null,
          });
        }
      } else {
        setSelectedRunProposal(null);
      }
    } catch (err: any) {
      console.error('Failed to load triage runs for note:', err);
    } finally {
      setLoadingRuns(false);
    }
  }, [noteId]);

  useEffect(() => {
    if (isOpen && noteId && noteId.startsWith('N')) {
      loadTriageRuns();
    } else {
      setTriageRuns([]);
      setSelectedRunProposal(null);
    }
  }, [isOpen, noteId, loadTriageRuns]);

  useEffect(() => {
    if (!isOpen || !noteId || !noteId.startsWith('N')) return;
    const hasActive = triageRuns.some((r) => r.status === 'starting' || r.status === 'running');
    if (!hasActive) return;

    const interval = setInterval(() => {
      loadTriageRuns();
    }, 2000);
    return () => clearInterval(interval);
  }, [isOpen, noteId, triageRuns, loadTriageRuns]);

  useEffect(() => {
    if (!isOpen || !noteId) return;
    const unsubscribe = api.subscribeWebSocket((msg: any) => {
      if (msg?.type === 'changed') {
        const areas = msg.areas || [];
        if (areas.includes('inbox') || areas.includes('runs') || areas.includes('tasks')) {
          loadTriageRuns();
        }
      }
    });
    return () => unsubscribe();
  }, [isOpen, noteId, loadTriageRuns]);

  const handleSelectRun = async (run: RunRecord) => {
    setTriageActionError(null);
    if (run.proposal_status === 'pending') {
      try {
        const propRes = await api.getTriageProposal(run.run_id);
        setSelectedRunProposal({
          runId: run.run_id,
          proposal: propRes.proposal,
          proposal_status: propRes.proposal_status,
          proposal_error: propRes.proposal_error,
        });
        if (propRes.proposal?.tasks) {
          setSelectedTaskIndices(new Set(propRes.proposal.tasks.map((_, i) => i)));
        }
      } catch (e: any) {
        setTriageActionError(e?.message || String(e));
      }
    } else {
      setSelectedRunProposal({
        runId: run.run_id,
        proposal: null,
        proposal_status: run.proposal_status || null,
        proposal_error: run.proposal_error || null,
      });
    }
  };

  const toggleTaskAccept = (idx: number) => {
    setSelectedTaskIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const handleAcceptTriage = async () => {
    if (!selectedRunProposal || !selectedRunProposal.runId) return;
    if (selectedTaskIndices.size === 0) {
      setTriageActionError('Please select at least one proposed task to accept.');
      return;
    }

    setIsAcceptingTriage(true);
    setTriageActionError(null);
    try {
      const sortedIndices = Array.from(selectedTaskIndices).sort((a, b) => a - b);
      const res = await api.acceptTriage(selectedRunProposal.runId, {
        only: sortedIndices,
        expect_note_hash: currentHash,
      });

      if (res && res.tasks_created) {
        setTriageSuccessTasks(res.tasks_created);
        setCreatedTasks((prev) => Array.from(new Set([...prev, ...res.tasks_created])));
        await handleReloadConflict();
        await loadTriageRuns();
        onSaved();
      }
    } catch (err: any) {
      const msg = err?.data?.error || err?.message || String(err);
      if (
        err.status === 409 ||
        msg.includes('409') ||
        msg.toLowerCase().includes('hash mismatch') ||
        msg.toLowerCase().includes('changed')
      ) {
        setTriageActionError('Note has changed since triage run started (hash mismatch). Please re-process.');
      } else {
        setTriageActionError(msg);
      }
    } finally {
      setIsAcceptingTriage(false);
    }
  };

  // Insert markdown reference at cursor
  const insertMarkdownAtCursor = (markdownRef: string) => {
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = body.substring(0, start);
      const after = body.substring(end);
      const insertion = `\n${markdownRef}\n`;
      const newBody = `${before}${insertion}${after}`;
      setBody(newBody);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
        textarea.focus();
      }, 0);
    } else {
      setBody((prev) => (prev ? `${prev}\n\n${markdownRef}` : markdownRef));
    }
  };

  // Upload an image file to the note
  const handleUploadFile = async (file: File | Blob, filename?: string) => {
    setIsUploading(true);
    setInlineError(null);

    let targetId = noteId;

    try {
      // If note has no ID yet, create it first
      if (!targetId || targetId === '-') {
        const createTitle = title.trim() || 'Untitled note';
        const resAdd = await api.addInboxNote({
          title: createTitle,
          kind,
          about: about.trim() || '-',
          body,
          status: 'draft',
        });
        targetId = resAdd.id;
        setNoteId(targetId);
        setCurrentHash(resAdd.bundle_sha256);
        lastSavedValues.current = { title: createTitle, kind, about, body };
      }

      const resUpload = await api.uploadInboxAttachment(targetId, file, filename);
      if (resUpload.attachment) {
        setAttachments((prev) => {
          if (!prev.includes(resUpload.attachment)) {
            return [...prev, resUpload.attachment];
          }
          return prev;
        });
        const fname = filename || (file instanceof File ? file.name : '');
        const detectedClass = (resUpload.class as any) || (
          file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(resUpload.attachment) || /\.(png|jpe?g|gif|webp)$/i.test(fname)
            ? 'image'
            : /\.pdf$/i.test(resUpload.attachment) || /\.pdf$/i.test(fname)
            ? 'pdf'
            : 'text'
        );
        setAttachmentDetails((prev) => {
          const filtered = prev.filter((d) => d.name !== resUpload.attachment);
          return [...filtered, { name: resUpload.attachment, class: detectedClass, size: file.size }];
        });
        if (resUpload.bundle_sha256) {
          setCurrentHash(resUpload.bundle_sha256);
        }
        const isImg = detectedClass === 'image';
        const mdRef = resUpload.markdown || (isImg ? `![](attachments/${resUpload.attachment})` : `[${resUpload.attachment}](attachments/${resUpload.attachment})`);
        insertMarkdownAtCursor(mdRef);
        onSaved();
      }
    } catch (err: any) {
      setInlineError(err?.message || String(err));
    } finally {
      setIsUploading(false);
    }
  };

  // Paste handler on textarea
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    const files = e.clipboardData?.files;
    const filesToUpload: File[] = [];

    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        filesToUpload.push(files[i]);
      }
    } else if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) filesToUpload.push(file);
        }
      }
    }

    if (filesToUpload.length > 0) {
      e.preventDefault();
      for (const file of filesToUpload) {
        await handleUploadFile(file);
      }
    }
  };

  // Drag and drop onto editor
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      await handleUploadFile(files[i]);
    }
  };

  // Remove attachment with confirmation
  const handleRemoveAttachment = async (attName: string) => {
    if (!window.confirm(`Delete attachment "${attName}"?`)) return;

    try {
      const res = await api.deleteInboxAttachment(noteId, attName);
      setAttachments((prev) => prev.filter((a) => a !== attName));
      setAttachmentDetails((prev) => prev.filter((a) => a.name !== attName));
      if (res.bundle_sha256) {
        setCurrentHash(res.bundle_sha256);
      }
      onSaved();
    } catch (err: any) {
      setInlineError(err?.message || String(err));
    }
  };

  const handleDownloadPdf = (attName: string) => {
    downloadAttachmentBlob(() => api.getInboxAttachment(noteId, attName), attName).catch((err) => {
      setInlineError(`Failed to download ${attName}: ${err?.message || err}`);
    });
  };

  const handleAttachmentClick = (filename: string) => {
    const info = getAttachmentInfo(filename, attachmentDetails);
    if (info.class === 'pdf') {
      handleDownloadPdf(filename);
    } else if (info.class === 'text') {
      setViewingTextAttachment({ filename, size: info.size });
    } else if (info.class === 'image') {
      handleDownloadPdf(filename);
    }
  };

  // Save note explicitly
  const handleSave = async (silent = false): Promise<boolean> => {
    if (!title.trim()) {
      if (!silent) setInlineError('Title is required');
      return false;
    }

    setIsSaving(true);
    setInlineError(null);
    setConflictError(null);

    try {
      if (!noteId || noteId === '-') {
        const res = await api.addInboxNote({
          title: title.trim(),
          kind,
          about: about.trim() || '-',
          body,
          status,
        });
        setNoteId(res.id);
        setCurrentHash(res.bundle_sha256);
        lastSavedValues.current = { title: title.trim(), kind, about, body };
        onSaved();
        return true;
      } else {
        const res = await api.editInboxNote(noteId, {
          title: title.trim(),
          kind,
          about: about.trim() || '-',
          body,
          status,
          expect_hash: currentHash,
        });
        setCurrentHash(res.bundle_sha256);
        lastSavedValues.current = { title: title.trim(), kind, about, body };
        onSaved();
        return true;
      }
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictError('Conflict (409): The note bundle was modified concurrently.');
      } else {
        setInlineError(err?.message || String(err));
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // Reload note from server (discard local on conflict)
  const handleReloadConflict = async () => {
    if (!noteId) return;
    try {
      const res = await api.getInboxNote(noteId);
      if (res.note) {
        setTitle(res.note.title || '');
        setKind(res.note.kind || 'note');
        setAbout(res.note.about === '-' ? '' : res.note.about || '');
        setBody(res.note.body || '');
        setStatus(res.note.status || 'draft');
        setAttachments(res.note.attachments || []);
        setAttachmentDetails(res.note.attachment_details || []);
        setCurrentHash(res.note.bundle_sha256);
        lastSavedValues.current = {
          title: res.note.title || '',
          kind: res.note.kind || 'note',
          about: res.note.about === '-' ? '' : res.note.about || '',
          body: res.note.body || '',
        };
        setConflictError(null);
        setInlineError(null);
      }
    } catch (err: any) {
      setInlineError(`Failed to reload note: ${err?.message || err}`);
    }
  };

  // Keep mine on conflict (re-fetch hash and save again)
  const handleKeepMineConflict = async () => {
    if (!noteId) return;
    try {
      const res = await api.getInboxNote(noteId);
      const latestHash = res.note.bundle_sha256;
      setCurrentHash(latestHash);

      const editRes = await api.editInboxNote(noteId, {
        title: title.trim(),
        kind,
        about: about.trim() || '-',
        body,
        status,
        expect_hash: latestHash,
      });
      setCurrentHash(editRes.bundle_sha256);
      lastSavedValues.current = { title: title.trim(), kind, about, body };
      setConflictError(null);
      setInlineError(null);
      onSaved();
    } catch (err: any) {
      setInlineError(`Failed to save: ${err?.message || err}`);
    }
  };

  // Debounced autosave (1.5 s) while status is draft
  useEffect(() => {
    if (status !== 'draft' || !noteId || noteId === '-' || !isDirty || conflictError) {
      return;
    }

    const timer = setTimeout(() => {
      handleSave(true);
    }, 1500);

    return () => clearTimeout(timer);
  }, [title, kind, about, body, status, noteId, isDirty, conflictError]);

  // Mark ready action
  const handleMarkReady = async () => {
    if (!noteId) {
      const saved = await handleSave();
      if (!saved) return;
    }
    try {
      const res = await api.editInboxNote(noteId, {
        status: 'ready',
        expect_hash: currentHash,
      });
      setStatus('ready');
      setCurrentHash(res.bundle_sha256);
      onSaved();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictError('Conflict (409): The note was modified elsewhere.');
      } else {
        setInlineError(err?.message || String(err));
      }
    }
  };

  // Reopen action
  const handleReopen = async () => {
    if (!noteId) return;
    try {
      const res = await api.reopenInboxNote(noteId);
      setStatus(res.status || 'ready');
      onSaved();
    } catch (err: any) {
      setInlineError(err?.message || String(err));
    }
  };

  // Discard action
  const handleConfirmDiscard = async () => {
    if (!discardReason.trim()) {
      setInlineError('Reason is required to discard a note.');
      return;
    }
    try {
      const res = await api.discardInboxNote(noteId, { reason: discardReason.trim() });
      setStatus(res.status || 'discarded');
      setShowDiscardPrompt(false);
      onSaved();
    } catch (err: any) {
      setInlineError(err?.message || String(err));
    }
  };

  // Resolve (mark processed) action
  const handleConfirmResolve = async () => {
    const prod = resolveProduced.trim() || createdTasks.join(', ') || '-';
    try {
      const res = await api.resolveInboxNote(noteId, { produced: prod, by: 'owner' });
      setStatus(res.status || 'processed');
      setShowResolvePrompt(false);
      onSaved();
    } catch (err: any) {
      setInlineError(err?.message || String(err));
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: '1rem',
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        style={{
          backgroundColor: '#1e293b',
          border: `1px solid ${isDraggingOver ? '#818cf8' : '#334155'}`,
          borderRadius: '0.75rem',
          width: '100%',
          maxWidth: '920px',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Drag overlay indicator */}
        {isDraggingOver && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(79, 70, 229, 0.25)',
              border: '2px dashed #818cf8',
              borderRadius: '0.75rem',
              zIndex: 10,
              pointerEvents: 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#c7d2fe',
              gap: '0.5rem',
              fontWeight: 600,
            }}
          >
            <Upload size={32} />
            <span>Drop image to upload and attach</span>
          </div>
        )}

        {/* Modal Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.5rem',
            borderBottom: '1px solid #334155',
            backgroundColor: '#0f172a',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <Inbox size={20} color="#818cf8" />
            <h2 style={{ fontSize: '1.15rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
              {noteId ? `Note ${noteId}` : 'New Inbox Note'}
            </h2>

            {status && (
              <span
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  padding: '0.15rem 0.45rem',
                  borderRadius: '1rem',
                  border: `1px solid ${getStatusBadgeStyle(status).border}`,
                  backgroundColor: getStatusBadgeStyle(status).bg,
                  color: getStatusBadgeStyle(status).color,
                  textTransform: 'uppercase',
                }}
              >
                {status}
              </span>
            )}

            {isDirty && status === 'draft' && (
              <span style={{ fontSize: '0.75rem', color: '#fbbf24', fontStyle: 'italic' }}>
                (Unsaved changes)
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '0.25rem',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1.25rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}
        >
          {/* Conflict 409 Banner */}
          {conflictError && (
            <div
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '0.375rem',
                backgroundColor: '#451a03',
                border: '1px solid #f59e0b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                color: '#fef3c7',
                fontSize: '0.85rem',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertTriangle size={18} color="#f59e0b" />
                <span>{conflictError}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={handleReloadConflict}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: '0.25rem',
                    border: '1px solid #d97706',
                    backgroundColor: '#78350f',
                    color: '#fff',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  Reload (discard local)
                </button>
                <button
                  type="button"
                  onClick={handleKeepMineConflict}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: '0.25rem',
                    border: 'none',
                    backgroundColor: '#d97706',
                    color: '#fff',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  Keep mine
                </button>
              </div>
            </div>
          )}

          {/* Inline Error Banner */}
          {inlineError && (
            <div
              style={{
                padding: '0.6rem 0.8rem',
                borderRadius: '0.375rem',
                backgroundColor: '#451a1a',
                border: '1px solid #ef4444',
                color: '#fca5a5',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <AlertCircle size={18} color="#ef4444" />
              <span>{inlineError}</span>
            </div>
          )}

          {/* Created Tasks Banner */}
          {createdTasks.length > 0 && (
            <div
              style={{
                padding: '0.6rem 0.8rem',
                borderRadius: '0.375rem',
                backgroundColor: '#064e3b',
                border: '1px solid #10b981',
                color: '#6ee7b7',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <CheckCircle2 size={18} color="#10b981" />
              <span>
                Created tasks in this session: <strong>{createdTasks.join(', ')}</strong>
              </span>
            </div>
          )}

          {/* Discard Prompt Modal / Box */}
          {showDiscardPrompt && (
            <div
              style={{
                padding: '0.9rem',
                borderRadius: '0.375rem',
                backgroundColor: '#2d1515',
                border: '1px solid #ef4444',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#fca5a5' }}>
                Discard Note — Reason required
              </div>
              <input
                type="text"
                value={discardReason}
                onChange={(e) => setDiscardReason(e.target.value)}
                placeholder="Reason for discarding (e.g. Duplicate, Obsolete, Handled elsewhere)"
                style={{
                  width: '100%',
                  padding: '0.45rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.25rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowDiscardPrompt(false)}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: '0.25rem',
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
                  type="button"
                  onClick={handleConfirmDiscard}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: '0.25rem',
                    border: 'none',
                    backgroundColor: '#ef4444',
                    color: '#fff',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Confirm Discard
                </button>
              </div>
            </div>
          )}

          {/* Resolve (Mark Processed) Box */}
          {showResolvePrompt && (
            <div
              style={{
                padding: '0.9rem',
                borderRadius: '0.375rem',
                backgroundColor: '#143828',
                border: '1px solid #10b981',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#6ee7b7' }}>
                Mark Processed — Produced IDs
              </div>
              <input
                type="text"
                value={resolveProduced}
                onChange={(e) => setResolveProduced(e.target.value)}
                placeholder="Produced items (e.g. T001, T002 or spec path)"
                style={{
                  width: '100%',
                  padding: '0.45rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.25rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowResolvePrompt(false)}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: '0.25rem',
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
                  type="button"
                  onClick={handleConfirmResolve}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: '0.25rem',
                    border: 'none',
                    backgroundColor: '#10b981',
                    color: '#fff',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Confirm Processed
                </button>
              </div>
            </div>
          )}

          {/* Title and Kind Row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
                Title *
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary of note, bug or idea"
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: '#f8fafc',
                  fontSize: '0.9rem',
                  fontWeight: 500,
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
                Kind
              </label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              >
                <option value="note">Note</option>
                <option value="bug">Bug</option>
                <option value="feature">Feature</option>
                <option value="idea">Idea</option>
                <option value="request">Request</option>
                <option value="question">Question</option>
              </select>
            </div>
          </div>

          {/* About Field */}
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.3rem' }}>
              About (paths, repos, or task IDs)
            </label>
            <input
              type="text"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="e.g. backend/server.py, T014"
              style={{
                width: '100%',
                padding: '0.45rem 0.75rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Markdown Body Section */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8' }}>
                Body (Markdown, paste or drop files)
              </label>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    if (e.target.files) {
                      for (let i = 0; i < e.target.files.length; i++) {
                        await handleUploadFile(e.target.files[i]);
                      }
                      e.target.value = '';
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.3rem 0.6rem',
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '0.25rem',
                    color: '#94a3b8',
                    fontSize: '0.75rem',
                    cursor: isUploading ? 'not-allowed' : 'pointer',
                  }}
                >
                  <Paperclip size={13} />
                  <span>Attach…</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsPreview(!isPreview)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.3rem 0.6rem',
                    backgroundColor: isPreview ? '#4338ca' : '#1e293b',
                    border: `1px solid ${isPreview ? '#6366f1' : '#334155'}`,
                    borderRadius: '0.25rem',
                    color: isPreview ? '#fff' : '#94a3b8',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                >
                  {isPreview ? <Edit3 size={13} /> : <Eye size={13} />}
                  <span>{isPreview ? 'Edit' : 'Preview'}</span>
                </button>
              </div>
            </div>

            {isPreview ? (
              <div
                style={{
                  minHeight: '220px',
                  maxHeight: '380px',
                  overflowY: 'auto',
                  padding: '0.75rem 1rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  fontSize: '0.85rem',
                  color: '#cbd5e1',
                }}
              >
                {body.trim() ? (
                  <SafeMarkdown
                    content={body}
                    attachmentBlobUrls={attachmentBlobUrls}
                    onAttachmentClick={handleAttachmentClick}
                  />
                ) : (
                  <span style={{ color: '#64748b', fontStyle: 'italic' }}>No body text</span>
                )}
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onPaste={handlePaste}
                placeholder="Markdown text... Paste or drop files directly here."
                style={{
                  width: '100%',
                  minHeight: '220px',
                  maxHeight: '380px',
                  padding: '0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: '#f8fafc',
                  fontSize: '0.85rem',
                  fontFamily: 'monospace',
                  lineHeight: 1.5,
                  boxSizing: 'border-box',
                  resize: 'vertical',
                }}
              />
            )}
          </div>

          {/* Attachments List */}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8' }}>
                Attachments ({attachments.length})
              </span>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {attachments.map((name) => (
                  <AttachmentItem
                    key={name}
                    name={name}
                    context={{ type: 'note', id: noteId }}
                    details={attachmentDetails}
                    thumbnailSize={64}
                    canRemove={true}
                    onRemove={() => handleRemoveAttachment(name)}
                    onBlobLoaded={(attName, url) => {
                      setAttachmentBlobUrls((prev) => ({ ...prev, [attName]: url }));
                    }}
                    onOpenTextViewer={(attName, sz) => {
                      setViewingTextAttachment({ filename: attName, size: sz });
                    }}
                    onDownloadPdf={(attName) => {
                      handleDownloadPdf(attName);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {isUploading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#818cf8', fontSize: '0.8rem' }}>
              <Loader2 size={16} className="spin" />
              <span>Uploading attachment...</span>
            </div>
          )}

          {/* Triage Runs & Proposal Review Section */}
          {noteId && noteId.startsWith('N') && (
            <div
              style={{
                marginTop: '1rem',
                paddingTop: '1rem',
                borderTop: '1px solid #334155',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.85rem',
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Play size={16} color="#818cf8" />
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f8fafc' }}>
                    Agent Triage Runs {triageRuns.length > 0 && `(${triageRuns.length})`}
                  </span>
                  {loadingRuns && <Loader2 size={14} className="spin" color="#818cf8" />}
                </div>
                {status === 'ready' && (
                  <button
                    type="button"
                    onClick={() => setShowRunDialog(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.3rem 0.6rem',
                      backgroundColor: '#312e81',
                      border: '1px solid #4338ca',
                      borderRadius: '0.375rem',
                      color: '#c7d2fe',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <Play size={12} />
                    <span>Process with…</span>
                  </button>
                )}
              </div>

              {/* Triage Runs List */}
              {triageRuns.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {triageRuns.map((r) => {
                    const isSelected = selectedRunProposal?.runId === r.run_id;
                    return (
                      <div
                        key={r.run_id}
                        onClick={() => handleSelectRun(r)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '0.5rem 0.75rem',
                          backgroundColor: isSelected ? '#1e293b' : '#0f172a',
                          border: isSelected ? '1px solid #6366f1' : '1px solid #334155',
                          borderRadius: '0.375rem',
                          fontSize: '0.8rem',
                          cursor: 'pointer',
                          transition: 'border-color 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'monospace', color: '#f8fafc', fontWeight: 600 }}>
                            {r.run_id}
                          </span>
                          <span style={{ color: '#94a3b8' }}>
                            {r.tool} ({r.profile})
                          </span>
                          <span
                            style={{
                              padding: '0.15rem 0.45rem',
                              borderRadius: '0.25rem',
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              backgroundColor:
                                r.status === 'succeeded'
                                  ? '#064e3b'
                                  : r.status === 'running' || r.status === 'starting'
                                  ? '#1e3a8a'
                                  : r.status === 'failed'
                                  ? '#451a1a'
                                  : '#334155',
                              color:
                                r.status === 'succeeded'
                                  ? '#6ee7b7'
                                  : r.status === 'running' || r.status === 'starting'
                                  ? '#93c5fd'
                                  : r.status === 'failed'
                                  ? '#fca5a5'
                                  : '#cbd5e1',
                            }}
                          >
                            {r.status}
                          </span>
                          {r.proposal_status && (
                            <span
                              style={{
                                padding: '0.15rem 0.45rem',
                                borderRadius: '0.25rem',
                                fontSize: '0.7rem',
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                backgroundColor:
                                  r.proposal_status === 'accepted'
                                    ? '#064e3b'
                                    : r.proposal_status === 'pending'
                                    ? '#78350f'
                                    : '#451a1a',
                                color:
                                  r.proposal_status === 'accepted'
                                    ? '#6ee7b7'
                                    : r.proposal_status === 'pending'
                                    ? '#fde68a'
                                    : '#fca5a5',
                              }}
                            >
                              Proposal: {r.proposal_status}
                            </span>
                          )}
                        </div>
                        <span style={{ color: '#64748b', fontSize: '0.75rem' }}>
                          {formatRelativeAge(r.started_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: '0.8rem', color: '#64748b', fontStyle: 'italic' }}>
                  No triage runs yet for this note.
                </div>
              )}

              {/* Triage Success Message / Created Tasks Banner */}
              {triageSuccessTasks.length > 0 && (
                <div
                  style={{
                    padding: '0.75rem 1rem',
                    backgroundColor: '#064e3b',
                    border: '1px solid #10b981',
                    borderRadius: '0.375rem',
                    color: '#6ee7b7',
                    fontSize: '0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <CheckCircle2 size={18} color="#10b981" />
                    <span>Triage proposal accepted! Created tasks:</span>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      {triageSuccessTasks.map((tId) => (
                        <a
                          key={tId}
                          href={`#${tId}`}
                          onClick={(e) => {
                            e.preventDefault();
                            onClose();
                          }}
                          style={{
                            padding: '0.15rem 0.5rem',
                            backgroundColor: '#047857',
                            color: '#fff',
                            borderRadius: '0.25rem',
                            fontWeight: 600,
                            textDecoration: 'none',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                          }}
                        >
                          <span>{tId}</span>
                          <ExternalLink size={12} />
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Action Error Banner */}
              {triageActionError && (
                <div
                  style={{
                    padding: '0.6rem 0.8rem',
                    backgroundColor: '#451a1a',
                    border: '1px solid #ef4444',
                    borderRadius: '0.375rem',
                    color: '#fca5a5',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  <AlertCircle size={15} color="#ef4444" />
                  <span>{triageActionError}</span>
                </div>
              )}

              {/* Invalid Proposal State */}
              {selectedRunProposal && selectedRunProposal.proposal_status === 'invalid' && (
                <div
                  style={{
                    padding: '0.85rem 1rem',
                    backgroundColor: '#451a1a',
                    border: '1px solid #ef4444',
                    borderRadius: '0.375rem',
                    color: '#fca5a5',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
                      <AlertTriangle size={16} color="#ef4444" />
                      <span>Invalid Triage Proposal</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowRunDialog(true)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '0.35rem 0.75rem',
                        backgroundColor: '#ef4444',
                        border: 'none',
                        borderRadius: '0.25rem',
                        color: '#fff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <RotateCcw size={13} />
                      <span>Process again</span>
                    </button>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#fecaca', whiteSpace: 'pre-wrap' }}>
                    {selectedRunProposal.proposal_error || 'Agent did not produce a valid ```ai-orch-triage block.'}
                  </div>
                </div>
              )}

              {/* Proposal Review Panel (pending proposal) */}
              {selectedRunProposal &&
                selectedRunProposal.proposal_status === 'pending' &&
                selectedRunProposal.proposal && (
                  <div
                    style={{
                      padding: '1rem',
                      backgroundColor: '#1e293b',
                      border: '1px solid #4338ca',
                      borderRadius: '0.5rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.85rem',
                    }}
                  >
                    {/* Panel Header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f8fafc' }}>
                            Proposal Review
                          </span>
                          <span style={{ fontSize: '0.75rem', color: '#818cf8', fontFamily: 'monospace' }}>
                            ({selectedRunProposal.runId})
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: '0.75rem',
                            color: '#94a3b8',
                            fontStyle: 'italic',
                            marginTop: '0.2rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                          }}
                        >
                          <Info size={12} color="#818cf8" />
                          <span>Edit the task after it is created</span>
                        </div>
                      </div>

                      {/* Accept Selected Button */}
                      <button
                        type="button"
                        disabled={isAcceptingTriage || selectedTaskIndices.size === 0}
                        onClick={handleAcceptTriage}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.45rem 1rem',
                          backgroundColor: selectedTaskIndices.size > 0 ? '#4f46e5' : '#334155',
                          border: 'none',
                          borderRadius: '0.375rem',
                          color: '#fff',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          cursor: selectedTaskIndices.size > 0 && !isAcceptingTriage ? 'pointer' : 'not-allowed',
                          opacity: isAcceptingTriage ? 0.7 : 1,
                        }}
                      >
                        {isAcceptingTriage ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                        <span>
                          {isAcceptingTriage
                            ? 'Accepting...'
                            : `Accept selected (${selectedTaskIndices.size} of ${selectedRunProposal.proposal.tasks.length})`}
                        </span>
                      </button>
                    </div>

                    {/* Proposed Tasks Cards */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {selectedRunProposal.proposal.tasks.map((pt, idx) => {
                        const isAccepted = selectedTaskIndices.has(idx);
                        return (
                          <div
                            key={idx}
                            style={{
                              padding: '0.85rem 1rem',
                              backgroundColor: isAccepted ? '#0f172a' : '#141c2e',
                              border: isAccepted ? '1px solid #334155' : '1px solid #1e293b',
                              borderRadius: '0.375rem',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.5rem',
                              opacity: isAccepted ? 1 : 0.65,
                              transition: 'opacity 0.15s ease',
                            }}
                          >
                            {/* Card Top: Checkbox, Title, Badges, Reject Toggle */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                <input
                                  type="checkbox"
                                  checked={isAccepted}
                                  onChange={() => toggleTaskAccept(idx)}
                                  id={`pt-check-${idx}`}
                                  style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: '#4f46e5' }}
                                />
                                <label
                                  htmlFor={`pt-check-${idx}`}
                                  style={{
                                    fontSize: '0.9rem',
                                    fontWeight: 600,
                                    color: isAccepted ? '#f8fafc' : '#94a3b8',
                                    cursor: 'pointer',
                                    textDecoration: isAccepted ? 'none' : 'line-through',
                                  }}
                                >
                                  {pt.title}
                                </label>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                {/* Category badge */}
                                <span
                                  style={{
                                    padding: '0.15rem 0.45rem',
                                    borderRadius: '0.25rem',
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                    backgroundColor: '#312e81',
                                    color: '#c7d2fe',
                                  }}
                                >
                                  {pt.category}
                                </span>

                                {/* Priority + Reason */}
                                <span
                                  style={{
                                    padding: '0.15rem 0.45rem',
                                    borderRadius: '0.25rem',
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                    backgroundColor: '#1e293b',
                                    color: '#cbd5e1',
                                    border: '1px solid #334155',
                                  }}
                                  title={pt.priority_reason ? `Reason: ${pt.priority_reason}` : undefined}
                                >
                                  {pt.priority}
                                  {pt.priority_reason ? ` (${pt.priority_reason})` : ''}
                                </span>

                                {/* Reject / Accept Toggle */}
                                <button
                                  type="button"
                                  onClick={() => toggleTaskAccept(idx)}
                                  style={{
                                    padding: '0.2rem 0.5rem',
                                    borderRadius: '0.25rem',
                                    border: 'none',
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    backgroundColor: isAccepted ? '#451a1a' : '#064e3b',
                                    color: isAccepted ? '#fca5a5' : '#6ee7b7',
                                  }}
                                >
                                  {isAccepted ? 'Reject' : 'Accept'}
                                </button>
                              </div>
                            </div>

                            {/* Goal */}
                            {pt.goal && (
                              <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                                <span style={{ fontWeight: 600, color: '#94a3b8', marginRight: '0.35rem' }}>Goal:</span>
                                {pt.goal}
                              </div>
                            )}

                            {/* Steps */}
                            {pt.steps && (
                              <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                                <span style={{ fontWeight: 600, color: '#94a3b8' }}>Steps:</span>
                                {Array.isArray(pt.steps) ? (
                                  <ol style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem' }}>
                                    {pt.steps.map((step, sIdx) => (
                                      <li key={sIdx} style={{ marginBottom: '0.15rem' }}>
                                        {step}
                                      </li>
                                    ))}
                                  </ol>
                                ) : (
                                  <div style={{ whiteSpace: 'pre-wrap', marginTop: '0.2rem' }}>{pt.steps}</div>
                                )}
                              </div>
                            )}

                            {/* Verification */}
                            {pt.verification && (
                              <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                                <span style={{ fontWeight: 600, color: '#94a3b8', marginRight: '0.35rem' }}>
                                  Verification:
                                </span>
                                {pt.verification}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Updates (read-only) */}
                    {selectedRunProposal.proposal.updates &&
                      selectedRunProposal.proposal.updates.length > 0 && (
                        <div
                          style={{
                            padding: '0.75rem',
                            backgroundColor: '#0f172a',
                            border: '1px solid #334155',
                            borderRadius: '0.375rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.4rem',
                          }}
                        >
                          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8' }}>
                            Proposed Updates (read-only)
                          </span>
                          <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                            {selectedRunProposal.proposal.updates.map((u: any, uIdx: number) => (
                              <div key={uIdx} style={{ marginBottom: '0.25rem' }}>
                                {typeof u === 'string' ? u : JSON.stringify(u, null, 2)}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                    {/* Spec (read-only) */}
                    {selectedRunProposal.proposal.spec && (
                      <div
                        style={{
                          padding: '0.75rem',
                          backgroundColor: '#0f172a',
                          border: '1px solid #334155',
                          borderRadius: '0.375rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.4rem',
                        }}
                      >
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8' }}>
                          Proposed Spec (read-only)
                        </span>
                        <pre style={{ margin: 0, fontSize: '0.75rem', color: '#cbd5e1', overflowX: 'auto' }}>
                          {typeof selectedRunProposal.proposal.spec === 'string'
                            ? selectedRunProposal.proposal.spec
                            : JSON.stringify(selectedRunProposal.proposal.spec, null, 2)}
                        </pre>
                      </div>
                    )}

                    {/* Questions (read-only) */}
                    {selectedRunProposal.proposal.questions &&
                      selectedRunProposal.proposal.questions.length > 0 && (
                        <div
                          style={{
                            padding: '0.75rem',
                            backgroundColor: '#0f172a',
                            border: '1px solid #334155',
                            borderRadius: '0.375rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.4rem',
                          }}
                        >
                          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8' }}>
                            Questions from Agent (read-only)
                          </span>
                          <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8rem', color: '#cbd5e1' }}>
                            {selectedRunProposal.proposal.questions.map((q: any, qIdx: number) => (
                              <li key={qIdx}>
                                {typeof q === 'string' ? q : q.question || JSON.stringify(q)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                  </div>
                )}
            </div>
          )}
        </div>

        {/* Modal Footer / Actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.85rem 1.5rem',
            backgroundColor: '#0f172a',
            borderTop: '1px solid #334155',
            flexWrap: 'wrap',
            gap: '0.6rem',
          }}
        >
          {/* Left Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {noteId && status === 'draft' && (
              <button
                type="button"
                onClick={handleMarkReady}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.8rem',
                  backgroundColor: '#064e3b',
                  border: '1px solid #059669',
                  borderRadius: '0.375rem',
                  color: '#6ee7b7',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <CheckCircle2 size={14} />
                <span>Mark Ready</span>
              </button>
            )}

            {noteId && (
              <button
                type="button"
                onClick={() => setShowConvertToTask(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.8rem',
                  backgroundColor: '#312e81',
                  border: '1px solid #4338ca',
                  borderRadius: '0.375rem',
                  color: '#c7d2fe',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Layers size={14} />
                <span>Convert to Task</span>
              </button>
            )}

            {noteId && (
              <button
                type="button"
                disabled={status !== 'ready'}
                onClick={() => setShowRunDialog(true)}
                title={status !== 'ready' ? 'Note must be marked Ready to process with an agent' : 'Process note with agent triage'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.8rem',
                  backgroundColor: status === 'ready' ? '#312e81' : '#1e293b',
                  border: status === 'ready' ? '1px solid #4338ca' : '1px solid #334155',
                  borderRadius: '0.375rem',
                  color: status === 'ready' ? '#c7d2fe' : '#64748b',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: status === 'ready' ? 'pointer' : 'not-allowed',
                  opacity: status === 'ready' ? 1 : 0.6,
                }}
              >
                <Play size={14} />
                <span>Process with…</span>
              </button>
            )}

            {noteId && (status === 'processed' || status === 'discarded') && (
              <button
                type="button"
                onClick={handleReopen}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.8rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #475569',
                  borderRadius: '0.375rem',
                  color: '#cbd5e1',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                <RotateCcw size={14} />
                <span>Reopen</span>
              </button>
            )}

            {noteId && status !== 'processed' && status !== 'discarded' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setResolveProduced(createdTasks.join(', ') || initialNote?.produced || '');
                    setShowResolvePrompt(true);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.4rem 0.75rem',
                    backgroundColor: 'transparent',
                    border: '1px solid #059669',
                    borderRadius: '0.375rem',
                    color: '#6ee7b7',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  <span>Mark Processed</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setDiscardReason('');
                    setShowDiscardPrompt(true);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.4rem 0.75rem',
                    backgroundColor: 'transparent',
                    border: '1px solid #7f1d1d',
                    borderRadius: '0.375rem',
                    color: '#fca5a5',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  <Trash2 size={13} />
                  <span>Discard</span>
                </button>
              </>
            )}
          </div>

          {/* Right Actions: Save / Close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '0.45rem 0.9rem',
                backgroundColor: 'transparent',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#cbd5e1',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Close
            </button>

            <button
              type="button"
              onClick={() => handleSave()}
              disabled={isSaving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 1rem',
                backgroundColor: '#4f46e5',
                border: 'none',
                borderRadius: '0.375rem',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: isSaving ? 'not-allowed' : 'pointer',
              }}
            >
              {isSaving ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
              <span>{isSaving ? 'Saving...' : 'Save'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Convert to Task Sub-Dialog */}
      {noteId && (
        <ConvertToTaskDialog
          note={{
            id: noteId,
            title,
            kind,
            status,
            created: initialNote?.created || '',
            author: initialNote?.author || 'owner',
            about,
            produced: initialNote?.produced || '-',
            body,
            attachments,
            attachment_details: attachmentDetails,
            bundle_sha256: currentHash,
          }}
          isOpen={showConvertToTask}
          onClose={() => setShowConvertToTask(false)}
          onSuccess={(taskId) => {
            setCreatedTasks((prev) => [...prev, taskId]);
            onSaved();
          }}
        />
      )}

      {/* Text Viewer Modal */}
      {viewingTextAttachment && (
        <TextViewerModal
          filename={viewingTextAttachment.filename}
          size={viewingTextAttachment.size}
          fetchContent={() => api.getInboxAttachment(noteId, viewingTextAttachment.filename)}
          onClose={() => setViewingTextAttachment(null)}
        />
      )}

      {/* Triage Run Dialog */}
      {noteId && showRunDialog && (
        <RunDialog
          isOpen={true}
          note={{
            id: noteId,
            title,
            bundle_sha256: currentHash,
          }}
          onClose={() => setShowRunDialog(false)}
          onRunStarted={(_runId) => {
            setShowRunDialog(false);
            loadTriageRuns();
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main InboxPanel Component
// ---------------------------------------------------------------------------

interface InboxPanelProps {
  onRefreshNotesCount?: () => void;
  refreshTrigger?: number;
}

export const InboxPanel: React.FC<InboxPanelProps> = ({
  onRefreshNotesCount,
  refreshTrigger = 0,
}) => {
  const [notes, setNotes] = useState<InboxNoteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<InboxNoteStatus[]>(DEFAULT_STATUS_FILTER);
  const [kindFilter, setKindFilter] = useState<InboxNoteKind | 'all'>('all');

  // Selected note for editing/modal
  const [editingNote, setEditingNote] = useState<InboxNoteItem | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listInboxNotes();
      if (res && res.notes) {
        setNotes(res.notes);
      }
      if (onRefreshNotesCount) {
        onRefreshNotesCount();
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [onRefreshNotesCount]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes, refreshTrigger]);

  const toggleStatusFilter = (st: InboxNoteStatus) => {
    setStatusFilter((prev) =>
      prev.includes(st) ? prev.filter((s) => s !== st) : [...prev, st]
    );
  };

  // Filtered notes
  const filteredNotes = notes.filter((n) => {
    // Status filter
    if (statusFilter.length > 0 && !statusFilter.includes(n.status as InboxNoteStatus)) {
      return false;
    }
    // Kind filter
    if (kindFilter !== 'all' && (n.kind || 'note').toLowerCase() !== kindFilter) {
      return false;
    }
    return true;
  });

  return (
    <div style={{ maxWidth: '1200px', margin: '1.5rem auto', padding: '0 1rem' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          padding: '0.85rem 1.25rem',
          marginBottom: '1.25rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            onClick={() => {
              setEditingNote(null);
              setIsEditorOpen(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.9rem',
              backgroundColor: '#4f46e5',
              border: 'none',
              borderRadius: '0.375rem',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 4px rgba(79, 70, 229, 0.3)',
            }}
          >
            <Plus size={16} />
            <span>New note</span>
          </button>

          {/* Status Multi-Select Filter Chips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', marginLeft: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginRight: '0.2rem' }}>Status:</span>
            {ALL_STATUSES.map((st) => {
              const active = statusFilter.includes(st);
              const count = notes.filter((n) => (n.status || 'draft').toLowerCase() === st).length;
              return (
                <button
                  key={st}
                  onClick={() => toggleStatusFilter(st)}
                  style={{
                    fontSize: '0.72rem',
                    padding: '0.15rem 0.5rem',
                    borderRadius: '1rem',
                    border: `1px solid ${active ? '#6366f1' : '#334155'}`,
                    backgroundColor: active ? '#312e81' : 'transparent',
                    color: active ? '#e0e7ff' : count > 0 ? '#94a3b8' : '#475569',
                    cursor: 'pointer',
                  }}
                >
                  {st} ({count})
                </button>
              );
            })}

            <span style={{ color: '#334155', margin: '0 0.1rem' }}>|</span>

            {[
              { label: 'Draft + Ready', statuses: DEFAULT_STATUS_FILTER },
              { label: 'All', statuses: ALL_STATUSES },
              { label: 'None', statuses: [] as InboxNoteStatus[] },
            ].map((preset) => (
              <button
                key={preset.label}
                onClick={() => setStatusFilter(preset.statuses)}
                style={{
                  fontSize: '0.7rem',
                  padding: '0.15rem 0.45rem',
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
          </div>
        </div>

        {/* Kind filter & refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Kind:</span>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as any)}
              style={{
                fontSize: '0.75rem',
                padding: '0.25rem 0.5rem',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.25rem',
                color: '#cbd5e1',
                cursor: 'pointer',
              }}
            >
              {ALL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === 'all' ? 'All kinds' : k}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={loadNotes}
            disabled={loading}
            title="Refresh notes"
            style={{
              background: 'none',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#94a3b8',
              padding: '0.35rem',
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
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
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '1rem',
          }}
        >
          <AlertCircle size={20} color="#ef4444" />
          <span>Failed to load inbox notes: {error}</span>
        </div>
      )}

      {/* Notes List */}
      {loading && notes.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4rem 1rem',
            gap: '0.75rem',
            color: '#94a3b8',
          }}
        >
          <Loader2 size={24} className="spin" color="#818cf8" />
          <span>Loading inbox notes...</span>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4rem 1rem',
            gap: '0.75rem',
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '0.5rem',
            color: '#94a3b8',
            textAlign: 'center',
          }}
        >
          <Inbox size={32} color="#64748b" />
          <div style={{ fontWeight: 600, color: '#f8fafc' }}>No notes match your filters</div>
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
            Try adjusting visible statuses or kinds, or create a new note.
          </div>
          <button
            onClick={() => {
              setEditingNote(null);
              setIsEditorOpen(true);
            }}
            style={{
              marginTop: '0.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.4rem 0.8rem',
              backgroundColor: '#4f46e5',
              border: 'none',
              borderRadius: '0.375rem',
              color: '#fff',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus size={15} />
            <span>New note</span>
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {filteredNotes.map((note) => {
            const kindStyle = getKindBadgeStyle(note.kind);
            const statusStyle = getStatusBadgeStyle(note.status);
            const attCount = note.attachments?.length || 0;
            const topThumbs = (note.attachments || []).slice(0, 3);

            return (
              <div
                key={note.id || note.folder_name || note.title}
                onClick={() => {
                  setEditingNote(note);
                  setIsEditorOpen(true);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.85rem 1.15rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '0.5rem',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s, background-color 0.15s',
                  gap: '1rem',
                  flexWrap: 'wrap',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#6366f1';
                  e.currentTarget.style.backgroundColor = '#24334a';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#334155';
                  e.currentTarget.style.backgroundColor = '#1e293b';
                }}
              >
                {/* Left side: ID, kind, title, about */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: '280px' }}>
                  <span
                    style={{
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: '#818cf8',
                      minWidth: '45px',
                    }}
                  >
                    {note.id || '—'}
                  </span>

                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      padding: '0.15rem 0.45rem',
                      borderRadius: '0.25rem',
                      border: `1px solid ${kindStyle.border}`,
                      backgroundColor: kindStyle.bg,
                      color: kindStyle.color,
                      textTransform: 'uppercase',
                      letterSpacing: '0.025em',
                    }}
                  >
                    {note.kind || 'note'}
                  </span>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f8fafc' }}>
                      {note.title}
                    </div>
                    {note.about && note.about !== '-' && (
                      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                        about: <code style={{ color: '#cbd5e1' }}>{note.about}</code>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right side: status, age, thumbnails, count */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  {/* Thumbnails (up to 3) */}
                  {topThumbs.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      {topThumbs.map((attName) => (
                        <AttachmentThumbnail
                          key={attName}
                          noteId={note.id}
                          name={attName}
                          size={36}
                          canRemove={false}
                          details={note.attachment_details}
                        />
                      ))}
                    </div>
                  )}

                  {/* Attachment count */}
                  {attCount > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        fontSize: '0.75rem',
                        color: '#94a3b8',
                      }}
                      title={`${attCount} attachment(s)`}
                    >
                      <Paperclip size={13} />
                      <span>{attCount}</span>
                    </div>
                  )}

                  {/* Status badge */}
                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      padding: '0.15rem 0.45rem',
                      borderRadius: '1rem',
                      border: `1px solid ${statusStyle.border}`,
                      backgroundColor: statusStyle.bg,
                      color: statusStyle.color,
                      textTransform: 'uppercase',
                    }}
                  >
                    {note.status}
                  </span>

                  {/* Age */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      fontSize: '0.75rem',
                      color: '#64748b',
                      minWidth: '60px',
                      justifyContent: 'flex-end',
                    }}
                  >
                    <Calendar size={12} />
                    <span>{formatRelativeAge(note.created)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Note Editor Modal */}
      {isEditorOpen && (
        <NoteEditorModal
          note={editingNote}
          isOpen={isEditorOpen}
          onClose={() => {
            setIsEditorOpen(false);
            setEditingNote(null);
          }}
          onSaved={() => {
            loadNotes();
          }}
        />
      )}
    </div>
  );
};
