// SM Reader - dict-worker.js
// last modified (utc): 2026-10-07-12-54-28
// instructions: on modify, update string.
// Dictionary importer (dictionary-bundled-import): a classic Web Worker (new Worker('./js/dict-worker.js')).
// Reads a dictionary file (JSON Lines, gzip or plain; the format is decided by the header line and the first two bytes,
// never by the file name) and writes it into IndexedDB 'sm_reader': stores dictInfo, dictEntries, dictForms.
// It opens the database WITHOUT a version number, so it can never start an upgrade: the page (openDB() in app.js) has
// already created the stores.
//
// Message in:  { cmd: 'import', dbName, id, bundled, build, url, file, askIfExists, batchSize, relaxed }   (url = bundled file, file = a File chosen by the user;
//              askIfExists: when that dictionary is already installed, ask the page first; batchSize: records per write transaction
//              (10..50000, default 100); relaxed: write the batches with durability 'relaxed'; chunkEntries: words per chunk
//              record (8..2000, default 128))
//              { cmd: 'answer', yes } = the page's answer to 'exists'
// Messages out: { type: 'started', id }  { type: 'progress', pct }  { type: 'done', info }  { type: 'error', message }
//               { type: 'exists', id, name } (waits for the answer)  { type: 'cancelled' } (the answer was No)
//               { type: 'timing', ... } just before 'done': where the time went (dict-import-timing, 2026-10-05-09-16-55)
//
// File: line 1 header {"format":"smr-dict","version":2,"name":...}; entry lines {"w":"sling","g":[["n",["def",...]],...]};
// form lines {"f":"slung","h":["sling"],"p":["v"]}  (p = optional: the parts of speech, one string of letters per headword;
// the app then shows only those senses of the headword. Files without p show all senses.)
//
// Storage layout 2 (dict-chunked-store, 2026-10-05-09-23-00): one record per CHUNK of consecutive entries, not per word:
// dictEntries { d: id, w: first word of the chunk, c: [[word, groups], ...] } (about 1/128 of the records, much faster to write);
// a word is found with one cursor query (the last chunk whose first word is <= the word). This needs the entries sorted by
// word (JavaScript string order); the worker refuses a file that is not. dictForms stay one record per form.

let BATCH = 100 // records (chunks or forms) per write transaction; set from the message in run()
let CHUNK = 128 // words per chunk record; set from the message in run()
const now = () => performance.now()

const post = msg => self.postMessage(msg)
const errText = err => String((err && err.message) ? err.message : err).slice(0, 200)

let answerResolve = null
const waitAnswer = () => new Promise(resolve => { answerResolve = resolve })
self.onmessage = e => {
  const m = e.data || {}
  if (m.cmd === 'answer') { const r = answerResolve; answerResolve = null; if (r) r(!!m.yes); return }
  if (m.cmd !== 'import') return
  run(m).catch(err => (err && err.cancelled) ? post({ type: 'cancelled' }) : post({ type: 'error', message: errText(err) }))
}

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name) // no version: never upgrades
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('cannot open the database'))
  })
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('database write failed'))
    tx.onabort = () => reject(tx.error || new Error('database write aborted'))
  })
}
const slug = s => String(s || 'file').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file'

async function openSource(m) {
  if (m.file) return { stream: m.file.stream(), total: m.file.size }
  const res = await fetch(m.url, { cache: 'no-store' })
  if (!res.ok) throw new Error('cannot load the dictionary file (HTTP ' + res.status + ')')
  if (!res.body) throw new Error('cannot read the dictionary file')
  return { stream: res.body, total: Number(res.headers.get('content-length')) || 0 }
}

// reads the first two bytes (gzip magic 1f 8b), then hands back a stream of the whole file; counted.bytes = bytes read so far
async function sniff(stream) {
  const reader = stream.getReader()
  let head = new Uint8Array(0)
  let ended = false
  while (head.length < 2 && !ended) {
    const r = await reader.read()
    if (r.done) { ended = true; break }
    const t = new Uint8Array(head.length + r.value.length)
    t.set(head); t.set(r.value, head.length)
    head = t
  }
  const gz = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b
  const counted = { bytes: 0 }
  let sent = false
  const rest = new ReadableStream({
    async pull(c) {
      if (!sent) {
        sent = true
        if (head.length) { counted.bytes += head.length; c.enqueue(head) }
        if (ended) c.close()
        return
      }
      const r = await reader.read()
      if (r.done) { c.close(); return }
      counted.bytes += r.value.length
      c.enqueue(r.value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
  return { gz, stream: rest, counted }
}

async function run(m) {
  const db = await openDb(m.dbName || 'sm_reader')
  BATCH = Math.min(50000, Math.max(10, (m.batchSize | 0) || 100))
  CHUNK = Math.min(2000, Math.max(8, (m.chunkEntries | 0) || 128))
  const relaxed = m.relaxed === true
  // timing (ms): read = waiting for data (download + unpacking), line = all line handling, write = batch transactions,
  // wipe = deleting an older copy, ask = waiting for the user; parse = line - write inside lines - wipe - ask
  const T = { start: now(), read: 0, line: 0, write: 0, writeInLine: 0, wipe: 0, ask: 0 }
  let inLine = false, batches = 0, textChars = 0
  try {
    for (const s of ['dictInfo', 'dictEntries', 'dictForms']) {
      if (!db.objectStoreNames.contains(s)) throw new Error('the database is not ready, reload the app')
    }
    const src = await openSource(m)
    const { gz, stream, counted } = await sniff(src.stream)
    let body = stream
    if (gz) {
      if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack gzip')
      body = stream.pipeThrough(new DecompressionStream('gzip'))
    }
    const reader = body.getReader()
    const decoder = new TextDecoder('utf-8')

    let header = null, id = m.id || null
    let nEntries = 0, nForms = 0
    let batch = [] // [isForm, record]
    let chunk = [], lastW = null, nChunks = 0 // the chunk being filled: [[word, groups], ...]
    const closeChunk = () => {
      if (!chunk.length) return
      batch.push([false, { d: id, w: chunk[0][0], c: chunk }])
      chunk = []; nChunks++
    }
    let lastPct = -1

    const flush = async () => {
      if (!batch.length) return
      const t0 = now()
      const tx = db.transaction(['dictEntries', 'dictForms'], 'readwrite', relaxed ? { durability: 'relaxed' } : undefined)
      const E = tx.objectStore('dictEntries'), F = tx.objectStore('dictForms')
      for (const [isForm, rec] of batch) (isForm ? F : E).put(rec)
      batch = []
      await txDone(tx)
      const dt = now() - t0
      T.write += dt; batches++
      if (inLine) T.writeInLine += dt
    }
    // header line: check the format, wipe an older copy of this dictionary, store an incomplete info record
    const begin = async obj => {
      if (!obj || obj.format !== 'smr-dict' || obj.version !== 2) {
        throw new Error('not an SM Reader dictionary file (header "smr-dict", version 2 expected)')
      }
      header = obj
      if (!id) id = 'f-' + slug(obj.name)
      if (m.askIfExists) { // already installed: the page asks the user, No stops here before anything is changed
        const tAsk = now()
        const old = await new Promise((resolve, reject) => {
          const q = db.transaction('dictInfo').objectStore('dictInfo').get(id)
          q.onsuccess = () => resolve(q.result || null)
          q.onerror = () => reject(q.error)
        })
        if (old && old.complete === true && old.layout === 2) {
          post({ type: 'exists', id, name: old.name || id })
          if (!(await waitAnswer())) { const c = new Error('cancelled'); c.cancelled = true; throw c }
        }
        T.ask += now() - tAsk
      }
      const tWipe = now()
      const tx = db.transaction(['dictInfo', 'dictEntries', 'dictForms'], 'readwrite')
      tx.objectStore('dictEntries').delete(IDBKeyRange.bound([id], [id, []]))
      tx.objectStore('dictForms').delete(IDBKeyRange.bound([id], [id, []]))
      tx.objectStore('dictInfo').put({
        id, name: obj.name || id, language: obj.language || '', license: obj.license || '', source: obj.source || '',
        version: obj.version, build: m.build | 0, bundled: !!m.bundled, entries: 0, forms: 0, complete: false, layout: 2, chunk: CHUNK,
      })
      await txDone(tx)
      T.wipe += now() - tWipe
      post({ type: 'started', id })
    }
    const onLine = async line => {
      if (!line.trim()) return
      let obj
      try { obj = JSON.parse(line) } catch { throw new Error(header ? 'a line of the file is not valid JSON' : 'not an SM Reader dictionary file (the first line is not JSON)') }
      if (!header) { await begin(obj); return }
      if (obj && typeof obj.w === 'string' && Array.isArray(obj.g)) {
        if (lastW !== null && obj.w < lastW) throw new Error('the entries must be sorted by word ("' + obj.w.slice(0, 30) + '" comes after "' + lastW.slice(0, 30) + '")')
        lastW = obj.w
        chunk.push([obj.w, obj.g]); nEntries++
        if (chunk.length >= CHUNK) closeChunk()
      } else if (obj && typeof obj.f === 'string' && Array.isArray(obj.h)) {
        closeChunk() // the entries come first: a partly filled last chunk is closed at the first form
        const rec = { d: id, f: obj.f, h: obj.h }
        if (Array.isArray(obj.p)) rec.p = obj.p // part of speech per headword (dict-form-pos); absent in older files
        batch.push([true, rec]); nForms++
      } else return // unknown line: ignored
      if (batch.length >= BATCH) await flush()
    }

    const timedLine = async line => { const t0 = now(); inLine = true; try { await onLine(line) } finally { inLine = false; T.line += now() - t0 } }
    let buf = ''
    for (;;) {
      const t0 = now()
      const r = await reader.read()
      T.read += now() - t0
      if (r.done) break
      const txt = decoder.decode(r.value, { stream: true })
      textChars += txt.length
      buf += txt
      let start = 0, nl
      while ((nl = buf.indexOf('\n', start)) >= 0) {
        await timedLine(buf.slice(start, nl))
        start = nl + 1
      }
      buf = buf.slice(start)
      if (src.total) {
        const pct = Math.min(99, Math.floor(counted.bytes / src.total * 100))
        if (pct !== lastPct) { lastPct = pct; post({ type: 'progress', pct }) }
      }
    }
    buf += decoder.decode()
    if (buf.trim()) await timedLine(buf)
    if (!header) throw new Error('not an SM Reader dictionary file (empty file)')
    closeChunk()
    await flush()
    if (!nEntries) throw new Error('the file has no dictionary entries')

    const info = {
      id, name: header.name || id, language: header.language || '', license: header.license || '', source: header.source || '',
      version: header.version, build: m.build | 0, bundled: !!m.bundled, entries: nEntries, forms: nForms, complete: true, importedAt: Date.now(), layout: 2, chunk: CHUNK,
    }
    const tx = db.transaction('dictInfo', 'readwrite')
    tx.objectStore('dictInfo').put(info)
    await txDone(tx)
    const r0 = Math.round
    post({
      type: 'timing', gz, relaxed, batchSize: BATCH, batches, chunks: nChunks, chunkEntries: CHUNK, bytes: counted.bytes, chars: textChars,
      readMs: r0(T.read), parseMs: r0(T.line - T.writeInLine - T.wipe - T.ask), writeMs: r0(T.write), wipeMs: r0(T.wipe), totalMs: r0(now() - T.start),
    })
    post({ type: 'done', info })
  } finally {
    try { db.close() } catch {}
  }
}
