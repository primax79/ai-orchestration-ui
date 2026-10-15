import {
  TaskListResponse,
  WorkspaceInfo,
  EnvStatusResponse,
  OrchestrationConfigResponse,
} from './types';

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

export const isVsCode = typeof window.acquireVsCodeApi === 'function';
export const vscode = isVsCode && window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

// Helper for HTTP fetch in browser mode
async function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : endpoint;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    let err = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.error) err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    } catch {}
    throw new Error(err);
  }
  return res.json();
}

export const api = {
  async getWorkspace(): Promise<WorkspaceInfo> {
    return apiFetch<WorkspaceInfo>('/api/workspace');
  },

  async switchWorkspace(workspacePath: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>('/api/workspace/switch', {
      method: 'POST',
      body: JSON.stringify({ workspace_path: workspacePath }),
    });
  },

  async getTasks(): Promise<TaskListResponse> {
    return apiFetch<TaskListResponse>('/api/tasks');
  },

  async validateTasks(): Promise<any> {
    return apiFetch('/api/tasks/validate');
  },

  async transitionTask(
    taskId: string,
    newState: string,
    actor = 'operator',
    verifier?: string,
    reason?: string
  ): Promise<any> {
    return apiFetch('/api/tasks/transition', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        new_state: newState,
        actor,
        verifier,
        reason,
      }),
    });
  },

  async syncIndex(): Promise<any> {
    return apiFetch('/api/tasks/sync-index', { method: 'POST' });
  },

  async getTaskDetail(taskId: string): Promise<any> {
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`);
  },

  async getEnvStatus(): Promise<EnvStatusResponse> {
    return apiFetch<EnvStatusResponse>('/api/env/status');
  },

  async installSkills(
    assistants: string[],
    scope: 'global' | 'project',
    repo = 'ai-orchestration',
    link = false
  ): Promise<any> {
    return apiFetch('/api/env/install-skills', {
      method: 'POST',
      body: JSON.stringify({ assistants, scope, repo, link }),
    });
  },

  async registerMcp(
    server: string,
    assistants: string[],
    scope: 'global' | 'project',
    provisionVenv = false
  ): Promise<any> {
    return apiFetch('/api/env/register-mcp', {
      method: 'POST',
      body: JSON.stringify({
        server,
        assistants,
        scope,
        provision_venv: provisionVenv,
      }),
    });
  },

  async getConfig(): Promise<OrchestrationConfigResponse> {
    return apiFetch<OrchestrationConfigResponse>('/api/config/show');
  },

  async setProfile(
    tool: string,
    profile: string,
    model: string,
    variant?: string,
    effort?: string,
    scope: 'global' | 'project' = 'global'
  ): Promise<any> {
    return apiFetch('/api/config/set-profile', {
      method: 'POST',
      body: JSON.stringify({ tool, profile, model, variant, effort, scope }),
    });
  },

  async renderAgentsMd(): Promise<any> {
    return apiFetch('/api/config/render-agents-md');
  },

  async applyAgentsMd(): Promise<any> {
    return apiFetch('/api/config/render-agents-md/apply', { method: 'POST' });
  },

  connectWebSocket(onMessage: (msg: any) => void): () => void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:8765';
    const ws = new WebSocket(`${protocol}//${host}/ws`);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch {}
    };

    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      }
    }, 15000);

    return () => {
      clearInterval(interval);
      ws.close();
    };
  },
};
