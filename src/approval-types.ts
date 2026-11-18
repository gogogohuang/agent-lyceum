export type Sha256 = string; // /^[0-9a-f]{64}$/
export type ApprovalId = string; // /^[0-9a-f]{24}$/
export type IsoTime = string; // UTC Date.toISOString() canonical form, valid date
export type Sequence = number; // safe integer; >0；state previous 可為 0
export interface SourceBase { readonly kind: "run" | "call"; readonly source_id: string;
  readonly slot: string; readonly seq: Sequence }
export type DeniedReason = "not_regular" | "too_large" | "bad_content" |
  "bad_executor" | "bad_header" | "not_allowed" | "quota" | "scan_limit";
export type SourceKey = SourceBase & (
  { readonly variant: "payload"; readonly filename: string; readonly payload_sha256: Sha256 } |
  { readonly variant: "denied_bytes"; readonly filename: string;
    readonly reason: Exclude<DeniedReason, "not_regular" | "scan_limit">; readonly request_sha256: Sha256 } |
  { readonly variant: "denied_entry"; readonly filename: string; readonly reason: "not_regular" } |
  { readonly variant: "denied_size"; readonly filename: string; readonly reason: "too_large"; readonly size: number } |
  { readonly variant: "denied_scan"; readonly reason: "scan_limit" });
export interface WritableSet { readonly dirs: readonly string[]; readonly files: readonly string[] }
export type Origin = { readonly kind: "run"; readonly project: string; readonly run_id: string;
  readonly project_dir: string; readonly role: string; readonly full_writable: WritableSet } |
  { readonly kind: "call"; readonly call_id: string; readonly project_dir: string;
    readonly role: string; readonly full_writable: WritableSet };
export interface PremiseResult { readonly check: string; readonly ok: boolean; readonly code: string }
export interface QualificationSnapshot { readonly schema_version: 1; readonly sha256: Sha256;
  readonly premises: readonly PremiseResult[] }
export interface Proposer { readonly role: string; readonly slot: string }
export interface RecordBase { readonly schema_version: 1; readonly id: ApprovalId;
  readonly source_key: SourceKey; readonly origin: Origin; readonly proposer: Proposer;
  readonly created_at: IsoTime; readonly expires_at: IsoTime;
  readonly executor: string | null; readonly summary: string | null;
  readonly payload_sha256: Sha256 | null; readonly payload_bytes: number | null;
  readonly qualification: QualificationSnapshot | null }
export type ApprovalRecord = RecordBase & (
  { readonly disposition: "pending"; readonly executor: string; readonly payload_sha256: Sha256;
    readonly payload_bytes: number; readonly qualification: QualificationSnapshot } |
  { readonly disposition: "denied"; readonly reason: DeniedReason; readonly ignored_count: number | null });
export type Status = "pending" | "denied" | "executing" | "unknown" | "executed" |
  "failed" | "rejected" | "expired" | "tampered";
export interface Actor { readonly user: string; readonly tty: string | null;
  readonly pid: number; readonly pid_started: string | null }
export interface ExecutionOwner { readonly pid: number; readonly pid_started: string }
export interface Output { readonly text: string; readonly truncated: boolean }
export interface ExitData { readonly exit_code: number | null; readonly signal: string | null;
  readonly failure: "exit" | "timeout" | "spawn" | null; readonly error_code: string | null;
  readonly stdout: Output; readonly stderr: Output }
export type StateData =
  { readonly status: "executing"; readonly owner: ExecutionOwner; readonly timeout_sec: number;
    readonly viewed_bytes: number; readonly viewed_sha256: Sha256; readonly command_sha256: Sha256 } |
  { readonly status: "executed" | "failed"; readonly method: "executor"; readonly result: ExitData } |
  { readonly status: "executed" | "failed"; readonly method: "manual"; readonly conclusion: string } |
  { readonly status: "unknown"; readonly reason: "creator_dead" | "interrupted"; readonly detail: string } |
  { readonly status: "rejected"; readonly reason: string | null } |
  { readonly status: "expired" } |
  { readonly status: "tampered"; readonly observed_sha256: Sha256 };
export type ApprovalState = StateData & { readonly schema_version: 1; readonly n: Sequence;
  readonly previous: number; readonly updated_at: IsoTime; readonly actor: Actor };
export interface Current { readonly record: ApprovalRecord; readonly n: number;
  readonly state: ApprovalState | null } // n=0 implies no state; disposition supplies status
