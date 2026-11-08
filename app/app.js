import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { log, errorFields, requestLogger } from './logger.js';
import { statusRouter } from './routes/status.js';
import { adminRouter } from './routes/admin.js';
import { readerRouter } from './routes/reader.js';
import { searchRouter } from './routes/search.js';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(appDir, '..', 'package.json'), 'utf8'));

export function createApp({ config, pool }) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(appDir, 'views'));
  app.set('trust proxy', config.server.trustProxy);

  // Defaults for the header partial; the admin routes override them per request.
  app.locals.admin = null;
  app.locals.csrfToken = null;

  app.use(requestLogger);

  // Baseline security headers (brainstorm 5.11, section 7). Inline styles are
  // allowed because KaTeX emits style attributes; scripts stay strict.
  // The site runs over plain HTTP on the LAN for now, so the defaults that only
  // make sense over HTTPS are turned off: upgrade-insecure-requests would make
  // the browser request the CSS over https and fail, and HSTS is ignored on HTTP.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      strictTransportSecurity: false,
    }),
  );

  app.use(express.static(path.join(appDir, 'public'), { index: false, dotfiles: 'ignore' }));

  // KaTeX's stylesheet and fonts, served from the package so there is no copy to keep in step.
  app.use(
    '/vendor/katex',
    express.static(path.join(appDir, '..', 'node_modules', 'katex', 'dist'), { index: false, dotfiles: 'ignore' }),
  );

  app.use(statusRouter({ pool }));
  app.use(readerRouter({ pool }));
  app.use(searchRouter({ pool, config }));
  app.use('/admin', adminRouter({ pool, config, version }));

  app.use((req, res) => {
    res.status(404).render('404', { title: 'Page not found' });
  });

  // Four arguments: Express recognises this as the error handler. The page never
  // shows the error itself, only the log does.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error('unhandled error', errorFields(err));
    if (res.headersSent) return res.end();
    res.status(500).render('error', { title: 'Something went wrong' });
  });

  return app;
}
