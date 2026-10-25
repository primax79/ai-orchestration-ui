import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Radio,
  Search,
  Play,
  RefreshCw,
  Pause,
  ChevronDown,
  ChevronRight,
  ListOrdered,
  CheckCircle2,
  X,
  Copy,
  Check,
} from 'lucide-react';
import { OrchestrationEvent, EventsStatsResponse, OrchestratorTurnItem } from '../types';
import { api, useProject } from '../api';
import { SessionChips } from './SessionChips';

interface EventStreamPanelProps {
  onNavigateTab?: (tab: 'backlog' | 'decisions' | 'inbox' | 'runs' | 'use-cases' | 'installer' | 'doctor' | 'config' | 'triggers' | 'events') => void;
}

export const EventStreamPanel: React.FC<EventStreamPanelProps> = ({ onNavigateTab: _onNavigateTab }) => {
  const targetProject = useProject();
  const [activeSubTab, setActiveSubTab] = useState<'events' | 'queue'>('events');
  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [stats, setStats] = useState<EventsStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // Filters
  const [search, setSearch] = useState('');
  const [selectedTypeCategory, setSelectedTypeCategory] = useState<string>('all');
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Queue state
  const [queueItems, setQueueItems] = useState<OrchestratorTurnItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [expandedTurnSeq, setExpandedTurnSeq] = useState<number | null>(null);

  const scrollBottomRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef<number>(0);

  // Initial load of events & stats
  const loadInitialEvents = useCallback(async () => {
    if (!targetProject) return;
    setLoading(true);
    try {
      const [eventsRes, statsRes] = await Promise.all([
        api.getEvents({ limit: 100 }, targetProject),
        api.getEventsStats(targetProject),
      ]);
      if (eventsRes && eventsRes.events) {
        setEvents(eventsRes.events);
        if (eventsRes.events.length > 0) {
          lastSeqRef.current = Math.max(...eventsRes.events.map((e: OrchestrationEvent) => e.seq));
        }
      }
      if (statsRes) {
        setStats(statsRes);
      }
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  }, [targetProject]);

  const loadQueue = useCallback(async () => {
    if (!targetProject) return;
    setQueueLoading(true);
    try {
      const res = await api.getOrchestratorQueue(targetProject);
      if (res && res.queue) {
        setQueueItems(res.queue);
      }
    } catch {
      // Fallback
    } finally {
      setQueueLoading(false);
    }
  }, [targetProject]);

  useEffect(() => {
    loadInitialEvents();
    loadQueue();
  }, [loadInitialEvents, loadQueue]);

  // WebSocket event handler
  useEffect(() => {
    const unsubscribe = api.subscribeWebSocket((msg: any) => {
      if (msg.type === 'event' && msg.event) {
        const ev = msg.event as OrchestrationEvent;
        if (!isPaused) {
          setEvents((prev) => {
            if (prev.some((e) => e.seq === ev.seq || e.id === ev.id)) {
              return prev;
            }
            const updated = [...prev, ev];
            lastSeqRef.current = Math.max(lastSeqRef.current, ev.seq);
            return updated;
          });
        }
        setStats((prev) =>
          prev
            ? { ...prev, total_events: prev.total_events + 1, last_seq: ev.seq }
            : null
        );
      } else if (msg.type === 'changed') {
        if (msg.areas?.includes('queue')) {
          loadQueue();
        }
      }
    });
    return () => unsubscribe();
  }, [isPaused, loadQueue]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && activeSubTab === 'events' && scrollBottomRef.current) {
      scrollBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events, autoScroll, activeSubTab]);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const filteredEvents = useMemo(() => {
    let result = [...events];

    // Session filter
    if (selectedSession) {
      result = result.filter(
        (e) =>
          e.origin_session === selectedSession ||
          (e.data && e.data.session === selectedSession) ||
          e.actor === selectedSession
      );
    }

    // Type category filter
    if (selectedTypeCategory !== 'all') {
      result = result.filter((e) => e.type.startsWith(selectedTypeCategory));
    }

    // Search query filter
    if (search.trim()) {
      const qLower = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.type.toLowerCase().includes(qLower) ||
          (e.subject && e.subject.toLowerCase().includes(qLower)) ||
          (e.actor && e.actor.toLowerCase().includes(qLower)) ||
          (e.origin_session && e.origin_session.toLowerCase().includes(qLower)) ||
          JSON.stringify(e.data || {}).toLowerCase().includes(qLower)
      );
    }

    return result;
  }, [events, selectedSession, selectedTypeCategory, search]);

  const getTypeColor = (type: string) => {
    if (type.startsWith('task')) return '#60a5fa';
    if (type.startsWith('question')) return '#fbbf24';
    if (type.startsWith('run')) return '#34d399';
    if (type.startsWith('trigger')) return '#f472b6';
    if (type.startsWith('config')) return '#a78bfa';
    if (type.startsWith('note') || type.startsWith('inbox')) return '#f87171';
    return '#94a3b8';
  };

  const formatAge = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diffSec < 60) return `${diffSec}s ago`;
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      return `${Math.floor(diffSec / 3600)}h ago`;
    } catch {
      return '';
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - var(--nav-h, 3.75rem))',
        backgroundColor: '#0f172a',
        color: '#f8fafc',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* Top Header & Stats */}
      <div
        style={{
          padding: '0.75rem 1.5rem',
          backgroundColor: '#1e293b',
          borderBottom: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Radio size={20} color="#818cf8" />
            <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700 }}>
              Event Stream & Orchestration Queue
            </h2>
          </div>

          {/* Sub-tab Switcher */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: '#0f172a',
              borderRadius: '0.375rem',
              padding: '0.2rem',
              border: '1px solid #334155',
            }}
          >
            <button
              onClick={() => setActiveSubTab('events')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.3rem 0.75rem',
                borderRadius: '0.25rem',
                border: 'none',
                backgroundColor: activeSubTab === 'events' ? '#4f46e5' : 'transparent',
                color: activeSubTab === 'events' ? '#fff' : '#94a3b8',
                fontWeight: 600,
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
            >
              <Radio size={13} />
              <span>Domain Events ({events.length})</span>
            </button>
            <button
              onClick={() => {
                setActiveSubTab('queue');
                loadQueue();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.3rem 0.75rem',
                borderRadius: '0.25rem',
                border: 'none',
                backgroundColor: activeSubTab === 'queue' ? '#4f46e5' : 'transparent',
                color: activeSubTab === 'queue' ? '#fff' : '#94a3b8',
                fontWeight: 600,
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
            >
              <ListOrdered size={13} />
              <span>Turn Queue ({queueItems.length})</span>
            </button>
          </div>
        </div>

        {/* Stats Summary */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.8rem' }}>
          {stats && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#94a3b8' }}>
              <span>
                Total Events: <strong style={{ color: '#f8fafc' }}>{stats.total_events}</strong>
              </span>
              <span>•</span>
              <span>
                Seq Range:{' '}
                <strong style={{ color: '#818cf8' }}>
                  {stats.first_seq ?? 0}..{stats.last_seq ?? 0}
                </strong>
              </span>
            </div>
          )}

          <button
            onClick={() => {
              loadInitialEvents();
              loadQueue();
            }}
            title="Refresh stream & queue"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              backgroundColor: 'transparent',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#cbd5e1',
              padding: '0.35rem 0.6rem',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={13} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Session Chips Header Bar */}
      <div
        style={{
          padding: '0.5rem 1.5rem',
          backgroundColor: '#131d31',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Registered Sessions:
        </span>
        <SessionChips
          selectedSessionId={selectedSession}
          onSelectSession={(sid) => setSelectedSession(sid)}
        />
        {selectedSession && (
          <button
            onClick={() => setSelectedSession(null)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.2rem',
              backgroundColor: '#ef444420',
              border: '1px solid #ef444440',
              color: '#fca5a5',
              borderRadius: '9999px',
              padding: '0.15rem 0.5rem',
              fontSize: '0.7rem',
              cursor: 'pointer',
            }}
          >
            <span>Filtered by session</span>
            <X size={12} />
          </button>
        )}
      </div>

      {activeSubTab === 'events' ? (
        <>
          {/* Controls & Filter Bar */}
          <div
            style={{
              padding: '0.5rem 1.5rem',
              backgroundColor: '#1e293b',
              borderBottom: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '0.75rem',
            }}
          >
            {/* Search Input */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                padding: '0.3rem 0.6rem',
                gap: '0.5rem',
                width: '240px',
              }}
            >
              <Search size={14} color="#64748b" />
              <input
                type="text"
                placeholder="Search events..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  background: 'none',
                  border: 'none',
                  outline: 'none',
                  color: '#f8fafc',
                  fontSize: '0.8rem',
                  width: '100%',
                }}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 0 }}
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Type Category Pills */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
              {[
                { key: 'all', label: 'All' },
                { key: 'task', label: 'Tasks' },
                { key: 'question', label: 'Questions' },
                { key: 'run', label: 'Runs' },
                { key: 'trigger', label: 'Triggers' },
                { key: 'note', label: 'Inbox' },
                { key: 'config', label: 'Config' },
              ].map((cat) => {
                const isActive = selectedTypeCategory === cat.key;
                return (
                  <button
                    key={cat.key}
                    onClick={() => setSelectedTypeCategory(cat.key)}
                    style={{
                      padding: '0.25rem 0.55rem',
                      borderRadius: '0.25rem',
                      border: isActive ? '1px solid #818cf8' : '1px solid transparent',
                      backgroundColor: isActive ? '#312e81' : '#0f172a',
                      color: isActive ? '#e0e7ff' : '#94a3b8',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>

            {/* Stream Action Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.75rem',
                  color: '#cbd5e1',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Auto-scroll
              </label>

              <button
                onClick={() => setIsPaused(!isPaused)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  padding: '0.25rem 0.55rem',
                  borderRadius: '0.25rem',
                  border: isPaused ? '1px solid #f59e0b' : '1px solid #334155',
                  backgroundColor: isPaused ? '#78350f' : '#0f172a',
                  color: isPaused ? '#fef3c7' : '#94a3b8',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                {isPaused ? <Play size={12} /> : <Pause size={12} />}
                <span>{isPaused ? 'Resume' : 'Pause'}</span>
              </button>

              <button
                onClick={() => setEvents([])}
                style={{
                  padding: '0.25rem 0.55rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #334155',
                  backgroundColor: '#0f172a',
                  color: '#94a3b8',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                Clear View
              </button>
            </div>
          </div>

          {/* Events Stream List */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '1rem 1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
            }}
          >
            {loading && events.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                Loading event stream...
              </div>
            ) : filteredEvents.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                No events match the current filter.
              </div>
            ) : (
              filteredEvents.map((ev) => {
                const isExpanded = expandedEventId === (ev.id || String(ev.seq));
                const color = getTypeColor(ev.type);

                return (
                  <div
                    key={ev.id || `${ev.seq}-${ev.ts}`}
                    style={{
                      borderRadius: '0.375rem',
                      border: '1px solid #1e293b',
                      backgroundColor: '#131d31',
                      overflow: 'hidden',
                      transition: 'border-color 0.15s ease',
                    }}
                  >
                    {/* Event Summary Row */}
                    <div
                      onClick={() =>
                        setExpandedEventId(isExpanded ? null : (ev.id || String(ev.seq)))
                      }
                      style={{
                        padding: '0.5rem 0.8rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        cursor: 'pointer',
                        userSelect: 'none',
                        backgroundColor: isExpanded ? '#1e293b' : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
                        {isExpanded ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}

                        {/* Sequence Badge */}
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#818cf8',
                            backgroundColor: '#312e8140',
                            padding: '0.1rem 0.4rem',
                            borderRadius: '4px',
                            minWidth: '2.5rem',
                            textAlign: 'center',
                          }}
                        >
                          #{ev.seq}
                        </span>

                        {/* Type Badge */}
                        <span
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            color: color,
                            backgroundColor: `${color}15`,
                            border: `1px solid ${color}30`,
                            padding: '0.1rem 0.4rem',
                            borderRadius: '4px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {ev.type}
                        </span>

                        {/* Subject */}
                        {ev.subject && (
                          <span
                            style={{
                              fontSize: '0.8rem',
                              fontWeight: 600,
                              color: '#f8fafc',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {ev.subject}
                          </span>
                        )}

                        {/* Actor / Origin Session */}
                        {(ev.actor || ev.origin_session) && (
                          <span
                            style={{
                              fontSize: '0.72rem',
                              color: '#64748b',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            ({ev.actor || ev.origin_session})
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                        <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
                          {formatAge(ev.ts) || ev.ts}
                        </span>
                      </div>
                    </div>

                    {/* Expandable JSON Detail */}
                    {isExpanded && (
                      <div
                        style={{
                          padding: '0.75rem 1rem',
                          backgroundColor: '#0a0f1d',
                          borderTop: '1px solid #1e293b',
                          fontSize: '0.75rem',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '0.5rem',
                            color: '#94a3b8',
                          }}
                        >
                          <div style={{ display: 'flex', gap: '1rem', fontSize: '0.72rem' }}>
                            <span><strong>ID:</strong> {ev.id}</span>
                            <span><strong>Timestamp:</strong> {ev.ts}</span>
                            {ev.origin_session && <span><strong>Origin Session:</strong> {ev.origin_session}</span>}
                            {ev.actor && <span><strong>Actor:</strong> {ev.actor}</span>}
                          </div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopy(JSON.stringify(ev, null, 2), ev.id);
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem',
                              background: 'none',
                              border: '1px solid #334155',
                              borderRadius: '0.25rem',
                              color: '#94a3b8',
                              padding: '0.15rem 0.4rem',
                              fontSize: '0.7rem',
                              cursor: 'pointer',
                            }}
                          >
                            {copiedId === ev.id ? <Check size={11} color="#10b981" /> : <Copy size={11} />}
                            <span>{copiedId === ev.id ? 'Copied' : 'Copy JSON'}</span>
                          </button>
                        </div>

                        <pre
                          style={{
                            margin: 0,
                            padding: '0.5rem',
                            backgroundColor: '#0f172a',
                            borderRadius: '0.25rem',
                            color: '#cbd5e1',
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            overflowX: 'auto',
                            maxHeight: '260px',
                          }}
                        >
                          {JSON.stringify(ev.data || {}, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div ref={scrollBottomRef} />
          </div>
        </>
      ) : (
        /* Orchestrator Turn Queue View (Spec §0, E6) */
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}
        >
          <div
            style={{
              padding: '1rem',
              backgroundColor: '#1e293b',
              borderRadius: '0.5rem',
              border: '1px solid #334155',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem', fontWeight: 600 }}>
              Durable Orchestrator Turn Queue (Spec §0, E6)
            </h3>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.5 }}>
              Serialized turn requests dispatched to the orchestrator role. Items in the queue are processed under an exclusive lock with atomic claiming, crash recovery, and reduced-capability policy safeguards.
            </p>
          </div>

          {queueLoading && queueItems.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
              Loading queue...
            </div>
          ) : queueItems.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '3rem',
                color: '#64748b',
                backgroundColor: '#131d31',
                borderRadius: '0.5rem',
                border: '1px dashed #334155',
              }}
            >
              <CheckCircle2 size={32} color="#10b981" style={{ marginBottom: '0.5rem' }} />
              <div style={{ fontSize: '0.9rem', color: '#e2e8f0', fontWeight: 600 }}>Queue is idle</div>
              <div style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>No pending turn requests in the orchestrator queue.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {queueItems.map((turn) => {
                const isExpanded = expandedTurnSeq === turn.turn_seq;
                const stateColor =
                  turn.state === 'running'
                    ? '#38bdf8'
                    : turn.state === 'queued'
                    ? '#fbbf24'
                    : turn.state === 'done'
                    ? '#34d399'
                    : '#ef4444';

                return (
                  <div
                    key={turn.turn_seq}
                    style={{
                      borderRadius: '0.375rem',
                      border: '1px solid #334155',
                      backgroundColor: '#131d31',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      onClick={() => setExpandedTurnSeq(isExpanded ? null : turn.turn_seq)}
                      style={{
                        padding: '0.75rem 1rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: 'pointer',
                        backgroundColor: isExpanded ? '#1e293b' : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        {isExpanded ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#818cf8', fontSize: '0.85rem' }}>
                          Turn #{turn.turn_seq}
                        </span>
                        <span
                          style={{
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            color: stateColor,
                            backgroundColor: `${stateColor}15`,
                            border: `1px solid ${stateColor}40`,
                            padding: '0.1rem 0.45rem',
                            borderRadius: '9999px',
                            textTransform: 'uppercase',
                          }}
                        >
                          {turn.state}
                        </span>
                        <span style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                          Type: <strong>{turn.type}</strong>
                        </span>
                        {turn.trigger_rule && (
                          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                            Rule: <span style={{ color: '#f472b6' }}>{turn.trigger_rule}</span>
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.75rem', color: '#64748b' }}>
                        <span>Role: {turn.role}</span>
                        <span>•</span>
                        <span>{formatAge(turn.created_at)}</span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div
                        style={{
                          padding: '1rem',
                          backgroundColor: '#0a0f1d',
                          borderTop: '1px solid #1e293b',
                          fontSize: '0.75rem',
                        }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' }}>
                          <div><strong>Turn ID:</strong> {turn.turn_id}</div>
                          <div><strong>Created:</strong> {turn.created_at}</div>
                          <div><strong>Policy:</strong> {turn.policy}</div>
                          {turn.trigger_event_id && <div><strong>Event ID:</strong> {turn.trigger_event_id}</div>}
                          {turn.trigger_event_seq !== undefined && <div><strong>Event Seq:</strong> #{turn.trigger_event_seq}</div>}
                        </div>

                        {turn.prompt_data && (
                          <div>
                            <div style={{ fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
                              Prompt Data Payload (E3 Untrusted Typed Data):
                            </div>
                            <pre
                              style={{
                                margin: 0,
                                padding: '0.5rem',
                                backgroundColor: '#0f172a',
                                borderRadius: '0.25rem',
                                color: '#cbd5e1',
                                fontFamily: 'monospace',
                                fontSize: '0.75rem',
                                overflowX: 'auto',
                                maxHeight: '200px',
                              }}
                            >
                              {JSON.stringify(turn.prompt_data, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
