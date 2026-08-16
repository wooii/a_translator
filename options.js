document.addEventListener('DOMContentLoaded', function() {
  var providerOptions = document.querySelectorAll('.provider-option');
  var targetSelect = document.getElementById('targetLanguage');
  var status = document.getElementById('status');

  function saveSetting(key, value) {
    var obj = {};
    obj[key] = value;
    chrome.storage.sync.set(obj, function() {
      status.textContent = 'Saved';
      setTimeout(function() { status.textContent = ''; }, 1000);
    });
  }

  function applyProvider(value) {
    providerOptions.forEach(function(opt) {
      var input = opt.querySelector('input[type="radio"]');
      var selected = input.value === value;
      input.checked = selected;
      opt.classList.toggle('selected', selected);
    });
  }

  providerOptions.forEach(function(opt) {
    opt.addEventListener('click', function() {
      var value = opt.querySelector('input[type="radio"]').value;
      applyProvider(value);
      saveSetting('provider', value);
    });
  });

  targetSelect.addEventListener('change', function() {
    saveSetting('targetLanguage', targetSelect.value);
  });

  chrome.storage.sync.get(['targetLanguage', 'provider'], function(data) {
    if (data.provider) applyProvider(data.provider);
    if (data.targetLanguage) targetSelect.value = data.targetLanguage;
  });
});
