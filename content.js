(function() {
  var popup = null;
  var voices = [];
  var browserTranslators = {};
  var currentUtterance = null;
  var currentSpeechBtn = null;
  var BROWSER_LANG_MAP = { 'zh-CN': 'zh', 'zh-TW': 'zh-Hant', 'iw': 'he' };

  function extensionAlive() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  function browserCapable() {
    return typeof Translator !== 'undefined' && typeof Translator.create === 'function';
  }

  function guessLang(text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return 'zh';
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    if (/[\u0980-\u09ff]/.test(text)) return 'bn';
    if (/[\u0b80-\u0bff]/.test(text)) return 'ta';
    return 'en';
  }

  function detectSourceLang(text) {
    return new Promise(function(resolve) {
      if (typeof LanguageDetector !== 'undefined' && typeof LanguageDetector.create === 'function') {
        LanguageDetector.create().then(function(detector) {
          return detector.detect(text);
        }).then(function(results) {
          if (results && results.length && results[0].detectedLanguage) {
            resolve(results[0].detectedLanguage);
          } else {
            resolve(guessLang(text));
          }
        }).catch(function() { resolve(guessLang(text)); });
      } else {
        resolve(guessLang(text));
      }
    });
  }

  function getBrowserTranslator(src, tgt) {
    var key = src + '|' + tgt;
    if (browserTranslators[key]) return Promise.resolve(browserTranslators[key]);
    return Translator.create({ sourceLanguage: src, targetLanguage: tgt }).then(function(t) {
      browserTranslators[key] = t;
      return t;
    });
  }

  function translateWithBrowser(text, targetLang) {
    var tgt = BROWSER_LANG_MAP[targetLang] || targetLang;
    return detectSourceLang(text).then(function(src) {
      if (src === tgt) return text;
      return getBrowserTranslator(src, tgt).then(function(t) {
        return t.translate(text).then(function(out) {
          return normalizePunct(out);
        });
      });
    });
  }

  function normalizePunct(s) {
    if (!s || /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return s;
    var map = { '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':', '、': ',', '（': '(', '）': ')', '「': '"', '」': '"', '『': '"', '』': '"', '【': '[', '】': ']' };
    var out = '';
    for (var i = 0; i < s.length; i++) out += map[s[i]] || s[i];
    return out.replace(/\s+([,.!?;:])/g, '$1').replace(/([,;])(?=[A-Za-z])/g, '$1 ');
  }

  var loadingTimer = null;

  function startLoadingAnimation() {
    stopLoadingAnimation();
    var dots = document.getElementById('loading-dots');
    if (!dots) return;
    var count = 3;
    dots.textContent = '...';
    function tick() {
      if (!dots.isConnected) { stopLoadingAnimation(); return; }
      count = count % 3 + 1;
      dots.textContent = new Array(count + 1).join('.');
    }
    loadingTimer = setInterval(tick, 300);
  }

  function stopLoadingAnimation() {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
  }

  function showLoadingPopup(text) {
    if (popup) popup.remove();
    popup = document.createElement('div');
    popup.id = 'translation-popup';
    popup.innerHTML = '<div class="popup-content"><span id="selected-text">' + esc(text) +
                      '</span><p id="translation-text">Loading<span id="loading-dots">…</span></p></div>';
    document.body.appendChild(popup);
    addPopupEventListeners();
    adjustPopupSize();
    startLoadingAnimation();
  }

  function getSelectionRect() {
    var sel = window.getSelection();
    if (sel.rangeCount > 0) {
      var r = sel.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, top: r.bottom, width: r.width };
    }
    return { left: 0, top: 0, width: 0 };
  }

  function addSearchIcon() {
    var existing = document.querySelector('#search-icon');
    if (existing) existing.remove();

    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var rect = range.getBoundingClientRect();

    var el = document.createElement('div');
    el.id = 'search-icon';
    el.textContent = '🔍';
    Object.assign(el.style, {
      position: 'fixed', backgroundColor: '#FFF', border: '1px solid #ccc',
      borderRadius: '50%', padding: '5px', boxShadow: '0 0 5px rgba(0,0,0,0.3)',
      cursor: 'pointer', zIndex: '2147483646',
      width: '36px', height: '36px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '18px', lineHeight: '1',
      left: (rect.left + 5) + 'px', top: (rect.bottom - 2) + 'px'
    });
    document.body.appendChild(el);

    el.addEventListener('mousedown', function(e) { e.preventDefault(); });

    el.addEventListener('mouseup', function(e) {
      e.stopPropagation();
      sel.removeAllRanges();
      sel.addRange(range);
      var text = sel.toString().trim();
      if (!text) { el.remove(); return; }
      el.remove();
      translateSelection(text);
    });

    function onSelChange() {
      var s = window.getSelection();
      if (s.isCollapsed || s.toString() === '') {
        el.remove();
        document.removeEventListener('selectionchange', onSelChange);
      }
    }
    document.addEventListener('selectionchange', onSelChange);
  }

  var ON_DEVICE_TIMEOUT = 45000;

  function withTimeout(promise, ms) {
    return new Promise(function(resolve, reject) {
      var id = setTimeout(function() { reject(new Error('on-device timeout')); }, ms);
      promise.then(function(v) {
        clearTimeout(id);
        resolve(v);
      }, function(e) {
        clearTimeout(id);
        reject(e);
      });
    });
  }

  function translateSelection(text) {
    if (!extensionAlive()) return;
    showLoadingPopup(text);
    chrome.storage.sync.get(['provider', 'targetLanguage'], function(settings) {
      if (settings.provider === 'google' || !browserCapable()) {
        sendToBackground(text);
        return;
      }
      withTimeout(translateWithBrowser(text, settings.targetLanguage || 'en'), ON_DEVICE_TIMEOUT).then(function(out) {
        showPopup(text, out, null, null);
      }).catch(function() {
        sendToBackground(text);
      });
    });
  }

  function sendToBackground(text) {
    if (!extensionAlive()) {
      showPopup(text, null, null, 'Extension is not responding — try reloading it.');
      return;
    }
    var done = false;
    function finish(msg, response) {
      if (done) return;
      done = true;
      if (response) {
        showPopup(text, response.translation, response.moreUrl, response.error);
      } else {
        showPopup(text, null, null, msg);
      }
    }
    setTimeout(function() {
      finish('No response from the extension — check your connection.');
    }, 15000);
    chrome.runtime.sendMessage({ action: 'translate', text: text }, function(response) {
      var msg = 'Extension is not responding — try reloading it.';
      if (chrome.runtime && chrome.runtime.lastError) msg = 'Extension error: ' + chrome.runtime.lastError.message;
      finish(msg, response);
    });
  }

  document.addEventListener('mouseup', function(e) {
    if (e.target && e.target.closest && e.target.closest('#translation-popup')) return;
    var text = window.getSelection().toString().trim();
    if (text.length > 0) addSearchIcon();
  });

  chrome.runtime.onMessage.addListener(function(request) {
    if (!extensionAlive()) return;
    if (request.action === 'translate_request') {
      closePopup();
      translateSelection(request.text);
    }
  });

  function showPopup(text, translation, moreUrl, error) {
    stopLoadingAnimation();
    if (popup) popup.remove();
    popup = document.createElement('div');
    popup.id = 'translation-popup';
    var content = '<div class="popup-content">';
    content += '<span id="selected-text">' + esc(text) + '</span>';
    if (!error) {
      content += '<button id="pronounce-button">🔊</button>';
      content += '<p id="translation-text">' + esc(translation) + ' <button id="pronounce-translation-button">🔊</button></p>';
    } else {
      content += '<p id="translation-text">' + esc(error) + '</p>';
    }
    if (!error && moreUrl) {
      var clickable = browserCapable();
      content += '<p class="online-notice' + (clickable ? ' clickable' : '') + '">⬆ Translated online by Google — your text left this device.' + (clickable ? ' Click to switch to on-device (Browser AI).' : '') + '</p>';
      content += '<a href="' + moreUrl + '" target="_blank">More</a>';
    }
    content += '</div>';
    popup.innerHTML = content;
    document.body.appendChild(popup);
    if (!error && moreUrl && browserCapable()) {
      var notice = popup.querySelector('.online-notice');
      if (notice) {
        notice.addEventListener('mousedown', function(e) { e.preventDefault(); });
        notice.addEventListener('click', function(e) {
          e.stopPropagation();
          chrome.storage.sync.set({ provider: 'browser' }, function() {
            translateSelection(text);
          });
        });
      }
    }
    getVoices();
    addPopupEventListeners();
    if (!error) {
      wireSpeakButton('#pronounce-button', 'original', text, function() {
        return detectSourceLang(text);
      });
      wireSpeakButton('#pronounce-translation-button', 'translation', translation, function() {
        return chrome.storage.sync.get('targetLanguage').then(function(data) {
          var tgt = data.targetLanguage || 'en';
          return BROWSER_LANG_MAP[tgt] || tgt;
        });
      });
    }
    adjustPopupSize();
  }

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getVoices() {
    voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      window.speechSynthesis.onvoiceschanged = function() { voices = window.speechSynthesis.getVoices(); };
    }
  }

  function closePopup() {
    stopLoadingAnimation();
    window.speechSynthesis.cancel();
    currentUtterance = null;
    currentSpeechBtn = null;
    if (popup) { popup.remove(); popup = null; }
  }

  function pickVoiceFor(lang) {
    var l = (lang || '').toLowerCase().split('-')[0];
    var local = voices.find(function(x) {
      return x.localService && x.lang && x.lang.toLowerCase().split('-')[0] === l;
    });
    if (local) return local;
    return voices.find(function(x) {
      return x.lang && x.lang.toLowerCase().split('-')[0] === l;
    }) || null;
  }

  function handleSpeakClick(e, btnId, speakFn) {
    e.stopPropagation();
    if (currentSpeechBtn === btnId && (window.speechSynthesis.speaking || currentUtterance)) {
      window.speechSynthesis.cancel();
      currentUtterance = null;
      currentSpeechBtn = null;
      return;
    }
    speakFn();
  }

  function speakText(text, lang, btnId) {
    window.speechSynthesis.cancel();
    currentUtterance = null;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    var v = pickVoiceFor(lang);
    if (v) u.voice = v;
    u.onend = u.onerror = function() {
      if (currentUtterance === u) {
        currentUtterance = null;
        currentSpeechBtn = null;
      }
    };
    currentUtterance = u;
    currentSpeechBtn = btnId;
    speechSynthesis.speak(u);
  }

  function wireSpeakButton(selector, btnId, text, getLang) {
    requestAnimationFrame(function() {
      var btn = popup && popup.querySelector(selector);
      if (!btn) return;
      btn.addEventListener('click', function(e) {
        handleSpeakClick(e, btnId, function() {
          Promise.resolve(getLang()).then(function(lang) {
            speakText(text, lang, btnId);
          });
        });
      });
    });
  }

  function adjustPopupSize() {
    if (!popup) return;
    var rect = getSelectionRect();
    popup.style.minWidth = Math.max(rect.width, 200) + 'px';
    popup.style.maxWidth = '400px';
    setPopupPosition();
  }

  var lastAnchorRect = null;
  var lastPopupPos = null;

  function setPopupPosition() {
    if (!popup) return;
    var rect = getSelectionRect();
    if (lastAnchorRect && lastPopupPos &&
        lastAnchorRect.left === rect.left &&
        lastAnchorRect.top === rect.top &&
        lastAnchorRect.width === rect.width) {
      popup.style.position = 'fixed';
      popup.style.left = lastPopupPos.left + 'px';
      popup.style.top = lastPopupPos.top + 'px';
      return;
    }
    lastAnchorRect = { left: rect.left, top: rect.top, width: rect.width };
    popup.style.position = 'fixed';
    popup.style.left = rect.left + 'px';
    popup.style.top = rect.top + 'px';
    var right = rect.left + popup.offsetWidth;
    if (right > window.innerWidth) popup.style.left = (window.innerWidth - popup.offsetWidth - 5) + 'px';
    if (parseInt(popup.style.top) < 0) popup.style.top = '0px';
    var pr = popup.getBoundingClientRect();
    if (pr.bottom > window.innerHeight) popup.style.top = (window.innerHeight - pr.height) + 'px';
    lastPopupPos = { left: parseInt(popup.style.left), top: parseInt(popup.style.top) };
  }

  function addPopupEventListeners() {
    if (!popup) return;
    var myPopup = popup;
    function onDocClick(e) {
      if (popup !== myPopup) { document.removeEventListener('click', onDocClick); return; }
      if (!myPopup.contains(e.target)) closePopup();
    }
    document.addEventListener('click', onDocClick);
    function onSelChange() {
      var s = window.getSelection();
      if (popup !== myPopup) { document.removeEventListener('selectionchange', onSelChange); return; }
      if (s.isCollapsed) {
        var anchor = s.anchorNode;
        var el = anchor && anchor.nodeType === 3 ? anchor.parentNode : anchor;
        if (el && myPopup.contains(el)) return;
        closePopup();
      }
    }
    document.addEventListener('selectionchange', onSelChange);
  }
})();
