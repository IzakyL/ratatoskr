import { Hono } from 'hono';
import { publicKeyPem } from './lib/crypto';
import { YggdrasilError } from './lib/errors';
import { publicOrigin } from './lib/profile';
import { account } from './routes/account';
import { admin } from './routes/admin';
import { api, textureKey } from './routes/api';
import { authserver } from './routes/authserver';
import { sessionserver } from './routes/sessionserver';
import type { Env } from './types';

// Yggdrasil's metadata document has to live at the API root, so the API gets a
// prefix of its own and the site root stays free for the web UI.
// Anything but the default export here is treated as a Worker entrypoint.
const YGGDRASIL_PREFIX = '/api/yggdrasil';

const app = new Hono<{ Bindings: Env }>();

/**
 * The authlib-injector metadata document. This is the URL players paste into
 * their launcher, and everything else hangs off it.
 */
app.get(YGGDRASIL_PREFIX, async (c) => {
  const origin = publicOrigin(c.env, c.req.url);
  const host = new URL(origin).hostname;

  const skinDomains = (c.env.SKIN_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);
  // Clients refuse skin URLs from hosts they were not told about, so our own
  // host has to be on the list no matter what.
  if (!skinDomains.includes(host)) skinDomains.unshift(host);

  return c.json({
    meta: {
      serverName: c.env.SERVER_NAME || 'Ratatoskr',
      implementationName: 'ratatoskr',
      implementationVersion: '0.1.0',
      // Lets players log in with their character name, not just their email.
      'feature.non_email_login': true,
      links: { homepage: origin, register: origin },
    },
    skinDomains,
    signaturePublickey: await publicKeyPem(c.env.SIGNING_KEY),
  });
});

app.route(`${YGGDRASIL_PREFIX}/authserver`, authserver);
app.route(`${YGGDRASIL_PREFIX}/sessionserver`, sessionserver);
app.route(`${YGGDRASIL_PREFIX}/api`, api);

// Our own account management, outside the Yggdrasil namespace.
app.route('/api', account);
app.route('/api/admin', admin);

/** Content-addressed textures. The hash is the content, so cache forever. */
app.get('/textures/:hash', async (c) => {
  const hash = c.req.param('hash');
  if (!/^[0-9a-f]{64}$/.test(hash)) return c.notFound();

  const texture = await c.env.KV.get(textureKey(hash), 'arrayBuffer');
  if (!texture) return c.notFound();

  return c.body(texture, 200, {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=31536000, immutable',
  });
});

app.onError((error, c) => {
  if (error instanceof YggdrasilError) return error.toResponse();
  console.error(error);
  return c.json(
    { error: 'InternalServerError', errorMessage: 'Something went wrong on our side.' },
    500,
  );
});

export default app;
