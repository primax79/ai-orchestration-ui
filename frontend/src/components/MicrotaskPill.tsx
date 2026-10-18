import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { KindBadge } from './KindBadge';
import { LabelList } from './LabelChip';
import { Priority, TaskKind } from '../types';

interface MicrotaskPillProps {
  id: string;
  title: string;
  kind?: TaskKind | string;
  priority: Priority;
  labels?: string[];
  isSelected?: boolean;
  onClick?: () => void;
  onPromote?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

const PRIORITY_COLORS: Record<string, string> = {
  P0: '#ef4444',
  P1: '#f59e0b',
  P2: '#3b82f6',
  P3: '#64748b',
};

export const MicrotaskPill: React.FC<MicrotaskPillProps> = ({
  id,
  title,
  kind = 'chore',
  priority = 'P2',
  labels = [],
  isSelected = false,
  onClick,
  onPromote,
  style,
}) => {
  return (
    <div
      onClick={onClick}
      title={`${id}: ${title} (${kind}, ${priority}, XS)`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        padding: '0.25rem 0.5rem',
        backgroundColor: isSelected ? '#1e1b4b' : '#0f172a',
        border: `1px solid ${isSelected ? '#6366f1' : '#334155'}`,
        borderRadius: '9999px',
        cursor: onClick ? 'pointer' : 'default',
        boxSizing: 'border-box',
        maxWidth: '100%',
        minWidth: 0,
        transition: 'all 0.15s ease',
        ...style,
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
    >
      {/* Kind icon badge */}
      <KindBadge kind={kind} size={11} />

      {/* Micro badge */}
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          color: '#a1a1aa',
          backgroundColor: '#27272a',
          padding: '0.05rem 0.25rem',
          borderRadius: '9999px',
          textTransform: 'uppercase',
          letterSpacing: '0.025em',
          flexShrink: 0,
        }}
      >
        micro
      </span>

      {/* ID */}
      <span
        style={{
          fontSize: '0.75rem',
          fontWeight: 700,
          color: '#38bdf8',
          fontFamily: 'monospace',
          flexShrink: 0,
        }}
      >
        {id}
      </span>

      {/* Title */}
      <span
        style={{
          fontSize: '0.75rem',
          fontWeight: 500,
          color: '#f8fafc',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '160px',
        }}
      >
        {title}
      </span>

      {/* Priority chip */}
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          padding: '0.05rem 0.3rem',
          borderRadius: '9999px',
          backgroundColor: PRIORITY_COLORS[priority] || '#64748b',
          color: '#fff',
          flexShrink: 0,
        }}
      >
        {priority}
      </span>

      {/* XS size tag */}
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 600,
          color: '#cbd5e1',
          backgroundColor: '#1e293b',
          border: '1px solid #475569',
          padding: '0.05rem 0.25rem',
          borderRadius: '9999px',
          flexShrink: 0,
        }}
      >
        XS
      </span>

      {/* Labels preview (if any, max 1) */}
      {labels && labels.length > 0 && (
        <LabelList labels={labels} maxVisible={1} size="xs" />
      )}

      {/* Promote button */}
      {onPromote && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPromote(e);
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
            marginLeft: '0.15rem',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(99, 102, 241, 0.4)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(99, 102, 241, 0.2)')}
        >
          <ArrowUpRight size={10} />
          <span>Promote</span>
        </button>
      )}
    </div>
  );
};
