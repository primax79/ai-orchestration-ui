import React from 'react';

export interface ArrowPosition {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isHeavy: boolean;
}

interface TimelineArrowsProps {
  arrows: ArrowPosition[];
  onRemoveArrow?: (from: string, to: string) => void;
  width: number;
  height: number;
}

export const TimelineArrows: React.FC<TimelineArrowsProps> = ({
  arrows,
  onRemoveArrow,
  width,
  height,
}) => {
  if (arrows.length === 0 || width <= 0 || height <= 0) return null;

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <defs>
        {/* Standard arrowhead */}
        <marker
          id="timeline-arrow-standard"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
        </marker>

        {/* Heaviest chain arrowhead */}
        <marker
          id="timeline-arrow-heavy"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#f59e0b" />
        </marker>
      </defs>

      {arrows.map((arr, idx) => {
        const { from, to, x1, y1, x2, y2, isHeavy } = arr;
        const dx = Math.max(30, Math.abs(x2 - x1) * 0.45);
        const pathData = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

        return (
          <g key={`${from}->${to}-${idx}`} className="timeline-arrow-group">
            {/* Clickable transparent hitbox for easy removal */}
            {onRemoveArrow && (
              <path
                d={pathData}
                fill="none"
                stroke="transparent"
                strokeWidth={18}
                style={{
                  pointerEvents: 'stroke',
                  cursor: 'pointer',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveArrow(from, to);
                }}
              >
                <title>{`Dependency: ${from} → ${to}\nClick to remove this dependency.`}</title>
              </path>
            )}

            {/* Visible connector line */}
            <path
              d={pathData}
              fill="none"
              stroke={isHeavy ? '#f59e0b' : '#64748b'}
              strokeWidth={isHeavy ? 2.75 : 1.5}
              strokeDasharray={isHeavy ? undefined : undefined}
              markerEnd={isHeavy ? 'url(#timeline-arrow-heavy)' : 'url(#timeline-arrow-standard)'}
              style={{
                pointerEvents: 'none',
                transition: 'stroke 0.15s ease',
              }}
            />
          </g>
        );
      })}
    </svg>
  );
};
