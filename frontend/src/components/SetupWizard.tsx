import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Bot,
  Cpu,
  Shield,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileCode,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import {
  SetupPlanResponse,
  SetupApplyResponse,
} from '../types';
import { orchestratorConfigApi } from '../api';

interface SetupWizardProps {
  onComplete: () => void;
  onDismiss?: () => void;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({
  onComplete,
  onDismiss,
}) => {
  // Wizard state
  const [orchestrator, setOrchestrator] = useState<string>('claude');
  const [orchestratorModel, setOrchestratorModel] = useState<string>('sonnet');
  const [executor, setExecutor] = useState<string>('kilo');
  const [executorModel, setExecutorModel] = useState<string>('google/gemini-3.8-flash');
  const [verificationMode, setVerificationMode] = useState<string>('cross-agent');
  const [scope, setScope] = useState<'project-local' | 'project' | 'global'>('project-local');
  const [startOrchestrator, setStartOrchestrator] = useState<boolean>(true);

  // Plan & preview state
  const [plan, setPlan] = useState<SetupPlanResponse | null>(null);
  const [loadingPlan, setLoadingPlan] = useState<boolean>(false);
  const [applying, setApplying] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<SetupApplyResponse | null>(null);

  // Load preview plan
  const fetchPlan = async (overrides?: {
    orch?: string;
    orchM?: string;
    exec?: string;
    execM?: string;
    vMode?: string;
    sc?: string;
  }) => {
    setLoadingPlan(true);
    setErrorMsg(null);
    try {
      const res = await orchestratorConfigApi.previewSetup({
        orchestrator: overrides?.orch ?? orchestrator,
        orchestrator_model: overrides?.orchM ?? orchestratorModel,
        executor: overrides?.exec ?? executor,
        executor_model: overrides?.execM ?? executorModel,
        verification_mode: overrides?.vMode ?? verificationMode,
        scope: overrides?.sc ?? scope,
      });
      setPlan(res);
      // Sync defaults if initial
      if (!overrides && res.routing) {
        if (res.routing.default_orchestrator) setOrchestrator(res.routing.default_orchestrator);
        if (res.routing.default_executor) setExecutor(res.routing.default_executor);
      }
    } catch (err: any) {
      console.error('Failed to load setup preview plan:', err);
      setErrorMsg(err.message || 'Failed to generate setup plan');
    } finally {
      setLoadingPlan(false);
    }
  };

  useEffect(() => {
    fetchPlan();
  }, []);

  // Handle Apply
  const handleApply = async () => {
    if (!plan?.plan_hash) return;
    setApplying(true);
    setErrorMsg(null);
    try {
      const res = await orchestratorConfigApi.applySetup({
        expect_hash: plan.plan_hash,
        scope,
        orchestrator,
        executor,
        orchestrator_model: orchestratorModel || undefined,
        executor_model: executorModel || undefined,
        verification_mode: verificationMode,
        start_orchestrator: startOrchestrator,
      });
      setApplyResult(res);
      setTimeout(() => {
        onComplete();
      }, 1000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to apply setup');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      data-testid="first-run-setup-wizard"
      style={{
        backgroundColor: '#0f172a',
        border: '2px solid #6366f1',
        borderRadius: '0.65rem',
        padding: '1.5rem',
        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(99, 102, 241, 0.2)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
      }}
    >
      {/* Wizard Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div
            style={{
              padding: '0.5rem',
              borderRadius: '0.375rem',
              backgroundColor: '#4338ca',
              color: '#c7d2fe',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Sparkles size={22} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                First-Run Orchestration Setup Wizard
              </h2>
              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '0.25rem',
                  backgroundColor: '#312e81',
                  color: '#a5b4fc',
                  fontWeight: 600,
                  border: '1px solid #4f46e5',
                }}
              >
                Guided Initialization
              </span>
            </div>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: '0.25rem 0 0 0' }}>
              Configure cognitive role routing, tool models, and autonomous verification policies for this repository.
            </p>
          </div>
        </div>

        {onDismiss && (
          <button
            onClick={onDismiss}
            data-testid="dismiss-wizard-btn"
            style={{
              padding: '0.35rem 0.75rem',
              backgroundColor: 'transparent',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#94a3b8',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            Dismiss Wizard
          </button>
        )}
      </div>

      {/* Status Messages */}
      {errorMsg && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.65rem 0.85rem',
          borderRadius: '0.375rem',
          backgroundColor: '#451a1a',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          fontSize: '0.82rem',
        }}>
          <AlertCircle size={16} color="#ef4444" />
          <span>{errorMsg}</span>
        </div>
      )}

      {applyResult && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.65rem 0.85rem',
          borderRadius: '0.375rem',
          backgroundColor: '#064e3b',
          border: '1px solid #10b981',
          color: '#a7f3d0',
          fontSize: '0.85rem',
          fontWeight: 600,
        }}>
          <CheckCircle2 size={18} color="#10b981" />
          <span>Configuration applied successfully! Refreshing workspace...</span>
        </div>
      )}

      {/* Step 1: Tool Detection */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.375rem',
        padding: '0.85rem 1rem',
      }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Cpu size={15} color="#818cf8" />
          <span>1. Host Tool Detection</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.6rem' }}>
          {plan?.detection ? (
            Object.entries(plan.detection).map(([tname, tinfo]) => (
              <div
                key={tname}
                data-testid={`detected-tool-${tname}`}
                style={{
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.25rem',
                  backgroundColor: '#0f172a',
                  border: `1px solid ${tinfo.installed ? '#334155' : '#451a1a'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <strong style={{ fontSize: '0.85rem', color: '#f8fafc', textTransform: 'capitalize' }}>
                    {tname}
                  </strong>
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                    {tinfo.installed ? (tinfo.version ? tinfo.version.split(' ')[0] : 'Installed') : 'Not found'}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: '0.68rem',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '0.2rem',
                    backgroundColor: tinfo.installed ? '#064e3b' : '#334155',
                    color: tinfo.installed ? '#34d399' : '#94a3b8',
                    fontWeight: 600,
                  }}
                >
                  {tinfo.installed ? (tinfo.auth_status || 'Ready') : 'Missing'}
                </span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
              Detecting tools on host...
            </div>
          )}
        </div>
      </div>

      {/* Step 2 & 3: Orchestrator & Executor Selection */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
        {/* Orchestrator Picker */}
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          padding: '0.85rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Bot size={15} color="#818cf8" />
            <span>2. Orchestrator Role Holder</span>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
              Tool (Claude recommended global default)
            </label>
            <select
              data-testid="wizard-orchestrator-select"
              value={orchestrator}
              onChange={(e) => {
                const next = e.target.value;
                setOrchestrator(next);
                let nextM = orchestratorModel;
                if (next === 'claude') nextM = 'sonnet';
                else if (next === 'kilo') nextM = 'google/gemini-4-argon';
                else if (next === 'codex') nextM = 'gpt-5-codex';
                setOrchestratorModel(nextM);
                fetchPlan({ orch: next, orchM: nextM });
              }}
              style={{
                width: '100%',
                padding: '0.4rem 0.6rem',
                backgroundColor: '#0f172a',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.82rem',
              }}
            >
              <option value="claude">Claude Code (global default)</option>
              <option value="kilo">Kilo CLI</option>
              <option value="codex">Codex CLI</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
              Orchestrator Model
            </label>
            <input
              data-testid="wizard-orchestrator-model-input"
              type="text"
              value={orchestratorModel}
              onChange={(e) => {
                const nextM = e.target.value;
                setOrchestratorModel(nextM);
              }}
              onBlur={() => fetchPlan()}
              style={{
                width: '100%',
                padding: '0.4rem 0.6rem',
                backgroundColor: '#0f172a',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.82rem',
                fontFamily: 'monospace',
              }}
            />
          </div>
        </div>

        {/* Executor Picker */}
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          padding: '0.85rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Layers size={15} color="#818cf8" />
            <span>3. Default Executor</span>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
              Tool (Kilo recommended for parallel execution)
            </label>
            <select
              data-testid="wizard-executor-select"
              value={executor}
              onChange={(e) => {
                const next = e.target.value;
                setExecutor(next);
                let nextM = executorModel;
                if (next === 'kilo') nextM = 'google/gemini-3.8-flash';
                else if (next === 'claude') nextM = 'sonnet';
                else if (next === 'codex') nextM = 'gpt-5-codex-mini';
                setExecutorModel(nextM);
                fetchPlan({ exec: next, execM: nextM });
              }}
              style={{
                width: '100%',
                padding: '0.4rem 0.6rem',
                backgroundColor: '#0f172a',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.82rem',
              }}
            >
              <option value="kilo">Kilo CLI (bulk execution default)</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex CLI</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
              Executor Model
            </label>
            <input
              data-testid="wizard-executor-model-input"
              type="text"
              value={executorModel}
              onChange={(e) => {
                const nextM = e.target.value;
                setExecutorModel(nextM);
              }}
              onBlur={() => fetchPlan()}
              style={{
                width: '100%',
                padding: '0.4rem 0.6rem',
                backgroundColor: '#0f172a',
                border: '1px solid #475569',
                borderRadius: '0.375rem',
                color: '#f8fafc',
                fontSize: '0.82rem',
                fontFamily: 'monospace',
              }}
            />
          </div>
        </div>
      </div>

      {/* Step 4 & 5: Verification & Scope */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
        {/* Verification Mode */}
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          padding: '0.85rem 1rem',
        }}>
          <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
            4. Autonomous Verification Policy
          </label>
          <select
            data-testid="wizard-verification-mode-select"
            value={verificationMode}
            onChange={(e) => {
              const next = e.target.value;
              setVerificationMode(next);
              fetchPlan({ vMode: next });
            }}
            style={{
              width: '100%',
              padding: '0.4rem 0.6rem',
              backgroundColor: '#0f172a',
              border: '1px solid #475569',
              borderRadius: '0.375rem',
              color: '#f8fafc',
              fontSize: '0.82rem',
            }}
          >
            <option value="cross-agent">Cross-Agent Verification (recommended)</option>
            <option value="independent-session">Independent Session Verification</option>
            <option value="owner">Owner Gate (Manual confirmation)</option>
            <option value="panel">Multi-Agent Review Panel</option>
            <option value="self">Self-Verification Only</option>
          </select>
          <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '0.3rem 0 0 0' }}>
            Cross-Agent ensures independent verification by a different model family.
          </p>
        </div>

        {/* Scope */}
        <div style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          padding: '0.85rem 1rem',
        }}>
          <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '0.3rem' }}>
            5. Target Configuration Scope
          </label>
          <select
            data-testid="wizard-scope-select"
            value={scope}
            onChange={(e) => {
              const next = e.target.value as any;
              setScope(next);
              fetchPlan({ sc: next });
            }}
            style={{
              width: '100%',
              padding: '0.4rem 0.6rem',
              backgroundColor: '#0f172a',
              border: '1px solid #475569',
              borderRadius: '0.375rem',
              color: '#f8fafc',
              fontSize: '0.82rem',
            }}
          >
            <option value="project-local">Project-Local (.ai-orchestration.local.toml inside repo)</option>
            <option value="project">Project Scope (~/.config/ai-orchestration/projects/...)</option>
            <option value="global">Global Scope (Host default)</option>
          </select>
          <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '0.3rem 0 0 0' }}>
            Target: <code>{plan?.path || '.ai-orchestration.local.toml'}</code>
          </p>
        </div>
      </div>

      {/* Step 6: Permission Policy summary */}
      <div style={{
        padding: '0.75rem 1rem',
        backgroundColor: '#0f172a',
        border: '1px solid #334155',
        borderLeft: '4px solid #10b981',
        borderRadius: '0.375rem',
        fontSize: '0.78rem',
        color: '#cbd5e1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '0.5rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Shield size={16} color="#10b981" />
          <span>
            <strong>6. Permission Policy (Q001 Option A):</strong> Safe per-mode allow-lists applied automatically without dangerous overrides.
          </span>
        </div>
        <span style={{ color: '#34d399', fontSize: '0.72rem', fontWeight: 600 }}>Active</span>
      </div>

      {/* Step 7: Preview Diff & Plan Hash */}
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '0.375rem',
        padding: '0.85rem 1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <FileCode size={15} color="#818cf8" />
            <span>7. Preview Setup Diff</span>
          </div>

          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
            Plan Hash:{' '}
            <code data-testid="wizard-plan-hash" style={{ color: '#a5b4fc', fontFamily: 'monospace' }}>
              {plan?.plan_hash || 'calculating...'}
            </code>
          </div>
        </div>

        {loadingPlan ? (
          <div style={{ padding: '1rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.8rem' }}>
            <Loader2 size={16} className="spin" style={{ display: 'inline', marginRight: '0.4rem' }} />
            Generating setup plan diff...
          </div>
        ) : plan?.diff ? (
          <pre
            data-testid="wizard-diff"
            style={{
              margin: 0,
              padding: '0.75rem',
              backgroundColor: '#020617',
              border: '1px solid #1e293b',
              borderRadius: '0.25rem',
              color: '#a7f3d0',
              fontSize: '0.72rem',
              fontFamily: 'monospace',
              overflowX: 'auto',
              maxHeight: '200px',
            }}
          >
            {plan.diff}
          </pre>
        ) : (
          <div style={{ fontSize: '0.75rem', color: '#64748b', fontStyle: 'italic', padding: '0.5rem 0' }}>
            (No configuration diff)
          </div>
        )}
      </div>

      {/* Options & Action Button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: '#cbd5e1', cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-testid="wizard-start-orchestrator-checkbox"
            checked={startOrchestrator}
            onChange={(e) => setStartOrchestrator(e.target.checked)}
          />
          <span>Start orchestrator role immediately after setup</span>
        </label>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => fetchPlan()}
            disabled={loadingPlan || applying}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.5rem 0.85rem',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              color: '#cbd5e1',
              fontSize: '0.82rem',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={13} className={loadingPlan ? 'spin' : ''} />
            <span>Update Preview</span>
          </button>

          <button
            onClick={handleApply}
            disabled={!plan?.plan_hash || applying}
            data-testid="wizard-apply-btn"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.5rem 1.25rem',
              backgroundColor: !plan?.plan_hash || applying ? '#312e81' : '#4f46e5',
              border: 'none',
              borderRadius: '0.375rem',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: !plan?.plan_hash || applying ? 'not-allowed' : 'pointer',
              opacity: !plan?.plan_hash ? 0.6 : 1,
            }}
          >
            {applying ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}
            <span>Apply Configuration & Finish Setup</span>
          </button>
        </div>
      </div>
    </div>
  );
};
