-- Migration: normalize or delete non-GET prober targets and findings

-- Step 1: Delete non-GET targets where a GET target already exists for the same project and path
DELETE FROM "runtime_prober_targets" t1
WHERE t1."method" != 'GET'
  AND EXISTS (
    SELECT 1 FROM "runtime_prober_targets" t2
    WHERE t2."project_id" = t1."project_id"
      AND t2."path" = t1."path"
      AND t2."method" = 'GET'
  );

-- Step 2: Normalize remaining non-GET targets to GET
UPDATE "runtime_prober_targets"
SET "method" = 'GET'
WHERE "method" != 'GET';

-- Step 3: Normalize non-GET findings to GET
UPDATE "runtime_prober_findings"
SET "method" = 'GET'
WHERE "method" != 'GET';
