import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

const denied = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(network, prefix, 'ipv4');
denied.addSubnet('::', 96, 'ipv6');
denied.addSubnet('fc00::', 7, 'ipv6');
denied.addSubnet('fe80::', 10, 'ipv6');
denied.addSubnet('ff00::', 8, 'ipv6');

export function publicModelAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !denied.check(address, family === 4 ? 'ipv4' : 'ipv6')
    // BlockList also checks IPv4-mapped IPv6 against its IPv4 rules.
    && address !== '::1';
}

/** Validate the addresses used by the socket itself; a prior DNS check cannot prevent rebinding. */
export function guardedLookup(resolve: typeof lookup = lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !addresses.length || addresses.some(row => !publicModelAddress(row.address))) {
        callback(new Error('Model endpoint is unavailable'), '', 0); return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export function createModelTransport(baseUrl: string) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid model endpoint');
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(), timeout: 15000 }, headersTimeout: 60000, bodyTimeout: 60000 });
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url), hostname = target.hostname.replace(/^\[|\]$/g, '');
    if (target.origin !== endpoint.origin || isIP(hostname) && !publicModelAddress(hostname)) throw new Error('Invalid model endpoint');
    // Node accepts undici dispatchers; its bundled declarations may use a different undici version.
    return globalThis.fetch(request, { dispatcher, redirect: 'error' } as unknown as RequestInit);
  };
  return { fetch: transport, close: () => { void dispatcher.close().catch(() => {}); } };
}
