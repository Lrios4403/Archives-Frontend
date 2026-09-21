'use client';

import styles from "./WarcSearchResults.module.css";

export interface SiteJumpItem {
    /** The id on the site's window. */
    id: string;
    /** The url, as it reads in the list. */
    label: string;
    /** Full url, for the tooltip. */
    title: string;
    /** How many captures are behind it. */
    count: number;
}

/**
 * Every site on this page, as a jump list.
 *
 * A client component only for the scroll. The links are real anchors with real
 * fragments, so with no JavaScript they still work — the browser just aligns the
 * window to the top of the viewport instead of centring it, which is why the
 * target still carries a `scroll-margin-top`.
 */
export default function SiteJumpList({ items }: { items: readonly SiteJumpItem[] }) {
    /*
     * Centred, and instant.
     *
     * Neither is available to a plain fragment link. A fragment aligns the target
     * to the TOP, and the page sets `scroll-behavior: smooth` globally — which
     * over the eight thousand pixels a results page can span is a long ride
     * through fifteen other sites to reach the one you picked.
     *
     * `block: "center"` puts the window in the middle of the viewport, so its
     * titlebar, timeline and first records are all on screen at once rather than
     * the window starting at the fold.
     *
     * `behavior: "instant"`, NOT "auto". They read as synonyms and are not:
     * "auto" means "defer to the CSS scroll-behavior", which on this page is
     * `smooth`, so it produced exactly the long animated ride it was meant to
     * skip. "instant" is the value that overrides the stylesheet — for this one
     * jump, without changing scrolling anywhere else on the site.
     */
    const jump = (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
        const target = document.getElementById(id);
        if (!target) return; // Let the browser try the fragment itself.

        event.preventDefault();
        target.scrollIntoView({ behavior: "instant", block: "center" });

        // The fragment still goes on the url, so the position is shareable and
        // Back returns to where the reader was.
        history.replaceState(null, "", `#${id}`);
    };

    return (
        <nav className={styles.jumpList} aria-label="Sites on this page">
            {items.map(item => (
                <a
                    key={item.id}
                    href={`#${item.id}`}
                    onClick={event => jump(event, item.id)}
                    className={styles.jumpLink}
                    title={item.title}
                >
                    <span className={styles.jumpUrl}>{item.label}</span>
                    <span className={styles.jumpCount}>{item.count}</span>
                </a>
            ))}
        </nav>
    );
}
