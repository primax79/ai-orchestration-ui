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

export const isVsCode = typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function';
export const vscode = isVsCode && window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

let messageSeq = 0;
const pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
let globalWsListener: ((msg: any) => void) | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const { id, data, error, ok, type } = event.data || {};
    if (id && pendingRequests.has(id)) {
      const { resolve, reject } = pendingRequests.get(id)!;
      pendingRequests.delete(id);
      if (ok) {
        resolve(data);
      } else {
        reject(new Error(error || 'VS Code message failed'));
      }
    } else if (type === 'tasks_changed' && globalWsListener) {
      globalWsListener({ type: 'tasks_changed' });
    }
  });
}

function sendVsCodeMessage<T>(type: string, payload?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!vscode) return reject(new Error('VS Code API not available'));
    const id = `req_${++messageSeq}_${Date.now()}`;
    pendingRequests.set(id, { resolve, reject });
    vscode.postMessage({ id, type, payload });
  });
}

// Helper for HTTP fetch in standalone browser mode
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
    if (isVsCode && vscode) {
      return sendVsCodeMessage<WorkspaceInfo>('getWorkspace');
    }
    return apiFetch<WorkspaceInfo>('/api/workspace');
  },

  async switchWorkspace(workspacePath: string): Promise<{ ok: boolean }> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<{ ok: boolean }>('switchWorkspace', { workspacePath });
    }
    return apiFetch<{ ok: boolean }>('/api/workspace/switch', {
      method: 'POST',
      body: JSON.stringify({ workspace_path: workspacePath }),
    });
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
    reason?: string
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('transitionTask', { taskId, newState, actor, verifier, reason });
    }
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
    if (isVsCode && vscode) {
      return sendVsCodeMessage('syncIndex');
    }
    return apiFetch('/api/tasks/sync-index', { method: 'POST' });
  },

  async getTaskDetail(taskId: string): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('getTaskDetail', { taskId });
    }
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`);
  },

  async getEnvStatus(): Promise<EnvStatusResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<EnvStatusResponse>('getEnvStatus');
    }
    return apiFetch<EnvStatusResponse>('/api/env/status');
  },

  async installSkills(
    assistants: string[],
    scope: 'global' | 'project',
    repo = 'ai-orchestration',
    link = false
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('installSkills', { assistants, scope, repo, link });
    }
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
    if (isVsCode && vscode) {
      return sendVsCodeMessage('registerMcp', { server, assistants, scope, provisionVenv });
    }
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

  async removeSkill(
    skill: string,
    assistant: string,
    scope: 'global' | 'project' = 'global'
  ): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('removeSkill', { skill, assistant, scope });
    }
    return apiFetch('/api/env/remove-skill', {
      method: 'POST',
      body: JSON.stringify({ skill, assistant, scope }),
    });
  },

  async resolveConflicts(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('resolveConflicts');
    }
    return apiFetch('/api/env/resolve-conflicts', { method: 'POST' });
  },

  async getConfig(): Promise<OrchestrationConfigResponse> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage<OrchestrationConfigResponse>('getConfig');
    }
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
    if (isVsCode && vscode) {
      return sendVsCodeMessage('setProfile', { tool, profile, model, variant, effort, scope });
    }
    return apiFetch('/api/config/set-profile', {
      method: 'POST',
      body: JSON.stringify({ tool, profile, model, variant, effort, scope }),
    });
  },

  async renderAgentsMd(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('renderAgentsMd');
    }
    return apiFetch('/api/config/render-agents-md');
  },

  async applyAgentsMd(): Promise<any> {
    if (isVsCode && vscode) {
      return sendVsCodeMessage('applyAgentsMd');
    }
    return apiFetch('/api/config/render-agents-md/apply', { method: 'POST' });
  },

  connectWebSocket(onMessage: (msg: any) => void): () => void {
    if (isVsCode) {
      globalWsListener = onMessage;
      return () => {
        globalWsListener = null;
      };
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:8780';
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
