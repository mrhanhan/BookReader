import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { defaultDeviceName, platformFromUserAgent } from '../src/auth/device';
import { devices, users } from '../src/db/schema';
import {
  buildTestApp,
  createInvite,
  resetDb,
  seedUser,
  testDb,
} from './helpers';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

it('maps user agents to platforms and readable names', () => {
  const cases = [
    [ANDROID_UA, 'android', 'Android 设备'],
    [IPHONE_UA, 'ios', 'iOS 设备'],
    [IPAD_UA, 'ios', 'iOS 设备'],
    [WINDOWS_UA, 'windows', 'Windows 上的浏览器'],
    [MAC_UA, 'macos', 'macOS 上的浏览器'],
    [LINUX_UA, 'linux', 'Linux 上的浏览器'],
    ['curl/8.0', 'web', '网页浏览器'],
    ['', 'web', '网页浏览器'],
  ] as const;

  for (const [userAgent, platform, name] of cases) {
    expect(platformFromUserAgent(userAgent)).toBe(platform);
    expect(defaultDeviceName(platform)).toBe(name);
  }
});

it('records the derived platform and name when registering', async () => {
  await resetDb();
  const app = await buildTestApp();
  const cases = [
    [ANDROID_UA, 'android', 'Android 设备'],
    [IPHONE_UA, 'ios', 'iOS 设备'],
    [WINDOWS_UA, 'windows', 'Windows 上的浏览器'],
    [MAC_UA, 'macos', 'macOS 上的浏览器'],
    [LINUX_UA, 'linux', 'Linux 上的浏览器'],
    ['curl/8.0', 'web', '网页浏览器'],
  ] as const;

  for (const [index, [userAgent, platform, name]] of cases.entries()) {
    const username = `reader_${index}`;
    const inviteCode = await createInvite(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'user-agent': userAgent },
      payload: {
        inviteCode,
        username,
        password: 'a-long-password',
        displayName: `读者${index}`,
      },
    });
    expect(response.statusCode).toBe(201);

    const [row] = await testDb
      .select({ name: devices.name, platform: devices.platform })
      .from(devices)
      .innerJoin(users, eq(devices.userId, users.id))
      .where(eq(users.username, username));
    expect(row).toEqual({ name, platform });
  }
});

it('prefers an explicit device name on login and defaults otherwise', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const before = await testDb
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.userId, user.id));
  const knownIds = new Set(before.map((row) => row.id));

  const named = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'user-agent': ANDROID_UA, 'x-device-name': '  我的手机  ' },
    payload: { username: user.username, password: user.password },
  });
  expect(named.statusCode).toBe(200);

  const afterFirst = await testDb
    .select({ id: devices.id, name: devices.name, platform: devices.platform })
    .from(devices)
    .where(eq(devices.userId, user.id));
  expect(afterFirst.find((row) => !knownIds.has(row.id))).toMatchObject({
    name: '我的手机',
    platform: 'android',
  });
  for (const row of afterFirst) {
    knownIds.add(row.id);
  }

  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'user-agent': IPHONE_UA },
    payload: { username: user.username, password: user.password },
  });
  expect(anonymous.statusCode).toBe(200);

  const afterSecond = await testDb
    .select({ id: devices.id, name: devices.name, platform: devices.platform })
    .from(devices)
    .where(eq(devices.userId, user.id));
  expect(afterSecond.find((row) => !knownIds.has(row.id))).toMatchObject({
    name: 'iOS 设备',
    platform: 'ios',
  });
});
