import { ImageResponse } from "next/og"

/*
 * The favicon. There was no icon of any kind at the app root, so browsers showed
 * their generic blank-page glyph in tabs, bookmarks and history.
 *
 * Generated rather than a checked-in favicon.ico because a .ico is a binary blob
 * nobody can review or recolour in a diff. Next serves this at /icon and emits
 * the <link rel="icon"> for it.
 *
 * Deliberately NOT the 🗂️ emoji used elsewhere: at 32x32 an emoji is a smear of
 * colour with no readable shape. A single glyph on a flat field survives the size,
 * which is the only thing a favicon has to do.
 */

export const size = { width: 32, height: 32 }
export const contentType = "image/png"

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Navy on teal: the titlebar-on-desktop pairing from the Win95 palette,
          // and enough contrast to stay legible against both light and dark
          // browser chrome.
          background: "#000080",
          color: "#ffffff",
          fontFamily: "monospace",
          fontSize: 22,
          fontWeight: 700,
        }}
      >
        A
      </div>
    ),
    size,
  )
}
