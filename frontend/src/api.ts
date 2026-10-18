import {
  TaskListResponse,
  WorkspaceInfo,
  EnvStatusResponse,
  OrchestrationConfigResponse,
  ConfigPreviewResponse,
  ConfigApplyResponse,
  QuestionListResponse,
  QuestionItem,
  AskQuestionPayload,
  AnswerQuestionPayload,
  WithdrawQuestionPayload,
  RunOptionsResponse,
  RunPreviewPayload,
  RunPreviewResponse,
  RunStartPayload,
  RunContinuePayload,
  RunRecord,
  RunListResponse,
  RunLogsResponse,
  RunCleanupPayload,
  RunApplyVerdictPayload,
  RunMarkDeliveredPayload,
  InboxListResponse,
  InboxNoteResponse,
  AddInboxNotePayload,
  EditInboxNotePayload,
  AddInboxNoteResponse,
  EditInboxNoteResponse,
  UploadAttachmentResponse,
  DeleteAttachmentResponse,
  ResolveInboxNotePayload,
  DiscardInboxNotePayload,
  InboxToTaskPayload,
  InboxToTaskResponse,
  TriageProposalResponse,
  AcceptTriagePayload,
  AcceptTriageResponse,
  StructureActionResponse,
  EventsTailResponse,
  EventsStatsResponse,
  OrchestrationSession,
  TriggersListResponse,
  TriggersStatusResponse,
  TriggersHistoryResponse,
  ProposedActionsResponse,
  AwaitingApplicationResponse,
  ApplyQuestionPayload,
  ApplyQuestionResponse,
  OrchestratorQueueResponse,
  NotificationsResponse,
} from './types';

// Custom ApiError to carry HTTP status and response payload
export class ApiError extends Error {
  status: number;
  data: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// Detect whether running inside VS Code Webview or standalone browser
declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage: (msg: any) => void;
      getState: () => any;
      setState: (state: any) => void;
    };
  }
}

export const isVsCode = typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function';
export const vscode = isVsCode && window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

let messageSeq = 0;
const pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
const wsMessageListeners = new Set<(msg: any) => void>();
const wsStatusListeners = new Set<(status: 'connected' | 'disconnected') => void>();
let currentWsStatus: 'connected' | 'disconnected' = 'disconnected';

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const { id, data, error, status, ok, type } = event.data || {};
    if (id && pendingRequests.has(id)) {
      const { resolve, reject } = pendingRequests.get(id)!;
      pendingRequests.delete(id);
      if (ok) {
        resolve(data);
      } else {
        const errStatus = status || (typeof error === 'string' && error.includes('409') ? 409 : 500);
        reject(new ApiError(error || 'VS Code message failed', errStatus, data));
      }
    } else if (type === 'tasks_changed') {
      wsMessageListeners.forEach((l) => {
        try { l({ type: 'tasks_changed' }); } catch {}
      });
    } else if (type === 'changed') {
      wsMessageListeners.forEach((l) => {
        try { l(event.data); } catch {}
      });
    }
  });
}

function sendVsCodeMessage<T>(type: string, payload?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!vscode) return reject(new ApiError('VS Code API not available', 500));
    const id = `req_${++messageSeq}_${Date.now()}`;
    pendingRequests.set(id, { resolve, reject });
    vscode.postMessage({ id, type, payload });
  });
}

function getApiToken(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name="ai-orch-token"]');
  return meta ? meta.getAttribute('content') : null;
}

// Helper for HTTP fetch in standalone browser mode
async function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : endpoint;
  const token = getApiToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['X-AI-Orch-Token'] = token;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
    });
  } catch {
    // fetch() rejects only on network failure: the backend is down or unreachable
    throw new Error('Server not reachable: is ./start.sh still running?');
  }

  if (!res.ok) {
    if (res.status === 401) {
      if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
        const reloaded = window.sessionStorage.getItem('ai_orch_reloaded_on_401');
        if (!reloaded) {
          window.sessionStorage.setItem('ai_orch_reloaded_on_401', '1');
          window.location.reload();
        }
      }
    }
    let err = `${res.status} ${res.statusText}`;
    let data: any = null;
    try {
      data = await res.json();
      if (data && data.error) {
        err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
      }
    } catch {}
    throw new ApiError(err, res.status, data);
  }

  if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
    window.sessionStorage.removeItem('ai_orch_reloaded_on_401');
  }

  return res.json();
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      const base64 = res.includes(',') ? res.split(',')[1] : res;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export const api = {
  async getWorkspace(): Promise<WorkspaceInfo> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<WorkspaceInfo>('getWorkspace');
    }
    return apiFetch<WorkspaceInfo>('/api/workspace');
  },

  async switchWorkspace(workspacePath: string): Promise<{ ok: boolean }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean }>('switchWorkspace', { workspacePath });
    }
    throw new ApiError('Workspace switching is not supported in standalone browser mode. Start another server with the desired workspace.', 400);
  },

  async getTasks(filters?: { kind?: string[]; label?: string[] }): Promise<TaskListResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TaskListResponse>('getTasks', filters);
    }
    const params = new URLSearchParams();
    if (filters?.kind) {
      filters.kind.forEach((k) => params.append('kind', k));
    }
    if (filters?.label) {
      filters.label.forEach((l) => params.append('label', l));
    }
    const qs = params.toString();
    return apiFetch<TaskListResponse>(qs ? `/api/tasks?${qs}` : '/api/tasks');
  },

  async validateTasks(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('validateTasks');
    }
    return apiFetch('/api/tasks/validate');
  },

  async transitionTask(
    taskId: string,
    newState: string,
    actor = 'operator',
    verifier?: string,
    reason?: string,
    expectTaskHash?: string
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('transitionTask', { taskId, newState, actor, verifier, reason, expectTaskHash });
    }
    return apiFetch('/api/tasks/transition', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        new_state: newState,
        actor,
        verifier,
        reason,
        expect_task_hash: expectTaskHash,
      }),
    });
  },

  async previewSyncIndex(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewSyncIndex');
    }
    return apiFetch('/api/tasks/sync-index/preview');
  },

  async syncIndex(expectHash: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('syncIndex', { expectHash });
    }
    return apiFetch('/api/tasks/sync-index', {
      method: 'POST',
      body: JSON.stringify({ expect_hash: expectHash }),
    });
  },

  async getTaskDetail(taskId: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('getTaskDetail', { taskId });
    }
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`);
  },

  async uploadTaskAttachment(
    taskId: string,
    file: File | Blob,
    filename?: string,
    expectTaskHash?: string
  ): Promise<UploadAttachmentResponse> {
    const fname = filename || (file instanceof File ? file.name : 'attachment.txt');
    if (isVsCode && vscode) {
      const base64 = await blobToBase64(file);
      return sendVsCodeMessage<UploadAttachmentResponse>('uploadTaskAttachment', {
        id: taskId,
        filename: fname,
        data: base64,
        expect_task_hash: expectTaskHash,
      });
    }

    const formData = new FormData();
    formData.append('file', file, fname);
    if (expectTaskHash) {
      formData.append('expect_task_hash', expectTaskHash);
    }
    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['X-AI-Orch-Token'] = token;
    }

    let res: Response;
    try {
      res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch {
      throw new Error('Server not reachable: is ./start.sh still running?');
    }

    if (!res.ok) {
      let err = `${res.status} ${res.statusText}`;
      let data: any = null;
      try {
        data = await res.json();
        if (data && data.error) {
          err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        }
      } catch {}
      throw new ApiError(err, res.status, data);
    }

    return res.json();
  },

  async getTaskAttachment(taskId: string, name: string): Promise<Blob> {
    if (isVsCode && vscode) {
      const res = await sendVsCodeMessage<{ data: string; contentType?: string }>('getTaskAttachment', { id: taskId, name });
      const byteCharacters = atob(res.data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      return new Blob([byteArray], { type: res.contentType || 'application/octet-stream' });
    }

    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['X-AI-Orch-Token'] = token;
    }

    let res: Response;
    try {
      res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(name)}`, {
        headers,
      });
    } catch {
      throw new Error('Server not reachable: is ./start.sh still running?');
    }

    if (!res.ok) {
      let err = `${res.status} ${res.statusText}`;
      let data: any = null;
      try {
        data = await res.json();
        if (data && data.error) {
          err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        }
      } catch {}
      throw new ApiError(err, res.status, data);
    }

    return res.blob();
  },

  async deleteTaskAttachment(taskId: string, name: string, expectTaskHash?: string): Promise<DeleteAttachmentResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<DeleteAttachmentResponse>('deleteTaskAttachment', { id: taskId, name, expect_task_hash: expectTaskHash });
    }
    const q = expectTaskHash ? `?expect_task_hash=${encodeURIComponent(expectTaskHash)}` : '';
    return apiFetch<DeleteAttachmentResponse>(`/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(name)}${q}`, {
      method: 'DELETE',
    });
  },

  async getQuestions(params?: { status?: string; blocks?: string }): Promise<QuestionListResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<QuestionListResponse>('getQuestions', params);
    }
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.blocks) searchParams.set('blocks', params.blocks);
    const qs = searchParams.toString();
    return apiFetch<QuestionListResponse>(qs ? `/api/questions?${qs}` : '/api/questions');
  },

  async getQuestion(id: string): Promise<{ ok: boolean; question: QuestionItem }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean; question: QuestionItem }>('getQuestion', { id });
    }
    return apiFetch<{ ok: boolean; question: QuestionItem }>(`/api/questions/${encodeURIComponent(id)}`);
  },

  async askQuestion(payload: AskQuestionPayload): Promise<{ ok: boolean; id: string; rel_path?: string }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean; id: string; rel_path?: string }>('askQuestion', payload);
    }
    return apiFetch<{ ok: boolean; id: string; rel_path?: string }>('/api/questions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async answerQuestion(id: string, payload: AnswerQuestionPayload): Promise<{ ok: boolean; choice: string; unblocked_tasks?: string[] }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean; choice: string; unblocked_tasks?: string[] }>('answerQuestion', { id, ...payload });
    }
    return apiFetch<{ ok: boolean; choice: string; unblocked_tasks?: string[] }>(`/api/questions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async withdrawQuestion(id: string, payload: WithdrawQuestionPayload): Promise<{ ok: boolean }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean }>('withdrawQuestion', { id, ...payload });
    }
    return apiFetch<{ ok: boolean }>(`/api/questions/${encodeURIComponent(id)}/withdraw`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getEnvStatus(): Promise<EnvStatusResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<EnvStatusResponse>('getEnvStatus');
    }
    return apiFetch<EnvStatusResponse>('/api/env/status');
  },

  async previewInstallSkills(
    assistants: string[],
    scope: 'global' | 'project',
    repo = 'ai-orchestration',
    link = false,
    plugins?: string[],
    overwrite?: string[]
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewInstallSkills', { assistants, scope, repo, link, plugins, overwrite });
    }
    return apiFetch('/api/env/install-skills/preview', {
      method: 'POST',
      body: JSON.stringify({ assistants, scope, repo, link, plugins, overwrite }),
    });
  },

  async installSkills(
    assistants: string[],
    scope: 'global' | 'project',
    repo = 'ai-orchestration',
    link = false,
    expectPlanHash?: string,
    plugins?: string[],
    overwrite?: string[]
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('installSkills', { assistants, scope, repo, link, expectPlanHash, plugins, overwrite });
    }
    return apiFetch('/api/env/install-skills', {
      method: 'POST',
      body: JSON.stringify({
        assistants,
        scope,
        repo,
        link,
        expect_plan_hash: expectPlanHash,
        plugins,
        overwrite,
      }),
    });
  },

  async previewRegisterMcp(
    server: string,
    assistants: string[],
    scope: 'global' | 'project',
    provisionVenv = false
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewRegisterMcp', { server, assistants, scope, provisionVenv });
    }
    return apiFetch('/api/env/register-mcp/preview', {
      method: 'POST',
      body: JSON.stringify({
        server,
        assistants,
        scope,
        provision_venv: provisionVenv,
      }),
    });
  },

  async registerMcp(
    server: string,
    assistants: string[],
    scope: 'global' | 'project',
    provisionVenv = false,
    expectPlanHash?: string
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('registerMcp', { server, assistants, scope, provisionVenv, expectPlanHash });
    }
    return apiFetch('/api/env/register-mcp', {
      method: 'POST',
      body: JSON.stringify({
        server,
        assistants,
        scope,
        provision_venv: provisionVenv,
        expect_plan_hash: expectPlanHash,
      }),
    });
  },

  async previewRemoveSkill(
    skill: string,
    assistant: string,
    scope: 'global' | 'project' = 'global'
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewRemoveSkill', { skill, assistant, scope });
    }
    return apiFetch('/api/env/remove-skill/preview', {
      method: 'POST',
      body: JSON.stringify({ skill, assistant, scope }),
    });
  },

  async removeSkill(
    skill: string,
    assistant: string,
    scope: 'global' | 'project' = 'global',
    expectPlanHash?: string
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('removeSkill', { skill, assistant, scope, expectPlanHash });
    }
    return apiFetch('/api/env/remove-skill', {
      method: 'POST',
      body: JSON.stringify({ skill, assistant, scope, expect_plan_hash: expectPlanHash }),
    });
  },

  async previewResolveConflicts(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewResolveConflicts');
    }
    return apiFetch('/api/env/resolve-conflicts/preview', { method: 'POST' });
  },

  async resolveConflicts(expectPlanHash?: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('resolveConflicts', { expectPlanHash });
    }
    return apiFetch('/api/env/resolve-conflicts', {
      method: 'POST',
      body: JSON.stringify({ expect_plan_hash: expectPlanHash }),
    });
  },

  async previewFetchRepos(repos?: string[]): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewFetchRepos', { repos });
    }
    return apiFetch('/api/env/fetch-repos/preview', {
      method: 'POST',
      body: JSON.stringify({ repos }),
    });
  },

  async fetchRepos(expectPlanHash: string, repos?: string[]): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('fetchRepos', { expectPlanHash, repos });
    }
    return apiFetch('/api/env/fetch-repos', {
      method: 'POST',
      body: JSON.stringify({ expect_plan_hash: expectPlanHash, repos }),
    });
  },

  async getConfig(): Promise<OrchestrationConfigResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<OrchestrationConfigResponse>('getConfig');
    }
    return apiFetch<OrchestrationConfigResponse>('/api/config/show');
  },

  async previewSetProfile(
    tool: string,
    profile: string,
    model: string,
    variant?: string,
    effort?: string,
    basis?: string,
    scope: 'global' | 'project' = 'global'
  ): Promise<ConfigPreviewResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigPreviewResponse>('previewSetProfile', { tool, profile, model, variant, effort, basis, scope });
    }
    return apiFetch<ConfigPreviewResponse>('/api/config/set-profile/preview', {
      method: 'POST',
      body: JSON.stringify({ tool, profile, model, variant, effort, basis, scope }),
    });
  },

  async setProfile(
    tool: string,
    profile: string,
    model: string,
    expectHash: string,
    variant?: string,
    effort?: string,
    basis?: string,
    scope: 'global' | 'project' = 'global'
  ): Promise<ConfigApplyResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigApplyResponse>('setProfile', { tool, profile, model, expectHash, variant, effort, basis, scope });
    }
    return apiFetch<ConfigApplyResponse>('/api/config/set-profile', {
      method: 'POST',
      body: JSON.stringify({ tool, profile, model, expect_hash: expectHash, variant, effort, basis, scope }),
    });
  },

  async previewSetRouting(
    scope: 'global' | 'project' = 'global',
    orchestrator?: string,
    executor?: string,
    defaultProfile?: string,
    verificationMode?: string
  ): Promise<ConfigPreviewResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigPreviewResponse>('previewSetRouting', { scope, orchestrator, executor, defaultProfile, verificationMode });
    }
    return apiFetch<ConfigPreviewResponse>('/api/config/set-routing/preview', {
      method: 'POST',
      body: JSON.stringify({
        scope,
        orchestrator,
        executor,
        default_profile: defaultProfile,
        verification_mode: verificationMode,
      }),
    });
  },

  async setRouting(
    expectHash: string,
    scope: 'global' | 'project' = 'global',
    orchestrator?: string,
    executor?: string,
    defaultProfile?: string,
    verificationMode?: string
  ): Promise<ConfigApplyResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigApplyResponse>('setRouting', { expectHash, scope, orchestrator, executor, defaultProfile, verificationMode });
    }
    return apiFetch<ConfigApplyResponse>('/api/config/set-routing', {
      method: 'POST',
      body: JSON.stringify({
        expect_hash: expectHash,
        scope,
        orchestrator,
        executor,
        default_profile: defaultProfile,
        verification_mode: verificationMode,
      }),
    });
  },

  async renderAgentsMd(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('renderAgentsMd');
    }
    return apiFetch('/api/config/render-agents-md');
  },

  async previewAgentsMd(): Promise<ConfigPreviewResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigPreviewResponse>('previewAgentsMd');
    }
    return apiFetch<ConfigPreviewResponse>('/api/config/render-agents-md/preview');
  },

  async applyAgentsMd(expectHash: string, allowGlobalRouting = false): Promise<ConfigApplyResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigApplyResponse>('applyAgentsMd', { expectHash, allowGlobalRouting });
    }
    return apiFetch<ConfigApplyResponse>('/api/config/render-agents-md/apply', {
      method: 'POST',
      body: JSON.stringify({ expect_hash: expectHash, allow_global_routing: allowGlobalRouting }),
    });
  },

  // -------------------------------------------------------------------------
  // Agent Runs Endpoints (Task 07.7)
  // -------------------------------------------------------------------------

  async getRunOptions(target: string | { task?: string; note?: string }): Promise<RunOptionsResponse> {
    const payload = typeof target === 'string'
      ? (target.startsWith('N') ? { note: target } : { task: target })
      : target;
    if (isVsCode && vscode) {
      return sendVsCodeMessage<RunOptionsResponse>('getRunOptions', payload);
    }
    const query = new URLSearchParams();
    if (payload.task) query.set('task', payload.task);
    if (payload.note) query.set('note', payload.note);
    return apiFetch<RunOptionsResponse>(`/api/runs/options?${query.toString()}`);
  },

  async previewRun(payload: RunPreviewPayload): Promise<RunPreviewResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<RunPreviewResponse>('previewRun', payload);
    }
    return apiFetch<RunPreviewResponse>('/api/runs/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async startRun(payload: RunStartPayload): Promise<{ ok: boolean; run_id: string; status: string; [key: string]: any }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('startRun', payload);
    }
    return apiFetch('/api/runs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async continueRun(runId: string, payload?: RunContinuePayload): Promise<{ ok: boolean; run_id: string; status: string; [key: string]: any }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('continueRun', { runId, ...(payload || {}) });
    }
    return apiFetch(`/api/runs/${encodeURIComponent(runId)}/continue`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async listRuns(params?: { task?: string; note?: string; active?: boolean }): Promise<RunListResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<RunListResponse>('listRuns', params);
    }
    const query = new URLSearchParams();
    if (params?.task) query.set('task', params.task);
    if (params?.note) query.set('note', params.note);
    if (params?.active) query.set('active', '1');
    const qs = query.toString();
    return apiFetch<RunListResponse>(`/api/runs${qs ? `?${qs}` : ''}`);
  },

  async getRun(runId: string): Promise<{ ok: boolean; run: RunRecord }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean; run: RunRecord }>('getRun', { runId });
    }
    return apiFetch<{ ok: boolean; run: RunRecord }>(`/api/runs/${encodeURIComponent(runId)}`);
  },

  async getRunLogs(runId: string, params?: { since_offset?: number; tail?: number }): Promise<RunLogsResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<RunLogsResponse>('getRunLogs', { runId, ...(params || {}) });
    }
    const query = new URLSearchParams();
    if (params?.since_offset !== undefined) query.set('since_offset', String(params.since_offset));
    if (params?.tail !== undefined) query.set('tail', String(params.tail));
    const qs = query.toString();
    return apiFetch<RunLogsResponse>(`/api/runs/${encodeURIComponent(runId)}/logs${qs ? `?${qs}` : ''}`);
  },

  async cancelRun(runId: string): Promise<{ ok: boolean; run_id: string; status: string }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('cancelRun', { runId });
    }
    return apiFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    });
  },

  async markDeliveredRun(runId: string, payload?: RunMarkDeliveredPayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('markDeliveredRun', { runId, ...(payload || {}) });
    }
    return apiFetch(`/api/runs/${encodeURIComponent(runId)}/mark-delivered`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async applyVerdictRun(runId: string, payload?: RunApplyVerdictPayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('applyVerdictRun', { runId, ...(payload || {}) });
    }
    return apiFetch(`/api/runs/${encodeURIComponent(runId)}/apply-verdict`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async cleanupRun(runId: string, payload?: RunCleanupPayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('cleanupRun', { runId, ...(payload || {}) });
    }
    return apiFetch(`/api/runs/${encodeURIComponent(runId)}/cleanup`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async getTriageProposal(runId: string): Promise<TriageProposalResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TriageProposalResponse>('getTriageProposal', { runId });
    }
    return apiFetch<TriageProposalResponse>(`/api/runs/${encodeURIComponent(runId)}/triage-proposal`);
  },

  async acceptTriage(runId: string, payload?: AcceptTriagePayload): Promise<AcceptTriageResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<AcceptTriageResponse>('acceptTriage', { runId, ...(payload || {}) });
    }
    return apiFetch<AcceptTriageResponse>(`/api/runs/${encodeURIComponent(runId)}/accept-triage`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  // -------------------------------------------------------------------------
  // Inbox API methods (Task 09.3)
  // -------------------------------------------------------------------------

  async listInboxNotes(params?: { status?: string }): Promise<InboxListResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<InboxListResponse>('listInbox', params || {});
    }
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    return apiFetch<InboxListResponse>(`/api/inbox${qs ? `?${qs}` : ''}`);
  },

  async getInboxNote(id: string): Promise<InboxNoteResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<InboxNoteResponse>('getInboxNote', { id });
    }
    return apiFetch<InboxNoteResponse>(`/api/inbox/${encodeURIComponent(id)}`);
  },

  async addInboxNote(payload: AddInboxNotePayload): Promise<AddInboxNoteResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<AddInboxNoteResponse>('addInboxNote', payload);
    }
    return apiFetch<AddInboxNoteResponse>('/api/inbox', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async editInboxNote(id: string, payload: EditInboxNotePayload): Promise<EditInboxNoteResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<EditInboxNoteResponse>('editInboxNote', { id, ...payload });
    }
    return apiFetch<EditInboxNoteResponse>(`/api/inbox/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async uploadInboxAttachment(
    id: string,
    file: File | Blob,
    filename?: string
  ): Promise<UploadAttachmentResponse> {
    const fname = filename || (file instanceof File ? file.name : 'attachment.png');
    if (isVsCode && vscode) {
      const base64 = await blobToBase64(file);
      return sendVsCodeMessage<UploadAttachmentResponse>('uploadInboxAttachment', {
        id,
        filename: fname,
        data: base64,
      });
    }

    const formData = new FormData();
    formData.append('file', file, fname);
    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['X-AI-Orch-Token'] = token;
    }

    let res: Response;
    try {
      res = await fetch(`/api/inbox/${encodeURIComponent(id)}/attachments`, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch {
      throw new Error('Server not reachable: is ./start.sh still running?');
    }

    if (!res.ok) {
      let err = `${res.status} ${res.statusText}`;
      let data: any = null;
      try {
        data = await res.json();
        if (data && data.error) {
          err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        }
      } catch {}
      throw new ApiError(err, res.status, data);
    }

    return res.json();
  },

  async getInboxAttachment(id: string, name: string): Promise<Blob> {
    if (isVsCode && vscode) {
      const res = await sendVsCodeMessage<{ data: string; contentType?: string }>('getInboxAttachment', { id, name });
      const byteCharacters = atob(res.data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      return new Blob([byteArray], { type: res.contentType || 'application/octet-stream' });
    }

    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['X-AI-Orch-Token'] = token;
    }

    let res: Response;
    try {
      res = await fetch(`/api/inbox/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`, {
        headers,
      });
    } catch {
      throw new Error('Server not reachable: is ./start.sh still running?');
    }

    if (!res.ok) {
      let err = `${res.status} ${res.statusText}`;
      let data: any = null;
      try {
        data = await res.json();
        if (data && data.error) {
          err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        }
      } catch {}
      throw new ApiError(err, res.status, data);
    }

    return res.blob();
  },

  async deleteInboxAttachment(id: string, name: string): Promise<DeleteAttachmentResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<DeleteAttachmentResponse>('deleteInboxAttachment', { id, name });
    }
    return apiFetch<DeleteAttachmentResponse>(`/api/inbox/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  async resolveInboxNote(id: string, payload: ResolveInboxNotePayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('resolveInboxNote', { id, ...payload });
    }
    return apiFetch(`/api/inbox/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async discardInboxNote(id: string, payload: DiscardInboxNotePayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('discardInboxNote', { id, ...payload });
    }
    return apiFetch(`/api/inbox/${encodeURIComponent(id)}/discard`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async reopenInboxNote(id: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('reopenInboxNote', { id });
    }
    return apiFetch(`/api/inbox/${encodeURIComponent(id)}/reopen`, {
      method: 'POST',
    });
  },

  async inboxToTask(id: string, payload: InboxToTaskPayload): Promise<InboxToTaskResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<InboxToTaskResponse>('inboxToTask', { id, ...payload });
    }
    return apiFetch<InboxToTaskResponse>(`/api/inbox/${encodeURIComponent(id)}/to-task`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // -------------------------------------------------------------------------
  // Use Cases (Spec 15)
  // -------------------------------------------------------------------------

  async getUseCases(status?: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('getUseCases', { status });
    }
    const q = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
    return apiFetch(`/api/use-cases${q}`);
  },

  async getUseCase(id: string): Promise<{ ok: boolean; use_case: any }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('getUseCase', { id });
    }
    return apiFetch(`/api/use-cases/${encodeURIComponent(id)}`);
  },

  async createUseCase(data: any): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('createUseCase', data);
    }
    return apiFetch('/api/use-cases', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async validateUseCase(id: string, options?: { timeout?: number; actor?: string }): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('validateUseCase', { id, ...options });
    }
    return apiFetch(`/api/use-cases/${encodeURIComponent(id)}/validate`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
    });
  },

  async runValidationCampaign(options?: { filter_actor?: string; timeout?: number }): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('runValidationCampaign', options);
    }
    return apiFetch('/api/use-cases/campaign', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    });
  },

  connectWebSocket(
    onMessage: (msg: any) => void,
    onStatusChange?: (status: 'connected' | 'disconnected') => void
  ): () => void {
    wsMessageListeners.add(onMessage);
    if (onStatusChange) {
      wsStatusListeners.add(onStatusChange);
      if (isVsCode) {
        onStatusChange('connected');
      } else {
        onStatusChange(currentWsStatus);
      }
    }

    if (isVsCode) {
      return () => {
        wsMessageListeners.delete(onMessage);
        if (onStatusChange) {
          wsStatusListeners.delete(onStatusChange);
        }
      };
    }

    // Shared WebSocket management for browser
    ensureBrowserWs();

    return () => {
      wsMessageListeners.delete(onMessage);
      if (onStatusChange) {
        wsStatusListeners.delete(onStatusChange);
      }
    };
  },

  subscribeWebSocket(onMessage: (msg: any) => void): () => void {
    return this.connectWebSocket(onMessage);
  },

  async getEvents(params?: { since?: number; limit?: number; type?: string; session?: string }): Promise<EventsTailResponse> {
    const query = new URLSearchParams();
    if (params?.since !== undefined) query.set('since', String(params.since));
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.type) query.set('type', params.type);
    if (params?.session) query.set('session', params.session);
    const qs = query.toString();
    const endpoint = `/api/events${qs ? `?${qs}` : ''}`;
    if (isVsCode && vscode) {
      return sendVsCodeMessage<EventsTailResponse>('getEvents', params || {});
    }
    return apiFetch<EventsTailResponse>(endpoint);
  },

  async getEventsStats(): Promise<EventsStatsResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<EventsStatsResponse>('getEventsStats', {});
    }
    return apiFetch<EventsStatsResponse>('/api/events/stats');
  },

  async getSessions(params?: { role?: string; status?: string; tool?: string }): Promise<{ ok: boolean; sessions: OrchestrationSession[] }> {
    const query = new URLSearchParams();
    if (params?.role) query.set('role', params.role);
    if (params?.status) query.set('status', params.status);
    if (params?.tool) query.set('tool', params.tool);
    const qs = query.toString();
    const endpoint = `/api/sessions${qs ? `?${qs}` : ''}`;
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean; sessions: OrchestrationSession[] }>('getSessions', params || {});
    }
    return apiFetch<{ ok: boolean; sessions: OrchestrationSession[] }>(endpoint);
  },

  async getSession(sessionId: string): Promise<OrchestrationSession> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<OrchestrationSession>('getSession', { sessionId });
    }
    return apiFetch<OrchestrationSession>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  },

  async getRoleHolder(role: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('getRoleHolder', { role });
    }
    return apiFetch<any>(`/api/sessions/role/${encodeURIComponent(role)}`);
  },

  async getTriggers(): Promise<TriggersListResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TriggersListResponse>('getTriggers', {});
    }
    return apiFetch<TriggersListResponse>('/api/triggers');
  },

  async getTriggersStatus(role?: string): Promise<TriggersStatusResponse> {
    const qs = role ? `?role=${encodeURIComponent(role)}` : '';
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TriggersStatusResponse>('getTriggersStatus', { role });
    }
    return apiFetch<TriggersStatusResponse>(`/api/triggers/status${qs}`);
  },

  async getTriggersHistory(params?: { rule?: string; limit?: number }): Promise<TriggersHistoryResponse> {
    const query = new URLSearchParams();
    if (params?.rule) query.set('rule', params.rule);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TriggersHistoryResponse>('getTriggersHistory', params || {});
    }
    return apiFetch<TriggersHistoryResponse>(`/api/triggers/history${qs ? `?${qs}` : ''}`);
  },

  async runTriggersOnce(payload?: { dry_run?: boolean; role?: string }): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('runTriggersOnce', payload || {});
    }
    return apiFetch<any>('/api/triggers/run-once', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async previewToggleTrigger(payload: { rule_name?: string; kill_switch?: boolean; enabled?: boolean }): Promise<ConfigPreviewResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigPreviewResponse>('previewToggleTrigger', payload);
    }
    return apiFetch<ConfigPreviewResponse>('/api/triggers/toggle/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async toggleTrigger(payload: { rule_name?: string; kill_switch?: boolean; enabled?: boolean; expect_hash: string }): Promise<ConfigApplyResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ConfigApplyResponse>('toggleTrigger', payload);
    }
    return apiFetch<ConfigApplyResponse>('/api/triggers/toggle', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getProposedActions(): Promise<ProposedActionsResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ProposedActionsResponse>('getProposedActions', {});
    }
    return apiFetch<ProposedActionsResponse>('/api/triggers/proposed-actions');
  },

  async confirmProposedAction(actionId: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('confirmProposedAction', { actionId });
    }
    return apiFetch<any>(`/api/triggers/proposed-actions/${encodeURIComponent(actionId)}/confirm`, {
      method: 'POST',
    });
  },

  async rejectProposedAction(actionId: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('rejectProposedAction', { actionId });
    }
    return apiFetch<any>(`/api/triggers/proposed-actions/${encodeURIComponent(actionId)}/reject`, {
      method: 'POST',
    });
  },

  async getQuestionsAwaitingApplication(): Promise<AwaitingApplicationResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<AwaitingApplicationResponse>('getQuestionsAwaitingApplication', {});
    }
    return apiFetch<AwaitingApplicationResponse>('/api/questions/awaiting-application');
  },

  async applyQuestion(questionId: string, payload: ApplyQuestionPayload): Promise<ApplyQuestionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<ApplyQuestionResponse>('applyQuestion', { questionId, ...payload });
    }
    return apiFetch<ApplyQuestionResponse>(`/api/questions/${encodeURIComponent(questionId)}/apply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getOrchestratorQueue(): Promise<OrchestratorQueueResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<OrchestratorQueueResponse>('getOrchestratorQueue', {});
    }
    return apiFetch<OrchestratorQueueResponse>('/api/orchestrator/queue');
  },

  async getNotifications(): Promise<NotificationsResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<NotificationsResponse>('getNotifications', {});
    }
    return apiFetch<NotificationsResponse>('/api/notifications');
  },

  async markNotificationRead(id: string): Promise<{ ok: boolean }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean }>('markNotificationRead', { id });
    }
    return apiFetch<{ ok: boolean }>(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
    });
  },

  async markAllNotificationsRead(): Promise<{ ok: boolean }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean }>('markAllNotificationsRead', {});
    }
    return apiFetch<{ ok: boolean }>('/api/notifications/read', {
      method: 'POST',
    });
  },
};

let sharedWs: WebSocket | null = null;
let sharedWsPingInterval: any = null;
let sharedWsReconnectTimeout: any = null;
let sharedWsDisposed = false;
let sharedWsBackoffMs = 1000;
let sharedWsHasConnectedOnce = false;

function broadcastWsStatus(status: 'connected' | 'disconnected') {
  currentWsStatus = status;
  wsStatusListeners.forEach((fn) => {
    try {
      fn(status);
    } catch {}
  });
}

function broadcastWsMessage(msg: any) {
  wsMessageListeners.forEach((fn) => {
    try {
      fn(msg);
    } catch {}
  });
}

function scheduleSharedWsReconnect() {
  if (sharedWsDisposed || sharedWsReconnectTimeout) return;
  broadcastWsStatus('disconnected');
  const delay = sharedWsBackoffMs;
  sharedWsBackoffMs = Math.min(30000, Math.round(sharedWsBackoffMs * 1.5));
  sharedWsReconnectTimeout = setTimeout(() => {
    sharedWsReconnectTimeout = null;
    initSharedWs();
  }, delay);
}

function initSharedWs() {
  if (isVsCode || typeof window === 'undefined' || sharedWsDisposed) return;
  if (sharedWs && (sharedWs.readyState === WebSocket.OPEN || sharedWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:8780';
  const token = getApiToken();
  const wsUrl = token
    ? `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`
    : `${protocol}//${host}/ws`;

  try {
    sharedWs = new WebSocket(wsUrl);

    sharedWs.onopen = () => {
      sharedWsBackoffMs = 1000;
      broadcastWsStatus('connected');
      if (sharedWsHasConnectedOnce) {
        broadcastWsMessage({ type: 'reconnected' });
      }
      sharedWsHasConnectedOnce = true;
    };

    sharedWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          broadcastWsStatus('connected');
        }
        broadcastWsMessage(data);
      } catch {}
    };

    sharedWs.onerror = () => {
      scheduleSharedWsReconnect();
    };

    sharedWs.onclose = () => {
      scheduleSharedWsReconnect();
    };
  } catch {
    scheduleSharedWsReconnect();
  }

  if (!sharedWsPingInterval) {
    sharedWsPingInterval = setInterval(() => {
      if (sharedWs && sharedWs.readyState === WebSocket.OPEN) {
        try {
          sharedWs.send('ping');
        } catch {}
      }
    }, 15000);
  }
}

function ensureBrowserWs() {
  sharedWsDisposed = false;
  initSharedWs();
}

// ============================================================================
// Task 10.2: Timeline & Task Graph API Extensions
// ============================================================================

import type {
  TaskGraphResponse,
  SetPriorityPayload,
  SetSizePayload,
  SetDepsPayload,
  TaskMutationPreviewResult,
} from './types';

export interface TimelineApiExtensions {
  getTasksGraph(filters?: { kind?: string[]; label?: string[] }): Promise<TaskGraphResponse>;
  previewSetPriority(taskId: string, payload: SetPriorityPayload): Promise<TaskMutationPreviewResult>;
  setPriority(taskId: string, payload: SetPriorityPayload): Promise<any>;
  previewSetSize(taskId: string, payload: SetSizePayload): Promise<TaskMutationPreviewResult>;
  setSize(taskId: string, payload: SetSizePayload): Promise<any>;
  previewSetDeps(taskId: string, payload: SetDepsPayload): Promise<TaskMutationPreviewResult>;
  setDeps(taskId: string, payload: SetDepsPayload): Promise<any>;
}

export const timelineApi: TimelineApiExtensions = {
  async getTasksGraph(filters?: { kind?: string[]; label?: string[] }): Promise<TaskGraphResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TaskGraphResponse>('getGraph', filters);
    }
    const params = new URLSearchParams();
    if (filters?.kind) {
      filters.kind.forEach((k) => params.append('kind', k));
    }
    if (filters?.label) {
      filters.label.forEach((l) => params.append('label', l));
    }
    const qs = params.toString();
    return apiFetch<TaskGraphResponse>(qs ? `/api/tasks/graph?${qs}` : '/api/tasks/graph');
  },

  async previewSetPriority(taskId: string, payload: SetPriorityPayload): Promise<TaskMutationPreviewResult> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TaskMutationPreviewResult>('previewSetPriority', { taskId, ...payload });
    }
    return apiFetch<TaskMutationPreviewResult>(`/api/tasks/${encodeURIComponent(taskId)}/priority/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async setPriority(taskId: string, payload: SetPriorityPayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('setPriority', { taskId, ...payload });
    }
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/priority`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewSetSize(taskId: string, payload: SetSizePayload): Promise<TaskMutationPreviewResult> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TaskMutationPreviewResult>('previewSetSize', { taskId, ...payload });
    }
    return apiFetch<TaskMutationPreviewResult>(`/api/tasks/${encodeURIComponent(taskId)}/size/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async setSize(taskId: string, payload: SetSizePayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('setSize', { taskId, ...payload });
    }
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/size`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewSetDeps(taskId: string, payload: SetDepsPayload): Promise<TaskMutationPreviewResult> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TaskMutationPreviewResult>('previewSetDeps', { taskId, ...payload });
    }
    return apiFetch<TaskMutationPreviewResult>(`/api/tasks/${encodeURIComponent(taskId)}/deps/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async setDeps(taskId: string, payload: SetDepsPayload): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('setDeps', { taskId, ...payload });
    }
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/deps`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

Object.assign(api, timelineApi);

// ============================================================================
// Answer and Resume API (Task 08.6)
// ============================================================================

import type {
  AnswerAndResumePayload,
  AnswerAndResumePreviewResponse,
  AnswerAndResumeResponse,
} from './types';

export interface AnswerAndResumeApiExtensions {
  previewAnswerAndResume(id: string, payload: AnswerAndResumePayload): Promise<AnswerAndResumePreviewResponse>;
  answerAndResume(id: string, payload: AnswerAndResumePayload): Promise<AnswerAndResumeResponse>;
}

export const answerAndResumeApi: AnswerAndResumeApiExtensions = {
  async previewAnswerAndResume(id: string, payload: AnswerAndResumePayload): Promise<AnswerAndResumePreviewResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<AnswerAndResumePreviewResponse>('previewAnswerAndResume', { id, ...payload });
    }
    return apiFetch<AnswerAndResumePreviewResponse>(`/api/questions/${encodeURIComponent(id)}/answer-and-resume/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async answerAndResume(id: string, payload: AnswerAndResumePayload): Promise<AnswerAndResumeResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<AnswerAndResumeResponse>('answerAndResume', { id, ...payload });
    }
    return apiFetch<AnswerAndResumeResponse>(`/api/questions/${encodeURIComponent(id)}/answer-and-resume`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

Object.assign(api, answerAndResumeApi);

// ---------------------------------------------------------------------------
// Task Structure Operations (Task 11.3)
// ---------------------------------------------------------------------------

export interface TaskStructureApiExtensions {
  previewAddChild(parentId: string, payload: { title: string; kind?: string }): Promise<StructureActionResponse>;
  addChild(parentId: string, payload: { title: string; kind?: string; expect_plan_hash: string }): Promise<StructureActionResponse>;
  previewExpandTask(taskId: string): Promise<StructureActionResponse>;
  expandTask(taskId: string, payload: { expect_plan_hash: string }): Promise<StructureActionResponse>;
  previewCollapseTask(taskId: string): Promise<StructureActionResponse>;
  collapseTask(taskId: string, payload: { expect_plan_hash: string }): Promise<StructureActionResponse>;
  previewReopenTask(taskId: string, payload: { reason: string }): Promise<StructureActionResponse>;
  reopenTask(taskId: string, payload: { reason: string; expect_plan_hash: string }): Promise<StructureActionResponse>;
}

export const taskStructureApi: TaskStructureApiExtensions = {
  async previewAddChild(parentId: string, payload: { title: string; kind?: string }): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('previewAddChild', { id: parentId, ...payload });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(parentId)}/child/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async addChild(parentId: string, payload: { title: string; kind?: string; expect_plan_hash: string }): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('addChild', { id: parentId, ...payload });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(parentId)}/child`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewExpandTask(taskId: string): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('previewExpandTask', { id: taskId });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/expand/preview`, {
      method: 'POST',
    });
  },

  async expandTask(taskId: string, payload: { expect_plan_hash: string }): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('expandTask', { id: taskId, ...payload });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/expand`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewCollapseTask(taskId: string): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('previewCollapseTask', { id: taskId });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/collapse/preview`, {
      method: 'POST',
    });
  },

  async collapseTask(taskId: string, payload: { expect_plan_hash: string }): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('collapseTask', { id: taskId, ...payload });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/collapse`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewReopenTask(taskId: string, payload: { reason: string }): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('previewReopenTask', { id: taskId, ...payload });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/reopen/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async reopenTask(taskId: string, payload: { reason: string; expect_plan_hash: string }): Promise<StructureActionResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<StructureActionResponse>('reopenTask', { id: taskId, ...payload });
    }
    return apiFetch<StructureActionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/reopen`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

Object.assign(api, taskStructureApi);

// ---------------------------------------------------------------------------
// Microtasks, Kinds & Labels API (Task 10.5)
// ---------------------------------------------------------------------------

import type {
  LabelsResponse,
  CreateMicrotaskPayload,
  CreateMicrotaskResponse,
  PromoteMicrotaskPayload,
  PromoteMicrotaskResponse,
  SetKindPayload,
  SetKindResponse,
  SetLabelsPayload,
  SetLabelsResponse,
  InboxToMicrotaskPayload,
} from './types';

export interface MicrotaskAndLabelsApiExtensions {
  getLabels(): Promise<LabelsResponse>;
  createMicrotask(payload: CreateMicrotaskPayload): Promise<CreateMicrotaskResponse>;
  previewPromoteMicrotask(taskId: string, payload?: PromoteMicrotaskPayload): Promise<PromoteMicrotaskResponse>;
  promoteMicrotask(taskId: string, payload?: PromoteMicrotaskPayload): Promise<PromoteMicrotaskResponse>;
  previewSetKind(taskId: string, payload: SetKindPayload): Promise<SetKindResponse>;
  setKind(taskId: string, payload: SetKindPayload): Promise<SetKindResponse>;
  previewSetLabels(taskId: string, payload: SetLabelsPayload): Promise<SetLabelsResponse>;
  setLabels(taskId: string, payload: SetLabelsPayload): Promise<SetLabelsResponse>;
  inboxToMicrotask(noteId: string, payload?: InboxToMicrotaskPayload): Promise<CreateMicrotaskResponse>;
}

export const microtaskAndLabelsApi: MicrotaskAndLabelsApiExtensions = {
  async getLabels(): Promise<LabelsResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<LabelsResponse>('getLabels');
    }
    return apiFetch<LabelsResponse>('/api/tasks/labels');
  },

  async createMicrotask(payload: CreateMicrotaskPayload): Promise<CreateMicrotaskResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<CreateMicrotaskResponse>('createMicrotask', payload);
    }
    return apiFetch<CreateMicrotaskResponse>('/api/tasks/micro', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewPromoteMicrotask(taskId: string, payload?: PromoteMicrotaskPayload): Promise<PromoteMicrotaskResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<PromoteMicrotaskResponse>('previewPromoteMicrotask', { taskId, ...payload });
    }
    return apiFetch<PromoteMicrotaskResponse>(`/api/tasks/${encodeURIComponent(taskId)}/promote/preview`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async promoteMicrotask(taskId: string, payload?: PromoteMicrotaskPayload): Promise<PromoteMicrotaskResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<PromoteMicrotaskResponse>('promoteMicrotask', { taskId, ...payload });
    }
    return apiFetch<PromoteMicrotaskResponse>(`/api/tasks/${encodeURIComponent(taskId)}/promote`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async previewSetKind(taskId: string, payload: SetKindPayload): Promise<SetKindResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<SetKindResponse>('previewSetKind', { taskId, ...payload });
    }
    return apiFetch<SetKindResponse>(`/api/tasks/${encodeURIComponent(taskId)}/kind/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async setKind(taskId: string, payload: SetKindPayload): Promise<SetKindResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<SetKindResponse>('setKind', { taskId, ...payload });
    }
    return apiFetch<SetKindResponse>(`/api/tasks/${encodeURIComponent(taskId)}/kind`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewSetLabels(taskId: string, payload: SetLabelsPayload): Promise<SetLabelsResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<SetLabelsResponse>('previewSetLabels', { taskId, ...payload });
    }
    return apiFetch<SetLabelsResponse>(`/api/tasks/${encodeURIComponent(taskId)}/labels/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async setLabels(taskId: string, payload: SetLabelsPayload): Promise<SetLabelsResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<SetLabelsResponse>('setLabels', { taskId, ...payload });
    }
    return apiFetch<SetLabelsResponse>(`/api/tasks/${encodeURIComponent(taskId)}/labels`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async inboxToMicrotask(noteId: string, payload?: InboxToMicrotaskPayload): Promise<CreateMicrotaskResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<CreateMicrotaskResponse>('inboxToMicrotask', { noteId, ...payload });
    }
    return apiFetch<CreateMicrotaskResponse>(`/api/inbox/${encodeURIComponent(noteId)}/to-microtask`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },
};

Object.assign(api, microtaskAndLabelsApi);

// ---------------------------------------------------------------------------
// Orchestrator Chat & Controls API (Task 12.8)
// ---------------------------------------------------------------------------

import type {
  OrchestratorStatus,
  OrchestratorTurn,
  OrchestratorConversationResponse,
  PostChatResponse,
} from './types';

export interface OrchestratorChatApiExtensions {
  getOrchestratorStatus(): Promise<OrchestratorStatus>;
  postOrchestratorChat(message: string, options?: { type?: string; priority?: string; policy?: string }): Promise<PostChatResponse>;
  getOrchestratorConversation(params?: { limit?: number; offset?: number; order?: string }): Promise<OrchestratorConversationResponse>;
  getOrchestratorTurn(turnId: string): Promise<{ ok: boolean; turn: OrchestratorTurn }>;
  pauseOrchestrator(): Promise<any>;
  resumeOrchestrator(): Promise<any>;
  rotateOrchestrator(payload?: { tool?: string; model?: string; reason?: string; no_handoff?: boolean }): Promise<any>;
  cancelOrchestratorTurn(turnId: string): Promise<any>;
  runNextOrchestratorTurn(timeout?: number): Promise<any>;
}

export const orchestratorChatApi: OrchestratorChatApiExtensions = {
  async getOrchestratorStatus(): Promise<OrchestratorStatus> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<OrchestratorStatus>('getOrchestratorStatus', {});
    }
    return apiFetch<OrchestratorStatus>('/api/orchestrator/status');
  },

  async postOrchestratorChat(message: string, options?: { type?: string; priority?: string; policy?: string }): Promise<PostChatResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<PostChatResponse>('postOrchestratorChat', { message, ...options });
    }
    return apiFetch<PostChatResponse>('/api/orchestrator/chat', {
      method: 'POST',
      body: JSON.stringify({ message, ...(options || {}) }),
    });
  },

  async getOrchestratorConversation(params?: { limit?: number; offset?: number; order?: string }): Promise<OrchestratorConversationResponse> {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    if (params?.order) query.set('order', params.order);
    const qs = query.toString();
    if (isVsCode && vscode) {
      return sendVsCodeMessage<OrchestratorConversationResponse>('getOrchestratorConversation', params || {});
    }
    return apiFetch<OrchestratorConversationResponse>(`/api/orchestrator/conversation${qs ? `?${qs}` : ''}`);
  },

  async getOrchestratorTurn(turnId: string): Promise<{ ok: boolean; turn: OrchestratorTurn }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean; turn: OrchestratorTurn }>('getOrchestratorTurn', { turnId });
    }
    return apiFetch<{ ok: boolean; turn: OrchestratorTurn }>(`/api/orchestrator/turns/${encodeURIComponent(turnId)}`);
  },

  async pauseOrchestrator(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('pauseOrchestrator', {});
    }
    return apiFetch<any>('/api/orchestrator/pause', { method: 'POST' });
  },

  async resumeOrchestrator(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('resumeOrchestrator', {});
    }
    return apiFetch<any>('/api/orchestrator/resume', { method: 'POST' });
  },

  async rotateOrchestrator(payload?: { tool?: string; model?: string; reason?: string; no_handoff?: boolean }): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('rotateOrchestrator', payload || {});
    }
    return apiFetch<any>('/api/orchestrator/rotate', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  async cancelOrchestratorTurn(turnId: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('cancelOrchestratorTurn', { turnId });
    }
    return apiFetch<any>(`/api/orchestrator/cancel/${encodeURIComponent(turnId)}`, { method: 'POST' });
  },

  async runNextOrchestratorTurn(timeout?: number): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<any>('runNextOrchestratorTurn', { timeout });
    }
    return apiFetch<any>('/api/orchestrator/run-next', {
      method: 'POST',
      body: JSON.stringify(timeout ? { timeout } : {}),
    });
  },
};

Object.assign(api, orchestratorChatApi);

export const eventsAndTriggersApi = api;

// ---------------------------------------------------------------------------
// Triage Proposal Editing API helpers (Task 09.10)
// ---------------------------------------------------------------------------

export async function acceptTriageWithEdits(
  runId: string,
  payload: AcceptTriagePayload,
): Promise<AcceptTriageResponse> {
  return api.acceptTriage(runId, payload);
}
