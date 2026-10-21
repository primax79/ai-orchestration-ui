import React from 'react';
import {
  Bug,
  Sparkles,
  Wrench,
  Cog,
  BookOpen,
  Compass,
  FileQuestion,
  Zap,
  CheckSquare,
  Target,
  CornerDownRight,
  Layers,
  FileText,
} from 'lucide-react';
import { TaskKind } from '../types';

interface KindBadgeProps {
  kind?: TaskKind | string;
  showLabel?: boolean;
  size?: number;
  style?: React.CSSProperties;
}

export interface KindConfig {
  label: string;
  color: string;
  bg: string;
  border: string;
  icon: any;
}

export const KIND_CONFIGS: Record<string, KindConfig> = {
  bug: {
    label: 'Bug',
    color: '#f43f5e',
    bg: 'rgba(244, 63, 94, 0.15)',
    border: 'rgba(244, 63, 94, 0.4)',
    icon: Bug,
  },
  feature: {
    label: 'Feature',
    color: '#818cf8',
    bg: 'rgba(129, 140, 248, 0.15)',
    border: 'rgba(129, 140, 248, 0.4)',
    icon: Sparkles,
  },
  fix: {
    label: 'Fix',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.15)',
    border: 'rgba(245, 158, 11, 0.4)',
    icon: Wrench,
  },
  chore: {
    label: 'Chore',
    color: '#94a3b8',
    bg: 'rgba(148, 163, 184, 0.15)',
    border: 'rgba(148, 163, 184, 0.35)',
    icon: Cog,
  },
  docs: {
    label: 'Docs',
    color: '#38bdf8',
    bg: 'rgba(56, 189, 248, 0.15)',
    border: 'rgba(56, 189, 248, 0.4)',
    icon: BookOpen,
  },
  investigation: {
    label: 'Investigation',
    color: '#c084fc',
    bg: 'rgba(192, 132, 252, 0.15)',
    border: 'rgba(192, 132, 252, 0.4)',
    icon: Compass,
  },
  emergent: {
    label: 'Emergent',
    color: '#fbbf24',
    bg: 'rgba(251, 191, 36, 0.15)',
    border: 'rgba(251, 191, 36, 0.4)',
    icon: Zap,
  },
  initiative_task: {
    label: 'Plan task',
    color: '#34d399',
    bg: 'rgba(52, 211, 153, 0.15)',
    border: 'rgba(52, 211, 153, 0.4)',
    icon: CheckSquare,
  },
  plan_task: {
    label: 'Plan task',
    color: '#34d399',
    bg: 'rgba(52, 211, 153, 0.15)',
    border: 'rgba(52, 211, 153, 0.4)',
    icon: CheckSquare,
  },
  initiative: {
    label: 'Initiative',
    color: '#a78bfa',
    bg: 'rgba(167, 139, 250, 0.15)',
    border: 'rgba(167, 139, 250, 0.4)',
    icon: Target,
  },
  subtask: {
    label: 'Subtask',
    color: '#94a3b8',
    bg: 'rgba(148, 163, 184, 0.15)',
    border: 'rgba(148, 163, 184, 0.35)',
    icon: CornerDownRight,
  },
  micro: {
    label: 'Micro',
    color: '#e2e8f0',
    bg: 'rgba(226, 232, 240, 0.12)',
    border: 'rgba(226, 232, 240, 0.3)',
    icon: Layers,
  },
  task: {
    label: 'Task',
    color: '#cbd5e1',
    bg: 'rgba(203, 213, 225, 0.12)',
    border: 'rgba(203, 213, 225, 0.3)',
    icon: FileText,
  },
};

export const KindBadge: React.FC<KindBadgeProps> = ({
  kind,
  showLabel = false,
  size = 13,
  style,
}) => {
  if (!kind) return null;
  const normalized = kind.toLowerCase();
  const config =
    KIND_CONFIGS[normalized] ||
    KIND_CONFIGS[normalized.replace(/[\s-]+/g, '_')] || {
      label: kind,
      color: '#94a3b8',
      bg: 'rgba(148, 163, 184, 0.1)',
      border: 'rgba(148, 163, 184, 0.25)',
      icon: FileQuestion,
    };

  const IconComponent = config.icon;

  return (
    <span
      title={`Kind: ${config.label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: showLabel ? '0.25rem' : '0',
        padding: showLabel ? '0.1rem 0.35rem' : '0.15rem',
        borderRadius: '0.25rem',
        backgroundColor: config.bg,
        border: `1px solid ${config.border}`,
        color: config.color,
        fontSize: '0.7rem',
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
        ...style,
      }}
    >
      <IconComponent size={size} color={config.color} />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
};

export function getEffectiveTaskKind(t?: {
  fields?: Record<string, any> | null;
  kind?: string | null;
  category?: string | null;
} | null): string | undefined {
  if (!t) return undefined;
  return (
    (t.fields?.kind?.value ? String(t.fields.kind.value) : undefined) ||
    (t.kind && t.kind !== 'emergent' && t.kind !== 'initiative_task' && t.kind !== 'initiative'
      ? t.kind
      : undefined) ||
    (t.category && KIND_CONFIGS[t.category.toLowerCase()]
      ? t.category.toLowerCase()
      : undefined) ||
    (t.kind || undefined)
  );
}
