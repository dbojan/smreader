// SM Reader - paginator.js
// last modified (utc): 2026-10-10-21-24-31
// instructions: on modify, update string.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const rangeA = makeRange(doc, node, start)
        const rangeB = makeRange(doc, node, end)
        const result = cb(rangeA, rangeB)
        const chosen = result < 0 ? start : end
        return chosen
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

// read-back probe (2026-09-29-08-27-26): `probe` is an optional plain object
// filled with debug data only; it never changes the result. See #afterScroll().
// window-edge (2026-09-29-09-18-31): `tol` (default 0 = unchanged behavior) is a
// pixel tolerance on the START edge only. Paginated mode passes about 0.5 px
// with the exact page grid, so a node that ends on the previous page (right =
// the column edge) is not taken as visible, and a first char whose left equals
// the page edge is not skipped by a fractional-pixel window error.
const PAGED_EDGE_TOL_PX = 0.5
// page-bm-edge (2026-10-03-09-48-04): rangeStartOnPage() - a char drawn within this many px of a page's RIGHT edge belongs
// to the next page (layout snaps to 1/64 px, so the first char of the next page can sit a hair inside this window)
const PAGED_EDGE_END_PX = 1
// tap-jitter: net touch drag (px) under which a touch is a tap, not a swipe
const TAP_JITTER_PX = 12
const getVisibleRange = (doc, start, end, mapRect, probe = null, tol = 0) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start - tol && right <= end + tol) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start + tol && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from
    if (probe) {
        try {
            probe.nodeCount = nodes.length
            probe.win = `${Math.round(start * 100) / 100}..${Math.round(end * 100) / 100}`
            probe.tol = tol
            const describe = n => {
                if (!n) return 'none'
                let l = '', r = ''
                try {
                    const rg = doc.createRange()
                    rg.selectNodeContents(n)
                    const m = mapRect(rg.getBoundingClientRect())
                    l = Math.round(m.left * 100) / 100
                    r = Math.round(m.right * 100) / 100
                } catch {}
                return n.nodeType === 1
                    ? `el:${n.localName} l=${l} r=${r}`
                    : `text:${n.parentElement?.localName ?? '?'} len=${n.nodeValue.length} l=${l} r=${r}`
            }
            probe.first = describe(nodes[0])
            probe.second = describe(nodes[1])
            probe.firstIsElement = from.nodeType === 1
            probe.steps = []
        } catch {}
    }

    // find the offset at which visibility changes
    let startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            const res = (p.right < start + tol && q.left > start - tol) ? 0 : (q.left > start - tol ? -1 : 1)
            if (probe?.steps && probe.steps.length < 24) {
                // step: a=[a.start,a.end) b=[b.start,b.end) p.right q.left result
                const f = v => Math.round(v * 100) / 100
                probe.steps.push(`${a.startOffset}-${a.endOffset}|${b.startOffset}-${b.endOffset} pR=${f(p.right)} qL=${f(q.left)} =>${res}`)
            }
            return res
        })
    // skip-hanging-space (2026-09-30-09-18-55): a justified line's trailing space
    // hangs just past the column edge (rect.left == the next page's start), so
    // the start bisect could stop on the LAST char of the previous page (phone
    // log: charT = last row). Paginated mode only (tol > 0): step over the
    // whitespace to the first real char, provided it is still inside the window.
    if (tol > 0 && from.nodeType === 3) {
        const t = from.nodeValue
        let k = startOffset
        while (k < t.length && /\s/.test(t[k])) k++
        if (k > startOffset && k < t.length) {
            try {
                const c = mapRect(getBoundingClientRect(makeRange(doc, from, k, k + 1)))
                if (c.left <= end) { if (probe) probe.skipWs = k - startOffset; startOffset = k }
            } catch {}
        }
    }
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    if (probe) {
        try {
            probe.off = startOffset
            const f = v => Math.round(v * 100) / 100
            if (from.nodeType === 3 && startOffset < from.nodeValue.length) {
                const c = mapRect(getBoundingClientRect(makeRange(doc, from, startOffset, startOffset + 1)))
                probe.charL = f(c.left)
                probe.charT = f(getBoundingClientRect(makeRange(doc, from, startOffset, startOffset + 1)).top)
            }
            if (from.nodeType === 3 && startOffset > 0) {
                const c = mapRect(getBoundingClientRect(makeRange(doc, from, startOffset - 1, startOffset)))
                probe.prevL = f(c.left)
                probe.prevR = f(c.right)
            }
        } catch {}
    }
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        sel.removeAllRanges()
        if (collapse === -1) range.collapse(true)
        else if (collapse === 1) range.collapse()
        sel.addRange(range)
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                this.docBackground = getBackground(doc)
                doc.body.style.background = 'none'
                const background = this.docBackground
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => this.expand())

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        if (!layout || !this.document) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ margin, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${margin*1.5}px ${gap}px` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            // FIX 2026-09-26-23-12-22: was Math.trunc(columnWidth), which
            // always rounds down. That drifts the browser's real column
            // boundaries away from the pageIndex * this.size grid (this.size
            // is the unrounded fractional container width), compounding per
            // column. Math.round halves the average per-column error instead
            // of it accumulating in one direction. Candidate from the
            // 2026-09-26-18-27-48 session, now tested after the larger
            // getVisibleRange page-shift bug (fixed 2026-09-26-23-05-17) was
            // no longer masking this smaller effect.
            'column-width': `${Math.round(columnWidth)}px`,
            'column-gap': vertical ? `${margin}px` : `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${margin / 2}px ${gap}px` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin, gap } = this.#layout
            const padding = this.#vertical ? `0 ${gap}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container" part="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange, 'anchor', 'keyboard-selection')
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target, 'anchor', 'focusin')))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#replaceBackground(this.#view.docBackground, this.columnCount)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView() {
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => this.#scrollToAnchor(this.#anchor, 'anchor', 'onExpand'),
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #replaceBackground(background, columnCount) {
        const doc = this.#view?.document
        if (!doc) return
        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)
        const themeBgColor = htmlStyle.getPropertyValue('--theme-bg-color')
        if (background && themeBgColor) {
            const parsedBackground = background.split(/\s(?=(?:url|rgb|hsl|#[0-9a-fA-F]{3,6}))/)
            parsedBackground[0] = themeBgColor
            background = parsedBackground.join(' ')
        }
        if (/cover.*fixed|fixed.*cover/.test(background)) {
            background = background.replace('cover', 'auto 100%').replace('fixed', '')
        }
        this.#background.innerHTML = ''
        this.#background.style.display = 'grid'
        this.#background.style.gridTemplateColumns = `repeat(${columnCount}, 1fr)`
        for (let i = 0; i < columnCount; i++) {
            const column = document.createElement('div')
            column.style.background = background
            column.style.width = '100%'
            column.style.height = '100%'
            this.#background.appendChild(column)
        }
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = vertical ? (size / divisor - margin) : (size / divisor - gap)
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.columnCount = divisor
        this.#replaceBackground(background, this.columnCount)

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    render() {
        if (!this.#view) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor, 'anchor', 'render')
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    // this is the current position of the container
    get containerPosition() {
        return this.#container[this.scrollProp]
    }

    // this is the new position of the containr
    set containerPosition(newVal) {
        this.#container[this.scrollProp] = newVal
    }

    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        this.containerPosition = Math.max(min, Math.min(max,
            this.containerPosition + delta))
    }

    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
            acc: 0, // tap-jitter: net scroll applied by touchmove (px, page axis)
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        const doc = this.#view?.document
        const selection = doc?.getSelection()
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        if (Math.abs(dx) >= Math.abs(dy)) {
            this.scrollBy(dx, 0)
            if (!this.#vertical) state.acc += dx
        } else if (Math.abs(dy) > Math.abs(dx)) {
            this.scrollBy(0, dy)
            if (this.#vertical) state.acc += dy
        }
    }
    #onTouchEnd() {
        const moved = this.#touchScrolled
        this.#touchScrolled = false
        if (this.scrolled) return
        // tap-vs-snap (2026-09-28-12-02-23): a pure tap (no touchmove) has
        // nothing to snap; snap(0, 0) re-pins the *current* page one frame
        // later and cancels the page turn the app's tap handler just started
        // (log: every tap on a text page was followed by relocate reason=snap
        // back at the same page). Swipes and drags still snap as before.
        if (!moved) return

        // tap-jitter (2026-09-29-14-26-56): a finger that wobbles a few px during
        // a tap fired touchmove, so snap() used its velocity (dx/dt of a tiny,
        // fast move) and threw the view 1-2 pages on a narrow page (log: three
        // reason=snap moves with no turn). A net drag under TAP_JITTER_PX is not
        // a swipe: put the container back exactly where the touch started
        // (synchronously, so the tap's own page turn still runs) and do not snap.
        const st = this.#touchState
        if (st && !st.pinched && Math.abs(st.acc) < TAP_JITTER_PX) {
            if (st.acc) {
                if (this.#vertical) this.scrollBy(0, -st.acc)
                else this.scrollBy(-st.acc, 0)
            }
            if (window.SM_READER_DEBUG_BEACON) window.SM_READER_DEBUG_BEACON('touch-jitter', { acc: Math.round(st.acc * 100) / 100 })
            return
        }

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const mappedLeft = this.#getRectMapper()(rect).left
        // FIX 2026-09-27-10-17-58 (Case B): snapshot size ONCE per chain.
        // size/start/end are live reads (getBoundingClientRect / scrollLeft)
        // and drift between reads (fractional container width, browser-rounded
        // scrollLeft), which flipped floor() a whole page on boundary targets.
        // pageIndex AND offset below both derive from this one snapSize, so no
        // inter-read drift inside this call. (Supersedes the 10-07-59 0.5px
        // epsilon, whose worked example had the arithmetic backwards.)
        const snapSize = this.size
        let pageIndex = Math.floor(mappedLeft / snapSize)
        // Residual float-dust epsilon only, scale-aware (1e-4 * size, ~0.035px
        // at 353px pages): rounds up only when the target sits essentially
        // exactly on the next boundary. Genuinely last-on-page targets (>dust
        // before the boundary) are unaffected. NOT the old +/-1 adjustment.
        const dust = 1e-4 * snapSize
        if ((pageIndex + 1) * snapSize - mappedLeft > 0
            && (pageIndex + 1) * snapSize - mappedLeft < dust) pageIndex += 1
        // PROBE 2026-09-27-11-24-24 (exact-char landing test, default off):
        // scroll to the char's own pixel instead of the page start, so the
        // anchor char sits exactly at the viewport edge (sliced columns, and
        // the next page-turn re-snaps on-grid). Same offset math sign
        // convention as #scrollToPage; read live so devtools flips apply.
        // Remove or promote to a setting once the product call is made.
        // restore-page-spacer-offset (2026-09-28-08-57-26): rects are in
        // iframe coords, but View.expand() centers the iframe inside an
        // element one page wider on each side, so container page p shows
        // iframe page p-1 (page 0 is a blank spacer). The +1/-1 below
        // (upstream's own) is the other half of the `- size` shift restored
        // in #getVisibleRange(); the two must stay paired. The exact-char
        // probe gets the same one-page shift so it stays consistent.
        const exactChar = window.SM_READER_FLAGS?.SWITCH_SCROLL_EXACT_CHAR === true
        const page = pageIndex + (this.#rtl ? -1 : 1)
        const offset = exactChar
            ? (this.#rtl ? snapSize - mappedLeft : mappedLeft + snapSize)
            : snapSize * (this.#rtl ? -page : page)
        const result = await this.#scrollTo(offset, reason, undefined)
        return result
    }
    async #scrollTo(offset, reason, smooth) {
        const { size } = this
        if (this.containerPosition === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            this.containerPosition, offset, 300, easeOutQuad,
            x => this.containerPosition = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            this.containerPosition = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation', 'public-api')
    }
    async #scrollToAnchor(anchor, reason = 'anchor', source = 'unknown') {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = Math.round(anchor * (textPages - 1))
        await this.#scrollToPage(newPage + 1, reason, undefined)
    }
    // bm-onpage (2026-10-03-08-47-15): is the first char of `range` drawn inside the current page window? Same window
    // and rect mapping as #getVisibleRange(), so it agrees with what that call treats as this page. null = unknown.
    rangeStartOnPage(range) {
        try {
            const r = range.getClientRects()[0] ?? range.getBoundingClientRect()
            if (!r || (!r.width && !r.height)) return null
            const { left } = this.#getRectMapper()(r)
            let s, e, tol = 0
            if (this.scrolled) { s = this.start + this.#margin; e = this.end - this.#margin }
            else {
                const size = this.#rtl ? -this.size : this.size
                const pageSize = this.size
                const gridStart = this.page * pageSize
                if (Math.abs(this.start - gridStart) < 1) { s = gridStart - size; e = gridStart + pageSize - size; tol = PAGED_EDGE_TOL_PX }
                else { s = this.start - size; e = this.end - size }
            }
            return left >= s - tol && left < e - (this.scrolled ? 0 : PAGED_EDGE_END_PX)
        } catch { return null }
    }
    #getVisibleRange(probe = null) {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper(), probe)
        // restore-page-spacer-offset (2026-09-28-08-57-26): back to upstream.
        // The window is in container coords but the mapper works on iframe
        // coords, which sit one page (`size`) inside the container (leading
        // spacer page, see View.expand()); shift back by that page. Paired
        // with the +1/-1 in #scrollToRect() (both were dropped 2026-09-26,
        // which made reads/scrolls one page off at section edges).
        const size = this.#rtl ? -this.size : this.size
        // window-edge (2026-09-29-09-18-31): `start` is an integer scrollLeft
        // but the true page edge is page*size (fractional). Rounding down made
        // odd pages read the node ending on the previous page; rounding up
        // skipped a first char on the edge. When the container sits on the
        // page grid (within 1 px), use the exact grid edge and a small
        // tolerance; otherwise (off-grid scroll) keep the old window.
        const pageSize = this.size
        const gridStart = this.page * pageSize
        const onGrid = Math.abs(this.start - gridStart) < 1
        if (probe) probe.grid = onGrid ? 'exact' : 'start'
        if (onGrid) return getVisibleRange(this.#view.document,
            gridStart - size, gridStart + pageSize - size, this.#getRectMapper(), probe, PAGED_EDGE_TOL_PX)
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper(), probe)
    }
    #afterScroll(reason) {
        // read-back probe (2026-09-29-08-27-26): debug only, page turns and jumps
        const probe = (window.SM_READER_FLAGS?.SWITCH_PROBE_READBACK === true
            && (reason === 'page' || reason === 'navigation')) ? {} : null
        const range = this.#getVisibleRange(probe)
        if (probe) {
            try {
                const extra = {
                    reason, pSize: this.size, pStart: this.start, pEnd: this.end,
                    pPage: this.page, pPages: this.pages,
                    grid: probe.grid, tol: probe.tol, skipWs: probe.skipWs ?? 0,
                    nodes: probe.nodeCount, win: probe.win, first: probe.first, second: probe.second,
                    off: probe.off, charL: probe.charL, charT: probe.charT,
                    prevL: probe.prevL, prevR: probe.prevR,
                    steps: (probe.steps ?? []).join(' ; '),
                }
                if (window.SM_READER_DEBUG_BEACON) window.SM_READER_DEBUG_BEACON('probe-readback', extra)
                else console.log('[SM PROBE] probe-readback', extra)
            } catch {}
        }
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select }) {
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return !this.atStart
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return !this.atEnd
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        const prev = dir === -1
        const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
        if (shouldGo) await this.#goTo({
            index: this.#adjacentIndex(dir),
            anchor: prev ? () => 1 : () => 0,
        })
        if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        this.#locked = false
    }
    async prev(distance) {
        return await this.#turnPage(-1, distance)
    }
    async next(distance) {
        return await this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    setStyles(styles) {
        this.#styles = styles
        const $$styles = this.#styleMap.get(this.#view?.document)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles

        // NOTE: needs `requestAnimationFrame` in Chromium
        requestAnimationFrame(() => {
            if (!this.#view?.document) return
            // theme-bg-refresh (2026-10-10-21-24-31): the background divs (spacer/gap
            // fill) were repainted from the stale docBackground captured at section
            // load, so a theme change left the old color on the spacer and a 1px
            // edge. Re-read the live doc (theme CSS is in place by now).
            try { this.#view.docBackground = getBackground(this.#view.document) } catch {}
            this.#replaceBackground(this.#view.docBackground, this.columnCount)
        })

        // needed because the resize observer doesn't work in Firefox
        this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#view.destroy()
        this.#view = null
        this.sections[this.#index]?.unload?.()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
