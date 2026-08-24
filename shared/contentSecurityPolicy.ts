export const PRODUCTION_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*";

export const DEVELOPMENT_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*";

export function applyDevelopmentContentSecurityPolicy(html: string): string {
  if (!html.includes(PRODUCTION_CONTENT_SECURITY_POLICY)) {
    throw new Error('The production Content Security Policy marker is missing from index.html.');
  }
  return html.replace(
    PRODUCTION_CONTENT_SECURITY_POLICY,
    DEVELOPMENT_CONTENT_SECURITY_POLICY,
  );
}
