import { renderEmail } from './templates.js';

/**
 * Getting a rendered letter into an inbox.
 *
 * The transport is an object with a `send(mail)` method rather than a
 * nodemailer instance, for two reasons. Tests hand in a transport that records
 * what it was given, so the suite proves what a clinic would read without
 * opening a socket; and `npm test` in this folder then needs nothing
 * installed at all. nodemailer is loaded only when SMTP is actually
 * configured, which keeps the example runnable straight from a clone.
 */

/** A transport that prints the letter instead of sending it. */
export function consoleTransport({ logger = console.log } = {}) {
  return {
    name: 'console',
    async send(mail) {
      logger(`--- email to ${mail.to}: ${mail.subject} ---\n${mail.text}\n`);
      return { accepted: [mail.to], rejected: [] };
    },
  };
}

async function loadNodemailer() {
  try {
    return await import('nodemailer');
  } catch {
    throw new Error(
      'The SMTP transport needs nodemailer. Run `npm install` inside examples/email-notifier.',
    );
  }
}

/**
 * A transport over SMTP.
 *
 * `secure` is false by default, which is STARTTLS on 587: the port where the
 * connection starts plain and is upgraded, rather than the implicit-TLS 465.
 */
export async function smtpTransport({ host, port = 587, secure = false, user, pass } = {}) {
  if (!host) throw new Error('smtpTransport requires an SMTP_HOST');
  const nodemailer = await loadNodemailer();

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user ? { auth: { user, pass } } : {}),
  });

  return {
    name: 'smtp',
    async send(mail) {
      return transporter.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
  };
}

/**
 * Renders each transition for one clinic mailbox and passes it to `transport`.
 */
export function createMailer({ from, to, transport }) {
  return {
    from,
    to,
    transport,
    async send(payload) {
      // renderEmail asserts the privacy rule, so a payload carrying a
      // beneficiary reference throws here rather than reaching the transport.
      return transport.send(renderEmail(payload, { from, to }));
    },
  };
}
