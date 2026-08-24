"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEVELOPMENT_CONTENT_SECURITY_POLICY = exports.PRODUCTION_CONTENT_SECURITY_POLICY = void 0;
exports.applyDevelopmentContentSecurityPolicy = applyDevelopmentContentSecurityPolicy;
exports.PRODUCTION_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*";
exports.DEVELOPMENT_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*";
function applyDevelopmentContentSecurityPolicy(html) {
    if (!html.includes(exports.PRODUCTION_CONTENT_SECURITY_POLICY)) {
        throw new Error('The production Content Security Policy marker is missing from index.html.');
    }
    return html.replace(exports.PRODUCTION_CONTENT_SECURITY_POLICY, exports.DEVELOPMENT_CONTENT_SECURITY_POLICY);
}
