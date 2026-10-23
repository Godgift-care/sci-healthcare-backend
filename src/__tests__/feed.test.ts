import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';

/**
 * Issue #155 asks for the feed to be validated by a feed validator in a test.
 * The validators that exist on npm are XML parsers with an Atom layer on top;
 * adding a dependency for one assertion is a poor trade, so this file carries
 * a small strict reader instead. It checks the two things a feed validator
 * checks: that the bytes are well-formed XML, and that the Atom 1.0 rules
 * that are actually mandatory (RFC 4287) hold.
 */

const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';

/** RFC 3339 date-time, which is the date format Atom requires. */
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

/** The predefined entities plus numeric references; anything else is illegal. */
const ENTITY_BODY = '(?:amp|lt|gt|quot|apos|#\\d+|#[xX][0-9a-fA-F]+)';
const ENTITY_AT = new RegExp(`&${ENTITY_BODY};`, 'y');

/** The predefined entities and numeric references, decoded. */
function decodeEntities(text: string): string {
  return text.replace(new RegExp(`&${ENTITY_BODY};`, 'g'), (entity) => {
    const body = entity.slice(1, -1);
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body]!;
  });
}

/**
 * A strict little XML reader.
 *
 * Throws on the errors that would make a feed unreadable: a tag left open, an
 * end tag that does not close the one open, a bare `<` in text, an `&` that
 * starts no entity, a duplicated attribute, or text after the root element.
 */
function parseXml(xml: string): XmlNode {
  let pos = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  // A declaration rather than an arrow, so `fail(...)` also narrows for the
  // type checker: the reader's guards below rely on that.
  function fail(message: string): never {
    throw new Error(`XML error at ${pos}: ${message}`);
  }

  const skipSpaces = () => {
    while (pos < xml.length && /\s/.test(xml[pos]!)) pos += 1;
  };

  const readName = () => {
    const start = pos;
    while (pos < xml.length && /[:\w.-]/.test(xml[pos]!)) pos += 1;
    if (pos === start) fail('expected a name');
    return xml.slice(start, pos);
  };

  const readQuoted = () => {
    const quote = xml[pos];
    if (quote !== '"' && quote !== "'") fail('expected a quoted attribute value');
    pos += 1;
    const start = pos;
    const end = xml.indexOf(quote, pos);
    if (end === -1) fail('unterminated attribute value');
    pos = end + 1;
    return xml.slice(start, end);
  };

  /** Rejects an `&` that opens nothing and a `<` that opens no tag. */
  const checkText = (text: string, where: string) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '<') fail(`${where} contains a bare "<"`);
      if (text[i] === '&') {
        ENTITY_AT.lastIndex = i;
        const match = ENTITY_AT.exec(text);
        if (!match) fail(`${where} contains an undeclared entity: ${text.slice(i, i + 12)}`);
        i = ENTITY_AT.lastIndex;
        continue;
      }
      i += 1;
    }
  };

  const parseAttributes = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipSpaces();
      if (xml[pos] === '>' || xml.startsWith('/>', pos)) return attrs;
      const name = readName();
      skipSpaces();
      if (xml[pos] !== '=') fail(`attribute ${name} has no value`);
      pos += 1;
      if (Object.hasOwn(attrs, name)) fail(`duplicate attribute ${name}`);
      attrs[name] = readQuoted();
      checkText(attrs[name]!, `attribute ${name}`);
    }
  };

  for (;;) {
    const open = xml.indexOf('<', pos);
    const text = xml.slice(pos, open === -1 ? xml.length : open);
    checkText(text, 'text');
    // Text belongs to whatever element is currently open.
    if (stack.length > 0) stack[stack.length - 1]!.text += decodeEntities(text);
    if (open === -1) break;
    pos = open;

    if (xml.startsWith('<!--', pos)) {
      const end = xml.indexOf('-->', pos);
      if (end === -1) fail('unterminated comment');
      pos = end + 3;
      continue;
    }
    // The `<?xml ... ?>` declaration and any processing instruction.
    if (xml.startsWith('<?', pos)) {
      const end = xml.indexOf('?>', pos);
      if (end === -1) fail('unterminated declaration');
      pos = end + 2;
      continue;
    }
    // A CDATA section is legal XML but has no place in a feed we generate.
    if (xml.startsWith('<![', pos)) fail('CDATA is not used by this feed');

    if (xml.startsWith('</', pos)) {
      pos += 2;
      const name = readName();
      skipSpaces();
      if (xml[pos] !== '>') fail('malformed end tag');
      pos += 1;
      const closed = stack.pop();
      if (!closed) fail(`</${name}> closes nothing`);
      if (closed!.name !== name) fail(`</${name}> closes <${closed!.name}>`);
      if (stack.length === 0) {
        if (xml.slice(pos).trim() !== '') fail('content after the root element');
        return closed!;
      }
      continue;
    }

    pos += 1;
    const name = readName();
    const attrs = parseAttributes();
    const selfClosing = xml.startsWith('/>', pos);
    if (!selfClosing && xml[pos] !== '>') fail(`malformed start tag <${name}`);
    pos += selfClosing ? 2 : 1;

    const node: XmlNode = { name, attrs, children: [], text: '' };
    if (stack.length === 0) {
      if (root) fail('a second root element');
      root = node;
    } else {
      stack[stack.length - 1]!.children.push(node);
    }
    if (!selfClosing) stack.push(node);
  }

  if (!root) fail('no root element');
  if (stack.length > 0) fail(`<${stack[stack.length - 1]!.name}> is never closed`);
  return root;
}

/** Every direct child with this tag name. */
function all(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** The text of a required direct child. */
function textOf(node: XmlNode, name: string, where: string): string {
  const [child] = all(node, name);
  if (!child) throw new Error(`${where} has no ${name}`);
  const text = child.children.length > 0 ? '' : child.text;
  if (text.trim() === '') throw new Error(`${where} has an empty ${name}`);
  return text;
}

/**
 * The mandatory parts of an Atom document (RFC 4287), element by element.
 *
 * A feed needs `title`, `id` and `updated`; an entry needs the same three.
 * An `id` must be an IRI, `updated` an RFC 3339 date-time, and ids must be
 * unique across the document. An entry with no `author` is only legal when
 * the feed itself has one (section 4.1.1, rule 6).
 */
function assertAtom(xml: string): { feed: XmlNode; entries: XmlNode[] } {
  const feed = parseXml(xml);
  if (feed.name !== 'feed') throw new Error(`root is <${feed.name}>, not <feed>`);
  if (feed.attrs.xmlns !== ATOM_NAMESPACE) throw new Error('feed is not in the Atom namespace');

  textOf(feed, 'title', 'feed');
  const feedId = textOf(feed, 'id', 'feed');
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(feedId)) throw new Error(`feed id is not a URI: ${feedId}`);
  if (!RFC_3339.test(textOf(feed, 'updated', 'feed'))) throw new Error('feed updated is not RFC 3339');

  const self = all(feed, 'link').find((link) => link.attrs.rel === 'self');
  if (!self) throw new Error('feed has no rel="self" link');

  const feedHasAuthor = all(feed, 'author').length > 0;
  const entries = all(feed, 'entry');
  const ids = new Set([feedId]);
  for (const [index, entry] of entries.entries()) {
    const where = `entry ${index}`;
    textOf(entry, 'title', where);
    const id = textOf(entry, 'id', where);
    if (ids.has(id)) throw new Error(`${where} reuses id ${id}`);
    ids.add(id);
    if (!RFC_3339.test(textOf(entry, 'updated', where))) {
      throw new Error(`${where} updated is not RFC 3339`);
    }
    if (!feedHasAuthor && all(entry, 'author').length === 0) {
      throw new Error(`${where} has no author and the feed has none either`);
    }
    if (all(entry, 'content').length === 0 && all(entry, 'summary').length === 0) {
      throw new Error(`${where} has neither content nor summary`);
    }
    // `atom:content` with no type attribute is plain text, which must still
    // be free of markup; the reader above already proved the whole document
    // is well-formed.
  }
  return { feed, entries };
}

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const OTHER_CLINIC = 'GDRHSGBLCHN4DNXQMIHWR3XJH4JM4ZNEIZGURNG42KSQVYULDW3PQH3I';
const AMPOUTAND_CLINIC = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
/** Settled at a clinic the indexer never saw register: it has no name to show. */
const UNKNOWN_CLINIC = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
/** A patient reference: this must never appear in the feed. */
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let testClientId = 0;

async function get(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': `10.50.${(testClientId >>> 8) & 255}.${++testClientId & 255}` },
  });
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

/**
 * The read model the feed renders, built in one batch per table.
 *
 * A feed test writes more rows than most route tests (the cap test needs
 * twenty-five settlements), and every round trip here goes to a throwaway
 * SQLite file, so the seeds use `createMany` rather than a `create` per row.
 */
const BASE = Date.now();
const daysAgo = (days: number): Date => new Date(BASE - days * DAY);

const AMOUNT = '30000000';

/** id, provider, how many days ago it settled. */
const SETTLEMENTS: [string, string, number][] = [
  ['11', CLINIC, 6],
  ['12', OTHER_CLINIC, 4],
  ['13', AMPOUTAND_CLINIC, 3],
  // A receipt at a clinic the indexer never saw register. A voucher cannot
  // exist without its provider row, but a receipt can, and the feed reads the
  // receipt: it has to say the address rather than invent a name.
  ['14', UNKNOWN_CLINIC, 5],
];

async function seed(): Promise<void> {
  await prisma.provider.createMany({
    data: [
      {
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: daysAgo(10),
      },
      {
        address: OTHER_CLINIC,
        name: 'Kigali Care Centre',
        country: 'RW',
        status: 'Active',
        registeredAt: daysAgo(10),
      },
      {
        address: AMPOUTAND_CLINIC,
        name: 'Maternity & <Child> Health',
        country: 'KE',
        status: 'Active',
        registeredAt: daysAgo(10),
      },
    ],
  });
  // A catalogued service, so a settled entry names the care as well as the
  // clinic — the same batched label lookup every receipt route uses.
  await prisma.service.createMany({
    data: [
      {
        id: `${OTHER_CLINIC}:101`,
        code: 101,
        label: 'Antenatal visit',
        price: AMOUNT,
        providerAddress: OTHER_CLINIC,
      },
    ],
  });
  await prisma.providerStatusChange.createMany({
    data: [
      {
        id: `change-${CLINIC.slice(1, 8)}`,
        providerAddress: CLINIC,
        status: 'Active',
        ledger: 100,
        changedAt: daysAgo(2),
      },
      {
        id: `change-${OTHER_CLINIC.slice(1, 8)}`,
        providerAddress: OTHER_CLINIC,
        status: 'Active',
        ledger: 101,
        changedAt: daysAgo(1),
      },
    ],
  });
  await prisma.voucher.createMany({
    data: SETTLEMENTS.filter(([, address]) => address !== UNKNOWN_CLINIC).map(
      ([id, providerAddress]) => ({
        id,
        seq: BigInt(id),
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress,
        serviceCode: 101,
        amount: AMOUNT,
        status: 'Settled',
        createdAt: daysAgo(8),
        expiresAt: new Date(BASE + 27 * DAY),
        settledNet: AMOUNT,
        settledFee: '0',
      }),
    ),
  });
  await prisma.receipt.createMany({
    data: SETTLEMENTS.map(([id, providerAddress, days]) => ({
      voucherId: id,
      beneficiaryRef: REF,
      providerAddress,
      serviceCode: 101,
      amount: AMOUNT,
      settledAt: daysAgo(days),
    })),
  });
}

async function clearReadModel(): Promise<void> {
  // Vouchers and services reference providers, so they go first.
  await prisma.service.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.provider.deleteMany();
}

beforeAll(async () => {
  await clearReadModel();
  await seed();

  app = await buildApp({ logger: false });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe('GET /feed.xml', () => {
  it('is an Atom document', async () => {
    const res = await get('/feed.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/atom+xml');
    const { feed, entries } = assertAtom(res.body);
    expect(feed.children.some((c) => c.name === 'title' && c.text.includes('SCI Healthcare'))).toBe(
      true,
    );
    expect(entries.length).toBeGreaterThan(0);
  });

  it('validates against the Atom rules with settled vouchers and verified clinics', async () => {
    const { body } = await get('/feed.xml');
    const { entries } = assertAtom(body);
    const titles = entries.map((entry) => entry.children.find((c) => c.name === 'title')!.text);
    expect(titles).toContain('Voucher 12 settled at Kigali Care Centre');
    expect(titles.some((title) => title === 'Clinic Ikeja General Clinic verified')).toBe(true);

    // The entry content carries the catalogued service label and the amount in
    // both forms, exactly as the receipt endpoints render them.
    const settled = entries.find((e) =>
      e.children.find((c) => c.name === 'id')!.text.endsWith('voucher-settled:12'),
    )!;
    const content = settled.children.find((c) => c.name === 'content')!.text;
    expect(content).toBe(
      'Care voucher 12 settled at Kigali Care Centre, Antenatal visit for 30000000 base units (3.0000000).',
    );
  });

  it('says nothing about a patient', async () => {
    const { body } = await get('/feed.xml');
    expect(body).not.toContain(REF);
    expect(body.toLowerCase()).not.toContain('beneficiary');
  });

  it('escapes a clinic name that contains XML metacharacters', async () => {
    const { body } = await get('/feed.xml');
    expect(body).toContain('Maternity &amp; &lt;Child&gt; Health');
    // The escape is what keeps the document parseable, so prove both.
    assertAtom(body);
  });

  it('names a clinic the registry never saw by its address', async () => {
    const { body } = await get('/feed.xml');
    const { entries } = assertAtom(body);
    const titles = entries.map((entry) => entry.children.find((c) => c.name === 'title')!.text);
    expect(titles).toContain(`Voucher 14 settled at ${UNKNOWN_CLINIC}`);
    // An address is what the chain publishes; a made-up clinic name is not.
    expect(titles.some((title) => title.includes('Unknown'))).toBe(false);
  });

  it('links each entry to the JSON resource behind it', async () => {
    const { entries } = assertAtom((await get('/feed.xml')).body);
    const settled = entries.find((entry) =>
      entry.children.find((c) => c.name === 'id')!.text.endsWith(':12'),
    )!;
    const link = settled.children.find((c) => c.name === 'link')!;
    expect(link.attrs.rel).toBe('alternate');
    expect(link.attrs.href).toBe('/v1/vouchers/12');
  });

  it('orders entries newest first and caps the document', async () => {
    const { entries } = assertAtom((await get('/feed.xml')).body);
    const dates = entries.map((e) => Date.parse(e.children.find((c) => c.name === 'updated')!.text));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(entries.length).toBeLessThanOrEqual(20);
  });

  it('holds twenty entries, the twenty most recent, once there are more', async () => {
    // 25 more settlements, each a day apart and older than the seeded ones.
    const extra = Array.from({ length: 25 }, (_, i) => `${20 + i}`);
    await prisma.voucher.createMany({
      data: extra.map((id) => ({
        id,
        seq: BigInt(id),
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: AMOUNT,
        status: 'Settled',
        createdAt: daysAgo(40),
        expiresAt: new Date(BASE + 27 * DAY),
        settledNet: AMOUNT,
        settledFee: '0',
      })),
    });
    await prisma.receipt.createMany({
      data: extra.map((id, i) => ({
        voucherId: id,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: AMOUNT,
        settledAt: daysAgo(20 + i),
      })),
    });

    try {
      const { entries } = assertAtom((await get('/feed.xml')).body);
      expect(entries.length).toBe(20);

      const feedDates = entries.map(
        (e) => new Date(e.children.find((c) => c.name === 'updated')!.text).getTime(),
      );
      expect([...feedDates].sort((a, b) => b - a)).toEqual(feedDates);

      // The twenty newest of everything the read model holds, which is what
      // "latest activity" means here: the verifications and the settlements,
      // merged by when they happened.
      const [receipts, changes] = await Promise.all([
        prisma.receipt.findMany({ orderBy: { settledAt: 'desc' }, select: { settledAt: true } }),
        prisma.providerStatusChange.findMany({
          where: { status: 'Active' },
          orderBy: { changedAt: 'desc' },
          select: { changedAt: true },
        }),
      ]);
      const newest = [...receipts.map((r) => r.settledAt), ...changes.map((c) => c.changedAt)]
        .sort((a, b) => b.getTime() - a.getTime())
        .slice(0, 20)
        .map((d) => d.getTime());
      expect(feedDates).toEqual(newest);
    } finally {
      await prisma.receipt.deleteMany({ where: { voucherId: { in: extra } } });
      await prisma.voucher.deleteMany({ where: { id: { in: extra } } });
    }
  }, 30_000);

  it('is still a valid feed when the read model is empty', async () => {
    // Emptying and re-filling the shared read model is the slow part, not the
    // document; same 30s budget the other seeding-heavy suites ask for.
    await clearReadModel();
    try {
      const { body } = await get('/feed.xml');
      const { entries } = assertAtom(body);
      expect(entries).toEqual([]);
    } finally {
      await seed();
    }
  }, 30_000);

  it('serves the same document under /v1 and the legacy alias', async () => {
    const legacy = await get('/feed.xml');
    const versioned = await get('/v1/feed.xml');
    expect(versioned.status).toBe(200);
    expect(versioned.body).toBe(legacy.body);
    expect(versioned.headers['deprecation']).toBeUndefined();
  });

  it('is cacheable like the other read routes', async () => {
    const { headers } = await get('/feed.xml');
    expect(headers['cache-control']).toContain('max-age=5');
    expect(headers.etag).toMatch(/^W\/"/);
  });

  it('appears in the OpenAPI document', async () => {
    const { body } = await get('/openapi.json');
    const spec = JSON.parse(body) as {
      paths: Record<string, { get?: { summary?: string } } | undefined>;
    };
    for (const path of ['/feed.xml', '/v1/feed.xml']) {
      expect(spec.paths[path]?.get?.summary).toBe('Atom feed of protocol activity');
    }
  });
});
