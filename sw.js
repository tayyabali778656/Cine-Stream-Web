try {
  self.options = {
      "domain": "5gvci.com",
      "zoneId": 11462725
  }
  self.lary = ""
  importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw')
} catch (e) {
  console.warn('Ad network service worker script import blocked:', e);
}
