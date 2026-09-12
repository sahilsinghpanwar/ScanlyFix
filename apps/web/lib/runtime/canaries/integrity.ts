import { createHash } from 'node:crypto';

import type { CanaryDetection, IntegrityVerdict } from './types';

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export type LiveCanaryRow = { marker: string; payload: unknown };

export type SnapshotMirror = {
  payloadHashes: Record<string, string>;
  logRowCount: number;
  takenAt: string;
};

export type IntegrityInput = {
  snapshot: SnapshotMirror | null;
  liveRows: LiveCanaryRow[] | null; // null = REST unreachable (different handling)
  liveLogCount: number | null;
};

export type IntegrityResult = {
  verdicts: Record<string, IntegrityVerdict>; // marker → verdict
  detections: CanaryDetection[];
  newSnapshot: SnapshotMirror;
};


/*
* Tamper-evident core:
* * Missing row → 'deleted' · changed payload hash → 'modified'
* * ⭐ Log rows were previously higher, but are now lower/zero → 'log_wiped'
* (the attacker may be covering their tracks)
* * First check (snapshot is null) → baseline only; no detection
*/

export function evaluateIntegrity(input: IntegrityInput): IntegrityResult {
  const detections: CanaryDetection[] = [];
  const verdicts: Record<string, IntegrityVerdict> = {};

  if (!input.snapshot) {
    // Baseline take
    const hashes: Record<string, string> = {};
    for (const r of input.liveRows ?? []) hashes[r.marker] = sha256Canonical(r.payload);
    return {
      verdicts,
      detections,
      newSnapshot: { payloadHashes: hashes, logRowCount: input.liveLogCount ?? 0, takenAt: new Date().toISOString() },
    };
  }

  const liveByMarker = new Map((input.liveRows ?? []).map((r) => [r.marker, r]));

  for (const [marker, expectedHash] of Object.entries(input.snapshot.payloadHashes)) {
    const live = liveByMarker.get(marker);
    if (!live) {
      verdicts[marker] = 'missing';
      detections.push({ kind: 'deleted', source: 'integrity', canaryId: null, detail: `${marker} decoy row gayab hai` });
    } else if (sha256Canonical(live.payload) !== expectedHash) {
      verdicts[marker] = 'modified';
      detections.push({ kind: 'modified', source: 'integrity', canaryId: null, detail: `${marker} payload badla gaya` });
    } else {
      verdicts[marker] = 'ok';
    }
  }

  if (input.liveLogCount !== null && input.liveLogCount < input.snapshot.logRowCount) {
    detections.push({
      kind: 'log_wiped', source: 'integrity', canaryId: null,
      detail: `Trigger log ${input.snapshot.logRowCount} → ${input.liveLogCount} rows (tamper evidence)`,
    });
  }

  const hashes: Record<string, string> = {};
  for (const r of input.liveRows ?? []) hashes[r.marker] = sha256Canonical(r.payload);
  return {
    verdicts,
    detections,
    newSnapshot: { payloadHashes: hashes, logRowCount: input.liveLogCount ?? input.snapshot.logRowCount, takenAt: new Date().toISOString() },
  };
}