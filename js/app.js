// SM Reader - app.js
// last modified (utc): 2026-10-10-21-24-31
// instructions: on modify, update string.
import './foliate-js/view.js'

/* ---------------- IndexedDB ---------------- */

const DB_NAME = 'sm_reader'
const DB_VERSION = 3 // v2 (2026-10-01-09-10-23): + 'bookmarks' store; v3 (2026-10-04-14-44-09): + dictInfo, dictEntries, dictForms (dictionary)
let dbp = null

function openDB() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts', { keyPath: 'name' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('bookmarks')) {
        const bs = db.createObjectStore('bookmarks', { keyPath: 'id' })
        bs.createIndex('bookId', 'bookId', { unique: false })
      }
      // v3 (dictionary-bundled-import, 2026-10-04-14-44-09): additive stores, existing data untouched
      if (!db.objectStoreNames.contains('dictInfo')) db.createObjectStore('dictInfo', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('dictEntries')) db.createObjectStore('dictEntries', { keyPath: ['d', 'w'] })
      if (!db.objectStoreNames.contains('dictForms')) db.createObjectStore('dictForms', { keyPath: ['d', 'f'] })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

async function idbGet(store, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}
async function idbGetAll(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}
async function idbGetAllByIndex(store, index, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).index(index).getAll(key)
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}
async function idbDelete(store, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
async function idbPut(store, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* simple, fast, non-cryptographic-strength fingerprint: good enough to tell books apart */
/* A plain (non-cryptographic) 64-bit-ish hash, deliberately not using
   SubtleCrypto: crypto.subtle only exists in secure contexts (https, or
   exactly "localhost"), so it throws when the app is opened over plain
   http from another device on the LAN — e.g. a phone hitting the PC's
   http://192.168.x.x:PORT during local testing. This only needs to tell
   books apart, not resist tampering, so a fast manual hash is fine. */
async function fingerprint(file) {
  const buf = await file.slice(0, 1_000_000).arrayBuffer()
  const bytes = new Uint8Array(buf)
  let h1 = 0xdeadbeef ^ bytes.length
  let h2 = 0x41c6ce57 ^ bytes.length
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    h1 = Math.imul(h1 ^ b, 2654435761)
    h2 = Math.imul(h2 ^ b, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const hex = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
  return hex + '-' + file.size
}

/* ---------------- settings ---------------- */

const BUNDLED_FONTS = [
  { id: 'jost', label: 'Jost (sans, Futura-like)', family: "'Jost', system-ui, sans-serif" },
  { id: 'system-sans', label: 'System sans-serif', family: 'system-ui, sans-serif' },
  { id: 'system-serif', label: 'System serif', family: 'Georgia, "Times New Roman", serif' },
]

const SIZE_STEPS = [12, 14, 16, 18, 20, 24, 28, 32]

// colors (2026-09-30-09-18-55): Page / Monitor / Font color each take one of
// these ids or 'custom' (a #rrggbb string kept in <kind>ColorCustom). The Theme
// swatches are presets that set page + font color (never the monitor).
const COLOR_PALETTE = { black: '#000000', cream: '#fffdf5', darkgray: '#1c1c1c', white: '#ffffff' }
const COLOR_FALLBACK = { page: '#ffffff', monitor: '#000000', font: '#000000' }
// A theme button sets all of these at once (theme-link-colors, 2026-10-09-00-33-11: the link color is part of a theme).
// linkColor null = the default for the page: SWITCH_DEFAULT_LINK_COLOR on a light page (White, Cream), SWITCH_DEFAULT_LINK_COLOR_ON_DARK_PAGE
// on a dark page (Night tan #c9a27a); an explicit #rrggbb is used as it is (since theme-links-same-as-text, 2026-10-10-19-20-34 Green
// #33ff66 and Amber #ffb000 use their text color; Night restored to the tan default by 2026-10-10-19-23-08).
const THEME_PRESETS = {
  white: { monitorColor: 'black', pageColor: 'white', fontColor: 'black', linkColor: null },
  cream: { monitorColor: 'black', pageColor: 'cream', fontColor: 'black', linkColor: null },
  night: { monitorColor: 'black', pageColor: 'darkgray', fontColor: 'custom', fontColorCustom: '#dcdcdc', linkColor: null },
  // old monochrome monitors: text on a black screen (green phosphor, amber), links the same color as the text
  green: { monitorColor: 'black', pageColor: 'black', fontColor: 'custom', fontColorCustom: '#33ff66', linkColor: '#33ff66' },
  amber: { monitorColor: 'black', pageColor: 'black', fontColor: 'custom', fontColorCustom: '#ffb000', linkColor: '#ffb000' },
  // plain black and white (theme-blackwhite-alpha-sort, 2026-10-10-18-59-06): black screen and page, white text and links
  'black and white': { monitorColor: 'black', pageColor: 'black', fontColor: 'custom', fontColorCustom: '#ffffff', linkColor: '#ffffff' },
}
// '#rrggbb', 'rrggbb', '#rgb' or 'rgb' -> '#rrggbb' (lower case), else null
function normalizeHex(v) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v ?? '').trim())
  if (!m) return null
  let h = m[1].toLowerCase()
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  return '#' + h
}
function resolveColor(kind) {
  const id = settings[kind + 'Color']
  if (id === 'custom') return normalizeHex(settings[kind + 'ColorCustom']) || COLOR_FALLBACK[kind]
  return COLOR_PALETTE[id] || COLOR_FALLBACK[kind]
}
function isDarkColor(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128
}

const DEFAULT_SETTINGS = {
  fontId: 'jost',
  customFontName: '',
  uploadedFontName: '',
  fontSize: 18,
  theme: 'cream', // legacy, no longer used: see pageColor / fontColor
  pageColor: 'cream', // cream theme is the default since 2026-10-03-19-21-22 (was 'white'); saved settings win
  pageColorCustom: '#ffffff',
  monitorColor: 'black',
  monitorColorCustom: '#000000',
  fontColor: 'black',
  fontColorCustom: '#000000',
  roundedCorners: null, // null = follow the flag SWITCH_DEFAULT_ROUNDED_CORNERS_BORDER_RADIUS_IN_PIXELS
  pageShadow: null, // null = follow the flag SWITCH_DEFAULT_PAGE_SHADOW_ENABLED
  markColor: null, // null = follow SWITCH_DEFAULT_MARK_COLOR
  bookmarkColor: null, // null = follow SWITCH_DEFAULT_BOOKMARK_COLOR
  bmBar: null, // null = follow SWITCH_DEFAULT_SHOW_SMALL_BOOKMARK_BUTTON
  bmStar: null, bmRibbon: null, bmRibbonClickable: null, bmRibbonShape: null, bmRibbonColor: null,
  bmNoteHover: null, fnPopup: null, fnHover: null, // null = follow the matching SWITCH_DEFAULT_* flag
  dictShow: null, // null = follow SWITCH_DEFAULT_DICTIONARY_SETTINGS ('automatic' | 'request' | 'never')
  dictLoad: null, // null = follow SWITCH_DEFAULT_LOAD_DICTIONARY ('start' | 'settings' | 'use' | 'never')
  dictId: null, // null = the bundled dictionary; else the id of a dictionary imported from a file
  keepAwake: null, // null = follow SWITCH_DEFAULT_KEEP_SCREEN_ON (screen stays on while reading)
  keepAppCache: null, // null = follow SWITCH_DEFAULT_KEEP_APP_IN_CACHE_FOR_OFFLINE_ACCESS_ON_CLOSING_WEB_PAGE; else 'auto' | 'true' | 'false'
  linkColor: null, // null = follow SWITCH_DEFAULT_LINK_COLOR; else a #rrggbb string (Settings > Link color)
  wheelClick: null, // null = follow SWITCH_DEFAULT_MOUSE_WHEEL_CLICK; else 'dictionary' | 'select' | 'menu' | 'none'
  lineSpacing: 1.4,
  pageSizeVh: 88,
  frameSizePct: 11,
  pageRatio: 'reader',
  pctDecimals: 2,
  showBookMenu: true,
  showPosition: true,
  startFullscreen: false,
  clickPositionForGoto: false,
}

// Exposed on window so it can be flipped live from devtools while testing.
const FLAGS = {
  SWITCH_CLICK_LEFT_OR_RIGHT_ON_BLACK_SCREEN_WHEN_NO_RED_MENU_PRESENT_GOES_TO_PREV_NEXT_PAGE: true,
  SWITCH_HIDE_TOP_BOOK_MENU_AND_POSITION_AT_BOTTOM_MAKES_TOP_AND_BOTTOM_MARGINS_SAME_SIZE_AS_LEFT_AND_RIGHT_MARGINS: true,
  SWITCH_SHOW_DEBUG_INFO: true,
  // Renamed 2026-09-27 (was SWITCH_WAIT_TILL_PAGE_RESIZE_SETTLES_BEFORE_SYNCING_TOP_LEFT_CHAR_IN_MS,
  // 1000ms): this constant now only coalesces a burst of scheduleRestore()
  // triggers (resize/fullscreen/sidebar/slider calls firing in quick
  // succession) into a single pending restore. It is NOT what confirms the
  // layout has actually settled anymore - that job now belongs to the
  // SWITCH_POLL_PAGINATOR_SIZE_* poll below, added for Problem A (see
  // handoff.md / spec.md 2026-09-26 sessions: this.size kept changing for
  // 30+ calls during a fullscreen transition, well past the old fixed wait).
  SWITCH_WAIT_TILL_MOST_OF_PAGE_RESIZING_BURST_SETTLES_BEFORE_SYNCING_TOP_LEFT_CHAR_IN_MS: 500,
  // Problem A fix (2026-09-27): after the burst-coalescing wait above,
  // poll the paginator's own (already-public) `size` getter
  // (view.renderer.size) instead of trusting a fixed timer to know the
  // resize/fullscreen transition has actually finished. Proceeds once
  // `size` reads the same value STABLE_CHECKS_REQUIRED times in a row, at
  // INTERVAL_MS apart, or gives up and proceeds anyway after MAX_WAIT_MS
  // (safety cap so a genuinely-never-settling size can't hang the restore
  // forever).
  SWITCH_POLL_PAGINATOR_SIZE_BEFORE_RESTORE_INTERVAL_MS: 100,
  SWITCH_POLL_PAGINATOR_SIZE_STABLE_CHECKS_REQUIRED: 3,
  SWITCH_POLL_PAGINATOR_SIZE_MAX_WAIT_MS: 4000,
  // How long after a *confirmed* restore to keep ignoring relocate events
  // (isResizing stays true) as leftover paginator settling noise (e.g.
  // render()'s own trailing #scrollToAnchor(..., 'render') call) before
  // trusting relocates as real position changes again. Separate from the
  // burst-coalescing wait above on purpose - this guards a different,
  // narrower case (see spec.md follow-up entry for pros/cons of instead
  // waiting for trailing relocates to genuinely stop, rather than a fixed
  // grace window).
  SWITCH_POST_RESTORE_GRACE_IGNORE_TRAILING_RELOCATE_EVENTS_IN_MS: 500,
  // 2026-09-27-10-07-59 (persist-int-only): when false (default), the saved
  // location is the integer char index only (lastStableCharIndex /
  // furthestCharIndex) — CFI/fraction are never read for save, load, restore
  // or menu jumps. When true, the legacy CFI/fraction paths are used. Stored
  // rows are a superset of both so the flag can flip without data loss.
  SWITCH_SAVE_LOCATION_AS_CFI: false,
  // PROBE 2026-09-27-11-24-24 (exact-char landing test): when true,
  // #scrollToRect() scrolls to the char's own pixel instead of the page
  // start (expect sliced columns + a re-snap jump on the next page turn).
  // Default off; flip live from devtools (window.SM_READER_FLAGS), read by
  // the vendored paginator. No settings UI until the product call is made.
  // Result: forcing foliate to land on char results with scren errors. No.
  SWITCH_SCROLL_EXACT_CHAR: false,
  // 2026-09-27-15-10-46 (freeze-fullscreen-size): when true, entering
  // fullscreen pins #book-page and #viewer-host at their pre-fullscreen
  // pixel sizes (inline styles; viewport growth goes to the dark surround),
  // so the paginator never reflows and no restore is needed. Cleared on
  // exit. When false, the page scales with the viewport as before (spec §8).
  // 2026-09-28-23-12-51 (fixed-page-size): default false. The page size is now a
  // reference pixel height (--page-h-px, see applyGeometry), so nothing needs
  // pinning; the freeze/snapshot code below stays, dormant.
  SWITCH_KEEP_CONTAINER_AND_PAGE_SIZE_SAME_ON_FULLSCREEN_CHANGE: false,
  // 2026-09-27-15-41-42 (flash-first-row): when true, the landed top row is
  // tinted blue for _MS milliseconds after every restore landing, then
  // unwrapped (transient, never persisted; skipped while a search mark is
  // active). Both devtools-flippable, read live at each flash; no Settings UI.
  // 2026-09-29-08-27-26 (saved-char-mark): default false; replaced by the saved
  // char mark below (code kept, dormant).
  SWITCH_MARK_TEMPORARILY_FIRST_ROW_ON_PAGE_RESIZE: false,
  SWITCH_MARK_TEMPORARILY_FIRST_ROW_ON_PAGE_RESIZE_MS: 3000,
  // 2026-09-29-08-27-26 (saved-char-mark): after every restore, the saved char
  // (the word it starts) is tinted blue with the CSS Custom Highlight API (no
  // DOM wrapping) until the next page turn / jump. Transient, never persisted.
  // Needs a browser with the API (Firefox 140+, Chrome 105+); otherwise no mark.
  SWITCH_MARK_SAVED_CHAR_UNTIL_NEXT_PAGE_TURN: true,
  // 2026-09-29-08-27-26 (read-back probe): paginator.js logs one
  // `probe-readback` event per page turn / jump (page start, first accepted
  // node, bisect steps, char rects). Debug only, read live by paginator.js.
  SWITCH_PROBE_READBACK: true,
  // 2026-09-27-16-35-36 (unified-chrome): open the last viewed book on
  // start when true (fresh install with no opened book lands on Library).
  SWITCH_OPEN_LAST_VIEWED_BOOK_ON_START: true,
  // 2026-09-29-22-00-06: the red left sidebar was removed completely (the
  // merged menu opens from the page header).
  // ...hide the mouse cursor after this many seconds without movement, in
  // fullscreen only (F11 too). 0 = never hide. Any mouse move shows it again.
  // (default 3 since 2026-10-03-08-47-15; was 5)
  SWITCH_HIDE_MOUSE_CURSOR_IN_FULLSCREEN_AFTER_SECONDS: 3,
  // ...how long a toast (Copied / Copy failed) stays on screen, in seconds (share-hyphen-toast-3s, 2026-10-04-10-05-27)
  SWITCH_SHOW_TOAST_TIME_IN_SECONDS: 3,
  // ...text between the book title and the position in Copy (share-colon-separator, 2026-10-04-10-10-47): "Title: 0.816"
  SWITCH_BOOK_TITLE_AND_POSITION_SEPARATOR: ': ',
  // ...Copy on the selected-position bar copies "Title<separator>position" (true) or only the position (false)
  // (pos-bar-copy-goto-only, 2026-10-04-10-41-51)
  SWITCH_COPY_COPIES_TITLE_AND_POSITION: true,
  // ...small icons next to the items of the top menu (book = Library, gear = Settings, lens = Search, ...)
  SWITCH_SHOW_MENU_ICONS: true,
  // ...the first click / tap on the page while the yellow search mark shows only removes the mark (like a selection or
  // the blue saved-position mark); the next one turns the page. false = a click turns the page and the mark stays.
  SWITCH_FIRST_CLICK_CLEARS_SEARCH_MARK: true,
  // ...where the search panel opens (search-panel-place-switch, 2026-10-10-20-47-29):
  // 'top' (under the top menu), 'middle' (screen center, best over a phone keyboard) or 'bottom' (the old place).
  SWITCH_SEARCH_PANEL_PLACE: 'top',
  // ...the search panel moves off a covering search hit after a landed jump (search-panel-drag-close,
  // 2026-10-10-20-52-34). true = hop to the free half on jumps only (never mid-drag); false = never move itself.
  SWITCH_SEARCH_BOX_MOVES_AWAY_FROM_COVERING_SEARCH_RESULT: true,
  // ...mouse only: a click that would turn the page waits this many ms, so a second click can make it a double click
  // (selects the word) or a triple click (selects the paragraph) like in a browser. A second click in the same place
  // inside the delay cancels the turn. 0 = turn at once (a double click then turns the page, as before). Touch is unaffected.
  SWITCH_MOUSE_PAGE_TURN_DELAY_MS_FOR_DOUBLE_CLICK_SELECT: 250,
  // ...(top menu only since bookmark-bar-v2, 2026-10-04-12-11-11; the small bar now toggles instead)
  // disable the top-menu item "Bookmark (this page)" while the page already has a bookmark.
  SWITCH_DISABLE_BOOKMARK_BUTTON_ON_EXISTING_BOOKMARK: true,
  // ...disable the top-menu "Bookmark (selection)" when the selected text, leading and trailing whitespace
  // ignored, lies entirely inside existing text bookmarks (nothing new to add). A gap that holds only whitespace
  // between two bookmarks counts as covered. false = always enabled (extends the bookmark). The small bar uses the
  // same coverage test (and SWITCH_SELECTION_COVERAGE_IGNORES_PUNCTUATION) to show the check before "Bookmark".
  SWITCH_DISABLE_BOOKMARK_BUTTON_WHEN_SELECTION_ADDS_NOTHING: true,
  // ...for the check above also ignore punctuation (a selection that adds only a trailing period adds nothing)
  SWITCH_SELECTION_COVERAGE_IGNORES_PUNCTUATION: false,
  // ...round the corners of the book page (px); 0 = square. Book page only.
  // Default for fresh installs; the Settings slider (0-15) overrides and is saved.
  SWITCH_DEFAULT_ROUNDED_CORNERS_BORDER_RADIUS_IN_PIXELS: 2,
  // ...bookmarks (2026-10-01-09-10-23): small bar (Meaning / Copy / Bookmark / Note)
  // shown while book text is selected; Settings checkbox overrides (saved).
  SWITCH_DEFAULT_SHOW_SMALL_BOOKMARK_BUTTON: true,
  // ...buttons of the small bar and their order (bookmark-bar-v2, 2026-10-04-12-11-11): a name left out hides that
  // button. Names: 'Meaning', 'Copy', 'Bookmark', 'Note'. Read when the book view starts (reload to apply).
  SWITCH_BOOKMARK_MENU: ['Meaning', 'Copy', 'Bookmark', 'Note'],
  // ...locating a missing book file: a picked file whose fingerprint differs from the record asks once
  // (export-books-missing-locate, 2026-10-10-17-07-57). true = ask "Import as same book? (No = new)";
  // false = a mismatch is imported as a new book with no question.
  SWITCH_CONFIRM_REPLACE_BOOK_WRONG_CRC: true,
  // ...max chars of one item label in the main-menu submenus (chapters, books, bookmark snippets;
  // menus-viewall-books-snippets-theme-row, 2026-10-10-15-32-39): 30 fits a 720p phone; 0 or negative = full text.
  SWITCH_SUBMENU_MAX_LABEL_CHARS: 30,
  // ...dictionary (dictionary-meaning, 2026-10-04-12-11-11): 'automatic' = a popup with the meaning when one word is
  // selected (besides the small bar), 'request' = a Meaning button on the small bar, 'never' = neither.
  // Default of the Settings control; the saved user value wins.
  SWITCH_DEFAULT_DICTIONARY_SETTINGS: 'request',
  // ...when the bundled English dictionary is imported into IndexedDB (dictionary-bundled-import, 2026-10-04-14-44-09):
  // 'start' = once, in the background, after the first view is shown (only if it is not installed yet),
  // 'settings' = only when Import is pressed in Settings, 'use' = on the first Meaning lookup, 'never' = no automatic import.
  // Default of the Settings control "When to use dictionary"; the saved user value wins.
  SWITCH_DEFAULT_LOAD_DICTIONARY: 'start',
  // reader-polish-2 (2026-10-04-21-43-23): widths in px, always shrunk to fit inside the book page (never wider than it).
  // The small bookmark bar's note preview, and the popup (dictionary, footnotes; also the hover note when the bar is off).
  SWITCH_NOTE_WIDTH: 340,
  SWITCH_DICT_POPUP_WIDTH: 420,
  // PC: press and hold the left mouse button still on a word this many ms to select it (0 = off). Touch has the native long-press.
  SWITCH_HOLD_MOUSE_BUTTON_TO_SELECT_WORD_MS: 600,
  // ...keep the screen on while a book is shown (Screen Wake Lock; https or localhost only). Default of the Settings checkbox.
  SWITCH_DEFAULT_KEEP_SCREEN_ON: true,
  // dict-loading-live (2026-10-05-09-11-50): log what the dictionary import and the Meaning popup are doing to the dev server
  // terminal (same window as `python -m http.server`: lines `GET /__debug?event=dict-... ts=HH:MM:SS.mmm t=+NNNms ...`,
  // ts = the phone's clock, t = time since the import started). Independent of SWITCH_SHOW_DEBUG_INFO.
  SWITCH_DEBUG_LOADING_DICT_LOG: true,
  // dict-import-timing (2026-10-05-09-16-55): experiments for the speed of the dictionary import; the log (above) prints
  // where the time went (`dict-timing`). The defaults are the old behavior.
  SWITCH_DICT_IMPORT_BATCH_SIZE: 100, // records (word chunks or forms) per IndexedDB write transaction (10..50000); was 2000 lines before the chunked store
  // dict-chunked-store (2026-10-05-09-23-00): words per stored record (8..2000). One record per word took 26 s of 29 s on the phone
  // (about 0.2 ms per record); chunks of consecutive words need about 1/128 of the records.
  SWITCH_DICT_CHUNK_ENTRIES: 128,
  SWITCH_DICT_IMPORT_RELAXED_DURABILITY: false, // true: write the batches with durability 'relaxed' (faster commits, only the batches)
  // the bundled dictionary file, relative to index.html. The worker finds out gzip or plain by the first two bytes, not by the
  // name: e.g. unpack with `gunzip -k dict/oewn-2025.json.gz` and set './dict/oewn-2025.json' to try it uncompressed.
  SWITCH_DICT_BUNDLED_FILE: './dict/oewn-2025.json.gz',
  // offline-copy-settings (2026-10-06-20-10-00; replaces pwa-offline's SWITCH_UNREGISTER_SERVICE_WORKER_ON_EXIT, with the
  // opposite meaning): default of the Settings control "Keep app in cache" (Auto / Yes / No); the saved user value wins.
  // true = keep the app's files in the cache, so the app opens offline; false = keep nothing (no service worker, no cached
  // files); 'auto' = true on https hosting (GitHub Pages), false on development addresses (localhost, 127.0.0.1, *.local,
  // private LAN), where a stale worker is the "mobile trap" and keeps other projects on the same port hostage.
  // 2026-10-09-11-30-26: the default is now true (it was 'auto'): whoever runs the server once and opens http://localhost:PORT (or
  // visits the https site) gets the offline copy, and Chrome / Edge offer "Install app". 'auto' = keep nothing on development
  // addresses (the old default), false = never.
  SWITCH_DEFAULT_KEEP_APP_IN_CACHE_FOR_OFFLINE_ACCESS_ON_CLOSING_WEB_PAGE: true,
  // remove-book (2026-10-07-09-30-22): removing a book from the Library (the x on its row). false = its reading position, bookmarks
  // and notes are removed with it; true = they are kept, so importing the same book again brings them back.
  SWITCH_REMOVE_BOOK_KEEPS_POSITION_AND_BOOKMARKS: false,
  // link-color (2026-10-08-05-32-00): the color of links, in books (footnote markers, contents, internal links) and in the app's own
  // pages. Default of Settings > Link color; the saved user value wins, an empty hex field there goes back to the default.
  // The default follows the page (2026-10-09-00-18-11): SWITCH_DEFAULT_LINK_COLOR for a light page (black; it was light brown
  // '#a67c52' once), SWITCH_DEFAULT_LINK_COLOR_ON_DARK_PAGE for a dark page (page color darker than half: the Night theme, a dark
  // custom page color). A color a book sets directly on a link (inline style) still wins.
  SWITCH_DEFAULT_LINK_COLOR: '#000000',
  SWITCH_DEFAULT_LINK_COLOR_ON_DARK_PAGE: '#c9a27a', // light tan
  // scale-absolute-font-sizes (2026-10-09-00-28-11): the text size setting is put on <html>; when a section of a book loads, its
  // absolute font sizes and line heights (pt, px, pc, in, cm, mm: LibreOffice and many Word exports write `font-size: 12pt` on every
  // span) are turned into rem (16px = 12pt = 1rem), so the setting scales every book and its headings keep their proportions.
  // false = leave the book's absolute sizes alone (the setting then does nothing for such books).
  SWITCH_SCALE_ABSOLUTE_FONT_SIZES: true,
  SWITCH_FORCE_FONT_ON_TEXT_BLOCKS: true, // force-book-font (2026-10-10-15-20-47): true = the font chosen in Settings also wins over a font-family the book sets on p, li, blockquote, dd (headings and spans keep the book's); false = the book's font rules on those win
  // install-toast (2026-10-09-12-00-47): the toasts "Install complete" (the offline copy and the dictionary that were missing at
  // the start are both done) and "Dictionary updated". false = no such toast. Never shown while Settings is open (its status
  // lines show the result), never after a failure.
  SWITCH_SHOW_INSTALL_TOASTS: true,
  // uninstall-toast (2026-10-09-13-26-12): the toast "Uninstall complete" after Remove offline copy and after Keep app in cache is
  // switched to No (only when something was removed). Shown even while Settings is open (the buttons are there). false = no toast.
  SWITCH_SHOW_UNINSTALL_TOAST: true,
  // mouse-wheel-click (2026-10-09-13-26-12): default of Settings > Mouse wheel click, a click with the mouse wheel on book text (PC):
  // 'dictionary' = select the word and show its definition, 'select' = select the word, 'menu' = show / hide the menu,
  // 'none' = the browser's own behavior. The saved user value wins.
  SWITCH_DEFAULT_MOUSE_WHEEL_CLICK: 'dictionary',
  // ...Meaning works on one word only (bookmark-click-copy-meaning, 2026-10-04-12-47-42): true = the Meaning button is
  // greyed out unless the selected text (or the clicked bookmark's text) is one word, and the automatic mode looks at
  // one word only; "don't" and "well-known" count as one word, punctuation around it is ignored.
  // false = any text is looked up (automatic mode: up to 60 characters).
  SWITCH_DICTIONARY_USES_ONLY_ONE_WORD: true,
  // ...ribbon marks of a page bookmark that has a note (ribbon-note-marks, 2026-10-04-12-33-06; no Settings controls,
  // read each time the ribbon is drawn): an "n" inside the ribbon (bold or normal) and/or a second outline outside
  // it (1 px gap in the page color, then a 1 px line: the darker outline color, or the ribbon color).
  SWITCH_RIBBON_SHOWS_ON_NOTE_N: false,
  SWITCH_RIBBON_N_INSIDE_IS_BOLD: false,
  SWITCH_RIBBON_SHOWS_ON_NOTE_DOUBLE_OUTLINE: true,
  SWITCH_RIBBON_DOUBLE_OUTLINE_DARKER: true,
  // ...(2026-10-02-08-32-16) every flag below is the default of a Settings control;
  // the saved user choice wins. Bookmarks: mark a bookmarked PAGE with a '*' after
  // the position in the bottom label, and/or a small ribbon hanging from the top
  // edge of the page; the ribbon may open the Bookmarks menu when clicked; shape
  // A-F (A pointed, B deep point, C notched, D deep notch, E slim notch, F slim
  // point) and its own color; show a bookmark's note in a popup on mouse over.
  SWITCH_DEFAULT_SHOW_BOOKMARKS_AS_ASTERISK_NEAR_BOTTOM_LABEL: true,
  SWITCH_DEFAULT_SHOW_BOOKMARKS_AS_ASTERISK_RIBBON: true,
  SWITCH_DEFAULT_BOOKMARKS_AS_ASTERISK_RIBBON_CLICKABLE: true,
  SWITCH_DEFAULT_BOOKMARK_RIBBON_SHAPE: 'C',
  SWITCH_DEFAULT_BOOKMARK_RIBBON_COLOR: '#ffeb3b',
  // ...the ribbon uses the Bookmark color (Settings: "Use same color as bookmark"); false = its own Ribbon color
  SWITCH_DEFAULT_RIBBON_SAME_COLOR_AS_BOOKMARK: true,
  SWITCH_DEFAULT_SHOW_BOOKMARK_NOTES_ON_MOUSE_OVER: true,
  // ...footnotes: show a note in a popup window (scrolls when long) instead of
  // jumping to it; also when the mouse rests on the note marker (PC); the hover
  // delay is not a Settings control.
  SWITCH_DEFAULT_SHOW_FOOTNOTES_IN_POPUP_WINDOW: true,
  SWITCH_DEFAULT_SHOW_FOOTNOTES_ON_MOUSE_OVER: true,
  SWITCH_FOOTNOTE_HOVER_DELAY_MS: 300,
  // ...colors of the blue saved-position mark and of bookmarks (#rrggbb);
  // Settings color pickers override (saved).
  SWITCH_DEFAULT_MARK_COLOR: '#2196f3',
  SWITCH_DEFAULT_BOOKMARK_COLOR: '#ffeb3b',
  // ...draw a shadow around the book page. Default for fresh installs; the
  // Settings checkbox "Page shadow" overrides and is saved. (Never drawn when
  // monitor and page have the same color.)
  SWITCH_DEFAULT_PAGE_SHADOW_ENABLED: false,
  // ...on touch, a tap in the top / bottom this-many-percent band of the page
  // shows the hidden top / bottom label (a second tap or a swipe hides it)
  SWITCH_TAP_TOP_BOTTOM_LABEL_ZONE_PERCENT: 20,
  // ...where the Back buttons sit in Library/Settings/Contents:
  // 'top', 'bottom' or 'none'. Devtools-flippable, read live.
  SWITCH_BACK_BUTTON_LOCATION_IN_APP: 'top',
  // ...whether Library/Settings/Contents show their title headers.
  SWITCH_SHOW_COMPONENTS_TITLE_IN_APP: true,
  // 2026-09-27-16-55-53 (chrome-font-pct): header/position font sizes as a
  // percentage of the content font size. Both devtools-flippable, read live.
  SWITCH_TOP_MENU_FONT_SIZE_IN_PERCENTAGE: 90,
  SWITCH_BOTTOM_POSITION_FONT_SIZE_IN_PERCENTAGE: 90,
  // ...default footer-% decimals for installs with no stored choice yet
  // (a stored pctDecimals always wins; change the combo to override).
  SWITCH_DEFAULT_BOTTOM_POSITION_DECIMALS_DIGITS: 3,
  // 2026-09-27-17-37-26: footer position in italic when true. Read live.
  SWITCH_BOTTOM_POSITION_ITALIC: true,
  // ...fresh-install defaults (stored showBookMenu/showPosition always win).
  SWITCH_DEFAULT_HIDE_TOP_MENU: true,
  SWITCH_DEFAULT_HIDE_BOTTOM_POSITION: false,
  // 2026-09-28-09-29-09: append '%' to displayed positions (footer, goto and
  // search status) when true. Read live.
  SWITCH_DISPLAY_PERCENTAGE_SIGN_IN_POSITION: false,
  // 2026-09-28-11-27-11 (debug-log-events): print every debug event to the
  // browser console too (terminal beacon stays under SWITCH_SHOW_DEBUG_INFO).
  // Read live.
  SWITCH_LOG_DEBUG_TO_BROWSER_CONSOLE: true,
  // 2026-09-28-12-02-23 (restore-diag-retry): after a restore, if the landed
  // top-left char is earlier than the target (seen after F11: one page early),
  // wait 150ms and goTo the target once more. Gap limit in chars. Read live.
  // 2026-09-28-20-12-00 (retry-off): default false. Logs showed landed2 == landed
  // in every retry (a page-start landing is normal for a mid-page target).
  SWITCH_RETRY_RESTORE_ONCE_IF_LANDED_EARLY: false,
  SWITCH_RESTORE_RETRY_MAX_CHAR_GAP: 2000,
  // 2026-09-27-17-52-01 (overlay-chrome): uniform margins always, with the
  // title/position overlaid onto the margin bands (zero layout impact, so
  // toggles never reflow and restores never fire for chrome). Read live.
  SWITCH_PUT_TOP_MENU_AND_POSITION_TO_HALF_SPACE_VERTICALLY_AND_USE_SAME_HORIZONTAL_AND_VERTICAL_MARGINS: true,
}
window.SM_READER_FLAGS = FLAGS
// read-back probe hook: lets the vendored paginator use the same beacon
window.SM_READER_DEBUG_BEACON = (event, extra) => debugBeacon(event, extra)

function debugOn() { return FLAGS.SWITCH_SHOW_DEBUG_INFO === true || FLAGS.SWITCH_LOG_DEBUG_TO_BROWSER_CONSOLE === true }
// debug-log-events (2026-09-28-11-27-11): paginator geometry for every event.
// iframeOffset should be about `size` (one leading spacer page, View.expand()).
function debugGeom() {
  try {
    const r = view?.renderer
    let off = ''
    try { const f = r.getContents()[0].doc.defaultView.frameElement; off = Math.round(f.getBoundingClientRect().left - f.parentElement.getBoundingClientRect().left) } catch {}
    return { size: r?.size, start: r?.start, page: r?.page, pages: r?.pages, iframeOffset: off, fs: !!document.fullscreenElement, dm: !!displayModeMql?.matches, frozen: fullscreenFrozen }
  } catch { return {} }
}
// spacer pages: container page 0 (leading) and pages-1 (trailing) hold no book content
function isOnSpacerPage() {
  try { const r = view?.renderer; return !!r && !r.scrolled && r.pages > 2 && (r.page <= 0 || r.page >= r.pages - 1) } catch { return false }
}
// sel-beacon (2026-10-02-09-41-37): read-only trace of the book text selection (events sel-*);
// diagnoses "selection vanishes on the phone". No behavior change.
function selLen(doc) { try { return String(doc?.getSelection?.() ?? '').length } catch { return -1 } }
function selDbg(ev, doc, extra = {}) {
  if (!debugOn()) return
  debugBeacon('sel-' + ev, { len: selLen(doc), ptr: lastPointerType, ...extra })
}
function debugBeacon(event, extra = {}) {
  if (!debugOn()) return
  try {
    const cfi = extra.cfi ?? lastStableCfi ?? view?.lastLocation?.cfi ?? ''
    const frac = extra.frac ?? lastStableFraction ?? view?.lastLocation?.fraction ?? ''
    const charIdx = extra.charIdx ?? lastStableCharIndex ?? getCurrentCharIndex?.() ?? ''
    const pct = frac !== '' && frac != null ? (frac * 100).toFixed(2) : (charIdx !== '' && charIdx != null && bookTotalChars ? (charIdx / bookTotalChars * 100).toFixed(2) : '')
    // top-left snippet for char-level check (30 chars)
    let snippet = ''
    try {
      const r = extra.range ?? view?.lastLocation?.range
      if (r) snippet = String(r).slice(0, 30)
    } catch {}
    let q = `event=${encodeURIComponent(event)}&pct=${encodeURIComponent(pct)}&frac=${encodeURIComponent(String(frac))}&char=${encodeURIComponent(String(charIdx))}&cfi=${encodeURIComponent(String(cfi).slice(0,120))}&snippet=${encodeURIComponent(snippet)}`
    // diagnostic-only passthrough: any extra key not already handled above
    // (e.g. idx/prefix/local from encode, secIdx/secOffset from decode) is
    // appended as-is, so char-index round-trip debugging can be read
    // straight off the terminal log without touching any other behavior.
    const knownKeys = new Set(['cfi', 'frac', 'charIdx', 'range'])
    let xs = ''
    for (const [k, v] of Object.entries(extra)) {
      if (knownKeys.has(k)) continue
      q += `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
      xs += ` ${k}=${String(v)}`
    }
    // appears in python -m http.server terminal as GET /__debug?... 404 -
    if (FLAGS.SWITCH_SHOW_DEBUG_INFO) fetch(`/__debug?${q}`, { cache: 'no-store', method: 'GET' }).catch(() => {})
    if (FLAGS.SWITCH_LOG_DEBUG_TO_BROWSER_CONSOLE) console.log(`[SM DEBUG] ${event} pct=${pct}% frac=${frac} char=${charIdx}/${bookTotalChars} cfi=${String(cfi).slice(0,80)} snippet="${snippet}"${xs}`)
  } catch {}
}

let settings = { ...DEFAULT_SETTINGS }

/* theme-combo (2026-10-10-14-46-48): named themes. A theme = monitor, page, font and link colors (ids plus custom hex values).
   Built-in: THEME_PRESETS (names White, Cream, Night, Green, Amber, Black and white). User themes: settings.userThemes { name: colors } (kept in the
   settings row, so Export / Import carries them). settings.defaultTheme = the theme of every book without its own; a book's own theme
   is books record .themeName (not part of Export, which never carries book records). A combo choice only changes the live colors
   (they are re-set at the next start from the default theme, and when a book opens from its own or the default theme). */
const THEME_KEYS = ['monitorColor', 'monitorColorCustom', 'pageColor', 'pageColorCustom', 'fontColor', 'fontColorCustom', 'linkColor']
const THEME_BY_NAME = Object.fromEntries(Object.entries(THEME_PRESETS).map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), v]))
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isBuiltinThemeName = n => Object.keys(THEME_BY_NAME).some(b => b.toLowerCase() === String(n).trim().toLowerCase())
let themeSel = null // name last chosen or saved in the combo (tells apart themes with identical colors)
let currentBookTheme = null // themeName saved on the open book's record, else null
function findTheme(name) {
  let t = null
  if (typeof name !== 'string') return null
  if (hasOwn(THEME_BY_NAME, name)) t = THEME_BY_NAME[name]
  else if (settings.userThemes && hasOwn(settings.userThemes, name)) t = settings.userThemes[name]
  return t && typeof t === 'object' ? t : null
}
const themeNames = () => [...Object.keys(THEME_BY_NAME).sort((a, b) => a.localeCompare(b)), ...Object.keys(settings.userThemes || {}).sort((a, b) => a.localeCompare(b))]
const globalThemeName = () => (findTheme(settings.defaultTheme) ? settings.defaultTheme : 'Cream')
function currentThemeColors() {
  const o = {}
  for (const k of THEME_KEYS) o[k] = settings[k] ?? null
  return o
}
function themeResolved(t, kind) {
  const id = t[kind + 'Color']
  if (id === 'custom') return normalizeHex(t[kind + 'ColorCustom']) || COLOR_FALLBACK[kind]
  return COLOR_PALETTE[id] || COLOR_FALLBACK[kind]
}
function themeMatches(t) { // same colors as shown now (compared as resolved colors, link color null = the page default)
  if (!t) return false
  for (const kind of ['monitor', 'page', 'font']) if (themeResolved(t, kind) !== resolveColor(kind)) return false
  return (normalizeHex(t.linkColor) || null) === (normalizeHex(settings.linkColor) || null)
}
function applyThemeColors(t) { // sets the colors in settings (the caller runs applyTheme() when the page must change)
  const c = {}
  for (const kind of ['monitor', 'page', 'font']) {
    const id = t[kind + 'Color']
    c[kind + 'Color'] = (id === 'custom' || (typeof id === 'string' && hasOwn(COLOR_PALETTE, id))) ? id : DEFAULT_SETTINGS[kind + 'Color']
    if (t[kind + 'ColorCustom'] !== undefined) c[kind + 'ColorCustom'] = normalizeHex(t[kind + 'ColorCustom']) || DEFAULT_SETTINGS[kind + 'ColorCustom']
  }
  c.linkColor = normalizeHex(t.linkColor) || null
  Object.assign(settings, c)
}
function currentThemeName() {
  if (themeSel && themeMatches(findTheme(themeSel))) return themeSel
  return themeNames().find(n => themeMatches(findTheme(n))) || null
}
function applyThemeForBook(row) { // openBook: the book's own theme, else the default theme
  const own = typeof row?.themeName === 'string' && findTheme(row.themeName) ? row.themeName : null
  currentBookTheme = own
  const name = own || globalThemeName()
  applyThemeColors(findTheme(name))
  themeSel = name
}
function suggestThemeName() { // current name + -1, or -2 ... when taken ("Cream-1" gives "Cream-2")
  const base = (currentThemeName() || 'Custom').replace(/-\d+$/, '')
  const taken = new Set(themeNames().map(n => n.toLowerCase()))
  let i = 1
  while (taken.has((base + '-' + i).toLowerCase())) i++
  return base + '-' + i
}
function renderThemeControls() {
  const sel = $('#theme-select')
  if (!sel) return
  const cur = currentThemeName()
  sel.innerHTML = ''
  for (const n of themeNames()) {
    const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o)
  }
  if (cur == null) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Custom (unsaved)'; sel.appendChild(o) }
  sel.value = cur ?? ''
  const pv = $('#theme-preview')
  pv.textContent = cur ?? 'Custom'
  pv.style.background = resolveColor('page')
  pv.style.color = resolveColor('font')
  pv.style.border = '5px solid ' + resolveColor('monitor')
  const all = $('#theme-default-all'), book = $('#theme-default-book')
  const isGlobal = cur != null && cur === globalThemeName()
  all.checked = isGlobal
  all.disabled = cur == null || (isGlobal && cur === 'Cream') // Cream is the fallback: pick another theme and check "all" to change it
  book.checked = cur != null && currentBookTheme === cur
  book.disabled = cur == null || currentBookId == null
}
async function saveThemeAs() {
  let name = suggestThemeName(), msg = 'Save theme as:'
  for (;;) {
    const v = prompt(msg, name)
    if (v == null) return
    name = v.trim().replace(/\s+/g, ' ')
    msg = 'Save theme as:'
    if (!name) { name = suggestThemeName(); msg = 'Enter a name for the theme:'; continue }
    if (name.length > 40) { name = name.slice(0, 40); msg = 'Please use a name of at most 40 characters:'; continue }
    if (name === '__proto__') { name = suggestThemeName(); msg = 'That name cannot be used. Save theme as:'; continue }
    if (isBuiltinThemeName(name)) { msg = `"${name}" is a built-in theme and cannot be replaced. Save theme as:`; continue }
    const existing = Object.keys(settings.userThemes).find(n => n.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (!(await askYesNo(`Theme "${existing}" already exists. Overwrite it?`))) continue
      name = existing
    }
    break
  }
  settings.userThemes[name] = currentThemeColors()
  themeSel = name
  await saveSettings()
  renderSettings()
}
async function setThemeDefaultAll(on) {
  const name = currentThemeName()
  if (on) {
    if (!name) { renderThemeControls(); return }
    settings.defaultTheme = name
  } else {
    settings.defaultTheme = 'Cream'
    if (currentBookTheme == null) { themeSel = 'Cream'; applyThemeColors(THEME_BY_NAME.Cream); applyTheme() } // no book theme on top: show the new default
  }
  await saveSettings()
  renderSettings()
}
async function setThemeDefaultBook(on) {
  const row = currentBookId != null ? await idbGet('books', currentBookId) : null
  const name = currentThemeName()
  if (!row || (on && !name)) { renderThemeControls(); return }
  if (on) { row.themeName = name; currentBookTheme = name }
  else {
    delete row.themeName; currentBookTheme = null
    const g = globalThemeName()
    themeSel = g; applyThemeColors(findTheme(g)); applyTheme() // back to the default theme
  }
  await idbPut('books', row)
  await saveSettings()
  renderSettings()
}

async function loadSettings() {
  const row = await idbGet('settings', 'reader')
  if (row) settings = { ...DEFAULT_SETTINGS, ...row.value }
  // chrome-font-pct: fresh installs (no stored choice) take the flag default
  if (row?.value?.pctDecimals == null) {
    const d = parseInt(FLAGS.SWITCH_DEFAULT_BOTTOM_POSITION_DECIMALS_DIGITS ?? 3, 10)
    settings.pctDecimals = Math.min(7, Math.max(0, isNaN(d) ? 3 : d))
  }
  // position-toggle-defaults (2026-09-27-18-23-13): fresh installs start
  // with chrome hidden when the flags say so; stored choices always win
  if (row?.value?.showBookMenu == null) {
    settings.showBookMenu = !(FLAGS.SWITCH_DEFAULT_HIDE_TOP_MENU === true)
  }
  if (row?.value?.showPosition == null) {
    settings.showPosition = !(FLAGS.SWITCH_DEFAULT_HIDE_BOTTOM_POSITION === true)
  }
  // colors + rounded corners: validate stored values; the corner default comes
  // from the flag until the user moves the slider (then the saved value wins)
  for (const kind of ['page', 'monitor', 'font']) {
    const id = settings[kind + 'Color']
    if (id !== 'custom' && !(id in COLOR_PALETTE)) settings[kind + 'Color'] = DEFAULT_SETTINGS[kind + 'Color']
    settings[kind + 'ColorCustom'] = normalizeHex(settings[kind + 'ColorCustom']) || DEFAULT_SETTINGS[kind + 'ColorCustom']
  }
  // theme-combo: user themes + the default theme. First run (no valid defaultTheme): the stored colors become the default (a
  // built-in or user theme with the same colors, else a new user theme 'Previous look'), so nobody's look changes.
  if (!settings.userThemes || typeof settings.userThemes !== 'object' || Array.isArray(settings.userThemes)) settings.userThemes = {}
  if (!findTheme(settings.defaultTheme)) {
    let name = themeNames().find(n => themeMatches(findTheme(n)))
    if (!name) {
      name = 'Previous look'
      for (let i = 2; hasOwn(settings.userThemes, name); i++) name = 'Previous look ' + i
      settings.userThemes[name] = currentThemeColors()
    }
    settings.defaultTheme = name
  }
  applyThemeColors(findTheme(settings.defaultTheme))
  themeSel = settings.defaultTheme
  if (settings.pageShadow == null) settings.pageShadow = FLAGS.SWITCH_DEFAULT_PAGE_SHADOW_ENABLED === true
  if (settings.roundedCorners == null) {
    const rc = parseInt(FLAGS.SWITCH_DEFAULT_ROUNDED_CORNERS_BORDER_RADIUS_IN_PIXELS ?? 2, 10)
    settings.roundedCorners = Math.min(15, Math.max(0, isNaN(rc) ? 2 : rc))
  }
  applyGeometry()
}
async function saveSettings() {
  await idbPut('settings', { key: 'reader', value: settings })
}

// fixed-page-size (2026-09-28-23-12-51): returns true when the value changed.
function setPageRefHeight() {
  const px = Math.round((settings.pageSizeVh / 100) * window.innerHeight * 100) / 100
  const cur = document.documentElement.style.getPropertyValue('--page-h-px')
  const next = px + 'px'
  if (cur === next) return false
  document.documentElement.style.setProperty('--page-h-px', next)
  return true
}
function applyGeometry() {
  // 2026-09-27-19-02-57 (unfreeze-on-change): a user geometry change while
  // frozen releases the pin first, so it takes effect now through the normal
  // capture + restore path (next fullscreen entry re-freezes). Without this
  // the pinned px silently overrides the vars until exit.
  if (fullscreenFrozen) unfreezeFullscreenSize()
  if (view && lastStableCfi) captureAnchor()
  document.documentElement.style.setProperty('--page-height-vh', settings.pageSizeVh)
  // fixed-page-size (2026-09-28-23-12-51): reference page height in px from the
  // window as it is right now (startup / user geometry change). Fullscreen never
  // recomputes it; see the settled window-resize handler.
  setPageRefHeight()
  document.documentElement.style.setProperty('--page-margin-pct', settings.frameSizePct)
  // page-proportions (2026-09-27-18-56-31): width:height — Reader classic
  // 3:4, US Letter 8.5:11, ISO A4 210:297
  const ratios = { reader: 0.75, a4: 210 / 297, letter: 8.5 / 11 }
  document.documentElement.style.setProperty('--page-ratio', ratios[settings.pageRatio] ?? ratios.reader)
  if (view && lastStableCfi) scheduleRestore()
}

/* uploaded font: stored as a data URL, registered as a @font-face named 'UserFont' */
let uploadedFontLabel = null // file name of the stored upload (upload-row-submenu, 2026-10-10-20-19-28): submenu row, null = no row
async function loadUploadedFont() {
  const row = await idbGet('fonts', 'user-uploaded')
  if (!row) return null
  const style = document.createElement('style')
  style.dataset.userfont = '1'
  style.textContent = `@font-face { font-family: 'UserFont'; src: url(${JSON.stringify(row.dataUrl)}); }`
  document.head.appendChild(style)
  return row.originalName
}

function currentFontFamily() {
  if (settings.uploadedFontName) return `'UserFont', system-ui, sans-serif`
  if (settings.customFontName) return `"${settings.customFontName}", system-ui, sans-serif`
  const f = BUNDLED_FONTS.find(f => f.id === settings.fontId) || BUNDLED_FONTS[0]
  return f.family
}

/* ---------------- app state ---------------- */

const $ = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))

// 2026-09-27-10-41-54 (pct-decimals-setting): footer % with configurable
// decimals (settings.pctDecimals, combo 0-7; default from
// SWITCH_DEFAULT_BOTTOM_POSITION_DECIMALS_DIGITS when nothing stored).
function formatPct(fraction) {
  const d = Math.min(7, Math.max(0, settings.pctDecimals ?? 2))
  return (fraction * 100).toFixed(d) + (FLAGS.SWITCH_DISPLAY_PERCENTAGE_SIGN_IN_POSITION === true ? '%' : '')
}
function refreshPctDisplay() {
  if (!view) return
  // pct-from-char (2026-09-27-10-49-44): in int mode the footer shows the
  // stored/landed char position, never the stale pre-resize fraction.
  if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && lastStableCharIndex != null && bookTotalChars) $('#pct-display').textContent = formatPct(lastStableCharIndex / bookTotalChars)
  else if (lastStableFraction != null) $('#pct-display').textContent = formatPct(lastStableFraction)
  else if (lastStableCharIndex != null && bookTotalChars) $('#pct-display').textContent = formatPct(lastStableCharIndex / bookTotalChars)
}

let view = null
let currentBookId = null
let saveTimer = null
// Immediate write of the current stable anchor (same payload as the debounced
// save below). Flushed on pagehide/hidden so the last page-turns are not lost
// when the page closes within the 400ms debounce window.
function savePositionNow() {
  if (!view || currentBookId == null) return
  if (lastStableCfi == null && lastStableCharIndex == null) return
  idbPut('positions', { id: currentBookId, cfi: lastStableCfi, fraction: lastStableFraction, furthestFraction, charIndex: lastStableCharIndex, furthestCharIndex, totalChars: bookTotalChars || null, savedAt: Date.now() })
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { clearTimeout(saveTimer); savePositionNow() } })
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); savePositionNow() })

/* keep the screen on while reading (reader-polish-2, 2026-10-04-21-43-23): Screen Wake Lock API. It needs https or
   localhost; where navigator.wakeLock does not exist (plain http on the LAN) nothing happens. The browser drops the lock
   when the page is hidden; it is asked for again when the page is visible. Wanted: setting on, a book is open and shown
   (not the Library / Bookmarks / Settings views), page visible. */
let wakeLock = null, wakeBusy = false, wakeAgain = false
const wantWakeLock = () => (settings.keepAwake ?? (FLAGS.SWITCH_DEFAULT_KEEP_SCREEN_ON === true)) === true
  && !!view && document.visibilityState === 'visible' && !readerOverlayShown()
async function updateWakeLock() {
  if (!navigator.wakeLock) return
  if (wakeBusy) { wakeAgain = true; return }
  wakeBusy = true
  try {
    if (wantWakeLock()) {
      if (!wakeLock) {
        const w = await navigator.wakeLock.request('screen')
        w.addEventListener('release', () => { if (wakeLock === w) wakeLock = null })
        wakeLock = w
      }
    } else if (wakeLock) { const w = wakeLock; wakeLock = null; await w.release() }
  } catch { wakeLock = null }
  wakeBusy = false
  if (wakeAgain) { wakeAgain = false; updateWakeLock() }
}
function initWakeLock() {
  document.addEventListener('visibilitychange', updateWakeLock)
  const mo = new MutationObserver(updateWakeLock) // the views open and close by their 'show' class
  for (const id of ['#library-view', '#settings-view', '#bookmarks-view']) { const el = $(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] }) }
  updateWakeLock()
}
let furthestFraction = 0
let furthestCharIndex = null // int-only companion to furthestFraction (persist-int-only)
let lastStableCfi = null
let lastStableFraction = null
let lastStableSnippet = null
let lastStableCharIndex = null
let bookTotalChars = 0
let bookCharPrefixes = []
let isResizing = false
// search-book-panel (2026-09-27-12-08-27): query kept till reload (module var,
// never persisted); per-section visible-text cache cleared on every openBook;
// lastSearchLandedChar lets repeated Previous/Next step past the same match.
let lastSearchQuery = ''
let lastSearchQueryForStep = ''
let lastSearchLandedChar = null
let searchTextCache = []
// transient current-match mark (2026-09-27-12-42-49): inline-styled span in the
// live doc only (book-doc stylesheet untouched); cleared on next search step,
// book switch and overlay close — never persisted. Page turns deliberately
// keep it (2026-09-27-14-09-57): clearing on turn erased the mark before the
// found region could be examined.
let searchMark = null

// image-chars (2026-09-28-11-27-11): one shared counting rule. Text nodes count
// their code points; each outermost media element (image, svg, canvas, video,
// audio, object, embed, iframe, hr) counts as exactly 1 virtual char, so
// image-only pages/sections get positions of their own. Text inside a media
// element is ignored. Every walker (section totals, read-back, char -> range,
// search text) must use these helpers so the numbers always agree.
const CHAR_MEDIA_SEL = 'img,svg,canvas,video,audio,object,embed,iframe,hr'
const CHAR_WALK_SHOW = NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
function charAcceptNode(n) {
  if (n.nodeType === 1) {
    if (!n.matches?.(CHAR_MEDIA_SEL)) return NodeFilter.FILTER_SKIP
    if (n.parentElement?.closest?.(CHAR_MEDIA_SEL)) return NodeFilter.FILTER_SKIP // nested: outer one counts
    return NodeFilter.FILTER_ACCEPT
  }
  const p = n.parentElement
  if (!p) return NodeFilter.FILTER_REJECT
  const tag = p.tagName?.toLowerCase()
  if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT
  if (p.closest?.(CHAR_MEDIA_SEL)) return NodeFilter.FILTER_REJECT
  if (!n.nodeValue?.trim()) return NodeFilter.FILTER_SKIP
  return NodeFilter.FILTER_ACCEPT
}
function charNodeLen(n) { return n.nodeType === 1 ? 1 : [...(n.nodeValue ?? '')].length }
function countVisibleCharsInDoc(doc) {
  const walker = doc.createTreeWalker(doc.body, CHAR_WALK_SHOW, { acceptNode: charAcceptNode })
  let total = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) total += charNodeLen(n)
  return total
}
// chars strictly before the range start. A media element that contains the
// start is the current char itself (not counted); text before it is.
function countCharsUpToRange(doc, range) {
  if (!range) return 0
  const walker = doc.createTreeWalker(doc.body, CHAR_WALK_SHOW, { acceptNode: charAcceptNode })
  const sc = range.startContainer, so = range.startOffset
  const pos = doc.createRange()
  pos.setStart(sc, so); pos.collapse(true)
  const nr = doc.createRange()
  let total = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === sc) { total += [...(n.nodeValue ?? '').slice(0, so)].length; break }
    if (n.nodeType === 1 && n.contains(sc)) break
    if (n.nodeType === 1) nr.setStartBefore(n); else nr.setStart(n, 0)
    nr.collapse(true)
    if (nr.compareBoundaryPoints(Range.START_TO_START, pos) < 0) total += charNodeLen(n)
    else break
  }
  return total
}
async function computeBookCharPrefixes() {
  if (!view?.book) return
  const sections = view.book.sections
  bookCharPrefixes = []
  bookTotalChars = 0
  for (let i = 0; i < sections.length; i++) {
    bookCharPrefixes[i] = bookTotalChars
    try {
      const doc = await sections[i].createDocument()
      // empty (no text, no media) section still counts 1 virtual char
      if (doc) bookTotalChars += Math.max(1, countVisibleCharsInDoc(doc))
    } catch {}
  }
}
// blank-page-read (2026-09-28-20-12-00): paginator's getVisibleRange returns a
// collapsed range at doc.body when a page holds no readable node (blank page
// inside a section). Real positions never look like that, EXCEPT the first
// text page of an image-only section (Alice cover reads as a collapsed range
// at body, char 0), so only pages after the first text page count.
function isNoNodeRange(range) {
  try {
    const r = view?.renderer
    if (!r || r.scrolled || !(r.page > 1)) return false
    const sc = range?.startContainer
    return !!range && range.collapsed && sc?.nodeType === 1 && sc === sc.ownerDocument?.body
  } catch { return false }
}
// blank-page-save (2026-09-29-09-39-04): a page with no readable node has no
// char of its own. Its position is the last char of the last counted node that
// starts before the page window (the last text the reader has seen), so a
// reload lands on that page whichever direction the blank page was reached
// from. LTR horizontal paginated only; null otherwise (nothing is saved).
function getCharBeforeBlankPage(range) {
  try {
    const r = view?.renderer
    const doc = range?.startContainer?.ownerDocument
    if (!r || r.scrolled || !doc?.body || !doc.defaultView || !view?.book) return null
    const cs = doc.defaultView.getComputedStyle(doc.body)
    if (cs.direction === 'rtl' || !/^horizontal/.test(cs.writingMode || 'horizontal-tb')) return null
    const winStart = (r.page - 1) * r.size // iframe coords of this page's left edge
    const walker = doc.createTreeWalker(doc.body, CHAR_WALK_SHOW, { acceptNode: charAcceptNode })
    const rg = doc.createRange()
    let total = 0
    let best = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = charNodeLen(n)
      let rect
      if (n.nodeType === 1) rect = n.getBoundingClientRect()
      else { rg.selectNodeContents(n); rect = rg.getBoundingClientRect() }
      if (rect.width === 0 && rect.height === 0) { total += len; continue }
      if (rect.left >= winStart) break
      best = total + len - 1
      total += len
    }
    if (best == null) return null
    const contents = r.getContents?.() ?? []
    const idx = contents.find(c => c.doc === doc)?.index ?? contents[0]?.index ?? 0
    return (bookCharPrefixes[idx] ?? 0) + best
  } catch { return null }
}
function saveBlankPageAsPreviousText(e) {
  const reason = e.detail?.reason
  const restoreNavActive = restoreNavGen !== 0 && restoreNavGen === restoreGeneration
  if (isResizing || restoreNavActive) return
  if (reason !== 'page' && reason !== 'navigation' && reason !== 'snap') return
  if (reason === 'page' || reason === 'snap') clearSavedCharMark()
  const idx = getCharBeforeBlankPage(e.detail.range)
  if (idx == null) return
  lastStableCharIndex = idx
  if (furthestCharIndex == null || idx > furthestCharIndex) furthestCharIndex = idx
  if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && bookTotalChars) $('#pct-display').textContent = formatPct(idx / bookTotalChars)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(savePositionNow, 400)
}
function getCurrentCharIndex() {
  try {
    const range = view?.lastLocation?.range
    if (!range || !view?.book) return null
    if (isNoNodeRange(range)) return null
    const doc = range.startContainer?.ownerDocument
    if (!doc) return null
    // find section index for this doc (2026-09-27-14-40-47: match the
    // range's own document; contents[0] is wrong when several views are
    // mounted at once — multi-section books, spread, reflow transitions)
    const contents = view.renderer?.getContents?.() ?? []
    let idx = contents.find(c => c.doc === doc)?.index ?? contents[0]?.index
    if (idx == null) {
      // fallback: find by comparing doc
      idx = 0
    }
    const prefix = bookCharPrefixes[idx] ?? 0
    const local = countCharsUpToRange(doc, range)
    return prefix + local
  } catch { return null }
}
async function getRangeForCharIndex(charIndex) {
  if (charIndex == null || !view?.book || !bookTotalChars) return null
  // find section
  let secIdx = 0
  for (let i = 0; i < bookCharPrefixes.length; i++) {
    const start = bookCharPrefixes[i]
    const end = i + 1 < bookCharPrefixes.length ? bookCharPrefixes[i + 1] : bookTotalChars
    if (charIndex >= start && charIndex < end) { secIdx = i; break }
    if (charIndex >= end) secIdx = i + 1
  }
  if (secIdx >= view.book.sections.length) secIdx = view.book.sections.length - 1
  const secOffset = charIndex - (bookCharPrefixes[secIdx] ?? 0)
  // return anchor that walks the *live* paginator doc (passed as arg), not the counted doc
  const makeAnchor = secOffsetVal => (liveDoc) => {
    // goto-target diag (2026-09-28-12-02-23): where the target char sits in
    // iframe coords vs the page the paginator will pick (floor(x/size)+1).
    const finish = r => {
      if (debugOn()) {
        try {
          const rc = r.getBoundingClientRect()
          const size = view?.renderer?.size
          debugBeacon('goto-target', { target: charIndex, sec: secIdx, left: Math.round(rc.left * 100) / 100, top: Math.round(rc.top), ratio: size ? Math.round(rc.left / size * 1000) / 1000 : '', calcPage: size ? Math.floor(rc.left / size) + 1 : '', ...debugGeom() })
        } catch {}
      }
      return r
    }
    const walker = liveDoc.createTreeWalker(liveDoc.body, CHAR_WALK_SHOW, { acceptNode: charAcceptNode })
    const nodes = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n)
    let remaining = secOffsetVal
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (n.nodeType === 1) {
        // media element = 1 char: target it (selectNode gives a real rect)
        if (remaining <= 0) { const r = liveDoc.createRange(); r.selectNode(n); return finish(r) }
        remaining -= 1
        continue
      }
      const len = [...(n.nodeValue ?? '')].length
      // boundary-next-node (2026-09-29-09-39-04): a char index that equals the
      // end of this node is the FIRST char of the next node (the read-back
      // counts chars strictly before the page's first char). Only the very
      // last node keeps the end-of-node anchor. Before, a page starting at a
      // paragraph start restored to the end of the previous paragraph, i.e.
      // the previous page. A following media element is still targeted by
      // the media branch above (remaining 0).
      const isLastNode = i === nodes.length - 1
      if (remaining < len || (remaining === len && isLastNode)) {
        const str = n.nodeValue ?? ''
        let cuOffset = 0
        let cpCount = 0
        for (const ch of str) {
          if (cpCount >= remaining) break
          cuOffset += ch.length
          cpCount++
        }
        const range = liveDoc.createRange()
        range.setStart(n, Math.min(cuOffset, n.nodeValue.length))
        range.collapse(true)
        return finish(range)
      }
      remaining -= len
    }
    // fallback: start of body
    const range = liveDoc.createRange()
    range.selectNodeContents(liveDoc.body)
    range.collapse(true)
    return finish(range)
  }
  return { index: secIdx, anchor: makeAnchor(secOffset) }
}

/* ---------------- library ---------------- */

async function refreshLibrary() {
  const books = await idbGetAll('books')
  const posById = new Map((await idbGetAll('positions')).map(p => [p.id, p]))
  books.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
  const body = $('#library-body')
  body.innerHTML = ''
  if (!books.length) {
    body.innerHTML = '<p style="opacity:.7">No books yet. Import an EPUB to get started.</p>'
    return
  }
  for (const b of books) {
    const row = document.createElement('div')
    row.className = 'book-row'
    const img = document.createElement('img')
    if (b.coverDataUrl) img.src = b.coverDataUrl
    const meta = document.createElement('div')
    meta.className = 'meta'
    const opened = b.openedAt
      ? `Opened: ${new Date(b.openedAt).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`
      : '(Not yet opened)'
    // library last row (2026-10-01-09-10-23): the last position as a bare number in the
    // bottom-label format; 0 for a book that was never opened
    const pr = posById.get(b.id)
    const frac = pr && pr.charIndex != null && pr.totalChars ? pr.charIndex / pr.totalChars : (pr?.fraction ?? 0)
    meta.innerHTML = `<div class="title">${b.title}</div><div class="opened">${opened}</div><div class="pos">${formatPct(Math.min(1, Math.max(0, frac || 0)))}</div>${b.file ? '' : '<div class="missing">Book missing — tap to locate</div>'}`
    // remove-book: a small x at the right end of the row; the click must not open the book
    const rm = document.createElement('button')
    rm.className = 'book-remove'
    rm.textContent = '×'
    rm.title = 'Remove from library'
    rm.setAttribute('aria-label', 'Remove from library')
    rm.addEventListener('click', e => { e.stopPropagation(); removeBook(b) })
    row.append(img, meta, rm)
    // export-books-missing-locate: a record without its file (backup import) opens a file picker to locate it
    row.addEventListener('click', () => { const rec = b.file ? null : b; if (rec) locateBookFile(rec.id); else openBook(b.id) })
    body.appendChild(row)
  }
}

// remove-book (2026-10-07-09-30-22): remove one book from the Library after a Yes / No question (No is the default).
// Deletes the book file and, unless SWITCH_REMOVE_BOOK_KEEPS_POSITION_AND_BOOKMARKS, its position, bookmarks and notes.
// Nothing else is touched (other books, settings, the dictionary).
async function removeBook(b) {
  const keep = FLAGS.SWITCH_REMOVE_BOOK_KEEPS_POSITION_AND_BOOKMARKS === true
  const msg = `Remove "${b.title || 'this book'}" from the library?`
    + (keep ? ' Its reading position and bookmarks are kept.' : ' Its reading position, bookmarks and notes are removed too.')
  if (!(await askYesNo(msg))) return
  try {
    if (currentBookId === b.id) { // the open book: close it first, or its position would be saved again after the removal
      clearTimeout(saveTimer)
      if (view) { try { view.close() } catch {} view.remove(); view = null }
      currentBookId = null; currentBookTheme = null; bookmarks = []; bmFocus = null
      hidePopup()
      updateWakeLock()
    }
    await idbDelete('books', b.id)
    if (!keep) {
      await idbDelete('positions', b.id)
      for (const m of await idbGetAllByIndex('bookmarks', 'bookId', b.id)) await idbDelete('bookmarks', m.id)
    }
  } catch (err) { alert('Could not remove the book: ' + (err?.message || err)) }
  await refreshLibrary()
}

// export-books-missing-locate (2026-10-10-17-07-57): a Library record without its file (Export without
// books, then backup import). Tapping it opens a file picker; the picked file is checked with fingerprint():
// same id = attach silently and open; different id = one Yes/No/Cancel question
// ("Different book data. Import as same book? (No will import it as new)"), skipped when
// SWITCH_CONFIRM_REPLACE_BOOK_WRONG_CRC is not true (mismatch = new book, no question).
async function locateBookFile(id) {
  const rec = await idbGet('books', id)
  if (!rec) return
  if (rec.file) { openBook(id); return }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.epub'
  input.style.display = 'none'
  document.body.appendChild(input)
  const picked = await new Promise(resolve => {
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true })
    input.click()
  })
  input.remove()
  if (!picked) return
  let fp = null
  try { fp = await fingerprint(picked) } catch { alert('That file could not be read.'); return }
  if (fp === id) {
    rec.file = picked
    await idbPut('books', rec)
    await refreshLibrary() // locate-no-auto-open (2026-10-10-17-13-37): stay in the Library for the next book
    return
  }
  if (FLAGS.SWITCH_CONFIRM_REPLACE_BOOK_WRONG_CRC === true) {
    const ans = await askYesNoCancel('Different book data. Import as same book? (No will import it as new)')
    if (ans === 'cancel') return
    if (ans === 'yes') {
      rec.file = picked
      await idbPut('books', rec)
      await refreshLibrary() // locate-no-auto-open: no instant open, as above
      return
    }
  }
  importFiles([picked])
}

async function importFiles(fileList) {
  let added = 0, skipped = 0, failed = 0
  let lastError = ''
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  debugBeacon('import-start', { n: Array.from(fileList).length })
  for (const file of Array.from(fileList)) {
    // Be lenient: mobile pickers (cloud providers, SAF) sometimes give odd
    // names/MIME types even though the OS-level ".epub" filter was used.
    const looksLikeEpub = /\.epub$/i.test(file.name)
      || file.type === 'application/epub+zip'
      || file.type === 'application/zip'
      || file.type === ''
    if (!looksLikeEpub) { debugBeacon('import-skip-type', { fname: file.name.slice(0, 50), ftype: file.type }); skipped++; continue }
    try {
      const id = await fingerprint(file)
      debugBeacon('import-fingerprint', { ms: ms(), fname: file.name.slice(0, 50), fsize: file.size })
      const existing = await idbGet('books', id)
      // export-books-missing-locate: a record without its file (backup import) is completed by the real file
      if (existing) {
        if (!existing.file && file) {
          existing.file = file
          await idbPut('books', existing)
          debugBeacon('import-stored', { ms: ms() })
          added++
        } else { debugBeacon('import-exists', { ms: ms() }); skipped++ }
        continue
      }
      const title = file.name.replace(/\.epub$/i, '') || 'Untitled'
      await idbPut('books', { id, file, title, openedAt: null, coverDataUrl: null })
      debugBeacon('import-stored', { ms: ms() })
      added++
    } catch (err) {
      console.error('Import failed for', file.name, err)
      lastError = err?.message || String(err)
      debugBeacon('import-error', { ms: ms(), fname: file.name.slice(0, 50), ename: err?.name, emsg: lastError.slice(0, 160) })
      failed++
    }
  }
  await refreshLibrary()
  debugBeacon('import-done', { ms: ms(), added, skipped, failed })
  if (added === 0 && (skipped > 0 || failed > 0)) {
    const detail = failed > 0 ? ` Last error: ${lastError}` : ''
    alert(`Couldn't import: ${failed} failed, ${skipped} skipped (already in your library, or not recognized as EPUB).${detail}`)
  }
}

/* ---------------- reading ---------------- */

function getCSS() {
  const bg = resolveColor('page')
  const fg = resolveColor('font')
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html, body {
      background: ${bg};
      color: ${fg};
      color-scheme: ${isDarkColor(bg) ? 'dark' : 'light'};
    }
    html {
      font-size: ${settings.fontSize}px !important; /* scale-absolute-font-sizes: on the root, so the book's own body ratio (Calibre: .calibre { font-size: 1.25em }) and its em / rem sizes multiply on top of it */
    }
    body {
      font-family: ${currentFontFamily()};
    }
    html.sm-hide-cursor, html.sm-hide-cursor * { cursor: none !important; }
    ::highlight(sm-saved-char) {
      background-color: ${hexToRgba(getMarkColor(), .35)};
      color: inherit;
    }
    ::highlight(sm-bookmark) {
      background-color: ${hexToRgba(getBookmarkColor(), .6)};
      color: inherit;
    }
    ::highlight(sm-bookmark-note) {
      text-decoration: underline dotted;
    }
    a:any-link { color: ${getLinkColor()}; }
    ${FLAGS.SWITCH_FORCE_FONT_ON_TEXT_BLOCKS !== false ? `p, li, blockquote, dd { font-family: ${currentFontFamily()} !important; }` : ''}
    p, li, blockquote, dd {
      line-height: ${settings.lineSpacing};
      text-align: justify;
      hyphens: auto;
    }
  `
}

// colors: page/font vars on #book-page, monitor on the root (--surround), and a
// flat page (no shadow) when monitor and page are the same color, so a white
// monitor + white page looks like one screen on a phone
function applyColorVars() {
  const page = $('#book-page')
  const bg = resolveColor('page'), fg = resolveColor('font'), mon = resolveColor('monitor')
  page.style.setProperty('--page-bg', bg)
  page.style.setProperty('--page-text', fg)
  page.style.setProperty('--page-shadow', settings.pageShadow === true && bg !== mon ? '0 0 24px rgba(0,0,0,.6)' : 'none')
  document.documentElement.style.setProperty('--surround', mon)
  applyLinkColorVar()
  let meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta) }
  meta.content = mon
}
function applyTheme() {
  applyColorVars()
  applyStyles()
}

function applyStyles() {
  // unfreeze-on-change (2026-09-27-19-02-57): same as applyGeometry — font/
  // theme/spacing edits while frozen must take effect now, not at exit
  if (fullscreenFrozen) unfreezeFullscreenSize()
  if (view && lastStableCfi) captureAnchor()
  view?.renderer?.setStyles?.(getCSS())
  // chrome-font-pct (2026-09-27-16-55-53): header/position sizes as a
  // percentage of the content size. Position set inline on #pct-display
  // itself (beats the old 12px pin, which only inherited to the footer box).
  const topPct = Number(FLAGS.SWITCH_TOP_MENU_FONT_SIZE_IN_PERCENTAGE ?? 90)
  const botPct = Number(FLAGS.SWITCH_BOTTOM_POSITION_FONT_SIZE_IN_PERCENTAGE ?? 90)
  $('#page-header').style.fontSize = Math.round(settings.fontSize * topPct / 100) + 'px'
  $('#page-footer').style.fontSize = Math.round(settings.fontSize * botPct / 100) + 'px'
  $('#pct-display').style.fontSize = Math.round(settings.fontSize * botPct / 100) + 'px'
  // 2026-09-27-17-37-26: optional italic position line
  $('#pct-display').style.fontStyle = FLAGS.SWITCH_BOTTOM_POSITION_ITALIC === true ? 'italic' : ''
  if (view && lastStableCfi) scheduleRestore()
}

async function openBook(id) {
  const row = await idbGet('books', id)
  if (!row) return
  currentBookId = id
  bookTotalChars = 0; bookCharPrefixes = [] // bookmarks: no stale counts from the previous book
  bookmarks = []
  bookmarksLoading = loadBookmarks(id)
  furthestFraction = 0
  furthestCharIndex = null
  searchTextCache = []
  lastSearchLandedChar = null
  lastSearchQueryForStep = ''
  clearSearchMark()
  clearFirstRowFlash()
  clearSavedCharMark()
  // open-stay-until-ready (2026-10-10-18-35-45): no showReader() here; the current view (Library, ...)
  // stays on screen while the book opens underneath its opaque overlay, and showReader() runs in the
  // finally below once the saved position has landed.
  hideCover()

  if (view) { view.close(); view.remove() }
  view = document.createElement('foliate-view')
  $('#viewer-host').appendChild(view)
  updateWakeLock() // reader-polish-2
  view.addEventListener('relocate', onRelocate)
  noteDocCache.clear()
  bmFocus = null
  hidePopup()
  view.addEventListener('link', onBookLink) // footnote popup (cancels the jump for note markers)
  view.addEventListener('load', e => {
    if (FLAGS.SWITCH_SCALE_ABSOLUTE_FONT_SIZES !== false) { // before wireContentDoc and before the first layout of this section
      const c = scaleAbsoluteSizes(e.detail.doc)
      if (c.rules || c.inline) debugBeacon('abs-font-sizes', { rules: c.rules, inline: c.inline })
    }
    wireContentDoc(e.detail.doc)
    const idx = e.detail.index ?? liveContents().find(c => c.doc === e.detail.doc)?.index
    if (idx != null) applyBookmarkHighlights(e.detail.doc, idx)
  })
  // open-hide-until-restore (2026-10-10-18-31-44): hide the page while opening at text start and jumping
  // to the saved position, so the first page never flashes. visibility (not display) keeps the geometry
  // the paginator measures. Revealed in the finally below; a failed open reveals before rethrowing.
  $('#viewer-host').style.visibility = 'hidden'
  try { await view.open(row.file) } catch (err) { $('#viewer-host').style.visibility = ''; throw err }

  view.renderer.setAttribute('flow', 'paginated')
  view.renderer.setAttribute('max-column-count', '1')
  view.renderer.setAttribute('gap', '0%')
  view.renderer.setAttribute('margin', '0px')
  applyThemeForBook(row) // theme-combo: the book's own theme, else the default theme
  applyStyles()
  applyTheme()

  const pos = await idbGet('positions', id)
  furthestFraction = pos?.furthestFraction || 0
  furthestCharIndex = pos?.furthestCharIndex ?? null
  const useCfiOpen = FLAGS.SWITCH_SAVE_LOCATION_AS_CFI === true
  // int-only with a stored integer: swallow init's own relocates so the
  // text-start position is never saved as stable (its 400ms saveTimer would
  // otherwise clobber the stored row after the restore below runs).
  const intOnlyOpen = !useCfiOpen && pos?.charIndex != null
  if (intOnlyOpen) { isResizing = true; clearTimeout(saveTimer) }
  // open-finally (2026-09-27-11-14-07, Terra review): the reset below is in a
  // finally so a rejecting init (or anything else in this span) can't strand
  // isResizing=true and silently stop all future position saving. True hangs
  // (never-settling awaits) need timeouts and stay out of scope.
  try {
  if (useCfiOpen && pos?.cfi) {
    await view.init({ lastLocation: pos.cfi })
  } else {
    await view.init({ showTextStart: true })
  }
  // compute char prefixes for precise top-left char restore (char-index only, no snippet search)
  try { await computeBookCharPrefixes() } catch {}
  try { await bookmarksLoading } catch {}
  refreshBookmarkHighlights()
  updateBmBar()
  updateBookmarkMarkers()
  lastStableCfi = view.lastLocation?.cfi || pos?.cfi || null
  lastStableFraction = view.lastLocation?.fraction ?? null
  if (lastStableFraction == null && pos?.fraction != null) lastStableFraction = pos.fraction
  try { lastStableSnippet = String(view.lastLocation?.range).slice(0, 30) } catch { lastStableSnippet = null }
  try { lastStableCharIndex = getCurrentCharIndex() } catch { lastStableCharIndex = null }
  // int-only: the stored integer wins over the live text-start read
  // unconditionally (live is text start here, not a real position).
  if (!useCfiOpen && pos?.charIndex != null && bookTotalChars) lastStableCharIndex = Math.min(Math.max(0, pos.charIndex | 0), Math.max(0, bookTotalChars - 1))
  else if (lastStableCharIndex == null && pos?.fraction != null && bookTotalChars) lastStableCharIndex = Math.round(pos.fraction * bookTotalChars)
  if (furthestCharIndex == null && pos?.fraction != null && bookTotalChars) furthestCharIndex = Math.round(Math.min(1, Math.max(0, pos.fraction)) * bookTotalChars)
  if (furthestCharIndex == null && lastStableCharIndex != null) furthestCharIndex = lastStableCharIndex
  // int-only open (flag false): jump to the stored integer after prefixes exist.
  // isResizing guards the goTo's own relocate so it isn't saved as drift;
  // the char anchor stays the stored value (never re-derived here, the live
  // read may still reflect the pre-jump position).
  if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && pos?.charIndex != null && bookTotalChars) {
    try {
      isResizing = true
      const target = await getRangeForCharIndex(lastStableCharIndex)
      if (target) await view.renderer.goTo(target).catch(() => {})
      lastStableCfi = view.lastLocation?.cfi || lastStableCfi
      lastStableFraction = view.lastLocation?.fraction ?? lastStableFraction
      try { lastStableSnippet = String(view.lastLocation?.range).slice(0, 30) } catch {}
    } catch {}
  }
  } finally { isResizing = false; showReader(); $('#viewer-host').style.visibility = '' }
  // ensure percentage display reflects the restored location (was frozen during resize)
  if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && lastStableCharIndex != null && bookTotalChars) $('#pct-display').textContent = formatPct(lastStableCharIndex / bookTotalChars)
  else if (lastStableFraction != null) $('#pct-display').textContent = formatPct(lastStableFraction)
  // initial doc was already loaded before listener existed in old version – wire it explicitly
  try {
    for (const { doc } of view.renderer.getContents()) if (doc) wireContentDoc(doc)
  } catch {}

  const title = row.title
  $('#page-header .title').textContent = title
  document.title = title

  row.openedAt = Date.now()
  if (!row.coverDataUrl) {
    try {
      const blob = await view.book.getCover?.()
      if (blob) row.coverDataUrl = await blobToDataUrl(blob)
    } catch {}
  }
  await idbPut('books', row)

  buildGotoMenu()
  rememberWindowedSizesIfAtRest()
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

function onRelocate(e) {
  { const r0 = e.detail?.reason
    if (headerForcedByTouch && (r0 === 'page' || r0 === 'snap' || r0 === 'navigation')) hideTouchChrome()
    if (r0 === 'page' || r0 === 'snap' || r0 === 'navigation') {
      hidePopup()
      if (bmFocus) { bmFocus = null; updateBmBar() }
    }
    updateBookmarkMarkers(e.detail?.range) }
  const { fraction, cfi, reason } = e.detail
  // spacer-read-fix (2026-09-28-11-27-11): a relocate read while sitting on a
  // blank spacer page (container page 0 / last) is not a real position (it
  // resolved to the section prefix, e.g. 0.815 after 7.85). Ignore it; the
  // paginator's follow-up section jump / real page fires the real relocate.
  const onSpacer = isOnSpacerPage()
  if (debugOn()) {
    let ci = ''
    try { ci = getCurrentCharIndex() ?? '' } catch {}
    debugBeacon('relocate', { reason, frac: fraction, cfi, charIdx: ci, spacer: onSpacer, resizing: isResizing, ...debugGeom() })
  }
  if (onSpacer) return
  // blank-page-read (2026-09-28-20-12-00): a page with no readable node reads as
  // a collapsed range at body start (= the section start); not a position.
  // blank-page-save (2026-09-29-09-39-04): instead of ignoring it, save the
  // last char of the text before it (see getCharBeforeBlankPage()).
  if (isNoNodeRange(e.detail.range)) { saveBlankPageAsPreviousText(e); return }
  // restore-nav-guard: the running restore's own landing is not a user move.
  const restoreNavActive = restoreNavGen !== 0 && restoreNavGen === restoreGeneration
  // saved-char-mark: the mark lasts until the next page turn or real jump
  // save-swipes (2026-09-29-14-26-56): a swipe/drag ends as reason 'snap'
  if (reason === 'page' || ((reason === 'navigation' || reason === 'snap') && !isResizing && !restoreNavActive)) clearSavedCharMark()
  // freeze percentage display while resizing to avoid showing intermediate drift (2.09→2.05→1.9)
  // pct-unified (2026-09-27-11-02-29): in int mode every footer source uses
  // the char anchor, so page-turns and restores can't disagree on one page.
  if (!isResizing && !restoreNavActive) {
    // live char first (lastStable* below still holds the previous page here)
    let showChar = null
    try { showChar = getCurrentCharIndex() } catch { showChar = null }
    if (showChar == null) showChar = lastStableCharIndex
    if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && bookTotalChars && showChar != null) $('#pct-display').textContent = formatPct(showChar / bookTotalChars)
    else $('#pct-display').textContent = formatPct(fraction)
  }
  if (fraction > furthestFraction) furthestFraction = fraction
  // while a resize is in progress, relocate events reflect the paginator's
  // own drift as it re-flows content at the new size — not a real reading
  // position — so don't treat them as "stable", and don't save them.
  if (isResizing || restoreNavActive) return
  // only an intentional position change is savable: an actual page turn
  // ('page', from #scrollPrev/#scrollNext) or a real jump ('navigation':
  // TOC, "Go to position", "Most recent page", "Furthest read", or the
  // restore mechanism's own goTo/goToFraction calls — those are only
  // reached while isResizing is still true, so they're already excluded
  // above). save-swipes (2026-09-29-14-26-56): 'snap' (end of a touch swipe or
  // drag, the only source of that reason since tap-vs-snap and tap-jitter) is
  // an intentional move too; before, swipes on the phone were never saved and
  // the next restore jumped back to the old page. Every other reason
  // (anchor/scroll/selection) is the paginator's own re-pinning drift.
  if (reason !== 'page' && reason !== 'navigation' && reason !== 'snap') return
  lastStableCfi = cfi
  lastStableFraction = fraction
  try { lastStableSnippet = String(e.detail.range).slice(0, 30) } catch { lastStableSnippet = null }
  try { lastStableCharIndex = getCurrentCharIndex() } catch { lastStableCharIndex = null }
  if (lastStableCharIndex != null && (furthestCharIndex == null || lastStableCharIndex > furthestCharIndex)) furthestCharIndex = lastStableCharIndex
  clearTimeout(saveTimer)
  saveTimer = setTimeout(savePositionNow, 400)
}

/* ---------------- page-turn click zones (inside rendered content) ---------------- */

/* mouse-dblclick-select (2026-10-03-09-48-04): delayed page turn for mouse clicks, see the switch in FLAGS */
let pendingTurn = null // { fn, timer }
function cancelPendingTurn() { if (pendingTurn) { clearTimeout(pendingTurn.timer); pendingTurn = null } }
function flushPendingTurn() { const p = pendingTurn; if (p) { clearTimeout(p.timer); pendingTurn = null; p.fn() } }
function mouseTurn(fn) {
  const ms = Number(FLAGS.SWITCH_MOUSE_PAGE_TURN_DELAY_MS_FOR_DOUBLE_CLICK_SELECT) || 0
  flushPendingTurn() // an earlier single click that was not part of a double click turns now
  if (ms <= 0) { fn(); return }
  const p = { fn, timer: setTimeout(() => { if (pendingTurn === p) { pendingTurn = null; fn() } }, ms) }
  pendingTurn = p
}
/* scale-absolute-font-sizes (2026-10-09-00-28-11): absolute font sizes / line heights of a section's style sheets and inline styles
   -> rem (16px = 12pt = 1rem), so they follow the size set on <html>. Returns { rules, inline } (the number of declarations changed).
   Keywords, %, em, rem and unitless values are relative already and stay. A style sheet that cannot be read is skipped. */
const ABS_PX = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }
function absToRem(value) {
  const m = /^\s*(\d*\.?\d+)\s*(px|pt|pc|in|cm|mm)\s*$/i.exec(value || '')
  if (!m) return null
  return +(parseFloat(m[1]) * ABS_PX[m[2].toLowerCase()] / 16).toFixed(4) + 'rem'
}
function scaleAbsoluteSizes(doc) {
  const count = { rules: 0, inline: 0 }
  const fix = (style, key) => {
    for (const prop of ['font-size', 'line-height']) {
      const rem = absToRem(style.getPropertyValue(prop))
      if (!rem) continue
      style.setProperty(prop, rem, style.getPropertyPriority(prop))
      count[key]++
    }
  }
  const walk = rules => { for (const rule of rules) { if (rule.style) fix(rule.style, 'rules'); if (rule.cssRules) walk(rule.cssRules) } }
  try {
    for (const sheet of doc.styleSheets) { try { walk(sheet.cssRules) } catch {} }
    for (const el of doc.querySelectorAll('[style]')) fix(el.style, 'inline')
  } catch {}
  return count
}

/* word selection helpers (reader-polish-2, 2026-10-04-21-43-23): a hyphen or apostrophe between two letters joins a word
   ("rabbit-hole", "mother-in-law", "don't"), so a double click / long-press selects it whole, and so does the PC
   hold-to-select. Works inside one text node (a hyphenated word split by markup keeps the browser's own selection). */
const WORD_CH = /[\p{L}\p{M}\p{N}_]/u
const isWordCh = c => !!c && WORD_CH.test(c)
const isJoinCh = c => !!c && (c === '-' || c === '\u2010' || c === '\u2011' || c === "'" || c === '\u2019')
// grow [s, e) of text t over letters and joining hyphens / apostrophes; returns [s, e]
function growWord(t, s, e) {
  for (;;) {
    let grew = false
    while (s > 0 && isWordCh(t[s - 1])) { s--; grew = true }
    while (e < t.length && isWordCh(t[e])) { e++; grew = true }
    if (s >= 2 && isJoinCh(t[s - 1]) && isWordCh(t[s - 2]) && isWordCh(t[s])) { s--; grew = true }
    if (e <= t.length - 2 && isJoinCh(t[e]) && isWordCh(t[e + 1]) && isWordCh(t[e - 1])) { e++; grew = true }
    if (!grew) return [s, e]
  }
}
// widen a one-word selection over joins; true when it changed. A selection of several words is left alone.
function expandSelectionWord(doc) {
  try {
    const sel = doc.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false
    const r = sel.getRangeAt(0)
    const n = r.startContainer
    if (n !== r.endContainer || n.nodeType !== 3) return false
    const t = n.nodeValue
    const s = r.startOffset
    let e = r.endOffset
    while (e > s && /\s/.test(t[e - 1])) e-- // Windows selects a word together with its trailing space
    if (e <= s || /\s/.test(t.slice(s, e))) return false
    const [s2, e2] = growWord(t, s, e)
    if (s2 === s && e2 === e) return false
    const nr = doc.createRange()
    nr.setStart(n, s2); nr.setEnd(n, e2)
    sel.removeAllRanges(); sel.addRange(nr)
    return true
  } catch { return false }
}
// PC press-and-hold: select the word under the pointer (x, y in the content document), only when the pointer is really
// over a letter; true when it selected one
function holdSelectWord(doc, x, y) {
  try {
    const sel = doc.getSelection()
    if (!sel || !sel.isCollapsed || barEdit || readerOverlayShown()) return false
    let node = null, off = 0
    if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset } }
    else if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset } }
    if (!node || node.nodeType !== 3) return false
    const t = node.nodeValue
    for (const idx of [off, off - 1]) { // the caret sits between two chars: the pointer is over one of them
      if (idx < 0 || idx >= t.length || !isWordCh(t[idx])) continue
      const cr = doc.createRange()
      cr.setStart(node, idx); cr.setEnd(node, idx + 1)
      const over = [...cr.getClientRects()].some(q => x >= q.left - 1 && x <= q.right + 1 && y >= q.top - 1 && y <= q.bottom + 1)
      if (!over) continue
      const [s, e] = growWord(t, idx, idx + 1)
      const nr = doc.createRange()
      nr.setStart(node, s); nr.setEnd(node, e)
      sel.removeAllRanges(); sel.addRange(nr)
      return true
    }
  } catch {}
  return false
}
function wireContentDoc(doc) {
  if (!doc || doc.__smReaderWired) return
  doc.__smReaderWired = true
  let downX = 0, downY = 0
  // 2026-09-27-17-56-08 (deselect-first): the browser natively collapses the
  // selection on tap-down, so tap-up sees an empty selection and would turn
  // the page. Remember tap-down state instead — a pre-existing selection
  // consumes the whole tap (remnant cleared), never a page turn.
  let downHadSelection = false
  let selSnap = null
  let mouseDetail = 1 // click count of the current mouse press (2 = double click, 3 = triple click)
  let hadSel = false // reader-polish-2: was there a selection before this selectionchange (touch: a new one is a long-press word)

  doc.addEventListener('pointerdown', e => {
    mouseDetail = 1
    lastPointerType = e.pointerType
    downX = e.clientX; downY = e.clientY
    try { downHadSelection = !!(doc.getSelection && String(doc.getSelection()).length) } catch { downHadSelection = false }
    // bookmarks: remember the selection (the browser collapses it on tap-down) so a
    // tap on the hidden top label can open the dropdown and keep it
    selSnap = null
    try { if (downHadSelection) selSnap = doc.getSelection().getRangeAt(0).cloneRange() } catch {}
    posSelDown = !!posSelText() // position-select-bar: a selected position consumes this tap
    selDbg('down', doc, { had: downHadSelection })
  })
  doc.addEventListener('pointercancel', () => { selDbg('cancel', doc, { had: downHadSelection }); downHadSelection = false; hideTouchChrome() })
  doc.addEventListener('contextmenu', () => selDbg('contextmenu', doc))
  // tap-header / hide-cursor (2026-09-29-22-00-06)
  doc.addEventListener('pointermove', e => { lastPointerType = e.pointerType }, { passive: true })
  doc.addEventListener('mousemove', cursorActivity, { passive: true })
  doc.addEventListener('mousedown', cursorActivity, { passive: true })
  doc.addEventListener('mousedown', e => { mouseDetail = e.detail || 1; if (mouseDetail >= 2) cancelPendingTurn() }, { passive: true })
  // reader-polish-2: a double click selects a hyphenated word whole ("rabbit-hole")
  doc.addEventListener('dblclick', () => { expandSelectionWord(doc) })
  // hold-mouse-button-select (2026-10-05-06-01-01): PC press-and-hold. The left button held still (3 px jitter) on a word for
  // SWITCH_HOLD_MOUSE_BUTTON_TO_SELECT_WORD_MS selects it, like the touch long-press. Moving further (a drag-select), a
  // double click, a link, touch, the wheel or a key cancel it. holdDone: this press selected a word, so its release keeps
  // the selection and never turns the page (see pointerup).
  let holdTimer = null, holdX = 0, holdY = 0, holdDone = false
  const holdCancel = () => { clearTimeout(holdTimer); holdTimer = null }
  doc.addEventListener('mousedown', e => {
    holdCancel(); holdDone = false
    const ms = Number(FLAGS.SWITCH_HOLD_MOUSE_BUTTON_TO_SELECT_WORD_MS) || 0
    if (ms <= 0 || e.button !== 0 || (e.detail || 1) >= 2 || isTouchPointer() || e.target?.closest?.('a')) return
    holdX = e.clientX; holdY = e.clientY
    holdTimer = setTimeout(() => { holdTimer = null; holdDone = holdSelectWord(doc, holdX, holdY) }, ms)
  }, { passive: true })
  doc.addEventListener('mousemove', e => { if (holdTimer && (Math.abs(e.clientX - holdX) > 3 || Math.abs(e.clientY - holdY) > 3)) holdCancel() }, { passive: true })
  doc.addEventListener('mouseup', holdCancel, { passive: true })
  doc.addEventListener('wheel', holdCancel, { passive: true })
  doc.addEventListener('keydown', holdCancel)
  doc.documentElement.addEventListener('mouseleave', holdCancel, { passive: true })
  // mouse-wheel-click (2026-10-09-13-26-12): a click with the mouse wheel (middle button) on book text, PC. Setting Mouse wheel click:
  // dictionary = select the word and show its definition, select = select the word, menu = show / hide the menu, none = the
  // browser's own behavior (autoscroll on some systems). The word under the pointer is found as for the press-and-hold above.
  doc.addEventListener('mousedown', e => { if (e.button === 1 && getWheelClick() !== 'none') e.preventDefault() }) // no autoscroll
  doc.addEventListener('auxclick', e => {
    if (e.button !== 1) return
    const mode = getWheelClick()
    if (mode === 'none') return
    e.preventDefault()
    if (mode === 'menu') { openGotoMenuAtHeader(false); return }
    if (e.target?.closest?.('a')) return
    const sel = doc.getSelection()
    sel?.removeAllRanges()
    if (!holdSelectWord(doc, e.clientX, e.clientY)) return
    if (mode === 'dictionary') showMeaning(String(sel), toOuterRect(doc, sel.getRangeAt(0).getBoundingClientRect()), false)
  })
  // hover popups (PC): bookmark notes and footnotes
  doc.addEventListener('mousemove', e => hoverBookmarkNote(doc, e), { passive: true })
  doc.addEventListener('mouseover', e => hoverFootnote(doc, e), { passive: true })
  doc.addEventListener('mouseout', leaveFootnote, { passive: true })
  if (cursorHidden) doc.documentElement.classList.add('sm-hide-cursor')
  // a new text selection removes the blue saved-char mark
  doc.addEventListener('selectionchange', () => {
    try { if (savedCharMark && String(doc.getSelection?.() ?? '').length) clearSavedCharMark() } catch {}
    try { if (bmFocus && String(doc.getSelection?.() ?? '').length) bmFocus = null } catch {}
    try { if (String(doc.getSelection?.() ?? '').length) clearPosSelection() } catch {} // position-select-bar
    // reader-polish-2: a new word selection by touch (long-press, double tap) is widened over hyphen joins; a selection
    // that already existed (dragging the handles) is never touched
    try {
      const has = !!String(doc.getSelection?.() ?? '').length
      if (has && !hadSel && isTouchPointer()) expandSelectionWord(doc)
      hadSel = has
    } catch {}
    selDbg('change', doc)
    updateBmBar()
  })

  doc.addEventListener('pointerup', e => {
    // wheel-click-no-turn (2026-10-10-15-20-47): the release of the mouse wheel button (middle) is never a page tap; its action is in the auxclick handler above
    if (e.pointerType === 'mouse' && e.button === 1) { downHadSelection = false; selSnap = null; return }
    // hold-mouse-button-select: this press selected a word: keep it (also when a selection existed at press time), no turn
    if (holdDone) { holdDone = false; downHadSelection = false; selSnap = null; return }
    selDbg('up', doc, { had: downHadSelection, dx: Math.round(Math.abs(e.clientX - downX)), dy: Math.round(Math.abs(e.clientY - downY)) })
    // position-select-bar: a selected position is only deselected by a tap elsewhere, never a page turn
    if (consumePosSel() && Math.abs(e.clientX - downX) <= 6 && Math.abs(e.clientY - downY) <= 6) { downHadSelection = false; selSnap = null; return }
    // mouse-dblclick-select: the 2nd / 3rd click of a double / triple click selects a word / paragraph natively; keep it
    // (no clearing, no page turn). The pending turn of the 1st click was cancelled by the mousedown.
    if (e.pointerType === 'mouse' && mouseDetail >= 2) { downHadSelection = false; selSnap = null; selDbg('up-multi', doc, { n: mouseDetail }); return }
    if (downHadSelection) {
      downHadSelection = false
      const snap = selSnap
      selSnap = null
      // bookmarks: a touch tap in the top/bottom band with text selected shows the labels and
      // opens the dropdown WITHOUT dropping the selection (put it back, the browser
      // collapses it natively); any other tap clears it and closes open labels/dropdown
      const small = Math.abs(e.clientX - downX) <= 6 && Math.abs(e.clientY - downY) <= 6
      const fe = doc.defaultView.frameElement
      if (snap && small && fe && isTouchPointer()) {
        const idx = liveContents().find(c => c.doc === doc)?.index ?? 0
        menuSnap = { doc, index: idx, range: snap }
        const put = () => { try { const s = doc.getSelection(); s.removeAllRanges(); s.addRange(snap) } catch {} }
        put()
        if (tryRevealChromeByTap(fe.getBoundingClientRect().top + e.clientY)) {
          setTimeout(put, 0); setTimeout(put, 80); setTimeout(put, 250)
          return
        }
        menuSnap = null
      }
      selDbg('clear', doc, { where: 'up-had' })
      try { doc.getSelection?.()?.removeAllRanges?.() } catch {}
      dismissChrome()
      return
    }
    const dx = Math.abs(e.clientX - downX), dy = Math.abs(e.clientY - downY)
    if (dx > 6 || dy > 6) { hideTouchChrome(); return } // was a drag (selection or swipe), not a tap
    // unified-chrome (2026-09-27-16-35-36): selected text is cleared first
    // and the tap consumed — never a page turn on top of a selection
    const sel = doc.getSelection?.()
    // keep-new-selection (2026-10-02-10-34-41): a selection that exists now but did not at tap-down was made by this
    // very press (long-press, double-click): keep it, still no page turn. Old selections are cleared in the branch above.
    if (sel && String(sel).length) return
    if (e.target.closest && e.target.closest('a')) return // let links work
    // yellow text (2026-10-02-08-32-16): a tap/click on bookmarked text shows the small bar
    // for that bookmark (note preview, Note, Remove) and does not turn the page
    if (isBmBarOn()) {
      const hit = bookmarkAtPoint(doc, e.clientX, e.clientY, false)
      if (hit) { hidePopup(); bmFocus = { b: hit.b, anchor: toOuterRect(doc, hit.rc) }; updateBmBar(); return }
    }
    // consume-mark (2026-09-29-22-00-06): a tap with the blue mark showing only
    // removes the mark (like a selection); the next tap navigates
    if (savedCharMark) { clearSavedCharMark(); return }
    if (consumeSearchMarkClick()) return
    if (dismissChrome()) return // first tap just closes the open menu/dropdown / tap-revealed header
    // tap-coords-fix (2026-09-27-18-51-02): the book iframe is laid out at
    // full-book width, so iframe coords are book coords, not page coords.
    // Decide in visible coords: subtract the paginator's scroll offset and
    // compare against its visible size (both public). Fallback keeps the
    // old behavior when the renderer isn't ready.
    // tap-outer-coords (2026-09-28-09-29-09): the iframe sits one spacer page
    // inside the paginator container, so the old clientX - start always fell
    // in [-size, 0) (every tap = previous). Use outer coords like the
    // #viewer-host margin handler; old formula stays as the fallback.
    const frameEl = doc.defaultView.frameElement
    const hostEl = $('#viewer-host')
    if (frameEl && hostEl) {
      // tap-header: a touch tap in the top 20% of the page shows the hidden header
      if (tryRevealChromeByTap(frameEl.getBoundingClientRect().top + e.clientY)) return
      const hr = hostEl.getBoundingClientRect()
      const tx = frameEl.getBoundingClientRect().left + e.clientX - hr.left, tw = hr.width, rawX = Math.round(e.clientX)
      const go = () => turnAt(tx, tw, 'iframe-tap rawX=' + rawX)
      if (e.pointerType === 'mouse') mouseTurn(go); else go()
      return
    }
    const renderer = view?.renderer
    const w = renderer?.size ?? doc.defaultView.innerWidth
    const vx = e.clientX - (renderer?.start ?? 0)
    const go2 = () => turnAt(vx, w, 'iframe-tap-fallback')
    if (e.pointerType === 'mouse') mouseTurn(go2); else go2()
  })

  let wheelLock = false
  doc.addEventListener('wheel', e => {
    if (wheelLock) return
    wheelLock = true
    setTimeout(() => { wheelLock = false }, 350)
    if (e.deltaY > 0) view?.goRight?.() ?? view?.renderer?.next()
    else if (e.deltaY < 0) view?.goLeft?.() ?? view?.renderer?.prev()
  }, { passive: true })

  // the book content renders in its own <iframe> document, so key
  // presses while it has focus never reach our outer document listener
  doc.addEventListener('keydown', handleKey)
}

function turnAt(clientX, width, src = '') {
  if (debugOn()) debugBeacon('turn', { src, x: Math.round(clientX), width: Math.round(width), dir: clientX < width / 2 ? 'prev' : 'next', ...debugGeom() })
  if (clientX < width / 2) view?.goLeft?.() ?? view?.renderer?.prev()
  else view?.goRight?.() ?? view?.renderer?.next()
}

function handleKey(e) {
  // bookmarks: while the note box is open keys belong to it (Esc cancels, Ctrl+Enter saves)
  if (barEdit) { // note being edited inside the small bar (unified-note-bar)
    if (e.key === 'Escape') { e.preventDefault(); closeBarEdit(null) }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeBarEdit($('#bm-edit').value.trim()) }
    return
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
  // search-book-panel (2026-09-27-12-08-27): Ctrl/Cmd shortcuts first, so
  // Ctrl+F never reaches the plain-f fullscreen branch below. preventDefault
  // asks the browser not to open its own find UI (browsers may still win).
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); if (view) promptGoto(); return }
  if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); if (view) { showReaderView(); showSearchPanel() } return }
  if (!typing && (e.key === 'f' || e.key === 'F')) { toggleFullscreen(); return }
  if (e.key === 'Escape' && !$('#search-panel')?.classList.contains('hidden')) { hideSearchPanel(); return }
  // esc-clears (2026-09-29-22-00-06): Esc removes the selection, the blue
  // saved-char mark and a tap-revealed header first; only then leaves fullscreen
  if (e.key === 'Escape') {
    const hadSel = clearBookSelection()
    const hadPosSel = clearPosSelection() // position-select-bar
    const hadOuterSel = clearOuterSelection() // popup-polish
    const hadMark = !!savedCharMark
    clearSavedCharMark()
    const hadHdr = hideTouchChrome()
    const hadPop = hidePopup()
    const hadFoc = !!bmFocus
    if (hadFoc) { bmFocus = null; updateBmBar() }
    if (hadSel || hadPosSel || hadOuterSel || hadMark || hadHdr || hadPop || hadFoc) return
  }
  if (e.key === 'Escape' && document.fullscreenElement) { document.exitFullscreen(); return }
  // unified-chrome (2026-09-27-16-35-36): F9 toggles the book menu, F10 the
  // position line. Work with no book open; never while typing.
  if (!typing && e.key === 'F9') { e.preventDefault(); toggleBookMenu(); return }
  if (!typing && e.key === 'F10') { e.preventDefault(); togglePosition(); return }
  if (!view || typing) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); view.goLeft?.() ?? view.renderer?.prev() }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); view.goRight?.() ?? view.renderer?.next() }
}

/* ---------------- go to menu ---------------- */

// menu-icons (2026-10-03-08-47-15): inline SVG icons for the top menu (SWITCH_SHOW_MENU_ICONS)
const MENU_ICONS = {
  book: '<path d="M3 5.5C5.5 4 8.5 4 12 6c3.5-2 6.5-2 9-.5V19c-2.5-1.5-5.5-1.5-9 .5-3.5-2-6.5-2-9-.5z"/><path d="M12 6v13.5"/>',
  gear: '<path d="M10.19 5.24L10.47 2.32L13.53 2.32L13.81 5.24A7.0 7.0 0 0 1 15.50 5.94L17.76 4.07L19.93 6.24L18.06 8.50A7.0 7.0 0 0 1 18.76 10.19L21.68 10.47L21.68 13.53L18.76 13.81A7.0 7.0 0 0 1 18.06 15.50L19.93 17.76L17.76 19.93L15.50 18.06A7.0 7.0 0 0 1 13.81 18.76L13.53 21.68L10.47 21.68L10.19 18.76A7.0 7.0 0 0 1 8.50 18.06L6.24 19.93L4.07 17.76L5.94 15.50A7.0 7.0 0 0 1 5.24 13.81L2.32 13.53L2.32 10.47L5.24 10.19A7.0 7.0 0 0 1 5.94 8.50L4.07 6.24L6.24 4.07L8.50 5.94A7.0 7.0 0 0 1 10.19 5.24Z"/><circle cx="12" cy="12" r="2.8"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l6 6"/>',
  steps: '<ellipse cx="7.5" cy="10" rx="2.6" ry="4"/><ellipse cx="7.5" cy="18" rx="1.9" ry="2"/><ellipse cx="16.5" cy="5.5" rx="2.6" ry="4"/><ellipse cx="16.5" cy="13.5" rx="1.9" ry="2"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  // top label: square with a line above it (same width, 2 px gap); bottom label: square with a half-width line below it
  toplabel: '<path d="M4.5 2.4h15"/><rect x="4.5" y="7.2" width="15" height="15"/>',
  botlabel: '<rect x="4.5" y="1.8" width="15" height="15"/><path d="M8.25 20.85h7.5"/>',
  // menu-icons-start-mountain-font (2026-10-10-20-26-19): sunrise = Book start, mountain + cloud = Furthest read, F = Font & Themes
  sunrise: '<path d="M3 15h18"/><path d="M8.5 15a3.5 3.5 0 0 1 7 0"/><path d="M12 7.5v-2M5.8 9.3l-1.4-1.4M18.2 9.3l1.4-1.4"/>',
  mountain: '<path d="M2.5 19.5L9.5 8l4 6.5 3-4L21.5 19.5z"/><path d="M14.5 8.5h3.2a1.9 1.9 0 0 0 .37-3.76 2.7 2.7 0 0 0-5.2 1.06A2 2 0 0 0 14.5 8.5z"/>',
  font: '<path d="M10 20V6M6 6h9M10 12h6"/>',
}
const menuIcon = k => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MENU_ICONS[k]}</svg>`
function buildGotoMenu() {
  const menu = $('#goto-menu')
  menu.innerHTML = ''
  menu.classList.remove('long'); menu.style.maxHeight = '' // only the chapters list scrolls (nav-menus)
  const iconsOn = FLAGS.SWITCH_SHOW_MENU_ICONS === true && gotoMenuMode === 'main'
  // keepOpen: the item only switches the menu content (Bookmarks submenu); icon: key of MENU_ICONS (blank slot if none)
  const addItem = (label, fn, disabled, keepOpen, icon) => {
    const b = document.createElement('button')
    if (iconsOn) {
      const mi = document.createElement('span'); mi.className = 'mi'
      if (icon && MENU_ICONS[icon]) mi.innerHTML = menuIcon(icon)
      const tx = document.createElement('span'); tx.textContent = label
      b.classList.add('with-icon'); b.append(mi, tx)
    } else b.textContent = label
    if (disabled) b.disabled = true
    b.addEventListener('click', e => {
      // keepOpen items rebuild the menu (their own button is removed): the click must not
      // reach the document "click outside closes the menu" check (2026-10-01-20-20-00)
      if (keepOpen) { e.stopPropagation(); if (!disabled) fn(); return }
      menu.classList.remove('show'); hideTouchChrome()
      if (!disabled) fn() // fn reads menuSnap synchronously before it is dropped below
      menuSnap = null
    })
    menu.appendChild(b)
    return b
  }
  const addSep = () => { const d = document.createElement('div'); d.className = 'separator'; menu.appendChild(d) }
  // submenu labels (menus-viewall-books-snippets-theme-row, 2026-10-10-15-32-39): cut chapter / book /
  // bookmark labels to SWITCH_SUBMENU_MAX_LABEL_CHARS so a 720p phone menu stays narrow; full text in title.
  const truncMenuLabel = s => {
    const n = Number(FLAGS.SWITCH_SUBMENU_MAX_LABEL_CHARS ?? 30)
    s = String(s ?? '').replace(/\s+/g, ' ').trim()
    if (!(n > 0) || s.length <= n) return s
    return s.slice(0, n).trimEnd() + '…'
  }

  // table of contents submenu (nav-menus, 2026-10-10-06-10-00): the chapters of the book's own contents list, sub-chapters indented;
  // the chapter you are in is bold; View all opens the Contents page (on top since 2026-10-10-15-32-39)
  if (gotoMenuMode === 'toc') {
    addItem('‹ Back', () => { gotoMenuMode = 'main'; buildGotoMenu() }, false, true)
    addItem('View all', () => showTOC())
    addSep()
    const toc = view?.book?.toc ?? []
    const curHref = view?.lastLocation?.tocItem?.href
    let curBtn = null
    const walk = (items, depth) => {
      for (const item of items) {
        const full = String(item.label ?? '').replace(/\s+/g, ' ').trim() || '(untitled)'
        const b = addItem(truncMenuLabel(full), async () => { await view.goTo(item.href); showReaderView() })
        b.title = full
        b.style.paddingLeft = (14 + depth * 16) + 'px'
        if (curHref && item.href === curHref) { b.classList.add('cur'); curBtn = b }
        if (item.subitems) walk(item.subitems, depth + 1)
      }
    }
    if (toc.length) walk(toc, 0)
    else addItem('No contents', () => {}, true, true)
    menu.classList.add('long')
    menu.style.maxHeight = Math.max(160, window.innerHeight - (parseFloat(menu.style.top) || 0) - 12) + 'px'
    if (curBtn) setTimeout(() => curBtn.scrollIntoView({ block: 'center' }), 0)
    return
  }

  // library submenu (menus-viewall-books-snippets-theme-row, 2026-10-10-15-32-39; missing marks: library-submenu-missing, 2026-10-10-18-14-24): View all on top, then the books
  if (gotoMenuMode === 'library') {
    addItem('‹ Back', () => { gotoMenuMode = 'main'; buildGotoMenu() }, false, true)
    addItem('View all', () => showLibrary())
    addSep()
    const loading = addItem('Loading…', () => {}, true, true)
    menu.classList.add('long')
    menu.style.maxHeight = Math.max(160, window.innerHeight - (parseFloat(menu.style.top) || 0) - 12) + 'px'
    idbGetAll('books').then(books => {
      if (gotoMenuMode !== 'library' || !menu.contains(loading)) return
      loading.remove()
      books.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
      if (!books.length) { addItem('(no books)', () => {}, true, true); return }
      for (const bk of books) {
        const missing = !bk.file // library-submenu-missing: file-less records locate instead of opening empty
        const full = (missing ? 'Missing — ' : '') + (String(bk.title || 'Untitled').replace(/\s+/g, ' ').trim() || 'Untitled')
        const btn = missing
          ? addItem(truncMenuLabel(full), () => locateBookFile(bk.id))
          : addItem(truncMenuLabel(full), async () => { try { await openBook(bk.id) } catch {} showReaderView() })
        btn.title = full
        if (missing) btn.classList.add('missing')
      }
    }).catch(() => { if (menu.contains(loading)) loading.textContent = '(could not load books)' })
    return
  }

  // bookmarks submenu (2026-10-01-09-10-23): acts on the selected text, else on this page
  if (gotoMenuMode === 'bookmarks') {
    const sp = getSelectionSpan(true)
    const pg = sp ? null : getPageSpan()
    const hasHere = sp ? bmOverlapText(sp).length > 0 : (pg ? bmPageHere(pg).length > 0 : false)
    addItem('‹ Back', () => { gotoMenuMode = 'main'; buildGotoMenu() }, false, true)
    addSep()
    const pageHas = pg ? bmPageHere(pg).length > 0 : false
    const selAddsNothing = !!sp && FLAGS.SWITCH_DISABLE_BOOKMARK_BUTTON_WHEN_SELECTION_ADDS_NOTHING === true
      && bmOverlapText(sp).length > 0 && !selectionAddsText(sp)
    addItem(sp ? 'Bookmark (selection)' : 'Bookmark (this page)', () => (sp ? bmAddSelection(false, true) : bmAddPage(false)),
      sp ? selAddsNothing : (!pg || (FLAGS.SWITCH_DISABLE_BOOKMARK_BUTTON_ON_EXISTING_BOOKMARK === true && pageHas)))
    addItem(sp ? 'Note (selection)…' : 'Note (this page)…', () => (sp ? bmAddSelection(true, true) : bmAddPage(true)), !sp && !pg)
    addItem('Remove', () => bmRemoveHere(true), !hasHere)
    addSep()
    addItem(`View all (${bookmarks.length})`, () => showBookmarks())
    for (const bm of bookmarks) {
      const full = String(bm.text || '').replace(/\s+/g, ' ').trim() || (bm.type === 'page' ? '(page)' : '(untitled)')
      const btn = addItem(truncMenuLabel(full), () => jumpToBookmark(bm))
      btn.title = full
    }
    addItem('Remove all', () => bmRemoveAll(), !bookmarks.length)
    if (bookmarks.length) {
      menu.classList.add('long')
      menu.style.maxHeight = Math.max(160, window.innerHeight - (parseFloat(menu.style.top) || 0) - 12) + 'px'
    }
    return
  }

  // font + themes submenu (font-themes-submenu, 2026-10-10-19-43-41): quick font size / font / theme
  // changes reusing the Settings setters (Settings screen itself unchanged)
  if (gotoMenuMode === 'fontthemes') {
    addItem('‹ Back', () => { gotoMenuMode = 'main'; buildGotoMenu() }, false, true)
    addItem(`Font size: ${settings.fontSize}`, () => {
      const v = parseFloat(prompt('Font size (px):', String(settings.fontSize)))
      if (v > 0) { settings.fontSize = v; saveSettings(); applyStyles() }
      buildGotoMenu()
    }, false, true)
    const fontLabel = settings.uploadedFontName || settings.customFontName
      || ({ jost: 'Jost', 'system-sans': 'Sans serif', 'system-serif': 'Serif' }[(BUNDLED_FONTS.find(f => f.id === settings.fontId) || BUNDLED_FONTS[0]).id])
    addItem(`Font: ${fontLabel}`, () => {}, true, true)
    for (const [id, label] of [['jost', 'Jost'], ['system-sans', 'Sans serif'], ['system-serif', 'Serif']]) {
      const cur = !settings.customFontName && !settings.uploadedFontName && settings.fontId === id
      addItem((cur ? '✓ ' : '') + label, () => {
        settings.fontId = id; settings.customFontName = ''; settings.uploadedFontName = ''
        saveSettings(); applyStyles(); buildGotoMenu()
      }, false, true)
    }
    // upload-row-submenu: the stored upload as a 4th row (reselects without re-uploading); absent when none stored
    if (uploadedFontLabel) {
      addItem((settings.uploadedFontName ? '✓ ' : '') + uploadedFontLabel, () => {
        settings.uploadedFontName = uploadedFontLabel; settings.customFontName = ''
        saveSettings(); applyStyles(); buildGotoMenu()
      }, false, true)
    }
    addSep()
    const curTheme = currentThemeName()
    for (const n of themeNames()) {
      addItem((n === curTheme ? '✓ ' : '') + n, () => {
        const t = findTheme(n)
        if (!t) return
        themeSel = n
        applyThemeColors(t)
        saveSettings(); applyTheme(); buildGotoMenu()
      }, false, true)
    }
    menu.classList.add('long')
    menu.style.maxHeight = Math.max(160, window.innerHeight - (parseFloat(menu.style.top) || 0) - 12) + 'px'
    return
  }

  addItem('Book start', async () => { await view.goToTextStart(); showReaderView() }, false, false, 'sunrise')
  addItem('Furthest read', async () => {
    if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && furthestCharIndex != null && bookTotalChars) {
      try {
        const target = await getRangeForCharIndex(Math.min(Math.max(0, furthestCharIndex | 0), Math.max(0, bookTotalChars - 1)))
        if (target) { await view.renderer.goTo(target).catch(() => {}); showReaderView(); return }
      } catch {}
    }
    await view.goToFraction(furthestFraction); showReaderView()
  }, false, false, 'mountain')
  addItem('Table of Contents ▸', () => { gotoMenuMode = 'toc'; buildGotoMenu() }, !view?.book?.toc?.length, true, 'menu')
  addSep()
  addItem('Go to position…', () => { promptGoto(); showReaderView() }, false, false, 'steps')
  addItem('Search book', () => { showReaderView(); showSearchPanel() }, false, false, 'search')
  addItem('Bookmarks ▸', () => { gotoMenuMode = 'bookmarks'; buildGotoMenu() }, false, true, 'star')
  addSep()
  addItem(`${isFullscreenNow() ? '✓ ' : ''}Full screen (F11)`, () => toggleFullscreen(), false, false, 'expand')
  addItem(`${settings.showBookMenu !== false ? '✓ ' : ''}Top label (F9)`, () => { toggleBookMenu(); }, false, false, 'toplabel')
  addItem(`${settings.showPosition !== false ? '✓ ' : ''}Bottom label (F10)`, () => { togglePosition(); }, false, false, 'botlabel')
  addSep()
  addItem('Library ▸', () => { gotoMenuMode = 'library'; buildGotoMenu() }, false, true, 'book')
  addItem('Font & Themes ▸', () => { gotoMenuMode = 'fontthemes'; buildGotoMenu() }, false, true, 'font')
  addItem('Settings', () => showSettings(), false, false, 'gear')
}

/* nav-menus (2026-10-10-06-10-00): a small ▾ beside every Back button (Library, Contents, Settings and Bookmarks screens; top and bottom
   Back buttons) opens a menu to jump to Library / Contents / Bookmarks / Settings. Contents and Bookmarks only while a book is open
   (Contents only when the book has a contents list). A ✓ marks the screen you are on. The Library view also shows the Contents page. */
let libraryViewMode = 'library'
function currentViewName() {
  if ($('#settings-view').classList.contains('show')) return 'settings'
  if ($('#bookmarks-view')?.classList.contains('show')) return 'bookmarks'
  if ($('#library-view').classList.contains('show')) return libraryViewMode
  return ''
}
function openViewMenu(btn) {
  const menu = $('#view-menu')
  if (menu.classList.contains('show') && menu._owner === btn) { menu.classList.remove('show'); return }
  menu._owner = btn
  const cur = currentViewName()
  const items = [['library', 'Library', () => showLibrary()]]
  if (view?.book?.toc?.length) items.push(['contents', 'Contents', () => { $('#bookmarks-view')?.classList.remove('show'); showTOC() }])
  if (currentBookId) items.push(['bookmarks', 'Bookmarks', () => showBookmarks()])
  items.push(['settings', 'Settings', () => showSettings()])
  menu.innerHTML = ''
  for (const [key, label, fn] of items) {
    const b = document.createElement('button')
    b.textContent = (key === cur ? '✓ ' : '') + label
    b.addEventListener('click', () => { menu.classList.remove('show'); fn() })
    menu.appendChild(b)
  }
  const r = btn.getBoundingClientRect()
  menu.style.left = r.left + 'px'; menu.style.top = (r.bottom + 4) + 'px'
  menu.classList.add('show')
  const w = menu.offsetWidth, h = menu.offsetHeight
  if (r.left + w > window.innerWidth - 8) menu.style.left = Math.max(8, window.innerWidth - w - 8) + 'px'
  if (r.bottom + 4 + h > window.innerHeight - 8) menu.style.top = Math.max(8, r.top - 4 - h) + 'px' // the bottom Back button opens it upwards
}
function initViewMenu() {
  const menu = document.createElement('div')
  menu.id = 'view-menu'
  document.body.appendChild(menu)
  for (const id of ['#library-back-top', '#library-back-bottom', '#settings-back-top', '#settings-back-bottom', '#bookmarks-back-top', '#bookmarks-back-bottom']) {
    const back = $(id)
    if (!back) continue
    const more = document.createElement('button')
    more.className = 'back-more'
    more.textContent = '▾'
    more.title = 'Go to…'
    more.setAttribute('aria-label', 'Go to…')
    more.addEventListener('click', e => { e.stopPropagation(); openViewMenu(more) })
    back.after(more) // applyBackButtons() shows and hides it together with its Back button
  }
  document.addEventListener('click', e => { if (!e.target.closest('#view-menu')) menu.classList.remove('show') })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.classList.remove('show') })
}

function showTOC() {
  const toc = view?.book?.toc
  if (!toc) return
  const body = $('#library-body')
  $('#settings-view').classList.remove('show')
  setComponentTitle($('#library-header-title'), 'Contents')
  libraryViewMode = 'contents'
  // Contents reuses the library view: hide the import row, Back returns
  const importRow = $('#import-row')
  if (importRow) importRow.style.display = 'none'
  body.innerHTML = ''
  const walk = (items, depth) => {
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'book-row'
      row.style.paddingLeft = (depth * 20) + 'px'
      row.innerHTML = `<div class="meta"><div class="title">${item.label}</div></div>`
      row.addEventListener('click', async () => { await view.goTo(item.href); showReaderView() })
      body.appendChild(row)
      if (item.subitems) walk(item.subitems, depth + 1)
    }
  }
  walk(toc, 0)
  $('#library-view').classList.add('show')
  applyBackButtons()
  hideCover()
}

function promptGoto() {
  const val = prompt('Go to position (percentage, e.g. 42.73, or character index, e.g. 110003):')
  if (val == null) return
  gotoFromText(val)
}
// position-select-bar (2026-10-04-08-20-19): the parsing part of promptGoto(), also used by the Goto button of the
// selected-position bar. dry = true: only says whether the text is a usable target, no jump. Returns true when usable.
function gotoFromText(val, dry = false) {
  const trimmed = String(val ?? '').trim()
  if (!trimmed) return false
  // goto-pct-char-unified (2026-09-27-11-49-15): a trailing % always means
  // percentage (checked BEFORE stripping, so "70%" can't fall into the
  // integer-char branch); otherwise a plain integer 0-100 is a percentage
  // and only integers >100 are char indexes. Percentage jumps in int mode
  // go via charIdx so footer display and goto share one denominator
  // (charIndex/bookTotalChars), never SectionProgress sizes.
  const hadPercent = /%\s*$/.test(trimmed)
  const raw = trimmed.replace(/%$/, '').trim()
  if (!raw) return false
  const gotoFractionViaChar = frac => {
    const f = Math.min(1, Math.max(0, frac))
    if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && bookTotalChars) {
      const charIdx = Math.min(Math.max(0, Math.round(f * bookTotalChars)), Math.max(0, bookTotalChars - 1))
      getRangeForCharIndex(charIdx).then(target => {
        if (target) view.renderer.goTo(target).catch(() => {})
        else view.goToFraction(f).catch(() => {})
      }).catch(() => {})
    } else {
      view.goToFraction(f).catch(() => {})
    }
  }
  // whole digits (no . or ,): percentage when hadPercent or 0-100, else char index
  // (both . and , accepted as the decimal separator below, any precision kept)
  if (/^[+-]?\d+$/.test(raw)) {
    const idx = parseInt(raw, 10)
    if (isNaN(idx)) return false
    if (hadPercent || (idx >= 0 && idx <= 100)) {
      if (dry) return true
      gotoFractionViaChar(idx / 100)
      return true
    }
    if (!bookTotalChars) return false
    if (dry) return true
    const clamped = Math.min(Math.max(0, idx), Math.max(0, bookTotalChars - 1))
    getRangeForCharIndex(clamped).then(target => {
      if (target) view.renderer.goTo(target).catch(() => {})
      else view.goToFraction(clamped / bookTotalChars).catch(() => {})
    }).catch(() => {})
    return true
  }
  const num = parseFloat(raw.replace(',', '.'))
  if (isNaN(num)) return false
  if (dry) return true
  gotoFractionViaChar(num / 100)
  return true
}

/* ---------------- search book (2026-09-27-12-08-27) ---------------- */
// Whole book, all sections, from the current position in the given direction.
// Per-section visible text is built with the same filter as the char counters
// and cached till the next openBook. Code-unit/code-point conversion keeps
// indexOf (UTF-16) consistent with the char-index anchor walker (code points).
function showSearchPanel() {
  const panel = $('#search-panel')
  if (!panel) return
  // search-panel-place-switch: the CSS default is bottom; move it per flag (anything else = bottom).
  // A drag sets explicit left/top (search-panel-drag-close); reopening resets to the place (left: 50% + transform).
  const place = FLAGS.SWITCH_SEARCH_PANEL_PLACE
  panel.style.left = '50%'
  if (place === 'top') { panel.style.top = '18px'; panel.style.bottom = 'auto'; panel.style.transform = 'translateX(-50%)' }
  else if (place === 'middle') { panel.style.top = '50%'; panel.style.bottom = 'auto'; panel.style.transform = 'translate(-50%, -50%)' }
  else { panel.style.top = 'auto'; panel.style.bottom = '18px'; panel.style.transform = 'translateX(-50%)' }
  panel.classList.remove('hidden')
  const input = $('#search-input')
  input.value = lastSearchQuery
  input.classList.remove('not-found')
  input.focus()
  input.select()
}
function hideSearchPanel() {
  $('#search-panel')?.classList.add('hidden')
  clearSearchMark()
}
// unwraps the transient mark without touching text (split text nodes are
// re-merged); background-only styling means wrap/unwrap never reflows layout
function clearSearchMark() {
  try {
    const m = searchMark
    searchMark = null
    const span = m?.span
    const parent = span?.parentNode
    if (!span || !parent) return
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
    parent.normalize?.()
  } catch {}
}
// highlights the landed match inside one text node (where prose matches almost
// always sit); a cross-node match still marks to the node end at the exact
// landing spot rather than nothing
function markSearchMatch(target, query, charIdx) {
  clearSearchMark()
  // search-stable-goto (2026-09-27-13-39-03): the mark path was blind
  // (collapsed/bad-node/throw all silent) — report the outcome per jump.
  const report = extra => debugBeacon('search-mark', { charIdx, query: String(query).slice(0, 30), ...extra })
  try {
    const contents = view.renderer.getContents() ?? []
    const live = (contents.find(c => c.index === target.index) ?? contents[0])?.doc
    if (!live) { report({ outcome: 'no-live-doc' }); return }
    const range = target.anchor(live)
    const node = range?.startContainer
    if (!node || node.nodeType !== 3 || !node.nodeValue) { report({ outcome: 'bad-node', nodeType: node?.nodeType ?? null }); return }
    let qLenCu = 0
    for (const ch of query) qLenCu += ch.length
    const start = Math.min(range.startOffset, node.nodeValue.length)
    const end = Math.min(node.nodeValue.length, range.startOffset + qLenCu)
    if (end <= start) { report({ outcome: 'collapsed', nodeLen: node.nodeValue.length, startOffset: range.startOffset }); return }
    const r = live.createRange()
    r.setStart(node, start)
    r.setEnd(node, end)
    const span = live.createElement('span')
    span.setAttribute('data-sm-search-mark', '1')
    span.style.background = 'rgba(255, 235, 59, .65)'
    span.style.color = 'inherit'
    r.surroundContents(span)
    searchMark = { span }
    dodgeSearchPanel(live, span)
    report({ outcome: 'marked', nodeLen: node.nodeValue.length })
  } catch (e) { report({ outcome: 'threw', reason: String(e?.message ?? e).slice(0, 80) }) }
}
// search-panel-drag-close (2026-10-10-20-52-34): after a landed jump, hop the open panel to the free half
// when it covers the yellow match. Jumps only: a manual drag spot is left alone until the next covering jump.
function dodgeSearchPanel(doc, span) {
  try {
    if (FLAGS.SWITCH_SEARCH_BOX_MOVES_AWAY_FROM_COVERING_SEARCH_RESULT !== true) return
    const panel = $('#search-panel')
    if (!panel || panel.classList.contains('hidden')) return
    const pr = panel.getBoundingClientRect()
    const mr = toOuterRect(doc, span.getBoundingClientRect())
    if (mr.bottom < pr.top || mr.top > pr.bottom || mr.right < pr.left || mr.left > pr.right) return
    // dodge-bottom-fix (2026-10-10-21-00-38): toOuterRect() has no height field, so center from top/bottom
    if ((mr.top + mr.bottom) / 2 < window.innerHeight / 2) panel.style.top = Math.max(8, window.innerHeight - panel.offsetHeight - 8) + 'px'
    else panel.style.top = '18px'
    panel.style.bottom = 'auto'
    panel.style.left = '50%'
    panel.style.transform = 'translateX(-50%)'
  } catch {}
}
// flash-first-row (2026-09-27-15-41-42): transient blue tint on the landed
// top row after a restore, so resize/fullscreen landings are eye-checkable.
// Separate var/timer from the yellow search mark (never clobbered; skipped
// while one is active). Background-only styling, no reflow. Single text
// node only (where prose top rows sit); cross-node rows simply don't flash.
let firstRowFlash = null
let firstRowFlashTimer = null
function clearFirstRowFlash() {
  try {
    clearTimeout(firstRowFlashTimer)
    firstRowFlashTimer = null
    const m = firstRowFlash
    firstRowFlash = null
    const span = m?.span
    const parent = span?.parentNode
    if (!span || !parent) return
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
    parent.normalize?.()
  } catch {}
}
function flashFirstRowOnRestore() {
  clearFirstRowFlash()
  if (FLAGS.SWITCH_MARK_TEMPORARILY_FIRST_ROW_ON_PAGE_RESIZE !== true) return
  const ms = Number(FLAGS.SWITCH_MARK_TEMPORARILY_FIRST_ROW_ON_PAGE_RESIZE_MS ?? 3000)
  if (!(ms > 0)) return
  if (searchMark) return
  try {
    const landed = view?.lastLocation?.range
    if (!landed) return
    const doc = landed.startContainer?.ownerDocument
    if (!doc?.createRange) return
    const node = landed.startContainer
    if (!node || node.nodeType !== 3 || !node.nodeValue) return
    const len = node.nodeValue.length
    const offset = Math.min(Math.max(0, landed.startOffset ?? 0), len)
    if (offset >= len) return
    const r = doc.createRange()
    r.setStart(node, offset)
    r.collapse(true)
    let lineH = 0
    let end = offset
    while (end < len && end - offset < 200) {
      end++
      r.setEnd(node, end)
      let h = 0
      try { h = r.getBoundingClientRect().height } catch { break }
      if (h > 0 && !lineH) lineH = h
      if (lineH && h > lineH * 1.3) { end--; break }
    }
    if (end <= offset) return
    r.setEnd(node, end)
    const span = doc.createElement('span')
    span.setAttribute('data-sm-first-row-flash', '1')
    span.style.background = 'rgba(33, 150, 243, .35)'
    span.style.color = 'inherit'
    r.surroundContents(span)
    firstRowFlash = { span }
    firstRowFlashTimer = setTimeout(clearFirstRowFlash, Math.min(30000, ms))
  } catch {}
}
// saved-char-mark (2026-09-29-08-27-26): tints the saved char (through the end
// of its word, at most 12 code units) after a restore, until the next page
// turn or jump. CSS Custom Highlight API: registry entry on the book iframe's
// window, no DOM change, so no reflow and no split text nodes. The rule
// `::highlight(sm-saved-char)` lives in getCSS().
const SAVED_MARK_NAME = 'sm-saved-char'
let savedCharMark = null // { win }
function clearSavedCharMark() {
  try {
    const m = savedCharMark
    savedCharMark = null
    m?.win?.CSS?.highlights?.delete(SAVED_MARK_NAME)
  } catch {}
}
// mark-at-node-end (2026-09-29-09-18-31): first non-blank text node after
// `node` in document order (skips script/style), or null.
function nextNonBlankTextNode(doc, node) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  walker.currentNode = node
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const pn = n.parentElement?.localName?.toLowerCase()
    if (pn === 'script' || pn === 'style') continue
    if (n.nodeValue?.trim()) return n
  }
  return null
}
async function markSavedCharAfterRestore(charIdx, gen) {
  clearSavedCharMark()
  if (FLAGS.SWITCH_MARK_SAVED_CHAR_UNTIL_NEXT_PAGE_TURN !== true) return
  if (charIdx == null || !view) return
  const report = extra => debugBeacon('saved-mark', { charIdx, ...extra })
  try {
    const target = await getRangeForCharIndex(charIdx)
    if (!target || gen !== restoreGeneration) return
    const contents = view.renderer.getContents() ?? []
    const live = (contents.find(c => c.index === target.index) ?? contents[0])?.doc
    const win = live?.defaultView
    if (!win?.CSS?.highlights || typeof win.Highlight !== 'function') { report({ outcome: 'no-highlight-api' }); return }
    const r = target.anchor(live)
    const node = r?.startContainer
    if (!node) { report({ outcome: 'no-range' }); return }
    let via = 'node'
    if (node.nodeType === 3) {
      let tNode = node
      let str = node.nodeValue ?? ''
      let from = Math.min(r.startOffset, str.length)
      // mark-skip-blank (2026-09-29-09-39-04): start on the first non-blank
      // char (\s also covers nbsp), so a leading nbsp/space is not the mark
      if (from < str.length && /\s/.test(str[from])) {
        while (from < str.length && /\s/.test(str[from])) from++
        if (from < str.length) r.setStart(node, from)
      }
      if (from >= str.length) {
        // saved char sits at the very end of its text node (restore target at
        // a node end): mark the first word of the next non-blank text node
        const nxt = nextNonBlankTextNode(live, node)
        if (!nxt) { report({ outcome: 'empty', via: 'no-next-node' }); return }
        tNode = nxt
        str = nxt.nodeValue ?? ''
        from = Math.max(0, str.search(/\S/))
        r.setStart(tNode, from)
        via = 'next-node'
      }
      let end = from
      const max = Math.min(str.length, from + 12)
      while (end < max && !/\s/.test(str[end])) end++
      if (end === from) end = Math.min(str.length, from + 1)
      if (end <= from) { report({ outcome: 'empty', via }); return }
      r.setEnd(tNode, end)
    } else if (r.collapsed) { report({ outcome: 'collapsed-element' }); return }
    const hl = new win.Highlight(r)
    try { hl.priority = 1 } catch {} // above bookmark highlights
    win.CSS.highlights.set(SAVED_MARK_NAME, hl)
    savedCharMark = { win }
    report({ outcome: 'marked', via })
  } catch (e) { report({ outcome: 'threw', reason: String(e?.message ?? e).slice(0, 80) }) }
}
// search-stable-goto (2026-09-27-13-39-03): search jumps go through the same
// settle path as restores. Fresh-open layout (fonts/images reflowing) used to
// shift columns between rect measurement and scroll, stranding viewport and
// mark; and an in-flight scheduleRestore could fire after the search goTo and
// yank the viewport back. Bumping restoreGeneration retires pending restores;
// the size poll waits out reflow. isResizing is cleared so the search landing
// (reason 'navigation') saves as a real position instead of being filtered.
async function stableSearchGoTo(target, query, charIdx) {
  const myGeneration = ++restoreGeneration
  clearTimeout(resizeSettleTimer)
  clearTimeout(isResizingOffTimer)
  const qLower = query.toLowerCase()
  // search-confirm-retry (2026-09-27-13-54-33): fresh-load font/column reflow
  // can strand the first goTo a page off the match (rects measured pre-swap).
  // Go, re-settle, confirm the landed window actually contains the query,
  // retry once with final rects, and only then mark. At most two loadings; a
  // superseded jump (newer generation) owns nothing and bails out.
  let current = target
  let attempts = 0
  let confirmed = false
  while (attempts < 2) {
    attempts++
    await waitForPaginatorSizeStable(myGeneration)
    if (myGeneration !== restoreGeneration) return false
    isResizing = false
    try {
      await view.renderer.goTo(current).catch(() => {})
    } catch {}
    await waitForPaginatorSizeStable(myGeneration)
    if (myGeneration !== restoreGeneration) return false
    let visible = ''
    try { visible = String(view.lastLocation?.range ?? '') } catch {}
    if (visible.toLowerCase().includes(qLower)) { confirmed = true; break }
    // re-resolve in the now-settled doc and try once more
    try {
      const fresh = await getRangeForCharIndex(charIdx)
      if (fresh) current = fresh
      else break
    } catch { break }
  }
  markSearchMatch(current, query, charIdx)
  debugBeacon('search-confirm', { charIdx, query: String(query).slice(0, 30), confirmed, attempts })
  return true
}
async function getSectionSearchText(i) {
  if (searchTextCache[i]) return searchTextCache[i]
  try {
    const doc = await view.book.sections[i].createDocument()
    if (!doc?.body) return null
    // image-chars: one placeholder (U+FFFC, 1 code unit) per media element keeps
    // hit offsets aligned with the global char numbers
    const walker = doc.createTreeWalker(doc.body, CHAR_WALK_SHOW, { acceptNode: charAcceptNode })
    let text = ''
    for (let n = walker.nextNode(); n; n = walker.nextNode()) text += (n.nodeType === 1 ? '\uFFFC' : (n.nodeValue ?? ''))
    const entry = { text, lower: text.toLowerCase() }
    searchTextCache[i] = entry
    return entry
  } catch { return null }
}
const cuToCp = (s, cuIdx) => [...s.slice(0, Math.max(0, cuIdx))].length
const cpToCu = (s, cpIdx) => {
  let cu = 0
  let counted = 0
  for (const ch of s) {
    if (counted >= cpIdx) break
    cu += ch.length
    counted++
  }
  return cu
}
function secOfChar(charIdx) {
  let sec = 0
  for (let i = 0; i < bookCharPrefixes.length; i++) {
    const start = bookCharPrefixes[i]
    const end = i + 1 < bookCharPrefixes.length ? bookCharPrefixes[i + 1] : bookTotalChars
    if (charIdx >= start && charIdx < end) { sec = i; break }
    if (charIdx >= end) sec = i + 1
  }
  return Math.min(sec, (view?.book?.sections.length ?? 1) - 1)
}
async function doSearchBook(dir) {
  const input = $('#search-input')
  const status = $('#search-status')
  const query = input?.value ?? ''
  if (!view?.book || !query || !bookTotalChars) return
  lastSearchQuery = query
  clearSearchMark() // a new attempt retires the previous transient mark
  const qLower = query.toLowerCase()
  const qLenCp = [...query].length
  let cur = null
  try { cur = getCurrentCharIndex() } catch { cur = null }
  if (cur == null) cur = lastStableCharIndex ?? 0
  // repeated stepping with the same query continues past the landed match
  // instead of re-finding it (the footer reads the page start, which sits
  // before a mid-page match, so cur alone would loop on one result)
  let base
  if (lastSearchLandedChar != null && lastSearchQueryForStep === query) {
    base = dir > 0 ? lastSearchLandedChar + qLenCp : lastSearchLandedChar - 1
  } else {
    base = dir > 0 ? cur + 1 : cur - 1
  }
  const wrap = $('#search-wrap')?.checked === true
  const n = view.book.sections.length
  const startSec = secOfChar(Math.min(Math.max(0, base), Math.max(0, bookTotalChars - 1)))
  const order = []
  if (dir > 0) { for (let i = startSec; i < n; i++) order.push(i); if (wrap) for (let i = 0; i < startSec; i++) order.push(i) }
  else { for (let i = startSec; i >= 0; i--) order.push(i); if (wrap) for (let i = n - 1; i > startSec; i--) order.push(i) }
  let first = true
  for (const i of order) {
    const entry = await getSectionSearchText(i)
    if (!entry) { first = false; continue }
    const prefix = bookCharPrefixes[i] ?? 0
    let idx = -1
    if (first) {
      const localCp = Math.min(Math.max(0, base - prefix), cuToCp(entry.text, entry.text.length))
      const localCu = cpToCu(entry.text, localCp)
      if (dir > 0) idx = entry.lower.indexOf(qLower, localCu)
      else {
        // matches starting at/after base don't count — step back past them
        idx = entry.lower.lastIndexOf(qLower, localCu)
        if (idx >= localCu) idx = entry.lower.lastIndexOf(qLower, localCu - 1)
      }
      first = false
    } else {
      idx = dir > 0 ? entry.lower.indexOf(qLower) : entry.lower.lastIndexOf(qLower)
    }
    if (idx >= 0) {
      const globalCp = prefix + cuToCp(entry.text, idx)
      const clamped = Math.min(Math.max(0, globalCp), Math.max(0, bookTotalChars - 1))
      try {
        const target = await getRangeForCharIndex(clamped)
        // search-stable-goto: waits out reflow and retires pending restores;
        // records only when still current (a superseded jump owns nothing)
        if (target && await stableSearchGoTo(target, query, clamped)) {
          lastSearchLandedChar = clamped
          lastSearchQueryForStep = query
          input.classList.remove('not-found')
          if (status) status.textContent = bookTotalChars ? formatPct(clamped / bookTotalChars) : ''
        }
        return
      } catch {}
    }
  }
  // the wrapped-around remainder of the start section is not in the order
  // list above (the start section is never revisited), so check its far
  // side explicitly here when wrap is on
  if (wrap) {
    const entry = await getSectionSearchText(startSec)
    if (entry) {
      const prefix = bookCharPrefixes[startSec] ?? 0
      const localCp = Math.min(Math.max(0, base - prefix), cuToCp(entry.text, entry.text.length))
      const localCu = cpToCu(entry.text, localCp)
      let idx = -1
      if (dir > 0) {
        // far side of the start section: matches strictly before base
        // (at/after base was already covered in the first pass above)
        const firstAtZero = entry.lower.indexOf(qLower)
        if (firstAtZero >= 0 && firstAtZero < localCu) idx = firstAtZero
      } else {
        // far side: last match overall counts only if it starts after base
        // (at/before base was already covered in the first pass above)
        idx = entry.lower.lastIndexOf(qLower)
        if (idx < localCu) idx = -1
      }
      if (idx >= 0) {
        const globalCp = prefix + cuToCp(entry.text, idx)
        const clamped = Math.min(Math.max(0, globalCp), Math.max(0, bookTotalChars - 1))
        try {
          const target = await getRangeForCharIndex(clamped)
          if (target && await stableSearchGoTo(target, query, clamped)) {
            lastSearchLandedChar = clamped
            lastSearchQueryForStep = query
            input.classList.remove('not-found')
            if (status) status.textContent = bookTotalChars ? formatPct(clamped / bookTotalChars) : ''
          }
          return
        } catch {}
      }
    }
  }
  input.classList.add('not-found')
  if (status) status.textContent = 'Not found'
}

function showCover() {
  showReaderView()
  Promise.resolve(view?.book?.getCover?.()).then(blob => {
    if (!blob) { alert("No cover image found in this book."); return }
    $('#cover-img').src = URL.createObjectURL(blob)
    $('#cover-overlay').classList.add('show')
  })
}
function hideCover() { $('#cover-overlay').classList.remove('show') }

/* ---------------- view switching ---------------- */

function showReader() {
  $('#library-view').classList.remove('show')
  $('#settings-view').classList.remove('show')
  $('#bookmarks-view')?.classList.remove('show')
  setComponentTitle($('#library-header-title'), 'Library')
}
function showReaderView() { showReader(); hideCover(); updateBmBar() }
// Back-button + title visibility for Library/Settings/Contents
// (2026-09-27-16-35-36, unified-chrome). Back always returns to the last
// reading position (same as Return did). Location switch read live.
function setComponentTitle(el, text) {
  if (!el) return
  el.textContent = FLAGS.SWITCH_SHOW_COMPONENTS_TITLE_IN_APP === true ? text : ''
}
function applyBackButtons() {
  const loc = FLAGS.SWITCH_BACK_BUTTON_LOCATION_IN_APP ?? 'top'
  const showTop = loc === 'top'
  const showBottom = loc === 'bottom'
  for (const id of ['#library-back-top', '#settings-back-top', '#bookmarks-back-top']) {
    const el = $(id)
    if (el) el.style.display = showTop ? '' : 'none'
  }
  for (const id of ['#library-back-bottom', '#settings-back-bottom', '#bookmarks-back-bottom']) {
    const el = $(id)
    if (el) el.style.display = showBottom ? '' : 'none'
  }
  for (const m of document.querySelectorAll('.back-more')) m.style.display = m.previousElementSibling?.style.display ?? '' // nav-menus
}
function showLibrary() {
  libraryViewMode = 'library'
  $('#bookmarks-view')?.classList.remove('show')
  $('#settings-view').classList.remove('show')
  setComponentTitle($('#library-header-title'), 'Library')
  $('#import-row')?.style.removeProperty('display')
  refreshLibrary()
  $('#library-view').classList.add('show')
  applyBackButtons()
  hideCover()
}
function showSettings() {
  $('#bookmarks-view')?.classList.remove('show')
  $('#library-view').classList.remove('show')
  setComponentTitle($('#settings-header-title'), 'Settings')
  renderSettings()
  $('#settings-view').classList.add('show')
  applyBackButtons()
  hideCover()
}

/* ---------------- fullscreen / chrome visibility ---------------- */
// (2026-09-29-22-00-06: the red left sidebar was removed completely)

// tap-header (2026-09-29-22-00-06): on touch, a tap in the top 20% of the page
// shows the hidden header (setting off). It stays until the next action: the
// next tap only hides it (like menus / the blue mark), a swipe or any page
// move hides it too. Mouse hover behavior is unchanged.
let headerForcedByTouch = false
let footerForcedByTouch = false
let touchRevealAt = 0 // ms of the last tap-reveal: the click of that same tap must not undo it
let lastPointerType = ''
const isTouchPointer = () => lastPointerType === 'touch' || lastPointerType === 'pen'
// fullscreen state incl. physical F11 (display-mode); used by the menu check
// mark and the cursor auto-hide
const isFullscreenNow = () => !!document.fullscreenElement || displayModeMql?.matches === true

// hide-cursor (2026-09-29-22-00-06): in fullscreen the mouse cursor hides after
// SWITCH_HIDE_MOUSE_CURSOR_IN_FULLSCREEN_AFTER_SECONDS without movement (0 =
// off) and returns on the next move. `html.sm-hide-cursor` in the app document
// (style.css) and in each book document (getCSS()).
let cursorHidden = false
let cursorTimer = 0
let lastMouseScreen = ''
function setCursorHidden(h) {
  if (cursorHidden === h) return
  cursorHidden = h
  document.documentElement.classList.toggle('sm-hide-cursor', h)
  try {
    for (const { doc } of view?.renderer?.getContents?.() ?? []) doc.documentElement.classList.toggle('sm-hide-cursor', h)
  } catch {}
}
function cursorActivity(e) {
  if (e && e.type === 'mousemove') {
    // hiding/showing the cursor can fire a mousemove without movement: ignore
    const k = e.screenX + ',' + e.screenY
    if (k === lastMouseScreen) return
    lastMouseScreen = k
  }
  setCursorHidden(false)
  clearTimeout(cursorTimer)
  const sec = Number(FLAGS.SWITCH_HIDE_MOUSE_CURSOR_IN_FULLSCREEN_AFTER_SECONDS)
  if (!(sec > 0) || !isFullscreenNow()) return
  cursorTimer = setTimeout(() => { if (isFullscreenNow()) setCursorHidden(true) }, sec * 1000)
}

// rounded corners (2026-09-29-22-00-06): --page-radius drives #book-page in style.css
function applyRoundedCorners() {
  const px = Number(settings.roundedCorners ?? FLAGS.SWITCH_DEFAULT_ROUNDED_CORNERS_BORDER_RADIUS_IN_PIXELS)
  document.documentElement.style.setProperty('--page-radius', (Number.isFinite(px) && px > 0 ? px : 0) + 'px')
}

// boot-hide (2026-09-29-22-00-06): index.html hides #app until the first view
// is chosen (last book or Library), so no empty page flashes. Failsafe: a crash
// in startup, or 3 s with no view chosen, shows the Library; a book that is
// still opening is not interrupted (the screen is just revealed).
let bootChosen = false
let bootRevealed = false
let bootTimer = 0
function revealApp() {
  bootRevealed = true
  clearTimeout(bootTimer)
  document.documentElement.classList.add('sm-ready')
}
function bootFailsafe(why) {
  if (bootRevealed) return
  debugBeacon('boot-failsafe', { why, chosen: bootChosen })
  if (!bootChosen && !view) { try { showLibrary() } catch {} }
  revealApp()
}
// hides the tap-revealed labels and the dropdown that opened with them
function hideTouchChrome() {
  if (!headerForcedByTouch && !footerForcedByTouch) return false
  if (headerForcedByTouch) $('#goto-menu').classList.remove('show')
  headerForcedByTouch = false
  footerForcedByTouch = false
  applyChromeVisibility()
  return true
}
// (renamed 2026-09-30-09-18-55: top label AND bottom label; the top one opens
// the dropdown at once, like a click on the header on PC)
function tryRevealChromeByTap(yAbs) {
  if (!view || headerForcedByTouch || footerForcedByTouch || !isTouchPointer()) return false
  const r = $('#book-page').getBoundingClientRect()
  const frac = (yAbs - r.top) / Math.max(1, r.height)
  const zone = Math.min(0.4, Math.max(0.05, Number(FLAGS.SWITCH_TAP_TOP_BOTTOM_LABEL_ZONE_PERCENT ?? 20) / 100))
  if (frac < zone && settings.showBookMenu === false) {
    headerForcedByTouch = true
    touchRevealAt = Date.now()
    applyChromeVisibility()
    openGotoMenuAtHeader(true)
    return true
  }
  if (frac > 1 - zone && settings.showPosition === false) {
    footerForcedByTouch = true
    touchRevealAt = Date.now()
    applyChromeVisibility()
    return true
  }
  return false
}
function openGotoMenuAtHeader(forceOpen) { openGotoMenuAt($('#page-header'), forceOpen, null) }
// mode: null = main menu (or keep the submenu while it is open), 'bookmarks' = that submenu
function openGotoMenuAt(anchor, forceOpen, mode) {
  const menu = $('#goto-menu')
  if (mode) gotoMenuMode = mode
  else if (forceOpen || !menu.classList.contains('show')) gotoMenuMode = 'main'
  buildGotoMenu()
  const r = anchor.getBoundingClientRect()
  menu.style.left = r.left + 'px'
  menu.style.top = (r.bottom + 6) + 'px'
  menu.style.transform = 'none'
  if (forceOpen) menu.classList.add('show')
  else menu.classList.toggle('show')
  if (menu.classList.contains('show')) {
    const w = menu.offsetWidth
    if (r.left + w > window.innerWidth - 8) menu.style.left = Math.max(8, window.innerWidth - w - 8) + 'px'
  }
}

// Dismiss whatever chrome is showing, in priority order. Returns true if it
// dismissed something — the caller should treat that as the whole click and
// not also navigate, so the *next* click is the one that turns the page.
function dismissChrome() {
  const menu = $('#goto-menu')
  const menuWasOpen = menu.classList.contains('show')
  if (menuWasOpen) { menu.classList.remove('show'); menuSnap = null }
  const hid = hideTouchChrome() // tap-revealed labels go with the dropdown
  const pop = popState?.sticky === true && hidePopup() // sticky footnote/note popup
  const foc = !!bmFocus
  if (foc) { bmFocus = null; updateBmBar() } // small bar opened by a tap on yellow text
  return menuWasOpen || hid || pop || foc
}

// no-mark-on-chrome-toggle (2026-09-29-14-26-56): the restore scheduled by a
// menu/position toggle must not paint the blue saved-char mark (the page grid
// does not change; the mark is meant for real resizes). Holds the restore
// generation that skips it; a newer restore has a newer generation.
let noMarkRestoreGen = 0
function updateChromeVisibility() {
  // remember top-left before header/footer visibility changes reflow
  if (view && !isResizing && view.lastLocation?.cfi) lastStableCfi = view.lastLocation.cfi
  if (view && lastStableCfi) { captureAnchor() }
  applyChromeVisibility()
  if (view && lastStableCfi) {
    const g0 = restoreGeneration
    scheduleRestore()
    if (restoreGeneration !== g0) noMarkRestoreGen = restoreGeneration
  }
}
// pure applicator (2026-09-27-16-35-36, unified-chrome): no capture, no
// restore — safe to call from hover handlers. visibility (not display) so
// the page keeps its box/padding, except symmetric-margins mode below.
// overlay-chrome (2026-09-27-17-52-01): title/position are absolutely
// overlaid (zero layout impact), so toggles use display:none — fully
// invisible and reflow-free. Mode-specific props are reset on every call
// so live flag flips can't strand a mix.
function applyChromeVisibility() {
  const overlay = FLAGS.SWITCH_PUT_TOP_MENU_AND_POSITION_TO_HALF_SPACE_VERTICALLY_AND_USE_SAME_HORIZONTAL_AND_VERTICAL_MARGINS === true
  $('#book-page').classList.toggle('overlay-chrome', overlay)
  const showMenuSetting = settings.showBookMenu !== false
  const showMenu = showMenuSetting || headerForcedByTouch // tap-header
  const showPosSetting = settings.showPosition !== false
  const showPos = showPosSetting || footerForcedByTouch
  const header = $('#page-header')
  const pct = $('#pct-display')
  if (overlay) {
    header.style.display = showMenu ? '' : 'none'
    header.style.visibility = ''
    header.style.pointerEvents = showMenu ? '' : 'none'
    pct.style.display = showPos ? '' : 'none'
    pct.style.visibility = ''
    pct.style.pointerEvents = showPos ? '' : 'none'
  } else {
    header.style.display = ''
    pct.style.display = ''
    header.style.visibility = showMenu ? '' : 'hidden'
    header.style.pointerEvents = showMenu ? '' : 'none'
    pct.style.visibility = showPos ? '' : 'hidden'
    pct.style.pointerEvents = showPos ? '' : 'none'
  }

  // when the top menu AND the position line are both fully hidden,
  // optionally reclaim their space so the page's top/bottom margin
  // matches its left/right margin instead of staying header/footer-sized
  const symmetric = FLAGS.SWITCH_HIDE_TOP_BOOK_MENU_AND_POSITION_AT_BOTTOM_MAKES_TOP_AND_BOTTOM_MARGINS_SAME_SIZE_AS_LEFT_AND_RIGHT_MARGINS
    && !showMenuSetting && !showPosSetting
  $('#book-page').classList.toggle('symmetric-margins', symmetric)
}
function toggleBookMenu() {
  headerForcedByTouch = false
  settings.showBookMenu = !(settings.showBookMenu !== false)
  // chrome-round2: full path (capture + restore) — hiding/showing reflows,
  // and the pure applicator alone would leave the drift uncorrected
  saveSettings(); updateChromeVisibility()
}
function togglePosition() {
  footerForcedByTouch = false
  settings.showPosition = !(settings.showPosition !== false)
  saveSettings(); updateChromeVisibility()
}
// position-settings (2026-09-27-18-32-22): clear the furthest-read mark for
// the current book (menu jumps to the start until reading advances again).
function resetCurrentFurthest() {
  furthestFraction = 0
  furthestCharIndex = null
  savePositionNow()
}
// a click with selected book text clears the selection first and is
// consumed — never a page turn. Returns true when it cleared something.
function clearBookSelection() {
  let cleared = false
  try {
    for (const { doc } of view?.renderer?.getContents?.() ?? []) {
      const sel = doc.getSelection?.()
      if (sel && String(sel).length) { selDbg('clear', doc, { where: 'clearBookSelection' }); sel.removeAllRanges(); cleared = true }
    }
  } catch {}
  return cleared
}

function requestFullscreen() {
  // freeze-fullscreen-size: pin BEFORE the viewport changes (it is still
  // windowed here); the capture/schedule below then no-op via the guard.
  // Unfreeze if the request itself fails, or sizes stay pinned forever.
  freezeFullscreenSize()
  // fixed-page-size (2026-09-28-23-12-51): no capture/restore; page size does
  // not depend on fullscreen.
  document.documentElement.requestFullscreen().catch(() => { unfreezeFullscreenSize() })
}
function exitFullscreenIfActive() {
  if (document.fullscreenElement) document.exitFullscreen()
}
function toggleFullscreen() {
  if (document.fullscreenElement) exitFullscreenIfActive()
  else requestFullscreen()
}
// 2026-09-27-15-10-46 (freeze-fullscreen-size): while frozen, #book-page
// and #viewer-host hold their pre-fullscreen pixel sizes, so the paginator
// container never changes size and no reflow/restore is needed. All restore
// callers stay untouched: scheduleRestore() bails while frozen (resetting
// isResizing, so a pre-freeze captureAnchor can't strand it true).
let fullscreenFrozen = false
// last pixel sizes seen while windowed (2026-09-27-15-22-16): the physical
// F11 key gives no before-event (no DOM fullscreenchange), so on entering
// browser-chrome fullscreen we pin these instead of the live (grown) sizes.
let windowedPageW = 0, windowedPageH = 0, windowedHostW = 0, windowedHostH = 0
let displayModeMql = null
function rememberWindowedSizes() {
  try {
    const page = $('#book-page')
    const host = $('#viewer-host')
    if (!page || !host) return
    // fractional rects (2026-09-27-15-32-22): offset/clientWidth round to
    // integers, pinning a sub-pixel-different size and causing a microscopic
    // reflow (few-char read-back drift, changed bottom line)
    windowedPageW = page.getBoundingClientRect().width
    windowedPageH = page.getBoundingClientRect().height
    windowedHostW = host.getBoundingClientRect().width
    windowedHostH = host.getBoundingClientRect().height
  } catch {}
}
// windowed-snapshot-at-rest (2026-09-28-08-58-34): refresh the windowed
// snapshot whenever the layout is at rest, not only from window 'resize'
// (which never fires before the first F11, and can fire after the grown
// size is already live). Skipped while any fullscreen is active/pinned or
// while the page has no size (hidden), so it can never store a grown or
// zero snapshot. rememberWindowedSizes() itself is unchanged: the freeze
// path calls it directly, deliberately while fullscreen.
function rememberWindowedSizesIfAtRest() {
  try {
    if (document.fullscreenElement || displayModeMql?.matches || fullscreenFrozen) return
    const r = $('#book-page')?.getBoundingClientRect()
    if (!r || !r.width || !r.height) return
    rememberWindowedSizes()
  } catch {}
}
function freezeFullscreenSize() {
  if (!FLAGS.SWITCH_KEEP_CONTAINER_AND_PAGE_SIZE_SAME_ON_FULLSCREEN_CHANGE) return
  if (fullscreenFrozen) return
  try {
    const page = $('#book-page')
    const host = $('#viewer-host')
    if (!page || !host) return
    const pageRect = page.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    page.style.width = pageRect.width + 'px'
    page.style.height = pageRect.height + 'px'
    host.style.width = hostRect.width + 'px'
    host.style.height = hostRect.height + 'px'
    // this live measurement is itself a good windowed snapshot
    rememberWindowedSizes()
    fullscreenFrozen = true
  } catch {}
}
// F11 path: pin the remembered windowed sizes (live ones already grew).
function freezeFullscreenSizeFromSnapshot() {
  if (!FLAGS.SWITCH_KEEP_CONTAINER_AND_PAGE_SIZE_SAME_ON_FULLSCREEN_CHANGE) return
  if (fullscreenFrozen) return
  if (!windowedPageW || !windowedPageH || !windowedHostW || !windowedHostH) return
  try {
    const page = $('#book-page')
    const host = $('#viewer-host')
    if (!page || !host) return
    page.style.width = windowedPageW + 'px'
    page.style.height = windowedPageH + 'px'
    host.style.width = windowedHostW + 'px'
    host.style.height = windowedHostH + 'px'
    fullscreenFrozen = true
  } catch {}
}
function unfreezeFullscreenSize() {
  if (!fullscreenFrozen) return
  try {
    $('#book-page')?.style.removeProperty('width')
    $('#book-page')?.style.removeProperty('height')
    $('#viewer-host')?.style.removeProperty('width')
    $('#viewer-host')?.style.removeProperty('height')
  } catch {}
  fullscreenFrozen = false
}

/* Any layout change (window resize, fullscreen toggle, sidebar show/hide,
   hiding header/footer, page/frame sliders) re-paginates the book, which
   otherwise silently drifts the reading position. Top-left character is
   remembered before the change and restored after layout settles.

   The naive fix — read view.lastLocation.cfi when the resize is first
   noticed — loses the race: by the time ResizeObserver runs, the paginator
   has usually already re-flowed and fired its own drifted 'relocate', so
   "the position right now" is already the wrong one. Instead we keep
   lastStableCfi updated by onRelocate only on an intentional position
   change (reason 'page', an actual page turn, or 'navigation', a real
   jump such as TOC/"Go to position") and never mid-resize, and also
   capture it synchronously *before* any mutation that will change layout
   (sidebar, header/footer, sliders, fullscreen, window resize) so the
   anchor is the true top-left before reflow.

   2026-09-27 addition (Problem A): a fixed wait alone wasn't enough to
   know the layout had actually finished resizing - a fullscreen transition
   can keep changing the paginator's `size` for far longer than any one
   fixed guess. scheduleRestore() now polls view.renderer.size (see
   waitForPaginatorSizeStable()) after the burst-coalescing wait below, and
   only does the actual restore once size has stopped moving. */
let resizeSettleTimer = null
let isResizingOffTimer = null
// bumped on every scheduleRestore() call; lets a still-in-flight size poll
// from an earlier call detect it's been superseded by a newer one (e.g.
// another resize/toggle arriving while the poll is still waiting) and bail
// out cleanly instead of racing the newer restore.
let restoreGeneration = 0
// restore-nav-guard (2026-09-28-20-12-00): generation of the restore whose own
// goTo relocates are in flight (0 = none). A freeze (F11 pressed again) resets
// isResizing without bumping restoreGeneration, so that restore's landing used
// to be saved as a real move (2303 -> 2211). onRelocate ignores relocates while
// restoreNavGen === restoreGeneration; a newer jump (search etc.) bumps the
// generation, so it is still saved.
let restoreNavGen = 0
// Problem A fix (2026-09-27): poll the paginator's own `size` getter
// (already public - view.renderer.size, see paginator.js `get size()`)
// until it's read the same value STABLE_CHECKS_REQUIRED times in a row,
// instead of trusting a fixed timer to know a resize/fullscreen transition
// has finished. Resolves true once settled (or once MAX_WAIT_MS elapses,
// as a safety cap), or resolves false if superseded by a newer
// scheduleRestore() call in the meantime (checked via the generation
// counter above).
function waitForPaginatorSizeStable(generation) {
  return new Promise(resolve => {
    const intervalMs = FLAGS.SWITCH_POLL_PAGINATOR_SIZE_BEFORE_RESTORE_INTERVAL_MS
    const neededStableChecks = FLAGS.SWITCH_POLL_PAGINATOR_SIZE_STABLE_CHECKS_REQUIRED
    const maxWaitMs = FLAGS.SWITCH_POLL_PAGINATOR_SIZE_MAX_WAIT_MS
    const startedAt = Date.now()
    let lastSize = null
    let stableCount = 0
    const check = () => {
      if (generation !== restoreGeneration) { resolve(false); return }
      let size = null
      try { size = view?.renderer?.size ?? null } catch { size = null }
      if (size != null && size === lastSize) stableCount++
      else stableCount = 1
      lastSize = size
      if (stableCount >= neededStableChecks) { resolve(true); return }
      if (Date.now() - startedAt >= maxWaitMs) {
        resolve(true) // give up waiting, proceed anyway rather than hang the restore
        return
      }
      setTimeout(check, intervalMs)
    }
    check()
  })
}
function captureAnchor() {
  if (!view) return
  const cur = view.lastLocation?.cfi
  const frac = view.lastLocation?.fraction
  let snippet = null
  try { snippet = String(view.lastLocation?.range).slice(0, 30) } catch {}
  let charIdx = null
  try { charIdx = getCurrentCharIndex() } catch {}
  // lastStable* is now only ever updated by onRelocate()'s reason-filtered
  // save ('page' or 'navigation'). Re-deriving it here from the live view
  // position used to run whenever !isResizing, which included exactly the
  // post-resize drift window onRelocate() is designed to reject — bypassing
  // that filter. Only fall back to the live position if there is no saved
  // anchor at all yet (e.g. the very first geometry-changing action before
  // any relocate has fired).
  if (cur && !lastStableCfi) { lastStableCfi = cur; if (frac != null && lastStableFraction == null) lastStableFraction = frac; if (snippet && !lastStableSnippet) lastStableSnippet = snippet; if (charIdx != null && lastStableCharIndex == null) lastStableCharIndex = charIdx }
  isResizing = true
  clearTimeout(resizeSettleTimer)
  clearTimeout(isResizingOffTimer)
}
function scheduleRestore() {
  if (!view) { isResizing = false; return }
  // freeze-fullscreen-size: nothing reflowed while frozen, so there is no
  // drift to correct; reset the flag a pre-freeze captureAnchor may have set
  // and bail before arming any timers or generation bumps.
  if (fullscreenFrozen) { isResizing = false; return }
  const myGeneration = ++restoreGeneration
  clearTimeout(resizeSettleTimer)
  resizeSettleTimer = setTimeout(async () => {
    const cfi = lastStableCfi
    const frac = lastStableFraction
    const charIdx = lastStableCharIndex
    debugBeacon('restore-start', { target: charIdx ?? '', gen: myGeneration, ...debugGeom() })
    // same guard at fire time: a restore scheduled just before the freeze
    // (e.g. requestFullscreen's own call) must not goTo once frozen.
    if (fullscreenFrozen) { isResizing = false; return }
    await waitForPaginatorSizeStable(myGeneration)
    if (myGeneration !== restoreGeneration) {
      // superseded by a newer resize/toggle while we were polling - that
      // newer call owns finishing the restore and turning isResizing back
      // off; bail out here without touching either.
      return
    }
    const waitRelocate = () => new Promise(resolve => {
      let done = false
      const h = e => {
        if (done) return
        // ignore drift relocates from the paginator's own internal resize /
        // font-load settling (reason 'anchor', from render()/onExpand); only
        // a real goTo/goToFraction (reason 'navigation') confirms our restore.
        if (e.detail?.reason !== 'navigation') return
        done = true; view.removeEventListener('relocate', h); resolve(e.detail)
      }
      view.addEventListener('relocate', h)
      setTimeout(() => { if (!done) { view.removeEventListener('relocate', h); resolve(null) } }, 700)
    })
    // persist-int-only: when SWITCH_SAVE_LOCATION_AS_CFI is not true, only
    // the integer char path below runs; the CFI/fraction branches are skipped.
    const useCfiRestore = FLAGS.SWITCH_SAVE_LOCATION_AS_CFI === true
    restoreNavGen = myGeneration
    try {
      if (charIdx != null && bookTotalChars) {
        const target = await getRangeForCharIndex(charIdx)
        // start listening BEFORE calling goTo/goToFraction: the confirming
        // relocate can be dispatched synchronously inside goTo's own await
        // chain, so attaching the listener only after `await goTo(...)`
        // returns can miss it entirely.
        const pending = waitRelocate()
        if (target) await view.renderer.goTo(target).catch(() => {})
        else {
          const charFrac = charIdx / bookTotalChars
          await view.goToFraction(charFrac).catch(() => {})
        }
        const detail = await pending
        // restore-diag-retry (2026-09-28-12-02-23): landed earlier than the
        // target (e.g. one page early after F11)? settle, then goTo once more.
        if (FLAGS.SWITCH_RETRY_RESTORE_ONCE_IF_LANDED_EARLY === true && target && myGeneration === restoreGeneration && !fullscreenFrozen) {
          let landed = null
          try { landed = getCurrentCharIndex() } catch { landed = null }
          const gap = landed == null ? 0 : charIdx - landed
          if (gap > 0 && gap <= (FLAGS.SWITCH_RESTORE_RETRY_MAX_CHAR_GAP ?? 2000)) {
            debugBeacon('restore-retry', { target: charIdx, landed, gap, ...debugGeom() })
            await new Promise(r => setTimeout(r, 150))
            if (myGeneration === restoreGeneration && !fullscreenFrozen) {
              const t2 = await getRangeForCharIndex(charIdx)
              const pending2 = waitRelocate()
              if (t2) await view.renderer.goTo(t2).catch(() => {})
              await pending2
              let landed2 = null
              try { landed2 = getCurrentCharIndex() } catch { landed2 = null }
              debugBeacon('restore-retry-done', { target: charIdx, landed: landed ?? '', landed2: landed2 ?? '', ...debugGeom() })
            }
          }
        }
        let curSnippet = ''
        try { curSnippet = String(detail?.range ?? view.lastLocation?.range).slice(0, 30) } catch {}
        const snippetMismatch = lastStableSnippet && curSnippet && curSnippet !== lastStableSnippet
        if (snippetMismatch && useCfiRestore && cfi) {
          const pendingFallback = waitRelocate()
          await view.goTo(cfi).catch(() => {})
          await pendingFallback
        }
      } else if (useCfiRestore && cfi) {
        const pending = waitRelocate()
        await view.goTo(cfi).catch(() => {})
        const detail = await pending
        const curFrac = detail?.fraction ?? view.lastLocation?.fraction
        let curSnippet = ''
        try { curSnippet = String(detail?.range ?? view.lastLocation?.range).slice(0, 30) } catch {}
        const snippetMismatch = lastStableSnippet && curSnippet && curSnippet !== lastStableSnippet
        if ((frac != null && curFrac != null && Math.abs(curFrac - frac) > 0.0005) || snippetMismatch) {
          const pendingFallback = waitRelocate()
          await view.goToFraction(frac).catch(() => {})
          await pendingFallback
        }
      }
    } catch {} finally { if (restoreNavGen === myGeneration) restoreNavGen = 0 }
    // pct-from-char (2026-09-27-10-49-44): in int mode show where the restore
    // landed (live read), not the pre-resize frac.
    if (FLAGS.SWITCH_SAVE_LOCATION_AS_CFI !== true && bookTotalChars) {
      let li = null
      try { li = getCurrentCharIndex() } catch { li = null }
      if (li == null) li = charIdx
      if (li != null) $('#pct-display').textContent = formatPct(li / bookTotalChars)
      else if (frac != null) $('#pct-display').textContent = formatPct(frac)
    }
    else if (frac != null) $('#pct-display').textContent = formatPct(frac)
    else if (charIdx != null && bookTotalChars) $('#pct-display').textContent = formatPct(charIdx / bookTotalChars)
    try { flashFirstRowOnRestore() } catch {}
    if (myGeneration !== noMarkRestoreGen) markSavedCharAfterRestore(charIdx, myGeneration).catch(() => {})
    if (debugOn()) { let landed = ''; try { landed = getCurrentCharIndex() ?? '' } catch {} ; debugBeacon('restore-done', { target: charIdx ?? '', landed, ...debugGeom() }) }
    rememberWindowedSizesIfAtRest()
    clearTimeout(isResizingOffTimer)
    isResizingOffTimer = setTimeout(() => { isResizing = false }, FLAGS.SWITCH_POST_RESTORE_GRACE_IGNORE_TRAILING_RELOCATE_EVENTS_IN_MS)
  }, FLAGS.SWITCH_WAIT_TILL_MOST_OF_PAGE_RESIZING_BURST_SETTLES_BEFORE_SYNCING_TOP_LEFT_CHAR_IN_MS)
}
// page-size-no-vh (2026-09-28-23-34-29): ignore sub-pixel changes (Firefox layout
// units are 1/60 px; F11 flipped the host between 482.3833 and 482.3999 px and
// scheduled a restore each time). Compared with the last accepted size, so
// small changes cannot accumulate unnoticed.
let roLastW = null, roLastH = null
const RO_MIN_CHANGE_PX = 0.5
const resizeObserver = new ResizeObserver(entries => {
  if (!view) return
  const r = entries?.[entries.length - 1]?.contentRect
  if (r && roLastW != null) {
    if (Math.abs(r.width - roLastW) < RO_MIN_CHANGE_PX && Math.abs(r.height - roLastH) < RO_MIN_CHANGE_PX) return
  }
  if (r) { roLastW = r.width; roLastH = r.height }
  // observer fires after layout – capture should already have happened synchronously
  scheduleRestore()
})
let lastWindowResizeLogAt = 0
let pageRefSettleTimer = null // fixed-page-size (2026-09-28-23-12-51)
// settle-guard (2026-09-29-08-27-26): time of the last fullscreenchange /
// display-mode event. On leaving fullscreen the display-mode event arrives
// before innerHeight has shrunk, so a settle timer firing in that gap refitted
// the page to 88% of the still-big height (page grew, then shrank: drift).
// The timer now waits until FS_EVENT_QUIET_MS after the last such event.
let lastFsEventAt = 0
const FS_EVENT_QUIET_MS = 1500
const PAGE_REF_SETTLE_MS = 600
function runPageRefSettle() {
  if (document.fullscreenElement || displayModeMql?.matches) return
  if (Date.now() - lastFsEventAt < FS_EVENT_QUIET_MS) {
    clearTimeout(pageRefSettleTimer)
    pageRefSettleTimer = setTimeout(runPageRefSettle, PAGE_REF_SETTLE_MS)
    return
  }
  const cur = document.documentElement.style.getPropertyValue('--page-h-px')
  const px = Math.round((settings.pageSizeVh / 100) * window.innerHeight * 100) / 100 + 'px'
  if (cur === px) return
  if (view && lastStableCfi) captureAnchor()
  setPageRefHeight()
  if (view && lastStableCfi) scheduleRestore()
}
window.addEventListener('resize', () => {
  // throttled (2026-09-28-12-02-23): F11 fires ~50 resize events per press
  const nowMs = Date.now()
  if (nowMs - lastWindowResizeLogAt > 400) { lastWindowResizeLogAt = nowMs; debugBeacon('window-resize', { w: window.innerWidth, h: window.innerHeight, ...debugGeom() }) }
  // keep the windowed snapshot fresh (skipped while any fullscreen is active)
  if (!document.fullscreenElement && !(displayModeMql?.matches)) rememberWindowedSizes()
  // fixed-page-size (2026-09-28-23-12-51): no capture/restore per resize event.
  // After the resize burst settles, and only when not in any fullscreen, refit
  // the reference page height; a real size change goes through the usual
  // capture + restore. Fullscreen/F11 leaves the page untouched.
  clearTimeout(pageRefSettleTimer)
  pageRefSettleTimer = setTimeout(runPageRefSettle, PAGE_REF_SETTLE_MS)
})

/* ---------------- export / import (backup) ---------------- */

// fresh-app-button (2026-09-27-18-51-02): escape a stale service worker
// (the mobile trap) — update check, drop all our caches, unregister, then
// hard reload. Next boot registers a fresh worker from network code.
async function loadFreshApp() {
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
      const regs = await ownRegistrations() // scope-safe: only this app's worker and caches
      await Promise.all(regs.map(r => { try { return r.update() } catch { return null } })).catch(() => {})
      try {
        const keys = await ownCacheKeys()
        await Promise.all(keys.map(k => caches.delete(k).catch(() => false)))
      } catch {}
      await Promise.all(regs.map(r => { try { return r.unregister() } catch { return null } })).catch(() => {})
    }
  } catch {}
  location.reload()
}

async function exportData(includeBooks) {
  const payload = await buildExportPayload(includeBooks)
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
  downloadBackupBlob(blob, `sm-reader-backup-${new Date().toISOString().slice(0, 10)}.json`)
}

// export-picker-label-booktheme (2026-10-10-17-21-04): Save picker with the file name pre-filled
// (Chromium, secure context only); everywhere else, and on picker failure, the automatic download.
// Cancel in the picker is silent.
async function exportBackup() {
  const includeBooks = $('#export-books')?.checked === true
  const name = `sm-reader-backup-${new Date().toISOString().slice(0, 10)}.json`
  let payload
  try { payload = await buildExportPayload(includeBooks) } catch { return }
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'SM Reader backup', accept: { 'application/json': ['.json'] } }],
      })
      const w = await handle.createWritable()
      await w.write(JSON.stringify(payload))
      await w.close()
      return
    } catch (err) {
      if (err?.name === 'AbortError') return
    }
  }
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
  downloadBackupBlob(blob, name)
}

function downloadBackupBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

async function buildExportPayload(includeBooks) {
  const [booksRaw, positions, settingsRow, fontRow] = await Promise.all([
    idbGetAll('books'), idbGetAll('positions'), idbGet('settings', 'reader'), idbGet('fonts', 'user-uploaded'),
  ])
  const bookmarksAll = await idbGetAll('bookmarks')
  const books = []
  for (const b of booksRaw) {
    const entry = { id: b.id, title: b.title, openedAt: b.openedAt, coverDataUrl: b.coverDataUrl }
    if (b.themeName) entry.themeName = b.themeName // per-book theme (custom themes live in settings.userThemes, exported below)
    if (includeBooks && b.file) {
      try { entry.fileDataUrl = await blobToDataUrl(b.file) } catch {}
    }
    books.push(entry)
  }
  return {
    app: 'sm_reader', version: 1, exportedAt: Date.now(),
    settings: settingsRow?.value || null, positions, books, uploadedFont: fontRow || null,
    bookmarks: bookmarksAll, // bookmarks + notes of all books (optional field, old backups lack it)
  }
}

async function importDataFile(file) {
  let payload
  try { payload = JSON.parse(await file.text()) }
  catch { alert('That file could not be read as an SM Reader backup.'); return }

  if (payload.settings) await idbPut('settings', { key: 'reader', value: payload.settings })
  for (const p of payload.positions || []) await idbPut('positions', p)
  for (const b of payload.books || []) {
    const existing = await idbGet('books', b.id)
    let fileObj = existing?.file || null
    if (b.fileDataUrl) {
      try {
        const res = await fetch(b.fileDataUrl)
        const blob = await res.blob()
        fileObj = new File([blob], (b.title || 'book') + '.epub', { type: 'application/epub+zip' })
      } catch {}
    }
    await idbPut('books', { id: b.id, title: b.title, openedAt: b.openedAt, coverDataUrl: b.coverDataUrl, file: fileObj, themeName: b.themeName })
  }
  if (payload.uploadedFont) await idbPut('fonts', payload.uploadedFont)
  // bookmarks + notes: same id overwrites; the same span in the same book is not duplicated
  if (Array.isArray(payload.bookmarks)) {
    const have = await idbGetAll('bookmarks')
    for (const b of payload.bookmarks) {
      if (!b || !b.id || b.bookId == null) continue
      const dup = have.find(h => h.id !== b.id && h.bookId === b.bookId && h.type === b.type && h.start === b.start && h.end === b.end)
      if (dup) continue
      await idbPut('bookmarks', b)
    }
    if (currentBookId != null) { await loadBookmarks(currentBookId); refreshBookmarkHighlights() }
  }

  await loadSettings()
  uploadedFontLabel = await loadUploadedFont()
  await refreshLibrary()
  renderSettings()
  alert('Import complete.')
}

/* ---------------- bookmarks & notes (2026-10-01-09-10-23) ---------------- */
// A bookmark is a span of book chars, counted exactly like the saved reading
// position (code points of counted text nodes + 1 per media element, see
// charAcceptNode), so it survives resizing and font changes.
//   { id, bookId, type: 'text' | 'page', start, end, text, note, createdAt }
// 'text' = selected text (start < end); 'page' = a page (start = its first
// char, end = start). Text bookmarks are drawn with the Custom Highlight API
// (sm-bookmark, plus sm-bookmark-note = dotted underline when a note exists).
let bookmarks = []
let bookmarksLoading = null
const bmRangesByDoc = new WeakMap() // doc -> [{ b, r }] text bookmarks drawn in that document
let bmFocus = null // { b }: bookmark picked by a tap/click on its yellow text (small bar acts on it)
let popState = null // the open popup: { kind: 'footnote' | 'bmnote' | 'meaning', sticky }
let hoverTimer = 0, hoverHideTimer = 0, hoverBmId = null, lastHoverCheck = 0
// search-mark-first-click (2026-10-03-19-21-22): the first click / tap on the page while the yellow search mark shows only
// removes it (true = the click is consumed), like a selection or the blue saved-position mark
function consumeSearchMarkClick() {
  if (!searchMark || FLAGS.SWITCH_FIRST_CLICK_CLEARS_SEARCH_MARK !== true) return false
  clearSearchMark()
  return true
}
const noteDocCache = new Map() // section index -> Document (footnotes in other files)
let menuSnap = null // { doc, index, range }: selection kept while the top-label dropdown is open
let gotoMenuMode = 'main'
let barEdit = null // { resolve }: a note being edited inside the small bar (unified-note-bar)

const getMarkColor = () => normalizeHex(settings.markColor) || normalizeHex(FLAGS.SWITCH_DEFAULT_MARK_COLOR) || '#2196f3'
const getBookmarkColor = () => normalizeHex(settings.bookmarkColor) || normalizeHex(FLAGS.SWITCH_DEFAULT_BOOKMARK_COLOR) || '#ffeb3b'
const getLinkColor = () => normalizeHex(settings.linkColor) || defaultLinkColor()
// the link color follows the page: a user's own choice (settings.linkColor) wins on every theme, otherwise the default depends on
// whether the page color is dark
function defaultLinkColor() {
  const dark = isDarkColor(resolveColor('page'))
  return normalizeHex(dark ? FLAGS.SWITCH_DEFAULT_LINK_COLOR_ON_DARK_PAGE : FLAGS.SWITCH_DEFAULT_LINK_COLOR) || (dark ? '#c9a27a' : '#000000')
}
const applyLinkColorVar = () => document.documentElement.style.setProperty('--link-color', getLinkColor()) // the app's own links (css: a)
const flagOn = (key, flag) => (settings[key] ?? (FLAGS[flag] === true)) === true
const isBmStar = () => flagOn('bmStar', 'SWITCH_DEFAULT_SHOW_BOOKMARKS_AS_ASTERISK_NEAR_BOTTOM_LABEL')
const isBmRibbon = () => flagOn('bmRibbon', 'SWITCH_DEFAULT_SHOW_BOOKMARKS_AS_ASTERISK_RIBBON')
const isRibbonClickable = () => flagOn('bmRibbonClickable', 'SWITCH_DEFAULT_BOOKMARKS_AS_ASTERISK_RIBBON_CLICKABLE')
const isRibbonSameColor = () => flagOn('bmRibbonSameColor', 'SWITCH_DEFAULT_RIBBON_SAME_COLOR_AS_BOOKMARK')
const isBmNoteHover = () => flagOn('bmNoteHover', 'SWITCH_DEFAULT_SHOW_BOOKMARK_NOTES_ON_MOUSE_OVER')
const isFnPopupOn = () => flagOn('fnPopup', 'SWITCH_DEFAULT_SHOW_FOOTNOTES_IN_POPUP_WINDOW')
const isFnHoverOn = () => flagOn('fnHover', 'SWITCH_DEFAULT_SHOW_FOOTNOTES_ON_MOUSE_OVER')
// ribbon shapes in a 20 x 34 box (no asterisk inside)
const RIBBON_SHAPES = {
  A: '0,0 20,0 20,26 10,34 0,26',
  B: '0,0 20,0 20,20 10,34 0,20',
  C: '0,0 20,0 20,34 10,26 0,34',
  D: '0,0 20,0 20,34 10,22 0,34',
  E: '3,0 17,0 17,34 10,26 3,34',
  F: '3,0 17,0 17,26 10,34 3,26',
}
const getRibbonShape = () => RIBBON_SHAPES[settings.bmRibbonShape] ? settings.bmRibbonShape
  : (RIBBON_SHAPES[FLAGS.SWITCH_DEFAULT_BOOKMARK_RIBBON_SHAPE] ? FLAGS.SWITCH_DEFAULT_BOOKMARK_RIBBON_SHAPE : 'C')
const getRibbonColor = () => isRibbonSameColor() ? getBookmarkColor()
  : (normalizeHex(settings.bmRibbonColor) || normalizeHex(FLAGS.SWITCH_DEFAULT_BOOKMARK_RIBBON_COLOR) || '#ffeb3b')
function darkenHex(hex, f) {
  const n = parseInt(normalizeHex(hex).slice(1), 16)
  const c = v => Math.round(v * (1 - f)).toString(16).padStart(2, '0')
  return '#' + c((n >> 16) & 255) + c((n >> 8) & 255) + c(n & 255)
}
const DICT_MODES = ['automatic', 'request', 'never']
// mouse-wheel-click (2026-10-09-13-26-12)
const WHEEL_CLICK_MODES = ['dictionary', 'select', 'menu', 'none']
const getWheelClick = () => WHEEL_CLICK_MODES.includes(settings.wheelClick) ? settings.wheelClick
  : (WHEEL_CLICK_MODES.includes(FLAGS.SWITCH_DEFAULT_MOUSE_WHEEL_CLICK) ? FLAGS.SWITCH_DEFAULT_MOUSE_WHEEL_CLICK : 'dictionary')
const getDictShow = () => DICT_MODES.includes(settings.dictShow) ? settings.dictShow
  : (DICT_MODES.includes(FLAGS.SWITCH_DEFAULT_DICTIONARY_SETTINGS) ? FLAGS.SWITCH_DEFAULT_DICTIONARY_SETTINGS : 'request')
// black or white, whichever reads on this color (the "n" in the ribbon)
function contrastHex(hex) {
  const n = parseInt(normalizeHex(hex).slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? '#222222' : '#ffffff'
}
const isBmBarOn = () => (settings.bmBar ?? (FLAGS.SWITCH_DEFAULT_SHOW_SMALL_BOOKMARK_BUTTON === true)) === true
function hexToRgba(hex, a) {
  const n = parseInt(normalizeHex(hex).slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
const newBmId = () => 'bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
const sortBookmarks = () => bookmarks.sort((a, b) => a.start - b.start || a.end - b.end)
async function loadBookmarks(bookId) {
  try { bookmarks = bookId == null ? [] : await idbGetAllByIndex('bookmarks', 'bookId', bookId) } catch { bookmarks = [] }
  sortBookmarks()
}
const liveContents = () => { try { return view?.renderer?.getContents?.() ?? [] } catch { return [] } }
const secBase = idx => bookCharPrefixes[idx] ?? 0
function cuOffset(str, cp) { let cu = 0, n = 0; for (const ch of str) { if (n >= cp) break; cu += ch.length; n++ } return cu }

// Range covering section-local chars [s, e) in a live book document
function rangeForSpan(doc, s, e) {
  const walker = doc.createTreeWalker(doc.body, CHAR_WALK_SHOW, { acceptNode: charAcceptNode })
  const r = doc.createRange()
  let pos = 0, startSet = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = charNodeLen(n)
    if (n.nodeType === 1) {
      if (!startSet && s < pos + 1) { r.setStartBefore(n); startSet = true }
      if (startSet && e <= pos + 1) { r.setEndAfter(n); return r }
    } else {
      const str = n.nodeValue ?? ''
      if (!startSet && s < pos + len) { r.setStart(n, cuOffset(str, s - pos)); startSet = true }
      if (startSet && e <= pos + len) { r.setEnd(n, cuOffset(str, e - pos)); return r }
    }
    pos += len
  }
  return null
}
function applyBookmarkHighlights(doc, index) {
  try {
    const win = doc?.defaultView
    if (!win?.CSS?.highlights || !win.Highlight || !bookTotalChars) return
    const base = secBase(index)
    const next = index + 1 < bookCharPrefixes.length ? bookCharPrefixes[index + 1] : bookTotalChars
    const plain = [], withNote = [], cache = []
    for (const b of bookmarks) {
      if (b.type !== 'text' || b.start < base || b.start >= next) continue
      const r = rangeForSpan(doc, b.start - base, Math.min(b.end, next) - base)
      if (!r) continue
      plain.push(r)
      cache.push({ b, r })
      if (b.note) withNote.push(r)
    }
    bmRangesByDoc.set(doc, cache)
    for (const [name, arr] of [['sm-bookmark', plain], ['sm-bookmark-note', withNote]]) {
      if (arr.length) win.CSS.highlights.set(name, new win.Highlight(...arr))
      else win.CSS.highlights.delete(name)
    }
  } catch {}
}
function refreshBookmarkHighlights() { for (const c of liveContents()) applyBookmarkHighlights(c.doc, c.index) }

function spanFromRange(doc, index, r) {
  const s = countCharsUpToRange(doc, r)
  const er = r.cloneRange(); er.collapse(false)
  const e = countCharsUpToRange(doc, er)
  if (e <= s) return null
  const text = String(r).replace(/\s+/g, ' ').trim().slice(0, 600)
  return { doc, index, start: secBase(index) + s, end: secBase(index) + e, text }
}
// the live selection in a book document, as a book-char span (null if none).
// useSnap: the top-label dropdown may use the selection remembered when it opened.
function getSelectionSpan(useSnap) {
  for (const c of liveContents()) {
    try {
      const sel = c.doc?.getSelection?.()
      if (!sel || !sel.rangeCount || sel.isCollapsed || !String(sel).trim()) continue
      const sp = spanFromRange(c.doc, c.index, sel.getRangeAt(0))
      if (sp) return sp
    } catch {}
  }
  if (useSnap && menuSnap && !menuSnap.range.collapsed) {
    try { return spanFromRange(menuSnap.doc, menuSnap.index, menuSnap.range) } catch {}
  }
  return null
}
// the visible page as a span (start = first char of the page)
function getPageSpan() { return pageSpanFromRange(view?.lastLocation?.range) }
function pageSpanFromRange(range) {
  try {
    const doc = range?.startContainer?.ownerDocument
    if (!range || !doc) return null
    if (isNoNodeRange(range)) {
      if (lastStableCharIndex == null) return null
      return { start: lastStableCharIndex, end: lastStableCharIndex, text: '' }
    }
    const c = liveContents().find(x => x.doc === doc)
    const base = secBase(c?.index ?? 0)
    const s = countCharsUpToRange(doc, range)
    const er = range.cloneRange(); er.collapse(false)
    const e = countCharsUpToRange(doc, er)
    return { start: base + s, end: base + Math.max(e, s), text: String(range).replace(/\s+/g, ' ').trim().slice(0, 160) }
  } catch { return null }
}
const bmOverlap = sp => bookmarks.filter(b => b.type === 'text' ? (b.start < sp.end && b.end > sp.start) : (b.start >= sp.start && b.start < sp.end))
// text bookmarks only (a page bookmark inside a selection is neither merged nor removed with it)
const bmOverlapText = sp => bmOverlap(sp).filter(b => b.type === 'text')
// page-bm-onpage (2026-10-03-08-47-15): the visible range is about TWO pages long (log: a page's end lands near the start
// of the page after next), so no start/end comparison can tell which page a bookmark is on. A page bookmark is on this
// page when its first char is the page start or is drawn inside the current page window (paginator.rangeStartOnPage)
function bmOnPage(b, pg) {
  if (b.start === pg.start) return true
  if (pg.end <= pg.start || b.start < pg.start || b.start >= pg.end) return false
  try {
    const doc = view?.lastLocation?.range?.startContainer?.ownerDocument
    const c = doc && liveContents().find(x => x.doc === doc)
    if (!c) return false
    const base = secBase(c.index)
    const r = rangeForSpan(doc, b.start - base, b.start - base + 1)
    return !!r && view.renderer?.rangeStartOnPage?.(r) === true
  } catch { return false }
}
const bmPageHere = pg => bookmarks.filter(b => b.type === 'page' && bmOnPage(b, pg))

async function bmSave(b) {
  const rec = { id: newBmId(), bookId: currentBookId, createdAt: Date.now(), note: '', ...b }
  await idbPut('bookmarks', rec)
  bookmarks.push(rec); sortBookmarks()
  return rec
}
async function bmDelete(b) {
  await idbDelete('bookmarks', b.id)
  bookmarks = bookmarks.filter(x => x.id !== b.id)
}
function bmChanged() {
  refreshBookmarkHighlights()
  updateBmBar()
  updateBookmarkMarkers()
  if ($('#bookmarks-view')?.classList.contains('show')) renderBookmarksView()
}
function clearBookSelectionOf(doc) { selDbg('clear', doc, { where: 'clearBookSelectionOf' }); try { doc?.getSelection?.()?.removeAllRanges() } catch {} ; menuSnap = null }

// Bookmark (withNote = false) or Note (withNote = true) for the selected text.
// Overlapping old bookmarks are replaced by the new one; the note box starts
// with the old note when exactly one old bookmark overlaps.
async function bmAddSelection(withNote, useSnap) {
  const sp = getSelectionSpan(useSnap)
  if (!sp || currentBookId == null) return
  // note-widgets-round-2 (2026-10-03-08-47-15): a selection that overlaps existing text bookmarks extends them: one
  // bookmark over the union of the selection and the overlapped ones, their notes kept (joined by a blank line)
  const over = bmOverlapText(sp)
  const oldNotes = over.map(b => b.note).filter(Boolean).join('\n\n')
  let note = oldNotes
  if (withNote) {
    const res = await openNoteBox(sp.text, oldNotes)
    if (res === null) return
    note = res
  }
  let start = sp.start, end = sp.end, text = sp.text
  if (over.length) {
    start = Math.min(sp.start, ...over.map(b => b.start))
    end = Math.max(sp.end, ...over.map(b => b.end))
    if (start !== sp.start || end !== sp.end) {
      try {
        const base = secBase(sp.index)
        const r = rangeForSpan(sp.doc, start - base, end - base)
        if (r) text = String(r).replace(/\s+/g, ' ').trim().slice(0, 600)
      } catch {}
    }
  }
  for (const b of over) await bmDelete(b)
  await bmSave({ type: 'text', start, end, text, note })
  clearBookSelectionOf(sp.doc)
  bmChanged()
}
// Bookmark (withNote false) or Note (true) for the current page
async function bmAddPage(withNote) {
  const pg = getPageSpan()
  if (!pg || currentBookId == null) return
  const here = bmPageHere(pg)
  if (!withNote) {
    if (!here.length) await bmSave({ type: 'page', start: pg.start, end: pg.start, text: pg.text, note: '' })
    bmChanged()
    return
  }
  const res = await openNoteBox(pg.text || formatPct(pg.start / Math.max(1, bookTotalChars)), here[0]?.note || '')
  if (res === null) return
  if (here[0]) { here[0].note = res; await idbPut('bookmarks', here[0]) }
  else await bmSave({ type: 'page', start: pg.start, end: pg.start, text: pg.text, note: res })
  bmChanged()
}
// bookmark the Edit / Remove commands act on: under the selection, else on this page
function bmTargets(useSnap) {
  const sp = getSelectionSpan(useSnap)
  if (sp) return { sp, list: bmOverlapText(sp) }
  const pg = getPageSpan()
  return { sp: null, list: pg ? bmPageHere(pg) : [] }
}
async function bmRemoveHere(useSnap) {
  const { sp, list } = bmTargets(useSnap)
  for (const b of list) await bmDelete(b)
  if (sp) clearBookSelectionOf(sp.doc)
  bmChanged()
}
async function bmRemoveAll() {
  if (!bookmarks.length) return
  if (!confirm(`Remove all ${bookmarks.length} bookmarks and notes of this book?`)) return
  for (const b of [...bookmarks]) await bmDelete(b)
  bmChanged()
}

/* note editor (note-widgets-round-2, 2026-10-03-08-47-15): ONE editor for every note edit (top menu, bar, ribbon,
   Bookmarks list, old popup): the floating bar turns into a text box with Cancel / Save, no page text, no dimming.
   It does not depend on the small-bar setting and also works over the lists. The old centered note box is gone. */
const readerOverlayShown = () => ['#library-view', '#settings-view', '#bookmarks-view'].some(id => $(id)?.classList.contains('show'))
function openNoteBox(snippet, note) { // snippet is not shown any more (kept so the callers stay as they are)
  return new Promise(resolve => {
    if (barEdit) closeBarEdit(null)
    barEdit = { resolve }
    $('#bm-edit').value = note || ''
    updateBmBar()
    setTimeout(() => { const t = $('#bm-edit'); t.focus(); try { t.setSelectionRange(t.value.length, t.value.length) } catch {} }, 30)
  })
}
function closeBarEdit(result) {
  const r = barEdit?.resolve
  barEdit = null
  if (r) r(result)
  updateBmBar()
}

/* small bar: Bookmark / Note / Remove (unified-note-bar, 2026-10-02-12-34-13).
   One format for every note view: shown while book text is selected, after a tap/click on yellow text,
   on mouse-over of yellow text with a note, and on the ribbon (hover, or click when the page has a note).
   Pressing Note edits inside the bar (text box, Cancel / Save). */
/* page bounds (reader-polish-2): the small bar, its note and the popup stay inside the book page, not the window */
function pageBounds() {
  const r = $('#book-page')?.getBoundingClientRect()
  if (r && r.width > 160) return { left: Math.max(0, r.left), right: Math.min(window.innerWidth, r.right) }
  return { left: 0, right: window.innerWidth }
}
// a width switch value (px) shrunk to fit the page
function fitWidth(want, fallback) {
  const pb = pageBounds()
  return Math.max(120, Math.min(Number(want) || fallback, pb.right - pb.left - 16))
}
function placeBmBar(bar, anchor, editing) {
  if (bar.classList.contains('hidden')) return
  const s = bar.style
  const pb = bar.id === 'bm-bar' ? pageBounds() : { left: 0, right: window.innerWidth } // the position bar may sit outside the page
  if (editing) { // clear of the soft keyboard; centered on the page, never wider than it
    s.width = Math.min(420, pb.right - pb.left - 16) + 'px'
    s.left = ((pb.left + pb.right) / 2) + 'px'; s.top = '12vh'; s.bottom = 'auto'; s.transform = 'translateX(-50%)'; return
  }
  s.width = ''
  if (!anchor) { s.left = ''; s.top = ''; s.bottom = ''; s.transform = ''; return }
  s.transform = 'none'; s.bottom = 'auto'; s.left = '0px' // measure at the left edge so shrink-to-fit width is the natural one
  const w = bar.offsetWidth, h = bar.offsetHeight
  const left = Math.min(Math.max(pb.left + 8, anchor.left), Math.max(pb.left + 8, pb.right - w - 8))
  let top = anchor.bottom + (anchor.sel && isTouchPointer() ? 36 : 8) // touch: clear of the selection handles
  if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - 8 - h)
  s.left = left + 'px'; s.top = top + 'px'
}
/* selection coverage (bookmark-disabled-and-coverage, 2026-10-03-09-34-00): does a selection add any text that is not
   already inside a text bookmark? */
// walk the book chars of a live section document in section-local positions [s, e): fn(pos, ch); ch is null for a media
// element (counts as one char); fn returning false stops the walk
function eachCharInSpan(doc, s, e, fn) {
  const walker = doc.createTreeWalker(doc.body, CHAR_WALK_SHOW, { acceptNode: charAcceptNode })
  let pos = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (pos >= e) return
    const len = charNodeLen(n)
    if (pos + len <= s) { pos += len; continue }
    if (n.nodeType === 1) { if (fn(pos, null) === false) return; pos++; continue }
    for (const ch of (n.nodeValue ?? '')) {
      if (pos >= e) return
      if (pos >= s && fn(pos, ch) === false) return
      pos++
    }
  }
}
// true when the selection holds at least one non-ignorable char (not whitespace, optionally not punctuation) that no
// text bookmark covers; also true when nothing overlaps or anything goes wrong (then the button stays enabled)
function selectionAddsText(sp) {
  try {
    const over = bmOverlapText(sp)
    if (!over.length) return true
    const base = secBase(sp.index)
    const noPunct = FLAGS.SWITCH_SELECTION_COVERAGE_IGNORES_PUNCTUATION === true
    const cov = []
    for (const [a, b] of over.map(b => [b.start - base, b.end - base]).sort((x, y) => x[0] - y[0])) {
      const l = cov[cov.length - 1]
      if (l && a <= l[1]) l[1] = Math.max(l[1], b); else cov.push([a, b])
    }
    let adds = false
    eachCharInSpan(sp.doc, sp.start - base, sp.end - base, (pos, ch) => {
      if (ch !== null && (/\s/.test(ch) || (noPunct && /\p{P}/u.test(ch)))) return true
      if (cov.some(([a, b]) => pos >= a && pos < b)) return true
      adds = true
      return false
    })
    return adds
  } catch { return true }
}
// small bar state (bookmark-bar-v2, 2026-10-04-12-11-11): marked = the check before "Bookmark" (a bookmark in focus, or a
// selection that lies entirely inside text bookmarks); hasNote = the check before "Note" (the bookmark(s) have a note)
function bmBarState(focus, sp, over) {
  if (focus) return { marked: true, hasNote: !!focus.b.note }
  if (sp && over.length) return { marked: !selectionAddsText(sp), hasNote: over.some(b => b.note) }
  return { marked: false, hasNote: false }
}
const BM_BAR_BUTTONS = { meaning: 'bm-meaning', copy: 'bm-copy', bookmark: 'bm-bookmark', note: 'bm-note' }
// ids of the buttons listed in SWITCH_BOOKMARK_MENU, in that order (unknown names and repeats ignored)
function barButtonIds() {
  const ids = []
  for (const name of Array.isArray(FLAGS.SWITCH_BOOKMARK_MENU) ? FLAGS.SWITCH_BOOKMARK_MENU : []) {
    const id = BM_BAR_BUTTONS[String(name).trim().toLowerCase()]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}
// order the buttons once (moving a button while it is pressed could lose the click)
function orderBarButtons() {
  const row = $('#bm-row-main')
  for (const id of barButtonIds()) row.appendChild($('#' + id))
}
function setBarLabel(el, name, checked) {
  const t = (checked ? '✓ ' : '') + name
  if (el.textContent !== t) el.textContent = t
}
/* dictionary (dictionary-meaning, 2026-10-04-12-11-11; bundled import and lookup: dictionary-bundled-import, 2026-10-04-14-44-09).
   The English dictionary is Open English WordNet 2025, trimmed (definitions only), shipped as dict/oewn-2025.json.gz and
   imported ONCE into IndexedDB (stores dictInfo, dictEntries, dictForms) by js/dict-worker.js, a Web Worker, so the page
   never blocks. A dictionary file chosen in Settings (same JSON Lines format, gzip or plain) is imported the same way.
   Lookups read IndexedDB only (no network). Imported dictionaries are not part of the Export backup (size). */
const BUNDLED_DICT = { id: 'oewn-2025', url: FLAGS.SWITCH_DICT_BUNDLED_FILE || './dict/oewn-2025.json.gz', build: 3, name: 'Open English WordNet 2025' } // build 3: irregular forms carry their part of speech (p); build 2: storage layout 2 (word chunks); an older copy is replaced
const DICT_FILE_OPTION = '__file__' // the "Choose a file…" entry of the Dictionary file combo
const DICT_LOAD_MODES = ['start', 'settings', 'use', 'never']
const getDictLoad = () => DICT_LOAD_MODES.includes(settings.dictLoad) ? settings.dictLoad
  : (DICT_LOAD_MODES.includes(FLAGS.SWITCH_DEFAULT_LOAD_DICTIONARY) ? FLAGS.SWITCH_DEFAULT_LOAD_DICTIONARY : 'start')
let dictInfos = [] // complete dictInfo records (cache; see refreshDictInfos)
let dictInfosLoaded = false
const dictState = { importing: false, removing: false, pct: 0, error: '' }
const dictInstalled = id => dictInfos.find(i => i.id === id) || null
// update-notices (2026-10-06-20-20-00): the installed bundled dictionary is older than the one shipped in the app
const dictOutdated = info => !!info && info.id === BUNDLED_DICT.id && (info.build | 0) < BUNDLED_DICT.build
// the dictionary lookups use: the one chosen in Settings if it is installed, else the bundled one
const getDictId = () => (settings.dictId && dictInstalled(settings.dictId)) ? settings.dictId : BUNDLED_DICT.id
async function refreshDictInfos() {
  // layout 2 = word chunks (dict-chunked-store); a copy in the old one-record-per-word layout counts as not installed
  try { dictInfos = (await idbGetAll('dictInfo')).filter(i => i && i.complete === true && i.layout === 2) } catch { dictInfos = [] }
  dictInfosLoaded = true
}
// status line and buttons of Settings > Dictionary (cheap: also called on every progress step)
function renderDictStatus() {
  const st = $('#dict-status')
  if (!st) return
  const info = dictInstalled(getDictId())
  const busy = dictState.importing || dictState.removing
  let t
  if (dictState.importing) t = `Importing… ${dictState.pct}%`
  else if (dictState.removing) t = 'Removing…'
  else if (dictState.error) t = dictState.error
  else if (info) t = `Installed: ${info.name}, ${Number(info.entries || 0).toLocaleString('en-US')} words` + (dictOutdated(info) ? ' · update available' : '')
  else t = 'Not imported'
  st.textContent = t
  $('#dict-import-btn').disabled = busy
  $('#dict-import-btn').textContent = dictOutdated(info) ? 'Update dictionary' : 'Import dictionary'
  $('#dict-remove-btn').disabled = busy || !info
  $('#dict-file').disabled = busy
}
// whole Dictionary group (rebuilds the combo, so not called on progress steps)
function renderDictUi() {
  const sel = $('#dict-file')
  if (!sel) return
  sel.replaceChildren()
  const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o) }
  add(BUNDLED_DICT.id, BUNDLED_DICT.name + ' (bundled)')
  for (const i of dictInfos) if (i.id !== BUNDLED_DICT.id) add(i.id, i.name || i.id)
  add(DICT_FILE_OPTION, 'Choose a file…')
  sel.value = getDictId()
  $('#dict-load').value = getDictLoad()
  renderDictStatus()
}
// Import in the worker: bundled = the file shipped in dict/, else `file` (a File chosen by the user). Resolves true / false.
function startDictImport({ file = null, bundled = false, reason = '' }) {
  if (dictState.importing || dictState.removing) { dictLog('import-ignored', { reason, why: dictState.importing ? 'already importing' : 'removing' }); return Promise.resolve(false) }
  dictState.importing = true; dictState.pct = 0; dictState.error = ''
  dictLogT0.t = Date.now()
  const hadDict = bundled && !!dictInstalled(BUNDLED_DICT.id) // install-toast: a re-import of an installed dictionary is an update
  dictLog('import-start', {
    reason, source: file ? 'file ' + file.name + ' (' + file.size + ' bytes)' : BUNDLED_DICT.url,
    batch: FLAGS.SWITCH_DICT_IMPORT_BATCH_SIZE, chunk: FLAGS.SWITCH_DICT_CHUNK_ENTRIES, relaxed: FLAGS.SWITCH_DICT_IMPORT_RELAXED_DURABILITY === true,
  })
  renderDictStatus()
  return new Promise(resolve => {
    let worker = null, ended = false, lastBucket = -1
    const finish = (ok, msg, info, silent) => {
      if (ended) return
      ended = true
      dictLog(ok ? 'import-done' : silent ? 'import-cancelled' : 'import-failed',
        ok ? { entries: info?.entries, forms: info?.forms } : { error: msg || '' })
      try { worker?.terminate() } catch {}
      dictState.importing = false
      if (!ok && !silent) dictState.error = 'Import failed: ' + (msg || 'unknown error')
      refreshDictInfos().then(async () => {
        if (ok && info && !bundled) { settings.dictId = info.id; await saveSettings() } // a chosen file becomes the selected dictionary
        renderDictUi()
        updateLiveMeaning(ok ? 'done' : 'failed')
        if (ok) { if (hadDict) toastUnlessSettings('Dictionary updated'); installDone('dict') }
        else if (installState.dict) { installState.dict = false; installState.fired = true } // a failure: no "Install complete"
        dictLogT0.t = 0
        resolve(ok)
      })
    }
    try { worker = new Worker('./js/dict-worker.js') } catch (err) { finish(false, err?.message || 'cannot start the import worker'); return }
    worker.onmessage = ev => {
      const m = ev.data || {}
      if (m.type === 'progress') {
        dictState.pct = m.pct; renderDictStatus()
        const log = Math.floor(m.pct / 5) > lastBucket // log when a 5 % step is crossed, the popup itself follows every step
        if (log) { lastBucket = Math.floor(m.pct / 5); dictLog('progress', { pct: m.pct }) }
        updateLiveMeaning('progress', log)
      }
      else if (m.type === 'started') { dictLog('worker-started', { id: m.id }); dictInfos = dictInfos.filter(i => i.id !== m.id); renderDictUi() } // its old data is being replaced
      else if (m.type === 'timing') dictLog('timing', { gz: m.gz, readMs: m.readMs, parseMs: m.parseMs, writeMs: m.writeMs, wipeMs: m.wipeMs, totalMs: m.totalMs, batches: m.batches, batchSize: m.batchSize, chunks: m.chunks, chunkEntries: m.chunkEntries, relaxed: m.relaxed, bytes: m.bytes, chars: m.chars })
      else if (m.type === 'done') finish(true, '', m.info)
      else if (m.type === 'error') finish(false, m.message)
      else if (m.type === 'exists') { dictLog('already-imported', { name: m.name }); askYesNo(`"${m.name}" is already imported. Import it again?`).then(yes => { dictLog('answer', { yes }); if (!ended) worker.postMessage({ cmd: 'answer', yes }) }) }
      else if (m.type === 'cancelled') finish(false, '', null, true)
    }
    worker.onerror = ev => finish(false, ev?.message || 'the import worker failed')
    worker.postMessage({
      cmd: 'import', dbName: DB_NAME, bundled, id: bundled ? BUNDLED_DICT.id : null, build: bundled ? BUNDLED_DICT.build : 0, askIfExists: !!file,
      batchSize: FLAGS.SWITCH_DICT_IMPORT_BATCH_SIZE, chunkEntries: FLAGS.SWITCH_DICT_CHUNK_ENTRIES, relaxed: FLAGS.SWITCH_DICT_IMPORT_RELAXED_DURABILITY === true,
      url: bundled ? new URL(BUNDLED_DICT.url, location.href).href : null, file,
    })
  })
}
async function removeDict(id) {
  if (dictState.importing || dictState.removing) return
  dictState.removing = true; dictState.error = ''
  renderDictStatus()
  try {
    const db = await openDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['dictInfo', 'dictEntries', 'dictForms'], 'readwrite')
      tx.objectStore('dictEntries').delete(IDBKeyRange.bound([id], [id, []]))
      tx.objectStore('dictForms').delete(IDBKeyRange.bound([id], [id, []]))
      tx.objectStore('dictInfo').delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('aborted'))
    })
    if (settings.dictId === id) { settings.dictId = null; await saveSettings() }
  } catch (err) { dictState.error = 'Remove failed: ' + (err?.message || err) }
  dictState.removing = false
  await refreshDictInfos()
  renderDictUi()
}
// mode "start": import the bundled dictionary in the background when it is not installed (or an older build is)
async function maybeImportBundledAtStart() {
  if (getDictLoad() !== 'start' || getDictShow() === 'never') return
  if (!dictInfosLoaded) await refreshDictInfos()
  const i = dictInstalled(BUNDLED_DICT.id)
  if (i && (i.build | 0) >= BUNDLED_DICT.build) return
  startDictImport({ bundled: true, reason: 'start' })
}
// Yes / No question (reader-polish-2). "No" is the default: it has the focus, and Esc or a click outside answer No.
// Every key is kept from the page while it is open (no page turn). Resolves true only for Yes.
function askYesNo(text) {
  return new Promise(resolve => {
    const shield = $('#yn-shield'), box = $('#yn-box'), yes = $('#yn-yes'), no = $('#yn-no')
    $('#yn-cancel').classList.add('hidden') // the 3-way button belongs to askYesNoCancel() only
    box.style.background = resolveColor('page')
    box.style.color = resolveColor('font')
    $('#yn-text').textContent = text
    const done = v => {
      shield.classList.add('hidden')
      yes.removeEventListener('click', onYes); no.removeEventListener('click', onNo)
      shield.removeEventListener('click', onShield); document.removeEventListener('keydown', onKey, true)
      resolve(v)
    }
    const onYes = () => done(true), onNo = () => done(false)
    const onShield = e => { if (e.target === shield) done(false) }
    const onKey = e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(false) } }
    yes.addEventListener('click', onYes); no.addEventListener('click', onNo)
    shield.addEventListener('click', onShield); document.addEventListener('keydown', onKey, true)
    shield.classList.remove('hidden')
    no.focus()
  })
}
// export-books-missing-locate (2026-10-10-17-07-57): Yes/No/Cancel version of the question above
// (mismatched book file). askYesNo() and its callers are untouched. Esc and a click outside = Cancel;
// No keeps the focus, like above. Returns 'yes', 'no' or 'cancel'.
function askYesNoCancel(text) {
  return new Promise(resolve => {
    const shield = $('#yn-shield'), box = $('#yn-box'), yes = $('#yn-yes'), no = $('#yn-no'), cancel = $('#yn-cancel')
    cancel.classList.remove('hidden')
    box.style.background = resolveColor('page')
    box.style.color = resolveColor('font')
    $('#yn-text').textContent = text
    const done = v => {
      shield.classList.add('hidden')
      cancel.classList.add('hidden')
      yes.removeEventListener('click', onYes); no.removeEventListener('click', onNo); cancel.removeEventListener('click', onCancel)
      shield.removeEventListener('click', onShield); document.removeEventListener('keydown', onKey, true)
      resolve(v)
    }
    const onYes = () => done('yes'), onNo = () => done('no'), onCancel = () => done('cancel')
    const onShield = e => { if (e.target === shield) done('cancel') }
    const onKey = e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done('cancel') } }
    yes.addEventListener('click', onYes); no.addEventListener('click', onNo); cancel.addEventListener('click', onCancel)
    shield.addEventListener('click', onShield); document.addEventListener('keydown', onKey, true)
    shield.classList.remove('hidden')
    no.focus()
  })
}
function wireDictionaryUi() {
  $('#dict-load').addEventListener('change', e => { settings.dictLoad = e.target.value; saveSettings() })
  $('#dict-file').addEventListener('change', e => {
    const v = e.target.value
    if (v === DICT_FILE_OPTION) { e.target.value = getDictId(); $('#dict-file-input').click(); return }
    settings.dictId = v === BUNDLED_DICT.id ? null : v
    dictState.error = ''
    saveSettings(); renderDictStatus()
  })
  // Import / Remove act on the dictionary selected in the combo; an imported one can only be re-imported from its file
  // (reader-polish-2) importing what is already installed asks first, "No" is the default; a chosen file is checked by the worker
  $('#dict-import-btn').addEventListener('click', async () => {
    const id = getDictId()
    if (id !== BUNDLED_DICT.id) { $('#dict-file-input').click(); return }
    const inst = dictInstalled(id)
    if (inst && !dictOutdated(inst) && !(await askYesNo('This dictionary is already imported. Import it again?'))) return // an update is not asked about
    startDictImport({ bundled: true, reason: dictOutdated(inst) ? 'update' : 'import-button' })
  })
  $('#dict-remove-btn').addEventListener('click', () => removeDict(getDictId()))
  $('#dict-file-input').addEventListener('change', e => {
    const f = e.target.files[0]
    e.target.value = '' // the same file can be chosen again
    if (f) startDictImport({ file: f, reason: 'file' })
  })
}
// dict-merge-roots (2026-10-05-11-59-40): regular endings -> candidate root words, in the order they are tried, each with the
// parts of speech the ending applies to ('nv' = noun and verb senses: -s -es -ies; 'v' = verb senses: -ed -ied -ing). A root
// shorter than 3 letters is only taken for 'v' (going -> go, doing -> do); nouns never from a word ending in 'ss' (pass).
// The part of speech filter keeps the roots honest: thing -> "the" has no verb sense, gas -> "ga" is too short.
function dictRoots(w) {
  const out = []
  const add = (stem, pos) => { if (stem.length >= (pos === 'v' ? 2 : 3) && stem !== w && !out.some(o => o.stem === stem)) out.push({ stem, pos }) }
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y', 'nv')
  if (w.endsWith('es')) add(w.slice(0, -2), 'nv')
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1), 'nv')
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y', 'v')
  if (w.endsWith('ed')) { add(w.slice(0, -2), 'v'); add(w.slice(0, -1), 'v') }
  if (w.endsWith('ing')) { add(w.slice(0, -3), 'v'); add(w.slice(0, -3) + 'e', 'v') }
  return out
}
// the parts of speech of an irregular form's headword ("v", "nv") -> array of letters; absent (older files) = all senses
const dictPosOnly = s => (typeof s === 'string' && s) ? s.split('') : null
const dictReq = (store, key) => new Promise((resolve, reject) => {
  const q = store.get(key)
  q.onsuccess = () => resolve(q.result || null)
  q.onerror = () => reject(q.error)
})
// a word's entry {w, g} from the chunked store (layout 2): the last chunk whose first word is <= the word, then a scan of it
const dictEntryReq = (store, id, w) => new Promise((resolve, reject) => {
  const q = store.openCursor(IDBKeyRange.bound([id], [id, w]), 'prev')
  q.onsuccess = () => {
    const cur = q.result
    const hit = cur && Array.isArray(cur.value.c) ? cur.value.c.find(x => x[0] === w) : null
    resolve(hit ? { w, g: hit[1] } : null)
  }
  q.onerror = () => reject(q.error)
})
// All of these are shown, in this order, each headword once (dict-merge-roots): the word's own entry; the headwords of the
// irregular forms table (was -> be, saw -> see); the roots of the regular endings (flies -> fly), see dictRoots(). So "flies"
// shows the theater noun AND fly, "played" the adjective AND play. Every group carries its headword (head) for the label.
async function dictLookup(id, word) {
  const w = word.toLowerCase().replace(/[\u2018\u2019]/g, "'")
  const roots = dictRoots(w)
  const db = await openDB()
  const tx = db.transaction(['dictEntries', 'dictForms'], 'readonly')
  const E = tx.objectStore('dictEntries'), F = tx.objectStore('dictForms')
  const [exact, form, ...rootHits] = await Promise.all([dictEntryReq(E, id, w), dictReq(F, [id, w]), ...roots.map(r => dictEntryReq(E, id, r.stem))])
  const groups = []
  const seen = new Set()
  const take = (en, only) => { // only = the parts of speech to keep (null = all)
    if (!en || seen.has(en.w)) return
    const gs = (en.g || []).filter(g => !only || only.includes(g[0]))
    if (!gs.length) return
    seen.add(en.w)
    for (const g of gs) groups.push({ pos: g[0], defs: Array.isArray(g[1]) ? g[1] : [], orig: g[2] || null, head: en.w })
  }
  take(exact, null)
  if (form && Array.isArray(form.h) && form.h.length) {
    const tx2 = db.transaction('dictEntries', 'readonly')
    const hs = await Promise.all(form.h.map(h => dictEntryReq(tx2.objectStore('dictEntries'), id, h)))
    hs.forEach((en, i) => take(en, dictPosOnly(form.p?.[i]))) // was -> be: the verb senses only (file made with the form part of speech)
  }
  roots.forEach((r, i) => take(rootHits[i], r.pos === 'v' ? ['v'] : ['n', 'v']))
  return groups.length ? { status: 'ok', groups } : { status: 'not-found' }
}
// { status: 'ok', groups } | { status: 'loading', pct } | { status: 'none' } | { status: 'not-found' } | { status: 'error' }
async function lookupMeaning(word) {
  try {
    if (!dictInfosLoaded) await refreshDictInfos()
    const id = getDictId()
    if (!dictInstalled(id)) {
      if (dictState.importing) return { status: 'loading', pct: dictState.pct }
      // mode "use": the first lookup imports the bundled dictionary; the user looks again when it is done
      if (id === BUNDLED_DICT.id && getDictLoad() === 'use' && getDictShow() !== 'never') {
        startDictImport({ bundled: true, reason: 'first-lookup' })
        return { status: 'loading', pct: 0 }
      }
      return { status: 'none' }
    }
    return await dictLookup(id, word)
  } catch { return { status: 'error' } }
}
const meaningWord = text => String(text).trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
const isOneWord = text => { const w = meaningWord(text); return !!w && !/\s/.test(w) }
// text of a text bookmark, re-read from its drawn range in the live document (the saved snippet is cut and has its
// whitespace collapsed); '' for a page bookmark or when the bookmark is not drawn
function bmFocusText(b) {
  if (!b || b.type !== 'text') return ''
  for (const c of liveContents()) {
    const hit = bmRangesByDoc.get(c.doc)?.find(x => x.b === b)
    if (hit) { try { return String(hit.r) } catch {} }
  }
  return b.text || ''
}
// what Copy / Meaning on the small bar act on: the bookmark in focus (click / tap on yellow text, mouse-over), else the
// selection; null = nothing (page bookmark, no selection)
function barSubject() {
  if (bmFocus) {
    const t = bmFocusText(bmFocus.b)
    return t.trim() ? { text: t, anchor: bmFocus.anchor ?? null, sp: null } : null
  }
  const sp = getSelectionSpan(false)
  if (!sp) return null
  let text = ''
  try { text = String(sp.doc.getSelection()) } catch {}
  if (!text.trim()) text = sp.text
  return { text, anchor: selAnchor(sp), sp }
}
// the bar has done its job: drop the selection, or the bookmark focus
function barSubjectDone(sub) {
  if (sub.sp) clearBookSelectionOf(sub.sp.doc); else bmFocus = null
  updateBmBar()
}
const DICT_POS = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' }
// popup body: definitions grouped by part of speech, numbered; or a message
function meaningNode(res, word) {
  const node = document.createElement('div')
  node.className = 'pop-text'
  if (res.status !== 'ok') {
    node.textContent = res.status === 'loading' ? `Loading dictionary… ${res.pct}%`
      : res.status === 'not-found' ? `No entry for "${word}".`
      : res.status === 'error' ? 'Dictionary lookup failed.'
      : 'No dictionary imported.'
    return node
  }
  for (const g of res.groups) {
    const h = document.createElement('div')
    h.style.cssText = 'font-style:italic;opacity:.7;margin:.5em 0 .15em'
    // label (dict-merge-roots): the headword when the senses belong to another word (verb · fly), the original spelling when it differs (noun · Paris)
    const lbl = g.orig || g.head || ''
    const differs = lbl && ((g.orig && g.orig !== word) || lbl.toLowerCase() !== word.toLowerCase())
    h.textContent = (DICT_POS[g.pos] || g.pos) + (differs ? ' · ' + lbl : '')
    const ol = document.createElement('ol')
    ol.style.cssText = 'margin:0;padding-left:1.4em'
    for (const d of g.defs) { const li = document.createElement('li'); li.textContent = d; ol.appendChild(li) }
    node.append(h, ol)
  }
  return node
}
/* dict-loading-live (2026-10-05-09-11-50): while the dictionary loads, the Meaning popup follows the import. It shows the
   running percentage and, when the import is done, replaces itself with the definition of the same word (also with
   "Import dictionary at: First lookup", where the first lookup starts the import). It stops following when the popup is closed
   or taken over by another popup. Automatic mode shows no popup while loading. */
let meaningLive = null // { word, title, node, anchor } of the Meaning popup that shows "Loading dictionary… N%"
async function updateLiveMeaning(state, log) {
  const L = meaningLive
  if (!L) return
  if (!L.node.isConnected || popState?.kind !== 'meaning') { meaningLive = null; dictLog('popup-gone', { word: L.word }); return }
  if (state === 'progress') {
    L.node.textContent = `Loading dictionary… ${dictState.pct}%`
    if (log) dictLog('popup-live', { word: L.word, pct: dictState.pct })
    return
  }
  meaningLive = null
  if (state === 'failed') { // the error text stays in the popup
    L.node.textContent = dictState.error || 'Import cancelled.'
    dictLog('popup-error', { word: L.word, text: L.node.textContent })
    return
  }
  const res = await lookupMeaning(L.word)
  if (!L.node.isConnected || popState?.kind !== 'meaning') { dictLog('popup-gone', { word: L.word }); return } // closed meanwhile
  dictLog('popup-replaced', { word: L.word, status: res.status })
  showPopup({ kind: 'meaning', title: L.title, node: meaningNode(res, L.word), anchor: L.anchor, sticky: true })
}
// SWITCH_DEBUG_LOADING_DICT_LOG: one line per event in the dev server terminal (GET /__debug?event=dict-...)
const dictLogT0 = { t: 0 } // start of the running import (0 = none)
function dictLog(event, extra = {}) {
  if (FLAGS.SWITCH_DEBUG_LOADING_DICT_LOG !== true) return
  try {
    const d = new Date()
    const ts = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0') // the phone's clock
    const enc = encodeURIComponent
    let q = `event=${enc('dict-' + event)}&ts=${enc(ts)}`
    let txt = `[SM DICT] ${ts} dict-${event}`
    if (dictLogT0.t) { const t = '+' + (Date.now() - dictLogT0.t) + 'ms'; q += `&t=${enc(t)}`; txt += ` ${t}` }
    for (const [k, v] of Object.entries(extra)) { q += `&${enc(k)}=${enc(String(v))}`; txt += ` ${k}=${String(v)}` }
    fetch(`/__debug?${q}`, { cache: 'no-store', method: 'GET' }).catch(() => {})
    if (FLAGS.SWITCH_LOG_DEBUG_TO_BROWSER_CONSOLE) console.log(txt)
  } catch {}
}
async function showMeaning(text, anchor, auto) {
  const word = meaningWord(text)
  if (!word) return
  const res = await lookupMeaning(word)
  dictLog('lookup', { word, status: res.status, pct: res.pct ?? '', auto: !!auto })
  if (auto && res.status !== 'ok') return // automatic mode shows nothing unless there is a meaning
  const title = word.length > 40 ? word.slice(0, 40) + '…' : word
  const node = meaningNode(res, word)
  showPopup({ kind: 'meaning', title, node, anchor, sticky: true })
  meaningLive = res.status === 'loading' ? { word, title, node, anchor } : null // see updateLiveMeaning
}
// automatic mode: one selected word, still selected after a short wait, popup under the bar (once per selection)
let autoMeaningTimer = 0, autoMeaningKey = ''
function scheduleAutoMeaning(sp) {
  clearTimeout(autoMeaningTimer)
  if (!sp) { autoMeaningKey = ''; return }
  const key = sp.start + ':' + sp.end
  if (getDictShow() !== 'automatic' || key === autoMeaningKey) return
  if (FLAGS.SWITCH_DICTIONARY_USES_ONLY_ONE_WORD === true ? !isOneWord(sp.text) : sp.text.trim().length > 60) return
  autoMeaningTimer = setTimeout(() => {
    const cur = getSelectionSpan(false)
    if (!cur || cur.start + ':' + cur.end !== key) return
    autoMeaningKey = key
    const r = $('#bm-bar').getBoundingClientRect()
    showMeaning(cur.text, { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, true)
  }, 500)
}
// outer-window rect of the live selection (first line top .. last line bottom), for placing the bar next to it
function selAnchor(sp) {
  try {
    const rg = sp.doc.getSelection().getRangeAt(0)
    const rects = [...rg.getClientRects()].filter(r => r.width || r.height)
    if (!rects.length) return null
    const o1 = toOuterRect(sp.doc, rects[0]), o2 = toOuterRect(sp.doc, rects[rects.length - 1])
    return { left: o2.left, right: o2.right, top: o1.top, bottom: o2.bottom, sel: true }
  } catch { return null }
}
function updateBmBar() {
  const bar = $('#bm-bar')
  if (!bar) return
  const overlayShown = readerOverlayShown()
  if (bmFocus && !bookmarks.includes(bmFocus.b)) bmFocus = null
  const canShow = isBmBarOn() && view && !overlayShown
  const editing = !!barEdit // the editor works over the lists too and does not depend on the bar setting
  const live = canShow && !editing
  const focus = live ? bmFocus : null
  const sp = live && !focus ? getSelectionSpan(false) : null
  const over = sp ? bmOverlapText(sp) : []
  bar.classList.toggle('hidden', !(editing || focus || sp))
  bar.classList.toggle('editing', editing)
  $('#bm-shield').classList.toggle('hidden', !editing)
  $('#bm-edit').classList.toggle('hidden', !editing)
  $('#bm-row-main').classList.toggle('hidden', editing)
  $('#bm-row-edit').classList.toggle('hidden', !editing)
  // bookmark-bar-v2 (2026-10-04-12-11-11): Bookmark and Note are never disabled and show a check when the bookmark / note
  // exists (clicking a checked Bookmark removes it with its note); Meaning and Copy need selected text; buttons listed
  // in SWITCH_BOOKMARK_MENU only, Meaning only in the 'request' dictionary mode
  const st = bmBarState(focus, sp, over)
  setBarLabel($('#bm-bookmark'), 'Bookmark', st.marked)
  setBarLabel($('#bm-note'), 'Note', st.hasNote)
  // Copy / Meaning: the selection, or the text of the bookmark in focus (not a page bookmark); Meaning also needs one
  // word when SWITCH_DICTIONARY_USES_ONLY_ONE_WORD is true
  const subjText = focus ? bmFocusText(focus.b) : (sp ? sp.text : '')
  $('#bm-copy').disabled = !subjText.trim()
  $('#bm-meaning').disabled = !subjText.trim() || (FLAGS.SWITCH_DICTIONARY_USES_ONLY_ONE_WORD === true && !isOneWord(subjText))
  { const ids = barButtonIds()
    for (const id of Object.values(BM_BAR_BUTTONS)) $('#' + id).classList.toggle('hidden', !ids.includes(id) || (id === 'bm-meaning' && getDictShow() !== 'request')) }
  const note = editing ? '' : (focus ? focus.b.note : (over.length === 1 ? over[0].note : ''))
  const pv = $('#bm-preview')
  pv.textContent = note || ''
  pv.classList.toggle('hidden', !note)
  pv.style.maxWidth = (fitWidth(FLAGS.SWITCH_NOTE_WIDTH, 340) - 20) + 'px' // reader-polish-2: 20 = its side padding
  placeBmBar(bar, focus ? (focus.anchor ?? null) : (sp ? selAnchor(sp) : null), editing)
  scheduleAutoMeaning(sp)
}
// show the bar for one bookmark (hover = transient, anchored near the text / ribbon). false: the bar is off (caller may use the old popup)
function showBarFor(b, anchor, hover) {
  if (!isBmBarOn()) return false
  if (barEdit) return true
  if (hover && ((bmFocus && !bmFocus.hover) || getSelectionSpan(false))) return true // never replace a clicked bar or the selection bar
  bmFocus = { b, hover: !!hover, anchor }
  updateBmBar()
  return true
}
function scheduleBarHoverHide() {
  clearTimeout(hoverHideTimer)
  hoverHideTimer = setTimeout(() => { if (bmFocus?.hover && !barEdit) { bmFocus = null; updateBmBar() } }, 250)
}
// page bookmark under the ribbon (the one on the visible page), optionally only one that has a note
function ribbonBookmark(needNote) {
  const pg = getPageSpan()
  if (!pg) return null
  const list = bmPageHere(pg)
  return (needNote ? list.find(b => b.note) : list[0]) ?? null
}
function ribbonAnchor() {
  const r = $('#bm-ribbon').getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
}
function wireBookmarkUi() {
  const bar = $('#bm-bar')
  // keep the book selection alive while the bar is pressed (but let the note text box take focus)
  for (const ev of ['pointerdown', 'mousedown']) bar.addEventListener(ev, e => { if (!e.target.closest('#bm-edit')) e.preventDefault() })
  orderBarButtons()
  // Bookmark toggles: a checked button removes the bookmark(s) with their notes, an unchecked one adds / extends
  $('#bm-bookmark').addEventListener('click', () => {
    if (bmFocus) { bmRemoveFocus(); return }
    const sp = getSelectionSpan(false)
    if (!sp) return
    if (bmOverlapText(sp).length && !selectionAddsText(sp)) bmRemoveHere(false)
    else bmAddSelection(false, false)
  })
  // Note opens the editor; saving it empty removes the note and keeps the bookmark
  $('#bm-note').addEventListener('click', () => (bmFocus ? bmEditFocus() : bmAddSelection(true, false)))
  // Copy: only the selected text, or the text of the bookmark in focus (no title)
  $('#bm-copy').addEventListener('click', () => {
    const sub = barSubject()
    if (!sub) return
    copyWithToast(sub.text)
    barSubjectDone(sub)
  })
  $('#bm-meaning').addEventListener('click', () => {
    const sub = barSubject()
    if (!sub) return
    const r = $('#bm-bar').getBoundingClientRect()
    const anchor = sub.anchor ?? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    barSubjectDone(sub)
    showMeaning(sub.text, anchor, false)
  })
  $('#bm-edit-save').addEventListener('click', () => closeBarEdit($('#bm-edit').value.trim()))
  $('#bm-edit-cancel').addEventListener('click', () => closeBarEdit(null))
  // while editing, a transparent shield covers the page: a click outside cancels (like the old note box backdrop)
  const shield = $('#bm-shield')
  shield.addEventListener('click', () => closeBarEdit(null))
  shield.addEventListener('wheel', e => e.stopPropagation(), { passive: true })
  // a hover bar stays while the mouse is on it
  bar.addEventListener('mouseenter', () => clearTimeout(hoverHideTimer))
  bar.addEventListener('mouseleave', () => { if (bmFocus?.hover) scheduleBarHoverHide() })
  // popup: its own clicks, wheel and touches must not reach the page (no turn, no scroll-to-turn)
  const pop = $('#pop')
  for (const ev of ['pointerdown', 'pointerup', 'click', 'wheel', 'touchstart', 'touchmove']) pop.addEventListener(ev, e => e.stopPropagation(), { passive: true })
  // reader-polish-2: the note preview scrolls by itself; wheel / touch moves on the bars never reach the page (no turn)
  for (const el of [bar, $('#pos-bar')]) for (const ev of ['wheel', 'touchmove']) el.addEventListener(ev, e => e.stopPropagation(), { passive: true })
  $('#pop-close').addEventListener('click', hidePopup)
  // popup-polish (2026-10-08-05-32-00): while a drag that started inside the popup is in progress, nothing outside the popup can be
  // swept into the selection (css: body.popup-drag). The position label itself stays selectable the rest of the time.
  const popDragEnd = () => document.body.classList.remove('popup-drag')
  $('#pop').addEventListener('pointerdown', () => document.body.classList.add('popup-drag'))
  for (const ev of ['pointerup', 'pointercancel', 'mouseup']) window.addEventListener(ev, popDragEnd, true)
  window.addEventListener('blur', popDragEnd)
  pop.addEventListener('mouseenter', () => clearTimeout(hoverHideTimer))
  pop.addEventListener('mouseleave', () => { if (popState && !popState.sticky) scheduleHoverHide() })
  // ribbon: opens the Bookmarks menu under it (when clickable)
  // (note-widgets-round-2: the click always shows the small bar for the page bookmark, empty note area when there is
  // no note; the Bookmarks menu stays in the top menu, and is the fallback when the small bar is turned off)
  $('#bm-ribbon').addEventListener('click', e => {
    if (!isRibbonClickable()) return
    e.stopPropagation()
    const rbm = isBmBarOn() ? ribbonBookmark(false) : null
    if (rbm) {
      clearTimeout(hoverTimer); hidePopup()
      if (bmFocus?.b === rbm && !bmFocus.hover) { bmFocus = null; updateBmBar(); return }
      bmFocus = { b: rbm, hover: false, anchor: ribbonAnchor() }; updateBmBar()
      return
    }
    openGotoMenuAt($('#bm-ribbon'), false, 'bookmarks')
  })
  $('#bm-ribbon').addEventListener('mouseenter', () => {
    if (!isBmNoteHover() || isTouchPointer()) return
    const rbm = ribbonBookmark(true)
    if (!rbm) return
    clearTimeout(hoverTimer); clearTimeout(hoverHideTimer)
    hoverTimer = setTimeout(() => {
      const anchor = ribbonAnchor()
      if (!showBarFor(rbm, anchor, true)) showBookmarkNoteAt(rbm, anchor) // bar turned off: old popup
    }, Number(FLAGS.SWITCH_FOOTNOTE_HOVER_DELAY_MS) || 300)
  })
  $('#bm-ribbon').addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer)
    if (bmFocus?.hover) scheduleBarHoverHide()
    else if (popState?.kind === 'bmnote') scheduleHoverHide()
  })
  for (const id of ['#bookmarks-back-top', '#bookmarks-back-bottom']) $(id)?.addEventListener('click', showReaderView)
}

/* selected position bar (position-select-bar, 2026-10-04-08-20-19): the position text (#pct-display) can be selected;
   while it is, a small bar (#pos-bar, same look as the bookmark bar) shows Copy / Goto next to it. It behaves like a
   book text selection: a tap or click anywhere else only deselects (no page turn), Esc deselects, it never survives a
   change of the position text. posSelDown = a position selection existed when the current press started (the browser
   collapses it on press, so the click can no longer see it). */
let posSelDown = false
function posSelText() {
  try {
    const pct = $('#pct-display'), sel = window.getSelection()
    if (!pct || !sel || !sel.rangeCount || sel.isCollapsed) return ''
    const rg = sel.getRangeAt(0)
    if (!pct.contains(rg.startContainer) && !pct.contains(rg.endContainer)) return ''
    return String(sel).trim()
  } catch { return '' }
}
function updatePosBar() {
  const bar = $('#pos-bar')
  if (!bar) return
  const text = view && !readerOverlayShown() ? posSelText() : ''
  let anchor = null
  if (text) {
    try {
      let r = window.getSelection().getRangeAt(0).getBoundingClientRect()
      if (!r.width && !r.height) r = $('#pct-display').getBoundingClientRect()
      if (r.width || r.height) anchor = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, sel: true }
    } catch {}
  }
  const wasShown = !bar.classList.contains('hidden')
  bar.classList.toggle('hidden', !anchor)
  if (!anchor) {
    // the position line was only revealed by hover and the pointer is not over the page any more: hide it again
    if (wasShown && settings.showPosition === false && !$('#book-page').matches(':hover')) applyChromeVisibility()
    return
  }
  placeBmBar(bar, anchor, false)
}
// true when a position selection was cleared
// popup-polish: a selection in the app's own page (outside the book frame), e.g. one swept over the position label or the search
// text from a popup drag. Esc removes it. Returns true when there was one.
function clearOuterSelection() {
  const s = window.getSelection?.()
  if (s && !s.isCollapsed) { s.removeAllRanges(); return true }
  return false
}
function clearPosSelection() {
  if (!posSelText()) return false
  try { window.getSelection().removeAllRanges() } catch {}
  updatePosBar()
  return true
}
// a tap / click that must only deselect the position: it was selected at press time (posSelDown) or still is
function consumePosSel() {
  const had = posSelDown || !!posSelText()
  posSelDown = false
  if (had) clearPosSelection()
  return had
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  try { // no clipboard API (plain http): temporary text box
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.cssText = 'position:fixed;left:-1000px;top:0;opacity:0'
    document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}
// pos-bar-toast (2026-10-04-09-48-56): small message at the bottom, gone after SWITCH_SHOW_TOAST_TIME_IN_SECONDS (3 s; element created on first use)
let toastTimer = 0
function showToast(msg) {
  let el = $('#toast')
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el) }
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), (Number(FLAGS.SWITCH_SHOW_TOAST_TIME_IN_SECONDS) || 3) * 1000)
}
// copies and tells the result: Copied: text (cut at 80 characters), or Copy failed
async function copyWithToast(text) {
  const ok = await copyText(text)
  const t = String(text)
  showToast(ok ? `Copied: ${t.length > 80 ? t.slice(0, 80) + '…' : t}` : 'Copy failed')
  return ok
}
// Copy (selected position): "Title<separator>position" when SWITCH_COPY_COPIES_TITLE_AND_POSITION is true (the position text
// as shown, i.e. the decimals / % sign from Settings; title = the page header title), else only the position text
async function copyPosition(text) {
  let msg = text
  if (FLAGS.SWITCH_COPY_COPIES_TITLE_AND_POSITION === true) {
    const title = ($('#page-header .title')?.textContent || document.title || '').trim()
    const sep = typeof FLAGS.SWITCH_BOOK_TITLE_AND_POSITION_SEPARATOR === 'string' ? FLAGS.SWITCH_BOOK_TITLE_AND_POSITION_SEPARATOR : ': '
    if (title) msg = `${title}${sep}${text}`
  }
  await copyWithToast(msg)
}
function wirePositionBar() {
  const bar = $('#pos-bar')
  // keep the selection alive while the bar is pressed
  for (const ev of ['pointerdown', 'mousedown']) bar.addEventListener(ev, e => e.preventDefault())
  // remember, before the browser collapses it, whether a position selection existed at the start of a press outside the bar
  document.addEventListener('pointerdown', e => { posSelDown = !e.target.closest?.('#pos-bar') && !!posSelText() }, { capture: true, passive: true })
  // a position selection replaces a book selection and the bookmark bar; any change of the selection updates the bar
  document.addEventListener('selectionchange', () => {
    if (posSelText()) {
      if (bmFocus) { bmFocus = null; updateBmBar() }
      clearBookSelection()
    }
    updatePosBar()
  })
  const run = fn => () => {
    const t = posSelText()
    if (!t) return
    clearPosSelection()
    fn(t)
  }
  $('#pos-copy').addEventListener('click', run(t => { copyPosition(t) }))
  $('#pos-goto').addEventListener('click', run(() => { promptGoto() }))
}

/* View all */
function showBookmarks() {
  $('#library-view').classList.remove('show')
  $('#settings-view').classList.remove('show')
  setComponentTitle($('#bookmarks-header-title'), 'Bookmarks')
  renderBookmarksView()
  $('#bookmarks-view').classList.add('show')
  applyBackButtons()
  hideCover()
  updateBmBar()
}
function renderBookmarksView() {
  const body = $('#bookmarks-body')
  body.innerHTML = ''
  if (!bookmarks.length) {
    body.innerHTML = '<p style="opacity:.7">No bookmarks in this book yet.</p>'
    return
  }
  for (const b of bookmarks) {
    const item = document.createElement('div')
    item.className = 'bm-item'
    const top = document.createElement('div')
    top.className = 'bm-top'
    top.textContent = `${formatPct(b.start / Math.max(1, bookTotalChars))} · ${b.type === 'page' ? 'Page' : 'Text'}`
    const text = document.createElement('div')
    text.className = 'bm-text'
    text.textContent = b.text || '(blank page)'
    item.append(top, text)
    if (b.note) {
      const note = document.createElement('div')
      note.className = 'bm-note'
      note.textContent = b.note
      item.appendChild(note)
    }
    const actions = document.createElement('div')
    actions.className = 'bm-actions'
    const edit = document.createElement('button')
    edit.textContent = 'Edit note'
    edit.addEventListener('click', async e => {
      e.stopPropagation()
      const res = await openNoteBox(b.text || '', b.note || '')
      if (res === null) return
      b.note = res
      await idbPut('bookmarks', b)
      bmChanged()
    })
    const del = document.createElement('button')
    del.textContent = 'Delete'
    del.addEventListener('click', async e => {
      e.stopPropagation()
      await bmDelete(b)
      bmChanged()
    })
    actions.append(edit, del)
    item.appendChild(actions)
    item.addEventListener('click', () => jumpToBookmark(b))
    body.appendChild(item)
  }
}
async function jumpToBookmark(b) {
  try {
    const target = await getRangeForCharIndex(Math.min(Math.max(0, b.start | 0), Math.max(0, bookTotalChars - 1)))
    if (target) await view.renderer.goTo(target).catch(() => {})
  } catch {}
  showReaderView()
}


/* ---------------- markers, ribbon, popups, footnotes (2026-10-02-08-32-16) ---------------- */
// page bookmarks are marked by a '*' after the position (class has-bm on #pct-display,
// drawn by CSS) and a ribbon hanging from the top edge of the page (#bm-ribbon)
function drawRibbon(hasNote) {
  const rb = $('#bm-ribbon')
  if (!rb) return
  const col = getRibbonColor()
  const poly = rb.querySelector('#bm-ribbon-poly')
  const pts = RIBBON_SHAPES[getRibbonShape()]
  poly.setAttribute('points', pts)
  poly.setAttribute('fill', col)
  poly.setAttribute('stroke', darkenHex(col, 0.35))
  // double outline when the page bookmark has a note: #bm-ribbon-o1 = outer line, #bm-ribbon-o2 = gap in the page color
  const dbl = hasNote && FLAGS.SWITCH_RIBBON_SHOWS_ON_NOTE_DOUBLE_OUTLINE === true
  for (const id of ['#bm-ribbon-o1', '#bm-ribbon-o2']) {
    const o = rb.querySelector(id)
    o.setAttribute('points', pts)
    o.setAttribute('visibility', dbl ? 'visible' : 'hidden')
  }
  rb.querySelector('#bm-ribbon-o1').setAttribute('stroke', FLAGS.SWITCH_RIBBON_DOUBLE_OUTLINE_DARKER === true ? darkenHex(col, 0.35) : col)
  rb.classList.toggle('nolink', !isRibbonClickable())
  const n = rb.querySelector('#bm-ribbon-n') // "n" inside the ribbon = the page bookmark has a note (bookmark-bar-v2)
  if (n) {
    n.setAttribute('fill', contrastHex(col))
    n.setAttribute('font-weight', FLAGS.SWITCH_RIBBON_N_INSIDE_IS_BOLD === true ? 'bold' : 'normal')
    n.setAttribute('visibility', hasNote && FLAGS.SWITCH_RIBBON_SHOWS_ON_NOTE_N === true ? 'visible' : 'hidden')
  }
}
function updateBookmarkMarkers(range) {
  if (!bookTotalChars) return
  const pg = range ? pageSpanFromRange(range) : getPageSpan()
  const hereList = pg ? bmPageHere(pg) : []
  const has = !!hereList.length
  if (pg && debugOn() && bookmarks.some(b => b.type === 'page')) { // page-bm-boundary: read-only trace
    const near = bookmarks.filter(b => b.type === 'page' && Math.abs(b.start - pg.start) < 3000).map(b => b.start).join(',')
    debugBeacon('bm-page', { pgS: pg.start, pgE: pg.end, near, here: has ? 1 : 0 })
  }
  $('#pct-display')?.classList.toggle('has-bm', has && isBmStar())
  const rb = $('#bm-ribbon')
  if (rb) { drawRibbon(hereList.some(b => b.note)); rb.classList.toggle('hidden', !(has && isBmRibbon())) }
}

// bookmark under a point of a book document (x, y in that document's client coordinates)
function bookmarkAtPoint(doc, x, y, noteOnly) {
  for (const { b, r } of bmRangesByDoc.get(doc) ?? []) {
    if (noteOnly && !b.note) continue
    try {
      for (const rc of r.getClientRects()) {
        if (x >= rc.left - 1 && x <= rc.right + 1 && y >= rc.top - 1 && y <= rc.bottom + 1) return { b, rc }
      }
    } catch {}
  }
  return null
}
function toOuterRect(doc, rc) {
  const fe = doc.defaultView?.frameElement?.getBoundingClientRect?.() ?? { left: 0, top: 0 }
  return { left: fe.left + rc.left, right: fe.left + rc.right, top: fe.top + rc.top, bottom: fe.top + rc.bottom }
}

/* popup window (footnotes and bookmark notes) */
const popOpen = () => !$('#pop').classList.contains('hidden')
function hidePopup() {
  clearTimeout(hoverTimer); clearTimeout(hoverHideTimer)
  hoverBmId = null
  if (!popOpen()) { popState = null; return false }
  $('#pop').classList.add('hidden')
  popState = null
  return true
}
function scheduleHoverHide() {
  clearTimeout(hoverHideTimer)
  hoverHideTimer = setTimeout(() => { if (popState && !popState.sticky) hidePopup() }, 250)
}
// node: DOM node for the body; anchor: outer viewport rect; buttons: [{ label, fn }]
function showPopup({ kind, title, node, anchor, buttons = [], sticky }) {
  const pop = $('#pop')
  clearTimeout(hoverTimer); clearTimeout(hoverHideTimer)
  pop.style.background = resolveColor('page')
  pop.style.color = resolveColor('font')
  $('#pop-title').textContent = title || ''
  const body = $('#pop-body')
  body.replaceChildren(node)
  body.scrollTop = 0
  const foot = $('#pop-foot')
  foot.replaceChildren()
  for (const b of buttons) {
    const el = document.createElement('button')
    el.textContent = b.label
    el.addEventListener('click', e => { e.stopPropagation(); b.fn() })
    foot.appendChild(el)
  }
  foot.classList.toggle('hidden', !buttons.length)
  popState = { kind, sticky: !!sticky }
  pop.style.visibility = 'hidden'
  pop.classList.remove('hidden')
  // reader-polish-2: never wider than the book page; a word near the page's right edge shifts the popup left
  pop.style.width = fitWidth(kind === 'bmnote' ? FLAGS.SWITCH_NOTE_WIDTH : FLAGS.SWITCH_DICT_POPUP_WIDTH, 420) + 'px'
  const w = pop.offsetWidth, h = pop.offsetHeight
  body.scrollTop = 0 // popup-polish: after the layout; the reset above is lost while the popup is still display:none, so a long definition kept its old scroll position
  const pb = pageBounds()
  let left = Math.min(Math.max(pb.left + 8, anchor.left), Math.max(pb.left + 8, pb.right - w - 8))
  let top = anchor.bottom + 8
  if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - 8 - h)
  pop.style.left = left + 'px'
  pop.style.top = top + 'px'
  pop.style.visibility = ''
}

/* bookmark note popup (mouse over, PC) */
function showBookmarkNote(doc, hit) { showBookmarkNoteAt(hit.b, toOuterRect(doc, hit.rc)) }
// (kept as the fallback when the small bar is turned off in Settings)
function showBookmarkNoteAt(b, anchor) {
  const node = document.createElement('div')
  node.className = 'pop-text pop-note'
  node.textContent = b.note
  showPopup({
    kind: 'bmnote', title: 'Note', node, anchor, sticky: false,
    buttons: [
      { label: 'Edit', fn: async () => {
        hidePopup()
        const res = await openNoteBox(b.text || '', b.note || '')
        if (res === null) return
        b.note = res; await idbPut('bookmarks', b); bmChanged()
      } },
      { label: 'Remove', fn: async () => { hidePopup(); await bmDelete(b); bmChanged() } },
    ],
  })
}
function hoverBookmarkNote(doc, e) {
  if (!isBmNoteHover() || isTouchPointer()) return
  const now = Date.now()
  if (now - lastHoverCheck < 60) return
  lastHoverCheck = now
  const hit = bookmarkAtPoint(doc, e.clientX, e.clientY, true)
  if (hit && hit.b.id !== hoverBmId) {
    hoverBmId = hit.b.id
    clearTimeout(hoverTimer); clearTimeout(hoverHideTimer)
    hoverTimer = setTimeout(() => { if (!showBarFor(hit.b, toOuterRect(doc, hit.rc), true)) showBookmarkNote(doc, hit) }, Number(FLAGS.SWITCH_FOOTNOTE_HOVER_DELAY_MS) || 300)
  } else if (!hit && hoverBmId) {
    hoverBmId = null
    clearTimeout(hoverTimer)
    if (popState?.kind === 'bmnote') scheduleHoverHide()
    else if (bmFocus?.hover) scheduleBarHoverHide()
  }
}

/* small bar on a tapped yellow bookmark */
async function bmEditFocus() {
  const b = bmFocus?.b
  bmFocus = null
  if (!b) { updateBmBar(); return }
  const res = await openNoteBox(b.text || '', b.note || '')
  if (res === null) return
  b.note = res; await idbPut('bookmarks', b); bmChanged()
}
async function bmRemoveFocus() {
  const b = bmFocus?.b
  bmFocus = null
  if (b) await bmDelete(b)
  bmChanged()
}

/* footnotes: a note marker shows its note in a popup instead of jumping there */
function isFootnoteLink(a, href) {
  if (!a || !href || !String(href).includes('#')) return false
  const et = (a.getAttribute('epub:type') || '').toLowerCase()
  const role = (a.getAttribute('role') || '').toLowerCase()
  if (/\bnoteref\b/.test(et) || role === 'doc-noteref') return true
  const t = (a.textContent || '').trim()
  if (/^[\[(]?(\d{1,3}|[*†‡§¶#]{1,3})[\])]?$/.test(t)) return true
  return a.children.length === 1 && /^(sup|sub)$/i.test(a.firstElementChild.localName) && t.length <= 4 && t.length > 0
}
function resolvedHref(doc, a) {
  try {
    const idx = liveContents().find(c => c.doc === doc)?.index
    const raw = a.getAttribute('href')
    return view.book.sections[idx]?.resolveHref?.(raw) ?? raw
  } catch { return a.getAttribute('href') }
}
const NOTE_ALLOWED = new Set(['p', 'br', 'i', 'b', 'em', 'strong', 'sup', 'sub', 'ul', 'ol', 'li', 'blockquote', 'span', 'div', 'small', 'cite', 'q', 'dl', 'dt', 'dd'])
function cloneNote(src, dst, srcId, budget) {
  for (const n of src.childNodes) {
    if (budget.left <= 0) return
    if (n.nodeType === 3) {
      const t = (n.nodeValue ?? '').slice(0, budget.left)
      budget.left -= t.length
      dst.appendChild(document.createTextNode(t))
      continue
    }
    if (n.nodeType !== 1) continue
    const tag = n.localName.toLowerCase()
    if (/^(script|style|img|svg|iframe|object|embed|audio|video|canvas|math|link|meta|nav)$/.test(tag)) continue
    if (tag === 'a') {
      const hf = (n.getAttribute('href') || '').split('#')[1]
      const et = (n.getAttribute('epub:type') || '').toLowerCase(), role = (n.getAttribute('role') || '').toLowerCase()
      if ((hf && srcId && hf === srcId) || /backlink/.test(et) || role === 'doc-backlink') continue
      if (/^[\s\u21a9\u21aa\u2191\u21b5^]+$/.test(n.textContent || '')) continue
      cloneNote(n, dst, srcId, budget) // links inside a note become plain text
      continue
    }
    if (NOTE_ALLOWED.has(tag)) {
      const c = document.createElement(tag)
      cloneNote(n, c, srcId, budget)
      dst.appendChild(c)
    } else cloneNote(n, dst, srcId, budget)
  }
}
async function loadNoteNode(a, href) {
  try {
    const resolved = view.book.resolveHref(href)
    if (!resolved || !String(href).includes('#')) return null
    let doc = liveContents().find(c => c.index === resolved.index)?.doc
    if (!doc) {
      if (!noteDocCache.has(resolved.index)) noteDocCache.set(resolved.index, await view.book.sections[resolved.index].createDocument())
      doc = noteDocCache.get(resolved.index)
    }
    let el = resolved.anchor(doc)
    if (el && el.startContainer) el = el.startContainer.nodeType === 1 ? el.startContainer : el.startContainer.parentElement
    if (!el || el === doc.body || el === doc.documentElement) return null
    while (el && /^(a|span|sup|sub|i|b|em|strong)$/i.test(el.localName)) el = el.parentElement
    if (!el || el === doc.body || el === doc.documentElement || /^(h[1-6]|section|body|html)$/i.test(el.localName)) return null
    const wrap = document.createElement('div')
    wrap.className = 'pop-text'
    cloneNote(el, wrap, a.id || '', { left: 12000 })
    return wrap.textContent.trim() ? wrap : null
  } catch { return null }
}
let fnToken = 0
async function showFootnote(doc, a, href, sticky) {
  const token = ++fnToken
  const node = await loadNoteNode(a, href)
  if (token !== fnToken) return true // a newer request replaced this one
  if (!node) return false
  const rc = (a.getClientRects()[0]) || a.getBoundingClientRect()
  const buttons = sticky ? [{ label: 'Go to note', fn: () => { hidePopup(); view.goTo(href).catch(() => {}) } }] : []
  showPopup({ kind: 'footnote', title: 'Note', node, anchor: toOuterRect(doc, rc), buttons, sticky })
  return true
}
async function onBookLink(e) {
  const { a, href } = e.detail
  if (!isFnPopupOn() || !isFootnoteLink(a, href)) return
  e.preventDefault() // no jump: show the note in a popup instead (falls back to the jump)
  const ok = await showFootnote(a.ownerDocument, a, href, true)
  if (!ok) { try { await view.goTo(href) } catch {} }
}
function hoverFootnote(doc, e) {
  if (!isFnPopupOn() || !isFnHoverOn() || isTouchPointer()) return
  const a = e.target?.closest?.('a[href]')
  if (!a) return
  const href = resolvedHref(doc, a)
  if (!isFootnoteLink(a, href)) return
  clearTimeout(hoverTimer); clearTimeout(hoverHideTimer)
  hoverTimer = setTimeout(() => { if (!popState?.sticky) showFootnote(doc, a, href, false) }, Number(FLAGS.SWITCH_FOOTNOTE_HOVER_DELAY_MS) || 300)
}
function leaveFootnote(e) {
  if (!e.target?.closest?.('a[href]')) return
  clearTimeout(hoverTimer)
  if (popState?.kind === 'footnote') scheduleHoverHide()
}

/* ---------------- settings UI ---------------- */

// ribbon shape picker: six previews at real size in the current ribbon color
function renderRibbonShapes() {
  const box = $('#ribbon-shapes')
  if (!box) return
  const col = getRibbonColor(), edge = darkenHex(col, 0.35), cur = getRibbonShape()
  box.replaceChildren()
  for (const [id, pts] of Object.entries(RIBBON_SHAPES)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'shape-btn' + (id === cur ? ' active' : '')
    b.title = id
    b.setAttribute('aria-label', 'Ribbon shape ' + id)
    b.innerHTML = `<svg viewBox="0 0 20 34" width="20" height="34"><polygon points="${pts}" fill="${col}" stroke="${edge}" stroke-width="1"/></svg>`
    b.addEventListener('click', () => { settings.bmRibbonShape = id; saveSettings(); renderRibbonShapes(); updateBookmarkMarkers() })
    box.appendChild(b)
  }
}
function renderSettings() {
  const sizeRow = $('#size-chips')
  sizeRow.innerHTML = ''
  for (const s of SIZE_STEPS) {
    const b = document.createElement('button')
    b.className = 'size-chip' + (settings.fontSize === s ? ' active' : '')
    b.textContent = s
    b.addEventListener('click', () => { settings.fontSize = s; saveSettings(); applyStyles(); renderSettings() })
    sizeRow.appendChild(b)
  }
  $('#custom-size').value = settings.fontSize

  const fontRow = $('#font-chips')
  fontRow.innerHTML = ''
  for (const f of BUNDLED_FONTS) {
    const b = document.createElement('button')
    b.className = 'font-chip' + (!settings.customFontName && !settings.uploadedFontName && settings.fontId === f.id ? ' active' : '')
    b.textContent = f.label
    b.style.fontFamily = f.family
    b.addEventListener('click', () => {
      settings.fontId = f.id; settings.customFontName = ''; settings.uploadedFontName = ''
      saveSettings(); applyStyles(); renderSettings()
    })
    fontRow.appendChild(b)
  }
  $('#custom-font-name').value = settings.customFontName

  renderThemeControls() // theme-combo: combo, preview panel and the Make default for boxes
  for (const kind of ['page', 'monitor', 'font']) {
    $('#' + kind + '-color').value = settings[kind + 'Color']
    const custom = settings[kind + 'Color'] === 'custom'
    $('#' + kind + '-color-custom').classList.toggle('hidden', !custom)
    $('#' + kind + '-color-pick').value = normalizeHex(settings[kind + 'ColorCustom']) || COLOR_FALLBACK[kind]
    $('#' + kind + '-color-hex').value = normalizeHex(settings[kind + 'ColorCustom']) || COLOR_FALLBACK[kind]
  }
  $('#page-shadow').checked = settings.pageShadow === true
  for (const [kind, hex] of [['mark', getMarkColor()], ['bookmark', getBookmarkColor()], ['link', getLinkColor()]]) {
    $('#' + kind + '-color-pick').value = hex
    $('#' + kind + '-color-hex').value = hex
    if (kind === 'link') $('#link-color-hex').placeholder = defaultLinkColor() // shown when emptied
  }
  $('#bm-bar-enabled').checked = isBmBarOn()
  $('#bm-star-enabled').checked = isBmStar()
  $('#bm-ribbon-enabled').checked = isBmRibbon()
  $('#bm-ribbon-clickable').checked = isRibbonClickable()
  $('#bm-note-hover-enabled').checked = isBmNoteHover()
  $('#fn-popup-enabled').checked = isFnPopupOn()
  $('#fn-hover-enabled').checked = isFnHoverOn()
  $('#dict-show').value = getDictShow()
  $('#wheel-click').value = getWheelClick()
  renderDictUi()
  $('#ribbon-color-pick').value = getRibbonColor()
  $('#ribbon-color-hex').value = getRibbonColor()
  { // ribbon color follows the bookmark color: its own picker is greyed out
    const same = isRibbonSameColor()
    $('#bm-ribbon-same-color').checked = same
    $('#ribbon-color-pick').disabled = same
    $('#ribbon-color-hex').disabled = same
    $('#ribbon-color-pick').closest('.color-row')?.classList.toggle('off', same)
  }
  renderRibbonShapes()
  $('#rounded-corners').value = settings.roundedCorners
  $('#rounded-corners-val').textContent = settings.roundedCorners + ' px'

  $('#line-spacing').value = settings.lineSpacing
  $('#line-spacing-val').textContent = settings.lineSpacing

  $('#page-size').value = settings.pageSizeVh
  $('#page-size-val').textContent = settings.pageSizeVh + '%'
  $('#frame-size').value = settings.frameSizePct
  $('#frame-size-val').textContent = settings.frameSizePct + '%'
  $('#page-ratio').value = ['reader', 'a4', 'letter'].includes(settings.pageRatio) ? settings.pageRatio : 'reader'

  $('#pct-decimals').value = String(settings.pctDecimals ?? 2)
  $('#start-fullscreen').checked = settings.startFullscreen === true
  $('#keep-awake').checked = (settings.keepAwake ?? (FLAGS.SWITCH_DEFAULT_KEEP_SCREEN_ON === true)) === true
  renderOfflineUi()
  $('#click-position-goto').checked = settings.clickPositionForGoto === true
}

function wireSettings() {
  $('#custom-size').addEventListener('change', e => {
    const v = parseFloat(e.target.value)
    if (v > 0) { settings.fontSize = v; saveSettings(); applyStyles(); renderSettings() }
  })
  $('#custom-font-name').addEventListener('change', e => {
    settings.customFontName = e.target.value.trim()
    settings.uploadedFontName = ''
    saveSettings(); applyStyles(); renderSettings()
  })
  $('#font-upload').addEventListener('change', async e => {
    const file = e.target.files[0]
    if (!file) return
    const dataUrl = await blobToDataUrl(file)
    await idbPut('fonts', { name: 'user-uploaded', originalName: file.name, dataUrl })
    document.querySelectorAll('style[data-userfont]').forEach(s => s.remove())
    const style = document.createElement('style')
    style.dataset.userfont = '1'
    style.textContent = `@font-face { font-family: 'UserFont'; src: url(${JSON.stringify(dataUrl)}); }`
    document.head.appendChild(style)
    settings.uploadedFontName = file.name
    settings.customFontName = ''
    uploadedFontLabel = file.name
    saveSettings(); applyStyles(); renderSettings()
  })
  // theme-combo: the combo applies the theme live; Save as / Make default for are in saveThemeAs(), setThemeDefaultAll(), setThemeDefaultBook()
  $('#theme-select').addEventListener('change', e => {
    const t = findTheme(e.target.value)
    if (!t) { renderThemeControls(); return }
    themeSel = e.target.value
    applyThemeColors(t)
    saveSettings(); applyTheme(); renderSettings()
  })
  $('#theme-save-btn').addEventListener('click', saveThemeAs)
  $('#theme-default-all').addEventListener('change', e => setThemeDefaultAll(e.target.checked))
  $('#theme-default-book').addEventListener('change', e => setThemeDefaultBook(e.target.checked))
  for (const kind of ['page', 'monitor', 'font']) {
    const sel = $('#' + kind + '-color'), pick = $('#' + kind + '-color-pick'), hex = $('#' + kind + '-color-hex')
    sel.addEventListener('change', () => {
      if (sel.value === 'custom' && settings[kind + 'Color'] !== 'custom') {
        settings[kind + 'ColorCustom'] = resolveColor(kind) // start from the color shown now
      }
      settings[kind + 'Color'] = sel.value
      saveSettings(); applyTheme(); renderSettings()
    })
    pick.addEventListener('input', () => {
      settings[kind + 'ColorCustom'] = pick.value
      hex.value = pick.value
      applyTheme()
    })
    pick.addEventListener('change', () => { saveSettings(); renderSettings() })
    // live: apply as soon as the text is a valid hex color; red outline if not
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value)
      hex.classList.toggle('invalid', !v && hex.value.trim() !== '')
      if (v) { settings[kind + 'ColorCustom'] = v; pick.value = v; applyTheme() }
    })
    hex.addEventListener('change', () => {
      const v = normalizeHex(hex.value)
      if (v) { settings[kind + 'ColorCustom'] = v; saveSettings(); applyTheme() }
      hex.classList.remove('invalid')
      renderSettings() // invalid text falls back to the stored color
    })
  }
  $('#rounded-corners').addEventListener('input', e => {
    settings.roundedCorners = Math.min(15, Math.max(0, parseInt(e.target.value, 10) || 0))
    $('#rounded-corners-val').textContent = settings.roundedCorners + ' px'
    applyRoundedCorners()
  })
  $('#rounded-corners').addEventListener('change', saveSettings)
  // mark / bookmark colors (color picker + hex text) and the small bar switch
  for (const [kind, key] of [['mark', 'markColor'], ['bookmark', 'bookmarkColor'], ['link', 'linkColor']]) {
    const pick = $('#' + kind + '-color-pick'), hex = $('#' + kind + '-color-hex')
    const apply = v => { settings[key] = v; view?.renderer?.setStyles?.(getCSS()); refreshBookmarkHighlights()
      if (kind === 'link') applyLinkColorVar()
      if (kind === 'bookmark' && isRibbonSameColor()) { renderRibbonShapes(); updateBookmarkMarkers() } } // the ribbon follows
    pick.addEventListener('input', () => { hex.value = pick.value; apply(pick.value) })
    pick.addEventListener('change', saveSettings)
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value)
      hex.classList.toggle('invalid', !v && hex.value.trim() !== '')
      if (v) { pick.value = v; apply(v) }
    })
    hex.addEventListener('change', () => {
      hex.classList.remove('invalid')
      if (kind === 'link' && !hex.value.trim()) apply(null) // an empty field = back to the default (it follows the page)
      saveSettings(); renderSettings()
    })
  }
  $('#bm-bar-enabled').addEventListener('change', e => { settings.bmBar = e.target.checked; saveSettings(); updateBmBar() })
  $('#dict-show').addEventListener('change', e => { settings.dictShow = e.target.value; saveSettings(); updateBmBar() })
  $('#wheel-click').addEventListener('change', e => { settings.wheelClick = e.target.value; saveSettings() })
  wireDictionaryUi()
  $('#bm-ribbon-same-color').addEventListener('change', e => {
    settings.bmRibbonSameColor = e.target.checked; saveSettings(); renderSettings(); updateBookmarkMarkers()
  })
  for (const [id, key] of [['bm-star-enabled', 'bmStar'], ['bm-ribbon-enabled', 'bmRibbon'], ['bm-ribbon-clickable', 'bmRibbonClickable'],
    ['bm-note-hover-enabled', 'bmNoteHover'], ['fn-popup-enabled', 'fnPopup'], ['fn-hover-enabled', 'fnHover']]) {
    $('#' + id).addEventListener('change', e => { settings[key] = e.target.checked; saveSettings(); updateBookmarkMarkers() })
  }
  { // ribbon color (color picker + hex text)
    const pick = $('#ribbon-color-pick'), hex = $('#ribbon-color-hex')
    const apply = v => { settings.bmRibbonColor = v; renderRibbonShapes(); updateBookmarkMarkers() }
    pick.addEventListener('input', () => { hex.value = pick.value; apply(pick.value) })
    pick.addEventListener('change', saveSettings)
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value)
      hex.classList.toggle('invalid', !v && hex.value.trim() !== '')
      if (v) { pick.value = v; apply(v) }
    })
    hex.addEventListener('change', () => { hex.classList.remove('invalid'); saveSettings(); renderSettings() })
  }
  $('#page-shadow').addEventListener('change', e => { settings.pageShadow = e.target.checked; saveSettings(); applyColorVars() })
  $('#line-spacing').addEventListener('input', e => {
    settings.lineSpacing = parseFloat(e.target.value)
    $('#line-spacing-val').textContent = settings.lineSpacing
    applyStyles()
  })
  $('#line-spacing').addEventListener('change', saveSettings)

  $('#page-size').addEventListener('input', e => {
    settings.pageSizeVh = parseFloat(e.target.value)
    $('#page-size-val').textContent = settings.pageSizeVh + '%'
    applyGeometry()
  })
  $('#page-size').addEventListener('change', saveSettings)
  $('#frame-size').addEventListener('input', e => {
    settings.frameSizePct = parseFloat(e.target.value)
    $('#frame-size-val').textContent = settings.frameSizePct + '%'
    applyGeometry()
  })
  $('#frame-size').addEventListener('change', saveSettings)

  $('#page-ratio').addEventListener('change', e => { settings.pageRatio = e.target.value; saveSettings(); applyGeometry(); renderSettings() })

  $('#pct-decimals').addEventListener('change', e => { settings.pctDecimals = Math.min(7, Math.max(0, parseInt(e.target.value, 10) || 0)); saveSettings(); refreshPctDisplay(); renderSettings() })
  $('#start-fullscreen').addEventListener('change', e => { settings.startFullscreen = e.target.checked; saveSettings() })
  $('#keep-awake').addEventListener('change', e => { settings.keepAwake = e.target.checked; saveSettings(); updateWakeLock() })
  wireOfflineUi()
  $('#click-position-goto').addEventListener('change', e => { settings.clickPositionForGoto = e.target.checked; saveSettings() })
  $('#reset-furthest-btn').addEventListener('click', () => { resetCurrentFurthest() })

  $('#export-btn').addEventListener('click', () => exportBackup())
  $('#fresh-app-btn').addEventListener('click', () => loadFreshApp())
  $('#import-btn-settings').addEventListener('click', () => $('#import-file-input').click())
  $('#import-file-input').addEventListener('change', e => {
    const file = e.target.files[0]
    if (file) importDataFile(file)
  })
}

/* ---------------- boot ---------------- */

async function main() {
  bootTimer = setTimeout(() => bootFailsafe('timeout'), 3000)
  await loadSettings()
  uploadedFontLabel = await loadUploadedFont()
  await refreshDictInfos()
  wireSettings()
  initViewMenu() // nav-menus: the ▾ beside the Back buttons

  // dropdown / page-turn priority on the dark surround:
  //  1. selected book text (if any) is cleared first
  //  2. otherwise the blue saved-char mark is removed
  //  3. otherwise an open "top book menu" dropdown (or tap-revealed header) closes first
  //  4. otherwise (nothing else to dismiss) turn the page, if that flag is on
  $('#main').addEventListener('click', e => {
    if (e.target.id !== 'main') return
    if (consumePosSel()) return // position-select-bar
    if (view && clearBookSelection()) { dismissChrome(); return } // black-click-closes-popup (2026-10-10-15-59-49): like the in-page tap, one click clears the selection and the sticky popup together
    if (savedCharMark) { clearSavedCharMark(); return }
    if (consumeSearchMarkClick()) return
    if (dismissChrome()) return
    if (FLAGS.SWITCH_CLICK_LEFT_OR_RIGHT_ON_BLACK_SCREEN_WHEN_NO_RED_MENU_PRESENT_GOES_TO_PREV_NEXT_PAGE && view) {
      turnAt(e.clientX, window.innerWidth, 'window-tap')
    }
  })

  $('#page-header').addEventListener('click', e => {
    if (!view) return
    openGotoMenuAtHeader(false)
  })
  document.addEventListener('click', e => {
    // the click of the very tap that revealed the labels must not undo it
    if (Date.now() - touchRevealAt < 400) return
    if (!e.target.isConnected) return // the clicked menu button was just rebuilt away
    if (e.target.closest('#pop') || e.target.closest('#bm-ribbon')) return
    if (!e.target.closest('#goto-menu') && !e.target.closest('#page-header')) {
      $('#goto-menu').classList.remove('show')
      menuSnap = null
      // tapping anywhere else outside the revealed labels hides them again
      if (!e.target.closest('#pct-display')) hideTouchChrome()
    }
  })

  for (const id of ['#library-back-top', '#library-back-bottom', '#settings-back-top', '#settings-back-bottom']) {
    $(id)?.addEventListener('click', showReaderView)
  }

  // import-reset (2026-10-09-13-26-12): Chromium restores the chosen file of a file input after a reload, and choosing the same file
  // again then fires no 'change' (nothing is imported). So the field is emptied now and just before every dialog opens (and the
  // input has autocomplete=off); 'input' and 'cancel' are logged too: no 'cancel' and no 'input' after a dialog = the browser's
  // file chooser returned nothing.
  const libFileInput = $('#file-input')
  libFileInput.value = ''
  libFileInput.addEventListener('input', () => debugBeacon('import-input', { n: libFileInput.files.length }))
  libFileInput.addEventListener('cancel', () => debugBeacon('import-cancel'))
  $('#import-btn').addEventListener('click', () => { debugBeacon('import-click'); libFileInput.value = ''; libFileInput.click() })
  $('#file-input').addEventListener('change', e => {
    const files = Array.from(e.target.files)
    // import-log (2026-10-08-20-12-00): where does a failing import stop? (browser, secure context, the chosen files)
    debugBeacon('import-change', { n: files.length, secure: window.isSecureContext, ua: navigator.userAgent.slice(0, 140), f1: files[0] ? `${files[0].name.slice(0, 50)} | ${files[0].type} | ${files[0].size}` : '' })
    e.target.value = '' // popup-polish: Chromium does not fire 'change' when the same file is chosen again (e.g. after removing the book)
    importFiles(files)
  })
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => {
    e.preventDefault()
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files)
  })

  $('#cover-overlay').addEventListener('click', hideCover)

  // search-book-panel (2026-09-27-12-08-27): footer % opens goto; panel buttons step
  // position-settings (2026-09-27-18-32-22): or toggles position on/off
  // instead of the dialog (mobile). Header click keeps the dialog.
  // position-select-bar (2026-10-04-08-20-19): the position text can be selected (double click, long-press, drag). A click
  // on / away from a selected position only deselects; a mouse click waits like the page turn so a double click can select.
  let posClickTimer = null
  $('#pct-display').addEventListener('click', e => {
    if (!view) return
    if (e.detail >= 2) { clearTimeout(posClickTimer); posClickTimer = null; return } // 2nd / 3rd click of a multi click
    if (consumePosSel()) return // the position was selected before this click: deselect only
    if (posSelText()) return // selection made by this very press (drag, long-press): keep it
    const act = () => { if (settings.clickPositionForGoto === true) promptGoto(); else togglePosition() }
    const ms = Number(FLAGS.SWITCH_MOUSE_PAGE_TURN_DELAY_MS_FOR_DOUBLE_CLICK_SELECT) || 0
    clearTimeout(posClickTimer)
    if (lastPointerType !== 'mouse' || ms <= 0) { posClickTimer = null; act(); return }
    posClickTimer = setTimeout(() => { posClickTimer = null; act() }, ms)
  })
  $('#pct-display').addEventListener('dblclick', () => {
    clearTimeout(posClickTimer); posClickTimer = null
    try {
      const rg = document.createRange(); rg.selectNodeContents($('#pct-display'))
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg) // the whole text, not one word
    } catch {}
  })
  $('#search-prev').addEventListener('click', () => doSearchBook(-1))
  $('#search-next').addEventListener('click', () => doSearchBook(1))
  $('#search-close').addEventListener('click', hideSearchPanel)
  // search-panel-drag-close: move by the header (mouse + touch); clamped to the viewport, session-only
  // (reopening re-applies the place switch). A press on the × button is a click, never a drag.
  {
    const head = $('#search-head'), panel = $('#search-panel')
    let drag = null
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const r = panel.getBoundingClientRect()
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      try { head.setPointerCapture(e.pointerId) } catch {}
      e.preventDefault()
    })
    head.addEventListener('pointermove', e => {
      if (!drag) return
      panel.style.left = Math.min(Math.max(8, e.clientX - drag.dx), Math.max(8, window.innerWidth - panel.offsetWidth - 8)) + 'px'
      panel.style.top = Math.min(Math.max(8, e.clientY - drag.dy), Math.max(8, window.innerHeight - panel.offsetHeight - 8)) + 'px'
      panel.style.bottom = 'auto'
      panel.style.transform = 'none'
    })
    for (const ev of ['pointerup', 'pointercancel']) head.addEventListener(ev, () => { drag = null })
  }
  $('#search-input').addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey) return // let global Ctrl+G/Ctrl+F through
    if (e.key === 'Enter') { e.preventDefault(); doSearchBook(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') hideSearchPanel()
    e.stopPropagation() // keep global handleKey (arrows/page-turn) off the input
  })
  $('#search-input').addEventListener('input', e => e.target.classList.remove('not-found'))

  // clicking the page padding (outside the rendered text, still on the page)
  $('#viewer-host').addEventListener('click', e => {
    if (e.target.id !== 'viewer-host' || !view) return
    if (consumePosSel()) return // position-select-bar
    if (clearBookSelection()) { dismissChrome(); return } // black-click-closes-popup (2026-10-10-15-59-49): page padding behaves like the black surround
    if (savedCharMark) { clearSavedCharMark(); return }
    if (consumeSearchMarkClick()) return
    if (dismissChrome()) return
    if (tryRevealChromeByTap(e.clientY)) return
    // tap-coords-fix: clientX is viewport-based, so subtract the host's own
    // left edge before comparing against its width
    const r = e.currentTarget.getBoundingClientRect()
    turnAt(e.clientX - r.left, r.width, 'host-tap')
  })

  // zoned hover reveal (chrome-round2): cursor in the top/bottom ~20% of
  // the page reveals the header/position when toggled off; zones are page
  // areas (not the elements, which may be display:none) so both-hidden
  // works too. Overlay mode is reflow-free (absolute); classic visibility
  // mode keeps its box. Leave hides.
  let chromeHoverState = ''
  const overlayMode = () => FLAGS.SWITCH_PUT_TOP_MENU_AND_POSITION_TO_HALF_SPACE_VERTICALLY_AND_USE_SAME_HORIZONTAL_AND_VERTICAL_MARGINS === true
  const showChromeEl = el => {
    if (overlayMode()) el.style.display = ''
    else el.style.visibility = 'visible'
    el.style.pointerEvents = ''
  }
  const hideChromeEl = el => {
    if (overlayMode()) el.style.display = 'none'
    else el.style.visibility = 'hidden'
    el.style.pointerEvents = 'none'
  }
  $('#book-page').addEventListener('mousemove', e => {
    if (isTouchPointer()) return // tap-header: compat mouse events after a touch are not hovering
    const r = e.currentTarget.getBoundingClientRect()
    const y = (e.clientY - r.top) / Math.max(1, r.height)
    // ribbon-zone (2026-10-02-12-34-13): while the bookmark ribbon is shown, the area from just left of it to the page's
    // right edge, down to just under it, does not reveal the top menu (and hides it if it was showing)
    let inRibbonZone = false
    { const rb = $('#bm-ribbon')
      if (rb && !rb.classList.contains('hidden')) {
        const rr = rb.getBoundingClientRect()
        inRibbonZone = e.clientX >= rr.left - 16 && e.clientX <= r.right && e.clientY <= rr.bottom + 16
      } }
    const wantHeader = settings.showBookMenu === false && y < 0.2 && !inRibbonZone
    const wantPos = settings.showPosition === false && y > 0.8
    const state = (wantHeader ? 'h' : '') + (wantPos ? 'p' : '')
    if (state === chromeHoverState) return
    chromeHoverState = state
    const header = $('#page-header')
    if (wantHeader) showChromeEl(header)
    else if (settings.showBookMenu === false) hideChromeEl(header)
    const pct = $('#pct-display')
    if (wantPos) showChromeEl(pct)
    else if (settings.showPosition === false) hideChromeEl(pct)
  })
  // position-select-bar: with a selected position (hover-revealed line) the pointer moving onto the bar must not hide it
  $('#book-page').addEventListener('mouseleave', () => { if (posSelText()) return; chromeHoverState = ''; applyChromeVisibility() })

  document.addEventListener('keydown', handleKey)
  wireBookmarkUi()
  wirePositionBar()
  document.addEventListener('mousemove', cursorActivity, { passive: true })
  document.addEventListener('mousedown', cursorActivity, { passive: true })
  // tap-header: which kind of pointer was last used (the book iframe reports its own)
  document.addEventListener('pointerdown', e => { lastPointerType = e.pointerType }, { capture: true, passive: true })
  document.addEventListener('pointermove', e => { lastPointerType = e.pointerType }, { capture: true, passive: true })

  // scroll-to-turn, for the outer document (page padding, black surround,
  // header/footer area) — the book text itself is a separate <iframe>
  // document and is wired independently in wireContentDoc()
  let outerWheelLock = false
  document.addEventListener('wheel', e => {
    if (!view || outerWheelLock) return
    outerWheelLock = true
    setTimeout(() => { outerWheelLock = false }, 350)
    if (e.deltaY > 0) view.goRight?.() ?? view.renderer?.next()
    else if (e.deltaY < 0) view.goLeft?.() ?? view.renderer?.prev()
  }, { passive: true })

  document.addEventListener('fullscreenchange', () => {
    lastFsEventAt = Date.now() // settle-guard
    debugBeacon('fullscreenchange', { fsEl: !!document.fullscreenElement, ...debugGeom() })
    // freeze-fullscreen-size: pin (or release) pixel sizes before any
    // capture/schedule below; while frozen those calls become no-ops via
    // the scheduleRestore() guard. requestFullscreen() already pinned
    // pre-change; this covers the remaining DOM-fullscreen entries.
    // (Physical F11 fires no DOM event — see display-mode listener below.)
    if (document.fullscreenElement) freezeFullscreenSize()
    else unfreezeFullscreenSize()
    document.getElementById('app').classList.toggle('fullscreen', !!document.fullscreenElement)
    cursorActivity() // hide-cursor: start or stop the idle timer
    updateChromeVisibility()
    // fixed-page-size (2026-09-28-23-12-51): no capture/restore here; the page
    // size does not depend on fullscreen. A real host size change (clamp case)
    // is still caught by resizeObserver below.
  })

  // watch the actual page content area for size changes, from any cause
  // (window resize, fullscreen, sidebar show/hide) and correct drift
  resizeObserver.observe($('#viewer-host'))

  // physical F11 (browser-chrome fullscreen): no DOM fullscreenchange fires,
  // but display-mode flips where the browser supports it — pin the
  // remembered windowed sizes so the page snaps back instead of reflowing.
  // Best-effort and idempotent with the DOM path above (frozen guard).
  try {
    displayModeMql = window.matchMedia?.('(display-mode: fullscreen)') ?? null
    displayModeMql?.addEventListener?.('change', e => {
      lastFsEventAt = Date.now() // settle-guard
      debugBeacon('display-mode', { matches: e.matches, ...debugGeom() })
      cursorActivity() // hide-cursor: start or stop the idle timer
      // fixed-page-size (2026-09-28-23-12-51): freeze helpers are no-ops with the
      // flag off; no restore here (resizeObserver covers real size changes).
      if (e.matches && !document.fullscreenElement) freezeFullscreenSizeFromSnapshot()
      else if (!e.matches && !document.fullscreenElement) unfreezeFullscreenSize()
    })
  } catch {}

  applyRoundedCorners()
  applyColorVars() // monitor / page colors also for the Library, before any book opens
  updateChromeVisibility()

  await refreshLibrary()

  // unified-chrome: open the last viewed book when the switch is on and a
  // book was opened before; fresh installs (or switch off) land on Library
  let openedLastBook = false
  if (FLAGS.SWITCH_OPEN_LAST_VIEWED_BOOK_ON_START === true) {
    try {
      const books = await idbGetAll('books')
      books.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
      const last = books.find(b => b.openedAt)
      if (last) { bootChosen = true; await openBook(last.id); openedLastBook = true }
    } catch {}
  }
  if (!openedLastBook) { bootChosen = true; showLibrary() }
  revealApp()
  initWakeLock()
  maybeImportBundledAtStart().catch(() => {}) // dictionary mode 'start': background import, not awaited

  if (settings.startFullscreen === true) {
    try { requestFullscreen() } catch {}
  }

  // offline-copy-settings (2026-10-06-20-10-00): the setting "Keep app in cache" decides: register the worker, or remove it
  await initInstallToast() // install-toast: what is still missing, before the worker and the dictionary import start
  initAppUpdate() // update-notices: before the worker is registered, so the page's first controller is known
  applyOfflineSetting().catch(() => {})
}

/* offline copy (offline-copy-settings, 2026-10-06-20-10-00; replaces pwa-offline's unregister-on-exit).
   Settings > App > "Keep app in cache" = settings.keepAppCache 'auto' | 'true' | 'false' (null = the flag
   SWITCH_DEFAULT_KEEP_APP_IN_CACHE_FOR_OFFLINE_ACCESS_ON_CLOSING_WEB_PAGE). Yes: the service worker (sw.js) is registered and
   keeps the app files in the cache, so the app opens offline. No: no worker and no cached files; an existing copy is removed
   at once when the setting changes and at every start, so nothing is left behind after closing the page (no stale files on
   localhost). Auto: Yes on https hosting, No on development addresses. Only the app files are touched; books, bookmarks,
   settings and the dictionary (IndexedDB) never. Needs https or localhost (elsewhere there are no service workers). */
const isDevAddress = () => {
  const h = location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.local')
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}
function getKeepApp() { // 'auto' | true | false
  const v = settings.keepAppCache
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'auto') return 'auto'
  const f = FLAGS.SWITCH_DEFAULT_KEEP_APP_IN_CACHE_FOR_OFFLINE_ACCESS_ON_CLOSING_WEB_PAGE
  return f === true || f === false ? f : 'auto'
}
const keepAppNow = () => { const k = getKeepApp(); return k === 'auto' ? !isDevAddress() : k }
/* install-toast (2026-10-09-12-00-47): "Install complete" when what was missing at the start has been done by the app itself:
   the offline copy (the service worker has cached the files; only when Keep app in cache is on and the browser has service
   workers) and the bundled dictionary (only when "Import dictionary at" is Start and it is not installed yet). Only what is
   really missing counts, so an app that is ready never shows it; a failure shows nothing (the Settings status lines say what
   went wrong); it is skipped while Settings is open, and by SWITCH_SHOW_INSTALL_TOASTS = false. "Dictionary updated" is the same
   kind of toast for the automatic update of the bundled dictionary. Removing things shows no toast (the buttons are in Settings). */
const installState = { offline: false, dict: false, fired: false }
const toastUnlessSettings = msg => {
  if (FLAGS.SWITCH_SHOW_INSTALL_TOASTS === false || $('#settings-view')?.classList.contains('show')) return
  showToast(msg)
}
const toastUninstall = () => { if (FLAGS.SWITCH_SHOW_UNINSTALL_TOAST !== false) showToast('Uninstall complete') } // even while Settings is open
function installDone(kind) {
  if (!installState[kind]) return
  installState[kind] = false
  if (installState.offline || installState.dict || installState.fired) return
  installState.fired = true
  toastUnlessSettings('Install complete')
}
async function initInstallToast() {
  try {
    if ('serviceWorker' in navigator && keepAppNow() && (await ownCacheKeys()).length === 0) installState.offline = true
    if (getDictLoad() === 'start' && getDictShow() !== 'never' && !dictInstalled(BUNDLED_DICT.id)) installState.dict = true
  } catch {}
}

/* update-notices (2026-10-06-20-20-00): which app version runs, and "App update ready" in Settings > App.
   APP_VERSION must be changed with every patch, together with CACHE in sw.js (both are the patch's UTC stamp).
   With "Keep app in cache" on, a newer sw.js is downloaded in the background by the browser; sw.js skips waiting and claims the
   page, so the new files are in the cache when 'controllerchange' fires. The page still runs the old code until it reloads:
   the Reload button (a plain reload, not "Load fresh app"). A first install is not an update (the page had no controller),
   and neither is a worker added after the user removed the offline copy in this session. A check for a newer worker is made
   when the app becomes visible again, at most once an hour. */
const APP_VERSION = '2026-10-10-21-24-31'
let appUpdateReady = false, appUpdateCheckedAt = 0, swTouched = false
function renderAppUpdate() {
  $('#app-update-row')?.classList.toggle('hidden', !appUpdateReady)
}
function initAppUpdate() {
  if (!('serviceWorker' in navigator)) return
  const hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || swTouched || appUpdateReady) return
    appUpdateReady = true
    renderAppUpdate()
  })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkAppUpdate() })
}
async function checkAppUpdate() {
  if (!keepAppNow() || Date.now() - appUpdateCheckedAt < 3600000) return
  appUpdateCheckedAt = Date.now()
  try { const r = await navigator.serviceWorker.getRegistration(); await r?.update() } catch {}
}
/* scope-safe (2026-10-07-12-54-28): all the sites of one GitHub account share the address username.github.io, so only SM Reader's
   own service worker (its scope = the folder of this app) and its own caches are looked at or deleted, never other apps'.
   OWN_CACHE_PREFIX must match CACHE_PREFIX in sw.js; the second form is the plain stamp used before the prefix existed. */
const OWN_CACHE_PREFIX = 'sm-reader-'
const ownScope = () => new URL('./', location.href).href
const isOwnCacheKey = k => k.startsWith(OWN_CACHE_PREFIX) || /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(k)
async function ownRegistrations() {
  try { return ((await navigator.serviceWorker.getRegistrations()) || []).filter(r => r.scope === ownScope()) } catch { return [] }
}
async function ownCacheKeys() {
  try { return typeof caches === 'undefined' ? [] : (await caches.keys()).filter(isOwnCacheKey) } catch { return [] }
}
// delete SM Reader's own service worker registration and caches (the app files only; see above)
async function removeOfflineCopy() { // returns true when something was there to remove
  swTouched = true // a worker added after this is not an app update
  let removed = false
  try { const rs = await ownRegistrations(); removed = rs.length > 0; await Promise.all(rs.map(r => r.unregister())) } catch {}
  try { const ks = await ownCacheKeys(); removed = removed || ks.length > 0; await Promise.all(ks.map(k => caches.delete(k))) } catch {}
  return removed
}
// make the state match the setting: Yes = register (the worker caches the files when it installs), No = remove
async function applyOfflineSetting(fromUser = false) {
  if (!('serviceWorker' in navigator)) { renderOfflineStatus(); return }
  try {
    if (keepAppNow()) {
      await navigator.serviceWorker.register('./sw.js')
      navigator.serviceWorker.ready.then(async () => { // active = the files are cached
        await renderOfflineStatus()
        if ((await ownCacheKeys()).length) installDone('offline')
      }).catch(() => {})
    } else if (await removeOfflineCopy() && fromUser) toastUninstall() // fromUser: the Keep app in cache control was changed
  } catch {}
  renderOfflineStatus()
}
async function renderOfflineStatus() {
  const st = $('#offline-status')
  if (!st) return
  const btn = $('#offline-remove-btn')
  if (!('serviceWorker' in navigator) || typeof caches === 'undefined') {
    st.textContent = 'Offline copy: not available here (needs https or localhost)'
    btn.disabled = true
    return
  }
  let files = 0, worker = false
  try { for (const k of await ownCacheKeys()) files += (await (await caches.open(k)).keys()).length } catch {}
  try { worker = (await ownRegistrations()).length > 0 } catch {}
  st.textContent = files ? `Offline copy: saved (${files} files)` : worker ? 'Offline copy: being saved…' : 'Offline copy: none'
  btn.disabled = !(files || worker)
}
function renderOfflineUi() {
  const sel = $('#keep-app')
  if (!sel) return
  $('#app-version').textContent = 'App version: ' + APP_VERSION
  renderAppUpdate()
  const k = getKeepApp()
  sel.value = k === 'auto' ? 'auto' : String(k)
  renderOfflineStatus()
}
function wireOfflineUi() {
  $('#app-update-btn').addEventListener('click', () => location.reload()) // the new files are in the cache already
  $('#keep-app').addEventListener('change', e => { settings.keepAppCache = e.target.value; saveSettings(); applyOfflineSetting(true) })
  $('#offline-remove-btn').addEventListener('click', async () => {
    $('#offline-remove-btn').disabled = true
    const removed = await removeOfflineCopy()
    renderOfflineStatus()
    if (removed) toastUninstall()
  })
}

main().catch(err => { console.error('[SM] startup failed', err); bootFailsafe('crash') })
