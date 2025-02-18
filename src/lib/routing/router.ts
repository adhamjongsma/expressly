import { match } from "path-to-regexp";
import { AutoCorsPreflightOptions, EConfig, Method } from ".";
import { RequestHandler, RequestHandlerCallback } from "./request-handler";
import { ErrorMiddleware, ErrorMiddlewareCallback } from "./error-middleware";
import { ErrorNotFound, ErrorMethodNotAllowed } from "./errors";
import { ERequest, EReq } from "./request";
import { EResponse, ERes } from "./response";

const pathMatcherCache: Map<string, Function> = new Map();

const defaultErrorHandler = (auto405) => async (err: Error, req: EReq, res: ERes) => {
  if (err instanceof ErrorNotFound || (err instanceof ErrorMethodNotAllowed && !auto405)) {
    return res.sendStatus(404);
  } else if (err instanceof ErrorMethodNotAllowed) {
    res.headers.set("Allow", err.allow);
    return res.sendStatus(405);
  }
  console.error(err);
  res.withStatus(500).json({ error: err.message });
}

/**
 * Handles preflight requests from trusted origins configured by the user when initializing a router.
 * Note that the wildcard value "*" will fail if the request is sent with credentials (see: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin#directives)
 * @param autoCorsPreflight the object containing CORS preflight option of trustedOrigins, an array of trusted origins.
 * @returns 200 if the preflight request succeeds, 403 if it fails
 */
const preflightHandler = (autoCorsPreflight: AutoCorsPreflightOptions) => async (req: EReq, res: ERes) => {
  if (autoCorsPreflight.trustedOrigins.length === 0) {
    return res.sendStatus(403);
  }
  let originHeaderValue: string | null = null;
  if (autoCorsPreflight.trustedOrigins.length === 1 && autoCorsPreflight.trustedOrigins[0] === "*") {
    originHeaderValue = "*";
  } else if (req.headers.has("origin")) {
    const origin = req.headers.get("origin").toLowerCase();
    if (autoCorsPreflight.trustedOrigins.some((trustedOrigin) => trustedOrigin.toLowerCase() === origin)) {
      originHeaderValue = origin;
    }
  }
  if (!originHeaderValue) {
    return res.sendStatus(403);
  }
  if (req.headers.has("access-control-request-method")) {
    res.headers.set("access-control-allow-methods", req.headers.get("access-control-request-method"));
  }
  if (req.headers.has("access-control-request-headers")) {
    res.headers.set("access-control-allow-headers", req.headers.get("access-control-request-headers"));
  }
  res.headers.set("access-control-allow-origin", originHeaderValue);
  return res.sendStatus(200);
}

export class Router {
  requestHandlers: Array<RequestHandler> = [];
  errorHandlers: Array<ErrorMiddleware> = [];
  config: EConfig = {
    parseCookie: true,
    auto405: true,
    extractRequestParameters: true,
    autoContentType: false,
  };

  constructor(config?: EConfig) {
    this.config = {
      ...this.config,
      ...config
    }
    if (this.config.autoCorsPreflight) {
      this.options("*", preflightHandler(this.config.autoCorsPreflight));
    }
  }

  public listen(): void {
    addEventListener("fetch", (event) =>
      event.respondWith(this.handler(event))
    );
  }

  private async handler(event: FetchEvent): Promise<Response> {
    const req = new ERequest(this.config, event);
    const res = new EResponse(this.config);
    try {
      // Run middleware and request handler stack.
      await this.runRequestHandlers(req, res);
    } catch (err) {
      // Add default error handler.
      this.use(defaultErrorHandler(this.config.auto405));
      // Run error handler stack.
      await this.runErrorHandlers(err, req, res);
    }
    return Router.serializeResponse(res);
  }

  // Middleware attach point.
  public use(
    path: string | RequestHandlerCallback | ErrorMiddlewareCallback,
    callback?: RequestHandlerCallback | ErrorMiddlewareCallback
  ): void {
    const cb = path instanceof Function ? path : callback;
    const matcher = path instanceof Function ? () => 0 : this.routeMatcher(["*"], path as string);
    if (cb.length === 3) {
      this.errorHandlers.push(
        new ErrorMiddleware(matcher, cb as ErrorMiddlewareCallback)
      );
    } else {
      this.requestHandlers.push(
        new RequestHandler(matcher, cb as RequestHandlerCallback)
      )
    }
  }

  // Router API.
  public route(methods: Method[], pattern: string, callback: RequestHandlerCallback): void {
    this.requestHandlers.push(new RequestHandler(this.routeMatcher(methods.map(m => m.toUpperCase()), pattern), callback));
  }

  public all(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["*"], pattern, callback);
  }

  public get(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["GET"], pattern, callback);
  }

  public post(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["POST"], pattern, callback);
  }

  public put(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["PUT"], pattern, callback);
  }

  public delete(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["DELETE"], pattern, callback);
  }

  public head(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["HEAD"], pattern, callback);
  }

  public options(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["OPTIONS"], pattern, callback);
  }

  public patch(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["PATCH"], pattern, callback);
  }

  public purge(pattern: string, callback: RequestHandlerCallback): void {
    this.route(["PURGE"], pattern, callback);
  }

  // Request handler runner.
  private async runRequestHandlers(req: EReq, res: ERes): Promise<any> {
    let checkResult;
    const allowedMethods = [];
    for (let a of this.requestHandlers) {
      if (res.hasEnded) {
        break;
      }
      checkResult = a.check(req);
      if (checkResult === 0) {
        await a.run(req, res);
      } else if (checkResult.length) {
        allowedMethods.push(checkResult)
      }
    }
    if (allowedMethods.length) {
      throw new ErrorMethodNotAllowed(allowedMethods);
    } else if (checkResult === 404) {
      throw new ErrorNotFound();
    }
  }

  // Error handler runner.
  private async runErrorHandlers(err: Error, req: EReq, res: ERes): Promise<any> {
    for (let eH of this.errorHandlers) {
      if (res.hasEnded) {
        break;
      }
      if (eH.check(req) === 0) {
        await eH.run(err, req, res);
      }
    }
  }

  /**
   * Creates a function used to check if the request method and path match a router configuration.
   * @param methods An array of HTTP method(s) or "*" to match all methods.
   * @param pattern A path string compatible with path-to-regexp (see: https://www.npmjs.com/package/path-to-regexp)
   * @param extractRequestParameters Whether to extract parameters from a request
   * @returns 405 if the method is not allowed, 404 if the path doesn't match, 0 otherwise.
   */
  private routeMatcher(methods: string[], pattern: string): Function {
    return (req: EReq): 404 | 0 | string[] => {
      const methodAllowed = methods.some(m => m === "*" || m === req.method);
      if (pattern === "*" || pattern === "(.*)") {
        return methodAllowed ? 0 : methods;
      } else {
        // Cache pattern matcher.
        if (!pathMatcherCache.has(pattern)) {
          pathMatcherCache.set(pattern, match(pattern, { decode: decodeURIComponent }));
        }
        // Match on pathname.
        let { path, params } = pathMatcherCache.get(pattern)(req.urlObj.pathname) || {};
        if (path) {
          if (this.config.extractRequestParameters) {
            req.params = params;
          }
          return methodAllowed ? 0 : methods;
        }
      }
      // Route not found.
      return 404;
    };
  }

  private static serializeResponse(res: ERes): Response {
    const response = new Response(res.body, {
      headers: res.headers,
      // Default to 200 / 204 if no status was set by middleware / route handler.
      status: res.status ? res.status : Boolean(res.body) ? 200 : 204,
    });
    if (res.headers.cookies.size) {
      // Loop cookies manually to work around this issue: https://github.com/fastly/js-compute-runtime/issues/47
      response.headers.delete("Set-Cookie");
      res.headers.cookies.forEach((c) => response.headers.append("Set-Cookie", c));
    }
    return response;
  }
}
