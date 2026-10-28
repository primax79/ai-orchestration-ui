import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Target, Play, Plus, Loader2, RefreshCw, Clock, CheckCircle2, AlertTriangle, RotateCcw, MoreVertical } from 'lucide-react';
import {
  UseCaseItem,
  UseCaseQueueItem,
  UseCaseQueueResponse,
  UseCaseApprovalPayload,
  UseCaseApprovalResponse,
  buildApprovalSummary,
  ValidationCampaignResult,
  ValidationCampaignNotReadyItem,
  TaskItem,
  ALL_USE_CASE_STAGES,
  getUseCaseStage,
  getUseCaseStageStyle,
  getUseCaseApprovalStyle,
} from '../types';
import { UseCaseDetailModal } from './UseCaseDetailModal';
import { ConfirmDialog, ConfirmDialogPreviewData } from './ConfirmDialog';
import { api, useProject } from '../api';

interface UseCasesManagerProps {
  onRefresh: () => void;
  tasks?: TaskItem[];
  onSelectTask?: (taskId: string) => void;
}

export const UseCasesManager: React.FC<UseCasesManagerProps> = ({
  onRefresh,
  tasks = [],
  onSelectTask,
}) => {
  const targetProject = useProject();
  const [useCases, setUseCases] = useState<UseCaseItem[]>([]);
  const [queueItems, setQueueItems] = useState<UseCaseQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUc, setSelectedUc] = useState<UseCaseItem | null>(null);
  const [runningCampaign, setRunningCampaign] = useState(false);
  const [campaignReport, setCampaignReport] = useState<ValidationCampaignResult | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [approvalFilter, setApprovalFilter] = useState<string>('all');
  const [activeView, setActiveView] = useState<'all' | 'queue'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Selection and approval state
  const [selectedUcIds, setSelectedUcIds] = useState<Set<string>>(new Set());
  const [openMenuUcId, setOpenMenuUcId] = useState<string | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalConfirmData, setApprovalConfirmData] = useState<{
    payload: UseCaseApprovalPayload;
    title: string;
    preview: UseCaseApprovalResponse;
  } | null>(null);

  // Close card menu on outside click
  useEffect(() => {
    const handleWindowClick = () => setOpenMenuUcId(null);
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, []);

  // 409 Not Ready confirmation state for card/queue quick-validate
  const [quickForceConfirm, setQuickForceConfirm] = useState<{
    ucId: string;
    title: string;
    message: string;
  } | null>(null);

  // New Use Case form state
  const [newId, setNewId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newActor, setNewActor] = useState('End-User');
  const [newApproval, setNewApproval] = useState<'proposed' | 'approved' | 'deprecated'>('proposed');
  const [newPriority, setNewPriority] = useState('P1');
  const [newLinkedTasks, setNewLinkedTasks] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newScenario, setNewScenario] = useState('');
  const [creating, setCreating] = useState(false);

  const loadUseCasesAndQueue = useCallback(async () => {
    if (!targetProject) return;
    setLoading(true);
    try {
      const [ucData, qData] = await Promise.all([
        api.getUseCases('all', targetProject),
        api.getUseCaseQueue(targetProject).catch((): UseCaseQueueResponse => ({ ok: true, count: 0, queue: [] })),
      ]);
      const list: UseCaseItem[] = ucData.use_cases || [];
      setUseCases(list);
      setQueueItems(qData.queue || qData.use_cases || qData.items || []);
      setSelectedUc((prev) => {
        if (!prev) return null;
        return list.find((u) => u.id === prev.id) || prev;
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [targetProject]);

  useEffect(() => {
    if (targetProject) {
      loadUseCasesAndQueue();
    }
  }, [targetProject, loadUseCasesAndQueue]);

  // Listen for WebSocket updates on use_cases_changed or tasks
  useEffect(() => {
    const unsub = api.subscribeWebSocket((msg) => {
      if (
        msg.type === 'use_cases_changed' ||
        msg.type === 'task_transitioned' ||
        msg.type === 'tasks_changed' ||
        (msg.type === 'changed' && Array.isArray(msg.areas) && msg.areas.includes('tasks'))
      ) {
        loadUseCasesAndQueue();
      }
    });
    return () => unsub();
  }, [loadUseCasesAndQueue]);

  const handleQuickValidate = async (e: React.MouseEvent | null, ucId: string, ucTitle?: string, force = false) => {
    if (e) e.stopPropagation();
    setValidatingId(ucId);
    try {
      await api.validateUseCase(ucId, { timeout: 60, force: force || undefined }, targetProject);
      setQuickForceConfirm(null);
      await loadUseCasesAndQueue();
      onRefresh();
    } catch (err: any) {
      const status = err?.status;
      const errData = err?.data;
      const msg = errData?.error || errData?.message || err?.message || String(err);
      if (status === 409 || errData?.reason === 'not_ready' || String(msg).toLowerCase().includes('not ready')) {
        const foundUc = useCases.find((u) => u.id === ucId);
        setQuickForceConfirm({
          ucId,
          title: ucTitle || foundUc?.title || ucId,
          message: msg,
        });
      } else {
        alert(`Validation error: ${msg}`);
      }
    } finally {
      setValidatingId(null);
    }
  };

  const handleRunCampaign = async () => {
    setRunningCampaign(true);
    setCampaignReport(null);
    try {
      const res = await api.runValidationCampaign({ timeout: 60 }, targetProject);
      setCampaignReport(res);
      await loadUseCasesAndQueue();
      onRefresh();
    } catch (err: any) {
      alert(`Campaign error: ${err.message}`);
    } finally {
      setRunningCampaign(false);
    }
  };

  const handleCreateUseCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle) {
      alert('Title is required');
      return;
    }
    setCreating(true);
    try {
      await api.createUseCase({
        // Empty id: the engine assigns the next free UC### on save.
        id: newId.trim(),
        title: newTitle,
        actor: newActor,
        approval: newApproval,
        priority: newPriority as any,
        linked_tasks: newLinkedTasks ? newLinkedTasks.split(',').map((t) => t.trim()).filter(Boolean) : [],
        verification_command: newCommand,
        description: newDesc,
        scenario: newScenario,
      }, targetProject);
      setShowCreateModal(false);
      setNewId('');
      setNewTitle('');
      await loadUseCasesAndQueue();
      onRefresh();
    } catch (err: any) {
      alert(`Create error: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleTriggerApproval = async (payload: UseCaseApprovalPayload, title: string) => {
    setApprovalLoading(true);
    try {
      const res = await api.previewUseCaseApproval(payload, targetProject);
      setApprovalConfirmData({
        payload,
        title,
        preview: res,
      });
    } catch (e: any) {
      alert(`Approval preview failed: ${e?.message || e}`);
    } finally {
      setApprovalLoading(false);
    }
  };

  const handleApplyApproval = async (planHash?: string) => {
    if (!approvalConfirmData) return;
    const { payload } = approvalConfirmData;
    await api.applyUseCaseApproval(
      {
        ...payload,
        expect_plan_hash: planHash,
      },
      targetProject
    );
    setApprovalConfirmData(null);
    setSelectedUcIds(new Set());
    await loadUseCasesAndQueue();
    onRefresh();
  };

  const handleRefetchApprovalPreview = async (): Promise<ConfirmDialogPreviewData> => {
    if (!approvalConfirmData) return {};
    const res = await api.previewUseCaseApproval(approvalConfirmData.payload, targetProject);
    setApprovalConfirmData((prev) => (prev ? { ...prev, preview: res } : null));
    return {
      summary: buildApprovalSummary(res),
      plan: res.plan,
      diff: res.diff,
      hash: res.plan_hash,
    };
  };

  // Counts per stage across all use cases
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const st of ALL_USE_CASE_STAGES) {
      counts[st] = 0;
    }
    for (const uc of useCases) {
      const st = getUseCaseStage(uc);
      counts[st] = (counts[st] || 0) + 1;
    }
    return counts;
  }, [useCases]);

  // Approval counts
  const approvalCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: useCases.length,
      approved: 0,
      proposed: 0,
      deprecated: 0,
    };
    for (const uc of useCases) {
      const app = (uc.approval || 'proposed').toLowerCase();
      counts[app] = (counts[app] || 0) + 1;
    }
    return counts;
  }, [useCases]);

  // Filtered use cases by stage and approval
  const filteredUseCases = useMemo(() => {
    return useCases.filter((uc) => {
      const st = getUseCaseStage(uc);
      const app = (uc.approval || 'proposed').toLowerCase();
      if (stageFilter !== 'all' && st !== stageFilter) return false;
      if (approvalFilter !== 'all' && app !== approvalFilter) return false;
      return true;
    });
  }, [useCases, stageFilter, approvalFilter]);

  // Campaign breakdown helpers
  const campaignSummary = useMemo(() => {
    if (!campaignReport) return null;
    const passed = campaignReport.passed ?? 0;
    const failed = campaignReport.failed ?? 0;
    const evaluated = campaignReport.evaluated ?? (passed + failed);
    const untestedCount = Array.isArray(campaignReport.untested)
      ? campaignReport.untested.length
      : typeof campaignReport.untested === 'number'
      ? campaignReport.untested
      : (campaignReport.results || []).filter((r: any) => r.verdict === 'untested' || r.stage === 'untested').length;
    const inScopeCount =
      campaignReport.in_scope !== undefined
        ? campaignReport.in_scope
        : campaignReport.total !== undefined
        ? campaignReport.total
        : evaluated + untestedCount;

    const notReadyList: ValidationCampaignNotReadyItem[] = Array.isArray(campaignReport.not_ready)
      ? campaignReport.not_ready
      : [];
    const notReadyCount =
      typeof campaignReport.not_ready_count === 'number'
        ? campaignReport.not_ready_count
        : typeof campaignReport.not_ready === 'number'
        ? campaignReport.not_ready
        : notReadyList.length;

    const untestedItems = Array.isArray(campaignReport.untested)
      ? campaignReport.untested
      : (campaignReport.results || []).filter((r: any) => r.verdict === 'untested' || r.stage === 'untested');

    const inScopeItems = (campaignReport.results || []).filter(
      (r: any) => r.verdict !== 'untested' && r.stage !== 'untested'
    );

    const score = campaignReport.readiness_score ?? 0;
    const inScopeScore = campaignReport.readiness_score_in_scope;

    return {
      passed,
      failed,
      evaluated,
      untestedCount,
      untestedItems,
      inScopeCount,
      inScopeItems,
      notReadyList,
      notReadyCount,
      score,
      inScopeScore,
    };
  }, [campaignReport]);

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1300px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Target size={24} color="#818cf8" />
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
              Use Cases & Autonomous AI Validation
            </h1>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem', marginBottom: 0 }}>
            End-to-end user scenarios, lifecycle stages, approval status, and automated product verification gates.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* View Toggle: All Use Cases vs Revalidation Queue */}
          <div style={{ display: 'flex', backgroundColor: '#1e293b', padding: '0.2rem', borderRadius: '0.375rem', border: '1px solid #334155' }}>
            <button
              type="button"
              onClick={() => setActiveView('all')}
              style={{
                padding: '0.3rem 0.7rem',
                borderRadius: '0.25rem',
                border: 'none',
                backgroundColor: activeView === 'all' ? '#4f46e5' : 'transparent',
                color: activeView === 'all' ? '#fff' : '#94a3b8',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Use Cases ({useCases.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveView('queue')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.3rem 0.7rem',
                borderRadius: '0.25rem',
                border: 'none',
                backgroundColor: activeView === 'queue' ? '#4f46e5' : 'transparent',
                color: activeView === 'queue' ? '#fff' : queueItems.length > 0 ? '#fde68a' : '#94a3b8',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <RefreshCw size={13} />
              <span>Revalidation Queue ({queueItems.length})</span>
            </button>
          </div>

          <button
            onClick={() => setShowCreateModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.45rem 0.9rem',
              borderRadius: '0.375rem',
              border: '1px solid #334155',
              backgroundColor: '#1e293b',
              color: '#e2e8f0',
              fontSize: '0.85rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <Plus size={16} />
            <span>New Use Case</span>
          </button>

          <button
            onClick={handleRunCampaign}
            disabled={runningCampaign}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.9rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: '#4f46e5',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 4px 6px -1px rgba(79, 70, 229, 0.3)',
            }}
          >
            {runningCampaign ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
            <span>{runningCampaign ? 'Testing Product...' : 'Run Product Validation Campaign'}</span>
          </button>
        </div>
      </div>

      {/* Counts per Stage in Header Strip */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.6rem 0.85rem',
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.5rem',
        marginBottom: '1.25rem',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginRight: '0.25rem' }}>
          Stages:
        </span>
        {ALL_USE_CASE_STAGES.map((st) => {
          const stStyle = getUseCaseStageStyle(st);
          const count = stageCounts[st] || 0;
          const isSelected = stageFilter === st;
          return (
            <button
              key={st}
              type="button"
              onClick={() => {
                setActiveView('all');
                setStageFilter(stageFilter === st ? 'all' : st);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.2rem 0.55rem',
                borderRadius: '1rem',
                backgroundColor: isSelected ? stStyle.bg : '#0f172a',
                color: stStyle.color,
                border: `1px solid ${isSelected ? stStyle.color : stStyle.border}`,
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                opacity: count === 0 && !isSelected ? 0.65 : 1,
              }}
              title={`Filter by stage: ${st} (${count})`}
            >
              <span>{stStyle.label}</span>
              <span style={{
                backgroundColor: 'rgba(15, 23, 42, 0.6)',
                padding: '0.05rem 0.35rem',
                borderRadius: '0.75rem',
                fontSize: '0.7rem',
                fontWeight: 700,
                color: '#f8fafc',
              }}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Campaign Result Banner */}
      {campaignReport && campaignSummary && (
        <div style={{
          backgroundColor: '#0f172a',
          border: '1px solid #4f46e5',
          borderRadius: '0.5rem',
          padding: '1.25rem',
          marginBottom: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.9rem',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                Product Validation Campaign Result ({campaignReport.timestamp})
              </h3>
              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                Report written to: <code>{campaignReport.report_file}</code>
              </div>
            </div>
            <div style={{
              backgroundColor: '#1e293b',
              border: '1px solid #4f46e5',
              borderRadius: '0.5rem',
              padding: '0.5rem 0.85rem',
              textAlign: 'right',
            }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#818cf8' }}>
                Readiness Score: {campaignSummary.score}%
              </div>
              <div style={{ fontSize: '0.72rem', color: '#cbd5e1', fontFamily: 'monospace', marginTop: '0.15rem' }}>
                Formula: passed / evaluated = {campaignSummary.passed} / {campaignSummary.evaluated} ({campaignSummary.score}%)
              </div>
              {campaignSummary.inScopeScore !== undefined && (
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', fontFamily: 'monospace', marginTop: '0.1rem' }}>
                  In-scope formula: passed / in_scope = {campaignSummary.passed} / {campaignSummary.inScopeCount} ({campaignSummary.inScopeScore}%)
                </div>
              )}
            </div>
          </div>

          {/* 3-Column Breakdown: In-Scope, Not Ready (N/M, stage), Untested */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.85rem' }}>
            {/* In-Scope Box */}
            <div style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.85rem',
            }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#e2e8f0', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                In-Scope ({campaignSummary.inScopeCount})
              </div>
              <div style={{ fontSize: '0.82rem', color: '#cbd5e1', marginBottom: '0.5rem' }}>
                Evaluated: <strong>{campaignSummary.evaluated}</strong> —{' '}
                <strong style={{ color: '#10b981' }}>{campaignSummary.passed} Passed</strong>,{' '}
                <strong style={{ color: '#ef4444' }}>{campaignSummary.failed} Failed</strong>
                {campaignReport.regressions_count > 0 && (
                  <span>
                    , Regressions: <strong style={{ color: '#f59e0b' }}>{campaignReport.regressions_count}</strong>
                  </span>
                )}
              </div>
              {campaignSummary.inScopeItems.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: '130px', overflowY: 'auto' }}>
                  {campaignSummary.inScopeItems.map((r: any) => (
                    <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', padding: '0.2rem 0.4rem', backgroundColor: '#0f172a', borderRadius: '0.25rem' }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#818cf8' }}>
                        {r.id} <span style={{ fontFamily: 'sans-serif', fontWeight: 400, color: '#cbd5e1' }}>{r.title || ''}</span>
                      </span>
                      <span style={{
                        fontWeight: 700,
                        color: r.verdict === 'pass' ? '#34d399' : '#fca5a5',
                        textTransform: 'uppercase',
                        fontSize: '0.7rem',
                      }}>
                        {r.verdict}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Not Ready Box (N/M, stage) */}
            <div style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.85rem',
            }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                Not Ready ({campaignSummary.notReadyCount})
              </div>
              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                Excluded from readiness evaluation because linked tasks or approval are not complete:
              </div>
              {campaignSummary.notReadyList.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', maxHeight: '130px', overflowY: 'auto' }}>
                  {campaignSummary.notReadyList.map((nr) => {
                    const stStyle = getUseCaseStageStyle(nr.stage);
                    const progressStr = nr.progress || `${nr.tasks_done ?? 0}/${nr.tasks_total ?? 0}`;
                    return (
                      <div
                        key={nr.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '0.4rem',
                          fontSize: '0.75rem',
                          padding: '0.25rem 0.45rem',
                          backgroundColor: '#0f172a',
                          borderRadius: '0.25rem',
                        }}
                      >
                        <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#818cf8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {nr.id} <span style={{ fontFamily: 'sans-serif', fontWeight: 400, color: '#cbd5e1' }}>{nr.title || ''}</span>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                          <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: '#cbd5e1', backgroundColor: '#1e293b', padding: '0.05rem 0.3rem', borderRadius: '0.2rem' }}>
                            {progressStr}
                          </span>
                          <span style={{
                            fontSize: '0.68rem',
                            fontWeight: 600,
                            padding: '0.05rem 0.35rem',
                            borderRadius: '0.75rem',
                            backgroundColor: stStyle.bg,
                            color: stStyle.color,
                            border: `1px solid ${stStyle.border}`,
                          }}>
                            {nr.stage || 'not ready'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: '0.75rem', color: '#64748b', fontStyle: 'italic' }}>
                  None ({campaignSummary.notReadyCount} not ready)
                </div>
              )}
            </div>

            {/* Untested Box */}
            <div style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.85rem',
            }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#d8b4fe', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                Untested ({campaignSummary.untestedCount})
              </div>
              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                Ready use cases without an automated verification probe command:
              </div>
              {campaignSummary.untestedItems.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: '130px', overflowY: 'auto' }}>
                  {campaignSummary.untestedItems.map((u: any) => (
                    <div
                      key={u.id || String(u)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '0.75rem',
                        padding: '0.2rem 0.4rem',
                        backgroundColor: '#0f172a',
                        borderRadius: '0.25rem',
                      }}
                    >
                      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#818cf8' }}>
                        {typeof u === 'string' ? u : u.id}{' '}
                        {typeof u === 'object' && u.title && (
                          <span style={{ fontFamily: 'sans-serif', fontWeight: 400, color: '#cbd5e1' }}>{u.title}</span>
                        )}
                      </span>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#d8b4fe' }}>untested</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '0.75rem', color: '#64748b', fontStyle: 'italic' }}>
                  {campaignSummary.untestedCount === 0 ? 'None' : `${campaignSummary.untestedCount} untested`}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Revalidation Queue Panel/Tab */}
      {activeView === 'queue' || queueItems.length > 0 ? (
        <div style={{
          backgroundColor: '#1e293b',
          border: `1px solid ${queueItems.length > 0 ? '#d97706' : '#334155'}`,
          borderRadius: '0.5rem',
          padding: '1rem 1.25rem',
          marginBottom: '1.5rem',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <RefreshCw size={17} color="#fbbf24" />
              <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                Revalidation Queue ({queueItems.length})
              </h2>
              <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                Use cases flagged for revalidation after linked task delivery
              </span>
            </div>
          </div>

          {queueItems.length === 0 ? (
            <div style={{ padding: '1rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
              No use cases currently pending revalidation.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {queueItems.map((item) => {
                const ucId = item.id || item.use_case_id || '';
                const isVal = validatingId === ucId;
                const trigTask = item.triggering_task || (item as any).task_id || (item as any).trigger_task;
                const dateStr = item.date || (item as any).triggering_date || item.requested_at || item.last_tested || '—';
                const stStyle = getUseCaseStageStyle(item.stage || 'ready (revalidation pending)');

                return (
                  <div
                    key={ucId}
                    onClick={() => {
                      const found = useCases.find((u) => u.id === ucId);
                      if (found) setSelectedUc(found);
                    }}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.65rem 0.9rem',
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '0.375rem',
                      cursor: 'pointer',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', minWidth: 0 }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.12rem 0.4rem', borderRadius: '0.2rem', backgroundColor: '#4f46e5', color: '#fff', fontFamily: 'monospace' }}>
                        {ucId}
                      </span>
                      <span style={{ fontSize: '0.88rem', fontWeight: 600, color: '#f8fafc' }}>
                        {item.title}
                      </span>
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        padding: '0.1rem 0.45rem',
                        borderRadius: '1rem',
                        backgroundColor: stStyle.bg,
                        color: stStyle.color,
                        border: `1px solid ${stStyle.border}`,
                      }}>
                        {stStyle.label}
                      </span>
                      {trigTask && (
                        <span
                          onClick={(e) => {
                            if (onSelectTask) {
                              e.stopPropagation();
                              onSelectTask(trigTask);
                            }
                          }}
                          style={{
                            fontSize: '0.75rem',
                            color: '#818cf8',
                            backgroundColor: '#1e293b',
                            border: '1px solid #334155',
                            padding: '0.1rem 0.45rem',
                            borderRadius: '0.25rem',
                            textDecoration: onSelectTask ? 'underline' : 'none',
                            cursor: onSelectTask ? 'pointer' : 'default',
                          }}
                          title="Triggering task"
                        >
                          Triggering task: <strong>{trigTask}</strong>
                        </span>
                      )}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                        <Clock size={12} />
                        <span>Date: {dateStr}</span>
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => handleQuickValidate(e, ucId, item.title)}
                      disabled={isVal}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.3rem 0.65rem',
                        borderRadius: '0.25rem',
                        border: 'none',
                        backgroundColor: '#4f46e5',
                        color: '#fff',
                        fontWeight: 600,
                        fontSize: '0.75rem',
                        cursor: isVal ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isVal ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                      <span>{isVal ? 'Validating...' : 'Validate'}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* Filter Bar (Stage + Approval) */}
      {activeView === 'all' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            {/* Stage Filter */}
            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginRight: '0.2rem' }}>
                Stage:
              </span>
              <button
                type="button"
                onClick={() => setStageFilter('all')}
                style={{
                  padding: '0.25rem 0.65rem',
                  borderRadius: '0.25rem',
                  border: 'none',
                  backgroundColor: stageFilter === 'all' ? '#4f46e5' : '#1e293b',
                  color: stageFilter === 'all' ? '#fff' : '#94a3b8',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                All ({useCases.length})
              </button>
              {ALL_USE_CASE_STAGES.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStageFilter(st)}
                  style={{
                    padding: '0.25rem 0.65rem',
                    borderRadius: '0.25rem',
                    border: 'none',
                    backgroundColor: stageFilter === st ? '#4f46e5' : '#1e293b',
                    color: stageFilter === st ? '#fff' : '#94a3b8',
                    fontSize: '0.78rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {st} ({stageCounts[st] || 0})
                </button>
              ))}
            </div>

            {/* Approval Filter */}
            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', marginRight: '0.2rem' }}>
                Approval:
              </span>
              {(['all', 'approved', 'proposed', 'deprecated'] as const).map((app) => (
                <button
                  key={app}
                  type="button"
                  onClick={() => setApprovalFilter(app)}
                  style={{
                    padding: '0.25rem 0.65rem',
                    borderRadius: '0.25rem',
                    border: 'none',
                    backgroundColor: approvalFilter === app ? '#4f46e5' : '#1e293b',
                    color: approvalFilter === app ? '#fff' : '#94a3b8',
                    fontSize: '0.78rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {app} ({approvalCounts[app] || 0})
                </button>
              ))}
            </div>
          </div>

          {/* Selection & Approval Bulk Actions Bar */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
            padding: '0.6rem 0.9rem',
            backgroundColor: '#1e293b',
            borderRadius: '0.375rem',
            border: '1px solid #334155',
            flexWrap: 'wrap',
            gap: '0.75rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.82rem', color: '#cbd5e1', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={filteredUseCases.length > 0 && filteredUseCases.every((u) => selectedUcIds.has(u.id))}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedUcIds((prev) => {
                        const next = new Set(prev);
                        filteredUseCases.forEach((u) => next.add(u.id));
                        return next;
                      });
                    } else {
                      setSelectedUcIds((prev) => {
                        const next = new Set(prev);
                        filteredUseCases.forEach((u) => next.delete(u.id));
                        return next;
                      });
                    }
                  }}
                  style={{ cursor: 'pointer', width: '15px', height: '15px', accentColor: '#4f46e5' }}
                />
                <span>Select all shown ({filteredUseCases.length})</span>
              </label>

              {selectedUcIds.size > 0 && (
                <span style={{ fontSize: '0.8rem', color: '#818cf8', fontWeight: 600 }}>
                  {selectedUcIds.size} selected
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {selectedUcIds.size > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      handleTriggerApproval(
                        { action: 'approve', ids: Array.from(selectedUcIds) },
                        `Approve Selected Use Cases (${selectedUcIds.size})`
                      );
                    }}
                    disabled={approvalLoading}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.75rem',
                      borderRadius: '0.25rem',
                      border: '1px solid #059669',
                      backgroundColor: '#065f46',
                      color: '#fff',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: approvalLoading ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <CheckCircle2 size={14} />
                    <span>Approve selected ({selectedUcIds.size})</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSelectedUcIds(new Set())}
                    style={{
                      padding: '0.35rem 0.65rem',
                      borderRadius: '0.25rem',
                      border: '1px solid #475569',
                      backgroundColor: 'transparent',
                      color: '#94a3b8',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    Clear selection
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => {
                  const payload: UseCaseApprovalPayload = {
                    action: 'approve',
                    stage: stageFilter !== 'all' ? stageFilter : undefined,
                    approval: approvalFilter !== 'all' ? approvalFilter : undefined,
                    all: stageFilter === 'all' && approvalFilter === 'all' ? true : undefined,
                  };
                  const filterLabel = [
                    stageFilter !== 'all' ? `stage: ${stageFilter}` : null,
                    approvalFilter !== 'all' ? `approval: ${approvalFilter}` : null,
                  ].filter(Boolean).join(', ');
                  const title = filterLabel ? `Approve All Shown Use Cases (${filterLabel})` : 'Approve All Use Cases';
                  handleTriggerApproval(payload, title);
                }}
                disabled={approvalLoading || filteredUseCases.length === 0}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.35rem 0.75rem',
                  borderRadius: '0.25rem',
                  border: '1px solid #4f46e5',
                  backgroundColor: '#4338ca',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: (approvalLoading || filteredUseCases.length === 0) ? 'not-allowed' : 'pointer',
                  opacity: filteredUseCases.length === 0 ? 0.6 : 1,
                }}
              >
                <CheckCircle2 size={14} />
                <span>Approve all shown ({filteredUseCases.length})</span>
              </button>
            </div>
          </div>

          {/* Use Cases Grid */}
          {loading ? (
            <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>Loading use cases...</div>
          ) : filteredUseCases.length === 0 ? (
            <div style={{ backgroundColor: '#1e293b', borderRadius: '0.5rem', border: '1px solid #334155', padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>
              No use cases match the selected filters.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '1rem' }}>
              {filteredUseCases.map((uc) => {
                const isVal = validatingId === uc.id;
                const stage = getUseCaseStage(uc);
                const stageStyle = getUseCaseStageStyle(stage);
                const approval = uc.approval || 'proposed';
                const approvalStyle = getUseCaseApprovalStyle(approval);

                const rawDetails = uc.linked_tasks_details || [];
                const nonDropped = rawDetails.filter((t) => !t.dropped && (t.canonical_state || t.state) !== 'dropped');
                const doneTasks = nonDropped.filter((t) => {
                  const s = (t.canonical_state || t.state || '').toLowerCase();
                  return s === 'done' || s === 'done with a caveat' || s === 'verified';
                }).length;
                const totalTasks = rawDetails.length > 0 ? nonDropped.length : (uc.linked_tasks?.length || 0);

                return (
                  <div
                    key={uc.id}
                    onClick={() => setSelectedUc(uc)}
                    style={{
                      backgroundColor: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: '0.5rem',
                      padding: '1.25rem',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                      transition: 'border-color 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#6366f1')}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#334155')}
                  >
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem', flexWrap: 'wrap', gap: '0.35rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <input
                            type="checkbox"
                            checked={selectedUcIds.has(uc.id)}
                            onChange={(e) => {
                              e.stopPropagation();
                              setSelectedUcIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(uc.id)) next.delete(uc.id);
                                else next.add(uc.id);
                                return next;
                              });
                            }}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', width: '15px', height: '15px', accentColor: '#4f46e5', marginRight: '0.1rem' }}
                            title={`Select ${uc.id}`}
                          />
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: '#4f46e5', color: '#fff' }}>
                            {uc.id}
                          </span>
                          {/* Stage Badge */}
                          <span style={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            padding: '0.12rem 0.45rem',
                            borderRadius: '1rem',
                            backgroundColor: stageStyle.bg,
                            color: stageStyle.color,
                            border: `1px solid ${stageStyle.border}`,
                          }}>
                            {stageStyle.label}
                          </span>
                          {/* Approval Badge shown when not 'approved' */}
                          {approval !== 'approved' && (
                            <span style={{
                              fontSize: '0.68rem',
                              fontWeight: 700,
                              padding: '0.1rem 0.4rem',
                              borderRadius: '0.2rem',
                              backgroundColor: approvalStyle.bg,
                              color: approvalStyle.color,
                              border: `1px solid ${approvalStyle.border}`,
                              textTransform: 'uppercase',
                            }}>
                              {approvalStyle.label}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Actor: <strong>{uc.actor}</strong></span>
                          {/* Card Action Menu */}
                          <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuUcId(openMenuUcId === uc.id ? null : uc.id);
                              }}
                              title="Use case actions"
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#94a3b8',
                                cursor: 'pointer',
                                padding: '0.15rem',
                                borderRadius: '0.25rem',
                                display: 'flex',
                                alignItems: 'center',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
                              onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
                            >
                              <MoreVertical size={16} />
                            </button>
                            {openMenuUcId === uc.id && (
                              <div
                                style={{
                                  position: 'absolute',
                                  right: 0,
                                  top: '100%',
                                  marginTop: '0.25rem',
                                  backgroundColor: '#0f172a',
                                  border: '1px solid #334155',
                                  borderRadius: '0.375rem',
                                  boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)',
                                  zIndex: 30,
                                  minWidth: '160px',
                                  overflow: 'hidden',
                                }}
                              >
                                <button
                                  type="button"
                                  disabled={approval === 'approved'}
                                  onClick={() => {
                                    setOpenMenuUcId(null);
                                    handleTriggerApproval({ action: 'approve', ids: [uc.id] }, `Approve Use Case ${uc.id}`);
                                  }}
                                  style={{
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    padding: '0.5rem 0.75rem',
                                    border: 'none',
                                    backgroundColor: 'transparent',
                                    color: approval === 'approved' ? '#64748b' : '#34d399',
                                    fontSize: '0.8rem',
                                    fontWeight: 500,
                                    textAlign: 'left',
                                    cursor: approval === 'approved' ? 'default' : 'pointer',
                                  }}
                                  onMouseEnter={(e) => {
                                    if (approval !== 'approved') e.currentTarget.style.backgroundColor = '#1e293b';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }}
                                >
                                  <CheckCircle2 size={13} />
                                  <span>Approve</span>
                                </button>

                                <button
                                  type="button"
                                  disabled={approval === 'deprecated'}
                                  onClick={() => {
                                    setOpenMenuUcId(null);
                                    handleTriggerApproval({ action: 'deprecate', ids: [uc.id] }, `Deprecate Use Case ${uc.id}`);
                                  }}
                                  style={{
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    padding: '0.5rem 0.75rem',
                                    border: 'none',
                                    backgroundColor: 'transparent',
                                    color: approval === 'deprecated' ? '#64748b' : '#f87171',
                                    fontSize: '0.8rem',
                                    fontWeight: 500,
                                    textAlign: 'left',
                                    cursor: approval === 'deprecated' ? 'default' : 'pointer',
                                  }}
                                  onMouseEnter={(e) => {
                                    if (approval !== 'deprecated') e.currentTarget.style.backgroundColor = '#1e293b';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }}
                                >
                                  <AlertTriangle size={13} />
                                  <span>Deprecate</span>
                                </button>

                                <button
                                  type="button"
                                  disabled={approval === 'proposed'}
                                  onClick={() => {
                                    setOpenMenuUcId(null);
                                    handleTriggerApproval({ action: 'propose', ids: [uc.id] }, `Move Use Case ${uc.id} Back to Proposed`);
                                  }}
                                  style={{
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    padding: '0.5rem 0.75rem',
                                    border: 'none',
                                    backgroundColor: 'transparent',
                                    color: approval === 'proposed' ? '#64748b' : '#cbd5e1',
                                    fontSize: '0.8rem',
                                    fontWeight: 500,
                                    textAlign: 'left',
                                    cursor: approval === 'proposed' ? 'default' : 'pointer',
                                  }}
                                  onMouseEnter={(e) => {
                                    if (approval !== 'proposed') e.currentTarget.style.backgroundColor = '#1e293b';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }}
                                >
                                  <RotateCcw size={13} />
                                  <span>Back to proposed</span>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#f8fafc', lineHeight: 1.3, marginBottom: '0.35rem' }}>
                        {uc.title}
                      </h3>

                      {uc.description && (
                        <p style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: 0 }}>
                          {uc.description}
                        </p>
                      )}
                    </div>

                    <div>
                      {/* Linked Tasks Pills & Progress */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.35rem' }}>
                        {uc.linked_tasks && uc.linked_tasks.length > 0 ? (
                          <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                            {uc.linked_tasks.map((tid) => (
                              <span
                                key={tid}
                                onClick={(e) => {
                                  if (onSelectTask) {
                                    e.stopPropagation();
                                    onSelectTask(tid);
                                  }
                                }}
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '0.1rem 0.35rem',
                                  borderRadius: '0.2rem',
                                  backgroundColor: '#0f172a',
                                  color: '#818cf8',
                                  border: '1px solid #334155',
                                  textDecoration: onSelectTask ? 'underline' : 'none',
                                }}
                              >
                                Task {tid}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ fontSize: '0.7rem', color: '#64748b', fontStyle: 'italic' }}>No linked tasks</span>
                        )}
                        {totalTasks > 0 && (
                          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: doneTasks === totalTasks ? '#34d399' : '#94a3b8' }}>
                            {doneTasks}/{totalTasks} done
                          </span>
                        )}
                      </div>

                      {/* Footer Bar */}
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingTop: '0.6rem',
                        borderTop: '1px solid #334155',
                        fontSize: '0.75rem',
                      }}>
                        <span style={{ color: '#64748b' }}>
                          Tested: {uc.last_tested || 'Never'} {uc.last_verdict ? `(${uc.last_verdict})` : ''}
                        </span>

                        <button
                          onClick={(e) => handleQuickValidate(e, uc.id, uc.title)}
                          disabled={isVal}
                          title="Validate this Use Case autonomously"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.25rem 0.55rem',
                            borderRadius: '0.25rem',
                            border: 'none',
                            backgroundColor: '#4f46e5',
                            color: '#fff',
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontSize: '0.75rem',
                          }}
                        >
                          {isVal ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                          <span>{isVal ? 'Testing...' : 'Validate'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Detail Modal */}
      {selectedUc && (
        <UseCaseDetailModal
          useCase={selectedUc}
          tasks={tasks}
          onSelectTask={
            onSelectTask
              ? (tid) => {
                  setSelectedUc(null);
                  onSelectTask(tid);
                }
              : undefined
          }
          onClose={() => setSelectedUc(null)}
          onRefresh={() => {
            loadUseCasesAndQueue();
            onRefresh();
          }}
        />
      )}

      {/* Quick Validate 409 Not Ready -> Validate Anyway Confirmation */}
      {quickForceConfirm && (
        <ConfirmDialog
          isOpen={true}
          title={`Validate ${quickForceConfirm.ucId} anyway (force)?`}
          summary={`The engine reported that **${quickForceConfirm.ucId}** (${quickForceConfirm.title}) is not ready:\n\n> ${quickForceConfirm.message}\n\nConfirming will run validation with \`force: true\`.`}
          warnings={['Forced validation runs the verification probe even when the use case is not in the ready stage.']}
          applyButtonText="Validate anyway (force)"
          danger={true}
          onApply={async () => {
            await handleQuickValidate(null, quickForceConfirm.ucId, quickForceConfirm.title, true);
          }}
          onCancel={() => setQuickForceConfirm(null)}
        />
      )}

      {/* Approval Confirmation Dialog */}
      {approvalConfirmData && (
        <ConfirmDialog
          isOpen={true}
          title={approvalConfirmData.title}
          summary={buildApprovalSummary(approvalConfirmData.preview)}
          plan={approvalConfirmData.preview.plan}
          diff={approvalConfirmData.preview.diff}
          hash={approvalConfirmData.preview.plan_hash}
          applyButtonText={
            approvalConfirmData.payload.action === 'approve'
              ? 'Approve'
              : approvalConfirmData.payload.action === 'deprecate'
              ? 'Deprecate'
              : 'Back to proposed'
          }
          danger={approvalConfirmData.payload.action === 'deprecate'}
          onApply={handleApplyApproval}
          onCancel={() => setApprovalConfirmData(null)}
          onRefetchPreview={handleRefetchApprovalPreview}
        />
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '2rem',
        }}>
          <form
            onSubmit={handleCreateUseCase}
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              width: '100%',
              maxWidth: '600px',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>Create New Use Case</h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Use Case ID (optional)
              </label>
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="Leave empty: next free UC### is assigned on save"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Title
              </label>
              <input
                type="text"
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Car Search by Budget and Fuel"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                  Actor / Persona
                </label>
                <input
                  type="text"
                  value={newActor}
                  onChange={(e) => setNewActor(e.target.value)}
                  placeholder="End-User, Developer"
                  style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                  Approval
                </label>
                <select
                  value={newApproval}
                  onChange={(e) => setNewApproval(e.target.value as any)}
                  style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
                >
                  <option value="proposed">proposed</option>
                  <option value="approved">approved</option>
                  <option value="deprecated">deprecated</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                  Priority
                </label>
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
                >
                  <option value="P0">P0 - Blocker</option>
                  <option value="P1">P1 - High</option>
                  <option value="P2">P2 - Medium</option>
                  <option value="P3">P3 - Low</option>
                </select>
              </div>
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Linked Tasks (comma-separated)
              </label>
              <input
                type="text"
                value={newLinkedTasks}
                onChange={(e) => setNewLinkedTasks(e.target.value)}
                placeholder="08.T1, 08.T3, T012"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Automated Verification Command
              </label>
              <input
                type="text"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                placeholder="curl -fsS http://localhost:8765/api/cars | jq -e 'length > 0'"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#34d399', fontFamily: 'monospace', fontSize: '0.8rem', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Description
              </label>
              <textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={2}
                placeholder="What user capability or business value does this deliver?"
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.25rem' }}>
                Scenario Steps
              </label>
              <textarea
                value={newScenario}
                onChange={(e) => setNewScenario(e.target.value)}
                rows={3}
                placeholder="1. User initiates action...\n2. System responds with..."
                style={{ width: '100%', padding: '0.5rem', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                style={{ padding: '0.4rem 0.8rem', borderRadius: '0.375rem', border: '1px solid #64748b', backgroundColor: 'transparent', color: '#cbd5e1', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                style={{ padding: '0.4rem 0.8rem', borderRadius: '0.375rem', border: 'none', backgroundColor: '#4f46e5', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
              >
                {creating ? 'Saving...' : 'Create Use Case'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
