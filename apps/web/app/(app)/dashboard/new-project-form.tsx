'use client'

import { useActionState } from 'react'
import { createProjectAction, type ActionState } from './actions.ts'

/**
 * The orgId is passed through the form for convenience, and re-derived from the
 * session inside the action — a value that arrives in a POST body is a claim,
 * not a fact.
 *
 * Styled in the console's tokens rather than the terminal's, because the
 * dashboard is the only page that mounts it. If it ever appears on a terminal
 * surface it needs the `tone` treatment ScanForm has, not a second copy.
 */
export function NewProjectForm({ orgId }: { orgId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createProjectAction, {})

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <input type="hidden" name="orgId" value={orgId} />
        <label htmlFor="new-project-url" className="sr-only">
          Site address
        </label>
        <input
          id="new-project-url"
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          required
          placeholder="example.com"
          disabled={pending}
          aria-invalid={Boolean(state.error)}
          className="w-44 rounded-lg border border-c-line bg-c-card px-3.5 py-2 text-[14px] text-c-ink
                     placeholder:text-c-muted focus-visible:outline-2 focus-visible:outline-offset-1
                     focus-visible:outline-c-accent disabled:opacity-60 sm:w-52"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-c-brand px-4 py-2 text-[13px] font-medium text-c-brand-ink
                     transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? 'Adding…' : 'Add domain'}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="text-[12.5px] text-sev-high">
          {state.error}
        </p>
      )}
    </form>
  )
}
