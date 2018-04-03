declare const Zotero: any
declare const Components: any

import { debug } from './debug.ts'

import Queue = require('better-queue')
import MemoryStore = require('better-queue-memory')
import * as ini from 'ini'
import { Events } from './events.ts'
import { DB } from './db/main.ts'
import { Translators } from './translators.ts'
import { Preferences as Prefs } from './prefs.ts'

function queueHandler(kind, handler) {
  return (task, cb) => {
    debug('AutoExport.queue:', kind, task)

    handler(task).then(() => {
      debug('AutoExport.queue:', kind, task, 'completed')
      cb(null)
    }).catch(err => {
      debug('AutoExport.queue:', kind, task, 'failed:', err)
      cb(err)
    })

    return {
      cancel() { task.cancelled = true },
    }
  }
}

const dirsep = Zotero.platform.toLowerCase().startsWith('win') ? '\\' : '/'

const scheduled = new Queue(
  queueHandler('scheduled',
    async task => {
      const db = DB.getCollection('autoexport')
      const ae = db.get(task.id)
      if (!ae) throw new Error(`AutoExport ${task.id} not found`)

      debug('AutoExport.scheduled:', ae)
      ae.status = 'running'
      db.update(ae)

      try {
        let items
        switch (ae.type) {
          case 'collection':
            items = { collection: ae.id }
            break
          case 'library':
            items = { library: ae.id }
            break
          default:
            items = null
        }

        debug('AutoExport.scheduled: starting export', ae)

        let overleaf = ae.path.split(dirsep).slice(0, -1).join(dirsep)
        try {
          const git_config_path = Zotero.File.pathToFile([overleaf, '.git', 'config'].join(dirsep))
          if (git_config_path.exists()) {
            const config = ini.parse(Zotero.File.getContents(git_config_path))
            if (!config['remote "origin"'] || !config['remote "origin"'].url || !config['remote "origin"'].url.startsWith('https://git.overleaf.com/')) overleaf = null
          }
        } catch (err) {
          debug('overleaf detection:', err)
          overleaf = null
        }

        // Zotero.Utilities.Internal.exec('/bin/bash', '-c cd ...')
        if (overleaf) debug(`cd ${overleaf} && git pull`)
        await Translators.translate(ae.translatorID, { exportNotes: ae.exportNotes, useJournalAbbreviation: ae.useJournalAbbreviation}, items, ae.path)
        if (overleaf) debug(`cd ${overleaf} && git add ${ae.path.split(dirsep).slice(-1).join('')} && git push`)

        debug('AutoExport.scheduled: export finished', ae)
        ae.error = ''
      } catch (err) {
        debug('AutoExport.scheduled: failed', ae, err)
        ae.error = `${err}`
      }

      ae.status = 'done'
      db.update(ae)
      debug('AutoExport.scheduled: completed', task, ae)
    }
  ),

  {
    store: new MemoryStore(),
    // https://bugs.chromium.org/p/v8/issues/detail?id=4718
    setImmediate: setTimeout.bind(null),
  }
)
scheduled.resume()

const debounce_delay = 1000
const scheduler = new Queue(
  queueHandler('scheduler',
    async task => {
      task = {...task}

      const db = DB.getCollection('autoexport')
      const ae = db.get(task.id)
      if (!ae) throw new Error(`AutoExport ${task.id} not found`)

      debug('AutoExport.scheduler:', task, '->', ae, !!ae)
      ae.status = 'scheduled'
      db.update(ae)
      debug('AutoExport.scheduler: waiting...', task, ae)

      await Zotero.Promise.delay(debounce_delay)

      debug('AutoExport.scheduler: woken', task, ae)

      if (task.cancelled) {
        debug('AutoExport.scheduler: cancel', ae)
      } else {
        debug('AutoExport.scheduler: start', ae)
        scheduled.push(task)
      }
    }
  ),

  {
    store: new MemoryStore(),
    cancelIfRunning: true,
    // https://bugs.chromium.org/p/v8/issues/detail?id=4718
    setImmediate: setTimeout.bind(null),
  }
)

if (Prefs.get('autoExport') !== 'immediate') { scheduler.pause() }

if (Zotero.Debug.enabled) {
  for (const event of [ 'empty', 'drain', 'task_queued', 'task_accepted', 'task_started', 'task_finish', 'task_failed', 'task_progress', 'batch_finish', 'batch_failed', 'batch_progress' ]) {
    (e => scheduler.on(e, (...args) => { debug(`AutoExport.scheduler.${e}`, args) }))(event);
    (e => scheduled.on(e, (...args) => { debug(`AutoExport.scheduled.${e}`, args) }))(event)
  }
}

const idleObserver = {
  observe(subject, topic, data) {
    debug(`AutoExport.idle: ${topic}`)
    if (Prefs.get('autoExport') !== 'idle') { return }
    switch (topic) {
      case 'back': case 'active':
        scheduler.pause()
        break

      case 'idle':
        scheduler.resume()
        break
    }
  },
}
const idleService = Components.classes['@mozilla.org/widget/idleservice;1'].getService(Components.interfaces.nsIIdleService)
idleService.addIdleObserver(idleObserver, Prefs.get('autoExportIdleWait'))

Events.on('preference-changed', pref => {
  if (pref !== 'autoExport') { return }

  debug('AutoExport: preference changed')

  switch (Prefs.get('autoExport')) {
    case 'immediate':
      scheduler.resume()
      break
    default: // / off / idle
      scheduler.pause()
  }
})

// export singleton: https://k94n.com/es6-modules-single-instance-pattern
export let AutoExport = new class { // tslint:disable-line:variable-name
  public db: any

  constructor() {
    Events.on('libraries-changed', ids => this.schedule('library', ids))
    Events.on('libraries-removed', ids => this.remove('library', ids))
    Events.on('collections-changed', ids => this.schedule('collection', ids))
    Events.on('collections-removed', ids => this.remove('collection', ids))
  }

  public init() {
    this.db = DB.getCollection('autoexport')
    for (const ae of this.db.find({ status: { $ne: 'done' } })) {
      scheduler.push({ id: ae.$loki })
    }

    if (Prefs.get('autoExport') === 'immediate') { scheduler.resume() }
  }

  public add(ae) {
    debug('AutoExport.add', ae)
    this.db.removeWhere({ path: ae.path })
    this.db.insert(ae)
  }

  public changed(items) {
    const changed = {
      collections: new Set,
      libraries: new Set,
    }

    for (const item of items) {
      changed.libraries.add(item.libraryID)

      for (let collectionID of item.getCollections()) {
        if (changed.collections.has(collectionID)) continue

        while (collectionID) {
          changed.collections.add(collectionID)
          collectionID = Zotero.Collections.get(collectionID).parentID
        }
      }
    }

    if (changed.collections.size) Events.emit('collections-changed', Array.from(changed.collections))
    if (changed.libraries.size) Events.emit('libraries-changed', Array.from(changed.libraries))
  }

  public schedule(type, ids) {
    debug('AutoExport.schedule:', type, ids, {db: this.db.data, state: Prefs.get('autoExport'), scheduler: !scheduler._stopped, scheduled: !scheduled._stopped})
    for (const ae of this.db.find({ type, id: { $in: ids } })) {
      debug('AutoExport.schedule: push', ae.$loki)
      scheduler.push({ id: ae.$loki })
    }
  }

  public remove(type, ids) {
    debug('AutoExport.remove:', type, ids, {db: this.db.data, state: Prefs.get('autoExport'), scheduler: !scheduler._stopped, scheduled: !scheduled._stopped})
    for (const ae of this.db.find({ type, id: { $in: ids } })) {
      scheduled.cancel(ae.$loki)
      scheduler.cancel(ae.$loki)
      this.db.remove(ae)
    }
  }

  public run(ae) {
    if (typeof ae === 'number') { ae = this.db.get(ae) }

    debug('Autoexport.run:', ae)
    ae.status = 'scheduled'
    this.db.update(ae)
    scheduled.push({ id: ae.$loki })
  }
}
