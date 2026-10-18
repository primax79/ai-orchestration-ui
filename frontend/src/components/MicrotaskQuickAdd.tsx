import React, { useState } from 'react';
import { Plus, Zap, Loader2, AlertCircle, X, Check } from 'lucide-react';
import { TaskKind, Priority, CreateMicrotaskResponse } from '../types';
import { microtaskAndLabelsApi } from '../api';
import { KIND_CONFIGS } from './KindBadge';

interface MicrotaskQuickAddProps {
  onCreated?: (microtask: CreateMicrotaskResponse) => void;
  defaultKind?: TaskKind;
  buttonLabel?: string;
  style?: React.CSSProperties;
}

const ALL_KINDS: TaskKind[] = ['bug', 'chore', 'docs', 'feature', 'fix', 'investigation'];
const ALL_PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export const MicrotaskQuickAdd: React.FC<MicrotaskQuickAddProps> = ({
  onCreated,
  defaultKind = 'chore',
  buttonLabel = 'Quick Microtask',
  style,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [shortTitle, setShortTitle] = useState('');
  const [kind, setKind] = useState<TaskKind>(defaultKind);
  const [priority, setPriority] = useState<Priority>('P2');
  const [labelsStr, setLabelsStr] = useState('');
  const [what, setWhat] = useState('');
  const [showWhat, setShowWhat] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    const labels = labelsStr
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    try {
      const res = await microtaskAndLabelsApi.createMicrotask({
        title: title.trim(),
        short_title: shortTitle.trim() || undefined,
        kind,
        priority,
        labels: labels.length > 0 ? labels : undefined,
        what: what.trim() || undefined,
      });

      // Clear form
      setTitle('');
      setShortTitle('');
      setKind(defaultKind);
      setPriority('P2');
      setLabelsStr('');
      setWhat('');
      setShowWhat(false);
      setIsOpen(false);

      if (onCreated) {
        onCreated(res);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to create microtask');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          padding: '0.4rem 0.75rem',
          backgroundColor: '#4f46e5',
          border: 'none',
          borderRadius: '0.375rem',
          color: '#fff',
          fontSize: '0.8rem',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'background-color 0.15s ease',
          ...style,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#4338ca')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#4f46e5')}
      >
        <Plus size={14} />
        <span>{buttonLabel}</span>
      </button>
    );
  }

  return (
    <div
      style={{
        backgroundColor: '#0f172a',
        border: '1px solid #4f46e5',
        borderRadius: '0.5rem',
        padding: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
        width: '100%',
        maxWidth: '650px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <Zap size={15} color="#818cf8" />
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f8fafc' }}>
            Quick-Add Microtask
          </span>
          <span style={{ fontSize: '0.7rem', color: '#94a3b8', backgroundColor: '#1e293b', padding: '0.1rem 0.35rem', borderRadius: '0.2rem' }}>
            XS weight (0.5)
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            setError(null);
          }}
          style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 0 }}
        >
          <X size={16} />
        </button>
      </div>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.4rem 0.6rem',
            backgroundColor: '#451a1a',
            border: '1px solid #ef4444',
            borderRadius: '0.25rem',
            color: '#fca5a5',
            fontSize: '0.75rem',
          }}
        >
          <AlertCircle size={14} color="#ef4444" style={{ flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {/* Title Input */}
        <div>
          <input
            type="text"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Microtask title (e.g. Fix navbar overflow on mobile)..."
            style={{
              width: '100%',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.45rem 0.65rem',
              color: '#f8fafc',
              fontSize: '0.85rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Short Title Input */}
        <div>
          <input
            type="text"
            value={shortTitle}
            onChange={(e) => setShortTitle(e.target.value)}
            placeholder="Short title (optional, 3-4 words)..."
            style={{
              width: '100%',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.35rem 0.65rem',
              color: '#f8fafc',
              fontSize: '0.8rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Row with Kind, Priority, Labels */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Kind Select */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>Kind:</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
              style={{
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.25rem',
                color: '#f8fafc',
                fontSize: '0.75rem',
                padding: '0.25rem 0.45rem',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {ALL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_CONFIGS[k]?.label || k}
                </option>
              ))}
            </select>
          </div>

          {/* Priority Select */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>Priority:</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              style={{
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.25rem',
                color: '#f8fafc',
                fontSize: '0.75rem',
                padding: '0.25rem 0.45rem',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {ALL_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* Labels Input */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flex: 1, minWidth: '160px' }}>
            <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>Labels:</span>
            <input
              type="text"
              value={labelsStr}
              onChange={(e) => setLabelsStr(e.target.value)}
              placeholder="comma-separated..."
              style={{
                flex: 1,
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.25rem',
                color: '#f8fafc',
                fontSize: '0.75rem',
                padding: '0.25rem 0.45rem',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Optional What Section */}
        {showWhat ? (
          <div>
            <textarea
              rows={2}
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              placeholder="What to change (optional description or acceptance criteria)..."
              style={{
                width: '100%',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.25rem',
                color: '#f8fafc',
                fontSize: '0.8rem',
                padding: '0.4rem 0.6rem',
                outline: 'none',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setShowWhat(true)}
              style={{
                background: 'none',
                border: 'none',
                color: '#818cf8',
                fontSize: '0.72rem',
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              + Add description (## What)
            </button>
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.25rem' }}>
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              setError(null);
            }}
            disabled={submitting}
            style={{
              padding: '0.35rem 0.75rem',
              backgroundColor: 'transparent',
              border: '1px solid #334155',
              borderRadius: '0.25rem',
              color: '#94a3b8',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '0.35rem 0.85rem',
              backgroundColor: '#4f46e5',
              border: 'none',
              borderRadius: '0.25rem',
              color: '#fff',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: submitting || !title.trim() ? 'not-allowed' : 'pointer',
              opacity: submitting || !title.trim() ? 0.6 : 1,
            }}
          >
            {submitting ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
            <span>Add Microtask</span>
          </button>
        </div>
      </form>
    </div>
  );
};
