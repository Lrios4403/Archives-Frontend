import { ImageResponse } from "next/og"
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site"

/*
 * The card people see when a link to this site is pasted into Discord, Slack,
 * iMessage or a tweet. Before this there was none, so every share rendered as a
 * bare grey text row.
 *
 * Generated rather than a static JPEG on purpose: the palette lives in
 * globals.css and the name lives in lib/site.ts, so a static export would be a
 * third copy to forget. This one is built from the same constants.
 *
 * ImageResponse renders through satori, NOT a browser. Practical consequences,
 * all of which cost time to discover:
 *   - flexbox only. `display: grid` silently produces nothing.
 *   - every element with more than one child needs an explicit display: flex.
 *   - no external assets: a fetch for a font or image would have to leave the
 *     server at render time, so the design is CSS and text.
 */

export const size = { width: 1200, height: 630 }
export const contentType = "image/png"
export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`

// Win95 palette, matching globals.css and the themeColor in the root layout.
const TEAL = "#008080"
const FACE = "#c0c0c0"
const SHADOW = "#808080"
const NAVY = "#000080"

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: TEAL,
          fontFamily: "monospace",
        }}
      >
        {/* The window. Border colours do the 3D bevel by hand - satori has no
            `border-style: outset`. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 1000,
            background: FACE,
            borderTop: `4px solid #ffffff`,
            borderLeft: `4px solid #ffffff`,
            borderRight: `4px solid ${SHADOW}`,
            borderBottom: `4px solid ${SHADOW}`,
            boxShadow: "8px 8px 0 rgba(0,0,0,0.35)",
          }}
        >
          {/* Titlebar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: NAVY,
              padding: "14px 18px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 34 }}>🗂️</div>
              <div style={{ fontSize: 30, color: "#ffffff", fontWeight: 700, letterSpacing: 1 }}>
                C:\ARCHIVES
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {["_", "□", "×"].map((glyph) => (
                <div
                  key={glyph}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 34,
                    height: 30,
                    background: FACE,
                    borderTop: "3px solid #ffffff",
                    borderLeft: "3px solid #ffffff",
                    borderRight: `3px solid ${SHADOW}`,
                    borderBottom: `3px solid ${SHADOW}`,
                    fontSize: 20,
                    color: "#000000",
                  }}
                >
                  {glyph}
                </div>
              ))}
            </div>
          </div>

          {/* Body */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "58px 60px 64px 60px",
            }}
          >
            <div
              style={{
                fontSize: 82,
                fontWeight: 800,
                color: "#000000",
                lineHeight: 1.05,
                letterSpacing: -1,
              }}
            >
              {SITE_NAME}
            </div>

            <div style={{ display: "flex", marginTop: 26, fontSize: 34, color: "#404040" }}>
              {SITE_TAGLINE}
            </div>

            {/* Inset field, the way the site draws its search box. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                marginTop: 46,
                padding: "20px 24px",
                background: "#ffffff",
                borderTop: `3px solid ${SHADOW}`,
                borderLeft: `3px solid ${SHADOW}`,
                borderRight: "3px solid #ffffff",
                borderBottom: "3px solid #ffffff",
              }}
            >
              <div style={{ fontSize: 30 }}>🔍</div>
              <div style={{ fontSize: 30, color: "#000000" }}>
                search archived websites &amp; WARC files
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  )
}
