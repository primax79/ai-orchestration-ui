export type TaskState =
  | 'open'
  | 'in progress'
  | 'waiting'
  | 'blocked'
  | 'delivered'
  | 'bounced'
  | 'verified'
  | 'done'
  | 'done with a caveat'
  | 'dropped';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type CognitiveProfile = 'deep-reasoning' | 'orchestration' | 'bulk-execution' | 'exploration';
export type VerificationMode = 'self' | 'independent-session' | 'cross-agent' | 'panel' | 'owner';

export interface TaskItem {
  kind: 'emergent' | 'initiative_task';
  id: string;
  title: string;
  category: string;
  priority: Priority;
  priority_reason?: string;
  next_up?: string;
  state: TaskState;
  executor: string;
  depends_on?: string;
  decider?: string;
  sources?: string;
  paths?: string;
  handoff?: string;
  profile?: CognitiveProfile;
  verification_mode?: VerificationMode;
  verifier?: string;
  file_path?: string;
  is_done?: boolean;
}

export interface InitiativeItem {
  id: string;
  title: string;
  slug: string;
  plan_path: string;
  tasks_count: number;
}

export interface TaskListResponse {
  ok: boolean;
  tasks_dir: string;
  emergent_tasks: TaskItem[];
  initiatives: InitiativeItem[];
  all_tasks?: TaskItem[];
}

export interface WorkspaceInfo {
  workspace_path: string;
  workspace_name: string;
  has_tasks_dir: boolean;
  tasks_path: string | null;
}

export interface CliInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface InstalledSkill {
  state: 'up-to-date' | 'modified-or-outdated' | 'unmanaged';
  is_symlink: boolean;
  installed_hash: string;
  source_repo: string | null;
  source_hash: string | null;
}

export interface AssistantScopeEnv {
  skills_dir: string;
  installed_count: number;
  skills: Record<string, InstalledSkill>;
  conflicts: string[];
  mcp_config_path: string;
  registered_mcps: string[];
}

export interface EnvStatusResponse {
  clis: Record<string, CliInfo>;
  source_repos: Record<string, { available: boolean; path: string | null; has_server_py: boolean; has_venv: boolean }>;
  available_catalog_count: number;
  environments: Record<string, Record<string, AssistantScopeEnv>>;
}

export interface OrchestrationConfigResponse {
  meta: {
    global_config_path: string;
    global_config_exists: boolean;
    project_config_path: string | null;
    project_config_exists: boolean;
  };
  valid: boolean;
  errors: string[];
  warnings: string[];
  config: {
    routing: {
      default_orchestrator: string;
      default_executor: string;
      default_profile: string;
    };
    verification: {
      default_mode: VerificationMode;
      cross_agent_order: string[];
      panel_reviewers: string[];
      panel_require_blind: boolean;
    };
    tools: Record<string, any>;
    project?: Record<string, any>;
  };
}
