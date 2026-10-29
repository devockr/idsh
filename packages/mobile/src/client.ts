// The touch-device half of the Web UI, as a client plugin.
//
// The image this was extracted from got all three of these by patching dsh's installed
// files at build time: two CSS rules injected into dist/index.html, a rewritten
// dist/favicon.svg, and a sed-injected branch inside the composer's keydown handler.
// Doing them here means the image can ship an untouched dsh and install a package.
globalThis.__ModuleLoader__.load({
  id: '@idsh/mobile',
  factory: () => {
    const module: { exports: Record<string, unknown> } = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    exports.name = '@idsh/mobile'
    exports.inject = []

    // One-glance state for the probe and for anyone with DevTools open.
    let state = 'starting'
    function mark(extra?: string): void {
      state = extra === undefined ? state : extra
      try {
        document.body.dataset.idshMobile = state
      } catch {}
      console.log('[mobile] ' + state)
    }

    /**
     * Coarse-pointer CSS, byte for byte what the image injected into index.html: vertical page
     * panning, and a 16px floor on form controls so iOS does not zoom the page when one takes focus
     * (the terminal keeps its own size).
     */
    const CSS =
      '@media(pointer:coarse){html{touch-action:pan-x pan-y}' +
      'select,:read-write:not(.xterm-helper-textarea){font-size:max(16px,1em)!important}}'

    function injectCss(): Disposable {
      const style = document.createElement('style')
      style.dataset.idshMobile = 'css'
      style.textContent = CSS
      document.head.append(style)
      return () => style.remove()
    }

    /**
     * Enter inserts a line break on a touch device instead of sending.
     *
     * Stock behaviour is `event.key === "Enter" && !event.shiftKey` → send, and a shifted Enter
     * runs the editor's own line-break command. So the plain key is turned into a shifted one in
     * the capture phase, and the original is stopped before the composer's handler ever sees it.
     */
    /** The key code Safari uses for a composition being committed. */
    const IME_PROCESSING_KEY_CODE = 229

    function rewriteEnterOnCoarsePointers(): Disposable {
      const onKeydown = (event: KeyboardEvent): void => {
        if (
          event.key !== 'Enter' ||
          event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        ) {
          return
        }
        // 229 is the IME processing key code Safari reports when a composition is being committed,
        // and keyCode is the only place it appears — hence the deprecation suppression below.
        if (event.isComposing || event.keyCode === IME_PROCESSING_KEY_CODE) {
          return
        } // mid-IME
        if (!globalThis.matchMedia('(pointer: coarse)').matches) {
          return
        }
        // Only the composer's own editor: the same rewrite on a plain input (the session
        // search) or the terminal's textarea would break them, and the patch this replaces
        // lived inside the composer's handler, so that is the scope it had.
        //
        // Two things about finding it: the composer writes `contenteditable=""` rather than
        // `"true"` — dsh's own shortcut plugin matches both — and the editor sits inside a shadow
        // root, where the event target is retargeted to the host. composedPath sees through it.
        const editable = event
          .composedPath()
          .find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement &&
              (node.getAttribute('contenteditable') === 'true' ||
                node.getAttribute('contenteditable') === ''),
          )
        if (editable === undefined) {
          return
        }
        event.stopPropagation()
        event.preventDefault()
        // A synthetic keydown never produces the browser's own line break — untrusted events
        // have no default behaviour — and the composer's editor is Lexical, which drives its
        // insertLineBreak command from beforeinput. Measured on the running editor: this adds
        // <br data-lexical-managed-linebreak> where a dispatched shift+Enter adds nothing.
        editable.dispatchEvent(
          new InputEvent('beforeinput', {
            inputType: 'insertLineBreak',
            bubbles: true,
            cancelable: true,
          }),
        )
      }
      document.addEventListener('keydown', onKeydown, true)
      return () => document.removeEventListener('keydown', onKeydown, true)
    }

    /**
     * The iOS home-screen icon. iOS ignores an SVG apple-touch-icon and nothing under a plugin
     * package is reachable by URL, so the artwork comes from the favicon the app already serves and
     * is rasterised here.
     *
     * One tile, no prefers-color-scheme variant: iOS samples the icon when the shortcut is added,
     * so a pair would freeze whichever theme was active then, while Apple's own dark-icon treatment
     * swaps the background by itself. Mid-tone brand blue with a light glyph survives it.
     */
    async function rewriteHomeScreenIcon(): Promise<Disposable> {
      const link = document.querySelector('link[rel~="icon"]')
      if (!(link instanceof HTMLLinkElement)) {
        // Nothing was installed, so there is nothing to undo.
        // oxlint-disable-next-line no-empty-function -- nothing was installed, so there is nothing to undo
        return () => {}
      }
      const response = await fetch(link.href)
      const source = await response.text()
      const svg = source
        .replaceAll(/(<path[^>]*)fill="#[0-9A-Fa-f]{3,6}"/g, '$1fill="#FFFFFF"')
        .replace(/(<svg[^>]*)viewBox="[^"]*"/, '$1viewBox="-7.83 -7.83 66 66"')
        .replace(/(<svg[^>]*)width="[0-9.]+" height="[0-9.]+"/, '$1width="1024" height="1024"')
        .replace(
          /<path/,
          '<rect x="-7.83" y="-7.83" width="66" height="66" rx="12" ry="12" fill="#4D6BFE"/><path',
        )
      const image = new Image()
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      await image.decode()
      // 512: the largest slot in service is iPad Pro at 167pt x2 = 334px, and iOS only ever
      // downsamples. 180 (the iPhone slot) is soft there; 1024 measures 47KB of data URI.
      const SIZE = 512
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const context = canvas.getContext('2d')
      if (context === null) {
        // Nothing was installed, so there is nothing to undo.
        // oxlint-disable-next-line no-empty-function -- nothing was installed, so there is nothing to undo
        return () => {}
      }
      context.drawImage(image, 0, 0, SIZE, SIZE)
      const icon = document.createElement('link')
      icon.rel = 'apple-touch-icon'
      icon.href = canvas.toDataURL('image/png')
      document.head.append(icon)
      return () => icon.remove()
    }

    function apply(ctx: PluginContext): void {
      const teardown: Disposable[] = [injectCss(), rewriteEnterOnCoarsePointers()]
      let disposed = false
      mark('css+enter coarse:' + globalThis.matchMedia('(pointer: coarse)').matches)
      rewriteHomeScreenIcon()
        .then(off => {
          // The icon arrives a fetch later, so a dispose that already happened has to undo it
          // here: the teardown list was drained and would never see this one.
          if (disposed) {
            off()
            return
          }
          teardown.push(off)
          mark(state + ' icon:ok')
        })
        .catch((error: unknown) => mark(state + ' icon:' + (error as Error).message))
      // cordis's own teardown: the effect body returns what undoes it.
      ctx.effect(() => () => {
        disposed = true
        for (const off of teardown) {
          try {
            off()
          } catch {}
        }
      })
    }

    exports.apply = apply

    return module.exports
  },
})
