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
  kind: 'emergent' | 'initiative_task' | string;
  id: string;
  title: string;
  category: string;
  priority: Priority;
  priority_reason?: string;
  next_up?: string;
  size?: string;
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
  bundle_sha256?: string;
  task_bundle_sha256?: string;
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

export interface SkillEntry {
  name: string;
  origin: string;
  scope: string;
  path: string;
  enabled: boolean;
  state: string;
}

export interface StructuredConflict {
  kind: string;
  names: string[];
  entries?: SkillEntry[];
}

export interface McpServerInfo {
  name: string;
  scope: string;
  provenance: string;
  overrides?: string[];
  config?: any;
  command?: string;
  args?: string[];
}

export interface AssistantScopeEnv {
  skills_dir: string;
  installed_count: number;
  skills: Record<string, InstalledSkill>;
  skill_entries?: SkillEntry[];
  agents_dir?: string;
  agents?: Record<string, any>;
  conflicts: string[];
  structured_conflicts?: StructuredConflict[];
  mcp_config_path: string | null;
  registered_mcps: string[];
  mcp_servers?: Record<string, McpServerInfo>;
}

export interface EnvStatusResponse {
  clis: Record<string, CliInfo>;
  source_repos: Record<string, { available: boolean; path: string | null; has_server_py: boolean; has_venv: boolean }>;
  available_catalog_count: number;
  environments: Record<string, Record<string, AssistantScopeEnv>>;
  stray?: string[];
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
    agents_md?: Record<string, any>;
    schema_version?: number;
    last_verified?: string;
  };
}

export interface ConfigPreviewResponse {
  ok: boolean;
  path: string;
  diff: string;
  hash: string;
  changed: boolean;
  warnings?: string[];
  error?: string;
}

export interface ConfigApplyResponse {
  ok: boolean;
  path: string;
  hash?: string;
  warnings?: string[];
  error?: string;
}

export interface QuestionOption {
  label: string;
  title: string;
  consequence?: string | null;
  raw?: string;
}

export interface QuestionAnswer {
  choice: string;
  answered_by?: string;
  answered?: string;
  text?: string | null;
}

export interface QuestionItem {
  id: string;
  question: string;
  status: 'open' | 'answered' | 'withdrawn' | string;
  blocks: string;
  blocks_parsed?: [string, string][];
  decider: string;
  asked_by: string;
  asked: string;
  origin_run?: string;
  open_answer: 'yes' | 'no' | string;
  recommended: string;
  title?: string;
  context?: string;
  options?: QuestionOption[];
  answer?: QuestionAnswer;
  rel_path?: string;
  filename?: string;
}

export interface QuestionListResponse {
  ok: boolean;
  questions: QuestionItem[];
}

export interface AskQuestionPayload {
  question: string;
  context?: string;
  options?: Array<{ label: string; title: string; consequence?: string }>;
  recommended?: string;
  open_answer?: boolean | 'yes' | 'no';
  blocks?: string | string[];
  decider?: string;
  asked_by?: string;
  origin_run?: string;
  from_task?: string;
}

export interface AnswerQuestionPayload {
  choice: string;
  text?: string;
  by?: string;
}

export interface WithdrawQuestionPayload {
  reason: string;
  by?: string;
}

// ---------------------------------------------------------------------------
// Run Engine Types (Task 07.7)
// ---------------------------------------------------------------------------

export type RunStatus = 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost' | string;
export type RunMode = 'execute' | 'orchestrate' | 'verify' | string;

export interface ToolStatus {
  enabled: boolean;
  installed: boolean;
  available: boolean;
  cli_command?: string;
  path?: string | null;
  version?: string | null;
  reason?: string | null;
}

export interface ProfileModelConfig {
  model?: string;
  variant?: string;
  effort?: string;
}

export interface ResolvedDefaultRun {
  mode: string;
  tool: string;
  profile: string;
  model?: string;
  variant?: string;
  effort?: string;
  isolation?: string;
  target_run?: string;
}

export interface VerifyTarget {
  run_id: string;
  ended_at?: string;
  final_commit?: string;
  tool?: string;
}

export interface RunOptionsResponse {
  ok: boolean;
  task: {
    id: string;
    title: string;
    state: string;
    executor: string;
    profile?: string;
    bundle_sha256?: string;
  };
  allowed_modes: string[];
  default_mode: string;
  tools: Record<string, ToolStatus>;
  models_per_profile: Record<string, Record<string, ProfileModelConfig>>;
  resolved_defaults: Record<string, ResolvedDefaultRun>;
  usable_verify_targets: VerifyTarget[];
}

export interface RunPreviewPayload {
  task: string;
  mode?: string;
  tool?: string;
  profile?: string;
  model?: string;
  variant?: string;
  effort?: string;
  isolation?: string;
  target_run?: string;
  instructions?: string;
  allow_same_tool?: boolean;
  allow_dirty_base?: boolean;
  force?: boolean;
}

export interface RunPreviewResponse {
  ok: boolean;
  prompt: string;
  prompt_sha256?: string;
  argv_display: string[];
  cwd: string;
  planned_worktree?: string | null;
  planned_branch?: string | null;
  warnings: string[];
  plan_hash: string;
}

export interface RunStartPayload {
  task: string;
  expect_plan_hash: string;
  mode?: string;
  tool?: string;
  profile?: string;
  model?: string;
  variant?: string;
  effort?: string;
  isolation?: string;
  target_run?: string;
  instructions?: string;
  allow_same_tool?: boolean;
  allow_dirty_base?: boolean;
  force?: boolean;
}

export interface RunContinuePayload {
  instructions?: string;
  expect_plan_hash?: string;
}

export interface FindingItem {
  id: string;
  severity: 'blocker' | 'major' | 'minor' | string;
  text: string;
}

export interface CheckItem {
  step: string;
  result: 'pass' | 'fail' | string;
  evidence?: string;
}

export interface RunVerdict {
  verdict: 'verified' | 'bounced' | string;
  findings?: FindingItem[];
  checks?: CheckItem[];
}

export interface RunRecord {
  run_id: string;
  task_id: string;
  mode: RunMode;
  tool: string;
  profile: string;
  model?: string;
  variant?: string;
  effort?: string;
  requested_by?: string;
  workspace?: string;
  cwd?: string;
  isolation?: string;
  worktree_path?: string | null;
  branch?: string | null;
  base_commit?: string | null;
  final_commit?: string | null;
  commits_after_base?: number | null;
  invariant_error?: string | null;
  target_run?: string | null;
  target_commit?: string | null;
  task_bundle_sha256?: string | null;
  plan_hash?: string;
  supervisor?: { pid: number | null; start_time: number | null };
  agent?: { pid: number | null; pgid: number | null; start_time: number | null };
  argv_display?: string[];
  status: RunStatus;
  exit_code?: number | null;
  started_at?: string;
  ended_at?: string | null;
  session_id?: string | null;
  continued_from?: string | null;
  final_report?: string | null;
  verdict?: RunVerdict | null;
  panel_id?: string | null;
  verification_mode?: string | null;
  keep_worktree?: boolean;
  worktree_removed?: boolean | null;
  questions?: string[];
  question_errors?: any[];
  task_transition_error?: string | null;
}

export interface RunListResponse {
  ok: boolean;
  runs: RunRecord[];
}

export interface RunLogEvent {
  offset?: number;
  type?: string;
  text?: string;
  tool_call?: any;
  error?: any;
  raw?: any;
  [key: string]: any;
}

export interface RunLogsResponse {
  ok: boolean;
  run_id: string;
  first_available_offset: number;
  next_offset: number;
  events: RunLogEvent[];
  raw?: string;
}

export interface RunCleanupPayload {
  discard?: boolean;
  dry_run?: boolean;
  expect_plan_hash?: string;
}

export interface RunApplyVerdictPayload {
  expect_task_hash?: string;
  panel_id?: string;
}

export interface RunMarkDeliveredPayload {
  expect_task_hash?: string;
}

