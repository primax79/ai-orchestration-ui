import {
  TaskListResponse,
  WorkspaceInfo,
  EnvStatusResponse,
  OrchestrationConfigResponse,
  QuestionListResponse,
  QuestionItem,
  AskQuestionPayload,
  AnswerQuestionPayload,
  WithdrawQuestionPayload,
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
let globalWsListener: ((msg: any) => void) | null = null;

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
    } else if (type === 'tasks_changed' && globalWsListener) {
      globalWsListener({ type: 'tasks_changed' });
    } else if (type === 'changed' && globalWsListener) {
      globalWsListener(event.data);
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

  async getTasks(): Promise<TaskListResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<TaskListResponse>('getTasks');
    }
    return apiFetch<TaskListResponse>('/api/tasks');
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
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewSetProfile', { tool, profile, model, variant, effort, basis, scope });
    }
    return apiFetch('/api/config/set-profile/preview', {
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
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('setProfile', { tool, profile, model, expectHash, variant, effort, basis, scope });
    }
    return apiFetch('/api/config/set-profile', {
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
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewSetRouting', { scope, orchestrator, executor, defaultProfile, verificationMode });
    }
    return apiFetch('/api/config/set-routing/preview', {
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
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('setRouting', { expectHash, scope, orchestrator, executor, defaultProfile, verificationMode });
    }
    return apiFetch('/api/config/set-routing', {
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

  async previewAgentsMd(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('previewAgentsMd');
    }
    return apiFetch('/api/config/render-agents-md/preview');
  },

  async applyAgentsMd(expectHash: string, allowGlobalRouting = false): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('applyAgentsMd', { expectHash, allowGlobalRouting });
    }
    return apiFetch('/api/config/render-agents-md/apply', {
      method: 'POST',
      body: JSON.stringify({ expect_hash: expectHash, allow_global_routing: allowGlobalRouting }),
    });
  },

  connectWebSocket(
    onMessage: (msg: any) => void,
    onStatusChange?: (status: 'connected' | 'disconnected') => void
  ): () => void {
    if (isVsCode) {
      globalWsListener = onMessage;
      onStatusChange?.('connected');
      return () => {
        globalWsListener = null;
      };
    }

    let ws: WebSocket | null = null;
    let pingInterval: any = null;
    let reconnectTimeout: any = null;
    let isDisposed = false;
    let backoffMs = 1000;
    let hasConnectedOnce = false;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:8780';
    const token = getApiToken();
    const wsUrl = token
      ? `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`
      : `${protocol}//${host}/ws`;

    function scheduleReconnect() {
      if (isDisposed || reconnectTimeout) return;
      onStatusChange?.('disconnected');
      const delay = backoffMs;
      backoffMs = Math.min(30000, Math.round(backoffMs * 1.5));
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connect();
      }, delay);
    }

    function connect() {
      if (isDisposed) return;
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          backoffMs = 1000;
          onStatusChange?.('connected');
          if (hasConnectedOnce) {
            // Signal a reconnection so the app can reload state
            onMessage({ type: 'reconnected' });
          }
          hasConnectedOnce = true;
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'connected') {
              onStatusChange?.('connected');
            }
            onMessage(data);
          } catch {}
        };

        ws.onerror = () => {
          scheduleReconnect();
        };

        ws.onclose = () => {
          scheduleReconnect();
        };
      } catch {
        scheduleReconnect();
      }
    }

    connect();

    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send('ping');
        } catch {}
      }
    }, 15000);

    return () => {
      isDisposed = true;
      if (pingInterval) clearInterval(pingInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
    };
  },
};
