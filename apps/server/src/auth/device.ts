import type { FastifyRequest } from 'fastify';

/** Platform labels stored on a device row. */
export type DevicePlatform = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';

/**
 * Derives the platform from a User-Agent. Android also mentions Linux and an
 * iPad may identify as Macintosh, so the specific checks come first.
 */
export function platformFromUserAgent(userAgent: string): DevicePlatform {
  if (/Android/i.test(userAgent)) {
    return 'android';
  }
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return 'ios';
  }
  if (/Windows/i.test(userAgent)) {
    return 'windows';
  }
  if (/Macintosh|Mac OS/i.test(userAgent)) {
    return 'macos';
  }
  if (/Linux/i.test(userAgent)) {
    return 'linux';
  }
  return 'web';
}

/** Readable default shown in the device list instead of a raw User-Agent. */
export function defaultDeviceName(platform: DevicePlatform): string {
  switch (platform) {
    case 'android':
      return 'Android 设备';
    case 'ios':
      return 'iOS 设备';
    case 'windows':
      return 'Windows 上的浏览器';
    case 'macos':
      return 'macOS 上的浏览器';
    case 'linux':
      return 'Linux 上的浏览器';
    case 'web':
      return '网页浏览器';
  }
}

/** Device metadata recorded for a new session. */
export interface DeviceInfo {
  name: string;
  platform: DevicePlatform;
}

/**
 * Builds the name and platform stored with a new device. An explicit
 * `x-device-name` header (desktop and native shells) wins over the readable
 * default derived from the User-Agent.
 */
export function deviceInfoOf(request: FastifyRequest): DeviceInfo {
  const header = request.headers['user-agent'];
  const platform = platformFromUserAgent(typeof header === 'string' ? header : '');
  const explicit = request.headers['x-device-name'];
  const provided = typeof explicit === 'string' ? explicit.trim() : '';
  return {
    name: provided === '' ? defaultDeviceName(platform) : provided.slice(0, 60),
    platform,
  };
}
