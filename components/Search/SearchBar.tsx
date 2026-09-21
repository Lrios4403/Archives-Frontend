"use client"

import type React from "react"
import { Suspense, use, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Input from "@/components/Input/Input"
import Button from "@/components/Button/Button"
import { searchHref } from "@/components/WarcSearch/actions"
import styles from "./SearchBar.module.css"

interface ContentTypeSelectProps {
  types: string[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

// Presentational only, so the resolved-array and streamed-promise paths below
// render byte-identical markup.
function ContentTypeSelect({ types, value, onChange, disabled }: ContentTypeSelectProps) {
  if (types.length === 0) return null

  return (
    <select
      name="content_type"
      className={styles.contentTypeSelect}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label="Filter by content type"
      title="Filter by content type"
    >
      <option value="">Any type</option>
      {types.map((ct) => (
        <option key={ct} value={ct}>
          {ct}
        </option>
      ))}
    </select>
  )
}

/**
 * Unwraps the streamed content-type promise.
 *
 * This has to be its own component: use() suspends the component that calls it,
 * so keeping it out of SearchBar is what lets the input and submit button render
 * in the static shell while only the dropdown waits on the backend.
 */
function StreamedContentTypeSelect({
  promise,
  ...rest
}: { promise: Promise<string[]> } & Omit<ContentTypeSelectProps, "types">) {
  return <ContentTypeSelect types={use(promise)} {...rest} />
}

// Placeholder occupying the dropdown's slot while it streams, so the row does
// not reflow when the real options arrive.
function ContentTypeSelectFallback() {
  return (
    <select className={styles.contentTypeSelect} disabled aria-label="Filter by content type">
      <option value="">Any type</option>
    </select>
  )
}

interface SearchBarProps {
  /** Prefilled query. */
  initialQuery?: string
  /** Input placeholder. */
  placeholder?: string
  /** Content types for the filter dropdown. Omit/empty = no dropdown. */
  contentTypes?: string[]
  /**
   * Unresolved content types, streamed in. Pass this instead of `contentTypes`
   * from a Server Component that must not block on the backend: hand over
   * getContentTypesReal() WITHOUT awaiting it and the dropdown fills in on its
   * own. Takes precedence over `contentTypes` when both are given.
   */
  contentTypesPromise?: Promise<string[]>
  /** Prefilled content-type filter ("" = Any). */
  initialContentType?: string
  autoFocus?: boolean
}

// Standardized search bar (input + optional content-type filter + submit) used
// inside any Window. Submits to /warcs/search/<query> via SPA navigation.
//
// The <form> keeps `action="/warcs/search" method="get"`, which still produces
// the old `?q=` shape. That is deliberate: a plain GET cannot build a path
// segment from an input value, and frontend/proxy.ts (the Next 16 proxy, what
// middleware.ts is now called) 308s `?q=` into the path using this same
// slugForQuery — so the no-JS fallback lands in the right place with no extra
// work, on a byte-identical url to the one this component would have pushed.
export default function SearchBar({
  initialQuery = "",
  placeholder = "Search WARC records...",
  contentTypes = [],
  contentTypesPromise,
  initialContentType = "",
  autoFocus = false,
}: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery)
  const [contentType, setContentType] = useState(initialContentType)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  // A blank query is a legitimate search, not a no-op: the backend matches URIs
  // with ILIKE '%' || q || '%', so an empty q matches every archived URI — i.e.
  // "show me everything", ordered shallowest-first then A->Z. q is therefore
  // always set, even when empty, which is what lets the results page tell
  // "searched for nothing" apart from "hasn't searched yet" (no q at all).
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    startTransition(() => {
      router.push(searchHref(query, { contentType }))
    })
  }

  return (
    <form onSubmit={handleSubmit} action="/warcs/search" method="get" className={styles.searchForm}>
      <div className={styles.searchInputGroup}>
        <Input
          name="q"
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.searchInput}
          autoFocus={autoFocus}
          autoComplete="off"
          disabled={isPending}
        />

        {contentTypesPromise ? (
          <Suspense fallback={<ContentTypeSelectFallback />}>
            <StreamedContentTypeSelect
              promise={contentTypesPromise}
              value={contentType}
              onChange={setContentType}
              disabled={isPending}
            />
          </Suspense>
        ) : (
          <ContentTypeSelect
            types={contentTypes}
            value={contentType}
            onChange={setContentType}
            disabled={isPending}
          />
        )}

        {/* Enabled even with an empty input — see handleSubmit. */}
        <Button type="submit" className={styles.searchButton} disabled={isPending}>
          {isPending ? "🔄 Searching..." : "🔍 Search"}
        </Button>
      </div>
    </form>
  )
}
