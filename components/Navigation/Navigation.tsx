"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import styles from './Navigation.module.css'

interface NavLeaf {
  href: string
  label: string
  icon: string
}

interface NavGroup {
  label: string
  icon: string
  children: NavLeaf[]
}

type NavEntry = NavLeaf | NavGroup

const isGroup = (entry: NavEntry): entry is NavGroup => 'children' in entry

/*
 * No `prefetch={true}` on any of these, and that is deliberate.
 *
 * It used to be on all three link sites, presumably on the reasoning that more
 * prefetching is faster. Under Cache Components it is the opposite. The router
 * already prefetches every route's App Shell by default; `prefetch={true}` asks
 * it to additionally render the destination's whole component tree at prefetch
 * time, which costs a server invocation PER LINK — this nav has five, on every
 * page.
 *
 * That extra render is only worth buying when a route's cached content depends
 * on the link's own URL, such as a `searchParams` or a dynamic param. Every
 * destination here is a fixed, parameterless route, so it bought nothing.
 *
 * It also produced the "Next.js encountered dynamic data during prefetching"
 * insight in the dev overlay on every page. The dynamic data is in this very
 * file: `usePathname()` below is URL data, the layout is re-rendered as part of
 * a full prefetch, and so every prefetch tripped the check.
 */
const LINKS: NavEntry[] = [
  { href: "/", label: "Home", icon: "🏠" },
  {
    label: "Web Archive",
    icon: "🗄️",
    children: [
      { href: "/warcs/search", label: "Search", icon: "🔍" },
      // "WARC Viewer", not "Offline": the anchor text is what tells a reader -
      // and a crawler - what the page is, and "Offline" said the opposite of
      // what someone searching for an online viewer wanted.
      { href: "/warcs/offline", label: "WARC Viewer", icon: "💾" },
      { href: "/guides/how-to-open-warc-file", label: "Guides", icon: "📖" },
    ],
  },
  { href: "/about", label: "About", icon: "ℹ️" },
]

/**
 * A nav group that opens on hover, click, or focus.
 *
 * All three, deliberately. Hover alone is unreachable by keyboard and does not
 * exist on a touch screen — a hover-only menu is simply a dead button on a
 * phone. So the pointer opens it, a click toggles it, and tabbing into it opens
 * it via :focus-within in the stylesheet.
 *
 * The panel is anchored at `top: 100%` with its own padding rather than a
 * margin, so there is no gap between the trigger and the menu for the pointer
 * to fall through on the way down.
 */
function NavDropdown({
  group,
  isActive,
}: {
  group: NavGroup
  isActive: (href: string) => boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // The parent reads as current when any child page is showing — otherwise the
  // only indication of where you are disappears the moment the menu closes.
  const groupActive = group.children.some((child) => isActive(child.href))

  /**
   * Escape closes, and so does clicking away.
   *
   * Both only while open, so the page is not carrying two document listeners
   * for a menu nobody has touched.
   */
  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  return (
    <div
      ref={wrapperRef}
      className={styles.navGroup}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`${styles.navLink} ${styles.navTrigger} ${groupActive ? styles.active : ""}`}
      >
        {group.label}
        <span aria-hidden className={styles.caret}>▾</span>
      </button>

      <div className={`${styles.dropdown} ${open ? styles.dropdownOpen : ""}`}>
        <div className={styles.dropdownPanel}>
          {group.children.map((child) => (
            <Link
              key={child.href}
              href={child.href}
              className={`${styles.dropdownLink} ${isActive(child.href) ? styles.active : ""}`}
              aria-current={isActive(child.href) ? "page" : undefined}
              // Closed on navigation: without this the menu stays open over the
              // page you just moved to, until the pointer happens to leave it.
              onClick={() => setOpen(false)}
            >
              {child.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const pathname = usePathname()

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href)

  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen)
  }

  return (
    <nav className={styles.navigation}>
      <div className={styles.navContent}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoIcon}>🗂️</span>
          <span>M4cgyvers Archives</span>
        </Link>

        <div className={styles.navLinks}>
          {LINKS.map((link) => (
            isGroup(link)
              ? <NavDropdown key={link.label} group={link} isActive={isActive} />
              : <Link
                  key={link.href}
                  href={link.href}
                  className={`${styles.navLink} ${isActive(link.href) ? styles.active : ""}`}
                  aria-current={isActive(link.href) ? "page" : undefined}
                >
                  {link.label}
                </Link>
          ))}
        </div>

        <button
          className={styles.mobileMenuButton}
          onClick={toggleMobileMenu}
          aria-label="Toggle mobile menu"
        >
          ☰
        </button>
      </div>

      <div className={`${styles.mobileMenu} ${mobileMenuOpen ? styles.open : ''}`}>
        <div className={styles.mobileMenuContent}>
          {/*
            * Flattened on mobile. A hover menu has nothing to hover, and a
            * nested tap-to-open inside a menu that is already tap-to-open is two
            * taps to reach a page — so the group becomes a heading and its
            * children become ordinary indented links.
            */}
          {LINKS.map((link) => (
            isGroup(link)
              ? (
                <div key={link.label}>
                  <p className={styles.mobileGroupLabel}>{link.icon} {link.label}</p>
                  {link.children.map((child) => (
                    <Link
                      key={child.href}
                      href={child.href}
                      className={`${styles.mobileNavLink} ${styles.mobileChildLink} ${isActive(child.href) ? styles.active : ""}`}
                      aria-current={isActive(child.href) ? "page" : undefined}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      {child.icon} {child.label}
                    </Link>
                  ))}
                </div>
              )
              : (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`${styles.mobileNavLink} ${isActive(link.href) ? styles.active : ""}`}
                  aria-current={isActive(link.href) ? "page" : undefined}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {link.icon} {link.label}
                </Link>
              )
          ))}
        </div>
      </div>
    </nav>
  )
}
