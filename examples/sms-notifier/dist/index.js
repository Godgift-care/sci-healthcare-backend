import { fileURLToPath } from 'node:url';
import { createWebhookServer } from './server.js';
export * from './formatter.js';
export * from './server.js';
export * from './sms.js';
export * from './verify.js';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const port = Number(process.env.PORT ?? 3003);
    const webhookSecret = process.env.WEBHOOK_SECRET ?? 'example-webhook-secret-do-not-use-in-prod';
    if (!process.env.AFRICTALKING_API_KEY && !process.env.SMS_SANDBOX) {
        console.warn('Notice: AFRICTALKING_API_KEY not set and SMS_SANDBOX is off; signed webhooks will be accepted but delivery answers 501 not_configured.');
    }
    const server = createWebhookServer({ webhookSecret, logger: console.log });
    server.listen(port, () => {
        console.log(`Clinic SMS notifier listening on http://localhost:${port}/webhook`);
        console.log('Expecting signed voucher webhooks (HMAC-SHA256 in X-SCI-Signature)');
    });
}
