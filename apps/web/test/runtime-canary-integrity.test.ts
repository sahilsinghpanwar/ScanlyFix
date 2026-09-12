import { describe, expect, it } from 'vitest';

import { evaluateIntegrity, sha256Canonical } from '@/lib/runtime/canaries/integrity';
import { evaluateAnonProbe } from '@/lib/runtime/canaries/rls-probe';
import { buildSetupScript } from '@/lib/runtime/canaries/setup-script';

const baseSnapshot = () => {
  const rows = [
    { marker: 'CANARY::abc::A', payload: { note: 'x' } },
    { marker: 'CANARY::abc::B', payload: { note: 'y' } },
    { marker: 'CANARY::abc::C', payload: { note: 'z' } },
  ];
  return {
    rows,
    snapshot: {
      payloadHashes: Object.fromEntries(rows.map((r) => [r.marker, sha256Canonical(r.payload)])),
      logRowCount: 5,
      takenAt: new Date().toISOString(),
    },
  };
};

describe('evaluateIntegrity', () => {
  it('pehla run (snapshot null) → baseline, koi detection nahi', () => {
    const { rows } = baseSnapshot();
    const r = evaluateIntegrity({ snapshot: null, liveRows: rows, liveLogCount: 5 });
    expect(r.detections).toHaveLength(0);
    expect(Object.keys(r.newSnapshot.payloadHashes)).toHaveLength(3);
  });

  it('sab intact → ok, zero detections', () => {
    const { rows, snapshot } = baseSnapshot();
    const r = evaluateIntegrity({ snapshot, liveRows: rows, liveLogCount: 5 });
    expect(r.detections).toHaveLength(0);
    expect(Object.values(r.verdicts).every((v) => v === 'ok')).toBe(true);
  });

  it('row deleted → deleted detection', () => {
    const { rows, snapshot } = baseSnapshot();
    const r = evaluateIntegrity({ snapshot, liveRows: rows.slice(0, 2), liveLogCount: 5 });
    expect(r.detections).toContainEqual(expect.objectContaining({ kind: 'deleted' }));
    expect(r.verdicts['CANARY::abc::C']).toBe('missing');
  });

  it('payload modified → modified detection', () => {
    const { rows, snapshot } = baseSnapshot();
    const tampered = [...rows];
    tampered[1] = { ...tampered[1]!, payload: { note: 'ATTACKER EDIT' } };
    const r = evaluateIntegrity({ snapshot, liveRows: tampered, liveLogCount: 5 });
    expect(r.detections).toContainEqual(expect.objectContaining({ kind: 'modified' }));
  });

  it('⭐ log wipe → tamper detection (attacker tracks cover kar raha)', () => {
    const { rows, snapshot } = baseSnapshot();
    const r = evaluateIntegrity({ snapshot, liveRows: rows, liveLogCount: 0 });
    expect(r.detections).toContainEqual(expect.objectContaining({ kind: 'log_wiped' }));
  });

  it('log grow normal hai — alarm nahi', () => {
    const { rows, snapshot } = baseSnapshot();
    const r = evaluateIntegrity({ snapshot, liveRows: rows, liveLogCount: 9 });
    expect(r.detections).toHaveLength(0);
  });
});

describe('evaluateAnonProbe — deterministic read detection', () => {
  it('200 + rows → RLS HOLE', () => {
    expect(evaluateAnonProbe({ status: 200, rowCount: 3 })).toMatchObject({ kind: 'anon_readable' });
  });
  it('200 + empty / 401 / 403 / network-0 → theek ya inconclusive (kabhi alarm nahi)', () => {
    expect(evaluateAnonProbe({ status: 200, rowCount: 0 })).toBeNull();
    expect(evaluateAnonProbe({ status: 401, rowCount: null })).toBeNull();
    expect(evaluateAnonProbe({ status: 403, rowCount: null })).toBeNull();
    expect(evaluateAnonProbe({ status: 0, rowCount: null })).toBeNull();
  });
});

describe('buildSetupScript', () => {
  const s = buildSetupScript({ projectId: '12345678-abcd-1234-abcd-1234567890ab', appDomain: 'app.scanlyfix.dev' });
  it('3 unique markers + RLS enabled + honeytoken URLs', () => {
    expect(s.seeds).toHaveLength(3);
    expect(new Set(s.seeds.map((x) => x.marker)).size).toBe(3);
    expect(s.sql).toContain('enable row level security');
    expect(s.sql).toContain('after update or delete');
    expect(s.sql).toContain('/api/runtime/honeytoken/');
  });
});