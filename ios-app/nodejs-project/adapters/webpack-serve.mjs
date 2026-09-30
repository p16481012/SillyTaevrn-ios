// The frontend bundle is compiled at build time and served by express.static.
export default function getWebpackServeMiddleware() {
    const middleware = (_req, _res, next) => next();
    middleware.runWebpackCompiler = async () => {};
    return middleware;
}
