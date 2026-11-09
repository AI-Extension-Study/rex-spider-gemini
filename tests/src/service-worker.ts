import corePlugin, { REXServiceWorkerModule, registerREXModule } from '@bric/rex-core/service-worker'

import spiderPlugin from '@bric/rex-spider/service-worker'
import geminiSpider from '@bric/rex-spider-gemini/service-worker'

// Keeps every event rex-core dispatches to its modules, so a spec can read
// the records a crawl sent exactly as the data-upload module would get them.
class EventRecorder extends REXServiceWorkerModule {
  events: object[] = []

  moduleName() {
    return 'EventRecorder'
  }

  logEvent(event: object) {
    this.events.push(JSON.parse(JSON.stringify(event)))
  }
}

const recorder = new EventRecorder()

registerREXModule(recorder)

self['rexCorePlugin'] = corePlugin
self['rexSpiderPlugin'] = spiderPlugin
self['rexGeminiPlugin'] = geminiSpider
self['eventRecorder'] = recorder

corePlugin.setup()

spiderPlugin.registerSpider(geminiSpider)
