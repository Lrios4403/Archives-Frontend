import styles from './Window.module.css'

interface WindowProps {
  title: string
  /**
   * DOM id for the whole window.
   *
   * On the results page this is what the jump list scrolls to — the WINDOW, not
   * a part of it, so the titlebar, the timeline and the first records arrive
   * together rather than the reader landing mid-panel.
   */
  id?: string
  icon?: string
  /**
   * Optional, because a Window is sometimes only its titlebar.
   *
   * The viewer's bar is a control surface in its own right — address, history,
   * Save — and there are states where it should stay on screen with nothing
   * under it. With `children` required those callers had to pass `null` or an
   * empty fragment, and then the content box still rendered: an empty padded
   * panel hanging off the bottom of the bar. It is skipped entirely now, so a
   * bar on its own is a bar on its own.
   */
  children?: React.ReactNode
  className?: string
  /** Remove the content padding so children (e.g. an iframe) fill the window. */
  flush?: boolean
  /**
   * Arbitrary chrome in place of the visual title.
   *
   * For a window whose titlebar IS a control surface — the offline viewer puts
   * its whole address bar there, the way a browser does. `title` is still
   * required and still names the window for assistive tech; this only replaces
   * what is drawn.
   */
  titleContent?: React.ReactNode
  /**
   * A count or status, drawn at the right of the titlebar before the controls.
   *
   * Distinct from `titleContent`, which REPLACES the title. This sits beside it,
   * for the "6 files" / "1,624 total" kind of fact that belongs on the bar rather
   * than in the body — a window whose contents scroll needs its total where the
   * scrolling cannot hide it.
   *
   * Takes a node rather than a string because the value is usually live, and the
   * page holding these windows is a server component: the count has to come from
   * a small client component passed in here.
   */
  meta?: React.ReactNode
  /**
   * The decorative `_ □ ×` cluster. On by default.
   *
   * Turned off by a window whose titlebar carries real controls, where three
   * fake ones sit beside a working Save button and invite the reader to try
   * them. Everywhere else they are the retro chrome the site is built on, so
   * the default keeps them and only the viewer opts out.
   */
  controls?: boolean
}

export default function Window({
  id,
  title,
  icon,
  children,
  className = '',
  flush = false,
  titleContent,
  meta,
  controls = true,
}: WindowProps) {
  return (
    <section id={id} className={`${styles.window} ${className}`} aria-label={title}>
      <div className={styles.titlebar}>
        {titleContent
          ? <div className={styles.titleSlot}>{titleContent}</div>
          : (
            <div className={styles.titleText}>
              {icon && <span>{icon}</span>}
              <span>{title}</span>
            </div>
          )}

        {meta && <div className={styles.titleMeta}>{meta}</div>}

        {/*
          * Decorative only — these three do not minimise, maximise or close
          * anything. They were plain <button>s with no type, which meant a
          * Window inside a <form> had three extra submit buttons in it, and
          * three tab stops per Window on a page. The offline viewer stacks
          * several Windows around a keyboard-driven tree, so that was a dozen
          * stops between the reader and the thing they came to use.
          */}
        {controls && (
          <div className={styles.windowControls} aria-hidden="true">
            <button type="button" tabIndex={-1} className={styles.controlButton}>_</button>
            <button type="button" tabIndex={-1} className={styles.controlButton}>□</button>
            <button type="button" tabIndex={-1} className={styles.controlButton}>×</button>
          </div>
        )}
      </div>

      {/* No content box at all when there is nothing to put in it — see the note
          on `children`. `null` and `false` are both "nothing" here; `0` is not,
          which is why this is an explicit check rather than a truthiness test. */}
      {children !== undefined && children !== null && children !== false && (
        <div className={`${styles.content}${flush ? ' ' + styles.contentFlush : ''}`}>
          {children}
        </div>
      )}
    </section>
  )
}
