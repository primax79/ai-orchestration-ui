export type TaskState =
  | 'open'
  | 'in progress'
  | 'paused'
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

export interface AttachmentDetail {
  name: string;
  class: 'image' | 'text' | 'pdf' | string;
  size: number;
}

export interface TaskConditionItem {
  id: string;
  status: string;
  short_title?: string;
  age_days?: number;
  decider?: string;
}

export interface TaskCoordinateItem {
  project: string;
  id: string;
  short_title?: string;
  state?: TaskState | string;
}

export type ProjectKind = 'project' | '_workspace' | 'sub_workspace' | string;

export interface ProjectCounts {
  open: number;
  'in progress': number;
  waiting: number;
  blocked: number;
  paused: number;
  bounced: number;
  delivered: number;
  verified: number;
  done: number;
  dropped: number;
  total: number;
  conditional?: number;
  [key: string]: number | undefined;
}

export interface WorkspaceProjectInfo {
  id: string;
  path: string;
  kind: ProjectKind;
  uuid?: string | null;
  counts?: ProjectCounts;
  open_questions?: number;
  inbox_notes?: number;
  conditional?: number;
}

export interface TaskItem {
  kind: 'emergent' | 'initiative_task' | string;
  id: string;
  project?: string;
  qualified_id?: string;
  title: string;
  short?: string;
  short_title?: string;
  short_title_source?: 'field' | 'derived';
  category: string;
  priority: Priority;
  priority_reason?: string;
  next_up?: string;
  size?: string;
  state: TaskState;
  canonical_state?: TaskState | string;
  executor: string;
  depends_on?: string;
  decider?: string;
  sources?: string;
  paths?: string;
  handoff?: string;
  profile?: CognitiveProfile;
  verification_mode?: VerificationMode;
  verifier?: string;
  verify_by?: string | null;
  'verify-by'?: string | null;
  file_path?: string;
  is_done?: boolean;
  bundle_sha256?: string;
  task_bundle_sha256?: string;
  attachments?: string[];
  attachment_details?: AttachmentDetail[];
  parent?: string | null;
  depth?: number;
  node_type?: string;
  is_leaf?: boolean;
  is_container?: boolean;
  is_folder?: boolean;
  children?: string[];
  fields?: Record<string, TreeNodeField>;
  derived_state?: TaskState | string | null;
  leaves_done?: number;
  leaves_total?: number;
  labels?: string[];
  label_sources?: Record<string, string>;
  priority_source?: string;
  size_source?: string;
  conditional?: boolean;
  conditions?: TaskConditionItem[];
  coordinates?: TaskCoordinateItem[];
  placement_warning?: string;
  placement_warnings?: string[];
  warnings?: string[];
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
  tree?: Record<string, TreeNode>;
}

export interface WorkspaceTasksResponse {
  ok: boolean;
  tasks: TaskItem[];
  items?: TaskItem[];
  total: number;
  page: number;
  per_page: number;
}

export interface WorkspaceInfo {
  root?: string;
  workspace_path: string;
  workspace_name: string;
  mode?: 'registered' | 'discovered' | 'single' | string;
  registered?: boolean;
  discovered?: boolean;
  single?: boolean;
  has_tasks_dir: boolean;
  tasks_path: string | null;
  projects?: WorkspaceProjectInfo[];
  sub_workspaces?: Array<{
    uuid?: string | null;
    slug: string;
    path: string;
    kind: string;
  }>;
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
  scope?: string;
  fixable?: boolean;
  actionable?: boolean;
  actions?: any[];
  advice?: string[];
  message?: string;
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
  by?: string;
  answered?: string;
  text?: string | null;
}

export interface QuestionItem {
  id: string;
  project?: string;
  question: string;
  short_title?: string;
  short_title_source?: 'field' | 'derived';
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
  applied?: boolean;
  applied_record?: {
    question?: string;
    by?: string;
    at?: string;
    ref?: string;
    note?: string;
  } | null;
}

export interface QuestionListResponse {
  ok: boolean;
  questions: QuestionItem[];
}

export interface AskQuestionPayload {
  question: string;
  short_title?: string;
  short?: string;
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
  task?: string;
  note?: string;
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
  task?: string;
  note?: string;
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
  project?: string;
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
  note_id?: string | null;
  note_bundle_sha256?: string | null;
  proposal_status?: 'pending' | 'invalid' | 'accepted' | string | null;
  proposal_error?: string | null;
  accepted_tasks?: string[];
  accepted_at?: string | null;
}

export interface ProposedTask {
  title: string;
  short_title?: string;
  short_title_source?: 'field' | 'derived';
  category: string;
  priority: Priority | string;
  priority_reason: string;
  goal: string;
  steps?: string[] | string;
  verification?: string;
  [key: string]: any;
}

export interface TriageProposal {
  tasks: ProposedTask[];
  updates?: any[];
  spec?: any;
  questions?: any[];
  [key: string]: any;
}

export interface TriageProposalResponse {
  ok: boolean;
  run_id: string;
  proposal_status: 'pending' | 'invalid' | 'accepted' | string | null;
  proposal_error?: string | null;
  proposal: TriageProposal | null;
}

export interface AcceptTriagePayload {
  only?: number[] | string[];
  expect_note_hash?: string;
}

export interface AcceptTriageResponse {
  ok: boolean;
  run_id: string;
  note_id: string;
  proposal_status: string;
  tasks_created: string[];
  produced?: string;
  processed_by?: string;
  [key: string]: any;
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

// ---------------------------------------------------------------------------
// Inbox Notes Types (Task 09.3)
// ---------------------------------------------------------------------------

export type InboxNoteKind = 'note' | 'bug' | 'feature' | 'idea' | 'request' | 'question';
export type InboxNoteStatus = 'draft' | 'ready' | 'processing' | 'processed' | 'discarded';

export interface InboxNoteItem {
  id: string;
  project?: string;
  title: string;
  kind: InboxNoteKind | string;
  status: InboxNoteStatus | string;
  created: string;
  author: string;
  about: string;
  produced: string;
  processed_by?: string;
  body: string;
  attachments: string[];
  attachment_details?: AttachmentDetail[];
  bundle_sha256?: string;
  legacy?: boolean;
  folder_name?: string;
  folder_path?: string;
  file_path?: string;
  rel_path?: string;
  in_analyzed?: boolean;
}

export interface InboxListResponse {
  ok: boolean;
  notes: InboxNoteItem[];
}

export interface InboxNoteResponse {
  ok: boolean;
  note: InboxNoteItem;
}

export interface AddInboxNotePayload {
  title: string;
  kind?: string;
  about?: string;
  author?: string;
  status?: string;
  body?: string;
}

export interface EditInboxNotePayload {
  title?: string;
  kind?: string;
  about?: string;
  author?: string;
  status?: string;
  body?: string;
  expect_hash?: string;
}

export interface AddInboxNoteResponse {
  ok: boolean;
  id: string;
  rel_path?: string;
  bundle_sha256: string;
}

export interface EditInboxNoteResponse {
  ok: boolean;
  id: string;
  status: string;
  bundle_sha256: string;
}

export interface UploadAttachmentResponse {
  ok: boolean;
  id: string;
  attachment: string;
  markdown: string;
  class?: 'image' | 'text' | 'pdf' | string;
  path?: string;
  bundle_sha256?: string;
}

export interface DeleteAttachmentResponse {
  ok: boolean;
  id: string;
  attachment: string;
  bundle_sha256?: string;
}

export interface ResolveInboxNotePayload {
  produced: string;
  by?: string;
}

export interface DiscardInboxNotePayload {
  reason: string;
}

export interface InboxToTaskPayload {
  category: string;
  title: string;
  priority?: string;
  priority_reason?: string;
  executor?: string;
  next_up?: string;
  depends_on?: string;
  decider?: string;
}

export interface InboxToTaskResponse {
  ok: boolean;
  id: string;
  file?: string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Use Cases & Validation (Spec 15)
// ---------------------------------------------------------------------------

export type UseCaseStatus = 'draft' | 'active' | 'verified' | 'failing' | 'partial' | string;
export type UseCaseStage =
  | 'draft'
  | 'planned'
  | 'in development'
  | 'ready'
  | 'verified'
  | 'failing'
  | 'partial'
  | 'untested'
  | 'ready (revalidation pending)';
export type UseCaseApproval = 'proposed' | 'approved' | 'deprecated';
export type UseCaseVerdict = 'pass' | 'fail' | 'partial' | 'untested';
export type UseCaseVerificationType = 'automated-probe' | 'e2e' | 'code-audit' | 'api-probe';

export interface UseCaseItem {
  id: string;
  title: string;
  short_title?: string;
  short_title_source?: 'field' | 'derived';
  actor: string;
  status: UseCaseStatus;
  stage?: UseCaseStage;
  approval?: UseCaseApproval;
  revalidation?: string | null;
  priority: Priority;
  linked_tasks: string[];
  linked_tasks_details?: Array<{
    id: string;
    title?: string;
    short_title?: string;
    state?: string;
    canonical_state?: string;
    dropped?: boolean;
  }>;
  verification_type: UseCaseVerificationType;
  last_tested?: string | null;
  last_verdict?: UseCaseVerdict | null;
  description?: string;
  preconditions?: string;
  scenario?: string;
  verification_command?: string;
  acceptance_criteria?: string;
  validation_log?: string;
  file_path?: string;
  rel_path?: string;
  content?: string;
}

export interface TaskUseCasesPayload {
  use_cases: string[];
  action: 'link' | 'unlink';
  expect_plan_hash?: string;
}

export interface UseCaseQueueItem {
  id: string;
  use_case_id?: string;
  title: string;
  short_title?: string;
  actor?: string;
  approval?: UseCaseApproval;
  stage?: UseCaseStage;
  status?: string;
  priority?: Priority;
  revalidation?: string;
  last_verdict?: UseCaseVerdict | null;
  last_tested?: string | null;
  linked_tasks?: string[];
  triggering_task?: string;
  date?: string;
  requested_at?: string;
  transition?: string;
  file_path?: string;
  rel_path?: string;
}

export interface UseCaseQueueResponse {
  ok: boolean;
  count: number;
  queue: UseCaseQueueItem[];
  use_cases?: UseCaseQueueItem[];
  items?: UseCaseQueueItem[];
}

export interface UseCaseListResponse {
  ok: boolean;
  tasks_dir: string;
  total: number;
  use_cases: UseCaseItem[];
}

export interface ValidationCampaignResult {
  ok: boolean;
  timestamp: string;
  readiness_score: number;
  total: number;
  passed: number;
  failed: number;
  regressions_count: number;
  regressions: any[];
  report_file: string;
  results: any[];
}

// ============================================================================
// Task 10.2: Timeline & Task Graph Types
// ============================================================================

export type TaskSize = 'XS' | 'S' | 'M' | 'L' | 'XL';

export interface TaskGraphNode {
  id: string;
  project?: string;
  qualified_id?: string;
  node_type?: string;
  kind?: string;
  title: string;
  short_title?: string;
  short_title_source?: 'field' | 'derived';
  group: string;
  state: TaskState;
  canonical_state?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  priority_source?: string;
  size?: TaskSize;
  size_source?: string;
  depends_on: string[];
  expanded_depends_on?: string[];
  column: number | null;
  blocked_by: string[];
  next_up?: string;
  executor?: string;
  labels?: string[];
  conditional?: boolean;
  conditions?: TaskConditionItem[];
  coordinates?: TaskCoordinateItem[];
}

export interface TaskGraphEdge {
  from: string;
  to: string;
  source?: string;
  target?: string;
}

export interface TaskGraphGroupTotals {
  id: string;
  by_size?: Record<string, number>;
  by_state?: Record<string, number>;
  total_open: number;
  total_leaves: number;
}

export interface TaskGraphTotals {
  overall?: string;
  by_state?: Record<string, number>;
  by_size?: Record<string, number>;
  by_group?: Record<string, TaskGraphGroupTotals>;
  total_open?: number;
  total_leaves?: number;
  done?: number;
  delivered?: number;
  open?: number;
  verified?: number;
  'in progress'?: number;
  [key: string]: any;
}

export interface TaskGraphResponse {
  ok: boolean;
  tasks_dir?: string;
  nodes: TaskGraphNode[];
  nodes_by_id?: Record<string, TaskGraphNode>;
  edges: TaskGraphEdge[];
  columns: Record<string, number>;
  ready_queue: string[];
  longest_chain: string[];
  heaviest_chain: string[];
  heaviest_chain_weight: number;
  totals: TaskGraphTotals;
}

export interface TaskMutationPreviewResult {
  ok: boolean;
  task_id: string;
  diff?: string;
  hash?: string;
  task_hash?: string;
  base_task_hash?: string;
  dry_run?: boolean;
  priority?: string;
  size?: string;
  depends_on?: string[];
  error?: string;
}

export interface SetPriorityPayload {
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  reason?: string;
  expect_task_hash?: string;
  expect_hash?: string;
}

export interface SetSizePayload {
  size: TaskSize;
  expect_task_hash?: string;
  expect_hash?: string;
}

export interface SetDepsPayload {
  add?: string[];
  remove?: string[];
  to?: string[];
  deps?: string[];
  expect_task_hash?: string;
  expect_hash?: string;
}

export interface SetShortTitlePayload {
  short_title?: string;
  short?: string;
  expect_plan_hash?: string;
  expect_task_hash?: string;
  expect_hash?: string;
  plan_hash?: string;
  dry_run?: boolean;
}

export interface SetShortTitleResponse {
  ok: boolean;
  task_id?: string;
  short_title?: string;
  short_title_source?: 'field' | 'derived';
  plan_hash?: string;
  task_hash?: string;
  hash?: string;
  diff?: string;
  dry_run?: boolean;
  error?: string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Answer and Resume Types (Task 08.6)
// ---------------------------------------------------------------------------

export interface AnswerAndResumePayload {
  choice: string;
  text?: string;
  expect_plan_hash?: string;
  by?: string;
}

export interface AnswerAndResumePreviewResponse {
  ok: boolean;
  continuable: boolean;
  can_resume?: boolean;
  run_id?: string;
  origin_run?: string;
  question_id?: string;
  plan_hash?: string;
  prompt?: string;
  instructions?: string;
  reason?: string;
  error?: string;
}

export interface AnswerAndResumeResponse {
  ok: boolean;
  question_id: string;
  choice: string;
  resumed: boolean;
  run_id?: string;
  continued_from?: string;
  instructions?: string;
  reason?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Task Hierarchy / Tree Types (Task 11.3)
// ---------------------------------------------------------------------------

export interface TreeNodeField {
  value: any;
  source: string;
}

export interface TreeNode {
  kind?: string;
  id: string;
  project?: string;
  qualified_id?: string;
  title: string;
  short_title?: string;
  short_title_source?: 'field' | 'derived';
  parent: string | null;
  depth: number;
  node_type: 'initiative' | 'leaf' | 'container' | 'microtask' | string;
  is_leaf: boolean;
  is_container: boolean;
  children: string[];
  fields?: Record<string, TreeNodeField>;
  labels?: string[];
  label_sources?: Record<string, string>;
  depends_on?: string[];
  expanded_depends_on?: string[];
  state: TaskState;
  canonical_state: TaskState;
  derived_state: TaskState | null;
  leaves_done: number;
  leaves_total: number;
  file_path?: string;
  rel_path?: string;
  is_folder?: boolean;
  in_done?: boolean;
  in_closed_section?: boolean;
  bundle_sha256?: string;
  task_hash?: string;
  priority: Priority;
  priority_source?: string;
  priority_reason?: string;
  size?: string;
  size_source?: string;
  executor?: string;
  handoff?: string;
  category?: string;
  slug?: string;
  conditional?: boolean;
  conditions?: TaskConditionItem[];
  coordinates?: TaskCoordinateItem[];
  placement_warning?: string;
  placement_warnings?: string[];
  warnings?: string[];
}

export interface StructurePlanItem {
  action: string;
  path: string;
  before_hash: string;
}

export interface StructureActionResponse {
  ok: boolean;
  dry_run?: boolean;
  allocated_id?: string;
  plan_hash?: string;
  hash?: string;
  summary?: string;
  plan?: StructurePlanItem[];
  error?: string;
  folder?: string;
}

export interface AddChildPayload {
  parent?: string;
  title: string;
  short_title?: string;
  short?: string;
  kind?: string;
  expect_plan_hash?: string;
}

export interface ReopenTaskPayload {
  reason: string;
  expect_plan_hash?: string;
}

export interface ExpandTaskPayload {
  expect_plan_hash?: string;
}

export interface CollapseTaskPayload {
  expect_plan_hash?: string;
}

// ---------------------------------------------------------------------------
// Microtasks, Kinds & Labels Types (Task 10.5)
// ---------------------------------------------------------------------------

export type TaskKind = 'bug' | 'chore' | 'docs' | 'feature' | 'fix' | 'investigation';

export interface LabelCountItem {
  label: string;
  count: number;
}

export interface LabelsResponse {
  ok: boolean;
  tasks_dir?: string;
  labels: LabelCountItem[];
  counts: Record<string, number>;
}

export interface CreateMicrotaskPayload {
  title: string;
  short_title?: string;
  short?: string;
  kind?: TaskKind | string;
  priority?: Priority | string;
  paths?: string;
  depends_on?: string;
  labels?: string[] | string;
  label?: string[] | string;
  size?: TaskSize | string;
  executor?: string;
  what?: string;
}

export interface CreateMicrotaskResponse {
  ok: boolean;
  id: string;
  category: string;
  rel_path?: string;
  file_path?: string;
  error?: string;
}

export interface PromoteMicrotaskPayload {
  category?: string;
  expect_task_hash?: string;
  expect_hash?: string;
}

export interface PromoteMicrotaskResponse {
  ok: boolean;
  dry_run?: boolean;
  id: string;
  task_id?: string;
  category: string;
  old_rel_path?: string;
  rel_path?: string;
  file_path?: string;
  summary?: string;
  diff?: string;
  hash?: string;
  task_hash?: string;
  base_task_hash?: string;
  error?: string;
}

export interface SetKindPayload {
  kind: TaskKind | string;
  expect_task_hash?: string;
  expect_hash?: string;
}

export interface SetKindResponse {
  ok: boolean;
  task_id: string;
  kind: string;
  task_hash?: string;
  hash?: string;
  base_task_hash?: string;
  dry_run?: boolean;
  diff?: string;
  error?: string;
}

export interface SetLabelsPayload {
  add?: string[];
  remove?: string[];
  to?: string[];
  labels?: string[];
  expect_task_hash?: string;
  expect_hash?: string;
}

export interface SetLabelsResponse {
  ok: boolean;
  task_id: string;
  labels: string[];
  task_hash?: string;
  hash?: string;
  base_task_hash?: string;
  dry_run?: boolean;
  diff?: string;
  error?: string;
}

export interface SharedFilterState {
  search: string;
  kinds: TaskKind[];
  labels: string[];
  states: TaskState[];
  priority?: Priority | 'all';
  groupByLabel?: boolean;
  projects?: string[];
  groupByProject?: boolean;
}

export interface InboxToMicrotaskPayload {
  title?: string;
  kind?: string;
  priority?: string;
  what?: string;
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Events, Sessions, Triggers & Queue Types (Task 12.6)
// ---------------------------------------------------------------------------

export interface OrchestrationEvent {
  seq: number;
  id: string;
  ts: string;
  type: string;
  subject: string;
  data?: any;
  origin_session?: string | null;
  actor?: string | null;
}

export interface EventsTailResponse {
  ok: boolean;
  events: OrchestrationEvent[];
  count: number;
  first_seq: number | null;
  last_seq: number | null;
}

export interface EventsStatsResponse {
  ok: boolean;
  total_events: number;
  first_seq: number | null;
  last_seq: number | null;
  chunk_count: number;
  chunks?: any[];
  counter: number;
}

export interface OrchestrationSession {
  session_id: string;
  tool: string;
  kind: 'headless' | 'interactive' | string;
  status: 'active' | 'stale' | 'retired' | 'deregistered' | string;
  role?: string | null;
  generation?: number;
  cursor?: number;
  last_seen?: string;
  created_at?: string;
  subscriptions?: string[];
  pending_events_count?: number;
  last_activity_type?: string;
}

export interface TriggerRule {
  name: string;
  on: string;
  when?: Record<string, any>;
  action: string;
  enabled: boolean;
  run?: any;
  command?: string | string[];
  max_per_hour?: number;
}

export interface TriggersListResponse {
  ok: boolean;
  meta: {
    kill_switch_enabled: boolean;
    config_paths: string[];
    rule_count: number;
  };
  rules: TriggerRule[];
  errors?: string[];
}

export interface TriggersStatusResponse {
  ok: boolean;
  kill_switch_enabled: boolean;
  rule_count: number;
  role: string;
  cursor: number;
  total_firings: number;
  daemon: any;
  config_paths: string[];
}

export interface TriggerFiring {
  firing_id: string;
  rule_name: string;
  event_seq: number;
  event_id: string;
  state: 'pending' | 'fired' | 'skipped' | 'retry' | 'dead' | string;
  updated_at: string;
  result?: any;
}

export interface TriggersHistoryResponse {
  ok: boolean;
  count?: number;
  firings: TriggerFiring[];
}

export interface ProposedAction {
  action_id: string;
  action_hash: string;
  type: string;
  rule: string;
  trigger_event?: string;
  trigger_seq?: number;
  created_at: string;
  status: string;
  origin_run?: string;
  run_params?: any;
  command?: string[];
  reason?: string;
  policy?: string;
}

export interface ProposedActionsResponse {
  ok: boolean;
  proposed_actions: ProposedAction[];
  count: number;
}

export interface AwaitingApplicationResponse {
  ok: boolean;
  questions: QuestionItem[];
  count: number;
}

export interface ApplyQuestionPayload {
  by?: string;
  ref?: string;
  note?: string;
  force?: boolean;
  dry_run?: boolean;
}

export interface ApplyQuestionResponse {
  ok: boolean;
  id: string;
  status?: string;
  by?: string;
  record?: any;
  error?: string;
}

export interface OrchestratorTurnItem {
  turn_seq: number;
  turn_id: string;
  role: string;
  created_at: string;
  state: 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'dead' | 'cancelled' | string;
  type: string;
  policy: string;
  trigger_rule?: string;
  trigger_event_id?: string;
  trigger_event_seq?: number;
  events?: any[];
  prompt_data?: any;
}

export interface OrchestratorQueueResponse {
  ok: boolean;
  queue: OrchestratorTurnItem[];
  count: number;
}

export interface NotificationItem {
  id: string;
  type?: string;
  rule?: string;
  event_seq?: number;
  event_type?: string;
  subject?: string;
  data?: any;
  created_at: string;
  read: boolean;
}

export interface NotificationsResponse {
  ok: boolean;
  notifications: NotificationItem[];
  recent_events?: OrchestrationEvent[];
  unread_count: number;
}

// ---------------------------------------------------------------------------
// Orchestrator Chat & Role Types (Task 12.8)
// ---------------------------------------------------------------------------

export interface OrchestratorUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  estimated_context_tokens?: number;
  cost_usd?: number;
}

export interface OrchestratorStatus {
  role: string;
  generation: number;
  status: 'active' | 'paused' | 'rotating' | string;
  session_id?: string | null;
  provider_session_id?: string | null;
  tool?: string | null;
  model?: string | null;
  cursor?: number;
  turns?: number;
  last_usage?: OrchestratorUsage | null;
  consecutive_owner_turns?: number;
  consecutive_turn_failures?: number;
  fencing_token?: string | null;
  queue?: {
    total: number;
    queued: number;
    running: number;
  };
  rotate_after_tokens?: number;
  ok?: boolean;
}

export interface OrchestratorTurn {
  turn_id: string;
  turn_seq: number;
  role?: string;
  type: 'owner_chat' | 'event_batch' | 'handoff' | string;
  state: 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'dead' | 'cancelled' | string;
  policy?: string;
  priority?: string;
  message?: string | null;
  prompt_text?: string | null;
  assistant_messages?: string[];
  output?: string;
  usage?: OrchestratorUsage | null;
  duration_seconds?: number;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  error?: string | null;
  events?: any[];
  bound_exceeded?: string;
  trigger_rule?: string;
}

export interface OrchestratorConversationResponse {
  ok: boolean;
  turns: OrchestratorTurn[];
  count: number;
  limit: number;
  offset: number;
}

export interface PostChatResponse {
  ok: boolean;
  status: string;
  turn_id?: string;
  turn_seq?: number;
  turn?: OrchestratorTurn;
  error?: string;
}

// 12.10: Orchestrator Reassign & Setup Wizard types
export interface OrchestratorReassignPreviewResponse {
  ok: boolean;
  dry_run?: boolean;
  plan?: string;
  plan_hash?: string;
  hash?: string;
  config_hash?: string;
  diff?: string;
  path?: string;
  from_tool?: string;
  to_tool?: string;
  generation?: number;
  target_generation?: number;
  error?: string;
}

export interface ProposedAction {
  confirmed_at?: string;
  confirmed_by?: string;
  rejected_at?: string;
  rejected_by?: string;
  run_id?: string;
  result?: any;
}

export interface ConfirmProposedActionPayload {
  expect_hash: string;
}

export interface RejectProposedActionPayload {
  reason: string;
}

export interface ConfirmProposedActionResponse {
  ok: boolean;
  action_id?: string;
  status?: string;
  run_id?: string;
  result?: any;
  message?: string;
  error?: string;
}

export interface RejectProposedActionResponse {
  ok: boolean;
  action_id?: string;
  status?: string;
  reason?: string;
  message?: string;
  error?: string;
}



export interface OrchestratorReassignApplyResponse {
  ok: boolean;
  status?: string;
  plan?: string;
  plan_hash?: string;
  generation?: number;
  session_id?: string;
  tool?: string;
  model?: string;
  path?: string;
  diff?: string;
  error?: string;
}

export interface SetupToolDetection {
  installed: boolean;
  path?: string;
  version?: string;
  auth_status?: string;
  models?: string[];
}

export interface SetupPlanResponse {
  ok: boolean;
  applied?: boolean;
  detection: Record<string, SetupToolDetection>;
  routing: {
    default_orchestrator: string;
    default_executor: string;
    default_profile: string;
  };
  verification: {
    default_mode: string;
    cross_agent_order: string[];
  };
  profiles: {
    orchestrator: {
      tool: string;
      profile: string;
      model: string;
    };
    executor: {
      tool: string;
      profile: string;
      model: string;
    };
  };
  permission_policy: {
    description: string;
    defaults: Record<string, string[]>;
  };
  scope: string;
  path: string;
  existing_exists: boolean;
  diff: string;
  plan_hash: string;
  config_hash: string;
  hash: string;
  error?: string;
}

export interface SetupApplyResponse {
  ok: boolean;
  applied: boolean;
  scope?: string;
  path?: string;
  plan_hash?: string;
  hash?: string;
  orchestrator_started?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Triage Proposal Editing Types (Task 09.10)
// ---------------------------------------------------------------------------

export interface ProposedTaskEdits {
  title?: string;
  category?: string;
  priority?: Priority | string;
  priority_reason?: string;
  goal?: string;
  steps?: string[];
  verification?: string;
  kind?: string;
  labels?: string[];
  [key: string]: any;
}

export interface AcceptTriagePayload {
  edits?: Record<string | number, ProposedTaskEdits>;
}

export interface ValidateCloseTaskItem {
  id: string;
  task_id: string;
  title: string;
  short_title: string;
  state: string;
  raw_state?: string;
  new_state?: string;
  verify_by?: string | null;
  verifier?: string;
  path?: string[];
  rel_path?: string;
  task_hash?: string;
}

export interface ValidateClosePreviewPayload {
  task_ids: string[];
  note?: string;
}

export interface ValidateClosePreviewResponse {
  ok: boolean;
  dry_run?: boolean;
  tasks: ValidateCloseTaskItem[];
  task_ids: string[];
  count: number;
  verifier: string;
  note?: string | null;
  plan?: StructurePlanItem[];
  plan_hash: string;
  hash: string;
  summary: string;
  error?: string;
}

export interface ValidateCloseApplyPayload {
  task_ids: string[];
  note?: string;
  expect_plan_hash?: string;
  expect_task_hashes?: Record<string, string>;
}

export interface ValidateCloseApplyResponse {
  ok: boolean;
  applied: boolean;
  count: number;
  task_ids: string[];
  verifier: string;
  note?: string | null;
  results: any[];
  index_in_sync?: boolean;
  error?: string;
}

/**
 * Returns item.short_title if present, or derives a compact 3-4 word short title
 * from title/question (dropping leading articles, stripping ids, backticks, parentheticals).
 */
export function shortTitle(
  item?: { short_title?: string; title?: string; question?: string; id?: string } | string | null
): string {
  if (!item) return '';

  if (typeof item === 'object' && item.short_title && item.short_title.trim()) {
    return item.short_title.trim();
  }

  const raw = typeof item === 'string' ? item : item.title || item.question || '';
  if (!raw || !raw.trim()) {
    return typeof item === 'object' && item.id ? item.id : '';
  }

  // 1. Strip backticks
  let text = raw.replace(/`/g, '');

  // 2. Strip parentheticals like (UI), (Spec 15), (T025), etc.
  text = text.replace(/\([^)]*\)/g, ' ');

  // 3. Strip leading task/question IDs or tags (e.g. "T007:", "12.16 -", "Q006: ", "[T025]", "Task 01.1:")
  text = text.replace(/^(\[?(?:[A-Za-z]\d+(?:\.\d+)*|\d+\.\d+|INIT-[A-Za-z0-9_-]+)\]?\s*[:-]?\s*)+/i, '');
  text = text.replace(/^(?:Task|Question)\s+[A-Za-z0-9._-]+\s*[:-]?\s*/i, '');

  // 4. Strip markdown headings or bullet prefixes
  text = text.replace(/^[#\-*:]+\s*/, '');

  // 5. Drop a short code prefix such as "P1-a:" or "P3-a..d:" (mirrors derive_short_title in the engine)
  text = text.replace(/^\s*[A-Z]\d+[-\w.]*:\s+/, '');

  // 6. Tokenize, strip outer punctuation, drop leading articles
  const words = text.trim().split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean);
  while (words.length > 0 && /^(a|an|the|which|what|how|who|should|would)$/i.test(words[0])) {
    words.shift();
  }
  if (words.length === 0) {
    const fallbackWords = raw.replace(/[`()]/g, '').trim().split(/\s+/).filter(Boolean);
    return fallbackWords.slice(0, 4).join(' ');
  }

  // 7. Keep significant words: no function words, no case-insensitive repeats (same list as the engine)
  const seen = new Set<string>();
  let sig = words.filter((w) => {
    const lw = w.toLowerCase();
    if (SHORT_TITLE_STOP_WORDS.has(lw) || seen.has(lw)) return false;
    seen.add(lw);
    return true;
  });
  if (sig.length < 2) sig = words;

  // 8. Up to 4 words, at most 40 characters, no trailing punctuation
  const picked = sig.slice(0, 4);
  while (picked.join(' ').length > 40 && picked.length > 1) picked.pop();
  return picked.join(' ').slice(0, 40).replace(/[.,:;!?\u2014\u2013-]+$/, '').trim();
}

const SHORT_TITLE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'as', 'is', 'are',
  'was', 'were', 'it', 'its', 'via', 'which', 'what', 'should', 'would', 'could', 'does', 'do', 'before',
  'after', 'that', 'this', 'into', 'when', 'where', 'be', 'but', 'not', 'than', 'then', 'so', 'if', 'all',
  'each', 'every',
]);


