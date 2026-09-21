"use client"

import { useEffect, useState } from "react"

interface LocalTimestampProps {
  /** Rendered until the browser has mounted and can report its own clock. */
  placeholder?: string
  className?: string
}

/**
 * Current time in the VISITOR's locale and timezone.
 *
 * Deliberately blank on the first paint. Reading the clock while rendering on
 * the server is two bugs at once: under Partial Prerendering the value would be
 * baked into the prerendered shell, so Next refuses it outright
 * (next-prerender-current-time), and even under plain SSR the server's timezone
 * would not match the browser's, which is a hydration mismatch. Filling it in
 * from an effect avoids both — the server render and the first client render
 * agree on the placeholder, then the real local time replaces it.
 */
export default function LocalTimestamp({ placeholder = "—", className }: LocalTimestampProps) {
  const [stamp, setStamp] = useState<string | null>(null)

  useEffect(() => {
    setStamp(new Date().toLocaleString())
  }, [])

  return <span className={className}>{stamp ?? placeholder}</span>
}
