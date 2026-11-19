import { type Server } from 'node:http';
export interface SentSms {
    to: string;
    message: string;
    messageId: string;
}
export interface WebhookServerOptions {
    webhookSecret: string;
    username?: string | undefined;
    apiKey?: string | undefined;
    from?: string | undefined;
    baseUrl?: string | undefined;
    /**
     * Which number a voucher goes to. The webhook payload identifies the
     * voucher and nothing else, so a real deployment resolves
     * voucher -> clinic -> staff number from its own store; the default is the
     * single number in `SMS_CLINIC_NUMBER`.
     */
    resolveRecipient?: ((voucherId: string) => string | undefined) | undefined;
    logger?: ((msg: string) => void) | undefined;
    fetchImpl?: typeof fetch | undefined;
    onMessageSent?: ((message: SentSms) => void) | undefined;
}
export declare function createWebhookServer(options: WebhookServerOptions): Server;
