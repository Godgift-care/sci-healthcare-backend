import type { WhatsAppTemplate } from './formatter.js';

/** Graph API host and version used for the WhatsApp Cloud API. */
export const DEFAULT_GRAPH_API = 'https://graph.facebook.com';
export const DEFAULT_API_VERSION = 'v23.0';

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

export type SendResult = { ok: true; messageId: string } | { ok: false; error: string };

/**
 * Posts one approved template message through the WhatsApp Business Cloud
 * API (`POST /{PHONE_NUMBER_ID}/messages`). The payload shape — and the
 * `components` array that carries the template variables — is exactly what
 * Meta requires for `type: "template"`; a template that has not been
 * approved, or whose variable count does not match the approved body, is
 * rejected by the API with a 4xx and surfaces here as `{ ok: false }`.
 */
export async function sendWhatsAppTemplate(options: SendTemplateOptions): Promise<SendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    template,
    graphApi = DEFAULT_GRAPH_API,
    apiVersion = DEFAULT_API_VERSION,
    fetchImpl = fetch,
  } = options;

  const response = await fetchImpl(
    `${graphApi}/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.languageCode },
          components: [
            {
              type: 'body',
              parameters: template.variables.map((text) => ({ type: 'text', text })),
            },
          ],
        },
      }),
    },
  );

  // The Cloud API answers 200 with `messages: [{ id: "wamid..." }]`, and a
  // 4xx/5xx with `{ error: { message, type, code } }`. Anything else is
  // reported as a delivery failure so the webhook can be retried.
  let body: { messages?: { id?: string }[]; error?: { message?: string; code?: number } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, error: `Unparseable Graph API response (HTTP ${response.status})` };
  }

  if (!response.ok) {
    const code = body.error?.code === undefined ? '' : ` (code ${body.error.code})`;
    return {
      ok: false,
      error:
        body.error?.message ?? `Graph API rejected the message (HTTP ${response.status})${code}`,
    };
  }

  const messageId = body.messages?.[0]?.id;
  if (messageId === undefined) {
    return { ok: false, error: 'Graph API accepted the request but returned no message id' };
  }
  return { ok: true, messageId };
}
