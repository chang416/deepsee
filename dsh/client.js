// Browser half of the deepsee dsh plugin: paste-to-path.
//
// A capture-phase paste listener runs before the composer's own handler.
// When the clipboard carries image files, the default intake (attachment ->
// host image admission -> "model does not support images" for text-only
// models) is suppressed; the bytes go to the plugin's host route
// (POST /deepsee/paste), land as a private temp file, and the returned path
// is inserted into the composer as plain text. A text-only model then sees
// exactly what Pi, OpenCode, and Claude Code hand their models: a file path,
// which is also the deepsee skill's and read_image tool's primary trigger.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages — the same zero-dependency stance as the
// host half.
// The id must be the package name: the host serves this bundle as
// /plugins/<package>/client.js and refuses it if the module it registers is
// named anything else ("loaded without registering ..."). The bin name
// ('deepsee') looks right here and fails the whole plugin tree in the browser.
window.__ModuleLoader__.load({
  id: '@chang416/deepsee',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    function imageFilesOf(event) {
      var items = event.clipboardData?.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item.kind !== 'file') continue
        var file = item.getAsFile()
        if (file && /^image\//.test(file.type)) files.push(file)
      }
      return files
    }

    function insertText(target, text) {
      var el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') ? target : document.activeElement
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
      el.focus()
      // execCommand fires the input event React's controlled textarea needs;
      // the prototype-setter dance is the fallback for engines dropping it.
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (!inserted) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, el.value + text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/deepsee/paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `paste upload failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        }),
      )
    }

    function currentModelLabel() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/选择模型|select model|current model/i.test(label)) return label
      }
      return ''
    }

    // Whether to take a paste over is the HOST's call (GET /deepsee/paste
    // with the selector label; the host resolves it against real model
    // metadata). A name regex here once declared every vision model it did
    // not recognize text-only and hijacked its native paste. The verdict is
    // cached per label and refreshed in the background; until a label has a
    // cached `true`, pastes stay native — the safe direction for both a
    // vision model (keeps its thumbnail) and a text-only one (keeps only its
    // old error message, once). A 404 means the route is off (pasteToPath:
    // false, or no host half), so the client stands down entirely instead of
    // swallowing pastes into a dead endpoint.
    var routeAvailable = true
    var verdicts = {}
    // A verdict older than this is UNKNOWN again, even while a refresh is in
    // flight: the route's model metadata can change mid-session (discovery
    // sweeps, provider mounts), and acting on a long-stale `true` is exactly
    // the vision-model hijack this design exists to prevent. The bound is a
    // backstop, since every focus and paste re-asks anyway.
    var VERDICT_MAX_AGE_MS = 60000

    function refreshVerdict(label) {
      if (!routeAvailable) return
      var cached = verdicts[label]
      // Dedupe only on an in-flight request, never on freshness: the host's
      // model inventory can change under an unchanged label (a same-named
      // route mounting mid-session), so every focus and paste re-asks and a
      // stale answer survives at most one local round-trip.
      if (cached?.pending) return
      var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
      verdicts[label] = entry
      fetch(`/deepsee/paste?model=${encodeURIComponent(label)}`)
        .then((res) => {
          if (res.status === 404) {
            routeAvailable = false
            entry.pending = false
            return null
          }
          if (!res.ok) throw new Error(`policy ${res.status}`)
          return res.json()
        })
        .then((body) => {
          entry.pending = false
          if (body) {
            entry.takeover = body.takeover === true
            entry.at = Date.now()
          }
        })
        .catch(() => {
          entry.pending = false
        })
    }

    // A paste needs the composer focused first, so a focus-time prefetch has
    // the verdict ready before the first paste can land.
    function onFocusIn() {
      refreshVerdict(currentModelLabel())
    }

    function onPaste(event) {
      if (!routeAvailable) return
      var files = imageFilesOf(event)
      if (files.length === 0) return
      var label = currentModelLabel()
      var cached = verdicts[label]
      refreshVerdict(label)
      // No fresh confirmed host verdict: leave the paste native. Wrong only
      // for a text-only model's very first paste, and self-correcting.
      if (!cached || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > VERDICT_MAX_AGE_MS) return
      // Take the paste before the composer's intake starts an attachment (and
      // with it the host-side image admission a text-only model fails).
      event.preventDefault()
      event.stopImmediatePropagation()
      var target = event.target
      Promise.all(files.map(uploadOne))
        .then((results) => {
          var text = results
            .map((r) => r.path)
            .filter(Boolean)
            .join(' ')
          if (text) insertText(target, `${text} `)
        })
        .catch((error) => {
          // A 404 here means the route vanished AFTER a verdict confirmed it
          // (plugin disposed mid-session): that race can cost this one paste
          // — preventDefault already ran — but never another. Stand down and
          // forget every verdict, so the next paste goes native immediately.
          if (error && error.status === 404) {
            routeAvailable = false
            verdicts = {}
          }
          console.error(`[deepsee] paste-to-path failed: ${error?.message ? error.message : error}`)
        })
    }

    var settingsOpen = false
    var settingsButton

    function element(tag, text) {
      var node = document.createElement(tag)
      if (text !== undefined) node.textContent = text
      return node
    }

    function apiJson(url, init) {
      return fetch(url, init).then((res) =>
        res
          .json()
          .catch(() => ({}))
          .then((body) => {
            if (!res.ok) throw new Error(body.error || `DeepSee settings failed (${res.status})`)
            return body
          }),
      )
    }

    function openSettings() {
      if (settingsOpen || !document.createElement || !document.body) return
      settingsOpen = true
      apiJson('/deepsee/settings')
        .then((settings) => {
          var backdrop = element('div')
          backdrop.setAttribute('data-deepsee-settings', 'true')
          backdrop.style.cssText =
            'position:fixed;inset:0;z-index:2147483646;background:rgba(5,8,16,.72);backdrop-filter:blur(10px);display:grid;place-items:center;padding:24px;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#edf4ff'
          var panel = element('div')
          panel.style.cssText =
            'width:min(720px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#0d1424;border:1px solid #293957;border-radius:20px;box-shadow:0 28px 90px rgba(0,0,0,.55);padding:28px'
          var header = element('div')
          header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:20px'
          var titleWrap = element('div')
          var title = element('h2', 'DeepSee Settings')
          title.style.cssText = 'font-size:24px;line-height:1.2;margin:0 0 8px'
          var intro = element(
            'p',
            'Use free vision keys and decide which coding work goes to DeepSeek V4 Flash or Pro.',
          )
          intro.style.cssText = 'margin:0;color:#9fb0ca;line-height:1.5'
          titleWrap.append(title, intro)
          var close = element('button', '×')
          close.type = 'button'
          close.setAttribute('aria-label', 'Close DeepSee Settings')
          close.style.cssText =
            'border:0;background:transparent;color:#aebbd0;font-size:30px;cursor:pointer;line-height:1'
          header.append(titleWrap, close)
          panel.append(header)

          var keyLabel = element('label', 'Gemini API keys')
          keyLabel.style.cssText = 'display:block;font-weight:700;margin:28px 0 8px'
          var keyHelp = element(
            'p',
            `${settings.keyCount || 0} saved. Add one key per line; DeepSee rotates when a key reaches its limit. Saved keys are never shown again.`,
          )
          keyHelp.style.cssText = 'margin:0 0 10px;color:#9fb0ca;font-size:13px;line-height:1.5'
          var keys = element('textarea')
          keys.rows = 4
          keys.placeholder = 'AIza…\nAIza…'
          keys.autocomplete = 'off'
          keys.spellcheck = false
          keys.style.cssText =
            'width:100%;box-sizing:border-box;resize:vertical;border:1px solid #314361;border-radius:12px;background:#080e1a;color:#edf4ff;padding:12px;font:13px ui-monospace,SFMono-Regular,monospace;outline:none'
          var clearWrap = element('label')
          clearWrap.style.cssText =
            'display:flex;align-items:center;gap:8px;margin:9px 0 0;color:#9fb0ca;font-size:13px'
          var clearKeys = element('input')
          clearKeys.type = 'checkbox'
          clearWrap.append(clearKeys, document.createTextNode('Remove all saved Gemini keys'))
          panel.append(keyLabel, keyHelp, keys, clearWrap)

          var routeTitle = element('h3', 'Customize routing')
          routeTitle.style.cssText = 'font-size:16px;margin:28px 0 6px'
          var routeHelp = element(
            'p',
            'Flash is fast and economical. Pro handles work where deeper reasoning matters. Auto already uses the recommended split below.',
          )
          routeHelp.style.cssText = 'margin:0 0 12px;color:#9fb0ca;font-size:13px;line-height:1.5'
          panel.append(routeTitle, routeHelp)
          var selects = {}
          var grid = element('div')
          grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px'
          var categories = [
            'discovery',
            'documentation',
            'tests',
            'small-edit',
            'bug-fix',
            'ui-implementation',
            'visual-review',
            'refactor',
            'architecture',
            'security',
            'integration',
            'review',
          ]
          categories.forEach((category) => {
            var row = element('label')
            row.style.cssText =
              'display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #263650;border-radius:11px;padding:10px 12px;color:#d9e4f5;text-transform:capitalize'
            row.append(element('span', category.replace('-', ' ')))
            var select = element('select')
            select.style.cssText =
              'border:1px solid #344866;border-radius:8px;background:#111d30;color:#edf4ff;padding:6px 8px'
            ;['flash', 'pro'].forEach((choice) => {
              var option = element('option', choice === 'flash' ? 'Flash' : 'Pro')
              option.value = choice
              select.append(option)
            })
            select.value = settings.assignments?.[category] || 'flash'
            selects[category] = select
            row.append(select)
            grid.append(row)
          })
          panel.append(grid)

          var visual = settings.visualCheck || {}
          var visualTitle = element('h3', 'Gemini visual self-check')
          visualTitle.style.cssText = 'font-size:16px;margin:28px 0 6px'
          var visualHelp = element(
            'p',
            'DeepSee can inspect the real rendered UI while DeepSeek is still working. A failed check returns exact visual defects to fix before delivery.',
          )
          visualHelp.style.cssText = 'margin:0 0 12px;color:#9fb0ca;font-size:13px;line-height:1.5'
          panel.append(visualTitle, visualHelp)

          function checkboxRow(label, checked) {
            var row = element('label')
            row.style.cssText = 'display:flex;align-items:center;gap:9px;color:#d9e4f5;font-size:13px;margin:9px 0'
            var input = element('input')
            input.type = 'checkbox'
            input.checked = checked
            row.append(input, document.createTextNode(label))
            return { row, input }
          }

          var visualEnabled = checkboxRow('Enable automatic visual checks for visual work', visual.enabled !== false)
          var visualMilestones = checkboxRow('Check after meaningful UI milestones', visual.milestones !== false)
          var visualFinal = checkboxRow('Require a PASS before final delivery', visual.final !== false)
          panel.append(visualEnabled.row, visualMilestones.row, visualFinal.row)

          var visualGrid = element('div')
          visualGrid.style.cssText =
            'display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:12px'

          function field(labelText, input) {
            var label = element('label')
            label.style.cssText = 'display:grid;gap:6px;color:#9fb0ca;font-size:12px'
            label.append(element('span', labelText), input)
            return label
          }

          var previewUrl = element('input')
          previewUrl.type = 'url'
          previewUrl.placeholder = 'http://127.0.0.1:3000'
          previewUrl.value = visual.previewUrl || ''
          previewUrl.style.cssText =
            'border:1px solid #314361;border-radius:10px;background:#080e1a;color:#edf4ff;padding:9px 10px;outline:none'

          var viewport = element('input')
          viewport.type = 'text'
          viewport.placeholder = '1440x900'
          viewport.value = visual.viewport || '1440x900'
          viewport.style.cssText = previewUrl.style.cssText

          var maxRounds = element('select')
          maxRounds.style.cssText =
            'border:1px solid #314361;border-radius:10px;background:#080e1a;color:#edf4ff;padding:9px 10px;outline:none'
          ;[1, 2, 3, 4].forEach((rounds) => {
            var option = element('option', `${rounds}`)
            option.value = `${rounds}`
            maxRounds.append(option)
          })
          maxRounds.value = `${visual.maxRounds || 2}`
          visualGrid.append(
            field('Local preview URL (optional)', previewUrl),
            field('Viewport', viewport),
            field('Maximum rounds per phase', maxRounds),
          )
          panel.append(visualGrid)

          var footer = element('div')
          footer.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:26px'
          var status = element('span')
          status.style.cssText = 'margin-right:auto;color:#9fb0ca;font-size:13px'
          var save = element('button', 'Save settings')
          save.type = 'button'
          save.style.cssText =
            'border:0;border-radius:11px;background:linear-gradient(135deg,#3b82f6,#7c3aed);color:white;font-weight:750;padding:11px 18px;cursor:pointer'
          footer.append(status, save)
          panel.append(footer)
          backdrop.append(panel)
          document.body.append(backdrop)

          var dismiss = () => {
            backdrop.remove()
            settingsOpen = false
          }
          close.addEventListener('click', dismiss)
          backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) dismiss()
          })
          save.addEventListener('click', () => {
            save.disabled = true
            status.textContent = 'Saving…'
            var assignments = {}
            categories.forEach((category) => {
              assignments[category] = selects[category].value
            })
            var payload = {
              assignments,
              visualCheck: {
                enabled: visualEnabled.input.checked,
                milestones: visualMilestones.input.checked,
                final: visualFinal.input.checked,
                maxRounds: Number(maxRounds.value),
                previewUrl: previewUrl.value.trim(),
                viewport: viewport.value.trim() || '1440x900',
              },
            }
            if (keys.value.trim() || clearKeys.checked) payload.keysText = clearKeys.checked ? '' : keys.value
            apiJson('/deepsee/settings', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
              .then(() => {
                status.textContent = 'Saved. Customize is ready.'
                setTimeout(dismiss, 700)
              })
              .catch((error) => {
                status.textContent = error.message
                save.disabled = false
              })
          })
        })
        .catch((error) => {
          settingsOpen = false
          console.error(`[deepsee] settings unavailable: ${error?.message ? error.message : error}`)
        })
    }

    function clickText(target) {
      var node = target
      for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        var text = `${node.textContent || ''} ${node.getAttribute?.('aria-label') || ''}`
        if (text.trim()) return text
      }
      return ''
    }

    function onClick(event) {
      var text = clickText(event.target)
      if (!/DeepSee Customize/i.test(text)) return
      apiJson('/deepsee/settings')
        .then((settings) => {
          if (!settings.customizeConfigured) openSettings()
        })
        .catch(() => {})
    }

    function installSettingsEntry() {
      if (!document.createElement || !document.body) return
      settingsButton = element('button', 'DeepSee Settings')
      settingsButton.type = 'button'
      settingsButton.setAttribute('aria-label', 'Open DeepSee Settings')
      settingsButton.style.cssText =
        'position:fixed;right:18px;bottom:18px;z-index:2147483000;border:1px solid #35507a;border-radius:999px;background:#111b2f;color:#dceaff;padding:9px 13px;font:600 12px Inter,ui-sans-serif,system-ui;box-shadow:0 10px 30px rgba(0,0,0,.3);cursor:pointer'
      settingsButton.addEventListener('click', openSettings)
      document.body.append(settingsButton)
    }

    function apply(ctx) {
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('click', onClick, true)
      installSettingsEntry()
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            document.removeEventListener('paste', onPaste, true)
            document.removeEventListener('focusin', onFocusIn, true)
            document.removeEventListener('click', onClick, true)
            settingsButton?.remove()
          },
          'deepsee: paste-to-path listener',
        )
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
