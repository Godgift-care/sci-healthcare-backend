import { fileURLToPath } from 'node:url';

import { createServerFromEnv } from './lib/server.js';

export * from './lib/mailer.js';
export * from './lib/server.js';
export * from './lib/templates.js';
export * from './lib/verify.js';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const port = Number(process.env.PORT ?? 3002);

  const { mailer, server } = await createServerFromEnv();

  if (mailer.transport.name === 'console') {
    console.warn(
      'Notice: SMTP_HOST not provided. Mail is printed to the console instead of being sent.',
    );
  }

  server.listen(port, () => {
    console.log(`Email notifier listening on http://localhost:${port}/webhook`);
    console.log(`Transport: ${mailer.transport.name}, recipient: ${mailer.to}`);
  });
}
