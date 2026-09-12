'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Refreshes the page while a repo scan is queued or running, so the report
 * lands on screen the moment the worker finishes without the user having to
 * notice anything. `active` flips false the instant the server render sees a
 * terminal status, which unmounts the interval.
 */
export function RepoScanPoller({ active }: { active: boolean }) {
  const router = useRouter()

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => router.refresh(), 4000)
    return () => clearInterval(id)
  }, [active, router])

  return null
}