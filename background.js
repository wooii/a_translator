var FETCH_TIMEOUT = 12000;

chrome.runtime.onInstalled.addListener(function() {
  chrome.contextMenus.create({
    id: 'translate',
    title: "Translate",
    contexts: ["selection"]
  });
  chrome.storage.sync.get(['targetLanguage', 'provider'], function(data) {
    var updates = {};
    if (!data.targetLanguage) updates.targetLanguage = 'en';
    if (!data.provider) updates.provider = 'browser';
    if (Object.keys(updates).length) chrome.storage.sync.set(updates);
  });
});

chrome.contextMenus.onClicked.addListener(function(info, tab) {
  if (!info.selectionText) return;
  chrome.tabs.sendMessage(tab.id, {
    action: 'translate_request', text: info.selectionText
  }).catch(function() {});
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'translate') {
    doTranslate(request.text).then(function(result) {
      sendResponse({ translation: result.translation, moreUrl: result.moreUrl });
    }).catch(function(e) {
      sendResponse({ error: e.message });
    });
    return true;
  }
});

function doTranslate(text) {
  return chrome.storage.sync.get('targetLanguage').then(function(settings) {
    return translateGoogle(text, settings.targetLanguage || 'en');
  });
}

function fetchWithTimeout(url, ms) {
  var controller = new AbortController();
  var id = setTimeout(function() { controller.abort(); }, ms);
  return fetch(url, { signal: controller.signal }).then(function(r) {
    clearTimeout(id);
    return r;
  }).catch(function(e) {
    clearTimeout(id);
    if (e.name === 'AbortError') throw new Error('Connection timed out (server unreachable)');
    if (e.name === 'TypeError') throw new Error('Network error — check your internet connection.');
    throw e;
  });
}

function translateGoogle(text, targetLang) {
  var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + targetLang + '&dt=t&q=' + encodeURIComponent(text);
  return fetchWithTimeout(url, FETCH_TIMEOUT).then(function(res) {
    return res.json();
  }).then(function(data) {
    return {
      translation: data[0].map(function(i) { return i[0]; }).join(' '),
      moreUrl: 'https://translate.google.com/?sl=auto&tl=' + targetLang + '&text=' + encodeURIComponent(text) + '&op=translate'
    };
  });
}


