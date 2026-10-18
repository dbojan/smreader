<!-- SM Reader - PATCHES.md -->
<!-- last modified (utc): 2026-10-10-21-24-31 -->
<!-- instructions: on modify, update string. -->
# Local changes to the vendored foliate-js

Purpose: if a newer foliate-js is ever downloaded, this lists what was changed locally, so the changes can be re-applied or dropped on purpose.

- **Base: the npm package `foliate-js@1.0.1`** (registry tarball `https://registry.npmjs.org/foliate-js/-/foliate-js-1.0.1.tgz`, shasum `bcd143845d2ee184c37aedccc271af0c6a0110b1`; the only version on npm, published by a third party, not by the original author). The files were copied on 2026-09-25 with `npm install foliate-js` (found in the first conversation export, sm_reader.json). **Verified 2026-10-03 by a line-by-line diff of the local files against that tarball.** It is not GitHub `78914ae` as spec.md says; GitHub main is a different snapshot (see the last section).
- **Result of the diff (3-line header removed from the local files):** `epub.js`, `epubcfi.js`, `overlayer.js`, `progress.js`, `text-walker.js`, `vendor/fflate.js`, `vendor/zip.js` and `LICENSE` are identical to npm 1.0.1. `view.js` differs on one line. `paginator.js` differs in the 15 places listed below. Nothing else was changed.
- **Location:** `js/foliate-js/`
- **SM Reader edits are in:** `paginator.js` (most), `view.js` (one line).
- **Header lines:** `epub.js`, `epubcfi.js`, `overlayer.js`, `progress.js`, `text-walker.js`, `paginator.js` and `view.js` start with a 3-line "SM Reader" header (project rules; 110-117 bytes each). That is the only change in the first five.
- Search strings below are exact text to find in the current files. Patch stamps are the spec.md entries that describe each change.

## view.js

### 1. `reason` passed through relocate (2026-09-26-15-39-58)
- **Why:** every relocate event reached `app.js` with `reason: undefined`, so `app.js` could not tell a page turn from drift.
- **Find:** `#onRelocate({ reason, range, index, fraction, size })`
- **Change:** `this.lastLocation = { ...progress, tocItem, pageItem, cfi, range, reason }` (`reason` added at the end).
- **app.js depends on it:** `onRelocate()` filters on `reason` (`page`, `navigation`, `snap`, `anchor`).

## paginator.js

### Constants (near the top)
- **Find:** `PAGED_EDGE_TOL_PX = 0.5`, `PAGED_EDGE_END_PX = 1`, `TAP_JITTER_PX = 12`

### 2. `getVisibleRange()`: `tol` parameter and probe (window-edge, 2026-09-29-09-18-31)
- **Why:** `start` is a rounded integer `scrollLeft` but the real page edge is `page * size` (fractional). Odd pages read the node ending on the previous page, or a first char on the edge was skipped.
- **Find:** `const getVisibleRange = (doc, start, end, mapRect, probe = null, tol = 0) =>`
- **Change:** the extra `probe` and `tol` parameters. `tol` applies to the START edge only: text node visible if `right >= start + tol`; element accepted if `left >= start - tol && right <= end + tol`; start bisect uses `start - tol` / `start + tol`. Default `tol = 0` keeps upstream behavior (scrolled mode).
- **The `probe` object** (`probe.nodeCount`, `probe.win`, `probe.tol`, `probe.steps`, `probe.charL`, `probe.charT`, ...) is debug only.

### 3. `getVisibleRange()`: skip-hanging-space (2026-09-30-09-18-55)
- **Why:** on the phone, the saved char was the space hanging past the column edge at the end of the previous page's last justified line.
- **Find:** `skip-hanging-space (2026-09-30-09-18-55)`
- **Change:** in paged mode (`tol > 0`), the start offset steps over whitespace to the first real char, if that char is still inside the window.

### 4. `#getVisibleRange()`: exact grid window and the spacer pairing (window-edge 2026-09-29-09-18-31; restore-page-spacer-offset 2026-09-28-08-57-26)
- **Why:** `View.expand()` puts the iframe one page (`size`) inside the container (blank spacer page 0). Window and scroll must both account for it, as upstream does.
- **Find:** `const gridStart = this.page * pageSize` in `#getVisibleRange()`
- **Change:** when the container is within 1 px of the page grid, the window is built from `gridStart` with `PAGED_EDGE_TOL_PX`, not from the rounded `this.start`. The `- size` window shift is kept (this is upstream's).
- **Paired with change 5. Never change one without the other.**

### 5. `#scrollToRect()`: size snapshot, dust epsilon, bypass of `#scrollToPage` (2026-09-27-10-17-58; spacer pair 2026-09-28-08-57-26)
- **Why:** `size`, `start` and `end` are live reads that drift between reads, which flipped `floor()` by a page on boundary targets.
- **Find:** `const snapSize = this.size`
- **Change:** `snapSize` is read once and used for both `pageIndex` and `offset`; `dust = 1e-4 * snapSize` rounds up only when the target sits exactly on the next boundary; the `+1` / `-1` page (`const page = pageIndex + (this.#rtl ? -1 : 1)`) is upstream's pairing with change 4. The offset is computed here and passed to `#scrollTo()` (upstream calls `#scrollToPage()`).
- **Dead code inside:** `SWITCH_SCROLL_EXACT_CHAR` probe (`const exactChar = window.SM_READER_FLAGS?.SWITCH_SCROLL_EXACT_CHAR === true`). Default off; can be removed.

### 6. `columnize()`: `Math.round` column width (2026-09-26-23-12-22)
- **Why:** theory that `Math.trunc` made the column grid drift away from `pageIndex * size`.
- **Find:** `'column-width': \`${Math.round(columnWidth)}px\``
- **Change:** `Math.trunc` to `Math.round`.
- **Unproven:** the test did not show that it fixed anything. It was kept because it is harmless in isolation. On a new foliate-js, it is safe to drop first and see whether anything changes.

### 7. Touch handlers: tap-vs-snap and tap-jitter (2026-09-28-12-02-23; 2026-09-29-14-26-56)
- **Why (tap-vs-snap):** on the phone, a tap fired a page turn and then `touchend` called `snap(0, 0)`, which re-pinned the page and cancelled the turn.
- **Why (tap-jitter):** a few px of finger wobble during a tap gave `snap()` a huge velocity and moved the view 1-2 pages.
- **Find:** `#onTouchStart(e)`, `#onTouchMove(e)`, `#onTouchEnd()`; search `tap-vs-snap` and `tap-jitter`.
- **Change:** `#touchState` also has `acc` (net scroll applied by `touchmove`); `#onTouchMove` adds to `acc`; `#onTouchEnd` returns at once if no `touchmove` happened (`if (!moved) return`), and if the net drag is under `TAP_JITTER_PX` it scrolls back by `-acc` and does not call `snap()`.
- **Not local (verified):** the `#onTouchMove` early return while text is selected, and the dominant-axis scroll (`if (Math.abs(dx) >= Math.abs(dy)) this.scrollBy(dx, 0)`), are already in npm 1.0.1. Only the `acc` lines in `#onTouchMove` are SM Reader's.
- **Tradeoff:** a real swipe shorter than 12 px no longer turns the page (use a tap).
- **Known, not changed:** the `requestAnimationFrame` callback at the end reads `this.#touchState` and not the state of the touch that ended. A second touch within one frame could change the snap velocity.

### 8. `rangeStartOnPage()`: new method (bm-onpage 2026-10-03-08-47-15; page-bm-edge 2026-10-03-09-48-04)
- **Why:** the visible range is about two pages long, so a page bookmark showed on more than one page. `app.js` needs to know whether a char is drawn on the current page.
- **Find:** `rangeStartOnPage(range)`
- **Change:** a whole new public method, not in upstream. Uses the same window and rect mapper as `#getVisibleRange()`. Uses `PAGED_EDGE_TOL_PX` for the start edge and `PAGED_EDGE_END_PX` for the end edge. Returns `null` if unknown.
- **app.js depends on it:** `bmOnPage()` calls `renderer.rangeStartOnPage(...)`. If it is missing, page bookmarks count as not on the page.

### 9. Debug beacons (no behavior change)
- **Find:** `SM_READER_DEBUG_BEACON`, `SM_READER_FLAGS` in `paginator.js`.
- **Events:** `probe-readback` (in `#afterScroll`, flag `SWITCH_PROBE_READBACK`) and `touch-jitter` (in `#onTouchEnd`).
- Both are optional; they only do something when `app.js` sets those globals.

### 11. `setStyles()`: re-read background on theme change (theme-bg-refresh 2026-10-10-21-24-31)
- **Why:** `setStyles()` repainted the spacer/gap `#background` divs from `docBackground` captured once at section load, so a theme change left the old color on the spacer and a 1px edge (white line at a chapter start; white flash when swiping to the previous page, flipping mid-swipe when the new section re-read it fresh).
- **Find:** `NOTE: needs \`requestAnimationFrame\` in Chromium` in `setStyles()`
- **Change:** inside that callback, `this.#view.docBackground = getBackground(this.#view.document)` (guarded: destroyed view returns, read failure keeps the old value) before `#replaceBackground()`. Section-load and first-paint paths untouched.

### 10. Diagnostic leftovers (no behavior change)
- **`bisectNode()`:** `const rangeA`, `const rangeB`, `const chosen` instead of upstream's `const result = cb(makeRange(...), makeRange(...)); return result < 0 ? start : end`. Same result.
- **`#scrollToAnchor(anchor, reason = 'anchor', source = 'unknown')`:** the `source` parameter is unused. Its callers pass strings: `'keyboard-selection'`, `'focusin'`, `'onExpand'`, `'render'`, `'public-api'`. Upstream has no such parameter.
- **`await this.#scrollToPage(newPage + 1, reason, undefined)`** in `#scrollToAnchor`: the extra `undefined` argument only.
- Safe to drop when updating; nothing in `app.js` reads `source`.

## Differences between npm 1.0.1 and GitHub main (not SM Reader edits)
Diff of the local files against GitHub main `78914ae` (2026-05-01, downloaded 2026-10-03). The local base is npm 1.0.1, so these are differences between two upstream snapshots, not local changes. They matter only if you switch to GitHub main.

- **In the local (npm 1.0.1) files, not in GitHub main:** `#replaceBackground()` and `docBackground` (per-column page background), `margin`-aware `columnize()` / `scrolled()` for vertical text, `part="container"` / `exportparts ... container`, `containerPosition` getter and setter, async `prev()` / `next()` with `#turnPage` returning `!this.atStart` / `!this.atEnd`, `if (!layout || !this.document) return`, overlayer zoom correction, per-paragraph splitting and `padding` option, `Overlayer(doc)` constructor argument in `view.js`, the `%2c` fix, `allowScript` and the cover fallback in `epub.js`.
- **In GitHub main, not in the local files:** the `document.hidden` guards in `animate()`, the `if (sel)` check before `sel.removeAllRanges()`, PDF support (`isPDF`, `pdf.js`) and `#searchDraw` options in `view.js`, `srcset` loading, `manifestById`, `pageBreakSource` and the `load` event for scripts in `epub.js`, the `filter` parameter in `epubcfi.js`, the `filterFunc` parameter in `text-walker.js`.
- **`vendor/zip.js` and `vendor/fflate.js` differ in size from GitHub main** (55607 vs 36512 bytes; 3830 vs 3857): different builds.
- **To update foliate-js:** keep the pristine `foliate-js-1.0.1.tgz` (or re-run `npm pack foliate-js@1.0.1`) as the reference. Diff a newer version against it to see what upstream changed, then re-apply changes 1-8 and 11 from this file. Moving to GitHub main is a separate decision: it means testing the features above.

## What app.js expects from the paginator and view
- `relocate` events carry `reason` (change 1).
- `renderer.rangeStartOnPage(range)` exists (change 8).
- `app.js` also uses these renderer members (upstream): `goTo`, `next`, `prev`, `getContents`, `setStyles`, `setAttribute`, `size`, `start`.
- `app.js` also uses these view members (upstream): `lastLocation`, `book`, `goTo`, `goToFraction`, `goToTextStart`, `goLeft`, `goRight`, `init`, `open`.
- `app.js` sets `window.SM_READER_FLAGS` and `window.SM_READER_DEBUG_BEACON`, which the paginator reads (change 9).
- Position reads and scrolls use the paired spacer math (changes 4 and 5).

## After updating foliate-js: check list
1. Re-apply changes 1-8 and 11 in that order. Drop 6 first if unsure.
2. Keep 4 and 5 together.
3. Test: reload on pages that start at a paragraph start; reload on a blank page; F11 several times; drag-resize; page bookmark on every page of a chapter (`bm-page`: `here=1` only on the bookmarked page); phone taps and swipes; Go to position, search hit and Contents jump.
4. Bump `sw.js` `CACHE` so the browser does not serve the old files.
