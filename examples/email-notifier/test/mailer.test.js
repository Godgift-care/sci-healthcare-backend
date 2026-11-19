import assert from 'node:assert/strict';
import { test } from 'node:test';

import { consoleTransport, createMailer, smtpTransport } from '../lib/mailer.js';
import { PrivacyError } from '../lib/templates.js';

const OPTIONS = { from: 'notifier@example.invalid', to: 'clinic@example.invalid' };

function recordingTransport() {
  const sent = [];
  return {
    name: 'recording',
    sent,
    async send(mail) {
      sent.push(mail);
      return { accepted: [mail.to] };
    },
  };
}

test('renders one letter and passes it to the transport', async () => {
  const transport = recordingTransport();
  const mailer = createMailer({ ...OPTIONS, transport });

  await mailer.send({
    event: 'voucher_claimed',
    voucherId: 'VC-9',
    status: 'Claimed',
    ledger: 12,
  });

  const [mail] = transport.sent;
  assert.equal(mail.subject, 'Voucher claimed at your clinic');
  assert.match(mail.text, /Voucher: VC-9/);
  assert.match(mail.text, /Ledger: 12/);
});

test('a beneficiary reference never reaches the transport', async () => {
  const transport = recordingTransport();
  const mailer = createMailer({ ...OPTIONS, transport });
  await assert.rejects(
    () => mailer.send({ voucherId: 'VC-1', status: 'Claimed', beneficiaryRef: 'deadbeef' }),
    PrivacyError,
  );
  assert.equal(transport.sent.length, 0);
});

test('the console transport prints instead of sending', async () => {
  const logged = [];
  const transport = consoleTransport({ logger: (line) => logged.push(line) });

  await transport.send({ to: 'clinic@example.invalid', subject: 'Voucher settled', text: 'x' });

  assert.equal(logged.length, 1);
  assert.match(logged[0], /clinic@example.invalid/);
});

test('SMTP needs a host', async () => {
  await assert.rejects(() => smtpTransport({}), /SMTP_HOST/);
});

test('SMTP names the install when nodemailer is missing', async (t) => {
  try {
    await import('nodemailer');
    t.skip('nodemailer is installed, so the missing-dependency path cannot be taken');
    return;
  } catch {
    await assert.rejects(
      () => smtpTransport({ host: 'smtp.example.invalid' }),
      /needs nodemailer[\s\S]*examples\/email-notifier/,
    );
  }
});
