import React, { useState } from 'react';
import { ListOrdered, Flame, ArrowRight } from 'lucide-react';
import { TaskGraphNode } from '../types';
import { KindBadge } from './KindBadge';
import { LabelList } from './LabelChip';
import { MicrotaskPill } from './MicrotaskPill';
import { PromoteDialog } from './PromoteDialog';

interface TimelineReadyQueueProps {
  readyQueueIds: string[];
  nodesById: Record<string, TaskGraphNode>;
  heaviestChainIds: string[];
  onSelectTask?: (task: TaskGraphNode) => void;
  onFocusCard?: (taskId: string) => void;
  onRefresh?: () => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  P0: '#ef4444',
  P1: '#f59e0b',
  P2: '#3b82f6',
  P3: '#64748b',
};

export const TimelineReadyQueue: React.FC<TimelineReadyQueueProps> = ({
  readyQueueIds,
  nodesById,
  heaviestChainIds,
  onSelectTask,
  onFocusCard,
  onRefresh,
}) => {
  const [promoteTask, setPromoteTask] = useState<TaskGraphNode | null>(null);

  return (
    <aside
      style={{
        width: '320px',
        flexShrink: 0,
        backgroundColor: '#0f172a',
        borderLeft: '1px solid #334155',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Panel Header */}
      <div
        style={{
          padding: '1rem',
          borderBottom: '1px solid #1e293b',
          backgroundColor: '#1e293b',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
          <ListOrdered size={18} color="#38bdf8" />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9', margin: 0 }}>
            Ready Queue
          </h3>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '0.75rem',
              fontWeight: 700,
              padding: '0.15rem 0.5rem',
              borderRadius: '999px',
              backgroundColor: '#0284c7',
              color: '#fff',
            }}
          >
            {readyQueueIds.length}
          </span>
        </div>
        <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: 0 }}>
          Tasks ready to execute now (Column 0, sorted by priority).
        </p>
      </div>

      {/* Task list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        {readyQueueIds.length === 0 ? (
          <div
            style={{
              padding: '2rem 1rem',
              textAlign: 'center',
              color: '#64748b',
              fontSize: '0.85rem',
            }}
          >
            No ready tasks in queue.
          </div>
        ) : (
          readyQueueIds.map((id, index) => {
            const node = nodesById[id];
            if (!node) return null;
            const isHeavy = heaviestChainIds.includes(id);
            const isMicro = node.size === 'XS' || node.group === 'micro' || node.node_type === 'microtask';

            if (isMicro) {
              return (
                <div
                  key={id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <span
                    style={{
                      fontSize: '0.7rem',
                      color: '#64748b',
                      fontWeight: 600,
                      width: '1.25rem',
                      flexShrink: 0,
                    }}
                  >
                    #{index + 1}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <MicrotaskPill
                      id={node.id}
                      title={node.title}
                      kind={node.kind}
                      priority={node.priority}
                      labels={node.labels}
                      onClick={() => onSelectTask?.(node)}
                      onPromote={() => setPromoteTask(node)}
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                    />
                  </div>
                </div>
              );
            }

            return (
              <div
                key={id}
                onClick={() => onSelectTask?.(node)}
                style={{
                  backgroundColor: '#1e293b',
                  borderRadius: '0.375rem',
                  border: isHeavy ? '1px solid #f59e0b' : '1px solid #334155',
                  padding: '0.625rem 0.75rem',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.35rem',
                  transition: 'background-color 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#24334a';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#1e293b';
                }}
              >
                {/* Header row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      color: '#64748b',
                      fontWeight: 600,
                      width: '1.25rem',
                    }}
                  >
                    #{index + 1}
                  </span>

                  {node.kind && (
                    <KindBadge kind={node.kind} size={11} />
                  )}

                  <span
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: '#38bdf8',
                    }}
                  >
                    {node.id}
                  </span>

                  {/* Priority */}
                  <span
                    style={{
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      padding: '0.1rem 0.35rem',
                      borderRadius: '0.2rem',
                      backgroundColor: PRIORITY_COLORS[node.priority] || '#64748b',
                      color: '#fff',
                    }}
                  >
                    {node.priority}
                  </span>

                  {/* Size */}
                  <span
                    style={{
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      padding: '0.1rem 0.35rem',
                      borderRadius: '0.2rem',
                      backgroundColor: '#0f172a',
                      border: '1px solid #475569',
                      color: '#cbd5e1',
                    }}
                  >
                    {node.size || 'M'}
                  </span>

                  {isHeavy && (
                    <span title="On heaviest chain" style={{ display: 'flex', alignItems: 'center' }}>
                      <Flame size={14} color="#f59e0b" />
                    </span>
                  )}

                  {onFocusCard && (
                    <button
                      type="button"
                      title="Scroll to card in timeline"
                      onClick={(e) => {
                        e.stopPropagation();
                        onFocusCard(id);
                      }}
                      style={{
                        marginLeft: 'auto',
                        background: 'transparent',
                        border: 'none',
                        color: '#64748b',
                        cursor: 'pointer',
                        padding: '0.1rem',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = '#38bdf8')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = '#64748b')}
                    >
                      <ArrowRight size={14} />
                    </button>
                  )}
                </div>

                {/* Title */}
                <div
                  style={{
                    fontSize: '0.8rem',
                    color: '#e2e8f0',
                    lineHeight: 1.35,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                  title={node.title}
                >
                  {node.title}
                </div>

                {/* Labels */}
                {node.labels && node.labels.length > 0 && (
                  <LabelList labels={node.labels} maxVisible={3} size="xs" />
                )}

                {/* Group info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.7rem', color: '#94a3b8' }}>
                  <span>Group:</span>
                  <span style={{ color: '#cbd5e1', fontWeight: 500 }}>{node.group}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Promote Dialog */}
      {promoteTask && (
        <PromoteDialog
          taskId={promoteTask.id}
          taskTitle={promoteTask.title}
          isOpen={true}
          onClose={() => setPromoteTask(null)}
          onSuccess={() => {
            setPromoteTask(null);
            if (onRefresh) onRefresh();
          }}
        />
      )}
    </aside>
  );
};

