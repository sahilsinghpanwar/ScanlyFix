export type CanaryEventKind =
  | 'modified' | 'deleted' | 'anon_readable' | 'log_wiped' | 'honeytoken_hit' | 'table_missing';

export type CanaryEventSource = 'trigger_log' | 'integrity' | 'rls_probe' | 'honeytoken' | 'verify';

/** Har canary event CRITICAL hai — zero-triage philosophy. */
export type CanaryDetection = {
  kind: CanaryEventKind;
  source: CanaryEventSource;
  canaryId: string | null;
  detail: string;
};

export type IntegrityVerdict = 'ok' | 'modified' | 'missing' | 'unreachable';

export const CANARY_ROW_COUNT = 3;
export const CANARY_TABLE = 'scanlyfix_canaries';
export const CANARY_LOG_TABLE = 'scanlyfix_canary_log';
export const MAX_AUDIT_TABLES = 30;