/**
 * Host half. The decision this package carries is made in the browser (see ./client), because that
 * is where dsh decides whether the privileged surface belongs to the page. The browser cannot
 * answer it alone: what counts as this deployment's own authority is the host's business, and dsh
 * already answers it — `connection.requestRejection` is the fence its own API runs, browser login
 * included. This half asks it and hands the verdict over, so the browser never re-implements
 * authority matching (and never gets it subtly wrong).
 */
export const name = '@idsh/privileged-ui'

/** The path the browser half reads. Read-only, and no secret: it is one boolean about the caller. */
export const trustedPath = '/idsh/trusted'

const HTTP_OK = 200
const HTTP_FORBIDDEN = 403
const HTTP_METHOD_NOT_ALLOWED = 405

interface RouteRequest {
  method?: string
}

interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

interface HostContext {
  webServer?: { register(route: unknown): (() => void) | void }
  get(name: string): unknown
  inject(names: string[], callback: (ctx: HostContext) => void): void
  effect(body: () => (() => void) | void): void
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** The gate dsh's connection service exposes, narrowed out of the untyped registry value. */
const requestRejectionOf = (
  connection: unknown,
): ((request: unknown) => number | undefined) | undefined => {
  if (!isObject(connection)) {
    return undefined
  }
  const gate = connection.requestRejection
  if (typeof gate !== 'function') {
    return undefined
  }
  return (request: unknown): number | undefined => {
    const verdict: unknown = gate.call(connection, request)
    if (verdict === undefined) {
      return undefined
    }
    // A gate that answers something other than a status is not a gate that says "allow".
    return typeof verdict === 'number' ? verdict : HTTP_FORBIDDEN
  }
}

/** What dsh's own API would do with this request: a status code to reject it, or nothing. */
function rejectionFor(ctx: HostContext, request: RouteRequest): number | undefined {
  const connection = ctx.get('connection')
  const gate = requestRejectionOf(connection)

  // A host older than that service has no gate to ask. Nothing gets privileged on a guess: the
  // profile this package is installed into is the one that serves the page, so a missing gate is
  // a reason to deny rather than to widen.
  return typeof gate === 'function' ? gate.call(connection, request) : HTTP_FORBIDDEN
}

export function apply(ctx: HostContext): void {
  ctx.inject(['webServer'], ctx => {
    const { webServer } = ctx
    if (webServer !== undefined) {
      ctx.effect(() =>
        webServer.register({
          kind: 'exact',
          path: trustedPath,
          handler: (request: RouteRequest, response: RouteResponse) => {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              response.writeHead(HTTP_METHOD_NOT_ALLOWED, { allow: 'GET' })
              response.end()
              return
            }
            const rejection = rejectionFor(ctx, request)
            response.writeHead(HTTP_OK, {
              'cache-control': 'no-store',
              'content-type': 'application/json; charset=utf-8',
            })
            response.end(
              JSON.stringify(
                rejection === undefined
                  ? { trusted: true }
                  : { trusted: false, reason: `request-rejected:${rejection}` },
              ),
            )
          },
        }),
      )
    }
  })
}
