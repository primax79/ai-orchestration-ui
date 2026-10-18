import React from 'react';
import { Tag, X } from 'lucide-react';

export function getLabelColor(label: string): { bg: string; text: string; border: string } {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = label.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return {
    bg: `hsl(${hue}, 40%, 16%)`,
    text: `hsl(${hue}, 80%, 78%)`,
    border: `hsl(${hue}, 50%, 32%)`,
  };
}

interface LabelChipProps {
  label: string;
  onRemove?: () => void;
  onClick?: () => void;
  size?: 'xs' | 'sm' | 'md';
  style?: React.CSSProperties;
}

export const LabelChip: React.FC<LabelChipProps> = ({
  label,
  onRemove,
  onClick,
  size = 'sm',
  style,
}) => {
  const colors = getLabelColor(label);

  const sizeStyles = {
    xs: { fontSize: '0.65rem', padding: '0.05rem 0.3rem', iconSize: 10 },
    sm: { fontSize: '0.7rem', padding: '0.1rem 0.35rem', iconSize: 11 },
    md: { fontSize: '0.75rem', padding: '0.15rem 0.5rem', iconSize: 12 },
  }[size];

  return (
    <span
      onClick={onClick}
      title={`Label: ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        borderRadius: '0.25rem',
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        fontSize: sizeStyles.fontSize,
        fontWeight: 600,
        padding: sizeStyles.padding,
        lineHeight: 1.2,
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        userSelect: 'none',
        ...style,
      }}
    >
      <Tag size={sizeStyles.iconSize} color={colors.text} style={{ opacity: 0.8 }} />
      <span>{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title={`Remove label ${label}`}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            marginLeft: '0.1rem',
            color: colors.text,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            opacity: 0.7,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
        >
          <X size={sizeStyles.iconSize} />
        </button>
      )}
    </span>
  );
};

interface LabelListProps {
  labels?: string[];
  maxVisible?: number;
  size?: 'xs' | 'sm' | 'md';
  onLabelClick?: (label: string) => void;
  style?: React.CSSProperties;
}

export const LabelList: React.FC<LabelListProps> = ({
  labels,
  maxVisible,
  size = 'xs',
  onLabelClick,
  style,
}) => {
  if (!labels || labels.length === 0) return null;

  const visible = maxVisible ? labels.slice(0, maxVisible) : labels;
  const remaining = maxVisible ? labels.length - maxVisible : 0;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        flexWrap: 'wrap',
        ...style,
      }}
    >
      {visible.map((lbl) => (
        <LabelChip
          key={lbl}
          label={lbl}
          size={size}
          onClick={onLabelClick ? () => onLabelClick(lbl) : undefined}
        />
      ))}
      {remaining > 0 && (
        <span
          title={`${remaining} more: ${labels.slice(maxVisible).join(', ')}`}
          style={{
            fontSize: '0.65rem',
            color: '#94a3b8',
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '0.2rem',
            padding: '0.05rem 0.25rem',
            fontWeight: 600,
          }}
        >
          +{remaining}
        </span>
      )}
    </div>
  );
};
