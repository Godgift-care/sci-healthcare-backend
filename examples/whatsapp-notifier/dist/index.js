import { fileURLToPath } from 'node:url';
import { createWebhookServer } from './server.js';
export * from './formatter.js';
export * from './server.js';
export * from './verify.js';
export * from './whatsapp.js';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const port = Number(process.env.PORT ?? 3002);
    const webhookSecret = process.env.WEBHOOK_SECRET ?? 'example-webhook-secret-do-not-use-in-prod';
    if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
        console.warn('Notice: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not provided; signed webhooks will be accepted but delivery answers 501 not_configured.');
    }
    const server = createWebhookServer({ webhookSecret, logger: console.log });
    server.listen(port, () => {
        console.log(`Clinic WhatsApp notifier listening on http://localhost:${port}/webhook`);
        console.log('Expecting signed voucher webhooks (HMAC-SHA256 in X-SCI-Signature)');
    });
}
