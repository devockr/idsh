// The whole trick, in one property — and one check before granting it.
//
// dsh computes `ctx.connection.isLoopback` from the page's own authority and refuses
// to be convinced otherwise — upstream puts it plainly: "Only a shell that assembles
// its own transport can set this; served pages never carry the global at all". Every
// privileged affordance hangs off that one boolean (`ui-settings` picks "host" vs
// "memory" persistence, `ui-settings-general` builds its document controller only
// when true, the Cordis runner reads it too).
//
// A self-hosted deployment that is reached over the LAN or the internet wants that
// surface anyway. The image used to get it by patching dsh's installed JavaScript at
// build time; this does the same thing at runtime, in the browser, where the flag
// lives — installable, visible, and removable without touching dsh.
//
// It grants the surface only to a page this deployment actually serves: loopback, the
// listener's own bind literal, or an authority the host declared (`dsh web
// --trusted-host`, i.e. `DSH_TRUSTED_HOSTS`). dsh's fence around its own `/api` accepts
// exactly that set, so this follows it instead of privileging whoever can load the page.
// The verdict comes from the host half, because the browser cannot judge it: /idsh/trusted.
//
// This is deliberately an exception to a designed boundary. Read the package README
// before installing it.
globalThis.__ModuleLoader__.load({
  id: '@idsh/privileged-ui',
  factory: () => {
    const module: { exports: Record<string, unknown> } = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const isObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null

    const isLoopbackOf = (value: unknown): value is { isLoopback: boolean } =>
      isObject(value) && typeof value.isLoopback === 'boolean'

    /** The marker for a connection whose flag cannot be read, naming what it was instead. */
    const missingFlag = (connection: unknown): string =>
      'SELF-CHECK-FAILED connection.isLoopback is ' +
      typeof (isObject(connection) ? connection.isLoopback : undefined)

    /** Write the flag, reporting a frozen one; false means the page cannot be privileged. */
    const writeFlag = (connection: { isLoopback: boolean }): boolean => {
      try {
        connection.isLoopback = true
        return true
      } catch (error) {
        mark(
          'SELF-CHECK-FAILED not writable: ' +
            (error instanceof Error ? error.message : String(error)),
        )
        return false
      }
    }

    /** The gateway's own copy of the flag, which is what the settings pages read. */
    const factsOf = (services: unknown): unknown => {
      const remote = isObject(services) ? services.remote : undefined
      return isObject(remote) ? remote.$host : undefined
    }

    const MARK = 'idshPrivileged'

    /** Set when this plugin is disposed, and read again before the flag is written. */
    let disposed = false

    // A one-glance marker and a console line: the image's build-time patch fails the
    // build when dsh moves, and a runtime patch has to fail just as loudly instead of
    // rotting quietly. `document.body.dataset.idshPrivileged` is the whole report.
    function mark(state: string): void {
      try {
        document.body.dataset[MARK] = state
      } catch {}
      console.log('[privileged-ui] ' + state)
    }

    exports.name = '@idsh/privileged-ui'
    // `remote` is read below for the report, and cordis throws when a plugin touches a
    // service it did not inject — that throw is what made the first version inactive.
    exports.inject = ['connection', 'remote']

    /**
     * Whether this deployment serves the page that is asking. The host answers it — see ./index —
     * with the same fence dsh runs for its own /api, so loopback forms, IPv6, default ports and the
     * declared authorities are all judged in one place, not here.
     */
    async function mayBePrivileged(): Promise<boolean> {
      try {
        const response = await fetch('/idsh/trusted', {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) {
          return false
        }
        const body = (await response.json()) as { trusted?: unknown }
        return body.trusted === true
      } catch {
        return false
      }
    }

    function apply(ctx: PluginContext): void {
      // A disposal while the list is in flight must not leave the flag written with no handler to
      // undo it: `grant` writes before it registers its effect, so a call after disposal would set
      // the flag and then be refused the teardown. Nothing awaits between the check below and the
      // write, so the flag cannot slip through once this is set.
      ctx.effect(() => () => {
        disposed = true
      })
      void mayBePrivileged().then(allowed => {
        if (disposed) {
          return
        }
        if (!allowed) {
          mark('SELF-CHECK-FAILED not-a-served-authority:' + location.host)
          return
        }
        grant(ctx)
      })
    }

    /**
     * The half that writes the flag. Split from `apply` so the decision above can be asynchronous —
     * the list it needs is a request — while this stays exactly what it was: a synchronous write,
     * reported, and undone on disposal.
     */
    function grant(ctx: PluginContext): void {
      if (disposed) {
        return
      }
      // The one place this package reaches past the published client types, and it is the point of
      // the package: dsh's `Context` does not declare `connection` or `remote` for client plugins,
      // and it declares the flag `readonly` on the host side, because a served page is not supposed
      // to write it at all. Stating the shape here is smaller than a hand-written context interface
      // and keeps everything else — `ctx.effect` included — checked against dsh's own types.
      const services: unknown = ctx
      const connection = isObject(services) ? services.connection : undefined
      if (!isLoopbackOf(connection)) {
        mark(missingFlag(connection))
        return
      }
      const before = connection.isLoopback
      if (!writeFlag(connection)) {
        return
      }
      // Whether the consumers can see this depends on when they read it: the gateway copies the
      // flag into its `$host` facts when it activates, and the settings pages read
      // `$host.isLoopback`. So the flag alone is not the point — a live gateway that still says false
      // is the activation-order regression this package exists to prevent, and it has to fail as
      // loudly as a property that cannot be written. A profile with no gateway at all reports
      // undefined, which is not judged.
      const facts = factsOf(services)
      const host = isLoopbackOf(facts) ? facts.isLoopback : undefined
      const state = 'connection:' + before + '->' + connection.isLoopback + ' host:' + host
      const visible = host !== false
      // The one ordering outcome that is still repairable: a live gateway that copied `false` before
      // this plugin activated. The settings pages read these facts, so writing them reaches every
      // reader that has not cached the value itself — and the marker below still reports that the
      // gateway had it wrong, so the regression is visible rather than quietly papered over.
      let repaired = false
      if (host === false && isObject(facts)) {
        try {
          facts.isLoopback = true
          repaired = true
        } catch {}
      }
      mark(visible ? state : 'SELF-CHECK-FAILED ' + state)
      // cordis's own teardown: the effect body returns what undoes it — including the facts above,
      // or a dropped package would leave the pages it privileged still privileged.
      ctx.effect(() => () => {
        try {
          connection.isLoopback = before
        } catch {}
        if (repaired && isObject(facts)) {
          try {
            facts.isLoopback = host
          } catch {}
        }
      })
    }

    exports.apply = apply

    return module.exports
  },
})
