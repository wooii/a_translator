(function() {
  var popup = null;
  var voices = [];
  var browserTranslators = {};
  var currentUtterance = null;
  var currentSpeechBtn = null;
  var cachedTarget = null;
  var cachedSource = null;
  var cachedText = null;
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
    return Translator.create({
      sourceLanguage: src,
      targetLanguage: tgt
    }).then(function(t) {
      browserTranslators[key] = t;
      return t;
    });
  }

  function modelStatus(src, tgt) {
    if (typeof Translator === 'undefined') return Promise.resolve('unavailable');
    try {
      if (Translator.availability) {
        return Promise.resolve(Translator.availability({ sourceLanguage: src, targetLanguage: tgt }))
          .catch(function() { return 'unavailable'; });
      }
      if (Translator.capabilities) {
        var caps = Translator.capabilities();
        if (caps && caps.available) return Promise.resolve(caps.available(src, tgt));
        if (caps && caps.languagePairAvailable) {
          return Promise.resolve(caps.languagePairAvailable(src, tgt) ? 'available' : 'downloadable');
        }
      }
    } catch (e) {}
    return Promise.resolve('unavailable');
  }

  function attemptOnDevice(src, tgt, text) {
    return getBrowserTranslator(src, tgt).then(function(t) {
      return t.translate(text).then(function(out) {
        return normalizePunct(out);
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
  var modelDownloading = false;
  var DL_FAIL_MSG = 'Download didn\'t finish — using Google. Try again or restart the browser.';

  function downloadModel(src, tgt, ui, timeoutMs) {
    if (modelDownloading) return;
    if (typeof Translator === 'undefined') return;
    modelDownloading = true;
    var settled = false;
    var timer = setTimeout(function() {
      finish(false);
    }, timeoutMs || 3000);
    var pollTimer = setInterval(function() {
      if (settled || typeof Translator === 'undefined' || !Translator.availability) return;
      Promise.resolve(Translator.availability({ sourceLanguage: src, targetLanguage: tgt })).then(function(status) {
        if (!settled && status === 'available') finish(true);
      }).catch(function() {});
    }, 3000);

    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      modelDownloading = false;
      if (ok) {
        if (ui.onOk) ui.onOk();
      } else {
        if (ui.onFail) ui.onFail();
      }
    }

    try {
      Translator.create({
        sourceLanguage: src,
        targetLanguage: tgt
      }).then(function(session) {
        if (session && session.destroy) { try { session.destroy(); } catch (e) {} }
        finish(true);
      }, function() {
        finish(false);
      });
    } catch (e) {
      finish(false);
    }
  }

  function startModelDownload(btn) {
    if (modelDownloading || !btn) return;
    var originalHTML = btn.innerHTML;
    var src = btn.getAttribute('data-source');
    var tgt = btn.getAttribute('data-target');
    if (!src || !tgt) return;
    var affordance = btn.querySelector('.dl-affordance');
    if (affordance) affordance.textContent = 'Downloading on-device models…';
    var sib = btn.nextSibling;
    while (sib && sib.className === 'download-note') {
      var nxt = sib.nextSibling;
      sib.parentNode.removeChild(sib);
      sib = nxt;
    }
    downloadModel(src, tgt, {
      onOk: function() {
        if (affordance) affordance.textContent = 'Downloaded ✓';
        chrome.storage.sync.set({ provider: 'browser' }, function() {
          if (popup && popup.isConnected && cachedText) {
            translateSelection(cachedText);
          }
        });
      },
      onFail: function() {
        btn.innerHTML = originalHTML;
        var note = document.createElement('span');
        note.className = 'download-note';
        note.style.marginTop = '8px';
        note.textContent = DL_FAIL_MSG;
        btn.parentNode.insertBefore(note, btn.nextSibling);
      }
    });
  }

  function autoDownload(src, tgt, text) {
    stopLoadingAnimation();
    var tl = popup && popup.querySelector('#translation-text');
    if (tl) tl.textContent = 'Downloading on-device models…';
    downloadModel(src, tgt, {
      onOk: function() {
        if (popup && popup.isConnected && cachedText) {
          translateSelection(cachedText);
        }
      },
      onFail: function() {
        if (popup && popup.isConnected) {
          sendToBackground(text, true);
        }
      }
    }, 600);
  }

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
    popup.innerHTML = '<div id="popup-scroll"><div class="popup-content"><span id="selected-text">' + esc(text) +
                      '</span><p id="translation-text">Loading<span id="loading-dots">…</span></p></div></div>';
    document.body.appendChild(popup);
    addPopupEventListeners();
    adjustPopupSize();
    startLoadingAnimation();
  }

  function getSelectionRect() {
    var sel = window.getSelection();
    if (sel.rangeCount > 0) {
      var r = sel.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
    }
    return { left: 0, top: 0, bottom: 0, width: 0 };
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
    var iconSize = 36;
    var iconLeft = rect.left + 5;
    if (iconLeft + iconSize > window.innerWidth) iconLeft = window.innerWidth - iconSize - 5;
    if (iconLeft < 0) iconLeft = 0;
    var iconTop = rect.bottom - 2;
    if (iconTop + iconSize > window.innerHeight) iconTop = window.innerHeight - iconSize - 5;
    if (iconTop < 0) iconTop = 0;
    Object.assign(el.style, {
      position: 'fixed', backgroundColor: '#FFF', border: '1px solid #ccc',
      borderRadius: '50%', padding: '5px', boxShadow: '0 0 5px rgba(0,0,0,0.3)',
      cursor: 'pointer', zIndex: '2147483646',
      width: iconSize + 'px', height: iconSize + 'px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '18px', lineHeight: '1',
      left: Math.round(iconLeft) + 'px', top: Math.round(iconTop) + 'px'
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

  function runAttempt(src, tgt, text) {
    withTimeout(attemptOnDevice(src, tgt, text), ON_DEVICE_TIMEOUT).then(function(out) {
      showPopup(text, out, null, null);
    }).catch(function(e) {
      sendToBackground(text, isActivationError(e));
    });
  }

  function translateSelection(text) {
    if (!extensionAlive()) return;
    cachedSource = null;
    cachedText = text;
    showLoadingPopup(text);
    chrome.storage.sync.get(['provider', 'targetLanguage'], function(settings) {
      cachedTarget = settings.targetLanguage || cachedTarget || 'en';
      if (settings.provider === 'google' || !browserCapable()) {
        sendToBackground(text, false);
        return;
      }
      var tgt = settings.targetLanguage || 'en';
      var tgtBcp47 = BROWSER_LANG_MAP[tgt] || tgt;
      detectSourceLang(text).then(function(src) {
        cachedSource = src;
        if (src === tgtBcp47) {
          showPopup(text, text, null, null);
          return;
        }
        modelStatus(src, tgtBcp47).then(function(status) {
          var needsDownload = (status === 'downloadable' || status === 'downloading');
          if (needsDownload) {
            if (navigator.userActivation && navigator.userActivation.isActive) {
              autoDownload(src, tgtBcp47, text);
            } else {
              sendToBackground(text, true);
            }
            return;
          }
          runAttempt(src, tgtBcp47, text);
        });
      }).catch(function() {
        sendToBackground(text, false);
      });
    });
  }

  function isActivationError(e) {
    if (!e) return false;
    return e.name === 'NotAllowedError' ||
           (e.message && /activation|user gesture|consent/i.test(e.message));
  }

  function sendToBackground(text, needsActivation) {
    if (!extensionAlive()) {
      showPopup(text, null, null, 'Extension is not responding — try reloading it.');
      return;
    }
    var done = false;
    function finish(msg, response) {
      if (done) return;
      done = true;
      if (response) {
        showPopup(text, response.translation, response.moreUrl, response.error, needsActivation);
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

  function showPopup(text, translation, moreUrl, error, needsActivation) {
    stopLoadingAnimation();
    if (popup) popup.remove();
    popup = document.createElement('div');
    popup.id = 'translation-popup';
    var content = '<div id="popup-scroll"><div class="popup-content">';
    content += '<span id="selected-text">' + esc(text) + '</span>';
    if (!error) {
      content += '<button id="pronounce-button">🔊</button>';
      content += '<p id="translation-text">' + esc(translation) + ' <button id="pronounce-translation-button">🔊</button></p>';
    } else {
      content += '<p id="translation-text">' + esc(error) + '</p>';
    }
    if (!error && moreUrl) {
      var clickable = browserCapable();
      var needsDl = clickable && needsActivation;
      var noticeText = '⚠ Translated by Google.';
      if (clickable && !needsDl) {
        noticeText += ' Click to switch to on-device AI.';
      }
      var dlTgt = cachedTarget || 'en';
      content += '<p class="online-notice' + (clickable ? ' clickable' : '') + '" data-source="' + esc(cachedSource || guessLang(text)) +
                 '" data-target="' + esc(BROWSER_LANG_MAP[dlTgt] || dlTgt) + '">' + noticeText;
      if (needsDl) {
        content += ' <span class="dl-affordance">⬇ Download on-device model</span>';
      }
      content += '</p>';
      content += '<a href="' + moreUrl + '" target="_blank">More</a>';
    }
    content += '</div></div>';
    popup.innerHTML = content;
    document.body.appendChild(popup);
    addPopupEventListeners();
    adjustPopupSize();
    if (!error && moreUrl && browserCapable()) {
      function switchToOnDevice(e) {
        e.stopPropagation();
        chrome.storage.sync.set({ provider: 'browser' }, function() {
          closePopup();
          translateSelection(text);
        });
      }
      var notice = popup.querySelector('.online-notice');
      if (notice) {
        notice.addEventListener('mousedown', function(e) { e.preventDefault(); });
        notice.addEventListener('click', function(e) {
          e.stopPropagation();
          if (needsActivation) {
            startModelDownload(notice);
          } else {
            switchToOnDevice(e);
          }
        });
      }
    }
    try { getVoices(); } catch (e) {}
    if (!error) {
      try {
        wireSpeakButton('#pronounce-button', 'original', text, function() {
          return detectSourceLang(text);
        });
        wireSpeakButton('#pronounce-translation-button', 'translation', translation, function() {
          return chrome.storage.sync.get('targetLanguage').then(function(data) {
            var tgt = data.targetLanguage || 'en';
            return BROWSER_LANG_MAP[tgt] || tgt;
          });
        });
      } catch (e) {}
    }
  }

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getVoices() {
    if (typeof window.speechSynthesis === 'undefined') return;
    try {
      voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) {
        window.speechSynthesis.onvoiceschanged = function() { voices = window.speechSynthesis.getVoices(); };
      }
    } catch (e) {}
  }

  function closePopup() {
    stopLoadingAnimation();
    if (typeof window.speechSynthesis !== 'undefined') {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
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
    if (typeof window.speechSynthesis === 'undefined') return;
    try {
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
    } catch (e) {}
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
    var maxH = Math.round(window.innerHeight * 0.8);
    popup.style.minWidth = Math.max(rect.width, 200) + 'px';
    popup.style.maxWidth = '400px';
    popup.style.maxHeight = maxH + 'px';
    popup.style.overflowY = 'auto';
    popup.style.boxSizing = 'border-box';
    var scroller = popup.querySelector('#popup-scroll');
    if (scroller) {
      scroller.style.overflowY = 'auto';
      scroller.style.maxHeight = maxH + 'px';
      scroller.style.boxSizing = 'border-box';
    }
    var s = scroller || popup;
    if (s.scrollHeight > s.clientHeight) {
      s.style.height = maxH + 'px';
    }
    var posH = s.offsetHeight;
    if (popup.querySelector('#loading-dots')) {
      posH = Math.min(posH + 100, maxH);
    }
    setPopupPosition(posH);
  }

  function setPopupPosition(posH) {
    if (!popup) return;
    var rect = getSelectionRect();
    var gap = 6;
    var w = popup.offsetWidth;
    var h = posH || popup.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = Math.min(Math.max(rect.left, 0), Math.max(0, vw - w - 5));
    var top = rect.bottom + gap;
    if (top + h > vh) {
      var above = rect.top - h - gap;
      top = above >= 0 ? above : Math.max(0, vh - h - 5);
    }
    popup.style.position = 'fixed';
    popup.style.left = Math.round(left) + 'px';
    popup.style.top = Math.round(top) + 'px';
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
