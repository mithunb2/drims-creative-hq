// Vercel Serverless Function — GET /api/meta-oauth-start?state=<nonce>
// Kicks off Facebook Login (DISCOVERY only). Redirects to FB's OAuth dialog requesting READ scopes to
// enumerate the operator's BMs/accounts/pages. No token is minted here; the callback handles exchange.
// Requires META_APP_ID in the Vercel env. The redirect_uri (this host + /api/meta-oauth-callback) must
// be registered in the FB app's "Valid OAuth Redirect URIs".
export default async function handler(req, res) {
  const APP_ID = process.env.META_APP_ID || '';
  if (!APP_ID) return res.status(503).send('META_APP_ID not set in the Vercel env');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirect = `${proto}://${host}/api/meta-oauth-callback`;
  const state = String((req.query && req.query.state) || '') || Math.random().toString(36).slice(2);
  // READ-only scopes — enough to list businesses + their assets. The write scope stays on the
  // system-user token (runtime), never requested here.
  const scope = 'business_management,ads_read,pages_show_list';
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`
    + `&scope=${encodeURIComponent(scope)}&response_type=code`;
  res.writeHead(302, { Location: url });
  res.end();
}
