import { type Server } from 'node:http';
import { type WhatsAppTemplate } from './formatter.js';
export interface SentMessage {
    to: string;
    template: WhatsAppTemplate;
    messageId: string;
}
export interface WebhookServerOptions {
    webhookSecret: string;
    phoneNumberId?: string | undefined;
    accessToken?: string | undefined;
    languageCode?: string | undefined;
    graphApi?: string | undefined;
    apiVersion?: string | undefined;
    /**
     * Which WhatsApp number a voucher goes to. The webhook payload identifies
     * the voucher and nothing else, so a real deployment resolves
     * voucher -> clinic -> staff number from its own store; the default is the
     * single number in `WHATSAPP_CLINIC_NUMBER`.
     */
    resolveRecipient?: ((voucherId: string) => string | undefined) | undefined;
    logger?: ((msg: string) => void) | undefined;
    fetchImpl?: typeof fetch | undefined;
    onMessageSent?: ((message: SentMessage) => void) | undefined;
}
export declare function createWebhookServer(options: WebhookServerOptions): Server;
