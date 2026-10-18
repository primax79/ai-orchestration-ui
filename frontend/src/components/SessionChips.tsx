import React, { useState, useEffect, useCallback } from 'react';
import { Terminal, Bot, User, AlertTriangle, Layers, Radio } from 'lucide-react';
import { OrchestrationSession } from '../types';
import { api } from '../api';

interface SessionChipsProps {
  selectedSessionId?: string | null;
  onSelectSession?: (sessionId: string | null) => void;
  compact?: boolean;
}

export const SessionChips: React.FC<SessionChipsProps> = ({
  selectedSessionId,
  onSelectSession,
  compact = false,
}) => {
  const [sessions, setSessions] = useState<OrchestrationSession[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.getSessions();
      if (res && res.sessions) {
        setSessions(res.sessions);
      }
    } catch {
      // Silently ignore or retain previous sessions
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const getToolIcon = (tool: string) => {
    const t = tool.toLowerCase();
    if (t.includes('claude')) return <Bot size={13} color="#a78bfa" />;
    if (t.includes('kilo')) return <Terminal size={13} color="#38bdf8" />;
    if (t.includes('human')) return <User size={13} color="#34d399" />;
    return <Layers size={13} color="#94a3b8" />;
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

  if (loading && sessions.length === 0) {
    return null;
  }

  if (sessions.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.75rem',
          color: '#64748b',
          fontStyle: 'italic',
        }}
      >
        <Radio size={12} />
        <span>No active sessions</span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        flexWrap: 'wrap',
      }}
    >
      {sessions.map((sess) => {
        const isSelected = selectedSessionId === sess.session_id;
        const isStale = sess.status === 'stale';
        const isActive = sess.status === 'active';
        const shortId = sess.session_id.length > 8 ? sess.session_id.substring(0, 8) : sess.session_id;

        return (
          <button
            key={sess.session_id}
            onClick={() => {
              if (onSelectSession) {
                onSelectSession(isSelected ? null : sess.session_id);
              }
            }}
            title={`Session: ${sess.session_id}\nTool: ${sess.tool}\nRole: ${sess.role || 'none'}\nStatus: ${sess.status}\nLast seen: ${sess.last_seen || '-'}\nCursor: ${sess.cursor ?? 0}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: compact ? '0.15rem 0.45rem' : '0.25rem 0.6rem',
              borderRadius: '9999px',
              border: isSelected ? '1px solid #818cf8' : '1px solid #334155',
              backgroundColor: isSelected ? '#312e81' : '#0f172a',
              color: isSelected ? '#e0e7ff' : '#cbd5e1',
              fontSize: '0.75rem',
              cursor: onSelectSession ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap',
            }}
          >
            {getToolIcon(sess.tool)}

            {sess.role && (
              <span
                style={{
                  fontWeight: 600,
                  color: isSelected ? '#a5b4fc' : '#818cf8',
                }}
              >
                {sess.role}
              </span>
            )}

            <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>
              {shortId}
            </span>

            {/* Status dot / badge */}
            {isActive && (
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: '#10b981',
                  boxShadow: '0 0 4px #10b981',
                  display: 'inline-block',
                }}
              />
            )}

            {isStale && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '2px',
                  backgroundColor: '#78350f',
                  color: '#fde68a',
                  padding: '0.05rem 0.3rem',
                  borderRadius: '4px',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  lineHeight: 1,
                }}
              >
                <AlertTriangle size={10} />
                stale
              </span>
            )}

            {sess.pending_events_count !== undefined && sess.pending_events_count > 0 && (
              <span
                style={{
                  backgroundColor: '#4f46e5',
                  color: '#fff',
                  borderRadius: '10px',
                  padding: '0 0.3rem',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  lineHeight: '1.2',
                }}
              >
                +{sess.pending_events_count}
              </span>
            )}

            {!compact && sess.last_seen && (
              <span style={{ color: '#64748b', fontSize: '0.7rem' }}>
                {formatAge(sess.last_seen)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
