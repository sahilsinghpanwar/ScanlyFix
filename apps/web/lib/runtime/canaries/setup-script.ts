import { randomBytes } from 'node:crypto';

import { CANARY_LOG_TABLE, CANARY_ROW_COUNT, CANARY_TABLE } from './types';

export type CanarySeed = { marker: string; honeytokenPath: string; payloadJson: string };

export type SetupScript = { seeds: CanarySeed[]; sql: string };

function shortToken(): string {
  return randomBytes(12).toString('base64url');
}

function canonicalPayload(marker: string, honeyPath: string, appDomain: string): string {
  return JSON.stringify({
    note: 'legacy integration backup',
    api_key: `sk-live-cnf-${shortToken()}`,
    callback_url: `https://${appDomain}/api/runtime/honeytoken/${honeyPath}`,
    rotated_by: 'ops@internal',
  });
}

/*
* Deterministic per-call seeds; the system stores them in its own database
* (`runtimeCanaries` rows), while the SQL creates the same markers
* in the user's Supabase database.
*/

export function buildSetupScript(params: { projectId: string; appDomain: string }): SetupScript {
  const { projectId, appDomain } = params;
  const short = projectId.slice(0, 8);
  const labels = ['A', 'B', 'C'];

  const seeds: CanarySeed[] = Array.from({ length: CANARY_ROW_COUNT }, (_, i) => {
    const marker = `CANARY::${short}::${labels[i]!}`;
    const honeyPath = shortToken();
    return { marker, honeytokenPath: honeyPath, payloadJson: canonicalPayload(marker, honeyPath, appDomain) };
  });

  const values = seeds
    .map((s) => `  ('${s.marker}', '${s.payloadJson.replace(/'/g, "''")}'::jsonb)`)
    .join(',\n');

  const sql = `-- ScanlyFix Canaries — setup (project ${short})
-- Ye script DECOY rows + watch triggers banata hai. Kuch bhi block nahi hota — sirf LOG hota hai.
-- Iske baad ScanlyFix dashboard par "Verify setup" dabao.

create table if not exists public.${CANARY_TABLE} (
  id uuid primary key default gen_random_uuid(),
  marker text unique not null,
  payload jsonb not null,
  planted_at timestamptz not null default now()
);

create table if not exists public.${CANARY_LOG_TABLE} (
  id bigint generated always as identity primary key,
  canary_marker text,
  action text not null,
  old_payload jsonb,
  acted_at timestamptz not null default now()
);

-- RLS ON, koi policy NAHI → sirf service_role (jo RLS bypass karta hai) access kar sakta hai.
-- Anon key se in tables ko padhna IMPOSSIBLE hona chahiye — agar padh liya, wo hi alert hai.
alter table public.${CANARY_TABLE} enable row level security;
alter table public.${CANARY_LOG_TABLE} enable row level security;

create or replace function public.${CANARY_TABLE}_guard()
returns trigger language plpgsql as $$ begin
  insert into public.${CANARY_LOG_TABLE} (canary_marker, action, old_payload)
  values (old.marker, tg_op, to_jsonb(old));
  return null; -- AFTER trigger: watch-only, kabhi interfere nahi
end $$;

drop trigger if exists ${CANARY_TABLE}_guard_trg on public.${CANARY_TABLE};
create trigger ${CANARY_TABLE}_guard_trg
after update or delete on public.${CANARY_TABLE}
for each row execute function public.${CANARY_TABLE}_guard();

insert into public.${CANARY_TABLE} (marker, payload) values
 ${values}
on conflict (marker) do nothing;`;

  return { seeds, sql };
}