import type { WhatsAppTemplate } from './formatter.js';
/** Graph API host and version used for the WhatsApp Cloud API. */
export declare const DEFAULT_GRAPH_API: string;
export declare const DEFAULT_API_VERSION = "v23.0";
export interface SendTemplateOptions {
    phoneNumberId: string;
    accessToken: string;
    /** Recipient in E.164, e.g. `+2348023104455`. */
    to: string;
    template: WhatsAppTemplate;
    graphApi?: string;
    apiVersion?: string;
    fetchImpl?: typeof fetch;
}
export type SendResult = {
    ok: true;
    messageId: string;
} | {
    ok: false;
    error: string;
};
/**
 * Posts one approved template message through the WhatsApp Business Cloud
 * API (`POST /{PHONE_NUMBER_ID}/messages`). The payload shape — and the
 * `components` array that carries the template variables — is exactly what
 * Meta requires for `type: "template"`; a template that has not been
 * approved, or whose variable count does not match the approved body, is
 * rejected by the API with a 4xx and surfaces here as `{ ok: false }`.
 */
export declare function sendWhatsAppTemplate(options: SendTemplateOptions): Promise<SendResult>;
