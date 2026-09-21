import Window from "@/components/Window/Window";
import { SkeletonBar, SkeletonRegion } from "@/components/Skeleton/Skeleton";
import styles from "./page.module.css";
import s from "./loading.module.css";

/**
 * What the offline viewer looks like before its JavaScript arrives.
 *
 * The route segment had no `loading.tsx`, so the nearest one up the tree — the
 * root, which returns null — was the fallback: navigating here showed an empty
 * page until the route's chunk had downloaded and hydrated. This page is the
 * heaviest client bundle in the app (store, tree, parse pool, viewer), so that
 * gap is the most visible one there is.
 *
 * ## It stands in for the page's EMPTY state, not its full one
 *
 * Every measurement here is the size of what actually lands, which for a page
 * that has just opened means: the viewer showing its tutorial card, the upload
 * form with nothing selected, and a records tree whose body is one line of "no
 * records yet". A skeleton drawn at the size of a loaded viewer would be honest
 * about the eventual page and wrong about the one that arrives a moment later,
 * and the reader would watch it collapse.
 *
 * Sizes are duplicated from the real stylesheets rather than shared, and the
 * comments in loading.module.css name each source. Sharing them would mean the
 * real components importing layout from a skeleton, which is backwards.
 *
 * A server component with no client JS of its own, which is the point: it can be
 * part of the static shell and appear immediately.
 */
export default function OfflineViewerLoading() {
    return (
        <div className={styles.container}>
            {/*
              * OUTSIDE mainContent, which is load-bearing.
              *
              * mainContent is `display: flex` with `gap: 24px`, and that gap only
              * applies to its own children. With the region's <div> inside it,
              * the three windows became grandchildren in one flex item and sat
              * flush against each other — the whole page a single block, spaced
              * differently from the real thing it was standing in for.
              */}
            <SkeletonRegion label="Loading the offline viewer">
                <div className={styles.mainContent}>
                    {/*
                      * The viewer, showing what it shows before a page is opened:
                      * a bordered card with a title and a subtitle in it.
                      * Deliberately not `flush` — the real Window is only flush
                      * while a document is in it.
                      */}
                    <Window title="Viewer" icon="🗔">
                        <div className={s.tutorial}>
                            <SkeletonBar width="13rem" height="1rem" />
                            <SkeletonBar width="21rem" height="0.75rem" />
                        </div>
                    </Window>

                    {/* No timeline placeholder: the real one renders nothing until
                        a page is being viewed, so a bar here would be a shape the
                        reader watches disappear. */}

                    <Window title="Load archives" icon="📂">
                        <div className={s.form}>
                            {/* "Choose Local Archives", then the file input. The bar
                                is sized to that label, not the old shorter one — a
                                skeleton narrower than the text it stands in for is a
                                layout shift the moment the real label arrives. */}
                            <div className={s.field}>
                                <SkeletonBar width="10rem" height="0.7rem" className={s.label} />
                                <SkeletonBar width="18rem" height="1.5rem" />
                            </div>

                            {/* "Parse threads", the 7rem number field, then its hint. */}
                            <div className={s.field}>
                                <SkeletonBar width="6.5rem" height="0.7rem" className={s.label} />
                                <SkeletonBar width="7rem" height="2rem" />
                                <SkeletonBar width="24rem" height="0.7rem" className={s.hint} />
                            </div>

                            {/* Process locally: full width, like the real button. */}
                            <SkeletonBar width="100%" height="2.25rem" />
                        </div>
                    </Window>

                    <Window title="Records" icon="🗂">
                        {/*
                          * The toolbar renders whether or not anything is loaded:
                          * search field, the Normalized URLs checkbox, the content
                          * type select, and the hint that follows them.
                          */}
                        <div className={s.toolbar}>
                            <SkeletonBar width="13rem" height="2rem" />
                            <SkeletonBar width="9rem" height="1rem" />
                            <SkeletonBar width="11rem" height="2rem" />
                            <SkeletonBar width="15rem" height="0.7rem" />
                        </div>

                        {/* And the body, which on arrival is one line of prose
                            telling the reader to load something. */}
                        <div className={s.empty}>
                            <SkeletonBar width="27rem" height="0.75rem" />
                        </div>
                    </Window>
                </div>
            </SkeletonRegion>
        </div>
    );
}
