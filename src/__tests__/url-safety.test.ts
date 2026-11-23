import { describe, expect, it, vi } from 'vitest';

import { fetchProviderMetadata } from '../lib/provider-metadata.js';
import {
  assertSafeDestination,
  isPrivateAddress,
  UnsafeDestinationError,
  type ResolveHost,
} from '../lib/url-safety.js';

/** Public for names, but honours an IP literal, as the real resolver does. */
const publicResolve: ResolveHost = async (hostname) => [
  { address: /^[\d.]+$/.test(hostname) ? hostname : '93.184.216.34', family: 4 },
];

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('refuses anything that is not an IP address', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('assertSafeDestination (#264)', () => {
  it('refuses the cloud metadata address by name, after resolving it', async () => {
    const resolve = vi.fn<ResolveHost>(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(assertSafeDestination('http://metadata.internal/', { resolve })).rejects.toThrow(
      /169\.254\.169\.254 is a private, loopback, link-local or unique-local address/,
    );
    expect(resolve).toHaveBeenCalledWith('metadata.internal');
  });

  it('refuses when any resolved address is private, not just the first', async () => {
    const resolve: ResolveHost = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ];
    await expect(
      assertSafeDestination('https://rebind.example/hooks', { resolve }),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
  });

  it('refuses a non-http(s) scheme and an unparseable URL', async () => {
    await expect(assertSafeDestination('file:///etc/passwd')).rejects.toThrow(
      'scheme file: is not http(s)',
    );
    await expect(assertSafeDestination('not a url')).rejects.toThrow('not a valid URL');
  });

  it('refuses an IPv6 literal in a bracketed URL', async () => {
    await expect(assertSafeDestination('http://[::1]:8080/hooks')).rejects.toThrow(
      /::1 is a private/,
    );
  });

  it('refuses when the host does not resolve, and when it resolves to nothing', async () => {
    const failing: ResolveHost = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(
      assertSafeDestination('https://gone.example/', { resolve: failing }),
    ).rejects.toThrow('could not resolve gone.example: ENOTFOUND');
    const empty: ResolveHost = async () => [];
    await expect(
      assertSafeDestination('https://gone.example/', { resolve: empty }),
    ).rejects.toThrow('no addresses');
  });

  it('allows a public destination', async () => {
    await expect(
      assertSafeDestination('https://clinic.example/hooks', { resolve: publicResolve }),
    ).resolves.toBeUndefined();
  });

  it('lets local development opt in without resolving anything', async () => {
    const resolve = vi.fn<ResolveHost>(publicResolve);
    await expect(
      assertSafeDestination('http://localhost:3000/hooks', { allowPrivate: true, resolve }),
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('provider metadata redirects are checked hop by hop (#264)', () => {
  const redirectTo = (location: string): Response =>
    new Response(null, { status: 302, headers: { location } });

  it('refuses a public URL that redirects to the metadata address', async () => {
    const fetchImpl = vi.fn(async () =>
      redirectTo('http://169.254.169.254/latest/meta-data/'),
    ) as unknown as typeof fetch;

    await expect(
      fetchProviderMetadata('https://clinic.example/meta.json', {
        fetchImpl,
        allowPrivate: false,
        resolveHost: publicResolve,
      }),
    ).rejects.toThrow(/refused: refusing 169\.254\.169\.254/);

    // The redirect target was never dialled.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a metadata URI that is private before any request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchProviderMetadata('http://169.254.169.254/latest/meta-data/', {
        fetchImpl,
        allowPrivate: false,
      }),
    ).rejects.toThrow(/refused/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a public redirect and returns the document', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://cdn.example/meta.json'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'Redirected Clinic' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch;

    const metadata = await fetchProviderMetadata('https://clinic.example/meta.json', {
      fetchImpl,
      allowPrivate: false,
      resolveHost: publicResolve,
    });

    expect(metadata).toEqual({ name: 'Redirected Clinic' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect without a Location and one who chains too far', async () => {
    const noLocation = vi.fn(
      async () => new Response(null, { status: 302 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchProviderMetadata('https://clinic.example/a', {
        fetchImpl: noLocation,
        allowPrivate: false,
        resolveHost: publicResolve,
      }),
    ).rejects.toThrow(/302 without a Location/);

    const loop = vi.fn(async () =>
      redirectTo('https://clinic.example/loop'),
    ) as unknown as typeof fetch;
    await expect(
      fetchProviderMetadata('https://clinic.example/loop', {
        fetchImpl: loop,
        allowPrivate: false,
        resolveHost: publicResolve,
      }),
    ).rejects.toThrow(/more than 5 redirects/);
  });
});
