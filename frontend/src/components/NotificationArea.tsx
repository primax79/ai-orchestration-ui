import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  CheckCheck,
  HelpCircle,
  Play,
  Zap,
  Settings,
  Layers,
  X,
  Radio,
} from 'lucide-react';
import { NotificationItem, OrchestrationEvent, shortTitle } from '../types';
import { api, useProjectContext } from '../api';

interface NotificationAreaProps {
  onNavigate?: (tab: 'backlog' | 'decisions' | 'inbox' | 'runs' | 'use-cases' | 'installer' | 'doctor' | 'config' | 'triggers' | 'events') => void;
}

export const NotificationArea: React.FC<NotificationAreaProps> = ({ onNavigate }) => {
  const { selectedProject, fallbackProject } = useProjectContext();
  const targetProject = selectedProject || fallbackProject;

  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [recentEvents, setRecentEvents] = useState<OrchestrationEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The navbar clips its children (overflow: hidden), so the panel is rendered
  // in a portal with a fixed position computed from the bell button.
  const [panelPos, setPanelPos] = useState<{ top: number; right: number; width: number; maxHeight: number } | null>(null);

  const updatePanelPos = useCallback(() => {
    const anchor = dropdownRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + 8;
    const width = Math.min(360, window.innerWidth - 16);
    // Right-align with the bell, but keep 8px from both window edges.
    const right = Math.min(Math.max(8, window.innerWidth - rect.right), window.innerWidth - width - 8);
    setPanelPos({
      top,
      right,
      width,
      maxHeight: Math.max(160, Math.min(480, window.innerHeight - top - 8)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePanelPos();
    window.addEventListener('resize', updatePanelPos);
    window.addEventListener('scroll', updatePanelPos, true);
    return () => {
      window.removeEventListener('resize', updatePanelPos);
      window.removeEventListener('scroll', updatePanelPos, true);
    };
  }, [isOpen, updatePanelPos]);

  const fetchNotifications = useCallback(async () => {
    if (!targetProject) return;
    try {
      const res = await api.getNotifications(targetProject);
      if (res && res.ok) {
        setNotifications(res.notifications || []);
        setRecentEvents(res.recent_events || []);
        setUnreadCount(res.unread_count || 0);
      }
    } catch {
      // Ignore network errors
    }
  }, [targetProject]);

  useEffect(() => {
    if (!targetProject) return;
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 5000);
    return () => clearInterval(interval);
  }, [targetProject, fetchNotifications]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const inAnchor = dropdownRef.current?.contains(target);
      const inPanel = panelRef.current?.contains(target);
      if (!inAnchor && !inPanel) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleMarkAllRead = async () => {
    if (!targetProject) return;
    try {
      await api.markAllNotificationsRead(targetProject);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      // Ignore
    }
  };

  const handleItemClick = (type: string, id?: string) => {
    if (id && targetProject) {
      api.markNotificationRead(id, targetProject).catch(() => {});
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    setIsOpen(false);

    if (!onNavigate) return;
    if (type.startsWith('question')) {
      onNavigate('decisions');
    } else if (type.startsWith('task')) {
      onNavigate('backlog');
    } else if (type.startsWith('run')) {
      onNavigate('runs');
    } else if (type.startsWith('trigger')) {
      onNavigate('triggers');
    } else if (type.startsWith('config')) {
      onNavigate('config');
    } else if (type.startsWith('note') || type.startsWith('inbox')) {
      onNavigate('inbox');
    } else {
      onNavigate('events');
    }
  };

  const formatAge = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diffSec < 60) return `${diffSec}s ago`;
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return `${Math.floor(diffSec / 86400)}d ago`;
    } catch {
      return '';
    }
  };

  const getEventIcon = (type: string) => {
    if (type.startsWith('question')) return <HelpCircle size={15} color="#fbbf24" />;
    if (type.startsWith('task')) return <Layers size={15} color="#60a5fa" />;
    if (type.startsWith('run')) return <Play size={15} color="#34d399" />;
    if (type.startsWith('trigger')) return <Zap size={15} color="#f472b6" />;
    if (type.startsWith('config')) return <Settings size={15} color="#a78bfa" />;
    return <Radio size={15} color="#94a3b8" />;
  };

  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        title="Notifications & Activity"
        aria-label="Notifications & Activity"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          background: 'none',
          border: '1px solid #334155',
          color: unreadCount > 0 ? '#f8fafc' : '#94a3b8',
          backgroundColor: isOpen ? '#334155' : 'transparent',
          borderRadius: '0.375rem',
          padding: '0.35rem',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <Bell size={15} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              backgroundColor: '#ef4444',
              color: '#fff',
              fontSize: '0.65rem',
              fontWeight: 700,
              minWidth: '1rem',
              height: '1rem',
              borderRadius: '9999px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 2px',
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && panelPos && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: panelPos.top,
            right: panelPos.right,
            width: panelPos.width,
            maxHeight: panelPos.maxHeight,
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '0.5rem',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 1rem',
              borderBottom: '1px solid #334155',
              backgroundColor: '#0f172a',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Bell size={15} color="#818cf8" />
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#f8fafc' }}>
                Notifications & Activity
              </span>
              {unreadCount > 0 && (
                <span
                  style={{
                    backgroundColor: '#ef4444',
                    color: '#fff',
                    borderRadius: '9999px',
                    padding: '0.1rem 0.4rem',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                  }}
                >
                  {unreadCount} new
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  title="Mark all as read"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    background: 'none',
                    border: 'none',
                    color: '#818cf8',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                    padding: '0.2rem 0.4rem',
                    borderRadius: '0.25rem',
                  }}
                >
                  <CheckCheck size={13} />
                  <span>Mark read</span>
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  padding: '0.2rem',
                }}
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {/* Body */}
          <div
            style={{
              overflowY: 'auto',
              flex: 1,
              maxHeight: '400px',
            }}
          >
            {notifications.length === 0 && recentEvents.length === 0 ? (
              <div
                style={{
                  padding: '2rem 1rem',
                  textAlign: 'center',
                  color: '#64748b',
                  fontSize: '0.85rem',
                }}
              >
                No recent notifications or events
              </div>
            ) : (
              <div>
                {/* Trigger Notifications */}
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    onClick={() => handleItemClick(n.event_type || 'trigger', n.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      borderBottom: '1px solid #1e293b',
                      backgroundColor: n.read ? 'transparent' : '#1e1b4b25',
                      cursor: 'pointer',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#334155')}
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.backgroundColor = n.read ? 'transparent' : '#1e1b4b25')
                    }
                  >
                    <div style={{ marginTop: '2px', flexShrink: 0 }}>
                      {getEventIcon(n.event_type || 'trigger')}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '0.5rem',
                        }}
                      >
                        <span
                          style={{
                            fontWeight: n.read ? 500 : 700,
                            fontSize: '0.8rem',
                            color: n.read ? '#cbd5e1' : '#f8fafc',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {n.rule || n.event_type || 'Notification'}
                        </span>
                        <span style={{ fontSize: '0.7rem', color: '#64748b', flexShrink: 0 }}>
                          {formatAge(n.created_at)}
                        </span>
                      </div>
                      {n.subject && (
                        <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <span>Subject:</span>
                          <span style={{ color: '#cbd5e1', fontWeight: 600 }}>{n.subject}</span>
                          {(n.data?.short_title || n.data?.title) && (
                            <span style={{ color: '#94a3b8', fontSize: '0.72rem' }} title={n.data.title || n.data.short_title}>
                              ({shortTitle(n.data)})
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {/* Recent Events Section */}
                {recentEvents.length > 0 && (
                  <div>
                    <div
                      style={{
                        padding: '0.4rem 1rem',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: '#64748b',
                        backgroundColor: '#0f172a',
                        borderTop: notifications.length > 0 ? '1px solid #334155' : 'none',
                        borderBottom: '1px solid #334155',
                      }}
                    >
                      Recent Domain Events
                    </div>
                    {recentEvents.slice(0, 15).map((ev) => (
                      <div
                        key={ev.id || `${ev.seq}-${ev.ts}`}
                        onClick={() => handleItemClick(ev.type)}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.75rem',
                          padding: '0.6rem 1rem',
                          borderBottom: '1px solid #1e293b',
                          cursor: 'pointer',
                          transition: 'background 0.15s ease',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#334155')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <div style={{ marginTop: '2px', flexShrink: 0 }}>
                          {getEventIcon(ev.type)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '0.5rem',
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 500,
                                fontSize: '0.8rem',
                                color: '#e2e8f0',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {ev.type}
                            </span>
                            <span style={{ fontSize: '0.7rem', color: '#64748b', flexShrink: 0 }}>
                              {formatAge(ev.ts)}
                            </span>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.5rem',
                              fontSize: '0.72rem',
                              color: '#94a3b8',
                              marginTop: '2px',
                            }}
                          >
                            <span style={{ color: '#818cf8', fontWeight: 600 }}>#{ev.seq}</span>
                            {ev.subject && (
                              <span>
                                {ev.subject}
                                {(ev.data?.short_title || ev.data?.title) && (
                                  <span style={{ color: '#64748b', marginLeft: '0.25rem' }}>
                                    ({shortTitle(ev.data)})
                                  </span>
                                )}
                              </span>
                            )}
                            {ev.actor && <span style={{ color: '#64748b' }}>by {ev.actor}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#0f172a',
              borderTop: '1px solid #334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <button
              onClick={() => {
                setIsOpen(false);
                if (onNavigate) onNavigate('events');
              }}
              style={{
                background: 'none',
                border: 'none',
                color: '#818cf8',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              View Full Event Stream &rarr;
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
